import type pg from 'pg';
import type {Settings} from '../config.js';
import type {RuntimeCall} from '../runtime.js';
import {HttpError,string} from '../http.js';
import {fetchAttachments} from '../storage.js';
import {prepareArchiveFiles} from '../preparation.js';
import {guardState,prepareGuarded} from '../guarded.js';
import {dispatchCommitted} from '../assistant.js';
import type {ExecutionAuthority,WorkflowFamily,WorkflowState} from './store.js';

export type Observation={state:WorkflowState;stage:string;attempts:number;next_attempt:number;waiting_reason:string|null};
export type WorkflowOperation=(jobId:string,authority:ExecutionAuthority)=>Promise<Observation>;
export const observation=(state:WorkflowState,stage:string,attempts=0,next=Date.now(),reason:string|null=null):Observation=>({state,stage,attempts,next_attempt:Math.max(Date.now()+100,Number(next)),waiting_reason:reason});

async function preparationStatus(pool:pg.Pool,eventId:string):Promise<Observation> {
  const files=(await pool.query(`SELECT count(*)::int AS count,coalesce(max(attempts),0)::int AS attempts,
    min(next_attempt) AS next,bool_or(state='failed' AND error_code IS DISTINCT FROM 'import_bytes_pending') AS failed,
    bool_and(source_ref LIKE 'desktop:%' OR error_code='import_bytes_pending') AS upload_pending FROM artifacts WHERE event_id=$1 AND state<>'ready'`,[eventId])).rows[0];
  if(files.count)return observation(files.failed&&!files.upload_pending?'retryable_failed':'waiting','attachments',files.attempts,files.upload_pending?Date.now()+30000:files.next?.getTime()??Date.now()+30000,files.failed&&!files.upload_pending?'provider_unavailable':'prerequisite');
  const media=(await pool.query(`SELECT count(*)::int AS count,coalesce(max(t.attempts),0)::int AS attempts,min(t.next_attempt) AS next,bool_or(t.state='failed') AS failed
    FROM artifacts a LEFT JOIN transcription_jobs t ON t.artifact_id=a.id WHERE a.event_id=$1 AND a.state='ready'
    AND NOT EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.artifact_id=a.id AND d.kind IN ('transcript','extracted_text','extraction_status'))`,[eventId])).rows[0];
  if(media.count)return observation(media.failed?'retryable_failed':'waiting','transcription',media.attempts,media.next?.getTime()??Date.now(),media.failed?'provider_unavailable':'prerequisite');
  if((await guardState(pool)).mode==='on') {
    const guard=(await pool.query(`SELECT count(*)::int AS count,coalesce(max(attempts),0)::int AS attempts,min(next_attempt) AS next,bool_or(state='failed') AS failed
      FROM guard_sources WHERE event_id=$1 AND state<>'ready'`,[eventId])).rows[0];
    if(guard.count)return observation(guard.failed?'retryable_failed':'waiting','preparation',guard.attempts,guard.next?.getTime()??Date.now(),guard.failed?'provider_unavailable':'guard_pending');
  }
  return observation('completed','preparation');
}

export function pipelineOperations(pool:pg.Pool,config:Settings,call:RuntimeCall):Partial<Record<WorkflowFamily,WorkflowOperation>> {
  return {
    preparation:async(eventId,authority)=>{
      if(!(await pool.query('SELECT 1 FROM events WHERE id=$1',[eventId])).rowCount)return observation('failed','admission');
      const before=await preparationStatus(pool,eventId);
      if(before.state==='completed'||before.next_attempt>Date.now()+200)return before;
      if(before.stage==='attachments')await fetchAttachments(pool,config.dataDir,async ref=>Buffer.from(string((await call('source.file',{file_id:ref})).bytes_base64,70*1024*1024),'base64'),eventId,authority);
      else if(before.stage==='transcription')await prepareArchiveFiles(pool,config.dataDir,call,eventId,authority);
      else await prepareGuarded(pool,async text=>(await call('guard.detect',{text})).literals,config.detectorVersion,20,eventId,authority);
      return preparationStatus(pool,eventId);
    },
    telegram:async(eventId,authority)=>{
      if(!config.assistant.enabled)return observation('waiting','admission',0,Date.now()+60000,'owner_paused');
      const load=async()=> (await pool.query('SELECT state,attempts,next_attempt,error_code,runtime_stage FROM dispatches WHERE event_id=$1',[eventId])).rows[0];
      let row=await load();if(!row)return observation('failed','admission');
      if(['pending','running','failed'].includes(row.state)&&row.next_attempt<=new Date()) {
        await dispatchCommitted(pool,config,call,eventId,authority);row=await load();
      }
      const state:WorkflowState=row.state==='done'?'completed':row.state==='suppressed'?'skipped':row.state==='ambiguous'?'ambiguous':row.state==='cancelled'?'cancelled':row.state==='failed'?'retryable_failed':row.state==='running'?'running':'waiting';
      const waitStage:Record<string,string>={waiting_for_attachments:'attachments',waiting_for_transcription:'transcription',guard_preparation_pending:'preparation'};
      const stage=waitStage[row.error_code]??row.runtime_stage??'assistant';
      return observation(state,stage,row.attempts,row.next_attempt?.getTime(),row.state==='running'?'receipt_pending':state==='retryable_failed'?'runtime_unavailable':state==='waiting'?'prerequisite':null);
    },
  };
}

export function executionFailure(error:unknown,attempts:number):Observation {
  if(error instanceof HttpError&&['archive_integrity_failed','scope_denied','space_policy_changed'].includes(error.code))return observation('failed','admission',attempts,Date.now());
  return observation('retryable_failed','admission',attempts+1,Date.now()+Math.min(3600000,30000*2**Math.min(attempts,7)),'workflow_execution_failed');
}
