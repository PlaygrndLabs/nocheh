import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export * from './dashboard/lib/system-health.ts'; export * from './dashboard/lib/system-format.ts';",
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {issues, sendIssue, sendSummary, sendReason, sendState, sendWhat} = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

// Storage /v1/status reaches the dashboard whole, under monitoring's archive key.
const row = (state, kind, error_code) => ({
  id: '7',
  at: '2026-01-01T00:00:00.000Z',
  channel: 'telegram',
  kind,
  state,
  error_code,
});
const monitoring = chat_sends => ({archive: {archive: {spool_failures: [], workflows: []}, chat_sends}});
const sends = (extra = {}) => ({
  window_hours: 24,
  sent: 120,
  failed: 2,
  uncertain: 1,
  not_sent: 3,
  problems: 0,
  problem_kinds: {},
  last_problem_at: null,
  latest_problems: [],
  ...extra,
});

test('failed sends to chat apps need a look and open the Problems list', () => {
  const one = issues(
    monitoring(
      sends({problems: 1, problem_kinds: {reply: 1}, latest_problems: [row('failed', 'reply', 'bot_blocked')]}),
    ),
  );
  assert.deepEqual(one, [
    {
      tone: 'bad',
      text: '1 send to chat apps failed in the last day',
      detail: 'Reply: 1',
      link: '#system?view=sends&filter=problems',
      action: 'Review',
    },
  ]);
  const three = sendIssue(
    monitoring(
      sends({
        problems: 3,
        problem_kinds: {reaction: 1, reply: 2},
        latest_problems: [row('uncertain', 'reply', 'timed_out'), row('failed', 'reaction', 'reaction_not_allowed')],
      }),
    ),
  );
  assert.equal(three.text, '3 sends to chat apps failed in the last day');
  assert.equal(three.detail, 'Reaction: 1 · Reply: 2');
});

test('sends that may still have arrived warn instead of failing', () => {
  const item = sendIssue(
    monitoring(
      sends({problems: 2, problem_kinds: {reply: 2}, latest_problems: [row('uncertain', 'reply', 'timed_out')]}),
    ),
  );
  assert.equal(item.tone, 'warn');
});

test('no problem, no answer from storage or an older storage adds nothing', () => {
  // Failed counts may hold expected no-ops (already up to date); only problems count.
  assert.deepEqual(issues(monitoring(sends({failed: 4}))), []);
  assert.deepEqual(issues({archive: {unavailable: true}}), []);
  assert.deepEqual(issues({archive: {archive: {}}}), []);
  assert.equal(sendIssue(null), null);
});

test('the last day reads as one plain line', () => {
  assert.equal(sendSummary(sends()), 'Last day: 120 sent, 2 failed, 1 uncertain, 3 not sent');
});

test('each send reads in plain words, and what storage doesn’t count as a problem never looks like a failure', () => {
  assert.equal(sendWhat({kind: 'reaction', detail: '👀'}), 'Reaction 👀');
  assert.equal(sendWhat({kind: 'reaction', detail: 'clear'}), 'Reaction cleared');
  assert.equal(sendWhat({kind: 'refusal', detail: null}), 'Not-allowed reply');
  assert.deepEqual(sendState({state: 'failed', problem: false}), {label: 'Failed', tone: 'neutral'});
  assert.deepEqual(sendState({state: 'uncertain', problem: false}), {label: 'Uncertain', tone: 'neutral'});
  assert.deepEqual(sendState({state: 'failed', problem: true}), {label: 'Failed', tone: 'bad'});
  assert.deepEqual(sendState({state: 'uncertain', problem: true}), {label: 'Uncertain', tone: 'warn'});
  assert.deepEqual(sendState({state: 'sent', problem: false}), {label: 'Sent', tone: 'good'});
  assert.equal(sendReason({state: 'failed', error_code: 'rate_limited'}), 'Telegram asked to slow down');
  assert.equal(sendReason({state: 'not_sent', error_code: 'rate_limited'}), 'Held back: too many at once');
  assert.equal(sendReason({state: 'failed', error_code: 'something_new'}), 'something_new');
  assert.equal(sendReason({state: 'sent', error_code: null}), '');
  assert.equal(
    sendReason({state: 'failed', error_code: 'formatting_rejected', recovered: true}),
    'Formatting rejected; sent on a retry',
  );
});
