import {createServer} from 'node:http';
import {join} from 'node:path';
import {admin,reader} from '../access.js';
import {canonical,digest,envelope} from '../archive.js';
import type {Settings} from '../config.js';
import {HttpError,authorize,json,object,readJson,string} from '../http.js';
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
import {registerWorker} from '../workflows/store.js';
import {drainSourceSpool} from './capture.js';
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
    if(req.method==='POST'&&path==='/v1/browser/input') {
      admin(principal);return json(res,200,await s.browserCapture.capture(principal,await readJson(req,40*1024*1024)));
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
      if(req.method==='POST'&&path.startsWith('/v1/workflows/host/')) {
        const body=await readJson(req);
        if(path==='/v1/workflows/host/claim') {
          if(object(body).family!=='tools')throw new HttpError(503,'host_import_migration_pending');
          await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
          return json(res,200,await claimHostWorkflow(s.stores.control,body));
        }
        if(path==='/v1/workflows/host/renew')return json(res,200,await renewHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/finish')return json(res,200,await finishHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/continue')return json(res,200,await continueHostWorkflow(s.stores.control,body));
        if(path==='/v1/workflows/host/heartbeat') {
          await registerWorker(s.stores.control,'host',['tools']);
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
    if(path==='/v1/memory/check'&&req.method==='GET')return json(res,200,{valid:true});
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
    if(path==='/v1/memory/context'&&req.method==='GET')return result(await s.shared.context(principal,url.searchParams.get('q')??''),true);
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
      if(path==='/v1/search')return result(await s.sources.search(principal,url.searchParams.get('q')??'',limit(url.searchParams.get('limit'))),true);
      if(path==='/v1/graph')return json(res,200,await s.sources.graph(principal,url.searchParams.get('scope')??'*',url.searchParams.get('after')??'',limit(url.searchParams.get('limit')),url.searchParams.get('focus')??''));
      const event=path.match(/^\/v1\/events\/([a-f0-9]{64})$/);
      if(event)return result(await s.sources.read(principal,event[1]!),true);
      const file=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
      if(file){const bytes=await s.sources.bytes(principal,file[1]!);res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});return res.end(bytes);}
      admin(principal);
      if(path==='/v1/scopes') {
        const rows=(await s.stores.archive.query('SELECT scope,count(*)::integer AS events FROM events WHERE scope>$1 GROUP BY scope ORDER BY scope LIMIT 101',[url.searchParams.get('after')??''])).rows;
        return json(res,200,{scopes:rows.slice(0,100),next:rows.length>100?rows[99].scope:null});
      }
      if(path==='/v1/data') {
        const after=url.searchParams.get('after')??'';if(after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_cursor');
        const rows=(await s.stores.archive.query('SELECT id,channel,scope,source_id,revision,kind,origin,occurred_at,received_at,original_text FROM events WHERE id>$1 ORDER BY id LIMIT 51',[after])).rows;
        return json(res,200,{records:rows.slice(0,50).map(row=>({...row,original_text:undefined,text:row.original_text?.toString()??null})),next:rows.length>50?rows[49].id:null});
      }
      if(path==='/v1/status')return json(res,200,{service:config.service,storage_layout:'original-only-v1',guard:await s.guards.state(),
        services:(await s.stores.control.query('SELECT service,seen_at FROM service_heartbeats ORDER BY service')).rows,workers:status()});
    }
    throw new HttpError(404,'not_found');
  })().catch(error=>{
    if(res.headersSent){res.destroy();return;}
    json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'service_unavailable'});
  });});
  server.requestTimeout=30000;return server;
}
