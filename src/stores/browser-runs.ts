import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {SourceRepository} from './retrieval.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {PreparationRepository} from './preparation.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {GuardBinding} from './guards.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';

export const managedStorageSchema=`
CREATE TABLE IF NOT EXISTS managed_runs (
 event_id text PRIMARY KEY,channel text NOT NULL CHECK(channel IN ('browser','scheduler')),
 source_reference jsonb NOT NULL,scope text NOT NULL,space_id text NOT NULL,logical_profile text NOT NULL,conversation_id text NOT NULL,
 binding jsonb NOT NULL,state text NOT NULL DEFAULT 'captured' CHECK(state IN ('captured','running','done','failed','cancelled','interrupted')),
 admitted boolean NOT NULL DEFAULT true,actor text,owner_epoch integer,lease_until timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,input_reference jsonb,result_reference jsonb,error_code text,job_id text,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_conversation_busy ON managed_runs(scope,logical_profile,conversation_id)
 WHERE admitted AND state IN ('captured','running');
CREATE INDEX IF NOT EXISTS managed_run_lease ON managed_runs(lease_until) WHERE state='running';
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS launch_requested_at timestamptz;
`;
const protocol='managed-browser-v2',closed=new Set(['done','failed','cancelled','interrupted']);
const identity=(value:unknown)=>{const id=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HttpError(400,'invalid_run_identity');return id;};
const eventId=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_run_identity');return id;};
type Input={principal:Reader;text:string;transcripts:string[];files:Record<string,unknown>[];source_key:string};

/** Original input stays in archive; generated input/results and execution metadata
 * are accessed through separate repositories, with no cross-store SQL. */
