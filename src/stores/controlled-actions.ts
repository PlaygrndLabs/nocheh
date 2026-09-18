import {blockingPublications} from './publications.js';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {actionArguments} from '../action-arguments.js';
import {HttpError,object,string} from '../http.js';
import {decide,validatePolicy,type Effect} from '../security/contract.js';
import {evaluate,policySnapshot,recordEffect} from '../security/store.js';
import {requestWorkflow} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository} from './derived.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {SourceReference} from './archive.js';

const protocol='controlled-action-v2';
const identity=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_action_id');return id;};
const exact=(value:unknown,keys:string[])=>{const body=object(value);if(Object.keys(body).some(k=>!keys.includes(k)))throw new HttpError(400,'unknown_action_field');return body;};

/** Content and owner-edit history remain derived; authority and effects remain control. */
export class ControlledActionRepository {
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly guards:GuardRepository,
    readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,readonly detect:(text:string)=>Promise<unknown>){}
  get control(){return this.access.stores.control;}
  async row(id:unknown) {
    const row=(await this.control.query('SELECT * FROM controlled_actions WHERE id=$1',[identity(id)])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');return row;
  }
  effect(row:any):Effect {return {id:row.id,kind:row.kind,scope:row.scope,profile:row.logical_profile,fingerprint:row.fingerprint,...(row.job_id?{job:row.job_id}:{})};}
  async fence(db:pg.PoolClient,binding:GuardBinding) {
    const state=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(!state||canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
    if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async arguments(row:any,current=true) {
    if(current)await this.guards.assertCurrent(row.binding);
    const reference=row.proposal_reference,id='derived_artifacts:'+reference.id;
    const artifact=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(artifact?.content_hash!==reference.input_hash)throw new HttpError(409,'action_proposal_changed');
    const saved=row.guard_revision===null?(await this.derived.pool.query('SELECT input AS content FROM guard_sources WHERE id=$1',[id])).rows[0]:
      (await this.derived.pool.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,row.guard_revision])).rows[0];
    if(!saved)throw new HttpError(409,'action_proposal_changed');
    const document=JSON.parse(saved.content.toString()),args=actionArguments(row.kind,JSON.parse(document.text));
    if(digest(canonical(args))!==row.arguments_hash||digest(canonical({binding:row.binding,scope:row.scope,profile:row.logical_profile,kind:row.kind,arguments:args,job:row.job_id}))!==row.fingerprint)
      throw new HttpError(409,'action_proposal_changed');
    if(current) {
      const active=await this.guards.read(id,row.binding);
      if(active.revision!==row.guard_revision||canonical(active.value)!==canonical(document))throw new HttpError(409,'action_proposal_changed');
    }
    return args;
  }
  async propose(principal:Reader,value:unknown) {
    if(principal.admin||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'external_effect_scope_denied');
    const body=exact(value,['kind','arguments']),raw=actionArguments(body.kind,body.arguments),turn=await this.turns.binding(principal),binding=await this.guards.state();
    const source=await this.prepared.root(principal,binding);
    if(source.store==='archive') {
      const original=await this.access.archive.verify(source),intake=(await this.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
      if(original.origin!=='live'||intake?.transport==='import'||intake?.state==='pending')throw new HttpError(403,'external_effect_requires_live_turn');
    }
    const id=digest(canonical([protocol,source,binding,body.kind,raw])),proposal=await this.derived.record({operation_id:'controlled-proposal:'+id,
      source,kind:'controlled_action_request',content:Buffer.from(canonical(raw)),producer:'nocheh',producer_version:protocol,configuration:{binding,kind:body.kind}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),args=actionArguments(body.kind,JSON.parse((representation.value as any).text));
    const fingerprint=digest(canonical({binding,scope:turn.scope,profile:turn.logical_profile,kind:body.kind,arguments:args,job:turn.job??null}));
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');await this.fence(db,binding);
      await db.query(`INSERT INTO controlled_actions(id,event_id,source_reference,proposal_reference,binding,guard_revision,scope,space_id,profile,logical_profile,kind,fingerprint,arguments_hash,job_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [id,source.id,source,proposal,binding,representation.revision,turn.scope,principal.space,turn.profile,turn.logical_profile,body.kind,fingerprint,digest(canonical(args)),turn.job??null]);
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
      if(row.fingerprint!==fingerprint)throw new HttpError(409,'action_proposal_changed');
      const grant=(await this.grants(row,db))[0],decision=await evaluate(db,this.effect(row),row.state==='approved'?'exact_owner_approval':grant?.id);
      await recordEffect(db,this.effect(row),'proposed',decision,source);
      await recordEffect(db,this.effect(row),decision.outcome==='deny'?'blocked':decision.outcome==='allow'?'allowed':'awaiting_approval',decision,source,grant?.id);
      await requestWorkflow(db,'tools',id);await db.query('COMMIT');
      return {id,state:row.state,fingerprint,message:'Review the exact operation. Execution requires owner approval or a current bounded permission.'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async inspect(principal:Reader,id:unknown) {
    const row=await this.row(id);
    if(!principal.admin) {
      const turn=await this.turns.binding(principal);
      if(principal.space!==row.space_id||turn.profile!==row.profile)throw new HttpError(404,'action_not_found');
    }
    const args=await this.arguments(row,!principal.admin);
    let result:unknown=null;
    if(row.result_reference) {
      const output=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0];
      if(!output||output.content_hash!==row.result_reference.input_hash||digest(output.content)!==output.content_hash)throw new HttpError(409,'action_result_changed');
      result=JSON.parse(output.content.toString());
    }
    const view={id:row.id,event_id:row.event_id,scope:row.scope,profile:row.profile,logical_profile:row.logical_profile,kind:row.kind,arguments:args,fingerprint:row.fingerprint,
      state:row.state,revision:row.revision,job_id:row.job_id,created_at:row.created_at,permission_id:row.permission_id,error_code:row.error_code,result};
    // Results are untrusted generated content and need their own guarded context.
    if(!principal.admin){await this.prepared.allow(principal,args);return this.prepared.prepare(principal,view,this.detect) as Promise<any>;}
    return view;
  }
  async grants(row:any,db:Pick<pg.Pool,'query'>=this.control) {
    return (await db.query(`SELECT id,remaining,expires_at,revision FROM action_permissions WHERE fingerprint=$1 AND binding=$2
      AND (job_id IS NULL OR job_id=$3) AND remaining>0 AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at,id`,[row.fingerprint,row.binding,row.job_id])).rows;
  }
  private async command<T>(principal:Reader,body:Record<string,unknown>,request:unknown,change:(db:pg.PoolClient)=>Promise<T>,source?:SourceReference) {
    admin(principal);if(source)await this.access.archive.verify(source);
    const hash=digest(canonical(source?{request,source}:request)),id=body.operation_id===undefined?'action-owner:'+hash:string(body.operation_id,200),db=await this.control.connect();
    try {
      await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803365))',[id]);
      const prior=(await db.query('SELECT * FROM action_owner_commands WHERE id=$1',[id])).rows[0];
      if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'owner_command_conflict');await db.query('COMMIT');return prior.result as T;}
      const result=await change(db);await db.query('INSERT INTO action_owner_commands(id,request_hash,result,source_reference) VALUES($1,$2,$3,$4)',[id,hash,result,source??null]);
      await db.query('COMMIT');return result;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async decide(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=exact(value,['id','fingerprint','decision','expected_revision','operation_id']),id=identity(body.id);
    if(!['approve','deny'].includes(String(body.decision)))throw new HttpError(400,'invalid_decision');
    return this.command(principal,body,{...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(body.fingerprint!==row.fingerprint||body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'action_changed');
      if(!['proposed','approved'].includes(row.state))throw new HttpError(409,'action_already_started_or_closed');
      if(body.decision==='approve'){await this.fence(db,row.binding);await this.arguments(row);}
      const state=body.decision==='approve'?'approved':'rejected';
      await db.query('UPDATE controlled_actions SET state=$2,permission_id=NULL,decision_reference=$3,revision=revision+1,updated_at=now() WHERE id=$1',[id,state,source??null]);
      await requestWorkflow(db,'tools',id);return {id,state,revision:row.revision+1};
    },source);
  }
  async grant(principal:Reader,value:unknown) {
    admin(principal);const body=exact(value,['action_id','fingerprint','uses','minutes','expected_revision','operation_id']),id=identity(body.action_id);
    if(!Number.isSafeInteger(body.uses)||Number(body.uses)<1||Number(body.uses)>1000||!Number.isSafeInteger(body.minutes)||Number(body.minutes)<1||Number(body.minutes)>43200)throw new HttpError(400,'invalid_permission_bounds');
    return this.command(principal,body,{kind:'grant',...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR SHARE',[id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(body.fingerprint!==row.fingerprint||body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'action_changed');
      await this.fence(db,row.binding);await this.arguments(row);
      const permission=digest(canonical(['permission',id,body.operation_id??null,body.uses,body.minutes,row.fingerprint]));
      await db.query(`INSERT INTO action_permissions(id,action_id,fingerprint,proposal_reference,binding,scope,profile,kind,job_id,expires_at,remaining)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10*interval '1 minute',$11)`,[permission,id,row.fingerprint,row.proposal_reference,row.binding,row.scope,row.profile,row.kind,row.job_id,body.minutes,body.uses]);
      const queued=(await db.query("SELECT id FROM controlled_actions WHERE fingerprint=$1 AND state IN ('proposed','approved') ORDER BY id",[row.fingerprint])).rows;
      for(const candidate of queued)await requestWorkflow(db,'tools',candidate.id);
      return {id:permission,revision:1};
    });
  }
  async revoke(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=exact(value,['id','expected_revision','operation_id']),id=identity(body.id);
    return this.command(principal,body,{kind:'revoke',...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT revision,revoked_at FROM action_permissions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'permission_not_found');
      if(body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'permission_changed');
      if(!row.revoked_at)await db.query('UPDATE action_permissions SET revoked_at=now(),revision=revision+1 WHERE id=$1',[id]);
      return {id,revoked:true,revision:row.revision+(row.revoked_at?0:1)};
    },source);
  }
  async list(principal:Reader) {
    admin(principal);const rows=(await this.control.query('SELECT id FROM controlled_actions ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    const permissions=(await this.control.query('SELECT * FROM action_permissions ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    for(const permission of permissions)permission.arguments=await this.arguments(await this.row(permission.action_id),false);
    return {actions:await Promise.all(rows.map(row=>this.inspect(principal,row.id))),permissions};
  }
  async preview(principal:Reader,value:unknown) {
    admin(principal);const body=exact(value,['action_id','policy']),row=await this.row(body.action_id),snapshot=await policySnapshot(this.control);
    const grants=await this.grants(row),effect=this.effect(row),policy=body.policy===undefined?snapshot.policy:validatePolicy(body.policy);
    let stale=false;try{await this.arguments(row);}catch(error){if(error instanceof HttpError&&[403,409].includes(error.status))stale=true;else throw error;}
    return {effect,decision:decide(policy,snapshot.revision,effect,{...(stale?{mandatoryDenial:'guard_context_changed'}:{}),
      ...(row.state==='approved'?{grant:'exact_owner_approval'}:grants[0]?{grant:grants[0].id}:{})}),grants,consumes_permission:false,execution:false,candidate_policy:body.policy!==undefined};
  }
}
