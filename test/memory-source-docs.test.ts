import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';

// The docs of where memory notes come from (ADR-0257) say what the code and the dashboard do; read from the checkout.
const root=new URL('../../',import.meta.url),here=existsSync(new URL('docs/adr/',root));
const read=(path:string)=>readFileSync(new URL(path,root),'utf8');
const plain=(text:string)=>text.replace(/\s+/g,' ');
const skip=here?false:'the docs are not in this checkout';

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

test('the docs say an own forward earlier in a session is skipped only in the owner\'s private chat, with the lines code writes',{skip},()=>{
  // forwardLine (src/forwarded.ts) writes "your own" only in the owner's private chat; a group, or a private answer carried
  // from one, gets "the sender's own" for the owner's forward too, and earlier rows count that one (OWN_FORWARDS, _forwards).
  const own=read('services/hermes/note_sources.py').match(/^OWN_FORWARDS=\('([^']+)',"([^"]+)"\)$/m);
  assert.ok(own,'note_sources.py names both lines');
  const skipped=own[1]!,counted=own[2]!,writer=read('src/forwarded.ts');
  for(const line of [skipped,counted])assert.ok(writer.includes(line.replace(/'/g,'\\\'')),`forwardLine writes ${line}`);
  for(const path of ['docs/adr/0257-learned-memory-names-its-source.md','docs/security-service.md']) {
    const text=plain(read(path));
    const sentence=(line:string)=>{
      const at=text.indexOf(line);assert.ok(at>=0,`${path} quotes ${line}`);
      return text.slice(text.lastIndexOf('. ',at)+2,text.indexOf('. ',at+line.length));
    };
    assert.match(sentence(skipped),/\bonly\b.*private chat|private chat.*\bonly\b/);
    const others=sentence(counted);
    assert.match(others,/\bcounts as a forward read\b/);assert.match(others,/\bgroup\b/);assert.match(others,/private answer/);
  }
});

test('the docs say a message kept out of the owner\'s notes stays out after its sender becomes a member, in member words',{skip},()=>{
  // decide (src/stores/native-review.ts) reads native_review_skips before the sender; step 3 has members, no grants (ADR-0259).
  const sentence=(path:string,words:RegExp)=>{
    const text=plain(read(path)),at=text.search(words);assert.ok(at>=0,`${path} says ${words}`);
    return text.slice(text.lastIndexOf('. ',at)+2,text.indexOf('. ',at));
  };
  for(const [path,words] of [['docs/telegram.md',/stays out even if/],['SPECS.md',/does not add their earlier messages/]] as const) {
    const said=sentence(path,words);
    assert.match(said,/\bmember\b/,`${path}: ${said}`);assert.doesNotMatch(said,/\bgrant|\ballow/i,`${path}: ${said}`);
  }
});
