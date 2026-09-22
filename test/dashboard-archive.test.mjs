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
  assert.match(archive,/>Record<\/th><th>Type<\/th><th>Scope<\/th><th>Received<\/th><th>Reply<\/th><th>Agent copy<\/th>/);
  assert.match(archive,/Delivery attempts and receipts are operational records shown in Monitoring/);
  assert.match(archive,/ambiguous:\{label:'Needs review',state:'ambiguous'/);
  assert.match(archive,/<StatusBadge state=\{reply\.state\} label=\{reply\.label\}/);
  assert.match(archive,/View \/ edit/);
  assert.match(archive,/Permanent evidence/);
  assert.match(archive,/Editable and guarded/);
  assert.match(archive,/Used by agents/);
  assert.match(archive,/aria-label=\{selected\?undefined:'Message details'\}/);
  assert.ok(source.indexOf('original,')<source.indexOf('h(GuardedEditor'));
  assert.match(guarded,/Wording for agents/);
  assert.match(guarded,/Saving changes only the agent copy\. The original above remains unchanged\./);
  assert.match(guarded,/expected_revision:source\.active_revision/);
  assert.match(style,/\.archive-table-workspace\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(style,/\.archive-list \.ui-table th:last-child.*position:sticky/);
  assert.match(spec,/searchable, paginated, responsive table/);
  assert.match(spec,/immutable original evidence remains visibly read-only/);
});
