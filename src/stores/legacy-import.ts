import {admin,type Reader} from '../access.js';
import {canonical,digest,envelope} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {decodeBytes,limit} from '../retrieval.js';
import {originalEnvelope,type SourceReference,type FileReference} from './archive.js';
import type {OperationReference} from './operations.js';
import type {DerivativeReference} from './derived.js';
import {captureEvidence} from './generated-capture.js';
import type {SourcePortabilityRepository} from './source-portability.js';
import {DerivativePortabilityRepository,type PortableRecord} from './derivative-portability.js';

// Historical imported roots never belong to the destination's execution authority.
const historicalGeneration='00000000-0000-0000-0000-000000000052';
const date=(value:unknown)=>{const text=string(value??'1970-01-01T00:00:00.000Z',100);if(!Number.isFinite(Date.parse(text)))throw new HttpError(400,'invalid_timestamp');return new Date(text).toISOString();};
const wire=(type:string,key:string,value:Record<string,unknown>):PortableRecord=>({format:'nocheh-derivative-record-v1',type,key,value,sha256:digest(canonical({type,key,value}))});
type Root=SourceReference|OperationReference;
type GuardInput={reference:SourceReference|FileReference|DerivativeReference;kind:string;event_id:string|null;original:unknown;input:unknown};

/** Convert legacy mixed records through the explicit source/derivative import APIs.
 * Preserve the exact incoming document before materialization, including edits
 * which conflict with a destination's existing history. No result is activated. */
