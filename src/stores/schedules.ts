import {blockingPublications} from './publications.js';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {adminOrAgent,boundReader,type AgentLogin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {cronMatches,knownZone,parseCron} from '../schedule-timing.js';
import {HttpError,object,string} from '../http.js';
import {enterFamily,leaveFamily,releaseOperation,requestOpenWorkflow,requestWorkflow} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardBinding} from './guards.js';
import {OperationRepository} from './operations.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';
import {forwardedMessage} from './owner-member-asks.js';
import {ownerTimeZone,setOwnerTimeZone,timeZone} from './task-settings.js';
import {keepNotes} from './notes-epochs.js';
import {outsideReads,type OutsideRead} from './turn-reads.js';
import {activeAgent} from '../agent/agents.js';
import {memberReads} from './member-reads.js';

export const scheduleStorageSchema=`
CREATE TABLE IF NOT EXISTS schedule_versions (
 id text PRIMARY KEY,schedule_id text NOT NULL,document_hash text NOT NULL,execution_version text NOT NULL,execution_hash text NOT NULL,
 operation_reference jsonb NOT NULL,definition_reference jsonb NOT NULL,prompt_reference jsonb NOT NULL,
 configuration jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_schedules (
 id text PRIMARY KEY,logical_profile text NOT NULL,job_id text NOT NULL,scope text NOT NULL,
 version_id text NOT NULL REFERENCES schedule_versions(id),cursor text NOT NULL,sequence bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(logical_profile,job_id)
);
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS schedule_version text REFERENCES schedule_versions(id);
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS trigger_reference jsonb;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS fire_reason text;
-- Only Nocheh decides that a schedule may be set or fired (ADR-0290): a person's live turn, a press it saw, or its own
-- clock around advance. Each grant is a row here; no secret passes through Hermes.
CREATE TABLE IF NOT EXISTS schedule_turn_grants (
 turn_event text PRIMARY KEY,scope text NOT NULL,profile text NOT NULL,person text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_grants (
 id text PRIMARY KEY,schedule_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('edit','run_now','clock')),
 operation text CHECK(operation IN ('pause','resume','delete','run')),request_id text,person text,
 cursor text,owner_epoch bigint,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 used_by text,used_at timestamptz
);
CREATE INDEX IF NOT EXISTS schedule_grants_schedule ON schedule_grants(schedule_id,kind);
ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS created_turn text;
ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS body_hash text;
ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS set_by jsonb;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS fired_by text;
-- The id of Nocheh's latest message about a schedule set by asking, which a press on it edits (ADR-0294).
ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS notice_id text;
-- The agent whose turn first set the schedule (ADR-0305); its person is created_by. Each fire's run is made for both.
ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS agent text CHECK(agent IS NULL OR agent ~ '^[a-z][a-z0-9-]{0,31}$');
`;
const identity=(value:unknown)=>{const id=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HttpError(400,'invalid_schedule_identity');return id;};
/** A profile or job id as Hermes names them; 400 `invalid_schedule_identity` otherwise. */
export const scheduleIdentity=identity;
const hash=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_schedule_hash');return id;};
const scheduleId=(profile:string,job:string)=>digest(canonical([profile,job]));
/** A schedule's id in Nocheh's records, from its profile and Hermes job id. */
export const scheduleKey=scheduleId;
/** A request id a press or Hermes carries: what binds a grant to one change or one Run now. */
const requestId=(value:unknown,code:string)=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw new HttpError(400,code);return value;};
const grantId=(kind:'edit'|'run_now',schedule:string,request:string)=>digest(canonical(['schedule-grant',kind,schedule,request]));
/** What a definition says apart from whether it is on, removed or which execution it is: what an edit grant may not change. */
const bodyHash=(document:Record<string,unknown>)=>{const {enabled:_on,removed:_gone,execution_version:_version,...body}=document;return digest(canonical(body));};
const LOGICAL=/^nocheh-[a-f0-9]{24}$/;
/** Who a turn sets schedules as: the member in their own chat, else the owner. */
/** Reads that never hold a schedule (ADR-0294): only an unreported conversation. An archive search holds one, since it
 * returns other people's messages too (owner's choice, 2026-11-24). */
const SCHEDULE_IGNORES=new Set<OutsideRead>(['unchecked']);
const turnPerson=(principal:Reader)=>boundReader(principal)==='member'?principal.member??null:'owner';

/** Who set a definition version: a person's live turn, a person's press (edit grant), or Hermes's own checkpoint. */
export type ScheduleSetBy={via:'turn';person:string;turn:string}|{via:'edit';person:string;request_id:string}|{via:'checkpoint'};
export interface ScheduleAuthorization {set_by:ScheduleSetBy;created_by?:string;created_turn?:string;
  /** The agent the setting turn's key named (ADR-0305), kept with created_by. */
  agent?:string}
/** Decides inside the definition's transaction whether this change may be recorded; `version` is null for the read-only
 *  check before any derived records are written, so nothing is consumed then. */
export type ScheduleAuthorizer=(db:Pick<pg.PoolClient,'query'>,current:any|undefined,document:Record<string,unknown>,
  context:{id:string;scope:string;execution_hash:string;version:string|null})=>Promise<ScheduleAuthorization>;
type Queryable=Pick<pg.Pool,'query'>;
const currentSql=`SELECT s.*,v.execution_version,v.execution_hash,v.body_hash,v.configuration FROM workflow_schedules s
  JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1`;

