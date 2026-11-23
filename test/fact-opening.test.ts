import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {guardedFactLine,recallFactText,recallFactTexts} from '../src/fact-block.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {mcpTools} from '../src/mcp/tools.js';
import {privateAnswerRoute} from '../src/stores/private-answers.js';
import {scopedRoute} from '../src/security/broker.js';
import {NativeMemoryRepository} from '../src/stores/native-memory.js';
import {memoryWallName} from '../src/stores/memory-walls.js';
import {factRecords} from '../src/stores/fact-sources.js';
import {installChatsForTest} from '../src/chats.js';
import {legacyDirectory} from './fixture-groups.js';

/*
 * A recalled fact names its sources and opens by its record and number (ADR-0261, B3.6, B5.2, B6.3): memory_recall lists the
 * facts its answers read and stores every one in a record of its own; archive_read nocheh:memory:<record> fact=<n> opens
 * any of them, from its guarded copy, only while it still stands.
 */

const hex=(name:string)=>digest('fact-opening:'+name);
/** A Honcho id: 21 characters. */
const nid=(name:string)=>name.replace(/[^A-Za-z0-9]/g,'').padEnd(21,'0').slice(0,21);
const ref=(id:string)=>({store:'archive',kind:'event',id,revision:'1',input_hash:digest(id)});
const GP1='-100',BOB='person_bob';

