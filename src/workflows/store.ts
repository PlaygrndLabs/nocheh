import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {HttpError} from '../http.js';

export const families=['preparation','telegram','imports','memory_review','honcho','browser','schedules','actions','tools'] as const;
export type WorkflowFamily=typeof families[number];
export type ExecutionAuthority={owner:'inngest';epoch:number};
export const closedStates=['completed','failed','skipped','cancelled','ambiguous','denied'] as const;
export type WorkflowState='queued'|'waiting'|'running'|'retryable_failed'|typeof closedStates[number];
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const workflowSchema=`
CREATE TABLE IF NOT EXISTS workflow_owners (
  family text PRIMARY KEY CHECK(family IN (${families.map(f=>`'${f}'`).join(',')})),
  owner text NOT NULL DEFAULT 'inngest' CHECK(owner IN ('legacy','inngest')),
  epoch integer NOT NULL DEFAULT 1, admission boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow_owners ALTER COLUMN owner SET DEFAULT 'inngest';
INSERT INTO workflow_owners(family) VALUES ${families.map(f=>`('${f}')`).join(',')} ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS workflow_worker_registrations (
  family text PRIMARY KEY REFERENCES workflow_owners(family),version integer NOT NULL,
  app text NOT NULL CHECK(app IN ('pipeline','host')),seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_registry (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
  family text NOT NULL REFERENCES workflow_owners(family), job_id text NOT NULL,
  version integer NOT NULL CHECK(version>0), generation integer NOT NULL CHECK(generation>0),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','waiting','running','retryable_failed','completed','failed','skipped','cancelled','ambiguous','denied')),
  stage text NOT NULL DEFAULT 'admission', attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz, waiting_reason text, revision integer NOT NULL DEFAULT 1,
  dispatch integer NOT NULL DEFAULT 1, owner_epoch integer, lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family,job_id,version,generation)
);
CREATE INDEX IF NOT EXISTS workflow_registry_status ON workflow_registry(family,state,created_at,id);
CREATE TABLE IF NOT EXISTS workflow_outbox (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), workflow_id text NOT NULL REFERENCES workflow_registry(id),
  dispatch integer NOT NULL, attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
  published_at timestamptz, error_code text CHECK(error_code IS NULL OR error_code='publication_unavailable'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow_id,dispatch)
);
CREATE INDEX IF NOT EXISTS workflow_outbox_due ON workflow_outbox(next_attempt) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS workflow_runs (
  workflow_id text NOT NULL REFERENCES workflow_registry(id), run_id text NOT NULL,
  dispatch integer NOT NULL, owner_epoch integer NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id,run_id)
);
CREATE TABLE IF NOT EXISTS workflow_receipts (
  workflow_id text NOT NULL REFERENCES workflow_registry(id), step text NOT NULL,
  attempt integer NOT NULL, state text NOT NULL CHECK(state IN ('started','done','failed','ambiguous')),
  receipt_id text CHECK(receipt_id IS NULL OR receipt_id ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id,step,attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_effect_exclusion ON workflow_receipts(workflow_id,step)
  WHERE state IN ('started','done','ambiguous');
`;

