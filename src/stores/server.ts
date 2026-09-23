import {createServer} from 'node:http';
import {join} from 'node:path';
import {admin,reader} from '../access.js';
import {telegramDeliveryAllowed} from '../assistant-policy.js';
import {canonical,digest,envelope} from '../archive.js';
import type {Settings} from '../config.js';
import {HttpError,authorize,json,object,readJson,string} from '../http.js';
import {archiveFilters,matchesArchiveFilters} from '../archive-filters.js';
import {sourceContentTypes} from '../source-content.js';
import {limit} from '../retrieval.js';
import type {RuntimeCall} from '../runtime.js';
import {immutableFile} from '../storage.js';
import {ownerSecurityRoute} from '../security/owner-api.js';
import {captureEvidence} from './generated-capture.js';
import {OwnerStorageApi} from './owner-api.js';
import type {StorageServices} from './services.js';
import {assertStorageActive,assertGuardConfiguration,restoredInactive,storageHealth} from './lifecycle.js';
import {listWorkflows,workflowDetail,workflowHealth} from '../workflows/owner.js';
import {workflowMetrics} from '../workflows/metrics.js';
import {proxyInngestInspection} from '../workflows/inspection.js';
import {controlStorageWorkflow} from './workflow-owner.js';
import {claimHostWorkflow,renewHostWorkflow,finishHostWorkflow,continueHostWorkflow} from '../workflows/host-coordinator.js';
import {confirmImport,cancelImport,enterImportWrite,reconcileImportReceipt} from '../workflows/imports.js';
import {registerWorker} from '../workflows/store.js';
import {drainSourceSpool} from './capture.js';
import {archiveReplyPreviews} from './archive-reply-links.js';
import {telegramDirectory} from './telegram-directory.js';
import type {hostTransport} from '../workflows/host-transport.js';

