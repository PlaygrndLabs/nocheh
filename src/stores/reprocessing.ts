import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical,digest} from '../archive.js';
import {isPdf,pdfText} from '../pdf-text.js';
import {HttpError} from '../http.js';
import {requestWorkflow,enterFamily,leaveFamily,type ExecutionAuthority} from '../workflows/store.js';
import {ArchiveRepository,type FileReference} from './archive.js';
import {DerivedRepository,type DerivativeReference} from './derived.js';
import {GuardRepository} from './guards.js';
import type {StorePools} from './connections.js';
import {timed} from './stage-timings.js';
import type {RuntimeCall} from '../runtime.js';

export interface DerivationEngine {
  readonly name:string;readonly version:string;readonly outputKind:'transcript'|'extracted_text';
  run(bytes:Buffer,metadata:{kind:string;metadata:Record<string,unknown>},configuration:Record<string,unknown>):Promise<string|{kind:'extraction_status';text:string}>;
}

export function textExtraction():DerivationEngine {
  return {name:'nocheh-text',version:'1',outputKind:'extracted_text',async run(bytes,file,configuration){
    if(Object.keys(configuration).length)throw new HttpError(400,'unsupported_extraction_configuration');
    if(!['photo','image','video','sticker','animation'].includes(file.kind)&&isPdf(bytes)) {
      const result=await pdfText(bytes);
      if(!result)return {kind:'extraction_status',text:'This PDF could not be read; its original file is kept.'};
      if(!result.text)return {kind:'extraction_status',text:result.read<result.pages?'The first PDF page alone exceeds the text limit.':
        'This PDF has no text layer (for example, scanned pages); its original file is kept.'};
      return result.read<result.pages?result.text+`\n\n[Text of pages ${result.read+1} to ${result.pages} is not included.]`:result.text;
    }
    if(!['photo','image','video','sticker','animation'].includes(file.kind)&&bytes.length<=200000&&!bytes.includes(0)) {
      try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* preserve unsupported original bytes */}
    }
    return {kind:'extraction_status',text:'Text extraction is unavailable for this original file.'};
  }};
}

const READINGS:Record<string,string>={
  scanned:'This document is scanned pages without a text layer; its original file is kept.',
  unreadable:'This document could not be read; its original file is kept.',
  unsupported:'Text extraction is unavailable for this original file.',
  too_large:'This document is too large to read; its original file is kept.'};
const SIGHTS:Record<string,string>={
  not_configured:'Images are not read until Settings › Models has a provider for them; the original file is kept.',
  unreadable:'This image could not be read; its original file is kept.',
  too_large:'This image is too large to read; its original file is kept.',
  failed:'This image could not be read; its original file is kept.'};
// Moving pictures and stickers keep their original only.
const UNREAD=['video','sticker','animation','video_file'];
/** Files are read by the runtime's own readers (Hermes): documents (Word, Excel, PowerPoint, old
 * Office, OpenDocument, RTF, EPUB and PDF) by its document reader, and photos and images by its
 * vision tool with the Images model of Settings › Models. Plain UTF-8 text is read here. */
export function documentExtraction(runtime:RuntimeCall):DerivationEngine {
  return {name:'runtime-documents',version:'2',outputKind:'extracted_text',async run(bytes,file,configuration){
    if(Object.keys(configuration).length)throw new HttpError(400,'unsupported_extraction_configuration');
    const name=[file.metadata.file_name,file.metadata.relative_path].find(value=>typeof value==='string')??'';
    const mime=typeof file.metadata.mime_type==='string'?file.metadata.mime_type:'';
    if(UNREAD.includes(file.kind))return {kind:'extraction_status',text:READINGS.unsupported!};
    if(['photo','image'].includes(file.kind)||/^image\//i.test(mime)) {
      const result=await runtime('image.read',{bytes_base64:bytes.toString('base64'),name,mime_type:mime},300000);
      if(result.state==='done'&&typeof result.text==='string'&&result.text)return result.text;
      if(result.state==='failed'&&['provider_error','rate_limited','timed_out'].includes(String(result.reason)))
        throw new HttpError(503,'image_reading_unavailable');
      return {kind:'extraction_status',text:SIGHTS[String(result.state)]??SIGHTS.failed!};
    }
    if(bytes.length<=200000&&!bytes.includes(0)&&!isPdf(bytes)) {
      try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* a binary document goes to the reader */}
    }
    const result=await runtime('file.extract',{bytes_base64:bytes.toString('base64'),name,mime_type:mime},180000);
    if(result.state==='done'&&typeof result.text==='string'&&result.text)return result.text;
    return {kind:'extraction_status',text:READINGS[String(result.state)]??READINGS.unreadable!};
  }};
}

