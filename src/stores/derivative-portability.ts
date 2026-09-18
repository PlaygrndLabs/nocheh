import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {decodeBytes,limit} from '../retrieval.js';
import {textValues} from '../guarded.js';
import type {StorePools} from './connections.js';
import type {ArchiveRepository,SourceReference} from './archive.js';
import {selectionId} from './selections.js';

type Field='text'|'bytes'|'json'|'number'|'date'|'boolean';
type Shape={store:'derived'|'control';key:string;fields:Record<string,Field>;historyOnly?:boolean};
const shape=(store:Shape['store'],key:string,fields:Record<string,Field>,historyOnly=false):Shape=>({store,key,fields,historyOnly});
// Table identifiers and columns are fixed by code; bundles supply only values.
const shapes:Record<string,Shape>={
  content_operations:shape('control','id',{id:'text',generation:'text',operation_key:'text',kind:'text',scope:'text',input_hash:'text',created_at:'date'}),
  derived_artifacts:shape('derived','id',{id:'text',event_id:'text',artifact_id:'text',kind:'text',content:'bytes',content_hash:'text',provenance:'json',source_revision:'text',input_hash:'text',producer:'text',producer_version:'text',configuration_hash:'text',operation_id:'text',created_at:'date',operation_reference:'json'}),
  guard_sources:shape('derived','id',{id:'text',event_id:'text',kind:'text',source_id:'text',reference:'json',input_hash:'text',input:'bytes',active_revision:'number',state:'text',created_at:'date'}),
  guard_revisions:shape('derived','id',{id:'text',source_id:'text',revision:'number',content:'bytes',input_hash:'text',author:'text',preparation_version:'text',operation_id:'text',expected_revision:'number',created_at:'date'}),
  guard_activations:shape('derived','operation_id',{operation_id:'text',source_id:'text',revision:'number',activated_at:'date'}),
  guard_fragments:shape('derived','id',{id:'text',source_id:'text',input_hash:'text',preparation_version:'text',content:'bytes',created_at:'date'},true),
  runtime_prepared_values:shape('derived','id',{id:'text',audience:'text',generation:'text',epoch:'number',content:'bytes'},true),
  runtime_prepared_inputs:shape('derived','id',{id:'text',audience:'text',generation:'text',epoch:'number',source_id:'text'},true),
  derivative_selections:shape('derived','id',{id:'text',event_id:'text',artifact_id:'text',kind:'text',active_revision:'number'}),
  derivative_selection_revisions:shape('derived','operation_id',{operation_id:'text',selection_id:'text',revision:'number',expected_revision:'number',derived_id:'text',author:'text',created_at:'date'}),
  derivative_activations:shape('derived','operation_id',{operation_id:'text',activated_at:'date'}),
  learned_entries:shape('derived','id',{id:'text',scope_kind:'text',scope_id:'text',kind:'text',subject:'text',active_revision:'number',created_at:'date'}),
  learned_versions:shape('derived','operation_id',{operation_id:'text',entry_id:'text',revision:'number',expected_revision:'number',derived_id:'text',request_hash:'text',author:'text',retired:'boolean',evidence:'json',dependencies:'json',input_binding:'json',created_at:'date'}),
  learned_activations:shape('derived','operation_id',{operation_id:'text',activated_at:'date'})
};
export const portableDerivativeTypes=Object.keys(shapes);
export interface PortableRecord {format:'nocheh-derivative-record-v1';type:string;key:string;value:Record<string,unknown>;sha256:string}
function wire(type:string,row:Record<string,unknown>):PortableRecord {
  const definition=shapes[type]!,value:Record<string,unknown>={};
  for(const [name,kind] of Object.entries(definition.fields)) {
    const field=row[name];value[name]=field===null?null:kind==='bytes'?(field as Buffer).toString('base64'):kind==='date'?(field as Date).toISOString():kind==='number'?Number(field):field;
  }
  const key=String(value[definition.key]);return {format:'nocheh-derivative-record-v1',type,key,value,sha256:digest(canonical({type,key,value}))};
}
function parse(input:unknown):{record:PortableRecord;definition:Shape;row:Record<string,unknown>} {
  const value=object(input),type=string(value.type,80),definition=Object.hasOwn(shapes,type)?shapes[type]:undefined;
  if(value.format!=='nocheh-derivative-record-v1'||!definition)throw new HttpError(400,'invalid_portable_record');
  const content=object(value.value),key=string(value.key,1024);
  if(Object.keys(content).length!==Object.keys(definition.fields).length||Object.keys(content).some(k=>!Object.hasOwn(definition.fields,k))||content[definition.key]!==key)
    throw new HttpError(400,'invalid_portable_fields');
  if(digest(canonical({type,key,value:content}))!==value.sha256)throw new HttpError(409,'portable_record_integrity');
  const row:Record<string,unknown>={};
  for(const [name,kind] of Object.entries(definition.fields)) {
    const field=content[name];if(field===null){row[name]=null;continue;}
    if(kind==='bytes')row[name]=decodeBytes(field,50*1024*1024);
    else if(kind==='text')row[name]=string(field,100000);
    else if(kind==='json'){if(typeof field!=='object'||field===null)throw new HttpError(400,'invalid_portable_json');row[name]=field;}
    else if(kind==='date'){const text=string(field,100);if(!Number.isFinite(Date.parse(text)))throw new HttpError(400,'invalid_portable_date');row[name]=new Date(text);}
    else if(kind==='number'){if(!Number.isSafeInteger(field))throw new HttpError(400,'invalid_portable_number');row[name]=field;}
    else {if(typeof field!=='boolean')throw new HttpError(400,'invalid_portable_boolean');row[name]=field;}
  }
  return {record:{format:'nocheh-derivative-record-v1',type,key,value:content,sha256:String(value.sha256)},definition,row};
}

