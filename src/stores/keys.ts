import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object,string} from '../http.js';
import type {KeyList,KeyPerson,KeyStopRequest,KeyStopResult} from '../key-wire.js';
import {memberView,ownerAccount} from './members.js';
import {OwnerCommands} from './owner-commands.js';
import {continuationMaxAttempts} from './action-continuations.js';
import type {AssistantPolicy} from '../assistant-policy.js';

type Policy=()=>Pick<AssistantPolicy,'owner_id'>;

/** The last "Stop everything now" (ADR-0307): when, and what it ended. One row; each stop replaces it. */
export const keyStopSchema=`
CREATE TABLE IF NOT EXISTS key_stops (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),stopped_at timestamptz NOT NULL,counts jsonb NOT NULL
);
`;
const waiting="('queued','waiting','retryable_failed')";

export function keyStopRequest(input:unknown):KeyStopRequest {
  const body=object(input);if(Object.keys(body).some(key=>!['operation_id','again'].includes(key)))throw new HttpError(400,'unknown_operation_field');
  if(body.again!==undefined&&typeof body.again!=='boolean')throw new HttpError(400,'invalid_again');
  return {operation_id:string(body.operation_id,200),...(body.again?{again:true}:{})};
}
type Jobs={runs:{end(id:string,reason:'stopped'):Promise<void>};settled(id:string):Promise<void>};

/**
 * The owner's Keys list and "Stop everything now" (ADR-0307). The list shows each person's keys: the owner and every
 * member, on or paused, how many keys are open and when one was last used. Stop ends every open key at once and cancels
 * what is waiting on one: cards not yet approved or started, follow-ups not yet run, runs captured or under way, and jobs
 * not ended; schedule grants end too. A new agent login is then made by the dashboard (keys.agent_login).
 */
