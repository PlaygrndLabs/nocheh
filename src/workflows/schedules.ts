/** Native definitions stay in Hermes; archive rows address durable occurrences. */
import type pg from 'pg';
import type {Settings} from '../config.js';
import {agentOperation,type Agent} from '../agent/agent.js';
import {HttpError,object,string} from '../http.js';
import {hash,requestOpenWorkflow,type ExecutionAuthority} from './store.js';
import {observation,type WorkflowOperation} from './pipeline.js';
import {ownerChat} from '../assistant-policy.js';
import {servedGroup} from '../spaces.js';

export const scheduleWorkflowSchema=`CREATE TABLE IF NOT EXISTS workflow_schedules (
 id text PRIMARY KEY,logical_profile text NOT NULL,job_id text NOT NULL,
 source_event_id text NOT NULL REFERENCES events(id),cursor text NOT NULL,sequence bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(logical_profile,job_id)
);
ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT 0;`;
export async function scheduleOwnership(pool:pg.Pool){return (await pool.query("SELECT owner,epoch,admission FROM workflow_owners WHERE family='schedules'")).rows[0];}
export async function recordSchedule(pool:pg.Pool,source:string,input:unknown){
  const b=object(input);if(b.workflow_cursor===undefined)return;
  const cursor=string(b.workflow_cursor,64);if(!/^[a-f0-9]{64}$/.test(cursor))throw new HttpError(400,'invalid_schedule_cursor');
  const sequence=Number(b.workflow_sequence);if(!Number.isSafeInteger(sequence)||sequence<1)throw new HttpError(400,'invalid_schedule_sequence');
  const id=hash(JSON.stringify([b.profile,b.job_id])),client=await pool.connect();
  try {
    await client.query('BEGIN');
    const changed=await client.query(`INSERT INTO workflow_schedules(id,logical_profile,job_id,source_event_id,cursor,sequence) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET source_event_id=excluded.source_event_id,cursor=excluded.cursor,sequence=excluded.sequence,updated_at=now()
      WHERE workflow_schedules.sequence<excluded.sequence OR (workflow_schedules.sequence=excluded.sequence AND workflow_schedules.cursor=excluded.cursor)`,[id,b.profile,b.job_id,source,cursor,sequence]);
    if(!changed.rowCount){
      const current=(await client.query('SELECT sequence,cursor FROM workflow_schedules WHERE id=$1',[id])).rows[0];
      if(Number(current.sequence)===sequence&&current.cursor!==cursor)throw new HttpError(409,'schedule_sequence_conflict');
      await client.query('COMMIT');return;
    }
    await client.query(`UPDATE workflow_registry SET state='skipped',waiting_reason='superseded',revision=revision+1,updated_at=now()
      WHERE family='schedules' AND job_id LIKE $1 AND job_id<>$2 AND state IN ('queued','waiting','retryable_failed')`,['schedule:'+id+':%','schedule:'+id+':'+cursor]);
    // A Run now moves the cursor away and back again (pending, running, then idle with the same next run); the cursor's
    // earlier row is then closed, and a new generation runs it (ADR-0266).
    await requestOpenWorkflow(client,'schedules','schedule:'+id+':'+cursor);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** A schedule whose current cursor has no open workflow, only one closed as superseded, gets a new generation; a Run now
 * left such a schedule without a run before this was fixed (ADR-0266). Returns how many were started again. */
export async function reviveSchedules(pool:pg.Pool):Promise<number> {
  const stuck=(await pool.query(`SELECT s.id,s.cursor FROM workflow_schedules s
    WHERE EXISTS(SELECT 1 FROM workflow_registry w WHERE w.family='schedules' AND w.job_id='schedule:'||s.id||':'||s.cursor
      AND w.state='skipped' AND w.waiting_reason='superseded')
    AND NOT EXISTS(SELECT 1 FROM workflow_registry w WHERE w.family='schedules' AND w.job_id='schedule:'||s.id||':'||s.cursor
      AND w.state NOT IN ('skipped','cancelled'))`)).rows;
  let revived=0;
  for(const row of stuck) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      // The same lock a definition takes, so a cursor that moved meanwhile is left to its own request.
      const current=(await client.query('SELECT cursor FROM workflow_schedules WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(current?.cursor===row.cursor&&await requestOpenWorkflow(client,'schedules','schedule:'+row.id+':'+row.cursor))revived++;
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return revived;
}
export async function scheduledContext(pool:pg.Pool,config:Settings,input:unknown){
  const b=object(input),row=(await pool.query(`SELECT r.*,e.scope,e.payload,o.epoch,o.owner,o.admission FROM managed_runs r
    JOIN events e ON e.id=r.event_id CROSS JOIN workflow_owners o WHERE r.event_id=$1 AND e.channel='scheduler' AND o.family='schedules'`,[b.event_id])).rows[0];
  if(!row||!row.admitted||row.owner!=='inngest'||row.epoch!==b.owner_epoch||!row.admission)throw new HttpError(409,'workflow_owner_changed');
  if(row.scope!==ownerChat(config.assistant)&&!servedGroup(row.scope))throw new HttpError(403,'run_scope_denied');
  const payload=JSON.parse(row.payload.toString());
  return {event_id:b.event_id,actor:'run_'+b.event_id,scope:row.scope,profile:payload.profile,logical_profile:row.logical_profile,
    conversation:'cron_'+row.job_id+'_'+String(b.event_id).slice(0,24),job_id:row.job_id,definition:payload.definition,
    job_revision:payload.job_revision,owner_epoch:row.epoch,state:row.state};
}
export async function scheduledAuthority(pool:pg.Pool,config:Settings,input:unknown):Promise<ExecutionAuthority>{
  const b=object(input);await scheduledContext(pool,config,b);
  if(b.actor!=='run_'+b.event_id)throw new HttpError(409,'run_actor_mismatch');
  return {owner:'inngest',epoch:Number(b.owner_epoch)};
}
export async function scheduledObservation(pool:pg.Pool,input:unknown){
  const b=object(input),row=(await pool.query(`SELECT r.state,e.payload FROM managed_runs r JOIN events e ON e.id=r.event_id
    WHERE r.event_id=$1 AND e.channel='scheduler' AND e.scope=$2`,[b.event_id,b.scope])).rows[0];
  if(!row||JSON.parse(row.payload.toString()).profile!==b.profile)throw new HttpError(404,'captured_run_not_found');return {state:row.state};
}
export function scheduleOperation(pool:pg.Pool,agent:Agent,run:WorkflowOperation):WorkflowOperation{
  return async(job,authority)=>{
    if(job.startsWith('run:'))return run(job.slice(4),authority);
    const match=/^schedule:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(job);
    if(!match)return observation('failed','admission');
    const row=(await pool.query('SELECT * FROM workflow_schedules WHERE id=$1',[match[1]])).rows[0];
    if(!row||row.cursor!==match[2])return observation('skipped','schedule');
    const result=await agentOperation(agent,'advanceSchedules')({logical_profile:row.logical_profile,job_id:row.job_id,cursor:row.cursor,owner_epoch:authority.epoch});
    if(!['waiting','completed','skipped'].includes(String(result.state)))throw new HttpError(503,'invalid_schedule_observation');
    if(result.state==='waiting'&&(!Number.isSafeInteger(result.next_attempt)||Number(result.next_attempt)<0))throw new HttpError(503,'invalid_schedule_observation');
    return observation(result.state as 'waiting'|'completed'|'skipped','schedule',0,result.state==='waiting'?Number(result.next_attempt):Date.now(),result.state==='waiting'?'prerequisite':null);
  };
}
