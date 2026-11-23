import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';

/** Honcho's ids: 21 characters. */
const nid=(name:string)=>name.replace(/[^A-Za-z0-9]/g,'').padEnd(21,'0').slice(0,21);
const honchoTime=(seconds:number)=>new Date(seconds*1000).toISOString().replace('Z','000Z');

test('a recall\'s facts open by their record and number until a source is retired, and every record resting on a retired message is reported for native history (ADR-0261)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-fact-opening-'));
  // A synthetic group GP1 (A) and another, GP2 (B); the owner is account 123.
  const run=Date.now(),A='-100'+run,B='-200'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A,B],topic_memory:'group'};
  const workspace=digest('fact-opening:'+run),session=(name:string)=>digest(`fact-opening:${run}:session:${name}`);
  const first=session('first'),second=session('second');
  type Conclusion={id:string;content:string;observer_id:string;observed_id:string;level:'explicit';session_id:string;times_derived:number;created_at:string;source_message_ids:string[]|null};
  const conclusions:Conclusion[]=[],batches=new Map<string,{message_id:string;receipt_id:string}[]>();let evidence:string[]=[];
  // A wall's copies of facts are its own, observed by the wall (ADR-0282); here they keep the copied fact's id.
  const walls=new Map<string,Set<string>>();
  const engine=honchoEngine(async(path:string,body:any)=>{
    const scope=/\/scopes\/([^/]+)\/(sessions|status)$/.exec(path);
    if(path.endsWith('/scopes'))return {};
    if(scope?.[2]==='sessions'){for(const id of body.session_ids)(walls.get(scope[1]!)??walls.set(scope[1]!,new Set()).get(scope[1]!)!).add(id);return {};}
    if(scope?.[2]==='status')return {backfill_status:{}};
    if(path.endsWith('/chat'))return {content:'Bob gave his PIN and likes tea.',evidence:{conclusions:evidence.map(id=>({id})),messages:[],tool_calls:[]}};
    if(path.includes('/conclusions/list')) {
      const f=body.filters,size=Number(new URL('http://h'+path).searchParams.get('size'));
      const wall=String(f.observer_id).startsWith('scope.')?walls.get(f.observer_id.slice(6))??new Set():null;
      const items=conclusions.flatMap(c=>wall&&c.observer_id===c.observed_id&&wall.has(c.session_id)?[{...c,observer_id:f.observer_id}]:[c]).filter(c=>c.observer_id===f.observer_id&&c.observed_id===f.observed_id&&c.level===f.level&&(!f.session_id||f.session_id.in.includes(c.session_id))&&
        (!f.id||f.id.in.includes(c.id)));
      return {items:items.slice(0,size),next_page:items.length>size?'next':null};
    }
    // The uncited fact names its whole batch, which Honcho keeps of the observed peer's messages only (H1).
    if(path.endsWith('/nocheh/provenance')&&body.per_node)return {roots:body.conclusion_ids,nodes:body.conclusion_ids.map((id:string)=>({id,parents:[],deleted:false,
      exact_citations:batches.has(id)?false:null,messages:batches.get(id)??[],messages_truncated:false})),messages:[],limitations:[],exact_citations:false};
    throw Error('unexpected honcho call '+path);
  });
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,runtime:async()=>({literals:[]}),memoryEngine:engine});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0,messageId=0;
    const capture=async(scope:string,payload:Record<string,any>):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message;
      const value={version:1,key:`fact-opening:${run}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(inner.message_id),
        revision:String(update),occurred_at:String(inner.date),text:inner.text??null,payload:{update_id:update,...payload}} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    const T=1762179120,gp1={id:Number(A),type:'supergroup',title:'GP1'};
    const sam={id:123,is_bot:false,first_name:'Sam'},bob={id:456,is_bot:false,first_name:'Bob'};
    const say=(from:Record<string,unknown>,text:string,at:number)=>capture(A,{message:{message_id:++messageId,date:at,chat:gp1,from,text}});
    const question=await say(sam,'Bob, is your PIN still 4321?',T),answer=await say(bob,'yes',T+60),later=await say(bob,'and it stays so',T+90);
    const tea=await say(bob,'I like tea',T+3600),named=await say(bob,'I bake bread',T+7200),quiet=await say(bob,'something I took back',T+7300);

    const binding=await s.guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    for(const [key,id] of [[digest(`fact-opening:${run}:key:first`),first],[digest(`fact-opening:${run}:key:second`),second]])
      await stores.control.query('INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5)',[workspace,key,A,'conversation',id]);
    const remote=(source:SourceReference)=>nid('r'+source.id),receipt=(source:SourceReference)=>digest(`fact-opening:${run}:receipt:${source.id}`);
    const write=(source:SourceReference,peer:string,sessionId:string)=>stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,
      source_reference,source_references,guard_source_id,prepared_id,content_hash,state,remote_id,session_id,audience,peer_id,peer_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,'done',$8,$9,$10,$11,$12)`,[receipt(source),workspace,JSON.stringify(source),JSON.stringify([source]),'events:'+source.id,
      digest('prepared:'+source.id),digest('fixture'),remote(source),sessionId,A,peer,JSON.stringify([peer])]);
    const BOB='person_bob',OWNER='person_owner';
    await write(question,OWNER,first);await write(answer,BOB,first);await write(later,BOB,first);await write(tea,BOB,first);
    await write(named,BOB,second);await write(quiet,BOB,second);
    let created=T;
    const learn=(sessionId:string,content:string,cites:SourceReference[]|null)=>{const id=nid('c'+content);
      conclusions.push({id,content,observer_id:BOB,observed_id:BOB,level:'explicit',session_id:sessionId,times_derived:1,created_at:honchoTime(created+=10),
        source_message_ids:cites?cites.map(remote):null});return id;};
    // The PIN fact cites three messages; its result lists two of them, Bob's own first, never the owner's question.
    const pin=learn(first,'Bob PIN is still 4321',[answer,question,later]),likes=learn(first,'Bob likes tea',[tea]);
    // An uncited fact names one message of its batch in the second session, not all of it.
    const bakes=learn(second,'Bob bakes',null);batches.set(bakes,[{message_id:remote(named),receipt_id:receipt(named)}]);
    evidence=[bakes,pin,likes];

    const current={row:{id:workspace,root_reference:answer,state:'ready',last_ready_at:new Date()},binding,principal:{}};
    // The current binding, as storage reads it: a retirement moves its epoch.
    Object.assign(s.memory as any,{current:async()=>({...current,binding:await s.guards.state()}),workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],
      connectedPeers:async()=>({items:[{peer:BOB,path:'speaker → Bob'}],partial:false})});
    const reader={admin:false,scope:A,space:A,turnEvent:answer.id,generation:binding.generation,guard_epoch:binding.epoch} as Reader;
    // A later turn's reader, under the binding a retirement moved on.
    const turn=async()=>{const now=await s.guards.state();return {...reader,generation:now.generation,guard_epoch:now.epoch} as Reader;};
    const result=await s.memory.recall(reader,'What is Bob\'s PIN?') as any,recalled=result.sources.at(-1);
    assert.match(recalled.source,/^nocheh:memory:[a-f0-9]{64}$/);assert.match(recalled.facts_source,/^nocheh:memory:[a-f0-9]{64}$/);
    const answerRecord=recalled.source.slice(14),factsRecord=recalled.facts_source.slice(14);
    assert.deepEqual(recalled.facts.map((fact:any)=>[fact.n,fact.text,fact.exact,fact.by,fact.sources.map((item:any)=>item.source),fact.more]),[
      [1,'Bob PIN is still 4321',true,'person',['nocheh:event:'+answer.id,'nocheh:event:'+later.id],1],
      [2,'Bob likes tea',true,'person',['nocheh:event:'+tea.id],0],[3,'Bob bakes',false,'person',['nocheh:event:'+named.id],0]],
      'cited facts first, each with its first two sources tagged, the one it is about first');
    assert.match(recalled.facts[0].sources[0].tag,/^“Bob” · this chat · 2025-11-03 14:13 UTC$/);
    assert.ok(!JSON.stringify(recalled).includes(question.id),'the third source is not listed');
    // The batch fact names where and when it was learned, never Bob as its sender.
    assert.match(recalled.facts[2].sources[0].tag,/^learned in this chat on 2025-11-03 /);assert.equal(recalled.facts[2].sources[0].by,'unknown');
    // The record the model reads is guarded text only; its unguarded parent keeps every source (M1).
    const guardedRecord=(await stores.derived.query('SELECT provenance FROM derived_artifacts WHERE id=$1',[factsRecord])).rows[0].provenance;
    assert.equal(guardedRecord.facts,undefined);
    const stored=(await stores.derived.query('SELECT provenance FROM derived_artifacts WHERE id=$1',[guardedRecord.parents[0].id])).rows[0].provenance;
    assert.deepEqual(stored.facts[0].sources,[answer.id,later.id,question.id],'but stored, as every source is');
    assert.equal(stored.facts[2].complete,false,'a whole batch is never complete: other people\'s messages it rests on are not named');

    // Opened by its number, from the record's guarded copy; another group's reader never opens it.
    const opened=await s.memory.openFact(reader,factsRecord,1) as any;
    assert.deepEqual([opened.source,opened.fact,opened.text,opened.by,opened.exact,opened.sources.length,opened.more],
      ['nocheh:memory:'+factsRecord,1,'Bob PIN is still 4321','person',true,3,0]);
    assert.equal(opened.at,new Date((T+60)*1000).toISOString());
    const other={admin:false,scope:B,space:B,turnEvent:answer.id,generation:binding.generation,guard_epoch:binding.epoch} as Reader;
    await assert.rejects(s.memory.openFact(other,factsRecord,1),{code:'memory_fact_unavailable'});

    // Synthetic records of the kinds a turn reads, beside the recall's own: a recall answer resting on 200 messages, one of
    // them the owner's question; a per-turn block whose uncited fact names only part of the second session; the same fact named
    // completely; and a record of another kind, which never counts.
    const many=[...Array.from({length:199},(_,n)=>({store:'archive',kind:'event',id:digest(`fact-opening:${run}:unknown:${n}`),revision:'1',input_hash:digest('x')})),question];
    const record=async(name:string,kind:string,provenance:Record<string,unknown>,extra:Record<string,unknown>={},parents?:any[])=>(await s.derived.record({operation_id:`fact-opening:${run}:${name}`,
      source:answer,...parents?{parents}:{},kind:kind as any,content:Buffer.from(name),producer:'nocheh',producer_version:'fixture',configuration:{workspace,audience:A,...extra},provenance}));
    // A per-turn block: the bounded record the model reads, whose raw parent keeps the facts.
    const block=async(name:string,facts:unknown[])=>(await record(name,'memory_context',{limitations:[]},{facts_digest:digest(name)},
      [await record(name+':raw','memory_result',{facts,subject:BOB,limitations:[]})])).id;
    const recall200=(await record('recall-200','memory_result',{evidence:many,limitations:[]})).id;
    const partial=await block('partial',[{n:1,conclusion:bakes,exact:false,by:'person',sources:[named.id],more:0,complete:false,session:second}]);
    const whole=await block('whole',[{n:1,conclusion:likes,exact:true,by:'person',sources:[tea.id],more:0,complete:true,session:first}]);
    const input=(await record('input','memory_input',{evidence:[question]})).id;
    const ids=[answer.id,answerRecord,factsRecord,recall200,partial,whole,input];
    const before=await s.retirements.historyRetirements(ids);
    assert.deepEqual([before.retired,before.retired_records],[[],[]],'nothing is retired yet');

    // The owner retires the question, a source no row lists: the facts record and the 200-message answer go; the turn's own
    // message does not, nor the answer whose evidence never held it.
    const owner={admin:true,scope:null} as Reader;
    await s.retirements.set(owner,question.id,{retired:true,expected_revision:0,operation_id:`fact-opening:${run}:retire:question`});
    const after=await s.retirements.historyRetirements(ids);
    assert.deepEqual(after.retired_records,[factsRecord,recall200].sort());assert.deepEqual(after.retired,[factsRecord,recall200].sort());
    assert.notEqual(after.revision,before.revision);
    // Retire means forget at once: while the correction waits, nothing opens; once it is done, no fact of the record the
    // retired route reports opens either, so a row that opened one is withheld as surely as one that listed it.
    assert.equal(await (s.memory as any).correcting(await (s.memory as any).current(workspace)),true);
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,2),{code:'memory_fact_unavailable'},'a correction is pending');
    (s.memory as any).correcting=async()=>false;
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,1),{code:'memory_fact_unavailable'},'its third source is retired');
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,2),{code:'memory_fact_unavailable'},'another fact of the same record');
    assert.deepEqual((await s.memory.openFact(await turn(),factsRecord,null) as any).facts.map((fact:any)=>fact.unavailable===true),[true,true,true]);

    // A message of the second session that no fact names: the fact that names only part of that session goes with it.
    await s.retirements.set(owner,quiet.id,{retired:true,expected_revision:0,operation_id:`fact-opening:${run}:retire:quiet`});
    const session2=await s.retirements.historyRetirements(ids);
    assert.deepEqual(session2.retired_records,[factsRecord,partial,recall200].sort(),'the partial block and the recall whose third fact is partial; never the complete one');
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,3),{code:'memory_fact_unavailable'});
    // Restoring the question brings the 200-message answer back; the second session's retirement still holds the others.
    await s.retirements.set(owner,question.id,{retired:false,expected_revision:1,operation_id:`fact-opening:${run}:restore:question`});
    assert.deepEqual((await s.retirements.historyRetirements(ids)).retired_records,[factsRecord,partial].sort());
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,2),{code:'memory_fact_unavailable'},'the record still rests on a retired message');
    // Restoring the second session's message too: the record stands again, and a fact the engine still holds opens.
    await s.retirements.set(owner,quiet.id,{retired:false,expected_revision:1,operation_id:`fact-opening:${run}:restore:quiet`});
    assert.deepEqual((await s.retirements.historyRetirements(ids)).retired_records,[]);
    assert.equal((await s.memory.openFact(await turn(),factsRecord,2) as any).text,'Bob likes tea');
    // The engine deleted the tea fact (its session was rebuilt): it no longer opens.
    conclusions.splice(conclusions.findIndex(c=>c.id===likes),1);
    await assert.rejects(s.memory.openFact(await turn(),factsRecord,2),{code:'memory_fact_unavailable'});
  } finally {
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});
