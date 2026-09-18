import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import type {ExecutionAuthority} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository} from './derived.js';
import type {GuardBinding} from './guards.js';
import type {RuntimeTurnRepository} from './turns.js';
import {OperationRepository} from './operations.js';
import {ManagedExecutionRepository,managedEventId,managedIdentity,type ManagedInput} from './managed-execution.js';
import type {ScheduleRepository} from './schedules.js';
import type {TelegramActionRepository} from './telegram-actions.js';

export class ScheduledRunRepository extends ManagedExecutionRepository {
  protected readonly channel='scheduler' as const;
  protected readonly family='schedules' as const;
  constructor(access:SourceAccessRepository,derived:DerivedRepository,turns:RuntimeTurnRepository,token:string,call:RuntimeCall,
    readonly schedules:ScheduleRepository,readonly actions:TelegramActionRepository){super(access,derived,turns,token,call);}
  protected async readiness(_row:any){return observation('completed','preparation');}
  private async version(row:any){
    const version=(await this.control.query('SELECT * FROM schedule_versions WHERE id=$1',[row.schedule_version])).rows[0];
    if(!version||version.schedule_id!==digest(canonical([row.logical_profile,row.job_id])))throw new HttpError(409,'schedule_definition_changed');return version;
  }
  protected async sourceAllowed(row:any,binding:GuardBinding){
    await new OperationRepository(this.control).verify(row.source_reference);
    const version=await this.version(row),active=(await this.control.query(`SELECT s.scope,v.execution_version,v.configuration FROM workflow_schedules s
      JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1`,[version.schedule_id])).rows[0];
    if(!active||active.scope!==row.scope||active.execution_version!==version.execution_version||active.configuration.removed||row.space_id!==row.scope)
      throw new HttpError(409,'schedule_definition_changed');
    const trigger=await this.derived.checkpoint('scheduled-trigger:'+row.event_id);
    if(!trigger||trigger.kind!=='scheduled_trigger'||trigger.id!==row.trigger_reference?.id||trigger.content_hash!==row.trigger_reference?.input_hash||
      canonical(trigger.operation_reference)!==canonical(row.source_reference)||trigger.content_hash!==row.source_reference.input_hash)
      throw new HttpError(409,'run_input_conflict');
    if(binding.mode==='on')await this.guards.read('derived_artifacts:'+version.prompt_reference.id,binding);
  }
  protected override async contextDetails(row:any){const version=await this.version(row);
    return {logical_profile:row.logical_profile,job_id:row.job_id,job_revision:version.document_hash,definition:version.configuration};}
  protected async build(row:any){
    await this.current(row);const principal=this.principal(row),version=await this.version(row);
    await this.turns.register(principal,{logical_profile:row.logical_profile,job:row.job_id});
    let text:string;
    if(row.binding.mode==='on')text=string(object((await this.guards.read('derived_artifacts:'+version.prompt_reference.id,row.binding)).value).text,100000);
    else {
      const prompt=await this.derived.checkpoint('schedule-prompt:'+version.id);
      if(!prompt||prompt.id!==version.prompt_reference.id||prompt.content_hash!==version.prompt_reference.input_hash)throw new HttpError(409,'run_input_conflict');
      text=prompt.content.toString();
    }
    const input:ManagedInput={principal,text,transcripts:[],files:[],source_key:'nocheh:operation:'+row.event_id};
    await this.turns.prepared.allow(principal,input);
    const reference=await this.derived.record({operation_id:'scheduler-input:'+row.event_id,source:row.source_reference,
      parents:[version.prompt_reference,row.trigger_reference],kind:'runtime_context',content:Buffer.from(canonical(input)),
      producer:'nocheh',producer_version:this.protocol,configuration:{binding:row.binding,profile:row.logical_profile,job_id:row.job_id},provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
  override async cancel(input:unknown){const row=await this.row(managedEventId(object(input).event_id));
    if(!row)throw new HttpError(404,'captured_run_not_found');return this.cancelRow(row.event_id);}
  async recoverExpired(){
    const rows=(await this.control.query("SELECT event_id FROM managed_runs WHERE channel='scheduler' AND state='running' AND (lease_until IS NULL OR lease_until<=now()) ORDER BY event_id LIMIT 100")).rows;
    for(const {event_id:id} of rows){const row=await this.row(id);if(!await this.recover(row))await this.interrupt(id,'execution_interrupted');}
    return {recovered:true,count:rows.length};
  }
  async history(input:unknown){const body=object(input),profile=managedIdentity(body.profile),job=managedIdentity(body.job_id);
    const rows=(await this.control.query("SELECT * FROM managed_runs WHERE channel='scheduler' AND logical_profile=$1 AND job_id=$2 ORDER BY created_at DESC,event_id DESC LIMIT 100",[profile,job])).rows;
    const runs=[];
    for(const row of rows){const observed=await this.observe({event_id:row.event_id,scope:row.scope,profile});
      let session=null;if(observed.visible&&row.result_reference){const receipt=await this.derived.checkpoint('scheduler-result:'+row.event_id);session=receipt?JSON.parse(receipt.content.toString()).session:null;}
      runs.push({event_id:row.event_id,state:row.state,created_at:row.created_at,error_code:row.error_code,text:observed.text,
        native_session:session,payload:{profile:observed.visible?this.turns.profile(this.principal(row),row.binding):null,logical_profile:profile}});
    }return {runs};
  }
  async delivery(input:unknown){return this.actions.requestScheduled({admin:true,scope:null},managedEventId(object(input).event_id));}
  override async run(id:string,authority:ExecutionAuthority):Promise<Observation>{const result=await super.run(id,authority);
    if(result.state==='completed')await this.delivery({event_id:id});return result;}
  async operation(job:string,authority:ExecutionAuthority):Promise<Observation>{
    if(job.startsWith('run:'))return this.run(managedEventId(job.slice(4)),authority);
    const match=/^schedule:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(job);if(!match)return observation('failed','admission');
    const row=(await this.control.query(`SELECT s.*,v.prompt_reference,v.configuration FROM workflow_schedules s
      JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1`,[match[1]])).rows[0];
    if(!row||row.cursor!==match[2])return observation('skipped','schedule');
    const binding=await this.guards.state();await this.profile(row.scope,row.scope,row.logical_profile,binding);
    if(binding.mode==='on')await this.guards.prepare(row.prompt_reference,this.schedules.detectorVersion,this.schedules.detect);
    const ownership=await this.schedules.ownership();
    if(ownership.owner!==authority.owner||ownership.epoch!==authority.epoch||!ownership.admission)return observation('waiting','schedule',0,Date.now()+30000,'owner_paused');
    const result=await this.call('schedule.advance',{logical_profile:row.logical_profile,job_id:row.job_id,cursor:row.cursor,owner_epoch:authority.epoch},20000);
    if(!['waiting','completed','skipped'].includes(String(result.state))||result.state==='waiting'&&(!Number.isSafeInteger(result.next_attempt)||Number(result.next_attempt)<0))
      throw new HttpError(503,'invalid_schedule_observation');
    return observation(result.state as 'waiting'|'completed'|'skipped','schedule',0,result.state==='waiting'?Number(result.next_attempt):Date.now(),result.state==='waiting'?'prerequisite':null);
  }
}
