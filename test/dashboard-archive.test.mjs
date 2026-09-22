import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('archive presents one accessible original-to-agent-copy workflow',async()=>{
  const [archive,source,guarded,controls,style]=await Promise.all([
    readFile('web/pages/archive.tsx','utf8'),
    readFile('web/pages/source.js','utf8'),
    readFile('web/guarded-editor.js','utf8'),
    readFile('web/lib/owner-controls.tsx','utf8'),
    readFile('web/style.css','utf8'),
  ]);
  assert.match(archive,/CursorButtons/);
  assert.doesNotMatch(archive,/Previous records|Next records|Inspect source/);
  assert.match(controls,/if\(pages\.length===1&&!next\)return null/);
  assert.match(archive,/button type="button"[^>]*className=\{'archive-result'/);
  assert.match(archive,/Permanent evidence/);
  assert.match(archive,/Editable and guarded/);
  assert.match(archive,/Used by agents/);
  assert.match(archive,/aria-label=\{selected\?undefined:'Message details'\}/);
  assert.ok(source.indexOf("original,")<source.indexOf("h(GuardedEditor"));
  assert.match(guarded,/Wording for agents/);
  assert.match(guarded,/Saving changes only the agent copy\. The original above remains unchanged\./);
  assert.match(style,/button\.archive-result/);
  assert.match(style,/\.archive-flow\{/);
  assert.match(style,/@media\(max-width:767px\)\{\.archive-workspace\{grid-template-columns:1fr\}/);
});