export class BrowserRunRepository {
  constructor(readonly access:SourceAccessRepository,readonly sources:SourceRepository,readonly derived:DerivedRepository,
    readonly preparation:PreparationRepository,readonly turns:RuntimeTurnRepository,readonly token:string,readonly call:RuntimeCall){}
  private get control(){return this.access.stores.control;}
  private get guards(){return this.access.guards;}
  private async row(id:string){return (await this.control.query("SELECT * FROM managed_runs WHERE event_id=$1 AND channel='browser'",[id])).rows[0];}
  private scope(value:unknown){const scope=string(value,64),policy=this.access.policy();
    if(!policy.owner_id||scope!==policy.owner_id&&!policy.group_ids.includes(scope))throw new HttpError(403,'run_scope_denied');return scope;}
  private principal(row:any):Reader {return {admin:false,scope:row.scope===this.access.policy().owner_id?null:row.scope,space:row.space_id,
    turnEvent:row.event_id,logical_profile:row.logical_profile,generation:row.binding.generation,guard_epoch:row.binding.epoch,revision:row.binding.epoch};}
  private async scoped(input:unknown){const body=object(input),id=eventId(body.event_id),scope=this.scope(body.scope),profile=identity(body.profile),row=await this.row(id);
    if(!row||row.scope!==scope)throw new HttpError(404,'captured_run_not_found');
    if(profile!==row.logical_profile||body.conversation!==undefined&&body.conversation!==row.conversation_id)throw new HttpError(403,'run_profile_mismatch');return row;}
  private async profile(scope:string,space:string,profile:string,binding:GuardBinding){
    const entry=await new RuntimeProfileRepository(this.access).resolve({admin:true,scope:null},{profile,space});
    if(entry.logical_profile!==profile||entry.scope!==scope)throw new HttpError(403,'profile_scope_denied');
    if(entry.generation!==binding.generation||entry.guard_epoch!==binding.epoch)throw new HttpError(409,'guard_context_changed');
  }
  private async current(row:any){this.scope(row.scope);await this.guards.assertCurrent(row.binding);
    await this.profile(row.scope,row.space_id,row.logical_profile,row.binding);
    if(!await this.access.canRead(this.principal(row),row.source_reference,row.binding)||await this.access.space(row.source_reference)!==row.space_id)
      throw new HttpError(403,'turn_source_denied');await this.guards.assertCurrent(row.binding);}
  private async fence(db:pg.PoolClient,binding:GuardBinding){
    const row=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(!row||canonical({generation:row.generation,epoch:Number(row.epoch),mode:row.mode})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
    if((await db.query("SELECT 1 FROM guard_publications WHERE state='pending' LIMIT 1")).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async admit(principal:Reader,input:unknown){
    admin(principal);const body=object(input),id=eventId(body.event_id),scope=this.scope(body.scope),profile=identity(body.profile);
    const source=(await this.access.archive.captured(id)).reference,original=(await this.access.stores.archive.query('SELECT channel,kind,origin,scope,payload FROM events WHERE id=$1',[id])).rows[0];
    if(original.channel!=='browser'||original.kind!=='browser_input'||original.origin!=='live'||original.scope!==scope)throw new HttpError(403,'browser_original_required');
    const payload=JSON.parse(original.payload.toString()),space=await this.access.space(source);
    if(payload.profile!==profile||body.conversation!==undefined&&body.conversation!==payload.conversation_id)throw new HttpError(403,'run_profile_mismatch');
    if(!space||payload.space!==space)throw new HttpError(403,'run_scope_denied');
    const intake=(await this.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[id])).rows[0];
    if(!intake||intake.state!=='ready')throw new HttpError(409,'capture_handoff_pending');
    if(intake.transport!=='capture')throw new HttpError(403,'browser_original_required');
    const db=await this.control.connect();let held=false;
    try {
      const owner=(await db.query("SELECT * FROM workflow_owners WHERE family='browser'")).rows[0];
      held=await enterFamily(db,'browser',owner.owner,owner.epoch);if(!held)throw new HttpError(409,'workflow_owner_changed');
      await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,803366))",[canonical([scope,profile,payload.conversation_id])]);
      const binding=await this.guards.state();await this.fence(db,binding);
      await this.profile(scope,space,profile,binding);
      const saved=(await db.query('SELECT * FROM managed_runs WHERE event_id=$1 FOR UPDATE',[id])).rows[0];
      if(saved){await db.query('COMMIT');return {owned:true,event_id:id,state:saved.state};}
      if(scope!==this.access.policy().owner_id&&payload.revision!==binding.epoch)throw new HttpError(409,'browser_audience_changed');
      if((await db.query("SELECT 1 FROM managed_runs WHERE scope=$1 AND logical_profile=$2 AND conversation_id=$3 AND state IN ('captured','running')",[scope,profile,payload.conversation_id])).rowCount)
        throw new HttpError(409,'session_busy');
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,owner_epoch)
        VALUES($1,'browser',$2,$3,$4,$5,$6,$7,$8)`,[id,source,scope,space,profile,payload.conversation_id,binding,owner.epoch]);
      await requestWorkflow(db,'browser',id);await db.query('COMMIT');return {owned:true,event_id:id,state:'captured'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'browser');});}
  }
  /** Capture/admission is not a prepared execution context. Bind after initial
   * extraction/selection, before the first native request can exist. */
  private async bindPrepared(row:any,epoch:number){
    if((await this.preparation.status(row.event_id)).state!=='completed')throw new HttpError(409,'run_preparation_pending');
    const binding=await this.guards.state();this.scope(row.scope);
    await this.profile(row.scope,row.space_id,row.logical_profile,binding);
    if(binding.generation!==row.binding.generation)throw new HttpError(409,'audience_context_changed');
    if(await this.access.space(row.source_reference)!==row.space_id)throw new HttpError(403,'turn_source_denied');
    const db=await this.control.connect();try{await db.query('BEGIN');await this.fence(db,binding);
      const owner=(await db.query("SELECT * FROM workflow_owners WHERE family='browser' FOR SHARE")).rows[0];
      if(owner.owner!=='inngest'||!owner.admission||owner.epoch!==epoch||row.owner_epoch!==epoch)throw new HttpError(409,'workflow_owner_changed');
      await db.query(`UPDATE managed_runs SET binding=$2,launch_requested_at=now(),revision=revision+1,updated_at=now()
        WHERE event_id=$1 AND state='captured' AND NOT cancel_requested AND launch_requested_at IS NULL`,[row.event_id,binding]);
      const saved=(await db.query('SELECT * FROM managed_runs WHERE event_id=$1',[row.event_id])).rows[0];
      if(saved.state!=='captured'||saved.cancel_requested)throw new HttpError(409,'run_lease_lost');
      await db.query('COMMIT');await this.current(saved);return saved;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async context(input:unknown){const body=object(input);let row=await this.row(eventId(body.event_id));
    const owner=(await this.control.query("SELECT * FROM workflow_owners WHERE family='browser'")).rows[0];
    if(!row?.admitted||owner.owner!=='inngest'||!owner.admission||owner.epoch!==body.owner_epoch||row.owner_epoch!==owner.epoch)throw new HttpError(409,'workflow_owner_changed');
    if(row.state==='captured'&&!row.launch_requested_at)row=await this.bindPrepared(row,owner.epoch);
    await this.current(row);return {event_id:row.event_id,scope:row.scope,space:row.space_id,profile:row.logical_profile,conversation:row.conversation_id,
      revision:row.binding.epoch,generation:row.binding.generation,actor:'run_'+row.event_id,owner_epoch:owner.epoch,storage_layout:'original-only-v1'};
  }
  private async build(row:any):Promise<{reference:DerivativeReference;input:Input}>{
    const principal=this.principal(row);await this.current(row);
    if((await this.preparation.status(row.event_id)).state!=='completed')throw new HttpError(409,'run_preparation_pending');
    await this.turns.register(principal,{logical_profile:row.logical_profile});
    const selected=await this.sources.read(principal,row.event_id),transcripts:string[]=[],files:Record<string,unknown>[]=[],parents:DerivativeReference[]=[];
    for(const result of selected.derived){const hash=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[result.id])).rows[0].content_hash;
      parents.push({store:'derived',kind:'artifact',id:result.id,input_hash:hash});if(result.kind==='transcript')transcripts.push(Buffer.from(result.content_base64,'base64').toString());}
    const manifests=(await this.access.stores.archive.query('SELECT id,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[row.event_id])).rows;
    for(const file of selected.artifacts){const hash=manifests.find(m=>m.id===file.id)?.file_hash;if(!hash)throw new HttpError(409,'source_file_pending');
      const extracted=selected.derived.find(d=>d.artifact_id===file.id&&d.kind==='extracted_text');
      files.push({id:file.id,sha256:hash,name:typeof file.metadata.file_name==='string'?file.metadata.file_name:'Attachment',
        kind:row.binding.mode==='off'&&file.kind==='image'?'image':'file',text:extracted?Buffer.from(extracted.content_base64,'base64').toString():null});}
    const input:Input={principal,text:selected.event.text??'',transcripts,files,source_key:'nocheh:event:'+row.event_id};
    const reference=await this.derived.record({operation_id:'browser-input:'+row.event_id,source:row.source_reference,kind:'runtime_context',
      content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,configuration:{binding:row.binding,profile:row.logical_profile},
      ...(parents.length?{parents}:{}),provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
  private async savedInput(row:any):Promise<Input>{
    const ref=row.input_reference,data=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[ref?.id])).rows[0];
    if(!data||data.content_hash!==ref.input_hash||digest(data.content)!==ref.input_hash)throw new HttpError(409,'run_input_conflict');return JSON.parse(data.content.toString());
  }
  async claim(input:unknown){
    if(this.token.length<24)throw new HttpError(503,'service_credential_required');
    const body=object(input);await this.context(body);const row=await this.scoped(body);
    if(body.actor!=='run_'+row.event_id)throw new HttpError(403,'run_actor_mismatch');
    if(row.state!=='captured')return {claimed:false,event_id:row.event_id,state:row.state};
    const built=await this.build(row),db=await this.control.connect();let held=false;
    try {
      held=await enterFamily(db,'browser','inngest',Number(body.owner_epoch));if(!held)throw new HttpError(409,'workflow_owner_changed');
      await db.query('BEGIN');await this.fence(db,row.binding);
      const owner=(await db.query("SELECT * FROM workflow_owners WHERE family='browser' FOR SHARE")).rows[0];
      if(owner.owner!=='inngest'||!owner.admission||owner.epoch!==body.owner_epoch)throw new HttpError(409,'workflow_owner_changed');
      const changed=await db.query(`UPDATE managed_runs SET state='running',actor=$2,owner_epoch=$3,input_reference=$4,
        lease_until=now()+interval '60 seconds',revision=revision+1,updated_at=now() WHERE event_id=$1 AND state='captured' AND NOT cancel_requested RETURNING event_id`,
        [row.event_id,body.actor,body.owner_epoch,built.reference]);
      if(!changed.rowCount){await db.query('COMMIT');return {claimed:false,event_id:row.event_id,state:(await this.row(row.event_id)).state};}
      await db.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state) SELECT id,'browser',1,'started' FROM workflow_registry WHERE family='browser' AND job_id=$1
        ON CONFLICT(workflow_id,step,attempt) DO NOTHING`,[row.event_id]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'browser');});}
    await this.current(row);await this.turns.binding(built.input.principal);
    return {claimed:true,event_id:row.event_id,state:'running',channel:'browser',scope:row.scope,owner:row.scope===this.access.policy().owner_id,
      guard_mode:row.binding.mode,text:built.input.text,source_key:built.input.source_key,payload:{profile:row.logical_profile,space:row.space_id,conversation_id:row.conversation_id},
      archive_credential:await this.turns.prepared.audience.turn(this.token,built.input.principal,row.event_id,Date.now()+600000)};
  }
  async prepare(input:unknown){const row=await this.scoped(input);await this.leased(row,object(input));const saved=await this.savedInput(row);
    await this.turns.binding(saved.principal);await this.current(row);return {transcripts:saved.transcripts,files:saved.files};}
  private async leased(row:any,body:Record<string,unknown>){
    if(row.actor!==body.actor||row.owner_epoch!==body.owner_epoch||row.state!=='running'||!row.lease_until||row.lease_until<=new Date()||row.cancel_requested)
      throw new HttpError(409,'run_lease_lost');await this.context(body);await this.current(row);
  }
  async heartbeat(input:unknown){const body=object(input),row=await this.scoped(body);
    if(row.cancel_requested)return {event_id:row.event_id,state:row.state,cancel_requested:true};
    await this.leased(row,body);const db=await this.control.connect();try{await db.query('BEGIN');await this.fence(db,row.binding);
      const changed=await db.query(`UPDATE managed_runs SET lease_until=now()+interval '60 seconds',updated_at=now() WHERE event_id=$1 AND actor=$2
        AND owner_epoch=$3 AND state='running' AND lease_until>now() AND NOT cancel_requested RETURNING event_id`,[row.event_id,body.actor,body.owner_epoch]);
      if(!changed.rowCount)throw new HttpError(409,'run_lease_lost');await db.query('COMMIT');return {event_id:row.event_id,state:'running',cancel_requested:false};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
  private async complete(row:any,result:any,reference:DerivativeReference){
    const db=await this.control.connect();try{await db.query('BEGIN');
      const saved=(await db.query('SELECT * FROM managed_runs WHERE event_id=$1 FOR UPDATE',[row.event_id])).rows[0];
      if(saved.result_reference){if(canonical(saved.result_reference)!==canonical(reference))throw new HttpError(409,'run_result_conflict');await db.query('COMMIT');return {event_id:row.event_id,state:saved.state,duplicate:true};}
      // Retain late evidence without claiming that its execution stayed supervised.
      const guard=(await db.query('SELECT i.generation,g.epoch FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
      const interrupted=saved.state==='interrupted'||!saved.lease_until||saved.lease_until<=new Date()||guard.generation!==row.binding.generation||Number(guard.epoch)!==row.binding.epoch;
      const state=interrupted?'interrupted':saved.cancel_requested?'cancelled':result.state;
      await db.query(`UPDATE managed_runs SET state=$2,result_reference=$3,error_code=$4,lease_until=NULL,revision=revision+1,updated_at=now() WHERE event_id=$1`,
        [row.event_id,state,reference,interrupted?'execution_interrupted':result.error_code]);
      await db.query("UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=$1 AND state='open'",[row.event_id]);
      await db.query(`UPDATE workflow_receipts SET state=$2,receipt_id=$3,updated_at=now() WHERE step='browser' AND workflow_id IN
        (SELECT id FROM workflow_registry WHERE family='browser' AND job_id=$1) AND state IN ('started','ambiguous')`,[row.event_id,state==='done'?'done':state==='interrupted'?'ambiguous':'failed',reference.id]);
      await db.query('COMMIT');return {event_id:row.event_id,state,duplicate:false};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async finish(input:unknown){const body=object(input),row=await this.row(eventId(body.event_id));
    if(!row?.actor||row.actor!==body.actor||!row.input_reference)throw new HttpError(403,'run_actor_mismatch');
    const state=string(body.state,32);if(!closed.has(state))throw new HttpError(400,'invalid_run_state');
    const code=body.error_code===null||body.error_code===undefined?null:['managed_execution_failed','runtime_execution_interrupted','execution_interrupted','model_unavailable','intentional_silence'].includes(String(body.error_code))?body.error_code:'managed_execution_failed';
    const result={state,text:string(body.text??'',1000000),session:identity(body.session),error_code:code};
    const reference=await this.derived.record({operation_id:'browser-result:'+row.event_id,source:row.source_reference,parents:[row.input_reference],
      kind:'browser_result',content:Buffer.from(canonical(result)),producer:'hermes',producer_version:protocol,configuration:{binding:row.binding},
      provenance:{actor:row.actor,input:row.input_reference}});
    return this.complete(row,result,reference);
  }
  private async recover(row:any){const result=await this.derived.checkpoint('browser-result:'+row.event_id);
    if(!result)return false;
    if(result.kind!=='browser_result'||result.producer!=='hermes'||result.producer_version!==protocol||digest(result.content)!==result.content_hash||
      result.provenance.actor!==row.actor||canonical(result.provenance.input)!==canonical(row.input_reference)||canonical(result.provenance.source)!==canonical(row.source_reference))throw new HttpError(409,'run_result_conflict');
    await this.complete(row,JSON.parse(result.content.toString()),{store:'derived',kind:'artifact',id:result.id,input_hash:result.content_hash});return true;
  }
  async observe(input:unknown){const row=await this.scoped(input);let visible=true;
    try{await this.current(row);}catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;visible=false;}
    if(row.cancel_requested||row.state==='interrupted'||row.state==='running'&&(!row.lease_until||row.lease_until<=new Date()))visible=false;
    let text='';if(visible&&row.result_reference){const result=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0];
      if(!result||digest(result.content)!==row.result_reference.input_hash)throw new HttpError(409,'run_result_conflict');text=JSON.parse(result.content.toString()).text;}
    if(visible)await this.current(row);return {event_id:row.event_id,state:row.state,admitted:true,visible,text,conversation:row.conversation_id,owner_epoch:row.owner_epoch};}
  async active(input:unknown){const body=object(input),scope=this.scope(body.scope),profile=identity(body.profile),conversation=identity(body.conversation);
    const row=(await this.control.query("SELECT event_id FROM managed_runs WHERE channel='browser' AND scope=$1 AND logical_profile=$2 AND conversation_id=$3 AND state IN ('captured','running') ORDER BY created_at DESC LIMIT 1",[scope,profile,conversation])).rows[0];
    return row?{active:true,...await this.observe({...body,event_id:row.event_id})}:{active:false,event_id:null};}
  async cancel(input:unknown){return this.cancelRow((await this.scoped(input)).event_id);}
  private async cancelRow(id:string){const db=await this.control.connect();try{await db.query('BEGIN');
    await db.query("UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,revision=revision+1,updated_at=now() WHERE event_id=$1 AND state IN ('captured','running')",[id]);
    await db.query("UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=$1 AND state='open'",[id]);await db.query('COMMIT');return {cancel_requested:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
  private async interrupt(id:string,code:string){const db=await this.control.connect();try{await db.query('BEGIN');
    await db.query("UPDATE managed_runs SET state='interrupted',error_code=$2,lease_until=NULL,revision=revision+1,updated_at=now() WHERE event_id=$1 AND state IN ('captured','running')",[id,code]);
    await db.query("UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=$1 AND state='open'",[id]);
    await db.query("UPDATE workflow_receipts SET state='ambiguous',updated_at=now() WHERE step='browser' AND state='started' AND workflow_id IN (SELECT id FROM workflow_registry WHERE family='browser' AND job_id=$1)",[id]);
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
  private status(row:any):Observation{return observation(row.state==='captured'?'waiting':row.state==='done'?'completed':row.state==='interrupted'?'ambiguous':row.state,
    row.state==='captured'?'admission':'assistant',row.actor?1:0,Date.now()+1000,row.state==='running'?'receipt_pending':row.state==='captured'?'prerequisite':null);}
  async run(id:string,authority:ExecutionAuthority):Promise<Observation>{
    const db=await this.control.connect();let held=false,locked=false;try{
      held=await enterFamily(db,'browser',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803367)) AS locked',[id])).rows[0].locked;
      if(!locked)return observation('waiting','admission',0,Date.now()+1000,'receipt_pending');
      let row=await this.row(id);if(!row)return observation('skipped','admission');
      if(row.input_reference&&!row.result_reference&&await this.recover(row))row=await this.row(id);
      if(closed.has(row.state))return this.status(row);
      if(row.state==='captured'&&!row.launch_requested_at&&!row.cancel_requested&&row.owner_epoch===authority.epoch){
        const ready=await this.preparation.status(id);if(ready.state!=='completed')return observation('waiting',ready.stage,0,ready.next_attempt,'prerequisite');
        try{row=await this.bindPrepared(row,authority.epoch);}catch(error){
          if(!(error instanceof HttpError)||!['profile_not_found','profile_scope_denied'].includes(error.code))throw error;
          await this.cancelRow(id);return this.status(await this.row(id));
        }
      }
      let current=row.owner_epoch===authority.epoch;try{await this.current(row);}catch(error){if(!(error instanceof HttpError))throw error;current=false;}
      const body={channel:'browser',event_id:id,attempt:1,owner_epoch:row.owner_epoch??authority.epoch,asynchronous:true};
      if(!current||row.cancel_requested){
        await this.cancelRow(id);
        try{await this.call('run.cancel',body,10000);}catch{}
        row=await this.row(id);if(row.state==='captured'||row.state==='cancelled')return this.status(row);
      }
      if(row.state==='captured'){
        const ready=await this.preparation.status(id);if(ready.state!=='completed')return observation('waiting',ready.stage,0,ready.next_attempt,'prerequisite');
      }
      try {
        const native=await this.call('run.resume',{...body,observe_only:true},10000);
        if(current&&!row.cancel_requested&&row.state==='captured'&&['not_found','queued'].includes(String(native.state)))await this.call('run.start',body,10000);
        else if(native.state==='not_found'&&row.state==='running'||['ambiguous','failed','cancelled','done'].includes(String(native.state))) {
          await this.interrupt(id,'runtime_receipt_missing');
        }
      }catch{return observation('waiting','assistant',row.actor?1:0,Date.now()+30000,'runtime_unavailable');}
      row=await this.row(id);
      if(row.state==='running'&&row.lease_until<=new Date()){
        await this.interrupt(id,'execution_interrupted');row=await this.row(id);
      }
      return this.status(row);
    }finally{await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803367))',[id]);if(held)await leaveFamily(db,'browser');});}
  }
}
