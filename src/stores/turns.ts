import type {Reader} from '../access.js';
import {canonical} from '../archive.js';
import {HttpError} from '../http.js';
import {parentSpace} from '../spaces.js';
import type {BrokerStorage,TurnBinding} from '../security/broker.js';
import type {SourceReference} from './archive.js';
import type {OperationReference} from './operations.js';
import type {SourceAccessRepository} from './access.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {GuardBinding} from './guards.js';
import {defaultLogicalProfile,runtimeProfile} from './runtime-profile.js';

export const runtimeTurnSchema=`
CREATE TABLE IF NOT EXISTS runtime_turns (
 id text PRIMARY KEY,reference jsonb NOT NULL,generation uuid NOT NULL,guard_epoch bigint NOT NULL,
 space_id text NOT NULL,owner boolean NOT NULL,logical_profile text NOT NULL,job_id text,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 created_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz
);
`;

/** Runtime authority uses original references or explicit control operations, never generated archive events. */
export class RuntimeTurnRepository implements BrokerStorage {
  constructor(readonly access:SourceAccessRepository,readonly prepared:PreparedContextRepository){}
  async assertAudience(principal:Reader):Promise<GuardBinding> {
    const binding=await this.prepared.audience.assert(principal);
    if(principal.turnEvent) {
      const managed=(await this.access.stores.control.query('SELECT state,generation,guard_epoch,logical_profile FROM runtime_turns WHERE id=$1',[principal.turnEvent])).rows[0];
      if(managed&&(managed.state!=='open'||managed.generation!==binding.generation||Number(managed.guard_epoch)!==binding.epoch))
        throw new HttpError(409,'runtime_turn_changed');
      if(managed&&managed.logical_profile!==principal.logical_profile)throw new HttpError(409,'runtime_profile_changed');
    }
    return binding;
  }
  profile(principal:Reader,binding:GuardBinding):string {
    return runtimeProfile(principal,binding);
  }
  /** Trusted admission only. The referenced operation/source must already be durable. */
  async register(principal:Reader,input:{logical_profile:string;job?:string}):Promise<void> {
    if(principal.admin||!principal.turnEvent||!principal.space||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.logical_profile)||principal.logical_profile!==input.logical_profile||
      input.job!==undefined&&!/^[-\w.]{1,200}$/.test(input.job))throw new HttpError(400,'invalid_runtime_turn');
    const binding=await this.assertAudience(principal),reference=await this.prepared.root(principal,binding);
    await this.checkSpace(principal,reference);
    if(reference.store==='archive'&&(await this.access.archive.verify(reference)).channel!=='browser')
      throw new HttpError(400,'managed_turn_source_required');
    const db=this.access.stores.control;
    await db.query(`INSERT INTO runtime_turns(id,reference,generation,guard_epoch,space_id,owner,logical_profile,job_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [reference.id,reference,binding.generation,binding.epoch,principal.space,principal.scope===null,input.logical_profile,input.job??null]);
    const saved=(await db.query('SELECT * FROM runtime_turns WHERE id=$1',[reference.id])).rows[0];
    if(!saved||canonical(saved.reference)!==canonical(reference)||saved.generation!==binding.generation||Number(saved.guard_epoch)!==binding.epoch||
      saved.space_id!==principal.space||saved.owner!==(principal.scope===null)||saved.logical_profile!==input.logical_profile||saved.job_id!==(input.job??null)||saved.state!=='open')
      throw new HttpError(409,'runtime_turn_conflict');
    await this.assertAudience(principal);
  }
  async close(id:string):Promise<void> {
    await this.access.stores.control.query("UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=$1 AND state='open'",[id]);
  }
  private async checkSpace(principal:Reader,reference:SourceReference|OperationReference):Promise<string> {
    if(reference.store==='control') {
      const row=(await this.access.stores.control.query('SELECT scope FROM content_operations WHERE id=$1',[reference.id])).rows[0];
      if(!row||row.scope!==principal.space||principal.scope!==null&&principal.scope!==(parentSpace(row.scope)??row.scope))throw new HttpError(403,'turn_source_denied');
      return parentSpace(row.scope)??row.scope;
    }
    const source=await this.access.archive.verify(reference),space=await this.access.space(reference);
    if(principal.scope===null&&principal.purpose==='memory-review'&&principal.space===this.access.policy().owner_id) {
      const binding=await this.assertAudience(principal);
      if(!await this.access.canLearn(reference,binding))throw new HttpError(403,'learning_consent_required');
      // An owner-only native review learns permitted evidence into the owner's
      // native notes. It cannot grant group access or become an ordinary reply.
      return principal.space!;
    }
    if(!space||space!==principal.space)throw new HttpError(403,'turn_source_denied');
    return source.scope;
  }
  async binding(principal:Reader):Promise<TurnBinding> {
    if(principal.admin||!principal.turnEvent||!principal.space||principal.guard_epoch===undefined)throw new HttpError(403,'scoped_turn_required');
    const current=await this.assertAudience(principal),reference=await this.prepared.root(principal,current),scope=await this.checkSpace(principal,reference);
    const managed=(await this.access.stores.control.query('SELECT * FROM runtime_turns WHERE id=$1',[reference.id])).rows[0];
    if((reference.store==='control'||principal.logical_profile!==undefined)&&!managed)throw new HttpError(403,'runtime_turn_not_admitted');
    if(managed&&(managed.generation!==current.generation||Number(managed.guard_epoch)!==current.epoch||managed.space_id!==principal.space||
      managed.owner!==(principal.scope===null)||managed.state!=='open'||canonical(managed.reference)!==canonical(reference)))
      throw new HttpError(409,'runtime_turn_changed');
    await this.assertAudience(principal);
    return {event_id:reference.id,reference,scope,profile:this.profile(principal,current),
      logical_profile:managed?.logical_profile??defaultLogicalProfile(principal),
      owner:principal.scope===null,guard_epoch:current.epoch,generation:current.generation,...(principal.revision===undefined?{}:{revision:principal.revision}),
      ...(managed?.job_id?{job:managed.job_id}:{})};
  }
  async turnFile(principal:Reader,hash:string):Promise<string> {
    await this.binding(principal);
    const artifact=(await this.access.stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1 AND file_hash=$2 ORDER BY id LIMIT 1',
      [principal.turnEvent,hash])).rows[0];
    if(!artifact)throw new HttpError(404,'turn_file_not_found');
    await this.assertAudience(principal);return artifact.id;
  }
}
