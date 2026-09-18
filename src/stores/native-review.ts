import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository} from './derived.js';
import type {GuardBinding} from './guards.js';
import type {LearningContextRepository} from './learning-context.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';

export const nativeReviewSchema=`
CREATE TABLE IF NOT EXISTS native_review_jobs (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,input_reference jsonb NOT NULL,binding jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','paused','ambiguous')),
 attempts integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1,next_attempt timestamptz NOT NULL DEFAULT now(),
 result_id text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE native_review_jobs ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
`;
const protocol='hermes-native-review-v3';

/** Native notes remain in Hermes. Nocheh stores prepared inputs and execution receipts separately. */
export class NativeReviewRepository {
  constructor(readonly contexts:LearningContextRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly turns:RuntimeTurnRepository,readonly call:RuntimeCall,readonly token:string){}
  private get control(){return this.contexts.access.stores.control;}
  private actor(source:SourceReference,binding:GuardBinding):Reader {
    const owner=this.contexts.access.policy().owner_id;if(!owner)throw new HttpError(409,'owner_review_required');
    return {admin:false,scope:null,space:owner,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch,purpose:'memory-review'};
  }
  async queue(source:SourceReference):Promise<string[]> {
    const binding=await this.contexts.guards.state(),context=await this.contexts.prepare(source,binding),actor=this.actor(source,binding);
    await this.turns.binding(actor);await this.prepared.allow(actor,{observations:context.observations,rules:context.rules});
    const text=canonical({space:context.space,observations:context.observations,rules:context.rules,limitations:context.limitations});
    if(text.length>200000)throw new HttpError(413,'native_review_input_limit');
    const characters=Array.from(text),ids:string[]=[];
    for(let offset=0;offset<characters.length;offset+=8000) {
      const content=`Source nocheh:event:${source.id}; conversation ${context.space}; fragment ${offset/8000+1}. Speakers are not necessarily the owner.\n`+characters.slice(offset,offset+8000).join('');
      const document={text:content,evidence:context.evidence.map(e=>e.reference),dependencies:context.dependencies};
      const id=digest(canonical([protocol,binding,source,document]));
      const input=await this.derived.record({operation_id:'native-review-input:'+id,source,kind:'runtime_context',content:Buffer.from(canonical(document)),
        producer:'nocheh',producer_version:protocol,configuration:{binding,purpose:'memory-review'},provenance:{evidence:document.evidence}});
      await this.prepared.allow(actor,{text:content});await this.turns.binding(actor);
      const db=await this.control.connect();
      try {
        await db.query('BEGIN');
        await db.query(`INSERT INTO native_review_jobs(id,source_reference,input_reference,binding) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,source,input,binding]);
        await requestWorkflow(db,'memory_review','native:'+id);await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      ids.push(id);
    }
    return ids;
  }
  async inspect(id:string) {
    const row=(await this.control.query('SELECT * FROM native_review_jobs WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'native_review_missing');return row;
  }
  async run(id:string,authority:ExecutionAuthority):Promise<string> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'memory_review',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803359) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'native_review_busy');
      const job=await this.inspect(id);if(job.paused)return 'paused';if(['done','paused'].includes(job.state))return job.state;
      const operationId='native-review-result:'+id;
      const complete=async(resultId:string)=>{
        await db.query("UPDATE native_review_jobs SET state='done',result_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[id,resultId]);return 'done';
      };
      const saved=await this.derived.checkpoint(operationId);
      if(saved)return await complete(saved.id);
      const input=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[job.input_reference.id])).rows[0];
      if(!input||input.content_hash!==job.input_reference.input_hash||digest(input.content)!==input.content_hash)throw new HttpError(409,'native_review_input_conflict');
      const document=JSON.parse(input.content.toString());
      if(!Array.isArray(document.evidence)||document.evidence.length>30)throw new HttpError(409,'native_review_input_conflict');
      const actor=this.actor(job.source_reference,job.binding);
      const uncertain=['running','ambiguous'].includes(job.state);
      // Already-started work can be observed after revocation; its old profile
      // remains inaccessible. New work must revalidate every prepared dependency.
      if(!uncertain) {
        await this.contexts.guards.assertCurrent(job.binding);await this.turns.binding(actor);
        await this.contexts.learned.validateDependencies(document.dependencies,job.binding);
        for(const evidence of document.evidence)if(!await this.contexts.access.canLearn(evidence,job.binding))throw new HttpError(403,'learning_consent_required');
        if(this.token.length<24)throw new HttpError(503,'service_credential_required');
        await this.prepared.allow(actor,{text:document.text});
      }
      const credential=uncertain?null:await this.prepared.audience.turn(this.token,{scope:null,space:actor.space!,purpose:'memory-review'},job.source_reference.id,Date.now()+600000);
      if(!uncertain){
        await this.turns.binding(actor);
        const claimed=await db.query("UPDATE native_review_jobs SET state='running',attempts=attempts+1,updated_at=now() WHERE id=$1 AND state='pending' AND NOT paused AND revision=$2 RETURNING id",[id,job.revision]);
        if(!claimed.rowCount)throw new HttpError(409,'native_review_changed');
      }
      let result:Record<string,unknown>;
      try {
        result=await this.call('memory.review',uncertain?{id,scope:actor.space,observe_only:true}:{id,scope:actor.space,content:document.text,
          event_id:job.source_reference.id,guard_mode:job.binding.mode,archive_credential:credential},uncertain?10000:240000);
      }catch {
        await db.query("UPDATE native_review_jobs SET state='ambiguous',error_code='native_review_unconfirmed',next_attempt=now()+interval '60 seconds',updated_at=now() WHERE id=$1",[id]);return 'ambiguous';
      }
      if(!uncertain&&result.state==='waiting'&&result.error_code==='profile_busy') {
        await db.query("UPDATE native_review_jobs SET state='pending',attempts=greatest(0,attempts-1),error_code='waiting_for_profile',next_attempt=now()+interval '5 seconds',updated_at=now() WHERE id=$1",[id]);return 'pending';
      }
      if(result.state==='done') {
        const output=await this.derived.record({operation_id:operationId,source:job.source_reference,parents:[job.input_reference],kind:'runtime_result',content:Buffer.from(canonical({state:'done'})),
          producer:'hermes',producer_version:protocol,configuration:{review_id:id},provenance:{binding:job.binding,native_receipt:id}});
        return await complete(output.id);
      }
      const state=result.state==='running'?'running':'ambiguous';
      await db.query('UPDATE native_review_jobs SET state=$2,error_code=$3,next_attempt=now()+interval \'60 seconds\',updated_at=now() WHERE id=$1',
        [id,state,state==='running'?null:'native_review_unconfirmed']);return state;
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803359)');if(fenced)await leaveFamily(db,'memory_review');});}
  }
  async list(principal:Reader,after='') {
    admin(principal);const rows=(await this.control.query('SELECT * FROM native_review_jobs WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    return {jobs:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  }
  async controlJob(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=object(input);
    if(!['pause','resume'].includes(String(body.action))||!Number.isSafeInteger(body.expected_revision))throw new HttpError(400,'invalid_review_action');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const job=(await db.query('SELECT * FROM native_review_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!job||job.revision!==body.expected_revision||!['pending','paused','ambiguous'].includes(job.state))throw new HttpError(409,'review_not_controllable');
      const state=job.state==='ambiguous'?'ambiguous':body.action==='pause'?'paused':'pending';
      const row=(await db.query('UPDATE native_review_jobs SET state=$2,paused=$3,revision=revision+1,next_attempt=now(),updated_at=now() WHERE id=$1 RETURNING *',[id,state,body.action==='pause'])).rows[0];
      // Resuming an uncertain review can only reconcile its existing identity.
      if(body.action==='resume')await requestWorkflow(db,'memory_review','native:'+id,row.revision);
      await db.query('COMMIT');return row;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
