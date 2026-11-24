import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {servedPolicy,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import type {SourceReference} from '../src/stores/archive.js';
import {fixtureServices,fixtureTelegram,type FakeCall} from './fixture-agent.js';
import {OWNER} from './fixture-groups.js';

// A turn's frame names and quotes the message its own message replies to, and each recent group message names the one it
// replies to (ADR-0261): by the archive's reply relation, only as the turn's reader may read it, never a forum topic's
// opening, and never a Telegram ID.
test('a turn names and quotes the message it replies to, and a recent message names its own, each only as its reader may read it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-reply-frame-')),base=Date.now(),token=digest('reply-frame:'+base);
  // A synthetic forum group first seen in this run; Alice is a member who may not talk to Nocheh.
  const G='-100'+String(base).slice(-10),ALICE=987654321,LONG=Number(String(base).slice(-6))+700000;
  const configured:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[],topic_memory:'group'};
  const policy=servedPolicy(()=>configured),started:any[]=[];let serial=base;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='run.start'){started.push(input);return {state:'done',stage:'assistant'};}
    return {state:'done'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),groupReplies:{mode:'addressed',names:['Nocheh']},telegram:fixtureTelegram()});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const chatOf=(telegram:string)=>telegram===OWNER?{id:Number(telegram),type:'private',first_name:'Owner'}:{id:Number(telegram),type:'supergroup',title:'Reply team',is_forum:true};
  const names:Record<number,string>={[Number(OWNER)]:'Owner',[ALICE]:'Alice',[LONG]:'L'.repeat(200)};
  const date=(update:number)=>1762179120+update-base;
  /** One live update, taken in, prepared and dispatched as the service does; its message, to reply to. */
  const say=async(telegram:string,text:string|null,from=Number(OWNER),extra:Record<string,unknown>={}):Promise<{id:string;message:any}>=>{
    const update=++serial,message={message_id:update,date:date(update),chat:chatOf(telegram),from:{id:from,is_bot:false,first_name:names[from]},
      ...(text===null?{}:{text}),...extra};
    const id=(await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:telegram,
      source_id:String(update),revision:'1',occurred_at:String(message.date),text,payload:{update_id:update,message}} as Envelope)).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    await services.telegram.run(id,await authority('telegram'));return {id,message};
  };
  const prepared=async(source:SourceReference)=>{await services.guards.prepare(source,'fixture',services.detect);return source;};
  /** A message Nocheh's bot sent, as it is archived. */
  const nocheh=async(telegram:string,text:string,send_class:string):Promise<{id:string;message:any}>=>{
    const update=++serial,message={message_id:update,date:date(update),chat:chatOf(telegram),from:{id:123456,is_bot:true,first_name:'Nocheh'},text};
    const source=await prepared((await services.capture.capture({version:1,key:`reply-frame:${base}:sent:${update}`,origin:'live',kind:'telegram_delivered_message',
      bot_id:'123456',scope:telegram,source_id:String(update),revision:'1',occurred_at:String(message.date),text,payload:{message,send_class}} as Envelope)).source.reference);
    return {id:source.id,message};
  };
  const ownerAdds=async(telegram:string)=>{
    const update=++serial,bot={id:123456,is_bot:true,first_name:'Nocheh'};
    await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:telegram,
      source_id:String(update),revision:'1',occurred_at:null,text:null,payload:{update_id:update,my_chat_member:{chat:chatOf(telegram),
        from:{id:Number(OWNER),is_bot:false,first_name:'Owner'},date:date(update),old_chat_member:{status:'left',user:bot},new_chat_member:{status:'member',user:bot}}}} as Envelope);
  };
  const turnOf=(event:string)=>started.find(turn=>turn.event_id===event);
  const at=(message:any)=>new Date(message.date*1000).toISOString().slice(0,16).replace('T',' ')+' UTC';
  // A whole number only: a short ID such as the owner's can also sit inside an event digest or a time, which differ each run.
  const noIds=(value:unknown)=>{const text=JSON.stringify(value);for(const id of [G,String(ALICE),String(LONG),OWNER])assert.ok(!new RegExp(`(?<![0-9A-Za-z])${id}(?![0-9A-Za-z])`).test(text),'no Telegram ID: '+id);};
  await startChatDirectory(stores.control,()=>configured);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    await ownerAdds(G);
    const code=await say(G,'The door code is 4711\nfrom Monday on',ALICE);
    const answer=await nocheh(G,'Noted: I keep that to myself.','reply');
    const card=await nocheh(G,'Approve this action? Alice asked for the door code.','card');
    const thanks=await say(G,'Thanks Nocheh',ALICE,{reply_to_message:answer.message});
    const agree=await say(G,'Count me in',ALICE,{reply_to_message:code.message});
    const long=await say(G,'Same here',LONG,{reply_to_message:code.message});

    // The owner replies to Alice: the block names her as this group reads her, with her text on one line.
    const asked=await say(G,'Nocheh, what did Alice mean?',Number(OWNER),{reply_to_message:code.message}),turn=turnOf(asked.id);
    assert.deepEqual(turn.reply,{line:`[Replying to, by=person: “Alice” · this chat · ${at(code.message)}] (source nocheh:event:${code.id})`,
      text:'The door code is 4711 from Monday on',by:'person',id:code.id});
    // Each recent message that replies names its message, without its text: Nocheh's reply by=nocheh, Alice's by=person.
    const recent=new Map(turn.recent_group.map((item:any)=>[item.id,item]));
    assert.equal((recent.get(code.id) as any).reply,undefined,'a message that replies to nothing has no part');
    assert.equal((recent.get(thanks.id) as any).reply,`[In reply to, by=nocheh: Nocheh, Nocheh's reply · this chat · ${at(answer.message)}] (source nocheh:event:${answer.id})`);
    assert.equal((recent.get(agree.id) as any).reply,`[In reply to, by=person: “Alice” · this chat · ${at(code.message)}] (source nocheh:event:${code.id})`);
    // A long name never drops a speaker line or a part: each is cut to its own size.
    const tall=recent.get(long.id) as any;
    assert.match(tall.speaker,/^\[Group message from L{64}, sent [^\]]+\]$/);assert.ok(tall.reply.length<=300&&tall.reply.endsWith(`(source nocheh:event:${code.id})`));
    noIds([turn.reply,turn.recent_group]);

    // A reply to Nocheh's own message reads by=nocheh, with Nocheh's text, so "source?" can be answered; a card may carry
    // others' words, so it reads by=person.
    const toNocheh=turnOf((await say(G,'Nocheh, is that right?',Number(OWNER),{reply_to_message:answer.message})).id);
    assert.deepEqual([toNocheh.reply.by,toNocheh.reply.text,toNocheh.reply.id],['nocheh','Noted: I keep that to myself.',answer.id]);
    assert.ok(toNocheh.reply.line.startsWith('[Replying to, by=nocheh: Nocheh, Nocheh\'s reply · this chat · '));
    const toCard=turnOf((await say(G,'Nocheh, what is this card?',Number(OWNER),{reply_to_message:card.message})).id);
    assert.deepEqual([toCard.reply.by,toCard.reply.id],['person',card.id]);
    assert.ok(toCard.reply.line.startsWith('[Replying to, by=person: Nocheh, a card that may carry others\' words · this chat · '));

    // A retired target, and one never archived, give no block.
    const taken=await say(G,'Something I take back',ALICE);
    await services.retirements.set({admin:true,scope:null},taken.id,{retired:true,expected_revision:0,operation_id:'reply-frame:'+base});
    const toRetired=turnOf((await say(G,'Nocheh, and that?',Number(OWNER),{reply_to_message:taken.message})).id);
    assert.equal(toRetired.reply,undefined,'a retired target gives no block');
    assert.ok(!JSON.stringify(toRetired).includes(taken.id),'nor a part or a recent line');
    const unseen={message_id:1,date:date(base),chat:chatOf(G),from:{id:ALICE,is_bot:false,first_name:'Alice'},text:'Never archived'};
    assert.equal(turnOf((await say(G,'Nocheh, and this?',Number(OWNER),{reply_to_message:unseen})).id).reply,undefined,'nor one Nocheh never archived');

    // A plain forum-topic message replies to the topic's opening in Telegram: it gets no block and no part, in the Bot API
    // shape (the opening embedded and archived) and when only an old Telegram Desktop export of the opening is archived.
    const thread={message_thread_id:Number(String(base).slice(-4))+10,is_topic_message:true};
    const opening=await say(G,null,ALICE,{...thread,forum_topic_created:{name:'Trips',icon_color:1}});
    const plain=await say(G,'Trip on Friday',ALICE,{...thread,reply_to_message:opening.message});
    const inTopic=turnOf((await say(G,'Nocheh, plans?',Number(OWNER),{...thread,reply_to_message:opening.message})).id);
    assert.ok(inTopic,'the topic message is answered');
    assert.equal(inTopic.reply,undefined,'no block for a plain topic message');
    assert.ok(inTopic.recent_group.some((item:any)=>item.id===plain.id),'the topic\'s recent message is there');
    assert.ok(inTopic.recent_group.every((item:any)=>item.reply===undefined),'and replies to nothing');
    // Bot API embeds the opening; with that field gone, the archived opening alone still says it is no reply.
    const {forum_topic_created:_,...bare}=opening.message;
    assert.equal(turnOf((await say(G,'Nocheh, still there?',Number(OWNER),{...thread,reply_to_message:bare})).id).reply,undefined);
    const exportedId=Number(String(base).slice(-5))+200000;
    await prepared((await services.access.archive.capture({version:1,key:`reply-frame:${base}:export:${exportedId}`,bot_id:'desktop-export',source_id:String(exportedId),revision:'1',
      occurred_at:String(date(base)),origin:'import',kind:'telegram_desktop_message',scope:G,text:'',
      payload:{chat:{id:Number(G.slice(4)),type:'private_supergroup',name:'Reply team'},
        message:{id:exportedId,type:'service',date:'2025-11-03T14:00:00',date_unixtime:String(date(base)),actor:'Alice',actor_id:'user987654321',action:'topic_created',title:'Old trips',text:''}}} as Envelope)).source.reference);
    const desktop=turnOf((await say(G,'Nocheh, about the old topic?',Number(OWNER),{reply_to_message:{message_id:exportedId,date:date(base),chat:chatOf(G)}})).id);
    assert.equal(desktop.reply,undefined,'a Desktop export\'s topic opening is no reply either');

    // In the owner's private chat, a reply to Nocheh's answer there names it by=nocheh, as the owner reads it.
    const flight=await nocheh(OWNER,'Your flight is at 09:00 on Friday.','reply');
    const source=turnOf((await say(OWNER,'source?',Number(OWNER),{reply_to_message:flight.message})).id);
    assert.equal(source.speaker,undefined);
    assert.deepEqual([source.reply.by,source.reply.text,source.reply.id],['nocheh','Your flight is at 09:00 on Friday.',flight.id]);
    assert.ok(source.reply.line.startsWith('[Replying to, by=nocheh: Nocheh, Nocheh\'s reply · this chat · '),source.reply.line);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
