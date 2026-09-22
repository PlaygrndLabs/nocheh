import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('archive presents records as a safe editable table',async()=>{
  const [archive,source,style,spec]=await Promise.all([
    readFile('web/pages/archive.tsx','utf8'),
    readFile('web/guarded-editor.js','utf8'),
    readFile('web/style.css','utf8'),
    readFile('SPECS.md','utf8'),
  ]);
  assert.match(archive,/<Table aria-label="Archive records">/);
  assert.match(archive,/>Record<\/th><th>Scope<\/th><th>Received<\/th><th>Guarded<\/th>/);
  assert.match(archive,/View \/ edit/);
  assert.match(archive,/Originals are read-only/);
  assert.match(archive,/Editable guarded copies save as new revisions/);
  assert.match(source,/The original archive is read only/);
  assert.match(source,/expected_revision:source\.active_revision/);
  assert.match(style,/\.archive-list \.ui-table\{min-width:720px\}/);
  assert.match(style,/\.archive-list \.ui-table tr\.selected/);
  assert.match(style,/\.archive-list \.ui-table th:last-child.*position:sticky/);
  assert.match(spec,/searchable, paginated, responsive table/);
  assert.match(spec,/immutable original evidence remains visibly read-only/);
});
