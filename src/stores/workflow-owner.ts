import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import {workflowIdentity} from '../workflows/client.js';
import {hash} from '../workflows/store.js';
import {workflowDetail,workflowView} from '../workflows/owner.js';

/** All relations in this view are control metadata. Source references are links, never SQL joins to content. */
export const storageWorkflowOwnerSchema=`
CREATE OR REPLACE VIEW workflow_observations AS
SELECT w.id,w.family,w.job_id,w.version,w.generation,w.state AS registry_state,w.revision,w.dispatch,
 w.created_at,w.created_at::text AS created_cursor,w.updated_at,w.owner_epoch,o.owner,o.admission,
 (w.lease_until>now()) IS TRUE AS active_step,
 coalesce(d.event_id,a.source_reference->>'id',t.source_reference->>'id',j.source_reference->>'id',h.source_reference->>'id',
   r.file_reference#>>'{event,id}',CASE WHEN w.family IN ('telegram','preparation') AND w.job_id ~ '^[a-f0-9]{64}$' THEN w.job_id
   WHEN w.family IN ('memory_review','honcho') AND w.job_id ~ '^source:[a-f0-9]{64}$' THEN substring(w.job_id FROM 8) END) AS source_event_id,
 CASE WHEN w.state IN ('completed','failed','skipped','cancelled','ambiguous','denied') THEN w.state
 WHEN d.event_id IS NOT NULL THEN CASE d.state WHEN 'done' THEN 'completed' WHEN 'suppressed' THEN 'skipped' WHEN 'pending' THEN w.state ELSE d.state END
 WHEN a.id IS NOT NULL THEN CASE a.state WHEN 'done' THEN 'completed' WHEN 'rejected' THEN 'denied' WHEN 'proposed' THEN 'waiting' WHEN 'approved' THEN w.state ELSE a.state END
 WHEN t.id IS NOT NULL THEN CASE t.state WHEN 'done' THEN 'completed' WHEN 'rejected' THEN 'denied' WHEN 'proposed' THEN 'waiting' WHEN 'approved' THEN w.state ELSE t.state END
 WHEN j.id IS NOT NULL THEN CASE WHEN j.paused OR j.state='paused' THEN 'waiting' WHEN j.state='done' THEN 'completed' WHEN j.state='pending' THEN w.state WHEN j.state='ambiguous' THEN 'waiting' ELSE j.state END
 WHEN h.id IS NOT NULL THEN CASE h.state WHEN 'done' THEN 'completed' WHEN 'uncertain' THEN 'waiting' ELSE w.state END
 WHEN r.state='done' THEN 'completed' ELSE w.state END AS state,
 CASE WHEN j.state='ambiguous' OR h.state='uncertain' THEN 'reconcile'
 WHEN w.stage<>'admission' THEN w.stage WHEN d.event_id IS NOT NULL THEN d.runtime_stage
 WHEN w.family='preparation' THEN 'preparation' WHEN w.family='memory_review' THEN 'review'
 WHEN w.family='honcho' THEN 'sync' WHEN w.family IN ('actions','tools') THEN 'action' ELSE w.stage END AS stage,
 greatest(w.attempts,coalesce(d.attempts,0),coalesce(j.attempts,0),coalesce(h.attempts,0),coalesce(r.attempts,0),CASE WHEN t.started_at IS NOT NULL THEN 1 ELSE 0 END) AS attempts,
 coalesce(w.next_attempt,d.next_attempt,j.next_attempt,h.next_attempt) AS next_attempt,
 CASE WHEN a.state='proposed' OR t.state='proposed' THEN 'approval_required' WHEN j.paused OR j.state='paused' THEN 'owner_paused'
 WHEN j.state='ambiguous' OR h.state='uncertain' THEN 'receipt_pending' ELSE w.waiting_reason END AS waiting_reason,
 NULL::integer AS total,NULL::integer AS completed,NULL::integer AS duplicates,NULL::integer AS learning_after,
 NULL::text AS native_job_id,NULL::text AS native_profile,
 (w.family IN ('telegram','actions') OR w.family='tools' AND t.id IS NOT NULL OR w.family='memory_review' AND w.job_id LIKE 'native:%' AND coalesce(j.attempts,0)=0) AS domain_controllable,
 (w.family IN ('telegram','preparation','actions','memory_review','honcho') OR w.family='tools' AND t.id IS NOT NULL) AS retry_supported,
 EXISTS(SELECT 1 FROM workflow_receipts r WHERE r.workflow_id=w.id AND r.state IN ('started','ambiguous','done')) AS receipt_blocked
FROM workflow_registry w JOIN workflow_owners o USING(family)
LEFT JOIN dispatches d ON w.family='telegram' AND d.event_id=w.job_id
LEFT JOIN telegram_action_requests a ON w.family='actions' AND a.id=w.job_id
LEFT JOIN controlled_actions t ON w.family='tools' AND t.id=w.job_id
LEFT JOIN native_review_jobs j ON w.family='memory_review' AND w.job_id='native:'||j.id
LEFT JOIN memory_ingestion_receipts h ON w.family='honcho' AND w.job_id IN ('receipt:'||h.id,'reconcile:'||h.id)
LEFT JOIN reprocess_jobs r ON w.family='preparation' AND w.job_id='reprocess:'||r.id;
CREATE TABLE IF NOT EXISTS workflow_controls (
 workflow_id text NOT NULL REFERENCES workflow_registry(id),revision integer NOT NULL,action text NOT NULL CHECK(action IN ('retry','cancel')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,revision,action)
);
`;

