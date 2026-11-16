import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';

// The docs of where memory notes come from (ADR-0257) say what the code and the dashboard do; read from the checkout.
const root=new URL('../../',import.meta.url),here=existsSync(new URL('docs/adr/',root));
const read=(path:string)=>readFileSync(new URL(path,root),'utf8');
const plain=(text:string)=>text.replace(/\s+/g,' ');
const skip=here?false:'the docs are not in this checkout';

test('the task entry for memory sources cites files that exist, and its notices link is the test of those notice lines',{skip},()=>{
  const task=read('TASK.md'),start=task.indexOf('Security fixes: where memory comes from'),end=task.indexOf('\nSecurity fixes, part 2',start);
  assert.ok(start>=0&&end>start,'the entry is found');
  const links=[...task.slice(start,end).matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map(([,label,path])=>({label:label!,path:path!}));
  for(const {path} of links)assert.ok(existsSync(new URL(path,root)),path);
  const notices=links.filter(link=>link.label==='notices');
  assert.deepEqual(notices.map(link=>link.path),['services/hermes/test_monitoring.py']);
  assert.match(read(notices[0]!.path),/note_problems/,'the linked file tests the notes and memory_read notice lines');
});

test('the docs say a message kept out of the owner\'s notes shows its memory step as done, with the dashboard\'s own words',{skip},()=>{
  // The source step completes with the reason (src/stores/workflow-operations.ts); only Nocheh's own cards are skipped.
  const format=read('dashboard/lib/system-format.ts');
  const words=(name:string)=>format.match(new RegExp(`^\\s*${name}: '([^']*)',$`,'m'))?.[1];
  const kept=words('sender_not_allowed'),reaction=words('target_not_allowed');
  assert.ok(kept&&reaction,'the dashboard names both reasons');
  for(const path of ['docs/dashboard.md','docs/adr/0257-learned-memory-names-its-source.md']) {
    const text=plain(read(path)),at=text.indexOf(kept);
    assert.ok(at>=0,`${path} quotes the dashboard's words`);
    assert.ok(text.includes(reaction),`${path} quotes the words for a reaction`);
    const sentence=text.slice(text.lastIndexOf('. ',at)+2,text.indexOf('. ',at+kept.length));
    assert.match(sentence,/Background work/);assert.match(sentence,/\bDone\b/);assert.doesNotMatch(sentence,/skipped/);
  }
});
