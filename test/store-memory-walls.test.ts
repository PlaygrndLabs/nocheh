import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MemoryWalls,memoryWallName} from '../src/stores/memory-walls.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installChatsForTest} from '../src/chats.js';
import {seededDirectory} from './fixture-seeded-chats.js';

test('a wall holds every learned session of its chats, is reused while nothing changed and refuses a read until its copy is done (ADR-0283)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async t=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),run=Date.now(),A='-100'+run,B='-200'+run,topic=A+'/topic/3',workspace=digest('walls:'+run);
  t.after(installChatsForTest(seededDirectory(()=>({enabled:true,owner_id:'123',group_ids:[A,B,topic]}))));
  const calls:{path:string;body:any}[]=[];let state='completed';
  const engine=honchoEngine(async(path:string,body:any)=>{calls.push({path,body});
    return path.endsWith('/status')?{backfill_status:{s:{state}}}:{};});
  const walls=new MemoryWalls(stores.control,engine,300);
  let n=0;
  const session=async(audience:string,receipt:'done'|'retired'|'pending'|null='done')=>{
    const id=digest(`walls:${run}:${++n}`);
    await stores.control.query('INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5)',[workspace,id,audience,'conversation',id]);
    if(receipt)await stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,audience,source_reference,guard_source_id,prepared_id,content_hash,state,session_id,retired_at)
      VALUES($1,$2,$3,'{}','fixture','fixture',$4,$5,$6,$7)`,[digest(`walls:${run}:receipt:${n}`),workspace,audience,digest('fixture'),receipt==='retired'?'done':receipt,id,
      receipt==='retired'?new Date():null]);
    return id;
  };
  try {
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,randomUUID(),1,'owner']);
    const a1=await session(A),a2=await session(topic),b1=await session(B);
    await session(A,'retired');await session(A,'pending');await session(A,null);
    await session('123');
    // Only sessions with a write that is done and still standing join; the chats' order and repeats do not matter.
    const opened=await walls.open(workspace,[topic,A,A]);
    assert.deepEqual(opened,{wall:memoryWallName(workspace,[A,topic]),sessions:[a1,a2].sort()});
    assert.deepEqual(calls.map(call=>call.path.split('/').slice(4).join('/')),['scopes','scopes/'+opened!.wall+'/sessions','scopes/'+opened!.wall+'/status']);
    assert.deepEqual([...calls[1]!.body.session_ids].sort(),[a1,a2].sort());
    // A ready wall with nothing new is read at once; a new learned session joins it, and the read waits for its copy.
    calls.length=0;assert.deepEqual(await walls.open(workspace,[A,topic]),opened);assert.equal(calls.length,0);
    const a3=await session(A);calls.length=0;
    assert.deepEqual((await walls.open(workspace,[A,topic]))!.sessions,[a1,a2,a3].sort());
    assert.deepEqual(calls.filter(call=>call.path.endsWith('/sessions')).map(call=>call.body),[{session_ids:[a3]}],'only the missing session is added');
    // Another set of chats is another wall; a private chat is never in one.
    const project=await walls.open(workspace,[A,topic,B,'123']);
    assert.equal(project!.wall,memoryWallName(workspace,[A,topic,B]));assert.notEqual(project!.wall,opened!.wall);
    assert.deepEqual(project!.sessions,[a1,a2,a3,b1].sort());
    await assert.rejects(walls.open(workspace,['123']),{code:'memory_wall_empty'});
    // A new session of a chat joins every wall holding it; a private chat joins none.
    assert.deepEqual(await walls.of(workspace,A),[opened!.wall,project!.wall].sort());
    assert.deepEqual(await walls.of(workspace,B),[project!.wall]);
    assert.deepEqual(await walls.of(workspace,'123'),[]);
    // A copy not done in time refuses the read; a failed copy says so.
    await session(B);state='pending';
    await assert.rejects(walls.open(workspace,[A,topic,B]),{code:'memory_wall_syncing'});
    await assert.rejects(walls.open(workspace,[A,topic,B]),{code:'memory_wall_syncing'},'a wall that was not ready stays unread');
    state='failed';await assert.rejects(walls.open(workspace,[A,topic,B]),{code:'memory_wall_copy_failed'});
    state='completed';assert.equal((await walls.open(workspace,[A,topic,B]))!.sessions.length,5);
    // Without wall support in the engine, reads go by sessions as before.
    assert.equal(await new MemoryWalls(stores.control,{...engine,openWall:undefined} as any).open(workspace,[A]),null);
  } finally {
    await stores.control.query('DELETE FROM memory_walls WHERE workspace=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_ingestion_receipts WHERE generation=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_sessions WHERE workspace=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_generations WHERE id=$1',[workspace]);
    await stores.archive.end();await stores.derived.end();await stores.control.end();
  }
});