/** Control-only transactions; owner retry never changes a native execution identity. */
export async function controlStorageWorkflow(pool:pg.Pool,principal:Reader,id:string,action:string,input:unknown) {
  admin(principal);workflowIdentity(id);const body=object(input),revision=body.revision;
  if(Object.keys(body).some(k=>k!=='revision')||!['retry','cancel'].includes(action)||!Number.isSafeInteger(revision)||Number(revision)<1)
    throw new HttpError(400,'invalid_workflow_control');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');const row=(await db.query('SELECT * FROM workflow_registry WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new HttpError(404,'workflow_not_found');
    const prior=(await db.query('SELECT 1 FROM workflow_controls WHERE workflow_id=$1 AND revision=$2 AND action=$3',[id,revision,action])).rowCount;
    if(!prior) {
      if(row.revision!==revision)throw new HttpError(409,'workflow_revision_changed');
      if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':workflow:'||$1,803321)) AS held",[row.family])).rows[0].held)
        throw new HttpError(409,'workflow_execution_in_progress');
      const current=workflowView((await db.query('SELECT * FROM workflow_observations WHERE id=$1',[id])).rows[0]);
      if(!current[action==='retry'?'can_retry':'can_cancel'])throw new HttpError(409,'workflow_'+(current.control_reason??'control_unavailable'));
      if((await db.query("SELECT 1 FROM workflow_receipts WHERE workflow_id=$1 AND state IN ('started','ambiguous','done') LIMIT 1",[id])).rowCount)
        throw new HttpError(409,'workflow_receipt_closed');
      const job=row.job_id;
      if(action==='retry') {
        if(row.family==='preparation'&&!job.startsWith('reprocess:'))await db.query("UPDATE attachment_retrievals SET next_attempt=now() WHERE event_id=$1 AND state='failed' AND error_code IS DISTINCT FROM 'import_bytes_pending'",[job]);
        if(row.family==='honcho'&&job.startsWith('receipt:'))await db.query("UPDATE memory_ingestion_receipts SET next_attempt=now() WHERE id=$1 AND state='pending'",[job.slice(8)]);
        if(row.family==='memory_review'&&job.startsWith('native:'))await db.query("UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1 AND state='pending' AND NOT paused",[job.slice(7)]);
        await db.query("UPDATE workflow_registry SET state='queued',dispatch=dispatch+1,next_attempt=now(),waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[id]);
        await db.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,$3)',[hash(id+':'+(row.dispatch+1)),id,row.dispatch+1]);
      } else {
        let changed=0;
        if(row.family==='telegram') {
          await db.query(`INSERT INTO dispatches(event_id,source_reference) SELECT event_id,jsonb_build_object('store','archive','kind','event','id',event_id,'revision',source_revision,'input_hash',payload_hash)
            FROM capture_handoffs WHERE event_id=$1 ON CONFLICT DO NOTHING`,[job]);
          changed=(await db.query("UPDATE dispatches SET state='cancelled',error_code='owner_cancelled',revision=revision+1,updated_at=now() WHERE event_id=$1 AND state='pending' AND attempts=0",[job])).rowCount??0;
        }
        if(row.family==='actions')changed=(await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code='owner_cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND state IN ('proposed','approved')",[job])).rowCount??0;
        if(row.family==='tools')changed=(await db.query("UPDATE controlled_actions SET state='rejected',error_code='owner_cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND state IN ('proposed','approved') AND started_at IS NULL",[job])).rowCount??0;
        if(row.family==='memory_review'&&job.startsWith('native:'))changed=(await db.query("UPDATE native_review_jobs SET paused=true,state='paused',error_code='owner_cancelled',revision=revision+1,updated_at=now() WHERE id=$1 AND state IN ('pending','paused') AND attempts=0",[job.slice(7)])).rowCount??0;
        if(!changed)throw new HttpError(409,'workflow_domain_changed');
        await db.query("UPDATE workflow_registry SET state='cancelled',next_attempt=NULL,waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[id]);
      }
      await db.query('INSERT INTO workflow_controls(workflow_id,revision,action) VALUES($1,$2,$3)',[id,revision,action]);
    }
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  return workflowDetail(pool,id);
}