export class KeyRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool,readonly policy:Policy,readonly jobs:Jobs){this.commands=new OwnerCommands(control);}

  async list(principal:Reader):Promise<KeyList> {
    admin(principal);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const view=await memberView(db,ownerAccount(this.policy()),null,false);
      const counts=new Map((await db.query(`SELECT person,count(*) FILTER (WHERE closed_at IS NULL AND expires_at>now())::int AS open,max(last_used_at) AS last_use
        FROM one_time_keys GROUP BY person`)).rows.map(row=>[row.person as string,{open:row.open as number,last_use:row.last_use?(row.last_use as Date).toISOString():null}]));
      const stop=(await db.query('SELECT stopped_at,counts FROM key_stops WHERE singleton')).rows[0];
      await db.query('COMMIT');
      const keys=(person:string)=>counts.get(person)??{open:0,last_use:null};
      const people:KeyPerson[]=[{person:'owner',name:null,username:null,state:'on',...keys('owner')},
        ...view.members.map(member=>({person:member.id,name:member.name,username:member.username,state:member.state==='paused'?'paused' as const:'on' as const,...keys(member.id)}))];
      return {people,stopped:stop?{at:(stop.stopped_at as Date).toISOString(),...stop.counts}:null};
    } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
    finally{db.release();}
  }

  async stop(principal:Reader,request:KeyStopRequest):Promise<KeyStopResult> {
    const done=await this.commands.run(principal,request.operation_id,{kind:'keys_stop',again:request.again===true},async db=>{
      const count=async(sql:string,params:unknown[]=[])=>(await db.query(sql,params)).rowCount??0;
      // Every key, so every reply, run, review and filter under way reads nothing more and is never signed again. A reply or
      // follow-up whose key closed is withdrawn when it is next checked. Only keys still open count: an expired key is
      // closed too, as it may still be signed again for its attempt, but it ended already.
      const keys=Number((await db.query(`WITH closed AS (UPDATE one_time_keys SET closed_at=now(),closed_reason='stopped' WHERE closed_at IS NULL
        RETURNING expires_at>now() AS open) SELECT count(*) FILTER (WHERE open) AS open FROM closed`)).rows[0].open);
      // A follow-up not yet run, or waiting to run again after a failed attempt, is the answer after operations end: it is
      // not written. Taken before the tool cards, whose rejection below asks for follow-ups of its own.
      const followUps=(await db.query(`UPDATE action_continuations SET state='cancelled',error_code='owner_stopped',updated_at=now()
        WHERE state IN ('pending','waiting') OR state='failed' AND attempts<$1 RETURNING action_id`,[continuationMaxAttempts])).rows.map(row=>'continue:'+row.action_id);
      // Cards not yet approved, or approved and not started: a send, a tool or an outside call never runs.
      const sends=(await db.query(`UPDATE telegram_action_requests SET state='cancelled',error_code='owner_stopped',revision=revision+1,updated_at=now()
        WHERE state IN ('proposed','approved') RETURNING id`)).rows.map(row=>row.id as string);
      const tools=(await db.query(`UPDATE controlled_actions SET state='rejected',error_code='owner_stopped',revision=revision+1,updated_at=now()
        WHERE state IN ('proposed','approved') AND started_at IS NULL RETURNING id`)).rows.map(row=>row.id as string);
      // A rejected tool card asks for a follow-up to say so; after a stop nothing is said, and it is not counted.
      const asked=tools.length?(await db.query(`UPDATE action_continuations SET state='cancelled',error_code='owner_stopped',updated_at=now()
        WHERE action_id=ANY($1::text[]) AND state='pending' RETURNING action_id`,[tools])).rows.map(row=>'continue:'+row.action_id):[];
      for(const [family,ids] of [['actions',sends],['tools',tools],['telegram',[...followUps,...asked]]] as const)if(ids.length)
        await db.query(`UPDATE workflow_registry SET state='cancelled',next_attempt=NULL,waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now()
          WHERE family=$1 AND job_id=ANY($2::text[]) AND state IN ${waiting}`,[family,ids]);
      // Jobs not ended are stopped here, as a job's own Stop is (halt), so no tick relaunches one after its run is cancelled
      // below; each live run is ended after this commits.
      const jobs=(await db.query(`UPDATE background_jobs SET cancel_requested=true,state=CASE WHEN state='proposed' THEN 'stopped' ELSE state END,
        finished_at=CASE WHEN state='proposed' THEN now() ELSE finished_at END,
        machine_cleanup=CASE WHEN machine IS NOT NULL AND state IN ('running','reporting') THEN coalesce(machine_cleanup,'pending') ELSE machine_cleanup END,
        revision=revision+1,updated_at=now() WHERE state NOT IN ('done','failed','stopped','rejected') RETURNING id`)).rows.map(row=>row.id as string);
      // Runs captured or under way (scheduled, background, browser): cancelled, and their runtime turns closed.
      const runs=(await db.query(`UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,
        error_code=CASE WHEN state='captured' THEN 'owner_stopped' ELSE error_code END,revision=revision+1,updated_at=now()
        WHERE state IN ('captured','running') RETURNING event_id`)).rows.map(row=>row.event_id as string);
      if(runs.length)await db.query(`UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=ANY($1::text[]) AND state='open'`,[runs]);
      // A schedule change or fire granted to a turn and not yet used is not used.
      const grants=await count('UPDATE schedule_turn_grants SET expires_at=now() WHERE expires_at>now()')+
        await count('UPDATE schedule_grants SET expires_at=now() WHERE expires_at>now() AND used_at IS NULL');
      const counts={keys,cards:sends.length+tools.length,follow_ups:followUps.length,runs:runs.length,jobs:jobs.length,grants};
      // The close after the new login adds to the stop it finishes; any other stop replaces the last one.
      const prior=request.again?(await db.query('SELECT stopped_at,counts FROM key_stops WHERE singleton FOR UPDATE')).rows[0]:undefined;
      const kept=prior?Object.fromEntries(Object.entries(counts).map(([name,value])=>[name,value+Number(prior.counts[name]??0)])) as typeof counts:counts;
      const stopped=(await db.query(`INSERT INTO key_stops(singleton,stopped_at,counts) VALUES(true,coalesce($2,now()),$1)
        ON CONFLICT(singleton) DO UPDATE SET stopped_at=EXCLUDED.stopped_at,counts=EXCLUDED.counts RETURNING stopped_at`,[kept,prior?.stopped_at??null])).rows[0].stopped_at as Date;
      return {stopped_at:stopped.toISOString(),...counts,halt:jobs};
    },{epoch:false});
    const {halt,...result}=done as KeyStopResult&{halt:string[]};
    // Each stopped job's live run ends, and its card says so; one that fails to end does not keep the others running.
    for(const id of halt??[]) {
      try {
        const live=(await this.control.query(`SELECT b.event_id FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id
          WHERE b.job_id=$1 AND r.state IN ('captured','running')`,[id])).rows;
        for(const run of live)await this.jobs.runs.end(run.event_id as string,'stopped');
      } catch {/* the run's own check ends it: its job is stopped and its key closed */}
      void this.jobs.settled(id).catch(()=>{});
    }
    return result;
  }
}
