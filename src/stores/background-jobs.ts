import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {backgroundBox,backgroundCard,backgroundContinue,backgroundJob,backgroundTexts,backgroundWrapUp,fillTemplate,labeledLines,lineKept,ownerPrompts} from '../prompts.js';
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
 minutes_limit integer NOT NULL DEFAULT 60 CHECK(minutes_limit BETWEEN 5 AND 1440),
 member_daily_jobs integer NOT NULL DEFAULT 3 CHECK(member_daily_jobs BETWEEN 0 AND 100),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO background_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS background_jobs (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),source_reference jsonb NOT NULL,proposal_reference jsonb NOT NULL,guard_revision integer,
 binding jsonb NOT NULL,scope text NOT NULL,space_id text NOT NULL,target text NOT NULL,logical_profile text NOT NULL UNIQUE,
 requester text,approver text NOT NULL CHECK(approver IN ('requester','owner')),fingerprint text NOT NULL,estimate jsonb NOT NULL,
 cost_limit_usd numeric NOT NULL,minutes_limit integer NOT NULL,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','running','reporting','done','failed','stopped','rejected')),
 decision_reference jsonb,decided_by text,cancel_requested boolean NOT NULL DEFAULT false,queued boolean NOT NULL DEFAULT false,
 steps integer NOT NULL DEFAULT 0,cost_usd numeric NOT NULL DEFAULT 0,todo jsonb NOT NULL DEFAULT '[]'::jsonb,
 report_reference jsonb,error_code text,started_at timestamptz,finished_at timestamptz,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_jobs_chat ON background_jobs(scope,created_at DESC);
