import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {prepareValue,textValues} from '../guarded.js';
import {requestWorkflow} from '../workflows/store.js';
import {ArchiveRepository,type SourceReference,type FileReference} from './archive.js';
import type {DerivativeReference} from './derived.js';
import type {StorePools} from './connections.js';
import {revokeBeforePublication} from './publications.js';

export type GuardReference=SourceReference|FileReference|DerivativeReference;
export interface GuardBinding {generation:string;epoch:number;mode:'on'|'off'}
export interface GuardRevision {source_id:string;revision:number;operation_id:string;expected_revision:number|null}

export class GuardRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository){}

  async state():Promise<GuardBinding> {
    const row=(await this.stores.control.query(`SELECT i.generation,g.epoch,g.mode,
      EXISTS(SELECT 1 FROM guard_publications WHERE state='pending') AS pending
      FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton`)).rows[0];
    if(!row||row.pending)throw new HttpError(409,'guard_transition_pending');
    return {generation:row.generation,epoch:Number(row.epoch),mode:row.mode};
  }

  async assertCurrent(binding:GuardBinding):Promise<void> {
    const state=await this.state();
    if(canonical(state)!==canonical(binding))throw new HttpError(409,'guard_context_changed');
  }

  async setMode(mode:'on'|'off'):Promise<GuardBinding> {
    if(!['on','off'].includes(mode))throw new HttpError(400,'invalid_guard_mode');
    const client=await this.stores.control.connect();
    try {
      await client.query('BEGIN');
      const current=(await client.query('SELECT mode FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
      if((await client.query("SELECT 1 FROM guard_publications WHERE state='pending' LIMIT 1")).rowCount)
        throw new HttpError(409,'guard_transition_pending');
      if(current.mode!==mode) {
        const epoch=Number((await client.query('UPDATE guard_state SET mode=$1,epoch=epoch+1 WHERE singleton RETURNING epoch',[mode])).rows[0].epoch);
        await requestWorkflow(client,'honcho','refresh',epoch);await requestWorkflow(client,'memory_review','refresh',epoch);
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    return this.state();
  }

  async register(reference:GuardReference):Promise<string> {
    let id:string,eventId:string,kind:string,input:unknown;
    if(reference.store==='archive'&&reference.kind==='event') {
      await this.archive.verify(reference);
      const row=(await this.stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[reference.id])).rows[0];
      kind='events';id=`events:${reference.id}`;eventId=reference.id;
      input={text:row.original_text?.toString()??null,payload:JSON.parse(row.payload.toString())};
    } else if(reference.store==='archive'&&reference.kind==='file') {
      await this.archive.verify(reference.event);
      const row=(await this.stores.archive.query('SELECT event_id,kind,metadata,file_hash,byte_size FROM artifacts WHERE id=$1',[reference.id])).rows[0];
      if(!row||row.event_id!==reference.event.id||row.file_hash!==reference.input_hash||Number(row.byte_size)!==reference.byte_size)
        throw new HttpError(409,'file_reference_conflict');
      kind='artifacts';id=`artifacts:${reference.id}`;eventId=row.event_id;input={kind:row.kind,metadata:row.metadata};
    } else if(reference.store==='derived'&&reference.kind==='artifact') {
      const row=(await this.stores.derived.query('SELECT event_id,content,content_hash,kind,provenance FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
      if(!row||row.content_hash!==reference.input_hash)throw new HttpError(409,'derivative_reference_conflict');
      await this.archive.captured(row.event_id);
      let text:string;try {text=new TextDecoder('utf-8',{fatal:true}).decode(row.content);}
      catch {throw new HttpError(422,'guard_unsupported_binary');}
      kind='derived_artifacts';id=`derived_artifacts:${reference.id}`;eventId=row.event_id;input={text,kind:row.kind,provenance:row.provenance};
    } else throw new HttpError(400,'invalid_guard_reference');
    const bytes=Buffer.from(canonical(input)),hash=digest(bytes);
    await this.stores.derived.query(`INSERT INTO guard_sources(id,event_id,kind,source_id,reference,input_hash,input)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[id,eventId,kind,reference.id,JSON.stringify(reference),hash,bytes]);
    const saved=(await this.stores.derived.query('SELECT reference,input_hash FROM guard_sources WHERE id=$1',[id])).rows[0];
    if(saved.input_hash!==hash||canonical(saved.reference)!==canonical(reference))throw new HttpError(409,'guard_source_conflict');
    return id;
  }

  private async stage(id:string,expected:number|null,content:unknown,author:'automatic'|'owner',version:string,operationId:string):Promise<GuardRevision> {
    if(expected!==null&&(!Number.isSafeInteger(expected)||expected<1))throw new HttpError(400,'invalid_revision');
    if(!operationId||Buffer.byteLength(operationId)>200)throw new HttpError(400,'invalid_guard_operation');
    const value=object(content),serialized=canonical(value);
    if(Buffer.byteLength(serialized)>8*1024*1024)throw new HttpError(413,'guard_edit_too_large');
    const client=await this.stores.derived.connect();
    try {
      await client.query('BEGIN');
      const source=(await client.query('SELECT * FROM guard_sources WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!source)throw new HttpError(404,'guard_source_missing');
      if(source.kind==='events'){if(value.text!==null)string(value.text,2000000);object(value.payload);}
      else if(source.kind==='artifacts'){string(value.kind,100);object(value.metadata);}
      else {string(value.text,4000000);string(value.kind,100);object(value.provenance);}
      const previous=(await client.query('SELECT * FROM guard_revisions WHERE operation_id=$1',[operationId])).rows[0];
      if(previous) {
        if(previous.source_id!==id||previous.expected_revision!==expected||previous.content.toString()!==serialized||
          previous.author!==author||previous.preparation_version!==version)throw new HttpError(409,'guard_operation_conflict');
        await client.query('COMMIT');return {source_id:id,revision:previous.revision,operation_id:operationId,expected_revision:expected};
      }
      if(source.active_revision!==expected)throw new HttpError(409,'guard_revision_conflict');
      const revision=Number((await client.query('SELECT coalesce(max(revision),0)+1 AS revision FROM guard_revisions WHERE source_id=$1',[id])).rows[0].revision);
      await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version,operation_id,expected_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[digest(`${id}:${revision}`),id,revision,Buffer.from(serialized),
        textValues(value).join('\n').replaceAll('\0',''),source.input_hash,author,version,operationId,expected]);
      await client.query('COMMIT');return {source_id:id,revision,operation_id:operationId,expected_revision:expected};
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }

  /** Begin revocation before changing any active derived pointer. */
  async beginPublication(revision:GuardRevision):Promise<void> {
    const saved=(await this.stores.derived.query('SELECT source_id,revision,expected_revision FROM guard_revisions WHERE operation_id=$1',[revision.operation_id])).rows[0];
    if(!saved||saved.source_id!==revision.source_id||saved.revision!==revision.revision||saved.expected_revision!==revision.expected_revision)
      throw new HttpError(409,'guard_operation_conflict');
    await revokeBeforePublication(this.stores.control,{...revision,kind:'guard'});
  }

  /** Safe to retry after either database commit, including an uncertain response. */
  async finishPublication(operationId:string):Promise<void> {
    const operation=(await this.stores.control.query('SELECT * FROM guard_publications WHERE id=$1',[operationId])).rows[0];
    if(!operation)throw new HttpError(404,'guard_publication_missing');
    if(operation.operation_kind!=='guard')throw new HttpError(409,'guard_operation_conflict');
    if(operation.state==='done')return;
    if(operation.state==='conflict')throw new HttpError(409,'guard_revision_conflict');
    const client=await this.stores.derived.connect();let conflict=false;
    try {
      await client.query('BEGIN');
      const source=(await client.query('SELECT active_revision FROM guard_sources WHERE id=$1 FOR UPDATE',[operation.source_id])).rows[0];
      const revision=(await client.query('SELECT source_id,revision FROM guard_revisions WHERE operation_id=$1',[operationId])).rows[0];
      if(!source||!revision||revision.source_id!==operation.source_id||revision.revision!==operation.revision)
        throw new HttpError(409,'guard_publication_incomplete');
      const activated=(await client.query('SELECT 1 FROM guard_activations WHERE operation_id=$1',[operationId])).rowCount;
      if(!activated) {
        if(source.active_revision!==operation.expected_revision)conflict=true;
        else {
          await client.query("UPDATE guard_sources SET active_revision=$2,state='ready' WHERE id=$1",[operation.source_id,operation.revision]);
          await client.query('INSERT INTO guard_activations(operation_id,source_id,revision) VALUES($1,$2,$3)',[operationId,operation.source_id,operation.revision]);
        }
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
    await this.stores.control.query("UPDATE guard_publications SET state=$2,completed_at=now() WHERE id=$1 AND state='pending'",[operationId,conflict?'conflict':'done']);
    if(conflict)throw new HttpError(409,'guard_revision_conflict');
  }

  async reconcile(limit=100):Promise<number> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_reconciliation_limit');
    const rows=(await this.stores.control.query("SELECT id FROM guard_publications WHERE state='pending' AND operation_kind='guard' ORDER BY created_at,id LIMIT $1",[limit])).rows;
    for(const row of rows)try {await this.finishPublication(row.id);}
    catch(error) {if(!(error instanceof HttpError)||error.code!=='guard_revision_conflict')throw error;}
    return rows.length;
  }

  async prepare(reference:GuardReference,version:string,detect:(text:string)=>Promise<unknown>):Promise<GuardRevision|null> {
    const id=await this.register(reference),source=(await this.stores.derived.query('SELECT input,input_hash,active_revision FROM guard_sources WHERE id=$1',[id])).rows[0];
    if(source.active_revision!==null)return null; // Includes authoritative owner edits.
    const client=await this.stores.derived.connect();let content:unknown;
    try {content=await prepareValue(client,id,JSON.parse(source.input.toString()),version,detect);}
    finally {client.release();}
    const operationId=digest(canonical(['guard',id,source.input_hash,version]));
    let revision:GuardRevision;
    try {revision=await this.stage(id,null,content,'automatic',version,operationId);}
    catch(error) {if(error instanceof HttpError&&error.code==='guard_revision_conflict')return null;throw error;}
    await this.beginPublication(revision);await this.finishPublication(operationId);return revision;
  }

  async edit(id:string,expected:number|null,content:unknown,operationId:string):Promise<GuardRevision> {
    const revision=await this.stage(id,expected,content,'owner','owner-edit-v1',operationId);
    await this.beginPublication(revision);await this.finishPublication(operationId);return revision;
  }

  async restore(id:string,expected:number|null,oldRevision:number,operationId:string):Promise<GuardRevision> {
    if(!Number.isSafeInteger(oldRevision)||oldRevision<1)throw new HttpError(400,'invalid_revision');
    const old=(await this.stores.derived.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,oldRevision])).rows[0];
    if(!old)throw new HttpError(404,'guard_revision_missing');
    return this.edit(id,expected,JSON.parse(old.content.toString()),operationId);
  }

  async history(id:string,before=2147483647):Promise<{revisions:unknown[];next:number|null}> {
    if(!Number.isInteger(before)||before<1||before>2147483647)throw new HttpError(400,'invalid_revision');
    const rows=(await this.stores.derived.query(`SELECT r.revision,r.author,r.preparation_version,r.created_at,
      r.operation_id,r.expected_revision,a.activated_at FROM guard_revisions r LEFT JOIN guard_activations a USING(operation_id)
      WHERE r.source_id=$1 AND r.revision<$2 ORDER BY r.revision DESC LIMIT 51`,[id,before])).rows;
    return {revisions:rows.slice(0,50),next:rows.length>50?rows[49].revision:null};
  }

  async read(id:string,binding:GuardBinding):Promise<{value:unknown;revision:number|null}> {
    await this.assertCurrent(binding);
    const row=(await this.stores.derived.query(`SELECT s.input,s.active_revision,s.state,r.content FROM guard_sources s
      LEFT JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.id=$1`,[id])).rows[0];
    if(!row)throw new HttpError(409,'guard_preparation_pending');
    if(binding.mode==='on'&&(row.state!=='ready'||!row.content))throw new HttpError(409,'guard_preparation_pending');
    const result={value:JSON.parse((binding.mode==='on'?row.content:row.input).toString()),revision:binding.mode==='on'?row.active_revision:null};
    await this.assertCurrent(binding);return result;
  }
}