/** Schedules are control operations with durable derivative prompts, never sources. */
export class ScheduleRepository {
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly detectorVersion:string,
    readonly detect:(text:string)=>Promise<unknown>){}
  private get control(){return this.access.stores.control;}
  private get guards(){return this.access.guards;}
  /** The member whose own open private chat `scope` is, or null (ADR-0305: who a schedule there is for). */
  private async chatMember(scope:string):Promise<string|null> {
    return (await memberReads(this.control,scope,ownerChat(this.access.policy())))?.member??null;
  }
  /** The runtime profile, which must be that chat's own (scope and space equal). */
  async profile(profile:string,scope:string){
    const entry=await new RuntimeProfileRepository(this.access).resolve({admin:true,scope:null},{profile});
    if(entry.logical_profile!==profile||entry.scope!==scope||entry.space!==scope)throw new HttpError(403,'profile_scope_denied');return entry;
  }
  private document(value:unknown,profile:string):Record<string,unknown>&{prompt:string;execution_version:string}{
    const body=object(value),keys=['profile','name','prompt','schedule','deliver','repeat','enabled','removed','preferences','execution_version','timezone'];
    // A schedule's own time zone (ADR-0266): an IANA name, or none for the agent's own.
    if(body.timezone!==undefined&&body.timezone!==null&&!(typeof body.timezone==='string'&&/^[A-Za-z0-9_+\-\/]{1,64}$/.test(body.timezone)))
      throw new HttpError(400,'invalid_schedule_definition');
    if(Object.keys(body).some(k=>!keys.includes(k))||body.profile!==profile||typeof body.enabled!=='boolean'||typeof body.removed!=='boolean'||
      !['local','telegram'].includes(String(body.deliver))||body.repeat!==null&&(!Number.isSafeInteger(body.repeat)||Number(body.repeat)<1||Number(body.repeat)>10000))
      throw new HttpError(400,'invalid_schedule_definition');
    const prompt=string(body.prompt,100000);if(!prompt.trim())throw new HttpError(400,'invalid_schedule_prompt');
    if(body.name!==null)string(body.name,200);
    const schedule=object(body.schedule),preferences=object(body.preferences);
    if(!['once','interval','cron'].includes(String(schedule.kind))||Buffer.byteLength(canonical(schedule))>4096||Buffer.byteLength(canonical(preferences))>4096)
      throw new HttpError(400,'invalid_schedule_definition');
    // Preferences are a closed set; conversation text never supplies provider or
    // administrative policy through a generated schedule document. Tools follow the
    // switches of the schedule's chat, so a schedule carries none of its own.
    for(const [key,value] of Object.entries(preferences)){
      const range:Record<string,[number,number]>={'agent.max_iterations':[1,16],'agent.run_budget_seconds':[30,180],
        'memory.memory_char_limit':[100,20000],'memory.user_char_limit':[100,20000]};
      if(key==='agent.reasoning_effort'){if(!['low','medium','high'].includes(String(value)))throw new HttpError(400,'invalid_schedule_preference');}
      else if(!range[key]||!Number.isSafeInteger(value)||Number(value)<range[key]![0]||Number(value)>range[key]![1])throw new HttpError(400,'invalid_schedule_preference');
    }
    return {...body,prompt,execution_version:identity(body.execution_version)};
  }
  private async fence(db:pg.PoolClient,binding:GuardBinding,update=false){
    const row=(await db.query(`SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton
      ${update?'FOR UPDATE OF g FOR SHARE OF i':'FOR SHARE OF i,g'}`)).rows[0];
    if(!row||canonical({generation:row.generation,epoch:Number(row.epoch),mode:row.mode})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
    if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async ownership(){return (await this.control.query("SELECT owner,epoch,admission FROM workflow_owners WHERE family='schedules'")).rows[0];}
  /** The current version's body hash; a version from before grants has none, so its definition derivative gives it. */
  private async currentBody(current:any):Promise<string|null> {
    if(current.body_hash)return current.body_hash;
    try {
      const saved=await this.derived.checkpoint('schedule-definition:'+current.version_id);
      return saved?bodyHash(object(JSON.parse(saved.content.toString()))):null;
    }catch{return null;}
  }
  /**
   * Hermes's own definition post (the agent login, ADR-0295; or the owner's admin bearer): a checkpoint of a schedule
   * Nocheh already has, with the same execution version and never turning it back on; or a change a person's press asked
   * for, with that press's unused edit grant, which may only pause, resume or delete. Anything else, a schedule Nocheh
   * never recorded included, is refused.
   */
  private edits(grant:string|undefined):ScheduleAuthorizer {
    return async(db,current,document,{id,execution_hash,version})=>{
      if(current&&current.execution_version===document.execution_version&&current.execution_hash===execution_hash&&
        !(current.configuration?.enabled===false&&document.enabled===true))return {set_by:{via:'checkpoint'}};
      const refused=new HttpError(403,'schedule_definition_not_allowed');
      if(grant===undefined||!current||current.configuration?.removed)throw refused;
      const row=(await db.query(`SELECT * FROM schedule_grants WHERE id=$1 AND kind='edit' AND schedule_id=$2 AND request_id=$3 AND used_by IS NULL
        AND expires_at>now() FOR UPDATE`,[grantId('edit',id,grant),id,grant])).rows[0];
      const implied=document.removed===true?'delete':document.enabled===false?'pause':'resume';
      // A removal may carry a body a refused turn changed (it is never run again); a pause or resume says what Nocheh has.
      if(!row||row.operation!==implied||implied!=='delete'&&bodyHash(document)!==await this.currentBody(current))throw refused;
      if(version)await db.query('UPDATE schedule_grants SET used_by=$2,used_at=now() WHERE id=$1',[row.id,version]);
      return {set_by:{via:'edit',person:row.person,request_id:row.request_id}};
    };
  }
  /**
   * A person's live turn (schedule_turn_grants): any change in that turn's own chat, within a member's cap. A turn that
   * read outside content (`steered`, ADR-0294) may not leave a schedule running unless it already ran with that very
   * instruction: 409 `schedule_start_needed`, and Hermes saves it paused instead, for its person's Start.
   */
  private turnChange(grant:{scope:string;person:string},turn:string,limit:number|null,steered=false,agent?:string):ScheduleAuthorizer {
    return async(db,current,document,{version})=>{
      if(current&&current.scope!==grant.scope)throw new HttpError(403,'profile_scope_denied');
      if(steered&&document.enabled===true&&document.removed!==true&&!(current&&current.configuration?.enabled!==false&&
        !current.configuration?.removed&&bodyHash(document)===await this.currentBody(current)))throw new HttpError(409,'schedule_start_needed');
      if(grant.person!=='owner'&&!document.removed&&(!current||current.configuration?.removed)) {
        // Two turns of one chat cannot both take its last place.
        if(version)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803369))',['schedule-chat:'+grant.scope]);
        if(limit===null||await chatSchedules(db,grant.scope)>=limit)throw new HttpError(403,'schedule_limit_reached');
      }
      return {set_by:{via:'turn',person:grant.person,turn},created_by:grant.person,created_turn:turn,...(agent?{agent}:{})};
    };
  }
  async definition(principal:Reader|AgentLogin,input:unknown){
    adminOrAgent(principal);const body=object(input);
    const grant=body.grant===undefined||body.grant===null?undefined:requestId(body.grant,'invalid_schedule_definition');
    const {created:_created,...result}=await this.record(body,this.edits(grant));return result;
  }
  /**
   * Records one definition version as `authorize` allows (ADR-0266, ADR-0290): sequence ordering, the execution-version
   * conflict, revocation on a new execution version, the version and current row, older cursors superseded and the
   * cursor's workflow requested. `created` says the schedule was new.
   */
  async record(input:unknown,authorize:ScheduleAuthorizer){
    const body=object(input),profile=identity(body.profile),job=identity(body.job_id),scope=string(body.scope,64);
    await this.profile(profile,scope);const document=this.document(body.definition,profile),fingerprint=digest(canonical(document));
    const cursor=hash(body.workflow_cursor),sequence=Number(body.workflow_sequence);
    if(!Number.isSafeInteger(sequence)||sequence<1)throw new HttpError(400,'invalid_schedule_sequence');
    const id=scheduleId(profile,job),{enabled:_enabled,...execution}=document,executionHash=digest(canonical(execution));
    const prior=async(db:Queryable)=>{
      const row=(await db.query('SELECT execution_hash FROM schedule_versions WHERE schedule_id=$1 AND execution_version=$2 LIMIT 1',[id,document.execution_version])).rows[0];
      if(row&&row.execution_hash!==executionHash)throw new HttpError(409,'schedule_execution_version_conflict');
    };
    // The same decision once before anything is written, so a refused post leaves no derived records; the transaction's stays authoritative.
    const seen=(await this.control.query(currentSql,[id])).rows[0];
    if(!seen||Number(seen.sequence)<sequence){await prior(this.control);await authorize(this.control,seen,document,{id,scope,execution_hash:executionHash,version:null});}
    const operation=await new OperationRepository(this.control).record({key:'schedule-definition:'+id+':'+fingerprint,
      kind:'schedule_definition',scope,input_hash:fingerprint});
    const {prompt,name,...configuration}=document;
    const output=await this.derived.record({operation_id:'schedule-definition:'+operation.id,source:operation,kind:'schedule_definition',
      content:Buffer.from(canonical(document)),producer:'hermes',producer_version:'managed-scheduler-v2',configuration:{schedule_id:id}});
    const prepared=await this.derived.record({operation_id:'schedule-prompt:'+operation.id,source:operation,parents:[output],kind:'scheduled_prompt',
      content:Buffer.from(prompt),producer:'hermes',producer_version:'managed-scheduler-v2',configuration});
    if((await this.guards.state()).mode==='on')await this.guards.prepare(prepared,this.detectorVersion,this.detect);
    const binding=await this.guards.state();
    if(binding.mode==='on')await this.guards.read('derived_artifacts:'+prepared.id,binding);
    const db=await this.control.connect();
    try{await db.query('BEGIN');await this.fence(db,binding,true);
      const authorized=await this.profile(profile,scope);
      if(authorized.generation!==binding.generation||authorized.guard_epoch!==binding.epoch||operation.generation!==binding.generation)throw new HttpError(409,'guard_context_changed');
      const current=(await db.query(currentSql+' FOR UPDATE OF s',[id])).rows[0];
      if(current&&Number(current.sequence)>=sequence){
        if(Number(current.sequence)===sequence&&(current.cursor!==cursor||current.version_id!==operation.id))throw new HttpError(409,'schedule_sequence_conflict');
        await db.query('COMMIT');return {id,event_id:current.version_id as string,duplicate:true,superseded:Number(current.sequence)>sequence,created:false};
      }
      await prior(db);
      const allowed=await authorize(db,current,document,{id,scope,execution_hash:executionHash,version:operation.id});
      // Definition edits revoke before publication. Clock/cursor checkpoints with
      // the same execution version cannot revoke their already-admitted fire.
      if(current&&current.execution_version!==document.execution_version){
        const epoch=Number((await db.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch);
        await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);
        // A schedule's new definition takes nothing from any chat's Hermes notes (ADR-0292).
        await keepNotes(db,epoch,'all');
        await db.query(`UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,
          revision=revision+1,updated_at=now() WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2 AND state IN ('captured','running')`,[profile,job]);
        await db.query(`UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id IN
          (SELECT event_id FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2) AND state='open'`,[profile,job]);
        // Their one-time keys close with them (ADR-0305).
        await db.query(`UPDATE one_time_keys SET closed_at=now(),closed_reason='schedule_changed' WHERE kind='scheduled' AND closed_at IS NULL AND event_id IN
          (SELECT event_id FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2)`,[profile,job]);
      }
      await db.query(`INSERT INTO schedule_versions(id,schedule_id,document_hash,execution_version,operation_reference,definition_reference,prompt_reference,configuration,execution_hash,body_hash,set_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[operation.id,id,fingerprint,document.execution_version,operation,output,prepared,configuration,executionHash,
          bodyHash(document),allowed.set_by]);
      // Who first set a schedule by asking, and in which turn, is kept as it was; a later version never changes it.
      await db.query(`INSERT INTO workflow_schedules(id,logical_profile,job_id,scope,version_id,cursor,sequence,created_by,created_turn,agent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(id) DO UPDATE SET version_id=$5,cursor=$6,sequence=$7,updated_at=now()`,[id,profile,job,scope,operation.id,cursor,sequence,allowed.created_by??null,allowed.created_turn??null,
          allowed.agent??null]);
      await db.query(`UPDATE workflow_registry SET state='skipped',waiting_reason='superseded',revision=revision+1,updated_at=now()
        WHERE family='schedules' AND job_id LIKE $1 AND job_id<>$2 AND state IN ('queued','waiting','retryable_failed')`,['schedule:'+id+':%','schedule:'+id+':'+cursor]);
      // A Run now moves the cursor away and back again (pending, running, then idle with the same next run); the cursor's
      // earlier row is then closed, and a new generation runs it (ADR-0266).
      await requestOpenWorkflow(db,'schedules','schedule:'+id+':'+cursor);await db.query('COMMIT');
      return {id,event_id:operation.id,duplicate:false,created:!current,definition:output,prompt:prepared};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /**
   * A schedule set by asking (POST /v1/schedules/turn/definition): Hermes posts it from inside the person's sealed turn,
   * through the broker, as that turn. It needs the turn grant /v1/schedules/turn recorded, the turn still allowed to
   * set schedules now, the same chat and profile, and a definition this side can time exactly. A new schedule gets its
   * message in that chat once (ScheduleNotices.announce).
   */
  async turnDefinition(principal:Reader,input:unknown,s:ScheduleTurnRecordServices&{scheduleNotices:{announce(input:unknown):Promise<{state:string}>}}) {
    if(principal.admin||!principal.turnEvent)throw new HttpError(403,'schedule_turn_required');
    const body=object(input),turn=principal.turnEvent,refused=()=>new HttpError(403,'schedule_turn_not_allowed');
    const notice=body.notice===undefined||body.notice===null?{}:object(body.notice);
    const grant=(await this.control.query<{scope:string;profile:string;person:string}>('SELECT scope,profile,person FROM schedule_turn_grants WHERE turn_event=$1 AND expires_at>now()',[turn])).rows[0];
    if(!grant)throw refused();
    let rules:ScheduleTurnRules;
    try {
      rules=await scheduleTurn(s,principal);
      if(!rules.allowed||turnPerson(principal)!==grant.person||(await s.turns.binding(principal)).logical_profile!==grant.profile)throw refused();
    }catch(error){if(error instanceof HttpError&&error.status<500)throw refused();throw error;}
    if(body.profile!==grant.profile||body.scope!==grant.scope)throw refused();
    // Only what Nocheh can time exactly and send to the chat it was set in.
    const document=this.document(body.definition,grant.profile),schedule=object(document.schedule);
    if(document.deliver!=='telegram'||schedule.kind==='interval'&&(!Number.isSafeInteger(schedule.minutes)||Number(schedule.minutes)<1)||
      typeof document.timezone==='string'&&!knownZone(document.timezone))throw new HttpError(400,'invalid_schedule_definition');
    if(schedule.kind==='cron'&&!parseCron(schedule.expr))throw new HttpError(400,'schedule_cron_unsupported');
    // What outside content reached this turn so far, and the instruction the schedule ran with before it (ADR-0294). The
    // asker's own typed words are theirs, the owner's or a member's in their own chat, whose chat id is their account's.
    // A runtime that never reported its conversation does not hold a schedule; an archive search does.
    const asker=grant.person==='owner'?s.access.policy().owner_id:grant.scope;
    const reads=(await outsideReads(this.control,s.stores.archive,turn,asker)).filter(read=>!SCHEDULE_IGNORES.has(read));
    const before=(await this.control.query(currentSql,[scheduleId(grant.profile,identity(body.job_id))])).rows[0];
    const earlier=before&&!before.configuration?.removed?await this.currentBody(before):null;
    const result=await this.record(body,this.turnChange(grant,turn,rules.limit,reads.length>0,principal.agent));
    if(result.duplicate)return {id:result.id,event_id:result.event_id,duplicate:true,superseded:result.superseded,created:false,notice:null,held:false};
    // Held: saved paused, by a turn that read outside content, as new or with another instruction. Its person starts it.
    const held=reads.length>0&&!document.removed&&document.enabled===false&&(result.created||earlier!==bodyHash(document));
    let state:string|null=null;
    if(!document.removed&&(result.created||held)) {
      const fields=Object.fromEntries(['name','schedule','timezone','next_run_at'].filter(key=>key in notice).map(key=>[key,notice[key]]));
      state=(await s.scheduleNotices.announce({...fields,scope:grant.scope,profile:grant.profile,job_id:body.job_id,prompt:document.prompt,
        enabled:document.enabled,changed:!result.created,reads:held?reads:[],version:result.event_id}).catch(()=>({state:'failed'}))).state;
    }
    return {id:result.id,event_id:result.event_id,duplicate:false,created:result.created,notice:state,held};
  }
  /**
   * Whether a fire Hermes captured may run (ADR-0290): a timed fire needs the clock grant Nocheh issued around this
   * advance and must land when the schedule says; a Run now needs the grant a person's press issued. Consumes the grant
   * and returns who fired it; with no `event` it only checks, read-only.
   */
  private async fireGrant(db:Queryable,current:any,request:{reason:string;scheduled:number;epoch:number;request_id:string|null;event:string|null}):Promise<string> {
    const lock=request.event?' FOR UPDATE':'';
    if(request.reason==='manual') {
      const row=(await db.query(`SELECT id,person FROM schedule_grants WHERE id=$1 AND kind='run_now' AND operation='run' AND schedule_id=$2 AND request_id=$3
        AND used_by IS NULL AND expires_at>now()${lock}`,[grantId('run_now',current.id,request.request_id!),current.id,request.request_id])).rows[0];
      if(!row)throw new HttpError(403,'fire_grant_run_now');
      if(request.event)await db.query('UPDATE schedule_grants SET used_by=$2,used_at=now() WHERE id=$1',[row.id,request.event]);return String(row.person);
    }
    const grant=(await db.query(`SELECT id FROM schedule_grants WHERE kind='clock' AND schedule_id=$1 AND cursor=$2 AND owner_epoch=$3 AND used_by IS NULL
      AND expires_at>now()${lock&&lock+' SKIP LOCKED'} LIMIT 1`,[current.id,current.cursor,request.epoch])).rows[0];
    if(!grant)throw new HttpError(403,'fire_grant_clock');
    const fires=(await db.query(`SELECT (extract(epoch FROM now())*1000)::float8 AS now,
        (SELECT max(r.scheduled_for) FROM managed_runs r WHERE r.channel='scheduler' AND r.logical_profile=$1 AND r.job_id=$2 AND r.fired_by='clock' AND r.scheduled_for IS NOT NULL) AS last,
        (SELECT count(*)::int FROM managed_runs r JOIN schedule_versions v ON v.id=r.schedule_version WHERE r.channel='scheduler' AND r.logical_profile=$1 AND r.job_id=$2
          AND r.fired_by='clock' AND r.scheduled_for IS NOT NULL AND v.execution_version=$3) AS fired`,[current.logical_profile,current.job_id,current.execution_version])).rows[0];
    if(!fireTiming(current.configuration,request.reason,request.scheduled,{now:Number(fires.now),last:fires.last?new Date(fires.last).getTime():null,fired:Number(fires.fired)}))
      throw new HttpError(403,'fire_grant_time');
    if(request.event)await db.query('UPDATE schedule_grants SET used_by=$2,used_at=now() WHERE id=$1',[grant.id,request.event]);return 'clock';
  }
  async capture(principal:Reader|AgentLogin,input:unknown){
    adminOrAgent(principal);const body=object(input),profile=identity(body.profile),scope=string(body.scope,64),job=identity(body.job_id),fire=identity(body.id);
    await this.profile(profile,scope);const document=this.document(body.definition,profile),version=hash(body.job_revision);
    if(version!==digest(canonical(document))||body.text!==document.prompt||body.space!==scope||!Array.isArray(body.files)||body.files.length)
      throw new HttpError(400,'schedule_input_conflict');
    const scheduled=string(body.scheduled_for,64),reason=string(body.fire_reason,32);
    if(!Number.isFinite(Date.parse(scheduled))||!['scheduled','manual','catch_up','missed','overlap'].includes(reason))throw new HttpError(400,'invalid_scheduled_fire');
    // A Run now names the press that asked for it; it is not part of the fire itself.
    const pressed=reason==='manual'?requestId(body.request_id,'invalid_scheduled_fire'):null;
    // Catch-up is off for now (ADR-0290): no page or command asks for it.
    if(reason==='catch_up')throw new HttpError(403,'schedule_catch_up_off');
    // The fire's identity leaves out the reason Hermes claims (it is kept on the run): Hermes names a slot by its fire id
    // whatever the reason, so a later retry of the same slot as missed, after a grant refused even inside the
    // transaction below, is the same operation, never an identity conflict that would stop the schedule for good.
    const request={profile,scope,job_id:job,fire,job_revision:version,scheduled_for:scheduled,definition:document};
    const key='scheduled-fire:'+scheduleId(profile,job)+':'+fire;
    // A fire refused before anything is written leaves no derived records behind; the transaction's check below stays
    // authoritative.
    if(!(await this.control.query('SELECT 1 FROM content_operations o JOIN installation i ON i.generation=o.generation AND i.singleton WHERE o.operation_key=$1',[key])).rowCount) {
      const seen=(await this.control.query(`SELECT s.*,v.document_hash,v.configuration,v.execution_version FROM workflow_schedules s
        JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1`,[scheduleId(profile,job)])).rows[0];
      if(seen&&seen.document_hash===version&&seen.scope===scope&&!seen.configuration.removed&&(seen.configuration.enabled||reason!=='scheduled'))
        await this.fireGrant(this.control,seen,{reason,scheduled:Date.parse(scheduled),epoch:Number(body.owner_epoch),request_id:pressed,event:null});
    }
    const db=await this.control.connect();let held=false;
    try{
      held=await enterFamily(db,'schedules','inngest',Number(body.owner_epoch));if(!held)throw new HttpError(409,'workflow_owner_changed');
      const operation=await new OperationRepository(this.control).record({key,
        kind:'scheduled_trigger',scope,input_hash:digest(canonical(request))});
      const output=await this.derived.record({operation_id:'scheduled-trigger:'+operation.id,source:operation,kind:'scheduled_trigger',
        content:Buffer.from(canonical(request)),producer:'hermes',producer_version:'managed-scheduler-v2',configuration:{profile,job_id:job}});
      const binding=await this.guards.state();await db.query('BEGIN');await this.fence(db,binding);
      const authorized=await this.profile(profile,scope);
      if(authorized.generation!==binding.generation||authorized.guard_epoch!==binding.epoch||operation.generation!==binding.generation)throw new HttpError(409,'guard_context_changed');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803368))',[scheduleId(profile,job)]);
      const saved=(await db.query("SELECT state,fire_reason FROM managed_runs WHERE event_id=$1 AND channel='scheduler'",[operation.id])).rows[0];
      if(saved){await db.query('COMMIT');return {event_id:operation.id,state:saved.state,fire_reason:saved.fire_reason,duplicate:true};}
      const current=(await db.query(`SELECT s.*,v.document_hash,v.prompt_reference,v.configuration,v.execution_version FROM workflow_schedules s
        JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1 FOR SHARE OF s`,[scheduleId(profile,job)])).rows[0];
      if(!current||current.document_hash!==version||current.scope!==scope||current.configuration.removed||
        !current.configuration.enabled&&reason==='scheduled')throw new HttpError(409,'schedule_definition_changed');
      // Who fired it follows the grant for the reason Hermes claimed, also when a busy schedule turns it into an overlap below.
      const firedBy=await this.fireGrant(db,current,{reason,scheduled:Date.parse(scheduled),epoch:Number(body.owner_epoch),request_id:pressed,event:operation.id});
      const prompt=current.prompt_reference as DerivativeReference;
      if(binding.mode==='on')await this.guards.read('derived_artifacts:'+prompt.id,binding);
      // Who the run is for (ADR-0305): the schedule's creator; one with none recorded, the owner in the owner's chat and
      // the member in their own chat. Anywhere else nobody can be named, and the fire is refused before it is recorded.
      const person=current.created_by??(scope===ownerChat(this.access.policy())?'owner':await this.chatMember(scope));
      if(!person)throw new HttpError(409,'one_time_key_person_required');
      const busy=(await db.query("SELECT 1 FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2 AND state IN ('captured','running')",[profile,job])).rowCount;
      const effective=busy?'overlap':reason,missed=['missed','overlap'].includes(effective);
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,
        owner_epoch,job_id,schedule_version,trigger_reference,fire_reason,state,error_code,scheduled_for,fired_by,person,agent)
        VALUES($1,'scheduler',$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[operation.id,operation,scope,profile,
          'cron_'+job+'_'+operation.id.slice(0,24),binding,body.owner_epoch,job,current.version_id,output,effective,missed?'cancelled':'captured',missed?'scheduled_'+effective:null,
          new Date(Date.parse(scheduled)),firedBy,person,current.agent??activeAgent]);
      await requestWorkflow(db,'schedules','run:'+operation.id);await db.query('COMMIT');
      return {event_id:operation.id,state:missed?'cancelled':'captured',fire_reason:effective,duplicate:false};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'schedules');});}
  }
}

/**
 * Whether a clock fire at `scheduled` (ms) lands when the schedule says (ADR-0290), given the database's `now`, this
 * schedule's last clock fire and how many clock fires its current execution version has had. Hermes decides when a
 * schedule is due; this only keeps a fire it claims on a time the definition names, never twice and never early.
 */
export function fireTiming(configuration:Record<string,any>,reason:string,scheduled:number,fires:{now:number;last:number|null;fired:number}):boolean {
  const {now,last,fired}=fires,schedule=configuration?.schedule??{};
  if(!Number.isFinite(scheduled)||scheduled>now+5000)return false;
  // A timed run more than ten minutes late is stale; Hermes already calls anything over a minute late missed.
  if(reason==='scheduled'&&now-scheduled>600000)return false;
  if(last!==null&&scheduled<=last)return false;
  if(schedule.kind==='cron'){if(scheduled%60000!==0||!cronMatches(String(schedule.expr??''),scheduled,typeof configuration.timezone==='string'?configuration.timezone:'UTC'))return false;}
  else if(schedule.kind==='interval'){if(!Number.isSafeInteger(schedule.minutes)||schedule.minutes<1||last!==null&&scheduled-last<schedule.minutes*60000-1000)return false;}
  else if(schedule.kind==='once'){if(fired>0)return false;}
  else return false;
  // Hermes keeps the exact count across versions; this is a loose cap within one.
  if(typeof configuration.repeat==='number'&&fired>=configuration.repeat)return false;
  return true;
}

/**
 * A person's press asked to pause, resume, delete or run one schedule now (ADR-0290): the grant Hermes's following
 * definition post or Run now fire must show, bound to the press's request id. Edit grants live 3 minutes (Hermes's
 * manage call times out at 2), Run now 10. The same request id for another change or person is 409
 * `schedule_request_conflict`. A press bound to one chat (a member's own, or the chat of Nocheh's message) names it as
 * `scope`: a schedule Nocheh holds for another chat is 404 `schedule_not_found`, whatever the agent's list said.
 * Returns the request id.
 */
export async function issueScheduleGrant(control:Queryable,input:{profile:string;job_id:string;operation:'pause'|'resume'|'delete'|'run';person:string;request_id:string;scope?:string}):Promise<string> {
  const kind=input.operation==='run'?'run_now':'edit',schedule=scheduleId(input.profile,input.job_id),id=grantId(kind,schedule,input.request_id);
  if(input.scope!==undefined) {
    const held=(await control.query('SELECT scope FROM workflow_schedules WHERE id=$1',[schedule])).rows[0];
    if(held&&held.scope!==input.scope)throw new HttpError(404,'schedule_not_found');
  }
  await control.query(`DELETE FROM schedule_grants WHERE expires_at<now()-interval '1 day'`);
  await control.query(`INSERT INTO schedule_grants(id,schedule_id,kind,operation,request_id,person,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs=>$7)) ON CONFLICT(id) DO NOTHING`,[id,schedule,kind,input.operation,input.request_id,input.person,kind==='run_now'?600:180]);
  const row=(await control.query('SELECT operation,person FROM schedule_grants WHERE id=$1',[id])).rows[0];
  if(!row||row.operation!==input.operation||row.person!==input.person)throw new HttpError(409,'schedule_request_conflict');
  return input.request_id;
}
/** The clock grant around one advance (ADR-0290): Hermes may capture one timed fire for this cursor and epoch while it
 *  lasts. It outlives the advance call's 20 s timeout and the time Hermes may still be working after it (its own 15 s
 *  calls under the store's lock), so a slow but valid fire still lands; it stays single-use and bound to the cursor. */
export async function issueClockGrant(control:Queryable,schedule:string,cursor:string,epoch:number):Promise<string> {
  const id=randomUUID();
  await control.query(`DELETE FROM schedule_grants WHERE expires_at<now()-interval '1 day'`);
  await control.query(`INSERT INTO schedule_grants(id,schedule_id,kind,cursor,owner_epoch,expires_at) VALUES($1,$2,'clock',$3,$4,now()+interval '90 seconds')`,[id,schedule,cursor,epoch]);
  return id;
}

/** Seeds a definition version as `authorization` says, past the routes' checks: for tests only. */
export function recordScheduleDefinition(schedules:ScheduleRepository,input:unknown,authorization:ScheduleAuthorization={set_by:{via:'turn',person:'owner',turn:'fixture'},created_by:'owner'}) {
  return schedules.record(input,async()=>authorization);
}

/** What a reply may do with Hermes's schedule tool (ADR-0266). */
export interface ScheduleTurnRules {allowed:boolean;time_zone:string;limit:number|null;count:number|null}
interface ScheduleTurnServices {
  knowledge:{ownerTurn(principal:Reader):Promise<{source:TurnSource}>;liveGroupTurn(principal:Reader):Promise<{source:TurnSource}>};
  stores:{archive:pg.Pool;control:pg.Pool};
}
type TurnSource={channel?:string;kind:string;origin:string;reference:{id:string}};
/**
 * Whether a reply may set the chat's schedules with Hermes's schedule tool: a live reply in the owner's private chat
 * (ownerTurn, which refuses anything else) to the owner's own Telegram message, not a forward. A schedule runs in the
 * owner's time zone (Settings › General). Or a member's live reply in their own private chat (members' schedules), bound
 * to that chat, while they have Personal assistant on: the same, with how many schedules they may keep (Members ›
 * Schedules per member) and how many that chat keeps now. A member's schedule runs in their own time zone when they set
 * one (members' time zones), else in the owner's, unless they name another for that schedule.
 */
export async function scheduleTurn(s:ScheduleTurnServices,principal:Reader):Promise<ScheduleTurnRules> {
  const refused={allowed:false,time_zone:'UTC',limit:null,count:null};
  const member=boundReader(principal)==='member';
  let limits:{limit:number|null;count:number|null}={limit:null,count:null},zone:string|null=null;
  if(member) {
    const chat=principal.memberChat;
    if(!chat||principal.scope!==chat||principal.space!==chat)return refused;
    const row=(await s.stores.control.query<{limit:number;time_zone:string|null}>(`SELECT d.member_schedules AS limit,m.time_zone FROM members m CROSS JOIN member_directory_state d
      WHERE m.id=$1 AND m.state='active' AND m.private_chat AND m.assistant AND d.singleton`,[principal.member])).rows[0];
    if(!row)return refused;
    limits={limit:Number(row.limit),count:await chatSchedules(s.stores.control,chat)};zone=row.time_zone;
  }
  const {source}=member?await s.knowledge.liveGroupTurn(principal):await s.knowledge.ownerTurn(principal);
  if(source.channel!=='telegram'||source.kind!=='telegram_update'||source.origin!=='live')return refused;
  const original=(await s.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.reference.id])).rows[0];
  let message:unknown=null;
  try{message=original?(JSON.parse(original.payload.toString()) as {message?:unknown}).message:null;}catch{message=null;}
  if(!message||typeof message!=='object'||forwardedMessage(message as Record<string,unknown>))return refused;
  return {allowed:true,time_zone:zone??await ownerTimeZone(s.stores.control),...limits};
}

/** POST /v1/schedules/turn's answer: the rules, and the chat and profile a schedule this turn sets must name (ADR-0290). */
export type ScheduleTurnAnswer=ScheduleTurnRules&{profile:string|null;scope:string|null};
export interface ScheduleTurnRecordServices extends ScheduleTurnServices {
  turns:{binding(principal:Reader):Promise<{logical_profile:string}>};
  access:{policy():Pick<AssistantPolicy,'owner_id'|'owner_chat'>};
  schedules:Pick<ScheduleRepository,'profile'>;
}
/**
 * The turn grant (ADR-0290): when scheduleTurn allows this turn, Nocheh keeps for 15 minutes who it is (the owner, or
 * the member in their own chat), its chat and its schedule profile, so a definition Hermes posts from inside it later
 * (POST /v1/schedules/turn/definition) can show it was set by asking here. Anything that does not hold refuses.
 */
export async function recordScheduleTurn(s:ScheduleTurnRecordServices,principal:Reader,rules:ScheduleTurnRules):Promise<ScheduleTurnAnswer> {
  const refused={allowed:false,time_zone:'UTC',limit:null,count:null,profile:null,scope:null};
  if(!rules.allowed)return {...rules,profile:null,scope:null};
  try {
    const person=turnPerson(principal),scope=boundReader(principal)==='member'?principal.memberChat:ownerChat(s.access.policy());
    if(principal.admin||!principal.turnEvent||!person||!scope)return refused;
    const profile=(await s.turns.binding(principal)).logical_profile;
    if(typeof profile!=='string'||!LOGICAL.test(profile))return refused;
    await s.schedules.profile(profile,scope);
    await s.stores.control.query(`DELETE FROM schedule_turn_grants WHERE expires_at<now()-interval '1 day'`);
    await s.stores.control.query(`INSERT INTO schedule_turn_grants(turn_event,scope,profile,person,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')
      ON CONFLICT(turn_event) DO UPDATE SET scope=$2,profile=$3,person=$4,created_at=now(),expires_at=now()+interval '15 minutes'`,[principal.turnEvent,scope,profile,person]);
    return {...rules,profile,scope};
  }catch(error){if(error instanceof HttpError&&error.status<500)return refused;throw error;}
}

/** A member's own time zone for new schedules as asked: an IANA name such as Europe/Berlin, or null (or "") for the
 *  owner's. 400 `invalid_time_zone` otherwise. */
export function memberTimeZoneValue(value:unknown):string|null {
  if(value===null||value==='')return null;
  try{return timeZone(value);}catch{throw new HttpError(400,'invalid_time_zone');}
}
/** Saves a member's own time zone (members' time zones); returns it. Their schedules already set keep their own. */
export async function setMemberTimeZone(db:Pick<pg.Pool,'query'>,member:string,value:unknown):Promise<string|null> {
  const zone=memberTimeZoneValue(value);
  await db.query('UPDATE members SET time_zone=$2,updated_at=now() WHERE id=$1',[member,zone]);
  return zone;
}

/**
 * Someone sets their own time zone by asking in their own private chat (ADR-0281, ADR-0282): the same live, not
 * forwarded, own message that may set schedules (scheduleTurn). A member's goes to them (null for the owner's); the
 * owner's is the one every part of Nocheh follows (Settings › General), never null. Refused with 403
 * `time_zone_not_here` in any other turn.
 */
export async function timeZoneTurn(s:ScheduleTurnServices,principal:Reader,value:unknown):Promise<{time_zone:string|null}> {
  const member=boundReader(principal)==='member';
  if(!member&&boundReader(principal)!==null)throw new HttpError(403,'time_zone_not_here');
  const rules=await scheduleTurn(s,principal).catch(error=>{if(error instanceof HttpError&&error.status<500)return null;throw error;});
  if(!rules?.allowed)throw new HttpError(403,'time_zone_not_here');
  const body=object(value);
  if(Object.keys(body).some(key=>key!=='time_zone'))throw new HttpError(400,'invalid_time_zone');
  if(member)return {time_zone:await setMemberTimeZone(s.stores.control,principal.member!,body.time_zone)};
  try{return {time_zone:await setOwnerTimeZone(s.stores.control,body.time_zone)};}
  catch(error){if(error instanceof HttpError&&error.status===400)throw new HttpError(400,'invalid_time_zone');throw error;}
}
/** How many schedules a chat keeps now: each one captured and not removed. */
export async function chatSchedules(control:Pick<pg.Pool,'query'>,chat:string):Promise<number> {
  return Number((await control.query(`SELECT count(*) AS count FROM workflow_schedules s JOIN schedule_versions v ON v.id=s.version_id
    WHERE s.scope=$1 AND NOT coalesce((v.configuration->>'removed')::boolean,false)`,[chat])).rows[0].count);
}

/** The Schedules pages' list (ADR-0266): each schedule with its chat as the owner sees it, the owner's private chat first
 *  and then groups and members' private chats by their title (a member's by the member's name, member_chat); a chat
 *  with no title shows none. Other answers pass through. */
export async function scheduleChats(control:pg.Pool,owner:string|null|undefined,value:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(!Array.isArray(value.schedules))return value;
  const scopes=[...new Set(value.schedules.map((item:any)=>String(item?.scope??'')))];
  // A member's private chat (members' schedules) is named by the member's name, as the Members page shows it.
  const rows=(await control.query(`SELECT c.id,c.title,c.kind,a.member_id,coalesce(a.display_name,a.username) AS member_name FROM chats c
      LEFT JOIN chat_accounts a ON c.kind='private' AND a.id=c.account_id AND a.member_id IS NOT NULL WHERE c.id=ANY($1::text[])`,[scopes])).rows;
  const chats=new Map(rows.map(row=>[String(row.id),row]));
  const schedules=value.schedules.map((item:any)=>{
    const row=chats.get(String(item?.scope)),member=item?.scope!==owner&&!!row?.member_id;
    return {...item,owner_chat:item?.scope===owner,member_chat:member,
      chat_title:item?.scope===owner?null:member?(row?.member_name as string|null)??null:(row?.title as string|null)??null};
  });
  schedules.sort((a:any,b:any)=>Number(b.owner_chat)-Number(a.owner_chat)||String(a.chat_title??'').localeCompare(String(b.chat_title??''))||String(a.name).localeCompare(String(b.name)));
  return {...value,schedules};
}
