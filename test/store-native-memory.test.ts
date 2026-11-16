import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {NativeMemoryRepository,assistantPeer,materialPeer,materialSessionKey} from '../src/stores/native-memory.js';
import type {SourceReference} from '../src/stores/archive.js';
import {captureEvidence} from '../src/stores/generated-capture.js';
import {honchoPointer,honchoSource} from '../src/source-labels.js';
import {HttpError} from '../src/http.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installChatsForTest} from '../src/chats.js';
import {legacyDirectory} from './fixture-groups.js';

/** The chats the recall and search cases below name, as the seeder makes their rows (ADR-0252). */
const recallChats=()=>legacyDirectory(['-100','-100/topic/3','-200'],{owner:'123',served:['-100','-200']});
/** Control answers for recall cases where the owner's forwards and files hold nothing learned. */
const nothingForwarded={query:async(sql:string)=>{if(sql.includes('r.peer_id=$2'))return {rowCount:0,rows:[]};throw Error('unexpected_control_query');}};

test('reply context reads Honcho on arrival, limits other audiences to their own session and reuses identical guarded results',async()=>{
  const workspace=digest('installation-workspace'),groupSession=digest('group-session'),ownerSession=digest('owner-session');
  const root={store:'archive',kind:'event',id:digest('root'),revision:'1',input_hash:digest('root-hash')};
  const sessions:Record<string,{session_id:string;audience:string}>={[digest('group-key')]:{session_id:groupSession,audience:'-100'},[digest('owner-key')]:{session_id:ownerSession,audience:'owner'}};
  let key=digest('group-key'),fail=false,failForwards=false,uncorrected=false,deleting=false;const calls:string[]=[],records:string[]=[],contents:string[]=[];let prepared=0;
  const control={query:async(sql:string,values:any[]=[])=>{
    if(sql.includes('FROM owner_commands'))return {rowCount:uncorrected?1:0,rows:uncorrected?[{}]:[]};
    if(sql.includes('FROM memory_session_deletions'))return {rowCount:deleting?1:0,rows:deleting?[{}]:[]};
    if(sql.includes('FROM memory_generations WHERE installation_generation'))return {rows:[{id:workspace,state:'ready',last_ready_at:new Date()}]};
    if(sql.startsWith('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2 AND audience=$3')) {
      const found=sessions[values[1]];return {rows:found&&found.audience===values[2]?[found]:[]};
    }
    if(sql.includes("count(*) FILTER (WHERE state='done')"))return {rows:[{done:1,pending:0}]};
    // Whether the forwards and files wrote anything is read by the writer's own column, which an index covers.
    if(sql.includes("state='done'\n      AND peer_id=$2 LIMIT 1"))return {rowCount:1,rows:[{}]};
    if(sql.includes('peer_ids ? $2 AND ($3::text IS NULL OR session_id=$3)'))return {rowCount:1,rows:[{}]};
    throw Error('unexpected_control_query '+sql);
  }};
  const contexts={access:{stores:{control},policy:()=>({owner_id:'123'}),archive:{captured:async()=>({reference:root})}},
    entities:{context:async()=>({session_id:key,speaker:{id:'speaker',kind:'person'},project:null,mentioned_projects:[],mentioned_people:[]})},
    guards:{prepareContext:async()=>{prepared++;return null;},read:async()=>({value:{text:'Guarded Honcho context'}})}};
  const derived={record:async(input:any)=>{records.push(input.operation_id);contents.push(String(input.content));return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const audience={assert:async()=>({generation:'fixture',epoch:1,mode:'on'})};
  const engine=honchoEngine(async(path:string)=>{
    calls.push(path);if(fail||failForwards&&path.includes(materialPeer))throw Error('honcho_down');
    return {summary:{content:'Conversation summary'},peer_representation:'What the speaker said',peer_card:['Prefers mornings'],messages:[{content:'never used'}]};
  });
  const memory=new NativeMemoryRepository(contexts as any,derived as any,{audience,allow:async()=>{}} as any,{} as any,engine,async()=>[]);
  (memory as any).current=async()=>({row:{id:workspace,root_reference:root,state:'ready'},binding:{generation:'fixture',epoch:1,mode:'on'},principal:{}});
  const group={admin:false,scope:'-100',space:'-100',turnEvent:root.id} as Reader;
  const first=await memory.context(group);
  assert.equal(first.limited_memory,false);assert.equal(first.sources[0]?.text,'Guarded Honcho context');
  assert.match(calls[0]!,new RegExp('/v3/workspaces/'+workspace+'/sessions/'+groupSession+'/context\\?'));
  assert.match(calls[0]!,/peer_target=person_speaker/);assert.match(calls[0]!,/limit_to_session=true/,'a group turn never reads the speaker\'s whole representation');
  assert.equal(calls.length,1,'a group turn reads no forwards and files');assert.equal((first.sources[0] as any).about,undefined);
  assert.equal(contents[0],'[conversation summary]\nConversation summary\n\n[what is known about the speaker]\nWhat the speaker said');
  const before=records.length;await memory.context(group);
  assert.deepEqual(records.slice(before),records.slice(0,before),'identical Honcho output reuses its guarded result, so a prefetch serves the next turn');
  assert.equal(calls.length,2,'every turn checks Honcho freshness on arrival; nothing is saved behind a timer');
  key=digest('owner-key');const ownerStart=calls.length;
  const owner=await memory.context({admin:false,scope:null,space:'123',turnEvent:root.id} as Reader);
  const ownerRead=calls.slice(ownerStart).find(path=>path.includes('/context?'))!;
  assert.equal(owner.limited_memory,false);assert.match(ownerRead,new RegExp(ownerSession));assert.doesNotMatch(ownerRead,/limit_to_session/);
  // Before the owner's forwards session holds anything, what their participant learned is read from its profile.
  assert.deepEqual(calls.slice(ownerStart).filter(path=>!path.includes('/context?')),['/v3/workspaces/'+workspace+'/peers/'+materialPeer+'/representation']);
  // A peer card summarizes a person across every session: no context Nocheh reads carries one, even one Honcho returned.
  assert.ok(contents.some(text=>text.includes('What the speaker said')));
  assert.ok(!contents.some(text=>text.includes('Prefers mornings')),'no peer card, for the owner or a group');
  // An owner turn reads the owner's forwards and files beside the private chat, side by side, as a block of its own.
  const materialSession=digest('material-session'),ownerReader={admin:false,scope:null,space:'123',turnEvent:root.id} as Reader;
  sessions[materialSessionKey(engine.protocol)]={session_id:materialSession,audience:'owner'};
  let asked=calls.length,written=contents.length;
  const both=await memory.context(ownerReader) as any,reads=calls.slice(asked);
  assert.equal(reads.length,2);assert.ok(reads.some(path=>path.includes('/sessions/'+ownerSession+'/context?')));
  const forwards=reads.find(path=>path.includes('/sessions/'+materialSession+'/context?'))!;
  assert.match(forwards,/peer_target=nocheh_forwards_and_files/);assert.match(forwards,/tokens=2000/);assert.doesNotMatch(forwards,/limit_to_session/,'the forwards and files span the space');
  assert.deepEqual(both.sources.map((source:any)=>[source.about,source.limitations]),[['owner',['representation_has_no_exact_citations']],
    ['forwards_and_files',['representation_has_no_exact_citations']]]);
  assert.deepEqual([...new Set(contents.slice(written))].sort(),[
    '[conversation summary]\nConversation summary\n\n[what is known about the owner; it may include conclusions drawn from things the owner forwarded or sent]\nWhat the speaker said',
    '[summary of messages the owner forwarded from other people]\nConversation summary\n\n[from forwards (other people\'s words) and files the owner sent (their contents, not the owner\'s typed words)]\nWhat the speaker said'].sort(),
    'each block is guarded on its own, under a header that says what it is');
  // When only the forwards and files cannot be read, the owner's block stays and says so, so the turn's parent counts it.
  failForwards=true;
  const partial=await memory.context(ownerReader) as any;
  assert.equal(partial.limited_memory,false);assert.deepEqual(partial.sources.map((source:any)=>source.about),['owner']);
  assert.ok(partial.sources[0].limitations.includes('forwards_unavailable'));
  // A job's run reads what it read before: the private chat only.
  failForwards=false;asked=calls.length;
  const job=await memory.context({...ownerReader,logical_profile:'job-fixture'} as Reader) as any;
  assert.equal(calls.length,asked+1);assert.deepEqual(job.sources.map((source:any)=>source.about),[undefined]);
  delete sessions[materialSessionKey(engine.protocol)];
  const calledBefore=calls.length;
  const crossed=await memory.context(group);
  assert.deepEqual(crossed.sources,[],'a group turn cannot read an owner-private session');assert.equal(calls.length,calledBefore);
  key=digest('group-key');
  // A retired message stays in Honcho's summaries until its session is rebuilt and the old one deleted.
  for(const [owner,pending] of [[true,false],[false,true]] as const) {
    uncorrected=owner;deleting=pending;const asked:number=calls.length;
    const waiting=await memory.context(group);
    assert.equal(waiting.limited_memory,true);assert.equal(waiting.syncing,true);assert.deepEqual(waiting.sources,[]);
    assert.equal(calls.length,asked,'no Honcho-derived text is read while an owner change is uncorrected');
  }
  uncorrected=false;deleting=false;fail=true;
  const down=await memory.context(group);
  assert.equal(down.limited_memory,true);assert.deepEqual(down.sources,[]);
  assert.ok(prepared>=3);
});

test('recall asks every connected peer side by side, keeps each inside the group\'s sessions and their order',async t=>{
  t.after(installChatsForTest(recallChats()));
  const workspace=digest('recall-workspace'),root={store:'archive',kind:'event',id:digest('recall-root'),revision:'1',input_hash:digest('recall-root-hash')};
  const groupSessions=[digest('group-session-a'),digest('group-session-b')],peers=['person_a','person_b','project_c'];
  const asked:{peer:string;body:any}[]=[],waiting:(()=>void)[]=[];let recorded='';
  const contexts={access:{stores:{control:nothingForwarded},policy:()=>({owner_id:'123'}),
    recall:(principal:Reader)=>({space:principal.space,group:'-100'})},
    guards:{prepareContext:async()=>null,read:async()=>({value:{text:recorded}})}};
  const derived={record:async(input:any)=>{if(input.kind==='memory_result')recorded=input.content.toString();
    return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const binding={generation:'fixture',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,root:async()=>root,allow:async()=>{}};
  const provenance={sessions:async(id:string,audience:string,_limit:number,group:string|null)=>{
    assert.equal(id,workspace);assert.equal(audience,'-100');assert.deepEqual(group,['-100','-100/topic/3'],'a group recall spans every topic of its group');return groupSessions;}};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,prepared as any,provenance as any,honchoEngine(async(path:string,body:any)=>{
    const peer=/\/peers\/([^/]+)\/chat$/.exec(path)![1]!;asked.push({peer,body});
    // Hold every answer until all peers were asked, then release the first peer last.
    await new Promise<void>(resolve=>{waiting.push(resolve);if(waiting.length===peers.length)[...waiting.slice(1),waiting[0]!].forEach(release=>release());});
    return {content:'Answer from '+peer};
  }),async()=>[]);
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],correcting:async()=>false,
    current:async()=>({row:{id:workspace,state:'ready',last_ready_at:new Date()},binding,principal:{}}),
    connectedPeers:async()=>({items:peers.map(peer=>({peer,path:'speaker → '+peer})),partial:false})});
  const result=await Promise.race([memory.recall({admin:false,scope:'-100',space:'-100',turnEvent:root.id} as Reader,'Who planned the trip?'),
    new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('peers were asked one after another')),2000))]) as any;
  assert.deepEqual(asked.map(item=>item.peer),peers,'all connected peers are asked before any answer returns');
  for(const item of asked)assert.deepEqual(item.body.filters,{session_id:groupSessions},'a group recall stays inside that group\'s sessions');
  assert.deepEqual(recorded.split('\n\n').map(block=>block.split('\n')[1]),peers.map(peer=>'Answer from '+peer),'answers keep the connected-peer order');
  assert.equal(result.sources.at(-1).text,recorded);
});

