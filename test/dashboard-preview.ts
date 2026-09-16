/** Isolated UI acceptance fixture. No poller, scheduler, provider, or effect executor. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {DashboardSessions} from '../src/dashboard-auth.js';
import {HttpError,json,readJson} from '../src/http.js';
import {requestWorkflow} from '../src/workflows/store.js';
import {listWorkflows,workflowHealth,workflowDetail,controlWorkflow} from '../src/workflows/owner.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_opt_in_required');
const pool=new pg.Pool(),sessions=new DashboardSessions(),port=Number(process.env.NOCHEH_DASHBOARD_PORT||18848);
await initialize(pool);
const client=await pool.connect();try{
 for(let i=0;i<90;i++){
  const family=(['browser','imports','tools','telegram','honcho','memory_review','preparation'] as const)[i%7]!;
  const id=await requestWorkflow(client,family,'ui-fixture-'+i);
  const state=i%11===0?'retryable_failed':i%13===0?'ambiguous':i%17===0?'failed':i%7===0?'waiting':i%9===0?'running':'completed';
  await client.query("UPDATE workflow_registry SET state=$2,created_at=now()-($3*interval '80 minutes'),updated_at=now()-($3*interval '80 minutes')+interval '47 seconds',stage=$4,attempts=1 WHERE id=$1 AND revision=1",[id,state,i+1,family==='honcho'?'sync':'execution']);
 }
 await client.query("INSERT INTO workflow_worker_registrations(family,version,app) SELECT family,1,CASE WHEN family IN ('tools','imports') THEN 'host' ELSE 'pipeline' END FROM workflow_owners ON CONFLICT(family) DO UPDATE SET seen_at=now()");
}finally{client.release();}
const id='a'.repeat(64),profile='fixture-owner';
const source={id,event:{text:'A synthetic conversation about the northern lights.',payload:{text:'A synthetic conversation about the northern lights.'},scope:'42',source_id:'fixture',channel:'telegram',received_at:new Date().toISOString()},artifacts:[],derived:[]};
let revision=1,guarded='A synthetic conversation about the northern lights.',settingsRevision='fixture-1';
let settingsChanges:Record<string,unknown>={};
const fields=[{key:'TELEGRAM_ENABLED',value:'false',editable:true},{key:'TELEGRAM_OWNER_ID',value:'42',editable:true},{key:'TELEGRAM_GROUP_IDS',value:'-10042',editable:true},{key:'NOCHEH_MODEL',value:'gpt-5.6-sol',editable:true},{key:'NOCHEH_GUARD_MODE',value:'on',editable:true},{key:'TELEGRAM_BOT_TOKEN',value:'',secret:true,configured:false,editable:true}];
const preferences={scope:'42',revision:'fixture-1',schema:{'agent.max_iterations':{min:1,max:100},'memory.memory_char_limit':{min:100,max:10000}},values:{'agent.max_iterations':20,'memory.memory_char_limit':2200},origins:{'agent.max_iterations':'global','memory.memory_char_limit':'profile'}};
const jobs:any[]=[{id:'11111111-1111-4111-8111-111111111111',kind:'import',state:'complete',created_at:new Date().toISOString(),completed:180,total:180,duplicates:3,preview:{messages:180,supplied_files:4,missing_files:1,chats:[{id:'chat-1',name:'Synthetic travel notes',messages:180}]},review_approved:false,mapping:{}},{id:'22222222-2222-4222-8222-222222222222',kind:'operations.diagnose',state:'complete',created_at:new Date().toISOString(),result:{containers:[{service:'nocheh-app',tool:'Nocheh',location:'docker',purpose:'Synthetic API',state:'running',expected_state:'running'}]}}];
const serviceRows=[['nocheh-app','Nocheh','Archive API and workflow handlers','running'],['nocheh-executor','Nocheh','Approved execution','running'],['hermes-runtime','Hermes','Assistant runtime','running'],['cliproxy-monitor','CPA Manager Plus','Provider observations','unhealthy'],['pgweb-archive','pgweb','Optional archive inspection','optional-stopped']].map(([service,tool,purpose,state])=>({service,tool,purpose,state,location:'docker',expected_state:state==='optional-stopped'?state:'running'}));
async function scenario(){try{return (await readFile('/tmp/nocheh-ui-scenario','utf8')).trim();}catch{return 'normal';}}
const server=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url||'/','http://fixture'),path=url.pathname;
 if(req.method==='GET'&&path==='/'){
  const session=sessions.page(req);res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader('content-type','text/html');res.end((await readFile('web/dist/index.html','utf8')).replace('/*NOCHEH_BOOTSTRAP*/',`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`));return;
 }
 if(req.method==='GET'&&/^\/assets\/(?:app\.js|style\.css|graph-3d\.js|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(path)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join('web/dist',path.slice(8))));return;}
 sessions.authorize(req,req.method!=='GET');
 if(['/inngest/runs','/hermes/nocheh','/providers/management.html'].includes(path)){res.setHeader('content-type','text/html');res.end('<h1>Synthetic integration boundary</h1><p>This isolated preview has no native runtime or provider. Production proxy behavior is verified by boundary tests.</p><a href="/">Return to Nocheh</a>');return;}
 const route=path.replace(/^\/api\/(?:plugins\/)?nocheh/,'');
 const mode=await scenario();if(mode==='offline'&&['/monitoring','/workflows/metrics','/status'].includes(route))throw new HttpError(503,'fixture_observation_unavailable');
 if(req.method==='GET'){
  if(route==='/health')return json(res,200,{ok:true});
  if(route==='/monitoring'){const workflows=await workflowHealth(pool);return json(res,200,{checked_at:new Date().toISOString(),telegram_enabled:false,runtime:{status:{telegram:'disabled',reasoning_route:'shared'}},archive:{archive:{telegram:[],workflows:[],preparation:[{state:'ready',count:180}],artifacts:[],transcriptions:[],actions:[]},guard_mode:'on'},provider:{login_present:true},application:{ok:true,capture:{capture:'ready'},workflows:'connected'},workflows:mode==='unavailable'?{unavailable:true}:workflows,services:serviceRows});}
  if(route==='/workflows')return json(res,200,await listWorkflows(pool,Object.fromEntries(url.searchParams)));
  if(route==='/workflows/health')return json(res,200,await workflowHealth(pool));
  if(/^\/workflows\/[a-f0-9]{64}$/.test(route))return json(res,200,await workflowDetail(pool,route.split('/')[2]!));
  if(route==='/status')return json(res,200,{archive:{events:1842,artifacts:[{state:'ready',count:28}],dispatches:[{state:'done',count:86}],transcriptions:[{state:'done',count:12}],actions:[]},guard_mode:'on',services:[]});
  if(route==='/settings')return json(res,200,{revision:settingsRevision,apply_state:'current',fields:fields.map(f=>({...f,value:settingsChanges[f.key]??f.value}))});
  if(route==='/jobs')return json(res,200,jobs);
  if(route==='/operations')return json(res,200,{backups:[]});
  if(route==='/scopes')return json(res,200,{scopes:[{scope:'42',events:180},{scope:'-10042',events:32}],next:null});
  if(route==='/events'||route==='/search')return json(res,200,{events:[source.event?{...source.event,id,text:source.event.text}:source],results:[{...source.event,id}],next:null});
  if(route==='/events/'+id)return json(res,200,source);
  if(route==='/data/'+id+'/guarded')return json(res,200,{projections:[{id:'b'.repeat(64),source_id:id,kind:'events',state:'ready',active_revision:revision,author:revision>1?'owner':'automatic',content:{text:guarded,payload:{text:guarded}}}]});
  if(route==='/data/'+id+'/guarded/history')return json(res,200,url.searchParams.has('revision')?{revision:1,content:{text:source.event.text}}:{revisions:[{revision:1,author:'automatic',created_at:new Date().toISOString()}],next:null});
  if(route==='/memory/profiles')return json(res,200,{profiles:[{owner:true,scope:'42',profile},{owner:false,scope:'-10042',profile:'fixture-group'}]});
  if(route==='/memory')return json(res,200,{scope:url.searchParams.get('scope'),profile:url.searchParams.get('profile'),memories:[{name:'MEMORY.md',exists:true,text:'Synthetic memory: interested in astronomy. Verify against original evidence.',citations:[]}],sessions:[{id:'fixture-session',title:'Planning a stargazing trip',source:'browser'}],messages:url.searchParams.get('session')?[{id:'m1',role:'user',content:'Where can we see the northern lights?'}]:[],next_offset:null});
  if(route==='/memory/preferences'||route==='/policy')return json(res,200,preferences);
  if(route==='/memory/honcho')return json(res,200,{connection:{attached:true,verified:true},limited_memory:false,sync:{state:'syncing',pending:4},generations:[{id:'fixture',state:'ready',mode:'on'}],receipts:[{state:'done',count:176},{state:'pending',count:4}]});
  if(route==='/honcho/status')return json(res,200,{enabled:true,attached:true,status:'ready'});
  if(route==='/runtime')return json(res,200,{status:{ok:true,model:'Subscription model',telegram:'disabled'},capabilities:{chat:true,sessions:true}});
  if(route==='/graph')return json(res,200,{scope:url.searchParams.get('scope'),nodes:[{id:'scope:42',kind:'scope',label:'Owner private'},{id:'event:'+id,event_id:id,kind:'message',label:'Northern lights trip'},{id:'author:owner',kind:'author',label:'Owner'}],edges:[{from:'scope:42',to:'event:'+id,kind:'contains'},{from:'author:owner',to:'event:'+id,kind:'authored'}],bounds:{truncated:false},unresolved_replies:0,next:null});
  if(route==='/runs')return json(res,200,{runs:[]});
  if(route==='/tools/actions')return json(res,200,{actions:[],permissions:[]});
  if(route==='/memory/spaces')return json(res,200,{spaces:[{scope:'42',kind:'owner',name:'Owner',policy:{mode:'isolated'},revision:1}]});
  if(route==='/memory/reviews')return json(res,200,{jobs:[]});
 }
 if(req.method==='POST'){
  const body=await readJson(req) as any;
  if(/^\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(route))return json(res,200,await controlWorkflow(pool,route.split('/')[2]!,route.split('/')[3]!,body));
  if(route==='/settings'){if(body.revision!==settingsRevision)throw new HttpError(409,'configuration_conflict');settingsChanges={...settingsChanges,...body.changes};settingsRevision+='x';return json(res,200,{ok:true});}
  if(route==='/data/'+id+'/guarded'){if(body.expected_revision!==revision)throw new HttpError(409,'guard_revision_conflict');guarded=body.content?.text??source.event.text;revision++;return json(res,200,{ok:true});}
 }
 throw new HttpError(404,'fixture_capability_unavailable');
})().catch(error=>json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'fixture_request_failed'}));});
server.listen(port,'0.0.0.0',()=>console.log(`Synthetic dashboard preview ready on ${port}; no external execution authorities.`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>void pool.end());});
