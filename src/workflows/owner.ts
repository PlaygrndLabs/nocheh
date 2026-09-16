/** Owner metadata only. Never select source content, arguments, or credentials. */
import type pg from 'pg';
import {HttpError,object} from '../http.js';
import {families,closedStates,hash,type WorkflowFamily} from './store.js';
import {workflowIdentity} from './client.js';

export const workflowOwnerSchema=`
CREATE OR REPLACE VIEW workflow_observations AS
SELECT w.id,w.family,w.job_id,w.version,w.generation,w.state AS registry_state,w.revision,w.dispatch,
 w.created_at,w.created_at::text AS created_cursor,w.updated_at,w.owner_epoch,o.owner,o.admission,
 (w.lease_until>now()) IS TRUE AS active_step,
 coalesce(e.id,j.event_id,a.event_id,t.event_id,gs.event_id) AS source_event_id,
 CASE WHEN w.state IN ('completed','failed','skipped','cancelled','ambiguous','denied') THEN w.state
 WHEN w.family='telegram' THEN CASE d.state WHEN 'done' THEN 'completed' WHEN 'suppressed' THEN 'skipped' WHEN 'failed' THEN 'retryable_failed' WHEN 'pending' THEN 'queued' ELSE coalesce(d.state,w.state) END
 WHEN w.family IN ('browser','schedules') AND m.event_id IS NOT NULL THEN CASE m.state WHEN 'done' THEN 'completed' WHEN 'captured' THEN 'queued' WHEN 'interrupted' THEN 'ambiguous' WHEN 'cancelled' THEN CASE WHEN m.error_code IN ('scheduled_missed','scheduled_overlap') THEN 'skipped' ELSE 'cancelled' END ELSE m.state END
 WHEN w.family='imports' THEN CASE WHEN i.state='queued' AND w.state='retryable_failed' THEN w.state ELSE coalesce(i.state,w.state) END
 WHEN w.family IN ('actions','tools') THEN CASE coalesce(a.state,t.state) WHEN 'done' THEN 'completed' WHEN 'rejected' THEN 'denied' WHEN 'proposed' THEN 'waiting' WHEN 'approved' THEN CASE WHEN w.state='retryable_failed' THEN w.state ELSE 'queued' END ELSE coalesce(a.state,t.state,w.state) END
 WHEN w.family='memory_review' AND j.id IS NOT NULL THEN CASE j.state WHEN 'done' THEN 'completed' WHEN 'failed' THEN 'retryable_failed' WHEN 'paused' THEN 'waiting' WHEN 'pending' THEN 'queued' ELSE j.state END
 WHEN w.family='honcho' AND h.id IS NOT NULL AND w.job_id LIKE 'receipt:%' THEN CASE h.state WHEN 'done' THEN 'completed' WHEN 'uncertain' THEN 'ambiguous' ELSE w.state END
 WHEN w.family='preparation' AND e.id IS NOT NULL AND p.files_waiting=0 AND p.media_waiting=0 AND ((SELECT mode FROM guard_state WHERE singleton)='off' OR p.guards_waiting=0) THEN 'completed'
 ELSE w.state END AS state,
 CASE WHEN w.stage<>'admission' THEN w.stage
 WHEN w.family='telegram' THEN coalesce(d.runtime_stage,'admission')
 WHEN w.family='preparation' THEN 'preparation' WHEN w.family='imports' THEN 'import'
 WHEN w.family='memory_review' THEN 'review' WHEN w.family='honcho' THEN 'sync'
 WHEN w.family IN ('actions','tools') THEN 'action' WHEN w.family='schedules' AND w.job_id LIKE 'schedule:%' THEN 'schedule'
 ELSE w.stage END AS stage,
 greatest(w.attempts,coalesce(d.attempts,j.attempts,h.attempts,0)) AS attempts,
 coalesce(w.next_attempt,d.next_attempt,j.next_attempt,h.next_attempt) AS next_attempt,
 CASE WHEN coalesce(a.state,t.state)='proposed' THEN 'approval_required' WHEN j.state='paused' THEN 'owner_paused' ELSE w.waiting_reason END AS waiting_reason,
 i.total,i.completed,i.duplicates,i.learning_after,
 sc.job_id AS native_job_id,sc.logical_profile AS native_profile
FROM workflow_registry w JOIN workflow_owners o USING(family)
LEFT JOIN events e ON e.id=CASE WHEN w.family IN ('telegram','preparation','browser') THEN w.job_id WHEN w.family='schedules' AND w.job_id LIKE 'run:%' THEN substring(w.job_id FROM 5) WHEN w.family='memory_review' AND w.job_id LIKE 'source:%' THEN substring(w.job_id FROM 8) END
LEFT JOIN dispatches d ON w.family='telegram' AND d.event_id=e.id
LEFT JOIN managed_runs m ON w.family IN ('browser','schedules') AND m.event_id=e.id
LEFT JOIN workflow_imports i ON w.family='imports' AND i.id::text=w.job_id
LEFT JOIN action_requests a ON w.family='actions' AND a.id=w.job_id
LEFT JOIN controlled_actions t ON w.family='tools' AND t.id=w.job_id
LEFT JOIN memory_review_jobs j ON w.family='memory_review' AND w.job_id='review:'||j.id
LEFT JOIN honcho_receipts h ON w.family='honcho' AND w.job_id IN ('receipt:'||h.id,'reconcile:'||h.id)
LEFT JOIN guard_sources gs ON gs.id=h.source_id
LEFT JOIN workflow_schedules sc ON w.family='schedules' AND w.job_id='schedule:'||sc.id||':'||sc.cursor
LEFT JOIN LATERAL (
 SELECT (SELECT count(*) FROM artifacts WHERE event_id=e.id AND state<>'ready') AS files_waiting,
 (SELECT count(*) FROM artifacts f WHERE f.event_id=e.id AND f.state='ready' AND NOT EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.artifact_id=f.id AND d.kind IN ('transcript','extracted_text','extraction_status'))) AS media_waiting,
 (SELECT count(*) FROM guard_sources WHERE event_id=e.id AND state<>'ready') AS guards_waiting
) p ON w.family='preparation';
CREATE TABLE IF NOT EXISTS workflow_controls (
 workflow_id text NOT NULL REFERENCES workflow_registry(id),revision integer NOT NULL,action text NOT NULL CHECK(action IN ('retry','cancel')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,revision,action)
);
`;
const states=['queued','waiting','running','retryable_failed',...closedStates];
function criteria(input:unknown){
  const b=object(input),family=b.family===undefined||b.family===''?null:String(b.family),state=b.state===undefined||b.state===''?null:String(b.state);
  if(family&&!families.includes(family as WorkflowFamily)||state&&!states.includes(state as any))throw new HttpError(400,'invalid_workflow_filter');
  const limit=Number(b.limit??50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'invalid_workflow_limit');
  let after:{at:string;id:string}|null=null;
  if(b.after){
    try {if(String(b.after).length>512)throw Error();after=JSON.parse(Buffer.from(String(b.after),'base64url').toString());if(!after||typeof after.at!=='string'||after.at.length>64||!Number.isFinite(Date.parse(after.at)))throw Error();workflowIdentity(after.id);}
    catch{throw new HttpError(400,'invalid_workflow_cursor');}
  }
  return {family,state,limit,after};
}
function view(row:Record<string,any>):Record<string,any>{
  const {created_cursor,...data}=row;
  const open=!closedStates.includes(row.state),owned=row.owner==='inngest';
  const retry=owned&&row.admission&&!row.active_step&&row.state==='retryable_failed';
  const schedule=row.family==='schedules'&&row.job_id.startsWith('schedule:');
  const domainCancel=['telegram','imports','browser','actions','tools'].includes(row.family)||row.family==='memory_review'&&row.job_id.startsWith('review:')||row.family==='schedules'&&!schedule;
  const cancel=owned&&row.admission&&open&&!row.active_step&&row.state!=='running'&&domainCancel;
  return {...data,can_retry:retry,can_cancel:cancel,
    control_reason:!owned?'legacy_owner':!open?'closed':!row.admission?'owner_paused':schedule?'native_schedule_control':row.active_step||row.state==='running'?'execution_in_progress':!domainCancel?'source_policy_control':null,
    source_url:row.source_event_id?'/api/nocheh/events/'+row.source_event_id:null};
}
export async function listWorkflows(pool:pg.Pool,input:unknown={}){
  const c=criteria(input);
  const rows=(await pool.query(`SELECT * FROM workflow_observations WHERE ($1::text IS NULL OR family=$1) AND ($2::text IS NULL OR state=$2)
    AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5`,[c.family,c.state,c.after?.at??null,c.after?.id??null,c.limit+1])).rows;
  const more=rows.length>c.limit,items=rows.slice(0,c.limit),last=items.at(-1);
  return {workflows:items.map(view),next:more?Buffer.from(JSON.stringify({at:last.created_cursor,id:last.id})).toString('base64url'):null,observed_at:new Date().toISOString()};
}
export async function workflowDetail(pool:pg.Pool,id:string):Promise<Record<string,any>>{
  workflowIdentity(id);
  const row=(await pool.query('SELECT * FROM workflow_observations WHERE id=$1',[id])).rows[0];
  if(!row)throw new HttpError(404,'workflow_not_found');
  const results=await Promise.all([
    pool.query('SELECT run_id,dispatch,owner_epoch,seen_at FROM workflow_runs WHERE workflow_id=$1 ORDER BY seen_at DESC LIMIT 100',[id]),
    pool.query('SELECT step,attempt,state,receipt_id,created_at,updated_at FROM workflow_receipts WHERE workflow_id=$1 ORDER BY created_at DESC,step,attempt LIMIT 100',[id]),
    pool.query('SELECT dispatch,attempts,next_attempt,published_at,error_code,created_at FROM workflow_outbox WHERE workflow_id=$1 ORDER BY dispatch DESC LIMIT 100',[id]),
    pool.query('SELECT action,revision,created_at FROM workflow_controls WHERE workflow_id=$1 ORDER BY created_at DESC LIMIT 100',[id])]);
  return {...view(row),runs:results[0].rows,receipts:results[1].rows,outbox:results[2].rows,controls:results[3].rows};
}

