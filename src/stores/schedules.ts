import {blockingPublications} from './publications.js';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardBinding} from './guards.js';
import {OperationRepository} from './operations.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';

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
`;
const identity=(value:unknown)=>{const id=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HttpError(400,'invalid_schedule_identity');return id;};
const hash=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_schedule_hash');return id;};
const scheduleId=(profile:string,job:string)=>digest(canonical([profile,job]));

/** Schedules are control operations with durable derivative prompts, never sources. */
export class ScheduleRepository {
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly detectorVersion:string,
    readonly detect:(text:string)=>Promise<unknown>){}
  private get control(){return this.access.stores.control;}
  private get guards(){return this.access.guards;}
  private async profile(profile:string,scope:string){
    const entry=await new RuntimeProfileRepository(this.access).resolve({admin:true,scope:null},{profile});
    if(entry.logical_profile!==profile||entry.scope!==scope||entry.space!==scope)throw new HttpError(403,'profile_scope_denied');return entry;
  }
  private document(value:unknown,profile:string):Record<string,unknown>&{prompt:string;execution_version:string}{
    const body=object(value),keys=['profile','name','prompt','schedule','deliver','repeat','enabled','removed','preferences','execution_version'];
    if(Object.keys(body).some(k=>!keys.includes(k))||body.profile!==profile||typeof body.enabled!=='boolean'||typeof body.removed!=='boolean'||
      !['local','telegram'].includes(String(body.deliver))||body.repeat!==null&&(!Number.isSafeInteger(body.repeat)||Number(body.repeat)<1||Number(body.repeat)>10000))
      throw new HttpError(400,'invalid_schedule_definition');
    const prompt=string(body.prompt,100000);if(!prompt.trim())throw new HttpError(400,'invalid_schedule_prompt');
    if(body.name!==null)string(body.name,200);
    const schedule=object(body.schedule),preferences=object(body.preferences);
    if(!['once','interval','cron'].includes(String(schedule.kind))||Buffer.byteLength(canonical(schedule))>4096||Buffer.byteLength(canonical(preferences))>4096)
      throw new HttpError(400,'invalid_schedule_definition');
    // Preferences are a closed set; conversation text never supplies provider or
    // administrative policy through a generated schedule document.
    for(const [key,value] of Object.entries(preferences)){
      const range:Record<string,[number,number]>={'agent.max_iterations':[1,16],'agent.run_budget_seconds':[30,180],
        'memory.memory_char_limit':[100,20000],'memory.user_char_limit':[100,20000]};
      if(key==='agent.reasoning_effort'){if(!['low','medium','high'].includes(String(value)))throw new HttpError(400,'invalid_schedule_preference');}
      else if(['nocheh_tools.shell','nocheh_tools.browser','nocheh_tools.mcp'].includes(key)){if(!['on','off'].includes(String(value)))throw new HttpError(400,'invalid_schedule_preference');}
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
  async definition(principal:Reader,input:unknown){
    admin(principal);const body=object(input),profile=identity(body.profile),job=identity(body.job_id),scope=string(body.scope,64);
    await this.profile(profile,scope);const document=this.document(body.definition,profile),fingerprint=digest(canonical(document));
    const cursor=hash(body.workflow_cursor),sequence=Number(body.workflow_sequence);
    if(!Number.isSafeInteger(sequence)||sequence<1)throw new HttpError(400,'invalid_schedule_sequence');
    const id=scheduleId(profile,job),operation=await new OperationRepository(this.control).record({key:'schedule-definition:'+id+':'+fingerprint,
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
      const current=(await db.query(`SELECT s.*,v.execution_version FROM workflow_schedules s JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1 FOR UPDATE OF s`,[id])).rows[0];
      if(current&&Number(current.sequence)>=sequence){
        if(Number(current.sequence)===sequence&&(current.cursor!==cursor||current.version_id!==operation.id))throw new HttpError(409,'schedule_sequence_conflict');
        await db.query('COMMIT');return {id,event_id:current.version_id,duplicate:true,superseded:Number(current.sequence)>sequence};
      }
      const {enabled,...execution}=document,executionHash=digest(canonical(execution));
      const prior=(await db.query('SELECT execution_hash FROM schedule_versions WHERE schedule_id=$1 AND execution_version=$2 LIMIT 1',[id,document.execution_version])).rows[0];
      if(prior&&prior.execution_hash!==executionHash)throw new HttpError(409,'schedule_execution_version_conflict');
      // Definition edits revoke before publication. Clock/cursor checkpoints with
      // the same execution version cannot revoke their already-admitted fire.
      if(current&&current.execution_version!==document.execution_version){
        const epoch=Number((await db.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch);
        await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);
        await db.query(`UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,
          revision=revision+1,updated_at=now() WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2 AND state IN ('captured','running')`,[profile,job]);
        await db.query(`UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id IN
          (SELECT event_id FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2) AND state='open'`,[profile,job]);
      }
      await db.query(`INSERT INTO schedule_versions(id,schedule_id,document_hash,execution_version,operation_reference,definition_reference,prompt_reference,configuration,execution_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[operation.id,id,fingerprint,document.execution_version,operation,output,prepared,configuration,executionHash]);
      await db.query(`INSERT INTO workflow_schedules(id,logical_profile,job_id,scope,version_id,cursor,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET version_id=$5,cursor=$6,sequence=$7,updated_at=now()`,[id,profile,job,scope,operation.id,cursor,sequence]);
      await db.query(`UPDATE workflow_registry SET state='skipped',waiting_reason='superseded',revision=revision+1,updated_at=now()
        WHERE family='schedules' AND job_id LIKE $1 AND job_id<>$2 AND state IN ('queued','waiting','retryable_failed')`,['schedule:'+id+':%','schedule:'+id+':'+cursor]);
      await requestWorkflow(db,'schedules','schedule:'+id+':'+cursor);await db.query('COMMIT');
      return {id,event_id:operation.id,duplicate:false,definition:output,prompt:prepared};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async capture(principal:Reader,input:unknown){
    admin(principal);const body=object(input),profile=identity(body.profile),scope=string(body.scope,64),job=identity(body.job_id),fire=identity(body.id);
    await this.profile(profile,scope);const document=this.document(body.definition,profile),version=hash(body.job_revision);
    if(version!==digest(canonical(document))||body.text!==document.prompt||body.space!==scope||!Array.isArray(body.files)||body.files.length)
      throw new HttpError(400,'schedule_input_conflict');
    const scheduled=string(body.scheduled_for,64),reason=string(body.fire_reason,32);
    if(!Number.isFinite(Date.parse(scheduled))||!['scheduled','manual','catch_up','missed','overlap'].includes(reason))throw new HttpError(400,'invalid_scheduled_fire');
    const request={profile,scope,job_id:job,fire,job_revision:version,scheduled_for:scheduled,fire_reason:reason,definition:document};
    const db=await this.control.connect();let held=false;
    try{
      held=await enterFamily(db,'schedules','inngest',Number(body.owner_epoch));if(!held)throw new HttpError(409,'workflow_owner_changed');
      const operation=await new OperationRepository(this.control).record({key:'scheduled-fire:'+scheduleId(profile,job)+':'+fire,
        kind:'scheduled_trigger',scope,input_hash:digest(canonical(request))});
      const output=await this.derived.record({operation_id:'scheduled-trigger:'+operation.id,source:operation,kind:'scheduled_trigger',
        content:Buffer.from(canonical(request)),producer:'hermes',producer_version:'managed-scheduler-v2',configuration:{profile,job_id:job}});
      const binding=await this.guards.state();await db.query('BEGIN');await this.fence(db,binding);
      const authorized=await this.profile(profile,scope);
      if(authorized.generation!==binding.generation||authorized.guard_epoch!==binding.epoch||operation.generation!==binding.generation)throw new HttpError(409,'guard_context_changed');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803368))',[scheduleId(profile,job)]);
      const saved=(await db.query("SELECT state,fire_reason FROM managed_runs WHERE event_id=$1 AND channel='scheduler'",[operation.id])).rows[0];
      if(saved){await db.query('COMMIT');return {event_id:operation.id,state:saved.state,fire_reason:saved.fire_reason,duplicate:true};}
      const current=(await db.query(`SELECT s.*,v.document_hash,v.prompt_reference,v.configuration FROM workflow_schedules s
        JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1 FOR SHARE OF s`,[scheduleId(profile,job)])).rows[0];
      if(!current||current.document_hash!==version||current.scope!==scope||current.configuration.removed||
        !current.configuration.enabled&&reason==='scheduled')throw new HttpError(409,'schedule_definition_changed');
      const prompt=current.prompt_reference as DerivativeReference;
      if(binding.mode==='on')await this.guards.read('derived_artifacts:'+prompt.id,binding);
      const busy=(await db.query("SELECT 1 FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2 AND state IN ('captured','running')",[profile,job])).rowCount;
      const effective=busy?'overlap':reason,missed=['missed','overlap'].includes(effective);
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,
        owner_epoch,job_id,schedule_version,trigger_reference,fire_reason,state,error_code)
        VALUES($1,'scheduler',$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[operation.id,operation,scope,profile,
          'cron_'+job+'_'+operation.id.slice(0,24),binding,body.owner_epoch,job,current.version_id,output,effective,missed?'cancelled':'captured',missed?'scheduled_'+effective:null]);
      await requestWorkflow(db,'schedules','run:'+operation.id);await db.query('COMMIT');
      return {event_id:operation.id,state:missed?'cancelled':'captured',fire_reason:effective,duplicate:false};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'schedules');});}
  }
}
