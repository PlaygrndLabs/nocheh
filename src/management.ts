import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, open, stat, unlink, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError, json, object, readJson, string } from './http.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STATE = resolve(process.env.NOCHEH_STATE_DIR ?? join(ROOT, 'data/local'));
const JOBS = join(STATE, 'admin/jobs');
const PORT = Number(process.env.NOCHEH_DASHBOARD_PORT ?? 8783);
const NATIVE = Number(process.env.NOCHEH_DASHBOARD_NATIVE_PORT ?? 8784);
const PREFIX = '/api/plugins/nocheh';
type Job = {id: string; kind: string; state: string; created_at: string; completed: number;
  files: number; bytes: number; duplicates: number; preview?: Record<string, unknown>;
  mapping?: Record<string, unknown>; error?: string; result?: unknown};

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
  try { return JSON.parse(await readFile(join(jobPath(id), 'job.json'), 'utf8')) as Job; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(404, 'job_not_found'); }
}
async function putJob(job: Job) { await atomic(join(jobPath(job.id), 'job.json'), job); }
async function listJobs() {
  const result: Job[] = [];
  for (const id of await readdir(JOBS)) { try { result.push(await getJob(id)); } catch { /* partial creation */ } }
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200);
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
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
      if (code || failure || result === undefined) reject(new HttpError(400, failure ?? 'operation_interrupted'));
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
function launch(job: Job, body: Record<string, unknown>) {
  let writes = Promise.resolve();
  void python(body, value => {
    if (typeof value.completed === 'number') job.completed = value.completed;
    if (typeof value.duplicates === 'number') job.duplicates = value.duplicates;
    const snapshot = {...job}; writes = writes.then(() => putJob(snapshot));
  }, child => active.set(job.id, child)).then(async result => {
    await writes; job.result = result;
    if (job.state !== 'cancelled') job.state = object(result).status === 'apply_failed' ? 'failed' : 'complete';
  }).catch(async error => {
    await writes.catch(() => {});
    if (job.state !== 'cancelled') { job.state = 'failed'; job.error = error instanceof HttpError ? error.code : 'operation_failed'; }
  }).finally(() => { active.delete(job.id); void putJob(job); });
  activeJobs.set(job.id, job);
}
const activeJobs = new Map<string, Job>();

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
  for (const job of await listJobs()) if (['running', 'queued'].includes(job.state)) {
    job.state = 'interrupted'; job.error = 'dashboard_restarted'; await putJob(job);
  }
  function authorized(req: IncomingMessage) {
    const actual = Buffer.from(String(req.headers['x-hermes-session-token'] ?? ''));
    const expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'owner_session_required');
  }
  const server = createServer((req, res) => { void (async () => {
    const authority = `127.0.0.1:${PORT}`;
    if (![authority, `localhost:${PORT}`].includes(req.headers.host ?? '')) throw new HttpError(403, 'invalid_host');
    const origin = req.headers.origin;
    if (origin && ![`http://${authority}`, `http://localhost:${PORT}`].includes(origin)) throw new HttpError(403, 'invalid_origin');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_site_denied');
    const url = new URL(req.url ?? '/', `http://${authority}`), path = url.pathname;
    if (path.startsWith(PREFIX + '/')) {
      authorized(req);
      const route = path.slice(PREFIX.length);
      if (req.method === 'GET' && route === '/health') return json(res, 200, {ok: true});
      if (req.method === 'POST' && route === '/shutdown') {
        json(res, 200, {ok: true}); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); return;
      }
      if (req.method === 'GET' && route === '/settings') return json(res, 200, await python({operation: 'settings.view'}));
      if (req.method === 'POST' && route === '/settings') {
        const body = object(await readJson(req));
        return json(res, 200, await python({operation: 'settings.save', changes: body.changes, revision: body.revision}));
      }
      if (req.method === 'POST' && route === '/settings/apply') {
        if ([...activeJobs.values()].some(j => j.kind !== 'import' && j.state === 'running')) throw new HttpError(409, 'operation_busy');
        const job = await newJob('settings.apply'); job.state = 'running'; await putJob(job);
        launch(job, {operation: 'settings.apply'}); return json(res, 202, job);
      }
      if (req.method === 'GET' && route === '/status') return json(res, 200, await archive('/v1/status'));
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
          if (req.method === 'POST' && action === 'start') {
            if (!job.preview || !['ready', 'failed', 'cancelled', 'interrupted'].includes(job.state) || active.has(id)) throw new HttpError(409, 'job_not_ready');
            const body = object(await readJson(req));
            const mapping = object(body.mapping ?? job.mapping ?? {});
            if (job.mapping && JSON.stringify(mapping) !== JSON.stringify(job.mapping)) throw new HttpError(409, 'resume_scope_cannot_change');
            job.mapping = mapping; job.state = 'running'; delete job.error; await putJob(job);
            launch(job, {operation: 'import.run', job: id, mapping, after: job.completed});
            return json(res, 202, job);
          }
          if (req.method === 'POST' && action === 'cancel') {
            if (job.kind !== 'import' || job.state !== 'running') throw new HttpError(409, 'job_not_cancellable');
            const running = activeJobs.get(id); if (running) running.state = 'cancelled';
            active.get(id)?.kill('SIGTERM'); job.state = 'cancelled'; await putJob(job);
            return json(res, 200, job);
          }
          throw new HttpError(404, 'not_found');
        });
      }
      throw new HttpError(404, 'not_found');
    }
    if (path === '/') { res.writeHead(302, {location: '/nocheh'}); res.end(); return; }
    // Native HTTP shell only. WebSockets and mutation APIs are denied upstream.
    const proxy = httpRequest({hostname: '127.0.0.1', port: NATIVE, path: req.url, method: req.method,
      headers: {...req.headers, host: `127.0.0.1:${NATIVE}`}}, response => {
      res.writeHead(response.statusCode ?? 502, {...response.headers, 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer'}); response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) json(res, 503, {error: 'dashboard_backend_unavailable'}); else res.end(); });
    req.pipe(proxy);
  })().catch(error => { if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503,
    {error: error instanceof HttpError ? error.code : 'management_unavailable'}); else res.end(); }); });
  server.requestTimeout = 120000;
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.listen(PORT, '127.0.0.1', () => console.log(`Nocheh dashboard: http://127.0.0.1:${PORT}/nocheh`));
  const stop = () => { for (const child of active.values()) child.kill('SIGTERM'); server.close(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startManagement();
