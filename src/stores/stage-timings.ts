/**
 * Content-free per-message stage durations. Each measured stage has exactly
 * one category; overlapping measurements are never summed. Time not covered
 * by any measurement is reported as unmeasured, never as zero.
 */
import type pg from 'pg';
import {HttpError} from '../http.js';
import {retentionDays} from '../workflows/retention.js';

export const categories=['internal','workflow','third_party','llm'] as const;
export type StageCategory=typeof categories[number];
type Definition={category:StageCategory;label:string};

/** Stages placed on the message timeline by their own start and end. */
const timeline={
  capture:{category:'internal',label:'capture → archive'},
  'queue:preparation':{category:'workflow',label:'preparation queue wait'},
  'outbox:preparation':{category:'internal',label:'preparation outbox → Inngest'},
  'step:preparation':{category:'internal',label:'preparation steps'},
  'wait:preparation':{category:'workflow',label:'preparation step waits'},
  transcription:{category:'third_party',label:'transcription'},
  'queue:telegram':{category:'workflow',label:'dispatch queue wait'},
  'outbox:telegram':{category:'internal',label:'dispatch outbox → Inngest'},
  'step:telegram':{category:'internal',label:'dispatch steps'},
  'wait:telegram':{category:'workflow',label:'dispatch step waits'},
  hermes_queue:{category:'workflow',label:'Hermes run queue'},
  hermes_turn:{category:'internal',label:'Hermes turn (other)'},
  hermes_delivery:{category:'internal',label:'Hermes delivery journal'},
} as const satisfies Record<string,Definition>;
/** Stages known only as durations inside a timeline stage of the same attempt. */
const nested={
  bootstrap:{category:'internal',label:'Hermes bootstrap'},
  memory_recall:{category:'third_party',label:'Honcho context'},
  history_prepare:{category:'internal',label:'Hermes history'},
  agent_init:{category:'internal',label:'Hermes agent setup'},
  conversation:{category:'internal',label:'tools + agent'},
  llm:{category:'llm',label:'provider wait'},
  model_guard:{category:'internal',label:'model guard'},
  honcho_recall:{category:'third_party',label:'Honcho recall'},
  telegram_send:{category:'third_party',label:'Telegram send'},
} as const satisfies Record<string,Definition>;
/** Parent → children, in allocation order. A parent keeps only what its children do not explain. */
const children:Record<string,readonly string[]>={
  hermes_turn:['bootstrap','memory_recall','history_prepare','agent_init','conversation'],
  conversation:['llm','model_guard','honcho_recall'],
  hermes_delivery:['telegram_send'],
};
export const stageDefinitions:Record<string,Definition>={...timeline,...nested};
/** Order used for display: roughly the order a reply passes through. */
const order=['capture','outbox:preparation','queue:preparation','step:preparation','wait:preparation','transcription',
  'outbox:telegram','queue:telegram','step:telegram','wait:telegram','hermes_queue','bootstrap','memory_recall','history_prepare',
  'agent_init','llm','model_guard','honcho_recall','conversation','hermes_turn','telegram_send','hermes_delivery'];
const recordable=new Set(Object.keys(stageDefinitions).filter(stage=>!stage.startsWith('wait:')));
const sources=new Set(['nocheh','workflow','hermes','broker']);
const maximum=86400000;

export const stageTimingSchema=`
CREATE TABLE IF NOT EXISTS stage_timings (
 event_id text NOT NULL CHECK(event_id ~ '^[a-f0-9]{64}$'),
 attempt integer NOT NULL CHECK(attempt>=0),
 stage text NOT NULL CHECK(stage ~ '^[a-z_:]{1,64}$'),
 category text NOT NULL CHECK(category IN ('internal','workflow','third_party','llm')),
 started_at timestamptz NOT NULL,
 duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 0 AND ${maximum}),
 calls integer NOT NULL DEFAULT 1 CHECK(calls BETWEEN 0 AND 100000),
 source text NOT NULL CHECK(source IN ('nocheh','workflow','hermes','broker')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id,attempt,stage,started_at)
);
CREATE INDEX IF NOT EXISTS stage_timings_recorded ON stage_timings(recorded_at);
`;

export type StageTiming={event_id:string;attempt:number;stage:string;started_at:Date;duration_ms:number;calls?:number;source:string};
type Db=Pick<pg.Pool,'query'>|pg.PoolClient;

