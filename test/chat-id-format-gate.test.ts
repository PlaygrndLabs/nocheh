import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/*
 * The chat id format gate (ADR-0250). No code outside the Telegram adapter reads a chat value's Telegram shape: no
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
  // Part A: chat records, seeding and the directory
  ['services/telegram/sends.py','A',1,'a send record\'s chat as a Telegram number'],
  ['src/stores/owner-portability.ts','A',1,'an older record\'s topic assignment found by its id'],
  ['src/stores/owner-supervision.ts','A',8,'the conversation directory\'s archive scan and /topic/ SQL; outsiders by shape'],
  ['src/stores/reset-setup.ts','A',3,'reset snapshot: policy ids and tool spaces'],
  ['src/stores/server.ts','A',1,'the outsiders check splits a topic off its group'],
  ['src/stores/telegram-chats.ts','A',3,'refresh observations keyed by raw group ids'],
  ['src/stores/telegram-directory.ts','A',3,'people found by scanning group scopes in the archive'],
  ['src/stores/telegram-topics.ts','A',3,'topic registrations keyed by a -100 id'],
  ['tools/acceptance/reset_configuration.py','A',5,'reset snapshot spaces and topics'],
  // Part B: reads and rules on chat rows
  ['src/assistant-policy.ts','B',1,'outsideChat decides a chat from the scope\'s shape'],
  ['src/observed-source.ts','B',1,'a Desktop export\'s topic read back out of eventSpace'],
  ['src/spaces.ts','B',8,'spaceId, validateSpace, parentSpace, the group patterns, recall and read-set SQL'],
  ['src/stores/access.ts','B',2,'an original\'s space built as chat/topic'],
  ['src/stores/background-jobs.ts','B',1,'the owner\'s chat found by splitting a space'],
  ['src/stores/browser-capture.ts','B',1,'an audience topic split off a space'],
  ['src/stores/browser-delivery.ts','B',1,'an audience topic split off a space'],
  ['src/stores/chat-tools.ts','B',3,'tool switch CHECK, SPACE pattern and topic origin'],
  ['src/stores/knowledge-management.ts','B',2,'a group\'s topics found by prefix'],
  ['src/stores/memory-map.ts','B',3,'topic and parent read from an id'],
  ['src/stores/native-memory.ts','B',1,'split_part on an audience'],
  ['src/stores/policy-schema.ts','B',1,'topic assignments found with LIKE'],
  ['src/stores/private-answers.ts','B',4,'private answer CHECKs and the account pattern'],
  ['src/stores/relationships.ts','B',1,'an observed audience built as chat/topic'],
  ['src/stores/retrieval.ts','B',1,'a reader\'s topic split off its space'],
  ['src/stores/tasks.ts','B',3,'group tasks found by topic prefix'],
  // Part C: turns, sends and the two front doors
  ['services/hermes/managed_async.py','C',1,'a space split to its chat'],
  ['services/hermes/native_admin.py','C',1,'a space split to its chat'],
  ['services/hermes/preference_transfer.py','C',7,'topic and group patterns; owner and groups from env'],
  ['services/hermes/profile_config.py','C',1,'a space split to its chat'],
  ['services/hermes/runtime_profiles.py','C',2,'topic pattern and topic test'],
  ['services/hermes/scopes.py','C',4,'owner, groups and access from env; space built as chat/topic'],
  ['services/telegram/checks.py','C',2,'space built and split as chat/topic'],
  ['services/telegram/gateway.py','C',5,'destination parsing, chat/topic outbound checks, the owner\'s chat taken as the owner id'],
  ['services/telegram/settings.py','C',3,'owner, groups and access from env'],
  ['src/access.ts','C',1,'an answer pass\'s scope must look like a Telegram private chat'],
  ['src/actions.ts','C',1,'a destination must be a Telegram number'],
  ['src/mcp/tools.ts','C',1,'the action_request destination text teaches CHAT_ID/topic/THREAD_ID'],
  ['src/stores/action-commands.ts','C',9,'chat/topic splits and the t.me link'],
  ['src/stores/telegram-actions.ts','C',6,'destination pattern, splits and the destinations note'],
  ['src/stores/telegram-reply.ts','C',1,'a reply\'s topic split off its space'],
  // Part D: dashboard, docs and the full tester
  ['dashboard/lib/chats-model.ts','D',6,'isSpaceId, parentOf, topicNumber, groupSpace and inferKind'],
  ['dashboard/pages/chats/chat-picker.tsx','D',1,'whole groups by topic test'],
  ['dashboard/pages/chats/detail.tsx','D',1,'forum by -100'],
  ['dashboard/pages/chats/project.tsx','D',1,'topic by id'],
  ['dashboard/pages/chats/rule-drawer.tsx','D',1,'groups split off rule sources'],
  ['dashboard/pages/chats/tools.tsx','D',2,'tool origin and parent by id'],
  ['dashboard/pages/inbox/allowed.tsx','D',1,'topic by id'],
  ['dashboard/pages/inbox/shared.ts','D',2,'kind by id'],
  ['dashboard/pages/memory/projects.tsx','D',2,'topic and its group by id'],
  ['dashboard/pages/memory/shared.tsx','D',1,'topic by id'],
  ['dashboard/pages/messages/chat-names.ts','D',2,'kind and topic by id'],
  ['dashboard/pages/settings/tasks.tsx','D',1,'topic by id'],
  ['dashboard/pages/system/sends.tsx','D',1,'a send\'s chat link built as chat/topic'],
  ['dashboard/pages/tasks.tsx','D',1,'topic by id'],
  ['tools/acceptance/product_scenarios.py','D',2,'a topic destination and rule built as chat/topic'],
  ['tools/acceptance/telegram_scenarios.py','D',7,'topic destinations and directory keys built as chat/topic'],
  // The Telegram adapter's legitimate reads of Telegram's own formats
  ['dashboard/lib/chats-model.ts','adapter',1,'validUserId: a Telegram user id typed for group access'],
  ['dashboard/lib/messages-format.ts','adapter',1,'a Desktop export matched to its group by the -100 id'],
  ['services/telegram/gateway.py','adapter',2,'raw Telegram chat, user and message ids at the front door'],
  ['services/telegram/server.py','adapter',1,'a refresh names a raw Telegram chat'],
  ['src/assistant-policy.ts','adapter',3,'TELEGRAM_OWNER_ID, TELEGRAM_GROUP_IDS and group access user ids'],
  ['src/conversation-page.ts','adapter',1,'Telegram ids inside an original\'s payload'],
  ['src/mini-app.ts','adapter',2,'the Telegram user id checked against TELEGRAM_OWNER_ID'],
  ['src/observed-source.ts','adapter',3,'archive intake: Desktop export and live scopes are Telegram ids'],
  ['src/stores/chat-sends.ts','adapter',1,'a send record\'s chat is the app\'s own chat id'],
  ['src/stores/runtime-configuration.ts','adapter',2,'the policy document holds raw Telegram owner and group ids'],
  ['tools/cli/main.py','adapter',1,'configure-telegram owner and group ids'],
  ['tools/operations/archive/telegram_directory.py','adapter',2,'Telegram group and user ids typed by the owner'],
  ['tools/operations/installation/configuration.py','adapter',3,'installer checks of TELEGRAM_OWNER_ID, TELEGRAM_GROUP_IDS and access'],
  ['tools/operations/installation/mini_app.py','adapter',1,'the bot id in the bot token'],
  ['tools/operations/security/group_access.py','adapter',1,'a Telegram user id typed by the owner'],
  ['src/honcho.ts','legacy',1,'legacy layout audience by sign'],
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
