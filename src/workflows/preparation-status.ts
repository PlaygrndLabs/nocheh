import type pg from 'pg';
import {guardState} from '../guarded.js';
import {observation,type Observation} from './pipeline.js';

/** A prerequisite's recovery lease is not its expected completion time. */
export function waitForPreparation(prepared:Observation,attempts=0):Observation {
  // Only Inngest schedules this observation. Preparation retains its own
  // provider backoff/lease, so polling readiness cannot repeat provider work.
  return observation('waiting',prepared.stage,attempts,Date.now()+2000,'prerequisite');
}

export async function preparationStatus(pool:pg.Pool,eventId:string):Promise<Observation> {
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
