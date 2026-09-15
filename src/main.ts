import {captureInput,claimRun,finishRun,renewRun,prepareRun,cancelScheduled,recoverScheduled,scheduleDefinition,scheduledRuns,scheduledDelivery} from './managed-runs.js';
import {admitBrowser,browserObservation,activeBrowser,cancelBrowser,browserWorkflowContext,browserAuthority} from './workflows/browser.js';
import {scheduleOwnership,scheduledContext,scheduledAuthority,scheduledObservation} from './workflows/schedules.js';
import {listWorkflows,workflowDetail,workflowHealth,controlWorkflow} from './workflows/owner.js';
import {proxyInngestInspection} from './workflows/inspection.js';
import {beginMigration,migrationStatus,finishMigration,reconcileMigration,migrationHostReady,stageMigrationImport} from './workflows/migrations.js';
import {ownerSecurityRoute} from './security/owner-api.js';
import { createServer } from 'node:http';
import { evidenceGraph } from './graph.js';
import { listSpaces, spacePolicy, saveSpace,parentSpace } from './spaces.js';
import {approveLearning,listReviews,controlReview} from './learning.js';
import { settings } from './config.js';
import { connectDatabase, heartbeat, initialize } from './database.js';
import { HttpError, json, readJson, object,authorize } from './http.js';
import {honchoClient,memoryStatus,setMemoryConnection,memoryContext,recallMemory,prepareMemoryRequest,acceptMemoryVerification} from './honcho.js';
import { archiveStatus, envelope, ingest } from './archive.js';
import { startWorker } from './worker.js';
import { hermesAdapter } from './hermes-adapter.js';
import { runtimeCall, type RuntimeOperation } from './runtime.js';
import { guardPayload,inspectRequest } from './guard.js';
import {prepareContext,allowPrepared} from './prepared-context.js';
import {browseData,inspectGuarded,editGuarded,guardedHistory,inspectRevision,setGuardMode,guardState,prepareGuarded} from './guarded.js';
import { requestAction,telegramActions,decideTelegram } from './actions.js';
import {proposeControlled,controlledAction,controlledList,decideControlled,grantPermission,revokePermission,claimControlled,startControlled,finishControlled} from './controlled-actions.js';
import { reader, admin,assertAudience,turnToken } from './access.js';
import {listShares,shareKnowledge,revokeShare,sharedContext,readShared} from './sharing.js';
import { search, readEvent, readArtifact, exportPage, importRecord, uploadArtifact, replay, limit } from './retrieval.js';
import {hostTransport} from './workflows/host-transport.js';
import {confirmImport,cancelImport,enterImportWrite,finishLegacyImport} from './workflows/imports.js';
import {claimHostWorkflow,renewHostWorkflow,finishHostWorkflow,continueHostWorkflow} from './workflows/host-coordinator.js';
import {registerWorker} from './workflows/store.js';
import {hostActionAuthority} from './workflows/host-tools.js';

const config = settings();
const runtime = hermesAdapter({url: config.hermesUrl, token: config.token});
const call = runtimeCall(runtime);
const honcho=honchoClient(config.honchoUrl);
// Each service owns its connection pool; an outage must be visible in health.
const pool = connectDatabase(config);
await initialize(pool);
if(config.service==='archive')await setGuardMode(pool,config.guardMode);
await heartbeat(pool, config.service);
const timer = setInterval(() => { void heartbeat(pool, config.service).catch(() => {}); }, 5000);
timer.unref();
const stopWorker = config.service === 'worker' ? startWorker(pool, config) : () => {};
const transport=config.service==='archive'&&process.env.NOCHEH_WORKFLOWS_ENABLED==='true'?hostTransport(process.env.INNGEST_SIGNING_KEY??''):null;

