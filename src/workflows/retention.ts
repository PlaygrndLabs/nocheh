import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {secret} from '../config.js';

/**
 * Optional expiry of Inngest's own run history and telemetry. Nocheh receipts,
 * the workflow registry and Inngest's queue state never live in these tables.
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

/** Drain everything past the cutoff, pausing between batches so live writes keep priority. */
export async function expireWorkflowHistory(client:pg.ClientBase,cutoff:Date,pause=200):Promise<Pruned> {
  const total=Object.fromEntries(prunedTables.map(table=>[table,0])) as Pruned;
  for(;;) {
    const pruned=await pruneWorkflowHistory(client,cutoff);
    for(const table of prunedTables)total[table]+=pruned[table];
    if(prunedTables.every(table=>!pruned[table]))return total;
    await delay(pause);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let days=0;
  try{days=retentionDays();}catch{console.error(JSON.stringify({event:'workflow_history_retention',state:'invalid'}));process.exit(1);}
  if(!days){console.log(JSON.stringify({event:'workflow_history_retention',state:'off'}));process.exit(0);}
  // Exit at once: PostgreSQL's shutdown waits for open sessions, and an
  // interrupted batch is its own transaction, so it simply rolls back.
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>process.exit(0));
  for(;;) {
    const client=new pg.Client({host:'127.0.0.1',user:'nocheh_inngest',database:'nocheh_inngest',password:secret('INNGEST_POSTGRES_PASSWORD'),
      application_name:'nocheh-workflow-retention',options:'-c statement_timeout=60000 -c client_connection_check_interval=1000'});
    try {
      await client.connect();
      const pruned=await expireWorkflowHistory(client,new Date(Date.now()-days*86400000));
      console.log(JSON.stringify({event:'workflow_history_retention',state:'pruned',days,...pruned}));
    } catch {console.error(JSON.stringify({event:'workflow_history_retention',state:'unavailable'}));}
    finally {await client.end().catch(()=>{});}
    // Expiry is measured in days, so one check per day is enough.
    await delay(86400000);
  }
}
