/** Real local Inngest + host Node/Python import worker; synthetic installation. */
import pg from 'pg';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {initialize} from '../src/database.js';
import {importRecord,uploadArtifact} from '../src/retrieval.js';
import {readJson,json,authorize,HttpError} from '../src/http.js';
import {hostTransport} from '../src/workflows/host-transport.js';
import {claimHostWorkflow,renewHostWorkflow,finishHostWorkflow,continueHostWorkflow} from '../src/workflows/host-coordinator.js';
import {confirmImport,enterImportWrite,importConfiguration} from '../src/workflows/imports.js';
import {pauseFamily,switchFamily,publishOutbox,registerWorker} from '../src/workflows/store.js';
import {workflowClient} from '../src/workflows/client.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const admin=new pg.Pool(),schema='host_probe_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({options:`-c search_path=${schema}`,max:8}),state=await mkdtemp(join(tmpdir(),'workflow-host-'));
const serviceToken=process.env.SERVICE_TOKEN!,key=process.env.INNGEST_SIGNING_KEY!;
const transport=hostTransport(key);let lostReceipt=false,child:ChildProcess|undefined;const failures:Record<string,number>={};
const server=createServer((req,res)=>{void(async()=>{
  if(transport.handle(req,res))return;
  authorize(req,serviceToken);const body=await readJson(req,70*1024*1024),path=req.url!;
  const host='/v1/workflows/host/';
  if(path===host+'claim')return json(res,200,await claimHostWorkflow(pool,body));
  if(path===host+'renew')return json(res,200,await renewHostWorkflow(pool,body));
  if(path===host+'finish'){
    const receipt=await finishHostWorkflow(pool,body);
    if(!lostReceipt){lostReceipt=true;res.destroy();return;}
    return json(res,200,receipt);
  }
  if(path===host+'continue')return json(res,200,await continueHostWorkflow(pool,body));
  if(path===host+'heartbeat'){await registerWorker(pool,'host',['imports']);return json(res,200,{ok:true});}
  const held=await enterImportWrite(pool,req.headers['x-nocheh-import-job'],req.headers['x-nocheh-import-lease'],req.headers['x-nocheh-import-owner']);
  try{
    if(path==='/v1/import')return json(res,200,await importRecord(pool,body));
    if(/^\/v1\/artifacts\/[a-f0-9]{64}\/bytes$/.test(path))return json(res,200,await uploadArtifact(pool,state,path.split('/')[3]!,body));
    throw Error('unexpected_import_route');
  }finally{await held.release();}
})().catch(error=>{const code=error instanceof HttpError?error.code:'fixture_operation_failed';failures[code]=(failures[code]??0)+1;if(!res.headersSent)json(res,503,{error:'fixture_operation_failed'});else res.destroy();});});
transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
try{
  await initialize(pool);await pauseFamily(pool,'imports',1);await switchFamily(pool,'imports',1,'inngest');
  const id=randomUUID(),directory=join(state,'admin/jobs',id);await mkdir(join(directory,'upload'),{recursive:true});
  const document={id:Date.now(),type:'private_group',name:'Synthetic import',messages:Array.from({length:103},(_,id)=>({id,type:'message',text:'Private import probe canary '+id}))};
  const source=JSON.stringify(document),preview={file:'upload/result.json',sha256:createHash('sha256').update(source).digest('hex'),messages:103};
  await writeFile(join(directory,'upload/result.json'),source,{mode:0o600});
  await writeFile(join(directory,'job.json'),JSON.stringify({id,kind:'import',state:'running',preview,mapping:{},review_approved:false}),{mode:0o600});
  await writeFile(join(state,'.env'),Object.entries({NOCHEH_CONFIG_VERSION:'1',NOCHEH_PORT:String(port),SERVICE_TOKEN:serviceToken}).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
  await confirmImport(pool,{id,configuration_hash:importConfiguration(preview,{},false),review_approved:false,total:103});
  child=spawn(process.execPath,[resolve('dist/src/workflows/host.js')],{env:{...process.env,NOCHEH_STATE_DIR:state,NOCHEH_PORT:String(port),INNGEST_BASE_URL:'http://127.0.0.1:'+port,INNGEST_CONNECT_GATEWAY_URL:'ws://127.0.0.1:'+port+'/v0/connect'},stdio:'ignore'});
  const publisher=workflowClient('pipeline'),deadline=Date.now()+90000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw Error('host_worker_exited');
    await publishOutbox(pool,event=>publisher.send(event));
    if((await pool.query('SELECT state FROM workflow_imports WHERE id=$1',[id])).rows[0].state==='completed')break;
    await delay(250);
  }
  const job=(await pool.query('SELECT state,completed,duplicates FROM workflow_imports WHERE id=$1',[id])).rows[0];
  const counts=(await pool.query("SELECT (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM dispatches WHERE state<>'suppressed') AS replies,(SELECT count(*)::int FROM memory_learning_sources) AS learning,(SELECT count(*)::int FROM workflow_host_receipts) AS batches")).rows[0];
  if(job.state!=='completed'||job.completed!==103||counts.events!==104||counts.replies!==0||counts.learning!==0||counts.batches!==3||!lostReceipt){console.log(JSON.stringify({probe:'failed',job,counts,failures,workflows:(await pool.query("SELECT state,stage,attempts,waiting_reason FROM workflow_registry WHERE family='imports'")).rows}));throw Error('host_import_probe_failed');}
  console.log(JSON.stringify({host_probe:'passed',job,counts,injected_lost_receipt_responses:1}));
}finally{
  if(child&&child.exitCode===null){const closed=once(child,'exit');child.kill('SIGTERM');await closed;}
  transport.close();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(state,{recursive:true,force:true});
}
