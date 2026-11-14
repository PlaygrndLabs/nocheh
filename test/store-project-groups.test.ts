import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {projectGroups,projectGroupsSql} from '../src/stores/project-groups.js';
import {readSet,readSetOf,readSetParam,readSetSql,recallScope} from '../src/spaces.js';
import {chatIdFor,installChatsForTest} from '../src/chats.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG2,OWNER,P1,P1_GROUPS,P2,UNSERVED,fixtureChats,groupsPolicy,legacyChats,
  seedGroups} from './fixture-groups.js';

test('a project\'s groups are its served groups, never a topic, a private chat or a group it does not serve',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),db=stores.control,served=groupsPolicy().group_ids;
  try {
    await seedGroups(db);await seedGroups(db);
    assert.deepEqual(await projectGroups(db,P1,served),[...P1_GROUPS],'GP1, GP2 and GP3; never UNSERVED or GP4');
    assert.deepEqual(await projectGroups(db,P2,served),[]);
    assert.deepEqual(await projectGroups(db,digest('fixture:project:unknown'),served),[]);
    // Rows that are not a group's own chat never count, even ones written before they were refused: a topic with its
    // own row (it follows its group), the owner's private chat, its topic, a desktop import and other private chats.
    for(const space of [GP1_TOPIC,GP4+'/topic/3',OWNER,OWNER+'/topic/5','456','desktop:private_supergroup:1234567890','system'])
      await db.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[space,P1]);
    const forged=[...served,OWNER,'456','desktop:private_supergroup:1234567890','system',GP1_TOPIC,UNSERVED+'/topic/1'];
    assert.deepEqual(await projectGroups(db,P1,forged),[...P1_GROUPS],'a served list cannot add a private chat or a topic');
    // Only what is served now, only 'assigned' rows, sorted by code point whatever the collation.
    assert.deepEqual(await projectGroups(db,P1,[GP3,GP1]),[GP1,GP3]);
    assert.deepEqual(await projectGroups(db,P1,[]),[]);
    assert.deepEqual(await projectGroups(db,P1,[...served,UNSERVED]),[...P1_GROUPS,UNSERVED].sort());
    await db.query("UPDATE project_assignments SET mode='none',project_id=NULL WHERE space_id=$1",[GP2]);
    await db.query("UPDATE project_assignments SET project_id=$2 WHERE space_id=$1",[GP3,P2]);
    assert.deepEqual(await projectGroups(db,P1,served),[GP1]);assert.deepEqual(await projectGroups(db,P2,served),[GP3]);
    // An archived project still lists its groups; callers that need an active project check it.
    await db.query("UPDATE projects SET state='archived' WHERE id=$1",[P2]);
    assert.deepEqual(await projectGroups(db,P2,served),[GP3]);
    // The same SQL works per row of a listing.
    const listed=(await db.query(`SELECT p.name,${projectGroupsSql('p.id','$1')} AS groups FROM projects p ORDER BY p.name`,[served])).rows;
    assert.deepEqual(listed,[{name:'P1',groups:[GP1]},{name:'P2',groups:[GP3]}]);
  } finally {await stores.close();}
});

