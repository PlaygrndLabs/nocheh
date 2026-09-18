import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {Interpretation,InterpretationVersion} from '../interpretations.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {DerivedRepository} from './derived.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {ProjectRepository} from './projects.js';
import {revokeBeforePublication} from './publications.js';
import {requestWorkflow} from '../workflows/store.js';

export interface PreparedDependency {source_id:string;revision:number|null;value_hash:string;selection?:{id:string;revision:number}}
export interface LearnedPublication {entry_id:string;revision:number;expected_revision:number|null;operation_id:string;input_binding:GuardBinding;request_hash:string}
export class LearnedMemoryRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly derived:DerivedRepository,readonly guards:GuardRepository){}

  async validateDependencies(dependencies:PreparedDependency[],binding:GuardBinding):Promise<void> {
    if(!dependencies.length||dependencies.length>100)throw new HttpError(400,'invalid_learning_dependencies');
    for(const dependency of dependencies) {
      const current=await this.guards.read(dependency.source_id,binding);
      if(current.revision!==dependency.revision||digest(canonical(current.value))!==dependency.value_hash)throw new HttpError(409,'memory_refresh_required');
      if(dependency.selection) {
        const selected=(await this.stores.derived.query('SELECT active_revision FROM derivative_selections WHERE id=$1',[dependency.selection.id])).rows[0];
        if(selected?.active_revision!==dependency.selection.revision)throw new HttpError(409,'memory_refresh_required');
      }
    }
    await this.guards.assertCurrent(binding);
  }

  private async resume(version:LearnedPublication) {
    await revokeBeforePublication(this.stores.control,{kind:'memory',source_id:version.entry_id,revision:version.revision,
      expected_revision:version.expected_revision,operation_id:version.operation_id,input_binding:version.input_binding});
    await this.finish(version.operation_id);return {id:version.entry_id,revision:version.revision};
  }
  private async prior(operationId:string,requestHash:string) {
    const row=(await this.stores.derived.query('SELECT * FROM learned_versions WHERE operation_id=$1',[operationId])).rows[0];
    if(row&&row.request_hash!==requestHash)throw new HttpError(409,'learning_operation_conflict');
    return row as LearnedPublication|undefined;
  }

  private async publish(id:string,value:Interpretation,expected:number|null,operationId:string,author:InterpretationVersion['author'],
    retired:boolean,dependencies:PreparedDependency[],binding:GuardBinding,producerVersion:string,requestHash:string,
    detect:(text:string)=>Promise<unknown>,nativeProvenance:Record<string,unknown>={}) {
    if(!/^[a-f0-9]{64}$/.test(id)||!operationId||operationId.length>200||!value.evidence.length||value.evidence.length>30||
      (expected!==null&&(!Number.isSafeInteger(expected)||expected<1)))throw new HttpError(400,'invalid_learned_version');
    const previous=await this.prior(operationId,requestHash);if(previous)return previous;
    await this.guards.assertCurrent(binding);
    for(const source of value.evidence)await this.archive.verify(source);
    if(author!=='owner') {
      if(value.evidence.some(e=>!dependencies.some(d=>d.source_id==='events:'+e.id)))throw new HttpError(400,'learning_evidence_not_prepared');
      await this.validateDependencies(dependencies,binding);
    }
    const {text,...metadata}=value;
    const output=await this.derived.record({operation_id:'learned:'+operationId,source:value.evidence[0]!,kind:'learned_memory',content:Buffer.from(text),
      producer:author==='owner'?'owner':'honcho',producer_version:producerVersion,configuration:{schema:'learned-memory-v1'},
      provenance:{learning:metadata,native:nativeProvenance,author,retired,dependencies,input_binding:binding}});
    await this.guards.prepare(output,'learned-memory-v1',detect);
    await this.guards.assertCurrent(binding);
    const client=await this.stores.derived.connect();let version:LearnedPublication;
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO learned_entries(id,scope_kind,scope_id,kind,subject) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [id,value.scope.kind,value.scope.id,value.kind,value.subject]);
      const current=(await client.query(`SELECT e.*,v.author FROM learned_entries e LEFT JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
        WHERE e.id=$1 FOR UPDATE OF e`,[id])).rows[0];
      if(current.scope_kind!==value.scope.kind||current.scope_id!==value.scope.id||current.kind!==value.kind||current.subject!==value.subject)
        throw new HttpError(409,'learned_identity_conflict');
      const prior=(await client.query('SELECT * FROM learned_versions WHERE operation_id=$1',[operationId])).rows[0];
      if(prior) {
        if(prior.request_hash!==requestHash)throw new HttpError(409,'learning_operation_conflict');version=prior;
      } else {
        if(current.active_revision!==expected)throw new HttpError(409,'learned_revision_conflict');
        if((current.author==='owner'||current.imported)&&author!=='owner')throw new HttpError(409,'owner_correction_is_authoritative');
        const revision=Number((await client.query('SELECT coalesce(max(revision),0)+1 AS revision FROM learned_versions WHERE entry_id=$1',[id])).rows[0].revision);
        await client.query(`INSERT INTO learned_versions(operation_id,entry_id,revision,expected_revision,derived_id,author,retired,evidence,dependencies,input_binding,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[operationId,id,revision,expected,output.id,author,retired,
          JSON.stringify(value.evidence),JSON.stringify(dependencies),JSON.stringify(binding),requestHash]);
        version={entry_id:id,revision,expected_revision:expected,operation_id:operationId,input_binding:binding,request_hash:requestHash};
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    return version!;
  }

  async publishAutomatic(id:string,value:Interpretation,expected:number|null,operationId:string,dependencies:PreparedDependency[],binding:GuardBinding,
    producerVersion:string,detect:(text:string)=>Promise<unknown>,nativeProvenance:Record<string,unknown>={}) {
    const author=value.uncertainty==='explicit'||value.kind==='convention'?'participant':'honcho';
    const hash=digest(canonical({id,value,expected,operationId,dependencies,producerVersion,nativeProvenance}));
    return this.resume(await this.publish(id,value,expected,operationId,author,false,dependencies,binding,producerVersion,hash,detect,nativeProvenance));
  }

  async stageAutomatic(id:string,value:Interpretation,expected:number|null,operationId:string,dependencies:PreparedDependency[],binding:GuardBinding,
    producerVersion:string,detect:(text:string)=>Promise<unknown>,nativeProvenance:Record<string,unknown>={}) {
    const author=value.uncertainty==='explicit'||value.kind==='convention'?'participant':'honcho';
    const hash=digest(canonical({id,value,expected,operationId,dependencies,producerVersion,nativeProvenance}));
    return this.publish(id,value,expected,operationId,author,false,dependencies,binding,producerVersion,hash,detect,nativeProvenance);
  }

  /** One control commit revokes for the whole prepared batch and records recovery before any pointer changes. */
  async activateBatch(versions:LearnedPublication[],binding:GuardBinding,jobId:string,resultId:string,resultIds:string[]):Promise<void> {
    if(versions.length>12||new Set(versions.map(v=>v.entry_id)).size!==versions.length)throw new HttpError(400,'invalid_learning_batch');
    for(const version of versions) {
      const saved=await this.prior(version.operation_id,version.request_hash);
      if(!saved||saved.entry_id!==version.entry_id||saved.revision!==version.revision||canonical(saved.input_binding)!==canonical(binding))throw new HttpError(409,'learning_batch_conflict');
    }
    const db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const state=(await db.query('SELECT g.epoch,g.mode,i.generation FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton FOR UPDATE OF g')).rows[0];
      const job=(await db.query('SELECT state,binding FROM interpretation_jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
      if(!job||canonical(job.binding)!==canonical(binding))throw new HttpError(409,'learning_batch_conflict');
      if(job.state==='publishing'||job.state==='done'){await db.query('COMMIT');return;}
      if(canonical({epoch:Number(state.epoch),mode:state.mode,generation:state.generation})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
      const changed=versions.some(v=>v.expected_revision!==null);
      const epoch=changed?Number((await db.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch):Number(state.epoch);
      for(const version of versions) {
        await db.query(`INSERT INTO guard_publications(id,operation_kind,source_id,revision,expected_revision,epoch) VALUES($1,'memory',$2,$3,$4,$5)`,
          [version.operation_id,version.entry_id,version.revision,version.expected_revision,epoch]);
        if(changed)await db.query('INSERT INTO guard_invalidations(source_id,epoch) VALUES($1,$2)',[version.entry_id,epoch]);
        await requestWorkflow(db,'honcho','projection:'+version.entry_id,version.revision);
      }
      if(changed){await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);}
      await db.query("UPDATE interpretation_jobs SET state='publishing',output_id=$2,result_ids=$3,publication_ids=$4 WHERE id=$1",[jobId,resultId,JSON.stringify(resultIds),JSON.stringify(versions.map(v=>v.operation_id))]);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  async correct(principal:Reader,id:string,input:unknown,detect:(text:string)=>Promise<unknown>) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(k=>!['expected_revision','operation_id','text','retired'].includes(k))||typeof body.retired!=='boolean')throw new HttpError(400,'invalid_memory_correction');
    const operationId=string(body.operation_id,200),expected=Number(body.expected_revision),hash=digest(canonical({id,...body}));
    const prior=await this.prior(operationId,hash);if(prior)return this.resume(prior);
    const current=(await this.stores.derived.query(`SELECT e.active_revision,v.evidence,v.dependencies,d.content,d.provenance FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision JOIN derived_artifacts d ON d.id=v.derived_id WHERE e.id=$1`,[id])).rows[0];
    if(!current)throw new HttpError(404,'learned_memory_not_found');
    if(!Number.isSafeInteger(body.expected_revision)||current.active_revision!==expected)throw new HttpError(409,'learned_revision_conflict');
    const text=body.retired?current.content.toString():string(body.text,8000).trim();if(!text)throw new HttpError(400,'memory_correction_required');
    const {quote:_,...metadata}=current.provenance.learning;
    const value:Interpretation={...metadata,text,uncertainty:'explicit',conflicts:[],evidence:current.evidence};
    return this.resume(await this.publish(id,value,expected,operationId,'owner',body.retired,current.dependencies,await this.guards.state(),'owner-correction-v1',hash,detect));
  }

  async finish(operationId:string):Promise<void> {
    const operation=(await this.stores.control.query('SELECT * FROM guard_publications WHERE id=$1',[operationId])).rows[0];
    if(!operation||operation.operation_kind!=='memory')throw new HttpError(404,'learned_publication_missing');
    if(operation.state==='done')return;
    if(operation.state==='conflict')throw new HttpError(409,'learned_revision_conflict');
    const client=await this.stores.derived.connect();let conflict=false;
    try {
      await client.query('BEGIN');
      const entry=(await client.query('SELECT active_revision FROM learned_entries WHERE id=$1 FOR UPDATE',[operation.source_id])).rows[0];
      const revision=(await client.query('SELECT * FROM learned_versions WHERE operation_id=$1',[operationId])).rows[0];
      if(!entry||!revision||revision.entry_id!==operation.source_id||revision.revision!==operation.revision||revision.expected_revision!==operation.expected_revision)
        throw new HttpError(409,'learned_publication_incomplete');
      if(!(await client.query('SELECT 1 FROM learned_activations WHERE operation_id=$1',[operationId])).rowCount) {
        if(entry.active_revision!==operation.expected_revision)conflict=true;
        else {
          if(!(await client.query("SELECT 1 FROM guard_sources WHERE id=$1 AND state='ready' AND active_revision IS NOT NULL",['derived_artifacts:'+revision.derived_id])).rowCount)
            throw new HttpError(409,'guard_preparation_pending');
          await client.query('UPDATE learned_entries SET active_revision=$2,imported=false WHERE id=$1',[operation.source_id,operation.revision]);
          await client.query('INSERT INTO learned_activations(operation_id) VALUES($1)',[operationId]);
        }
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    await this.stores.control.query("UPDATE guard_publications SET state=$2,completed_at=now() WHERE id=$1 AND state='pending'",[operationId,conflict?'conflict':'done']);
    if(conflict)throw new HttpError(409,'learned_revision_conflict');
  }

  async reconcile(limit=100):Promise<number> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_reconciliation_limit');
    const rows=(await this.stores.control.query("SELECT id FROM guard_publications WHERE operation_kind='memory' AND state='pending' ORDER BY created_at,id LIMIT $1",[limit])).rows;
    for(const row of rows)try {await this.finish(row.id);}catch(error){if(!(error instanceof HttpError)||error.code!=='learned_revision_conflict')throw error;}
    return rows.length;
  }

  async read(principal:Reader,id:string,binding:GuardBinding,canReadEvidence:(reference:SourceReference)=>Promise<boolean>):Promise<InterpretationVersion> {
    await this.guards.assertCurrent(binding);
    const row=(await this.stores.derived.query(`SELECT e.*,v.author,v.retired,v.evidence,v.dependencies,v.derived_id FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[id])).rows[0];
    if(!row||row.retired||row.imported&&!principal.admin)throw new HttpError(404,'learned_memory_not_found');
    if(!principal.admin&&principal.scope!==null) {
      const space=principal.space??principal.scope;
      if(row.scope_kind==='conversation'&&row.scope_id!==space)throw new HttpError(404,'learned_memory_not_found');
      if(row.scope_kind==='project') {
        const effective=await new ProjectRepository(this.stores.control).effective(space);
        if(effective.project?.id!==row.scope_id||effective.project?.state!=='active')throw new HttpError(404,'learned_memory_not_found');
      }
    }
    for(const reference of row.evidence as SourceReference[])if(!await canReadEvidence(reference))throw new HttpError(404,'learned_memory_not_found');
    if(row.author!=='owner')await this.validateDependencies(row.dependencies,binding);
    const guarded=(await this.guards.read('derived_artifacts:'+row.derived_id,binding)).value as any;
    await this.guards.assertCurrent(binding);
    return {...guarded.provenance.learning,text:guarded.text,id,revision:row.active_revision,author:row.author,retired:false};
  }

  async list(principal:Reader,scope?:{kind:string;id:string},after='') {
    admin(principal);const rows=(await this.stores.derived.query(`SELECT e.*,v.author,v.retired,v.created_at AS revised_at,d.content,d.provenance
      FROM learned_entries e JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
      JOIN derived_artifacts d ON d.id=v.derived_id WHERE e.id>$1 AND ($2::text IS NULL OR (e.scope_kind=$2 AND e.scope_id=$3)) ORDER BY e.id LIMIT 101`,[after,scope?.kind??null,scope?.id??null])).rows;
    return {entries:rows.slice(0,100).map(row=>({...row,text:row.content.toString(),content:undefined})),next:rows.length>100?rows[99].id:null};
  }
  async history(principal:Reader,id:string,before=2147483647) {
    admin(principal);if(!Number.isSafeInteger(before)||before<1)throw new HttpError(400,'invalid_revision');
    const rows=(await this.stores.derived.query(`SELECT v.*,d.content,d.provenance,a.activated_at FROM learned_versions v
      JOIN derived_artifacts d ON d.id=v.derived_id LEFT JOIN learned_activations a ON a.operation_id=v.operation_id
      WHERE v.entry_id=$1 AND v.revision<$2 ORDER BY v.revision DESC LIMIT 51`,[id,before])).rows;
    return {versions:rows.slice(0,50).map(row=>({...row,text:row.content.toString(),content:undefined})),next:rows.length>50?rows[49].revision:null};
  }
}
