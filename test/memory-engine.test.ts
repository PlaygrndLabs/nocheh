import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {engineErrors,engineRejected,engineSummary} from '../src/memory/engine.js';
import {HonchoEngine,honchoClient,readingInstructions,type HonchoCall} from '../src/memory/honcho.js';
import {materialPeer} from '../src/stores/native-memory.js';

type Call={path:string;body:unknown;method:string|undefined};
/** A fake Honcho that records each call and answers from a route table. */
function fake(answer:(path:string,body:any,method?:string)=>unknown) {
  const calls:Call[]=[];
  const call:HonchoCall=async(path,body,method)=>{calls.push({path,body,method});return answer(path,body,method);};
  return {calls,engine:new HonchoEngine(call)};
}
const id=(n:number)=>String(n).padStart(21,'c');
const receipt='a'.repeat(64);

test('the Honcho engine describes itself through the socket',()=>{
  const {engine}=fake(()=>({}));
  assert.deepEqual(engineSummary(engine),{id:'honcho',name:'Honcho',capabilities:{inspect:true,evidence:true,retry_failed_learning:true}});
  assert.deepEqual(engine.questionLimits,{characters:200000,bytes:92160});
  assert.equal(engine.protocol,'honcho-entity-v1');
});

test('the Honcho client turns transport and upstream failures into socket codes',async t=>{
  assert.throws(()=>honchoClient('http://user:pass@synthetic-honcho'),/invalid_honcho_url/);
  const warnings=t.mock.method(console,'warn',()=>{});
  const server=createServer((req,res)=>{
    if(req.method==='DELETE'){res.writeHead(404);res.end();return;}
    res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({detail:[{loc:['body','id'],type:'missing',input:'private text'}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const call=honchoClient('http://127.0.0.1:'+address.port);
  try {
    await assert.rejects(call('/v3/workspaces',{id:'x'}),{code:engineErrors.rejected,status:503});
    assert.doesNotMatch(String(warnings.mock.calls[0]!.arguments[0]),/private text/,'a rejection names fields, never their input');
    assert.deepEqual(await call('/v3/workspaces/x',undefined,'DELETE'),{deleted:false});
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
  // Nothing listens on the closed port any more.
  await assert.rejects(call('/v3/workspaces'),{code:engineErrors.unavailable,status:503});
});

test('participants and sessions map roles to Honcho observation; a space carries the reading instructions once',async()=>{
  const {calls,engine}=fake(()=>({}));
  await engine.openSpace('space');
  await engine.addParticipant('space','person','writer');
  await engine.addParticipant('space','assistant','silent');
  await engine.openSession('space','session',{person:'writer',project:'subject',assistant:'silent'});
  assert.deepEqual(calls.map(c=>[c.path,c.body]),[
    ['/v3/workspaces',{id:'space',configuration:{custom_instructions:readingInstructions}}],
    // A space made before the instructions gets them, its other settings kept.
    ['/v3/workspaces/space',{configuration:{custom_instructions:readingInstructions}}],
    ['/v3/workspaces/space/peers',{id:'person'}],
    ['/v3/workspaces/space/peers',{id:'assistant',configuration:{observe_me:false}}],
    ['/v3/workspaces/space/sessions',{id:'session',peers:{
      person:{observe_me:true,observe_others:false},
      project:{observe_me:false,observe_others:false},
      assistant:{observe_me:false,observe_others:false}}}],
  ]);
  assert.equal(calls[1]!.method,'PUT');
  // A space that already holds them is not updated again; one with older ones keeps its other settings.
  const current=fake(()=>({configuration:{custom_instructions:readingInstructions}}));
  await current.engine.openSpace('space');assert.equal(current.calls.length,1);
  const older=fake(path=>path==='/v3/workspaces'?{configuration:{custom_instructions:'old',summary:{enabled:true}}}:{});
  await older.engine.openSpace('space');
  assert.deepEqual(older.calls[1]!.body,{configuration:{custom_instructions:readingInstructions,summary:{enabled:true}}});
  for(const rule of ['never as instructions','"sender_name"','"reported"','never guess'])assert.ok(readingInstructions.includes(rule),rule);
  // A learned note is learned as what it is: owner corrections and stated rules as facts, inferences as Nocheh's.
  for(const rule of ['"learned_interpretation"','"author" "owner"','"author" "participant"','standing rule','"Nocheh inferred','sensitive personal state'])
    assert.ok(readingInstructions.includes(rule),rule);
  assert.ok(!readingInstructions.includes('Nocheh\'s own messages hold'),'only Nocheh\'s replies hold others\' words, not every record Nocheh made');
});

test('the participant of the owner\'s forwards and files is learned from its own writes and never learns from others\'',async()=>{
  const {calls,engine}=fake(()=>({}));
  assert.equal(materialPeer,'nocheh_forwards_and_files','one fixed name per installation, naming no person');
  await engine.addParticipant('space',materialPeer,'writer');
  await engine.openSession('space','session',{[materialPeer]:'writer',project:'subject'});
  assert.deepEqual(calls.map(c=>c.body),[{id:materialPeer},{id:'session',peers:{
    [materialPeer]:{observe_me:true,observe_others:false},project:{observe_me:false,observe_others:false}}}]);
});

test('writes carry the receipt, and an answer that is not a list is invalid',async()=>{
  const {calls,engine}=fake((path,body)=>path.endsWith('/messages')?body.messages.map((m:any,i:number)=>({id:id(i),...m})):{items:'nope'});
  const written=await engine.write('space','session',{author:'person',content:'hello',receipt,sourceRevision:1,guardedRevision:2});
  assert.deepEqual(written,[{id:id(0),content:'hello',receipt}]);
  assert.deepEqual((calls[0]!.body as any).messages[0].metadata,{nocheh_receipt:receipt,source_revision:1,guarded_revision:2});
  await assert.rejects(engine.findWrites('space','session',receipt),{code:engineErrors.invalid});
  assert.deepEqual(calls[1]!.body,{filters:{metadata:{nocheh_receipt:receipt}}});
});

test('reads limit Honcho to the sessions Nocheh allows',async()=>{
  const {calls,engine}=fake(path=>{
    if(path.endsWith('/chat'))return {content:'answer',evidence:{conclusions:[{id:id(1)},{id:id(1)},{id:'bad id'}]}};
    if(path.endsWith('/search'))return [{id:id(2),metadata:{nocheh_receipt:receipt}},{id:id(3),metadata:{}}];
    if(path.includes('/context'))return {summary:{content:'summary'},peer_representation:'subject'};
    return {};
  });
  assert.deepEqual(await engine.ask('space','person','question?',{sessions:['s1'],evidence:true}),{text:'answer',evidence:[id(1)]});
  assert.deepEqual(calls.at(-1)!.body,{query:'question?',reasoning_level:'low',stream:false,include_evidence:true,filters:{session_id:['s1']}});
  await engine.ask('space','person','question?',{sessions:null,evidence:false});
  assert.deepEqual(calls.at(-1)!.body,{query:'question?',reasoning_level:'low',stream:false});
  await engine.ask('space','person','question?',{sessions:null,evidence:false,format:{type:'object'}});
  assert.deepEqual(calls.at(-1)!.body,{query:'question?',reasoning_level:'low',stream:false,response_format:{type:'object'}});
  assert.deepEqual(await engine.search('space','query',{limit:5,sessions:['s1','s2']}),[{id:id(2),receipt}]);
  assert.deepEqual(calls.at(-1)!.body,{query:'query',limit:5,filters:{session_id:{in:['s1','s2']}}});
  assert.deepEqual(await engine.context('space','s1',{subject:'person',limitToSession:true,tokens:800}),{summary:'summary',subject:'subject',summaryMessage:null});
  assert.equal(calls.at(-1)!.path,'/v3/workspaces/space/sessions/s1/context?tokens=800&summary=true&peer_target=person&limit_to_session=true');
});

test('an ask without text is an invalid answer',async()=>{
  const {engine}=fake(()=>({content:null}));
  await assert.rejects(engine.ask('space','person','q',{sessions:null,evidence:false}),{code:engineErrors.invalid});
});

test('forgetting a session removes derived facts first, one bounded step at a time',async()=>{
  let pending=[id(1),id(2)];
  const {calls,engine}=fake((path)=>{
    if(path.endsWith('/nocheh/session-descendants')){const ids=pending;pending=[];return {ids};}
    return {deleted:true};
  });
  assert.deepEqual(await engine.forgetSession('space','s1'),{done:false,removed:2});
  assert.deepEqual(await engine.forgetSession('space','s1'),{done:true,removed:0});
  assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.path),[
    '/v3/workspaces/space/conclusions/'+id(1),'/v3/workspaces/space/conclusions/'+id(2),'/v3/workspaces/space/sessions/s1']);
  const bad=fake(()=>({ids:['not a native id']}));
  await assert.rejects(bad.engine.forgetSession('space','s1'),{code:'invalid_honcho_descendants'});
});

test('forgetting a space deletes its sessions before the space',async()=>{
  let sessions=[{id:'s1'},{id:'s2'}];
  const {calls,engine}=fake((path)=>{
    if(path.includes('/sessions/list')){const items=sessions;sessions=[];return {items};}
    return {deleted:true};
  });
  assert.deepEqual(await engine.forgetSpace('space'),{done:false,removed:2});
  assert.deepEqual(await engine.forgetSpace('space'),{done:true,removed:0});
  assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.path),
    ['/v3/workspaces/space/sessions/s1','/v3/workspaces/space/sessions/s2','/v3/workspaces/space']);
});

test('a trace must answer for exactly the facts asked about',async()=>{
  const good={roots:[id(1)],nodes:[{id:id(1),parents:[id(2)],exact_citations:true},{id:id(2),parents:[],deleted:true,exact_citations:false}],
    messages:[{message_id:id(3),receipt_id:receipt}],limitations:['partial']};
  assert.deepEqual(await fake(()=>good).engine.trace('space',[id(1)]),{
    facts:[{id:id(1),parents:[id(2)],deleted:false,exactCitations:true},{id:id(2),parents:[],deleted:true,exactCitations:false}],
    writes:[{id:id(3),receipt}],limitations:['partial']});
  await assert.rejects(fake(()=>({...good,roots:[id(9)]})).engine.trace('space',[id(1)]),{code:'invalid_honcho_provenance'});
  await assert.rejects(fake(()=>({...good,nodes:[{id:id(1),parents:[]}]})).engine.trace('space',[id(1)]),{code:'invalid_honcho_provenance'},
    'every fact says whether it cites its writes');
  await assert.rejects(fake(()=>({...good,messages:[{message_id:id(3),receipt_id:'short'}]})).engine.trace('space',[id(1)]),{code:'invalid_honcho_provenance'});
  const asked=fake(()=>good);
  await assert.rejects(asked.engine.trace('space',['abc']),{code:'invalid_provenance_request',status:400});
  assert.equal(asked.calls.length,0,'a malformed fact id never reaches Honcho');
});

test('progress reads Honcho queue state and checks its answers',async()=>{
  const {engine}=fake(path=>path.includes('/queue/status')?{pending_work_units:0,in_progress_work_units:1}
    :path.includes('/failed-learning/retry')?{retried:-1}:path.includes('/failed-learning')?{failed:3}:{failed_items:'yes'});
  assert.equal(await engine.busy('space'),true);
  assert.equal(await engine.failedLearning('space'),3);
  await assert.rejects(engine.retryFailedLearning('space'),{code:'invalid_honcho_retry'});
  await assert.rejects(engine.failing('space'),{code:'honcho_queue_health_invalid'});
});

/** A conclusion as Honcho's stock list answers it. */
const conclusion=(n:number,extra:Record<string,unknown>={})=>({id:id(n),content:'fact '+n,observer_id:'person',observed_id:'person',session_id:'s1',
  level:'explicit',source_ids:[],source_message_ids:null,times_derived:1,created_at:'2026-11-03T14:12:00.000000Z',...extra});
const listPath='/v3/workspaces/space/conclusions/list';

test('the start-of-turn summary names the last write it covers',async()=>{
  const {engine}=fake(()=>({summary:{content:'summary',message_id:id(7)},peer_representation:'subject'}));
  assert.deepEqual(await engine.context('space','s1',{subject:null,limitToSession:false,tokens:800}),{summary:'summary',subject:'subject',summaryMessage:id(7)});
  for(const answer of [{},{summary:{content:'summary',message_id:'not a message id'}},{summary:{message_id:id(7)}}])
    assert.equal((await fake(()=>answer).engine.context('space','s1',{subject:null,limitToSession:false,tokens:800})).summaryMessage,null);
});

test('facts come from the stock list with their cited writes, and uncited ones ask the plugin for their batch',async()=>{
  const {calls,engine}=fake((path,body)=>{
    if(path.startsWith(listPath))return body.filters.session_id?{items:[conclusion(1,{source_message_ids:[id(11),id(12),id(11)]}),conclusion(2)],next_page:'next-cursor'}
      :{items:[conclusion(3,{session_id:null})],next_page:null};
    if(path.endsWith('/nocheh/provenance'))return {roots:body.conclusion_ids,limitations:['message_limit'],
      nodes:body.conclusion_ids.map((v:string)=>({id:v,parents:[],deleted:false,exact_citations:false,messages_truncated:true,messages:[{message_id:id(21),receipt_id:receipt}]}))};
    throw Error('unexpected '+path);
  });
  const first=await engine.facts('space','person',{sessions:['s1'],size:100,cursor:null});
  assert.deepEqual(calls.map(c=>[c.path,c.body]),[
    [listPath+'?size=100&cursor=',{filters:{observer_id:'person',observed_id:'person',level:'explicit',session_id:{in:['s1']}}}],
    ['/v3/workspaces/space/nocheh/provenance',{conclusion_ids:[id(2)],depth:0,per_node:true}],
  ],'cited facts never reach the plugin');
  assert.deepEqual(first,{next:'next-cursor',limitations:['message_limit'],facts:[
    {id:id(1),content:'fact 1',session:'s1',writes:[id(11),id(12)],exact:true,complete:true,derived:1,createdAt:'2026-11-03T14:12:00.000000Z'},
    {id:id(2),content:'fact 2',session:'s1',writes:[id(21)],exact:false,complete:false,derived:1,createdAt:'2026-11-03T14:12:00.000000Z'}]});
  calls.length=0;
  const second=await engine.facts('space','person',{sessions:null,size:50,cursor:'next-cursor'});
  assert.equal(calls[0]!.path,listPath+'?size=50&cursor=next-cursor');
  assert.deepEqual(calls[0]!.body,{filters:{observer_id:'person',observed_id:'person',level:'explicit'}},'the owner reads the whole space');
  assert.equal(second.next,null);
  calls.length=0;
  assert.deepEqual(await engine.facts('space','person',{sessions:[],size:100,cursor:null}),{facts:[],next:null,limitations:[]});
  assert.equal(calls.length,0,'no allowed session reads nothing');
  await assert.rejects(engine.facts('space','person',{sessions:null,size:101,cursor:null}),{code:'invalid_fact_request',status:400});
});

test('every participant\'s facts for the owner\'s dashboard: by the stock list\'s filters, never one peer\'s facts about another (ADR-0261 step 4)',async()=>{
  const pages:Record<string,unknown>={
    '':{items:[conclusion(1,{observer_id:'bob',observed_id:'ana',source_message_ids:[id(11)]})],next_page:'p2'},
    p2:{items:[conclusion(2,{observer_id:'ana',observed_id:'ana',source_message_ids:[id(11),id(12)]}),conclusion(3,{observer_id:'bob',observed_id:'bob'})],next_page:'p3'}};
  const {calls,engine}=fake((path,body)=>{
    if(path.startsWith(listPath))return pages[new URL('http://h'+path).searchParams.get('cursor')!];
    if(path.endsWith('/nocheh/provenance'))return {roots:body.conclusion_ids,limitations:[],
      nodes:body.conclusion_ids.map((v:string)=>({id:v,parents:[],deleted:false,exact_citations:false,messages_truncated:false,messages:[{message_id:id(21),receipt_id:receipt}]}))};
    throw Error('unexpected '+path);
  });
  const all=await engine.everyFact('space',{sessions:['s1'],size:25,cursor:null});
  assert.deepEqual(calls.filter(c=>c.path.startsWith(listPath)).map(c=>[c.path,c.body]),[
    [listPath+'?size=25&cursor=',{filters:{level:'explicit',session_id:{in:['s1']}}}],
    [listPath+'?size=25&cursor=p2',{filters:{level:'explicit',session_id:{in:['s1']}}}]],'a page of only one peer\'s facts about another is followed by the next');
  assert.deepEqual(all.facts.map(f=>[f.id,f.participant,f.writes,f.exact]),[[id(2),'ana',[id(11),id(12)],true],[id(3),'bob',[id(21)],false]],
    'each names whose fact it is; an uncited one gets its batch');
  assert.equal(all.next,'p3');
  calls.length=0;
  const citing=await fake((path,body)=>{calls.push({path,body,method:undefined});return {items:[conclusion(4,{source_message_ids:[id(11)]})],next_page:null};})
    .engine.everyFact('space',{sessions:null,citing:[id(11)],size:25,cursor:null});
  assert.deepEqual(calls[0]!.body,{filters:{level:'explicit',source_message_ids:{in:[id(11)]}}});
  assert.deepEqual(citing.facts.map(f=>[f.id,f.participant,f.exact]),[[id(4),'person',true]]);
  for(const answer of [{items:[conclusion(5,{source_message_ids:[id(12)]})],next_page:null},{items:[conclusion(5)],next_page:null},
    {items:[conclusion(5,{observer_id:'not an id!',observed_id:'not an id!',source_message_ids:[id(11)]})],next_page:null}])
    await assert.rejects(fake(()=>answer).engine.everyFact('space',{sessions:null,citing:[id(11)],size:25,cursor:null}),{code:engineErrors.invalid},
      'a fact that cites none of the messages asked about is a broken answer');
  assert.deepEqual(await engine.everyFact('space',{sessions:null,citing:[],size:25,cursor:null}),{facts:[],next:null,limitations:[]});
  await assert.rejects(engine.everyFact('space',{sessions:null,citing:['short'],size:25,cursor:null}),{code:'invalid_fact_request'});
});

test('a fact list that is not what was asked is a broken answer',async()=>{
  const answers:Record<string,unknown>[]=[
    {items:[conclusion(1,{observed_id:'someone else'})],next_page:null},
    {items:[conclusion(1,{session_id:'s2'})],next_page:null},
    {items:[conclusion(1,{level:'deductive'})],next_page:null},
    {items:[conclusion(1,{source_message_ids:['short']})],next_page:null},
    {items:[conclusion(1,{created_at:'yesterday'})],next_page:null},
    {items:[conclusion(1)],total:1,page:1,pages:1},
  ];
  for(const answer of answers)
    await assert.rejects(fake(()=>answer).engine.facts('space','person',{sessions:['s1'],size:100,cursor:null}),{code:engineErrors.invalid},JSON.stringify(answer));
});

test('an uncited fact keeps no writes when the plugin cannot name its batch, and says why',async()=>{
  const list={items:[conclusion(1),conclusion(2,{source_message_ids:[id(11)]})],next_page:null};
  const run=async(plugin:(body:any)=>unknown)=>fake((path,body)=>path.startsWith(listPath)?list:plugin(body)).engine.facts('space','person',{sessions:null,size:100,cursor:null});
  const old=await run(body=>({roots:body.conclusion_ids,nodes:[{id:id(1),parents:[],deleted:false,exact_citations:false}],messages:[{message_id:id(21),receipt_id:receipt}],limitations:[]}));
  assert.deepEqual(old.limitations,['fact_batches_unsupported'],'an older plugin flattens its messages, so none is credited to a fact');
  assert.deepEqual(old.facts.map(f=>[f.writes,f.exact,f.complete]),[[[],null,false],[[id(11)],true,true]]);
  const down=await run(()=>{throw engineRejected();});
  assert.deepEqual([down.limitations,down.facts[0]!.writes,down.facts[0]!.exact],[['fact_batches_unavailable'],[],null]);
  const broken=await run(body=>({roots:body.conclusion_ids,limitations:[],nodes:[{id:id(9),parents:[],exact_citations:false,messages_truncated:false,messages:[{message_id:id(21),receipt_id:receipt}]}]}));
  assert.deepEqual([broken.limitations,broken.facts[0]!.writes],[['fact_batches_invalid'],[]],'a node for a fact not asked about');
  const tooMany=await run(body=>({roots:body.conclusion_ids,limitations:[],nodes:[{id:id(1),parents:[],exact_citations:false,messages_truncated:false,
    messages:Array.from({length:9},(_,n)=>({message_id:id(30+n),receipt_id:receipt}))}]}));
  assert.deepEqual(tooMany.limitations,['fact_batches_invalid']);
  const gone=await run(body=>({roots:body.conclusion_ids,limitations:['conclusion_unavailable'],nodes:[]}));
  assert.deepEqual([gone.limitations,gone.facts[0]!.exact,gone.facts[0]!.complete],[['conclusion_unavailable'],null,false]);
  // A whole batch is still never complete: Honcho keeps only the observed peer's messages of it, never the others' the
  // fact may rest on (H1); nor is a fact with no message named at all (L3).
  const whole=await run(body=>({roots:body.conclusion_ids,limitations:[],nodes:[{id:id(1),parents:[],exact_citations:false,messages_truncated:false,
    messages:[{message_id:id(21),receipt_id:receipt}]}]}));
  assert.deepEqual([whole.facts[0]!.writes,whole.facts[0]!.exact,whole.facts[0]!.complete],[[id(21)],false,false]);
  const none=await run(body=>({roots:body.conclusion_ids,limitations:[],nodes:[{id:id(1),parents:[],exact_citations:null,messages_truncated:false,messages:[]}]}));
  assert.deepEqual([none.facts[0]!.writes,none.facts[0]!.exact,none.facts[0]!.complete],[[],null,false]);
  // Listed without batches, they are asked for once the caller chose its facts (L5).
  const later=fake((path,body)=>path.startsWith(listPath)?list:{roots:body.conclusion_ids,limitations:[],
    nodes:[{id:id(1),parents:[],exact_citations:false,messages_truncated:false,messages:[{message_id:id(21),receipt_id:receipt}]}]});
  const page=await later.engine.facts('space','person',{sessions:null,size:100,cursor:null,batches:false});
  assert.deepEqual([page.facts[0]!.writes,later.calls.length],[[],1],'no plugin call while listing');
  assert.deepEqual(await later.engine.factBatches('space',page.facts.slice(0,1)),[]);
  assert.deepEqual([page.facts[0]!.writes,later.calls.length],[[id(21)],2]);
});

test('facts by id keep the order asked for, the reader\'s sessions and only facts that still exist',async()=>{
  const ids=Array.from({length:150},(_,n)=>id(n+1));
  const {calls,engine}=fake((path,body)=>{
    if(path.startsWith(listPath))return {items:body.filters.id.in.filter((v:string)=>v!==id(2)).reverse().map((v:string)=>conclusion(Number(v.replace(/c/g,'')),{source_message_ids:[id(500)]})),next_page:null};
    throw Error('unexpected '+path);
  });
  const found=await engine.factsById('space','person',[...ids,id(1)],{sessions:['s1']});
  assert.equal(calls.length,2,'a hundred ids per list call');
  assert.deepEqual(calls.map(c=>(c.body as any).filters.id.in.length),[100,50]);
  assert.deepEqual((calls[0]!.body as any).filters.session_id,{in:['s1']});
  assert.equal(calls[0]!.path,listPath+'?size=100&cursor=');
  assert.deepEqual(found.facts.map(f=>f.id),ids.filter(v=>v!==id(2)),'a deleted fact is left out; the rest keep the order asked');
  const stray=fake(()=>({items:[conclusion(99)],next_page:null}));
  await assert.rejects(stray.engine.factsById('space','person',[id(1)],{sessions:null}),{code:engineErrors.invalid});
  await assert.rejects(stray.engine.factsById('space','person',['bad'],{sessions:null}),{code:'invalid_fact_request'});
  const none=fake(()=>{throw Error('no call');});
  assert.deepEqual(await none.engine.factsById('space','person',[id(1)],{sessions:[]}),{facts:[],limitations:[]});
});

test('a fact exists only while Honcho still lists it for its peer',async()=>{
  let items:unknown[]=[conclusion(4)];
  const {calls,engine}=fake(()=>({items,next_page:null}));
  assert.equal(await engine.factExists('space','person',id(4)),true);
  assert.deepEqual(calls[0],{path:listPath+'?size=1&cursor=',method:undefined,
    body:{filters:{observer_id:'person',observed_id:'person',level:'explicit',id:{in:[id(4)]}}}});
  items=[];
  assert.equal(await engine.factExists('space','person',id(4)),false);
  await assert.rejects(engine.factExists('space','person','x'),{code:'invalid_fact_request'});
});

test('the most-derived facts follow Honcho\'s profile order over at most three pages',async()=>{
  const pages:{items:unknown[];next_page:string|null}[]=[
    {items:[conclusion(1,{times_derived:2,created_at:'2026-11-03T14:12:00Z',source_message_ids:[id(9)]}),
      conclusion(2,{times_derived:3,created_at:'2026-11-01T10:00:00Z',source_message_ids:[id(9)]})],next_page:'p2'},
    {items:[conclusion(4,{times_derived:2,created_at:'2026-11-03T14:12:00.000001Z',source_message_ids:[id(9)]}),
      conclusion(3,{times_derived:2,created_at:'2026-11-03T14:12:00.000001Z',source_message_ids:[id(9)]})],next_page:'p3'},
    {items:[conclusion(5,{times_derived:2,created_at:'2026-11-02T00:00:00Z',source_message_ids:[id(9)]})],next_page:'p4'},
  ];
  const {calls,engine}=fake(()=>pages.shift());
  const result=await engine.mostDerived('space','person',{sessions:null});
  assert.deepEqual(calls.map(c=>c.path),[listPath+'?size=100&cursor=',listPath+'?size=100&cursor=p2',listPath+'?size=100&cursor=p3']);
  assert.deepEqual((calls[0]!.body as any).filters.times_derived,{gte:2});
  assert.deepEqual(result.facts.map(f=>f.id),[id(2),id(3),id(4),id(1),id(5)],'most derived, then newest to the microsecond, then id');
  assert.equal(result.complete,false,'more than three pages were derived twice or more');
  pages.push({items:[],next_page:null});
  assert.equal((await engine.mostDerived('space','person',{sessions:null})).complete,true);
});

test('citation coverage is counts only, and must add up',async()=>{
  assert.deepEqual(await fake(()=>({explicit:10,cited:6,batch_only:3,none:1})).engine.citationCoverage('space'),{explicit:10,cited:6,batchOnly:3,none:1});
  const {calls,engine}=fake(()=>({explicit:10,cited:6,batch_only:3,none:2}));
  await assert.rejects(engine.citationCoverage('space'),{code:engineErrors.invalid});
  assert.equal(calls[0]!.path,'/v3/workspaces/space/nocheh/citation-coverage');
});
