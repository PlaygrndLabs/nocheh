import {randomBytes} from 'node:crypto';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {backgroundBox,backgroundCard,backgroundJob,backgroundLimit,backgroundMachine,backgroundRepo,backgroundRestart,backgroundResume,backgroundTexts,fillTemplate,labeledLines,lineKept,ownerPrompts} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';
import type {Brain} from '../brain/brain.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import {pageDate} from '../conversation-page.js';
import type {SourceAccessRepository} from './access.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import {afterPending,carriesForward,type GuardBinding} from './guards.js';
import {notionJobReads} from './notion.js';
import {OperationRepository} from './operations.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {SourceRepository} from './retrieval.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {RuntimeTurnRepository} from './turns.js';
import {ManagedExecutionRepository,managedEventId,type ManagedInput} from './managed-execution.js';
import {machineJob,machinePin,machineReady,machineTokenSet,type MachinePin} from './machines.js';
import {followUpTurn} from './owner-autonomy.js';
import {ProjectRepository} from './projects.js';

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
-- How many runs a job has had (ADR-0207); a table made before it had steps instead.
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3);
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
-- The GitHub copies a box job may read (ADR-0209): one row a repository, made from Settings › Connections only. A row's
-- copy_id is random and never comes back once the row is removed, so a later copy of the same name is a new copy.
CREATE TABLE IF NOT EXISTS github_copies (
 copy_id text PRIMARY KEY CHECK(copy_id ~ '^[a-f0-9]{32}$'),
 repo text NOT NULL CHECK(repo ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'),
 branch text NOT NULL CHECK(length(branch) BETWEEN 1 AND 255),
 commit_id text NOT NULL CHECK(commit_id ~ '^[a-f0-9]{40}$'),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),
 need integer NOT NULL CHECK(need BETWEEN 1 AND 268435456),
 files integer NOT NULL CHECK(files BETWEEN 0 AND 50000),
 previous_digest text CHECK(previous_digest ~ '^[a-f0-9]{64}$'),
 copied_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS github_copies_repo ON github_copies(lower(repo));
-- Each name's latest Remove, numbered in order. A new copy sends the number it read before it asked GitHub, so a Remove
-- of that name after it refuses the copy, also a Remove that found no row (ADR-0209).
CREATE TABLE IF NOT EXISTS github_removals (repo text PRIMARY KEY CHECK(repo=lower(repo)),removal integer NOT NULL CHECK(removal>0));
-- The GitHub copy a box job reads, pinned when it is asked (ADR-0209).
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS repo jsonb CHECK(repo IS NULL OR box);
-- Whether the job may read the owner's Notion without asking: what its card offered when it was asked, narrowed by the
-- owner's setting when it was approved, so it never says more than the card did (ADR-0225).
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS notion_reads boolean NOT NULL DEFAULT false;
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
// A job card with the longest line a decided card adds stays below Telegram's 4,096 UTF-16 units, so it can always be sent and settled.
const CARD_LIMIT=3800;
// The lines a decided card adds under its text (settleJob).
const outcomes=['running','running_elsewhere','queued','done','limited','stopped','stopping','failed','rejected','repo_removed','machine_off'];
/** A machine job's plan as its card and run show it: one numbered line a step. */
const numbered=(steps:string[])=>steps.map((step,index)=>`${index+1}. ${step}`).join('\n');
export const closedStates=new Set(['done','failed','stopped','rejected']);
// A GitHub copy a job's box may hold (ADR-0209). Same numbers and patterns as github.py, repo_fetch.py,
// box_repo.py and security_launcher.py; a parity test reads them.
export const MAX_REPOS=10,MAX_BUNDLE=67108864,MAX_FILES=50000,REPO_ROOM=268435456;
const REPO_NAME=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,COMMIT=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/,COPY_ID=/^[a-f0-9]{32}$/;
export const repoName=(v:unknown):v is string=>typeof v==='string'&&REPO_NAME.test(v)&&!['.','..'].includes(v.split('/')[1]!)&&!v.endsWith('.git');
export const repoBranch=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._\/-]{1,255}$/.test(v)&&!/\.\.|\/\/|^[-\/.]|[\/.]$|\.lock$/.test(v);
const matches=(pattern:RegExp,v:unknown):v is string=>typeof v==='string'&&pattern.test(v);

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
/** A machine job's plan as the owner approves it: 1 to 12 steps of 1 to 200 characters each, on one line each. */
export function planSteps(value:unknown):string[] {
  if(!Array.isArray(value)||value.length<1||value.length>12)throw new HttpError(400,'invalid_job_request');
  return value.map(step=>{
    const text=typeof step==='string'?step.replace(/\s+/g,' ').trim().replace(unstorable,'\ufffd'):'';
    if(!text||text.length>200)throw new HttpError(400,'invalid_job_request');return text;
  });
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
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null},notion=false):Promise<boolean> {
  if(!owner||!turn.owner||!turn.job||source.store!=='control')return false;
  // `notion` also asks that the job was approved with Notion reads on its card (ADR-0225).
  return !!(await db.query(`SELECT 1 FROM background_runs s JOIN background_jobs j ON j.id=s.job_id
    WHERE s.event_id=$1 AND j.id=$2 AND j.state='running' AND NOT j.cancel_requested AND j.scope=$3 AND j.requester IS NULL
      AND j.decided_by=$3 AND j.logical_profile=$4${notion?' AND j.notion_reads':''} FOR SHARE OF j`,[source.id,turn.job,owner,turn.logical_profile??null])).rowCount;
}