/** Transfer immutable content/history, never operational authority or grants. */
export class DerivativePortabilityRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository){}
  async page(principal:Reader,type:string,after='',count=50) {
    admin(principal);limit(count,50,100);string(after,1024);
    const definition=Object.hasOwn(shapes,type)?shapes[type]:undefined;if(!definition)throw new HttpError(400,'invalid_portable_record_type');
    const db=this.stores[definition.store],rows=(await db.query(`SELECT ${definition.key} FROM ${type} WHERE ${definition.key}>$1 ORDER BY ${definition.key} LIMIT $2`,[after,count])).rows;
    const records:PortableRecord[]=[];let size=0;
    for(const row of rows) {
      const selected=(await db.query(`SELECT ${Object.keys(definition.fields).join(',')} FROM ${type} WHERE ${definition.key}=$1`,[row[definition.key]])).rows[0],record=wire(type,selected),bytes=Buffer.byteLength(JSON.stringify(record));
      if(records.length&&size+bytes>8*1024*1024)break;records.push(record);size+=bytes;
    }
    return {format:'nocheh-derivatives-v1',type,records,next:records.length<rows.length||rows.length===count?records.at(-1)!.key:null};
  }
  async history(principal:Reader,after='',count=50) {
    admin(principal);limit(count,50,100);if(after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_export_cursor');
    const rows=(await this.stores.derived.query('SELECT id FROM portable_records WHERE id>$1 ORDER BY id LIMIT $2',[after,count])).rows;
    const records:PortableRecord[]=[];let size=0,cursor=after;
    for(const row of rows) {
      const saved=(await this.stores.derived.query('SELECT content FROM portable_records WHERE id=$1',[row.id])).rows[0].content as Buffer;
      if(records.length&&size+saved.length>8*1024*1024)break;records.push(JSON.parse(saved.toString()));size+=saved.length;cursor=row.id;
    }
    return {format:'nocheh-derivative-history-v1',records,next:records.length<rows.length||rows.length===count?cursor:null};
  }
  /** Persist before materialization. A rejected/conflicting import cannot lose
   * owner history, and cache records are inspectable without being reusable. */
  async retain(principal:Reader,input:unknown):Promise<string> {
    admin(principal);const {record}=parse(input),bytes=Buffer.from(canonical(record)),id=digest(bytes);
    await this.stores.derived.query(`INSERT INTO portable_records(id,record_type,record_key,content,content_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[id,record.type,record.key,bytes,digest(bytes)]);
    return id;
  }
  async restore(principal:Reader,inputs:unknown[]) {
    admin(principal);if(!Array.isArray(inputs)||!inputs.length||inputs.length>100)throw new HttpError(400,'portable_batch_limit');
    const parsed=inputs.map(parse);
    for(const {record} of parsed)await this.retain(principal,record);
    // Control references are historical only. Operational receipt/job tables are
    // absent from the format, and imported roots cannot authorize new effects.
    for(const entry of parsed.filter(p=>p.definition.store==='control'))await this.insert(this.stores.control,entry);
    const db=await this.stores.derived.connect();
    try {
      await db.query('BEGIN');
      for(const entry of parsed.filter(p=>p.definition.store==='derived'&&!p.definition.historyOnly))await this.insert(db,entry);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return {retained:parsed.length,activated:false};
  }
  /** Call after every declared record has been transferred, including parents
   * and revision history. This checks completeness without activating imports. */
  async verify(principal:Reader,inputs:unknown[]) {
    admin(principal);if(!Array.isArray(inputs)||inputs.length>100)throw new HttpError(400,'portable_batch_limit');
    for(const input of inputs) {
      const {record,definition,row}=parse(input),retained=(await this.stores.derived.query('SELECT 1 FROM portable_records WHERE id=$1',[digest(Buffer.from(canonical(record)))])).rowCount;
      if(!retained)throw new HttpError(409,'portable_record_missing');
      if(definition.historyOnly)continue;
      const db=this.stores[definition.store],saved=(await db.query(`SELECT ${definition.key} FROM ${record.type} WHERE ${definition.key}=$1`,[record.key])).rowCount;
      if(!saved)throw new HttpError(409,'portable_record_missing');
      await this.validate(db,record.type,row);
      if(row.active_revision!==undefined&&row.active_revision!==null) {
        const target=record.type==='guard_sources'?['guard_revisions','source_id']:record.type==='derivative_selections'?['derivative_selection_revisions','selection_id']:['learned_versions','entry_id'];
        if(!(await this.stores.derived.query(`SELECT 1 FROM ${target[0]} WHERE ${target[1]}=$1 AND revision=$2`,[record.key,row.active_revision])).rowCount)throw new HttpError(409,'portable_history_incomplete');
      }
    }
    return {verified:inputs.length,activated:false};
  }
  private async insert(db:Pick<pg.Pool,'query'>,entry:ReturnType<typeof parse>) {
    const {record,definition,row}=entry,type=record.type;
    await this.validate(db,type,row);
    const saved={...row};
    if(type==='guard_sources')saved.state='pending';
    if(type==='learned_entries'||type==='derivative_selections'||type==='content_operations')saved.imported=true;
    if(type==='derived_artifacts')saved.search_text=(row.content as Buffer).toString().replaceAll('\0','');
    if(type==='guard_revisions')saved.search_text=textValues(JSON.parse((row.content as Buffer).toString())).join('\n').replaceAll('\0','');
    const columns=Object.keys(saved),values=columns.map(name=>definition.fields[name]==='json'&&saved[name]!==null?JSON.stringify(saved[name]):saved[name]);
    await db.query(`INSERT INTO ${type}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT DO NOTHING`,values);
    const current=(await db.query(`SELECT ${Object.keys(definition.fields).join(',')} FROM ${type} WHERE ${definition.key}=$1`,[record.key])).rows[0];
    if(!current)throw new HttpError(409,'portable_identity_conflict');
    const previous=wire(type,current).value,next={...record.value};
    // Imported history cannot replace an existing selection or edit. Preserve
    // current heads while accepting identical immutable versions independently.
    for(const key of ['active_revision',...(type==='guard_sources'?['state']:[])]){delete previous[key];delete next[key];}
    if(canonical(previous)!==canonical(next))throw new HttpError(409,'portable_identity_conflict');
  }
  private async validate(db:Pick<pg.Pool,'query'>,type:string,row:Record<string,unknown>) {
    if(row.active_revision!==undefined&&row.active_revision!==null&&Number(row.active_revision)<1)throw new HttpError(400,'invalid_portable_revision');
    if(row.revision!==undefined&&Number(row.revision)<1||row.expected_revision!==undefined&&row.expected_revision!==null&&(Number(row.expected_revision)<1||Number(row.expected_revision)>=Number(row.revision)))throw new HttpError(400,'invalid_portable_revision');
    if(type==='content_operations') {
      if(row.id!==digest(canonical(['operation',row.generation,row.operation_key]))||!/^[a-f0-9]{64}$/.test(String(row.input_hash)))throw new HttpError(409,'portable_operation_integrity');
    }
    if(type==='derived_artifacts') {
      if(row.id!==digest('derivative:'+row.operation_id)||digest(row.content as Buffer)!==row.content_hash)throw new HttpError(409,'portable_derivative_integrity');
      const provenance=object(row.provenance),source=object(provenance.source);
      if(row.event_id!==null) {
        if(source.store!=='archive'||source.kind!=='event'||source.id!==row.event_id||source.revision!==row.source_revision||row.operation_reference!==null)throw new HttpError(409,'portable_source_integrity');
        await this.archive.verify(source as unknown as SourceReference);
      } else {
        if(source.store!=='control'||source.kind!=='operation'||canonical(source)!==canonical(row.operation_reference)||row.artifact_id!==null)throw new HttpError(409,'portable_operation_integrity');
        const operation=(await this.stores.control.query('SELECT generation,input_hash FROM content_operations WHERE id=$1',[source.id])).rows[0];
        if(!operation||operation.generation!==source.generation||operation.input_hash!==source.input_hash)throw new HttpError(409,'portable_operation_integrity');
      }
      if(digest(canonical(object(provenance.configuration)))!==row.configuration_hash)throw new HttpError(409,'portable_configuration_integrity');
      if(row.artifact_id!==null) {
        const file=object(provenance.file),stored=(await this.stores.archive.query('SELECT event_id,file_hash,byte_size FROM artifacts WHERE id=$1',[row.artifact_id])).rows[0];
        if(file.store!=='archive'||file.kind!=='file'||file.id!==row.artifact_id||canonical(file.event)!==canonical(source)||!stored||stored.event_id!==row.event_id||stored.file_hash!==file.input_hash||Number(stored.byte_size)!==file.byte_size||row.input_hash!==file.input_hash)
          throw new HttpError(409,'file_reference_conflict');
      } else if(!provenance.parents&&row.input_hash!==source.input_hash)throw new HttpError(409,'portable_input_integrity');
      if(provenance.parents!==undefined) {
        if(row.artifact_id!==null||!Array.isArray(provenance.parents)||!provenance.parents.length||provenance.parents.length>100)throw new HttpError(409,'portable_parent_integrity');
        for(const value of provenance.parents) {
          const parent=object(value);
          if(parent.store!=='derived'||parent.kind!=='artifact'||parent.id===row.id)throw new HttpError(409,'portable_parent_integrity');
          const saved=(await db.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[parent.id])).rows[0];
          if(!saved)throw new HttpError(409,'portable_parent_pending');
          if(saved.content_hash!==parent.input_hash)throw new HttpError(409,'portable_parent_integrity');
        }
        if(row.input_hash!==(provenance.parents.length===1?provenance.parents[0].input_hash:digest(canonical(provenance.parents))))throw new HttpError(409,'portable_input_integrity');
      }
    }
    if(type==='guard_sources') {
      const reference=object(row.reference);let expected:unknown;
      if(row.id!==row.kind+':'+row.source_id||reference.id!==row.source_id)throw new HttpError(409,'portable_guard_integrity');
      if(row.kind==='events') {
        await this.archive.verify(reference as unknown as SourceReference);
        const source=(await this.stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[reference.id])).rows[0];
        expected={text:source.original_text?.toString()??null,payload:JSON.parse(source.payload.toString())};
        if(row.event_id!==reference.id)throw new HttpError(409,'portable_guard_integrity');
      } else if(row.kind==='artifacts') {
        const file=(await this.stores.archive.query('SELECT * FROM artifacts WHERE id=$1',[reference.id])).rows[0];
        if(reference.store!=='archive'||reference.kind!=='file'||!file||file.event_id!==row.event_id||file.file_hash!==reference.input_hash||Number(file.byte_size)!==reference.byte_size)throw new HttpError(409,'portable_guard_integrity');
        await this.archive.verify(reference.event as SourceReference);if((reference.event as SourceReference).id!==file.event_id)throw new HttpError(409,'portable_guard_integrity');
        expected={kind:file.kind,metadata:file.metadata};
      } else if(row.kind==='derived_artifacts') {
        const artifact=(await db.query('SELECT * FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
        if(reference.store!=='derived'||reference.kind!=='artifact'||!artifact||artifact.content_hash!==reference.input_hash||artifact.event_id!==row.event_id)throw new HttpError(409,'portable_guard_integrity');
        expected={text:artifact.content.toString(),kind:artifact.kind,provenance:artifact.provenance};
      } else throw new HttpError(409,'portable_guard_integrity');
      if(canonical(expected)!==(row.input as Buffer).toString()||digest(row.input as Buffer)!==row.input_hash)throw new HttpError(409,'portable_guard_integrity');
    }
    if(type==='guard_revisions') {
      const source=(await db.query('SELECT input_hash,kind FROM guard_sources WHERE id=$1',[row.source_id])).rows[0];
      if(!source||source.input_hash!==row.input_hash||row.id!==digest(row.source_id+':'+row.revision))throw new HttpError(409,'portable_guard_integrity');
      const value=object(JSON.parse((row.content as Buffer).toString()));
      if(source.kind==='events'){if(value.text!==null)string(value.text,2000000);object(value.payload);}
      else if(source.kind==='artifacts'){string(value.kind,100);object(value.metadata);}
      else {string(value.text,4000000);string(value.kind,100);object(value.provenance);}
    }
    if(type==='derivative_selections') {
      if(row.id!==selectionId(String(row.event_id),row.artifact_id as string|null,String(row.kind)))throw new HttpError(409,'portable_selection_integrity');
      await this.archive.captured(String(row.event_id));
      if(row.artifact_id!==null&&!(await this.stores.archive.query('SELECT 1 FROM artifacts WHERE id=$1 AND event_id=$2',[row.artifact_id,row.event_id])).rowCount)throw new HttpError(409,'file_reference_conflict');
    }
    if(type==='derivative_selection_revisions') {
      const match=(await db.query(`SELECT 1 FROM derivative_selections s JOIN derived_artifacts d ON d.event_id=s.event_id
        AND d.artifact_id IS NOT DISTINCT FROM s.artifact_id AND d.kind=s.kind WHERE s.id=$1 AND d.id=$2`,[row.selection_id,row.derived_id])).rowCount;
      if(!match)throw new HttpError(409,'portable_selection_integrity');
    }
    if(type==='learned_versions') {
      if(!Array.isArray(row.evidence)||!row.evidence.length||row.evidence.length>30)throw new HttpError(400,'invalid_learning_evidence');
      for(const reference of row.evidence)await this.archive.verify(reference);
      const stored=(await db.query(`SELECT e.scope_kind,e.scope_id,e.kind,e.subject,d.provenance FROM learned_entries e
        JOIN derived_artifacts d ON d.id=$2 AND d.kind='learned_memory' WHERE e.id=$1`,[row.entry_id,row.derived_id])).rows[0];
      const learning=stored?.provenance?.learning;
      if(!learning||learning.scope?.kind!==stored.scope_kind||learning.scope?.id!==stored.scope_id||learning.kind!==stored.kind||learning.subject!==stored.subject||canonical(learning.evidence)!==canonical(row.evidence))throw new HttpError(409,'portable_learning_integrity');
    }
  }
}
