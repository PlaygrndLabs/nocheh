import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, open, stat, unlink, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError, json, object, readJson, string } from './http.js';
import {OwnerSessions,SESSION_COOKIE_AGE,csrfFor} from './dashboard-auth.js';
import type {Duplex} from 'node:stream';
import {proxyNative,proxyNativeSocket} from './dashboard-proxy.js';
import {importConfiguration} from './workflows/imports.js';
import {proxyOwnerInspection} from './inspection-proxy.js';
import {ownerStoragePath} from './stores/owner-api.js';
import {ManagementMaintenance} from './management-maintenance.js';
import {DashboardLiveUpdates} from './dashboard-live.js';
import {OwnerLock} from './owner-lock.js';
import {miniAppRoute} from './mini-app.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STATE = resolve(process.env.NOCHEH_STATE_DIR ?? join(ROOT, 'data/local'));
const JOBS = join(STATE, 'admin/jobs');
const PORT = Number(process.env.NOCHEH_DASHBOARD_PORT ?? 8783);
const CONTAINER=process.env.NOCHEH_CONTAINER==='1';
const PREFIX = '/api/plugins/nocheh';
const PRIMARY = '/api/nocheh';
type Job = {id: string; kind: string; state: string; created_at: string; completed: number;
  files: number; bytes: number; duplicates: number; preview?: Record<string, unknown>;
  mapping?: Record<string, unknown>; review_approved?:boolean; error?: string; result?: unknown;workflow?:'pending'|'inngest';
  /** After the messages are written: how far they are read and checked, and when all were. */
  prepared?: Record<string, unknown> | null; prepared_at?: string | null;
  /** The step a settings apply is on, so a reloaded page can still follow it. */
  step?: string;
  /** A backup the daily schedule started rather than the owner. */
  automatic?: boolean};

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
        job.prepared=current.progress?object(current.progress):null;job.prepared_at=current.ready_at?String(current.ready_at):null;
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
                started?: (child: ChildProcess) => void, coordinator?:string): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(process.env.NOCHEH_PYTHON ?? 'python3', ['-m', 'tools.runtime.management'],
      {cwd: ROOT, env: {...process.env, NOCHEH_STATE_DIR: STATE,NOCHEH_MAINTENANCE_COORDINATOR:coordinator??''}, stdio: ['pipe', 'pipe', 'ignore']});
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
      if (code || failure || result === undefined) reject(new HttpError(/(?:_conflict|_changed)$/.test(failure??'')?409:400, failure ?? 'operation_interrupted'));
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
const maintenance=new ManagementMaintenance();
function launch(job: Job, body: Record<string, unknown>, coordinator?:string) {
  let writes = Promise.resolve();
  const task = python(body, value => {
    if (typeof value.completed === 'number') job.completed = value.completed;
    if (typeof value.duplicates === 'number') job.duplicates = value.duplicates;
    if (typeof value.step === 'string') job.step = value.step.slice(0, 40);
    const snapshot = {...job}; writes = writes.then(() => putJob(snapshot));
  }, child => active.set(job.id, child),coordinator).then(async result => {
    await writes; job.result = result;
    if (job.state !== 'cancelled') job.state = object(result).status === 'import_paused'?'interrupted':object(result).status === 'apply_failed' ? 'failed' : 'complete';
  }).catch(async error => {
    await writes.catch(() => {});
    if (job.state !== 'cancelled') { job.state = 'failed'; job.error = error instanceof HttpError ? error.code : 'operation_failed'; }
  }).finally(async () => {try{await putJob(job);}finally{active.delete(job.id); activeJobs.delete(job.id); if(job.kind.startsWith('operations.')||job.kind==='settings.apply') operationBusy=false;if(coordinator)maintenance.end(coordinator);} });
  runningTasks.add(task); void task.finally(()=>runningTasks.delete(task)).catch(()=>{});
  activeJobs.set(job.id, job);
}
const activeJobs = new Map<string, Job>();
let operationBusy = false;