test('a read set selects in SQL exactly what inReadSet reads',{skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const db=new pg.Client(config);await db.connect();
  // Both fixture families, plus topics of GP1-GP4 the seeder would have made rows for (ADR-0250).
  const base=fixtureChats(),extra=legacyChats([GP1+'/topic/8',GP2+'/topic/7',GP3+'/topic/9',GP4+'/topic/1'],{served:GP_GROUP_IDS}),known=new Set(base.chats.map(chat=>chat.id));
  const restore=installChatsForTest({...base,chats:[...base.chats,...extra.chats.filter(chat=>!known.has(chat.id))],ids:[...base.ids,...extra.ids.filter(row=>!known.has(row.chat_id))]});
  const spaces=[GP1,GP1_TOPIC,GP1+'/topic/8',GP2,GP2+'/topic/7',GP3,GP3+'/topic/9',GP4,GP4+'/topic/1',UNSERVED,NG1,NG1_TOPIC,NG2,BOB_CHAT,
    OWNER,OWNER+'/topic/5','456','desktop:personal_chat:9','desktop:private_supergroup:1234567890','system','-0','-20/topic/0',GP1+'/*',GP1+'/topic/7/*','',
    chatIdFor('telegram',NG1_TG,'8')];
  const select=async(set:ReturnType<typeof readSet>|string[],at=2)=>(await db.query(`SELECT s FROM unnest($1::text[]) s WHERE ${readSetSql('s',at)} ORDER BY s COLLATE "C"`,
    [spaces,Array.isArray(set)?set:readSetParam(set)])).rows.map(row=>row.s);
  try {
    assert.equal((await db.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    const frozen=readSet({home:GP1_TOPIC,whole:[GP1,GP2,GP3],project:P1});
    assert.deepEqual(await select(frozen),[GP1,GP1_TOPIC,GP1+'/topic/8',GP2,GP2+'/topic/7',GP3,GP3+'/topic/9']);
    assert.deepEqual(await select(readSetOf(recallScope(GP1_TOPIC))),[GP1,GP1_TOPIC,GP1+'/topic/8']);
    assert.deepEqual(await select(readSetOf(recallScope(GP1_TOPIC,'topic'))),[GP1_TOPIC],'a topic alone');
    assert.deepEqual(await select(readSetOf(recallScope(GP1,'topic'))),[GP1],'the General chat alone');
    assert.deepEqual(await select(readSet({home:GP4,exact:[GP2+'/topic/7'],whole:[GP3]})),[GP2+'/topic/7',GP3,GP3+'/topic/9']);
    // Digest ids: a group with its topic rows, a group with an old Telegram id, and digest and old-shaped groups together;
    // a topic with no row is never read.
    assert.deepEqual(await select(readSet({home:NG1_TOPIC,whole:[NG1,NG2,GP3],project:P1})),[GP3,GP3+'/topic/9',NG1,NG1_TOPIC,NG2].sort());
    assert.deepEqual(await select(readSetOf(recallScope(NG1_TOPIC))),[NG1,NG1_TOPIC].sort());
    assert.deepEqual(await select(readSetOf(recallScope(NG1_TOPIC,'topic'))),[NG1_TOPIC],'a digest topic alone');
    for(const space of [OWNER,'456',BOB_CHAT,'desktop:personal_chat:9','system',chatIdFor('telegram','-1009999999999')])
      assert.deepEqual(await select(readSetOf(recallScope(space))),[],space);
    // The parameter is marked exact ids: a pattern written into it matches nothing, and a parameter made by hand, which
    // skipped readSetParam, matches nothing at all, the owner's chat, Bob's and a group alike (ADR-0242).
    assert.deepEqual(await select(['read:%','read:*','read:/*','read:'+GP1+'/*/*','read:'+GP4+'/topic/1']),[GP4+'/topic/1']);
    assert.deepEqual(await select([OWNER,OWNER+'/topic/5','456',BOB_CHAT,'system',GP1,GP4+'/topic/1']),[],'a list by hand opens nothing');
    assert.deepEqual(await select(['read',':'+OWNER,'READ:'+OWNER,' read:'+OWNER]),[],'only the exact mark counts');
    // A set made by hand with private chats, unknown ids and patterns in it still never puts one in the parameter.
    const forged={home:GP4,exact:[OWNER,OWNER+'/topic/5','456',BOB_CHAT,'system','desktop:personal_chat:9',GP1+'/*',GP4+'/topic/1'],whole:[OWNER,BOB_CHAT,'%',UNSERVED+'/topic/1'],project:null};
    assert.deepEqual(readSetParam(forged),['read:'+GP4+'/topic/1']);
    assert.deepEqual(await select(forged),[GP4+'/topic/1']);
    assert.deepEqual(await select([]),[]);
    const named=(await db.query(`SELECT s FROM unnest($2::text[]) s WHERE ${readSetSql('s','$1')} ORDER BY s COLLATE "C"`,[readSetParam(frozen),[GP2+'/topic/7',GP4,OWNER]])).rows;
    assert.deepEqual(named.map(row=>row.s),[GP2+'/topic/7']);
  } finally {restore();await db.end();}
});
