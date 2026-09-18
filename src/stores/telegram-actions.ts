import {blockingPublications} from './publications.js';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {evaluate,recordEffect} from '../security/store.js';
import type {Effect} from '../security/contract.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import type {StorePools} from './connections.js';
import type {SourceReference} from './archive.js';
import {OperationRepository,type OperationReference} from './operations.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository} from './derived.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';

const protocol='telegram-action-v2';
export class TelegramActionRepository {
  constructor(readonly stores:StorePools,readonly access:SourceAccessRepository,readonly derived:DerivedRepository,
    readonly guards:GuardRepository,readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>){}
  private async row(id:string) {
    if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_action');
    const row=(await this.stores.control.query('SELECT * FROM telegram_action_requests WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');return row;
  }
  private effect(row:any):Effect {return {id:row.id,kind:'telegram.send',scope:row.scope,profile:row.profile,fingerprint:row.fingerprint};}
  private async text(row:any,current=true):Promise<string> {
    if(current)await this.guards.assertCurrent(row.binding);
    const source=(await this.stores.derived.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[row.proposal_reference.id])).rows[0];
    if(source?.content_hash!==row.proposal_reference.input_hash)throw new HttpError(409,'action_proposal_changed');
    let value:any;
    if(row.guard_revision===null) {
      value=JSON.parse((await this.stores.derived.query('SELECT input FROM guard_sources WHERE id=$1',['derived_artifacts:'+row.proposal_reference.id])).rows[0]?.input.toString()??'null');
    } else {
      const guarded=(await this.stores.derived.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',
        ['derived_artifacts:'+row.proposal_reference.id,row.guard_revision])).rows[0];value=guarded?JSON.parse(guarded.content.toString()):null;
    }
    if(typeof value?.text!=='string'||digest(value.text)!==row.text_hash||digest(canonical({destination:row.destination,text:value.text}))!==row.fingerprint)
      throw new HttpError(409,'action_proposal_changed');
    if(current) {
      const active=await this.guards.read('derived_artifacts:'+row.proposal_reference.id,row.binding);
      if(active.revision!==row.guard_revision||digest(String((active.value as any).text))!==row.text_hash)throw new HttpError(409,'action_proposal_changed');
      await this.guards.assertCurrent(row.binding);
    }
    return value.text;
  }
  private async fence(db:pg.PoolClient,binding:GuardBinding) {
    const state=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(!state||canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode})!==canonical(binding))throw new HttpError(409,'action_context_changed');
    if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async request(principal:Reader,value:unknown) {
    if(principal.admin||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'external_effect_scope_denied');
    const turn=await this.turns.binding(principal),binding=await this.guards.state(),source=await this.prepared.root(principal,binding),input=object(value);
    if(Object.keys(input).some(key=>!['destination','text'].includes(key)))throw new HttpError(400,'invalid_action');
    let channel:string|undefined;
    if(source.store==='archive') {
      const original=await this.access.archive.verify(source),intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
      if(original.origin!=='live'||intake?.transport==='import'||intake?.state==='pending')throw new HttpError(403,'external_effect_requires_live_turn');
      channel=original.channel;
    }
    return this.propose(principal,turn,binding,source,input,channel);
  }
  /** Only a trusted completion path can stage delivery from a closed scheduled
   * run. This creates an exact proposal; it never reopens the runtime capability. */
  async requestScheduled(principal:Reader,id:string){
    admin(principal);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_run_identity');
    const row=(await this.stores.control.query("SELECT * FROM managed_runs WHERE event_id=$1 AND channel='scheduler'",[id])).rows[0];
    if(!row||row.state!=='done'||row.cancel_requested||!row.result_reference)return {state:'withheld',reason:'run_not_complete'};
    try{await this.guards.assertCurrent(row.binding);}catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;return {state:'withheld',reason:'guard_context_changed'};}
    const version=(await this.stores.control.query(`SELECT v.*,a.execution_version AS active_execution,a.configuration AS active_configuration
      FROM schedule_versions v JOIN workflow_schedules s ON s.id=v.schedule_id JOIN schedule_versions a ON a.id=s.version_id WHERE v.id=$1`,[row.schedule_version])).rows[0];
    if(!version||version.execution_version!==version.active_execution||version.active_configuration.removed)return {state:'withheld',reason:'schedule_definition_changed'};
    const selected=await new RuntimeProfileRepository(this.access).resolve(principal,{profile:row.logical_profile});
    if(selected.logical_profile!==row.logical_profile||selected.scope!==row.scope||row.space_id!==row.scope)throw new HttpError(403,'profile_scope_denied');
    await new OperationRepository(this.stores.control).verify(row.source_reference);
    const result=await this.derived.checkpoint('scheduler-result:'+id);
    if(!result||result.id!==row.result_reference.id||result.content_hash!==row.result_reference.input_hash||result.kind!=='scheduled_result'||
      result.producer!=='hermes'||result.producer_version!=='managed-scheduler-v2'||canonical(result.operation_reference)!==canonical(row.source_reference))
      throw new HttpError(409,'run_result_conflict');
    const output=JSON.parse(result.content.toString());if(output.state!=='done')return {state:'withheld',reason:'run_not_complete'};
    const text=string(output.text,1000000);if(version.configuration.deliver!=='telegram'||!text.trim())return {state:'local'};
    if(text.length>3500)return {state:'withheld',reason:'result_exceeds_telegram_limit'};
    const audience:Reader={admin:false,scope:row.scope===this.access.policy().owner_id?null:row.scope,space:row.space_id,
      turnEvent:row.event_id,logical_profile:row.logical_profile,generation:row.binding.generation,guard_epoch:row.binding.epoch,revision:row.binding.epoch};
    return this.propose(audience,{scope:row.scope,logical_profile:row.logical_profile},row.binding,row.source_reference,{destination:row.scope,text});
  }
  private async propose(principal:Reader,turn:{scope:string;logical_profile:string},binding:GuardBinding,
    source:SourceReference|OperationReference,input:Record<string,unknown>,channel?:string){
    const requested=string(input.destination,32),destination=requested==='current'&&channel==='telegram'?turn.scope:requested,text=string(input.text,3500);
    if(!/^-?[1-9]\d{0,18}$/.test(destination)||!text.trim())throw new HttpError(400,'invalid_action');
    const id=digest(canonical([protocol,source,binding,destination,text]));
    const proposal=await this.derived.record({operation_id:'telegram-proposal:'+id,source,kind:'action_request',content:Buffer.from(text),
      producer:'nocheh',producer_version:protocol,configuration:{destination,binding},provenance:{purpose:'exact_owner_approval'}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),preparedText=string((representation.value as any).text,3500);
    if(!preparedText.trim())throw new HttpError(400,'invalid_action');
    const fingerprint=digest(canonical({destination,text:preparedText})),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');await this.fence(db,binding);
      await db.query(`INSERT INTO telegram_action_requests(id,source_reference,proposal_reference,binding,scope,space_id,profile,destination,fingerprint,text_hash,guard_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [id,source,proposal,binding,turn.scope,principal.space,turn.logical_profile,destination,fingerprint,digest(preparedText),representation.revision]);
      const row=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1',[id])).rows[0];
      if(row.fingerprint!==fingerprint||canonical(row.proposal_reference)!==canonical(proposal))throw new HttpError(409,'action_proposal_changed');
      const effect=this.effect(row),decision=await evaluate(db,effect);await recordEffect(db,effect,'proposed',decision,source);
      await recordEffect(db,effect,decision.outcome==='deny'?'blocked':'awaiting_approval',decision,source);
      await db.query('COMMIT');return {id,state:row.state,fingerprint,message:'Owner approval is required for this exact message and destination.'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async inspect(principal:Reader,id:string) {
    const row=await this.row(id);
    if(!principal.admin) {
      await this.turns.binding(principal);
      if(principal.turnEvent!==row.source_reference.id||principal.space!==row.space_id)throw new HttpError(404,'action_not_found');
    }
    const text=await this.text(row,!principal.admin),result=row.result_reference?(await this.stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0]:null;
    if(!principal.admin){await this.prepared.allow(principal,{text});await this.turns.assertAudience(principal);}
    return {id:row.id,event_id:row.source_reference.id,scope:row.scope,profile:row.profile,kind:'telegram_message',arguments:{destination:row.destination,text},
      fingerprint:row.fingerprint,state:row.state,revision:row.revision,error_code:row.error_code,created_at:row.created_at,result:result?JSON.parse(result.content.toString()):null};
  }
  async list(principal:Reader) {
    admin(principal);const rows=(await this.stores.control.query('SELECT id FROM telegram_action_requests ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    return Promise.all(rows.map(row=>this.inspect(principal,row.id)));
  }
  /** Trusted native sender rechecks the exact approved payload immediately before sending. */
  async authorizeDelivery(value:unknown) {
    const body=object(value),row=await this.row(string(body.id,64));
    if(row.state!=='running'||body.destination!==row.destination||typeof body.text!=='string'||
      digest(canonical({destination:body.destination,text:body.text}))!==row.fingerprint)
      throw new HttpError(403,'action_delivery_denied');
    await this.text(row);
    if((await evaluate(this.stores.control,this.effect(row),'exact_owner_approval')).outcome!=='allow')
      throw new HttpError(403,'action_delivery_denied');
    await this.guards.assertCurrent(row.binding);return {valid:true};
  }
  async decide(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=object(value);
    if(Object.keys(body).some(key=>!['id','fingerprint','decision','operation_id','expected_revision'].includes(key))||
      !['approve','deny'].includes(String(body.decision)))throw new HttpError(400,'invalid_decision');
    const id=string(body.id,64),row=await this.row(id);
    if(body.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
    if(source)await this.access.archive.verify(source);
    const request={id,fingerprint:row.fingerprint,decision:body.decision,source:source??null},hash=digest(canonical(request));
    const operation=body.operation_id===undefined?'telegram-decision:'+hash:string(body.operation_id,200),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const current=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const prior=(await db.query('SELECT * FROM telegram_action_decisions WHERE operation_id=$1',[operation])).rows[0];
      if(prior) {
        if(prior.request_hash!==hash)throw new HttpError(409,'action_decision_conflict');
        await db.query('COMMIT');return {id,state:current.state,revision:current.revision};
      }
      if(body.expected_revision!==undefined&&body.expected_revision!==current.revision)throw new HttpError(409,'action_revision_changed');
      if(current.state!=='proposed')throw new HttpError(409,'action_already_started_or_closed');
      if(body.decision==='approve'){await this.fence(db,current.binding);await this.text(current);}
      const state=body.decision==='approve'?'approved':'rejected',revision=current.revision+1;
      await db.query('UPDATE telegram_action_requests SET state=$2,revision=$3,decision_reference=$4,updated_at=now() WHERE id=$1',[id,state,revision,source??null]);
      await db.query('INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision,source_reference) VALUES($1,$2,$3,$4,$5,$6)',[operation,hash,id,body.decision,revision,source??null]);
      if(state==='approved')await requestWorkflow(db,'actions',id);
      await db.query('COMMIT');return {id,state,revision};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    const db=await this.stores.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'actions',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803363)) AS held',[id])).rows[0].held;
      if(!locked)return observation('waiting','action',0,Date.now()+2000,'receipt_pending');
      let row=await this.row(id);
      if(['done','rejected','cancelled'].includes(row.state))return observation(row.state==='done'?'completed':row.state==='rejected'?'denied':'cancelled','action');
      if(row.state==='proposed')return observation('waiting','action',0,Date.now()+30000,'approval_required');
      if(row.next_attempt>new Date())return observation('waiting','action',0,row.next_attempt.getTime(),'receipt_pending');
      const observe=['running','ambiguous'].includes(row.state),effect=this.effect(row);
      let decision=row.security_decision,text:string|undefined;
      const finish=async(state:'done'|'denied'|'ambiguous',result:unknown)=>{
        await db.query('BEGIN');
        try {
          await db.query(`UPDATE telegram_action_requests SET state=$2,result_reference=$3,error_code=$4,next_attempt=now()+interval '60 seconds',revision=revision+1,updated_at=now() WHERE id=$1`,
            [id,state==='denied'?'rejected':state,result,state==='done'?null:state==='denied'?'action_delivery_denied':'delivery_unconfirmed']);
          if(decision)await recordEffect(db,effect,state==='done'?'completed':state==='denied'?'blocked':'ambiguous',decision,row.source_reference);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
        return observation(state==='done'?'completed':state==='denied'?'denied':'waiting',state==='ambiguous'?'reconcile':'action',1,Date.now()+60000,state==='ambiguous'?'receipt_pending':null);
      };
      const durable=await this.derived.checkpoint('telegram-action-result:'+id+':done')??await this.derived.checkpoint('telegram-action-result:'+id+':denied');
      if(durable) {
        const state=JSON.parse(durable.content.toString()).state;
        if(digest(durable.content)!==durable.content_hash||!['done','denied'].includes(state)||durable.content.toString()!==canonical({state}))throw new HttpError(409,'action_result_conflict');
        return await finish(state,{store:'derived',kind:'artifact',id:durable.id,input_hash:durable.content_hash});
      }
      if(!observe) {
        try{text=await this.text(row);}catch(error){
          if(error instanceof HttpError&&error.code==='guard_context_changed') {
            await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code='action_context_changed',revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved'",[id]);
            return observation('cancelled','action',0,Date.now(),'superseded');
          }throw error;
        }
        await db.query('BEGIN');
        try {
          await this.fence(db,row.binding);decision=await evaluate(db,effect,'exact_owner_approval',true);
          if(decision.outcome!=='allow') {
            await recordEffect(db,effect,'blocked',decision,row.source_reference);await db.query("UPDATE telegram_action_requests SET state='rejected',security_decision=$2,revision=revision+1,updated_at=now() WHERE id=$1",[id,decision]);
            await db.query('COMMIT');return observation('denied','action');
          }
          const claimed=await db.query("UPDATE telegram_action_requests SET state='running',security_decision=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved' AND revision=$3 RETURNING id",[id,decision,row.revision]);
          if(!claimed.rowCount)throw new HttpError(409,'action_changed');
          await recordEffect(db,effect,'allowed',decision,row.source_reference);await recordEffect(db,effect,'started',decision,row.source_reference);await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
      }
      let response:Record<string,unknown>;
      try {response=await this.call('action.execute',observe?{id,observe_only:true}:{id,destination:row.destination,text:text!},observe?10000:60000);}
      catch {response={state:'ambiguous'};}
      const state=response.state==='done'?'done':response.state==='denied'?'denied':'ambiguous',result=await this.derived.record({operation_id:'telegram-action-result:'+id+':'+(state==='ambiguous'?'uncertain':state),
        source:row.source_reference,parents:[row.proposal_reference],kind:'action_result',content:Buffer.from(canonical({state})),
        producer:'hermes',producer_version:protocol,configuration:{id},provenance:{binding:row.binding,native_receipt:id}});
      return await finish(state,result);
    }finally{await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803363))',[id]);if(held)await leaveFamily(db,'actions');});}
  }
}
