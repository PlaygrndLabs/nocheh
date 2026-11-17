import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/*
 * The chat id format gate (ADR-0252). No code outside the Telegram adapter reads a chat value's Telegram shape: no
 * '/topic/' string handling, no -100 prefix, and no negative or positive Telegram-number pattern, in TypeScript, the
 * dashboard or Python. Code asks the chat directory (src/chats.ts) instead. The allowlist below started with every
 * site there was when step 2b began; each part deletes (or lowers) its own entries as it removes its sites, and a file
 * may never have more matching lines than its entries allow, nor fewer: lower your entry when you remove a site.
 *
 * Owners: A, B, C and D are the step 2b-1 parts. 'adapter' sites read Telegram's own formats where they legitimately
 * arrive (Telegram account ids, env values that are raw Telegram ids by definition, archive originals, the Telegram
 * front door); they stay. 'legacy' is code of the old storage layout, which refuses to start; its removal is a
 * separate cleanup. 'unrelated' matches a number that is not a chat value at all.
 */
type Owner='A'|'B'|'C'|'D'|'adapter'|'legacy'|'unrelated';
/** [file, owner, matching lines, what they are]. One entry per file and owner, so each part edits only its own lines. */
const allowlist:readonly (readonly [string,Owner,number,string])[]=[
  // Part A: chat records, seeding and the directory. Every site is gone: the conversation directory, people, refresh,
  // topics, send records, owner records and reset snapshots read chats rows (src/stores/chats.ts).
  // Part B: reads and rules on chat rows. Every site is gone: spaces, recall, read sets, tool switches, private answers,
  // tasks, memory and archive reads ask the chat directory (src/chats.ts).
  // Part C: turns, sends and the two front doors. Every site is gone: passes, dispatch, destinations, runtime profiles and
  // the two Python services ask the chat directory or the served list (src/frontdoor/telegram.ts, services/chats.py).
  // Part D: dashboard, docs and the full tester. Every site is gone: pages read the directory fields on /v1/conversations
  // (dashboard/lib/chats-model.ts), and the tester finds chats by their Telegram ids.
  // The Telegram adapter's legitimate reads of Telegram's own formats
  ['dashboard/lib/chats-model.ts','adapter',1,'validUserId: a Telegram user id typed for group access'],
  ['dashboard/lib/messages-format.ts','adapter',1,'a Desktop export matched to its group by the -100 id'],
  ['services/telegram/gateway.py','adapter',2,'raw Telegram chat, user and message ids at the front door'],
  ['services/telegram/server.py','adapter',1,'a refresh names a raw Telegram chat'],
  ['src/assistant-policy.ts','adapter',1,'TELEGRAM_OWNER_ID'],
  ['src/conversation-page.ts','adapter',1,'Telegram ids inside an original\'s payload'],
  ['src/mini-app.ts','adapter',2,'the Telegram user id checked against TELEGRAM_OWNER_ID'],
  ['src/observed-source.ts','adapter',3,'archive intake: Desktop export and live scopes are Telegram ids'],
  ['src/owner-lock.ts','adapter',1,'a phone\'s sign-in pauses are kept under its Telegram account id'],
  ['src/stores/chat-sends.ts','adapter',1,'a send record\'s chat is the app\'s own chat id'],
  ['src/stores/runtime-configuration.ts','adapter',1,'the policy document holds the raw Telegram owner id'],
  ['tools/cli/main.py','adapter',1,'configure-telegram owner id'],
  ['tools/operations/archive/telegram_directory.py','adapter',2,'Telegram group and user ids typed by the owner'],
  ['tools/operations/installation/configuration.py','adapter',1,'installer check of TELEGRAM_OWNER_ID'],
  ['tools/operations/installation/mini_app.py','adapter',1,'the bot id in the bot token'],
  ['services/hermes/preference_transfer.py','legacy',1,'a legacy-layout reset, or a preferences snapshot from before step 2b: its topic spaces read once'],
  ['src/honcho.ts','legacy',1,'legacy layout audience by sign'],
  ['tools/acceptance/reset_configuration.py','legacy',1,'chat values of the legacy layout, read once to convert them'],
  ['tools/operations/installation/store_recovery.py','unrelated',1,'a PostgreSQL sequence value'],
];
/** Whole files that are the adapter: Telegram's formats live here. */
const adapterFiles=new Set(['src/chats-telegram.ts']);