/** No legacy pool, schema initialization, cross-store SQL or fallback route. */
export function storageServer(s:StorageServices,config:Settings,call:RuntimeCall,status:()=>unknown=()=>({}),transport?:ReturnType<typeof hostTransport>) {
  const owner=new OwnerStorageApi(s);
  const server=createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url??'/','http://local'),path=url.pathname;
    if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,service:config.service,storage_layout:'original-only-v1',
      databases:await storageHealth(s.stores),inactive:restoredInactive(config.dataDir),workers:status()});
    assertStorageActive(config.dataDir);
    if(transport?.handle(req,res))return;
    if(req.method==='POST'&&path==='/internal/actions/authorize') {
      authorize(req,config.token);await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
      return json(res,200,await s.telegramActions.authorizeDelivery(await readJson(req)));
    }
    if(req.method==='POST'&&path==='/internal/honcho/prepare') {
      if(!config.memoryToken)throw new HttpError(503,'memory_gateway_unconfigured');authorize(req,config.memoryToken);
      await assertGuardConfiguration(s.guards,config.guardMode);
      await s.configuration.assert(config.assistant);
      return json(res,200,await s.memory.prepareRequest(await readJson(req,1024*1024)));
    }
    const principal=reader(req,config.token);
    if(['x-nocheh-import-job','x-nocheh-import-lease','x-nocheh-import-owner'].some(key=>req.headers[key]!==undefined)){
      admin(principal);
      if(req.method!=='POST'||!(path==='/v1/import'||path==='/v1/memory/reviews'||/^\/v1\/artifacts\/[a-f0-9]{64}\/bytes$/.test(path)))throw new HttpError(403,'import_route_denied');
      const held=await enterImportWrite(s.stores.control,req.headers['x-nocheh-import-job'],req.headers['x-nocheh-import-lease'],req.headers['x-nocheh-import-owner']);
      try{
        if(path==='/v1/import')return json(res,200,await s.imports.record(principal,await readJson(req,32*1024*1024),held.job));
        if(path==='/v1/memory/reviews')return json(res,200,await s.imports.approveLearning(principal,await readJson(req),held.job));
        return json(res,200,await s.imports.upload(principal,path.split('/')[3]!,await readJson(req,70*1024*1024),held.job));
      }finally{await held.release();}
    }
    if(req.method==='POST'&&path==='/v1/import'){
      admin(principal);const body=object(await readJson(req,32*1024*1024));
      // Desktop batch imports are original-only; historical mixed-format exports
      // take the explicit converter and retain their generated/guarded domains.
      return json(res,200,body.guarded!=null||Array.isArray(body.derived)&&body.derived.length||object(body.event).origin==='generated'?
        await s.legacyImports.record(principal,body,url.searchParams.get('restore_guarded')==='true'):await s.imports.record(principal,body));
    }
    if(req.method==='POST'&&path==='/v1/memory/reviews'){admin(principal);return json(res,200,await s.imports.approveLearning(principal,await readJson(req)));}
    if(/^\/v1\/artifacts\/[a-f0-9]{64}\/bytes$/.test(path)&&req.method==='POST'){admin(principal);return json(res,200,await s.imports.upload(principal,path.split('/')[3]!,await readJson(req,70*1024*1024)));}

    if(req.method==='POST'&&path==='/v1/browser/input') {
      admin(principal);return json(res,200,await s.browserCapture.capture(principal,await readJson(req,40*1024*1024)));
    }
    if(req.method==='POST'&&path==='/v1/browser/delivered') {
      admin(principal);return json(res,202,await s.browserDelivery.acknowledge(principal,await readJson(req,1024)));
    }
    // Durable admission depends only on the owned filesystem. Database and
    // workflow outages leave an acknowledged observation available for replay.
    if(req.method==='POST'&&path==='/v1/ingest') {
      admin(principal);const value=envelope(await readJson(req,16*1024*1024));captureEvidence(value);
      await immutableFile(join(config.dataDir,'spool','pending'),digest(value.key)+'.json',Buffer.from(canonical(value)));
      return json(res,202,{id:digest(value.key),state:'spooled'});
    }
    // Owners can inspect and repair incomplete guard changes; scoped callers
    // must observe the complete current authorization generation on every call.
    if(!principal.admin){await s.turns.assertAudience(principal);await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);}
    if(req.method==='GET'&&path==='/v1/entities')return json(res,200,await s.entities.list(principal,{query:url.searchParams.get('q')??'',kind:url.searchParams.get('kind')??'',
      after:url.searchParams.get('after')??'',state:url.searchParams.get('state')??'active'}));
    const entityHistory=path.match(/^\/v1\/entities\/claims\/([a-f0-9]{64})\/history$/);
    if(req.method==='GET'&&entityHistory)return json(res,200,await s.entities.history(principal,entityHistory[1]!,url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined));
    const entityRead=path.match(/^\/v1\/entities\/([a-f0-9]{64})$/);
    if(req.method==='GET'&&entityRead)return json(res,200,await s.entities.inspect(principal,entityRead[1]!));
    if(await owner.handle(principal,req,res,url))return;
    if(path==='/v1/runtime/profiles'||path==='/v1/runtime/profiles/resolve') {
      admin(principal);await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
      if(req.method==='GET'&&path==='/v1/runtime/profiles')return json(res,200,await s.runtimeProfiles.list(principal));
      if(req.method==='POST')return json(res,200,await (path.endsWith('/resolve')?s.runtimeProfiles.resolve(principal,await readJson(req)):s.runtimeProfiles.save(principal,await readJson(req))));
    }
    if(req.method==='POST'&&path.startsWith('/v1/scheduler/')) {
      admin(principal);const body=object(await readJson(req,2*1024*1024)),operation=path.slice('/v1/scheduler/'.length);
      if(operation==='finish')return json(res,200,await s.scheduled.finish(body));
      await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
      if(operation==='ownership')return json(res,200,await s.schedules.ownership());
      if(operation==='definition')return json(res,200,await s.schedules.definition(principal,body));
      if(operation==='input')return json(res,200,await s.schedules.capture(principal,body));
      if(operation==='workflow-context')return json(res,200,await s.scheduled.context(body));
      if(operation==='claim')return json(res,200,await s.scheduled.claim(body));
      if(operation==='prepare')return json(res,200,await s.scheduled.prepare(body));
      if(operation==='heartbeat')return json(res,200,await s.scheduled.heartbeat(body));
      if(operation==='observe')return json(res,200,await s.scheduled.observe(body));
      if(operation==='cancel')return json(res,200,await s.scheduled.cancel(body));
      if(operation==='recover')return json(res,200,await s.scheduled.recoverExpired());
      if(operation==='runs')return json(res,200,await s.scheduled.history(body));
      if(operation==='delivery')return json(res,200,await s.scheduled.delivery(body));
      throw new HttpError(404,'not_found');
    }
    if(req.method==='POST'&&path.startsWith('/v1/browser/')) {
      admin(principal);const body=object(await readJson(req,2*1024*1024)),operation=path.slice('/v1/browser/'.length);
      if(operation==='finish')return json(res,200,await s.browser.finish(body));
      if(operation==='cancel')return json(res,200,await s.browser.cancel(body));
      if(operation==='observe')return json(res,200,await s.browser.observe(body));
      if(operation==='active')return json(res,200,await s.browser.active(body));
      if(operation==='undelivered')return json(res,200,await s.browser.undelivered(principal,body));
      await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
      if(operation==='admit') {
        await drainSourceSpool(s.capture,config.dataDir,string(body.event_id,64));
        return json(res,200,await s.browser.admit(principal,body));
      }
      if(operation==='workflow-context')return json(res,200,await s.browser.context(body));
      if(operation==='claim')return json(res,200,await s.browser.claim(body));
      if(operation==='prepare')return json(res,200,await s.browser.prepare(body));
      if(operation==='heartbeat')return json(res,200,await s.browser.heartbeat(body));
    }
    if(await ownerSecurityRoute(s.stores.control,principal,req,res,url,{separated:true,preview:input=>s.controlledActions.preview(principal,input)}))return;
    if(path==='/v1/workflows'||path.startsWith('/v1/workflows/')) {
      admin(principal);

      if(req.method==='POST'&&path.startsWith('/v1/workflows/imports/')){
        const body=await readJson(req);
        if(path==='/v1/workflows/imports/confirm')return json(res,200,await confirmImport(s.stores.control,body));
        if(path==='/v1/workflows/imports/reconcile-receipt')return json(res,200,await reconcileImportReceipt(s.stores.control,body));
        if(path==='/v1/workflows/imports/cancel')return json(res,200,await cancelImport(s.stores.control,object(body).id));
      }
      if(req.method==='GET'&&/^\/v1\/workflows\/imports\/[a-f0-9-]{36}$/.test(path)){
        const job=(await s.stores.control.query('SELECT id,state,completed,duplicates,learning_after,review_approved,total,generation,updated_at FROM workflow_imports WHERE id=$1',[path.split('/').at(-1)])).rows[0];
        const owner=(await s.stores.control.query("SELECT owner FROM workflow_owners WHERE family='imports'")).rows[0].owner;
        return json(res,200,{owned:!!job,owner,job});
      }
      if(req.method==='POST'&&path.startsWith('/v1/workflows/host/')) {
        const body=await readJson(req);
        if(path==='/v1/workflows/host/claim') {
          await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
          return json(res,200,await claimHostWorkflow(s.stores.control,body));
        }
        if(path==='/v1/workflows/host/renew')return json(res,200,await renewHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/finish')return json(res,200,await finishHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/continue')return json(res,200,await continueHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/heartbeat') {
          await registerWorker(s.stores.control,'host',['imports','tools']);
          await s.stores.control.query("INSERT INTO service_heartbeats(service) VALUES('workflow-host') ON CONFLICT(service) DO UPDATE SET seen_at=now()");
          return json(res,200,{ok:true});
        }
      }
      if(path.startsWith('/v1/workflows/inspection/'))return proxyInngestInspection(req,res,process.env.INNGEST_SIGNING_KEY??'');
      if(req.method==='GET') {
        if(path==='/v1/workflows')return json(res,200,await listWorkflows(s.stores.control,Object.fromEntries(url.searchParams)));
        if(path==='/v1/workflows/health')return json(res,200,await workflowHealth(s.stores.control));
        if(path==='/v1/workflows/metrics')return json(res,200,await workflowMetrics(s.stores.control,Object.fromEntries(url.searchParams)));
        if(/^\/v1\/workflows\/[a-f0-9]{64}$/.test(path))return json(res,200,await workflowDetail(s.stores.control,path.split('/').at(-1)!));
      }
      const control=path.match(/^\/v1\/workflows\/([a-f0-9]{64})\/(retry|cancel)$/);
      if(control&&req.method==='POST')return json(res,200,await controlStorageWorkflow(s.stores.control,principal,control[1]!,control[2]!,await readJson(req)));
      if(path==='/v1/workflows/migrations'||path.startsWith('/v1/workflows/migrations/'))throw new HttpError(409,'legacy_migration_not_applicable');
    }
    const result=async(value:unknown,prepared=false)=>{
      if(!principal.admin){if(prepared)await s.prepared.allow(principal,value);else value=await s.prepared.prepare(principal,value,s.detect);await s.turns.assertAudience(principal);}
      return json(res,200,value);
    };
    if(path==='/v1/action-requests'&&req.method==='POST')return result(await s.telegramActions.request(principal,await readJson(req)));
    if(path==='/v1/tools/propose'&&req.method==='POST')return result(await s.controlledActions.propose(principal,await readJson(req)));
    if(req.method==='POST'&&['/v1/tools/claim','/v1/tools/start','/v1/tools/finish'].includes(path)) {
      admin(principal);const body=await readJson(req,2*1024*1024);
      if(path==='/v1/tools/finish')return json(res,200,await s.controlledExecution.finish(body));
      await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
      return json(res,200,await (path.endsWith('/claim')?s.controlledExecution.claim(body):s.controlledExecution.start(body)));
    }
    if(req.method==='POST'&&['/v1/tools/decide','/v1/tools/grant','/v1/tools/revoke'].includes(path)) {
      admin(principal);const body=await readJson(req);
      return json(res,200,await (path.endsWith('/decide')?s.controlledActions.decide(principal,body):path.endsWith('/grant')?s.controlledActions.grant(principal,body):s.controlledActions.revoke(principal,body)));
    }
    if(path==='/v1/tools/actions'&&req.method==='GET') {
      admin(principal);return json(res,200,{...await s.controlledActions.list(principal),telegram:await s.telegramActions.list(principal)});
    }
    if(path==='/v1/tools/telegram-decision'&&req.method==='POST'){admin(principal);return json(res,200,await s.telegramActions.decide(principal,await readJson(req)));}
    const action=path.match(/^\/v1\/tools\/actions\/([a-f0-9]{64})$/);
    if(action&&req.method==='GET') {
      const exists=(await s.stores.control.query('SELECT 1 FROM controlled_actions WHERE id=$1',[action[1]])).rowCount;
      return result(exists?await s.controlledActions.inspect(principal,action[1]):await s.telegramActions.inspect(principal,action[1]!),true);
    }
    if(path==='/v1/context/prepare'&&req.method==='POST') {
      if(principal.admin)throw new HttpError(403,'scoped_turn_required');await s.turns.binding(principal);
      return result(await readJson(req,1024*1024));
    }
    if(path==='/v1/memory/check'&&req.method==='GET'){
      const source=principal.turnEvent?(await s.stores.archive.query('SELECT origin,channel,kind,scope,payload FROM events WHERE id=$1',[principal.turnEvent])).rows[0]??null:null;
      return json(res,200,{valid:principal.admin||telegramDeliveryAllowed(s.access.policy(),principal,source)});
    }
    if(path==='/v1/memory/honcho') {
      admin(principal);
      if(req.method==='GET')return json(res,200,await s.memory.status());
      if(req.method==='POST')return json(res,200,await s.memory.connection(principal,await readJson(req)));
    }
    if(path==='/v1/memory/honcho/verify'&&req.method==='POST'){admin(principal);return json(res,200,await s.memory.acceptVerification(principal,await readJson(req)));}
    if(req.method==='POST'&&['/v1/memory/honcho/context','/v1/memory/honcho/recall'].includes(path)) {
      if(principal.admin)throw new HttpError(403,'scoped_memory_context_required');await s.turns.binding(principal);
      const body=object(await readJson(req));return result(path.endsWith('/context')?await s.memory.context(principal):await s.memory.recall(principal,string(body.query??'',2000)),true);
    }
    if(path==='/v1/memory/context'&&req.method==='GET') {
      const query=url.searchParams.get('q')??'',existing=await s.shared.context(principal,query),granted=await s.memoryAccess.context(principal,query);
      return result({...existing,sources:[...existing.sources,...granted.sources]},true);
    }
    const shared=path.match(/^\/v1\/memory\/(?:shared|filtered)\/([a-f0-9]{64})$/);
    if(shared&&req.method==='GET')return result(await s.shared.read(principal,shared[1]!),true);
    if(path==='/v1/memory/recall'&&req.method==='POST') {
      if(principal.scope!==null)throw new HttpError(403,'owner_memory_required');
      const input=object(await readJson(req)),binding=await s.guards.state();
      if(!principal.admin)await s.turns.binding(principal);
      return result(await call('memory.recall',{...input,guard_epoch:binding.epoch,generation:binding.generation}));
    }
    if(path==='/v1/memory/reviews'&&req.method==='GET'){admin(principal);return json(res,200,await s.reviews.list(principal,url.searchParams.get('after')??''));}
    if(path==='/v1/memory/reviews/control'&&req.method==='POST') {
      admin(principal);const body=object(await readJson(req));
      return json(res,200,await s.reviews.controlJob(principal,string(body.id,64),{action:body.action,expected_revision:body.expected_revision}));
    }
    if(req.method==='GET') {
      if(path==='/v1/telegram/identities')return json(res,200,await telegramDirectory(s.stores.archive,principal));
      if(path==='/v1/search')return result(await s.sources.search(principal,url.searchParams.get('q')??'',limit(url.searchParams.get('limit')),archiveFilters(url.searchParams)),true);
      if(path==='/v1/graph')return json(res,200,await s.sources.graph(principal,url.searchParams.get('scope')??'*',url.searchParams.get('after')??'',limit(url.searchParams.get('limit')),url.searchParams.get('focus')??''));
      const event=path.match(/^\/v1\/events\/([a-f0-9]{64})$/);
      if(event)return result(await s.sources.read(principal,event[1]!),true);
      const file=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
      if(file){const bytes=await s.sources.bytes(principal,file[1]!);res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});return res.end(bytes);}
      admin(principal);
      if(path==='/v1/scopes') {
        const rows=(await s.stores.archive.query("SELECT scope,count(*)::integer AS events FROM events WHERE scope>$1 AND origin<>'generated' AND kind<>'telegram_wire' GROUP BY scope ORDER BY scope LIMIT 101",[url.searchParams.get('after')??''])).rows;
        return json(res,200,{scopes:rows.slice(0,100),next:rows.length>100?rows[99].scope:null});
      }
      if(path==='/v1/data') {
        const after=url.searchParams.get('after')??'',filters=archiveFilters(url.searchParams);if(after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_cursor');
        const candidates=(await s.stores.archive.query("SELECT e.id,e.channel,e.scope,e.source_id,e.revision,e.kind,e.origin,e.occurred_at,e.received_at,e.original_text,e.payload,(SELECT array_agg(a.kind ORDER BY a.id) FROM artifacts a WHERE a.event_id=e.id) AS artifact_kinds FROM events e WHERE ($1='' OR (e.received_at,e.id)<(SELECT received_at,id FROM events WHERE id=$1)) AND e.origin<>'generated' AND e.kind<>'telegram_wire' AND ($2='' OR e.scope=$2) AND ($3='' OR $3='incoming' AND e.kind IN ('telegram_update','browser_input') OR $3='assistant' AND e.kind LIKE '%_delivered_message') ORDER BY e.received_at DESC,e.id DESC LIMIT $4",[after,filters.scope,filters.kind,filters.reply?201:51])).rows;
        const states=candidates.length?(await s.stores.control.query(`SELECT event_id,state AS assistant_state,runtime_stage AS assistant_stage,
          error_code AS assistant_error,attempts AS assistant_attempts FROM dispatches WHERE event_id=ANY($1::text[])`,[candidates.map(row=>row.id)])).rows:[];
        const stateById=new Map(states.map(state=>[state.event_id,state])),matched=candidates.filter(row=>matchesArchiveFilters(row,stateById.get(row.id)?.assistant_state,filters));
        const page=matched.slice(0,50),replyPreviews=await archiveReplyPreviews(s.stores.archive,s.stores.control,page);
        const records=page.map(({payload,artifact_kinds,original_text,...row})=>({...row,...stateById.get(row.id),
          text:original_text?.toString()??null,content_types:sourceContentTypes(row.kind,JSON.parse(payload.toString()),artifact_kinds??[]),
          reply_messages:replyPreviews.get(row.id)??[]}));
        const next=matched.length>50?matched[49].id:filters.reply&&candidates.length===201?candidates.at(-1).id:null;
        return json(res,200,{records,next});
      }
      if(path==='/v1/status') {
        const [guard,archive,services]=await Promise.all([s.guards.state(),s.sources.status(principal),
          s.stores.control.query('SELECT service,seen_at FROM service_heartbeats ORDER BY service')]);
        return json(res,200,{service:config.service,storage_layout:'original-only-v1',guard,guard_mode:guard.mode,archive,
          services:services.rows,workers:status()});
      }
    }
    throw new HttpError(404,'not_found');
  })().catch(error=>{
    if(res.headersSent){res.destroy();return;}
    json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'service_unavailable'});
  });});
  server.requestTimeout=30000;return server;
}
