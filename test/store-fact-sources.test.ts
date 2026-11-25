import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {materialPeer,materialSessionKey} from '../src/stores/native-memory.js';
import {memoryProblems} from '../src/stores/note-sources.js';
import {fixtureServices} from './fixture-agent.js';

/** Honcho's ids: 21 characters. */
const nid=(name:string)=>name.replace(/[^A-Za-z0-9]/g,'').padEnd(21,'0').slice(0,21);
const honchoTime=(seconds:number)=>new Date(seconds*1000).toISOString().replace('Z','000Z');

test('recalled facts name their sources per turn: the reader\'s receipts, its zone and names, Honcho\'s own selection, and records that follow every source (ADR-0261)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-fact-sources-'));
  // A synthetic group GP1 (A); the owner is account 123.
  const run=Date.now(),A='-100'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A],topic_memory:'group'};
  const workspace=digest('fact-sources:'+run),session=(name:string)=>digest(`fact-sources:${run}:session:${name}`);
  const groupSession=session('group'),ownerSession=session('owner'),materialSession=session('material');
  // Honcho's conclusions, as the stock list and the context route read them (dreams off: explicit only).
  type Conclusion={id:string;content:string;observer_id:string;observed_id:string;level:'explicit';session_id:string;times_derived:number;created_at:string;source_message_ids:string[]|null};
  const conclusions:Conclusion[]=[],batches=new Map<string,{message_id:string;receipt_id:string}[]>(),represented:string[][]=[];
  /** Honcho's working representation: the newest explicit conclusions the peer holds of itself, within the session when
   *  limited to it, up to WORKING_REPRESENTATION_MAX_OBSERVATIONS (H:src/crud/representation.py _query_documents_recent). */
  const representation=(peer:string,allow:string[]|null)=>conclusions.filter(c=>c.observer_id===peer&&c.observed_id===peer&&(!allow||allow.includes(c.session_id)))
    .sort((a,b)=>a.created_at<b.created_at?1:a.created_at>b.created_at?-1:0).slice(0,100);
  let summaryMessage:string|null=null;
  const engine=honchoEngine(async(path:string,body:any)=>{
    const context=/\/sessions\/([^/]+)\/context\?(.*)$/.exec(path);
    if(context) {
      const query=new URLSearchParams(context[2]),peer=query.get('peer_target'),chosen=peer?representation(peer,query.get('limit_to_session')?[context[1]!]:null):[];
      represented.push(chosen.map(c=>c.id));
      return {summary:{content:'Summary of '+context[1]!.slice(0,6),message_id:summaryMessage},peer_representation:chosen.map(c=>`[${c.created_at}] ${c.content}`).join('\n')};
    }
    if(path.includes('/conclusions/list')) {
      const f=body.filters,size=Number(new URL('http://h'+path).searchParams.get('size'));
      const items=conclusions.filter(c=>c.observer_id===f.observer_id&&c.observed_id===f.observed_id&&c.level===f.level&&(!f.session_id||f.session_id.in.includes(c.session_id))&&
        (!f.id||f.id.in.includes(c.id))&&(!f.times_derived||c.times_derived>=f.times_derived.gte)).sort((a,b)=>a.created_at<b.created_at?1:a.created_at>b.created_at?-1:0);
      return {items:items.slice(0,size),next_page:items.length>size?'next':null};
    }
    if(path.endsWith('/nocheh/provenance')) {
      assert.equal(body.per_node,true);
      return {roots:body.conclusion_ids,nodes:body.conclusion_ids.map((id:string)=>({id,parents:[],deleted:false,exact_citations:batches.has(id)?false:null,
        messages:batches.get(id)??[],messages_truncated:false})),messages:[],limitations:[],exact_citations:false};
    }
    throw Error('unexpected honcho call '+path);
  });
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,runtime:async()=>({literals:[]}),memoryEngine:engine});
  const zone=(await stores.control.query('SELECT settings FROM owner_task_settings WHERE singleton')).rows[0]?.settings??{};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0,messageId=0;
    const capture=async(scope:string,payload:Record<string,any>):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message;
      const value={version:1,key:`fact-sources:${run}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(inner.message_id),
        revision:String(update),occurred_at:String(inner.date),text:inner.text??null,payload:{update_id:update,...payload}} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    // 2025-11-03 14:12 UTC, 15:12 in Europe/Berlin.
    const T=1762179120,gp1={id:Number(A),type:'supergroup',title:'GP1'},mine={id:123,type:'private',first_name:'Sam'};
    const sam={id:123,is_bot:false,first_name:'Sam',username:'sam_owner'},bob={id:456,is_bot:false,first_name:'Bob',username:'bob_gp'};
    const say=(chat:Record<string,unknown>,from:Record<string,unknown>,text:string,at:number,more:Record<string,unknown>={})=>
      capture(String(chat.id),{message:{message_id:++messageId,date:at,chat,from,text,...more}});
    const question=await say(gp1,sam,'Bob, is your PIN still 4321?',T),answer=await say(gp1,bob,'yes',T+60),tea=await say(gp1,bob,'I like tea',T+3600);
    const gone=await say(gp1,bob,'Something Bob took back',T+120),own=await say(mine,sam,'Meeting with the bank at 3',T);
    const forward=await say(mine,sam,'The airline moved the flight to 07:25',T+86400*2,{forward_origin:{type:'channel',chat:{id:-1009,type:'channel',title:'Air X'},message_id:5,date:T}});
    await stores.control.query(`UPDATE owner_task_settings SET settings=jsonb_set(settings,'{time_zone}','"Europe/Berlin"') WHERE singleton`);

    // The space, its sessions and the receipts that wrote each message to Honcho, as ingestion leaves them.
    const binding=await s.guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    const keys={group:digest(`fact-sources:${run}:key:group`),owner:digest(`fact-sources:${run}:key:owner`)};
    for(const [key,audience,kind,id] of [[keys.group,A,'conversation',groupSession],[keys.owner,'owner','conversation',ownerSession],
      [materialSessionKey(engine.protocol),'owner','material',materialSession]])
      await stores.control.query('INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5)',[workspace,key,audience,kind,id]);
    const remote=(source:SourceReference)=>nid('r'+source.id),receipt=(source:SourceReference)=>digest(`fact-sources:${run}:receipt:${source.id}`);
    const write=(source:SourceReference,peer:string,audience:string,sessionId:string,retired=false)=>stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,
      source_reference,source_references,guard_source_id,prepared_id,content_hash,state,remote_id,session_id,audience,peer_id,peer_ids,retired_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'done',$8,$9,$10,$11,$12,$13)`,[receipt(source),workspace,JSON.stringify(source),JSON.stringify([source]),'events:'+source.id,
      digest('prepared:'+source.id),digest('fixture'),remote(source),sessionId,audience,peer,JSON.stringify([peer]),retired?new Date():null]);
    const BOB='person_bob',OWNER='person_owner';
    await write(question,OWNER,A,groupSession);await write(answer,BOB,A,groupSession);await write(tea,BOB,A,groupSession);
    await write(gone,BOB,A,groupSession,true);await write(own,OWNER,'owner',ownerSession);await write(forward,materialPeer,'owner',materialSession);
    let created=T;
    const learn=(peer:string,sessionId:string,content:string,cites:SourceReference[]|null,id=nid('c'+content))=>{
      conclusions.push({id,content,observer_id:peer,observed_id:peer,level:'explicit',session_id:sessionId,times_derived:1,created_at:honchoTime(created+=10),
        source_message_ids:cites?cites.map(remote):null});return id;
    };
    // Bob says "yes" to the owner's question: the fact about Bob cites [the question, his answer] (H1).
    const pin=learn(BOB,groupSession,'Bob\'s PIN is still 4321',[question,answer]);
    learn(BOB,groupSession,'Bob likes tea',[tea]);
    learn(BOB,groupSession,'Bob took something back',[gone]);
    const batch=learn(BOB,groupSession,'Bob answers questions',null);batches.set(batch,[{message_id:remote(answer),receipt_id:receipt(answer)}]);
    // A fact in the group's session citing the owner's private message: the group's receipts never reach it.
    learn(BOB,groupSession,'Bob knows the bank time',[own]);
    learn(OWNER,ownerSession,'The owner meets the bank at 3',[own]);
    learn(materialPeer,materialSession,'The flight moved to 07:25',[forward]);

    const current={row:{id:workspace,root_reference:answer,state:'ready'},binding,principal:{}};
    (s.memory as any).current=async()=>current;
    (s.memory as any).contexts.entities.context=(async(source:SourceReference)=>source.id===own.id||source.id===forward.id?
      {session_id:keys.owner,speaker:{id:'owner',kind:'person'},project:null,mentioned_projects:[],mentioned_people:[]}:
      {session_id:keys.group,speaker:{id:'bob',kind:'person'},project:null,mentioned_projects:[],mentioned_people:[]}) as any;
    const records=async()=>new Set((await stores.derived.query("SELECT operation_id FROM derived_artifacts WHERE provenance->'configuration'->>'workspace'=$1",[workspace])).rows.map(row=>row.operation_id));
    const row=async(id:string)=>(await stores.derived.query('SELECT provenance,configuration_hash FROM derived_artifacts WHERE id=$1',[id])).rows[0];
    // A block's facts live on its raw parent, which the guard never reads (M1).
    const bounded=async(id:string)=>row((await row(id)).provenance.parents[0].id);

    // A group turn: its speaker's facts in its own session, by Telegram's names, in UTC.
    summaryMessage=remote(tea);
    const group=await (s.memory as any).sessionContext(current,A,answer,false);
    const groupText:string=group.text;
    assert.match(groupText,/^\[conversation summary, through 2025-11-03\]\nSummary of /,'the summary names the day of its last message');
    assert.match(groupText,/\nSource \[by=person\]: “Bob” · this chat · 2025-11-03\n {2}\d\. 14:13 Bob's PIN is still 4321 \(\+1 source\)\n/,
      'the fact about Bob names Bob, his time in UTC, and counts the owner\'s question it also cites');
    // Learned with its batch, of which Honcho keeps only Bob's "yes": where and when, never Bob as its sender (H1).
    assert.match(groupText,/\nSource \[by=person\] \(not exact; learned with other messages\): learned in this chat on 2025-11-03\n {2}\d\. 14:13 Bob answers questions\n/);
    assert.match(groupText,/\nSource \[by=person\] \(not exact; some of its messages are not available here\): not available here\n {2}\d\. --:-- Bob took something back\n {2}\d\. --:-- Bob knows the bank time/,
      'a retired message and one of the owner\'s private chat are never shown');
    for(const never of ['Europe/Berlin','the owner','15:13','Meeting with the bank','(@bob_gp)','(@sam_owner)'])assert.ok(!groupText.includes(never),'a group never reads '+never);
    const groupRecord=await bounded(group.record);
    assert.equal((await row(group.record)).provenance.facts,undefined,'the guarded record carries no source id');
    const facts=Object.fromEntries(groupRecord.provenance.facts.map((fact:any)=>[fact.conclusion,fact]));
    assert.deepEqual([facts[pin].sources,facts[pin].by,facts[pin].exact,facts[pin].complete,facts[pin].more],[[answer.id,question.id],'person',true,true,1]);
    assert.ok(!JSON.stringify(groupRecord.provenance).includes(own.id),'the group\'s record holds no id of the owner\'s private chat');
    assert.equal(group.exact,false);assert.ok(group.limitations.includes('some_facts_cite_only_their_batch'));
    assert.equal(groupRecord.provenance.summary_through,'2025-11-03');

    // The owner: the Tasks zone, "the owner", and the forwards and files under their origin.
    summaryMessage=null;
    const owner=await (s.memory as any).sessionContext(current,'owner',own,true);
    assert.match(owner.text,/\nSource \[by=owner\]: the owner · this chat · 2025-11-03\n {2}1\. 15:12 The owner meets the bank at 3$/);
    assert.equal(owner.exact,false);assert.deepEqual(owner.limitations,['summary_has_no_exact_citations'],'every fact is exact, but Honcho\'s summary cites nothing');
    assert.match(owner.material.text,/\nSource \[by=forward\]: the owner, forwarded from a channel shown as “Air X” · this chat · 2025-11-05\n {2}1\. 15:12 The flight moved to 07:25$/);

    // The same facts again reuse their records; a changed source is a new record, never a conflict (no 409).
    summaryMessage=remote(tea);
    const before=await records();
    const again=await (s.memory as any).sessionContext(current,A,answer,false);
    assert.equal(again.record,group.record);assert.deepEqual(await records(),before);
    conclusions.find(c=>c.id===pin)!.source_message_ids=[remote(answer)];
    const changed=await (s.memory as any).sessionContext(current,A,answer,false);
    assert.notEqual(changed.record,group.record);assert.ok([...await records()].some(id=>!before.has(id)));
    assert.deepEqual((await bounded(changed.record)).provenance.facts.find((fact:any)=>fact.conclusion===pin).sources,[answer.id]);
    // Prefetch runs the same builder, so the turn after it reads the prefetched records.
    learn(BOB,groupSession,'Bob prefers mornings',[tea]);
    assert.equal(await s.memory.prefetch(groupSession),true);
    const prefetched=await records(),turn=await (s.memory as any).sessionContext(current,A,answer,false);
    assert.deepEqual(await records(),prefetched,'the turn reuses what prefetch prepared');assert.match(turn.text,/Bob prefers mornings/);

    // Parity with Honcho's own selection: the block holds exactly the facts Honcho's context would (the newest 100 of the
    // speaker's, within the session), whatever other sessions hold.
    for(let n=0;n<110;n++)learn(BOB,groupSession,`Filler fact ${n}`,[tea]);
    for(let n=0;n<5;n++)learn(BOB,session('elsewhere'),`Elsewhere ${n}`,null);
    const full=await (s.memory as any).sessionContext(current,A,answer,false);
    const shown=(await bounded(full.record)).provenance.facts.map((fact:any)=>fact.conclusion);
    assert.equal(shown.length,100);assert.deepEqual(new Set(shown),new Set(represented.at(-1)),'the same fact ids as Honcho\'s representation');

    // A guard that rewrites a fact line: a group keeps only its summary (its prose can hold a conclusion drawn across
    // chats, ADR-0298), said and counted.
    const counted=async()=>(await memoryProblems(stores.control)).find(row=>row.kind==='source_tags')?.failed??0,was=await counted();
    const guards=(s.memory as any).contexts.guards,read=guards.read.bind(guards);
    guards.read=(async(id:string,b:any)=>{const found=await read(id,b);const value=found.value as any;
      return typeof value?.text==='string'?{...found,value:{...value,text:value.text.replace(/^1\. \d\d:\d\d /m,'1. ')}}:found;}) as any;
    try {
      const fallback=await (s.memory as any).sessionContext(current,A,answer,false);
      assert.doesNotMatch(fallback.text,/what is known about the speaker/,'no prose in a group');
      assert.deepEqual(fallback.limitations,['representation_has_no_exact_citations','source_tags_unavailable']);
      assert.equal(await counted(),was+1);
    } finally {guards.read=read;}
  } finally {
    await stores.control.query('UPDATE owner_task_settings SET settings=$1 WHERE singleton',[JSON.stringify(zone)]).catch(()=>{});
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});
