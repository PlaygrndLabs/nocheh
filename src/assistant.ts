import type pg from 'pg';
import type { Settings } from './config.js';
import { conversationScope } from './assistant-policy.js';
import { turnToken } from './access.js';
import {eventSpace,spacePolicy} from './spaces.js';
import { controlReply } from './actions.js';
import type { RuntimeCall } from './runtime.js';
import {guardState,guardedValue,prepareGuarded} from './guarded.js';
import {allowPrepared} from './prepared-context.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from './workflows/store.js';

type Call=RuntimeCall;

async function dispatchReceipt(client:pg.PoolClient,eventId:string,result:Record<string,unknown>) {
  if(!['queued','running','done','failed','ambiguous','suppressed','cancelled'].includes(String(result.state)))throw Error('invalid_dispatch_receipt');
  const active=['queued','running'].includes(String(result.state));
  const allowed=['model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message','delivery_unconfirmed','dispatch_interrupted','space_policy_changed','runtime_execution_interrupted','intentional_silence','telegram_rejected','not_addressed','provider_not_configured'];
  await client.query(`UPDATE dispatches SET state=$2,error_code=$3,next_attempt=now()+($4*interval '1 second'),updated_at=now(),
    runtime_stage=coalesce($5,runtime_stage) WHERE event_id=$1`,[eventId,active?'running':result.state,active?'awaiting_dispatch_receipt':allowed.includes(String(result.error_code))?result.error_code:null,
    active?5:result.state==='failed'?10:60,['admission','assistant','delivery'].includes(String(result.stage))?result.stage:result.state==='done'?'delivery':null]);
}

/** Readings already derived for this event's voice notes. Voice notes are archived
 * without transcription, so a missing reading never holds a reply back. */
export async function storedTranscripts(client:pg.Pool|pg.PoolClient,eventId:string):Promise<string[]> {
  const {rows}=await client.query<{content:Buffer}>(`SELECT d.content FROM derived_artifacts d JOIN artifacts a ON a.id=d.artifact_id
    WHERE d.event_id=$1 AND d.kind='transcript' AND a.kind IN ('voice','audio','video_note') ORDER BY a.id,d.id`,[eventId]);
  return rows.map(row=>row.content.toString());
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