function valid(row:StageTiming):boolean {
  return /^[a-f0-9]{64}$/.test(row.event_id)&&Number.isSafeInteger(row.attempt)&&row.attempt>=0&&recordable.has(row.stage)&&sources.has(row.source)&&
    row.started_at instanceof Date&&Number.isFinite(row.started_at.getTime())&&Number.isSafeInteger(row.duration_ms)&&row.duration_ms>=0&&row.duration_ms<=maximum&&
    (row.calls===undefined||Number.isSafeInteger(row.calls)&&row.calls>=0&&row.calls<=100000);
}

/**
 * Re-recording the same measurement replaces it, so a retried writer is
 * idempotent. `first` keeps the earliest write, for values only the first
 * observer can know. Timing is diagnostics: a failed write never fails work.
 */
export async function recordStages(db:Db,rows:StageTiming[],first=false):Promise<number> {
  const accepted=rows.filter(valid);if(!accepted.length)return 0;
  try {
    const result=await db.query(`INSERT INTO stage_timings(event_id,attempt,stage,category,started_at,duration_ms,calls,source)
      SELECT * FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::timestamptz[],$6::int[],$7::int[],$8::text[])
      ON CONFLICT(event_id,attempt,stage,started_at) DO ${first?'NOTHING':'UPDATE SET duration_ms=excluded.duration_ms,calls=excluded.calls,source=excluded.source,recorded_at=now()'}`,
      [accepted.map(r=>r.event_id),accepted.map(r=>r.attempt),accepted.map(r=>r.stage),accepted.map(r=>stageDefinitions[r.stage]!.category),
        accepted.map(r=>r.started_at),accepted.map(r=>r.duration_ms),accepted.map(r=>r.calls??1),accepted.map(r=>r.source)]);
    return result.rowCount??0;
  } catch {
    console.error(JSON.stringify({event:'stage_timing_unavailable'}));return 0;
  }
}

/** Measure one call; the duration is recorded whether it succeeds or fails. */
export async function timed<T>(db:Db,event:string|null|undefined,stage:string,source:string,work:()=>Promise<T>,attempt=0):Promise<T> {
  const started=new Date(),clock=performance.now();
  try {return await work();}
  finally {
    if(event&&/^[a-f0-9]{64}$/.test(event))
      await recordStages(db,[{event_id:event,attempt,stage,started_at:started,duration_ms:Math.max(0,Math.round(performance.now()-clock)),source}]);
  }
}

/** Remove one bounded batch of rows recorded before the cutoff. */
export async function pruneStageTimings(db:Db,cutoff:Date,batch=5000):Promise<number> {
  if(!Number.isSafeInteger(batch)||batch<1)throw new HttpError(400,'invalid_retention_batch');
  return (await db.query(`DELETE FROM stage_timings WHERE ctid IN (SELECT ctid FROM stage_timings WHERE recorded_at<$1 LIMIT $2)`,[cutoff,batch])).rowCount??0;
}

/** Stage timings follow the operational retention setting; zero keeps every row. */
export async function expireStageTimings(db:Db,now=Date.now(),days=retentionDays()):Promise<number> {
  if(!days)return 0;
  let total=0;
  for(let batch=0;batch<20;batch++){const removed=await pruneStageTimings(db,new Date(now-days*86400000));total+=removed;if(removed<5000)break;}
  return total;
}

const phaseNames=new Set(['bootstrap','memory_recall','history_prepare','agent_init','conversation','context_prepare','model_guard','total','telegram_send']);
const windowKeys=['queued','assistant','delivery','finished'] as const;
export type HermesTimings={phases:Record<string,{ms:number;calls:number}>;window:Partial<Record<typeof windowKeys[number],number>>};

