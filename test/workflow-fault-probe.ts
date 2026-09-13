/** Multi-process fault rehearsal. Synthetic Compose only; no live runtime. */
import pg from 'pg';
import {createServer} from 'node:http';
import {readFile,readdir,mkdir,writeFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {immutableFile,drainSpool,fetchAttachments} from '../src/storage.js';
import {setGuardMode,prepareGuarded} from '../src/guarded.js';
import {prepareArchiveFiles} from '../src/preparation.js';
import {dispatchCommitted} from '../src/assistant.js';
import {authorize,readJson,json,object} from '../src/http.js';
import {startLoops} from '../src/worker-loops.js';
import {hermesAdapter} from '../src/hermes-adapter.js';
import {runtimeCall} from '../src/runtime.js';
import {workflowClient,connectWorkflows} from '../src/workflows/client.js';
import {workflowFunctions} from '../src/workflows/engine.js';
import {pipelineOperations} from '../src/workflows/pipeline.js';
import {publishOutbox,registerWorker} from '../src/workflows/store.js';
import {beginMigration,finishMigration} from '../src/workflows/migrations.js';

if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const action=process.argv[2],schema=process.env.NOCHEH_FAULT_SCHEMA??'';
if(!/^fault_[a-f0-9]{8,32}$/.test(schema))throw Error('synthetic_schema_required');
const root='/fixture',config={...settings(),dataDir:root,assistant:{enabled:true,owner_id:'123',group_ids:[] as string[]}};
const pool=new pg.Pool({options:`-c search_path=${schema}`,max:8,connectionTimeoutMillis:3000,statement_timeout:10000});
pool.on('error',()=>{});
const source=(label:string):Envelope=>({version:1,key:'telegram:fixture:'+schema+':'+label,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:label,revision:'1',occurred_at:null,text:null,
  payload:{message:{message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false},voice:{file_id:label}}}});