/** SQL over a job row `j`: whether its box time has not passed yet. A box lasts until 5 minutes after the job's hard
 *  deadline (`jobDeadlines`): its time limit and 8 minutes more. */
export const boxOpen=`now()<j.started_at+(j.minutes_limit+8)*interval '1 minute'`;
/** When a job's sealed box must be gone. */
export const boxExpires=(job:{started_at:Date;minutes_limit:number})=>new Date(jobDeadlines(job).box).toISOString();
/** The GitHub copy a box job reads, pinned from its github_copies row when the job is asked (ADR-0209). Every run of the
 *  job reads this pin, never the row, so a later Copy again changes nothing for it. */
export type PinnedRepo={copy_id:string;name:string;branch:string;commit:string;digest:string;bytes:number;need:number;files:number;copied_at:string};
// copied_at is a string: canonical() would turn a Date into {}.
export const pinnedRepo=(row:any):PinnedRepo=>({copy_id:String(row.copy_id),name:String(row.repo),branch:String(row.branch),commit:String(row.commit_id),
  digest:String(row.digest),bytes:Number(row.bytes),need:Number(row.need),files:Number(row.files),copied_at:new Date(row.copied_at).toISOString()});
/** SQL over a job row `j`: whether the copy it pinned still exists. Remove and Disconnect delete the row for good. */
export const repoKept="(j.repo IS NULL OR EXISTS (SELECT 1 FROM github_copies c WHERE c.copy_id=j.repo->>'copy_id'))";

/** A run's job when the run runs in the job's sealed box: a run of a job that asked for the box and whose box time
 *  has not passed, that `ownerApprovedJob` lets through, while the owner's box switch and the guard are on, and whose
 *  GitHub copy, if it pinned one, was not removed. Null otherwise. */
