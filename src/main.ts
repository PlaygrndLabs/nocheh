import {captureInput,claimRun,finishRun,renewRun,prepareRun} from './managed-runs.js';
import { createServer } from 'node:http';
import { evidenceGraph } from './graph.js';
import { listSpaces, spacePolicy, saveSpace,parentSpace } from './spaces.js';
import {approveLearning,listReviews,controlReview} from './learning.js';
import { settings } from './config.js';
import { connectDatabase, heartbeat, initialize } from './database.js';
import { HttpError, json, readJson, object } from './http.js';
import { archiveStatus, envelope, ingest } from './archive.js';
import { startWorker } from './worker.js';
import { hermesAdapter } from './hermes-adapter.js';
import { runtimeCall, type RuntimeOperation } from './runtime.js';
import { guardPayload } from './guard.js';
import { requestAction } from './actions.js';
import { reader, admin,assertAudience } from './access.js';
import {listShares,shareKnowledge,revokeShare,sharedContext,readShared} from './sharing.js';
import { search, readEvent, readArtifact, exportPage, importRecord, uploadArtifact, replay, limit } from './retrieval.js';

const config = settings();
const runtime = hermesAdapter({url: config.hermesUrl, token: config.token});
const call = runtimeCall(runtime);
// Each service owns its connection pool; an outage must be visible in health.
const pool = connectDatabase(config);
await initialize(pool);
await heartbeat(pool, config.service);
const timer = setInterval(() => { void heartbeat(pool, config.service).catch(() => {}); }, 5000);
timer.unref();
const stopWorker = config.service === 'worker' ? startWorker(pool, config) : () => {};

const server = createServer((req, res) => { void (async () => {
  const url = new URL(req.url ?? '/', 'http://local'), path=url.pathname;
  if (req.method === 'GET' && path === '/health') {
    await pool.query('SELECT 1');
    return json(res, 200, {ok: true, service: config.service, database: 'ready'});
  }
  const principal=reader(req, config.token);
  await assertAudience(pool,principal);
  if(config.service==='archive' && path==='/v1/memory/check' && req.method==='GET')return json(res,200,{valid:true});
  if(config.service==='archive' && path==='/v1/memory/preview' && req.method==='GET') {
    admin(principal);const policy=await spacePolicy(pool,url.searchParams.get('space')??'');
    const preview={scope:parentSpace(policy.id)??policy.id,space:policy.id,revision:policy.revision,admin:false};
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
  if(config.service==='archive' && path==='/v1/memory/context' && req.method==='GET')return json(res,200,await sharedContext(pool,principal,url.searchParams.get('q')??'',call));
  const shared=path.match(/^\/v1\/memory\/(shared|filtered)\/([a-f0-9]{64})$/);
  if(config.service==='archive' && shared && req.method==='GET')return json(res,200,await readShared(pool,principal,shared[1]!,shared[2]!));
  if(config.service==='archive' && path==='/v1/memory/recall') {
    if(principal.scope!==null)throw new HttpError(403,'owner_memory_required');
    if(req.method==='POST')return json(res,200,await call('memory.recall',object(await readJson(req))));
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
  if (config.service === 'archive' && req.method === 'GET') {
    if (path==='/v1/graph') return json(res,200,await evidenceGraph(pool,principal,url.searchParams.get('scope') ?? '',url.searchParams.get('after') ?? '',limit(url.searchParams.get('limit')),url.searchParams.get('focus') ?? ''));
    if (path==='/v1/search') return json(res,200,await search(pool,principal,url.searchParams.get('q') ?? '',limit(url.searchParams.get('limit'))));
    const event=path.match(/^\/v1\/events\/([a-f0-9]{64})$/);
    if (event?.[1]) return json(res,200,await readEvent(pool,principal,event[1]));
    const artifact=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
    if (artifact?.[1]) {
      const bytes=await readArtifact(pool,principal,config.dataDir,artifact[1]);
      res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});
      return res.end(bytes);
    }
  }
  admin(principal);
  if (config.service==='archive' && req.method==='GET' && path==='/v1/runtime') {
    const status = await call('status', {}, 5000).catch(() => ({ok:false,error:'runtime_unavailable'}));
    return json(res,200,{id:runtime.id,capabilities:runtime.capabilities,status});
  }
  if(config.service==='archive' && req.method==='POST' && path.startsWith('/v1/browser/')) {
    const body=await readJson(req,36*1024*1024);
    if(path==='/v1/browser/input')return json(res,200,await captureInput(pool,config,body));
    if(path==='/v1/browser/claim')return json(res,200,await claimRun(pool,config,body));
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
    if (req.method==='POST' && path==='/v1/import') return json(res,200,await importRecord(pool,await readJson(req,32*1024*1024)));
    if (req.method==='POST' && path==='/v1/replay') return json(res,200,await replay(pool,object(await readJson(req)).event_ids));
    const upload=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
    if (req.method==='POST' && upload?.[1]) return json(res,200,await uploadArtifact(pool,config.dataDir,upload[1],await readJson(req,70*1024*1024)));
  }
  if (req.method === 'GET' && path === '/v1/status') {
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
server.listen(config.port, config.host, () => console.log(JSON.stringify({event: 'ready', service: config.service, port: config.port})));
let stopping=false;
function stop() {
  if(stopping)return;stopping=true;clearInterval(timer);
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  void Promise.all([closed,stopWorker()]).then(()=>pool.end()).then(()=>process.exit(0));
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
