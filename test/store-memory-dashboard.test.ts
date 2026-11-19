import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {installChatsForTest} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {sourceLines} from '../src/prompts.js';
import type {SourceReference} from '../src/stores/archive.js';
import {loadChatSnapshot} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MemoryDashboard} from '../src/stores/memory-dashboard.js';
import {materialPeer,materialSessionKey} from '../src/stores/native-memory.js';
import {memoryProblems} from '../src/stores/note-sources.js';
import {OwnerOriginals} from '../src/stores/owner-originals.js';
import {fixtureServices} from './fixture-brain.js';

/** Honcho's ids: 21 characters. */
const nid=(name:string)=>name.replace(/[^A-Za-z0-9]/g,'').padEnd(21,'0').slice(0,21);
const honchoTime=(seconds:number)=>new Date(seconds*1000).toISOString().replace('Z','000Z');

test('the owner\'s dashboard reads a message\'s thread and what was learned from it, the facts list and its coverage, each original in the owner\'s words (ADR-0261 step 4)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-dashboard-'));
  // A synthetic forum group GP1 (A); the owner is account 123.
  const run=Date.now(),A='-100'+run,key='memory-dashboard:'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A],topic_memory:'group'};
  const workspace=digest(key+':space'),session=(name:string)=>digest(`${key}:session:${name}`);
  const groupSession=session('group'),ownerSession=session('owner'),materialSession=session('material');
  // Honcho's conclusions as its stock list reads them, and its coverage route; `down` makes every call fail.
  type Conclusion={id:string;content:string;observer_id:string;observed_id:string;level:'explicit';session_id:string;times_derived:number;created_at:string;source_message_ids:string[]|null};
  const conclusions:Conclusion[]=[],batches=new Map<string,{message_id:string;receipt_id:string}[]>();
  let down=false;
  const engine=honchoEngine(async(path:string,body:any)=>{
    if(down)throw Object.assign(new Error('memory_engine_unavailable'),{code:'memory_engine_unavailable'});
    if(path.includes('/conclusions/list')) {
      const f=body.filters,size=Number(new URL('http://h'+path).searchParams.get('size'));
      const items=conclusions.filter(c=>c.level===f.level&&(!f.observer_id||c.observer_id===f.observer_id)&&(!f.observed_id||c.observed_id===f.observed_id)&&
        (!f.session_id||f.session_id.in.includes(c.session_id))&&(!f.source_message_ids||(c.source_message_ids??[]).some(m=>f.source_message_ids.in.includes(m))))
        .sort((a,b)=>a.created_at<b.created_at?1:a.created_at>b.created_at?-1:0);
      return {items:items.slice(0,size),next_page:items.length>size?'next':null};
    }
    if(path.endsWith('/nocheh/provenance'))return {roots:body.conclusion_ids,nodes:body.conclusion_ids.map((id:string)=>({id,parents:[],deleted:false,
      exact_citations:batches.has(id)?false:null,messages:batches.get(id)??[],messages_truncated:false})),messages:[],limitations:[],exact_citations:false};
    if(path.endsWith('/nocheh/citation-coverage'))return {explicit:4,cited:2,batch_only:1,none:1};
    throw Error('unexpected honcho call '+path);
  });
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,runtime:async()=>({literals:[]}),memoryEngine:engine});
  const admin:Reader={admin:true,scope:null};
  let restore=()=>{};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0;
    const capture=async(scope:string,payload:Record<string,any>):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message;
      const value={version:1,key:`${key}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(inner.message_id),
        revision:String(update),occurred_at:String(inner.date),text:inner.text??null,payload:{update_id:update,...payload}} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    // 2025-11-03 14:12 UTC.
    const T=1762179120,GP1={id:Number(A),type:'supergroup',title:'GP1',is_forum:true},mine={id:123,type:'private',first_name:'Sam'};
    const sam={id:123,is_bot:false,first_name:'Sam',username:'sam_owner'},bob={id:456,is_bot:false,first_name:'Bob',username:'bob_gp'},ana={id:789,is_bot:false,first_name:'Ana'};
    const message=(where:Record<string,unknown>,id:number,from:Record<string,unknown>,text:string,date:number,more:Record<string,unknown>={})=>({message_id:id,date,chat:where,from,text,...more});
    const planMessage=message(GP1,1,bob,'Bob plan',T),plan=await capture(A,{message:planMessage});
    const ana2=await capture(A,{message:message(GP1,2,ana,'Ana agrees',T+60,{reply_to_message:planMessage})});
    const sam3=await capture(A,{message:message(GP1,3,sam,'Owner agrees too',T+120,{reply_to_message:planMessage})});
    const openingMessage=message(GP1,5,bob,'',T+180,{message_thread_id:77,is_topic_message:true,forum_topic_created:{name:'Trips',icon_color:1}});
    const opening=await capture(A,{message:openingMessage});
    const t77=await capture(A,{message:message(GP1,6,bob,'Bob in trips',T+240,{message_thread_id:77,is_topic_message:true,reply_to_message:openingMessage})});
    const forward=await capture(A,{message:message(GP1,7,ana,'City news item',T+270,
      {forward_origin:{type:'channel',chat:{id:-1009876543210,title:'City News',type:'channel'},message_id:9,date:T-3600}})});
    const own=await capture('123',{message:message(mine,8,sam,'Meeting with the bank at 3',T+300)});
    // The chats as captured, named as the dashboard's process names them.
    restore=installChatsForTest(await loadChatSnapshot(stores.control as pg.Pool,policy));
    // The owner retires their own reply.
    await s.retirements.set(admin,sam3.id,{retired:true,expected_revision:0,operation_id:key+':retire'});

    // The space, its sessions and the receipts that wrote each message to Honcho, as ingestion leaves them.
    const binding=await s.guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    for(const [name,audience,kind,id] of [['group',A,'conversation',groupSession],['owner','owner','conversation',ownerSession],
      [materialSessionKey(engine.protocol),'owner','material',materialSession]])
      await stores.control.query('INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5)',[workspace,digest(key+name),audience,kind,id]);
    const remote=(source:SourceReference)=>nid('r'+source.id),receipt=(source:SourceReference)=>digest(`${key}:receipt:${source.id}`);
    const write=(source:SourceReference,peer:string,audience:string,sessionId:string)=>stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,
      source_reference,source_references,guard_source_id,prepared_id,content_hash,state,remote_id,session_id,audience,peer_id,peer_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,'done',$8,$9,$10,$11,$12)`,[receipt(source),workspace,JSON.stringify(source),JSON.stringify([source]),'events:'+source.id,
      digest('prepared:'+source.id),digest('fixture'),remote(source),sessionId,audience,peer,JSON.stringify([peer])]);
    // Bob is a person on the People page; his facts are his participant's.
    const bobEntity=digest(key+':bob'),BOB='person_'+bobEntity,ANA='person_'+digest(key+':ana'),OWNER='person_'+digest(key+':owner');
    await stores.control.query(`INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Bob','active')`,[bobEntity]);
    await write(plan,BOB,A,groupSession);await write(ana2,ANA,A,groupSession);await write(sam3,OWNER,A,groupSession);
    await write(own,OWNER,'owner',ownerSession);await write(forward,materialPeer,'owner',materialSession);
    let created=T;
    const learn=(peer:string,sessionId:string,content:string,cites:SourceReference[]|null,about=peer)=>{
      const id=nid('c'+content);
      conclusions.push({id,content,observer_id:peer,observed_id:about,level:'explicit',session_id:sessionId,times_derived:1,created_at:honchoTime(created+=10),
        source_message_ids:cites?cites.map(remote):null});return id;
    };
    const bobPlan=learn(BOB,groupSession,'Bob has a plan',[plan]);
    const agreed=learn(ANA,groupSession,'Ana and the owner agree on the plan',[ana2,sam3]);
    learn(BOB,groupSession,'Bob thinks Ana agrees',[ana2],ANA);
    const bank=learn(OWNER,ownerSession,'The owner meets the bank at 3',[own]);
    const batch=learn(ANA,groupSession,'Ana reads the news',null);batches.set(batch,[{message_id:remote(forward),receipt_id:receipt(forward)}]);
    // The memory space Nocheh reads now (one a fresh start left behind is never read: dashboardSpace()).
    (s.memory as any).workspace=async()=>({id:workspace});
    (s.memory as any).current=async()=>({row:{id:workspace},binding:await s.guards.state()});

    const today=async()=>(await memoryProblems(stores.control)).find(row=>row.kind==='source_tags')?.failed??0;
    const linked=(item:any)=>item&&'id' in item?item.id:item;

    // Thread: replies to the plan, oldest first, the retired one only as retired; what each replies to.
    const planThread=await s.sources.ownerThread(admin,plan.id,s.originals) as any;
    assert.deepEqual([planThread.reply_to,planThread.topic,planThread.forwarded_from],[null,null,null]);
    assert.deepEqual(planThread.replies.count,2);
    assert.deepEqual(planThread.replies.items.map(linked),[ana2.id,{retired:true}],'a retired reply is never shown as an original');
    assert.match(planThread.replies.items[0].label,/Ana/);assert.equal(planThread.replies.items[0].at,'2025-11-03T14:13:00.000Z');
    const reply=await s.sources.ownerThread(admin,ana2.id,s.originals) as any;
    assert.equal(reply.reply_to.id,plan.id);assert.match(reply.reply_to.label,/Bob/);assert.match(reply.reply_to.label,/GP1/);
    assert.deepEqual(reply.replies,{count:0,items:[]});
    // A message replying to a topic's opening is in that topic: never "replies to" the opening.
    const inTopic=await s.sources.ownerThread(admin,t77.id,s.originals) as any;
    assert.equal(inTopic.reply_to,null);
    assert.match(inTopic.topic.label,/GP1/);assert.match(inTopic.topic.label,/Trips/);assert.equal(inTopic.topic.opening.id,opening.id);
    const opens=await s.sources.ownerThread(admin,opening.id,s.originals) as any;
    assert.deepEqual([opens.replies,opens.topic.opens,opens.topic.opening,opens.reply_to],[{count:0,items:[],topic:true},true,null,null]);
    assert.match((await s.sources.ownerThread(admin,forward.id,s.originals) as any).forwarded_from,/City News/);

    // Learned into memory: the facts citing a message, through its receipts, with the exact badge; never a peer's fact
    // about another peer.
    const fromPlan=await s.memoryDashboard.learned(admin,plan.id);
    assert.deepEqual(fromPlan.facts.map(fact=>[fact.id,fact.text,fact.exact,fact.by]),[[bobPlan,'Bob has a plan',true,'person']]);
    assert.equal(linked(fromPlan.facts[0]!.originals[0]),plan.id);assert.match(fromPlan.facts[0]!.label!,/Bob/);
    const fromAna=await s.memoryDashboard.learned(admin,ana2.id);
    assert.deepEqual(fromAna.facts.map(fact=>fact.id),[agreed]);
    assert.deepEqual(fromAna.facts[0]!.originals.map(linked),[ana2.id,{retired:true}],'a retired source reads only retired');
    assert.deepEqual(await s.memoryDashboard.learned(admin,t77.id),{facts:[],reason:'not_learned'});

    // The Facts list: newest first, by chat or by person, a fact learned with its batch never exact.
    const all=await s.memoryDashboard.facts(admin,{chat:'',person:'',after:''});
    assert.deepEqual(all.facts.map(fact=>fact.id),[batch,bank,agreed,bobPlan]);
    const news=all.facts[0]!;
    assert.deepEqual([news.exact,news.batch,linked(news.originals[0])],[false,true,forward.id]);
    assert.equal(all.next,null);
    assert.deepEqual((await s.memoryDashboard.facts(admin,{chat:A,person:'',after:''})).facts.map(fact=>fact.id),[batch,agreed,bobPlan]);
    assert.deepEqual((await s.memoryDashboard.facts(admin,{chat:'123',person:'',after:''})).facts.map(fact=>fact.id),[bank]);
    assert.deepEqual((await s.memoryDashboard.facts(admin,{chat:'',person:bobEntity,after:''})).facts.map(fact=>fact.id),[bobPlan]);
    await assert.rejects(s.memoryDashboard.facts(admin,{chat:'',person:digest('nobody'),after:''}),{code:'person_not_found'});
    assert.deepEqual(await s.memoryDashboard.coverage(admin),{coverage:{total:4,exact:2,with_others:1,none:1}});

    // Short labels next to originals elsewhere (Facts, People, Inbox review): in the order asked.
    const looked=await s.originals.lookup(admin,[plan.id,sam3.id,digest('not archived')]);
    assert.deepEqual(looked.originals.map(linked),[plan.id,{retired:true},{unavailable:true,label:sourceLines(undefined).unknown}]);
    await assert.rejects(s.originals.lookup(admin,['short']),{code:'invalid_originals_request'});

    // Notes: a note's day and the message its turn answered, a retired one only as retired.
    const turn=(event:SourceReference)=>({by:'turn',event:event.id,channel:'telegram',at:'2025-11-03',at_time:T,reads:[],complete:true});
    const notes=await s.noteSources.withOwnerLabels({scope:A,memories:[{name:'MEMORY.md',entries:[
      {target:'memory',text:'Bob has a plan',key:digest(key+':note1'),origins:[turn(plan)]},
      {target:'memory',text:'The owner agreed',key:digest(key+':note2'),origins:[turn(sam3)]}]}]},ids=>s.originals.originals(ids)) as any;
    const [first,second]=notes.memories[0].entries;
    assert.equal(first.day,'2025-11-03');assert.deepEqual(first.originals.map(linked),[plan.id]);
    assert.deepEqual(second.originals,[{retired:true}]);

    // Only the owner: a turn reader, even the owner's own, gets none of it.
    const reader:Reader={admin:false,scope:null,space:'123',turnEvent:own.id,generation:binding.generation,guard_epoch:binding.epoch};
    for(const read of [()=>s.sources.ownerThread(reader,plan.id,s.originals),()=>s.memoryDashboard.learned(reader,plan.id),
      ()=>s.memoryDashboard.facts(reader,{chat:'',person:'',after:''}),()=>s.memoryDashboard.coverage(reader),()=>s.originals.lookup(reader,[plan.id])])
      await assert.rejects(read(),{status:403});

    // The engine down: every read answers an empty list with its reason, and each failure is counted.
    down=true;
    let before=await today();
    assert.deepEqual(await s.memoryDashboard.learned(admin,plan.id),{facts:[],reason:'unavailable'});
    assert.deepEqual(await s.memoryDashboard.facts(admin,{chat:'',person:'',after:''}),{facts:[],next:null,reason:'unavailable'});
    assert.deepEqual(await s.memoryDashboard.coverage(admin),{coverage:null,reason:'unavailable'});
    assert.equal(await today(),before+3,'each failed read is counted');
    down=false;
    // An engine that can't list facts, and no memory space: empty with the reason, nothing counted.
    before=await today();
    const plain=new MemoryDashboard(stores,{engine:{id:'plain'},dashboardSpace:async()=>({id:workspace,binding})} as any,s.originals,()=>policy);
    assert.deepEqual(await plain.learned(admin,plan.id),{facts:[],reason:'not_supported'});
    assert.deepEqual(await plain.facts(admin,{chat:'',person:'',after:''}),{facts:[],next:null,reason:'not_supported'});
    assert.deepEqual(await plain.coverage(admin),{coverage:null,reason:'not_supported'});
    const none=new MemoryDashboard(stores,{engine,dashboardSpace:async()=>null} as any,s.originals,()=>policy);
    assert.deepEqual(await none.learned(admin,plan.id),{facts:[],reason:'no_memory'});
    assert.equal(await today(),before);
    // Labels that can't be built fail closed: no id to open, "not available right now", counted.
    const broken=new OwnerOriginals(stores.control,{ownerEventLabels:async()=>{throw Error('down');},ownerWords:s.noteSources.ownerWords.bind(s.noteSources)},s.retirements);
    assert.deepEqual([...(await broken.originals([plan.id])).values()],[{unavailable:true,label:sourceLines(undefined).unavailable}]);
    assert.equal(await today(),before+1);
  } finally {restore();await rm(root,{recursive:true,force:true});await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);}
});
