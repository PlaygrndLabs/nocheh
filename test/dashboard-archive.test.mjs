import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('archive presents one accessible table-to-agent-copy workflow',async()=>{
  const [archive,source,guarded,controls,style,spec]=await Promise.all([
    readFile('web/pages/archive.tsx','utf8'),
    readFile('web/pages/source.js','utf8'),
    readFile('web/guarded-editor.js','utf8'),
    readFile('web/lib/owner-controls.tsx','utf8'),
    readFile('web/style.css','utf8'),
    readFile('SPECS.md','utf8'),
  ]);
  assert.match(archive,/CursorButtons/);
  assert.doesNotMatch(archive,/Previous records|Next records|Inspect source/);
  assert.match(controls,/if\(pages\.length===1&&!next\)return null/);
  assert.match(archive,/<Table aria-label="Archive records">/);
  assert.match(archive,/>Message<\/th><th>Status<\/th><th>Received<\/th>/);
  assert.match(archive,/Agent copy \{ready\?/);
  assert.match(archive,/archive-linked-reply/);
  assert.match(archive,/Assistant replied/);
  assert.match(archive,/Transcript · generated/);
  assert.ok(archive.indexOf('archive-transcript-preview')<archive.indexOf('archive-linked-replies" aria-label="Delivered replies"'));
  assert.match(archive,/In response to:/);
  assert.match(archive,/label:'Delivered'/);
  assert.match(archive,/Operational attempts and receipts stay in Monitoring/);
  assert.match(archive,/All source records/);
  assert.match(archive,/Conversation<select/);
  assert.match(archive,/Reply and action status<select/);
  assert.match(archive,/new URLSearchParams/);
  assert.match(archive,/kind:direction/);
  assert.match(archive,/reply:replyFilter/);
  assert.match(archive,/failed:\{label:'Retry scheduled',state:'retryable_failed',note:'Inngest will retry'/);
  assert.match(archive,/ambiguous:\{label:'Delivery uncertain',state:'ambiguous',note:'Not auto-retried'/);
  assert.match(archive,/<StatusBadge state=\{reply\.state\} label=\{reply\.label\}/);
  assert.match(archive,/>Open<\/Button>/);
  assert.doesNotMatch(archive,/Needs review|Review and control|View \/ edit/);
  assert.match(source,/Permanent · read only/);
  assert.match(source,/Advanced details and export/);
  assert.match(source,/Retire this message',change,busy/);
  assert.doesNotMatch(source,/Confirm retirement|setConfirm/);
  assert.match(source,/Change was not saved:/);
  assert.match(source,/saved\.revision>resource\.data\.revision/);
  assert.match(guarded,/What agents can use/);
  assert.match(guarded,/Advanced agent-copy fields/);
  assert.match(archive,/aria-label=\{selected\?undefined:'Message details'\}/);
  assert.ok(source.indexOf('original,')<source.indexOf('h(GuardedEditor'));
  assert.match(guarded,/Wording for agents/);
  assert.match(guarded,/Saving changes only the agent copy\. The original above remains unchanged\./);
  assert.match(guarded,/expected_revision:source\.active_revision/);
  assert.match(style,/\.archive-table-workspace\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(style,/\.archive-list \.ui-table th:last-child.*position:sticky/);
  assert.match(spec,/searchable, paginated, responsive table/);
  assert.match(spec,/Visible filters let the owner narrow/);
  assert.match(spec,/delivery uncertain and explicitly not auto-retried/);
  assert.match(spec,/immutable original evidence remains visibly read-only/);
});
