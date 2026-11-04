import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {backgroundBox,backgroundCard,backgroundJob,backgroundLimit,backgroundRestart,backgroundResume,backgroundTexts,fillTemplate,labeledLines,lineKept,ownerPrompts} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import {pageDate} from '../conversation-page.js';
import type {SourceAccessRepository} from './access.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import {carriesForward,type GuardBinding} from './guards.js';
import {notionJobReads} from './notion.js';
import {OperationRepository} from './operations.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {SourceRepository} from './retrieval.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {RuntimeTurnRepository} from './turns.js';
import {ManagedExecutionRepository,managedEventId,type ManagedInput} from './managed-execution.js';

export const backgroundJobSchema=`
CREATE TABLE IF NOT EXISTS background_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 cost_limit_usd numeric NOT NULL DEFAULT 5 CHECK(cost_limit_usd>0 AND cost_limit_usd<=1000),
 minutes_limit integer NOT NULL DEFAULT 45 CHECK(minutes_limit BETWEEN 5 AND 50),
 member_daily_jobs integer NOT NULL DEFAULT 3 CHECK(member_daily_jobs BETWEEN 0 AND 100),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO background_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS background_jobs (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),source_reference jsonb NOT NULL,proposal_reference jsonb NOT NULL,guard_revision integer,
 binding jsonb NOT NULL,scope text NOT NULL,space_id text NOT NULL,target text NOT NULL,logical_profile text NOT NULL UNIQUE,
 requester text,approver text NOT NULL CHECK(approver IN ('requester','owner')),fingerprint text NOT NULL,estimate jsonb NOT NULL,
 cost_limit_usd numeric NOT NULL,minutes_limit integer NOT NULL CHECK(minutes_limit BETWEEN 5 AND 50),
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','running','reporting','done','failed','stopped','rejected')),
 decision_reference jsonb,decided_by text,cancel_requested boolean NOT NULL DEFAULT false,queued boolean NOT NULL DEFAULT false,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),cost_usd numeric NOT NULL DEFAULT 0,todo jsonb NOT NULL DEFAULT '[]'::jsonb,
 report_reference jsonb,error_code text,started_at timestamptz,finished_at timestamptz,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_jobs_chat ON background_jobs(scope,created_at DESC);
-- The cards that list a job's waiting changes, frozen when they are sent: [{id,fingerprint,members:[[id,fingerprint]…]}].
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS changes jsonb;
-- The sealed job box: the owner's switch for it, and whether a job asked for one (job-box.ts).
ALTER TABLE background_settings ADD COLUMN IF NOT EXISTS box_tools boolean NOT NULL DEFAULT true;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS box boolean NOT NULL DEFAULT false;
-- What the job's model use costs, frozen when it is asked: the reply model's USD rates per million tokens, and the
-- broker's byte backstop with the request bytes it has counted (ADR-0206).
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS rates jsonb;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS byte_budget bigint;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS model_bytes bigint NOT NULL DEFAULT 0;
-- How a job ended at a limit: its run was stopped at its cost or time limit and a short note went out instead of a report.
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS ended text CHECK(ended IN ('cost','time'));
-- Each run of a job is one sealed Hermes turn of up to the job's time limit; a job has at most 3 (ADR-0207). Its counts
-- only grow: the tokens of the calls that reported usage, the calls that did not, the cost at the job's frozen rates.
CREATE TABLE IF NOT EXISTS background_runs (
 event_id text PRIMARY KEY,job_id text NOT NULL REFERENCES background_jobs(id),attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 tokens jsonb,unknown_calls integer NOT NULL DEFAULT 0 CHECK(unknown_calls>=0),cost_usd numeric NOT NULL DEFAULT 0 CHECK(cost_usd>=0),
 todo jsonb,ended text CHECK(ended IN ('cost','time','stopped')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS background_reports (
 job_id text NOT NULL REFERENCES background_jobs(id),part integer NOT NULL CHECK(part>0),action_id text NOT NULL,PRIMARY KEY(job_id,part)
);
`;

const protocol='background-job-v1';
// Hermes's backstop on the tool and thinking steps of one run; time and cost end a run long before it.
export const JOB_ITERATIONS=300;
// A job's runs: the first, and at most two relaunches after a run that did not finish.
const JOB_RUNS=3;
// After the time limit (soft), a run gets this long to send its report before it is stopped (hard); no run starts with
// less than RELAUNCH_MS left to soft; its credential lasts CREDENTIAL_GRACE_MS after hard and its box BOX_GRACE_MS.
const HARD_GRACE_MS=180000,RELAUNCH_MS=180000,CREDENTIAL_GRACE_MS=120000,BOX_GRACE_MS=300000;
// Jobs that run at once; each holds one sealed agent run while it works.
const RUNNING_JOBS=2;
// The longest time limit a job may have: one run, so one credential of at most an hour, covers it (ADR-0207).
export const JOB_MINUTES=50;
// A proposal waits this long for its decision.
const DECISION_HOURS=24;
// The report goes to the chat in parts the Telegram sender splits further.
const REPORT_PART=12000;
export const closedStates=new Set(['done','failed','stopped','rejected']);

/** A rough size of reading a chat once with the reply model: its text, about 50 tokens of
 * page detail for each record and some text for each file, read page by page while the
 * running notes are read again from the model's cache. The runtime prices it. */
export function jobTokens(size:{records:number;characters:number;files:number;images:number;voice_notes:number}) {
  const read=Math.ceil(size.characters/4)+size.records*50+size.files*800+size.images*150+size.voice_notes*300;
  const pages=Math.max(1,Math.ceil(read/7500));
  return {read,pages,input:Math.ceil(read*1.25)+pages*6000,output:pages*400+3000,calls:pages+2,minutes:Math.max(2,Math.ceil(pages*12/60)+1)};
}
/** The reply model's USD rates per million tokens, and per call for `request`, frozen on a job's card; null where no price is known. */
export type JobRates={input:number|null;output:number|null;cache_read:number|null;cache_write:number|null;request:number|null};
const RATE_NAMES=['input','output','cache_read','cache_write','request'] as const;
const TOKEN_NAMES=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','calls'] as const;
/** Rates as the runtime gives them: each a number from 0 below a million, else unknown. */
export const jobRates=(value:unknown):JobRates=>Object.fromEntries(RATE_NAMES.map(name=>{const rate=(value as any)?.[name];
  return [name,typeof rate==='number'&&Number.isFinite(rate)&&rate>=0&&rate<1e6?rate:null];})) as JobRates;
