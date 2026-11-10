import {test} from 'node:test';
import assert from 'node:assert/strict';
import {engineErrors,engineSummary} from '../src/memory/engine.js';
import {HonchoEngine,honchoClient,type HonchoCall} from '../src/memory/honcho.js';

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
  const call=honchoClient('http://synthetic-honcho');
  t.mock.method(console,'warn',()=>{});
  const fetches=t.mock.method(globalThis,'fetch',async()=>{throw Error('synthetic_network_down');});
  await assert.rejects(call('/v3/workspaces'),{code:engineErrors.unavailable,status:503});
  fetches.mock.mockImplementation(async()=>new Response(JSON.stringify({detail:[{loc:['body','id'],type:'missing',input:'private text'}]}),{status:422}));
  await assert.rejects(call('/v3/workspaces',{id:'x'}),{code:engineErrors.rejected,status:503});
  fetches.mock.mockImplementation(async()=>new Response('',{status:404}));
  assert.deepEqual(await call('/v3/workspaces/x',undefined,'DELETE'),{deleted:false});
});

test('participants and sessions map roles to Honcho observation',async()=>{
  const {calls,engine}=fake(()=>({}));
  await engine.openSpace('space');
  await engine.addParticipant('space','person','writer');
  await engine.addParticipant('space','assistant','silent');
  await engine.openSession('space','session',{person:'writer',project:'subject',assistant:'silent'});
  assert.deepEqual(calls.map(c=>[c.path,c.body]),[
    ['/v3/workspaces',{id:'space'}],
    ['/v3/workspaces/space/peers',{id:'person'}],
    ['/v3/workspaces/space/peers',{id:'assistant',configuration:{observe_me:false}}],
    ['/v3/workspaces/space/sessions',{id:'session',peers:{
      person:{observe_me:true,observe_others:false},
      project:{observe_me:false,observe_others:true},
      assistant:{observe_me:false,observe_others:false}}}],
  ]);
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
  assert.deepEqual(await engine.context('space','s1',{subject:'person',limitToSession:true,tokens:800}),{summary:'summary',subject:'subject'});
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
});

test('progress reads Honcho queue state and checks its answers',async()=>{
  const {engine}=fake(path=>path.includes('/queue/status')?{pending_work_units:0,in_progress_work_units:1}
    :path.includes('/failed-learning/retry')?{retried:-1}:path.includes('/failed-learning')?{failed:3}:{failed_items:'yes'});
  assert.equal(await engine.busy('space'),true);
  assert.equal(await engine.failedLearning('space'),3);
  await assert.rejects(engine.retryFailedLearning('space'),{code:'invalid_honcho_retry'});
  await assert.rejects(engine.failing('space'),{code:'honcho_queue_health_invalid'});
});
