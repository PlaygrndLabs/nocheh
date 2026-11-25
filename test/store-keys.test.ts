import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {fixtureServices,type FakeCall} from './fixture-agent.js';

// The owner's Keys list and "Stop everything now" (ADR-0307). Synthetic owner and keys only.
test('the Keys list shows each person\'s open keys and last use, and Stop ends every key at once, once per operation',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-keys-'));
  const policy={enabled:true,owner_id:'123',group_ids:['-42']};
  const runtime:FakeCall=async operation=>{if(operation==='status')return {ok:true};throw Error('unexpected external operation '+operation);};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,serviceToken:digest('keys-token'),runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const owner={scope:null,admin:true} as const;
  const key=async(jti:string,person:string,open:boolean,used:boolean)=>stores.control.query(`INSERT INTO one_time_keys(jti,kind,subject,attempt,person,agent,event_id,expires_at,closed_at,last_used_at)
    VALUES($1,'turn',$1,'1',$2,'hermes',$3,now()+interval '10 minutes',$4,$5)`,[jti,person,digest(jti),open?null:new Date(),used?new Date('2026-01-02T03:04:05Z'):null]);
  try {
    await key('1'.repeat(32),'owner',true,true);await key('2'.repeat(32),'owner',true,false);await key('3'.repeat(32),'owner',false,false);
    const before=await services.keys.list(owner as any);
    assert.deepEqual(before,{people:[{person:'owner',name:null,username:null,state:'on',open:2,last_use:'2026-01-02T03:04:05.000Z'}],stopped:null});
    await assert.rejects(services.keys.list({scope:null,admin:false} as any),{status:403});
    // Stop: every open key closes as stopped, and the counts say what ended; the same operation answers the same again.
    const stopped=await services.keys.stop(owner as any,{operation_id:'stop-1'});
    assert.deepEqual({...stopped,stopped_at:typeof stopped.stopped_at},{keys:2,cards:0,follow_ups:0,runs:0,jobs:0,grants:0,stopped_at:'string'});
    assert.deepEqual((await stores.control.query('SELECT jti,closed_reason FROM one_time_keys ORDER BY jti')).rows.map(row=>row.closed_reason),['stopped','stopped',null]);
    assert.deepEqual(await services.keys.stop(owner as any,{operation_id:'stop-1'}),stopped,'idempotent');
    const after=await services.keys.list(owner as any);
    assert.equal(after.people[0]!.open,0);assert.deepEqual(after.stopped,{at:stopped.stopped_at,keys:2,cards:0,follow_ups:0,runs:0,jobs:0,grants:0});
    await assert.rejects(services.keys.stop({scope:null,admin:false} as any,{operation_id:'stop-2'}),{status:403});
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