/** Call on the SAME transaction client as the domain mutation. No publication here. */
export async function requestWorkflow(client:pg.PoolClient,family:WorkflowFamily,jobId:string,generation=1,version=1):Promise<string> {
  if(!families.includes(family)||!jobId||jobId.length>200||!Number.isSafeInteger(generation)||generation<1||!Number.isSafeInteger(version)||version<1)
    throw new HttpError(400,'invalid_workflow_request');
  const id=hash(JSON.stringify([family,jobId,version,generation]));
  await client.query(`INSERT INTO workflow_registry(id,family,job_id,version,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[id,family,jobId,version,generation]);
  await client.query(`INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,1) ON CONFLICT DO NOTHING`,[hash(id+':1'),id]);
  return id;
}

const lockKey="hashtextextended(current_schema()||':workflow:'||$1,803321)";
/** Hold on the operation's existing database connection through receipt commit. */
export async function enterFamily(client:pg.PoolClient,family:WorkflowFamily,owner:'legacy'|'inngest',epoch:number,draining=false):Promise<boolean> {
  if(owner!=='inngest'||!Number.isSafeInteger(epoch)||epoch<1)return false;
  const locked=(await client.query(`SELECT pg_try_advisory_lock_shared(${lockKey}) AS locked`,[family])).rows[0].locked;
  if(!locked)return false;
  try {
    const row=(await client.query('SELECT owner,epoch,admission FROM workflow_owners WHERE family=$1',[family])).rows[0];
    // Draining is only for a domain operation already durably claimed under
    // this exact epoch. It cannot grant admission to new work.
    if(row?.owner===owner&&(row.admission||draining)&&row.epoch===epoch)return true;
  } catch(error) {await leaveFamily(client,family);throw error;}
  await leaveFamily(client,family);return false;
}
export async function leaveFamily(client:pg.PoolClient,family:WorkflowFamily):Promise<void> {
  await client.query(`SELECT pg_advisory_unlock_shared(${lockKey})`,[family]);
}
/** A failed unlock must discard the session, never return its locks to the pool. */
export async function releaseOperation(client:pg.PoolClient,unlock:()=>Promise<void>):Promise<void> {
  let failed=false;
  try{await unlock();}catch(error){failed=true;throw error;}finally{client.release(failed);}
}

/** Pausing is separate from switching: existing holders may finish and commit receipts. */
export async function pauseFamily(pool:pg.Pool,family:WorkflowFamily,epoch:number):Promise<void> {
  const result=await pool.query('UPDATE workflow_owners SET admission=false,updated_at=now() WHERE family=$1 AND epoch=$2 RETURNING family',[family,epoch]);
  if(!result.rowCount)throw new HttpError(409,'workflow_owner_changed');
}
export async function switchFamily(pool:pg.Pool,family:WorkflowFamily,epoch:number,owner:'legacy'|'inngest'):Promise<number> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');const next=await switchFamilyTransaction(client,family,epoch,owner);
    await client.query('COMMIT');return next;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** Caller holds its transaction through backfill and migration-receipt commit. */
export async function switchFamilyTransaction(client:pg.PoolClient,family:WorkflowFamily,epoch:number,owner:'legacy'|'inngest'):Promise<number> {
  if(owner!=='inngest')throw new HttpError(409,'legacy_execution_removed');
  const locked=(await client.query(`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,[family])).rows[0].locked;
  if(!locked)throw new HttpError(409,'workflow_family_not_drained');
  // Expiry cannot prove an effect did not happen. Reconciliation must clear
  // every running record/started receipt before either direction of cutover.
  const uncertain=await client.query(`SELECT 1 FROM workflow_registry w WHERE family=$1 AND (state='running' OR EXISTS(
    SELECT 1 FROM workflow_receipts r WHERE r.workflow_id=w.id AND r.state='started')) LIMIT 1`,[family]);
  if(uncertain.rowCount)throw new HttpError(409,'workflow_receipts_unreconciled');
  const domainQueries:Partial<Record<WorkflowFamily,string>>={
    telegram:"SELECT 1 FROM dispatches WHERE state='running' LIMIT 1",
    imports:"SELECT 1 FROM workflow_imports WHERE state='running' LIMIT 1",
    actions:"SELECT 1 FROM action_requests WHERE state='running' LIMIT 1",
    tools:"SELECT 1 FROM controlled_actions WHERE state IN ('claimed','running') LIMIT 1",
    memory_review:"SELECT 1 FROM memory_review_jobs WHERE state='running' LIMIT 1",
    honcho:"SELECT 1 FROM honcho_receipts WHERE state='uncertain' LIMIT 1",
    browser:"SELECT 1 FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='browser' AND r.state='running' LIMIT 1",
    schedules:"SELECT 1 FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='scheduler' AND r.state='running' LIMIT 1",
  };
  const query=domainQueries[family];
  if(query&&(await client.query(query)).rowCount)throw new HttpError(409,'workflow_receipts_unreconciled');
  const changed=await client.query(`UPDATE workflow_owners SET owner=$3,epoch=epoch+1,admission=true,updated_at=now()
    WHERE family=$1 AND epoch=$2 AND admission=false RETURNING epoch`,[family,epoch,owner]);
  if(!changed.rowCount)throw new HttpError(409,'workflow_owner_changed');
  return changed.rows[0].epoch;
}

export type WorkflowEvent={name:'nocheh/workflow.requested';id:string;data:{workflow_id:string;dispatch:number;family:WorkflowFamily}};
/** Record only after Connect confirms function registration; refresh while ACTIVE. */
export async function registerWorker(pool:pg.Pool,app:'pipeline'|'host',registered:WorkflowFamily[],version=1){
  for(const family of registered)await pool.query(`INSERT INTO workflow_worker_registrations(family,version,app) VALUES($1,$2,$3)
    ON CONFLICT(family) DO UPDATE SET version=excluded.version,app=excluded.app,seen_at=now()`,[family,version,app]);
}
export async function publishOutbox(pool:pg.Pool,send:(event:WorkflowEvent)=>Promise<unknown>,limit=25):Promise<number> {
  let published=0;
  for(let i=0;i<limit;i++) {
    const token=randomUUID();
    const result=await pool.query(`UPDATE workflow_outbox o SET lease_token=$1,lease_until=now()+interval '30 seconds',attempts=o.attempts+1
      WHERE o.id=(SELECT candidate.id FROM workflow_outbox candidate
        JOIN workflow_registry w ON w.id=candidate.workflow_id JOIN workflow_owners f ON f.family=w.family
        WHERE candidate.published_at IS NULL AND candidate.dispatch=w.dispatch AND candidate.next_attempt<=now()
        AND (candidate.lease_until IS NULL OR candidate.lease_until<now()) AND f.owner='inngest' AND f.admission
        AND EXISTS(SELECT 1 FROM workflow_worker_registrations r WHERE r.family=w.family AND r.version=w.version AND r.seen_at>now()-interval '30 seconds')
        AND w.state IN ('queued','waiting','retryable_failed','running')
        ORDER BY candidate.created_at,candidate.id FOR UPDATE OF candidate SKIP LOCKED LIMIT 1)
      RETURNING o.id,o.workflow_id,o.dispatch,(SELECT family FROM workflow_registry WHERE id=o.workflow_id) AS family`,[token]);
    const row=result.rows[0];if(!row)break;
    try {
      await send({name:'nocheh/workflow.requested',id:row.id,data:{workflow_id:row.workflow_id,dispatch:row.dispatch,family:row.family}});
      await pool.query(`UPDATE workflow_outbox SET published_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2`,[row.id,token]);
      published++;
    }catch {
      // A lost acknowledgment republishes exactly this ID. Permanent execution
      // exclusion is the registry's responsibility, including after 24 hours.
      await pool.query(`UPDATE workflow_outbox SET lease_token=NULL,lease_until=NULL,error_code='publication_unavailable',
        next_attempt=now()+least(3600,power(2,least(attempts,11)))*interval '1 second' WHERE id=$1 AND lease_token=$2`,[row.id,token]);
      break;
    }
  }
  return published;
}

