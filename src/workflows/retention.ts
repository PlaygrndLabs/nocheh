import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {secret} from '../config.js';
import {closedStates} from './store.js';

/**
 * Optional expiry of Inngest's own run history and telemetry, Nocheh's spent
 * workflow publication records and run links, broker model-call events and
 * guard invalidation notes, superseded Honcho context summaries, and guard
 * fragments of already prepared sources. Nocheh
 * receipts, the workflow registry and Inngest's queue state are never removed.
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

export type PrunedTelemetry={model_effects:number;guard_invalidations:number};
/**
 * Remove operational telemetry nothing reads after the window: the broker's
 * per-call `model.request` security events (their timings feed only the stage
 * breakdown of replies inside the window) and guard invalidation notes, which
 * record an epoch advance and are never read. Action and tool effects stay in
 * the security log: they are the owner's audit of approvals and outcomes.
 */
export async function pruneTelemetry(client:pg.ClientBase,cutoff:Date,batch=5000):Promise<PrunedTelemetry> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  const effects=await client.query(`DELETE FROM security_events WHERE ctid IN (SELECT ctid FROM security_events
    WHERE kind='model.request' AND created_at<$1 LIMIT $2)`,[cutoff,batch]);
  const invalidations=await client.query(`DELETE FROM guard_invalidations WHERE ctid IN (SELECT ctid FROM guard_invalidations
    WHERE created_at<$1 LIMIT $2)`,[cutoff,batch]);
  return {model_effects:effects.rowCount??0,guard_invalidations:invalidations.rowCount??0};
}
export const expireTelemetry=(client:pg.ClientBase,cutoff:Date,pause=200)=>drain(()=>pruneTelemetry(client,cutoff),pause);

export type PrunedSummaries={memory_contexts:number;memory_results:number};
/**
 * Remove spent Honcho context summaries from derived storage. Each context read
 * records Honcho's output (`memory_result`) and its bounded `memory_context`
 * with a guarded copy, and uses them only in the call that records them; a
 * later identical read reuses or recreates them. A summary younger than
 * `before` is kept, so a read still in progress is never touched.
 */
export async function pruneMemorySummaries(derived:pg.ClientBase,before:Date,batch=200):Promise<PrunedSummaries> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  await derived.query('BEGIN');
  try {
    const ids=(await derived.query(`SELECT d.id FROM derived_artifacts d WHERE d.kind='memory_context' AND d.operation_id LIKE 'native-context:%:bounded'
      AND d.created_at<$1
      AND NOT EXISTS (SELECT 1 FROM runtime_prepared_inputs p WHERE p.source_id='derived_artifacts:'||d.id) LIMIT $2 FOR UPDATE`,[before,batch])).rows.map(row=>String(row.id));
    const sources=ids.map(id=>'derived_artifacts:'+id);
    for(const table of ['guard_activations','guard_fragments','guard_revisions','guard_sources'])
      await derived.query(`DELETE FROM ${table} WHERE ${table==='guard_sources'?'id':'source_id'}=ANY($1::text[])`,[sources]);
    const contexts=await derived.query('DELETE FROM derived_artifacts WHERE id=ANY($1::text[])',[ids]);
    // A full representation goes with its bounded summary, or alone when no summary was saved from it.
    const results=await derived.query(`DELETE FROM derived_artifacts WHERE ctid IN (SELECT d.ctid FROM derived_artifacts d
      WHERE d.kind='memory_result' AND d.operation_id LIKE 'native-context:%' AND d.created_at<$1
      AND NOT EXISTS (SELECT 1 FROM derived_artifacts b WHERE b.operation_id=d.operation_id||':bounded') LIMIT $2)`,[before,batch]);
    await derived.query('COMMIT');
    return {memory_contexts:contexts.rowCount??0,memory_results:results.rowCount??0};
  } catch(error){await derived.query('ROLLBACK').catch(()=>{});throw error;}
}
export const expireMemorySummaries=(derived:pg.ClientBase,before:Date,pause=200)=>drain(()=>pruneMemorySummaries(derived,before),pause);

export type PrunedFragments={guard_fragments:number};
/**
 * Remove guard fragments of sources that already have a published guarded
 * revision. Fragments only let an interrupted preparation resume without
 * repeating detector calls; a source with an active revision is never prepared
 * again, so they are never read. A fragment younger than `before` is kept, so a
 * preparation that is still finishing keeps its own checkpoints.
 */
export async function pruneGuardFragments(derived:pg.ClientBase,before:Date,batch=5000):Promise<PrunedFragments> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  const fragments=await derived.query(`DELETE FROM guard_fragments WHERE ctid IN (SELECT f.ctid FROM guard_fragments f
    JOIN guard_sources s ON s.id=f.source_id WHERE s.active_revision IS NOT NULL AND f.created_at<$1 LIMIT $2)`,[before,batch]);
  return {guard_fragments:fragments.rowCount??0};
}
export const expireGuardFragments=(derived:pg.ClientBase,before:Date,pause=200)=>drain(()=>pruneGuardFragments(derived,before),pause);

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let days=0;
  try{days=retentionDays();}catch{console.error(JSON.stringify({event:'workflow_history_retention',state:'invalid'}));process.exit(1);}
  if(!days){console.log(JSON.stringify({event:'workflow_history_retention',state:'off'}));process.exit(0);}
  // Exit at once: PostgreSQL's shutdown waits for open sessions, and an
  // interrupted batch is its own transaction, so it simply rolls back.
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>process.exit(0));
  // Each store connects with its own role; one unavailable store does not stop the others.
  const connect=async(role:string,database:string,password:string)=>{
    const client=new pg.Client({host:'127.0.0.1',user:role,database,password:secret(password),
      application_name:'nocheh-workflow-retention',options:'-c statement_timeout=60000 -c client_connection_check_interval=1000'});
    await client.connect();return client;
  };
  const run=async(event:string,expire:(clients:pg.Client[])=>Promise<Record<string,number>>,...stores:[string,string,string][])=>{
    const clients:pg.Client[]=[];
    try {
      for(const [role,database,password] of stores)clients.push(await connect(role,database,password));
      console.log(JSON.stringify({event,state:'pruned',days,...await expire(clients)}));
    } catch {console.error(JSON.stringify({event,state:'unavailable'}));}
    finally {for(const client of clients)await client.end().catch(()=>{});}
  };
  for(;;) {
    const cutoff=new Date(Date.now()-days*86400000);
    await run('workflow_history_retention',([client])=>expireWorkflowHistory(client!,cutoff),['nocheh_inngest','nocheh_inngest','INNGEST_POSTGRES_PASSWORD']);
    await run('workflow_record_retention',([client])=>expireWorkflowRecords(client!,cutoff),['nocheh_control','nocheh_control','NOCHEH_CONTROL_PASSWORD']);
    await run('telemetry_retention',([client])=>expireTelemetry(client!,cutoff),['nocheh_control','nocheh_control','NOCHEH_CONTROL_PASSWORD']);
    // The derived runtime role cannot delete, so this local worker uses the administrator role.
    await run('memory_summary_retention',([derived])=>expireMemorySummaries(derived!,new Date(Date.now()-3600000)),
      ['nocheh','nocheh_derived','POSTGRES_PASSWORD']);
    await run('guard_fragment_retention',([derived])=>expireGuardFragments(derived!,new Date(Date.now()-3600000)),
      ['nocheh','nocheh_derived','POSTGRES_PASSWORD']);
    // Expiry is measured in days, so one check per day is enough.
    await delay(86400000);
  }
}