/** Compare-and-swap controls and domain changes share a transaction. A lost
 * response replays the control receipt; it never creates a new execution. */
export async function controlWorkflow(pool:pg.Pool,id:string,action:string,input:unknown){
  workflowIdentity(id);const b=object(input),revision=Number(b.revision);
  if(!['retry','cancel'].includes(action)||!Number.isSafeInteger(revision)||revision<1)throw new HttpError(400,'invalid_workflow_control');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM workflow_registry WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new HttpError(404,'workflow_not_found');
    const prior=await client.query('SELECT 1 FROM workflow_controls WHERE workflow_id=$1 AND revision=$2 AND action=$3',[id,revision,action]);
    if(!prior.rowCount){
      if(row.revision!==revision)throw new HttpError(409,'workflow_revision_changed');
      // Exclusive family fence excludes in-flight domain operations and cutover.
      const lock=(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':workflow:'||$1,803321)) AS held",[row.family])).rows[0];
      if(!lock.held)throw new HttpError(409,'workflow_execution_in_progress');
      const current=view((await client.query('SELECT * FROM workflow_observations WHERE id=$1',[id])).rows[0]);
      if(!current[action==='retry'?'can_retry':'can_cancel'])throw new HttpError(409,'workflow_'+(current.control_reason??'control_unavailable'));
      if((await client.query("SELECT 1 FROM workflow_receipts WHERE workflow_id=$1 AND state IN ('started','ambiguous','done') LIMIT 1",[id])).rowCount)
        throw new HttpError(409,'workflow_receipt_closed');
      const job=row.job_id;
      if(action==='retry'){
        if(row.family==='telegram')await client.query("UPDATE dispatches SET next_attempt=now(),updated_at=now() WHERE event_id=$1 AND state='failed'",[job]);
        if(row.family==='preparation'){
          await client.query("UPDATE artifacts SET next_attempt=now() WHERE event_id=$1 AND state='failed' AND error_code IS DISTINCT FROM 'import_bytes_pending'",[job]);
          await client.query("UPDATE transcription_jobs SET next_attempt=now() WHERE artifact_id IN (SELECT id FROM artifacts WHERE event_id=$1) AND state='failed'",[job]);
          await client.query("UPDATE guard_sources SET next_attempt=now() WHERE event_id=$1 AND state='failed'",[job]);
        }
        if(row.family==='memory_review'&&job.startsWith('review:'))await client.query("UPDATE memory_review_jobs SET next_attempt=now(),updated_at=now() WHERE id=$1 AND state='failed'",[job.slice(7)]);
        if(row.family==='honcho'&&job.startsWith('receipt:'))await client.query("UPDATE honcho_receipts SET next_attempt=now(),updated_at=now() WHERE id=$1 AND state='pending'",[job.slice(8)]);
        await client.query("UPDATE workflow_registry SET state='queued',dispatch=dispatch+1,next_attempt=now(),waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[id]);
        await client.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,$3)',[hash(id+':'+(row.dispatch+1)),id,row.dispatch+1]);
      }else{
        const query:Partial<Record<WorkflowFamily,string>>={
          telegram:"UPDATE dispatches SET state='cancelled',error_code='owner_cancelled',updated_at=now() WHERE event_id=$1 AND state IN ('pending','failed')",
          imports:"UPDATE workflow_imports SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='queued'",
          browser:"UPDATE managed_runs SET state='cancelled',cancel_requested=true,updated_at=now() WHERE event_id=$1 AND state='captured'",
          schedules:"UPDATE managed_runs SET state='cancelled',cancel_requested=true,updated_at=now() WHERE event_id=$1 AND state='captured'",
          actions:"UPDATE action_requests SET state='rejected',error_code='owner_cancelled',updated_at=now() WHERE id=$1 AND state IN ('proposed','approved')",
          tools:"UPDATE controlled_actions SET state='rejected',updated_at=now() WHERE id=$1 AND state IN ('proposed','approved')",
          memory_review:"UPDATE memory_review_jobs SET state='paused',error_code='owner_cancelled',updated_at=now() WHERE id=$1 AND state IN ('pending','failed','paused')",
        };
        const changed=await client.query(query[row.family as WorkflowFamily]!,[row.family==='memory_review'?job.slice(7):row.family==='schedules'?job.slice(4):job]);
        if(!changed.rowCount)throw new HttpError(409,'workflow_domain_changed');
        await client.query("UPDATE workflow_registry SET state='cancelled',next_attempt=NULL,waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[id]);
      }
      await client.query('INSERT INTO workflow_controls(workflow_id,revision,action) VALUES($1,$2,$3)',[id,revision,action]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return workflowDetail(pool,id);
}
export async function workflowHealth(pool:pg.Pool){
  const results=await Promise.all([
    pool.query('SELECT family,state,count(*)::int AS count FROM workflow_observations GROUP BY family,state ORDER BY family,state'),
    pool.query(`SELECT o.family,o.owner,o.epoch,o.admission,r.app,r.version,r.seen_at,(r.seen_at>now()-interval '30 seconds') IS TRUE AS connected FROM workflow_owners o LEFT JOIN workflow_worker_registrations r USING(family) ORDER BY family`),
    pool.query(`SELECT count(*)::int AS pending,count(*) FILTER(WHERE f.owner='inngest' AND f.admission)::int AS admitted,min(o.created_at) AS oldest
      FROM workflow_outbox o JOIN workflow_registry w ON w.id=o.workflow_id JOIN workflow_owners f USING(family)
      WHERE o.published_at IS NULL AND o.dispatch=w.dispatch AND w.state IN ('queued','waiting','running','retryable_failed')`),
    pool.query("SELECT min(created_at) AS oldest FROM workflow_observations WHERE state IN ('queued','waiting','retryable_failed')"),
    pool.query("SELECT service,seen_at,(seen_at>now()-interval '30 seconds') AS fresh FROM service_heartbeats WHERE service IN ('nocheh-app','workflow-pipeline','workflow-host') ORDER BY service"),
    // A domain may finish before orchestration records completion. Report the
    // last confirmed workflow completion, never its admission/update timestamp.
    pool.query("SELECT max(updated_at) AS at FROM workflow_registry WHERE state='completed'")]);
  return {counts:results[0].rows,workers:results[1].rows,outbox:results[2].rows[0],oldest_waiting:results[3].rows[0].oldest,services:results[4].rows,last_success_at:results[5].rows[0].at,observed_at:new Date().toISOString()};
}
