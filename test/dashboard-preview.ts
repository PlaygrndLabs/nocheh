import {workflowMetrics} from '../src/workflows/metrics.js';
/** Isolated UI acceptance fixture. No poller, scheduler, provider, or effect executor. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
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
let modeRevision=false;
let revision=1,guarded='A synthetic conversation about the northern lights.',settingsRevision='fixture-1';
let settingsChanges:Record<string,unknown>={};
const fields=[{key:'TELEGRAM_ENABLED',value:'false',editable:true},{key:'TELEGRAM_OWNER_ID',value:'42',editable:true},{key:'TELEGRAM_GROUP_IDS',value:'-10042',editable:true},{key:'NOCHEH_MODEL',value:'gpt-5.6-sol',editable:true},{key:'NOCHEH_GUARD_MODE',value:'on',editable:true},{key:'TELEGRAM_BOT_TOKEN',value:'',secret:true,configured:false,editable:true}];
const preferences={scope:'42',revision:'fixture-1',schema:{'agent.max_iterations':{min:1,max:100},'memory.memory_char_limit':{min:100,max:10000}},values:{'agent.max_iterations':20,'memory.memory_char_limit':2200},origins:{'agent.max_iterations':'global','memory.memory_char_limit':'profile'}};
const preview={messages:180,supplied_files:4,missing_files:1,chats:[{id:'chat-1',name:'Synthetic travel notes',messages:180}]};
const jobs:any[]=[{id:'11111111-1111-4111-8111-111111111111',kind:'import',state:'ready',created_at:new Date().toISOString(),completed:0,total:180,duplicates:0,preview},
{id:'33333333-3333-4333-8333-333333333333',kind:'import',state:'cancelled',created_at:new Date().toISOString(),completed:40,total:180,duplicates:3,preview,review_approved:true,mapping:{'chat-1':'-10042'}},
{id:'22222222-2222-4222-8222-222222222222',kind:'operations.diagnose',state:'complete',created_at:new Date().toISOString(),result:{containers:[{service:'nocheh-app',tool:'Nocheh',location:'docker',purpose:'Synthetic API',state:'running',expected_state:'running'}]}}];
const actions:any[]=[{id:'c'.repeat(64),fingerprint:'d'.repeat(64),kind:'shell',scope:'42',profile,arguments:{command:'printf synthetic-preview',workspace:'synthetic-demo'},state:'proposed',created_at:new Date().toISOString()}],permissions:any[]=[];
let spaceRevision=1,spaceOverrides:Record<string,any>={mode:'approved'},shares:any[]=[];
let memoryAttached=true;
const serviceRows=[['nocheh-app','Nocheh','Archive API and workflow handlers','running'],['nocheh-executor','Nocheh','Approved execution','running'],['hermes','Hermes','Assistant runtime','running'],['cliproxy-monitor','CPA Manager Plus','Provider observations','unhealthy'],['pgweb-archive','pgweb','Optional archive inspection','optional-stopped']].map(([service,tool,purpose,state])=>({service,tool,purpose,state,location:'docker',expected_state:state==='optional-stopped'?state:'running'}));
const personId='1'.repeat(64),projectEntityId='2'.repeat(64),projectId='project-fixture',factId='3'.repeat(64),requestId='4'.repeat(64),grantId='5'.repeat(64),conversation='-10042',topic='-10042/topic/7';
const memoryMapNodes:any[]=[
 {id:`person:${personId}`,kind:'person',label:'Mira Chen',state:'active',detail:{revision:2,fact_count:2}},
 {id:`project:${projectEntityId}`,kind:'project',label:'Aurora field guide',state:'active',detail:{revision:1,project_id:projectId,project:{id:projectId,name:'Aurora field guide',description:'Synthetic project for the isolated preview.',state:'active',revision:1}}},
 {id:`conversation:${conversation}`,kind:'conversation',label:'Friends travel group',detail:{space_id:conversation,assignment:{space_id:conversation,project_id:projectId,mode:'assigned',revision:1}}},
 {id:`topic:${topic}`,kind:'topic',label:'Topic 7 · Iceland planning',detail:{space_id:topic,parent:conversation,assignment:{space_id:topic,project_id:null,mode:'inherit',revision:1}}},
 {id:`fact:${factId}`,kind:'fact',label:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',state:'active',detail:{revision:1,predicate:'preference',attribution:'direct',uncertainty:'explicit',evidence:[{id}],author:'fixture-owner',created_at:new Date().toISOString()}},
];
const memoryMapEdges:any[]=[
 {id:`relationship:fact:${factId}`,kind:'relationship',source:`person:${personId}`,target:`fact:${factId}`,label:'preference',authoritative:false,detail:{claim_id:factId,content:memoryMapNodes[4].label,attribution:'direct',uncertainty:'explicit',evidence:[{id}],revision:1}},
 {id:`project_assignment:${conversation}`,kind:'project_assignment',source:`project:${projectEntityId}`,target:`conversation:${conversation}`,label:'contains',authoritative:false,detail:{destination:conversation,project_id:projectId,mode:'assigned',revision:1}},
 {id:`access:${grantId}`,kind:'access',source:`fact:${factId}`,target:`topic:${topic}`,state:'active',label:'persistent',authoritative:true,detail:{grant_id:grantId,destination:topic,wording:'Mira prefers quiet aurora viewpoints.',mode:'persistent',revision:1,fact_revision:1}},
 {id:`suggestion:${requestId}`,kind:'suggestion',source:`fact:${factId}`,target:`conversation:${conversation}`,state:'pending',label:'suggested',authoritative:false,detail:{request_id:requestId,destination:conversation,wording:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',revision:1,fact_revision:1,relationship_path:['Mira Chen','Aurora field guide'],evidence:[{id}],expires_at:new Date(Date.now()+86400000).toISOString()}},
];
const memoryAccessRequest={id:requestId,destination:conversation,state:'pending',revision:1,expires_at:new Date(Date.now()+86400000).toISOString(),wording:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',relationship_path:['Mira Chen','Aurora field guide'],evidence:[{id}],provenance:{fixture:true}};
const memoryGrant={id:grantId,destination:topic,fact_revision:1,mode:'persistent',state:'active',revision:1,wording:'Mira prefers quiet aurora viewpoints.',suspended_reason:null,provenance:{fixture:true}};
async function scenario(){try{return (await readFile('/tmp/nocheh-ui-scenario','utf8')).trim();}catch{return 'normal';}}
const server=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url||'/','http://fixture'),path=url.pathname;
 if(req.method==='GET'&&path==='/'){
  const session=sessions.page(req);res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader('content-type','text/html');res.end((await readFile('web/dist/index.html','utf8')).replace('/*NOCHEH_BOOTSTRAP*/',`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`));return;
 }
 if(req.method==='GET'&&path==='/assets/graph-3d.js'&&await scenario()==='no-graphics'){res.setHeader('content-type','text/javascript');res.end('export function createGraphScene(){throw new Error("Synthetic unavailable graphics")}');return;}
 if(req.method==='GET'&&/^\/assets\/(?:app\.js|style\.css|graph-3d\.js|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(path)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join('web/dist',path.slice(8))));return;}
 sessions.authorize(req,req.method!=='GET');
 if(['/inngest/runs','/hermes/nocheh','/providers/management.html'].includes(path)){res.setHeader('content-type','text/html');res.end('<h1>Synthetic integration boundary</h1><p>This isolated preview has no native runtime or provider. Production proxy behavior is verified by boundary tests.</p><a href="/">Return to Nocheh</a>');return;}
 const route=path.replace(/^\/api\/(?:plugins\/)?nocheh/,'');
 const mode=await scenario();if(mode==='conflict'&&!modeRevision){settingsRevision+='external';revision++;modeRevision=true;}if(mode!=='conflict')modeRevision=false;if(mode==='offline'&&['/monitoring','/workflows/metrics','/status','/tools/actions'].includes(route))throw new HttpError(503,'fixture_observation_unavailable');
 if(req.method==='GET'){
  if(route==='/health')return json(res,200,{ok:true});
  if(route==='/monitoring'){const workflows=await workflowHealth(pool);return json(res,200,{checked_at:new Date().toISOString(),telegram_enabled:false,runtime:{status:{telegram:'disabled',reasoning_route:'shared'}},archive:{archive:{telegram:[],workflows:[],preparation:[{state:'ready',count:180}],artifacts:[],transcriptions:[],actions:[]},guard_mode:'on'},provider:{login_present:true},application:{ok:true,capture:{capture:'ready'},workflows:'connected'},workflows:mode==='unavailable'?{unavailable:true}:workflows,services:serviceRows});}
  if(route==='/workflows')return json(res,200,await listWorkflows(pool,Object.fromEntries(url.searchParams)));
  if(route==='/workflows/metrics')return json(res,200,await workflowMetrics(pool,Object.fromEntries(url.searchParams)));
  if(route==='/workflows/health')return json(res,200,await workflowHealth(pool));
  if(/^\/workflows\/[a-f0-9]{64}$/.test(route))return json(res,200,await workflowDetail(pool,route.split('/')[2]!));
  if(route==='/status')return json(res,200,{archive:{events:1842,artifacts:[{state:'ready',count:28}],dispatches:[{state:'done',count:86}],transcriptions:[{state:'done',count:12}],actions:[],managed_runs:[{event_id:id,state:'done',created_at:new Date().toISOString(),channel:'browser',profile,scope:'42'}]},guard_mode:'on',services:[]});
  if(route==='/settings')return json(res,200,{revision:settingsRevision,apply_state:'current',fields:fields.map(f=>({...f,value:settingsChanges[f.key]??f.value}))});
  if(route==='/jobs')return json(res,200,jobs);
  if(route==='/operations')return json(res,200,{backups:[{id:'synthetic-backup',created_at:'2026-09-16T12:00:00Z',files:28}]});
  if(route==='/scopes')return json(res,200,{scopes:[{scope:'42',events:180},{scope:'-10042',events:32}],next:null});
  if(route==='/data')return json(res,200,{records:[{...source.event,id,ready:1,total:1}],next:null});
  if(route==='/search')return json(res,200,[{...source.event,id}]);
  if(route==='/events')return json(res,200,{events:[source.event?{...source.event,id,text:source.event.text}:source],results:[{...source.event,id}],next:null});
  if(route==='/events/'+id)return json(res,200,source);
  if(route==='/data/'+id+'/guarded')return json(res,200,{projections:[{id:'b'.repeat(64),source_id:id,kind:'events',state:'ready',active_revision:revision,author:revision>1?'owner':'automatic',content:{text:guarded,payload:{text:guarded}}}]});
  if(route==='/data/'+id+'/guarded/history')return json(res,200,url.searchParams.has('revision')?{revision:1,content:{text:source.event.text}}:{revisions:[{revision:1,author:'automatic',created_at:new Date().toISOString()}],next:null});
  if(route==='/memory/profiles')return json(res,200,{profiles:[{owner:true,scope:'42',profile},{owner:false,scope:'-10042',profile:'fixture-group'}]});
  if(route==='/memory')return json(res,200,{scope:url.searchParams.get('scope'),profile:url.searchParams.get('profile'),memories:[{name:'MEMORY.md',exists:true,text:'Synthetic memory: interested in astronomy. Verify against original evidence.',citations:[]}],sessions:[{id:'fixture-session',title:'Planning a stargazing trip',source:'browser'}],messages:url.searchParams.get('session')?[{id:'m1',role:'user',content:'Where can we see the northern lights?'}]:[],next_offset:null});
  if(route==='/memory/preferences'||route==='/policy')return json(res,200,preferences);
  if(route==='/memory/honcho')return json(res,200,{connection:{attached:memoryAttached,verified:true},limited_memory:!memoryAttached,syncing:true,generations:[{id:'fixture',state:'ready',mode:'on'}],receipts:[{state:'done',count:176},{state:'pending',count:4}]});
  if(route==='/honcho/status')return json(res,200,{enabled:true,running:true,live_compatibility:'verified',subscription_login:true,embedding_credential:true,api_budget_usd:5});
  if(route==='/runtime')return json(res,200,{status:{ok:true,model:'Subscription model',telegram:'disabled'},capabilities:{chat:true,sessions:true}});
  if(route==='/graph')return json(res,200,{scope:url.searchParams.get('scope'),nodes:[{id:'scope:42',kind:'scope',label:'Owner private'},{id:'event:'+id,event_id:id,kind:'message',label:'Northern lights trip'},{id:'author:owner',kind:'author',label:'Owner'}],edges:[{from:'scope:42',to:'event:'+id,kind:'contains'},{from:'author:owner',to:'event:'+id,kind:'authored'}],bounds:{truncated:false},unresolved_replies:0,next:null});
  if(route==='/runs')return json(res,200,{runs:[]});
  if(route==='/tools/actions')return json(res,200,{actions,permissions});
  if(route==='/memory/spaces')return json(res,200,url.searchParams.has('id')?{id:url.searchParams.get('id'),private_owner:url.searchParams.get('id')==='42',overrides:spaceOverrides,inherited:{mode:'approved',sources:[],privacy_instructions:''},effective:{mode:'approved',...spaceOverrides},revision:spaceRevision}:{spaces:[{id:'42'},{id:'-10042'}],owner_space:'42',next:null});
  if(route==='/memory/shares')return json(res,200,shares);
  if(route==='/memory/preview')return json(res,200,{originals:[],shares,filtered_sources:[]});
  if(route==='/memory/reviews')return json(res,200,{jobs:[{id:'e'.repeat(64),event_id:id,reason:'import',state:'paused',chunk_index:0}],next:null});
  if(route==='/memory-map'){const query=(url.searchParams.get('q')??'').trim().toLocaleLowerCase(),kind=url.searchParams.get('kind')??'',state=url.searchParams.get('state')??'';const stateEdges=state?memoryMapEdges.filter(edge=>edge.state===state||edge.label===state):memoryMapEdges,stateNodes=new Set(stateEdges.flatMap(edge=>[edge.source,edge.target])),nodes=memoryMapNodes.filter(node=>(!kind||node.kind===kind)&&(!state||node.state===state||stateNodes.has(node.id))&&(!query||`${node.label} ${node.kind}`.toLocaleLowerCase().includes(query))),ids=new Set(nodes.map(node=>node.id));return json(res,200,{format:'nocheh-memory-map-v1',nodes,edges:stateEdges.filter(edge=>ids.has(edge.source)||ids.has(edge.target)),next:null,collapsed_facts:true,focus:null,counts:{nodes:nodes.length,edges:memoryMapEdges.length},relationship_edges_grant_access:false});}
  if(route==='/memory-access/requests')return json(res,200,{requests:[memoryAccessRequest]});
  if(route==='/memory-access/grants')return json(res,200,{grants:[memoryGrant]});
  if(route==='/memory-access/settings')return json(res,200,{settings:[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:true,request_ttl_seconds:86400,default_grant_mode:'one_time',revision:1}]});
  if(route==='/projects')return json(res,200,{projects:[memoryMapNodes[1].detail.project],next:null});
 }
 if(req.method==='POST'){
  const body=await readJson(req) as any;
  if(/^\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(route))return json(res,200,await controlWorkflow(pool,route.split('/')[2]!,route.split('/')[3]!,body));
  if(route==='/memory/honcho'){memoryAttached=body.attached;return json(res,200,{ok:true});}
  if(route==='/honcho/read')return json(res,200,{complete:true,workspaces:[{id:'synthetic-workspace'}]});
  if(route==='/memory/preferences'||route==='/policy'){if(body.revision!==preferences.revision)throw new HttpError(409,'configuration_conflict');preferences.revision+='x';preferences.values={...preferences.values,...body.changes};return json(res,200,{ok:true});}
  if(route==='/tools/decide'){const item=actions.find(a=>a.id===body.id);if(!item||item.fingerprint!==body.fingerprint)throw new HttpError(409,'action_changed');item.state=body.decision==='approve'?'approved':'rejected';return json(res,200,{ok:true});}
  if(route==='/tools/grant'){permissions.push({id:randomUUID(),kind:'shell',scope:'42',arguments:actions[0].arguments,remaining:body.uses,expires_at:new Date(Date.now()+body.minutes*60000).toISOString()});return json(res,200,{ok:true});}
  if(route==='/tools/revoke'){const item=permissions.find(p=>p.id===body.id);if(item)item.revoked_at=new Date().toISOString();return json(res,200,{ok:true});}
  if(route==='/memory/spaces'){if(body.revision!==spaceRevision)throw new HttpError(409,'space_revision_conflict');spaceOverrides=body.overrides;spaceRevision++;return json(res,200,{ok:true});}
  if(route==='/memory/shares'){shares.push({id:randomUUID(),destination:body.destination,content:body.content});spaceRevision++;return json(res,200,{ok:true});}
  if(route==='/memory/recall')return json(res,200,{hits:[]});
  if(route==='/memory/reviews/control')return json(res,200,{ok:true});
  if(route==='/operations'||route==='/settings/apply'){const job={id:randomUUID(),kind:route==='/operations'?'operations.'+body.action:'settings.apply',state:'complete',created_at:new Date().toISOString(),result:{status:'synthetic_only'}};jobs.unshift(job);return json(res,200,job);}
  const importAction=/^\/jobs\/([a-f0-9-]{36})\/(start|cancel)$/.exec(route);
  if(importAction){const job=jobs.find(j=>j.id===importAction[1]);if(!job)throw new HttpError(404,'job_not_found');if(importAction[2]==='start'){if(job.state!=='ready'&&(JSON.stringify(body.mapping)!==JSON.stringify(job.mapping)||body.review_approved!==job.review_approved))throw new HttpError(409,'import_configuration_conflict');job.mapping=body.mapping;job.review_approved=body.review_approved;job.state='running';}else job.state='cancelled';return json(res,200,job);}
  if(route==='/settings'){if(body.revision!==settingsRevision)throw new HttpError(409,'configuration_conflict');settingsChanges={...settingsChanges,...body.changes};settingsRevision+='x';return json(res,200,{ok:true});}
  if(route==='/data/'+id+'/guarded'){if(body.expected_revision!==revision)throw new HttpError(409,'guard_revision_conflict');guarded=body.content?.text??source.event.text;revision++;return json(res,200,{ok:true});}
 }
 throw new HttpError(404,'fixture_capability_unavailable');
})().catch(error=>json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'fixture_request_failed'}));});
server.listen(port,'0.0.0.0',()=>console.log(`Synthetic dashboard preview ready on ${port}; no external execution authorities.`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>void pool.end());});
