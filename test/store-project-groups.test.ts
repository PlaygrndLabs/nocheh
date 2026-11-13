import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {projectGroups,projectGroupsSql} from '../src/stores/project-groups.js';
import {readSet,readSetOf,readSetParam,readSetSql,recallScope} from '../src/spaces.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,OWNER,P1,P1_GROUPS,P2,UNSERVED,groupsPolicy,seedGroups} from './fixture-groups.js';

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
  const spaces=[GP1,GP1_TOPIC,GP1+'/topic/8',GP2,GP2+'/topic/7',GP3,GP3+'/topic/9',GP4,GP4+'/topic/1',UNSERVED,
    OWNER,OWNER+'/topic/5','456','desktop:personal_chat:9','desktop:private_supergroup:1234567890','system','-0','-20/topic/0',GP1+'/*',GP1+'/topic/7/*',''];
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
    for(const space of [OWNER,'456','desktop:personal_chat:9','system'])assert.deepEqual(await select(readSetOf(recallScope(space))),[],space);
    // A parameter written by hand with private chats and patterns in it still never selects one.
    assert.deepEqual(await select([OWNER,OWNER+'/*','456','system','desktop:personal_chat:9',GP1+'/*/*','%','*','/*',GP4+'/topic/1']),[GP4+'/topic/1']);
    assert.deepEqual(await select([]),[]);
    const named=(await db.query(`SELECT s FROM unnest($2::text[]) s WHERE ${readSetSql('s','$1')} ORDER BY s COLLATE "C"`,[readSetParam(frozen),[GP2+'/topic/7',GP4,OWNER]])).rows;
    assert.deepEqual(named.map(row=>row.s),[GP2+'/topic/7']);
  } finally {await db.end();}
});