/** Accept only the closed Hermes timing shape; anything else is rejected whole. */
export function hermesTimings(value:unknown,now=Date.now()):HermesTimings|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const {timings,window}=value as Record<string,unknown>;
  if(!timings||typeof timings!=='object'||Array.isArray(timings)||!window||typeof window!=='object'||Array.isArray(window))return null;
  const phases:HermesTimings['phases']={};
  for(const [key,item] of Object.entries(timings)) {
    if(!phaseNames.has(key)||!item||typeof item!=='object'||Array.isArray(item))return null;
    const {ms,calls,...rest}=item as Record<string,unknown>;
    if(Object.keys(rest).length||!Number.isSafeInteger(ms)||!Number.isSafeInteger(calls)||(ms as number)<0||(ms as number)>maximum||(calls as number)<0||(calls as number)>100000)return null;
    phases[key]={ms:ms as number,calls:calls as number};
  }
  const placed:HermesTimings['window']={};let previous=0;
  for(const [key,item] of Object.entries(window)) if(!(windowKeys as readonly string[]).includes(key))return null;
  for(const key of windowKeys) {
    const item=(window as Record<string,unknown>)[key];if(item===undefined)continue;
    // Epoch milliseconds from the runtime clock: after 2020, not in the future, in journal order.
    if(!Number.isSafeInteger(item)||(item as number)<1577836800000||(item as number)>now+60000||(item as number)<previous)return null;
    placed[key]=previous=item as number;
  }
  if(placed.queued===undefined||placed.finished===undefined)return null;
  return {phases,window:placed};
}

/** Persist one closed Hermes attempt, including event-bound provider waits from the broker. */
export async function recordHermesAttempt(db:Db,event:string,attempt:number,value:HermesTimings):Promise<number> {
  const {phases,window}=value,rows:StageTiming[]=[],at=(ms:number)=>new Date(ms);
  const start=window.assistant??window.queued!,turnEnd=window.delivery??window.finished!;
  rows.push({event_id:event,attempt,stage:'hermes_queue',started_at:at(window.queued!),duration_ms:Math.max(0,start-window.queued!),source:'hermes'});
  if(window.assistant!==undefined)rows.push({event_id:event,attempt,stage:'hermes_turn',started_at:at(start),duration_ms:Math.max(0,turnEnd-start),source:'hermes'});
  if(window.delivery!==undefined)rows.push({event_id:event,attempt,stage:'hermes_delivery',started_at:at(window.delivery),duration_ms:Math.max(0,window.finished!-window.delivery),source:'hermes'});
  for(const [stage,item] of Object.entries(phases)) if(stage!=='total'&&stage!=='context_prepare')
    rows.push({event_id:event,attempt,stage,started_at:at(stage==='telegram_send'?window.delivery??window.finished!:start),duration_ms:item.ms,calls:item.calls,source:'hermes'});
  // The broker binds each provider request to its turn event. Only requests
  // inside this attempt's runtime window belong to this attempt.
  try {
    const llm=(await db.query(`SELECT count(*)::int AS calls,coalesce(sum(coalesce((timings->>'provider_headers_ms')::bigint,0)+coalesce((timings->>'provider_read_ms')::bigint,0)),0)::bigint AS ms,
      min(created_at) AS first FROM security_events WHERE source_event_id=$1 AND timings IS NOT NULL AND state IN ('completed','failed','ambiguous')
      AND created_at BETWEEN $2 AND $3`,[event,at(start),at(window.finished!+5000)])).rows[0];
    if(llm?.calls)rows.push({event_id:event,attempt,stage:'llm',started_at:llm.first,duration_ms:Math.min(maximum,Number(llm.ms)),calls:llm.calls,source:'broker'});
  } catch {/* Provider timing is optional evidence; the stage stays unmeasured. */}
  return recordStages(db,rows);
}

type Interval={stage:string;start:number;end:number;layer:number};
/**
 * Attribute each instant of [start,end] to the most specific covering stage:
 * the highest layer wins, then the later start (the more nested one).
 * Returns exclusive milliseconds per stage; uncovered time is `unmeasured`.
 */
export function attribute(start:number,end:number,intervals:readonly Interval[]):Map<string,number> {
  const result=new Map<string,number>(),usable=intervals.filter(i=>i.end>start&&i.start<end&&i.end>i.start);
  const points=[...new Set([start,end,...usable.flatMap(i=>[i.start,i.end]).filter(p=>p>start&&p<end)])].sort((a,b)=>a-b);
  for(let index=0;index+1<points.length;index++) {
    const a=points[index]!,b=points[index+1]!;let best:Interval|undefined;
    for(const item of usable) if(item.start<=a&&item.end>=b&&(!best||item.layer>best.layer||item.layer===best.layer&&item.start>best.start))best=item;
    const stage=best?.stage??'unmeasured';result.set(stage,(result.get(stage)??0)+b-a);
  }
  return result;
}

export type StageRow={stage:string;attempt:number;started_at:Date;duration_ms:number;calls:number};
export type BreakdownStage={stage:string;label:string;category:StageCategory|'unmeasured';ms:number;calls:number};
export type Breakdown={event_id:string;started_at:string|null;ended_at:string|null;reply_ms:number|null;complete:boolean;
  attempts:number;stages:BreakdownStage[];unmeasured_ms:number|null};
