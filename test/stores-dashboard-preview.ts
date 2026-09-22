/** Owner-interface rehearsal against real separated repositories and synthetic originals only. */
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {HttpError,json,readJson} from '../src/http.js';
import {DashboardSessions} from '../src/dashboard-auth.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';

if(process.env.NOCHEH_STORES_FIXTURE!=='1')throw Error('synthetic_fixture_opt_in_required');
const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
const check=new pg.Client(config);await check.connect();
try{if((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name!=='nocheh-stores-fixture')throw Error('synthetic_cluster_required');}finally{await check.end();}
const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),dataDir='/tmp/nocheh-owner-ui';await mkdir(dataDir,{recursive:true});
const services=storageServices(stores,{dataDir,detectorVersion:'ui-fixture',serviceToken:'ui-fixture-service-token-not-real',policy:()=>({enabled:true,owner_id:'123',group_ids:['-10042','-10043']}),
 runtime:async(operation,input)=>{
  if(operation==='guard.detect')return {literals:String(input.text).includes('sample-secret-value')?['sample-secret-value']:[]};
  if(operation==='memory.filter')return {items:[{text:'The observatory team is reviewing the instrument checklist.',source_ids:[(input.candidates as any[])[0].id]}],
   producer:{name:'fixture',version:'1',model:'deterministic',provider:'offline',api_mode:'fixture'}};
  throw Error('fixture_external_operation_denied');
 },honcho:async()=>{throw Error('fixture_native_memory_unavailable');},
 transcription:{name:'fixture-transcription',version:'2',outputKind:'transcript',async run(bytes){if(bytes.toString()!=='Synthetic original audio bytes')throw Error('fixture_bytes_changed');return 'Updated reading: the northern telescope inspection is complete.';}}
});
const api=new OwnerStorageApi(services),owner={admin:true,scope:null},sessions=new DashboardSessions();
await services.guards.reconcile();await services.guards.setMode('on');
const originals=[];
for(const [index,scope,text,voice,user] of [
 [1,'123','Field recording from the observatory. sample-secret-value',true,123],
 [2,'-10042','For the Observatory project, 👀 means under review.',false,123],
 [3,'-10042','The northern telescope inspection is complete.',false,123],
 [4,'-10043','The amber reaction means waiting for a reply in this conversation.',false,123],
 [5,'-10042','Beacon is blocked while Alex checks the telescope.',false,456]
] as const){
 const event:Envelope={version:1,key:'original-ui-fixture:'+index,origin:'live',bot_id:'fixture',kind:'telegram_update',scope,source_id:String(index),revision:'1',occurred_at:null,text,
  payload:{message:{message_id:index,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'group',...(scope==='123'?{first_name:'Mira',username:'mira_sky'}:{title:scope==='-10042'?'Observatory team':'Field reports'})},
   from:{id:user,...(user===123?{first_name:'Mira',username:'mira_sky'}:{first_name:'Alex',username:'alex_scope'})},text,...(voice?{voice:{file_id:'synthetic-voice'}}:{})}}};
 const source=(await services.capture.capture(event)).source;await services.guards.prepare(source.reference,'ui-fixture',services.detect);originals.push(source);
}
const file=await services.attachments.commit(originals[0]!.artifact_ids[0]!,Buffer.from('Synthetic original audio bytes'));await services.guards.prepare(file,'ui-fixture',services.detect);
const first=await services.derived.record({operation_id:'ui-transcript-v1',source:file.event,file,kind:'transcript',content:Buffer.from('First reading: the northern telescope inspection is planned.'),producer:'fixture-transcription',producer_version:'1',configuration:{}});
await services.guards.prepare(first,'ui-fixture',services.detect);
if(!(await stores.derived.query('SELECT 1 FROM derivative_selections WHERE event_id=$1 AND active_revision IS NOT NULL',[file.event.id])).rowCount)await services.selections.activate(first,null,'ui-first-selection');
const project=await services.projects.save(owner,{name:'Observatory',description:'Instrument inspections and field observations across the team.',state:'active',expected_revision:0,operation_id:'ui-project'});
const beacon=await services.projects.save(owner,{name:'Beacon',description:'A connected project mentioned by the observatory team.',state:'active',expected_revision:0,operation_id:'ui-project-beacon'});
await services.projects.assign(owner,{space_id:'-10042',mode:'assigned',project_id:project.id,expected_revision:0,operation_id:'ui-project-assignment'});
const entityContext=await services.entities.context(originals[4]!.reference,[beacon],'Beacon is blocked while Alex checks the telescope.');
const entityBinding=await services.guards.state();
await services.entities.publishDiscoveries({source:originals[4]!.reference,source_object:'ui-fixture',space:'-10042',binding:entityBinding,
 evidence:[{reference:originals[4]!.reference,text:'Beacon is blocked while Alex checks the telescope.',space:'-10042'}],dependencies:[],observations:[],
 rules:[],rule_ids:[],projects:[{id:project.id,name:project.name},{id:beacon.id,name:beacon.name}],entities:entityContext,limitations:[]},
 {entity_suggestions:[{kind:'person',name:'Alex',reason:'The mention is not bound to a platform identity.',evidence_ids:[originals[4]!.reference.id]}],
  entity_claims:[{subject_id:entityContext.mentioned_projects[0]!.id,predicate:'blocker',content:'Alex is checking the telescope, according to the participant.',
   attribution:'reported',speaker_entity_id:entityContext.speaker!.id,uncertainty:'supported',evidence_ids:[originals[4]!.reference.id]}]},'ui-entity-learning');