export async function claimWorkflow(client:pg.PoolClient,id:string,dispatch:number,runId:string,epoch:number) {
  if(!/^[a-f0-9]{64}$/.test(id)||!/^[-a-zA-Z0-9_]{1,100}$/.test(runId))throw new HttpError(400,'invalid_workflow_identity');
  const row=(await client.query('SELECT * FROM workflow_registry WHERE id=$1',[id])).rows[0];
  if(!row||row.dispatch!==dispatch||closedStates.includes(row.state))return null;
  const token=randomUUID();
  const claimed=await client.query(`UPDATE workflow_registry w SET lease_token=$3,lease_until=now()+interval '2 minutes',owner_epoch=$4,
    updated_at=now() WHERE id=$1 AND dispatch=$2 AND state IN ('queued','waiting','retryable_failed','running')
    AND (lease_until IS NULL OR lease_until<now())
    AND EXISTS(SELECT 1 FROM workflow_owners f WHERE f.family=w.family AND f.owner='inngest' AND f.epoch=$4 AND f.admission)
    RETURNING *`,[id,dispatch,token,epoch]);
  if(!claimed.rowCount)return null;
  await client.query(`INSERT INTO workflow_runs(workflow_id,run_id,dispatch,owner_epoch) VALUES($1,$2,$3,$4)
    ON CONFLICT(workflow_id,run_id) DO UPDATE SET seen_at=now()`,[id,runId,dispatch,epoch]);
  return {...claimed.rows[0],lease_token:token};
}

export async function beginEffect(client:pg.PoolClient,id:string,token:string,step:string,attempt:number) {
  if(!/^[a-z_]{1,40}$/.test(step)||!Number.isSafeInteger(attempt)||attempt<1)throw new HttpError(400,'invalid_workflow_step');
  const result=await client.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state)
    SELECT id,$3,$4,'started' FROM workflow_registry w WHERE id=$1 AND lease_token=$2 AND lease_until>now()
    AND state IN ('queued','waiting','retryable_failed','running')
    AND EXISTS(SELECT 1 FROM workflow_owners f WHERE f.family=w.family AND f.owner='inngest' AND f.epoch=w.owner_epoch AND f.admission)
    AND NOT EXISTS(SELECT 1 FROM workflow_receipts r WHERE r.workflow_id=w.id AND r.step=$3 AND r.state IN ('started','done','ambiguous'))
    ON CONFLICT DO NOTHING RETURNING *`,[id,token,step,attempt]);
  if(result.rowCount)return {execute:true,state:'started'};
  const previous=(await client.query('SELECT state,receipt_id FROM workflow_receipts WHERE workflow_id=$1 AND step=$2 AND attempt=$3',[id,step,attempt])).rows[0];
  // Even an expired lease does not authorize repeating a started effect.
  return {execute:false,state:previous?.state??'denied',receipt_id:previous?.receipt_id??null};
}
export async function finishEffect(client:pg.PoolClient,id:string,step:string,attempt:number,state:'done'|'failed'|'ambiguous',receiptId:string) {
  if(!/^[a-f0-9]{64}$/.test(receiptId))throw new HttpError(400,'invalid_workflow_receipt');
  const result=await client.query(`UPDATE workflow_receipts SET state=$4,receipt_id=$5,updated_at=now()
    WHERE workflow_id=$1 AND step=$2 AND attempt=$3 AND state='started' RETURNING state`,[id,step,attempt,state,receiptId]);
  if(!result.rowCount) {
    const previous=(await client.query('SELECT state,receipt_id FROM workflow_receipts WHERE workflow_id=$1 AND step=$2 AND attempt=$3',[id,step,attempt])).rows[0];
    if(previous?.state!==state||previous.receipt_id!==receiptId)throw new HttpError(409,'workflow_receipt_conflict');
  }
}
