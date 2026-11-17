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
const {issues, reason, reasonHeading, sendIssue, sendSummary, sendReason, sendState, sendWhat} = await import(
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

test('files a locked-down reader could not read say why and how to read them again', () => {
  const found = issues({
    reader_problems: [
      {day: '2026-11-14', reader: 'document', label: 'Documents', failure: 'temp_full', failed: 2, ok: 0},
      {day: '2026-11-14', reader: 'voice', label: 'Voice notes', failure: 'read_only', failed: 1, ok: 3},
    ],
  });
  assert.deepEqual(found, [
    {
      tone: 'warn',
      text: 'Documents: 2 files couldn’t be read today',
      detail:
        'Hermes’s temporary space was full. Restarting Hermes empties it. The originals are kept: Make a new version on a message’s page reads one again.',
      link: '#messages',
      action: 'Messages',
    },
    {
      tone: 'warn',
      text: 'Voice notes: 1 recording couldn’t be transcribed today',
      detail:
        'Hermes’s locked-down container refused a file write. The originals are kept: Make a new version on a message’s page transcribes one again.',
      link: '#messages',
      action: 'Messages',
    },
  ]);
});

test('failed attempts at telling where notes came from and memory read in part are counted today', () => {
  const found = issues({
    note_problems: [
      {day: '2026-11-14', kind: 'notes', failed: 3, ok: 9},
      {day: '2026-11-14', kind: 'memory_read', failed: 1, ok: 4},
    ],
  });
  assert.deepEqual(found, [
    {
      tone: 'warn',
      text: 'Telling where notes came from failed 3 times today',
      detail:
        'Notes written while it failed show “Source not recorded” or a less exact source, and replies may have seen “source not available”. The notes themselves are kept.',
      link: '#memory?view=notes',
      action: 'Notes',
    },
    {
      tone: 'warn',
      text: 'Long-term memory couldn’t be read in full 1 time today',
      detail: 'Your forwards and files, or your memory context, were left out; replies used the rest of your memory.',
    },
  ]);
  // Attempts, not notes: one failed lookup while 40 notes were listed is one time.
  assert.equal(
    issues({note_problems: [{day: '2026-11-14', kind: 'notes', failed: 1, ok: 0}]})[0].text,
    'Telling where notes came from failed 1 time today',
  );
});

test('the stores\' label lookups and recall\'s ask of forwards and files are lines of their own', () => {
  // Beside Hermes's own lines, so one side working never hides the other's failure.
  const found = issues({
    note_problems: [
      {day: '2026-11-14', kind: 'notes', failed: 1, ok: 0},
      {day: '2026-11-14', kind: 'note_labels', failed: 2, ok: 7},
      {day: '2026-11-14', kind: 'forwards_read', failed: 1, ok: 0},
    ],
  });
  assert.deepEqual(found, [
    {
      tone: 'warn',
      text: 'Telling where notes came from failed 1 time today',
      detail:
        'Notes written while it failed show “Source not recorded” or a less exact source, and replies may have seen “source not available”. The notes themselves are kept.',
      link: '#memory?view=notes',
      action: 'Notes',
    },
    {
      tone: 'warn',
      text: 'Looking up where notes came from failed 2 times today',
      detail:
        'Recall and the Notes page showed those notes as “source not available right now” or without their chat, and replies may have seen them without their chat. The notes and what was recorded about them are kept.',
      link: '#memory?view=notes',
      action: 'Notes',
    },
    {
      tone: 'warn',
      text: 'Recall couldn’t ask your forwards and files 1 time today',
      detail: 'Recall answered from the rest of your memory.',
    },
  ]);
});

test('a task that ended shows its recorded reason as a note, and only an open one is waiting for something', () => {
  // A memory step that completed without learning Nocheh's own card waits for nothing.
  assert.deepEqual(
    [reasonHeading('completed'), reason('nocheh_message')],
    ['Note', 'Nocheh’s own card, notice or reminder: kept, not learned'],
  );
  for (const state of ['failed', 'skipped', 'cancelled', 'denied']) assert.equal(reasonHeading(state), 'Note', state);
  for (const state of ['queued', 'waiting', 'running', 'retryable_failed', 'ambiguous'])
    assert.equal(reasonHeading(state), 'Waiting for', state);
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

test('a leave Telegram refused is a problem named as the request', () => {
  const item = sendIssue(
    monitoring(sends({problems: 1, problem_kinds: {leave: 1}, latest_problems: [row('failed', 'leave', 'no_permission')]})),
  );
  assert.deepEqual([item.tone, item.text, item.detail], ['bad', '1 send to chat apps failed in the last day', 'Leave a group: 1']);
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
  // A leave is named as the request, so a refused one never reads as done; one that found Nocheh gone says so, in
  // words that also fit a group that was deleted or that removed Nocheh.
  assert.equal(sendWhat({kind: 'leave', detail: null}), 'Leave a group');
  assert.equal(sendReason({state: 'failed', error_code: 'already_left'}), 'Nocheh was no longer in the chat');
  assert.equal(
    sendReason({state: 'failed', error_code: 'formatting_rejected', recovered: true}),
    'Formatting rejected; sent on a retry',
  );
  // A leave the stage settled as left from Telegram's own update was never retried, so it says Nocheh left.
  assert.equal(
    sendReason({state: 'uncertain', kind: 'leave', error_code: 'timed_out', recovered: true}),
    'No answer in time; Nocheh left',
  );
});

test('backups and off-site copies that did not happen need a look and open System › Backups', () => {
  const counts = {
    failed: 0,
    reason: null,
    unreadable: 0,
    skipped_days: 0,
    offsite_failed: 0,
    offsite_reason: null,
    offsite_skipped: 0,
  };
  assert.deepEqual(issues({backups: counts}), []);
  assert.deepEqual(issues({backups: {unavailable: true}}), []);
  const found = issues({
    backups: {
      ...counts,
      failed: 2,
      reason: 'backup_unsupported_link',
      unreadable: 1,
      skipped_days: 1,
      offsite_failed: 1,
      offsite_reason: 'offsite_low_disk',
      offsite_skipped: 3,
    },
  });
  assert.deepEqual(
    found.map(issue => [issue.tone, issue.text, issue.link, issue.action]),
    [
      ['bad', 'The last 2 backups didn’t finish', '#system?view=backups', 'Backups'],
      ['warn', 'The newest backup left out 1 file or folder', '#system?view=backups', 'Backups'],
      ['warn', 'The automatic backup was skipped', '#system?view=backups', 'Backups'],
      ['bad', 'The off-site copy failed', '#system?view=backups', 'Backups'],
      ['warn', 'Off-site copies of 3 backups were skipped', '#system?view=backups', 'Backups'],
    ],
  );
  assert.match(found[0].detail, /^A file link outside a command workspace stopped the backup\..* Older backups are kept\.$/);
  assert.equal(found[3].detail, 'Not enough free disk space to make the encrypted copy. Free some space, then try again.');
});