type Conclusion={id:string;content:string;session_id:string;source_message_ids:string[]|null;created_at:string};
/** A NativeMemoryRepository over mock stores and a Honcho that answers from `state`, for a group reader of GP1. */
function recallFixture(state:{conclusions:Conclusion[];evidence:string[];guard?:(text:string)=>string;failList?:boolean;
  receipts:Record<string,string[]>;unreadable?:string[];retired?:string[];retiredSessions?:string[];correcting?:boolean}) {
  const workspace=hex('workspace'),groupSessions=[hex('session-a'),hex('session-b')],root=ref(hex('root'));
  const lists:any[]=[],tagged:any[][]=[],problems:string[]=[],records=new Map<string,{id:string;kind:string;content:string;provenance:any;content_hash:string}>();
  const guarded=new Map<string,string>(),allowed:unknown[]=[];
  const engine=honchoEngine(async(path:string,body:any)=>{
    if(path.endsWith('/chat'))return {content:'Bob gave his PIN.',evidence:{conclusions:state.evidence.map(id=>({id})),messages:[],tool_calls:[]}};
    if(path.includes('/conclusions/list')) {
      lists.push(body.filters);if(state.failList)throw Error('honcho_down');
      const f=body.filters,size=Number(new URL('http://h'+path).searchParams.get('size'));
      const items=state.conclusions.filter(c=>(!f.id||f.id.in.includes(c.id))&&(!f.session_id||f.session_id.in.includes(c.session_id)))
        .map(c=>({...c,observer_id:f.observer_id,observed_id:f.observed_id,level:'explicit',times_derived:1}));
      return {items:items.slice(0,size),next_page:null};
    }
    if(path.endsWith('/nocheh/provenance'))return {roots:body.conclusion_ids,nodes:body.conclusion_ids.map((id:string)=>({id,parents:[],deleted:false,exact_citations:false,
      messages:[{message_id:nid('batch'),receipt_id:hex('receipt')}],messages_truncated:true})),messages:[],limitations:[],exact_citations:false};
    throw Error('unexpected honcho call '+path);
  });
  const control={query:async(sql:string,values:any[]=[])=>{
    if(sql.includes('FROM memory_generations WHERE installation_generation'))return {rows:[{id:workspace,state:'ready',last_ready_at:new Date()}]};
    if(sql.includes('FROM owner_commands'))return {rowCount:state.correcting?1:0,rows:state.correcting?[{}]:[]};
    if(sql.includes('FROM memory_session_deletions'))return {rowCount:0,rows:[]};
    if(sql.includes('r.peer_id=$2'))return {rowCount:0,rows:[]};
    if(sql.includes('memory_problem_days')){problems.push(sql.startsWith('INSERT')?'failed:'+values[0]:'done:'+values[0]);return {rows:[]};}
    if(sql.includes('remote_id=ANY')) {
      assert.equal(values[2],GP1,'the facts map through the group\'s own receipts');
      return {rows:values[1].flatMap((remote:string)=>state.receipts[remote]?[{remote_id:remote,peer_id:BOB,source_reference:ref(state.receipts[remote]![0]!),
        source_references:state.receipts[remote]!.map(ref)}]:[])};
    }
    throw Error('unexpected_control_query '+sql);
  }};
  // The retired route's rule, record by record (SourceRetirementRepository.retiredRecords), over the fixture's records.
  const retirements={retiredRecords:async(ids:readonly string[])=>{
    const found=await factRecords(derived.pool as any,ids);
    return new Set([...found.values()].filter(record=>record.facts.some(fact=>fact.sources.some(id=>state.retired?.includes(id))||
      fact.complete!==true&&typeof fact.session==='string'&&state.retiredSessions?.includes(fact.session))).map(record=>record.id));
  }};
  const access={stores:{control},policy:()=>({owner_id:'123'}),recall:(principal:Reader)=>({space:principal.space,group:GP1}),retirements,
    archive:{captured:async()=>({reference:root}),capturedMany:async(ids:readonly string[])=>new Map(ids.map(id=>[id,{reference:ref(id)}]))},
    readable:async(_p:Reader,refs:any[],_b:unknown,options:any)=>{assert.equal(options.historical,true);return new Map(refs.map(r=>[r.id,!state.unreadable?.includes(r.id)]));}};
  const contexts={access,guards:{
    prepareContext:async(reference:any)=>{const record=records.get(reference.id)!;guarded.set(record.id,(state.guard??(text=>text))(record.content));return null;},
    read:async(id:string)=>({value:{text:guarded.get(id.slice('derived_artifacts:'.length))??''}})}};
  const derived={record:async(input:any)=>{
    const id=digest(input.operation_id),content=String(input.content);
    records.set(id,{id,kind:input.kind,content,content_hash:digest(content),
      provenance:{...input.provenance,...input.parents?{parents:input.parents}:{},configuration:input.configuration}});
    return {store:'derived',kind:'artifact',id,input_hash:digest(content)};
  },pool:{query:async(sql:string,values:any[])=>{
    assert.match(sql,/kind IN \('memory_context','memory_result'\)|kind='memory_result'/,'only a block or a recall\'s records open');
    const kinds=sql.includes("kind='memory_result'")?['memory_result']:['memory_context','memory_result'];
    return {rows:(values[0] as string[]).flatMap(id=>{const found=records.get(id);return found&&kinds.includes(found.kind)?[found]:[];})};
  }}};
  const binding={generation:'g',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,root:async()=>root,allow:async(_p:unknown,value:unknown)=>{allowed.push(value);}};
  const provenance={sessions:async()=>groupSessions,read:async()=>({conclusions:[],evidence:[],limitations:[],exact_citations:true})};
  const notes={classesFor:async(ids:readonly string[])=>new Map(ids.map(id=>[id,{class:id===hex('question')?'owner_message':'person_message',facts:{}}]))};
  const tags={tags:async(_p:Reader,_b:unknown,refs:any[],options:any)=>{tagged.push(refs.map(r=>r.id));assert.equal(options.historical,true);
    return new Map(refs.map(r=>[r.id,{source:'nocheh:event:'+r.id,tag:'“Bob” · this chat · 2026-11-03 14:12',by:'person',at:'2026-11-03T14:12:00.000Z',
      ...options.place?{place:'learned in this chat on 2026-11-03 14:12'}:{}}]));}};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,prepared as any,provenance as any,engine,async()=>[],notes as any,tags as any);
  const current={row:{id:workspace,root_reference:root,state:'ready',last_ready_at:new Date()},binding,principal:{}};
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],current:async()=>current,
    connectedPeers:async()=>({items:[{peer:BOB,path:'speaker → Bob'}],partial:false}),
    // The group reads through its wall, which holds its two sessions (ADR-0284).
    wallStore:{of:async()=>[],open:async(id:string,chats:readonly string[])=>({wall:memoryWallName(id,chats),sessions:groupSessions})}});
  const reader={admin:false,scope:GP1,space:GP1,turnEvent:root.id} as Reader;
  return {memory,reader,records,lists,tagged,problems,allowed,workspace,groupSessions};
}
const conclusion=(name:string,cites:string[]|null,session=hex('session-a'),n=1):Conclusion=>({id:nid(name),content:'Fact '+name+'\nsecond line',session_id:session,
  source_message_ids:cites?cites.map(nid):null,created_at:new Date(Date.UTC(2026,10,3,14,n)).toISOString().replace('Z','000Z')});

