import {test} from 'node:test';
import assert from 'node:assert/strict';
import {brainErrors,brainOperation,brainSummary,turnChannel,turnChannels,type Brain} from '../src/brain/brain.js';
import {hermesBrain} from '../src/brain/hermes.js';
import {activeBrain,brain} from '../src/brain/brains.js';
import {defaultBrain} from '../src/access.js';

type Seen={path:string;method:string;body:Record<string,unknown>|null};
/** Hermes behind a fake transport that records each request and answers with `answer`. */
function hermes(answer:(seen:Seen)=>Response|Promise<Response>,telegramReplies?:'hermes'|'nocheh') {
  const seen:Seen[]=[];
  const plugged=hermesBrain({url:'http://fixture.invalid',token:'fixture',...(telegramReplies?{telegramReplies}:{}),fetch:async(url,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fixture');
    const request={path:new URL(String(url)).pathname,method:String(init?.method),body:init?.body?JSON.parse(String(init.body)):null};
    seen.push(request);return answer(request);
  }});
  return {plugged,seen};
}
const id='a'.repeat(64);

test('Hermes runs every channel on its run routes with one identity per turn',async()=>{
  const {plugged,seen}=hermes(({path})=>Response.json(path.endsWith('/events')?{events:[{sequence:4,state:'running',stage:'assistant',at:1}]}:{state:'running'}));
  for(const channel of turnChannels) {
    seen.length=0;const ref={channel,event_id:id,attempt:7};
    await plugged.startTurn(ref,{scope:'-20',text:'original 😃\r\n  ',channel:'other',attempt:1});
    await plugged.observeTurn(ref);await plugged.turnEvents(ref,3);await plugged.cancelTurn(ref);
    assert.deepEqual(seen.map(row=>row.path),['/internal/run/start','/internal/run/resume','/internal/run/events','/internal/run/cancel']);
    const identity={channel,event_id:id,attempt:7};
    assert.deepEqual(seen.map(row=>row.body),[{scope:'-20',text:'original 😃\r\n  ',...identity,asynchronous:true},
      {...identity,observe_only:true},{...identity,after:3},identity],'the ref wins over input fields of the same name');
  }
});

test('with Nocheh sending Telegram replies, Telegram turns run on the turn routes and must return their reply',async()=>{
  let answer:Record<string,unknown>={state:'done',reply:{text:'Hello',session_id:'s1'}};
  const {plugged,seen}=hermes(()=>Response.json(answer),'nocheh');
  const ref={channel:'telegram' as const,event_id:id,attempt:'continuation-1'};
  assert.deepEqual((await plugged.startTurn(ref,{text:'hi'})).reply,{text:'Hello',session_id:'s1'});
  await plugged.observeTurn(ref);await plugged.cancelTurn(ref);
  assert.deepEqual(seen.map(row=>row.path),['/internal/turn/start','/internal/turn/resume','/internal/turn/cancel']);
  assert.deepEqual(seen[0]?.body,{text:'hi',channel:'telegram',event_id:id,attempt:'continuation-1'},'turn routes take no asynchronous flag');
  answer={state:'suppressed',error_code:'intentional_silence'};assert.equal((await plugged.observeTurn(ref)).state,'suppressed');
  for(const invalid of [{state:'done'},{state:'done',reply:{text:'Hello'}},{state:'done',reply:'Hello'},{state:'sent'}]) {
    answer=invalid;await assert.rejects(plugged.observeTurn(ref),{code:brainErrors.invalid,status:502});
  }
  // Other channels still run on the run routes.
  seen.length=0;answer={state:'queued'};await plugged.startTurn({channel:'browser',event_id:id,attempt:1},{owner_epoch:2});
  assert.equal(seen[0]?.path,'/internal/run/start');
});

