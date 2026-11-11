import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telegramAdapter} from '../src/frontdoor/telegram.js';
import {hermesAdapter} from '../src/hermes-adapter.js';
import {combinedAdapter,runtimeCall} from '../src/runtime.js';
import {addressed,groupReplies,groupTurn,identityCache} from '../src/telegram-addressing.js';
import {deliveredReceipt,deliveryId,replyTarget,unansweredFinish} from '../src/stores/telegram-reply.js';
import {digest} from '../src/archive.js';

type Seen={url:string;method:string;auth:string|undefined;body:unknown};
function recorder(answer:(seen:Seen)=>Response) {
  const seen:Seen[]=[];
  const fetch=(async(url:URL|string,init?:RequestInit)=>{
    const request={url:String(url),method:String(init?.method),auth:(init?.headers as Record<string,string>|undefined)?.authorization,body:init?.body?JSON.parse(String(init.body)):null};
    seen.push(request);return answer(request);
  }) as typeof globalThis.fetch;
  return {seen,fetch};
}

test('Telegram calls go to Nocheh\'s own bot, the other helper services to Hermes',async()=>{
  const bot=recorder(()=>Response.json({state:'done'})),hermes=recorder(()=>Response.json({literals:[]}));
  const call=runtimeCall(combinedAdapter(telegramAdapter({url:'http://bot.invalid',token:'service',fetch:bot.fetch}),
    hermesAdapter({url:'http://hermes.invalid',token:'service',fetch:hermes.fetch})));
  for(const operation of ['telegram.chat','telegram.approval','telegram.refusal','telegram.notice','telegram.identity','telegram.presence','telegram.reply','action.execute','source.file'] as const)
    await call(operation,{id:'x'});
  await call('guard.detect',{text:'x'});await call('telegram.status',{});
  assert.deepEqual(bot.seen.map(row=>new URL(row.url).pathname),['/internal/telegram/chat','/internal/telegram/approval','/internal/telegram/refusal',
    '/internal/telegram/notice','/internal/telegram/identity','/internal/telegram/presence','/internal/telegram/reply','/internal/telegram/action',
    '/internal/telegram/file','/health']);
  assert.ok(bot.seen.slice(0,-1).every(row=>row.method==='POST'&&row.auth==='Bearer service'&&(row.body as {id:string}).id==='x'));
  assert.deepEqual([bot.seen.at(-1)!.method,bot.seen.at(-1)!.auth],['GET',undefined],'health is read without the service token');
  assert.deepEqual(hermes.seen.map(row=>new URL(row.url).pathname),['/internal/detect'],'Hermes no longer gets any Telegram call');
  await assert.rejects(runtimeCall(hermesAdapter({url:'http://hermes.invalid',token:'service',fetch:hermes.fetch}))('telegram.reply',{}),{code:'runtime_capability_unavailable'});
});

test('the bot\'s failures keep the codes callers act on',async()=>{
  const failing=(status:number,error:string)=>runtimeCall(telegramAdapter({url:'http://bot.invalid',token:'t',fetch:recorder(()=>Response.json({error},{status})).fetch}));
  await assert.rejects(failing(413,'attachment_too_large')('source.file',{file_id:'f'}),{code:'attachment_too_large',status:413});
  await assert.rejects(failing(413,'attachment_too_large')('telegram.notice',{}),{code:'telegram_unavailable'},'only a file read settles as too large');
  await assert.rejects(failing(429,'quota_paused')('telegram.reply',{}),{code:'quota_paused',status:429});
  await assert.rejects(failing(400,'invalid_request')('telegram.reply',{}),{code:'telegram_rejected_request',status:400});
  await assert.rejects(failing(503,'telegram_unavailable')('telegram.presence',{}),{code:'telegram_unavailable',status:503});
  const lost=runtimeCall(telegramAdapter({url:'http://bot.invalid',token:'t',fetch:(async()=>{throw Error('refused');}) as typeof fetch}));
  await assert.rejects(lost('telegram.reply',{}),{code:'telegram_unavailable',status:503});
});

