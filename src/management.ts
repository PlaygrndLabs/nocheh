import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, open, stat, lstat, unlink, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError, json, object, readJson, string } from './http.js';
import {DashboardSessions} from './dashboard-auth.js';
import type {Duplex} from 'node:stream';
import {proxyNative,proxyNativeSocket} from './dashboard-proxy.js';
import {proxyProviderMonitor} from './provider-monitor-proxy.js';
import {ProviderOAuth} from './provider-oauth.js';
import {importConfiguration} from './workflows/imports.js';
import {proxyOwnerInspection} from './inspection-proxy.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STATE = resolve(process.env.NOCHEH_STATE_DIR ?? join(ROOT, 'data/local'));
const JOBS = join(STATE, 'admin/jobs');
const PORT = Number(process.env.NOCHEH_DASHBOARD_PORT ?? 8783);
const CONTAINER=process.env.NOCHEH_CONTAINER==='1';
const MONITOR=CONTAINER?18317:Number(process.env.NOCHEH_PROVIDER_MONITOR_PORT??18317);
const MONITOR_HOST=CONTAINER?'cliproxy-monitor':'127.0.0.1';
const PREFIX = '/api/plugins/nocheh';
const PRIMARY = '/api/nocheh';
type Job = {id: string; kind: string; state: string; created_at: string; completed: number;
  files: number; bytes: number; duplicates: number; preview?: Record<string, unknown>;
  mapping?: Record<string, unknown>; review_approved?:boolean; error?: string; result?: unknown;workflow?:'pending'|'inngest'};

async function atomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function jobPath(id: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new HttpError(400, 'invalid_job');
  return join(JOBS, id);
}
async function getJob(id: string): Promise<Job> {
  let job:Job;
  try {job=JSON.parse(await readFile(join(jobPath(id),'job.json'),'utf8')) as Job;}
  catch(error){if(error instanceof HttpError)throw error;throw new HttpError(404,'job_not_found');}
    if(job.workflow){
      const status=object(await python({operation:'workflow.api',path:'/v1/workflows/imports/'+id}));
      if(status.owned){
        const current=object(status.job);job.state=current.state==='completed'?'complete':['queued','running'].includes(String(current.state))?'running':String(current.state);
        job.completed=Number(current.completed);job.duplicates=Number(current.duplicates);
        if(job.state==='complete')job.result={completed:job.completed,duplicates:job.duplicates,telegram_replies:0,review_approved:job.review_approved};
      }
    }
    return job;
}
async function putJob(job: Job) { await atomic(join(jobPath(job.id), 'job.json'), job); }
async function listJobs(max=200) {
  const result: Job[] = [];
  for (const id of await readdir(JOBS)) { try { result.push(await getJob(id)); } catch { /* partial creation */ } }
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, max);
}
async function newJob(kind: string): Promise<Job> {
  const job: Job = {id: randomUUID(), kind, state: kind === 'import' ? 'uploading' : 'queued',
    created_at: new Date().toISOString(), completed: 0, files: 0, bytes: 0, duplicates: 0};
  await mkdir(join(jobPath(job.id), 'upload'), {recursive: true, mode: 0o700}); await putJob(job); return job;
}

export function uploadName(name: string): string {
  if (!name || name.length > 1024 || name.startsWith('/') || /[\\\x00-\x1f]/.test(name)
      || name.split('/').some(part => !part || part === '..' || part === '.')) throw new HttpError(400, 'unsafe_upload_path');
  return name;
}

