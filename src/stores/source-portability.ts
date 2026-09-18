import {admin,type Reader} from '../access.js';
import {digest,type Envelope} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {decodeBytes,limit} from '../retrieval.js';
import {sourceIdentity,type OriginalManifest} from './archive.js';
import {CaptureCoordinator} from './capture.js';
import {AttachmentRepository} from './attachments.js';

/** Original-only transfer. Intake transport never rewrites observed origin. */
export class SourcePortabilityRepository {
  constructor(readonly capture:CaptureCoordinator,readonly attachments:AttachmentRepository){}
  async record(principal:Reader,id:string) {
    admin(principal);const archive=this.capture.archive,source=await archive.captured(id);
    const row=(await archive.pool.query('SELECT * FROM events WHERE id=$1',[id])).rows[0];
    const event:Envelope={version:1,key:row.source_key,bot_id:row.bot_id,scope:row.scope,source_id:row.source_id,revision:row.revision,
      ...(row.channel==='telegram'?{}:{channel:row.channel}),origin:row.origin,kind:row.kind,occurred_at:row.occurred_at,
      text:row.original_text?.toString()??null,payload:JSON.parse(row.payload.toString()),
      ...(row.wire?{wire_base64:row.wire.toString('base64')}:{}),...(row.source_descriptor?{source:JSON.parse(row.source_descriptor.toString())}:{})};
    const artifacts=(await archive.pool.query('SELECT id,source_ref,kind,metadata,file_hash,byte_size FROM artifacts WHERE event_id=$1 ORDER BY id',[id])).rows
      .map(a=>({...a,byte_size:a.byte_size===null?null:Number(a.byte_size),state:a.file_hash?'ready':'pending'}));
    return {id,source:'nocheh:event:'+id,reference:source.reference,received_at:row.received_at.toISOString(),event,artifacts};
  }
  async page(principal:Reader,after='',count=20) {
    admin(principal);limit(count,20,50);if(after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_export_cursor');
    const rows=(await this.capture.archive.pool.query('SELECT id FROM events WHERE id>$1 ORDER BY id LIMIT $2',[after,count])).rows;
    const records=[];for(const row of rows)records.push(await this.record(principal,row.id));
    return {format:'nocheh-sources-v1',records,next:rows.length===count?rows.at(-1)!.id:null};
  }
  async import(principal:Reader,input:unknown) {
    admin(principal);const record=object(input),{value,id,inputHash}=sourceIdentity(record.event);
    // Refuse lossy routing. Complete/legacy bundles are handled by their own importer.
    if(record.guarded!=null||record.derived!=null&&(!Array.isArray(record.derived)||record.derived.length))throw new HttpError(400,'complete_import_required');
    if(record.id!==undefined&&record.id!==id)throw new HttpError(409,'source_identity_conflict');
    if(record.reference!==undefined) {
      const reference=object(record.reference);
      if(reference.store!=='archive'||reference.kind!=='event'||reference.id!==id||reference.revision!==value.revision||reference.input_hash!==inputHash)
        throw new HttpError(409,'source_reference_conflict');
    }
    const received=record.received_at===undefined?undefined:string(record.received_at,100);
    if(received!==undefined&&!Number.isFinite(Date.parse(received)))throw new HttpError(400,'invalid_timestamp');
    const raw=record.artifacts??[];
    if(!Array.isArray(raw)||raw.length>1000)throw new HttpError(400,'invalid_artifacts');
    const manifests:OriginalManifest[]=raw.map(input=>{
      const item=object(input),ref=string(item.source_ref,4096),artifactId=digest(`${id}:${ref}`),kind=string(item.kind,100);
      if(!ref||!kind)throw new HttpError(400,'invalid_original_manifest');
      if(item.id!==undefined&&item.id!==artifactId)throw new HttpError(409,'artifact_identity_conflict');
      const hash=item.file_hash??null,size=item.byte_size??null;
      if(hash!==null?typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||Number(size)<0:size!==null)
        throw new HttpError(400,'invalid_file_manifest');
      return {id:artifactId,source_ref:ref,kind,metadata:object(item.metadata??{}),file_hash:hash as string|null,byte_size:size as number|null};
    });
    if(new Set(manifests.map(m=>m.id)).size!==manifests.length)throw new HttpError(400,'duplicate_original_manifest');
    // Imports need a durable control admission before archive commit. Unlike live
    // capture they may wait for control; a crash cannot turn history into a live turn.
    await this.capture.control.query(`INSERT INTO source_intakes(event_id,source_revision,input_hash,transport,state)
      VALUES($1,$2,$3,'import','pending') ON CONFLICT DO NOTHING`,[id,value.revision,inputHash]);
    const intake=(await this.capture.control.query('SELECT * FROM source_intakes WHERE event_id=$1',[id])).rows[0];
    if(intake.source_revision!==value.revision||intake.input_hash!==inputHash)throw new HttpError(409,'source_intake_conflict');
    const result=await this.capture.archive.capture(value,{...(received===undefined?{}:{received_at:received}),manifests});
    await this.capture.control.query("UPDATE source_intakes SET state='ready' WHERE event_id=$1 AND transport='import'",[id]);
    await this.capture.handoff(result.source);
    return {id,reference:result.source.reference,duplicate:result.duplicate,telegram_replies:0};
  }
  async upload(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=object(input),bytes=decodeBytes(body.bytes_base64);
    if(body.sha256!==digest(bytes))throw new HttpError(409,'artifact_integrity_failed');
    const file=await this.attachments.commit(id,bytes);return {id,sha256:file.input_hash,bytes:file.byte_size};
  }
  async bytes(principal:Reader,id:string) {admin(principal);return this.attachments.bytes(await this.attachments.file(id));}
}
