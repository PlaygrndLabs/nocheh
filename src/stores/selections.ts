import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import type {StorePools} from './connections.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import type {DerivativeReference} from './derived.js';
import {revokeBeforePublication} from './publications.js';

export const selectionId=(eventId:string,artifactId:string|null,kind:string)=>digest(canonical([eventId,artifactId,kind]));

export class SelectionRepository {
  constructor(readonly stores:StorePools,readonly guards:GuardRepository){}

  async activate(output:DerivativeReference,expected:number|null,operationId:string,author:'automatic'|'owner'='owner') {
    if(output.store!=='derived'||output.kind!=='artifact'||!operationId||Buffer.byteLength(operationId)>200||
      (expected!==null&&(!Number.isSafeInteger(expected)||expected<1))||!['automatic','owner'].includes(author))
      throw new HttpError(400,'invalid_derivative_selection');
    // Automatic preparation can establish the first selection, never replace an
    // existing selection or resurrect a selection after a stale owner request.
    if(author==='automatic'&&expected!==null)throw new HttpError(409,'owner_activation_required');
    const client=await this.stores.derived.connect();
    let id:string,revision:number;
    try {
      await client.query('BEGIN');
      const derived=(await client.query('SELECT event_id,artifact_id,kind,content_hash FROM derived_artifacts WHERE id=$1',[output.id])).rows[0];
      if(!derived||derived.content_hash!==output.input_hash)throw new HttpError(409,'derivative_reference_conflict');
      const prepared=(await client.query(`SELECT 1 FROM guard_sources s JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision
        WHERE s.id=$1 AND s.state='ready'`,['derived_artifacts:'+output.id])).rowCount;
      if(!prepared)throw new HttpError(409,'guard_preparation_pending');
      id=selectionId(derived.event_id,derived.artifact_id,derived.kind);
      await client.query('INSERT INTO derivative_selections(id,event_id,artifact_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id,derived.event_id,derived.artifact_id,derived.kind]);
      const selected=(await client.query('SELECT active_revision FROM derivative_selections WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const previous=(await client.query('SELECT * FROM derivative_selection_revisions WHERE operation_id=$1',[operationId])).rows[0];
      if(previous) {
        if(previous.selection_id!==id||previous.derived_id!==output.id||previous.expected_revision!==expected||previous.author!==author)
          throw new HttpError(409,'derivative_selection_conflict');
        revision=previous.revision;
      } else {
        if(selected.active_revision!==expected)throw new HttpError(409,'derivative_selection_conflict');
        revision=Number((await client.query('SELECT coalesce(max(revision),0)+1 AS revision FROM derivative_selection_revisions WHERE selection_id=$1',[id])).rows[0].revision);
        await client.query(`INSERT INTO derivative_selection_revisions(operation_id,selection_id,revision,expected_revision,derived_id,author)
          VALUES($1,$2,$3,$4,$5,$6)`,[operationId,id,revision,expected,output.id,author]);
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    await revokeBeforePublication(this.stores.control,{kind:'selection',source_id:id,revision,expected_revision:expected,operation_id:operationId});
    await this.finish(operationId);
    return {id,revision,derived:output};
  }

  async finish(operationId:string):Promise<void> {
    const operation=(await this.stores.control.query('SELECT * FROM guard_publications WHERE id=$1',[operationId])).rows[0];
    if(!operation||operation.operation_kind!=='selection')throw new HttpError(404,'derivative_selection_missing');
    if(operation.state==='done')return;
    if(operation.state==='conflict')throw new HttpError(409,'derivative_selection_conflict');
    const client=await this.stores.derived.connect();let conflict=false;
    try {
      await client.query('BEGIN');
      const current=(await client.query('SELECT active_revision FROM derivative_selections WHERE id=$1 FOR UPDATE',[operation.source_id])).rows[0];
      const revision=(await client.query('SELECT * FROM derivative_selection_revisions WHERE operation_id=$1',[operationId])).rows[0];
      if(!current||!revision||revision.selection_id!==operation.source_id||revision.revision!==operation.revision||revision.expected_revision!==operation.expected_revision)
        throw new HttpError(409,'derivative_publication_incomplete');
      if(!(await client.query('SELECT 1 FROM derivative_activations WHERE operation_id=$1',[operationId])).rowCount) {
        if(current.active_revision!==operation.expected_revision)conflict=true;
        else {
          if(!(await client.query("SELECT 1 FROM guard_sources WHERE id=$1 AND state='ready' AND active_revision IS NOT NULL",['derived_artifacts:'+revision.derived_id])).rowCount)
            throw new HttpError(409,'guard_preparation_pending');
          await client.query('UPDATE derivative_selections SET active_revision=$2 WHERE id=$1',[operation.source_id,operation.revision]);
          await client.query('INSERT INTO derivative_activations(operation_id) VALUES($1)',[operationId]);
        }
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    await this.stores.control.query("UPDATE guard_publications SET state=$2,completed_at=now() WHERE id=$1 AND state='pending'",[operationId,conflict?'conflict':'done']);
    if(conflict)throw new HttpError(409,'derivative_selection_conflict');
  }

  async reconcile(limit=100):Promise<number> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_reconciliation_limit');
    const rows=(await this.stores.control.query("SELECT id FROM guard_publications WHERE operation_kind='selection' AND state='pending' ORDER BY created_at,id LIMIT $1",[limit])).rows;
    for(const row of rows)try {await this.finish(row.id);}
    catch(error) {if(!(error instanceof HttpError)||error.code!=='derivative_selection_conflict')throw error;}
    return rows.length;
  }

  async current(eventId:string,artifactId:string|null,kind:string,binding:GuardBinding) {
    await this.guards.assertCurrent(binding);
    const row=(await this.stores.derived.query(`SELECT r.revision,d.id,d.content_hash,d.producer,d.producer_version,d.provenance
      FROM derivative_selections s JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
      JOIN derived_artifacts d ON d.id=r.derived_id WHERE s.id=$1`,[selectionId(eventId,artifactId,kind)])).rows[0];
    if(!row)throw new HttpError(409,'derivative_selection_pending');
    const guarded=await this.guards.read('derived_artifacts:'+row.id,binding);
    return {id:row.id,revision:row.revision,guard_revision:guarded.revision,value:guarded.value};
  }

  async versions(eventId:string,after='',limit=50) {
    if(!Number.isInteger(limit)||limit<1||limit>100||after.length>64)throw new HttpError(400,'invalid_derivative_page');
    const rows=(await this.stores.derived.query(`SELECT d.id,d.artifact_id,d.kind,d.created_at,d.source_revision,d.input_hash,
      d.content_hash,d.producer,d.producer_version,d.configuration_hash,d.provenance,g.active_revision AS guard_revision,
      EXISTS(SELECT 1 FROM derivative_selections s JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision WHERE r.derived_id=d.id) AS active
      FROM derived_artifacts d LEFT JOIN guard_sources g ON g.id='derived_artifacts:'||d.id
      WHERE d.event_id=$1 AND d.id>$2 ORDER BY d.id LIMIT $3`,[eventId,after,limit+1])).rows;
    return {versions:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null};
  }
}