-- The cards that list a job's waiting changes, frozen when they are sent: [{id,fingerprint,members:[[id,fingerprint]…]}].
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS changes jsonb;
-- The sealed job box: the owner's switch for it, and whether a job asked for one (job-box.ts).
ALTER TABLE background_settings ADD COLUMN IF NOT EXISTS box_tools boolean NOT NULL DEFAULT true;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS box boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS background_steps (
 event_id text PRIMARY KEY,job_id text NOT NULL REFERENCES background_jobs(id),step integer NOT NULL CHECK(step>0),
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0),kind text NOT NULL CHECK(kind IN ('work','wrap_up')),
 continues boolean,todo jsonb,cost_usd numeric,counted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,step,attempt)
);
-- What the job's model use costs, frozen when it is asked: the reply model's USD rates per million tokens, and the
-- broker's byte backstop with the request bytes it has counted (ADR-0206). A step keeps the token counts it reported.
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS rates jsonb;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS byte_budget bigint;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS model_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE background_steps ADD COLUMN IF NOT EXISTS tokens jsonb;
CREATE TABLE IF NOT EXISTS background_reports (
 job_id text NOT NULL REFERENCES background_jobs(id),part integer NOT NULL CHECK(part>0),action_id text NOT NULL,PRIMARY KEY(job_id,part)
);
`;

const protocol='background-job-v1';
// Tool and thinking steps in one step of a job, and in the step that writes the report at a limit.
const WORK_ITERATIONS=20,WRAP_UP_ITERATIONS=4;
// A step that fails is tried again this many times before the job stops.
const STEP_RETRIES=2;
// Jobs that run at once; each holds one sealed agent run while it works.
const RUNNING_JOBS=2;
// The longest time limit a job may have.
export const JOB_MINUTES=1440;
// A proposal waits this long for its decision.
const DECISION_HOURS=24;
// The report goes to the chat in parts the Telegram sender splits further.
const REPORT_PART=12000;
const closedStates=new Set(['done','failed','stopped','rejected']);

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
/** A step receipt's token counts: whole numbers from 0 below 10^12 in exactly these fields, else null. */
export function stepTokens(value:unknown):Record<typeof TOKEN_NAMES[number],number>|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(TOKEN_NAMES as readonly string[]).includes(key))||
    TOKEN_NAMES.some(name=>!Number.isSafeInteger(body[name])||(body[name] as number)<0||(body[name] as number)>=1e12))return null;
  return Object.fromEntries(TOKEN_NAMES.map(name=>[name,body[name]])) as any;
}
// A step that reports no token counts is priced as if each of its iterations were a call this large.
const UNKNOWN_INPUT=100000,UNKNOWN_OUTPUT=8000;
/** A step's cost in USD at the job's frozen rates. A step without counts is priced high, never as free, and so is one
 * whose calls read no prompt, since every model call reads one: its provider reported no usage. A cache bucket without
 * its own rate takes the input rate, and each call adds its per-request price. Nothing is measured without a price. */
export function stepCost(rates:JobRates|null|undefined,tokens:unknown,iterations:number):number {
  if(!jobPriced(rates))return 0;
  const {input,output}=rates as {input:number;output:number},request=rates!.request??0,counts=stepTokens(tokens);
  if(!counts||counts.calls>0&&counts.input_tokens+counts.cache_read_tokens+counts.cache_write_tokens===0) {
    const calls=Math.max(iterations,counts?.calls??0);return calls*(UNKNOWN_INPUT*input+UNKNOWN_OUTPUT*output)/1e6+calls*request;
  }
  return (counts.input_tokens*input+counts.output_tokens*output+counts.cache_read_tokens*(rates!.cache_read??input)+
    counts.cache_write_tokens*(rates!.cache_write??input))/1e6+counts.calls*request;
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
 * Whether a turn is a step of a running job that the owner asked for in their
 * private chat and approved there. Every input comes from the step's signed
 * credential and Nocheh's own rows. The job row is locked FOR SHARE, so Stop
 * waits for the caller's transaction and a later call sees the stop.
 */
export async function ownerApprovedJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null}):Promise<boolean> {
  if(!owner||!turn.owner||!turn.job||source.store!=='control')return false;
  return !!(await db.query(`SELECT 1 FROM background_steps s JOIN background_jobs j ON j.id=s.job_id
    WHERE s.event_id=$1 AND j.id=$2 AND j.state='running' AND NOT j.cancel_requested AND j.scope=$3 AND j.requester IS NULL
      AND j.decided_by=$3 AND j.logical_profile=$4 FOR SHARE OF j`,[source.id,turn.job,owner,turn.logical_profile??null])).rowCount;
}

// A sealed box lasts a job's time limit and an hour more, for its last steps; later steps run without one.
const BOX_MINUTES=60;
/** SQL over a job row `j`: whether its box time has not passed yet. */
export const boxOpen=`now()<j.started_at+(j.minutes_limit+${BOX_MINUTES})*interval '1 minute'`;
/** When a job's sealed box must be gone. */
export const boxExpires=(job:{started_at:Date;minutes_limit:number})=>new Date(new Date(job.started_at).getTime()+(Number(job.minutes_limit)+BOX_MINUTES)*60000).toISOString();

/** A step's job when the step runs in the job's sealed box: a work step, never the report at a limit, of a job
 *  that asked for the box and whose box time has not passed, that `ownerApprovedJob` lets through, while the
 *  owner's box switch and the guard are on. Null otherwise. */
export async function boxJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null},guard:GuardBinding):Promise<any|null> {
  if(!turn.job||guard.mode!=='on'||source.store!=='control')return null;
  const job=(await db.query(`SELECT j.* FROM background_jobs j JOIN background_steps t ON t.job_id=j.id AND t.event_id=$2 AND t.kind='work'
    JOIN background_settings s ON s.singleton AND s.box_tools WHERE j.id=$1 AND j.box AND ${boxOpen}`,[turn.job,source.id])).rows[0];
  return job&&await ownerApprovedJob(db,owner,source,turn)?job:null;
}

/** Work too big for one reply runs on its own once approved, as a chain of sealed
 * steps that continue one Hermes session of its own, and reports back to its chat. */
export class BackgroundJobRepository {
  steps:BackgroundStepRepository;
  /** Shows a job's state on its card; set by the approval cards. */
  settled:(id:string)=>Promise<void>=async()=>{};
  /** Ends a stopped job's changes that still wait for the owner; set by the controlled actions. */
  stopped:(id:string)=>Promise<void>=async()=>{};
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly turns:RuntimeTurnRepository,readonly sources:SourceRepository,readonly telegram:TelegramActionRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>,token:string){
    this.steps=new BackgroundStepRepository(this,token);
  }
  get control(){return this.access.stores.control;}
  get guards(){return this.access.guards;}
  async settings(){
    const row=(await this.control.query('SELECT * FROM background_settings WHERE singleton')).rows[0];
    return {cost_limit_usd:Number(row.cost_limit_usd),minutes_limit:row.minutes_limit,member_daily_jobs:row.member_daily_jobs,box_tools:row.box_tools as boolean,revision:row.revision};
  }
  async saveSettings(principal:Reader,input:unknown){
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['cost_limit_usd','minutes_limit','member_daily_jobs','box_tools','revision'].includes(key))||!Number.isSafeInteger(body.revision)||
      body.box_tools!==undefined&&typeof body.box_tools!=='boolean')throw new HttpError(400,'invalid_settings');
    const cost=Number(body.cost_limit_usd),minutes=Number(body.minutes_limit),daily=Number(body.member_daily_jobs);
    if(!(cost>0&&cost<=1000)||!Number.isSafeInteger(minutes)||minutes<5||minutes>1440||!Number.isSafeInteger(daily)||daily<0||daily>100)throw new HttpError(400,'invalid_settings');
    const changed=await this.control.query(`UPDATE background_settings SET cost_limit_usd=$1,minutes_limit=$2,member_daily_jobs=$3,box_tools=coalesce($5,box_tools),
      revision=revision+1,updated_at=now() WHERE singleton AND revision=$4`,[cost,minutes,daily,body.revision,body.box_tools??null]);
    if(!changed.rowCount)throw new HttpError(409,'configuration_conflict');
    return this.settings();
  }
  private async row(id:unknown){
    const row=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[managedEventId(id)])).rows[0];
    if(!row)throw new HttpError(404,'job_not_found');return row;
  }
  /** A live Telegram turn by the owner or a person allowed in the group; never a job's own step. */
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
  /** The name of the job a step belongs to, for the card of an operation that step asked for; null for anything else. */
  async stepJob(eventId:string):Promise<string|null> {
    const row=(await this.control.query('SELECT j.* FROM background_steps s JOIN background_jobs j ON j.id=s.job_id WHERE s.event_id=$1',[eventId])).rows[0];
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
        steps:row.steps,cost_usd:Number(row.cost_usd),cost_limit_usd:Number(row.cost_limit_usd),priced:jobPriced(row.rates),minutes_limit:row.minutes_limit,estimate:row.estimate,
        todo:row.todo,started_at:row.started_at,finished_at:row.finished_at,created_at:row.created_at,error_code:row.error_code,
        ...(principal.admin?{logical_profile:row.logical_profile,approver:row.approver}:{})});
    }
    return {jobs};
  }
  /** Stop a job: a proposal is withdrawn, a running job's step is cancelled and no report is sent.
   * The card's rule: the dashboard and the owner stop any job; a member only the job they asked for,
   * in its own chat, and a job of another chat stays unseen. A job's own turn stops none. */
  async stop(principal:Reader,input:unknown) {
    const body=object(input),live=principal.admin?null:await this.liveTurn(principal),row=await this.row(body.id);
    if(live?.requester) {
      if(row.scope!==live.turn.scope)throw new HttpError(404,'job_not_found');
      if(row.requester!==live.requester)throw new HttpError(403,'job_not_permitted');
    }
    if(closedStates.has(row.state))throw new HttpError(409,'job_not_running');
    const changed=await this.control.query(`UPDATE background_jobs SET cancel_requested=true,state=CASE WHEN state='proposed' THEN 'stopped' ELSE state END,
      finished_at=CASE WHEN state='proposed' THEN now() END,revision=revision+1,updated_at=now() WHERE id=$1 AND state NOT IN ('done','failed','stopped','rejected')`,[row.id]);
    if(!changed.rowCount)throw new HttpError(409,'job_not_running');
    const step=await this.latest(row.id);
    if(step&&['captured','running'].includes(step.run_state))await this.steps.stop(step.event_id);
    return {id:row.id,state:row.state==='proposed'?'stopped':'stopping'};
  }
  private async latest(id:string) {
    return (await this.control.query(`SELECT s.*,r.state AS run_state,r.error_code AS run_error,r.result_reference,r.binding AS run_binding FROM background_steps s
      JOIN managed_runs r ON r.event_id=s.event_id WHERE s.job_id=$1 ORDER BY s.step DESC,s.attempt DESC LIMIT 1`,[id])).rows[0];
  }
  /** One sealed step of a job, recorded before it runs. */
  private async addStep(row:any,step:number,attempt:number,kind:'work'|'wrap_up') {
    const operation=await new OperationRepository(this.control).record({key:'background-step:'+row.id+':'+step+':'+attempt,kind:'background_step',
      scope:row.space_id,input_hash:digest(canonical({job:row.id,step,attempt,kind}))});
    const binding=await this.guards.state(),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const owner=(await db.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0];
      await db.query(`INSERT INTO background_steps(event_id,job_id,step,attempt,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[operation.id,row.id,step,attempt,kind]);
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,owner_epoch,job_id)
        VALUES($1,'background',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [operation.id,operation,row.scope,row.space_id,row.logical_profile,'job_'+row.id.slice(0,24),binding,owner.epoch,row.id]);
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
  /** Drive one job: start it when a slot is free, run its steps one after another, and send its report. */
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
      await this.addStep(row,1,1,'work');
      await this.control.query("UPDATE background_jobs SET state='running',started_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved'",[id]);
      // A card that said the job waits for a free slot now says it runs.
      if(row.queued)await this.settled(id);
      return observation('waiting','assistant',0,Date.now()+5000,'receipt_pending');
    }
    if(row.state==='reporting')return this.report(row);
    const step=await this.latest(id);
    if(!step){await this.addStep(row,1,1,'work');return observation('waiting','assistant',0,Date.now()+5000,'receipt_pending');}
    if(['captured','running'].includes(step.run_state)) {
      if(row.cancel_requested)await this.steps.stop(step.event_id);
      return observation('waiting','assistant',row.steps,Date.now()+15000,'receipt_pending');
    }
    if(step.run_state==='done') {
      if(!step.counted)await this.count(row,step);
      const job=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
      if(job.cancel_requested)return this.finish(job,'stopped');
      if(step.kind==='wrap_up'||!step.continues) {
        await this.control.query(`UPDATE background_jobs SET state='reporting',report_reference=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='running'`,[id,step.result_reference]);
        return this.report({...job,state:'reporting',report_reference:step.result_reference});
      }
      if(bytesSpent(job))return this.finish(job,'failed','job_cost_limit');
      // At a limit, one last short step writes the report from what the job has found. Without a price only time limits it.
      const elapsed=(Date.now()-new Date(job.started_at).getTime())/60000;
      const limited=jobPriced(job.rates)&&Number(job.cost_usd)>=Number(job.cost_limit_usd)||elapsed>=job.minutes_limit;
      await this.addStep(job,step.step+1,1,limited?'wrap_up':'work');
      return observation('waiting','assistant',job.steps,Date.now()+5000,'receipt_pending');
    }
    if(row.cancel_requested)return this.finish(row,'stopped');
    if(bytesSpent(row))return this.finish(row,'failed','job_cost_limit');
    if(step.attempt<=STEP_RETRIES){await this.addStep(row,step.step,step.attempt+1,step.kind);return observation('waiting','assistant',row.steps,Date.now()+10000,'receipt_pending');}
    return this.finish(row,'failed',step.run_error??'job_step_failed');
  }
  /** Add a finished step's cost, priced at the job's frozen rates from the tokens it reported, and its to-do list to its job, once. */
  private async count(row:any,step:any) {
    const cost=stepCost(row.rates,step.tokens,step.kind==='wrap_up'?WRAP_UP_ITERATIONS:WORK_ITERATIONS),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const counted=await db.query('UPDATE background_steps SET counted=true,cost_usd=$2 WHERE event_id=$1 AND NOT counted RETURNING todo',[step.event_id,cost]);
      // A step that kept no to-do list leaves the last one in place. A job's cost never goes down.
      if(counted.rowCount)await db.query(`UPDATE background_jobs SET steps=steps+1,cost_usd=GREATEST(cost_usd,cost_usd+$2),todo=coalesce(NULLIF($3::jsonb,'[]'::jsonb),todo),revision=revision+1,updated_at=now() WHERE id=$1`,
        [row.id,cost,counted.rows[0].todo===null?null:JSON.stringify(counted.rows[0].todo)]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
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
    const part=sent.length+1,binding=await this.guards.state(),step=await this.latest(row.id);
    // The last step wrote the report in its own epoch. Only quiet epochs, a reaction or an automatic learning revision, may
    // have passed since (ADR-0201); any other change may have withdrawn what it read.
    if(!step||!await carriesForward(this.control,step.run_binding,binding))return this.finish(row,'failed','job_report_outdated');
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
  /** The workflow family: `job:` drives a job, `run:` one of its steps. */
  async operation(job:string,authority:ExecutionAuthority):Promise<Observation> {
    if(job.startsWith('run:'))return this.steps.run(managedEventId(job.slice(4)),authority);
    if(job.startsWith('job:'))return this.tick(managedEventId(job.slice(4)),authority);
    return observation('failed','admission');
  }
  /** The step message: the instruction for the first step, then continue, then the report at a limit. */
  async stepText(row:any,step:any,box=false):Promise<string> {
    const prompts=await ownerPrompts(this.control),text=await this.stepInstruction(row,step,prompts);
    // A step in the sealed box also says what the box holds, each time, since the box can be new.
    return box?text+'\n\n'+(prompts['background.box']??backgroundBox):text;
  }
  private async stepInstruction(row:any,step:any,prompts:Awaited<ReturnType<typeof ownerPrompts>>):Promise<string> {
    const shown=await this.proposal(row),estimate=row.estimate;
    const owner=this.access.policy().owner_id,period=estimate.from||estimate.to?[estimate.from??'the start',estimate.to??'now'].join(' to '):'the whole chat';
    if(step.kind==='wrap_up') {
      const elapsed=(Date.now()-new Date(row.started_at).getTime())/60000;
      return fillTemplate(prompts['background.wrap_up']??backgroundWrapUp,{title:shown.title,
        limit:elapsed>=row.minutes_limit||!jobPriced(row.rates)?row.minutes_limit+' minutes':money(Number(row.cost_limit_usd))});
    }
    if(step.step>1)return fillTemplate(prompts['background.continue']??backgroundContinue,{title:shown.title});
    return fillTemplate(prompts['background.job']??backgroundJob,{title:shown.title,instruction:shown.instruction,
      chat:row.target===owner?'your private chat with the owner (chat '+row.target+')':'chat '+row.target,period,size:sizeLine(estimate),
      // Without a price only the time limit applies, so the job is not told of a dollar limit.
      limits:jobPriced(row.rates)?money(Number(row.cost_limit_usd))+' or '+row.minutes_limit+' minutes, whichever comes first':row.minutes_limit+' minutes'});
  }
  /** A step may run only while its job runs and the person who asked may still use Nocheh there. */
  async allowed(row:any) {
    const job=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[row.job_id])).rows[0];
    if(!job||job.state!=='running'||job.cancel_requested||job.logical_profile!==row.logical_profile||job.space_id!==row.space_id)throw new HttpError(409,'job_not_running');
    const policy=this.access.policy(),access=policy.group_access?.[job.scope];
    if(job.requester&&(!access?.granted.includes(job.requester)||access.denied.includes(job.requester)))throw new HttpError(403,'job_not_permitted');
    return job;
  }
}

