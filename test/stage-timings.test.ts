import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {attribute,breakdown,eventBreakdown,expireStageTimings,hermesTimings,recordHermesAttempt,recordStages,stageSummary,type StageRow} from '../src/stores/stage-timings.js';
import {advanceWorkflow} from '../src/workflows/engine.js';
import {observation} from '../src/workflows/pipeline.js';
import {requestWorkflow} from '../src/workflows/store.js';

const event='e'.repeat(64);
const row=(stage:string,start:number,ms:number,attempt=0,calls=1):StageRow=>({stage,attempt,started_at:new Date(start),duration_ms:ms,calls});

test('overlapping measurements are attributed once to the most specific stage',()=>{
  const parts=attribute(0,100,[{stage:'step',start:10,end:60,layer:1},{stage:'asr',start:20,end:50,layer:2},{stage:'queue',start:0,end:70,layer:0}]);
  assert.deepEqual(Object.fromEntries(parts),{queue:20,step:20,asr:30,unmeasured:30});
});

test('a voice reply breaks down into non-overlapping categorized stages that sum to the reply time',()=>{
  const t=1_800_000_000_000,assistant=t+20_000,delivery=t+60_000,finished=t+61_000;
  const rows=[
    row('queue:preparation',t+500,1_000),row('outbox:preparation',t+500,200),row('step:preparation',t+1_500,8_000),
    row('transcription',t+2_000,7_000),row('step:preparation',t+12_000,500),
    row('queue:telegram',t+500,13_500),row('outbox:telegram',t+500,300),row('step:telegram',t+14_000,400),row('step:telegram',t+16_000,300),
    row('step:telegram',t+30_000,50),
    row('hermes_queue',t+16_200,3_800,1),row('hermes_turn',assistant,40_000,1),row('hermes_delivery',delivery,1_000,1),
    row('bootstrap',assistant,2_000,1),row('memory_recall',assistant,1_500,1),row('history_prepare',assistant,500,1),row('agent_init',assistant,1_000,1),
    row('conversation',assistant,30_000,1),row('llm',assistant+6_000,21_000,1,3),row('model_guard',assistant,800,1,3),
    row('telegram_send',delivery,600,1),
    // Bound to the turn event by the server, placed in attempt 1 by its time.
    row('honcho_recall',assistant+9_000,2_200,0),
    // Outside every Hermes window: cannot be attributed, never invented.
    row('honcho_recall',t+200_000,9_999,0),
  ];
  const result=breakdown(event,t,t+500,rows),stage=(name:string)=>result.stages.find(s=>s.stage===name);
  assert.equal(result.reply_ms,61_000);assert.equal(result.complete,true);assert.equal(result.attempts,1);
  assert.equal(result.stages.reduce((sum,s)=>sum+s.ms,0),result.reply_ms,'displayed stages never overlap');
  assert.equal(stage('capture')!.ms,500);assert.equal(stage('capture')!.category,'internal');
  assert.equal(stage('transcription')!.ms,7_000);assert.equal(stage('transcription')!.category,'third_party');
  assert.equal(stage('step:preparation')!.ms,1_500,'step time excludes the transcription inside it');
  assert.equal(stage('llm')!.ms,21_000);assert.equal(stage('llm')!.calls,3);assert.equal(stage('llm')!.category,'llm');
  assert.equal(stage('honcho_recall')!.ms,2_200,'only the in-window recall counts');assert.equal(stage('honcho_recall')!.category,'third_party');
  assert.equal(stage('memory_recall')!.label,'Honcho context');
  assert.equal(stage('conversation')!.ms,30_000-21_000-800-2_200,'tools + agent is conversation minus provider, guard and recall');
  assert.equal(stage('hermes_turn')!.ms,40_000-2_000-1_500-500-1_000-30_000);
  assert.equal(stage('telegram_send')!.ms,600);assert.equal(stage('hermes_delivery')!.ms,400);
  assert.equal(stage('hermes_queue')!.category,'workflow');
  assert.ok(stage('wait:telegram')!.ms>0,'waits between dispatch steps are workflow time');
  assert.equal(result.unmeasured_ms,0,'the dispatch queue wait covers the time between preparation and dispatch');
  const gap=breakdown(event,t,t+500,rows.filter(r=>r.stage!=='queue:telegram'));
  assert.equal(gap.unmeasured_ms,1_500,'without the dispatch queue row its time is unmeasured, never zero');
  assert.deepEqual(gap.stages.at(-1),{stage:'unmeasured',label:'unmeasured',category:'unmeasured',ms:1_500,calls:0});
  assert.equal(gap.stages.reduce((sum,s)=>sum+s.ms,0),gap.reply_ms);
  const pending=breakdown(event,t,t+500,rows.filter(r=>!['hermes_delivery','telegram_send'].includes(r.stage)));
  assert.equal(pending.complete,false,'without delivery timing the breakdown is incomplete');
  const nothing=breakdown(event,t,t+500,[]);
  assert.deepEqual(nothing.stages.map(s=>[s.stage,s.ms]),[['capture',500]]);assert.equal(nothing.unmeasured_ms,0);
});

