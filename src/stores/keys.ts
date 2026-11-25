import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object,string} from '../http.js';
import type {KeyList,KeyPerson,KeyStopRequest,KeyStopResult} from '../key-wire.js';
import {memberView,ownerAccount} from './members.js';
import {OwnerCommands} from './owner-commands.js';
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
  const body=object(input);if(Object.keys(body).some(key=>key!=='operation_id'))throw new HttpError(400,'unknown_operation_field');
  return {operation_id:string(body.operation_id,200)};
}

/**
 * The owner's Keys list and "Stop everything now" (ADR-0307). The list shows each person's keys: the owner and every
 * member, on or paused, how many keys are open and when one was last used. Stop ends every open key at once and cancels
 * what is waiting on one: cards not yet approved or started, follow-ups not yet run, runs captured or under way, and jobs
 * not ended; schedule grants end too. A new agent login is then made by the dashboard (keys.agent_login).
 */
export class KeyRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool,readonly policy:Policy,readonly jobs:{halt(id:string):Promise<unknown>}){this.commands=new OwnerCommands(control);}

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
    const done=await this.commands.run(principal,request.operation_id,{kind:'keys_stop'},async db=>{
      const count=async(sql:string,params:unknown[]=[])=>(await db.query(sql,params)).rowCount??0;
      // Every key, so every reply, run, review and filter under way reads nothing more and is never signed again.
      const keys=await count(`UPDATE one_time_keys SET closed_at=now(),closed_reason='stopped' WHERE closed_at IS NULL`);
      // Cards not yet approved, or approved and not started: a send, a tool or an outside call never runs.
      const sends=(await db.query(`UPDATE telegram_action_requests SET state='cancelled',error_code='owner_stopped',revision=revision+1,updated_at=now()
        WHERE state IN ('proposed','approved') RETURNING id`)).rows.map(row=>row.id as string);
      const tools=(await db.query(`UPDATE controlled_actions SET state='rejected',error_code='owner_stopped',revision=revision+1,updated_at=now()
        WHERE state IN ('proposed','approved') AND started_at IS NULL RETURNING id`)).rows.map(row=>row.id as string);
      // A follow-up not yet run is the answer after operations end: it is not written.
      const followUps=(await db.query(`UPDATE action_continuations SET state='cancelled',error_code='owner_stopped',updated_at=now()
        WHERE state IN ('pending','waiting') RETURNING action_id`)).rows.map(row=>'continue:'+row.action_id);
      for(const [family,ids] of [['actions',sends],['tools',tools],['telegram',followUps]] as const)if(ids.length)
        await db.query(`UPDATE workflow_registry SET state='cancelled',next_attempt=NULL,waiting_reason=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now()
          WHERE family=$1 AND job_id=ANY($2::text[]) AND state IN ${waiting}`,[family,ids]);
      // Runs captured or under way (scheduled, background, browser): cancelled, and their runtime turns closed.
      const runs=(await db.query(`UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,
        error_code=CASE WHEN state='captured' THEN 'owner_stopped' ELSE error_code END,revision=revision+1,updated_at=now()
        WHERE state IN ('captured','running') RETURNING event_id`)).rows.map(row=>row.event_id as string);
      if(runs.length)await db.query(`UPDATE runtime_turns SET state='closed',closed_at=now() WHERE id=ANY($1::text[]) AND state='open'`,[runs]);
      // A schedule change or fire granted to a turn and not yet used is not used.
      const grants=await count('UPDATE schedule_turn_grants SET expires_at=now() WHERE expires_at>now()')+
        await count('UPDATE schedule_grants SET expires_at=now() WHERE expires_at>now() AND used_at IS NULL');
      // Jobs not ended are stopped after this commits, each as its Stop would (halt), which also ends its live run.
      const jobs=(await db.query(`SELECT id FROM background_jobs WHERE state NOT IN ('done','failed','stopped','rejected') ORDER BY id`)).rows.map(row=>row.id as string);
      const counts={keys,cards:sends.length+tools.length,follow_ups:followUps.length,runs:runs.length,jobs:jobs.length,grants};
      const stopped=(await db.query(`INSERT INTO key_stops(singleton,stopped_at,counts) VALUES(true,now(),$1)
        ON CONFLICT(singleton) DO UPDATE SET stopped_at=EXCLUDED.stopped_at,counts=EXCLUDED.counts RETURNING stopped_at`,[counts])).rows[0].stopped_at as Date;
      return {stopped_at:stopped.toISOString(),...counts,halt:jobs};
    },{epoch:false});
    const {halt,...result}=done as KeyStopResult&{halt:string[]};
    for(const id of halt??[])await this.jobs.halt(id).catch(error=>{if(!(error instanceof HttpError)||error.status!==409)throw error;});
    return result;
  }
}
