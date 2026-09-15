import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from './config.js';
import { digest } from './archive.js';
import { conversationScope } from './assistant-policy.js';
import { turnToken } from './access.js';
import {eventSpace,spacePolicy} from './spaces.js';
import { controlReply } from './actions.js';
import { HttpError } from './http.js';
import type { RuntimeCall } from './runtime.js';
import {guardState,guardedValue,prepareGuarded} from './guarded.js';
import {allowPrepared} from './prepared-context.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from './workflows/store.js';

type Call=RuntimeCall;
const TRANSCRIPTION_VERSION='codex-asr:479f6a7a3db81fe2a23d4755b0ccbeb4400317d4';

async function dispatchReceipt(client:pg.PoolClient,eventId:string,result:Record<string,unknown>) {
  if(!['queued','running','done','failed','ambiguous','suppressed','cancelled'].includes(String(result.state)))throw Error('invalid_dispatch_receipt');
  const active=['queued','running'].includes(String(result.state));
  const allowed=['model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message','delivery_unconfirmed','dispatch_interrupted','space_policy_changed','runtime_execution_interrupted','intentional_silence'];
  await client.query(`UPDATE dispatches SET state=$2,error_code=$3,next_attempt=now()+($4*interval '1 second'),updated_at=now(),
    runtime_stage=coalesce($5,runtime_stage) WHERE event_id=$1`,[eventId,active?'running':result.state,active?'awaiting_dispatch_receipt':allowed.includes(String(result.error_code))?result.error_code:null,
    active?5:60,['admission','assistant','delivery'].includes(String(result.stage))?result.stage:result.state==='done'?'delivery':null]);
}

export async function storedTranscripts(client:pg.Pool|pg.PoolClient,eventId:string):Promise<string[]|null> {
  const {rows}=await client.query<{content:Buffer|null}>(`SELECT d.content FROM artifacts a
    LEFT JOIN derived_artifacts d ON d.id=encode(sha256(convert_to(a.id||':transcript:'||$2,'UTF8')),'hex')
    WHERE a.event_id=$1 AND a.kind IN ('voice','audio','video_note') ORDER BY a.id`,[eventId,TRANSCRIPTION_VERSION]);
  return rows.some(row=>row.content===null)?null:rows.map(row=>row.content!.toString());
}

export async function prepareTranscripts(client:pg.PoolClient,dataDir:string,eventId:string,call:Call,authority:ExecutionAuthority):Promise<string[]|null> {
  const {rows}=await client.query<{id:string;file_hash:string;kind:string;state:string;metadata:{file_name?:string}}>(
    "SELECT id,file_hash,kind,state,metadata FROM artifacts WHERE event_id=$1 AND kind IN ('voice','audio','video_note') ORDER BY id",[eventId]);
  const texts:string[]=[];
  for (const artifact of rows) {
    const id=digest(artifact.id+':transcript:'+TRANSCRIPTION_VERSION);
    const previous=await client.query<{content:Buffer}>('SELECT content FROM derived_artifacts WHERE id=$1',[id]);
    if (previous.rows[0]) {texts.push(previous.rows[0].content.toString());continue;}
    if (artifact.state!=='ready') return null;
    const fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);
    if(!fenced)return null;
    try {
    await client.query('INSERT INTO transcription_jobs(artifact_id) VALUES($1) ON CONFLICT DO NOTHING',[artifact.id]);
    const due=await client.query("UPDATE transcription_jobs SET state='running',attempts=attempts+1,next_attempt=now()+interval '5 minutes' WHERE artifact_id=$1 AND next_attempt<=now() RETURNING artifact_id",[artifact.id]);
    if (!due.rowCount)return null;
    try {
      if (!/^[a-f0-9]{64}$/.test(artifact.file_hash))throw new HttpError(503,'audio_hash_invalid');
      const raw=await readFile(join(dataDir,'files',artifact.file_hash));
      if (digest(raw)!==artifact.file_hash)throw new HttpError(503,'audio_hash_mismatch');
      const match=artifact.metadata.file_name?.match(/\.(ogg|oga|mp3|wav|m4a|mp4|flac)$/i);
      const result=await call('perception.transcribe',{audio_base64:raw.toString('base64'),suffix:artifact.kind==='video_note'?'.mp4':match?'.'+match[1]!.toLowerCase():'.ogg'});
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
    }finally{await leaveFamily(client,'preparation');}
  }
  return texts;
}

