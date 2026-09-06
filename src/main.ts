import { createServer } from 'node:http';
import { settings } from './config.js';
import { connectDatabase, heartbeat, initialize } from './database.js';
import { authorize, HttpError, json, readJson } from './http.js';
import { archiveStatus, envelope, ingest } from './archive.js';
import { startWorker } from './worker.js';

const config = settings();
// Each service owns its connection pool; an outage must be visible in health.
const pool = connectDatabase(config);
await initialize(pool);
await heartbeat(pool, config.service);
const timer = setInterval(() => { void heartbeat(pool, config.service).catch(() => {}); }, 5000);
timer.unref();
const stopWorker = config.service === 'worker' ? startWorker(pool, config) : () => {};

const server = createServer((req, res) => { void (async () => {
  const path = new URL(req.url ?? '/', 'http://local').pathname;
  if (req.method === 'GET' && path === '/health') {
    await pool.query('SELECT 1');
    return json(res, 200, {ok: true, service: config.service, database: 'ready'});
  }
  authorize(req, config.token);
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
function stop() { clearInterval(timer); stopWorker(); server.close(() => { void pool.end().then(() => process.exit(0)); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
