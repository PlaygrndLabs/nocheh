/** Explicit synthetic fixture. No runtime, publisher, scheduler or tool executor. */
import {createServer} from 'node:http';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,archiveStatus} from '../src/archive.js';
import {readEvent} from '../src/retrieval.js';
import {authorize,HttpError,json,readJson} from '../src/http.js';
import {listWorkflows,workflowDetail,workflowHealth,controlWorkflow} from '../src/workflows/owner.js';
import {proxyInngestInspection} from '../src/workflows/inspection.js';
import {requestWorkflow} from '../src/workflows/store.js';

if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_opt_in_required');
const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
const admin=new pg.Pool(connection);await admin.query('CREATE SCHEMA IF NOT EXISTS workflow_monitor_preview');await admin.end();
const pool=new pg.Pool({...connection,options:'-c search_path=workflow_monitor_preview'});await initialize(pool);
const event=await ingest(pool,{version:1,key:'monitor-preview',origin:'import',kind:'message',channel:'browser',bot_id:'fixture',scope:'42',source_id:'preview',revision:'0',occurred_at:null,text:'Synthetic monitoring preview. No external action is executed.',payload:{profile:'owner'}},false);
await pool.query("INSERT INTO controlled_actions(id,event_id,scope,profile,kind,arguments,fingerprint,state) VALUES($1,$2,'42','owner','shell',$3,$1,'approved') ON CONFLICT DO NOTHING",['f'.repeat(64),event.id,Buffer.from('{"command":"synthetic preview only"}')]);
await pool.query("UPDATE workflow_registry SET state='retryable_failed',stage='action',waiting_reason='workflow_execution_failed',attempts=2,next_attempt=now()+interval '1 hour' WHERE family='tools' AND revision=1");
await pool.query("UPDATE workflow_owners SET owner='inngest' WHERE family='tools'");
const client=await pool.connect();try{
  for(const [family,state] of [['imports','waiting'],['telegram','ambiguous'],['browser','completed'],['honcho','waiting']] as const){
    const id=await requestWorkflow(client,family,family==='imports'?'11111111-1111-4111-8111-111111111111':'e'.repeat(64));
    await client.query("UPDATE workflow_registry SET state=$2,stage=$3,waiting_reason=$4 WHERE id=$1 AND revision=1",[id,state,family==='honcho'?'sync':'admission',state==='waiting'?'prerequisite':null]);
  }
}finally{client.release();}
const server=createServer((req,res)=>{void(async()=>{
  authorize(req,config.token);const url=new URL(req.url??'/','http://fixture'),path=url.pathname;
  if(path.startsWith('/v1/workflows/inspection/'))return proxyInngestInspection(req,res,process.env.INNGEST_SIGNING_KEY??'');
  if(req.method==='GET'){
    if(path==='/v1/workflows')return json(res,200,await listWorkflows(pool,Object.fromEntries(url.searchParams)));
    if(path==='/v1/workflows/health')return json(res,200,await workflowHealth(pool));
    if(/^\/v1\/workflows\/[a-f0-9]{64}$/.test(path))return json(res,200,await workflowDetail(pool,path.split('/').at(-1)!));
    if(path==='/v1/status')return json(res,200,{archive:await archiveStatus(pool),guard_mode:'on',services:[]});
    if(path==='/v1/runtime')return json(res,200,{status:{telegram:'disabled',reasoning_route:'native'},fixture:true});
    if(/^\/v1\/events\/[a-f0-9]{64}$/.test(path))return json(res,200,await readEvent(pool,{admin:true,scope:null},path.split('/').at(-1)!));
  }
  if(req.method==='POST'&&/^\/v1\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(path))return json(res,200,await controlWorkflow(pool,path.split('/')[3]!,path.split('/')[4]!,await readJson(req)));
  throw new HttpError(403,'fixture_route_denied');
})().catch(error=>json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'fixture_unavailable'}));});
server.listen(8780,'0.0.0.0',()=>console.log('Synthetic workflow monitoring fixture ready; all routes require fixture authorization.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>{void pool.end();});});
