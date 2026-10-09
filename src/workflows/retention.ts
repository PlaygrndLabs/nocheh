import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {secret} from '../config.js';
import {closedStates} from './store.js';

/**
 * Optional expiry of Inngest's own run history and telemetry and of Nocheh's
 * spent workflow publication records and run links. Nocheh receipts, the
 * workflow registry and Inngest's queue state are never removed.
 * Fourteen days is the default; zero keeps every row.
 */
export function retentionDays(value=process.env.NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS??'14'):number {
  if(!/^\d{1,4}$/.test(value)||Number(value)>3650)throw Error('invalid_workflow_history_retention');
  return Number(value);
}

export const prunedTables=['spans','history','traces','function_runs','function_finishes','events','event_batches','trace_runs','worker_connections'] as const;
export type Pruned=Record<typeof prunedTables[number],number>;
/**
 * Remove history of runs whose newest recorded activity precedes the cutoff,
 * one bounded batch per call. A run that is still active keeps all of its rows,
 * and an event is kept while any run it triggered is still recorded.
 * Inngest stores `timestamp without time zone` columns in UTC and the
 * `trace_runs` and `worker_connections` times as Unix milliseconds; a run
 * that has not ended records a negative `ended_at`.
 */
export async function pruneWorkflowHistory(client:pg.ClientBase,cutoff:Date,batch=2000):Promise<Pruned> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  const utc=`($1::timestamptz AT TIME ZONE 'UTC')`,count=async(sql:string,values:unknown[]=[cutoff,batch])=>(await client.query(sql,values)).rowCount??0;
  const spans=await count(`WITH old AS (SELECT run_id FROM spans GROUP BY run_id HAVING max(end_time)<$1 LIMIT $2)
    DELETE FROM spans s USING old WHERE s.run_id=old.run_id`);
  const history=await count(`WITH old AS (SELECT run_id FROM history GROUP BY run_id HAVING max(created_at)<${utc} LIMIT $2)
    DELETE FROM history h USING old WHERE h.run_id=old.run_id`);
  const traces=await count(`DELETE FROM traces WHERE ctid IN (SELECT ctid FROM traces WHERE "timestamp"<${utc} LIMIT $2)`,[cutoff,batch*20]);
  const function_runs=await count(`DELETE FROM function_runs WHERE ctid IN (SELECT r.ctid FROM function_runs r WHERE r.run_started_at<${utc}
    AND NOT EXISTS (SELECT 1 FROM history h WHERE h.run_id=r.run_id AND h.created_at>=${utc})
    AND NOT EXISTS (SELECT 1 FROM function_finishes f WHERE f.run_id=r.run_id AND f.created_at>=${utc}) LIMIT $2)`);
  const function_finishes=await count(`DELETE FROM function_finishes WHERE ctid IN (SELECT ctid FROM function_finishes WHERE created_at<${utc} LIMIT $2)`);
  const events=await count(`DELETE FROM events WHERE ctid IN (SELECT e.ctid FROM events e WHERE e.received_at<${utc}
    AND NOT EXISTS (SELECT 1 FROM function_runs r WHERE r.event_id=e.internal_id) LIMIT $2)`);
  const event_batches=await count(`DELETE FROM event_batches WHERE ctid IN (SELECT ctid FROM event_batches WHERE executed_at<${utc} LIMIT $2)`);
  const trace_runs=await count(`DELETE FROM trace_runs WHERE ctid IN (SELECT t.ctid FROM trace_runs t WHERE greatest(t.queued_at,t.started_at,t.ended_at)<$1
    AND NOT EXISTS (SELECT 1 FROM spans s WHERE s.run_id=t.run_id::text AND s.end_time>=to_timestamp($1/1000.0)) LIMIT $2)`,[cutoff.getTime(),batch]);
  const worker_connections=await count(`DELETE FROM worker_connections WHERE ctid IN (SELECT ctid FROM worker_connections
    WHERE disconnected_at IS NOT NULL AND greatest(disconnected_at,recorded_at,inserted_at)<$1 LIMIT $2)`,[cutoff.getTime(),batch]);
  return {spans,history,traces,function_runs,function_finishes,events,event_batches,trace_runs,worker_connections};
}

