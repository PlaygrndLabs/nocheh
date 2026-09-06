import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { authorize, HttpError, json, readJson } from '../src/http.js';

test('authentication precedes parsing and oversized or malformed bodies are rejected', async () => {
  const server = createServer((req, res) => { void (async () => {
    authorize(req, 'test-token-of-at-least-24-characters');
    json(res, 200, await readJson(req, 16));
  })().catch((e: unknown) => json(res, e instanceof HttpError ? e.status : 500, {error: 'rejected'})); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address(); assert(addr && typeof addr === 'object');
  try {
    const url = `http://127.0.0.1:${addr.port}`;
    assert.equal((await fetch(url, {method: 'POST', body: 'not json'})).status, 401);
    const headers = {authorization: 'Bearer test-token-of-at-least-24-characters'};
    assert.equal((await fetch(url, {method: 'POST', headers, body: '"over the size limit"'})).status, 413);
    assert.equal((await fetch(url, {method: 'POST', headers, body: 'not json'})).status, 400);
    assert.deepEqual(await (await fetch(url, {method: 'POST', headers, body: '{"ok":true}'})).json(), {ok: true});
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
