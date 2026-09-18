import type pg from 'pg';
import {attachmentRefs,canonical,digest,envelope,type Envelope} from '../archive.js';
import {projectSource} from '../source-model.js';
import {observedSource} from '../observed-source.js';
import {HttpError} from '../http.js';

export interface SourceReference {
  store:'archive';kind:'event';id:string;revision:string;input_hash:string;
}
export interface FileReference {
  store:'archive';kind:'file';id:string;event:SourceReference;input_hash:string;byte_size:number;
}
export interface CapturedSource {
  reference:SourceReference;sequence:string;origin:'live'|'import';channel:string;kind:string;scope:string;
  artifact_ids:string[];
}

const internalKinds=new Set(['runtime_context','transcript','extracted_text','shared_knowledge',
  'outbound_intent','outbound_result','schedule_definition','schedule_fire','guard_result','learning_result','learned_memory','extraction_status',
  'memory_input','memory_result','memory_context','runtime_result']);
export function originalEnvelope(input:unknown):Envelope {
  const value=envelope(input);
  if(value.origin==='generated'||value.channel==='scheduler'||internalKinds.has(value.kind))
    throw new HttpError(400,'original_source_required');
  return value;
}

export class ArchiveRepository {
  constructor(readonly pool:pg.Pool){}

  /** One archive transaction: source evidence only; no workflow or guard writes. */
  async capture(input:unknown):Promise<{source:CapturedSource;duplicate:boolean}> {
    const value=originalEnvelope(input),id=digest(value.key),{channel,...identity}=value;
    const inputHash=digest(canonical({...identity,...(channel&&channel!=='telegram'?{channel}:{}),wire_base64:undefined}));
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const added=await client.query(`INSERT INTO events(id,source_key,channel,scope,source_id,revision,origin,kind,
        occurred_at,payload,payload_hash,original_text,search_text,wire,bot_id,source_descriptor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(source_key) DO NOTHING RETURNING id`,
      [id,value.key,channel??'telegram',value.scope,value.source_id,value.revision,value.origin,value.kind,
        value.occurred_at,Buffer.from(canonical(value.payload)),inputHash,
        value.text===null?null:Buffer.from(value.text),(value.text??'').replaceAll('\0',''),
        value.wire_base64===undefined?null:Buffer.from(value.wire_base64,'base64'),value.bot_id,
        value.source?Buffer.from(canonical(value.source)):null]);
      if(!added.rowCount) {
        const previous=(await client.query('SELECT payload_hash,wire FROM events WHERE id=$1',[id])).rows[0];
        if(previous?.payload_hash!==inputHash)throw new HttpError(409,'source_identity_conflict');
        const wire=value.wire_base64===undefined?null:Buffer.from(value.wire_base64,'base64');
        if((previous.wire===null)!==(wire===null)||(wire&&!wire.equals(previous.wire)))throw new HttpError(409,'source_wire_conflict');
      } else {
        await projectSource(client,id,value,observedSource(value));
        for(const ref of channel===undefined||channel==='telegram'?attachmentRefs(value.payload):[])
          await client.query(`INSERT INTO artifacts(id,event_id,kind,source_ref,metadata) VALUES($1,$2,$3,$4,$5)`,
            [digest(`${id}:${ref.ref}`),id,ref.kind,ref.ref,JSON.stringify(ref.metadata)]);
      }
      const source=await this.captured(id,client);
      await client.query('COMMIT');return {source,duplicate:!added.rowCount};
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }

  async captured(id:string,db:Pick<pg.Pool,'query'>=this.pool):Promise<CapturedSource> {
    const row=(await db.query(`SELECT id,revision,payload_hash,capture_sequence,origin,channel,kind,scope,
      ARRAY(SELECT id FROM artifacts WHERE event_id=e.id ORDER BY id) AS artifact_ids FROM events e WHERE id=$1`,[id])).rows[0];
    if(!row)throw new HttpError(404,'source_not_found');
    return {reference:{store:'archive',kind:'event',id:row.id,revision:row.revision,input_hash:row.payload_hash},
      sequence:String(row.capture_sequence),origin:row.origin,channel:row.channel,kind:row.kind,scope:row.scope,artifact_ids:row.artifact_ids};
  }

  async verify(reference:SourceReference):Promise<CapturedSource> {
    if(reference.store!=='archive'||reference.kind!=='event')throw new HttpError(400,'invalid_source_reference');
    const source=await this.captured(reference.id);
    if(source.reference.revision!==reference.revision||source.reference.input_hash!==reference.input_hash)
      throw new HttpError(409,'source_reference_conflict');
    return source;
  }

  async page(afterSequence:string,limit=100):Promise<CapturedSource[]> {
    if(!/^\d+$/.test(afterSequence)||!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_capture_page');
    const rows=await this.pool.query('SELECT id FROM events WHERE capture_sequence>$1 ORDER BY capture_sequence LIMIT $2',[afterSequence,limit]);
    return Promise.all(rows.rows.map(row=>this.captured(row.id)));
  }

  async attach(id:string,hash:string,byteSize:number):Promise<FileReference> {
    if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(byteSize)||byteSize<0)throw new HttpError(400,'invalid_file_manifest');
    const row=(await this.pool.query(`UPDATE artifacts SET file_hash=$2,byte_size=$3 WHERE id=$1
      AND (file_hash IS NULL OR (file_hash=$2 AND byte_size=$3)) RETURNING event_id`,[id,hash,byteSize])).rows[0];
    if(!row)throw new HttpError(409,'file_manifest_conflict');
    return {store:'archive',kind:'file',id,event:(await this.captured(row.event_id)).reference,input_hash:hash,byte_size:byteSize};
  }
}
