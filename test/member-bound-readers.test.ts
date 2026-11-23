import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundReaderReadOnly,type Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {assertPrivateAnswerRoute,boundReaderTools,privateAnswerRoute,privateAnswerTools} from '../src/stores/private-answers.js';
import {ownerRecallAllowed} from '../src/stores/recall-places.js';
import {boundChat} from '../src/stores/access.js';
import {memberAskReads,memberReads} from '../src/stores/member-reads.js';
import {sourceTag,type TagSource} from '../src/source-tags.js';
import {readSet,readSetGroups} from '../src/spaces.js';
import {chats} from '../src/chats.js';
import {servicesFile} from './services-file.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP_GROUP_IDS,MEMBER_GP_CHAT,MEMBER_NG_CHAT,NG1,NG1_TOPIC,NG_GROUP_IDS,OWNER,UNSERVED,fixtureDirectory,groupsPolicy} from './fixture-groups.js';

// Step 4 (ADR-0262): every check that holds for any bound reader asks boundReader, never the answer claim alone (D2);
// the bound readers' route and tool allowlists; the owner's recall allowlist (D7). Both fixture families.
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
installChatsForTest(fixtureDirectory(served));

/** Every TypeScript file under src, by its path from the repository root. */
function sources():string[] {
  const root=servicesFile('src'),found:string[]=[];
  const walk=(dir:string)=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else if(name.endsWith('.ts'))found.push(path);}};
  walk(root);return found.map(path=>'src/'+relative(root,path).split('\\').join('/')).sort();
}

/**
 * The answer-only sites (D2): checks about the "Answer privately" record itself, which no member or ask reader has. Each
 * is pinned by its file and a piece of its line. Every other `answer!==undefined` or `answer===undefined` in src fails:
 * a check that holds for any bound reader asks boundReader instead.
 */
const answerOnly:readonly [string,string][]=[
  // The claim's own parse, and boundReader itself.
  ['src/access.ts',"if(principal.answer!==undefined)return 'answer';"],
  ['src/access.ts','if(claims.answer!==undefined&&(prefix!==\'turn\''],
  ['src/access.ts','...(claims.answer===undefined?{}:{answer:claims.answer as string})'],
  // The answer's pass (audience.ts signs the answer claim and its project).
  ['src/stores/audience.ts',"if(answer!==undefined&&(!principal.reads"],
  ['src/stores/audience.ts','const project=answer!==undefined?'],
  ['src/stores/audience.ts','...(answer!==undefined?{answer}:{})'],
  // The answer's own runtime profile key.
  ['src/stores/runtime-profile.ts',"...(principal.answer!==undefined?['answer:'+principal.answer]:[])"],
  // The answer record's bookkeeping in dispatch.
  ['src/stores/telegram-dispatch.ts','else if(input.principal.answer!==undefined)await this.answers?.answered('],
  ['src/stores/telegram-dispatch.ts','if(principal.answer===undefined){if(principal.scope!==null)await this.answers.unshown(event);return;}'],
  ['src/stores/telegram-dispatch.ts',"input.principal.answer!==undefined?'private_answer':'reply'"],
  ['src/stores/telegram-dispatch.ts','input.principal.scope===null||input.principal.answer!==undefined||!space'],
  // The answer's own binder (bindReads hands it only an answer reader).
  ['src/stores/private-answers.ts','if(principal.answer===undefined)return principal;'],
];

