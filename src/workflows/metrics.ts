/** Bounded, content-free owner aggregates over persisted orchestration evidence. */
import type pg from 'pg';
import {HttpError,object} from '../http.js';
import {families,type WorkflowFamily} from './store.js';
export type MetricsRange='24h'|'7d';
export type WorkflowMetricBucket={start:string;end:string;admitted:number;completed:number;terminal_failed:number;completion_ms_p50:number|null;completion_ms_p95:number|null;completion_samples:number};
export type WorkflowMetrics={range:MetricsRange;family:WorkflowFamily|null;from:string;to:string;bucket_seconds:number;observed_at:string;buckets:WorkflowMetricBucket[]};
export async function workflowMetrics(pool:pg.Pool,input:unknown={},now=new Date()):Promise<WorkflowMetrics>{
 const args=object(input),range=args.range??'24h',family=args.family===''||args.family===undefined?null:args.family;
 if(range!=='24h'&&range!=='7d')throw new HttpError(400,'invalid_metrics_range');
 if(family!==null&&(typeof family!=='string'||!families.includes(family as WorkflowFamily)))throw new HttpError(400,'invalid_workflow_filter');
 const bucketSeconds=range==='24h'?3600:21600,to=now.toISOString(),from=new Date(now.getTime()-(range==='24h'?24:168)*3600000).toISOString();
 const client=await pool.connect();let rows:Record<string,any>[];
 try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='3s'");
  rows=(await client.query(`WITH buckets AS (
    SELECT generate_series(date_bin($3::interval,$1::timestamptz,'2000-01-01 UTC'::timestamptz),$2::timestamptz,$3::interval) AS at
   ), admissions AS (
    SELECT date_bin($3::interval,created_at,'2000-01-01 UTC'::timestamptz) AS at,count(*)::int AS admitted
    FROM workflow_registry WHERE created_at >= $1 AND created_at < $2 AND ($4::text IS NULL OR family=$4) GROUP BY 1
   ), outcomes AS (
    SELECT date_bin($3::interval,updated_at,'2000-01-01 UTC'::timestamptz) AS at,
      count(*) FILTER(WHERE state='completed')::int AS completed,
      count(*) FILTER(WHERE state='failed')::int AS terminal_failed,
      count(*) FILTER(WHERE state='completed' AND updated_at>=created_at)::int AS completion_samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM updated_at-created_at)*1000) FILTER(WHERE state='completed' AND updated_at>=created_at) AS completion_ms_p50,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM updated_at-created_at)*1000) FILTER(WHERE state='completed' AND updated_at>=created_at) AS completion_ms_p95
    FROM workflow_registry WHERE state IN ('completed','failed') AND updated_at >= $1 AND updated_at < $2 AND ($4::text IS NULL OR family=$4) GROUP BY 1
   ) SELECT greatest(b.at,$1::timestamptz) AS start,least(b.at+$3::interval,$2::timestamptz) AS "end",
    coalesce(a.admitted,0)::int AS admitted,coalesce(o.completed,0)::int AS completed,coalesce(o.terminal_failed,0)::int AS terminal_failed,
    coalesce(o.completion_samples,0)::int AS completion_samples,o.completion_ms_p50,o.completion_ms_p95
   FROM buckets b LEFT JOIN admissions a USING(at) LEFT JOIN outcomes o USING(at) WHERE b.at<$2 ORDER BY b.at`,[from,to,bucketSeconds+' seconds',family])).rows;
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return {range,family:family as WorkflowFamily|null,from,to,bucket_seconds:bucketSeconds,observed_at:to,buckets:rows.map(row=>({...row,start:row.start.toISOString(),end:row.end.toISOString()})) as WorkflowMetricBucket[]};
}