export async function dispatchCommitted(pool:pg.Pool,config:Settings,call:Call,eventId:string|null=null,authority:ExecutionAuthority):Promise<void> {
  if (!config.assistant.enabled)return;
  const client=await pool.connect();let held=false,fenced=false;
  try {
    fenced=await enterFamily(client,'telegram',authority.owner,authority.epoch);if(!fenced)return;
    held=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(803302) AS locked')).rows[0]!.locked;
    if (!held)return;
    const {rows}=await client.query<{id:string;scope:string;source_key:string;payload:Buffer;original_text:Buffer|null;state:string;attempts:number}>(
      `SELECT e.id,e.scope,e.source_key,e.payload,e.original_text,d.state,d.attempts FROM dispatches d JOIN events e ON e.id=d.event_id
       WHERE d.state IN ('pending','failed','running') AND d.next_attempt<=now() AND e.origin='live' AND e.kind='telegram_update'
       AND ($1::text IS NULL OR e.id=$1) ORDER BY d.next_attempt,e.received_at LIMIT 1`,[eventId]);
    const event=rows[0];if(!event)return;
    if(event.state==='running') {
      try {
        const observed=await call('run.resume',{channel:'telegram',event_id:event.id,attempt:event.attempts},10000);
        if(observed.state!=='not_found'){await dispatchReceipt(client,event.id,observed);return;}
        // Only the runtime's explicit absence permits resending the same start
        // identity. Never increment the attempt merely after a lost response.
      }catch {
        await client.query("UPDATE dispatches SET error_code='awaiting_dispatch_receipt',next_attempt=now()+interval '10 seconds',updated_at=now() WHERE event_id=$1",[event.id]);return;
      }
    }
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
    const transcripts=await storedTranscripts(client,event.id);
    if (transcripts===null) {await client.query("UPDATE dispatches SET error_code='waiting_for_transcription',next_attempt=now()+interval '30 seconds' WHERE event_id=$1",[event.id]);return;}
    const attempt=event.state==='running'?event.attempts:event.attempts+1;
    const control=await controlReply(pool,config.assistant,event.id);
    const guard=await guardState(pool);
    let text=event.original_text?.toString()??null,selectedTranscripts=transcripts;
    if(guard.mode==='on') {
      try {
        text=(await guardedValue(pool,'events:'+event.id)).value.text;
        const derived=await pool.query("SELECT id FROM derived_artifacts WHERE event_id=$1 AND kind='transcript' ORDER BY id",[event.id]);
        selectedTranscripts=[];for(const d of derived.rows)selectedTranscripts.push((await guardedValue(pool,'derived_artifacts:'+d.id)).value.text);
      }catch {await client.query("UPDATE dispatches SET error_code='guard_preparation_pending',next_attempt=now()+interval '15 seconds' WHERE event_id=$1",[event.id]);return;}
    }
    await client.query("UPDATE dispatches SET state='running',attempts=$2,updated_at=now(),error_code=NULL WHERE event_id=$1",[event.id,attempt]);
    try {
      const policy=await spacePolicy(pool,eventSpace(event.scope,payload));
      await allowPrepared(pool,{scope:scope.owner?null:scope.chat_id,admin:false,turnEvent:event.id,space:policy.id,revision:policy.revision,guard_epoch:guard.epoch},{text,transcripts:selectedTranscripts});
      const result=await call('run.start',{channel:'telegram',event_id:event.id,source_key:event.source_key,scope:event.scope,payload,
        text,transcripts:selectedTranscripts,attempt,control_reply:control,guard_mode:guard.mode,
        asynchronous:true,
        archive_credential:turnToken(config.token,scope.owner?null:scope.chat_id,Date.now()+600000,event.id,{space:policy.id,revision:policy.revision,guard_epoch:guard.epoch})},10000);
      await dispatchReceipt(client,event.id,result);
    } catch {
      // Retain running + the same attempt ID. A retry reads the Hermes receipt;
      // it never blindly launches a second turn after an uncertain HTTP result.
      await client.query("UPDATE dispatches SET error_code='awaiting_dispatch_receipt',next_attempt=now()+interval '30 seconds',updated_at=now() WHERE event_id=$1",[event.id]);
    }
  } finally {await releaseOperation(client,async()=>{if(held)await client.query('SELECT pg_advisory_unlock(803302)');if(fenced)await leaveFamily(client,'telegram');});}
}