let close:undefined|(()=>Promise<unknown>);
try{
  await mkdir(root,{recursive:true});
  if(action==='init'){
    const admin=new pg.Pool();try{await admin.query(`CREATE SCHEMA ${schema}`);}finally{await admin.end();}
    await initialize(pool);await setGuardMode(pool,'on');
    console.log(JSON.stringify({fixture:'initialized'}));
  }else if(action==='capture'){
    const label=process.argv[3]??'';if(!/^[a-z_]{1,50}$/.test(label))throw Error('invalid_capture_label');
    const value=source(label);await immutableFile(join(root,'spool/pending'),digest(value.key)+'.json',Buffer.from(canonical(value)));
    console.log(JSON.stringify({capture:'fsynced',id:digest(value.key)}));
  }else if(action==='migrate'){
    const target=process.argv[3];if(!['legacy','inngest'].includes(target??''))throw Error('invalid_owner');
    for(const family of ['preparation','telegram'] as const){
      const owner=(await pool.query('SELECT * FROM workflow_owners WHERE family=$1',[family])).rows[0];
      if(owner.owner===target)continue;
      const id=digest(schema+':'+family+':'+owner.epoch+':'+target);
      await beginMigration(pool,{id,family,owner:target,epoch:owner.epoch});
      await finishMigration(pool,id,'switch');
    }
    console.log(JSON.stringify({owner:target,migration:'switched'}));
  }else if(action==='runtime'){
    const receiptDirectory=join(root,'runtime-receipts');await mkdir(receiptDirectory,{recursive:true,mode:0o700});
    const server=createServer((req,res)=>{void(async()=>{
      authorize(req,process.env.SERVICE_TOKEN!);const body=object(await readJson(req)),path=req.url;
      if(path==='/internal/file')return json(res,200,{bytes_base64:Buffer.from('Synthetic Ogg bytes').toString('base64')});
      if(path==='/internal/transcribe')return json(res,200,{success:true,transcript:'Synthetic protected fault rehearsal transcript'});
      if(path==='/internal/detect')return json(res,200,{literals:[]});
      if(!/^[a-f0-9]{64}$/.test(String(body.event_id)))throw Error('fixture_identity_required');
      const id=digest(JSON.stringify([body.channel??'telegram',body.event_id,body.attempt])),receipt=join(receiptDirectory,id+'.json');
      if(path==='/internal/run/start'||path==='/internal/dispatch'){
        if(existsSync(receipt))throw Error('duplicate_fixture_effect');
        await immutableFile(receiptDirectory,id+'.json',Buffer.from(JSON.stringify({id,event_id:body.event_id,attempt:body.attempt,state:'done'})));
        if(existsSync(join(root,'crash-after-effect'))){await unlink(join(root,'crash-after-effect'));process.exit(137);}
        return json(res,200,{state:'done'});
      }
      if(path==='/internal/run/resume')return json(res,200,{state:existsSync(receipt)?'done':'not_found'});
      throw Error('unexpected_fixture_runtime_operation');
    })().catch(()=>{if(!res.headersSent)json(res,503,{error:'fixture_runtime_failed'});else res.destroy();});});
    server.listen(8781,'0.0.0.0');close=()=>new Promise<void>(resolve=>server.close(()=>resolve()));
  }else if(action==='worker'){
    const client=workflowClient('pipeline'),runtime=runtimeCall(hermesAdapter({url:'http://fault-runtime:8781',token:process.env.SERVICE_TOKEN!}));
    const connection=await connectWorkflows('pipeline',client,workflowFunctions(client,pool,pipelineOperations(pool,config,runtime)));
    const report=async()=>{if(connection.state==='ACTIVE')await registerWorker(pool,'pipeline',['preparation','telegram']);};
    await report();const timer=setInterval(()=>{void report().catch(()=>{});},1000);
    close=async()=>{clearInterval(timer);await connection.close();};
  }else if(action==='publisher'){
    const client=workflowClient('pipeline');
    close=startLoops({capture:()=>drainSpool(pool,root),outbox:()=>publishOutbox(pool,event=>client.send(event))},250,()=>{});
  }else if(action==='crash-receipt'){
    await writeFile(join(root,'crash-after-effect'),'1',{mode:0o600});
    console.log(JSON.stringify({runtime_crash:'armed'}));
  }else if(action==='status'||action==='verify'||action==='legacy-drain'){
    const expected=Number(process.argv[3]??0),deadline=Date.now()+(action==='status'?0:180000);
    const runtime=runtimeCall(hermesAdapter({url:'http://fault-runtime:8781',token:process.env.SERVICE_TOKEN!}));
    while(true){
      if(action==='legacy-drain'){
        await drainSpool(pool,root);
        await fetchAttachments(pool,root,async ref=>Buffer.from(String((await runtime('source.file',{file_id:ref})).bytes_base64),'base64'));
        await prepareArchiveFiles(pool,root,runtime);
        await prepareGuarded(pool,async text=>(await runtime('guard.detect',{text})).literals,config.detectorVersion);
        await dispatchCommitted(pool,config,runtime);
      }
      const events=Number((await pool.query('SELECT count(*) FROM events')).rows[0].count);
      const workflows=(await pool.query('SELECT family,state,count(*)::int AS count FROM workflow_registry GROUP BY family,state ORDER BY family,state')).rows;
      const outbox=(await pool.query('SELECT count(*)::int AS count FROM workflow_outbox WHERE published_at IS NULL AND dispatch=(SELECT dispatch FROM workflow_registry WHERE id=workflow_id)')).rows[0].count;
      const pending=(await readdir(join(root,'spool/pending')).catch(()=>[])).length;
      const receipts=(await readdir(join(root,'runtime-receipts')).catch(()=>[])).length;
      const ready_sources=Number((await pool.query(action==='legacy-drain'?`SELECT count(*) FROM events e WHERE
        NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.event_id=e.id AND a.state<>'ready')
        AND NOT EXISTS(SELECT 1 FROM guard_sources g WHERE g.event_id=e.id AND g.state<>'ready')
        AND EXISTS(SELECT 1 FROM dispatches d WHERE d.event_id=e.id AND d.state='done')`:`SELECT count(*) FROM events e WHERE
        (SELECT state FROM workflow_registry WHERE job_id=e.id AND family='preparation' ORDER BY generation DESC LIMIT 1)='completed'
        AND EXISTS(SELECT 1 FROM dispatches d WHERE d.event_id=e.id AND d.state='done')`)).rows[0].count);
      if(action==='status'||events===expected&&ready_sources===expected&&receipts===expected&&pending===0){
        console.log(JSON.stringify({events,ready_sources,workflows,outbox,pending,receipts,...(action!=='status'?{recovery:'passed'}:{})}));break;
      }
      if(Date.now()>deadline)throw Error('fault_recovery_incomplete');await delay(500);
    }
  }else throw Error('fixture_action_required');
}catch{
  console.error(JSON.stringify({error:'fault_probe_failed',action}));process.exitCode=1;
}finally{
  if(close){
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void close!().then(()=>pool.end()).then(()=>process.exit());};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }else await pool.end();
}