test('recall asks the owner\'s forwards and files beyond the four peers, under their own header, and in a group only within its sessions',async t=>{
  t.after(installChatsForTest(recallChats()));
  const workspace=digest('material-recall-workspace'),root={store:'archive',kind:'event',id:digest('material-recall-root'),revision:'1',input_hash:digest('material-recall-root-hash')};
  const groupSessions=[digest('material-group-session')],peers=['person_a','person_b','project_c','project_d','person_e'];
  const asked:{peer:string;body:any}[]=[],checked:unknown[][]=[],outputs:any[]=[];let recorded='',learned=true;
  const control={query:async(sql:string,values:unknown[])=>{
    if(!sql.includes('r.peer_id=$2'))throw Error('unexpected_control_query');checked.push(values);return {rowCount:learned?1:0,rows:learned?[{}]:[]};
  }};
  const contexts={access:{stores:{control},policy:()=>({owner_id:'123'}),recall:(principal:Reader)=>({space:principal.space,group:'-100'})},
    guards:{prepareContext:async()=>null,read:async()=>({value:{text:recorded}})}};
  const derived={record:async(input:any)=>{if(input.kind==='memory_result'){recorded=input.content.toString();outputs.push(input);}
    return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const binding={generation:'fixture',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,root:async()=>root,allow:async()=>{}};
  const provenance={sessions:async()=>groupSessions,read:async()=>({conclusions:[],evidence:[],limitations:[],exact_citations:false})};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,prepared as any,provenance as any,honchoEngine(async(path:string,body:any)=>{
    const peer=/\/peers\/([^/]+)\/chat$/.exec(path)![1]!;asked.push({peer,body});return {content:'Answer from '+peer};
  }),async()=>[]);
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],correcting:async()=>false,
    current:async()=>({row:{id:workspace,state:'ready',last_ready_at:new Date()},binding,principal:{}}),
    connectedPeers:async()=>({items:peers.map(peer=>({peer,path:'speaker → '+peer})),partial:false})});
  const owner={admin:false,scope:null,space:'123',turnEvent:root.id} as Reader;
  await memory.recall(owner,'Where is the trip?');
  assert.deepEqual(asked.map(item=>item.peer),[...peers.slice(0,4),materialPeer],'the forwards and files are asked beyond the four connected peers');
  assert.equal(asked.at(-1)!.body.filters,undefined,'owner recall spans the space');
  assert.deepEqual(checked.at(-1),[workspace,materialPeer,null,root.id],'only what was learned from another message than this question counts');
  assert.equal(recorded.split('\n\n').at(-1),'[related through the owner\'s forwards and files: information other people or files wrote, not the owner\'s words]\nAnswer from '+materialPeer);
  assert.equal(outputs.at(-1).configuration.forwards_and_files,true);
  // A group asks them only within its own sessions, and only when they wrote something there.
  asked.length=0;
  const group={admin:false,scope:'-100',space:'-100',turnEvent:root.id} as Reader;
  await memory.recall(group,'Where is the trip?');
  assert.deepEqual(asked.at(-1)!,{peer:materialPeer,body:asked.at(-1)!.body});assert.deepEqual(asked.at(-1)!.body.filters,{session_id:groupSessions});
  assert.deepEqual(checked.at(-1),[workspace,materialPeer,groupSessions,root.id]);
  learned=false;asked.length=0;
  await memory.recall(group,'Where is the trip?');
  assert.deepEqual(asked.map(item=>item.peer),peers.slice(0,4),'nothing learned there, nothing asked');
  assert.equal(outputs.at(-1).configuration.forwards_and_files,undefined);
});

test('a failed ask of the owner\'s forwards and files keeps the other answers, says what is missing and is counted; long answers are cut whole',async t=>{
  t.after(installChatsForTest(recallChats()));
  const workspace=digest('forwards-down-workspace'),root={store:'archive',kind:'event',id:digest('forwards-down-root'),revision:'1',input_hash:digest('forwards-down-root-hash')};
  let peers=['person_a','person_b'],answer=(peer:string):unknown=>'Answer from '+peer,forwards:()=>unknown=()=>{throw Error('honcho_down');};
  const counted:unknown[][]=[],outputs:any[]=[];let recorded='';
  const control={query:async(sql:string,values:unknown[])=>{
    if(sql.includes('r.peer_id=$2'))return {rowCount:1,rows:[{}]};
    // A failure is always written; a step that works only adds to a day that already holds a failure.
    if(sql.includes('memory_problem_days')){counted.push([/^\s*UPDATE\b/.test(sql)&&sql.includes('failed>0')?'worked':'failed',...values]);return {rowCount:1,rows:[]};}
    throw Error('unexpected_control_query');
  }};
  const contexts={access:{stores:{control},policy:()=>({owner_id:'123'}),recall:(principal:Reader)=>({space:principal.space,group:'-100'})},
    guards:{prepareContext:async()=>null,read:async()=>({value:{text:recorded}})}};
  const derived={record:async(input:any)=>{if(input.kind==='memory_result'){recorded=input.content.toString();outputs.push(input);}
    return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const binding={generation:'fixture',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,root:async()=>root,allow:async()=>{}};
  const provenance={sessions:async()=>[],read:async()=>({conclusions:[],evidence:[],limitations:[],exact_citations:false})};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,prepared as any,provenance as any,honchoEngine(async(path:string)=>{
    const peer=/\/peers\/([^/]+)\/chat$/.exec(path)![1]!;
    return {content:peer===materialPeer?forwards():answer(peer)};
  }),async()=>[]);
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],correcting:async()=>false,
    current:async()=>({row:{id:workspace,state:'ready',last_ready_at:new Date()},binding,principal:{}}),
    connectedPeers:async()=>({items:peers.map(peer=>({peer,path:'speaker → '+peer})),partial:false})});
  const owner={admin:false,scope:null,space:'123',turnEvent:root.id} as Reader;
  // The people's answers stay, with no forwards text and no header without its answer; the failure is one count.
  const down=await memory.recall(owner,'Where is the trip?') as any;
  assert.deepEqual(recorded.split('\n\n'),peers.map(peer=>`[related through speaker → ${peer}]\nAnswer from ${peer}`));
  assert.ok(down.sources.at(-1).limitations.includes('forwards_unavailable'));assert.equal(outputs.at(-1).configuration.forwards_and_files,undefined);
  assert.deepEqual(counted,[['failed','memory_read']]);
  // An answer that is not text is a failed ask too, and one that works is counted as working.
  forwards=()=>({not:'text'});await memory.recall(owner,'Where is the trip?');assert.deepEqual(counted.at(-1),['failed','memory_read']);
  forwards=()=>'Answer from '+materialPeer;
  const up=await memory.recall(owner,'Where is the trip?') as any;
  assert.deepEqual(counted.at(-1),['worked','memory_read']);assert.ok(!up.sources.at(-1).limitations.includes('forwards_unavailable'));
  assert.equal(outputs.at(-1).configuration.forwards_and_files,true);
  // Only the forwards were asked, and their ask failed: limited memory that says what is missing.
  peers=[];forwards=()=>{throw Error('honcho_down');};
  const alone=await memory.recall(owner,'Where is the trip?') as any;
  assert.equal(alone.limited_memory,true);assert.deepEqual(alone.limitations,['forwards_unavailable']);assert.deepEqual(alone.sources,[]);
  // Answers past 20,000 characters: the last ones are left out whole, a first one alone too long is cut, and nothing throws.
  peers=['person_a','person_b'];answer=peer=>(peer==='person_a'?'a':'b').repeat(15000);
  const long=await memory.recall(owner,'Where is the trip?') as any;
  assert.deepEqual(recorded.split('\n\n'),['[related through speaker → person_a]\n'+'a'.repeat(15000)]);
  assert.ok(long.sources.at(-1).limitations.includes('recall_answer_cut'));assert.ok(long.sources.at(-1).limitations.includes('forwards_unavailable'));
  peers=['person_a'];answer=()=>'🎉'.repeat(15000);
  const cut=await memory.recall(owner,'Where is the trip?') as any;
  assert.ok(recorded.startsWith('[related through speaker → person_a]\n🎉'));assert.ok(recorded.length<=20000);assert.doesNotMatch(recorded,/[\ud800-\udbff]$/);
  assert.ok(cut.sources.at(-1).limitations.includes('recall_answer_cut'));
});

