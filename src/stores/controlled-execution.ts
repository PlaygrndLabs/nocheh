import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {evaluate,recordEffect} from '../security/store.js';
import type {Decision} from '../security/contract.js';
import {enterFamily,leaveFamily,releaseOperation} from '../workflows/store.js';
import {hostActionAuthority} from '../workflows/host-tools.js';
import type {ControlledActionRepository} from './controlled-actions.js';

const protocol='controlled-execution-v2';
const operation=(id:string)=>'controlled-result:'+id;
const input=(value:unknown):Record<string,unknown>&{id:string;actor:string}=>{
  const body=object(value),id=string(body.id,64),actor=string(body.actor,128);
  if(!/^[a-f0-9]{64}$/.test(id)||!/^wf-[a-f0-9]{64}$/.test(actor))throw new HttpError(400,'invalid_action_identity');
  return {...body,id,actor};
};

/** One durable claim, one start, immutable derived receipt, then control completion. */
export class ControlledExecutionRepository {
  constructor(readonly actions:ControlledActionRepository){}
  get pool(){return this.actions.control;}
  private async lease(db:pg.PoolClient,b:any) {
    // Hold the orchestration lease and owner revision until domain admission commits.
    const row=(await db.query(`SELECT w.owner_epoch FROM workflow_registry w JOIN workflow_owners o USING(family)
      WHERE w.id=$1 AND w.family='tools' AND w.job_id=$2 AND w.lease_token=$3 AND w.lease_until>now()
      AND w.state='running' AND o.owner='inngest' AND o.epoch=w.owner_epoch FOR SHARE OF w,o`,[b.workflow_id,b.id,b.workflow_token])).rows[0];
    if(!row||b.actor!=='wf-'+b.workflow_id)throw new HttpError(409,'workflow_lease_closed');
    return row.owner_epoch as number;
  }
  private async blocked(db:pg.PoolClient,row:any,reason:string,policyDecision?:Decision) {
    const decision=policyDecision??{...await evaluate(db,this.actions.effect(row)),outcome:'deny' as const,origin:'mandatory' as const,rule:reason};
    await recordEffect(db,this.actions.effect(row),'blocked',decision,row.source_reference);
    await db.query("UPDATE controlled_actions SET state='rejected',security_decision=$2,error_code=$3,revision=revision+1,updated_at=now() WHERE id=$1",[row.id,decision,reason]);
    return {claimed:false,blocked:row.id,reason};
  }
  /** Recover only an exact immutable receipt; no external operation occurs here. */
  async recover(db:pg.PoolClient,row:any) {
    const saved=(await this.actions.derived.pool.query('SELECT * FROM derived_artifacts WHERE operation_id=$1',[operation(row.id)])).rows[0];
    if(!saved)return null;
    const content=JSON.parse(saved.content.toString());
    if(digest(saved.content)!==saved.content_hash||saved.kind!=='controlled_action_result'||saved.producer_version!==protocol||
      canonical(saved.provenance.source)!==canonical(row.source_reference)||canonical(saved.provenance.parents)!==canonical([row.proposal_reference])||
      saved.provenance.actor!==row.actor||saved.provenance.fingerprint!==row.fingerprint||!['done','failed','ambiguous'].includes(content.state))
      throw new HttpError(409,'action_result_changed');
    const reference={store:'derived',kind:'artifact',id:saved.id,input_hash:saved.content_hash};
    if(row.result_reference) {
      if(canonical(row.result_reference)!==canonical(reference)||row.state!==content.state)throw new HttpError(409,'action_result_changed');
      return {id:row.id,state:row.state};
    }
    if(!['running','ambiguous'].includes(row.state))throw new HttpError(409,'action_not_running');
    await this.complete(db,row,content.state,reference);
    return {id:row.id,state:content.state};
  }
  async complete(db:pg.PoolClient,row:any,state:'done'|'failed'|'ambiguous',reference:unknown) {
    await db.query(`UPDATE controlled_actions SET state=$2,result_id=$3,result_reference=$4,lease_until=NULL,
      error_code=$5,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,state,(reference as any).id,reference,state==='ambiguous'?'executor_outcome_unconfirmed':null]);
    await recordEffect(db,this.actions.effect(row),state==='done'?'completed':state,
      row.security_decision??await evaluate(db,this.actions.effect(row)),row.source_reference,row.permission_id??undefined);
    // A late retained receipt can settle an already closed uncertain workflow.
    // Preserve its earlier host observation as history; never create new work.
    await db.query(`UPDATE workflow_receipts r SET state=$2,receipt_id=$3,updated_at=now() FROM workflow_registry w
      WHERE r.workflow_id=w.id AND w.family='tools' AND w.job_id=$1 AND r.step='tool' AND r.attempt=1 AND r.state IN ('started','ambiguous')`,[row.id,state,(reference as any).id]);
    if(state!=='ambiguous')await db.query(`UPDATE workflow_registry SET state=$2,waiting_reason=NULL,next_attempt=NULL,lease_token=NULL,
      lease_until=NULL,revision=revision+1,updated_at=now() WHERE family='tools' AND job_id=$1 AND state='ambiguous'`,[row.id,state==='done'?'completed':'failed']);
  }
  async claim(value:unknown) {
    const b=input(value),authority=await hostActionAuthority(this.pool,b),db=await this.pool.connect();let held=false;
    try {
      held=await enterFamily(db,'tools',authority.owner,authority.epoch);if(!held)return {claimed:false};
      await db.query('BEGIN');await this.lease(db,b);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':controlled-operation',803322))");
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
      if(!row){await db.query('COMMIT');return {claimed:false};}
      if(await this.recover(db,row)){await db.query('COMMIT');return {claimed:false};}
      if(row.state==='running'&&row.lease_until<=new Date()) {
        await db.query("UPDATE controlled_actions SET state='ambiguous',error_code='executor_receipt_missing',revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);
        await recordEffect(db,this.actions.effect(row),'ambiguous',row.security_decision??await evaluate(db,this.actions.effect(row)),row.source_reference,row.permission_id??undefined);
        await db.query('COMMIT');return {claimed:false};
      }
      if(!['proposed','approved'].includes(row.state)){await db.query('COMMIT');return {claimed:false};}
      let args:unknown;
      try {await this.actions.fence(db,row.binding);args=await this.actions.arguments(row);}
      catch(error) {
        if(!(error instanceof HttpError)||![403,409].includes(error.status))throw error;
        const result=await this.blocked(db,row,error.code);await db.query('COMMIT');return result;
      }
      if((await db.query("SELECT 1 FROM controlled_actions WHERE state='running' LIMIT 1")).rowCount){await db.query('COMMIT');return {claimed:false};}
      const grant=row.state==='proposed'?(await db.query(`SELECT id FROM action_permissions WHERE fingerprint=$1 AND binding=$2 AND (job_id IS NULL OR job_id=$3)
        AND remaining>0 AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at,id LIMIT 1 FOR UPDATE`,[row.fingerprint,row.binding,row.job_id])).rows[0]:null;
      if(row.state==='proposed'&&!grant){await db.query('COMMIT');return {claimed:false};}
      const decision=await evaluate(db,this.actions.effect(row),grant?.id??'exact_owner_approval',true);
      if(decision.outcome!=='allow'){const result=await this.blocked(db,row,decision.rule,decision);await db.query('COMMIT');return result;}
      if(grant)await db.query('UPDATE action_permissions SET remaining=remaining-1,revision=revision+1 WHERE id=$1',[grant.id]);
      await recordEffect(db,this.actions.effect(row),'claimed',decision,row.source_reference,grant?.id);
      await db.query(`UPDATE controlled_actions SET state='running',actor=$2,permission_id=$3,security_decision=$4,lease_until=now()+interval '120 seconds',
        execution_owner='inngest',owner_epoch=$5,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,b.actor,grant?.id??null,decision,authority.epoch]);
      await db.query('COMMIT');return {claimed:true,id:row.id,profile:row.profile,kind:row.kind,arguments:args,fingerprint:row.fingerprint};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'tools');});}
  }
  async start(value:unknown) {
    const b=input(value),authority=await hostActionAuthority(this.pool,b),db=await this.pool.connect();let held=false;
    try {
      held=await enterFamily(db,'tools',authority.owner,authority.epoch,true);if(!held)throw new HttpError(409,'workflow_owner_changed');
      await db.query('BEGIN');await this.lease(db,b);
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
      if(!row||row.actor!==b.actor||row.state!=='running')throw new HttpError(403,'action_actor_denied');
      if(row.execution_owner!==authority.owner||row.owner_epoch!==authority.epoch)throw new HttpError(409,'workflow_owner_changed');
      if(row.started_at){await db.query('COMMIT');return {started:false,reason:'execution_already_started'};}
      let blocked:string|undefined;
      try {await this.actions.fence(db,row.binding);await this.actions.arguments(row);}
      catch(error){if(!(error instanceof HttpError)||![403,409].includes(error.status))throw error;blocked=error.code;}
      if(row.lease_until<=new Date())blocked='execution_lease_expired';
      if(row.permission_id) {
        const grant=(await db.query('SELECT * FROM action_permissions WHERE id=$1 FOR SHARE',[row.permission_id])).rows[0];
        if(!grant||grant.revoked_at||grant.expires_at<=new Date()||grant.fingerprint!==row.fingerprint||canonical(grant.binding)!==canonical(row.binding))blocked='permission_no_longer_valid';
      }
      const decision=await evaluate(db,this.actions.effect(row),row.permission_id??'exact_owner_approval',true);
      if(blocked||decision.outcome!=='allow') {
        await recordEffect(db,this.actions.effect(row),'blocked',blocked?{...decision,outcome:'deny',origin:'mandatory',rule:blocked}:decision,row.source_reference,row.permission_id??undefined);
        await db.query('COMMIT');return {started:false,reason:blocked??decision.rule};
      }
      await db.query('UPDATE controlled_actions SET started_at=now(),security_decision=$2,revision=revision+1,updated_at=now() WHERE id=$1',[row.id,decision]);
      await recordEffect(db,this.actions.effect(row),'started',decision,row.source_reference,row.permission_id??undefined);
      await db.query('COMMIT');return {started:true};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'tools');});}
  }
  async finish(value:unknown) {
    const b=input(value),state=String(b.state),result=object(b.result),content=Buffer.from(canonical({state,result}));
    if(!['done','failed','ambiguous'].includes(state)||content.length>1024*1024)throw new HttpError(400,'invalid_action_result');
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
      if(!row||row.actor!==b.actor)throw new HttpError(403,'action_actor_denied');
      if(!['running','ambiguous','done','failed'].includes(row.state))throw new HttpError(409,'action_not_running');
      // A retained host receipt remains publishable after lease expiry or guard
      // revocation. It cannot grant execution and must match the immutable result.
      await this.actions.derived.record({operation_id:operation(row.id),source:row.source_reference,parents:[row.proposal_reference],
        kind:'controlled_action_result',content,producer:'nocheh',producer_version:protocol,configuration:{binding:row.binding,kind:row.kind},
        provenance:{actor:row.actor,fingerprint:row.fingerprint,permission_id:row.permission_id}});
      const completed=await this.recover(db,row);await db.query('COMMIT');return completed;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
