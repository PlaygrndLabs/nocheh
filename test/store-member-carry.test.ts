import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {accountIdFor,connectionIdFor} from '../src/chats.js';
import {memberIdFor} from '../src/members.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {carryMembers} from '../src/stores/member-carry.js';
import {BOB,GP1,GP2,GP3,GP4,GP_GROUP_IDS,NG1,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,UNSERVED,fixtureChats,seedChats} from './fixture-groups.js';

/*
 * The one-time carry of the lists in force before step 3 into members (src/stores/member-carry.ts), one case per test,
 * in both fixture families: GP keys are old-shaped group ids, NG2's are its id before Telegram upgraded it and its
 * current one. Each test starts from no members and no marker, and puts its own assistant document in place.
 */
const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
const policy={owner_id:OWNER};
const ALL=[GP1,GP2,GP3,GP4,UNSERVED,NG1,NG2].sort();
const none={malformed:0,no_group:0,owner:0,proxy:0,bot:0,invalid:0,denied_only:0,denied:0};
let shared:Promise<pg.Pool>|null=null;
async function control():Promise<pg.Pool> {
  return shared??=(async()=>{
    const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
    const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
    const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
    await initializeStoreDatabases(config,passwords);
    const stores=connectStores(config,passwords);await seedChats(stores.control,fixtureChats(served));
    await stores.archive.end();await stores.derived.end();
    return stores.control;
  })();
}
/** Carries `access` as the newest assistant document's group_access (none at all when undefined), from no members and
 * no marker, and takes the document away again. */
async function carry(access?:unknown,document:Record<string,unknown>={enabled:true,owner_id:OWNER}) {
  const db=await control();
  await db.query('DELETE FROM members');await db.query('UPDATE member_directory_state SET carried_at=NULL WHERE singleton');
  const revision=Number((await db.query(`SELECT coalesce(max(revision),0)+1 AS next FROM runtime_configuration_versions WHERE name='assistant'`)).rows[0].next);
  if(access!==undefined)await db.query(`INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',$1,$2,$3)`,
    [revision,JSON.stringify({...document,group_access:access}),digest('carry:'+revision)]);
  try{return await carryMembers(db,policy);}
  finally{await db.query(`DELETE FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1`,[revision]);}
}
/** A member's switches, by the Telegram user id it was carried for: [group, on] for every group chat. */
async function switches(external:string) {
  return (await (await control()).query('SELECT chat_id,enabled FROM member_chats WHERE member_id=$1 ORDER BY chat_id',[memberIdFor(accountIdFor('telegram',external))]))
    .rows.map(row=>[row.chat_id,row.enabled]);
}
/** Every group chat, switched on only in `on`. */
const only=(...on:string[])=>ALL.map(chat=>[chat,on.includes(chat)]);
const carried=async()=>(await (await control()).query(`SELECT a.external_id FROM chat_accounts a JOIN members m ON m.id=a.member_id ORDER BY a.external_id`)).rows
  .map(row=>row.external_id);

after(async()=>{if(shared)await (await shared).end();});

test('an old-shaped group key and an upgraded group\'s old key both carry, with a switched-off row for every other group',fixture,async()=>{
  const result=await carry({[GP1]:{granted:['901'],denied:[]},[NG2_OLD_TG]:{granted:['902'],denied:[]}});
  assert.deepEqual(result,{carried:true,members:2,groups:2,skipped:none});
  assert.deepEqual(await carried(),['901','902']);
  assert.deepEqual(await switches('901'),only(GP1),'a group with no row would count as on, so every other group gets a row switched off');
  assert.deepEqual(await switches('902'),only(NG2));
  const db=await control(),member=(await db.query('SELECT * FROM members WHERE id=$1',[memberIdFor(accountIdFor('telegram','901'))])).rows[0];
  assert.deepEqual([member.state,member.group_talk,member.group_jobs,member.group_post_other,member.group_tools,member.tasks],['active',true,true,true,true,'write'],
    'every permission on and tasks read and write, as before');
  assert.notEqual((await db.query('SELECT carried_at FROM member_directory_state')).rows[0].carried_at,null);
});

test('the lists under every id of one group are joined',fixture,async()=>{
  const result=await carry({[NG2_OLD_TG]:{granted:['901'],denied:[]},[NG2_TG]:{granted:['902'],denied:[]}});
  assert.deepEqual([result.members,result.groups],[2,1]);
  assert.deepEqual([await switches('901'),await switches('902')],[only(NG2),only(NG2)]);
});

test('a person denied in a group under any of its ids is denied there, and keeps the groups they were granted elsewhere',fixture,async()=>{
  const result=await carry({[NG2_OLD_TG]:{granted:['901'],denied:[]},[NG2_TG]:{granted:[],denied:['901']},[GP1]:{granted:['901'],denied:[]}});
  assert.deepEqual([result.members,result.skipped.denied],[1,1]);
  assert.deepEqual(await switches('901'),only(GP1));
});