await services.sharing.save(owner,{name:'Observatory updates',sources:['123'],destination:'-10042',enabled:true,mode:'approved',instructions:'Share only the selected project status.',expected_revision:0,operation_id:'ui-approved-rule'});
await services.sharing.save(owner,{name:'Filtered field notes',sources:['123'],destination:'-10043',enabled:true,mode:'filtered',instructions:'Only general instrument facts; omit private details.',expected_revision:0,operation_id:'ui-filter-rule'});
for(const [index,subject,text,uncertainty,conflict] of [
 [1,'Eyes reaction','👀 means under review in the observatory conversation.','explicit',false],
 [2,'Northern telescope','The inspection appears complete; the final log still needs verification.','supported',true],
 [3,'Northern telescope','An older interpretation still describes the inspection as planned.','uncertain',true]
] as const){
 const id=digest('ui-learned:'+index);if((await stores.derived.query('SELECT 1 FROM learned_entries WHERE id=$1',[id])).rowCount)continue;
 const source=originals[index===1?1:2]!.reference,binding=await services.guards.state(),guarded=await services.guards.read('events:'+source.id,binding);
 await services.learned.publishAutomatic(id,{kind:index===1?'convention':'state',subject,text,scope:{kind:'conversation',id:'-10042'},uncertainty,evidence:[source],
  ...(index===1?{quote:{source_id:source.id,text:'👀 means under review'}}:{}),conflicts:conflict?[digest('ui-learned:'+(index===2?3:2))]:[]},null,'ui-learning:'+index,
  [{source_id:'events:'+source.id,revision:guarded.revision,value_hash:digest(canonical(guarded.value))}],binding,'deterministic-fixture',services.detect,{exact_citations:false,limitations:['Synthetic projection. No native conclusion citations were requested.']});
}
const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='preparation'")).rows[0].epoch)});
const port=Number(process.env.NOCHEH_DASHBOARD_PORT||18859);
const server=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url||'/','http://fixture'),path=url.pathname;
 if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw new HttpError(403,'origin_denied');
 if(req.method==='GET'&&path==='/'){
  const session=sessions.page(req);res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader('content-type','text/html');res.end((await readFile('web/dist/index.html','utf8')).replace('/*NOCHEH_BOOTSTRAP*/',`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`));return;
 }
 if(req.method==='GET'&&/^\/assets\/(?:app\.js|style\.css|graph-3d\.js|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(path)){
  res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join('web/dist',path.slice(8))));return;
 }
 sessions.authorize(req,req.method!=='GET');const route=path.replace(/^\/api\/nocheh/,'');
 if(req.method==='GET'&&route==='/entities')return json(res,200,await services.entities.list(owner,{query:url.searchParams.get('q')??'',kind:url.searchParams.get('kind')??'',after:url.searchParams.get('after')??'',state:url.searchParams.get('state')??'active'}));
 const entityRead=route.match(/^\/entities\/([a-f0-9]{64})$/);if(req.method==='GET'&&entityRead)return json(res,200,await services.entities.inspect(owner,entityRead[1]!));
 const entityHistory=route.match(/^\/entities\/claims\/([a-f0-9]{64})\/history$/);if(req.method==='GET'&&entityHistory)return json(res,200,await services.entities.history(owner,entityHistory[1]!,url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined));
 if(api.owns('/v1'+route)){
  const body=req.method==='POST'?await readJson(req,8*1024*1024):undefined,result:any=await api.request(owner,req.method??'GET',new URL('/v1'+route+url.search,'http://fixture'),body);
  // Only explicit owner requests execute deterministic fixture preparation; no background scheduler or provider exists.
  if(req.method==='POST'&&/^\/sources\/[a-f0-9]{64}\/reprocess$/.test(route))await services.reprocessing.run(result.id,'ui-fixture',services.detect,await authority());
  if(req.method==='POST'&&/^\/sources\/[a-f0-9]{64}\/prepare$/.test(route))await services.preparation.run(route.split('/')[2]!,async()=>{throw Error('fixture_download_denied');},'ui-fixture',services.detect,await authority());
  return json(res,200,result);
 }
 if(req.method==='GET'){
  if(route==='/health')return json(res,200,{ok:true});
  if(route==='/status'){
   const guard=await services.guards.state();
   return json(res,200,{service:'synthetic-owner-preview',storage_layout:'original-only-v1',guard,guard_mode:guard.mode,
    archive:await services.sources.status(owner),services:[],workers:{}});
  }
  if(route==='/monitoring')return json(res,200,{application:{ok:true},fixture:true,checked_at:new Date().toISOString()});
  if(route==='/scopes')return json(res,200,{scopes:[{scope:'123',events:1},{scope:'-10042',events:2},{scope:'-10043',events:1}],next:null});
  if(route==='/data'){
   const rows=(await stores.archive.query('SELECT id,scope,original_text,received_at FROM events WHERE id>$1 ORDER BY id LIMIT 51',[url.searchParams.get('after')??''])).rows;
   return json(res,200,{records:rows.slice(0,50).map(row=>({...row,text:row.original_text?.toString(),original_text:undefined})),next:rows.length>50?rows[49].id:null});
  }
  if(route==='/search')return json(res,200,await services.sources.search(owner,url.searchParams.get('q')??''));
  if(/^\/events\/[a-f0-9]{64}$/.test(route))return json(res,200,await services.sources.read(owner,route.split('/')[2]!));
  if(route==='/graph')return json(res,200,await services.sources.graph(owner,url.searchParams.get('scope')??'*',url.searchParams.get('after')??'',20,url.searchParams.get('focus')??''));
  if(/^\/artifacts\/[a-f0-9]{64}\/download$/.test(route)){res.setHeader('content-type','application/octet-stream');res.setHeader('content-disposition','attachment; filename="synthetic-original.bin"');return res.end(await services.sources.bytes(owner,route.split('/')[2]!));}
 }
 throw new HttpError(404,'fixture_capability_unavailable');
})().catch(error=>{console.error(JSON.stringify({event:'fixture_request_failed',code:error instanceof HttpError?error.code:'fixture_failure'}));json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'fixture_request_failed'});});});
server.listen(port,'0.0.0.0',()=>console.log(`Three-store synthetic owner preview ready on ${port}; no live credentials, provider, poller, scheduler or credential refresh.`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>void stores.close());});