test('recall asks Honcho for evidence and points the agent at the archived messages behind the conclusions it read',async t=>{
  t.after(installChatsForTest(recallChats()));
  const workspace=digest('evidence-workspace'),root={store:'archive',kind:'event',id:digest('evidence-root'),revision:'1',input_hash:digest('evidence-root-hash')};
  const sessions=[digest('evidence-session')],first='A'.repeat(21),second='B'.repeat(21);
  const archived={store:'archive',kind:'event',id:digest('evidence-message'),revision:'1',input_hash:digest('evidence-message-hash')};
  const bodies:any[]=[],reads:any[]=[],outputs:any[]=[];let recorded='',failRead=false;
  const contexts={access:{stores:{control:nothingForwarded},policy:()=>({owner_id:'123'}),
    recall:(principal:Reader)=>({space:principal.space,group:'-100'})},
    guards:{prepareContext:async()=>null,read:async()=>({value:{text:recorded}})}};
  const derived={record:async(input:any)=>{if(input.kind==='memory_result'){recorded=input.content.toString();outputs.push(input);}
    return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const binding={generation:'fixture',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,root:async()=>root,allow:async()=>{}};
  const provenance={sessions:async()=>sessions,read:async(id:string,audience:string,ids:string[],current:unknown)=>{
    reads.push({id,audience,ids,current});if(failRead)throw Error('provenance_down');
    return {conclusions:ids.map(item=>({id:item,parents:[],deleted:false,exact_citations:true})),evidence:[archived],limitations:[],exact_citations:true};}};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,prepared as any,provenance as any,honchoEngine(async(path:string,body:any)=>{
    bodies.push(body);const peer=/\/peers\/([^/]+)\/chat$/.exec(path)![1]!;
    return {content:'Answer from '+peer,evidence:{conclusions:peer==='person_a'?[{id:first},{id:second},{id:'not-a-conclusion'}]:[{id:first}],messages:[],tool_calls:[]}};
  }),async()=>[]);
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),relevantOwnerCorrections:async()=>[],correcting:async()=>false,
    current:async()=>({row:{id:workspace,state:'ready',last_ready_at:new Date()},binding,principal:{}}),
    connectedPeers:async()=>({items:['person_a','person_b'].map(peer=>({peer,path:'speaker → '+peer})),partial:false})});
  const reader={admin:false,scope:'-100',space:'-100',turnEvent:root.id} as Reader;
  const result=await memory.recall(reader,'Who planned the trip?') as any;
  assert.ok(bodies.every(body=>body.include_evidence===true),'every peer answer carries Honcho\'s evidence');
  assert.deepEqual(reads,[{id:workspace,audience:'-100',ids:[first,second],current:binding}],'conclusions are read once, deduplicated, within the audience');
  const source=result.sources.at(-1);
  assert.deepEqual(source.evidence_sources,['nocheh:event:'+archived.id]);
  assert.equal(source.exact_citations,false,'what Honcho read is not what the answer relied on, even when its conclusions cite exact messages');
  assert.ok(source.limitations.includes('evidence_lists_conclusions_read_not_relied_on'));
  assert.ok(!source.limitations.includes('ancestry_is_not_an_exact_citation'),'cited evidence is not called inexact');
  assert.deepEqual(outputs[0].provenance.evidence,[archived],'the recorded answer keeps its archive evidence');
  failRead=true;
  const fallback=await memory.recall(reader,'Who planned the trip?') as any;
  assert.equal(fallback.sources.at(-1).text,recorded,'an evidence failure still returns the answer');
  assert.deepEqual(fallback.sources.at(-1).evidence_sources,[]);
  assert.ok(fallback.sources.at(-1).limitations.includes('evidence_unavailable'));
});

test('search by meaning asks Honcho within the audience\'s learned sessions and returns only the archived messages behind its hits',async t=>{
  t.after(installChatsForTest(recallChats()));
  const workspace=digest('search-workspace'),sessions=[digest('search-session')],ref=(name:string)=>({store:'archive',kind:'event',id:digest(name),revision:'1',input_hash:digest(name+'-hash')});
  const receipts:Record<string,unknown>={[digest('receipt-a')]:{source_reference:ref('first'),source_references:[]},
    [digest('receipt-c')]:{source_reference:ref('first'),source_references:[ref('first'),ref('second')]}};
  const queries:unknown[][]=[],bodies:{path:string;body:any}[]=[],asked:string[]=[];let learned=sessions;
  const contexts={access:{stores:{control:{query:async(_sql:string,params:unknown[])=>{queries.push(params);const row=receipts[String(params[0])];return {rows:row?[row]:[]};}}},
    policy:()=>({owner_id:'123'}),recall:(principal:Reader)=>({space:principal.space,group:'-100'}),reads:(principal:Reader)=>principal.reads},guards:{}};
  const binding={generation:'fixture',epoch:1,mode:'on'};
  const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>{asked.push(query);return 'checked: '+query;},allow:async()=>{}};
  const readSessions:unknown[][]=[];
  const memory=new NativeMemoryRepository(contexts as any,{} as any,prepared as any,{sessions:async()=>learned,
    readSetSessions:async(...args:unknown[])=>{readSessions.push(args);return learned;}} as any,honchoEngine(async(path:string,body:any)=>{
    bodies.push({path,body});
    return [{id:'A'.repeat(21),metadata:{nocheh_receipt:digest('receipt-a')}},{id:'B'.repeat(21),metadata:{nocheh_receipt:digest('receipt-b')}},
      {id:'not-native',metadata:{nocheh_receipt:digest('receipt-a')}},{id:'C'.repeat(21),metadata:{nocheh_receipt:digest('receipt-c')}}];
  }),async()=>[]);
  Object.assign(memory as any,{workspace:async()=>({id:workspace}),current:async()=>({row:{id:workspace,state:'ready'},binding,principal:{}})});
  const group={admin:false,scope:'-100',space:'-100/topic/3',turnEvent:digest('turn')} as Reader;
  assert.deepEqual(await memory.search(group,'who sends the invoice',4),{ids:[digest('first'),digest('second')],learned:true});
  assert.deepEqual(bodies[0],{path:'/v3/workspaces/'+workspace+'/search',body:{query:'checked: who sends the invoice',limit:12,filters:{session_id:{in:sessions}}}});
  assert.deepEqual(asked,['who sends the invoice'],'the question is checked for secrets before Honcho sees it');
  // The group is bound as its id and its topics' ids, from the chat rows (ADR-0252).
  const topics=['-100','-100/topic/3'];
  assert.deepEqual(queries.map(params=>params.slice(1)),[[workspace,'A'.repeat(21),'-100/topic/3',topics,null],[workspace,'B'.repeat(21),'-100/topic/3',topics,null],
    [workspace,'C'.repeat(21),'-100/topic/3',topics,null]],'a hit counts only with its own receipt, in this audience or its group');
  assert.deepEqual(readSessions,[],'a group reader searches its own sessions');
  // An answer reader searches the sessions of the groups frozen in its record, and a hit counts only with a receipt of one
  // of them; Honcho's context and recall stay closed to it: plain search only (ADR-0249).
  const answer={admin:false,scope:'123',space:'123',turnEvent:digest('start'),answer:'a'.repeat(32),
    reads:{home:'-100/topic/3',exact:[],whole:['-100','-200'],project:null}} as Reader;
  queries.length=0;
  assert.deepEqual(await memory.search(answer,'who sends the invoice',4),{ids:[digest('first'),digest('second')],learned:true});
  // Its groups are bound as their ids and their topics' ids, from the chat rows (ADR-0252).
  // The read set reaches the provenance query whole, and SQL takes its ids only as marked read set entries.
  const frozen=['-100','-100/topic/3','-200'].map(id=>'read:'+id);
  assert.deepEqual(readSessions,[[workspace,(answer as any).reads,1000]]);
  assert.deepEqual(queries.map(params=>params.at(-1)),[frozen,frozen,frozen]);
  assert.equal((await memory.context(answer)).limited_memory,true);
  assert.equal((await memory.recall(answer,'invoice')).limited_memory,true);
  bodies.splice(1);
  await memory.search({admin:false,scope:null,space:'123',turnEvent:digest('turn')} as Reader,'invoice',2);
  assert.deepEqual(bodies[1]!.body,{query:'checked: invoice',limit:6},'the owner searches everything learned');
  learned=[];
  assert.deepEqual(await memory.search(group,'invoice',2),{ids:[],learned:false});
  assert.equal(bodies.length,2,'a chat that was not learned is not searched');
  await assert.rejects(memory.search(group,'  ',2),{code:'empty_query'});
});

test('terminal Honcho derivation errors cannot mark a generation ready',async()=>{
  const id=digest('failed-derivation'),updates:{sql:string;values:unknown[]}[]=[];
  let failed=true,valid=true;
  const control={query:async(sql:string,values:unknown[]=[])=>{
    if(sql.startsWith('SELECT 1 FROM memory_ingestion_receipts'))return {rowCount:0};
    if(sql.startsWith('UPDATE memory_generations')){updates.push({sql,values});return {rowCount:1};}
    throw Error('unexpected_control_query');
  }};
  const paths:string[]=[];let checkedAt:Date|null=null;
  const memory=new NativeMemoryRepository({access:{stores:{control}}} as any,{} as any,{} as any,{} as any,honchoEngine(
    async(path:string)=>{paths.push(path);return path.endsWith('/queue/status')?{pending_work_units:0,in_progress_work_units:0}:
      {failed_items:valid?failed:undefined};}),async()=>[]);
  (memory as any).current=async()=>({row:{work_revision:3,derivation_checked_at:checkedAt}});
  assert.equal(await memory.observe(id),false);
  assert.deepEqual(updates[0]!.values.slice(0,5),[id,'building',3,true,true]);
  assert.match(updates[0]!.sql,/memory_learning_failed/);
  assert.ok(paths.at(-1)!.endsWith('/nocheh/queue-health'),'the first check reads every failure');
  // Honcho keeps a failure for 30 days; once seen with the queue drained, only newer work counts.
  checkedAt=updates[0]!.values[5] as Date;
  failed=false;assert.equal(await memory.observe(id),true);
  assert.deepEqual(updates[1]!.values.slice(0,5),[id,'ready',3,false,true]);
  assert.ok(paths.at(-1)!.endsWith('/nocheh/queue-health?since='+encodeURIComponent(checkedAt.toISOString())));
  valid=false;await assert.rejects(memory.observe(id),{code:'honcho_queue_health_invalid'});
  assert.equal(updates.length,2,'invalid health cannot change readiness');
});

test('native memory dates a Honcho message by its event, not by a retried write',async()=>{
  const archive={query:async()=>({rows:[{occurred_at:'1760785619',received_at:new Date('2026-10-18T14:06:00Z')}]})};
  const memory=new NativeMemoryRepository({access:{stores:{archive}}} as any,{} as any,{} as any,{} as any,honchoEngine(async()=>({})),async()=>[]);
  const occurred=(row:unknown)=>(memory as any).occurredAt(row);
  assert.equal(await occurred({source_reference:{id:'fixture'},projection_reference:null}),'2025-10-18T11:06:59.000Z');
  assert.equal(await occurred({source_reference:{id:'fixture'},projection_reference:{id:'learned',revision:1}}),undefined,'an interpretation keeps the time it was learned');
});