export class LegacyImportRepository {
  constructor(readonly sources:SourcePortabilityRepository,readonly portable:DerivativePortabilityRepository){}
  private get stores(){return this.portable.stores;}
  private derivative(source:Root,operation:string,kind:string,content:Buffer,created:string,legacy:Record<string,unknown>,file?:FileReference){
    const id=digest('derivative:'+operation),configuration={format:'nocheh-archive-v1',conversion:1},provenance={source,...(file?{file}:{}),configuration,legacy};
    const row={id,event_id:source.store==='archive'?source.id:null,artifact_id:file?.id??null,kind,content:content.toString('base64'),content_hash:digest(content),provenance,
      source_revision:source.store==='archive'?source.revision:'0',input_hash:file?.input_hash??source.input_hash,producer:'legacy-import',producer_version:'1',
      configuration_hash:digest(canonical(configuration)),operation_id:operation,created_at:created,operation_reference:source.store==='control'?source:null};
    return {record:wire('derived_artifacts',id,row),reference:{store:'derived',kind:'artifact',id,input_hash:digest(content)} as DerivativeReference,
      input:{text:content.toString(),kind,provenance}};
  }
  async record(principal:Reader,input:unknown,restoreGuards=false){
    admin(principal);const record=object(input),event=envelope(record.event),id=digest(event.key),created=date(record.received_at);
    if(record.id!==undefined&&record.id!==id)throw new HttpError(409,'source_identity_conflict');
    const rawArtifacts=record.artifacts??[],derivatives=record.derived??[];
    if(!Array.isArray(rawArtifacts)||rawArtifacts.length>1000||!Array.isArray(derivatives)||derivatives.length>1000)throw new HttpError(400,'invalid_artifacts');
    let original=true;try{originalEnvelope(event);}catch(error){if(!(error instanceof HttpError)||error.code!=='original_source_required')throw error;original=false;}
    const operationKey='legacy-import:'+id,operationId=digest(canonical(['operation',historicalGeneration,operationKey]));
    const operation:OperationReference={store:'control',kind:'operation',id:operationId,generation:historicalGeneration,input_hash:digest(canonical(event))};
    await this.portable.restore(principal,[wire('content_operations',operationId,{id:operationId,generation:historicalGeneration,operation_key:operationKey,
      kind:'legacy_import',scope:event.scope,input_hash:operation.input_hash,created_at:created})]);
    const preserved=this.derivative(operation,'legacy:record:'+digest(canonical(record)),'legacy_import_record',Buffer.from(canonical(record)),created,{event_id:id});
    await this.portable.restore(principal,[preserved.record]);
    const artifacts=rawArtifacts.map(raw=>{
      const value=object(raw),size=value.byte_size;
      // Legacy pg bigint fields were serialized as decimal strings. The exact
      // document remains preserved above; typed manifests use safe integers.
      if(typeof size==='string'){if(!/^\d{1,20}$/.test(size)||!Number.isSafeInteger(Number(size)))throw new HttpError(400,'invalid_file_manifest');return {...value,byte_size:Number(size)};}
      return value;
    });
    const mapping=new Map<string,GuardInput>(),files:Record<string,unknown>[]=[];let root:Root=operation;
    const observed:SourceReference[]=[];
    if(original){
      const {derived:_derived,guarded:_guarded,...sourceRecord}=record;
      const captured=await this.sources.import(principal,{...sourceRecord,artifacts});root=captured.reference;observed.push(captured.reference);
      const value={text:event.text,payload:event.payload};mapping.set('events:'+id,{reference:root,kind:'events',event_id:id,original:value,input:value});
    }else{
      // A legacy delivery receipt may contain independently observed Telegram
      // messages. Only those actual API observations become imported originals.
      if(event.origin==='generated')for(const message of captureEvidence(event).originals){
        const captured=await this.sources.import(principal,{event:message,artifacts:[]});observed.push(captured.reference);
      }
      const generated=this.derivative(root,'legacy:event:'+id,event.kind,Buffer.from(event.text??''),created,{event_id:id,envelope:event});
      await this.portable.restore(principal,[generated.record]);
      mapping.set('events:'+id,{reference:generated.reference,kind:'derived_artifacts',event_id:null,original:{text:event.text,payload:event.payload},input:generated.input});
    }
    const manifests=new Map<string,Record<string,any>>();
    for(const raw of artifacts){
      const a=object(raw),ref=string(a.source_ref,4096),artifactId=digest(id+':'+ref);if(a.id!==undefined&&a.id!==artifactId)throw new HttpError(409,'artifact_identity_conflict');
      if(manifests.has(artifactId))throw new HttpError(400,'duplicate_original_manifest');manifests.set(artifactId,a);
      const kind=string(a.kind,100),metadata=object(a.metadata??{}),value={kind,metadata};
      if(a.file_hash!=null&&(typeof a.file_hash!=='string'||!/^[a-f0-9]{64}$/.test(a.file_hash)||!Number.isSafeInteger(a.byte_size)||Number(a.byte_size)<0))throw new HttpError(400,'invalid_file_manifest');
      if(original){
        files.push({id:artifactId,store:'archive'});
        if(a.file_hash!=null){const file:FileReference={store:'archive',kind:'file',id:artifactId,event:root as SourceReference,input_hash:String(a.file_hash),byte_size:Number(a.byte_size)};
          mapping.set('artifacts:'+artifactId,{reference:file,kind:'artifacts',event_id:id,original:value,input:value});}
      }else{
        const manifest=this.derivative(root,'legacy:manifest:'+artifactId,'legacy_file_manifest',Buffer.from(canonical({...a,id:artifactId})),created,{event_id:id,artifact_id:artifactId});
        await this.portable.restore(principal,[manifest.record]);files.push({id:artifactId,store:'derived'});
        mapping.set('artifacts:'+artifactId,{reference:manifest.reference,kind:'derived_artifacts',event_id:null,original:value,input:manifest.input});
      }
    }
    for(const raw of derivatives){
      const d=object(raw),oldId=string(d.id,128),artifactId=d.artifact_id==null?null:string(d.artifact_id,64),content=decodeBytes(d.content_base64,16*1024*1024),kind=string(d.kind,100),provenance=object(d.provenance);
      if(artifactId&&!manifests.has(artifactId))throw new HttpError(400,'invalid_artifact_reference');
      const a=artifactId?manifests.get(artifactId):undefined;
      const file:FileReference|undefined=original&&a?.file_hash?{store:'archive',kind:'file',id:artifactId!,event:root as SourceReference,input_hash:a.file_hash,byte_size:Number(a.byte_size)}:undefined;
      const converted=this.derivative(root,'legacy:derived:'+oldId,kind,content,date(d.created_at??record.received_at),{id:oldId,event_id:id,artifact_id:artifactId,provenance,
        ...(artifactId&&!file?{file_reference_unavailable:true}:{})},file);
      await this.portable.restore(principal,[converted.record]);mapping.set('derived_artifacts:'+oldId,{reference:converted.reference,kind:'derived_artifacts',event_id:original?id:null,
        original:{text:content.toString(),kind,provenance},input:converted.input});
    }
    let guarded=0;
    if(restoreGuards&&record.guarded!=null){
      const bundle=object(record.guarded);
      if(bundle.format!=='nocheh-guarded-v1'||!Array.isArray(bundle.sources)||bundle.sources.length>1001)throw new HttpError(400,'invalid_guarded_export');
      for(const raw of bundle.sources){
        const entry=object(raw),oldId=string(entry.id,256),mapped=mapping.get(oldId),revisions=entry.revisions;
        if(!mapped||!Array.isArray(revisions)||!revisions.length||revisions.length>10000||entry.active_revision!==revisions.length)throw new HttpError(409,'legacy_guard_source_unavailable');
        const guardId=mapped.kind+':'+mapped.reference.id,newInput=Buffer.from(canonical(mapped.input)),inputHash=digest(newInput),legacyHash=digest(canonical(mapped.original));
        const converted:PortableRecord[]=[wire('guard_sources',guardId,{id:guardId,event_id:mapped.event_id,kind:mapped.kind,source_id:mapped.reference.id,reference:mapped.reference,
          input_hash:inputHash,input:newInput.toString('base64'),active_revision:entry.active_revision,state:'pending',created_at:date(revisions[0].created_at)})];
        for(const [index,rawRevision] of revisions.entries()){
          const revision=object(rawRevision),value=object(revision.content);
          if(revision.revision!==index+1||revision.input_hash!==legacyHash||!['automatic','owner'].includes(String(revision.author)))throw new HttpError(409,'guard_restore_integrity');
          let guardedValue=value;
          if(mapped.kind==='derived_artifacts'&&!oldId.startsWith('derived_artifacts:')){
            const originalKind=oldId.startsWith('events:')?event.kind:'legacy_file_manifest';
            guardedValue={text:oldId.startsWith('events:')?value.text??'':canonical(value),kind:originalKind,
              provenance:oldId.startsWith('events:')?{legacy_guarded_payload:object(value.payload)}:{}};
          }
          const revisionId=digest(guardId+':'+revision.revision);
          converted.push(wire('guard_revisions',revisionId,{id:revisionId,source_id:guardId,revision:revision.revision,content:Buffer.from(canonical(guardedValue)).toString('base64'),
            input_hash:inputHash,author:revision.author,preparation_version:'legacy:'+string(revision.preparation_version,240),operation_id:'legacy:guard:'+digest(oldId)+':'+revision.revision,
            expected_revision:index===0?null:index,created_at:date(revision.created_at)}));
        }
        for(let offset=0;offset<converted.length;offset+=100)await this.portable.restore(principal,converted.slice(offset,offset+100));
        for(let offset=0;offset<converted.length;offset+=100)await this.portable.verify(principal,converted.slice(offset,offset+100));guarded++;
      }
    }
    return {id,store:original?'archive':'derived',record:preserved.reference,sources:observed,files,guarded,activated:false,telegram_replies:0};
  }
  async upload(principal:Reader,id:string,input:unknown){
    admin(principal);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_identity');const body=object(input),bytes=decodeBytes(body.bytes_base64);
    const saved=(await this.stores.derived.query('SELECT * FROM derived_artifacts WHERE operation_id=$1 AND imported',['legacy:manifest:'+id])).rows[0];
    if(!saved||digest(saved.content)!==saved.content_hash)throw new HttpError(404,'legacy_manifest_missing');
    const manifest=object(JSON.parse(saved.content.toString()));
    if(body.sha256!==digest(bytes)||manifest.file_hash!==body.sha256||manifest.byte_size!==bytes.length)throw new HttpError(409,'artifact_integrity_failed');
    const output=this.derivative(saved.operation_reference,'legacy:file:'+id,'legacy_generated_file',bytes,saved.created_at.toISOString(),{artifact_id:id,manifest});
    await this.portable.restore(principal,[output.record]);return {id,store:'derived',reference:output.reference,bytes:bytes.length,sha256:body.sha256};
  }
  async inspect(principal:Reader,id:string,after='',count=20){
    admin(principal);limit(count,20,50);if(!/^[a-f0-9]{64}$/.test(id)||after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_identity');
    const rows=(await this.stores.derived.query(`SELECT id,content,content_hash,created_at FROM derived_artifacts
      WHERE kind='legacy_import_record' AND provenance->'legacy'->>'event_id'=$1 AND id>$2 ORDER BY id LIMIT $3`,[id,after,count])).rows;
    for(const row of rows)if(digest(row.content)!==row.content_hash)throw new HttpError(409,'derivative_integrity_failed');
    return {records:rows.map(row=>({id:row.id,reference:{store:'derived',kind:'artifact',id:row.id,input_hash:row.content_hash},record:JSON.parse(row.content.toString()),created_at:row.created_at})),
      next:rows.length===count?rows.at(-1)!.id:null};
  }
}
