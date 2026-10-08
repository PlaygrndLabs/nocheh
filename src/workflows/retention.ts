import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {secret} from '../config.js';

/**
 * Optional expiry of Inngest's own run telemetry. Nocheh receipts, the
 * workflow registry and Inngest's queue state never live in these tables.
 * Zero, the default, keeps every row.
 */
export function retentionDays(value=process.env.NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS??'0'):number {
  if(!/^\d{1,4}$/.test(value)||Number(value)>3650)throw Error('invalid_workflow_history_retention');
  return Number(value);
}

export type Pruned={spans:number;history:number;traces:number};
/**
 * Remove telemetry of runs whose newest recorded activity precedes the cutoff,
 * one bounded batch per call. A run that is still active keeps all of its rows.
 * Inngest stores `history` and `traces` timestamps in UTC without a zone.
 */
export async function pruneWorkflowHistory(client:pg.ClientBase,cutoff:Date,batch=2000):Promise<Pruned> {
  if(!Number.isSafeInteger(batch)||batch<1)throw Error('invalid_retention_batch');
  const spans=await client.query(`WITH old AS (SELECT run_id FROM spans GROUP BY run_id HAVING max(end_time)<$1 LIMIT $2)
    DELETE FROM spans s USING old WHERE s.run_id=old.run_id`,[cutoff,batch]);
  const history=await client.query(`WITH old AS (SELECT run_id FROM history GROUP BY run_id
    HAVING max(created_at)<($1::timestamptz AT TIME ZONE 'UTC') LIMIT $2)
    DELETE FROM history h USING old WHERE h.run_id=old.run_id`,[cutoff,batch]);
  const traces=await client.query(`DELETE FROM traces WHERE ctid IN (SELECT ctid FROM traces
    WHERE "timestamp"<($1::timestamptz AT TIME ZONE 'UTC') LIMIT $2)`,[cutoff,batch*20]);
  return {spans:spans.rowCount??0,history:history.rowCount??0,traces:traces.rowCount??0};
}

/** Drain everything past the cutoff, pausing between batches so live writes keep priority. */
export async function expireWorkflowHistory(client:pg.ClientBase,cutoff:Date,pause=200):Promise<Pruned> {
  const total:Pruned={spans:0,history:0,traces:0};
  for(;;) {
    const pruned=await pruneWorkflowHistory(client,cutoff);
    for(const key of Object.keys(total) as (keyof Pruned)[])total[key]+=pruned[key];
    if(!pruned.spans&&!pruned.history&&!pruned.traces)return total;
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
