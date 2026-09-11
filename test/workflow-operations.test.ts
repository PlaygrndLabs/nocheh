import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {fetchAttachments} from '../src/storage.js';
import {prepareArchiveFiles} from '../src/preparation.js';
import {prepareGuarded,setGuardMode} from '../src/guarded.js';
import {dispatchCommitted} from '../src/assistant.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';

test('targeted preparation and dispatch preserve source identity and exclude legacy or stale owners',{skip:!process.env.PGHOST},async()=>{
  const config={...settings(),assistant:{enabled:true,owner_id:'123',group_ids:[] as string[]}};
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace='workflow_operations_'+Date.now();
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`,max:8});
  const root=await mkdtemp(join(tmpdir(),'workflow-operations-'));config.dataDir=root;
  const source=(id:number):Envelope=>({version:1,key:'telegram:fixture:update:'+id,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:String(id),revision:'1',occurred_at:null,text:null,
    payload:{update_id:id,message:{message_id:id,chat:{id:123,type:'private'},from:{id:123,is_bot:false},voice:{file_id:'voice'+id}}}});
  try {
    await initialize(pool);await setGuardMode(pool,'on');
    const first=await ingest(pool,source(1)),second=await ingest(pool,source(2));
    await pauseFamily(pool,'preparation',1);await switchFamily(pool,'preparation',1,'inngest');
    let downloads=0,transcribes=0,dispatches=0;
    const download=async(ref:string)=>{assert.equal(ref,'voice1');downloads++;return Buffer.from('fixture audio');};
    await fetchAttachments(pool,root,download);
    await fetchAttachments(pool,root,download,first.id,{owner:'inngest',epoch:1});
    assert.equal(downloads,0);
    await fetchAttachments(pool,root,download,first.id,{owner:'inngest',epoch:2});assert.equal(downloads,1);
    await prepareArchiveFiles(pool,root,async()=>{throw Error('legacy preparation cannot run');});
    await prepareArchiveFiles(pool,root,async operation=>{assert.equal(operation,'perception.transcribe');transcribes++;return {success:true,transcript:'fixture transcript'};},first.id,{owner:'inngest',epoch:2});
    await prepareArchiveFiles(pool,root,async()=>{throw Error('stored transcript must be reused');},first.id,{owner:'inngest',epoch:2});
    assert.equal(transcribes,1);
    await prepareGuarded(pool,async()=>{throw Error('legacy guard runner cannot run');},'fixture',100,first.id);
    await prepareGuarded(pool,async()=>[],'fixture',100,first.id,{owner:'inngest',epoch:2});
    assert.equal((await pool.query("SELECT count(*) FROM guard_sources WHERE event_id=$1 AND state<>'ready'",[first.id])).rows[0].count,'0');
    assert.equal((await pool.query("SELECT state FROM artifacts WHERE event_id=$1",[second.id])).rows[0].state,'pending');
    await pauseFamily(pool,'telegram',1);await switchFamily(pool,'telegram',1,'inngest');
    await dispatchCommitted(pool,config,async()=>{throw Error('legacy dispatch cannot run');});
    await dispatchCommitted(pool,config,async(operation,input)=>{assert.equal(operation,'run.start');assert.equal(input.event_id,first.id);dispatches++;return {state:'done'};},first.id,{owner:'inngest',epoch:2});
    assert.equal(dispatches,1);
    await dispatchCommitted(pool,config,async()=>{throw Error('completed job cannot run');},first.id,{owner:'inngest',epoch:2});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[first.id])).rows[0].state,'done');
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[second.id])).rows[0].state,'pending');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
});
