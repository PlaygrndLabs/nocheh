/** Local family cutover is independent of Inngest's control plane. */
import type pg from 'pg';
import {HttpError,object} from '../http.js';
import {families,hash,closedStates,switchFamilyTransaction,type WorkflowFamily} from './store.js';
import {workflowIdentity} from './client.js';
import type {RuntimeCall} from '../runtime.js';

export const migrationSchema=`
CREATE TABLE IF NOT EXISTS workflow_migrations (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),family text NOT NULL REFERENCES workflow_owners(family),
 from_owner text NOT NULL CHECK(from_owner IN ('legacy','inngest')),to_owner text NOT NULL CHECK(to_owner IN ('legacy','inngest')),
 from_epoch integer NOT NULL,to_epoch integer,state text NOT NULL DEFAULT 'paused' CHECK(state IN ('paused','switched','aborted')),
 registered integer NOT NULL DEFAULT 0,reconciled integer NOT NULL DEFAULT 0,redispatched integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(from_owner<>to_owner)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_migration_active ON workflow_migrations(family) WHERE state='paused';
ALTER TABLE workflow_migrations ADD COLUMN IF NOT EXISTS host_ready boolean NOT NULL DEFAULT false;
`;
const fence="SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':workflow:'||$1,803321)) AS held";
function family(value:unknown):WorkflowFamily {
  if(!families.includes(value as WorkflowFamily))throw new HttpError(400,'invalid_workflow_family');return value as WorkflowFamily;
}
export async function migrationStatus(pool:pg.Pool,id:string){
  workflowIdentity(id);const row=(await pool.query('SELECT * FROM workflow_migrations WHERE id=$1',[id])).rows[0];
  if(!row)throw new HttpError(404,'migration_not_found');
  const owner=(await pool.query('SELECT * FROM workflow_owners WHERE family=$1',[row.family])).rows[0];
  const counts=(await pool.query(`SELECT count(*) FILTER(WHERE state='running')::int AS running,
    count(*) FILTER(WHERE lease_until>now())::int AS active_steps,
    count(*) FILTER(WHERE EXISTS(SELECT 1 FROM workflow_receipts r WHERE r.workflow_id=w.id AND r.state='started'))::int AS unresolved_receipts
    FROM workflow_registry w WHERE family=$1`,[row.family])).rows[0];
  return {...row,owner,counts};
}
export async function beginMigration(pool:pg.Pool,input:unknown){
  const b=object(input),id=workflowIdentity(b.id),f=family(b.family),epoch=Number(b.epoch),target=b.owner;
  if(!Number.isSafeInteger(epoch)||epoch<1||!['legacy','inngest'].includes(String(target)))throw new HttpError(400,'invalid_migration');
  const client=await pool.connect();try{
    await client.query('BEGIN');
    const owner=(await client.query('SELECT * FROM workflow_owners WHERE family=$1 FOR NO KEY UPDATE',[f])).rows[0];
    const prior=(await client.query('SELECT * FROM workflow_migrations WHERE id=$1',[id])).rows[0];
    if(prior){if(prior.family!==f||prior.from_epoch!==epoch||prior.to_owner!==target)throw new HttpError(409,'migration_identity_conflict');}
    else{
      if(owner.epoch!==epoch||!owner.admission||owner.owner===target)throw new HttpError(409,'workflow_owner_changed');
      await client.query('INSERT INTO workflow_migrations(id,family,from_owner,to_owner,from_epoch) VALUES($1,$2,$3,$4,$5)',[id,f,owner.owner,target,epoch]);
      await client.query('UPDATE workflow_owners SET admission=false,updated_at=now() WHERE family=$1',[f]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return migrationStatus(pool,id);
}
export async function migrationHostReady(pool:pg.Pool,id:string){
  workflowIdentity(id);
  const changed=await pool.query("UPDATE workflow_migrations SET host_ready=true,updated_at=now() WHERE id=$1 AND state='paused' AND family IN ('imports','tools') RETURNING id",[id]);
  if(!changed.rowCount)throw new HttpError(409,'migration_host_not_paused');return migrationStatus(pool,id);
}
export async function stageMigrationImport(pool:pg.Pool,id:string,input:unknown){
  workflowIdentity(id);const b=object(input),job=String(b.id);
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job)||typeof b.configuration_hash!=='string'||!/^[a-f0-9]{64}$/.test(b.configuration_hash)||typeof b.review_approved!=='boolean')throw new HttpError(400,'invalid_import_configuration');
  for(const name of ['total','completed','duplicates','learning_after'])if(!Number.isSafeInteger(b[name])||Number(b[name])<0)throw new HttpError(400,'invalid_import_checkpoint');
  if(Number(b.completed)>Number(b.total)||Number(b.learning_after)>Number(b.total)||!b.review_approved&&b.learning_after!==0)throw new HttpError(400,'invalid_import_checkpoint');
  const client=await pool.connect();try{
    await client.query('BEGIN');
    const migration=(await client.query("SELECT * FROM workflow_migrations WHERE id=$1 AND family='imports' AND state='paused' AND to_owner='inngest' FOR UPDATE",[id])).rows[0];
    if(!migration)throw new HttpError(409,'migration_host_not_paused');
    if(!(await client.query(fence,['imports'])).rows[0].held)throw new HttpError(409,'workflow_family_not_drained');
    const owner=(await client.query("SELECT * FROM workflow_owners WHERE family='imports' FOR NO KEY UPDATE")).rows[0];
    if(owner.epoch!==migration.from_epoch||owner.admission)throw new HttpError(409,'workflow_owner_changed');
    await client.query(`INSERT INTO workflow_imports(id,configuration_hash,review_approved,total,completed,duplicates,learning_after)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[job,b.configuration_hash,b.review_approved,b.total,b.completed,b.duplicates,b.learning_after]);
    const current=(await client.query('SELECT * FROM workflow_imports WHERE id=$1 FOR UPDATE',[job])).rows[0];
    if(current.configuration_hash!==b.configuration_hash||current.review_approved!==b.review_approved||current.total!==b.total)throw new HttpError(409,'import_configuration_changed');
    if(current.state==='queued'){
      await client.query('UPDATE workflow_imports SET completed=greatest(completed,$2),duplicates=greatest(duplicates,$3),learning_after=greatest(learning_after,$4),updated_at=now() WHERE id=$1',[job,b.completed,b.duplicates,b.learning_after]);
      await client.query("SELECT nocheh_workflow_request('imports',$1,$2)",[job,current.generation]);
    }
    await client.query('COMMIT');return {id:job,state:current.state};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

// Eligibility uses only durable domain identities. It never infers import
// consent, a browser submission, or a scheduled occurrence from source content.
const candidates:Record<WorkflowFamily,string>={
  preparation:`SELECT e.id AS job,1 AS generation FROM events e WHERE
    EXISTS(SELECT 1 FROM artifacts a WHERE a.event_id=e.id AND (a.state<>'ready' OR NOT EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.artifact_id=a.id AND d.kind IN ('transcript','extracted_text','extraction_status'))))
    OR EXISTS(SELECT 1 FROM guard_sources g,guard_state s WHERE g.event_id=e.id AND g.state<>'ready' AND s.mode='on')`,
  telegram:"SELECT event_id AS job,1 AS generation FROM dispatches WHERE state IN ('pending','failed')",
  imports:"SELECT id::text AS job,generation FROM workflow_imports WHERE state='queued'",
  browser:"SELECT r.event_id AS job,1 AS generation FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='browser' AND r.admitted AND r.state='captured' AND NOT r.cancel_requested",
  schedules:`SELECT 'schedule:'||id||':'||cursor AS job,1 AS generation FROM workflow_schedules UNION ALL
    SELECT 'run:'||r.event_id AS job,1 AS generation FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='scheduler' AND r.admitted AND r.state='captured' AND NOT r.cancel_requested`,
  actions:"SELECT id AS job,1 AS generation FROM action_requests WHERE state IN ('proposed','approved')",
  tools:"SELECT id AS job,1 AS generation FROM controlled_actions WHERE state IN ('proposed','approved')",
  memory_review:`SELECT 'review:'||j.id AS job,j.generation+1 AS generation FROM memory_review_jobs j WHERE j.state IN ('pending','failed','paused')
    AND EXISTS(SELECT 1 FROM memory_learning_sources l WHERE l.event_id=j.event_id)
    UNION ALL SELECT 'source:'||l.event_id,1 FROM memory_learning_sources l,guard_state g WHERE NOT l.prepared OR l.prepared_epoch IS DISTINCT FROM g.epoch`,
  honcho:`SELECT 'receipt:'||id AS job,1 AS generation FROM honcho_receipts WHERE state='pending'
    UNION ALL SELECT 'generation:'||id,1 FROM honcho_generations WHERE state='building'
    UNION ALL SELECT 'refresh',1 FROM honcho_connection WHERE attached AND verified`,
};
async function registerMissing(client:pg.PoolClient,f:WorkflowFamily){
  const result=await client.query(`WITH candidates AS (${candidates[f]}), missing AS (
    SELECT DISTINCT job,generation FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM workflow_registry w WHERE w.family=$1 AND w.job_id=c.job))
    SELECT nocheh_workflow_request($1,job,generation) FROM missing`,[f]);
  return result.rowCount??0;
}
async function reconcileRecorded(client:pg.PoolClient,f:WorkflowFamily){
  // Archive-only import writes require a live lease. Once expired, replaying a
  // checkpoint is safe because imported source IDs deduplicate permanently.
  if(f==='imports')await client.query("UPDATE workflow_imports SET state='queued',lease_token=NULL,lease_until=NULL WHERE state='running' AND lease_until<now()");
  const receipts=await client.query(`UPDATE workflow_receipts r SET state=CASE WHEN o.state='ambiguous' THEN 'ambiguous'
    WHEN o.state='retryable_failed' THEN 'failed' ELSE 'done' END,
    receipt_id=coalesce(r.receipt_id,encode(sha256(convert_to(r.workflow_id||':'||r.step||':'||r.attempt::text,'UTF8')),'hex')),updated_at=now()
    FROM workflow_observations o WHERE o.id=r.workflow_id AND o.family=$1 AND r.state='started'
    AND o.state IN ('completed','failed','skipped','cancelled','ambiguous','denied','retryable_failed')
    AND o.registry_state NOT IN ('completed','failed','skipped','cancelled','ambiguous','denied')`,[f]);
  const rows=await client.query(`UPDATE workflow_registry w SET state=o.state,lease_token=NULL,lease_until=NULL,
    next_attempt=CASE WHEN o.state='retryable_failed' THEN o.next_attempt ELSE NULL END,
    waiting_reason=NULL,revision=w.revision+1,updated_at=now() FROM workflow_observations o
    WHERE w.id=o.id AND w.family=$1 AND w.state IN ('queued','waiting','running','retryable_failed')
    AND o.state IN ('completed','failed','skipped','cancelled','ambiguous','denied','retryable_failed') AND w.state<>o.state`,[f]);
  if(f==='imports')await client.query("UPDATE workflow_registry w SET state='queued',lease_token=NULL,lease_until=NULL WHERE family='imports' AND state='running' AND EXISTS(SELECT 1 FROM workflow_imports i WHERE i.id::text=w.job_id AND i.state='queued')");
  if(f==='tools')await client.query(`UPDATE workflow_registry w SET state=o.state,lease_token=NULL,lease_until=NULL,
    revision=w.revision+1,updated_at=now() FROM workflow_observations o WHERE w.id=o.id AND w.family='tools'
    AND w.state='running' AND o.state IN ('queued','waiting')
    AND NOT EXISTS(SELECT 1 FROM workflow_receipts r WHERE r.workflow_id=w.id AND r.state IN ('started','done','ambiguous'))`);
  return (rows.rowCount??0)+(receipts.rowCount??0);
}
/** Observe existing native identities only. Missing receipts stay unresolved. */
export async function reconcileMigration(pool:pg.Pool,id:string,runtime:RuntimeCall,ownerScope:string|null){
  workflowIdentity(id);const client=await pool.connect();let observed=0,unavailable=0;
  try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM workflow_migrations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.state!=='paused')throw new HttpError(409,'migration_not_paused');
    if(!(await client.query(fence,[row.family])).rows[0].held)throw new HttpError(409,'workflow_family_not_drained');
    const owner=(await client.query('SELECT * FROM workflow_owners WHERE family=$1 FOR NO KEY UPDATE',[row.family])).rows[0];
    if(owner.epoch!==row.from_epoch||owner.owner!==row.from_owner||owner.admission)throw new HttpError(409,'workflow_owner_changed');
    if((await client.query('SELECT 1 FROM workflow_registry WHERE family=$1 AND lease_until>now() LIMIT 1',[row.family])).rowCount)throw new HttpError(409,'workflow_family_not_drained');
    const queries:Partial<Record<WorkflowFamily,string>>={
      telegram:"SELECT event_id AS id,attempts FROM dispatches WHERE state='running' ORDER BY event_id LIMIT 20",
      actions:"SELECT id FROM action_requests WHERE state='running' ORDER BY id LIMIT 20",
      memory_review:"SELECT id,generation FROM memory_review_jobs WHERE state='running' ORDER BY id LIMIT 20",
      browser:"SELECT r.event_id AS id FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='browser' AND r.state='running' ORDER BY r.event_id LIMIT 20",
      schedules:"SELECT r.event_id AS id FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='scheduler' AND r.state='running' ORDER BY r.event_id LIMIT 20",
    };
    const query=queries[row.family as WorkflowFamily];
    for(const job of query?(await client.query(query)).rows:[]){
      let receipt:Record<string,unknown>;
      try{
        if(row.family==='actions')receipt=await runtime('action.execute',{id:job.id,observe_only:true},4000);
        else if(row.family==='memory_review')receipt=await runtime('memory.review',{id:hash(job.id+':'+job.generation),scope:ownerScope,observe_only:true},4000);
        else receipt=await runtime('run.resume',{channel:row.family==='schedules'?'scheduler':row.family,event_id:job.id,attempt:row.family==='telegram'?job.attempts:1,observe_only:true},4000);
      }catch{unavailable++;continue;}
      const state=String(receipt.state);
      if(row.family==='telegram'&&['done','failed','ambiguous','suppressed','cancelled'].includes(state)){
        await client.query("UPDATE dispatches SET state=$2,error_code=NULL,updated_at=now() WHERE event_id=$1 AND state='running'",[job.id,state]);observed++;
      }else if(row.family==='actions'&&['done','ambiguous'].includes(state)){
        await client.query("UPDATE action_requests SET state=$2,error_code=NULL,updated_at=now() WHERE id=$1 AND state='running'",[job.id,state]);observed++;
      }else if(row.family==='memory_review'&&['done','ambiguous'].includes(state)){
        await client.query("UPDATE memory_review_jobs SET state=$2,error_code=NULL,updated_at=now() WHERE id=$1 AND state='running'",[job.id,state]);observed++;
      }else if(['browser','schedules'].includes(row.family)&&['failed','ambiguous','cancelled'].includes(state)){
        await client.query("UPDATE managed_runs SET state=$2,error_code='runtime_execution_interrupted',lease_until=NULL,updated_at=now() WHERE event_id=$1 AND state='running'",[job.id,state==='ambiguous'?'interrupted':state]);observed++;
      }
      // Managed completion must publish its protected result through finishRun;
      // a metadata-only 'done' response cannot substitute for that evidence.
    }
    observed+=await reconcileRecorded(client,row.family);
    await client.query('UPDATE workflow_migrations SET reconciled=reconciled+$2,updated_at=now() WHERE id=$1',[id,observed]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return {...await migrationStatus(pool,id),observed,unavailable};
}
export async function finishMigration(pool:pg.Pool,id:string,action:'switch'|'abort'){
  workflowIdentity(id);const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM workflow_migrations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new HttpError(404,'migration_not_found');
    if(row.state===(action==='switch'?'switched':'aborted')){await client.query('COMMIT');return migrationStatus(pool,id);}
    if(row.state!=='paused')throw new HttpError(409,'migration_closed');
    if(!(await client.query(fence,[row.family])).rows[0].held)throw new HttpError(409,'workflow_family_not_drained');
    const owner=(await client.query('SELECT * FROM workflow_owners WHERE family=$1 FOR NO KEY UPDATE',[row.family])).rows[0];
    if(owner.epoch!==row.from_epoch||owner.owner!==row.from_owner||owner.admission)throw new HttpError(409,'workflow_owner_changed');
    if(action==='abort'){
      await client.query('UPDATE workflow_owners SET admission=true,updated_at=now() WHERE family=$1',[row.family]);
      await client.query("UPDATE workflow_migrations SET state='aborted',updated_at=now() WHERE id=$1",[id]);
    }else{
      if(['imports','tools'].includes(row.family)&&!row.host_ready)throw new HttpError(409,'migration_host_handoff_required');
      if((await client.query('SELECT 1 FROM workflow_registry WHERE family=$1 AND lease_until>now() LIMIT 1',[row.family])).rowCount)throw new HttpError(409,'workflow_family_not_drained');
      if(row.to_owner==='inngest'&&!(await client.query("SELECT 1 FROM workflow_worker_registrations WHERE family=$1 AND version=1 AND seen_at>now()-interval '30 seconds'",[row.family])).rowCount)throw new HttpError(409,'workflow_worker_not_ready');
      const reconciled=await reconcileRecorded(client,row.family),registered=await registerMissing(client,row.family);
      // Rollback cannot hand a closed registry outcome to an eligible legacy
      // scanner. Reconcile its domain receipt before restoring that owner.
      if(row.to_owner==='legacy'&&(await client.query(`WITH candidates AS (${candidates[row.family as WorkflowFamily]})
        SELECT 1 FROM candidates c JOIN workflow_registry w ON w.family=$1 AND w.job_id=c.job
        WHERE w.state=ANY($2::text[]) AND w.generation=(SELECT max(generation) FROM workflow_registry latest WHERE latest.family=w.family AND latest.job_id=w.job_id) LIMIT 1`,[row.family,closedStates])).rowCount)throw new HttpError(409,'rollback_closed_domain_unreconciled');
      const epoch=await switchFamilyTransaction(client,row.family,row.from_epoch,row.to_owner);
      const work=(await client.query(`UPDATE workflow_registry SET dispatch=dispatch+1,owner_epoch=NULL,lease_token=NULL,lease_until=NULL,
        revision=revision+1,updated_at=now() WHERE family=$1 AND state IN ('queued','waiting','retryable_failed') RETURNING id,dispatch`,[row.family])).rows;
      for(const w of work)await client.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,$3)',[hash(w.id+':'+w.dispatch),w.id,w.dispatch]);
      await client.query("UPDATE workflow_migrations SET state='switched',to_epoch=$2,registered=$3,reconciled=reconciled+$4,redispatched=$5,updated_at=now() WHERE id=$1",[id,epoch,registered,reconciled,work.length]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return migrationStatus(pool,id);
}