test('native memory keeps content derived, reconciles uncertain writes and rebuilds corrected guarded generations',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-memory-')),key='native:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},remote=new Map<string,any[]>(),calls:{path:string;body:any;method?:string}[]=[];
  let loseReply=true,rejectWrite=false,sequence=0;const ownerApproved='Owner-approved password=visible123',descendants:string[]=[],active=new Map<string,Set<string>>();
  const priorities:unknown[]=[];
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(_operation,input)=>{
      priorities.push(input.priority);const text=String(input.text);
      // A steered check flags the request's own structure words.
      return {literals:text.includes('saffronpass')?['saffronpass']:text.includes('Steered recall')?['user','fixture-recall-model'].filter(word=>text.includes(word)):[]};
    },
    memoryEngine:honchoEngine(async(path,body:any,method)=>{
      calls.push({path,body,...(method?{method}:{})});
      const session=/^\/v3\/workspaces\/([^/]+)\/sessions(?:\/([^/?]+))?/.exec(path);
      if(method==='DELETE'){if(session?.[2])active.get(session[1]!)?.delete(session[2]);return {deleted:true};}
      if(session&&session[2]==='list')return {items:[...active.get(session[1]!)??[]].map(id=>({id}))};
      if(session&&!session[2]&&body?.id){if(!active.has(session[1]!))active.set(session[1]!,new Set());active.get(session[1]!)!.add(body.id);}
      if(path.endsWith('/nocheh/session-descendants'))return {ids:descendants.splice(0),truncated:false};
      if(path.endsWith('/messages/list'))return {items:remote.get(path.replace('/list',''))??[]};
      if(path.endsWith('/messages')) {
        const message={...body.messages[0],id:String(++sequence).padStart(21,'r')};remote.set(path,[message]);
        if(rejectWrite){rejectWrite=false;remote.delete(path);throw new HttpError(503,'memory_engine_rejected');}
        if(loseReply){loseReply=false;throw Error('synthetic_lost_acknowledgment');}return [message];
      }
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.includes('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'Stored conclusion saffronpass. '+ownerApproved},peer_representation:'Speaker detail',peer_card:[]};
      if(path.endsWith('/representation'))return {representation:'Stored conclusion saffronpass. '+ownerApproved};
      if(path.endsWith('/chat'))return {content:'Recalled conclusion saffronpass.'};
      return {};
    })});
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:group,space:group,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  // Stands in for the honcho refresh workflow finishing this epoch's correction sweep.
  const swept=async()=>{const binding=await services.guards.state();await stores.control.query(`INSERT INTO learning_refresh_sweeps(installation_generation,guard_epoch,family,stage)
    VALUES($1,$2,'honcho','done') ON CONFLICT(installation_generation,guard_epoch,family) DO UPDATE SET stage='done'`,[binding.generation,binding.epoch]);};
  const insertRemote=async(id:string)=>{
    const row=(await stores.control.query('SELECT * FROM memory_ingestion_receipts WHERE id=$1',[id])).rows[0];
    const content=(await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[row.prepared_id])).rows[0].content.toString();
    remote.set('/v3/workspaces/'+row.generation+'/sessions/'+row.session_id+'/messages',[{id:String(++sequence).padStart(21,'r'),content,
      peer_id:row.peer_id,metadata:{nocheh_receipt:id}}]);
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');
    let status=await services.memory.status();
    const acceptance=await services.memory.issueAcceptance(owner);
    assert.match(acceptance.workspace,/^[a-f0-9]{64}$/);
    const synthetic={workspace:acceptance.workspace,route:'/v1/embeddings',payload:{model:'text-embedding-3-small',input:'Synthetic saffronpass'}};
    assert.equal(await services.memory.acceptanceRequest(synthetic),true);
    const syntheticPrepared=await storageGuardService(services)(owner,{destination:'http://honcho-provider-gateway:8790/v1/embeddings',payload:synthetic.payload});
    assert.ok(!JSON.stringify(syntheticPrepared.payload).includes('saffronpass'),'synthetic provider input is guarded before egress');
    await assert.rejects(services.memory.acceptanceRequest({...synthetic,route:'/v1/files'}),{code:'memory_route_denied'});
    assert.equal(await services.memory.acceptanceRequest({...synthetic,workspace:'0'.repeat(64)}),false);
    await services.memory.closeAcceptance(owner,acceptance.workspace);
    assert.equal(await services.memory.acceptanceRequest(synthetic),false,'closed acceptance workspace cannot reach provider');
    const allChecks={subscription_reasoning:'passed',ingestion:'passed',retrieval:'passed',embedding_guarded:'passed',restart:'passed',provider_failure:'passed'};
    await assert.rejects(services.memory.acceptVerification(owner,{format:'nocheh-honcho-live-v1',status:'passed',synthetic_only:true,
      checks:allChecks,ledger:{reserved_usd:0.53,limit_usd:5}}),{code:'honcho_live_acceptance_pending'});
    await services.guards.setMode('off');await services.guards.setMode('on');
    assert.equal(await services.memory.acceptanceRequest(synthetic),false,'a changed guard binding retires acceptance');
    const connect={attached:true,include_history:false,catch_up:false,expected_revision:status.connection.revision,operation_id:key+':attach'};
    await assert.rejects(services.memory.acceptVerification(owner,{format:'not-a-live-report',checks:{},ledger:{}}),{code:'honcho_live_acceptance_pending'});
    // Honcho memory is on by default: it attaches once without a live acceptance report.
    status=await services.memory.attachByDefault();assert.equal(status.connection.attached,true);assert.equal(status.connection.revision,1);
    assert.equal((await stores.control.query('SELECT verified FROM memory_engine_connection WHERE singleton')).rows[0].verified,false);
    status=await services.memory.connection(owner,{attached:false,include_history:false,catch_up:false,expected_revision:1,operation_id:key+':default-detach'});
    assert.equal(status.connection.attached,false);
    status=await services.memory.attachByDefault();assert.equal(status.connection.attached,false,'the owner\'s detach stands');
    status=await services.memory.connection(owner,{...connect,expected_revision:status.connection.revision});assert.equal(status.connection.attached,true);
    await assert.rejects(services.memory.issueAcceptance(owner),{code:'honcho_acceptance_requires_detached_memory'});
    const project=await services.projects.save(owner,{name:'Atlas',description:'Connected memory fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':project-assignment'});
    const event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:key,revision:'1',occurred_at:null,
      text:'The checkmark means done. saffronpass',payload:{message:{message_id:1,date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:123},text:'The checkmark means done. saffronpass'}}};
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',services.detect);
    const sourceGuard=await services.guards.read('events:'+source.id,await services.guards.state());
    const ownerValue=structuredClone(sourceGuard.value) as any;ownerValue.text=ownerApproved;ownerValue.payload.message.text=ownerApproved;
    await services.guards.edit('events:'+source.id,sourceGuard.revision,ownerValue,key+':owner-source-edit');
    const queued=await services.memory.queueSource(source);assert.equal(queued.length,1);assert.deepEqual(queued.map(q=>q.audience),[group],'group evidence is written once, to its own audience');
    assert.deepEqual(queued.map(q=>q.receipts.length),[2],'speaker evidence and typed project evidence are separate receipts');
    assert.deepEqual(await services.memory.queueSource(source),queued,'duplicate queuing reuses receipts and derivatives');
    const workspace=queued[0]!.workspace;
    const questionText='Recall the earlier recorded fact.';
    const question=(await services.capture.capture({...event,key:key+':question',source_id:key+':question',text:questionText,
      payload:{message:{...(event.payload.message as Record<string,unknown>),message_id:2,text:questionText}}})).source.reference;
    await services.guards.prepare(question,'fixture',services.detect);
    const originalCount=(await stores.archive.query('SELECT count(*) FROM events')).rows[0].count;
    const [receipt,entityReceiptId]=queued[0]!.receipts as [string,string],authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    await assert.rejects(services.memory.syncReceipt(receipt,{...authority,epoch:authority.epoch+1}),{code:'workflow_owner_changed'});
    await assert.rejects(services.memory.syncReceipt(receipt,authority),/synthetic_lost_acknowledgment/);
    assert.equal((await stores.control.query('SELECT state FROM memory_ingestion_receipts WHERE id=$1',[receipt])).rows[0].state,'uncertain');
    const writes=calls.filter(c=>c.path.endsWith('/messages')).length;
    const captured=(await stores.archive.query('SELECT received_at FROM events WHERE id=$1',[source.id])).rows[0].received_at.toISOString();
    assert.equal(calls.find(c=>c.path.endsWith('/messages'))!.body.messages[0].created_at,captured,'an undated message is dated by its capture, not by the write');
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[entityReceiptId]);
    assert.equal(await services.memory.syncReceipt(entityReceiptId,authority),false);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes,'absence cannot authorize repeating an uncertain effect');
    await insertRemote(entityReceiptId);assert.equal(await services.memory.reconcileReceipt(entityReceiptId),true);
    const entityRow=(await stores.control.query('SELECT generation,session_id FROM memory_ingestion_receipts WHERE id=$1',[entityReceiptId])).rows[0];
    const entityPath='/v3/workspaces/'+entityRow.generation+'/sessions/'+entityRow.session_id+'/messages';
    const receiptState=async()=>(await stores.control.query('SELECT state,error_code FROM memory_ingestion_receipts WHERE id=$1',[entityReceiptId])).rows[0];
    // A write still absent long after it ended never landed: it returns to pending and is written once.
    remote.delete(entityPath);
    await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain',uncertain_at=now()-interval '11 minutes' WHERE id=$1",[entityReceiptId]);
    assert.equal(await services.memory.reconcileReceipt(entityReceiptId),false);
    assert.deepEqual(await receiptState(),{state:'pending',error_code:'memory_write_absent'});
    const beforeRewrite=calls.filter(c=>c.path.endsWith('/messages')).length;
    assert.equal(await services.memory.syncReceipt(entityReceiptId,authority),true);
    assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,beforeRewrite+1);
    // Honcho answering a write with an error means nothing landed, so the receipt stays retryable.
    remote.delete(entityPath);rejectWrite=true;
    await stores.control.query("UPDATE memory_ingestion_receipts SET state='pending' WHERE id=$1",[entityReceiptId]);
    await assert.rejects(services.memory.syncReceipt(entityReceiptId,authority),/memory_engine_rejected/);
    assert.deepEqual(await receiptState(),{state:'pending',error_code:'memory_engine_rejected'});
    assert.equal(await services.memory.syncReceipt(entityReceiptId,authority),true);
    assert.equal(await services.memory.observe(workspace),true);
    assert.equal(await services.memory.settled(queued[0]!.receipts),true);
    const entityReceipt=(await stores.control.query("SELECT peer_id,peer_ids,audience FROM memory_ingestion_receipts WHERE generation=$1 AND record_kind='labelled_entity'",[workspace])).rows[0];
    assert.match(entityReceipt.peer_id,/^person_/);assert.ok(entityReceipt.peer_ids.some((peer:string)=>peer.startsWith('project_')),'the project peer observes attributed evidence');
    assert.equal(entityReceipt.audience,group);
    const sessionWrites=calls.filter(c=>c.path.endsWith('/sessions')&&c.body?.id);
    assert.ok(sessionWrites.every(c=>c.path==='/v3/workspaces/'+workspace+'/sessions'),'every session lives in the one installation workspace');
    const input=(await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{model:'fixture',input:'Embedding saffronpass'}})).payload;
    assert.ok(!JSON.stringify(input).includes('saffronpass'));
    assert.equal(((await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:ownerApproved}})).payload as any).input,ownerApproved);
    await assert.rejects(services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:[1,2]}}),{code:'opaque_embedding_input'});
    // Recall requests from Honcho's API are checked with reply priority; the deriver's yield to them.
    priorities.length=0;
    await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:'Recall request text saffronpass'}});
    await services.memory.prepareRequest({workspace,route:'/v1/embeddings',background:true,payload:{input:'Deriver request text saffronpass'}});
    assert.deepEqual(priorities,[undefined,'background']);
    await assert.rejects(services.memory.prepareRequest({workspace,route:'/v1/embeddings',background:'yes',payload:{input:'text'}}),{code:'invalid_memory_priority'});
    const callCount=calls.length;
    await assert.rejects(services.memory.prepareRequest({workspace,route:'/unsupported',payload:{input:'text'}}),{code:'memory_route_denied'});assert.equal(calls.length,callCount);
    // Honcho's model requests keep their roles and model when the check flags them, so learning and recall still reach the provider (ADR-0251).
    const steered=(await services.memory.prepareRequest({workspace,route:'/v1/chat/completions',background:true,payload:{model:'fixture-recall-model',
      messages:[{role:'system',content:'Steered recall for the user.'},{role:'user',content:'Which note was it?'}]}})).payload as any;
    assert.equal(steered.model,'fixture-recall-model');assert.deepEqual(steered.messages.map((message:any)=>message.role),['system','user']);
    assert.deepEqual(Object.keys(steered.messages[1]).sort(),['content','role']);assert.equal(steered.messages[1].content,'Which note was it?');

    await swept();const principal=await actor(question.id),context=await services.memory.context(principal);
    assert.equal(context.limited_memory,false);assert.ok(!JSON.stringify(context).includes('saffronpass'));assert.ok(JSON.stringify(context).includes('representation_has_no_exact_citations'));
    assert.ok(JSON.stringify(context).includes(ownerApproved),'native context preserves exact owner-approved guarded passages');
    const contextRead=calls.filter(c=>c.path.includes('/context?')).at(-1)!.path;
    assert.match(contextRead,/limit_to_session=true/,'a group turn reads only its own session');assert.match(contextRead,/peer_target=person_/);
    assert.equal(await services.memory.requestPrefetch(workspace),1,'Honcho finishing new work prefetches the changed conversation');
    const conversation=(await stores.control.query("SELECT session_id FROM memory_sessions WHERE workspace=$1 AND kind='conversation'",[workspace])).rows[0].session_id;
    assert.equal(await services.memory.prefetch(conversation),true);assert.equal(await services.memory.requestPrefetch(workspace),0);
    const recalled=await services.memory.recall(principal,'Recall saffronpass');assert.equal(recalled.sources.length,1);assert.ok(!JSON.stringify(recalled).includes('saffronpass'));
    const chat=calls.filter(c=>c.path.endsWith('/chat')).at(-1)!;
    assert.ok(!String(chat.body.query).includes('saffronpass'));
    const groupSessions=(await stores.control.query('SELECT session_id FROM memory_sessions WHERE audience=$1',[group])).rows.map(row=>row.session_id).sort();
    assert.deepEqual([...chat.body.filters.session_id].sort(),groupSessions,'group recall is confined to its own sessions');
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,originalCount,'memory and context never become original evidence');
    assert.ok(!JSON.stringify(calls.filter(c=>c.path.endsWith('/messages'))).includes('saffronpass'),'only guarded inputs reach native ingestion');
    const receiptColumns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_ingestion_receipts'")).rows.map(r=>r.column_name);
    assert.ok(!receiptColumns.includes('content'));

    const binding=await services.guards.state(),prepared=await services.guards.read('events:'+source.id,binding),entryId=digest(key+':meaning');
    await services.learned.publishAutomatic(entryId,{kind:'meaning',subject:'checkmark',text:'Checkmark means done.',scope:{kind:'conversation',id:group},uncertainty:'supported',conflicts:[],evidence:[source]},
      null,key+':learned',[{source_id:'events:'+source.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}],binding,'fixture',services.detect);
    const projections=await services.memory.queueProjection(entryId);assert.equal(projections.length,1);assert.equal(projections[0]!.workspace,workspace);
    const late=projections[0]!.receipts[0]!;await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[late]);
    const projectionSession=(await stores.control.query('SELECT session_id FROM memory_ingestion_receipts WHERE id=$1',[late])).rows[0].session_id;
    await services.learned.correct(owner,entryId,{expected_revision:1,operation_id:key+':correction',retired:false,text:'Checkmark means reviewed, not done.'},services.detect);
    assert.equal((await services.memory.current(workspace)).row.id,workspace,'a guard epoch never retires the installation workspace');
    await assert.rejects(services.memory.context(principal),{code:'audience_context_changed'});
    assert.ok(await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:'still served'}}));
    const unrelated=await services.memory.sweep('',await services.guards.state());
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE id=ANY($1::text[]) AND retired_at IS NULL',[queued[0]!.receipts])).rows[0].count,2,
      'an unrelated epoch keeps every still-valid Honcho write');
    assert.ok(unrelated.rebuilt<=2,'only the corrected interpretation\'s own sessions can be rebuilt');
    const rebuilt=await services.memory.queueProjection(entryId);assert.equal(rebuilt.length,1);assert.equal(rebuilt[0]!.workspace,workspace);
    assert.ok((await stores.control.query('SELECT retired_at FROM memory_ingestion_receipts WHERE id=$1',[late])).rows[0].retired_at,'the replaced interpretation leaves Honcho');
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL',[projectionSession])).rows[0].count,0);
    const rebuiltReceipt=(await stores.control.query('SELECT prepared_id,session_id FROM memory_ingestion_receipts WHERE id=$1',[rebuilt[0]!.receipts[0]])).rows[0];
    assert.notEqual(rebuiltReceipt.session_id,projectionSession,'corrected evidence is written to a new session revision');
    assert.ok((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[rebuiltReceipt.prepared_id])).rows[0].content.toString().includes('Checkmark means reviewed, not done.'));
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=$1",['delete:'+projectionSession])).rows[0].count,1);
    descendants.push('c'.repeat(21));
    assert.equal(await services.memory.deleteSession(projectionSession,authority),true);
    const deletes=calls.filter(c=>c.method==='DELETE').map(c=>c.path);
    assert.deepEqual(deletes,['/v3/workspaces/'+workspace+'/conclusions/'+'c'.repeat(21),'/v3/workspaces/'+workspace+'/sessions/'+projectionSession],
      'conclusions derived elsewhere are deleted before the replaced session');
    assert.equal(await services.memory.deleteSession(projectionSession,authority),true);assert.equal(calls.filter(c=>c.method==='DELETE').length,2);
    await insertRemote(late);assert.equal(await services.memory.reconcileReceipt(late),true,'a replaced receipt can still be reconciled');
    const fresh=await actor(source.id);
    const replaced=(await stores.control.query("SELECT session_id FROM memory_session_deletions WHERE workspace=$1 AND state<>'done'",[workspace])).rows;
    assert.ok(replaced.length,'the other rebuilt session still awaits deletion');
    assert.equal((await services.memory.context(fresh)).syncing,true,'a replaced session still in Honcho keeps its context withheld');
    for(const row of replaced)assert.equal(await services.memory.deleteSession(row.session_id,authority),true);
    assert.equal((await services.memory.context(fresh)).limited_memory,false,'an epoch without an owner change does not hold memory');
    const correctedRecall=await services.memory.recall(fresh,'What does checkmark mean?');
    assert.equal(correctedRecall.sources[0]?.kind,'owner_corrected_interpretation');
    assert.match(correctedRecall.sources[0]!.text,/Checkmark means reviewed, not done\./);
    assert.equal(JSON.stringify(await services.memory.recall(fresh,'What does another symbol mean?')).includes('owner_corrected_interpretation'),false,
      'an unrelated question cannot receive the correction');
    // Answering a suggestion card or renaming a person makes no write invalid, so neither holds Honcho (ADR-0223).
    const card=await services.entities.suggest('person','Card Person',source,'A person named in this chat.');
    const answered:any=await services.entities.decide(owner,card.id,{decision:'confirm',expected_revision:card.revision,operation_id:key+':remember'});
    await services.entities.rename(owner,answered.entity.id,{name:'Renamed Person',expected_revision:answered.entity.revision,operation_id:key+':rename'});
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM owner_commands WHERE NOT holds_memory')).rows[0].count,2);
    assert.equal((await services.memory.context(await actor(source.id))).limited_memory,false,'Remember and a rename keep Honcho memory readable');
    await services.access.setConsent(owner,source,{enabled:false,expected_revision:0,operation_id:key+':consent-off'});
    const withdrawn=await actor(source.id);
    assert.equal((await services.memory.context(withdrawn)).syncing,true,'an owner change holds Honcho until a sweep at its epoch');
    const retracted=await services.memory.sweep('',await services.guards.state());assert.ok(retracted.rebuilt>=1);
    await swept();
    assert.equal((await services.memory.context(withdrawn)).syncing,true,'a session replaced by that sweep still awaits deletion');
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE source_reference->>'id'=$1 AND retired_at IS NULL",[source.id])).rows[0].count,0,
      'withdrawn consent removes the source from every session that held it');
    assert.equal(await services.memory.ingested(source.id),false);

    // Fresh start: a new, empty workspace learns from new messages only; earlier workspaces leave Honcho and Nocheh.
    const legacy=digest('legacy-workspace:'+key),{generation}=await services.guards.state();
    await stores.control.query(`INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience,state,representation_version)
      VALUES($1,$2,1,$3,'retired','legacy-source-v1')`,[legacy,generation,group]);
    active.set(legacy,new Set(['l'.repeat(21)]));
    status=await services.memory.status();
    const started=await services.memory.freshStart(owner,{expected_revision:status.connection.revision,operation_id:key+':fresh-start'});
    assert.equal(started.workspace,null);assert.equal(started.connection.include_history,false);assert.equal(started.connection.workspace_revision,status.connection.workspace_revision+1);
    await assert.rejects(services.memory.current(workspace),{code:'memory_context_retired'});
    await assert.rejects(services.memory.freshStart(owner,{expected_revision:status.connection.revision,operation_id:key+':fresh-start-stale'}),{code:'memory_connection_conflict'});
    assert.deepEqual((await stores.control.query("SELECT job_id FROM workflow_registry WHERE family='honcho' AND job_id LIKE 'retire:%' ORDER BY job_id")).rows.map(row=>row.job_id),
      ['retire:'+legacy,'retire:'+workspace].sort());
    assert.deepEqual(await services.memory.queueSource(question),[],'a message received before the fresh start is not learned again');
    const remaining=[...active.get(workspace)!];assert.ok(remaining.length>0);
    const beforeRetire=calls.length;
    assert.equal(await services.memory.retireWorkspace(workspace,authority),true);
    const retired=calls.slice(beforeRetire).filter(c=>c.method==='DELETE').map(c=>c.path);
    assert.deepEqual(retired,[...remaining.map(id=>'/v3/workspaces/'+workspace+'/sessions/'+id),'/v3/workspaces/'+workspace],'sessions are deleted before their workspace');
    for(const table of ['memory_generations WHERE id=$1','memory_ingestion_receipts WHERE generation=$1','memory_sessions WHERE workspace=$1'])
      assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM '+table,[workspace])).rows[0].count,0,'Nocheh forgets the deleted workspace');
    assert.equal(await services.memory.retireWorkspace(workspace,authority),true);assert.equal(calls.filter(c=>c.path==='/v3/workspaces/'+workspace&&c.method==='DELETE').length,1);
    assert.equal(await services.memory.retireWorkspace(legacy,authority),true);assert.equal(active.get(legacy)!.size,0);
    assert.deepEqual((await services.memory.status()).workspace_deletions,[{state:'done',workspaces:2,sessions:remaining.length+1}]);
    const newText='A new message after the fresh start.';
    const after=(await services.capture.capture({...event,key:key+':after',source_id:key+':after',text:newText,
      payload:{message:{...(event.payload.message as Record<string,unknown>),message_id:3,text:newText}}})).source.reference;
    await services.guards.prepare(after,'fixture',services.detect);
    const renewed=await services.memory.queueSource(after);assert.equal(renewed.length,1);
    assert.notEqual(renewed[0]!.workspace,workspace,'new messages go to the new workspace');assert.equal((await services.memory.status()).workspace?.id,renewed[0]!.workspace);
    for(const receipt of renewed[0]!.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    // Honcho cannot change a message, so an edit replaces the sessions that held the earlier text and only the latest text stays.
    const editedText='A corrected message after the fresh start.';
    const edited=(await services.capture.capture({...event,key:key+':after-edit',source_id:key+':after',revision:'2',text:editedText,
      payload:{edited_message:{...(event.payload.message as Record<string,unknown>),message_id:3,edit_date:2,text:editedText}}})).source.reference;
    await services.guards.prepare(edited,'fixture',services.detect);
    const earlierSessions=(await stores.control.query('SELECT DISTINCT session_id FROM memory_ingestion_receipts WHERE id=ANY($1::text[])',[renewed[0]!.receipts])).rows.map(row=>row.session_id);
    const revised=await services.memory.queueSource(edited);assert.equal(revised.length,1);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE source_reference->>'id'=$1 AND retired_at IS NULL",[after.id])).rows[0].count,0,
      'the earlier revision leaves every session that held it');
    const revisedRows=(await stores.control.query('SELECT session_id,prepared_id FROM memory_ingestion_receipts WHERE id=ANY($1::text[])',[revised[0]!.receipts])).rows;
    assert.ok(revisedRows.every(row=>!earlierSessions.includes(row.session_id)),'the edit is written to a new session revision');
    assert.ok((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[revisedRows[0]!.prepared_id])).rows[0].content.toString().includes(editedText));
    for(const session of earlierSessions) {
      assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=$1",['delete:'+session])).rows[0].count,1);
      assert.equal(await services.memory.deleteSession(session,authority),true);
    }
    assert.deepEqual(await services.memory.queueSource(after),[],'a superseded revision is never written again');
    assert.equal(await services.memory.ingested(after.id),false);assert.equal(await services.memory.ingested(edited.id),true);
    assert.deepEqual(await services.memory.queueSource(edited),revised,'queuing the latest revision again reuses its receipts');
    for(const receipt of revised[0]!.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    status=await services.memory.status();await services.memory.connection(owner,{attached:false,include_history:false,catch_up:false,expected_revision:status.connection.revision,operation_id:key+':detach'});
    const beforeDetached=calls.length;assert.equal(await services.memory.reconcileReceipt(rebuilt[0]!.receipts[0]!),false);assert.equal(calls.length,beforeDetached);
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

test('foreground recall requires independent source evidence while background context can learn the current question',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-current-question-')),key='current-question:'+Date.now(),group='-'+Date.now();
  const calls:string[]=[];let sequence=0;
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async(path,body:any)=>{
      calls.push(path);
      if(path.endsWith('/messages/list'))return {items:[]};
      if(path.endsWith('/messages'))return [{...body.messages[0],id:String(++sequence).padStart(21,'r')}];
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.includes('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'The current question asks for the meeting time.'}};
      if(path.endsWith('/representation'))return {representation:'The current question asks for the meeting time.'};
      if(path.endsWith('/chat'))return {content:'The independently recorded meeting time is 18:00.'};
      return {};
    })});
  // Stands in for the honcho refresh workflow finishing this epoch's correction sweep.
  const swept=async()=>{const binding=await services.guards.state();await stores.control.query(`INSERT INTO learning_refresh_sweeps(installation_generation,guard_epoch,family,stage)
    VALUES($1,$2,'honcho','done') ON CONFLICT(installation_generation,guard_epoch,family) DO UPDATE SET stage='done'`,[binding.generation,binding.epoch]);};
  const capture=async(id:number,text:string)=>{
    const event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:key+':'+id,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:id,date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:123},text}}};
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now() WHERE singleton');
    const earlier=await capture(1,'The meeting time is 18:00.'),question=await capture(2,'What was the meeting time?');
    const queued=await services.memory.queueSource(question),current=queued.find(item=>item.audience===group)!;
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    for(const receipt of current.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    const binding=await services.guards.state(),principal:Reader={admin:false,scope:group,space:group,turnEvent:question.id,
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const building=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(building.limited_memory,true);assert.deepEqual(building.sources,[]);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,0,'ingesting the question cannot establish a prior fact');
    assert.equal(await services.memory.settled(current.receipts),true);await swept();
    assert.equal((await services.memory.context(principal)).limited_memory,false);
    assert.ok(calls.some(path=>path.includes('/context?')),'background context retains the current source');
    // Older receipts without the evidence array retain the same source boundary.
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE generation=$1",[current.workspace]);
    const ready=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(ready.limited_memory,true);assert.deepEqual(ready.sources,[]);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,0,'a ready question-only workspace is still not historical memory');
    const older=(await services.memory.queueSource(earlier)).find(item=>item.audience===group)!;
    for(const receipt of older.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE id=ANY($1::text[])",[older.receipts]);
    assert.equal(await services.memory.settled(older.receipts),true);
    assert.equal(await services.memory.observe(older.workspace),true,'Honcho finished the workspace\'s work');
    const recalled=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(recalled.limited_memory,false);assert.match(recalled.sources[0]!.text,/independently recorded meeting time is 18:00/);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,1,'completed independent source evidence enables historical reasoning');
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