test('a recall lists the facts its answer read with their sources, cited first, and keeps every one in a record its result names',async t=>{
  t.after(installChatsForTest(legacyDirectory([GP1],{owner:'123',served:[GP1]})));
  const [answer,question,tea,hidden]=['answer','question','tea','hidden'].map(hex) as [string,string,string,string];
  const batch=conclusion('batchfact',null,hex('session-b'),1),pin=conclusion('pinfact',['answer','question'],hex('session-a'),2),
    likes=conclusion('teafact',['tea','hidden'],hex('session-a'),3),elsewhere=conclusion('otherfact',['tea'],hex('session-z'),4);
  const fixture=recallFixture({conclusions:[batch,pin,likes,elsewhere],evidence:[batch.id,pin.id,likes.id,elsewhere.id,'not a fact'],
    receipts:{[nid('answer')]:[answer],[nid('question')]:[question],[nid('tea')]:[tea],[nid('hidden')]:[hidden],[nid('batch')]:[answer]},unreadable:[hidden]});
  const result=await fixture.memory.recall(fixture.reader,'What is Bob\'s PIN?') as any,source=result.sources.at(-1);
  const output=[...fixture.records.values()].find(record=>record.kind==='memory_result'&&record.content.startsWith('[related through'))!;
  const facts=[...fixture.records.values()].find(record=>Array.isArray(record.provenance.facts))!;
  const text=[...fixture.records.values()].find(record=>record.provenance.configuration?.facts==='recall')!;
  assert.deepEqual(Object.keys(source).slice(0,2),['source','facts_source'],'both record ids come before the answer\'s text');
  assert.equal(source.source,'nocheh:memory:'+output.id,'the answer is named by its own record, not the memory space');
  assert.equal(source.facts_source,'nocheh:memory:'+text.id,'the record the model reads is the guarded text');
  // Only the text lines are guarded: every source id stays on its unguarded parent (M1).
  assert.deepEqual([text.provenance.facts,text.provenance.parents[0].id,text.content],[undefined,facts.id,facts.content]);
  assert.ok(!('evidence_sources' in source),'the facts list replaces the archived-message list');
  assert.deepEqual(fixture.lists.at(-1),{observer_id:'scope.'+memoryWallName(fixture.workspace,[GP1]),observed_id:BOB,level:'explicit',
    id:{in:[batch.id,pin.id,likes.id,elsewhere.id]},session_id:{in:fixture.groupSessions}},
    'the facts are read by id as the wall\'s own copies, within the sessions the group\'s recall asked (ADR-0284)');
  assert.equal(source.evidence_count,3,'a fact outside the group\'s sessions is never read');
  assert.deepEqual(source.facts.map((fact:any)=>[fact.n,fact.text,fact.exact,fact.by,fact.more]),[
    [1,'Fact pinfact second line',true,'person',0],[2,'Fact teafact second line',false,'person',0],[3,'Fact batchfact second line',false,'person',0]],
    'cited facts first, then the engine\'s order; a fact with an unreadable source is not exact');
  assert.deepEqual(source.facts[0].sources.map((item:any)=>item.source),['nocheh:event:'+answer,'nocheh:event:'+question],'Bob\'s own message first, then the question it answers');
  // A batch fact names where and when it was learned, never Bob as its sender (H1).
  assert.deepEqual(source.facts[2].sources,[{source:'nocheh:event:'+answer,tag:'learned in this chat on 2026-11-03 14:12',by:'unknown'}]);
  assert.deepEqual(fixture.tagged,[[answer,question,tea,answer]],'one tag request, for the listed sources only, never an unreadable one');
  assert.equal(facts.content,'1. Fact pinfact second line\n2. Fact teafact second line\n3. Fact batchfact second line');
  assert.deepEqual(facts.provenance.facts.map((fact:any)=>[fact.n,fact.conclusion,fact.peer,fact.sources,fact.complete]),[
    [1,pin.id,BOB,[answer,question],true],[2,likes.id,BOB,[tea,hidden],true],[3,batch.id,BOB,[answer],false]],
    'every source is stored, the unreadable one too, so its retirement is found; a batch named only in part says so');
  assert.equal(facts.provenance.facts[2].session,hex('session-b'),'and keeps its session, whose retired messages count for it');
  assert.deepEqual([facts.provenance.configuration.audience,facts.provenance.configuration.workspace],[GP1,fixture.workspace]);
  assert.ok(source.limitations.includes('some_facts_cite_only_their_batch'));
  assert.ok(fixture.allowed.some(value=>JSON.stringify(value).includes('Fact pinfact second line')),'the guarded fact texts may be quoted');
  assert.deepEqual(fixture.problems,[],'the tag request counts itself; a recall never counts it twice');

  // A guard that changes the lines drops the texts, never the record, and says so; it is counted.
  const changed=recallFixture({conclusions:[pin],evidence:[pin.id],receipts:{[nid('answer')]:[answer],[nid('question')]:[question]},guard:text=>text.replace('1. ','1) ')});
  const dropped=(await changed.memory.recall(changed.reader,'PIN?') as any).sources.at(-1);
  assert.equal(dropped.facts[0].text,undefined);assert.match(dropped.facts_source,/^nocheh:memory:[a-f0-9]{64}$/);
  assert.ok(dropped.limitations.includes('fact_text_unavailable'));assert.deepEqual(changed.problems,['failed:source_tags']);
  // A failed read of the facts lists the archived messages, as before, and is counted.
  const down=recallFixture({conclusions:[pin],evidence:[pin.id],receipts:{},failList:true});
  const fallback=(await down.memory.recall(down.reader,'PIN?') as any).sources.at(-1);
  assert.deepEqual([fallback.evidence_sources,fallback.facts,fallback.facts_source],[[],undefined,undefined]);
  assert.ok(fallback.limitations.includes('recall_facts_unavailable'));assert.deepEqual(down.problems,['failed:source_tags']);
  assert.match(fallback.source,/^nocheh:memory:[a-f0-9]{64}$/);
});