const layers:Record<string,number>={'queue:preparation':0,'queue:telegram':0,capture:1,'outbox:preparation':1,'outbox:telegram':1,
  'step:preparation':1,'step:telegram':1,transcription:2,hermes_queue:2,hermes_turn:2,hermes_delivery:2};
const describe=(stage:string)=>({label:stage==='unmeasured'?'unmeasured':stageDefinitions[stage]?.label??stage,
  category:stage==='unmeasured'?'unmeasured' as const:stageDefinitions[stage]?.category??'internal' as const});
const rank=(stage:string)=>stage==='unmeasured'?1000:order.indexOf(stage)<0?999:order.indexOf(stage);

/**
 * Build one message's breakdown from its recorded rows. `begin` is when
 * Telegram dated the message (or its archive time); `archived` is its archive
 * time. Displayed stages never overlap, so they sum to the reply time.
 */
export function breakdown(event:string,begin:number|null,archived:number|null,rows:readonly StageRow[]):Breakdown {
  if(begin===null)return {event_id:event,started_at:null,ended_at:null,reply_ms:null,complete:false,attempts:0,stages:[],unmeasured_ms:null};
  const intervals:Interval[]=[],windows=new Map<number,{start:number;end:number;closed:boolean}>(),calls=new Map<string,number>();
  if(archived!==null&&archived>begin)intervals.push({stage:'capture',start:begin,end:archived,layer:1});
  for(const row of rows) {
    if(!(row.stage in layers))continue;
    const start=row.started_at.getTime(),end=start+row.duration_ms,hermes=row.stage.startsWith('hermes_');
    // Hermes containers are kept per attempt so each attempt splits only its own time.
    intervals.push({stage:hermes?row.stage+'#'+row.attempt:row.stage,start,end,layer:layers[row.stage]!});
    calls.set(row.stage,(calls.get(row.stage)??0)+row.calls);
    if(hermes) {
      const window=windows.get(row.attempt);
      windows.set(row.attempt,{start:Math.min(window?.start??start,start),end:Math.max(window?.end??end,end),closed:(window?.closed??false)||row.stage==='hermes_delivery'});
    }
  }
  // Duration-only stages belong to the Hermes attempt whose window contains them.
  const durations=new Map<number,Map<string,{ms:number;calls:number}>>();
  for(const row of rows) if(!(row.stage in layers)) {
    const start=row.started_at.getTime();
    const attempt=row.attempt||[...windows].find(([,w])=>start>=w.start-1000&&start<=w.end+1000)?.[0];
    if(attempt===undefined||!windows.has(attempt))continue;
    const map=durations.get(attempt)??new Map<string,{ms:number;calls:number}>();durations.set(attempt,map);
    const previous=map.get(row.stage)??{ms:0,calls:0};map.set(row.stage,{ms:previous.ms+row.duration_ms,calls:previous.calls+row.calls});
  }
  // Waits between consecutive steps of one workflow family are workflow time.
  for(const family of ['preparation','telegram']) {
    const steps=rows.filter(r=>r.stage==='step:'+family).map(r=>({start:r.started_at.getTime(),end:r.started_at.getTime()+r.duration_ms})).sort((a,b)=>a.start-b.start);
    let reached:number|null=null;
    for(const step of steps){if(reached!==null&&step.start>reached)intervals.push({stage:'wait:'+family,start:reached,end:step.start,layer:0});reached=Math.max(reached??step.end,step.end);}
  }
  // The reply ends when the last Hermes attempt finished delivery; without
  // one, at the last measured activity, and the breakdown is incomplete.
  const last=[...windows.keys()].sort((a,b)=>b-a)[0];
  const end=last!==undefined?windows.get(last)!.end:Math.max(archived??begin,...intervals.map(i=>i.end));
  const totals=new Map<string,{ms:number;calls:number}>();
  const add=(stage:string,ms:number,count:number)=>{const p=totals.get(stage)??{ms:0,calls:0};totals.set(stage,{ms:p.ms+ms,calls:p.calls+count});};
  // A container keeps only the part of its time that its children do not explain.
  const share=(parent:string,available:number,attempt:number)=>{
    let left=available;
    for(const child of children[parent]??[]) {
      const measured=durations.get(attempt)?.get(child);if(!measured)continue;
      const used=Math.min(left,measured.ms);left-=used;
      if(children[child]){add(child,0,measured.calls);share(child,used,attempt);}else add(child,used,measured.calls);
    }
    add(parent,left,0);
  };
  for(const [key,ms] of attribute(begin,end,intervals)) {
    const [stage,attempt]=key.split('#') as [string,string|undefined];
    if(attempt!==undefined){add(stage,0,1);share(stage,ms,Number(attempt));}
    else add(stage,ms,stage==='unmeasured'?0:calls.get(stage)??0);
  }
  const stages=[...totals].filter(([,value])=>value.ms>0||value.calls>0)
    .map(([stage,value])=>({stage,...describe(stage),ms:value.ms,calls:value.calls})).sort((a,b)=>rank(a.stage)-rank(b.stage));
  return {event_id:event,started_at:new Date(begin).toISOString(),ended_at:new Date(end).toISOString(),reply_ms:end-begin,
    complete:last!==undefined&&windows.get(last)!.closed,attempts:windows.size,stages,unmeasured_ms:totals.get('unmeasured')?.ms??0};
}