test('only a message that addresses the bot starts a group turn',()=>{
  const bot={username:'nocheh_bot',first_name:null},names=['Nocheh','نوچه'];
  const check=(facts:unknown,text:string)=>addressed(facts,text,bot,names);
  assert.equal(check({direct:false,handles:[]},'Who wants lunch?'),false,'a question for the whole group');
  assert.equal(check({direct:false,handles:['ali_k']},'@ali_k are you coming?'),false,'a question for one person');
  assert.equal(check({direct:false,handles:[]},'I asked Nocheh yesterday'),false,'talking about the bot is not addressing it');
  assert.equal(check({direct:false,handles:[]},'Nochehs everywhere'),false,'the name must be a whole word');
  assert.equal(check({direct:false,handles:[]},'نوچه‌ای'),true,'a zero-width non-joiner ends a Persian word');
  assert.equal(check(null,'Who wants lunch?'),false,'missing facts never address the bot');
  assert.equal(check({direct:true,handles:[]},'yes'),true,'a reply to the bot or a tap on its name');
  assert.equal(check({direct:false,handles:['nocheh_bot']},'lunch @Nocheh_Bot?'),true);
  for(const text of ['Nocheh, who wants lunch?','nocheh what do you think','  Nocheh?','نوچه، نظرت چیست؟','نوچه‌جان کمک کن'])assert.equal(check({direct:false,handles:[]},text),true,text);
  assert.equal(addressed({direct:false,handles:['nocheh_bot']},'Hi',null,[]),false,'an unknown username matches nothing');
  assert.equal(addressed({},'Nocheh, hi',{username:'other_bot'},['Helper']),false,'an owner who removed a name is obeyed');
  assert.equal(addressed({},'Helper2 hi',{username:'other_bot'},['Helper']),false);
  assert.equal(addressed({},'Assistant, hi',{username:'other_bot',first_name:'Assistant'},[]),true,'the bot\'s display name addresses it');
  assert.equal(addressed({},'a.b hi',{},['a.b']),true,'names are matched literally');assert.equal(addressed({},'axb hi',{},['a.b']),false);
  assert.equal(addressed({direct:'true',handles:'nocheh_bot'},null,bot,names),false,'malformed facts fail closed');
  assert.equal(groupTurn({mode:'all',names},{},'lunch?',bot),true,'the owner may let every message through');
  assert.equal(groupTurn({mode:'all',names},{},'lunch?',bot,true),false,'a refusal still needs addressing');
});

test('group reply settings default to addressed and reject malformed values',()=>{
  assert.deepEqual(groupReplies({}),{mode:'addressed',names:['Nocheh','نوچه']},'the product name addresses the bot by default');
  assert.deepEqual(groupReplies({TELEGRAM_GROUP_REPLIES:'all',TELEGRAM_BOT_NAMES:' Helper , یاور ,'}),{mode:'all',names:['Helper','یاور']});
  assert.deepEqual(groupReplies({TELEGRAM_BOT_NAMES:''}).names,[],'the owner can remove every name');
  for(const env of [{TELEGRAM_GROUP_REPLIES:'mentions'},{TELEGRAM_BOT_NAMES:Array(11).fill('n').join(',')},{TELEGRAM_BOT_NAMES:'n'.repeat(33)}])
    assert.throws(()=>groupReplies(env),Object.keys(env)[0]);
});

test('the bot\'s identity is read once a minute and an unknown one never blocks a turn',async()=>{
  let reads=0,answer:Record<string,unknown>={username:'nocheh_bot',first_name:'Nocheh'};
  const identity=identityCache(async()=>{reads++;if(answer.fail)throw Error('down');return answer;},60000);
  assert.deepEqual(await identity(),{username:'nocheh_bot',first_name:'Nocheh'});await identity();assert.equal(reads,1);
  const failing=identityCache(async()=>{reads++;throw Error('down');});assert.equal(await failing(),null);
  answer={state:'starting'};const empty=identityCache(async()=>answer,60000);assert.equal(await empty(),null);
  answer={username:'late_bot'};assert.deepEqual(await empty(),{username:'late_bot',first_name:null},'an identity not yet loaded is asked for again');
});

test('a reply goes to the asking message in its topic, with the brain\'s and the bot\'s timings',()=>{
  const event='e'.repeat(64),input={binding:{} as any,principal:{admin:false,scope:'-100',space:'-100/topic/7',turnEvent:event} as any,
    body:{event_id:event,payload:{update_id:9,message:{message_id:41,chat:{id:-100,type:'supergroup'}}}}};
  assert.deepEqual(replyTarget(input,'c1-x','pass'),{id:digest(event+':c1-x'),event_id:event,attempt:'c1-x',chat_id:'-100',message_id:'41',topic:7,archive_credential:'pass'});
  assert.equal(deliveryId(event,2),digest(event+':2'));
  assert.equal(replyTarget({...input,principal:{...input.principal,space:'-100'}},1,'p').topic,undefined);
  assert.deepEqual(deliveredReceipt({state:'done',reply:{text:'x',session_id:'s'},timings:{conversation:{ms:3,calls:1}},window:{queued:1,assistant:2,finished:3}},
    {state:'done',timings:{telegram_send:{ms:4,calls:1}},window:{delivery:5,finished:9}}),
    {state:'done',timings:{conversation:{ms:3,calls:1},telegram_send:{ms:4,calls:1}},window:{queued:1,assistant:2,delivery:5,finished:9}});
  assert.deepEqual(['failed','cancelled','suppressed','ambiguous'].map(unansweredFinish),['failed','clear','clear','clear']);
});