test('a recall lists 12 facts and stores all it read, up to 200, each openable by its number',async t=>{
  t.after(installChatsForTest(legacyDirectory([GP1],{owner:'123',served:[GP1]})));
  const many=Array.from({length:205},(_,n)=>conclusion('f'+String(n).padStart(3,'0')+'x',['tea'],hex('session-a'),n%60));
  const fixture=recallFixture({conclusions:many,evidence:many.map(item=>item.id),receipts:{[nid('tea')]:[hex('tea')]}});
  const source=(await fixture.memory.recall(fixture.reader,'Everything about Bob?') as any).sources.at(-1);
  assert.equal(source.facts.length,12);assert.equal(source.evidence_count,200);assert.ok(source.limitations.includes('recall_fact_limit'));
  const record=source.facts_source.slice('nocheh:memory:'.length);
  const opened=await fixture.memory.openFact(fixture.reader,record,150) as any;
  assert.deepEqual([opened.source,opened.fact,opened.text],[source.facts_source,150,'Fact f149x second line'],'a fact beyond the 12 listed opens too');
  await assert.rejects(fixture.memory.openFact(fixture.reader,record,201),{code:'memory_fact_unavailable'});
});

test('a fact opens from its record\'s guarded copy, only while it stands: its audience, nothing correcting, held by the engine, no source retired',async t=>{
  t.after(installChatsForTest(legacyDirectory([GP1,'-200'],{owner:'123',served:[GP1,'-200']})));
  const [answer,question,unlisted]=['answer','question','unlisted'].map(hex) as [string,string,string];
  const pin=conclusion('pinfact',['answer','question','unlisted']),batch=conclusion('batchfact',null,hex('session-b'));
  const state:Parameters<typeof recallFixture>[0]={conclusions:[pin,batch],evidence:[pin.id,batch.id],guard:text=>text.replace('pinfact','[guarded]'),
    receipts:{[nid('answer')]:[answer],[nid('question')]:[question],[nid('unlisted')]:[unlisted],[nid('batch')]:[answer]}};
  const fixture=recallFixture(state),source=(await fixture.memory.recall(fixture.reader,'PIN?') as any).sources.at(-1);
  const record=source.facts_source.slice('nocheh:memory:'.length);
  const opened=await fixture.memory.openFact(fixture.reader,record,1) as any;
  assert.deepEqual(opened,{source:source.facts_source,fact:1,text:'Fact [guarded] second line',exact:true,by:'person',at:'2026-11-03T14:12:00.000Z',
    sources:[answer,question,unlisted].map(id=>({source:'nocheh:event:'+id,tag:'“Bob” · this chat · 2026-11-03 14:12',by:'person'})),more:0},
    'its text from the guarded copy, its sources as this reader may read them, the one its line names first');
  const listed=await fixture.memory.openFact(fixture.reader,record,null) as any;
  assert.deepEqual(listed,{source:source.facts_source,count:2,facts:[{n:1,by:'person',tag:'“Bob” · this chat · 2026-11-03 14:12'},{n:2,by:'person',tag:'learned in this chat on 2026-11-03 14:12'}]},
    'a batch fact names where and when it was learned, never its sender');

  const refused=async(reader:Reader,n:number|null,why:string)=>assert.rejects(fixture.memory.openFact(reader,record,n),{code:'memory_fact_unavailable'},why);
  await refused({admin:false,scope:'-200',space:'-200',turnEvent:hex('root')} as Reader,1,'another group never opens GP1\'s record');
  await refused({...fixture.reader,answer:hex('answer-record')} as Reader,1,'a private answer opens no fact');
  await refused({...fixture.reader,member:hex('member')} as Reader,1,'a member\'s private chat opens no fact');
  await refused({...fixture.reader,memberRead:hex('ask').slice(0,32)} as Reader,1,'the owner\'s ask about a member opens no fact');
  await refused(fixture.reader,3,'a number beyond the stored facts');
  const owner=await fixture.memory.openFact({admin:false,scope:null,turnEvent:hex('root')} as unknown as Reader,record,1) as any;
  assert.equal(owner.fact,1,'the owner opens any audience\'s record');
  // A source that no row lists, retired: the fact is forgotten at once. The retired route withholds every row citing the
  // record, so no fact of it opens either, whatever the order of later retirements (LOW 3).
  state.retired=[unlisted];await refused(fixture.reader,1,'a retired source, listed or not');
  assert.deepEqual((await fixture.memory.openFact(fixture.reader,record,null) as any).facts,[{n:1,unavailable:true},{n:2,unavailable:true}]);
  await refused(fixture.reader,2,'another fact of a record the retired route forgets');
  state.retired=[];
  // A fact that names only part of its batch: any retired message of its session counts.
  state.retiredSessions=[hex('session-b')];await refused(fixture.reader,2,'an incomplete fact in a session with a retired message');
  await refused(fixture.reader,1,'and the record with it');
  state.retiredSessions=[];
  state.correcting=true;await refused(fixture.reader,1,'while a correction is pending');state.correcting=false;
  // The engine deleted the fact (a correction rebuilt its session): it no longer opens.
  state.conclusions=[batch];await refused(fixture.reader,1,'a fact the engine no longer holds');
  assert.equal((await fixture.memory.openFact(fixture.reader,record,2) as any).fact,2);
  // A record of another kind, or of another memory space, never opens.
  const input=[...fixture.records.values()].find(item=>item.kind==='runtime_context')!;
  await assert.rejects(fixture.memory.openFact(fixture.reader,input.id,1),{code:'memory_fact_unavailable'});
  // The raw record that keeps the sources is never opened by its own id.
  await assert.rejects(fixture.memory.openFact(fixture.reader,fixture.records.get(record)!.provenance.parents[0].id,2),{code:'memory_fact_unavailable'});
  fixture.records.get(record)!.provenance.configuration.workspace=hex('older-space');await refused(fixture.reader,2,'a record of an earlier memory space');
});