test('forwards and files the owner sent are kept apart from the owner\'s own words, and what Honcho already holds keeps its form',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-material-')),key='material:'+Date.now(),group='-'+Date.now(),bot=1000+Date.now()%1000;
  const calls:{path:string;body:any}[]=[];let sequence=0;
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async(path,body:any)=>{
      calls.push({path,body});
      if(path.endsWith('/messages/list'))return {items:[]};
      if(path.endsWith('/messages'))return [{...body.messages[0],id:String(++sequence).padStart(21,'m')}];
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.includes('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'Summary of the session.'},peer_representation:'What was learned.'};
      if(path.endsWith('/representation'))return {representation:'What was learned.'};
      if(path.endsWith('/chat'))return {content:'Recalled.'};
      return {};
    })});
  // Alice (123) owns Nocheh, Bob (456) is in the group and Sara (789) is only ever forwarded.
  const names:Record<number,string>={123:'Alice',456:'Bob',789:'Sara'},sara={type:'user',sender_user:{id:789,is_bot:false,first_name:'Sara'},date:1};
  const chatOf=(chat:string)=>chat==='123'?{id:123,type:'private'}:{id:Number(chat),type:'supergroup',is_forum:false};
  let serial=0;
  const say=async(chat:string,from:number,fields:Record<string,unknown>)=>{
    const id=++serial,text=(fields.text??fields.caption??null) as string|null;
    const event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',occurred_at:null,text,
      payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:chatOf(chat),from:{id:from,is_bot:false,first_name:names[from]},...fields}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  const nocheh=async(chat:string,text:string,send:Record<string,unknown>)=>{
    const id=++serial,reply={message_id:id,date:1700000000+id,chat:chatOf(chat),from:{id:bot,is_bot:true,first_name:'Nocheh'},text};
    const delivered:Envelope={version:1,key:key+':result:'+id,origin:'generated',bot_id:key,kind:'outbound_result',scope:chat,source_id:key+':'+id,revision:'0',occurred_at:null,text:null,
      payload:{intent_key:key+':intent:'+id,method:'sendMessage',state:'delivered',status:200,...send,wire_base64:Buffer.from(JSON.stringify({ok:true,result:reply})).toString('base64')}};
    const source=(await services.capture.capture(captureEvidence(delivered).originals[0]!)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  // Stands in for the file download and preparation: the file is kept, then its text read or its sound transcribed, and selected.
  const read=async(source:SourceReference,kind:'extracted_text'|'transcript',text:string)=>{
    const artifact=String((await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[source.id])).rows[0].id),bytes=Buffer.from('file '+source.id);
    await stores.archive.query('UPDATE artifacts SET file_hash=$2,byte_size=$3 WHERE id=$1',[artifact,digest(bytes),bytes.length]);
    const output=await services.derived.record({operation_id:key+':'+kind+':'+source.id,source,file:{store:'archive',kind:'file',id:artifact,event:source,input_hash:digest(bytes),
      byte_size:bytes.length},kind,content:Buffer.from(text),producer:'fixture',producer_version:'1',configuration:{}});
    await services.guards.prepare(output,'fixture',services.detect);await services.selections.activate(output,null,key+':select:'+source.id);
  };
  // Each live write of a source: who wrote it, its record kind, the kind and key of its session, and what it says.
  const written=async(source:{id:string})=>{
    const rows=(await stores.control.query(`SELECT r.id,r.peer_id,r.record_kind,r.session_key,r.prepared_id,s.kind FROM memory_ingestion_receipts r
      JOIN memory_sessions s ON s.session_id=r.session_id WHERE r.source_reference->>'id'=$1 AND r.retired_at IS NULL ORDER BY r.record_kind,r.peer_id`,[source.id])).rows;
    const contents=new Map((await stores.derived.query('SELECT id,content FROM derived_artifacts WHERE id=ANY($1::text[])',[rows.map(row=>row.prepared_id)])).rows
      .map(row=>[String(row.id),row.content.toString() as string]));
    return rows.map(row=>{const content=contents.get(row.prepared_id)!;
      return {id:String(row.id),writer:String(row.peer_id),record:String(row.record_kind),session:String(row.kind),key:String(row.session_key),content,value:JSON.parse(content.slice(content.indexOf('\n')+1))};});
  };
  const shape=(rows:Awaited<ReturnType<typeof written>>)=>rows.map(row=>[row.writer,row.record,row.session]);
  const swept=async()=>{const binding=await services.guards.state();await stores.control.query(`INSERT INTO learning_refresh_sweeps(installation_generation,guard_epoch,family,stage)
    VALUES($1,$2,'honcho','done') ON CONFLICT(installation_generation,guard_epoch,family) DO UPDATE SET stage='done'`,[binding.generation,binding.epoch]);};
  const reader=async(source:{id:string},chat:string):Promise<Reader>=>{const binding=await services.guards.state();
    return {admin:false,scope:chat==='123'?null:chat,space:chat,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};};
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now() WHERE singleton');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    const sync=async(queued:{receipts:string[]}[])=>{for(const item of queued)for(const receipt of item.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);};
    const owner:Reader={admin:true,scope:null},protocol=services.memory.engine.protocol,forwardsKey=materialSessionKey(protocol);
    const project=await services.projects.save(owner,{name:'Atlas',description:'Kept-apart memory fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':project-assignment'});

    // What Honcho holds in the earlier form is written exactly as before: same writer, same logical identity, no rebuild.
    const legacyOwn=await say(group,123,{text:'The plan is set for Friday.'});
    const legacyReply=await nocheh(group,'Noted, Friday it is.',{send_class:'reply'}),legacyCard=await nocheh(group,'Remember Friday?',{send_class:'card'});
    (services.memory as any).earlierForm=async()=>true;
    type Queued=Awaited<ReturnType<typeof services.memory.queueSource>>;
    const legacy:Queued=[];for(const source of [legacyOwn,legacyReply,legacyCard])legacy.push(...await services.memory.queueSource(source));
    delete (services.memory as any).earlierForm;
    const workspace=legacy[0]!.workspace;
    const earlier=await Promise.all([legacyOwn,legacyReply,legacyCard].map(written));
    assert.deepEqual(earlier.map(rows=>rows.map(row=>row.record)),Array(3).fill(['entity_evidence','source_evidence']));
    assert.ok(earlier.slice(1).every(rows=>rows.every(row=>row.writer===assistantPeer)),'Nocheh\'s messages are written by the assistant');
    assert.ok(earlier.flat().every(row=>typeof row.value.source!=='string'&&typeof row.value.observation?.source!=='string'),'the earlier form names no source');
    const receipts=(await stores.control.query(`SELECT * FROM memory_ingestion_receipts WHERE id=ANY($1::text[])`,[earlier.flat().map(row=>row.id)])).rows;
    for(const row of receipts) {
      const content=earlier.flat().find(item=>item.id===row.id)!.content;
      assert.equal(row.logical_id,digest(canonical([workspace,row.session_key,row.peer_id,row.subject_entity_id,row.source_references,row.dependencies,null,row.guard_mode,0,digest(content)])),
        'an earlier-form write keeps the identity its one writer gave it');
    }
    const revisions=async()=>(await stores.control.query('SELECT key,revision FROM memory_sessions WHERE workspace=$1 ORDER BY key',[workspace])).rows;
    const before=await revisions(),rebuild=services.memory.rebuild.bind(services.memory);let rebuilt=0;
    services.memory.rebuild=async(...args)=>{rebuilt++;return rebuild(...args);};
    try {
      for(const [index,source] of [legacyOwn,legacyReply,legacyCard].entries())
        assert.deepEqual((await services.memory.queueSource(source)).flatMap(item=>item.receipts).sort(),earlier[index]!.map(row=>row.id).sort(),
          'queued again, a source written before keeps every write');
    } finally {services.memory.rebuild=rebuild;}
    assert.equal(rebuilt,0,'no session is rebuilt');assert.deepEqual(await revisions(),before);
    await sync(legacy);

    // In the owner's private chat: the owner's own words, voice and own forward stay on the owner's participant.
    const typed=await say('123',123,{text:'OWNMARK I prefer the window seat.'});
    const ownForward=await say('123',123,{text:'EARLIERMARK my earlier note',forward_origin:{type:'user',sender_user:{id:123,is_bot:false,first_name:'Alice'},date:1}});
    const voice=await say('123',123,{voice:{file_id:key+':voice',file_unique_id:'v',duration:3}});await read(voice,'transcript','VOICEMARK call the hotel');
    // Someone else's forward, a file's text and a quote of someone else go to the participant of the owner's forwards and files.
    const forward=await say('123',123,{text:'FORWARDMARK the trip is in May',forward_origin:sara});
    const document=await say('123',123,{caption:'my CV',document:{file_id:key+':cv',file_unique_id:'d',file_name:'cv.pdf'}});await read(document,'extracted_text','FILEMARK resume text');
    const bare=await say('123',123,{document:{file_id:key+':notes',file_unique_id:'n',file_name:'notes.pdf'}});await read(bare,'extracted_text','BAREMARK notes text');
    const quote=await say('123',123,{text:'Sounds good',quote:{text:'QUOTEMARK May works',position:0},external_reply:{origin:sara}});
    const about=await nocheh('123','That forward says May.',{send_class:'reply',answers:forward.id});
    const queued:Queued=[];for(const source of [typed,ownForward,voice,forward,document,bare,quote,about])queued.push(...await services.memory.queueSource(source));
    assert.ok(queued.every(item=>item.audience==='owner'&&item.workspace===workspace));
    const [own]=await written(typed),ownerPeer=own!.writer,dm=own!.key;
    assert.match(ownerPeer,/^person_/);assert.deepEqual(shape([own!]),[[ownerPeer,'labelled_source','conversation']]);
    assert.equal(own!.value.source,honchoSource({part:'own'}));
    const ownForwarded=await written(ownForward);
    assert.deepEqual(shape(ownForwarded),[[ownerPeer,'labelled_source','conversation']]);assert.equal(ownForwarded[0]!.value.source,honchoSource({part:'own'}));
    const voiced=await written(voice);
    assert.deepEqual(shape(voiced),[[ownerPeer,'labelled_source','conversation']]);assert.equal(voiced[0]!.value.source,honchoSource({part:'recording'}));
    assert.ok(voiced[0]!.content.includes('VOICEMARK'),'the owner\'s own voice, transcribed, is the owner\'s');
    // Someone else's forward is kept whole in the session of forwards; the private chat keeps only a note that it came.
    const [kept,pointer]=await written(forward);
    assert.deepEqual(shape([kept!,pointer!]),[[materialPeer,'labelled_material','material'],[assistantPeer,'labelled_pointer','conversation']]);
    assert.equal(kept!.key,forwardsKey);assert.equal(pointer!.key,dm);assert.ok(kept!.content.includes('FORWARDMARK'));
    assert.equal(kept!.value.source,honchoSource({part:'forward',forward:{from:'person',name:'Sara'}}));
    assert.deepEqual(pointer!.value,honchoPointer('person'));assert.ok(!pointer!.content.includes('FORWARDMARK')&&!pointer!.content.includes('Sara'));
    // A file with a caption is two records in the private chat, so the caption still links to its file.
    const filed=await written(document);
    assert.deepEqual(shape(filed),[[materialPeer,'labelled_material','conversation'],[ownerPeer,'labelled_source','conversation']]);
    assert.ok(filed.every(row=>row.key===dm));assert.equal(filed[0]!.value.source,honchoSource({part:'file',name:'cv.pdf'}));
    assert.ok(filed[0]!.content.includes('FILEMARK'));assert.ok(!filed[1]!.content.includes('FILEMARK')&&filed[1]!.content.includes('my CV'));
    assert.deepEqual(shape(await written(bare)),[[materialPeer,'labelled_material','conversation']],'a file with no caption leaves nothing of the owner\'s');
    const quoted=await written(quote);
    assert.deepEqual(shape(quoted),[[materialPeer,'labelled_material','conversation'],[ownerPeer,'labelled_source','conversation']]);
    assert.equal(quoted[0]!.value.source,honchoSource({part:'quote'}));assert.ok(quoted[0]!.content.includes('QUOTEMARK'));
    assert.ok(!quoted[1]!.content.includes('QUOTEMARK')&&quoted[1]!.content.includes('Sounds good'));
    const answered=await written(about);
    assert.deepEqual(shape(answered),[[assistantPeer,'labelled_source','material']],'Nocheh\'s reply about a forward goes with it');
    assert.equal(answered[0]!.key,forwardsKey);assert.equal(answered[0]!.value.source,honchoSource({part:'nocheh',send_class:'reply',about_forward:true}));
    const ownerWrites=(await Promise.all([typed,ownForward,voice,forward,document,bare,quote,about].map(written))).flat().filter(row=>row.writer===ownerPeer);
    for(const mark of ['FORWARDMARK','FILEMARK','BAREMARK','QUOTEMARK'])
      assert.deepEqual(ownerWrites.filter(row=>row.content.includes(mark)).map(row=>[row.record,row.session,row.content]),[],'no owner write holds '+mark);
    assert.deepEqual(await services.memory.queueSource(forward),queued.filter(item=>item.receipts.includes(kept!.id)),'queued again, the same writes');
    // A pin carries the message it pinned: the owner's pin of their own forward of someone else's message is kept as that
    // forward is, and a pin of their own message stays theirs. The owner's quote of Nocheh's own learned reply is the
    // owner's words alone: Nocheh's message is learned as Nocheh's where it was sent.
    const alice={id:123,is_bot:false,first_name:'Alice'},pinned=(fields:Record<string,unknown>)=>({message_id:serial,date:1700000000,chat:chatOf('123'),from:alice,...fields});
    const pinForward=await say('123',123,{pinned_message:pinned({forward_origin:sara,text:'PINFORWARDMARK the trip moved'})});
    const pinOwn=await say('123',123,{pinned_message:pinned({text:'PINOWNMARK buy milk'})});
    const flight=await nocheh('123','NOCHEHMARK your flight is at 9',{send_class:'reply'}),flightId=serial;
    const thanks=await say('123',123,{text:'Thanks',quote:{text:'NOCHEHMARK your flight',position:0},
      reply_to_message:{message_id:flightId,date:1700000000+flightId,chat:chatOf('123'),from:{id:bot,is_bot:true,first_name:'Nocheh'},text:'NOCHEHMARK your flight is at 9'}});
    const pins:Queued=[];for(const source of [pinForward,pinOwn,flight,thanks])pins.push(...await services.memory.queueSource(source));
    const [pinKept,pinPointer]=await written(pinForward);
    assert.deepEqual(shape([pinKept!,pinPointer!]),[[materialPeer,'labelled_material','material'],[assistantPeer,'labelled_pointer','conversation']]);
    assert.equal(pinKept!.value.source,honchoSource({part:'forward',forward:{from:'person',name:'Sara'}}));assert.ok(pinKept!.content.includes('PINFORWARDMARK'));
    assert.deepEqual(pinPointer!.value,honchoPointer('person'));assert.ok(!pinPointer!.content.includes('PINFORWARDMARK'));
    const ownPin=await written(pinOwn);
    assert.deepEqual(shape(ownPin),[[ownerPeer,'labelled_source','conversation']]);assert.equal(ownPin[0]!.value.source,honchoSource({part:'own'}));
    assert.ok(ownPin[0]!.content.includes('PINOWNMARK'));
    const thanked=await written(thanks);
    assert.deepEqual(shape(thanked),[[ownerPeer,'labelled_source','conversation']],'nothing for the forwards and files');
    assert.equal(thanked[0]!.value.source,honchoSource({part:'own'}));
    assert.ok(thanked[0]!.content.includes('Thanks')&&!thanked[0]!.content.includes('NOCHEHMARK'),'the quote of Nocheh\'s reply is left out');
    // The owner's pin of Nocheh's own message leaves only a note in the chat that it was pinned: Nocheh's learned reply is
    // learned as Nocheh's where it was sent, and its card is not learned at all. Nothing goes to the forwards and files.
    const card=await nocheh('123','CARDMARK approve the booking?',{send_class:'card'}),cardId=serial;
    const pinNocheh=(id:number,text:string)=>say('123',123,{pinned_message:{message_id:id,date:1700000000+id,chat:chatOf('123'),
      from:{id:bot,is_bot:true,first_name:'Nocheh'},text}});
    const pinFlight=await pinNocheh(flightId,'NOCHEHMARK your flight is at 9'),pinCard=await pinNocheh(cardId,'CARDMARK approve the booking?');
    for(const source of [pinFlight,pinCard])pins.push(...await services.memory.queueSource(source));
    for(const source of [pinFlight,pinCard]) {
      const rows=await written(source);
      assert.deepEqual(shape(rows),[[assistantPeer,'labelled_pointer','conversation']]);assert.equal(rows[0]!.key,dm);
      assert.deepEqual(rows[0]!.value,honchoPointer('pinned_nocheh'));assert.doesNotMatch(rows[0]!.content,/NOCHEHMARK|CARDMARK/);
    }
    assert.ok(card.id);
    // In a group, a member's forward stays on the member with its source; the owner's forward of someone else goes to the
    // forwards-and-files participant in that group's own session, and its evidence names no speaker.
    const memberForward=await say(group,456,{text:'MEMBERMARK the office closes early',forward_origin:{type:'channel',chat:{id:-1009,type:'channel',title:'News'},message_id:3,date:1}});
    const member=await services.memory.queueSource(memberForward);
    const [memberEntity,memberSource]=await written(memberForward);
    assert.deepEqual([memberEntity!.record,memberSource!.record],['labelled_entity','labelled_source']);
    assert.ok([memberEntity!.writer,memberSource!.writer].every(writer=>writer===memberSource!.writer&&writer!==ownerPeer&&writer!==materialPeer));
    assert.equal(memberSource!.value.source,honchoSource({part:'forward',forward:{from:'channel',name:'News'}}));
    assert.equal(memberEntity!.value.attribution,'reported');assert.equal(memberEntity!.value.original_speaker.name,'Bob');
    await sync([...queued,...pins,...member]);
    assert.equal(await services.memory.observe(workspace),true);await swept();
    // The owner's forwards and files in the private chat are not asked in a group's recall.
    const groupReader=await reader(memberForward,group);
    let asked=calls.length;
    await services.memory.recall(groupReader,'When does the office close?');
    assert.ok(!calls.slice(asked).some(call=>call.path.endsWith('/peers/'+materialPeer+'/chat')),'nothing of theirs was written in the group');
    const groupForward=await say(group,123,{text:'GROUPFORWARDMARK the venue moved',forward_origin:sara});
    const groupQueued=await services.memory.queueSource(groupForward);
    const [groupEntity,groupMaterial]=await written(groupForward),groupKey=memberSource!.key;
    assert.deepEqual(shape([groupEntity!,groupMaterial!]),[[materialPeer,'labelled_entity','entity_evidence'],[materialPeer,'labelled_material','conversation']]);
    assert.equal(groupMaterial!.key,groupKey,'in a group, what is kept apart stays in the group\'s own session');
    assert.equal(groupEntity!.key,digest(canonical([protocol,'entity-evidence-material',groupKey,groupEntity!.value.subject.id])));
    assert.notEqual(groupEntity!.key,memberEntity!.key,'evidence of what is kept apart has a session of its own');
    assert.deepEqual([groupEntity!.value.original_speaker,groupEntity!.value.attribution,groupEntity!.value.observation.source],
      [null,'reported',honchoSource({part:'forward',forward:{from:'person',name:'Sara'}})]);
    await sync(groupQueued);
    // The owner's pin of a member's message in a group is kept on the forwards-and-files participant, in the group's own session.
    const groupPin=await say(group,123,{pinned_message:{message_id:serial,date:1700000000,chat:chatOf(group),from:{id:456,is_bot:false,first_name:'Bob'},text:'PINGROUPMARK office closed'}});
    const groupPinQueued=await services.memory.queueSource(groupPin),pinRows=await written(groupPin);
    assert.ok(pinRows.length>0&&pinRows.every(row=>row.writer===materialPeer),JSON.stringify(shape(pinRows)));
    const pinMaterial=pinRows.find(row=>row.record==='labelled_material')!;
    assert.deepEqual([pinMaterial.session,pinMaterial.key],['conversation',groupKey]);assert.equal(pinMaterial.value.source,honchoSource({part:'pinned'}));
    assert.ok(pinMaterial.content.includes('PINGROUPMARK'));
    await sync(groupPinQueued);
    // Honcho learns from what the participant writes, and it learns from no one else's writes.
    const forwardsSession=(await stores.control.query('SELECT session_id FROM memory_sessions WHERE workspace=$1 AND key=$2',[workspace,forwardsKey])).rows[0].session_id;
    assert.ok(calls.some(call=>call.path==='/v3/workspaces/'+workspace+'/peers'&&canonical(call.body)===canonical({id:materialPeer})));
    assert.ok(calls.some(call=>call.path==='/v3/workspaces/'+workspace+'/sessions'&&call.body.id===forwardsSession&&
      canonical(call.body.peers[materialPeer])===canonical({observe_me:true,observe_others:false})));
    assert.ok(calls.some(call=>call.path==='/v3/workspaces/'+workspace+'/sessions/'+forwardsSession+'/messages'&&call.body.messages[0].peer_id===materialPeer));
    asked=calls.length;
    await services.memory.recall(groupReader,'Where is the venue?');
    const groupAsk=calls.slice(asked).find(call=>call.path.endsWith('/peers/'+materialPeer+'/chat'))!;
    const groupSessions=(await stores.control.query('SELECT session_id FROM memory_sessions WHERE audience=$1',[group])).rows.map(row=>row.session_id).sort();
    assert.ok(groupAsk,'a group asks them once they wrote something there');assert.ok(groupAsk.body.filters.session_id.every((id:string)=>groupSessions.includes(id)));

    // An owner turn reads the private chat and the forwards and files side by side; a prefetch serves both.
    assert.equal(await services.memory.observe(workspace),true);await swept();
    const prefetching=(await stores.control.query(`SELECT session_id,kind,audience FROM memory_sessions WHERE workspace=$1 AND kind IN ('conversation','material')
      AND prefetched_revision<work_revision`,[workspace])).rows;
    assert.ok(prefetching.some(row=>row.kind==='material'));
    assert.equal(await services.memory.requestPrefetch(workspace),prefetching.length);
    // The space is the installation's, so other cases' chats are in it too; only this case's chats are served here.
    for(const row of prefetching.filter(row=>['owner',group].includes(row.audience)))assert.equal(await services.memory.prefetch(row.session_id),true);
    const guarded=async()=>(await stores.derived.query("SELECT count(*)::int AS count FROM derived_artifacts WHERE operation_id LIKE 'native-context:%'")).rows[0].count;
    const ownerReader=await reader(typed,'123'),checked=await guarded();asked=calls.length;
    const context=await services.memory.context(ownerReader) as any;
    const reads=calls.slice(asked).filter(call=>call.path.includes('/context?')).map(call=>call.path);
    assert.equal(reads.length,2);
    assert.ok(reads.some(path=>path.includes('/sessions/'+forwardsSession+'/context?')&&path.includes('peer_target='+materialPeer)&&!path.includes('limit_to_session')));
    assert.ok(reads.some(path=>path.includes('peer_target='+ownerPeer)));
    assert.deepEqual(context.sources.map((source:any)=>source.about),['owner','forwards_and_files']);
    assert.match(context.sources[0].text,/^\[conversation summary\][\s\S]*\[what is known about the owner; it may include conclusions drawn from things the owner forwarded or sent\]/);
    assert.match(context.sources[1].text,/^\[summary of messages the owner forwarded from other people\][\s\S]*\[from forwards \(other people's words\) and files the owner sent/);
    assert.equal(await guarded(),checked,'the prefetched blocks are reused without a new check');
    // Owner recall asks them too, under their own header.
    asked=calls.length;
    const recalled=await services.memory.recall(ownerReader,'When is the trip?');
    const ownerAsk=calls.slice(asked).find(call=>call.path.endsWith('/peers/'+materialPeer+'/chat'))!;
    assert.ok(ownerAsk);assert.equal(ownerAsk.body.filters,undefined);
    assert.ok(recalled.sources.some(source=>source.text.includes('[related through the owner\'s forwards and files: information other people or files wrote, not the owner\'s words]')));
    // Nocheh's card stays where an earlier form wrote it: a sweep finds every write valid.
    const binding=await services.guards.state();
    for(let after='',done=false;!done;)({after,done}=await services.memory.sweep(after,binding));
    assert.deepEqual((await written(legacyCard)).map(row=>row.id),earlier[2]!.map(row=>row.id),'an earlier card write stays');
    // A source whose earlier-form writes a rebuild retired is written in the earlier form again when it is queued again.
    const retiring=await written(legacyOwn);
    for(const sessionKey of new Set(retiring.map(row=>row.key)))await services.memory.rebuild(workspace,sessionKey,new Set(retiring.map(row=>row.id)));
    assert.deepEqual(await written(legacyOwn),[]);
    await services.memory.queueSource(legacyOwn);
    assert.deepEqual((await written(legacyOwn)).map(row=>row.record),['entity_evidence','source_evidence'],'never the labelled form for a source Honcho held before');
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});
