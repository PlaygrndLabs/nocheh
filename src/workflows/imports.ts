import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {HttpError,object} from '../http.js';
import {canonical} from '../archive.js';
import {hash,requestWorkflow,enterFamily,leaveFamily,releaseOperation} from './store.js';

export const importWorkflowSchema=`
CREATE TABLE IF NOT EXISTS workflow_imports (
 id uuid PRIMARY KEY,configuration_hash text NOT NULL,review_approved boolean NOT NULL,
 total integer NOT NULL CHECK(total>=0),completed integer NOT NULL DEFAULT 0,duplicates integer NOT NULL DEFAULT 0,
 learning_after integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','cancelled','failed')),
 lease_token uuid,lease_until timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(completed BETWEEN 0 AND total),CHECK(learning_after BETWEEN 0 AND total),CHECK(duplicates>=0)
);
CREATE TABLE IF NOT EXISTS workflow_host_receipts (
 token uuid PRIMARY KEY,workflow_id text NOT NULL REFERENCES workflow_registry(id),
 observation jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);`;
const uuid=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw new HttpError(400,'invalid_job');return value;};
export function importConfiguration(preview:unknown,mapping:unknown,approved:unknown) {
  const p=object(preview),m=object(mapping);
  if(typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256)||!Number.isSafeInteger(p.messages)||Number(p.messages)<0||typeof approved!=='boolean')throw new HttpError(400,'invalid_import_configuration');
  if(Object.entries(m).some(([key,value])=>!key||typeof value!=='string'))throw new HttpError(400,'invalid_import_configuration');
  return hash(canonical({sha256:p.sha256,mapping:m,review_approved:approved,total:p.messages}));
}
export async function confirmImport(pool:pg.Pool,input:unknown) {
  const b=object(input),id=uuid(b.id);
  if(typeof b.configuration_hash!=='string'||!/^[a-f0-9]{64}$/.test(b.configuration_hash)||typeof b.review_approved!=='boolean'||!Number.isSafeInteger(b.total)||Number(b.total)<0)throw new HttpError(400,'invalid_import_configuration');
  const completed=b.completed??0,duplicates=b.duplicates??0;
  if(!Number.isSafeInteger(completed)||Number(completed)<0||Number(completed)>Number(b.total)||!Number.isSafeInteger(duplicates)||Number(duplicates)<0)throw new HttpError(400,'invalid_import_checkpoint');
  const client=await pool.connect();let held=false;
  try {
    const owner=(await client.query("SELECT owner,admission FROM workflow_owners WHERE family='imports'")).rows[0];
    if(!owner?.admission)throw new HttpError(409,'import_owner_paused');
    if(owner.owner==='legacy')return {owned:false};
    held=await enterFamily(client,'imports','inngest');if(!held)throw new HttpError(409,'import_owner_paused');
    await client.query('BEGIN');
    await client.query(`INSERT INTO workflow_imports(id,configuration_hash,review_approved,total,completed,duplicates) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,b.configuration_hash,b.review_approved,b.total,completed,duplicates]);
    let job=(await client.query('SELECT * FROM workflow_imports WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(job.configuration_hash!==b.configuration_hash||job.review_approved!==b.review_approved||job.total!==b.total)throw new HttpError(409,'resume_import_configuration_cannot_change');
    if(['cancelled','failed'].includes(job.state)){
      if(b.resume!==true)throw new HttpError(409,'import_resume_required');
      job=(await client.query("UPDATE workflow_imports SET state='queued',generation=generation+1,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
    }
    if(job.state!=='completed')await requestWorkflow(client,'imports',id,job.generation);
    await client.query('COMMIT');return {owned:true,job};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await releaseOperation(client,async()=>{if(held)await leaveFamily(client,'imports');});}
}
export async function cancelImport(pool:pg.Pool,id:unknown) {
  const client=await pool.connect();try{
    await client.query('BEGIN');
    await client.query("SELECT id FROM workflow_registry WHERE family='imports' AND job_id=$1 ORDER BY id FOR UPDATE",[uuid(id)]);
    const job=(await client.query("UPDATE workflow_imports SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state IN ('queued','running') RETURNING *",[uuid(id)])).rows[0];
    if(job)await client.query("UPDATE workflow_registry SET state='cancelled',lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE family='imports' AND job_id=$1 AND state IN ('queued','running','waiting','retryable_failed')",[job.id]);
    await client.query('COMMIT');return {owned:!!job,job};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function claimImportBatch(client:pg.PoolClient,id:string,workflowGeneration:number) {
  return (await client.query(`UPDATE workflow_imports SET state='running',lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1 AND generation=$2 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,[uuid(id),workflowGeneration,randomUUID()])).rows[0]??null;
}
export async function finishImportBatch(client:pg.PoolClient,id:string,token:string,value:unknown) {
  const b=object(value);
  if(!Number.isSafeInteger(b.completed)||!Number.isSafeInteger(b.duplicates)||!Number.isSafeInteger(b.learning_after)||typeof b.complete!=='boolean')throw new HttpError(400,'invalid_import_receipt');
  const updated=await client.query(`UPDATE workflow_imports SET completed=$3,duplicates=$4,learning_after=$5,
    state=CASE WHEN $6 THEN 'completed' ELSE 'queued' END,lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND state='running' AND completed<=$3 AND $3<=total AND duplicates<=$4 AND learning_after<=$5 AND $5<=total
    AND (NOT $6 OR ($3=total AND (NOT review_approved OR $5=total))) RETURNING *`,[uuid(id),uuid(token),b.completed,b.duplicates,b.learning_after,b.complete]);
  if(!updated.rowCount)throw new HttpError(409,'import_receipt_conflict');return updated.rows[0];
}
/** Held around each archive write, so cancellation and ownership cannot race the write. */
export async function enterImportWrite(pool:pg.Pool,id:unknown,token:unknown,owner:unknown='inngest') {
  uuid(id);if(!['legacy','inngest'].includes(String(owner)))throw new HttpError(400,'invalid_import_owner');
  const client=await pool.connect();let held=false;
  try {
    held=await enterFamily(client,'imports',owner as 'legacy'|'inngest');
    if(!held)throw new HttpError(409,'import_owner_paused');
    await client.query('BEGIN');
    const job=owner==='legacy'?{review_approved:true}:(await client.query("SELECT * FROM workflow_imports WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() FOR SHARE",[uuid(id),uuid(token)])).rows[0];
    if(!job)throw new HttpError(409,'import_execution_closed');
    return {job,release:async()=>{await releaseOperation(client,async()=>{await client.query('COMMIT');await leaveFamily(client,'imports');});}};
  }catch(error){await releaseOperation(client,async()=>{await client.query('ROLLBACK');if(held)await leaveFamily(client,'imports');});throw error;}
}