/** Each pattern is a way code has read a chat value's Telegram shape. */
const patterns:Record<string,RegExp>={
  topic:/\\?\/topic\\?\/(?!\.test\()/,
  prefix:/['"`]-100['"`]|\^-100|-100\[|-100\\d|-100\(/,
  negative:/\^\(?-(?:\?|\\d|\[1-9\]|\[0-9\])|\br['"]\(?-(?:\?|\\d|\[1-9\]|\[0-9\])|startsWith\(\s*['"]-['"]\s*\)/,
  positive:/\[1-9\](?:\\d|\[0-9\])(?:\{0,18\}|\*)/,
};
const roots:readonly (readonly [string,readonly string[]])[]=[['src',['.ts']],['dashboard',['.ts','.tsx']],['services',['.py']],['tools',['.py','.mjs']]];
const skipped=new Set(['node_modules','dist','__pycache__']);
const root=fileURLToPath(new URL('../..',import.meta.url));

function* sources(dir:string,extensions:readonly string[]):Generator<string> {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    if(skipped.has(entry.name))continue;
    const path=join(dir,entry.name);
    if(entry.isDirectory())yield* sources(path,extensions);
    // Python tests are fixtures of their own: they may write any Telegram value.
    else if(extensions.some(extension=>entry.name.endsWith(extension))&&!entry.name.startsWith('test_'))yield relative(root,path).split('\\').join('/');
  }
}

function formatSites():Map<string,{line:number;text:string}[]> {
  const found=new Map<string,{line:number;text:string}[]>();
  for(const [top,extensions] of roots) {
    if(!existsSync(join(root,top)))continue;
    for(const file of sources(join(root,top),extensions)) {
      if(adapterFiles.has(file))continue;
      const lines=readFileSync(join(root,file),'utf8').split('\n');
      lines.forEach((text,index)=>{if(Object.values(patterns).some(pattern=>pattern.test(text)))found.set(file,[...found.get(file)??[],{line:index+1,text:text.trim().slice(0,160)}]);});
    }
  }
  return found;
}

test('no code outside the Telegram adapter reads a chat id\'s Telegram shape, beyond the sites each part still owns',()=>{
  const allowed=new Map<string,number>(),problems:string[]=[];
  for(const [file,owner,count] of allowlist) {
    assert.ok(count>0&&Number.isSafeInteger(count),`${file} (${owner}): an entry with no sites goes; delete it`);
    allowed.set(file,(allowed.get(file)??0)+count);
  }
  const keys=allowlist.map(([file,owner])=>file+'|'+owner);
  assert.equal(new Set(keys).size,keys.length,'one entry per file and owner');
  const found=formatSites(),scanned=(file:string)=>existsSync(join(root,file.split('/')[0]!));
  for(const [file,sites] of found) {
    const limit=allowed.get(file)??0;
    if(sites.length>limit)problems.push(`${file} reads a chat id's shape at ${sites.length} lines, ${limit} allowed. Ask the chat directory (src/chats.ts) `+
      `instead, or keep Telegram formats in src/chats-telegram.ts:\n`+sites.map(site=>`  ${file}:${site.line}  ${site.text}`).join('\n'));
  }
  for(const [file,limit] of allowed) {
    if(!scanned(file))continue;
    if(!existsSync(join(root,file)))problems.push(`${file} is gone: delete its allowlist entries`);
    else if((found.get(file)?.length??0)<limit)problems.push(`${file} has ${found.get(file)?.length??0} matching lines, its entries allow ${limit}: lower or delete your part's entry`);
  }
  assert.deepEqual(problems,[]);
});

test('the gate\'s patterns catch every way a chat id\'s shape has been read, and nothing else',()=>{
  const hit=(text:string)=>Object.values(patterns).some(pattern=>pattern.test(text));
  for(const line of [
    `space.split('/topic/')[0]`,`starts_with(group_id,$1||'/topic/')`,String.raw`/^-?[1-9]\d{0,18}(\/topic\/[1-9]\d{0,15})?$/`,
    `'-100'+match[1]`,`/^-100/.test(space)`,String.raw`/^-100([1-9][0-9]{0,15})$/`,`space.startsWith('-')`,String.raw`/^-?\d+$/.test(scope)`,
    String.raw`re.fullmatch(r'-\d{1,19}', g)`,String.raw`re.fullmatch(r'(-?[1-9]\d{0,18})(?:/topic/([1-9]\d{0,15}))?', x)`,
    String.raw`re.fullmatch(r'[1-9]\d{0,18}', owner)`,`scope ~ '^-?[1-9][0-9]{0,18}$'`,String.raw`/^[1-9]\d*$/.test(r.topic)`,
  ])assert.ok(hit(line),line);
  for(const line of [
    `if (/topic/.test(code) && /invalid/.test(code))`,`.replace(/^-+|-+$/g, '')`,`FRONTMATTER = re.compile(r'^---\\n(.*?)$')`,
    `rows.slice(-100)`,String.raw`before&&!/^[1-9][0-9]{0,15}$/.test(before)`,`scope='-10042'`,`a.startswith('-')`,`chats().isGroup(space)`,
  ])assert.ok(!hit(line),line);
});