test('a per-turn block\'s fact opens without its time, and a guard that moved its line gives no text and is counted',async()=>{
  const block='Summary\n\n1. 14:00 Fact one\n2. --:-- Fact two';
  assert.equal(guardedFactLine(block,2,1,'14:00'),'Fact one');assert.equal(guardedFactLine(block,2,2,null),'Fact two');
  assert.equal(guardedFactLine(block,2,1,'14:01'),null,'its own time, or no text');assert.equal(guardedFactLine(block,2,3,null),null);
  assert.equal(guardedFactLine('1. a\n2. b',2,2),'b');assert.equal(guardedFactLine('1. a\n2) b',2,2),null);
  assert.equal(recallFactText([{n:1,content:'a\nb'},{n:2,content:'c'}]),'1. a b\n2. c');
  assert.deepEqual(recallFactTexts('1. a b\n2. c',2),['a b','c']);assert.equal(recallFactTexts('1. a\n2. c\n',2),null,'as many lines as facts');
});

test('archive_read opens a recalled fact by its record and number and repeats the record in every answer',async()=>{
  const id=hex('record'),calls:string[]=[];
  const context=(answer:unknown)=>({principal:{admin:false,scope:GP1,space:GP1},isolated:true,pause:async()=>{},
    call:async(_method:string,path:string)=>{calls.push(path);return answer==='refused'?{status:404,body:{error:'memory_fact_unavailable'}}:{status:200,body:answer};}}) as any;
  const tool=mcpTools.find(item=>item.name==='archive_read')!;
  const run=async(args:Record<string,unknown>,answer:unknown)=>JSON.parse(await tool.run(args as any,context(answer)) as any);
  const opened=await run({id:'nocheh:memory:'+id,fact:3},{source:'nocheh:memory:'+'0'.repeat(64),fact:3,text:'x'.repeat(2500),sources:[]});
  assert.equal(calls.at(-1),'/v1/memory/facts/'+id+'/3');
  assert.equal(opened.source,'nocheh:memory:'+id,'the result names the record it opened, whatever storage said');
  assert.ok(opened.text.length<=2000);
  await run({id:'nocheh:memory:'+id},{source:'nocheh:memory:'+id,count:1,facts:[]});assert.equal(calls.at(-1),'/v1/memory/facts/'+id);
  for(const args of [{id:'nocheh:memory:'+id,fact:0},{id:'nocheh:memory:'+id,fact:201},{id:'nocheh:memory:'+id,fact:'3'},{id:'nocheh:memory:'+id.slice(1)}])
    assert.deepEqual(await run(args,{}),{error:'archive_source_unavailable'},JSON.stringify(args));
  assert.deepEqual(await run({id:'nocheh:memory:'+id,fact:1},'refused'),{error:'archive_source_unavailable'});
  assert.match(tool.description,/id=nocheh:memory:<id> fact=<n>/);
  assert.match(mcpTools.find(item=>item.name==='memory_recall')!.description,/archive_read id=<facts_source> fact=<n>/);
  // Not a private answer's route; the broker relays it for everyone else.
  for(const path of ['/v1/memory/facts/'+id,'/v1/memory/facts/'+id+'/3']) {
    assert.equal(privateAnswerRoute('GET',path),false,path);assert.equal(scopedRoute('GET',path),true,path);
  }
  for(const path of ['/v1/memory/facts/'+id+'/0','/v1/memory/facts/'+id+'/1000','/v1/memory/facts'])assert.equal(scopedRoute('GET',path),false,path);
});
