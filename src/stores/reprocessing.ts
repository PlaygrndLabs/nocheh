import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {requestWorkflow,enterFamily,leaveFamily,type ExecutionAuthority} from '../workflows/store.js';
import type {RuntimeCall} from '../runtime.js';
import {ArchiveRepository,type FileReference} from './archive.js';
import {DerivedRepository,type DerivativeReference} from './derived.js';
import {GuardRepository} from './guards.js';
import type {StorePools} from './connections.js';

export interface DerivationEngine {
  readonly name:string;readonly version:string;readonly outputKind:'transcript'|'extracted_text';
  run(bytes:Buffer,metadata:{kind:string;metadata:Record<string,unknown>},configuration:Record<string,unknown>):Promise<string>;
}

export function subscriptionTranscription(call:RuntimeCall):DerivationEngine {
  return {name:'nocheh-subscription',version:'codex-asr:479f6a7a3db81fe2a23d4755b0ccbeb4400317d4',outputKind:'transcript',async run(bytes,file,configuration){
    if(Object.keys(configuration).length)throw new HttpError(400,'unsupported_transcription_configuration');
    const match=typeof file.metadata.file_name==='string'?file.metadata.file_name.match(/\.(ogg|oga|mp3|wav|m4a|mp4|flac)$/i):null;
    const result=await call('perception.transcribe',{audio_base64:bytes.toString('base64'),suffix:file.kind==='video_note'?'.mp4':match?'.'+match[1]!.toLowerCase():'.ogg'});
    if(result.success!==true||typeof result.transcript!=='string')throw new HttpError(503,result.error==='quota_paused'?'quota_paused':'transcription_unavailable');
    return result.transcript;
  }};
}

export class ReprocessingRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly derived:DerivedRepository,
    readonly guards:GuardRepository,readonly dataDir:string,readonly engines:readonly DerivationEngine[]){}

  private engine(name:string,version:string):DerivationEngine {
    const engine=this.engines.find(engine=>engine.name===name&&engine.version===version);
    if(!engine)throw new HttpError(400,'unknown_derivation_engine');return engine;
  }

  async request(file:FileReference,producer:string,version:string,configuration:Record<string,unknown>,operationId:string):Promise<string> {
    this.engine(producer,version);
    if(!operationId||Buffer.byteLength(operationId)>200||Buffer.byteLength(canonical(configuration))>65536)
      throw new HttpError(400,'invalid_reprocess_request');
    await this.archive.verify(file.event);
    const manifest=(await this.stores.archive.query('SELECT event_id,file_hash,byte_size FROM artifacts WHERE id=$1',[file.id])).rows[0];
    if(file.store!=='archive'||file.kind!=='file'||!manifest||manifest.event_id!==file.event.id||manifest.file_hash!==file.input_hash||Number(manifest.byte_size)!==file.byte_size)
      throw new HttpError(409,'file_reference_conflict');
    const id=digest('reprocess:'+operationId),hash=digest(canonical({file,producer,version,configuration})),client=await this.stores.control.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO reprocess_jobs(id,request_hash,file_reference,producer,producer_version,configuration)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,hash,JSON.stringify(file),producer,version,JSON.stringify(configuration)]);
      if((await client.query('SELECT request_hash FROM reprocess_jobs WHERE id=$1',[id])).rows[0].request_hash!==hash)
        throw new HttpError(409,'reprocess_identity_conflict');
      await requestWorkflow(client,'preparation','reprocess:'+id);
      await client.query('COMMIT');return id;
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }

  /** Existing Inngest preparation workers own retries; this is one fenced step. */
  async run(id:string,detectorVersion:string,detect:(text:string)=>Promise<unknown>,authority:ExecutionAuthority):Promise<DerivativeReference|null> {
    const client=await this.stores.control.connect();let locked=false,fenced=false;
    try {
      fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);
      if(!fenced)return null;
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,803354)) AS locked',[id])).rows[0].locked;
      if(!locked)return null;
      const job=(await client.query('SELECT * FROM reprocess_jobs WHERE id=$1',[id])).rows[0];
      if(!job)throw new HttpError(404,'reprocess_job_missing');
      const file=job.file_reference as FileReference;
      await this.archive.verify(file.event);
      const previous=(await this.stores.derived.query('SELECT id,content_hash FROM derived_artifacts WHERE operation_id=$1',['reprocess:'+id])).rows[0];
      let result:DerivativeReference;
      if(previous)result={store:'derived',kind:'artifact',id:previous.id,input_hash:previous.content_hash};
      else {
        await client.query("UPDATE reprocess_jobs SET state='running',attempts=attempts+1,error_code=NULL,updated_at=now() WHERE id=$1",[id]);
        if(!/^[a-f0-9]{64}$/.test(file.input_hash))throw new HttpError(409,'file_reference_conflict');
        const manifest=(await this.stores.archive.query('SELECT kind,metadata,event_id,file_hash,byte_size FROM artifacts WHERE id=$1',[file.id])).rows[0];
        if(!manifest||manifest.event_id!==file.event.id||manifest.file_hash!==file.input_hash||Number(manifest.byte_size)!==file.byte_size)
          throw new HttpError(409,'file_reference_conflict');
        const bytes=await readFile(join(this.dataDir,'files',file.input_hash));
        if(digest(bytes)!==file.input_hash||bytes.length!==file.byte_size)throw new HttpError(409,'original_file_integrity_failed');
        const engine=this.engine(job.producer,job.producer_version),text=await engine.run(bytes,manifest,job.configuration);
        result=await this.derived.record({operation_id:'reprocess:'+id,source:file.event,file,kind:engine.outputKind,content:Buffer.from(text),
          producer:job.producer,producer_version:job.producer_version,configuration:job.configuration});
      }
      // Output is committed before guarding or completion; a retry reuses it.
      await this.guards.prepare(result,detectorVersion,detect);
      await client.query("UPDATE reprocess_jobs SET state='done',derived_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[id,result.id]);
      return result;
    } catch(error) {
      if(locked)await client.query("UPDATE reprocess_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1",[id,error instanceof HttpError?error.code:'reprocess_unavailable']).catch(()=>{});
      throw error;
    } finally {
      let failed=false;
      try {
        if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803354))',[id]);
        if(fenced)await leaveFamily(client,'preparation');
      }
      catch {failed=true;}
      client.release(failed);
    }
  }
}