/** A large file can arrive in pieces, so it fits through proxies that limit one request's size. */
async function upload(req: IncomingMessage, job: Job, name: string, offset = 0, more = false) {
  if (job.state !== 'uploading' || job.files >= 10000) throw new HttpError(409, 'upload_closed');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'invalid_upload_offset');
  const path = join(jobPath(job.id), 'upload', uploadName(name)), partial = path + '.part';
  const max = name.endsWith('.zip') ? 512 * 1024 * 1024 : name.endsWith('.json') ? 128 * 1024 * 1024 : 50 * 1024 * 1024;
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  try { await stat(path); throw new HttpError(409, 'duplicate_upload'); }
  catch (error) { if (error instanceof HttpError) throw error; }
  if (offset === 0) await unlink(partial).catch(() => {});
  else if ((await stat(partial).catch(() => null))?.size !== offset) throw new HttpError(409, 'upload_offset_mismatch');
  const file = await open(partial, offset === 0 ? 'wx' : 'a', 0o600); let size = offset;
  try {
    for await (const raw of req.iterator({destroyOnReturn: false})) {
      const chunk = raw as Buffer; size += chunk.length;
      if (size > max || job.bytes + size > 512 * 1024 * 1024) throw new HttpError(413, 'upload_size_limit');
      await file.write(chunk);
    }
    await file.sync(); await file.close();
  } catch (error) { await file.close().catch(() => {}); await unlink(partial).catch(() => {}); throw error; }
  if (more) return job;
  await rename(partial, path);
  job.files++; job.bytes += size; await putJob(job);
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
  const lock=new OwnerLock(join(STATE,'admin/owner-lock.json'));
  const sessions=new OwnerSessions(lock);
  const archiveConnection=object(await python({operation:'archive.connection'}));
  const sockets=new Set<Duplex>();
  const live=new DashboardLiveUpdates();
  for (const job of await listJobs(Infinity)) if (!job.workflow&&['running', 'queued'].includes(job.state)) {
    job.state = 'interrupted'; job.error = 'dashboard_restarted'; await putJob(job);
  }
  /** Who is calling: the installation token, a signed-in browser, or a signed-in phone through the mini app. */
  async function authorized(req: IncomingMessage, route: string, download=false):Promise<'token'|'browser'|'phone'> {
    const cookie = download ? req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('nocheh_download='))?.slice('nocheh_download='.length) : undefined;
    const actual = Buffer.from(String(req.headers['x-nocheh-session-token'] ?? req.headers['x-hermes-session-token'] ?? cookie ?? ''));
    const expected = Buffer.from(token);
    if (actual.length === expected.length && timingSafeEqual(actual, expected))return 'token';
    const phone=req.headers['x-nocheh-mini-session'];
    if(typeof phone==='string'&&!sessions.token(req)) {
      // A phone reaches only the mini app's own routes, with a header token and no cookie, so no CSRF applies.
      if(!miniAppRoute(req.method??'',route))throw new HttpError(404,'not_found');
      const state=await sessions.state(phone,'phone');
      if(state==='no_password')throw new HttpError(401,'mini_app_password_not_set');
      if(state!=='signed_in')throw new HttpError(401,'mini_app_sign_in_required');
      return 'phone';
    }
    await sessions.authorize(req,!['GET','HEAD'].includes(req.method??''));
    return 'browser';
  }
  const sessionCookie=(value:string,age=SESSION_COOKIE_AGE)=>`nocheh_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
  /** Answers a password check with its refusal details: tries left before a pause, or when the pause ends. */
  async function passwordAnswer(res:ServerResponse,work:()=>Promise<unknown>) {
    try {return json(res,200,await work());}
    catch(error) {
      if(!(error instanceof HttpError))throw error;
      const {until,tries_left}=error as HttpError&{until?:number;tries_left?:number};
      return json(res,error.status,{error:error.code,...(until?{until}:{}),...(tries_left!==undefined?{tries_left}:{})});
    }
  }
  function checkOrigin(req:IncomingMessage) {
    const authority = `127.0.0.1:${PORT}`;
    if (![authority, `localhost:${PORT}`].includes(req.headers.host ?? '')) throw new HttpError(403, 'invalid_host');
    if(req.headers.origin&&!['http://'+authority,`http://localhost:${PORT}`].includes(req.headers.origin))throw new HttpError(403,'invalid_origin');
    if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'cross_site_denied');
  }
  /** Starts an enumerated operation; callers hold the writer-start lock. `request` is the
   * caller's own admitted request, which a backup's drain must not wait for. */
  async function startOperation(action:string,options:unknown,request:symbol,automatic=false):Promise<Job> {
    if(operationBusy||active.size)throw new HttpError(409,'wait_for_active_jobs');
    operationBusy=true;
    let coordinator:string|undefined,job:Job|undefined;
    try {job=await newJob('operations.'+action);job.state='running';if(automatic)job.automatic=true;await putJob(job);
      if(automatic)await python({operation:'backups.started',job:job.id});
      if(action==='backup'){
        const draining=maintenance.begin(job.id,request);
        live.closeAll();
        coordinator=await draining;
        for(const socket of sockets)socket.destroy();maintenance.ready(coordinator);
      }
      launch(job,{operation:'operations.run',action,job:job.id,options},coordinator);return job;
    }catch(error){
      operationBusy=false;if(coordinator)maintenance.end(coordinator);
      if(job){job.state='failed';job.error=error instanceof HttpError?error.code:'operation_failed';await putJob(job).catch(()=>{});}
      throw error;
    }
  }
  const server = createServer((req, res) => {
    if(stopping){json(res,503,{error:'dashboard_stopping'});return;}
    const tracked=maintenance.enter();
    const responseDone=new Promise<void>(resolve=>{res.once('finish',resolve);res.once('close',resolve);});
    void (async () => {
    const authority = `127.0.0.1:${PORT}`;
    checkOrigin(req);
    const url = new URL(req.url ?? '/', `http://${authority}`), path = url.pathname;
    if(!maintenance.allows(req.method??'',path))throw new HttpError(503,'installation_maintenance');
    const prefix=path.startsWith(PRIMARY+'/')?PRIMARY:PREFIX;
    if (path.startsWith(prefix + '/')) {
      const route = path.slice(prefix.length);
      // Signing in needs no session: the password is the check. Only the browser's own sign-in sets a cookie.
      if(route==='/login'&&req.method==='GET'){
        const status=await lock.status();
        return json(res,200,{state:await sessions.session(req)?'signed_in':status.password_set?'sign_in':'create',paused_until:status.paused_until});
      }
      if(route==='/login'&&req.method==='POST')return passwordAnswer(res,async()=>{
        const {password}=object(await readJson(req,4096));
        const {token:session}=(await lock.status()).password_set?await lock.signIn(password,'browser'):await lock.create(password);
        res.setHeader('set-cookie',sessionCookie(session));return {ok:true};
      });
      // The mini app service signs phones in and checks them here; it holds no credential of its own.
      if(route==='/mini-app/sign-in'&&req.method==='POST')return passwordAnswer(res,async()=>lock.signIn(object(await readJson(req,4096)).password,'phone'));
      if(route==='/mini-app/check'&&req.method==='POST')return json(res,200,{state:await sessions.state(String(object(await readJson(req,4096)).token??''),'phone')});
      if(route==='/mini-app/sign-out'&&req.method==='POST'){await lock.signOut(object(await readJson(req,4096)).token);sessions.forget();return json(res,200,{ok:true});}
      const caller=await authorized(req,route,req.method==='GET' && /^\/(?:artifacts\/[a-f0-9]{64}|exports\/[a-f0-9-]{36})\/download$/.test(route));
      const legacy=caller==='token';
      // Session cookie is accepted only by streaming download routes, never by settings or mutations.
      if(legacy)res.setHeader('set-cookie',`nocheh_download=${token}; HttpOnly; SameSite=Strict; Path=${prefix}/`);
      if (req.method === 'GET' && route === '/health') return json(res, 200, {ok: true});
      if(req.method==='GET'&&route==='/maintenance')return json(res,200,maintenance.state??{ready:false});
      if(maintenance.active&&req.method==='GET'&&(route==='/jobs'||route==='/jobs/'+maintenance.state?.job)){
        const job=activeJobs.get(maintenance.state!.job);
        return json(res,200,route==='/jobs'?(job?[job]:[]):job??{state:'running'});
      }
      if(ownerStoragePath('/v1'+route)&&['GET','POST'].includes(req.method??''))return json(res,200,await python({operation:'knowledge.api',path:'/v1'+route+url.search,
        ...(req.method==='POST'?{body:await readJson(req,8*1024*1024)}:{})}));
      if (req.method === 'GET' && route === '/changes')return live.open(res);
      if (req.method === 'GET' && route === '/monitoring') return json(res,200,await python({operation:'monitoring.status'}));
      if(req.method==='GET'&&route==='/storage')return json(res,200,await python({operation:'storage.report'}));
      if(req.method==='GET'&&route==='/database-browser')return json(res,200,await python({operation:'database.browser',
        request:Object.fromEntries(url.searchParams)}));
      if(req.method==='GET'&&/^\/workflows(?:\/(?:health|metrics|timings(?:\/[a-f0-9]{64})?|[a-f0-9]{64}))?$/.test(route))return json(res,200,await python({operation:'workflow.api',path:'/v1'+route+url.search}));
      if(req.method==='POST'&&route==='/workflows/retry-failed')return json(res,200,await python({operation:'workflow.api',path:'/v1/workflows/retry-failed',body:{}}));
      if(req.method==='POST'&&/^\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(route))return json(res,200,await python({operation:'workflow.api',path:'/v1'+route,body:await readJson(req)}));
      if(route==='/tools/actions' && req.method==='GET')return json(res,200,await python({operation:'tools.manage'}));
      if(/^\/tools\/actions\/[a-f0-9]{64}$/.test(route) && req.method==='GET')return json(res,200,await python({operation:'tools.manage',action:route.slice(7)}));
      if(req.method==='POST' && ['/tools/decide','/tools/telegram-decision','/tools/grant','/tools/revoke'].includes(route))return json(res,200,await python({operation:'tools.manage',action:route.slice(7),request:await readJson(req)}));
      if (req.method === 'GET' && route === '/runtime') return json(res,200,await archive('/v1/runtime'));
      if (req.method==='POST' && route==='/ws-ticket')return json(res,200,{ticket:sessions.ticket(await sessions.authorize(req)),ttl_seconds:30});
      if(['/memory/honcho','/memory/honcho/rebuild','/memory/honcho/retry-failed','/memory/honcho/fresh-start','/memory/spaces','/memory/shares','/memory/shares/revoke','/memory/reviews','/memory/reviews/control','/memory/recall','/memory/preview'].includes(route) && ['GET','POST'].includes(req.method??'')) {
        return json(res,200,await python({operation:'memory.api',path:'/v1'+route+url.search,
          ...(req.method==='POST'?{body:object(await readJson(req))}:{})}));
      }
      if (req.method === 'POST' && route === '/shutdown') {
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        json(res, 200, {ok: true}); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); return;
      }
      if (req.method === 'GET' && route === '/scopes') return json(res,200,await archive('/v1/scopes?after='+encodeURIComponent(url.searchParams.get('after')??'')));
      if (req.method === 'GET' && route === '/telegram/identities') return json(res,200,await python({operation:'telegram.directory'}));
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
        return json(res,202,await startOperation(action,body.options??{},tracked.id));
      });
      if (route === '/policy' && ['GET','POST'].includes(req.method??'')) {
        const body=req.method==='POST'?object(await readJson(req)):{};
        return json(res,200,await python({operation:'policy.manage',request:{...body,profile:url.searchParams.get('profile'),job:url.searchParams.get('job')},write:req.method==='POST'}));
      }
      // The owner's Notion sign-in. Tokens travel only in POST bodies and never come back.
      if(req.method==='GET'&&route==='/connections/notion')return json(res,200,await python({operation:'notion.status'}));
      const notion=route.match(/^\/connections\/notion\/(start|finish|token|disconnect)$/);
      if(req.method==='POST'&&notion)return exclusive('notion-connection',async()=>json(res,200,await python({operation:'notion.'+notion[1],request:object(await readJson(req))})));
      // The mini app's password. The owner sets it here; the mini app service signs in and
      // checks its sessions through the same routes.
      // The owner's password, from a signed-in browser only.
      if(caller!=='phone'&&route==='/owner-lock'&&req.method==='GET')return json(res,200,await lock.status(sessions.token(req)));
      if(caller==='browser'&&route==='/owner-lock/password'&&req.method==='POST')return passwordAnswer(res,async()=>{
        const body=object(await readJson(req,4096));
        const {token:session}=await lock.changePassword(body.current,body.password);
        // The new session has a new CSRF value; the page keeps using it.
        sessions.forget();res.setHeader('set-cookie',sessionCookie(session));return {...await lock.status(session),csrf:csrfFor(session)};
      });
      if(caller==='browser'&&route==='/owner-lock/sign-out-others'&&req.method==='POST'){
        await lock.signOutOthers(sessions.token(req));sessions.forget();return json(res,200,await lock.status(sessions.token(req)));
      }
      if(caller==='browser'&&route==='/logout'&&req.method==='POST'){
        await lock.signOut(sessions.token(req));sessions.forget();res.setHeader('set-cookie',sessionCookie('',0));return json(res,200,{ok:true});
      }
      if (req.method === 'GET' && route === '/settings') {
        // A running apply is named so a page opened or reloaded meanwhile follows it instead of offering Apply again.
        const applying=[...activeJobs.values()].find(job=>job.kind==='settings.apply');
        // A phone reads settings only to know which chat is the owner's own.
        if(caller==='phone')return json(res,200,{fields:((object(await python({operation:'settings.view'})).fields??[]) as {key:string}[]).filter(field=>field.key==='TELEGRAM_OWNER_ID')});
        return json(res, 200, {...object(await python({operation: 'settings.view'})),
          applying:applying?{id:applying.id,step:applying.step??'starting',started_at:applying.created_at}:null});
      }
      // POST so a key being typed travels in the body, never in a URL or access log.
      if (req.method === 'POST' && route === '/settings/provider-models') return json(res, 200, await python({operation: 'settings.provider_models', request: object(await readJson(req))}));
      if (req.method === 'GET' && route === '/honcho/status') return json(res, 200, await python({operation: 'honcho.status'}));
      if (req.method === 'GET' && route === '/usage') return json(res, 200, await python({operation: 'usage.view', days: Number(url.searchParams.get('days') ?? 30)}));
      if (req.method === 'GET' && route === '/honcho/budget') return json(res, 200, await python({operation: 'honcho.budget'}));
      if (req.method === 'POST' && route === '/honcho/budget') return exclusive('honcho-budget',async()=>
        json(res,200,await python({operation:'honcho.budget.update',request:object(await readJson(req))})));
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
      // Role (SOUL.md) and skills of one chat's native profile, or `default` for every chat.
      if (req.method === 'GET' && route === '/memory/persona')
        return json(res,200,await python({operation:'hermes.manage',request:{action:'persona',scope:url.searchParams.get('scope')}}));
      if (req.method === 'POST' && route === '/memory/persona') return exclusive('writer-start',async()=>{
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        const body=object(await readJson(req,1024*1024));
        return json(res,200,await python({operation:'hermes.manage',request:{action:'persona',scope:body.scope,role:body.role,skills:body.skills,revision:body.revision}}));
      });
      if (req.method === 'POST' && route === '/settings') return exclusive('writer-start',async()=>{
        if(operationBusy)throw new HttpError(409,'wait_for_active_jobs');
        const body = object(await readJson(req));
        return json(res, 200, await python({operation: 'settings.save', changes: body.changes, revision: body.revision, rebuild_memory: body.rebuild_memory===true}));
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
          if (req.method === 'PUT' && action === 'upload') return json(res, 200, await upload(req, job, url.searchParams.get('name') ?? '',
            Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('more') === '1'));
          if (req.method === 'POST' && action === 'preview') {
            if (job.state !== 'uploading' && job.state !== 'preview_failed') throw new HttpError(409, 'preview_closed');
            // A preview that can't read the upload says so instead of looking unfinished.
            try {job.preview = object(await python({operation: 'import.inspect', job: id}));}
            catch(error){job.state='preview_failed';job.error=error instanceof HttpError?error.message:'operation_interrupted';await putJob(job);throw error;}
            job.state = 'ready'; delete job.error; await putJob(job); return json(res, 200, job);
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
            const chats=(Array.isArray(job.preview.chats)?job.preview.chats:[]).map(chat=>object(chat));
            const confirmed=object(await python({operation:'workflow.api',path:'/v1/workflows/imports/confirm',body:{id,configuration_hash:importConfiguration(job.preview,mapping,job.review_approved),review_approved:job.review_approved,total:job.preview.messages,completed:job.completed,duplicates:job.duplicates,resume:['failed','cancelled','interrupted'].includes(job.state),
              label:chats.map(chat=>String(chat.name??'')).filter(Boolean).join(', ').slice(0,300),
              scopes:chats.map(chat=>String(mapping[String(chat.id)]??chat.scope??'')).filter(Boolean)}}));
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
    if(process.env.NOCHEH_DEV_WATCH==='1'&&req.method==='GET'&&path==='/__dev/revision') {
      const revision=await readFile(join(ROOT,'dashboard/dist/.dev-revision'),'utf8').catch(()=>'');
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(revision);return;
    }
    if(req.method==='GET'&&path==='/') {
      // Without a signed-in session the same page opens on its sign-in screen, with no CSRF value.
      const session=await sessions.session(req);
      const bootstrap=session?`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`
        :`window.__NOCHEH_LOGIN__=${JSON.stringify((await lock.status()).password_set?'sign_in':'create')};`;
      const reload=process.env.NOCHEH_DEV_WATCH==='1' ? `<script>let nochehRevision;setInterval(async()=>{try{const next=await(await fetch('/__dev/revision',{cache:'no-store'})).text();if(nochehRevision&&next&&next!==nochehRevision){if(window.__nochehUnsaved)return;location.reload()}nochehRevision=next}catch{}},1000)</script>` : '';
      const html=(await readFile(join(ROOT,'dashboard/dist/index.html'),'utf8')).replace('/*NOCHEH_BOOTSTRAP*/',bootstrap).replace('</head>',reload+'</head>');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);return;
    }
    const asset=path.match(/^\/assets\/(app\.js|style\.css|chunks\/[a-zA-Z0-9_-]+\.js)$/);
    if(req.method==='GET'&&asset?.[1]) {
      res.writeHead(200,{'content-type':asset[1].endsWith('.css')?'text/css':'text/javascript','cache-control':'no-cache'});
      createReadStream(join(ROOT,'dashboard/dist',asset[1])).on('error',()=>res.destroy()).pipe(res);return;
    }
    if(path.startsWith('/inngest/')){
      const session=await sessions.authorize(req,req.method!=='GET');
      await proxyOwnerInspection(req,res,Number(archiveConnection.port),string(archiveConnection.token),session.csrf,String(archiveConnection.host??'127.0.0.1'));return;
    }
    if(path.startsWith('/hermes/')) {
      if(req.method==='POST'&&path==='/hermes/api/auth/ws-ticket') {
        // Native's ticket helper uses cookie + Origin, without a custom header.
        if(!req.headers.origin)throw new HttpError(403,'origin_required');
        return json(res,200,{ticket:sessions.ticket(await sessions.authorize(req,false)),ttl_seconds:30});
      }
      const page=req.method==='GET'&&!path.startsWith('/hermes/api/')&&!path.startsWith('/hermes/assets/')&&!path.startsWith('/hermes/dashboard-plugins/');
      const session=page?await sessions.session(req):await sessions.authorize(req,!['GET','HEAD'].includes(req.method??''));
      // A signed-out browser signs in on the dashboard first.
      if(!session){res.writeHead(303,{location:'/'});res.end();return;}
      const connection=object(await python({operation:'native.connection'}));
      proxyNative(req,res,Number(connection.port),string(connection.token),session.csrf,String(connection.host??'127.0.0.1'));return;
    }
    throw new HttpError(404,'not_found');
  })().catch(error => { if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503,
    {error: error instanceof HttpError ? error.code : 'management_unavailable'}); else res.end(); }).finally(async()=>{await responseDone;tracked.finish();}); });
  server.requestTimeout = 120000;
  server.on('upgrade', (req, socket, head) => { void (async()=>{
    try {
      if(maintenance.active)throw new HttpError(503,'installation_maintenance');
      checkOrigin(req);if(!req.headers.origin)throw new HttpError(403,'origin_required');
      const url=new URL(req.url??'','http://local');
      if(!['/hermes/api/pty','/hermes/api/ws','/hermes/api/events'].includes(url.pathname))throw new HttpError(403,'websocket_route_denied');
      await sessions.consume(req,url.searchParams.get('ticket')??'');
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      const connection=object(await python({operation:'native.connection'}));
      if(!socket.destroyed)proxyNativeSocket(req,socket,head,Number(connection.port),string(connection.token),String(connection.host??'127.0.0.1'));
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
  })(); });
  server.listen(PORT, CONTAINER?'0.0.0.0':'127.0.0.1', () => console.log(`Nocheh dashboard: http://127.0.0.1:${PORT}/`));
  let stopping=false;
  // The daily automatic backup goes through the same path as Back up now. A busy dashboard
  // waits for the next check; the schedule records each start, so a failure is not retried
  // until the next day.
  const automaticBackup=async()=>{
    if(stopping||operationBusy||active.size||maintenance.active||locked.has('writer-start'))return;
    if(object(await python({operation:'backups.due'})).due!==true)return;
    await exclusive('writer-start',async()=>{if(!stopping&&!operationBusy&&!active.size)await startOperation('backup',{},Symbol('schedule'),true);});
  };
  const schedule=setInterval(()=>void automaticBackup().catch(()=>{}),5*60*1000);schedule.unref();
  // Every two minutes, new or worse problems go to the owner's private chat. Backups, restores
  // and Apply restart services on purpose, so the check waits until they finish.
  let checkingProblems=false;
  const problemCheck=setInterval(()=>{
    if(stopping||checkingProblems||operationBusy||maintenance.active)return;
    checkingProblems=true;
    void python({operation:'problems.check'}).catch(()=>{}).finally(()=>{checkingProblems=false;});
  },2*60*1000);problemCheck.unref();
  const stop = () => {
    if(stopping)return;stopping=true;clearInterval(schedule);clearInterval(problemCheck);
    live.closeAll();
    for(const socket of sockets)socket.destroy();
    for (const [id,child] of active) if(activeJobs.get(id)?.kind==='import')child.kill('SIGTERM');
    // A partial request or stalled stream must not hold a reload open forever.
    // Closing its transport does not cancel admitted owner writes or lifecycle jobs.
    const admitted=maintenance.drain();
    const drainConnections=setTimeout(()=>server.closeAllConnections(),1000);drainConnections.unref();
    server.close(()=>{clearTimeout(drainConnections);void Promise.allSettled([admitted,...runningTasks]).then(()=>process.exit(0));});
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startManagement();