export async function boxJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{owner?:boolean;job?:string|null;logical_profile?:string|null},guard:GuardBinding):Promise<any|null> {
  if(!turn.job||guard.mode!=='on'||source.store!=='control')return null;
  const job=(await db.query(`SELECT j.* FROM background_jobs j JOIN background_runs t ON t.job_id=j.id AND t.event_id=$2
    JOIN background_settings s ON s.singleton AND s.box_tools WHERE j.id=$1 AND j.box AND ${boxOpen} AND ${repoKept}`,[turn.job,source.id])).rows[0];
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
    readonly call:RuntimeCall,readonly brain:Brain,readonly detect:(text:string)=>Promise<unknown>,token:string){
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
  /** The machine an owner's job may work on, pinned from its row (ADR-0231): only for the owner's own live message, never a
   *  follow-up, in their private chat or the group of an active project, never with the box, while machine control is on and
   *  set up; and only a machine that is ready: on, with a trusted host key, and its last test passed. */
  private async machineFor(principal:Reader,space:string,requester:string|null,box:boolean,name:string):Promise<MachinePin> {
    const project=async()=>(await new ProjectRepository(this.control).effective(space)).project?.state==='active';
    if(requester!==null||box||!machineTokenSet()||await followUpTurn(this.control,principal)||principal.scope!==null&&!await project()||
      !(await this.control.query('SELECT 1 FROM machine_settings WHERE singleton AND enabled')).rowCount)throw new HttpError(409,'job_machine_not_allowed');
    const row=(await this.control.query(`SELECT * FROM machines WHERE lower(name)=lower($1) AND ${machineReady}`,[name])).rows[0];
    if(!row)throw new HttpError(409,'job_machine_not_found');
    return machinePin(row);
  }
  /** Refuse a job whose card, with the longest line a decided card adds, would not fit Telegram: it could never be approved. */
  private async cardFits(row:any,shown:{title:string;instruction:string}):Promise<void> {
    const {text,lines}=await this.cardText(row,shown);
    if(text.length+2+Math.max(...outcomes.map(name=>(lines[name]??'').length))>CARD_LIMIT)throw new HttpError(409,'job_card_too_long');
  }
  /** Ask to start a job: count and price what it reads, then record the proposal its card shows.
   * Nothing runs until whoever approves it presses Approve. */
  async start(principal:Reader,input:unknown) {
    // A private answer only reads and talks (ADR-0249).
    if(principal.answer!==undefined)throw new HttpError(403,'private_answer_read_only');
    const body=object(input);if(Object.keys(body).some(key=>!['title','instruction','chat','from','to','box','repo','machine','steps'].includes(key))||
      body.box!==undefined&&typeof body.box!=='boolean'||body.repo!==undefined&&(typeof body.repo!=='string'||!body.repo||body.repo.length>140)||
      body.machine!==undefined&&(typeof body.machine!=='string'||!body.machine.trim()||body.machine.length>40)||(body.machine===undefined)!==(body.steps===undefined))
      throw new HttpError(400,'invalid_job_request');
    const title=string(body.title,100).replace(/\s+/g,' ').trim(),instruction=string(body.instruction,8000).trim(),steps=body.steps===undefined?null:planSteps(body.steps);
    if(!title||!instruction)throw new HttpError(400,'invalid_job_request');
    const {turn,binding,source,requester}=await this.liveTurn(principal),{from,to}=this.period(body);
    const owner=this.access.policy().owner_id!,space=principal.space!,scope=space.split('/topic/')[0]===owner?owner:turn.scope,box=body.box===true;
    // A machine only for the owner's own request, in their private chat or an active project's group; refused before anything is spent.
    const machine=body.machine===undefined?null:await this.machineFor(principal,space,requester,box,(body.machine as string).trim());
    const size=await this.sources.size(principal,{chat:body.chat===undefined?'':string(body.chat,64),from,to}),settings=await this.settings();
    // Only the owner's own job, asked in their private chat, gets the sealed box, and only while the box switch is on.
    if(box&&(!privateJob({scope,requester},owner)||!settings.box_tools))throw new HttpError(409,'job_box_not_allowed');
    // A GitHub copy only in the box, and only one the owner copied: refused before anything is spent.
    const pin=body.repo===undefined?null:box&&repoName(body.repo)?(await this.control.query('SELECT * FROM github_copies WHERE lower(repo)=lower($1)',[body.repo])).rows[0]??null:null;
    if(body.repo!==undefined&&!pin)throw new HttpError(409,'job_repo_not_allowed');
    const repo=pin?pinnedRepo(pin):null;
    // Whether the card offers Notion reads, kept with the job so its card and its runs never say more (ADR-0225).
    // Not part of the fingerprint: it only narrows, and a setting saved meanwhile must not turn a repeat into job_changed.
    const notion=privateJob({scope,requester},owner)&&await notionJobReads(this.control);
    if(requester) {
      const today=Number((await this.control.query(`SELECT count(*) FROM background_jobs WHERE scope=$1 AND requester=$2
        AND state<>'rejected' AND created_at>date_trunc('day',now())`,[turn.scope,requester])).rows[0].count);
      if(today>=settings.member_daily_jobs)throw new HttpError(409,'job_limit_reached');
    }
    const estimate=await this.estimate(size);
    // A member's job over the owner's limit, or on a model whose cost cannot be measured, waits for the owner instead. A machine
    // job's card always goes to the owner's private chat, wherever it was asked.
    const priced=jobPriced(estimate.rates),approver=machine||requester&&(!priced||(estimate.cost_usd??0)>settings.cost_limit_usd)?'owner':'requester';
    const costLimit=Math.max(settings.cost_limit_usd,Math.ceil((estimate.cost_usd??0)*1.5)),minutesLimit=Math.max(settings.minutes_limit,Math.ceil(estimate.minutes*1.5));
    const bytes=byteBudget(costLimit,estimate.rates);
    // Refused before the secret check spends anything: the agent narrows the period or splits the work.
    if(minutesLimit>JOB_MINUTES)throw new HttpError(409,'job_too_long');
    // A card Telegram would refuse could never be approved: refused before the secret check, and again with the checked text.
    const cardRow={estimate:{...estimate,from:from||null,to:to||null},rates:estimate.rates,cost_limit_usd:costLimit,minutes_limit:minutesLimit,notion_reads:notion,box,repo,requester,machine,steps};
    await this.cardFits(cardRow,{title,instruction});
    const id=digest(canonical([protocol,source,binding,title,instruction,size.chat,from,to]));
    // A machine job's plan is checked for secrets with its title and instruction; another plan for the same request is
    // another proposal, which the fingerprint then refuses as a changed job.
    const proposal=await this.derived.record({operation_id:'background-proposal:'+id+(steps?':'+digest(canonical(steps)):''),source,kind:'background_job_request',
      content:Buffer.from(canonical(steps?{title,instruction,steps}:{title,instruction})),producer:'nocheh',producer_version:protocol,configuration:{binding,chat:size.chat,from,to}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),shown=object(JSON.parse(String((representation.value as any).text)));
    const plan=steps&&Array.isArray(shown.steps)?shown.steps.map(step=>String(step)):steps;
    await this.cardFits({...cardRow,steps:plan},{title:String(shown.title),instruction:String(shown.instruction)});
    // The pinned copy and machine and the plan are part of what is approved; a job without them keeps the fingerprint it had before them.
    const fingerprint=digest(canonical({proposal:shown,chat:size.chat,from,to,estimate,cost_limit:costLimit,minutes_limit:minutesLimit,approver,box,byte_budget:bytes,
      ...(repo?{repo}:{}),...(machine?{machine,steps:plan}:{})}));
    const insert=(db:Pick<pg.PoolClient,'query'>)=>db.query(`INSERT INTO background_jobs(id,source_reference,proposal_reference,guard_revision,binding,scope,space_id,target,logical_profile,requester,approver,
      fingerprint,estimate,cost_limit_usd,minutes_limit,box,rates,byte_budget,repo,notion_reads,machine,steps) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT DO NOTHING`,
      [id,source,proposal,representation.revision,binding,scope,space,size.chat,'job-'+id.slice(0,24),requester,approver,fingerprint,
        {...estimate,from:from||null,to:to||null},costLimit,minutesLimit,box,estimate.rates,bytes,repo,notion,machine,plan===null?null:JSON.stringify(plan)]);
    if(!repo&&!machine)await insert(this.control);
    else {
      // The copy or machine row is locked before the job row exists, the order Remove takes them in: Remove waits for this
      // short transaction and then withdraws the new job, or removed the copy first and nothing is recorded. The machine
      // switch is taken first, as turning it off takes it.
      const db=await this.control.connect();
      try {
        await db.query('BEGIN');
        if(repo&&!(await db.query('SELECT 1 FROM github_copies WHERE copy_id=$1 FOR SHARE',[repo.copy_id])).rowCount)throw new HttpError(409,'job_repo_not_allowed');
        if(machine&&!(await db.query('SELECT 1 FROM machine_settings WHERE singleton AND enabled FOR SHARE')).rowCount)throw new HttpError(409,'job_machine_not_allowed');
        if(machine&&!(await db.query(`SELECT 1 FROM machines WHERE id=$1 AND ${machineReady} AND address=$2 AND port=$3 AND login=$4 AND host_key=$5 FOR SHARE`,
          [machine.id,machine.address,machine.port,machine.login,machine.host_key])).rowCount)throw new HttpError(409,'job_machine_not_found');
        await insert(db);await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    }
    const row=await this.row(id);
    if(row.fingerprint!==fingerprint)throw new HttpError(409,'job_changed');
    return {id,state:row.state,approver:row.approver,fingerprint,estimate:row.estimate,limits:{cost_usd:jobPriced(row.rates)?Number(row.cost_limit_usd):null,minutes:row.minutes_limit},box:row.box as boolean,
      repo:row.repo?{name:row.repo.name,branch:row.repo.branch,commit:row.repo.commit,copied_at:row.repo.copied_at}:null,
      // A machine job asked in a group shows its machine and plan only on the owner's private card (ADR-0244).
      ...(row.machine&&row.scope===owner?{machine:{name:row.machine.name},steps:row.steps}:{}),
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
    const row=await this.row(id),{text,lines}=await this.cardText(row,await this.proposal(row));
    const waiting=row.state==='approved'&&Number((await this.control.query("SELECT count(*) FROM background_jobs WHERE state IN ('running','reporting')")).rows[0].count)>=RUNNING_JOBS;
    return {row,text,fingerprint:row.fingerprint,state:row.state,waiting,lines};
  }
  /** A card's text from a job's values and the exact proposal it shows; also for a job not yet recorded. */
  private async cardText(row:any,shown:{title:string;instruction:string}) {
    const prompts=await ownerPrompts(this.control),estimate=row.estimate;
    const lines=labeledLines(backgroundTexts,prompts['background.texts']);
    const period=estimate.from||estimate.to?[estimate.from??'…',estimate.to??'…'].join(' – '):null;
    const values:Record<string,string|null|undefined>={title:shown.title,instruction:shown.instruction,
      size:[sizeLine(estimate),period].filter(Boolean).join(', '),minutes:String(estimate.minutes),cost:estimate.cost_usd===null?'cost unknown':'about '+money(estimate.cost_usd),
      // Without a price only the time limit applies, and the card says so instead of a cost limit.
      cost_limit:jobPriced(row.rates)?money(Number(row.cost_limit_usd)):null,unpriced:jobPriced(row.rates)?null:lines.unpriced,minutes_limit:String(row.minutes_limit),origin:null,
      notion:row.notion_reads?lines.notion_reads:null,box:row.box?(row.repo?lines.box_repo:lines.box):null,
      // From the job's own pin, so a card settled after Remove still shows what was asked.
      repo:row.repo?fillTemplate(lines.repo!,{repo_name:row.repo.name,repo_branch:row.repo.branch,repo_commit:row.repo.commit.slice(0,7),
        repo_copied:row.repo.copied_at.slice(0,16).replace('T',' ')+' UTC',repo_size:Math.ceil(row.repo.bytes/1e6)+' MB, '+count(row.repo.files,'file','files')}):null,
      // From the job's own pin too, and the plan exactly as approved.
      machine:row.machine?fillTemplate(lines.machine!,{machine_name:row.machine.name,machine_login:row.machine.login,machine_address:row.machine.address}):null,
      steps:row.steps?.length?lines.steps+'\n'+numbered(row.steps):null,
      checked:[lines.checked,row.requester?lines.member_limit:null].filter(Boolean).join(' ')||null};
    // What the job may do without asking is always on its card: a saved card without the line, or whose line
    // is left out for another missing value, gets it at the end.
    const template=prompts['background.card']??backgroundCard,kept=template.split('\n').filter(line=>lineKept(line,values));
    // A forced cost line carries the time limit too, when a saved card left it out with the cost limit's line.
    const missing=[['unpriced','🛑'],['notion','📒'],['box','🧰'],['repo','📦'],['machine','🖥'],['steps','📋']].filter(([name])=>values[name!]&&!kept.some(line=>line.includes('{'+name+'}'))).map(([name,icon])=>icon+' {'+name+'}'+
      (name==='unpriced'&&!kept.some(line=>line.includes('{minutes_limit}'))?' ({minutes_limit} min)':''));
    return {text:fillTemplate(missing.length?template+'\n\n'+missing.join('\n'):template,values),lines};
  }
  /** The decision on a card, by the owner or, on their own job's card in its chat, the person who asked. */
  async decide(by:string,input:unknown,source:SourceReference) {
    const body=object(input),row=await this.row(body.id);
    if(body.fingerprint!==row.fingerprint)throw new HttpError(409,'job_changed');
    await this.access.archive.verify(source);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      // The copy row first, as Remove takes it: a removed copy approves nothing, and a Remove that comes after this
      // waits and then stops the approved job.
      if(body.decision==='approve'&&row.repo&&!(await db.query('SELECT 1 FROM github_copies WHERE copy_id=$1 FOR SHARE',[row.repo.copy_id])).rowCount)throw new HttpError(409,'job_changed');
      const current=(await db.query('SELECT * FROM background_jobs WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(current.state!=='proposed'||current.created_at<new Date(Date.now()-DECISION_HOURS*3600000))throw new HttpError(409,'job_already_decided');
      const approve=body.decision==='approve';
      // Approve keeps the Notion reads its card offered only while the setting still allows them, so a job never gets more
      // than its card said; Reject leaves the line its card showed (ADR-0225).
      const reads=approve&&!!current.notion_reads&&await notionJobReads(db);
      await db.query(`UPDATE background_jobs SET state=$2,decision_reference=$3,decided_by=$4,finished_at=CASE WHEN $2='rejected' THEN now() END,
        notion_reads=CASE WHEN $2='approved' THEN $5::boolean ELSE notion_reads END,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,approve?'approved':'rejected',source,by,reads]);
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
  /** Jobs this chat can see: its own, or every job for the owner. A live turn in the owner's private chat also sees the
   *  GitHub copies a box job may read, while the box switch is on, and the machines a job may work on, while machine control
   *  is on. A group never sees a machine job's machine, plan or to-do list: those are in the owner's private chat. */
  async list(principal:Reader) {
    let rows,repos:{name:string;branch:string;commit:string;copied_at:string}[]|undefined,machines:{name:string;ready:boolean}[]|undefined;
    if(principal.admin)rows=(await this.control.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT 50')).rows;
    else {
      const turn=await this.turns.binding(principal);
      if(turn.owner&&!turn.job&&principal.scope===null&&(principal.purpose??'assistant')==='assistant'&&(await this.settings()).box_tools)
        // copied_at as ISO text, as in the pin: a turn's answer is rebuilt from its texts for the secret check, so a Date would become {}.
        repos=(await this.control.query('SELECT repo AS name,branch,left(commit_id,12) AS commit,copied_at FROM github_copies ORDER BY lower(repo)')).rows
          .map(row=>({...row,copied_at:new Date(row.copied_at).toISOString()}));
      if(await this.machinesShown(principal))machines=(await this.control.query(`SELECT name,${machineReady} AS ready FROM machines ORDER BY lower(name)`)).rows;
      rows=principal.scope===null?(await this.control.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT 20')).rows:
        (await this.control.query('SELECT * FROM background_jobs WHERE scope=$1 ORDER BY created_at DESC LIMIT 20',[principal.scope])).rows;
    }
    const jobs=[];
    for(const row of rows) {
      let title:string|null=null;try{title=(await this.proposal(row)).title;}catch(error){if(!(error instanceof HttpError))throw error;}
      const hidden=!!row.machine&&!principal.admin&&principal.scope!==null;
      jobs.push({id:row.id,title,state:row.cancel_requested&&!closedStates.has(row.state)?'stopping':row.state,chat:row.target,asked_in:row.space_id,
        attempts:row.attempts,ended:row.ended,cost_usd:Number(row.cost_usd),cost_limit_usd:Number(row.cost_limit_usd),priced:jobPriced(row.rates),minutes_limit:row.minutes_limit,estimate:row.estimate,
        todo:hidden?null:row.todo,started_at:row.started_at,finished_at:row.finished_at,created_at:row.created_at,error_code:row.error_code,
        machine:row.machine&&!hidden?{name:row.machine.name}:null,steps:hidden?null:row.steps??null,
        ...(hidden?{private:'A job on the owner\'s machine. Its plan and report are in the owner\'s private chat.'}:{}),
        ...(principal.admin?{logical_profile:row.logical_profile,approver:row.approver,machine_cleanup:row.machine_cleanup??null}:{})});
    }
    return {jobs,...(repos?{repos}:{}),...(machines?{machines}:{})};
  }
  /** Whether a turn may see the machines: the owner's own live message, not a job's run or a follow-up, in their private chat,
   *  while machine control is on and set up. A group never sees them, the owner's own message there included (ADR-0244): the
   *  owner names the machine there. */
  private async machinesShown(principal:Reader):Promise<boolean> {
    if(principal.scope!==null||!machineTokenSet()||!(await this.control.query('SELECT 1 FROM machine_settings WHERE singleton AND enabled')).rowCount)return false;
    try{if((await this.liveTurn(principal)).requester!==null)return false;}catch(error){if(error instanceof HttpError)return false;throw error;}
    return !await followUpTurn(this.control,principal);
  }
  /** The GitHub copies a box job may read, and the digests jobs still pin: an approved job, a running job within its box
   *  time and a proposal still waiting for its decision, none stopped and none whose copy was removed. github.py keeps
   *  every bundle these name and deletes the rest. Only management, with the service token, reaches this (owner-api.ts). */
  async copies(principal:Reader) {
    admin(principal);
    // Read first: a Remove that commits while the rows are read then still counts as after it.
    const removal=Number((await this.control.query('SELECT COALESCE(max(removal),0) AS removal FROM github_removals')).rows[0].removal);
    const copies=(await this.control.query(`SELECT copy_id,repo,branch,commit_id AS commit,digest,bytes,need,files,previous_digest,copied_at
      FROM github_copies ORDER BY lower(repo)`)).rows;
    const pinned=(await this.control.query(`SELECT DISTINCT j.repo->>'digest' AS digest FROM background_jobs j JOIN github_copies c ON c.copy_id=j.repo->>'copy_id'
      WHERE NOT j.cancel_requested AND (j.state='approved' OR (j.state='running' AND ${boxOpen})
        OR (j.state='proposed' AND j.created_at>now()-${DECISION_HOURS}*interval '1 hour'))`)).rows.map(row=>row.digest as string);
    return {copies,pinned,removal};
  }
  /** Save a finished copy, or remove copies. A set names the copy_id it started from: null makes a new copy with a new id,
   *  an id updates that same copy, and anything removed or replaced meanwhile refuses. A new copy also names the last
   *  removal it read, and a Remove of its name since then refuses it. A set past its not_after refuses
   *  too, so a copy github.py gave up on can never outlive a later Disconnect. A Remove or Disconnect withdraws every job
   *  that pinned the copy and has not started, in the same transaction; a running one loses its box (repoKept). */
  async changeCopies(principal:Reader,input:unknown) {
    admin(principal);
    const body=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{},keys=Object.keys(body);
    const invalid=new HttpError(400,'invalid_github_copy'),within=(value:unknown,low:number,high:number)=>Number.isSafeInteger(value)&&(value as number)>=low&&(value as number)<=high;
    if(keys.length===1&&keys[0]==='set') {
      const set=body.set&&typeof body.set==='object'&&!Array.isArray(body.set)?body.set as Record<string,unknown>:null;
      const fields=['repo','branch','commit','digest','bytes','need','files','copy_id','removal','not_after'];
      if(!set||Object.keys(set).length!==fields.length||!fields.every(key=>key in set)||!repoName(set.repo)||!repoBranch(set.branch)||!matches(COMMIT,set.commit)||
        !matches(DIGEST,set.digest)||!within(set.bytes,1,MAX_BUNDLE)||!within(set.need,1,REPO_ROOM)||!within(set.files,0,MAX_FILES)||
        set.copy_id!==null&&!matches(COPY_ID,set.copy_id)||!within(set.removal,0,2147483647)||!within(set.not_after,1,Math.floor(Date.now()/1000)+60))throw invalid;
      const values=[set.repo,set.branch,set.commit,set.digest,set.bytes,set.need,set.files],db=await this.control.connect();
      try {
        await db.query('BEGIN');
        let saved;
        if(set.copy_id===null) {
          // New copies and Removes take turns, so the limit holds and a new copy sees every Remove before it.
          await db.query('SELECT pg_advisory_xact_lock(803362)');
          if((await db.query('SELECT 1 FROM github_copies WHERE lower(repo)=lower($1)',[set.repo])).rowCount)throw new HttpError(409,'github_copy_cancelled');
          // Removed after the copy began: the owner's Remove is final, also when a Copy again of a missing copy had
          // already removed the row itself.
          if((await db.query('SELECT 1 FROM github_removals WHERE repo=lower($1) AND removal>$2',[set.repo,set.removal])).rowCount)
            throw new HttpError(409,'github_copy_cancelled');
          if(Number((await db.query('SELECT count(*) FROM github_copies')).rows[0].count)>=MAX_REPOS)throw new HttpError(409,'github_repo_limit');
          saved=await db.query(`INSERT INTO github_copies(copy_id,repo,branch,commit_id,digest,bytes,need,files) VALUES($8,$1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT ((lower(repo))) DO NOTHING`,[...values,randomBytes(16).toString('hex')]);
        } else saved=await db.query(`UPDATE github_copies SET branch=$2,commit_id=$3,digest=$4,bytes=$5,need=$6,files=$7,
            previous_digest=CASE WHEN digest<>$4 THEN digest ELSE previous_digest END,copied_at=now() WHERE copy_id=$8 AND lower(repo)=lower($1)`,[...values,set.copy_id]);
        // Checked after the write, so a set that waited on a row lock past its time is refused too.
        if(!saved.rowCount||Date.now()/1000>(set.not_after as number))throw new HttpError(409,'github_copy_cancelled');
        await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      return this.copies(principal);
    }
    const remove=keys.length===1&&keys[0]==='remove'&&repoName(body.remove);
    if(!remove&&!(keys.length===1&&body.clear===true))throw invalid;
    const db=await this.control.connect();let withdrawn:string[];
    try {
      await db.query('BEGIN');
      // A Remove is numbered even when it finds no row, so a new copy of that name still running is refused.
      if(remove) {
        await db.query('SELECT pg_advisory_xact_lock(803362)');
        await db.query(`INSERT INTO github_removals(repo,removal) SELECT lower($1),COALESCE(max(removal),0)+1 FROM github_removals
          ON CONFLICT(repo) DO UPDATE SET removal=EXCLUDED.removal`,[body.remove]);
      }
      // Copy rows first, then job rows: start and decide lock in the same order.
      const removed=(await db.query(`DELETE FROM github_copies${remove?' WHERE lower(repo)=lower($1)':''} RETURNING copy_id`,remove?[body.remove]:[])).rows.map(row=>row.copy_id);
      withdrawn=(await db.query(`UPDATE background_jobs SET state='stopped',cancel_requested=true,error_code='job_repo_removed',finished_at=now(),revision=revision+1,updated_at=now()
        WHERE state IN ('proposed','approved') AND repo->>'copy_id'=ANY($1::text[]) RETURNING id`,[removed])).rows.map(row=>row.id);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    // The cards say why, without holding up the answer.
    void Promise.all(withdrawn.map(id=>this.settled(id))).catch(()=>{});
    return this.copies(principal);
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
    // A machine job that started has what it runs on its machine ended too (machines.ts).
    const changed=await this.control.query(`UPDATE background_jobs SET cancel_requested=true,state=CASE WHEN state='proposed' THEN 'stopped' ELSE state END,
      finished_at=CASE WHEN state='proposed' THEN now() END,machine_cleanup=CASE WHEN machine IS NOT NULL AND state IN ('running','reporting') THEN coalesce(machine_cleanup,'pending')
      ELSE machine_cleanup END,revision=revision+1,updated_at=now() WHERE id=$1 AND state NOT IN ('done','failed','stopped','rejected')`,[row.id]);
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
  /** One run of a job, recorded with its managed run; the first also starts the job's clock. A relaunch keeps the last run's
   *  binding while it carries to the current one, so it has that run's physical profile and history (ADR-0208); otherwise it
   *  is bound to the current one. Nothing is added to a job that was stopped or ended meanwhile: the job row is locked first. */
  private async addRun(row:any,attempt:number):Promise<void> {
    const operation=await new OperationRepository(this.control).record({key:'background-run:'+row.id+':'+attempt,kind:'background_run',
      scope:row.space_id,input_hash:digest(canonical({job:row.id,attempt}))});
    const current=await this.guards.state(),earlier=attempt>1?(await this.latest(row.id))?.run_binding:null;
    const binding=earlier&&await carriesForward(this.control,earlier,current)?earlier:current,db=await this.control.connect();
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
    // A machine job that ran and failed or was stopped has its programs on the machine ended; one that ends well leaves them,
    // also when only its report then fails. A limit or a Stop while it reports has set its cleanup already.
    const changed=await this.control.query(`UPDATE background_jobs SET state=$2,error_code=$3,finished_at=now(),machine_cleanup=CASE WHEN machine IS NOT NULL
      AND started_at IS NOT NULL AND state<>'reporting' AND $2 IN ('failed','stopped') THEN coalesce(machine_cleanup,'pending') ELSE machine_cleanup END,revision=revision+1,updated_at=now()
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
    await this.control.query(`UPDATE background_jobs SET state='reporting',ended=$2,report_reference=$3,
      machine_cleanup=CASE WHEN machine IS NOT NULL THEN coalesce(machine_cleanup,'pending') ELSE machine_cleanup END,revision=revision+1,updated_at=now()
      WHERE id=$1 AND state='running'`,[row.id,limit,note]);
    return this.report({...row,state:'reporting',ended:limit,report_reference:note});
  }
  /** The job's audience in the current epoch, for the report it sends to the chat where it was asked, or to the owner. */
  private audience(row:any,binding:GuardBinding):Reader {
    const owner=this.access.policy().owner_id;
    return {admin:false,scope:row.scope===owner?null:row.scope,space:row.space_id,turnEvent:row.source_reference.id,
      logical_profile:row.logical_profile,generation:binding.generation,guard_epoch:binding.epoch};
  }
  /** Send the final answer to the chat where the job was asked, part after part. A job on one of the owner's machines sends
   *  its report, or its note at a limit, to the owner's private chat instead; when it was asked elsewhere, that chat then gets
   *  one fixed line with no machine, plan or report (ADR-0244). */
  private async report(row:any):Promise<Observation> {
    const result=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.report_reference?.id])).rows[0];
    if(!result||digest(result.content)!==row.report_reference.input_hash)return this.finish(row,'failed','job_report_missing');
    const parts=reportParts(String(JSON.parse(result.content.toString()).text??''));
    if(!parts.length)return this.finish(row,'failed','job_report_empty');
    const owner=this.access.policy().owner_id!,machine=!!row.machine&&row.scope!==owner;
    const sent=(await this.control.query(`SELECT b.part,a.state,a.destination FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id
      WHERE b.job_id=$1 ORDER BY b.part`,[row.id])).rows;
    // A report that began in the group before machine reports went private keeps the parts sent there; the owner then gets
    // the whole report and the group its line. One the group got whole before then is done.
    let early=0;
    if(machine)while(early<Math.min(sent.length,parts.length)&&sent[early].destination===row.space_id)early++;
    const away=machine&&early<parts.length;
    const targets=[...parts.slice(0,early).map(text=>({to:row.space_id as string,text})),...parts.slice(away?0:early).map(text=>({to:away?owner:row.space_id as string,text}))];
    if(away)targets.push({to:row.space_id,text:labeledLines(backgroundTexts,(await ownerPrompts(this.control))['background.texts'])[row.ended?'limited_private':'report_private']!});
    const last=sent.at(-1);
    // The group's line comes last: the report already reached the owner, so a lost line still ends the job done.
    if(last&&['failed','ambiguous','cancelled','rejected'].includes(last.state))return away&&sent.length===targets.length?this.finish(row,'done'):this.finish(row,'failed','job_report_not_delivered');
    if(last&&last.state!=='done')return observation('waiting','delivery',sent.length,Date.now()+5000,'receipt_pending');
    if(sent.length>=targets.length)return this.finish(row,'done');
    // Only the group's line is left: it names nothing the run read, so no later epoch holds it back, and a Stop or a
    // refused line still ends the job done.
    const line=away&&sent.length===targets.length-1;
    // A stopped job sends no further part.
    if(row.cancel_requested)return this.finish(row,line?'done':'stopped');
    // A member removed from the chat since the job ran gets nothing sent there.
    if(!sent.length&&!this.permitted(row))return this.finish(row,'failed','job_not_permitted');
    const part=sent.length+1,binding=await this.guards.state(),run=line?null:await this.latest(row.id);
    // The last run wrote the report in its own epoch. Only quiet epochs, a reaction or an automatic learning revision, may
    // have passed since (ADR-0201); any other change may have withdrawn what it read.
    if(!line&&(!run||!await carriesForward(this.control,run.run_binding,binding)))return this.finish(row,'failed','job_report_outdated');
    try {
      // Checked for secrets with the job's own audience, wherever the part goes.
      const target=targets[part-1]!,prepared=await this.telegram.prepareSystem(this.audience(row,binding),row.source_reference,binding,target.to,target.text,'background-report:'+row.id+':'+part);
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
    } catch(error) {
      // An epoch or a publication still pending while the part was checked: nothing was staged, so the next tick checks it again
      // under the binding then current, by the rule above, instead of the job's workflow closing with the job still reporting.
      if(error instanceof HttpError&&['guard_transition_pending','guard_context_changed','audience_context_changed','action_context_changed'].includes(error.code))
        return observation('waiting','delivery',sent.length,Date.now()+2000,'guard_pending');
      if(line&&error instanceof HttpError)return this.finish(row,'done');
      throw error;
    }
    return observation('waiting','delivery',part,Date.now()+5000,'receipt_pending');
  }
  /** The workflow family: `job:` drives a job, `run:` one of its runs. */
  async operation(job:string,authority:ExecutionAuthority):Promise<Observation> {
    if(job.startsWith('run:'))return this.runs.run(managedEventId(job.slice(4)),authority);
    if(job.startsWith('job:'))return this.tick(managedEventId(job.slice(4)),authority);
    return observation('failed','admission');
  }
  /** A run's message. A relaunch under the binding an earlier run of the job ran with, which it keeps while only quiet epochs
   *  passed (same physical profile, so Hermes reloads its history), gets the resume line; a relaunch after any other run gets
   *  the first message again with the restart note, whose
   *  to-do line is kept only while carriedTodo allows it. An earlier run ran only if it made a model call, after which Hermes
   *  has its first message: one that failed before (no box, a busy profile) left nothing to resume or restart. A box run also
   *  says what the box holds, every time: the box can be new; so does the GitHub copy it pinned. A run on the job's machine
   *  says which machine and the plan the owner approved, every time. */
  async runText(job:any,run:any,binding:GuardBinding,box=false,machine=false):Promise<string> {
    const prompts=await ownerPrompts(this.control),shown=await this.proposal(job);
    const ran=run.attempt>1?(await this.control.query(`SELECT r.binding FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id
      WHERE b.job_id=$1 AND b.attempt<$2 AND r.input_reference IS NOT NULL AND (b.unknown_calls>0 OR coalesce((b.tokens->>'calls')::integer,0)>0)`,
      [job.id,run.attempt])).rows:[];
    const same=ran.some(({binding:earlier})=>earlier.generation===binding.generation&&Number(earlier.epoch)===binding.epoch);
    let text=same?fillTemplate(prompts['background.resume']??backgroundResume,{title:shown.title}):await this.firstMessage(job,shown,prompts);
    if(ran.length&&!same){const todo=await this.carriedTodo(job.id,binding);
      text+='\n\n'+fillTemplate(prompts['background.restart']??backgroundRestart,{todo:todo?.length?todo.map(item=>item.content+' ('+item.status+')').join('; '):null});}
    if(machine&&job.machine)return text+'\n\n'+fillTemplate(prompts['background.machine']??backgroundMachine,{machine_name:job.machine.name,machine_login:job.machine.login,
      machine_address:job.machine.address,steps:numbered(job.steps??[])});
    return box?text+'\n\n'+(prompts['background.box']??backgroundBox)+(job.repo?'\n\n'+fillTemplate(prompts['background.repo']??backgroundRepo,{repo:job.repo.name,
      branch:job.repo.branch,commit:job.repo.commit,copied:job.repo.copied_at.slice(0,16).replace('T',' ')+' UTC'}):''):text;
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
  protected override readonly carries=true;
  constructor(readonly jobs:BackgroundJobRepository,token:string){super(jobs.access,jobs.derived,jobs.turns,token,jobs.brain);}
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
    await this.guards.assertCarried(binding);
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
    return {background:{job_id:row.job_id,attempt:run.attempt,max_iterations:JOB_ITERATIONS,box:await this.box(row),machine:await this.machine(row),
      soft_deadline:Math.floor(soft/1000),hard_deadline:Math.floor(hard/1000),rates,cost_limit_usd:jobPriced(rates)?Number(job.cost_limit_usd):null,prior_cost_usd:prior}};
  }
  /** Whether a run runs in its job's sealed box: the same rule that puts the box in its binding (job-box.ts). */
  private async box(row:any):Promise<boolean> {
    const owner=this.access.policy().owner_id;
    return !!await boxJob(this.control,owner,row.source_reference,{owner:row.scope===owner,job:row.job_id,logical_profile:row.logical_profile},await this.guards.state());
  }
  /** Whether a run works on its job's machine: the same rule that puts the machine in its binding (machines.ts). */
  private async machine(row:any):Promise<boolean> {
    return !!await machineJob(this.control,this.access.policy().owner_id,row.source_reference,{job:row.job_id,logical_profile:row.logical_profile});
  }
  protected async build(row:any){
    await this.current(row);const principal=this.principal(row),job=await this.jobs.allowed(row),run=await this.runRow(row.event_id);
    await this.turns.register(principal,{logical_profile:row.logical_profile,job:row.job_id});
    const input:ManagedInput={principal,text:await this.jobs.runText(job,run,row.binding,await this.box(row),await this.machine(row)),transcripts:[],files:[],source_key:'nocheh:operation:'+row.event_id};
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
  /** Whether a run's turn may go on: its run and job still run, for the same chat and profile, and its binding still carries.
   *  A publication still pending is waited out first, so a learning batch does not fail a run at its last check. */
  async deliveryAllowed(principal:Reader):Promise<boolean> {
    const row=principal.turnEvent?await this.row(principal.turnEvent):null;
    if(!row||row.state!=='running'||row.cancel_requested||row.space_id!==principal.space||row.logical_profile!==principal.logical_profile||
      (row.scope===this.access.policy().owner_id?null:row.scope)!==principal.scope)return false;
    try{await afterPending(true,()=>this.current(row));return true;}catch(error){if(error instanceof HttpError&&error.status<500)return false;throw error;}
  }
}