test('Hermes errors become the socket codes, and only owner-actionable setting refusals keep their own',async()=>{
  const failing=(status:number,payload:unknown)=>hermes(()=>Response.json(payload,{status})).plugged;
  const ref={channel:'telegram' as const,event_id:id,attempt:1};
  await assert.rejects(failing(429,{error:'private'}).startTurn(ref,{}),{code:'quota_paused',status:429});
  await assert.rejects(failing(503,{error:'provider_not_configured'}).startTurn(ref,{}),{code:'provider_not_configured'});
  await assert.rejects(failing(400,{error:'run_identity_conflict'}).startTurn(ref,{}),{code:brainErrors.rejected,status:503});
  await assert.rejects(failing(502,{secret:'private'}).observeTurn(ref),{code:brainErrors.unavailable,status:503});
  await assert.rejects(failing(409,{error:'configuration_conflict'}).writePersona!({scope:'-20',revision:'stale'}),{code:'configuration_conflict',status:409});
  await assert.rejects(failing(400,{error:'invalid_preference'}).writeSettings!({scope:'-20'}),{code:'invalid_preference',status:400});
  await assert.rejects(failing(409,{error:'configuration_conflict'}).readNotes!({scope:'-20'}),{code:brainErrors.rejected},'only settings and persona keep setting codes');
  const lost=hermesBrain({url:'http://fixture.invalid',token:'fixture',fetch:async()=>{throw Error('connection refused');}});
  await assert.rejects(lost.startTurn(ref,{}),{code:brainErrors.unavailable,status:503});
  await assert.rejects(hermes(()=>new Response('not json')).plugged.status(),{code:brainErrors.invalid});
  await assert.rejects(hermes(()=>Response.json([1])).plugged.status(),{code:brainErrors.invalid});
  await assert.rejects(hermes(()=>Response.json({sequence:1})).plugged.turnEvents(ref,0),{code:brainErrors.invalid});
});

test('Hermes keeps its own settings, persona, notes and schedules behind named operations',async()=>{
  const {plugged,seen}=hermes(({path,body})=>Response.json(path==='/health'?{ok:true}:body?.action==='prompts'?{defaults:{'reply.owner':'Text'}}:{state:'done'}));
  assert.deepEqual(await plugged.status(),{ok:true});assert.equal(seen[0]?.method,'GET');assert.equal(seen[0]?.body,null);
  await plugged.readPersona!({scope:'default'});await plugged.writePersona!({scope:'-20',role:'Family helper',skills:[],revision:'r'});
  await plugged.readSettings!({scope:'default'});await plugged.listProfiles!({});await plugged.readNotes!({scope:'-20'});
  assert.deepEqual(await plugged.promptDefaults!(),{'reply.owner':'Text'});
  await plugged.recallNotes!({query:'q'});await plugged.reviewNotes!({id:'r',observe_only:true});await plugged.advanceSchedules!({job_id:'j'});
  assert.deepEqual(seen.slice(1).map(row=>[row.path,row.body]),[
    ['/internal/manage',{scope:'default',action:'persona'}],['/internal/manage',{scope:'-20',role:'Family helper',skills:[],revision:'r',action:'persona'}],
    ['/internal/manage',{scope:'default',action:'preferences'}],['/internal/manage',{action:'profiles'}],['/internal/manage',{scope:'-20',action:'memory'}],
    ['/internal/manage',{action:'prompts'}],['/internal/memory/recall',{query:'q'}],['/internal/memory/review',{id:'r',observe_only:true}],
    ['/internal/schedule/advance',{job_id:'j'}]]);
  await assert.rejects(hermes(()=>Response.json({defaults:{'reply.owner':1}})).plugged.promptDefaults!(),{code:brainErrors.invalid});
});

test('a replacement brain offers only what it has, and Nocheh refuses the rest with one code',async()=>{
  const turns:string[]=[];
  const minimal:Brain={id:'fixture',name:'Fixture',channels:['browser'],
    startTurn:async ref=>{turns.push(ref.event_id);return {state:'queued'};},observeTurn:async()=>({state:'not_found'}),
    cancelTurn:async()=>({state:'cancelled'}),turnEvents:async()=>({events:[]}),status:async()=>({ok:true})};
  assert.deepEqual(brainSummary(minimal),{id:'fixture',name:'Fixture',capabilities:{telegram:false,browser:true,scheduler:false,background:false,
    settings:false,persona:false,prompts:false,notes:false,recall:false,review:false,schedules:false}});
  for(const name of ['readSettings','writePersona','recallNotes','reviewNotes','advanceSchedules'] as const)
    assert.throws(()=>brainOperation(minimal,name),{code:brainErrors.unsupported,status:409});
  assert.equal(turnChannel(minimal,'browser'),'browser');
  for(const channel of ['telegram','sms',undefined])assert.throws(()=>turnChannel(minimal,channel),{code:brainErrors.unsupported});
  const full=hermes(()=>Response.json({state:'done'})).plugged;
  assert.ok(Object.values(brainSummary(full).capabilities).every(Boolean),'Hermes offers every channel and operation');
  assert.equal(typeof brainOperation(full,'readNotes'),'function');
});

test('one brain runs at a time, and turn passes name it',()=>{
  const plugged=brain({hermesUrl:'http://fixture.invalid',token:'fixture'});
  assert.equal(plugged.id,activeBrain);assert.equal(defaultBrain,activeBrain);assert.equal(plugged.name,'Hermes');
});