/** Whether a job's cost can be measured: only with known input and output rates. */
export const jobPriced=(rates:JobRates|null|undefined)=>typeof rates?.input==='number'&&typeof rates?.output==='number';
export type RunTokens=Record<typeof TOKEN_NAMES[number],number>;
export type Todo={content:string;status:string};
/** What a running job's turn reports on its heartbeat: cumulative counts for the run, and its to-do list when it changed. */
export type RunProgress={tokens:RunTokens;unknown_calls:number;todo?:Todo[]};
/** A run's token counts: whole numbers from 0 below 10^12 in exactly these fields, else null. */
export function runTokens(value:unknown):RunTokens|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(TOKEN_NAMES as readonly string[]).includes(key))||
    TOKEN_NAMES.some(name=>!Number.isSafeInteger(body[name])||(body[name] as number)<0||(body[name] as number)>=1e12))return null;
  return Object.fromEntries(TOKEN_NAMES.map(name=>[name,body[name]])) as RunTokens;
}
/** Each bucket at the larger of two counts; either may be missing. */
export function maxTokens(a:RunTokens|null,b:RunTokens|null):RunTokens|null {
  return a&&b?Object.fromEntries(TOKEN_NAMES.map(name=>[name,Math.max(a[name],b[name])])) as RunTokens:a??b;
}
// A call that reports no usage is priced as if it read this many prompt tokens and wrote this many.
const UNKNOWN_INPUT=100000,UNKNOWN_OUTPUT=8000;
/** A run's cost in USD at the job's frozen rates: each bucket at its rate (a cache bucket without its own rate takes the input
 *  rate) plus each call's request price, and each call that reported no usage at U, deliberately high: a call that read 100,000
 *  prompt tokens and wrote 8,000. Counts whose calls read no prompt at all are such calls too. Nothing is measured without a
 *  price. Its twin in services/hermes/job_progress.py gives the same numbers (test/run-cost-examples.json). */
export function runCost(rates:JobRates|null|undefined,tokens:RunTokens|null,unknownCalls:number):number {
  if(!jobPriced(rates))return 0;
  const {input,output}=rates as {input:number;output:number},request=rates!.request??0;
  const t=tokens??{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:0};
  const blind=t.calls>0&&t.input_tokens+t.cache_read_tokens+t.cache_write_tokens===0;
  const counted=blind?0:(t.input_tokens*input+t.output_tokens*output+t.cache_read_tokens*(rates!.cache_read??input)+
    t.cache_write_tokens*(rates!.cache_write??input))/1e6+t.calls*request;
  return counted+(unknownCalls+(blind?t.calls:0))*((UNKNOWN_INPUT*input+UNKNOWN_OUTPUT*output)/1e6+request);
}
// NUL and a lone surrogate, which jsonb refuses; with the u flag a valid pair is one code point and never matches.
const unstorable=/[\0\ud800-\udfff]/gu;
const codePoints=(value:unknown,length:number)=>{if(value!==undefined&&typeof value!=='string')throw new HttpError(400,'invalid_run_progress');
  return [...(value as string|undefined)??''].slice(0,length).join('').replace(unstorable,'\ufffd');};
/** A to-do list as a job keeps it: its first 50 items, each cut to 200 code points of content and 20 of status, each
 *  character jsonb refuses replaced. */
export function todoList(value:unknown):Todo[] {
  if(!Array.isArray(value))throw new HttpError(400,'invalid_run_progress');
  return value.slice(0,50).map(item=>{if(!item||typeof item!=='object'||Array.isArray(item))throw new HttpError(400,'invalid_run_progress');
    return {content:codePoints(item.content,200),status:codePoints(item.status,20)};});
}
/** A heartbeat's progress, strictly: the run's token counts and calls without usage, and its to-do list when it changed. */
export function runProgress(value:unknown):RunProgress {
  const body=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null,tokens=runTokens(body?.tokens);
  if(!body||!tokens||Object.keys(body).some(key=>!['tokens','unknown_calls','todo'].includes(key))||!Number.isSafeInteger(body.unknown_calls)||
    (body.unknown_calls as number)<0||(body.unknown_calls as number)>1e6)throw new HttpError(400,'invalid_run_progress');
  return {tokens,unknown_calls:body.unknown_calls as number,...(body.todo===undefined?{}:{todo:todoList(body.todo)})};
}
/** A job's deadlines in epoch milliseconds, shared by all its runs: its time limit after it started (soft, when Hermes's own
 *  run budget ends), the stop (hard), and when its runs' credential and box expire. */
export function jobDeadlines(job:{started_at:Date|string;minutes_limit:number}) {
  const soft=new Date(job.started_at).getTime()+Number(job.minutes_limit)*60000,hard=soft+HARD_GRACE_MS;
  return {soft,hard,credential:hard+CREDENTIAL_GRACE_MS,box:hard+BOX_GRACE_MS};
}
/** Whether a turn is a relaunched run of a job (attempt > 1): it gets no autonomy, so every change it asks for waits for a card. */
export async function relaunchedRun(db:Pick<pg.PoolClient,'query'>,eventId:string):Promise<boolean> {
  return !!(await db.query('SELECT 1 FROM background_runs WHERE event_id=$1 AND attempt>1',[eventId])).rowCount;
}
// The bytes of a model request's JSON per input token, at most, for text: an assumption, to be measured (ADR-0206).
const BYTES_PER_TOKEN=12;
/** The model request bytes past which the broker refuses a job's calls: its cost limit spent at the cheapest
 * non-zero rate a prompt token can have. None without a price, or when every prompt token is free. */
export function byteBudget(costLimit:number,rates:JobRates):number|null {
  const cheapest=Math.min(...[rates.input,rates.cache_read,rates.cache_write].filter((rate):rate is number=>typeof rate==='number'&&rate>0));
  return jobPriced(rates)&&Number.isFinite(cheapest)?Math.floor(costLimit/(cheapest/1e6)*BYTES_PER_TOKEN):null;
}
const money=(value:number|null)=>value===null?'unknown cost':'$'+(value<1?value.toFixed(2):value.toFixed(value<10?1:0));
const count=(value:number,one:string,many:string)=>value.toLocaleString('en-US')+' '+(value===1?one:many);
const sizeLine=(size:any)=>[count(size.messages,'message','messages'),size.files?count(size.files,'file','files'):null,
  size.images?count(size.images,'image','images'):null,size.voice_notes?count(size.voice_notes,'voice note','voice notes'):null].filter(Boolean).join(', ');
/** Split a report at paragraph or line ends into parts Telegram accepts. */
export function reportParts(text:string,limit=REPORT_PART):string[] {
  const parts:string[]=[];let rest=text.trim();
  while(rest.length>limit) {
    const cut=Math.max(rest.lastIndexOf('\n\n',limit),rest.lastIndexOf('\n',limit));
    const at=cut>limit/2?cut:limit;parts.push(rest.slice(0,at).trim());rest=rest.slice(at).trim();
  }
  if(rest)parts.push(rest);return parts;
}

/** Whether the broker has counted a job's model requests past its byte backstop; it refuses their calls from then on. */
const bytesSpent=(row:any)=>row.byte_budget!==null&&Number(row.model_bytes)>=Number(row.byte_budget);

/** A job the owner asked for in their private chat; only its card is the owner's own to approve. */
const privateJob=(row:any,owner:string|null|undefined)=>!!owner&&row.scope===owner&&!row.requester;