/** Recordings to transcribe: Telegram's own kinds and the media types of a Telegram Desktop export. */
export const RECORDINGS:readonly string[]=['voice','audio','video_note','voice_message','audio_file','video_message'];
/** Voice notes saved before transcription was set up keep their original bytes and this status. */
export const VOICE_ARCHIVED='Voice note archived; transcription is not available.';
export function archivedVoice():DerivationEngine {
  return {name:'nocheh-voice-archive',version:'1',outputKind:'transcript',async run(_bytes,_file,configuration){
    if(Object.keys(configuration).length)throw new HttpError(400,'unsupported_transcription_configuration');
    return {kind:'extraction_status',text:VOICE_ARCHIVED};
  }};
}

const HEARINGS:Record<string,string>={
  not_configured:VOICE_ARCHIVED,
  silent:'This recording has no speech to transcribe; its original audio is kept.',
  unsupported:'This recording cannot be transcribed in its format; its original audio is kept.',
  too_large:'This recording is too large to transcribe; its original audio is kept.',
  failed:'This recording could not be transcribed; its original audio is kept.'};
// A provider that is busy or unreachable is tried again by the preparation workflow.
const RETRY=new Set(['rate_limited','provider_error','timed_out']);
/** Voice notes, audio files and round videos are transcribed by the runtime's own transcriber
 * (Hermes) with the provider chosen in Settings › Models. Without one, a note keeps the archived
 * status, so its reply never waits, and is transcribed once a provider is chosen. */
export function voiceTranscription(runtime:RuntimeCall):DerivationEngine {
  return {name:'runtime-voice',version:'1',outputKind:'transcript',async run(bytes,file,configuration){
    if(Object.keys(configuration).length)throw new HttpError(400,'unsupported_transcription_configuration');
    const text=(name:string)=>typeof file.metadata[name]==='string'?file.metadata[name] as string:'';
    const duration=file.metadata.duration;
    const result=await runtime('voice.transcribe',{bytes_base64:bytes.toString('base64'),name:text('file_name')||text('relative_path'),
      mime_type:text('mime_type'),kind:file.kind,...(typeof duration==='number'&&duration>=0?{duration}:{})},660000);
    if(result.state==='done'&&typeof result.text==='string'&&result.text)return result.text;
    if(result.state==='failed'&&RETRY.has(String(result.reason)))throw new HttpError(503,'transcription_unavailable');
    return {kind:'extraction_status',text:HEARINGS[String(result.state)]??HEARINGS.failed!};
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
      if(job.state==='failed'&&job.error_code==='invalid_transcription_response')return null;
      const file=job.file_reference as FileReference;
      await this.archive.verify(file.event);
      const previous=await this.derived.checkpoint('reprocess:'+id);
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
        const engine=this.engine(job.producer,job.producer_version),run=()=>engine.run(bytes,manifest,job.configuration);
        // A configured speech engine is on the reply path; its failures are timed too.
        const output=engine.outputKind==='transcript'?await timed(this.stores.control,file.event.id,'transcription','nocheh',run):await run();
        if(typeof output!=='string'&&(output.kind!=='extraction_status'||typeof output.text!=='string'))
          throw new HttpError(503,'invalid_derivation_result');
        result=await this.derived.record({operation_id:'reprocess:'+id,source:file.event,file,kind:typeof output==='string'?engine.outputKind:output.kind,content:Buffer.from(typeof output==='string'?output:output.text),
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