test('Hermes timing is accepted only in its closed shape',()=>{
  const now=Date.now(),window={queued:now-5_000,assistant:now-4_000,delivery:now-1_000,finished:now};
  const valid={state:'done',timings:{conversation:{ms:10,calls:1},telegram_send:{ms:4,calls:2}},window};
  assert.deepEqual(hermesTimings(valid,now),{phases:valid.timings,window});
  for(const bad of [null,'done',{state:'done'},{timings:valid.timings},{...valid,timings:{prompt:{ms:1,calls:1}}},
    {...valid,timings:{conversation:{ms:1,calls:1,text:'private'}}},{...valid,timings:{conversation:{ms:-1,calls:1}}},
    {...valid,timings:{conversation:{ms:1.5,calls:1}}},{...valid,window:{...window,assistant:window.finished+1}},
    {...valid,window:{queued:window.queued}},{...valid,window:{...window,finished:now+3_600_000}},{...valid,window:{...window,note:1}},
    {...valid,window:{...window,queued:1_000}}])
    assert.equal(hermesTimings(bad,now),null,JSON.stringify(bad));
});

test('stage timings persist idempotently, bind provider waits and Inngest steps to the event, and expire',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),control=stores.control,base=Date.now();
  try {
    const key='stage-timing:'+base,envelope:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'fixture',source_id:key,
      revision:'1',occurred_at:String(Math.floor(base/1000)-2),text:'Synthetic timing fixture',payload:{message:{text:'Synthetic timing fixture'}}};
    const id=(await new ArchiveRepository(stores.archive).capture(envelope)).source.reference.id;
    const at=(offset:number)=>new Date(base+offset),stage=(name:string,offset:number,ms:number,attempt=0)=>({event_id:id,attempt,stage:name,started_at:at(offset),duration_ms:ms,source:'nocheh'});
    assert.equal(await recordStages(control,[stage('transcription',0,10),{...stage('capture',0,1),stage:'private text'},{...stage('transcription',5,5),duration_ms:-1}]),1,'unknown stages and invalid durations are dropped');
    await recordStages(control,[stage('transcription',0,20)]);
    await recordStages(control,[stage('transcription',0,99)],true);
    assert.deepEqual((await control.query('SELECT duration_ms,category FROM stage_timings WHERE event_id=$1',[id])).rows,[{duration_ms:20,category:'third_party'}],
      're-recording replaces; first-write keeps the existing value');

    // Provider waits recorded by the broker belong to the attempt whose window contains them.
    const revision=(await control.query('SELECT revision FROM security_policy')).rows[0].revision;
    const effect=(name:string,offset:number,timings:object)=>control.query(`INSERT INTO security_events(effect_id,state,kind,scope,profile,source_event_id,policy_revision,origin,rule,timings,created_at)
      VALUES($1,'completed','model','fixture','fixture',$2,$3,'fixture','fixture',$4,$5)`,[name+base,id,revision,timings,at(offset)]);
    await effect('first',3_000,{provider_headers_ms:400,provider_read_ms:600});await effect('second',4_000,{provider_headers_ms:100});
    await effect('earlier',-60_000,{provider_headers_ms:9_999});
    const window={queued:base+1_000,assistant:base+2_000,delivery:base+8_000,finished:base+9_000};
    const timings=hermesTimings({timings:{conversation:{ms:5_000,calls:1},telegram_send:{ms:500,calls:1},total:{ms:5_500,calls:1}},window},base+10_000)!;
    await recordHermesAttempt(control,id,1,timings);
    const llm=(await control.query("SELECT duration_ms,calls,source FROM stage_timings WHERE event_id=$1 AND stage='llm'",[id])).rows;
    assert.deepEqual(llm,[{duration_ms:1_100,calls:2,source:'broker'}]);

    // Each Inngest step of a message workflow records its run and the queue wait before it.
    const db=await control.connect();let workflow:string;
    try{await db.query('BEGIN');workflow=await requestWorkflow(db,'telegram',id);await db.query('COMMIT');}finally{db.release();}
    await control.query("UPDATE workflow_outbox SET published_at=now(),first_published_at=now() WHERE workflow_id=$1",[workflow]);
    const step=()=>advanceWorkflow(control,workflow,1,'telegram','fixture-'+Math.random().toString(36).slice(2),async()=>observation('waiting','admission'));
    await step();await step();
    const steps=(await control.query("SELECT stage,count(*)::int AS count FROM stage_timings WHERE event_id=$1 AND source='workflow' GROUP BY stage ORDER BY stage",[id])).rows;
    assert.deepEqual(steps,[{stage:'outbox:telegram',count:1},{stage:'queue:telegram',count:1},{stage:'step:telegram',count:2}]);

    const result=await eventBreakdown(stores,id);
    assert.equal(result.complete,true);assert.equal(result.stages.reduce((sum,s)=>sum+s.ms,0),result.reply_ms);
    assert.ok(result.stages.some(s=>s.stage==='capture'&&s.ms>0),'reply time starts at the Telegram message date');
    assert.equal(result.stages.find(s=>s.stage==='llm')!.ms,1_100);
    assert.equal(JSON.stringify(result).includes('Synthetic timing fixture'),false,'no content in the breakdown');
    await assert.rejects(eventBreakdown(stores,'0'.repeat(64)),{code:'event_not_found'});
    await control.query("INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,'{}','done',1)",[id]);
    const summary=await stageSummary(stores,200);
    assert.ok(summary.recent.some(item=>item.event_id===id));assert.ok(summary.stages.some(s=>s.stage==='llm'&&s.ms_p50>0));

    await control.query("UPDATE stage_timings SET recorded_at=now()-interval '15 days' WHERE event_id=$1 AND stage<>'llm'",[id]);
    assert.equal(await expireStageTimings(control,Date.now(),0),0,'zero days keeps every row');
    assert.ok(await expireStageTimings(control,Date.now(),14)>0);
    assert.deepEqual((await control.query('SELECT stage FROM stage_timings WHERE event_id=$1',[id])).rows,[{stage:'llm'}],'only expired rows are removed');
  } finally {await stores.close();}
});