/** Each step of a job is a managed run: claimed, leased, cancellable, and recorded before its result counts. */
export class BackgroundStepRepository extends ManagedExecutionRepository {
  protected readonly channel='background' as const;
  protected readonly family='background' as const;
  protected override get resultKind(){return 'background_result';}
  protected override get protocol(){return 'managed-background-v1';}
  // A step may take minutes, so its credential outlives the longest step.
  protected override readonly credentialMillis=900000;
  constructor(readonly jobs:BackgroundJobRepository,token:string){super(jobs.access,jobs.derived,jobs.turns,token,jobs.call);}
  private async step(id:string){
    const step=(await this.control.query('SELECT * FROM background_steps WHERE event_id=$1',[id])).rows[0];
    if(!step)throw new HttpError(404,'captured_run_not_found');return step;
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
  protected override async contextDetails(row:any){
    const step=await this.step(row.event_id);
    return {background:{job_id:row.job_id,step:step.step,kind:step.kind,max_iterations:step.kind==='wrap_up'?WRAP_UP_ITERATIONS:WORK_ITERATIONS,box:await this.box(row)}};
  }
  /** Whether a step runs in its job's sealed box: the same rule that puts the box in its binding (job-box.ts). */
  private async box(row:any):Promise<boolean> {
    const owner=this.access.policy().owner_id;
    return !!await boxJob(this.control,owner,row.source_reference,{owner:row.scope===owner,job:row.job_id,logical_profile:row.logical_profile},await this.guards.state());
  }
  protected async build(row:any){
    await this.current(row);const principal=this.principal(row),job=await this.jobs.allowed(row),step=await this.step(row.event_id);
    await this.turns.register(principal,{logical_profile:row.logical_profile,job:row.job_id});
    const input:ManagedInput={principal,text:await this.jobs.stepText(job,step,await this.box(row)),transcripts:[],files:[],source_key:'nocheh:operation:'+row.event_id};
    await this.turns.prepared.allow(principal,input);
    const reference=await this.derived.record({operation_id:'background-input:'+row.event_id,source:row.source_reference,parents:[job.proposal_reference],
      kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:this.protocol,
      configuration:{binding:row.binding,profile:row.logical_profile,job_id:row.job_id},provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
  /** A step's result also says whether the job goes on, its to-do list and the tokens it used, which the job prices.
   * Counts that are missing or not plain whole numbers are kept as none, which is priced high. */
  override async finish(input:unknown){
    const body=object(input),row=await this.row(managedEventId(body.event_id));
    if(!row?.actor||row.actor!==body.actor)throw new HttpError(403,'run_actor_mismatch');
    const todo=Array.isArray(body.todo)?body.todo.slice(0,50).map(item=>{const value=object(item);
      return {content:string(value.content??'',200),status:string(value.status??'',20)};}):[];
    await this.control.query('UPDATE background_steps SET continues=$2,todo=$3,tokens=$4 WHERE event_id=$1 AND NOT counted',
      [row.event_id,body.continue===true,JSON.stringify(todo),stepTokens(body.tokens)]);
    const {continue:_continue,todo:_todo,tokens:_tokens,...result}=body;
    return super.finish(result);
  }
  async stop(id:string){return this.cancelRow(id);}
  /** Whether a step's turn may go on: its run and job still run, for the same chat and profile. */
  async deliveryAllowed(principal:Reader):Promise<boolean> {
    const row=principal.turnEvent?await this.row(principal.turnEvent):null;
    if(!row||row.state!=='running'||row.cancel_requested||row.space_id!==principal.space||row.logical_profile!==principal.logical_profile||
      (row.scope===this.access.policy().owner_id?null:row.scope)!==principal.scope)return false;
    try{await this.current(row);return true;}catch(error){if(error instanceof HttpError&&error.status<500)return false;throw error;}
  }
}
