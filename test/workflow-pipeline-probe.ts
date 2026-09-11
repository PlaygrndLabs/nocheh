/** Product functions, real local Inngest, synthetic runtime only. */
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {setGuardMode} from '../src/guarded.js';
import {pauseFamily,switchFamily,publishOutbox} from '../src/workflows/store.js';
import {pipelineOperations} from '../src/workflows/pipeline.js';
import {workflowFunctions} from '../src/workflows/engine.js';
import {workflowClient,connectWorkflows} from '../src/workflows/client.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const admin=new pg.Pool(),namespace='pipeline_probe_'+Date.now();await admin.query(`CREATE SCHEMA ${namespace}`);
const pool=new pg.Pool({options:`-c search_path=${namespace}`,max:8});
const root=await mkdtemp(join(tmpdir(),'pipeline-probe-'));
const config={...settings(),dataDir:root,assistant:{enabled:true,owner_id:'123',group_ids:[] as string[]}};
const client=workflowClient('pipeline');let connection:Awaited<ReturnType<typeof connectWorkflows>>|undefined;
const calls={download:0,transcribe:0,start:0,resume:0};
try {
  await initialize(pool);await setGuardMode(pool,'on');
  for(const family of ['preparation','telegram'] as const){await pauseFamily(pool,family,1);await switchFamily(pool,family,1,'inngest');}
  const operations=pipelineOperations(pool,config,async(operation,input)=>{
    if(operation==='source.file') {calls.download++;if(calls.download===1)throw Error('synthetic download outage');return {bytes_base64:Buffer.from('synthetic Ogg bytes').toString('base64')};}
    if(operation==='perception.transcribe'){calls.transcribe++;return {success:true,transcript:'Synthetic private transcript canary'};}
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='run.start'){calls.start++;if(calls.start!==1||input.attempt!==1||input.asynchronous!==true)throw Error('duplicate_runtime_effect');throw Error('synthetic lost start response after acceptance');}
    if(operation==='run.resume'){calls.resume++;if(input.attempt!==1)throw Error('replacement_attempt');return {state:'done'};}
    throw Error('unexpected_runtime_operation');
  });
  connection=await connectWorkflows('pipeline',client,workflowFunctions(client,pool,operations));
  const source:Envelope={version:1,key:'telegram:fixture:update:1',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'1',revision:'1',occurred_at:null,text:null,
    payload:{update_id:1,message:{message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false},voice:{file_id:'voice1'}}}};
  await ingest(pool,source);await ingest(pool,source);
  const deadline=Date.now()+120000;
  while(Date.now()<deadline) {
    await publishOutbox(pool,event=>client.send(event));
    const rows=(await pool.query('SELECT family,state,stage FROM workflow_registry ORDER BY family')).rows;
    if(rows.length===2&&rows.every(row=>row.state==='completed'))break;
    await delay(250);
  }
  const rows=(await pool.query('SELECT id,family,state,stage,attempts FROM workflow_registry ORDER BY family')).rows;
  if(rows.length!==2||rows.some(row=>row.state!=='completed'))throw Error('pipeline_did_not_complete');
  // A new transport event beyond any event dedup guarantee still cannot create
  // another effect for this permanently completed Nocheh workflow identity.
  const telegram=rows.find(row=>row.family==='telegram')!;
  await client.send({id:randomBytes(32).toString('hex'),name:'nocheh/workflow.requested',data:{workflow_id:telegram.id,dispatch:1,family:'telegram'}});
  await delay(1500);
  if(calls.start!==1||calls.transcribe!==1||calls.download!==2||calls.resume!==1)throw Error('pipeline_effect_count_mismatch');
  console.log(JSON.stringify({pipeline_probe:'passed',calls,workflows:rows.map(({id,...row})=>row),receipts:(await pool.query('SELECT step,attempt,state FROM workflow_receipts')).rows}));
}finally{await connection?.close();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