/** Repeat bounded batches until one removes nothing, pausing so live writes keep priority. */
async function drain<T extends Record<string,number>>(prune:()=>Promise<T>,pause:number):Promise<T> {
  let total:T|undefined;
  for(;;) {
    const pruned=await prune();
    total=total?Object.fromEntries(Object.entries(total).map(([key,count])=>[key,count+pruned[key]!])) as T:pruned;
    if(Object.values(pruned).every(count=>!count))return total;
    await delay(pause);
  }
}
/** Drain everything past the cutoff. */
export const expireWorkflowHistory=(client:pg.ClientBase,cutoff:Date,pause=200)=>drain(()=>pruneWorkflowHistory(client,cutoff),pause);

export type PrunedRecords={workflow_outbox:number;workflow_runs:number};
/**
 * Remove Nocheh's own publication records and Inngest run links that can no
 * longer be used: those of a superseded dispatch, and those of a workflow closed
 * before the cutoff. The publisher and run-receipt check read only the current
 * dispatch of an open workflow, and every reopening moves to a new dispatch.
 * The workflow registry and effect receipts are never removed; they carry
 * permanent deduplication and exclude repeated effects.
 */
export async function pruneWorkflowRecords(client:pg.ClientBase,cutoff:Date,batch=2000):Promise<PrunedRecords> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  const closed=closedStates.map(state=>`'${state}'`).join(',');
  const outbox=await client.query(`DELETE FROM workflow_outbox WHERE ctid IN (SELECT o.ctid FROM workflow_outbox o JOIN workflow_registry w ON w.id=o.workflow_id
    WHERE (o.dispatch<w.dispatch AND coalesce(o.published_at,o.created_at)<$1 OR w.state IN (${closed}) AND w.updated_at<$1)
    AND (o.lease_until IS NULL OR o.lease_until<now()) LIMIT $2)`,[cutoff,batch]);
  const runs=await client.query(`DELETE FROM workflow_runs WHERE ctid IN (SELECT r.ctid FROM workflow_runs r JOIN workflow_registry w ON w.id=r.workflow_id
    WHERE (r.dispatch<w.dispatch AND r.seen_at<$1 OR w.state IN (${closed}) AND w.updated_at<$1) LIMIT $2)`,[cutoff,batch]);
  return {workflow_outbox:outbox.rowCount??0,workflow_runs:runs.rowCount??0};
}
export const expireWorkflowRecords=(client:pg.ClientBase,cutoff:Date,pause=200)=>drain(()=>pruneWorkflowRecords(client,cutoff),pause);

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let days=0;
  try{days=retentionDays();}catch{console.error(JSON.stringify({event:'workflow_history_retention',state:'invalid'}));process.exit(1);}
  if(!days){console.log(JSON.stringify({event:'workflow_history_retention',state:'off'}));process.exit(0);}
  // Exit at once: PostgreSQL's shutdown waits for open sessions, and an
  // interrupted batch is its own transaction, so it simply rolls back.
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>process.exit(0));
  // Each store connects with its own runtime role; one unavailable store does not stop the other.
  const run=async(event:string,role:string,password:string,expire:(client:pg.Client,cutoff:Date)=>Promise<Record<string,number>>)=>{
    let client:pg.Client|undefined;
    try {
      client=new pg.Client({host:'127.0.0.1',user:role,database:role,password:secret(password),
        application_name:'nocheh-workflow-retention',options:'-c statement_timeout=60000 -c client_connection_check_interval=1000'});
      await client.connect();
      console.log(JSON.stringify({event,state:'pruned',days,...await expire(client,new Date(Date.now()-days*86400000))}));
    } catch {console.error(JSON.stringify({event,state:'unavailable'}));}
    finally {await client?.end().catch(()=>{});}
  };
  for(;;) {
    await run('workflow_history_retention','nocheh_inngest','INNGEST_POSTGRES_PASSWORD',expireWorkflowHistory);
    await run('workflow_record_retention','nocheh_control','NOCHEH_CONTROL_PASSWORD',expireWorkflowRecords);
    // Expiry is measured in days, so one check per day is enough.
    await delay(86400000);
  }
}