const server = createServer((req, res) => { void (async () => {
  if(transport?.handle(req,res))return;
  const url = new URL(req.url ?? '/', 'http://local'), path=url.pathname;
  if (req.method === 'GET' && path === '/health') {
    await pool.query('SELECT 1');
    return json(res, 200, {ok: true, service: config.service, database: 'ready'});
  }
  if(config.service==='archive'&&req.method==='POST'&&path==='/internal/honcho/prepare') {
    if(!config.memoryToken)throw new HttpError(503,'memory_gateway_unconfigured');authorize(req,config.memoryToken);
    return json(res,200,await prepareMemoryRequest(pool,await readJson(req,1024*1024),async text=>(await call('guard.detect',{text})).literals));
  }
  const principal=reader(req, config.token);
  await assertAudience(pool,principal);
  if(config.service==='archive'&&await ownerSecurityRoute(pool,principal,req,res,url))return;
  if(config.service==='archive'&&(path==='/v1/workflows'||path.startsWith('/v1/workflows/'))){
    admin(principal);
    if(path.startsWith('/v1/workflows/inspection/')){
      if(process.env.NOCHEH_WORKFLOWS_ENABLED!=='true')throw new HttpError(503,'workflows_unavailable');
      return proxyInngestInspection(req,res,process.env.INNGEST_SIGNING_KEY??'');
    }
    if(req.method==='GET'){
      if(/^\/v1\/workflows\/migrations\/[a-f0-9]{64}$/.test(path))return json(res,200,await migrationStatus(pool,path.split('/').at(-1)!));
      if(path==='/v1/workflows')return json(res,200,await listWorkflows(pool,Object.fromEntries(url.searchParams)));
      if(path==='/v1/workflows/health')return json(res,200,await workflowHealth(pool));
      if(/^\/v1\/workflows\/[a-f0-9]{64}$/.test(path))return json(res,200,await workflowDetail(pool,path.split('/').at(-1)!));
    }
    if(req.method==='POST'){
      const body=await readJson(req);
      if(path==='/v1/workflows/migrations')return json(res,200,await beginMigration(pool,body));
      if(/^\/v1\/workflows\/migrations\/[a-f0-9]{64}\/host-ready$/.test(path))return json(res,200,await migrationHostReady(pool,path.split('/')[4]!));
      if(/^\/v1\/workflows\/migrations\/[a-f0-9]{64}\/imports$/.test(path))return json(res,200,await stageMigrationImport(pool,path.split('/')[4]!,body));
      if(/^\/v1\/workflows\/migrations\/[a-f0-9]{64}\/reconcile$/.test(path))return json(res,200,await reconcileMigration(pool,path.split('/')[4]!,call,config.assistant.owner_id));
      if(/^\/v1\/workflows\/migrations\/[a-f0-9]{64}\/(switch|abort)$/.test(path))return json(res,200,await finishMigration(pool,path.split('/')[4]!,path.split('/')[5]! as 'switch'|'abort'));
      if(/^\/v1\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(path))return json(res,200,await controlWorkflow(pool,path.split('/')[3]!,path.split('/')[4]!,body));
      if(path==='/v1/workflows/imports/confirm')return json(res,200,await confirmImport(pool,body));
      if(path==='/v1/workflows/imports/legacy-finish')return json(res,200,await finishLegacyImport(pool,body));
      if(path==='/v1/workflows/imports/cancel')return json(res,200,await cancelImport(pool,object(body).id));
      if(path==='/v1/workflows/host/claim')return json(res,200,await claimHostWorkflow(pool,body));
      if(path==='/v1/workflows/host/renew')return json(res,200,await renewHostWorkflow(pool,body));
      if(path==='/v1/workflows/host/finish')return json(res,200,await finishHostWorkflow(pool,body));
      if(path==='/v1/workflows/host/continue')return json(res,200,await continueHostWorkflow(pool,body));
      if(path==='/v1/workflows/host/heartbeat'){await registerWorker(pool,'host',['imports','tools']);await heartbeat(pool,'workflow-host');return json(res,200,{ok:true});}
    }
    if(req.method==='GET'&&/^\/v1\/workflows\/imports\/[a-f0-9-]{36}$/.test(path)){
      const job=(await pool.query('SELECT id,state,completed,duplicates,learning_after,review_approved,total,generation,updated_at FROM workflow_imports WHERE id=$1',[path.split('/').at(-1)])).rows[0];
      const owner=(await pool.query("SELECT owner FROM workflow_owners WHERE family='imports'")).rows[0].owner;
      return json(res,200,{owned:!!job,owner,job});
    }
    throw new HttpError(404,'not_found');
  }
  // Every migrated import write checks its live batch lease. Hold the family
  // fence and import row through the write so cancellation/cutover can drain it.
  if(config.service==='archive'&&req.headers['x-nocheh-import-job']){
    admin(principal);
    if(req.method!=='POST'||!(path==='/v1/import'||path==='/v1/memory/reviews'||/^\/v1\/artifacts\/[a-f0-9]{64}\/bytes$/.test(path)))throw new HttpError(403,'import_route_denied');
    const held=await enterImportWrite(pool,req.headers['x-nocheh-import-job'],req.headers['x-nocheh-import-lease'],req.headers['x-nocheh-import-owner']);
    try{
      if(path==='/v1/import')return json(res,200,await importRecord(pool,await readJson(req,32*1024*1024)));
      if(path==='/v1/memory/reviews'){
        if(!held.job.review_approved)throw new HttpError(403,'import_consent_required');
        return json(res,200,await approveLearning(pool,await readJson(req)));
      }
      return json(res,200,await uploadArtifact(pool,config.dataDir,path.split('/')[3]!,await readJson(req,70*1024*1024)));
    }finally{await held.release();}
  }
  const prepare=(value:unknown)=>prepareContext(pool,principal,value,async text=>(await call('guard.detect',{text})).literals);
  const agentResult=async(value:unknown,prepared=false)=>{
    const result=principal.admin?value:prepared?(await allowPrepared(pool,principal,value),value):await prepare(value);
    await assertAudience(pool,principal);return json(res,200,result);
  };
  const claim=async(body:unknown,channel:'browser'|'scheduler')=>{
    if((await guardState(pool)).mode==='on')await prepareGuarded(pool,async text=>(await call('guard.detect',{text})).literals,config.detectorVersion,100,String(object(body).event_id));
    const authority=object(body).owner_epoch===undefined?undefined:channel==='browser'?await browserAuthority(pool,config,body):await scheduledAuthority(pool,config,body);
    return claimRun(pool,config,body,channel,authority);
  };
  if(config.service==='guard' && !principal.admin && req.method==='POST' && path==='/v1/guard') {
    const body=object(await readJson(req,1024*1024));
    if(typeof body.destination!=='string')throw new HttpError(400,'invalid_destination');
    const destination=new URL(body.destination);if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw new HttpError(400,'invalid_destination');
    if((await guardState(pool)).mode==='on')inspectRequest(body.payload);
    return json(res,200,{guarded:true,payload:await prepare(body.payload)});
  }
  if(config.service==='archive' && !principal.admin && req.method==='POST' && path==='/v1/context/prepare')return agentResult(await readJson(req,1024*1024));
  if(config.service==='archive' && path==='/v1/memory/check' && req.method==='GET')return json(res,200,{valid:true});
  if(config.service==='archive'&&path==='/v1/memory/honcho') {
    admin(principal);
    if(req.method==='GET')return json(res,200,await memoryStatus(pool));
    if(req.method==='POST')return json(res,200,await setMemoryConnection(pool,await readJson(req)));
  }
  if(config.service==='archive'&&path==='/v1/memory/honcho/verify'&&req.method==='POST') {
    admin(principal);return json(res,200,await acceptMemoryVerification(pool,await readJson(req)));
  }
  if(config.service==='archive'&&path==='/v1/guarded/prepare'&&req.method==='POST') {
    admin(principal);const body=object(await readJson(req));
    if(typeof body.event_id!=='string'||!/^[a-f0-9]{64}$/.test(body.event_id))throw new HttpError(400,'invalid_source');
    await pool.query("UPDATE guard_sources SET next_attempt=now() WHERE event_id=$1 AND active_revision IS NULL",[body.event_id]);
    await prepareGuarded(pool,async text=>(await call('guard.detect',{text})).literals,config.detectorVersion,100,body.event_id);
    return json(res,200,await inspectGuarded(pool,principal,body.event_id));
  }
  if(config.service==='archive'&&path==='/v1/memory/honcho/context'&&req.method==='POST') {
    if(principal.admin)throw new HttpError(403,'scoped_memory_context_required');
    object(await readJson(req));return agentResult(await memoryContext(pool,principal),true);
  }
  if(config.service==='archive'&&path==='/v1/memory/honcho/recall'&&req.method==='POST') {
    if(principal.admin)throw new HttpError(403,'scoped_memory_context_required');
    const body=object(await readJson(req));return agentResult(await recallMemory(pool,principal,String(body.query??''),honcho,async text=>(await call('guard.detect',{text})).literals),true);
  }
  if(config.service==='archive' && path==='/v1/memory/preview' && req.method==='GET') {
    admin(principal);const policy=await spacePolicy(pool,url.searchParams.get('space')??'');
    const preview={scope:parentSpace(policy.id)??policy.id,space:policy.id,revision:policy.revision,admin:false,guard_epoch:(await guardState(pool)).epoch};
    const q=url.searchParams.get('q')??'';
    const originals=q.trim()?await search(pool,preview,q):[];
    const shares=policy.effective.mode==='isolated'?[]:(await listShares(pool,policy.id)).filter(s=>!s.revoked_at).map(s=>({source:'nocheh:shared:'+s.id,text:s.content}));
    await assertAudience(pool,preview);
    return json(res,200,{policy,originals,shares,filtered_sources:policy.effective.mode==='filtered'?policy.effective.sources:[],filter_run:false});
  }
  if(config.service==='archive' && path==='/v1/memory/shares') {
    admin(principal);
    if(req.method==='GET')return json(res,200,await listShares(pool,url.searchParams.get('space')??''));
    if(req.method==='POST')return json(res,200,await shareKnowledge(pool,await readJson(req)));
  }
  if(config.service==='archive' && path==='/v1/memory/shares/revoke' && req.method==='POST') {
    admin(principal);const b=object(await readJson(req));return json(res,200,await revokeShare(pool,String(b.id),b.revision));
  }
  if(config.service==='archive' && path==='/v1/memory/context' && req.method==='GET')return agentResult(await sharedContext(pool,principal,url.searchParams.get('q')??'',async(operation,input,timeout)=>{
    if(operation!=='memory.filter'||(await guardState(pool)).mode==='off')return call(operation,input,timeout);
    if(!principal.turnEvent)throw new HttpError(403,'bound_guard_context_required');
    const policy={space:config.assistant.owner_id!,revision:principal.revision!,guard_epoch:(await guardState(pool)).epoch};
    const preparer={...policy,admin:false,scope:null,turnEvent:principal.turnEvent};
    await allowPrepared(pool,preparer,input.candidates);
    return call(operation,{...input,archive_credential:turnToken(config.token,null,Date.now()+600000,principal.turnEvent,{...policy,purpose:'filter'})},timeout);
  }));
  const shared=path.match(/^\/v1\/memory\/(shared|filtered)\/([a-f0-9]{64})$/);
  if(config.service==='archive' && shared && req.method==='GET')return agentResult(await readShared(pool,principal,shared[1]!,shared[2]!,call));
  if(config.service==='archive' && path==='/v1/memory/recall') {
    if(principal.scope!==null)throw new HttpError(403,'owner_memory_required');
    if(req.method==='POST')return agentResult(await call('memory.recall',{...object(await readJson(req)),...(principal.admin?{}:{guard_epoch:(await guardState(pool)).epoch})}));
  }
  if(config.service==='archive' && path==='/v1/memory/reviews') {
    admin(principal);
    if(req.method==='GET')return json(res,200,await listReviews(pool,url.searchParams.get('after')??''));
    if(req.method==='POST')return json(res,200,await approveLearning(pool,await readJson(req)));
  }
  if(config.service==='archive' && path==='/v1/memory/reviews/control' && req.method==='POST') {
    admin(principal);const b=object(await readJson(req));return json(res,200,await controlReview(pool,String(b.id),b.action));
  }
  if(config.service==='archive' && path==='/v1/memory/spaces') {
    admin(principal);
    if(req.method==='GET') {
      if(url.searchParams.has('id')) {
        const policy=await spacePolicy(pool,url.searchParams.get('id')!);
        return json(res,200,{...policy,private_owner:policy.id===config.assistant.owner_id});
      }
      return json(res,200,{...await listSpaces(pool,url.searchParams.get('after')??''),owner_space:config.assistant.owner_id});
    }
    if(req.method==='POST'){const b=object(await readJson(req));return json(res,200,await saveSpace(pool,String(b.id),b.overrides,b.revision));}
  }
  if(config.service==='archive' && req.method==='GET' && path==='/v1/scopes') {
    admin(principal);
    const {rows}=await pool.query('SELECT scope,count(*)::integer AS events FROM events WHERE scope>$1 GROUP BY scope ORDER BY scope LIMIT 101',[url.searchParams.get('after') ?? '']);
    return json(res,200,{scopes:rows.slice(0,100),next:rows.length>100?rows[99]?.scope:null});
  }
  if(config.service==='archive' && req.method==='POST' && path==='/v1/action-requests')return json(res,200,await requestAction(pool,principal,await readJson(req)));
  if(config.service==='archive' && path==='/v1/tools/propose' && req.method==='POST')return json(res,200,await proposeControlled(pool,principal,await readJson(req)));
  if(config.service==='archive' && req.method==='GET' && /^\/v1\/tools\/actions\/[a-f0-9]{64}$/.test(path))return agentResult(await controlledAction(pool,principal,path.split('/').at(-1)));
  if (config.service === 'archive' && req.method === 'GET') {
    if (path==='/v1/graph') {admin(principal);return json(res,200,await evidenceGraph(pool,principal,url.searchParams.get('scope') ?? '',url.searchParams.get('after') ?? '',limit(url.searchParams.get('limit')),url.searchParams.get('focus') ?? ''));}
    if (path==='/v1/search') return agentResult(await search(pool,principal,url.searchParams.get('q') ?? '',limit(url.searchParams.get('limit'))),true);
    const event=path.match(/^\/v1\/events\/([a-f0-9]{64})$/);
    if (event?.[1]) return agentResult(await readEvent(pool,principal,event[1]),true);
    const artifact=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
    if (artifact?.[1]) {
      const bytes=await readArtifact(pool,principal,config.dataDir,artifact[1]);
      res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});
      return res.end(bytes);
    }
  }
  admin(principal);
  if(config.service==='archive' && path==='/v1/data' && req.method==='GET')return json(res,200,await browseData(pool,principal,url.searchParams.get('after')??''));
  const projection=path.match(/^\/v1\/data\/([a-f0-9]{64})\/guarded(?:\/(history))?$/);
  if(config.service==='archive' && projection) {
    if(req.method==='GET' && projection[2] && url.searchParams.has('revision'))return json(res,200,await inspectRevision(pool,principal,projection[1]!,url.searchParams.get('source_id')??'',Number(url.searchParams.get('revision'))));
    if(req.method==='GET' && projection[2])return json(res,200,await guardedHistory(pool,principal,projection[1]!,url.searchParams.get('source_id')??'',Number(url.searchParams.get('before')??2147483647)));
    if(req.method==='GET')return json(res,200,await inspectGuarded(pool,principal,projection[1]!));
    if(req.method==='POST' && !projection[2])return json(res,200,await editGuarded(pool,principal,projection[1]!,await readJson(req,8*1024*1024)));
  }
  if(config.service==='archive'&&req.method==='POST'&&path.startsWith('/v1/scheduler/')) {
    const body=await readJson(req);
    if(path==='/v1/scheduler/input')return json(res,200,await captureInput(pool,config,body,'scheduler',object(body).owner_epoch===undefined?undefined:{owner:'inngest',epoch:Number(object(body).owner_epoch)}));
    if(path==='/v1/scheduler/ownership')return json(res,200,await scheduleOwnership(pool));
    if(path==='/v1/scheduler/workflow-context')return json(res,200,await scheduledContext(pool,config,body));
    if(path==='/v1/scheduler/observe')return json(res,200,await scheduledObservation(pool,body));
    if(path==='/v1/scheduler/prepare')return json(res,200,await prepareRun(pool,config,body,call));
    if(path==='/v1/scheduler/claim')return json(res,200,await claim(body,'scheduler'));
    if(path==='/v1/scheduler/finish')return json(res,200,await finishRun(pool,body));
    if(path==='/v1/scheduler/heartbeat')return json(res,200,await renewRun(pool,body));
    if(path==='/v1/scheduler/cancel')return json(res,200,await cancelScheduled(pool,body));
    if(path==='/v1/scheduler/recover')return json(res,200,await recoverScheduled(pool));
    if(path==='/v1/scheduler/definition')return json(res,200,await scheduleDefinition(pool,config,body));
    if(path==='/v1/scheduler/runs')return json(res,200,await scheduledRuns(pool,body));
    if(path==='/v1/scheduler/delivery')return json(res,200,await scheduledDelivery(pool,body));
  }
  if(config.service==='archive' && path==='/v1/tools/actions' && req.method==='GET')return json(res,200,{...await controlledList(pool,principal),telegram:await telegramActions(pool,principal)});
  if(config.service==='archive' && path.startsWith('/v1/tools/') && req.method==='POST') {
    const body=await readJson(req,2*1024*1024);
    if(path==='/v1/tools/decide')return json(res,200,await decideControlled(pool,principal,body));
    if(path==='/v1/tools/telegram-decision')return json(res,200,await decideTelegram(pool,principal,body));
    if(path==='/v1/tools/grant')return json(res,200,await grantPermission(pool,principal,body));
    if(path==='/v1/tools/start')return json(res,200,await startControlled(pool,body,object(body).workflow_id?await hostActionAuthority(pool,body):undefined));
    if(path==='/v1/tools/revoke')return json(res,200,await revokePermission(pool,principal,body));
    if(path==='/v1/tools/claim')return json(res,200,await claimControlled(pool,body,object(body).id===undefined?null:String(object(body).id),object(body).workflow_id?await hostActionAuthority(pool,body):undefined));
    if(path==='/v1/tools/finish')return json(res,200,await finishControlled(pool,body));
  }
  if (config.service==='archive' && req.method==='GET' && path==='/v1/runtime') {
    const status = await call('status', {}, 5000).catch(() => ({ok:false,error:'runtime_unavailable'}));
    return json(res,200,{id:runtime.id,capabilities:runtime.capabilities,status});
  }
  if(config.service==='archive' && req.method==='POST' && path.startsWith('/v1/browser/')) {
    const body=await readJson(req,36*1024*1024);
    if(path==='/v1/browser/input')return json(res,200,await captureInput(pool,config,body));
    if(path==='/v1/browser/admit')return json(res,200,await admitBrowser(pool,config,body));
    if(path==='/v1/browser/observe')return json(res,200,await browserObservation(pool,config,body));
    if(path==='/v1/browser/active')return json(res,200,await activeBrowser(pool,config,body));
    if(path==='/v1/browser/cancel')return json(res,200,await cancelBrowser(pool,config,body));
    if(path==='/v1/browser/workflow-context')return json(res,200,await browserWorkflowContext(pool,config,body));
    if(path==='/v1/browser/claim')return json(res,200,await claim(body,'browser'));
    if(path==='/v1/browser/finish')return json(res,200,await finishRun(pool,body));
    if(path==='/v1/browser/heartbeat')return json(res,200,await renewRun(pool,body));
    if(path==='/v1/browser/prepare')return json(res,200,await prepareRun(pool,config,body,call));
  }
  if(config.service==='archive' && req.method==='POST' && path==='/v1/manage/hermes') {
    const input=object(await readJson(req));
    const operation:RuntimeOperation|undefined=input.action==='profiles'?'profiles.list':input.action==='memory'?'memory.read':input.action==='preferences'?(input.changes?'config.write':'config.read'):undefined;
    if(!operation)throw new HttpError(400,'unknown_management_action');
    return json(res,200,await call(operation,input));
  }
  if (config.service==='guard' && req.method==='POST' && path==='/v1/guard') {
    const body=object(await readJson(req,1024*1024));
    if (typeof body.destination!=='string') throw new HttpError(400,'invalid_destination');
    return json(res,200,await guardPayload(body.payload,{mode:config.guardMode,trusted:config.guardTrusted,detectorVersion:config.detectorVersion},body.destination,
      async(text)=>(await call('guard.detect',{text})).literals,pool));
  }
  if (config.service === 'archive') {
    if (req.method==='GET' && path==='/v1/export') return json(res,200,await exportPage(pool,url.searchParams.get('after') ?? '',limit(url.searchParams.get('limit'))));
    if (req.method==='POST' && path==='/v1/import') return json(res,200,await importRecord(pool,await readJson(req,32*1024*1024),url.searchParams.get('restore_guarded')==='true'));
    if (req.method==='POST' && path==='/v1/replay') return json(res,200,await replay(pool,object(await readJson(req)).event_ids));
    const upload=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
    if (req.method==='POST' && upload?.[1]) return json(res,200,await uploadArtifact(pool,config.dataDir,upload[1],await readJson(req,70*1024*1024)));
  }
  if (req.method === 'GET' && path === '/v1/status') {
    admin(principal);
    const {rows} = await pool.query<{service: string; seen_at: Date}>('SELECT service, seen_at FROM service_heartbeats ORDER BY service');
    return json(res, 200, {service: config.service, guard_mode: config.guardMode, services: rows, archive: await archiveStatus(pool)});
  }
  if (config.service === 'archive' && req.method === 'POST' && path === '/v1/ingest') {
    return json(res, 200, await ingest(pool, envelope(await readJson(req, 16*1024*1024))));
  }
  throw new HttpError(404, 'not_found');
})().catch((error: unknown) => {
  json(res, error instanceof HttpError ? error.status : 503,
    {error: error instanceof HttpError ? error.code : 'service_unavailable'});
}); });
server.requestTimeout = 30000;
transport?.attach(server);
server.listen(config.port, config.host, () => console.log(JSON.stringify({event: 'ready', service: config.service, port: config.port})));
let stopping=false;
function stop() {
  if(stopping)return;stopping=true;clearInterval(timer);transport?.close();
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  void Promise.all([closed,stopWorker()]).then(()=>pool.end()).then(()=>process.exit(0));
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