/** One message's stage breakdown, read from the archive and control stores. */
export async function eventBreakdown(stores:{archive:Db;control:Db},event:string):Promise<Breakdown> {
  if(!/^[a-f0-9]{64}$/.test(event))throw new HttpError(400,'invalid_event_id');
  const source=(await stores.archive.query('SELECT received_at,occurred_at FROM events WHERE id=$1',[event])).rows[0];
  if(!source)throw new HttpError(404,'event_not_found');
  const rows=(await stores.control.query('SELECT stage,attempt,started_at,duration_ms,calls FROM stage_timings WHERE event_id=$1 ORDER BY started_at,stage',[event])).rows as StageRow[];
  const archived=source.received_at.getTime(),dated=/^\d{9,11}$/.test(String(source.occurred_at??''))?Number(source.occurred_at)*1000:null;
  // Telegram dates have one-second resolution; an implausible date is ignored.
  const begin=dated!==null&&dated<=archived&&archived-dated<86400000?dated:archived;
  return breakdown(event,begin,archived,rows);
}

const percentile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]!;};
export type StageSummary={observed_at:string;messages:number;reply_ms_p50:number|null;reply_ms_p95:number|null;
  stages:{stage:string;label:string;category:StageCategory|'unmeasured';messages:number;ms_p50:number;ms_p95:number}[];
  recent:{event_id:string;started_at:string|null;reply_ms:number|null;unmeasured_ms:number|null;complete:boolean}[]};

/** Per-stage p50/p95 across recent replied messages, plus each message's total. */
export async function stageSummary(stores:{archive:Db;control:Db},limit=50,now=new Date()):Promise<StageSummary> {
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_timing_limit');
  const ids=(await stores.control.query(`SELECT d.event_id FROM dispatches d WHERE d.state='done'
    AND EXISTS(SELECT 1 FROM stage_timings t WHERE t.event_id=d.event_id AND t.attempt=d.attempts AND t.stage IN ('hermes_delivery','telegram_send'))
    ORDER BY d.updated_at DESC,d.event_id LIMIT $1`,[limit])).rows.map(row=>row.event_id as string);
  const items:Breakdown[]=[];
  for(const id of ids)try{items.push(await eventBreakdown(stores,id));}catch(error){if(!(error instanceof HttpError))throw error;}
  const complete=items.filter(item=>item.complete&&item.reply_ms!==null);
  const byStage=new Map<string,number[]>();
  for(const item of complete){
    for(const stage of item.stages){const list=byStage.get(stage.stage)??[];list.push(stage.ms);byStage.set(stage.stage,list);}
  }
  const totals=complete.map(item=>item.reply_ms!);
  return {observed_at:now.toISOString(),messages:complete.length,
    reply_ms_p50:totals.length?percentile(totals,0.5):null,reply_ms_p95:totals.length?percentile(totals,0.95):null,
    stages:[...byStage].sort((a,b)=>rank(a[0])-rank(b[0])).map(([stage,values])=>({stage,...describe(stage),messages:values.length,ms_p50:percentile(values,0.5),ms_p95:percentile(values,0.95)})),
    recent:items.map(item=>({event_id:item.event_id,started_at:item.started_at,reply_ms:item.reply_ms,unmeasured_ms:item.unmeasured_ms,complete:item.complete}))};
}