/**
 * Whether a turn is a run of a running job that the owner asked for in their
 * private chat and approved there. Every input comes from the run's signed
 * credential and Nocheh's own rows. The job row is locked FOR SHARE, so Stop
 * waits for the caller's transaction and a later call sees the stop.
 */
export async function ownerApprovedJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null}):Promise<boolean> {
  if(!owner||!turn.owner||!turn.job||source.store!=='control')return false;
  return !!(await db.query(`SELECT 1 FROM background_runs s JOIN background_jobs j ON j.id=s.job_id
    WHERE s.event_id=$1 AND j.id=$2 AND j.state='running' AND NOT j.cancel_requested AND j.scope=$3 AND j.requester IS NULL
      AND j.decided_by=$3 AND j.logical_profile=$4 FOR SHARE OF j`,[source.id,turn.job,owner,turn.logical_profile??null])).rowCount;
}

/** SQL over a job row `j`: whether its box time has not passed yet. A box lasts until 5 minutes after the job's hard
 *  deadline (`jobDeadlines`): its time limit and 8 minutes more. */
export const boxOpen=`now()<j.started_at+(j.minutes_limit+8)*interval '1 minute'`;
/** When a job's sealed box must be gone. */
export const boxExpires=(job:{started_at:Date;minutes_limit:number})=>new Date(jobDeadlines(job).box).toISOString();

/** A run's job when the run runs in the job's sealed box: a run of a job that asked for the box and whose box time
 *  has not passed, that `ownerApprovedJob` lets through, while the owner's box switch and the guard are on. Null otherwise. */
export async function boxJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null},guard:GuardBinding):Promise<any|null> {
  if(!turn.job||guard.mode!=='on'||source.store!=='control')return null;
  const job=(await db.query(`SELECT j.* FROM background_jobs j JOIN background_runs t ON t.job_id=j.id AND t.event_id=$2
    JOIN background_settings s ON s.singleton AND s.box_tools WHERE j.id=$1 AND j.box AND ${boxOpen}`,[turn.job,source.id])).rows[0];
  return job&&await ownerApprovedJob(db,owner,source,turn)?job:null;
}

/** Work too big for one reply runs on its own once approved, as one sealed Hermes run of up to its time limit,
 * relaunched at most twice when it does not finish, and reports back to its chat (ADR-0207). */
