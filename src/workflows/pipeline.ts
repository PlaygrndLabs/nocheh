import type pg from 'pg';
import type {Settings} from '../config.js';
import type {RuntimeCall} from '../runtime.js';
import {HttpError,string} from '../http.js';
import {fetchAttachments} from '../storage.js';
import {prepareArchiveFiles} from '../preparation.js';
import {guardState,prepareGuarded} from '../guarded.js';
import {preparationStatus,waitForPreparation} from './preparation-status.js';
import {dispatchCommitted} from '../assistant.js';
import type {ExecutionAuthority,WorkflowFamily,WorkflowState} from './store.js';

export type Observation={state:WorkflowState;stage:string;attempts:number;next_attempt:number;waiting_reason:string|null};
export type WorkflowOperation=(jobId:string,authority:ExecutionAuthority)=>Promise<Observation>;
export const observation=(state:WorkflowState,stage:string,attempts=0,next=Date.now(),reason:string|null=null):Observation=>({state,stage,attempts,next_attempt:Math.max(Date.now()+100,Number(next)),waiting_reason:reason});


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
      if(['pending','failed'].includes(row.state)) {
        const prepared=await preparationStatus(pool,eventId);
        if(prepared.state!=='completed')return waitForPreparation(prepared,row.attempts);
      }
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