test('a person only ever denied is not carried',fixture,async()=>{
  const result=await carry({[GP1]:{granted:[],denied:['903']},[GP2]:{granted:['901'],denied:['901']}});
  assert.deepEqual([result.members,result.skipped.denied_only,result.skipped.denied],[0,2,1]);
  assert.deepEqual(await carried(),[]);
});

test('a key naming no group Nocheh has a row for is skipped',fixture,async()=>{
  const result=await carry({'-1009999999999':{granted:['901'],denied:[]},[BOB]:{granted:['902'],denied:[]},[GP3]:{granted:['904'],denied:[]}});
  assert.deepEqual([result.members,result.skipped.no_group],[1,2]);
  assert.deepEqual(await carried(),['904']);
});

test('a group that is off keeps its switched-on row',fixture,async()=>{
  const result=await carry({[UNSERVED]:{granted:['901'],denied:[]}});
  assert.equal(result.members,1);
  assert.deepEqual(await switches('901'),only(UNSERVED),'so they talk there once the owner turns it on');
});

test('a person Nocheh never saw gets an account, linked to their member',fixture,async()=>{
  const account=accountIdFor('telegram','905'),db=await control();
  assert.equal((await db.query('SELECT 1 FROM chat_accounts WHERE id=$1',[account])).rowCount,0);
  await carry({[GP4]:{granted:['905'],denied:[]}});
  assert.deepEqual((await db.query('SELECT external_id,kind,member_id FROM chat_accounts WHERE id=$1',[account])).rows,
    [{external_id:'905',kind:'human',member_id:memberIdFor(account)}]);
  assert.equal((await db.query('SELECT count(*) FROM chat_memberships WHERE account_id=$1',[account])).rows[0].count,'0','Telegram\'s rows are not made up');
});

test('the owner, Telegram\'s proxy accounts and an account recorded as a bot are skipped',fixture,async()=>{
  const db=await control();
  await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id,kind) VALUES($1,$2,'806','bot') ON CONFLICT DO NOTHING`,[accountIdFor('telegram','806'),connectionIdFor('telegram')]);
  const result=await carry({[GP1]:{granted:[OWNER,'777000','1087968824','806','907'],denied:[]}});
  assert.deepEqual(result.skipped,{...none,owner:1,proxy:2,bot:1});
  assert.deepEqual(await carried(),['907']);
  assert.equal((await db.query(`SELECT 1 FROM chat_accounts WHERE external_id IN ('777000','1087968824')`)).rowCount,0);
});

test('malformed entries and ids that are no Telegram user id are skipped and counted, never thrown',fixture,async()=>{
  const result=await carry({[GP1]:'everyone',[GP2]:{granted:'901'},[GP3]:{granted:[9,'908',null,'not-a-user'],denied:[]},[GP4]:{granted:['909'],denied:{}},[NG1]:null,
    [NG2_TG]:{granted:['-5'],denied:[]}});
  assert.deepEqual(result.skipped,{...none,malformed:4,invalid:2});
  assert.deepEqual(await carried(),['908']);
  assert.deepEqual(await carry(['not','an','object']),{carried:true,members:0,groups:0,skipped:none});
});

test('the marker blocks a second carry, and a fresh install only sets it',fixture,async()=>{
  const db=await control();
  // A fresh install has no assistant document with group_access: nobody is carried, and the marker is set.
  assert.deepEqual(await carry(),{carried:true,members:0,groups:0,skipped:none});
  const marked=(await db.query('SELECT carried_at,revision FROM member_directory_state')).rows[0];
  assert.notEqual(marked.carried_at,null);
  // A newer document with lists, after the marker, carries nothing and changes nothing.
  const revision=Number((await db.query(`SELECT coalesce(max(revision),0)+1 AS next FROM runtime_configuration_versions WHERE name='assistant'`)).rows[0].next);
  await db.query(`INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',$1,$2,$3)`,
    [revision,JSON.stringify({enabled:true,owner_id:OWNER,group_access:{[GP1]:{granted:['901'],denied:[]}}}),digest('carry:again')]);
  try {
    assert.deepEqual(await carryMembers(db,policy),{carried:false,members:0,groups:0,skipped:none});
    assert.deepEqual(await carried(),[]);
    assert.deepEqual((await db.query('SELECT carried_at,revision FROM member_directory_state')).rows[0],marked);
  } finally{await db.query(`DELETE FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1`,[revision]);}
  // The newest document that still has lists is the source; a newer one without them does not hide it.
  const older=Number((await db.query(`SELECT coalesce(max(revision),0)+1 AS next FROM runtime_configuration_versions WHERE name='assistant'`)).rows[0].next);
  await db.query(`INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',$1,$2,$3),('assistant',$4,$5,$6)`,
    [older,JSON.stringify({enabled:true,owner_id:OWNER,group_access:{[GP2]:{granted:['910'],denied:[]}}}),digest('carry:older'),
      older+1,JSON.stringify({enabled:true,owner_id:OWNER}),digest('carry:newer')]);
  try {
    assert.deepEqual((await carry(undefined)).members,1);
    assert.deepEqual(await switches('910'),only(GP2));
  } finally{await db.query(`DELETE FROM runtime_configuration_versions WHERE name='assistant' AND revision>=$1`,[older]);}
});