function python(body: unknown, progress?: (value: Record<string, unknown>) => void,
                started?: (child: ChildProcess) => void): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(process.env.NOCHEH_PYTHON ?? 'python3', ['-m', 'scripts.management'],
      {cwd: ROOT, env: {...process.env, NOCHEH_STATE_DIR: STATE}, stdio: ['pipe', 'pipe', 'ignore']});
    started?.(child);
    let buffer = '', result: unknown, failure: string | undefined;
    // Lifecycle operations must finish their cleanup; do not kill a backup with writers paused.
    const lifecycle = object(body).operation === 'operations.run' || object(body).operation === 'settings.apply';
    const timer = lifecycle ? undefined : setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { failure = 'operation_output_limit'; child.kill(); return; }
      let position: number;
      while ((position = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
        try {
          const value = object(JSON.parse(line));
          if ('result' in value) result = value.result;
          else if (typeof value.error === 'string') failure = value.error;
          else progress?.(value);
        } catch { failure = 'operation_output_invalid'; }
      }
    });
    child.on('error', () => { clearTimeout(timer); reject(new HttpError(503, 'operation_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code || failure || result === undefined) reject(new HttpError(['configuration_conflict','guard_revision_conflict'].includes(failure??'')?409:400, failure ?? 'operation_interrupted'));
      else accept(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(body));
  });
}

const active = new Map<string, ChildProcess>();
const locked = new Set<string>();
async function exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (locked.has(id)) throw new HttpError(409, 'job_busy');
  locked.add(id); try { return await run(); } finally { locked.delete(id); }
}
const runningTasks = new Set<Promise<void>>();
function launch(job: Job, body: Record<string, unknown>) {
  let writes = Promise.resolve();
  const task = python(body, value => {
    if (typeof value.completed === 'number') job.completed = value.completed;
    if (typeof value.duplicates === 'number') job.duplicates = value.duplicates;
    const snapshot = {...job}; writes = writes.then(() => putJob(snapshot));
  }, child => active.set(job.id, child)).then(async result => {
    await writes; job.result = result;
    if (job.state !== 'cancelled') job.state = object(result).status === 'import_paused'?'interrupted':object(result).status === 'apply_failed' ? 'failed' : 'complete';
  }).catch(async error => {
    await writes.catch(() => {});
    if (job.state !== 'cancelled') { job.state = 'failed'; job.error = error instanceof HttpError ? error.code : 'operation_failed'; }
  }).finally(async () => { await putJob(job); active.delete(job.id); activeJobs.delete(job.id); if(job.kind.startsWith('operations.')||job.kind==='settings.apply') operationBusy=false; });
  runningTasks.add(task); void task.finally(()=>runningTasks.delete(task)).catch(()=>{});
  activeJobs.set(job.id, job);
}
const activeJobs = new Map<string, Job>();
let operationBusy = false;

