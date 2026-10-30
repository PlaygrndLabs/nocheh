import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {backgroundCard,backgroundContinue,backgroundJob,backgroundTexts,backgroundWrapUp,fillTemplate,labeledLines,ownerPrompts} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import {pageDate} from '../conversation-page.js';
import type {SourceAccessRepository} from './access.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardBinding} from './guards.js';
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
CREATE TABLE IF NOT EXISTS background_steps (
 event_id text PRIMARY KEY,job_id text NOT NULL REFERENCES background_jobs(id),step integer NOT NULL CHECK(step>0),
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0),kind text NOT NULL CHECK(kind IN ('work','wrap_up')),
 continues boolean,todo jsonb,cost_usd numeric,counted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,step,attempt)
);
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

/** Work too big for one reply runs on its own once approved, as a chain of sealed
 * steps that continue one Hermes session of its own, and reports back to its chat. */
export class BackgroundJobRepository {
  steps:BackgroundStepRepository;
  /** Shows a job's state on its card; set by the approval cards. */
  settled:(id:string)=>Promise<void>=async()=>{};
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly turns:RuntimeTurnRepository,readonly sources:SourceRepository,readonly telegram:TelegramActionRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>,token:string){
    this.steps=new BackgroundStepRepository(this,token);
  }
  get control(){return this.access.stores.control;}
  get guards(){return this.access.guards;}
  async settings(){
    const row=(await this.control.query('SELECT * FROM background_settings WHERE singleton')).rows[0];
    return {cost_limit_usd:Number(row.cost_limit_usd),minutes_limit:row.minutes_limit,member_daily_jobs:row.member_daily_jobs,revision:row.revision};
  }
  async saveSettings(principal:Reader,input:unknown){
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['cost_limit_usd','minutes_limit','member_daily_jobs','revision'].includes(key))||!Number.isSafeInteger(body.revision))throw new HttpError(400,'invalid_settings');
    const cost=Number(body.cost_limit_usd),minutes=Number(body.minutes_limit),daily=Number(body.member_daily_jobs);
    if(!(cost>0&&cost<=1000)||!Number.isSafeInteger(minutes)||minutes<5||minutes>1440||!Number.isSafeInteger(daily)||daily<0||daily>100)throw new HttpError(400,'invalid_settings');
    const changed=await this.control.query(`UPDATE background_settings SET cost_limit_usd=$1,minutes_limit=$2,member_daily_jobs=$3,revision=revision+1,updated_at=now()
      WHERE singleton AND revision=$4`,[cost,minutes,daily,body.revision]);
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
  /** What reading the chat would take: its size, and the time and cost to read it once. */
  async estimate(size:Awaited<ReturnType<SourceRepository['size']>>) {
    const tokens=jobTokens(size);let cost:number|null=null;
    try {
      const priced=await this.call('usage.price',{rows:[{part:'reply',input_tokens:tokens.input,output_tokens:tokens.output,calls:tokens.calls}]},15000);
      const value=Array.isArray(priced.costs)?priced.costs[0]:null;if(typeof value==='number'&&Number.isFinite(value))cost=Math.round(value*100)/100;
    }catch{/* An unknown price still shows the size and time. */}
    return {...size,pages:tokens.pages,tokens:tokens.read,minutes:tokens.minutes,cost_usd:cost};
  }
  async size(principal:Reader,input:unknown) {
    const body=object(input);if(Object.keys(body).some(key=>!['chat','from','to'].includes(key)))throw new HttpError(400,'invalid_job_request');
    if(!principal.admin)await this.turns.binding(principal);
    const {from,to}=this.period(body),size=await this.sources.size(principal,{chat:body.chat===undefined?'':string(body.chat,64),from,to});
    const estimate=await this.estimate(size),settings=await this.settings();
    return {...estimate,from:from||null,to:to||null,limits:{cost_usd:settings.cost_limit_usd,minutes:settings.minutes_limit}};
  }
  /** Ask to start a job. Nothing runs until whoever approves it presses Approve. */
  async propose(principal:Reader,input:unknown) {
    const body=object(input);if(Object.keys(body).some(key=>!['title','instruction','chat','from','to'].includes(key)))throw new HttpError(400,'invalid_job_request');
    const title=string(body.title,100).replace(/\s+/g,' ').trim(),instruction=string(body.instruction,8000).trim();
    if(!title||!instruction)throw new HttpError(400,'invalid_job_request');
    const {turn,binding,source,requester}=await this.liveTurn(principal),{from,to}=this.period(body);
    const size=await this.sources.size(principal,{chat:body.chat===undefined?'':string(body.chat,64),from,to}),settings=await this.settings();
    const owner=this.access.policy().owner_id!;
    if(requester) {
      const today=Number((await this.control.query(`SELECT count(*) FROM background_jobs WHERE scope=$1 AND requester=$2
        AND state<>'rejected' AND created_at>date_trunc('day',now())`,[turn.scope,requester])).rows[0].count);
      if(today>=settings.member_daily_jobs)throw new HttpError(409,'job_limit_reached');
    }
    const estimate=await this.estimate(size);
    // A member's job over the owner's limit, or with no known cost, waits for the owner instead.
    const approver=requester&&(estimate.cost_usd===null||estimate.cost_usd>settings.cost_limit_usd)?'owner':'requester';
    const costLimit=Math.max(settings.cost_limit_usd,Math.ceil((estimate.cost_usd??0)*1.5)),minutesLimit=Math.max(settings.minutes_limit,Math.ceil(estimate.minutes*1.5));
    const id=digest(canonical([protocol,source,binding,title,instruction,size.chat,from,to]));
    const proposal=await this.derived.record({operation_id:'background-proposal:'+id,source,kind:'background_job_request',content:Buffer.from(canonical({title,instruction})),
      producer:'nocheh',producer_version:protocol,configuration:{binding,chat:size.chat,from,to}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),shown=object(JSON.parse(String((representation.value as any).text)));
    const fingerprint=digest(canonical({proposal:shown,chat:size.chat,from,to,estimate,cost_limit:costLimit,minutes_limit:minutesLimit,approver}));
    const space=principal.space!,scope=space.split('/topic/')[0]===owner?owner:turn.scope;
    await this.control.query(`INSERT INTO background_jobs(id,source_reference,proposal_reference,guard_revision,binding,scope,space_id,target,logical_profile,requester,approver,
      fingerprint,estimate,cost_limit_usd,minutes_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
      [id,source,proposal,representation.revision,binding,scope,space,size.chat,'job-'+id.slice(0,24),requester,approver,fingerprint,
        {...estimate,from:from||null,to:to||null},costLimit,minutesLimit]);
    const row=await this.row(id);
    if(row.fingerprint!==fingerprint)throw new HttpError(409,'job_changed');
    return {id,state:row.state,approver:row.approver,fingerprint,estimate:row.estimate,limits:{cost_usd:Number(row.cost_limit_usd),minutes:row.minutes_limit},
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
  /** The card a person approves: the exact instruction, what it reads and what it may cost. */
  async card(id:string) {
    const row=await this.row(id),shown=await this.proposal(row),prompts=await ownerPrompts(this.control),estimate=row.estimate;
    const period=estimate.from||estimate.to?[estimate.from??'…',estimate.to??'…'].join(' – '):null;
    const text=fillTemplate(prompts['background.card']??backgroundCard,{title:shown.title,instruction:shown.instruction,
      size:[sizeLine(estimate),period].filter(Boolean).join(', '),minutes:String(estimate.minutes),cost:estimate.cost_usd===null?'cost unknown':'about '+money(estimate.cost_usd),
      cost_limit:money(Number(row.cost_limit_usd)),minutes_limit:String(row.minutes_limit),origin:null});
    const waiting=row.state==='approved'&&Number((await this.control.query("SELECT count(*) FROM background_jobs WHERE state IN ('running','reporting')")).rows[0].count)>=RUNNING_JOBS;
    return {row,text,fingerprint:row.fingerprint,state:row.state,waiting,lines:labeledLines(backgroundTexts,prompts['background.texts'])};
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
        steps:row.steps,cost_usd:Number(row.cost_usd),cost_limit_usd:Number(row.cost_limit_usd),minutes_limit:row.minutes_limit,estimate:row.estimate,
        todo:row.todo,started_at:row.started_at,finished_at:row.finished_at,created_at:row.created_at,error_code:row.error_code,
        ...(principal.admin?{logical_profile:row.logical_profile,approver:row.approver}:{})});
    }
    return {jobs};
  }
  /** Stop a job: a proposal is withdrawn, a running job's step is cancelled and no report is sent. */
  async stop(principal:Reader,input:unknown) {
    const body=object(input),row=await this.row(body.id);
    if(!principal.admin) {
      await this.turns.binding(principal);
      if(principal.scope!==null&&row.scope!==principal.scope)throw new HttpError(404,'job_not_found');
    }
    if(closedStates.has(row.state))throw new HttpError(409,'job_not_running');
    await this.control.query(`UPDATE background_jobs SET cancel_requested=true,state=CASE WHEN state='proposed' THEN 'stopped' ELSE state END,
      finished_at=CASE WHEN state='proposed' THEN now() END,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id]);
    const step=await this.latest(row.id);
    if(step&&['captured','running'].includes(step.run_state))await this.steps.stop(step.event_id);
    return {id:row.id,state:row.state==='proposed'?'stopped':'stopping'};
  }
  private async latest(id:string) {
    return (await this.control.query(`SELECT s.*,r.state AS run_state,r.error_code AS run_error,r.result_reference FROM background_steps s
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
      // At a limit, one last short step writes the report from what the job has found.
      const elapsed=(Date.now()-new Date(job.started_at).getTime())/60000;
      const limited=Number(job.cost_usd)>=Number(job.cost_limit_usd)||elapsed>=job.minutes_limit;
      await this.addStep(job,step.step+1,1,limited?'wrap_up':'work');
      return observation('waiting','assistant',job.steps,Date.now()+5000,'receipt_pending');
    }
    if(row.cancel_requested)return this.finish(row,'stopped');
    if(step.attempt<=STEP_RETRIES){await this.addStep(row,step.step,step.attempt+1,step.kind);return observation('waiting','assistant',row.steps,Date.now()+10000,'receipt_pending');}
    return this.finish(row,'failed',step.run_error??'job_step_failed');
  }
  /** Add a finished step's cost and to-do list to its job, once. */
  private async count(row:any,step:any) {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const counted=await db.query('UPDATE background_steps SET counted=true WHERE event_id=$1 AND NOT counted RETURNING cost_usd,todo',[step.event_id]);
      // A step that kept no to-do list leaves the last one in place.
      if(counted.rowCount)await db.query(`UPDATE background_jobs SET steps=steps+1,cost_usd=cost_usd+$2,todo=coalesce(NULLIF($3::jsonb,'[]'::jsonb),todo),revision=revision+1,updated_at=now() WHERE id=$1`,
        [row.id,Number(counted.rows[0].cost_usd??0),counted.rows[0].todo===null?null:JSON.stringify(counted.rows[0].todo)]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** The job's audience, for the report it sends to the chat where it was asked. */
  private audience(row:any):Reader {
    const owner=this.access.policy().owner_id;
    return {admin:false,scope:row.scope===owner?null:row.scope,space:row.space_id,turnEvent:row.source_reference.id,
      logical_profile:row.logical_profile,generation:row.binding.generation,guard_epoch:Number(row.binding.epoch)};
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
    const part=sent.length+1,binding=await this.guards.state();
    const action=await this.telegram.approvedSystem(this.audience(row),row.source_reference,binding,row.space_id,parts[part-1]!,'background-report:'+row.id+':'+part);
    await this.control.query('INSERT INTO background_reports(job_id,part,action_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.id,part,action.id]);
    return observation('waiting','delivery',part,Date.now()+5000,'receipt_pending');
  }
  /** The workflow family: `job:` drives a job, `run:` one of its steps. */
  async operation(job:string,authority:ExecutionAuthority):Promise<Observation> {
    if(job.startsWith('run:'))return this.steps.run(managedEventId(job.slice(4)),authority);
    if(job.startsWith('job:'))return this.tick(managedEventId(job.slice(4)),authority);
    return observation('failed','admission');
  }
  /** The step message: the instruction for the first step, then continue, then the report at a limit. */
  async stepText(row:any,step:any):Promise<string> {
    const prompts=await ownerPrompts(this.control),shown=await this.proposal(row),estimate=row.estimate;
    const owner=this.access.policy().owner_id,period=estimate.from||estimate.to?[estimate.from??'the start',estimate.to??'now'].join(' to '):'the whole chat';
    if(step.kind==='wrap_up') {
      const elapsed=(Date.now()-new Date(row.started_at).getTime())/60000;
      return fillTemplate(prompts['background.wrap_up']??backgroundWrapUp,{title:shown.title,
        limit:elapsed>=row.minutes_limit?row.minutes_limit+' minutes':money(Number(row.cost_limit_usd))});
    }
    if(step.step>1)return fillTemplate(prompts['background.continue']??backgroundContinue,{title:shown.title});
    return fillTemplate(prompts['background.job']??backgroundJob,{title:shown.title,instruction:shown.instruction,
      chat:row.target===owner?'your private chat with the owner (chat '+row.target+')':'chat '+row.target,period,size:sizeLine(estimate),
      limits:money(Number(row.cost_limit_usd))+' or '+row.minutes_limit+' minutes'});
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
    return {background:{job_id:row.job_id,step:step.step,kind:step.kind,max_iterations:step.kind==='wrap_up'?WRAP_UP_ITERATIONS:WORK_ITERATIONS}};
  }
  protected async build(row:any){
    await this.current(row);const principal=this.principal(row),job=await this.jobs.allowed(row),step=await this.step(row.event_id);
    await this.turns.register(principal,{logical_profile:row.logical_profile,job:row.job_id});
    const input:ManagedInput={principal,text:await this.jobs.stepText(job,step),transcripts:[],files:[],source_key:'nocheh:operation:'+row.event_id};
    await this.turns.prepared.allow(principal,input);
    const reference=await this.derived.record({operation_id:'background-input:'+row.event_id,source:row.source_reference,parents:[job.proposal_reference],
      kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:this.protocol,
      configuration:{binding:row.binding,profile:row.logical_profile,job_id:row.job_id},provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
  /** A step's result also says whether the job goes on, its to-do list and what it cost. */
  override async finish(input:unknown){
    const body=object(input),row=await this.row(managedEventId(body.event_id));
    if(!row?.actor||row.actor!==body.actor)throw new HttpError(403,'run_actor_mismatch');
    const todo=Array.isArray(body.todo)?body.todo.slice(0,50).map(item=>{const value=object(item);
      return {content:string(value.content??'',200),status:string(value.status??'',20)};}):[];
    const cost=typeof body.cost_usd==='number'&&Number.isFinite(body.cost_usd)&&body.cost_usd>=0?body.cost_usd:null;
    await this.control.query('UPDATE background_steps SET continues=$2,todo=$3,cost_usd=$4 WHERE event_id=$1 AND NOT counted',
      [row.event_id,body.continue===true,JSON.stringify(todo),cost]);
    const {continue:_continue,todo:_todo,cost_usd:_cost,...result}=body;
    return super.finish(result);
  }
  async stop(id:string){return this.cancelRow(id);}
}
