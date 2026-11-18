import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {accountIdFor,chatIdFor,connectionIdFor} from '../src/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {carryMembers} from '../src/stores/member-carry.js';
import {telegramDirectory} from '../src/stores/telegram-directory.js';
import {BOB,GP1,GP2,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_NG,MEMBER_NG_ID,NG1,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,fixtureChats,seedChats,seedMembers} from './fixture-groups.js';

// GET /v1/telegram/identities (src/stores/server.ts) is telegramDirectory: the management side asks Telegram for the
// names of the people it lists, so a member Nocheh never saw write still gets a name on the dashboard (step 3).
test('identities list a carried member who never wrote in each group Nocheh is in where they are switched on, and say who is a member',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),db=stores.control,served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
  try {
    await seedChats(db,fixtureChats(served));await seedMembers(db);
    // Bob, a stranger, is in GP1; the lists before step 3 granted 911, whom Nocheh never saw, in GP2 and in NG2 by its old id.
    await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source) VALUES($1,$2,'in','message')`,[GP1,accountIdFor('telegram',BOB)]);
    await db.query(`INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)`,
      [JSON.stringify({enabled:true,owner_id:OWNER,group_access:{[GP2]:{granted:['911'],denied:[]},[NG2_OLD_TG]:{granted:['911'],denied:[]}}}),digest('identities')]);
    assert.equal((await carryMembers(db,{owner_id:OWNER})).members,1);
    // A group Nocheh left, where a member's switch is still on.
    const gone='-1003000000201',left=chatIdFor('telegram',gone);
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,state,added_by_role) VALUES($1,$2,'group','supergroup','left','seeded')`,[left,connectionIdFor('telegram')]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current')`,[connectionIdFor('telegram'),gone,left]);
    await db.query('INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,true)',[MEMBER_NG_ID,left]);

    const listed=await telegramDirectory(db,{admin:true,scope:null},null);
    const users=(chat:string)=>listed.groups.find(group=>group.id===chat)?.users.map(user=>[user.id,user.state,user.seen,user.member]);
    const carried=['911',null,false,true];
    assert.deepEqual(users(GP2),[[MEMBER_GP,'left',true,true],carried],'a carried member Telegram never told of: no state, not seen, a member');
    assert.deepEqual(users(GP1),[[BOB,'in',true,false],[MEMBER_GP,'in',true,true]],'a group they are switched off in does not list them');
    assert.deepEqual(users(NG1),[[MEMBER_NG,'in',true,true]]);
    assert.equal(users(GP4),undefined,'a group whose only switches are off is not listed');
    assert.equal(users(left),undefined,'nor one Nocheh left');
    assert.deepEqual(users(NG2),[[MEMBER_NG,'in',true,true],carried]);
    assert.deepEqual(listed.groups.find(group=>group.id===NG2)!.telegram_ids,[NG2_TG,NG2_OLD_TG],'the management side asks Telegram under the group\'s current id');
    assert.equal(listed.truncated,false);
    assert.deepEqual(listed.groups.flatMap(group=>group.users).find(user=>user.id==='911'),{id:'911',name:null,username:null,state:null,seen:false,member:true});
    await assert.rejects(telegramDirectory(db,{admin:false,scope:null},null),{status:403});
  } finally{await stores.close();}
});
