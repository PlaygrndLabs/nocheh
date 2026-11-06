import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  entryPoints: ['dashboard/lib/github.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {copyingRow, offersDisconnect} = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

const copy = {repo: 'example-org/widgets', missing: false};

test('Disconnect stays on offer after a failed Disconnect left copies without a key', () => {
  assert.equal(offersDisconnect({connected: true, reconnect: false, copies: []}), true);
  assert.equal(offersDisconnect({connected: false, reconnect: true, copies: []}), true);
  assert.equal(offersDisconnect({connected: false, reconnect: false, copies: [copy]}), true);
  assert.equal(offersDisconnect({connected: false, reconnect: false, copies: []}), false);
  assert.equal(offersDisconnect({connected: false, reconnect: false, copies: null}), false);
});

test('a running Copy shows in the row of its name in any case, and by the field while it has no row', () => {
  const names = ['example-org/gadgets', 'example-org/widgets'];
  assert.equal(copyingRow('example-org/widgets', names), 'example-org/widgets');
  assert.equal(copyingRow('Example-Org/Widgets', names), 'example-org/widgets');
  assert.equal(copyingRow('example-org/other', names), null);
  assert.equal(copyingRow(null, names), null);
});