export class BackgroundJobRepository {
  runs:BackgroundRunRepository;
  /** Shows a job's state on its card; set by the approval cards. */
  settled:(id:string)=>Promise<void>=async()=>{};
  /** Ends a stopped job's changes that still wait for the owner; set by the controlled actions. */
  stopped:(id:string)=>Promise<void>=async()=>{};
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly turns:RuntimeTurnRepository,readonly sources:SourceRepository,readonly telegram:TelegramActionRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>,token:string){
    this.runs=new BackgroundRunRepository(this,token);
  }
  get control(){return this.access.stores.control;}
  get guards(){return this.access.guards;}
  async settings(){
    const row=(await this.control.query('SELECT * FROM background_settings WHERE singleton')).rows[0];
    // A value saved before the 50-minute limit reads as the limit, so it never refuses every job.
    return {cost_limit_usd:Number(row.cost_limit_usd),minutes_limit:Math.min(row.minutes_limit,JOB_MINUTES),member_daily_jobs:row.member_daily_jobs,box_tools:row.box_tools as boolean,revision:row.revision};
  }
  async saveSettings(principal:Reader,input:unknown){
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['cost_limit_usd','minutes_limit','member_daily_jobs','box_tools','revision'].includes(key))||!Number.isSafeInteger(body.revision)||
      body.box_tools!==undefined&&typeof body.box_tools!=='boolean')throw new HttpError(400,'invalid_settings');
    const cost=Number(body.cost_limit_usd),minutes=Number(body.minutes_limit),daily=Number(body.member_daily_jobs);
    if(!(cost>0&&cost<=1000)||!Number.isSafeInteger(minutes)||minutes<5||minutes>JOB_MINUTES||!Number.isSafeInteger(daily)||daily<0||daily>100)throw new HttpError(400,'invalid_settings');
    const changed=await this.control.query(`UPDATE background_settings SET cost_limit_usd=$1,minutes_limit=$2,member_daily_jobs=$3,box_tools=coalesce($5,box_tools),
      revision=revision+1,updated_at=now() WHERE singleton AND revision=$4`,[cost,minutes,daily,body.revision,body.box_tools??null]);
    if(!changed.rowCount)throw new HttpError(409,'configuration_conflict');
    return this.settings();
  }
  private async row(id:unknown){
    const row=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[managedEventId(id)])).rows[0];
    if(!row)throw new HttpError(404,'job_not_found');return row;
  }
  /** A live Telegram turn by the owner or a person allowed in the group; never a job's own run. */
  private async liveTurn(principal:Reader) {
    if(principal.admin||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'job_not_permitted');
    const turn=await this.turns.binding(principal);if(turn.job)throw new HttpError(403,'job_in_a_job');
    const binding=await this.guards.state(),source=await this.prepared.root(principal,binding);
    if(source.store!=='archive')throw new HttpError(403,'job_not_permitted');
    const original=await this.access.archive.verify(source),intake=(await this.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
    if(original.origin!=='live'||original.channel!=='telegram'||intake?.transport==='import'||intake?.state==='pending')throw new HttpError(403,'job_not_permitted');
    const payload=JSON.parse((await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0].payload.toString());
    const sender=conversationScope(this.access.policy(),payload,original.scope);
    if(!sender)throw new HttpError(403,'job_not_permitted');
    return {turn,binding,source:source as SourceReference,requester:sender.owner||sender.user_id===this.access.policy().owner_id?null:sender.user_id};
  }
  private period(body:Record<string,unknown>){
    const from=body.from===undefined?'':string(body.from,40),to=body.to===undefined?'':string(body.to,40);
    pageDate(from);pageDate(to,true);return {from,to};
  }
  /** What reading the chat would take: its size, the time, the reply model's rates, and the cost to read it once at them. */
  async estimate(size:Awaited<ReturnType<SourceRepository['size']>>) {
    const tokens=jobTokens(size);let rates=jobRates(null);
    try{rates=jobRates((await this.call('usage.price',{rates:'reply'},15000)).rates);}catch{/* An unknown price still shows the size and time. */}
    const cost=jobPriced(rates)?Math.round(((tokens.input*rates.input!+tokens.output*rates.output!)/1e6+tokens.calls*(rates.request??0))*100)/100:null;
    return {...size,pages:tokens.pages,tokens:tokens.read,minutes:tokens.minutes,cost_usd:cost,rates};
  }
  /** Ask to start a job: count and price what it reads, then record the proposal its card shows.
   * Nothing runs until whoever approves it presses Approve. */
  async start(principal:Reader,input:unknown) {
    const body=object(input);if(Object.keys(body).some(key=>!['title','instruction','chat','from','to','box'].includes(key))||
      body.box!==undefined&&typeof body.box!=='boolean')throw new HttpError(400,'invalid_job_request');
    const title=string(body.title,100).replace(/\s+/g,' ').trim(),instruction=string(body.instruction,8000).trim();
    if(!title||!instruction)throw new HttpError(400,'invalid_job_request');
    const {turn,binding,source,requester}=await this.liveTurn(principal),{from,to}=this.period(body);
    const size=await this.sources.size(principal,{chat:body.chat===undefined?'':string(body.chat,64),from,to}),settings=await this.settings();
    const owner=this.access.policy().owner_id!,space=principal.space!,scope=space.split('/topic/')[0]===owner?owner:turn.scope,box=body.box===true;
    // Only the owner's own job, asked in their private chat, gets the sealed box, and only while the box switch is on.
    if(box&&(!privateJob({scope,requester},owner)||!settings.box_tools))throw new HttpError(409,'job_box_not_allowed');
    if(requester) {
      const today=Number((await this.control.query(`SELECT count(*) FROM background_jobs WHERE scope=$1 AND requester=$2
        AND state<>'rejected' AND created_at>date_trunc('day',now())`,[turn.scope,requester])).rows[0].count);
      if(today>=settings.member_daily_jobs)throw new HttpError(409,'job_limit_reached');
    }
    const estimate=await this.estimate(size);
    // A member's job over the owner's limit, or on a model whose cost cannot be measured, waits for the owner instead.
    const priced=jobPriced(estimate.rates),approver=requester&&(!priced||(estimate.cost_usd??0)>settings.cost_limit_usd)?'owner':'requester';
    const costLimit=Math.max(settings.cost_limit_usd,Math.ceil((estimate.cost_usd??0)*1.5)),minutesLimit=Math.max(settings.minutes_limit,Math.ceil(estimate.minutes*1.5));
    const bytes=byteBudget(costLimit,estimate.rates);
    // Refused before the secret check spends anything: the agent narrows the period or splits the work.
    if(minutesLimit>JOB_MINUTES)throw new HttpError(409,'job_too_long');
    const id=digest(canonical([protocol,source,binding,title,instruction,size.chat,from,to]));
    const proposal=await this.derived.record({operation_id:'background-proposal:'+id,source,kind:'background_job_request',content:Buffer.from(canonical({title,instruction})),
      producer:'nocheh',producer_version:protocol,configuration:{binding,chat:size.chat,from,to}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),shown=object(JSON.parse(String((representation.value as any).text)));
    const fingerprint=digest(canonical({proposal:shown,chat:size.chat,from,to,estimate,cost_limit:costLimit,minutes_limit:minutesLimit,approver,box,byte_budget:bytes}));
    await this.control.query(`INSERT INTO background_jobs(id,source_reference,proposal_reference,guard_revision,binding,scope,space_id,target,logical_profile,requester,approver,
      fingerprint,estimate,cost_limit_usd,minutes_limit,box,rates,byte_budget) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING`,
      [id,source,proposal,representation.revision,binding,scope,space,size.chat,'job-'+id.slice(0,24),requester,approver,fingerprint,
        {...estimate,from:from||null,to:to||null},costLimit,minutesLimit,box,estimate.rates,bytes]);
    const row=await this.row(id);
    if(row.fingerprint!==fingerprint)throw new HttpError(409,'job_changed');
    return {id,state:row.state,approver:row.approver,fingerprint,estimate:row.estimate,limits:{cost_usd:jobPriced(row.rates)?Number(row.cost_limit_usd):null,minutes:row.minutes_limit},box:row.box as boolean,
      message:row.state==='proposed'?'Nothing runs until it is approved.':'This job was already decided; its state is shown.'};
  }
  /** The exact proposal a card shows, read through the secret check of its audience. */
  async proposal(row:any):Promise<{title:string;instruction:string}> {
    const reference=row.proposal_reference as DerivativeReference,id='derived_artifacts:'+reference.id;
    const saved=row.guard_revision===null?(await this.derived.pool.query('SELECT input AS content FROM guard_sources WHERE id=$1',[id])).rows[0]:
      (await this.derived.pool.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,row.guard_revision])).rows[0];
    if(!saved)throw new HttpError(409,'job_changed');
    const value=object(JSON.parse(String(object(JSON.parse(saved.content.toString())).text)));
    return {title:string(value.title,100),instruction:string(value.instruction,8000)};
  }
  /** The name of the job a run belongs to, for the card of an operation that run asked for; null for anything else. */
  async runJob(eventId:string):Promise<string|null> {
    const row=(await this.control.query('SELECT j.* FROM background_runs s JOIN background_jobs j ON j.id=s.job_id WHERE s.event_id=$1',[eventId])).rows[0];
    if(!row)return null;
    try{return (await this.proposal(row)).title;}catch(error){if(error instanceof HttpError)return null;throw error;}
  }
  /** The card a person approves: the exact instruction, what it reads and what it may cost. */
  async card(id:string) {
    const row=await this.row(id),shown=await this.proposal(row),prompts=await ownerPrompts(this.control),estimate=row.estimate;
    const lines=labeledLines(backgroundTexts,prompts['background.texts']);
    const period=estimate.from||estimate.to?[estimate.from??'…',estimate.to??'…'].join(' – '):null;
    const values:Record<string,string|null|undefined>={title:shown.title,instruction:shown.instruction,
      size:[sizeLine(estimate),period].filter(Boolean).join(', '),minutes:String(estimate.minutes),cost:estimate.cost_usd===null?'cost unknown':'about '+money(estimate.cost_usd),
      // Without a price only the time limit applies, and the card says so instead of a cost limit.
      cost_limit:jobPriced(row.rates)?money(Number(row.cost_limit_usd)):null,unpriced:jobPriced(row.rates)?null:lines.unpriced,minutes_limit:String(row.minutes_limit),origin:null,
      notion:privateJob(row,this.access.policy().owner_id)&&await notionJobReads(this.control)?lines.notion_reads:null,box:row.box?lines.box:null,
      checked:[lines.checked,row.requester?lines.member_limit:null].filter(Boolean).join(' ')||null};
    // What the job may do without asking is always on its card: a saved card without the line, or whose line
    // is left out for another missing value, gets it at the end.
    const template=prompts['background.card']??backgroundCard,kept=template.split('\n').filter(line=>lineKept(line,values));
    // A forced cost line carries the time limit too, when a saved card left it out with the cost limit's line.
    const missing=[['unpriced','🛑'],['notion','📒'],['box','🧰']].filter(([name])=>values[name!]&&!kept.some(line=>line.includes('{'+name+'}'))).map(([name,icon])=>icon+' {'+name+'}'+
      (name==='unpriced'&&!kept.some(line=>line.includes('{minutes_limit}'))?' ({minutes_limit} min)':''));
    const text=fillTemplate(missing.length?template+'\n\n'+missing.join('\n'):template,values);
    const waiting=row.state==='approved'&&Number((await this.control.query("SELECT count(*) FROM background_jobs WHERE state IN ('running','reporting')")).rows[0].count)>=RUNNING_JOBS;
    return {row,text,fingerprint:row.fingerprint,state:row.state,waiting,lines};
  }
  /** The decision on a card, by the owner or, on their own job's card in its chat, the person who asked. */
  async decide(by:string,input:unknown,source:SourceReference) {
    const body=object(input),row=await this.row(body.id);
    if(body.fingerprint!==row.fingerprint)throw new HttpError(409,'job_changed');
    await this.access.archive.verify(source);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const current=(await db.query('SELECT * FROM background_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(current.state!=='proposed'||current.created_at<new Date(Date.now()-DECISION_HOURS*3600000))throw new HttpError(409,'job_already_decided');
      const approve=body.decision==='approve';
      await db.query(`UPDATE background_jobs SET state=$2,decision_reference=$3,decided_by=$4,finished_at=CASE WHEN $2='rejected' THEN now() END,
        revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,approve?'approved':'rejected',source,by]);
      if(approve)await requestWorkflow(db,'background','job:'+row.id);
      await db.query('COMMIT');return {id:row.id,state:approve?'approved':'rejected'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Who may press a card's buttons: the owner always, the person who asked only on their own job's card. */
  async presser(id:string,user:string,chat:string):Promise<boolean> {
    const row=await this.row(id),owner=this.access.policy().owner_id;
    if(user===owner)return true;
    return row.approver==='requester'&&!!row.requester&&row.requester===user&&row.scope===chat;
  }
  /** Jobs this chat can see: its own, or every job for the owner. */
  async list(principal:Reader) {
    let rows;
    if(principal.admin)rows=(await this.control.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT 50')).rows;
    else {
      await this.turns.binding(principal);
      rows=principal.scope===null?(await this.control.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT 20')).rows:
        (await this.control.query('SELECT * FROM background_jobs WHERE scope=$1 ORDER BY created_at DESC LIMIT 20',[principal.scope])).rows;
    }
    const jobs=[];
    for(const row of rows) {
      let title:string|null=null;try{title=(await this.proposal(row)).title;}catch(error){if(!(error instanceof HttpError))throw error;}
      jobs.push({id:row.id,title,state:row.cancel_requested&&!closedStates.has(row.state)?'stopping':row.state,chat:row.target,asked_in:row.space_id,
        attempts:row.attempts,ended:row.ended,cost_usd:Number(row.cost_usd),cost_limit_usd:Number(row.cost_limit_usd),priced:jobPriced(row.rates),minutes_limit:row.minutes_limit,estimate:row.estimate,
        todo:row.todo,started_at:row.started_at,finished_at:row.finished_at,created_at:row.created_at,error_code:row.error_code,
        ...(principal.admin?{logical_profile:row.logical_profile,approver:row.approver}:{})});
    }
    return {jobs};
  }
  /** Stop a job: a proposal is withdrawn, a running job's run is cancelled and no report is sent.
   * The card's rule: the dashboard and the owner stop any job; a member only the job they asked for,
   * in its own chat, and a job of another chat stays unseen. A job's own turn stops none. */
  async stop(principal:Reader,input:unknown) {
    const body=object(input),live=principal.admin?null:await this.liveTurn(principal),row=await this.row(body.id);
    if(live?.requester) {
      if(row.scope!==live.turn.scope)throw new HttpError(404,'job_not_found');
      if(row.requester!==live.requester)throw new HttpError(403,'job_not_permitted');
    }
    return this.halt(row.id);
  }
  /** Stop a job that has not ended, whoever asked: the Stop of the tool, the dashboard and the job's card. Its live run
   *  ends as stopped, which cancels it; what the job left waiting ends when the job does. */
  async halt(id:string):Promise<{id:string;state:'stopped'|'stopping'}> {
    const row=await this.row(id);
    if(closedStates.has(row.state))throw new HttpError(409,'job_not_running');
    const changed=await this.control.query(`UPDATE background_jobs SET cancel_requested=true,state=CASE WHEN state='proposed' THEN 'stopped' ELSE state END,
      finished_at=CASE WHEN state='proposed' THEN now() END,revision=revision+1,updated_at=now() WHERE id=$1 AND state NOT IN ('done','failed','stopped','rejected')`,[row.id]);
    if(!changed.rowCount)throw new HttpError(409,'job_not_running');
    const run=await this.latest(row.id);
    if(run&&['captured','running'].includes(run.run_state))await this.runs.end(run.event_id,'stopped');
    return {id:row.id,state:row.state==='proposed'?'stopped':'stopping'};
  }
  /** A job's newest run with its managed run's state. */
  private async latest(id:string) {
    return (await this.control.query(`SELECT b.*,r.state AS run_state,r.error_code AS run_error,r.result_reference,r.binding AS run_binding,r.input_reference
      FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1`,[id])).rows[0];
  }
  /** One run of a job, recorded with its managed run; the first also starts the job's clock. Nothing is added to a job
   *  that was stopped or ended meanwhile: the job row is locked first. */
  private async addRun(row:any,attempt:number):Promise<void> {
    const operation=await new OperationRepository(this.control).record({key:'background-run:'+row.id+':'+attempt,kind:'background_run',
      scope:row.space_id,input_hash:digest(canonical({job:row.id,attempt}))});
    const binding=await this.guards.state(),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const job=(await db.query('SELECT state,cancel_requested FROM background_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(!job||job.cancel_requested||!['approved','running'].includes(job.state)){await db.query('ROLLBACK');return;}
      const owner=(await db.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0];
      await db.query('INSERT INTO background_runs(event_id,job_id,attempt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[operation.id,row.id,attempt]);
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,owner_epoch,job_id)
        VALUES($1,'background',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [operation.id,operation,row.scope,row.space_id,row.logical_profile,'job_'+row.id.slice(0,24),binding,owner.epoch,row.id]);
      // The job runs from its first run's commit, so the run's own claim and context see its clock.
      await db.query(`UPDATE background_jobs SET state='running',started_at=coalesce(started_at,now()),attempts=GREATEST(attempts,$2),
        revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,attempt]);
      await requestWorkflow(db,'background','run:'+operation.id);await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  private async finish(row:any,state:'done'|'failed'|'stopped',code:string|null=null) {
    // After Stop, whatever the job asked for that still waits for the owner ends first, however the job
    // ends. A failure here fails the tick, which is tried again (ADR-0204).
    if(state==='stopped'||(await this.control.query('SELECT cancel_requested FROM background_jobs WHERE id=$1',[row.id])).rows[0]?.cancel_requested)
      await this.stopped(row.id);
    const changed=await this.control.query(`UPDATE background_jobs SET state=$2,error_code=$3,finished_at=now(),revision=revision+1,updated_at=now()
      WHERE id=$1 AND state NOT IN ('done','failed','stopped','rejected')`,[row.id,state,code]);
    if(changed.rowCount)await this.settled(row.id);
    return observation(state==='done'?'completed':state==='stopped'?'cancelled':'failed','assistant',0,Date.now(),state==='failed'?'workflow_execution_failed':null);
  }
  /** Drive one job: start its run when a slot is free, watch it, and send its report, or a short note at a limit.
   *  A run that did not finish is relaunched at most twice, while there is time and money left and its member may still ask. */
  async tick(id:string,authority:ExecutionAuthority):Promise<Observation> {
    const row=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
    if(!row||row.state==='proposed'||row.state==='rejected')return observation('skipped','admission');
    if(row.state==='done')return observation('completed','delivery');
    if(row.state==='stopped')return observation('cancelled','assistant');
    if(row.state==='failed')return observation('failed','assistant',0,Date.now(),'workflow_execution_failed');
    if((await this.control.query("SELECT 1 FROM workflow_owners WHERE family='background' AND owner=$1 AND epoch=$2 AND admission",[authority.owner,authority.epoch])).rowCount===0)
      return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
    if(row.state==='approved') {
      if(row.cancel_requested)return this.finish(row,'stopped');
      const running=Number((await this.control.query("SELECT count(*) FROM background_jobs WHERE state IN ('running','reporting')")).rows[0].count);
      if(running>=RUNNING_JOBS) {
        await this.control.query('UPDATE background_jobs SET queued=true WHERE id=$1 AND NOT queued',[id]);
        return observation('waiting','admission',0,Date.now()+30000,'prerequisite');
      }
      await this.addRun(row,1);
      // A card that said the job waits for a free slot now says it runs.
      if(row.queued)await this.settled(id);
      return observation('waiting','assistant',0,Date.now()+5000,'receipt_pending');
    }
    if(row.state==='reporting')return this.report(row);
    const run=await this.latest(id);
    if(!run){await this.addRun(row,1);return observation('waiting','assistant',0,Date.now()+5000,'receipt_pending');}
    const {soft,hard}=jobDeadlines(row),now=Date.now();
    if(['captured','running'].includes(run.run_state)) {
      // A running run past its time is stopped by its heartbeat; one still waiting to start is stopped here.
      if(row.cancel_requested)await this.runs.end(run.event_id,'stopped');
      else if(run.run_state==='captured'&&now>=hard)await this.runs.end(run.event_id,'time');
      return observation('waiting','assistant',row.attempts,now+15000,'receipt_pending');
    }
    // A stopped job sends neither its report nor a note.
    if(row.cancel_requested)return this.finish(row,'stopped');
    if(run.run_state==='done') {
      await this.control.query(`UPDATE background_jobs SET state='reporting',report_reference=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='running'`,[id,run.result_reference]);
      return this.report({...row,state:'reporting',report_reference:run.result_reference});
    }
    // A run stopped at a limit, or one that ended past its time or after the broker's byte backstop, gets no report from a model.
    const limit=['cost','time'].includes(run.ended)?run.ended:bytesSpent(row)?'cost':['interrupted','failed'].includes(run.run_state)&&now>=hard?'time':null;
    if(limit)return this.limitEnding(row,run,limit);
    if(!this.permitted(row))return this.finish(row,'failed','job_not_permitted');
    if(run.attempt<JOB_RUNS&&soft-now>=RELAUNCH_MS&&!(jobPriced(row.rates)&&Number(row.cost_usd)>=Number(row.cost_limit_usd))) {
      await this.addRun(row,run.attempt+1);return observation('waiting','assistant',row.attempts,now+10000,'receipt_pending');
    }
    return this.finish(row,'failed',run.run_error??'job_run_failed');
  }
  /** A run's counts only grow. The run's cost is priced at the job's frozen rates; the job's cost is the sum of its runs' and
   *  its to-do list the newest one, in the same transaction, so the list and the dashboard read live values. */
  async progress(eventId:string,input:RunProgress):Promise<void> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const run=(await db.query('SELECT b.*,j.rates FROM background_runs b JOIN background_jobs j ON j.id=b.job_id WHERE b.event_id=$1 FOR UPDATE OF b',[eventId])).rows[0];
      if(run) {
        const tokens=maxTokens(runTokens(run.tokens),input.tokens),unknown=Math.max(run.unknown_calls,input.unknown_calls);
        const todo=input.todo===undefined?null:JSON.stringify(input.todo);
        await db.query(`UPDATE background_runs SET tokens=$2,unknown_calls=$3,cost_usd=GREATEST(cost_usd,$4),todo=coalesce($5::jsonb,todo),updated_at=now() WHERE event_id=$1`,
          [eventId,tokens,unknown,runCost(jobRates(run.rates),tokens,unknown),todo]);
        // Every heartbeat writes here, so the job's revision, which its other changes move, stays.
        await db.query(`UPDATE background_jobs SET cost_usd=GREATEST(cost_usd,(SELECT coalesce(sum(cost_usd),0) FROM background_runs WHERE job_id=$1)),
          todo=coalesce($2::jsonb,todo),updated_at=now() WHERE id=$1`,[run.job_id,todo]);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Which limit a running job has reached: its cost (a priced job only, or the broker's byte backstop) or its time. */
  async overLimit(id:string):Promise<'cost'|'time'|null> {
    const job=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
    if(!job)return null;
    if(jobPriced(jobRates(job.rates))&&Number(job.cost_usd)>=Number(job.cost_limit_usd)||bytesSpent(job))return 'cost';
    return job.started_at&&Date.now()>=jobDeadlines(job).hard?'time':null;
  }
  /** Whether the person who asked for a job may still use Nocheh in its chat; the owner's own job always. */
  permitted(job:any):boolean {
    const access=this.access.policy().group_access?.[job.scope];
    return !job.requester||!!access?.granted.includes(job.requester)&&!access.denied.includes(job.requester);
  }
  /** The newest to-do list a run of the job kept, while what that run read may still be shown: its binding carries to `binding`. */
  private async carriedTodo(id:string,binding:GuardBinding):Promise<Todo[]|null> {
    const kept=(await this.control.query(`SELECT b.todo,r.binding FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id
      WHERE b.job_id=$1 AND b.todo IS NOT NULL ORDER BY b.attempt DESC LIMIT 1`,[id])).rows[0];
    return kept&&await carriesForward(this.control,kept.binding,binding)?kept.todo:null;
  }
  /** At a cost or time limit no model writes a report: a short note of what the last to-do list says is done and left goes out
   *  instead, through report(), so carriesForward, the member re-check, Stop and per-part staging apply to it. */
  private async limitEnding(row:any,run:any,limit:'cost'|'time'):Promise<Observation> {
    const prompts=await ownerPrompts(this.control),shown=await this.proposal(row),todo=await this.carriedTodo(row.id,run.run_binding);
    const named=(statuses:string[])=>todo!.filter(item=>statuses.includes(item.status)).map(item=>item.content).join('; ');
    const text=fillTemplate(prompts['background.limit']??backgroundLimit,{title:shown.title,limit,
      done:todo?.length?named(['completed'])||'nothing yet':null,left:todo?.length?named(['pending','in_progress'])||'nothing':null,
      none:todo?.length?null:'No to-do list was kept.'});
    const note=await this.derived.record({operation_id:'background-limit:'+row.id,source:row.source_reference,parents:[row.proposal_reference],
      kind:'background_limit_note',content:Buffer.from(canonical({text})),producer:'nocheh',producer_version:protocol,
      configuration:{binding:run.run_binding,job_id:row.id,limit}});
    await this.control.query(`UPDATE background_jobs SET state='reporting',ended=$2,report_reference=$3,revision=revision+1,updated_at=now()
      WHERE id=$1 AND state='running'`,[row.id,limit,note]);
    return this.report({...row,state:'reporting',ended:limit,report_reference:note});
  }
  /** The job's audience in the current epoch, for the report it sends to the chat where it was asked. */
  private audience(row:any,binding:GuardBinding):Reader {
    const owner=this.access.policy().owner_id;
    return {admin:false,scope:row.scope===owner?null:row.scope,space:row.space_id,turnEvent:row.source_reference.id,
      logical_profile:row.logical_profile,generation:binding.generation,guard_epoch:binding.epoch};
  }
  /** Send the final answer to the chat where the job was asked, part after part. */
  private async report(row:any):Promise<Observation> {
    const result=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.report_reference?.id])).rows[0];
    if(!result||digest(result.content)!==row.report_reference.input_hash)return this.finish(row,'failed','job_report_missing');
    const parts=reportParts(String(JSON.parse(result.content.toString()).text??''));
    if(!parts.length)return this.finish(row,'failed','job_report_empty');
    const sent=(await this.control.query(`SELECT b.part,a.state FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id
      WHERE b.job_id=$1 ORDER BY b.part`,[row.id])).rows;
    const last=sent.at(-1);
    if(last&&['failed','ambiguous','cancelled','rejected'].includes(last.state))return this.finish(row,'failed','job_report_not_delivered');
    if(last&&last.state!=='done')return observation('waiting','delivery',sent.length,Date.now()+5000,'receipt_pending');
    if(sent.length>=parts.length)return this.finish(row,'done');
    // A stopped job sends no further part.
    if(row.cancel_requested)return this.finish(row,'stopped');
    // A member removed from the chat since the job ran gets nothing sent there.
    if(!sent.length&&!this.permitted(row))return this.finish(row,'failed','job_not_permitted');
    const part=sent.length+1,binding=await this.guards.state(),run=await this.latest(row.id);
    // The last run wrote the report in its own epoch. Only quiet epochs, a reaction or an automatic learning revision, may
    // have passed since (ADR-0201); any other change may have withdrawn what it read.
    if(!run||!await carriesForward(this.control,run.run_binding,binding))return this.finish(row,'failed','job_report_outdated');
    const prepared=await this.telegram.prepareSystem(this.audience(row,binding),row.source_reference,binding,row.space_id,parts[part-1]!,'background-report:'+row.id+':'+part);
    // A part's message and its record commit together under the job's lock, so neither a retry
    // in a later epoch nor a second tick sends a part twice, and none is staged after Stop.
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const action=await this.telegram.stageSystem(db,prepared);
      const job=(await db.query('SELECT state,cancel_requested FROM background_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      const saved=job.state==='reporting'&&!job.cancel_requested&&
        (await db.query('INSERT INTO background_reports(job_id,part,action_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.id,part,action.id])).rowCount===1;
      await db.query(saved?'COMMIT':'ROLLBACK');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return observation('waiting','delivery',part,Date.now()+5000,'receipt_pending');
  }
  /** The workflow family: `job:` drives a job, `run:` one of its runs. */
  async operation(job:string,authority:ExecutionAuthority):Promise<Observation> {
    if(job.startsWith('run:'))return this.runs.run(managedEventId(job.slice(4)),authority);
    if(job.startsWith('job:'))return this.tick(managedEventId(job.slice(4)),authority);
    return observation('failed','admission');
  }
  /** A run's message. A relaunch in an epoch where an earlier run of the job ran (same physical profile, so Hermes reloads its
   *  history) gets the resume line; a relaunch after any other run gets the first message again with the restart note, whose
   *  to-do line is kept only while carriedTodo allows it. An earlier run ran only if it made a model call, after which Hermes
   *  has its first message: one that failed before (no box, a busy profile) left nothing to resume or restart. A box run also
   *  says what the box holds, every time: the box can be new. */
  async runText(job:any,run:any,binding:GuardBinding,box=false):Promise<string> {
    const prompts=await ownerPrompts(this.control),shown=await this.proposal(job);
    const ran=run.attempt>1?(await this.control.query(`SELECT r.binding FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id
      WHERE b.job_id=$1 AND b.attempt<$2 AND r.input_reference IS NOT NULL AND (b.unknown_calls>0 OR coalesce((b.tokens->>'calls')::integer,0)>0)`,
      [job.id,run.attempt])).rows:[];
    const same=ran.some(({binding:earlier})=>earlier.generation===binding.generation&&Number(earlier.epoch)===binding.epoch);
    let text=same?fillTemplate(prompts['background.resume']??backgroundResume,{title:shown.title}):await this.firstMessage(job,shown,prompts);
    if(ran.length&&!same){const todo=await this.carriedTodo(job.id,binding);
      text+='\n\n'+fillTemplate(prompts['background.restart']??backgroundRestart,{todo:todo?.length?todo.map(item=>item.content+' ('+item.status+')').join('; '):null});}
    return box?text+'\n\n'+(prompts['background.box']??backgroundBox):text;
  }
  private async firstMessage(job:any,shown:{title:string;instruction:string},prompts:Awaited<ReturnType<typeof ownerPrompts>>):Promise<string> {
    const estimate=job.estimate,owner=this.access.policy().owner_id,period=estimate.from||estimate.to?[estimate.from??'the start',estimate.to??'now'].join(' to '):'the whole chat';
    return fillTemplate(prompts['background.job']??backgroundJob,{title:shown.title,instruction:shown.instruction,
      chat:job.target===owner?'your private chat with the owner (chat '+job.target+')':'chat '+job.target,period,size:sizeLine(estimate),
      // Without a price only the time limit applies, so the job is not told of a dollar limit.
      limits:jobPriced(job.rates)?money(Number(job.cost_limit_usd))+' or '+job.minutes_limit+' minutes, whichever comes first':job.minutes_limit+' minutes'});
  }
  /** A run may run only while its job runs and the person who asked may still use Nocheh there. */
  async allowed(row:any) {
    const job=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[row.job_id])).rows[0];
    if(!job||job.state!=='running'||job.cancel_requested||job.logical_profile!==row.logical_profile||job.space_id!==row.space_id)throw new HttpError(409,'job_not_running');
    if(!this.permitted(job))throw new HttpError(403,'job_not_permitted');
    return job;
  }
}

/** Each run of a job is a managed run: claimed, leased, cancellable, and recorded before its result counts. */
export class BackgroundRunRepository extends ManagedExecutionRepository {
  protected readonly channel='background' as const;
  protected readonly family='background' as const;
  protected override get resultKind(){return 'background_result';}
  protected override get protocol(){return 'managed-background-v1';}
  constructor(readonly jobs:BackgroundJobRepository,token:string){super(jobs.access,jobs.derived,jobs.turns,token,jobs.call);}
  private async runRow(id:string){
    const run=(await this.control.query('SELECT * FROM background_runs WHERE event_id=$1',[id])).rows[0];
    if(!run)throw new HttpError(404,'captured_run_not_found');return run;
  }
  private async job(row:any){return (await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[row.job_id])).rows[0];}
  /** A run's credential lasts until 2 minutes after its job's hard deadline, and never more than an hour. */
  protected override async credentialExpiry(row:any):Promise<number> {
    const job=await this.job(row);
    if(!job?.started_at||jobDeadlines(job).hard<=Date.now())throw new HttpError(409,'job_not_running');
    return Math.min(jobDeadlines(job).credential,Date.now()+3600000);
  }
  protected async readiness(_row:any){return observation('completed','preparation');}
  protected override async profile(scope:string,space:string,profile:string,binding:GuardBinding){
    const policy=this.access.policy(),job=(await this.control.query('SELECT scope,space_id FROM background_jobs WHERE logical_profile=$1',[profile])).rows[0];
    if(!job||job.scope!==scope||job.space_id!==space||scope!==policy.owner_id&&!policy.group_ids.includes(scope))throw new HttpError(403,'profile_scope_denied');
    await this.guards.assertCurrent(binding);
  }
  protected async sourceAllowed(row:any,_binding:GuardBinding){
    await new OperationRepository(this.control).verify(row.source_reference);
    await this.jobs.allowed(row);
  }
  /** What the turn needs to run, warn and stop on its own: its iteration backstop, deadlines in epoch seconds, the job's
   *  frozen rates, its cost limit (none without a price) and what its earlier runs cost. */
  protected override async contextDetails(row:any){
    const run=await this.runRow(row.event_id),job=await this.job(row);
    if(!job?.started_at)throw new HttpError(409,'job_not_running');
    const rates=jobRates(job.rates),{soft,hard}=jobDeadlines(job);
    const prior=Number((await this.control.query('SELECT coalesce(sum(cost_usd),0) AS cost FROM background_runs WHERE job_id=$1 AND attempt<$2',[row.job_id,run.attempt])).rows[0].cost);
    return {background:{job_id:row.job_id,attempt:run.attempt,max_iterations:JOB_ITERATIONS,box:await this.box(row),
      soft_deadline:Math.floor(soft/1000),hard_deadline:Math.floor(hard/1000),rates,cost_limit_usd:jobPriced(rates)?Number(job.cost_limit_usd):null,prior_cost_usd:prior}};
  }
  /** Whether a run runs in its job's sealed box: the same rule that puts the box in its binding (job-box.ts). */
  private async box(row:any):Promise<boolean> {
    const owner=this.access.policy().owner_id;
    return !!await boxJob(this.control,owner,row.source_reference,{owner:row.scope===owner,job:row.job_id,logical_profile:row.logical_profile},await this.guards.state());
  }
  protected async build(row:any){
    await this.current(row);const principal=this.principal(row),job=await this.jobs.allowed(row),run=await this.runRow(row.event_id);
    await this.turns.register(principal,{logical_profile:row.logical_profile,job:row.job_id});
    const input:ManagedInput={principal,text:await this.jobs.runText(job,run,row.binding,await this.box(row)),transcripts:[],files:[],source_key:'nocheh:operation:'+row.event_id};
    await this.turns.prepared.allow(principal,input);
    const reference=await this.derived.record({operation_id:'background-input:'+row.event_id,source:row.source_reference,parents:[job.proposal_reference],
      kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:this.protocol,
      configuration:{binding:row.binding,profile:row.logical_profile,job_id:row.job_id},provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
  /** The run's receipt carries its final counts (the larger of its last progress and Hermes's own) and its last to-do list.
   *  Counts that are not plain whole numbers are ignored; the counts already kept stay. */
  override async finish(input:unknown){
    const body=object(input),row=await this.row(managedEventId(body.event_id));
    if(!row?.actor||row.actor!==body.actor)throw new HttpError(403,'run_actor_mismatch');
    const tokens=runTokens(body.tokens),calls=body.unknown_calls,unknown=Number.isSafeInteger(calls)&&(calls as number)>=0&&(calls as number)<=1e6?calls as number:0;
    let todo:Todo[]|undefined;try{todo=Array.isArray(body.todo)?todoList(body.todo):undefined;}catch(error){if(!(error instanceof HttpError))throw error;}
    if(tokens||unknown||todo)await this.jobs.progress(row.event_id,{tokens:tokens??{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:0},
      unknown_calls:unknown,...(todo?{todo}:{})});
    const {tokens:_tokens,unknown_calls:_unknown,todo:_todo,...result}=body;
    return super.finish(result);
  }
  /** Progress counts first, even while the run is being stopped (the base answers a cancelled run before any check). A live
   *  run past its cost or time limit is then ended, and the base answer carries cancel_requested to the turn. */
  override async heartbeat(input:unknown){
    const body=object(input),row=await this.scoped(body);
    if(!row.actor||row.actor!==body.actor||row.owner_epoch!==body.owner_epoch)throw new HttpError(409,'run_lease_lost');
    if(body.progress!==undefined)await this.jobs.progress(row.event_id,runProgress(body.progress));
    if(row.state==='running'&&!row.cancel_requested){const limit=await this.jobs.overLimit(row.job_id);if(limit)await this.end(row.event_id,limit);}
    const {progress:_progress,...rest}=body;
    return super.heartbeat(rest);
  }
  /** A run is watched every 15 seconds while it waits or runs; its heartbeat, not this, stops it at a limit. */
  protected override status(row:any):Observation {
    const seen=super.status(row);return ['captured','running'].includes(row.state)?{...seen,next_attempt:Date.now()+15000}:seen;
  }
  /** Stop a live run for one reason: the reason and the cancel (which closes its runtime turn, so the broker refuses its next
   *  call) commit together. A run that already closed keeps its end; the first reason wins. */
  async end(id:string,reason:'cost'|'time'|'stopped'):Promise<void> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const run=(await db.query('SELECT state FROM managed_runs WHERE event_id=$1 FOR UPDATE',[id])).rows[0];
      if(run&&['captured','running'].includes(run.state)) {
        await db.query('UPDATE background_runs SET ended=coalesce(ended,$2),updated_at=now() WHERE event_id=$1',[id,reason]);
        await this.cancelIn(db,id);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Whether a run's turn may go on: its run and job still run, for the same chat and profile. */
  async deliveryAllowed(principal:Reader):Promise<boolean> {
    const row=principal.turnEvent?await this.row(principal.turnEvent):null;
    if(!row||row.state!=='running'||row.cancel_requested||row.space_id!==principal.space||row.logical_profile!==principal.logical_profile||
      (row.scope===this.access.policy().owner_id?null:row.scope)!==principal.scope)return false;
    try{await this.current(row);return true;}catch(error){if(error instanceof HttpError&&error.status<500)return false;throw error;}
  }
}
