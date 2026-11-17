import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import type {Interpretation} from '../src/interpretations.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {observedSource} from '../src/observed-source.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import type {PreparedDependency} from '../src/stores/learned.js';
import {fixtureServices} from './fixture-brain.js';

/** The fields archive_read adds (ADR-0259). */
const added=['tag','by','at','chat_id','forward','topic','answers','reply_to','chain','replies','reply_link_withheld'];
const short=(item:any)=>item&&{source:item.source,by:item.by,text:item.text};

test('archive_read opens a message with its source and its thread, each part only within what the reader may read (ADR-0259)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-archive-thread-'));
  // Synthetic groups GP1 (a forum, A) and GP2 (B). The owner is account 123.
  const run=Date.now(),A='-100'+run,B='-100'+(run+1),key='archive-thread:'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A,B],topic_memory:'group'};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const zone=(await stores.control.query('SELECT settings FROM owner_task_settings WHERE singleton')).rows[0]?.settings??{};
  const admin:Reader={admin:true,scope:null};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0;
    const prepared=async(source:SourceReference)=>{await s.guards.prepare(source,'fixture',s.detect);return source;};
    const capture=async(scope:string,payload:Record<string,any>,kind='telegram_update'):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message;
      const value={version:1,key:`${key}:${update}`,origin:'live',kind,bot_id:'123456',scope,source_id:String(inner.message_id),
        revision:String(update),occurred_at:String(inner.date),text:inner.text??null,payload:{update_id:update,...payload}} as Envelope;
      return prepared((await s.capture.capture(value)).source.reference);
    };
    // An export of GP1 written by Telegram Desktop; `before` archives it as exports were before a reply into another chat
    // lost its reply relation (ADR-0258 G1), with one to this chat's message of that id.
    const exported=async(message:Record<string,unknown>,before=false)=>{
      const value:Envelope={version:1,key:`${key}:export:${message.id}`,bot_id:'desktop-export',source_id:String(message.id),revision:'1',occurred_at:String(message.date),origin:'import',
        kind:'telegram_desktop_message',scope:A,text:String(message.text),payload:{chat:{id:run,type:'private_supergroup',name:'GP1'},message:{type:'message',...message}}};
      const {reply_to_peer_id:_peer,...same}=(value.payload as any).message;
      return prepared((await s.access.archive.capture(before?{...value,source:observedSource({...value,payload:{...value.payload as object,message:same}})}:value)).source.reference);
    };
    // 2025-11-03 14:12 UTC, 15:12 in Europe/Berlin.
    const T=1762179120,chat=(id:string,title:string)=>({id:Number(id),type:'supergroup',title,is_forum:true});
    const sam={id:123,is_bot:false,first_name:'Sam',username:'sam_owner'},bob={id:456,is_bot:false,first_name:'Bob',username:'bob_gp'},ana={id:789,is_bot:false,first_name:'Ana'};
    const GP1=chat(A,'GP1'),GP2=chat(B,'GP2');
    const message=(where:Record<string,unknown>,id:number,from:Record<string,unknown>,text:string,date:number,more:Record<string,unknown>={})=>({message_id:id,date,chat:where,from,text,...more});
    const ownerPrivate=await capture('123',{message:message({id:123,type:'private',first_name:'Sam'},1,sam,'Owner private words',T)});
    const plan=message(GP1,1,bob,'Bob plan',T),bob1=await capture(A,{message:plan});
    const anaReply=message(GP1,2,ana,'Ana reply to the plan',T+60,{reply_to_message:plan}),ana2=await capture(A,{message:anaReply});
    const sam3=await capture(A,{message:message(GP1,3,sam,'Owner reply to the plan',T+120,{reply_to_message:plan})});
    const bob4=await capture(A,{message:message(GP1,4,bob,'Bob answers Ana',T+150,{reply_to_message:anaReply})});
    const openingMessage=message(GP1,5,bob,'',T+180,{message_thread_id:77,is_topic_message:true,forum_topic_created:{name:'Trips',icon_color:1}});
    const opening=await capture(A,{message:openingMessage});
    const t77=await capture(A,{message:message(GP1,6,bob,'Bob in trips',T+240,{message_thread_id:77,is_topic_message:true,reply_to_message:openingMessage})});
    const forward=await capture(A,{message:message(GP1,7,ana,'City news item',T+270,
      {forward_origin:{type:'channel',chat:{id:-1009876543210,title:'City News',type:'channel'},message_id:9,date:T-3600}})});
    const elsewhere=await exported({id:900,date:'2025-11-03T14:20:00',date_unixtime:String(T+480),from:'Ana',from_id:'user789',text:'Ana answers another chat',
      reply_to_message_id:1,reply_to_peer_id:'channel42'},true);
    const imported=await exported({id:901,date:'2025-11-03T14:21:00',date_unixtime:String(T+540),from:'Ana',from_id:'user789',text:'Ana imported reply',reply_to_message_id:1});
    const bobB=await capture(B,{message:message(GP2,1,bob,'Bob in GP2',T)});
    // GP2's reply to GP1's plan, as Telegram sends a reply into another chat: never counted or shown in GP1.
    const quoted=await capture(B,{message:message(GP2,2,bob,'Bob quotes GP1',T+30,{external_reply:{origin:{type:'user',sender_user:bob,date:T},chat:GP1,message_id:1}})});
    const bot={id:999,is_bot:true,first_name:'Nocheh'};
    const answered=await capture(A,{message:message(GP1,8,bot,'Noted, Ana',T+600),answers:ana2.id,send_class:'reply'},'telegram_delivered_message');
    // A forged answer of Nocheh's in GP2 naming GP1's message: its own canRead leaves it out.
    const forged=await capture(B,{message:message(GP2,3,bot,'Noted',T+600),answers:ana2.id,send_class:'reply'},'telegram_delivered_message');
    await stores.control.query(`UPDATE owner_task_settings SET settings=jsonb_set(settings,'{time_zone}','"Europe/Berlin"') WHERE singleton`);

    // Something learned in GP1 from six of its messages, written late on 3 November in UTC: 4 November in Berlin.
    const evidence=[bob1,ana2,sam3,bob4,t77,forward],learnedId=digest(key+':learned');
    let binding=await s.guards.state();
    const dependencies:PreparedDependency[]=[];
    for(const source of evidence){const copy=await s.guards.read('events:'+source.id,binding);dependencies.push({source_id:'events:'+source.id,revision:copy.revision,value_hash:digest(canonical(copy.value))});}
    const value:Interpretation={kind:'state',subject:'the plan',text:'The plan is agreed.',scope:{kind:'conversation',id:A},uncertainty:'supported',evidence,conflicts:[]};
    await s.learned.publishAutomatic(learnedId,value,null,key+':learned',dependencies,binding,'fixture',s.detect);
    const derived=new pg.Client({...config,database:'nocheh_derived'});await derived.connect();
    try{await derived.query("UPDATE learned_versions SET created_at='2025-11-03T23:30:00Z' WHERE entry_id=$1",[learnedId]);}finally{await derived.end();}

    binding=await s.guards.state();
    const reader=(scope:string|null,space:string,turnEvent:string):Reader=>({admin:false,scope,space,turnEvent,generation:binding.generation,guard_epoch:binding.epoch});
    let general=reader(A,A,bob1.id),other=reader(B,B,bobB.id),owner=reader(null,'123',ownerPrivate.id);
    const open=(principal:Reader,ref:SourceReference,replies=3,chain=1)=>s.sources.opened(principal,ref.id,{replies,chain}) as Promise<any>;

    // Every field read() gives stays; the source and the thread are added.
    const plain=await s.sources.read(general,bob1.id) as any,first=await open(general,bob1);
    for(const field of Object.keys(plain))assert.deepEqual(first[field],plain[field],field);
    assert.deepEqual(Object.keys(first).filter(field=>!(field in plain)).sort(),['at','by','chat_id','replies','tag']);
    assert.deepEqual([first.tag,first.by,first.at,first.chat_id],['“Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC','person','2025-11-03T14:12:00.000Z',A]);
    // Its replies: Ana's, the owner's and the imported one, oldest first; never the export's reply into another chat,
    // never GP2's. The export's sender reads "a person" for a member: an export names people as the exporting account
    // saw them, a saved contact by the name the owner gave them.
    assert.deepEqual(first.replies,{count:3,items:[
      {source:'nocheh:event:'+ana2.id,tag:'“Ana” · this chat · 2025-11-03 14:13 UTC',by:'person',text:'Ana reply to the plan'},
      {source:'nocheh:event:'+sam3.id,tag:'“Sam” (@sam_owner) · this chat · 2025-11-03 14:14 UTC',by:'owner',text:'Owner reply to the plan'},
      {source:'nocheh:event:'+imported.id,tag:'a person · this chat · 2025-11-03 14:21 local time of the export',by:'person',text:'Ana imported reply'}]});
    assert.ok(!JSON.stringify(first).includes(elsewhere.id)&&!JSON.stringify(first).includes(quoted.id));
    assert.deepEqual((await open(general,bob1,1)).replies.items.map((item:any)=>item.source),['nocheh:event:'+ana2.id],'replies shows the first ones, and counts them all');
    assert.equal((await open(general,bob1,0)).replies.count,3);

    // What it replies to, and the messages before that, one step further each.
    const answer=await open(general,bob4);
    assert.deepEqual(short(answer.reply_to),{source:'nocheh:event:'+ana2.id,by:'person',text:'Ana reply to the plan'});
    assert.deepEqual(answer.chain.map(short),[{source:'nocheh:event:'+bob1.id,by:'person',text:'Bob plan'}]);
    assert.deepEqual(answer.replies,{count:0,items:[]});
    assert.equal((await open(general,bob4,3,0)).chain,undefined);
    assert.equal((await open(general,ana2,3,5)).chain,undefined,'nothing before the first message');

    // A forum topic's opening is no reply target: its replies are the topic, which archive_page opens.
    const topic=await open(general,opening);
    assert.deepEqual(topic.replies,{count:0,items:[],topic:true});
    assert.equal(topic.topic,'group “GP1” › topic “Trips”');
    const inTopic=await open(general,t77);
    assert.deepEqual([inTopic.reply_to,inTopic.chain,inTopic.topic],[undefined,undefined,'group “GP1” › topic “Trips”']);
    assert.equal(first.topic,undefined,'a message in General is in no topic');

    // A forward names where it came from.
    assert.equal((await open(general,forward)).forward,'forwarded from a channel shown as “City News”');
    // An old export's reply into another chat keeps no reply link; any other imported reply keeps it.
    const withheld=await open(general,elsewhere);
    assert.deepEqual([withheld.reply_to,withheld.reply_link_withheld],[undefined,'other_chat']);
    assert.deepEqual(short((await open(general,imported)).reply_to),{source:'nocheh:event:'+bob1.id,by:'person',text:'Bob plan'});
    // Nocheh's reply names the message it answers, only where that message is readable.
    assert.deepEqual(short((await open(general,answered)).answers),{source:'nocheh:event:'+ana2.id,by:'person',text:'Ana reply to the plan'});
    assert.equal((await open(other,forged)).answers,undefined,'GP2 never reads GP1\'s message through an answer');

    // GP2 reads none of GP1: not the message, not a reply link into it.
    await assert.rejects(open(other,bob1));
    const fromGP2=await open(other,quoted);
    assert.equal(fromGP2.reply_to,undefined);
    assert.ok(!JSON.stringify(addedOf(fromGP2)).includes('GP1')&&!JSON.stringify(fromGP2).includes(bob1.id),'GP1 is named only where Telegram\'s own copy names it');
    // The owner reads the whole thread, GP2's reply into GP1 too, in the Tasks time zone.
    const owned=await open(owner,bob1,10);
    assert.deepEqual([owned.tag,owned.replies.count,owned.replies.items.at(-1)?.source],['“Bob” (@bob_gp) · group “GP1” · 2025-11-03 15:12 Europe/Berlin',4,'nocheh:event:'+quoted.id]);
    assert.equal(owned.replies.items.find((item:any)=>item.source==='nocheh:event:'+imported.id)?.tag,'“Ana” · group “GP1” · 2025-11-03 14:21 local time of the export',
      'the owner reads the name the export wrote');
    // A reader outside a turn, as the dashboard reads, gets today's fields alone.
    const outside:Reader={admin:false,scope:A,space:A,generation:binding.generation,guard_epoch:binding.epoch};
    assert.deepEqual(await open(outside,bob1),await s.sources.read(outside,bob1.id));

    // What was learned opens by its id and its active revision: who wrote it, its day in the reader's zone and five of
    // its sources, tagged.
    const learned=await s.sources.learnedEntry(general,learnedId,1) as any;
    assert.deepEqual({...learned,evidence:learned.evidence.map((item:any)=>item.source)},{source:`nocheh:learned:${learnedId}:1`,kind:'state',subject:'the plan',
      text:'The plan is agreed.',author:'honcho',day:'2025-11-03',evidence:evidence.slice(0,5).map(item=>'nocheh:event:'+item.id),more:1});
    assert.deepEqual([learned.evidence[0].tag,learned.evidence[0].by],['“Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC','person']);
    assert.equal((await s.sources.learnedEntry(owner,learnedId,1) as any).day,'2025-11-04');
    await assert.rejects(s.sources.learnedEntry(general,learnedId,2),{code:'learned_memory_not_found'},'only the active revision');
    await assert.rejects(s.sources.learnedEntry(other,learnedId,1),{code:'learned_memory_not_found'},'never another group\'s');
    await assert.rejects(s.sources.learnedEntry(outside,learnedId,1),{code:'scoped_turn_required'});

    // Retired is forgotten at once: the owner's reply leaves the count and the items, and what was learned from it closes.
    await s.retirements.set(admin,sam3.id,{retired:true,expected_revision:0,operation_id:key+':retire'});
    binding=await s.guards.state();general=reader(A,A,bob1.id);other=reader(B,B,bobB.id);owner=reader(null,'123',ownerPrivate.id);
    const after=await open(general,bob1);
    assert.deepEqual([after.replies.count,after.replies.items.map((item:any)=>item.source)],[2,['nocheh:event:'+ana2.id,'nocheh:event:'+imported.id]]);
    await assert.rejects(s.sources.learnedEntry(general,learnedId,1),{code:'learned_memory_not_found'});

    // Replies in chats the reader can't reach never take the place of its own: three GP2 quotes of GP1's message come
    // first, then Ana's reply in GP1; read two at a time, GP1 still finds Ana's, and says nothing of more elsewhere.
    const busy=message(GP1,20,bob,'Busy plan',T+900),busyRef=await capture(A,{message:busy});
    for(let n=0;n<3;n++)await capture(B,{message:message(GP2,30+n,bob,'GP2 quotes the busy plan',T+910+n,{external_reply:{origin:{type:'user',sender_user:bob,date:T+900},chat:GP1,message_id:20}})});
    const anaBusy=await capture(A,{message:message(GP1,21,ana,'Ana on the busy plan',T+990,{reply_to_message:busy})});
    const busyObject=(await s.access.relationships.describeMany([busyRef.id])).get(busyRef.id)!.object_id;
    const scoped=await s.access.relationships.replies(busyObject,{kind:'recall',scope:{space:A,group:A}},2);
    assert.deepEqual([scoped.replies.flatMap(reply=>reply.references.map(item=>item.id)),scoped.more],[[anaBusy.id],false]);
    const everyone=await s.access.relationships.replies(busyObject,{kind:'owner'},2);
    assert.equal(everyone.more,true,'the owner reads every chat, and is told there are more');

    // A thread or a page's links that can't be worked out never fail the read: the message opens as read() gives it,
    // with its source "not available right now", the page reads as it did before, and each failure is counted.
    const failures=async()=>(await stores.control.query(`SELECT coalesce(sum(failed),0)::integer AS failed FROM memory_problem_days
      WHERE kind='source_tags' AND day=(now() AT TIME ZONE 'UTC')::date`)).rows[0].failed as number;
    const before=await failures(),relations=s.access.relationships,targets=relations.replyTargets;
    relations.replyTargets=async()=>{throw new Error('relations down');};
    try {
      const broken=await open(general,bob4),read=await s.sources.read(general,bob4.id) as any;
      for(const field of Object.keys(read))assert.deepEqual(broken[field],read[field],field);
      assert.deepEqual([broken.tag,broken.by,broken.at,broken.reply_to,broken.replies],['source not available right now','unknown',null,undefined,undefined]);
      const page=await s.sources.page(general,{chat:'',from:'',to:'',after:'',count:30}) as any;
      assert.ok(page.items.length>0&&page.items.every((item:any)=>item.reply_source===undefined&&item.owner===undefined));
    } finally {relations.replyTargets=targets;}
    assert.equal(await failures(),before+2,'each failure is counted as a source_tags problem');
  } finally {
    await stores.control.query('UPDATE owner_task_settings SET settings=$1 WHERE singleton',[JSON.stringify(zone)]).catch(()=>{});
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});

/** Only the fields archive_read adds. */
function addedOf(value:Record<string,unknown>):Record<string,unknown> {return Object.fromEntries(Object.entries(value).filter(([field])=>added.includes(field)));}