test('only the answer-only sites ask the answer claim; every other bound-reader check asks boundReader (D2)',()=>{
  const found:[string,string][]=[];
  for(const file of sources())for(const line of readFileSync(servicesFile(file),'utf8').split('\n'))
    if(/answer[!=]==undefined/.test(line))found.push([file,line]);
  const matches=(sites:readonly [string,string][],[file,line]:[string,string])=>sites.some(([at,piece])=>at===file&&line.includes(piece));
  const stray=found.filter(site=>!matches(answerOnly,site));
  assert.deepEqual(stray.map(([file,line])=>file+': '+line.trim()),[],'a site that must ask boundReader still asks the answer claim');
  // Each answer-only site is still there, so the list cannot go stale unnoticed.
  for(const [file,piece] of answerOnly)assert.ok(found.some(([at,line])=>at===file&&line.includes(piece)),`${file}: ${piece}`);
  // The sites this part swept ask boundReader now.
  for(const file of ['src/security/broker.ts','src/stores/server.ts','src/mcp/server.ts','src/stores/access.ts','src/stores/retrieval.ts','src/stores/learned.ts',
    'src/stores/entities.ts','src/stores/services.ts','src/stores/native-memory.ts','src/stores/memory-access.ts','src/stores/source-tags.ts'])
    assert.match(readFileSync(servicesFile(file),'utf8'),/boundReader\(/,file);
});

const member=(chat:string,fields:Partial<Reader>={}):Reader=>({scope:chat,space:chat,admin:false,turnEvent:'e'.repeat(64),revision:1,member:'d'.repeat(64),...fields});
const ask=(fields:Partial<Reader>={}):Reader=>({scope:OWNER,space:OWNER,admin:false,turnEvent:'e'.repeat(64),revision:1,memberRead:'c'.repeat(32),...fields});
const answer=(fields:Partial<Reader>={}):Reader=>({scope:OWNER,space:OWNER,admin:false,turnEvent:'e'.repeat(64),revision:1,answer:'a'.repeat(32),...fields});

test('each bound reader reaches only its own read routes, refused with its own code',()=>{
  const reads=['/v1/search','/v1/archive/page','/v1/events/'+'a'.repeat(64),'/v1/artifacts/'+'a'.repeat(64)+'/bytes','/v1/memory/check','/v1/security/binding',
    '/v1/turn-files/'+'a'.repeat(64)];
  for(const path of reads)for(const kind of ['answer','member','memberRead'] as const)assert.ok(privateAnswerRoute('GET',path,kind),kind+' '+path);
  for(const kind of ['answer','member','memberRead'] as const)for(const path of ['/mcp','/v1/context/prepare','/v1/guard','/v1/chat/completions','/anthropic/v1/messages'])
    assert.ok(privateAnswerRoute('POST',path,kind),kind+' '+path);
  // A member's private chat: an answer's reads, its task list and read, Honcho search; no shared or approved context
  // by id, and no write.
  for(const path of ['/v1/owner/tasks','/v1/owner/tasks/'+'b'.repeat(64),'/v1/imports/pending','/v1/memory/context'])assert.ok(privateAnswerRoute('GET',path,'member'),path);
  for(const path of ['/v1/memory/longterm/search','/v1/memory/longterm/context'])assert.ok(privateAnswerRoute('POST',path,'member'),path);
  // Its projects' Notion and GitHub (ADR-0278): their lists, a lookup and its result; the store refuses all but reads with no card.
  for(const path of ['/v1/notion/connections','/v1/github/repos','/v1/tools/actions/'+'b'.repeat(64)])assert.ok(privateAnswerRoute('GET',path,'member'),path);
  assert.ok(privateAnswerRoute('POST','/v1/tools/propose','member'));
  assert.ok(privateAnswerRoute('POST','/v1/schedules/time-zone','member'),'its own time zone (members\' time zones)');
  for(const kind of ['answer','memberRead'] as const)assert.equal(privateAnswerRoute('POST','/v1/schedules/time-zone',kind),false,kind);
  for(const kind of ['answer','memberRead'] as const)for(const [method,path] of [['GET','/v1/notion/connections'],['GET','/v1/github/repos'],
    ['GET','/v1/tools/actions/'+'b'.repeat(64)],['POST','/v1/tools/propose']] as const)assert.equal(privateAnswerRoute(method,path,kind),false,kind+' '+path);
  for(const [method,path] of [['GET','/v1/tools/actions'],['POST','/v1/tools/decide'],['GET','/v1/notion/connections/x']] as const)
    assert.equal(privateAnswerRoute(method,path,'member'),false,method+' '+path);
  for(const path of ['/v1/memory/shared/'+'b'.repeat(64),'/v1/memory/filtered/'+'b'.repeat(64),'/v1/memory/grants/'+'b'.repeat(64),'/v1/memory/recall'])
    assert.equal(privateAnswerRoute('GET',path,'member'),false,path);
  for(const [method,path] of [['POST','/v1/owner/tasks'],['POST','/v1/owner/tasks/'+'b'.repeat(64)],['POST','/v1/memory/recall'],['POST','/v1/memory/longterm/recall'],
    ['POST','/v1/action-requests'],['POST','/v1/jobs/start'],['POST','/v1/knowledge/proposals'],['POST','/v1/telegram/send'],['GET','/v1/data'],
    ['GET','/v1/memory/facts/'+'b'.repeat(64)],['GET','/v1/memory/facts/'+'b'.repeat(64)+'/3']] as const)
    for(const kind of ['answer','member','memberRead'] as const)assert.equal(privateAnswerRoute(method,path,kind),false,kind+' '+method+' '+path);
  // The owner's ask about a member: the archive only; no tasks, no long-term memory, no imports, no context.
  for(const [method,path] of [['GET','/v1/owner/tasks'],['GET','/v1/imports/pending'],['GET','/v1/memory/context'],['POST','/v1/memory/longterm/search'],
    ['POST','/v1/memory/longterm/context']] as const)assert.equal(privateAnswerRoute(method,path,'memberRead'),false,method+' '+path);
  // The answer's list stays as ADR-0249 made it.
  assert.ok(privateAnswerRoute('GET','/v1/memory/shared/'+'b'.repeat(64)));
  assert.throws(()=>assertPrivateAnswerRoute(member(MEMBER_GP_CHAT),'POST','/v1/owner/tasks'),{status:403,code:boundReaderReadOnly.member});
  assert.throws(()=>assertPrivateAnswerRoute(ask(),'GET','/v1/owner/tasks'),{status:403,code:'member_private_read_only'});
  assert.throws(()=>assertPrivateAnswerRoute(answer(),'POST','/v1/owner/tasks'),{status:403,code:'private_answer_read_only'});
  assert.doesNotThrow(()=>assertPrivateAnswerRoute({scope:GP1,space:GP1,admin:false},'POST','/v1/owner/tasks'));
});

test('a member reads with the read tools, tasks and its projects\' Notion and GitHub; the owner\'s ask reads the archive alone; no notes or memory tool',()=>{
  assert.equal(boundReaderTools.answer,privateAnswerTools);
  assert.deepEqual([...boundReaderTools.member].sort(),['action_status','archive_page','archive_read','archive_search','github','memory_search','my_time_zone','notion','tasks']);
  assert.deepEqual([...boundReaderTools.memberRead].sort(),['archive_page','archive_read','archive_search']);
  for(const set of Object.values(boundReaderTools))for(const tool of ['notes','memory','knowledge','telegram','jobs','browser','web_search'])assert.equal(set.has(tool),false,tool);
});

test('only a member reader or an ask reader has a bound chat, and only once it is bound',()=>{
  assert.equal(boundChat(member(MEMBER_GP_CHAT)),null,'not bound yet');
  assert.equal(boundChat(member(MEMBER_GP_CHAT,{memberChat:MEMBER_GP_CHAT})),MEMBER_GP_CHAT);
  assert.equal(boundChat(ask({memberChat:MEMBER_NG_CHAT})),MEMBER_NG_CHAT);
  // A memberChat on any other reader is no binding: only bindReads sets one, and only for these two.
  assert.equal(boundChat(answer({memberChat:MEMBER_GP_CHAT})),null);
  assert.equal(boundChat({scope:GP1,space:GP1,admin:false,memberChat:MEMBER_GP_CHAT}),null);
  assert.equal(boundChat({scope:null,admin:false,memberChat:MEMBER_GP_CHAT}),null);
});

test('member reads close without a query for a chat that is not another person\'s private chat, and for a missing owner chat',async()=>{
  const db={query:async()=>{throw Error('no query for these');}} as never;
  for(const chat of [OWNER,GP1,GP1_TOPIC,NG1,NG1_TOPIC,UNSERVED,''])assert.equal(await memberReads(db,chat,OWNER),null,chat);
  assert.equal(await memberReads(db,MEMBER_GP_CHAT,null),null,'no owner chat: closed');
  for(const id of ['','c'.repeat(31),'C'.repeat(32)])assert.equal(await memberAskReads(db,id,OWNER),null,id);
  assert.equal(await memberAskReads(db,'c'.repeat(32),null),null);
});

test('an owner turn recalls notes only of the owner\'s chat and the served groups, with their topics (D7)',()=>{
  const allowed=ownerRecallAllowed(groupsPolicy({group_ids:served})).spaces;
  assert.ok(allowed.includes(OWNER));
  for(const chat of [GP1,GP1_TOPIC,NG1,NG1_TOPIC])assert.ok(allowed.includes(chat),chat);
  for(const chat of [MEMBER_GP_CHAT,MEMBER_NG_CHAT,BOB_CHAT,UNSERVED])assert.equal(allowed.includes(chat),false,chat);
  assert.deepEqual(allowed,[...allowed].sort());
  assert.deepEqual(ownerRecallAllowed({owner_id:null,owner_chat:null}).spaces.filter(chat=>chats().kind(chat)==='private'),[]);
});

test('a member\'s reads never hold a private chat: readSet drops every one (D3)',()=>{
  const set=readSet({home:MEMBER_GP_CHAT,whole:[GP1,GP2,MEMBER_GP_CHAT,MEMBER_NG_CHAT,OWNER,BOB_CHAT],exact:[MEMBER_NG_CHAT,OWNER]});
  assert.deepEqual(readSetGroups(set),[GP1,GP2].sort());
  assert.equal(set.home,MEMBER_GP_CHAT,'home names the reader and grants nothing');
  void GP3;
});

test('the owner\'s ask about a member names that member\'s chat by its name; no one else does',()=>{
  const chat=MEMBER_GP_CHAT,title=chats().get(chat)?.title??'';
  assert.ok(title,'the fixture chat has a name');
  const source:TagSource={id:'f'.repeat(64),class:'person_message',facts:{author:'person',act:'message'} as never,sender:{name:null,username:null},forward:null,file_name:null,saved:null,
    chat,web:false,exported:false,moment:null,at:null};
  const named=sourceTag(source,{owner:false,chat:OWNER,zone:'UTC',precision:'minute',member_chat:chat},new Map(),chats()).tag;
  assert.match(named,new RegExp(`“${title}”'s private chat`));
  const other=sourceTag(source,{owner:false,chat:GP1,zone:'UTC',precision:'minute'},new Map(),chats()).tag;
  assert.doesNotMatch(other,new RegExp(title));
});
