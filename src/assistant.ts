import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from './config.js';
import { digest } from './archive.js';
import { conversationScope } from './assistant-policy.js';
import { turnToken } from './access.js';
import { controlReply } from './actions.js';
import { HttpError } from './http.js';

type Call=(path:string,body:unknown,timeout?:number)=>Promise<Record<string,unknown>>;
const TRANSCRIPTION_VERSION='codex-asr:479f6a7a3db81fe2a23d4755b0ccbeb4400317d4';

export async function prepareTranscripts(client:pg.PoolClient,dataDir:string,eventId:string,call:Call):Promise<string[]|null> {
  const {rows}=await client.query<{id:string;file_hash:string;kind:string;state:string;metadata:{file_name?:string}}>(
    "SELECT id,file_hash,kind,state,metadata FROM artifacts WHERE event_id=$1 AND kind IN ('voice','audio','video_note') ORDER BY id",[eventId]);
  const texts:string[]=[];
  for (const artifact of rows) {
    const id=digest(artifact.id+':transcript:'+TRANSCRIPTION_VERSION);
    const previous=await client.query<{content:Buffer}>('SELECT content FROM derived_artifacts WHERE id=$1',[id]);
    if (previous.rows[0]) {texts.push(previous.rows[0].content.toString());continue;}
    if (artifact.state!=='ready') return null;
    await client.query('INSERT INTO transcription_jobs(artifact_id) VALUES($1) ON CONFLICT DO NOTHING',[artifact.id]);
    const due=await client.query("UPDATE transcription_jobs SET state='running',attempts=attempts+1 WHERE artifact_id=$1 AND next_attempt<=now() RETURNING artifact_id",[artifact.id]);
    if (!due.rowCount)return null;
    try {
      if (!/^[a-f0-9]{64}$/.test(artifact.file_hash))throw new HttpError(503,'audio_hash_invalid');
      const raw=await readFile(join(dataDir,'files',artifact.file_hash));
      if (digest(raw)!==artifact.file_hash)throw new HttpError(503,'audio_hash_mismatch');
      const match=artifact.metadata.file_name?.match(/\.(ogg|oga|mp3|wav|m4a|mp4|flac)$/i);
      const result=await call('/internal/transcribe',{audio_base64:raw.toString('base64'),suffix:artifact.kind==='video_note'?'.mp4':match?'.'+match[1]!.toLowerCase():'.ogg'});
      if (result.success!==true || typeof result.transcript!=='string')throw new HttpError(503,result.error==='quota_paused'?'quota_paused':'transcription_unavailable');
      await client.query('BEGIN');
      await client.query(`INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,search_text,provenance) VALUES($1,$2,$3,'transcript',$4,$5,$6) ON CONFLICT DO NOTHING`,
        [id,eventId,artifact.id,Buffer.from(result.transcript),result.transcript.replaceAll('\0',''),JSON.stringify({provider:'nocheh-subscription',version:TRANSCRIPTION_VERSION,input_sha256:artifact.file_hash})]);
      await client.query("UPDATE transcription_jobs SET state='done',error_code=NULL WHERE artifact_id=$1",[artifact.id]);
      await client.query('COMMIT');texts.push(result.transcript);
    } catch (error) {
      await client.query('ROLLBACK');
      await client.query("UPDATE transcription_jobs SET state='failed',error_code=$2,next_attempt=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE artifact_id=$1",[artifact.id,error instanceof HttpError?error.code:'transcription_unavailable']);
      return null;
    }
  }
  return texts;
}

export async function dispatchCommitted(pool:pg.Pool,config:Settings,call:Call):Promise<void> {
  if (!config.assistant.enabled)return;
  const client=await pool.connect();let held=false;
  try {
    held=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(803302) AS locked')).rows[0]!.locked;
    if (!held)return;
    const {rows}=await client.query<{id:string;scope:string;source_key:string;payload:Buffer;original_text:Buffer|null;state:string;attempts:number}>(
      `SELECT e.id,e.scope,e.source_key,e.payload,e.original_text,d.state,d.attempts FROM dispatches d JOIN events e ON e.id=d.event_id
       WHERE d.state IN ('pending','failed','running') AND d.next_attempt<=now() AND e.origin='live' AND e.kind='telegram_update'
       ORDER BY d.next_attempt,e.received_at LIMIT 1`);
    const event=rows[0];if(!event)return;
    let payload:unknown,scope:ReturnType<typeof conversationScope>;
    try {
      payload=JSON.parse(event.payload.toString()) as unknown;
      scope=conversationScope(config.assistant,payload,event.scope);
    } catch {
      await client.query("UPDATE dispatches SET state='suppressed',error_code='invalid_source_message',updated_at=now() WHERE event_id=$1",[event.id]);
      return;
    }
    if (!scope) {await client.query("UPDATE dispatches SET state='suppressed',error_code='conversation_not_selected',updated_at=now() WHERE event_id=$1",[event.id]);return;}
    const missing=await client.query("SELECT id FROM artifacts WHERE event_id=$1 AND state<>'ready' LIMIT 1",[event.id]);
    if (missing.rowCount) {await client.query("UPDATE dispatches SET error_code='waiting_for_attachments',next_attempt=now()+interval '30 seconds' WHERE event_id=$1",[event.id]);return;}
    const transcripts=await prepareTranscripts(client,config.dataDir,event.id,call);
    if (transcripts===null) {await client.query("UPDATE dispatches SET error_code='waiting_for_transcription',next_attempt=now()+interval '30 seconds' WHERE event_id=$1",[event.id]);return;}
    const attempt=event.state==='running'?event.attempts:event.attempts+1;
    const control=await controlReply(pool,config.assistant,event.id);
    await client.query("UPDATE dispatches SET state='running',attempts=$2,updated_at=now(),error_code=NULL WHERE event_id=$1",[event.id,attempt]);
    try {
      const result=await call('/internal/dispatch',{event_id:event.id,source_key:event.source_key,scope:event.scope,payload,
        text:event.original_text?.toString() ?? null,transcripts,attempt,control_reply:control,
        archive_credential:turnToken(config.token,scope.owner?null:scope.chat_id,Date.now()+600000,event.id)},260000);
      if (!['done','failed','ambiguous','suppressed'].includes(String(result.state))) throw new Error('invalid_dispatch_receipt');
      const allowedCodes=['model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message','delivery_unconfirmed','dispatch_interrupted'];
      await client.query(`UPDATE dispatches SET state=$2,error_code=$3,next_attempt=now()+interval '60 seconds',updated_at=now() WHERE event_id=$1`,
        [event.id,result.state,allowedCodes.includes(String(result.error_code))?result.error_code:null]);
    } catch {
      // Retain running + the same attempt ID. A retry reads the Hermes receipt;
      // it never blindly launches a second turn after an uncertain HTTP result.
      await client.query("UPDATE dispatches SET error_code='awaiting_dispatch_receipt',next_attempt=now()+interval '30 seconds',updated_at=now() WHERE event_id=$1",[event.id]);
    }
  } finally {if(held)await client.query('SELECT pg_advisory_unlock(803302)');client.release();}
}