async function upload(req: IncomingMessage, job: Job, name: string) {
  if (job.state !== 'uploading' || job.files >= 10000) throw new HttpError(409, 'upload_closed');
  const path = join(jobPath(job.id), 'upload', uploadName(name));
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = path + '.' + randomUUID() + '.part';
  const file = await open(temporary, 'wx', 0o600); let size = 0;
  try {
    try { await stat(path); throw new HttpError(409, 'duplicate_upload'); }
    catch (error) { if (error instanceof HttpError) throw error; }
    for await (const raw of req.iterator({destroyOnReturn: false})) {
      const chunk = raw as Buffer; size += chunk.length;
      const max = name.endsWith('.zip') ? 256 * 1024 * 1024 : 50 * 1024 * 1024;
      if (size > max || job.bytes + size > 512 * 1024 * 1024) throw new HttpError(413, 'upload_size_limit');
      await file.write(chunk);
    }
    await file.sync(); await file.close(); await rename(temporary, path);
    job.files++; job.bytes += size; await putJob(job);
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  return job;
}

async function archive(path: string) {
  // Config is resolved by the existing Python client, never sent to the browser.
  return python({operation: 'archive.read', path});
}

export async function startManagement() {
  await mkdir(JOBS, {recursive: true, mode: 0o700});
  const token = (await readFile(join(STATE, 'admin/dashboard/token'), 'utf8')).trim();
  if (token.length < 32) throw new Error('dashboard_token_missing');
  const monitorKeyPath=join(STATE,'provider/keys/monitor-admin.key');
  const monitorKeyStat=await lstat(monitorKeyPath);
  if(!monitorKeyStat.isFile()||monitorKeyStat.isSymbolicLink()||monitorKeyStat.size>1024)throw new Error('provider_monitor_key_invalid');
  const monitorKey=(await readFile(monitorKeyPath,'utf8')).trim();
  if(monitorKey.length<32)throw new Error('provider_monitor_key_missing');
  const sessions=new DashboardSessions();
  const archiveConnection=object(await python({operation:'archive.connection'}));
  const providerOAuth=new ProviderOAuth(MONITOR,monitorKey,PORT,1455,MONITOR_HOST,CONTAINER?'0.0.0.0':'127.0.0.1');
  const sockets=new Set<Duplex>();
  for (const job of await listJobs(Infinity)) if (!job.workflow&&['running', 'queued'].includes(job.state)) {
    job.state = 'interrupted'; job.error = 'dashboard_restarted'; await putJob(job);
  }
  function authorized(req: IncomingMessage, download=false) {
    const cookie = download ? req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('nocheh_download='))?.slice('nocheh_download='.length) : undefined;
    const actual = Buffer.from(String(req.headers['x-nocheh-session-token'] ?? req.headers['x-hermes-session-token'] ?? cookie ?? ''));
    const expected = Buffer.from(token);
    if (actual.length === expected.length && timingSafeEqual(actual, expected))return true;
    sessions.authorize(req,!['GET','HEAD'].includes(req.method??''));
    return false;
  }
  function checkOrigin(req:IncomingMessage) {
    const authority = `127.0.0.1:${PORT}`;
    if (![authority, `localhost:${PORT}`].includes(req.headers.host ?? '')) throw new HttpError(403, 'invalid_host');
    if(req.headers.origin&&!['http://'+authority,`http://localhost:${PORT}`].includes(req.headers.origin))throw new HttpError(403,'invalid_origin');
    if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'cross_site_denied');
  }
  const server = createServer((req, res) => { void (async () => {
    const authority = `127.0.0.1:${PORT}`;
    checkOrigin(req);
    const url = new URL(req.url ?? '/', `http://${authority}`), path = url.pathname;
    const prefix=path.startsWith(PRIMARY+'/')?PRIMARY:PREFIX;
    if (path.startsWith(prefix + '/')) {
      const route = path.slice(prefix.length);
      const legacy=authorized(req,req.method==='GET' && /^\/(?:artifacts\/[a-f0-9]{64}|exports\/[a-f0-9-]{36})\/download$/.test(route));
      // Session cookie is accepted only by streaming download routes, never by settings or mutations.
      if(legacy)res.setHeader('set-cookie',`nocheh_download=${token}; HttpOnly; SameSite=Strict; Path=${prefix}/`);
      if (req.method === 'GET' && route === '/health') return json(res, 200, {ok: true});
      if (req.method === 'GET' && route === '/monitoring') return json(res,200,await python({operation:'monitoring.status'}));
      if(req.method==='GET'&&/^\/workflows(?:\/(?:health|[a-f0-9]{64}))?$/.test(route))return json(res,200,await python({operation:'workflow.api',path:'/v1'+route+url.search}));
      if(req.method==='POST'&&/^\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(route))return json(res,200,await python({operation:'workflow.api',path:'/v1'+route,body:await readJson(req)}));
      if(route==='/tools/actions' && req.method==='GET')return json(res,200,await python({operation:'tools.manage'}));
      if(req.method==='POST' && ['/tools/decide','/tools/telegram-decision','/tools/grant','/tools/revoke'].includes(route))return json(res,200,await python({operation:'tools.manage',action:route.slice(7),request:await readJson(req)}));
      if (req.method === 'GET' && route === '/runtime') return json(res,200,await archive('/v1/runtime'));
      if (req.method==='POST' && route==='/ws-ticket')return json(res,200,{ticket:sessions.ticket(sessions.authorize(req)),ttl_seconds:30});
      if(['/memory/honcho','/memory/spaces','/memory/shares','/memory/shares/revoke','/memory/reviews','/memory/reviews/control','/memory/recall','/memory/preview'].includes(route) && ['GET','POST'].includes(req.method??'')) {
        return json(res,200,await python({operation:'memory.api',path:'/v1'+route+url.search,
          ...(req.method==='POST'?{body:object(await readJson(req))}:{})}));
      }
      if (req.method === 'POST' && route === '/shutdown') {
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        json(res, 200, {ok: true}); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); return;
      }
      if (req.method === 'GET' && route === '/scopes') return json(res,200,await archive('/v1/scopes?after='+encodeURIComponent(url.searchParams.get('after')??'')));
      if (req.method === 'GET' && route === '/graph') return json(res,200,await python({operation:'graph.read',scope:url.searchParams.get('scope')??'',after:url.searchParams.get('after')??'',focus:url.searchParams.get('focus')??''}));
      const artifact=route.match(/^\/artifacts\/([a-f0-9]{64})\/download$/);
      if(req.method==='GET' && artifact?.[1]) {
        await python({operation:'archive.cache',id:artifact[1]});
        res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent((url.searchParams.get('name')??artifact[1]).split(/[\\/]/).at(-1)!.slice(0,200)),'cache-control':'no-store'});
        createReadStream(join(STATE,'admin/downloads',artifact[1])).on('error',()=>res.destroy()).pipe(res);return;
      }
      const exported=route.match(/^\/exports\/([a-f0-9-]{36})\/download$/);
      if(req.method==='GET' && exported?.[1]) {
        const job=await getJob(exported[1]);if(!['operations.export','operations.portable-export'].includes(job.kind)||job.state!=='complete')throw new HttpError(409,'export_not_ready');
        res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="'+(job.kind==='operations.portable-export'?'nocheh-archive-memory.zip':'nocheh-archive.zip')+'"','cache-control':'no-store'});
        createReadStream(join(STATE,'admin/exports',job.id,'export.zip')).on('error',()=>res.destroy()).pipe(res);return;
      }
      if(req.method==='GET' && route==='/operations')return json(res,200,await python({operation:'operations.list'}));
      if(req.method==='POST' && route==='/operations') return exclusive('writer-start', async () => {
        const body=object(await readJson(req));const action=string(body.action,30);
        if(!['diagnose','backup','restore','restart','export','portable-export'].includes(action))throw new HttpError(400,'operation_denied');
        if(operationBusy||active.size)throw new HttpError(409,'wait_for_active_jobs');
        operationBusy=true;
        try {const job=await newJob('operations.'+action);job.state='running';await putJob(job);
          launch(job,{operation:'operations.run',action,job:job.id,options:body.options??{}});return json(res,202,job);
        }catch(error){operationBusy=false;throw error;}
      });
      if (route === '/policy' && ['GET','POST'].includes(req.method??'')) {
        const body=req.method==='POST'?object(await readJson(req)):{};
        return json(res,200,await python({operation:'policy.manage',request:{...body,profile:url.searchParams.get('profile'),job:url.searchParams.get('job')},write:req.method==='POST'}));
      }
      if (req.method === 'GET' && route === '/settings') return json(res, 200, await python({operation: 'settings.view'}));
      if (req.method === 'GET' && route === '/honcho/status') return json(res, 200, await python({operation: 'honcho.status'}));
      if (req.method === 'POST' && route === '/honcho/read') return json(res, 200, await python({operation: 'honcho.read', args: object(await readJson(req)).args}));
      if (req.method === 'GET' && route === '/memory/profiles') return json(res, 200, await python({operation:'hermes.manage',request:{action:'profiles'}}));
      if (req.method === 'GET' && ['/memory','/memory/preferences'].includes(route)) {
        return json(res,200,await python({operation:'hermes.manage',request:{action:route.endsWith('preferences')?'preferences':'memory',
          scope:url.searchParams.get('scope'),profile:url.searchParams.get('profile'),session:url.searchParams.get('session'),offset:Number(url.searchParams.get('offset')??0)}}));
      }
      if (req.method === 'POST' && route === '/memory/preferences') return exclusive('writer-start',async()=>{
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        const body=object(await readJson(req));
        return json(res,200,await python({operation:'hermes.manage',request:{action:'preferences',scope:body.scope,changes:body.changes,revision:body.revision}}));
      });
      if (req.method === 'POST' && route === '/settings') return exclusive('writer-start',async()=>{
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        const body = object(await readJson(req));
        return json(res, 200, await python({operation: 'settings.save', changes: body.changes, revision: body.revision}));
      });
      if (req.method === 'POST' && route === '/settings/apply') return exclusive('writer-start', async () => {
        if(operationBusy||active.size)throw new HttpError(409,'wait_for_active_jobs');
        operationBusy=true;
        try {const job = await newJob('settings.apply'); job.state = 'running'; await putJob(job);
          launch(job, {operation: 'settings.apply'}); return json(res, 202, job);
        }catch(error){operationBusy=false;throw error;}
      });
      if (req.method === 'GET' && route === '/status') return json(res, 200, await archive('/v1/status'));
      if ((req.method==='GET'||req.method==='POST') && (route==='/data'||/^\/data\/[a-f0-9]{64}\/guarded(?:\/history)?$/.test(route))) {
        return json(res,200,await python({operation:'archive.projections',path:'/v1'+route+url.search,
          ...(req.method==='POST'?{body:await readJson(req,8*1024*1024)}:{})}));
      }
      if (req.method === 'GET' && route === '/search') return json(res, 200, await archive('/v1/search?' + url.searchParams.toString()));
      if (req.method === 'GET' && route.startsWith('/events/')) return json(res, 200, await archive('/v1' + route));
      if (req.method === 'GET' && route === '/jobs') return json(res, 200, await listJobs());
      if (req.method === 'POST' && route === '/jobs') return json(res, 201, await newJob('import'));
      const match = route.match(/^\/jobs\/([^/]+)(?:\/(upload|preview|start|cancel))?$/);
      if (match?.[1]) {
        const id = match[1], action = match[2];
        if (req.method === 'GET' && !action) return json(res, 200, await getJob(id));
        return exclusive(id, async () => {
          const job = await getJob(id);
          if (req.method === 'PUT' && action === 'upload') return json(res, 200, await upload(req, job, url.searchParams.get('name') ?? ''));
          if (req.method === 'POST' && action === 'preview') {
            if (job.state !== 'uploading') throw new HttpError(409, 'preview_closed');
            job.preview = object(await python({operation: 'import.inspect', job: id}));
            job.state = 'ready'; await putJob(job); return json(res, 200, job);
          }
          if (req.method === 'POST' && action === 'start') return exclusive('writer-start', async () => {
            if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
            if (!job.preview || !['ready', 'failed', 'cancelled', 'interrupted'].includes(job.state) || active.has(id)) throw new HttpError(409, 'job_not_ready');
            const body = object(await readJson(req));
            const mapping = object(body.mapping ?? job.mapping ?? {});
            if(body.review_approved!==undefined && typeof body.review_approved!=='boolean')throw new HttpError(400,'invalid_review_approval');
            if(job.review_approved!==undefined && body.review_approved!==undefined && body.review_approved!==job.review_approved)throw new HttpError(409,'resume_review_approval_cannot_change');
            job.review_approved=job.review_approved??(body.review_approved===true);
            if (job.mapping && JSON.stringify(mapping) !== JSON.stringify(job.mapping)) throw new HttpError(409, 'resume_scope_cannot_change');
            job.mapping=mapping;job.workflow='pending';delete job.error;await putJob(job);
            const confirmed=object(await python({operation:'workflow.api',path:'/v1/workflows/imports/confirm',body:{id,configuration_hash:importConfiguration(job.preview,mapping,job.review_approved),review_approved:job.review_approved,total:job.preview.messages,completed:job.completed,duplicates:job.duplicates,resume:['failed','cancelled','interrupted'].includes(job.state)}}));
            if(confirmed.owned===true){job.workflow='inngest';job.state='running';await putJob(job);return json(res,202,await getJob(id));}
            throw new HttpError(503,'import_admission_unavailable');
          });
          if (req.method === 'POST' && action === 'cancel') {
            if (job.kind !== 'import' || job.state !== 'running') throw new HttpError(409, 'job_not_cancellable');
            if(job.workflow){await python({operation:'workflow.api',path:'/v1/workflows/imports/cancel',body:{id}});return json(res,200,await getJob(id));}
            const running = activeJobs.get(id); if (running) running.state = 'cancelled';
            active.get(id)?.kill('SIGTERM'); job.state = 'cancelled'; await putJob(job);
            return json(res, 200, job);
          }
          throw new HttpError(404, 'not_found');
        });
      }
      throw new HttpError(404, 'not_found');
    }
    res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');
    if(req.method==='GET'&&(path==='/nocheh'||path==='/nocheh/')){res.writeHead(308,{location:'/'+url.search});res.end();return;}
    if(req.method==='GET'&&path==='/hermes'){res.writeHead(308,{location:'/hermes/'+url.search});res.end();return;}
    if(req.method==='GET'&&(path==='/providers'||path==='/providers/')){res.writeHead(308,{location:'/providers/management.html'+url.search});res.end();return;}
    if(req.method==='GET'&&path==='/') {
      const session=sessions.page(req);
      res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      const html=(await readFile(join(ROOT,'web/dist/index.html'),'utf8')).replace('/*NOCHEH_BOOTSTRAP*/',`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);return;
    }
    const asset=path.match(/^\/assets\/(app\.js|style\.css|graph-3d\.js)$/);
    if(req.method==='GET'&&asset?.[1]) {
      res.writeHead(200,{'content-type':asset[1].endsWith('.css')?'text/css':'text/javascript','cache-control':'no-cache'});
      createReadStream(join(ROOT,'web/dist',asset[1])).on('error',()=>res.destroy()).pipe(res);return;
    }
    if(path.startsWith('/providers/')) {
      const page=req.method==='GET'&&path==='/providers/management.html';
      const session=page?sessions.page(req):sessions.authorize(req,!['GET','HEAD'].includes(req.method??''));
      if(page)res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      if(req.method==='GET'&&path==='/providers/v0/management/codex-auth-url') {
        sessions.authorize(req,true);
        const credentials=await readdir(join(STATE,'provider/auth')).catch(()=>[] as string[]);
        if(credentials.some(name=>name.endsWith('.json')))throw new HttpError(409,'provider_login_already_exists');
        return json(res,200,await providerOAuth.start());
      }
      proxyProviderMonitor(req,res,MONITOR,monitorKey,session.csrf,MONITOR_HOST);return;
    }
    if(path.startsWith('/inngest/')){
      const session=sessions.authorize(req,req.method!=='GET');
      await proxyOwnerInspection(req,res,Number(archiveConnection.port),string(archiveConnection.token),session.csrf,String(archiveConnection.host??'127.0.0.1'));return;
    }
    if(path.startsWith('/hermes/')) {
      if(req.method==='POST'&&path==='/hermes/api/auth/ws-ticket') {
        // Native's ticket helper uses cookie + Origin, without a custom header.
        if(!req.headers.origin)throw new HttpError(403,'origin_required');
        return json(res,200,{ticket:sessions.ticket(sessions.authorize(req,false)),ttl_seconds:30});
      }
      const page=req.method==='GET'&&!path.startsWith('/hermes/api/')&&!path.startsWith('/hermes/assets/')&&!path.startsWith('/hermes/dashboard-plugins/');
      const session=page?sessions.page(req):sessions.authorize(req,!['GET','HEAD'].includes(req.method??''));
      if(page)res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      const connection=object(await python({operation:'native.connection'}));
      proxyNative(req,res,Number(connection.port),string(connection.token),session.csrf,String(connection.host??'127.0.0.1'));return;
    }
    throw new HttpError(404,'not_found');
  })().catch(error => { if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503,
    {error: error instanceof HttpError ? error.code : 'management_unavailable'}); else res.end(); }); });
  server.requestTimeout = 120000;
  server.on('upgrade', (req, socket, head) => { void (async()=>{
    try {
      checkOrigin(req);if(!req.headers.origin)throw new HttpError(403,'origin_required');
      const url=new URL(req.url??'','http://local');
      if(!['/hermes/api/pty','/hermes/api/ws','/hermes/api/events'].includes(url.pathname))throw new HttpError(403,'websocket_route_denied');
      sessions.consume(req,url.searchParams.get('ticket')??'');
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      const connection=object(await python({operation:'native.connection'}));
      if(!socket.destroyed)proxyNativeSocket(req,socket,head,Number(connection.port),string(connection.token),String(connection.host??'127.0.0.1'));
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
  })(); });
  server.listen(PORT, CONTAINER?'0.0.0.0':'127.0.0.1', () => console.log(`Nocheh dashboard: http://127.0.0.1:${PORT}/`));
  let stopping=false;
  const stop = () => {
    if(stopping)return;stopping=true;
    for(const socket of sockets)socket.destroy();
    for (const [id,child] of active) if(activeJobs.get(id)?.kind==='import')child.kill('SIGTERM');
    providerOAuth.close();
    server.close(()=>{void Promise.allSettled([...runningTasks]).then(()=>process.exit(0));});
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startManagement();
