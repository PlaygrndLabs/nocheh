import type pg from 'pg';
import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {Brain,TurnReceipt} from '../brain/brain.js';
import type {RuntimeCall} from '../runtime.js';
import {actionContinued,fillTemplate,ownerPrompts} from '../prompts.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import type {ArchiveRepository} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardRepository} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import {closedTurnStates,currentTurn,dispatchPayload,terminalTurnStates,turnFence,turnResultCodes,type TurnInput} from './telegram-turn.js';
import {botReady,cancelReply,deliveredReceipt,finishPresence,replyOutcome,replyTarget,sendReply,showPresence,unansweredFinish,withdrawReply} from './telegram-reply.js';

/** One row per controlled action that ended in a live conversation; the DB trigger writes it in the same commit as the end state. */
export const actionContinuationSchema=`
CREATE TABLE IF NOT EXISTS action_continuations (
 action_id text PRIMARY KEY REFERENCES controlled_actions(id),event_id text NOT NULL,run_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','waiting','running','done','failed','ambiguous','suppressed','cancelled','skipped')),
 attempts integer NOT NULL DEFAULT 0,input_reference jsonb,result_reference jsonb,binding jsonb,error_code text,
 next_attempt timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_continuation_event ON action_continuations(event_id);
CREATE OR REPLACE FUNCTION nocheh_action_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity text;
BEGIN
 -- Same identity as requestWorkflow(db,'telegram','continue:'||id): sha256(JSON.stringify([family,job,1,1])).
 identity:=encode(sha256(convert_to('["telegram","continue:'||NEW.id||'",1,1]','UTF8')),'hex');
 INSERT INTO action_continuations(action_id,event_id) VALUES(NEW.id,NEW.event_id) ON CONFLICT DO NOTHING;
 INSERT INTO workflow_registry(id,family,job_id,version,generation) VALUES(identity,'telegram','continue:'||NEW.id,1,1) ON CONFLICT DO NOTHING;
 INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES(encode(sha256(convert_to(identity||':1','UTF8')),'hex'),identity,1) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS action_continuation_requested ON controlled_actions;
CREATE TRIGGER action_continuation_requested AFTER UPDATE OF state ON controlled_actions FOR EACH ROW
 WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('done','failed','ambiguous','rejected')
   AND NEW.job_id IS NULL AND NEW.source_reference->>'store'='archive')
 EXECUTE FUNCTION nocheh_action_continuation();
`;

const protocol='action-continuation-v1';
const maxAttempts=3,chainLimit=3,askingWaitMs=600000,receiptWaitMs=120000,siblingWaitMs=120000;
const closedRows=new Set(['done','ambiguous','suppressed','cancelled','skipped']);
const renewedCodes=['guard_context_changed','audience_context_changed','guard_transition_pending'];
const withdrawnCodes=[...renewedCodes,'conversation_not_selected','source_retired'];
/** Names the continuation in AsyncRuns, the gateway receipt and the archived result; never an integer, so it cannot meet a message turn's. */
export const continuationAttempt=(leader:string,attempts:number)=>'c'+attempts+'-'+leader.slice(0,40);
/** A leader counts once it started, or from its claim while it has yet to start. */
const leaders=`SELECT count(*)::int AS n FROM action_continuations WHERE event_id=$1 AND run_id=action_id AND (attempts>0 OR state IN ('pending','waiting'))`;
/** Whether an operation this asking message asks for now can still get a follow-up; past the cap no reply may promise one. */
export async function followUpLeft(db:Pick<pg.Pool,'query'>,event:string):Promise<boolean> {return (await db.query(leaders,[event])).rows[0].n<chainLimit;}
/** An operation whose lease expired without a receipt may still report done (recover); it waits for that before it is answered. */
const awaitingReceipt=(action:{state:string;error_code:string|null},ended:Date)=>
  action.state==='ambiguous'&&action.error_code==='executor_receipt_missing'&&Date.now()-ended.getTime()<receiptWaitMs;
/** The owner's own private request that the owner rejected needs no follow-up: they pressed Reject on its answer. */
export const ownerRejected=(action:{state:string;error_code:string|null},owner:boolean)=>owner&&action.state==='rejected'&&(action.error_code===null||action.error_code==='owner_cancelled');
/** The asking turn's own tool waited for it and read this very state, and that turn's reply went out (ADR-0215). */
export function answeredInTurn(action:{state:string;observed_in_turn:string|null},asking:string|undefined):boolean {
  return action.observed_in_turn===action.state&&asking==='done';
}
/** Only ids, tools and states reach the model; it reads each result itself through mcp__nocheh__action_status. */
export function continuationText(template:string,actions:{id:string;kind:string;state:string}[]):string {
  return fillTemplate(template,{actions:actions.map(a=>'- '+a.id+' ('+a.kind+'): '+a.state).join('\n')});
}

/**
 * After approved operations end, the agent continues the conversation that asked for them and answers there, as a
 * reply to the asking message (ADR-0212). Nocheh decides when the turn runs and checks it; the brain writes the answer and
 * Nocheh's bot sends it (ADR-0235).
 */
export class ActionContinuationRepository {
  constructor(readonly archive:ArchiveRepository,readonly access:SourceAccessRepository,readonly derived:DerivedRepository,
    readonly guards:GuardRepository,readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,
    readonly brain:Brain,readonly token:string,readonly call:RuntimeCall){}
  private get control(){return this.access.stores.control;}
  /** Native cancellation is best effort; the durable receipt remains authoritative. */
  async cancelRetired(ids:string[]):Promise<void> {
    if(!ids.length)return;
    const rows=(await this.control.query("SELECT action_id,event_id,attempts FROM action_continuations WHERE event_id=ANY($1::text[]) AND state='running' AND attempts>0",[ids])).rows;
    for(const row of rows) {
      const attempt=continuationAttempt(row.action_id,row.attempts);
      try{await this.brain.cancelTurn({channel:'telegram',event_id:row.event_id,attempt});}
      catch{/* The running workflow observes it again and cancels it under the revoked guard epoch. */}
      await cancelReply(this.call,row.event_id,attempt);
    }
  }
  private observation(row:any):Observation {
    const final=row.state==='failed'&&row.attempts>=maxAttempts;
    const states:Record<string,Observation['state']>={pending:'waiting',waiting:'waiting',running:'running',done:'completed',failed:final?'failed':'retryable_failed',
      ambiguous:'ambiguous',suppressed:'skipped',skipped:'skipped',cancelled:'cancelled'};
    return observation(states[row.state]!,row.attempts>0?'assistant':'admission',row.attempts,row.next_attempt.getTime(),row.state==='running'?'receipt_pending':
      row.state==='failed'&&!final?(row.error_code==='provider_not_configured'?'provider_not_configured':'runtime_unavailable'):['pending','waiting'].includes(row.state)?'prerequisite':null);
  }
  private async row(id:string){return (await this.control.query('SELECT * FROM action_continuations WHERE action_id=$1',[id])).rows[0];}
  private async close(id:string,state:string,code:string) {
    await this.control.query("UPDATE action_continuations SET state=$2,error_code=$3,updated_at=now() WHERE action_id=$1 AND state IN ('pending','waiting','failed')",[id,state,code]);
    return this.observation(await this.row(id));
  }
  private async wait(row:any,delay:number) {
    await this.control.query("UPDATE action_continuations SET state='waiting',updated_at=now() WHERE action_id=$1 AND state='pending'",[row.action_id]);
    return observation('waiting',row.attempts>0?'assistant':'admission',row.attempts,Date.now()+delay,'prerequisite');
  }
  private async storeResult(row:any,response:Record<string,unknown>) {
    const state=String(response.state);
    if(!closedTurnStates.has(state))throw new HttpError(409,'invalid_dispatch_receipt');
    const result={state,...(turnResultCodes.has(String(response.error_code))?{error_code:String(response.error_code)}:{})};
    // Why a follow-up did not go out, without message content: the code plus bounded Python identifiers.
    if(['failed','ambiguous'].includes(state)) {
      const bounded=(value:unknown)=>typeof value==='string'&&/^[A-Za-z_]{1,64}$/.test(value)?value:undefined;
      console.warn(JSON.stringify({event:'action_continuation_failed',state,attempt:row.attempts,code:result.error_code??(response.error_code===undefined?null:'unknown'),
        type:bounded(response.error_type),stage:bounded(response.error_stage)}));
    }
    const output=await this.derived.record({operation_id:`action-continuation-result:${row.action_id}:${row.attempts}`,
      source:(await this.archive.captured(row.event_id)).reference,parents:[row.input_reference],kind:'runtime_result',content:Buffer.from(canonical(result)),
      producer:this.brain.id,producer_version:protocol,configuration:{attempt:continuationAttempt(row.action_id,row.attempts)},provenance:{binding:row.binding}});
    return this.finish(row,result,output);
  }
  private async finish(row:any,result:{state:string;error_code?:string},reference:DerivativeReference) {
    await this.control.query(`UPDATE action_continuations SET state=$2,result_reference=$3,error_code=$4,
      next_attempt=CASE WHEN $2='failed' THEN now()+least(300,5*power(2,least(attempts,6)))*interval '1 second' ELSE next_attempt END,
      updated_at=now() WHERE action_id=$1`,[row.action_id,result.state,reference,result.error_code??null]);
    return this.observation(await this.row(row.action_id));
  }
  private async receive(row:any,result:Record<string,unknown>) {
    if(closedTurnStates.has(String(result.state)))return this.storeResult(row,result);
    await this.control.query(`UPDATE action_continuations SET state='running',error_code='awaiting_dispatch_receipt',
      next_attempt=now()+interval '1 second',updated_at=now() WHERE action_id=$1`,[row.action_id]);
    return this.observation(await this.row(row.action_id));
  }
  /** A pass for the turn under the current binding, after the turn's own binding and source are checked. */
  private async credential(input:TurnInput):Promise<string> {
    if(this.token.length<24)throw new HttpError(503,'service_credential_required');
    const credential=await this.prepared.audience.turn(this.token,input.principal,input.principal.turnEvent!,Date.now()+600000);
    await currentTurn(this,input);
    return credential;
  }
  /** As for a reply (TelegramDispatchRepository.settle): a done follow-up is sent by Nocheh's bot, and it alerts, as
   * nobody watched it being typed. */
  private async settle(row:any,input:TurnInput,receipt:TurnReceipt):Promise<Observation> {
    const attempt=continuationAttempt(row.action_id,row.attempts),state=String(receipt.state);
    let credential:string|null=null,withdrawn:string|null=null;
    try{credential=await this.credential(input);}catch(error){
      if(!(error instanceof HttpError)||!withdrawnCodes.includes(error.code))throw error;
      withdrawn=error.code;
    }
    if(state!=='done') {
      if(credential)await finishPresence(this.call,replyTarget(input,attempt,credential),unansweredFinish(state));
      return await this.storeResult(row,state==='ambiguous'?{...receipt,state:'failed',error_code:'assistant_runtime_unavailable'}:receipt);
    }
    if(!credential) {
      // An earlier check may have handed the reply to the bot, so the bot's receipt decides: a sent reply is never sent
      // again under a new attempt, nor recorded as withdrawn.
      const sent=await withdrawReply(this.call,row.event_id,attempt);
      if(!sent||sent.state==='running')return await this.receive(row,{state:'running'});
      if(replyOutcome(sent))return await this.storeResult(row,deliveredReceipt(receipt,sent));
      return await this.storeResult(row,renewedCodes.includes(withdrawn!)?{...receipt,state:'failed',error_code:'space_policy_changed'}:{state:'cancelled'});
    }
    const target=replyTarget(input,attempt,credential);
    if(!receipt.reply)throw new HttpError(502,'brain_invalid_response');
    const sent=await sendReply(this.call,target,String(input.body.source_key)+':continuation:'+row.action_id,receipt.reply,{notify:true,presence:true});
    if(!sent||!closedTurnStates.has(String(sent.state)))return await this.receive(row,{state:'running'});
    return await this.storeResult(row,deliveredReceipt(receipt,sent));
  }
  private async input(reference:DerivativeReference):Promise<TurnInput> {
    const row=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash||digest(row.content)!==row.content_hash)throw new HttpError(409,'dispatch_input_conflict');
    return JSON.parse(row.content.toString());
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    if(!/^[a-f0-9]{64}$/.test(id))return observation('failed','admission');
    const db=await this.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'telegram',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query("SELECT pg_try_advisory_lock(hashtextextended('continue:'||$1,803364)) AS held",[id])).rows[0].held;
      if(!locked)return observation('waiting','assistant',0,Date.now()+2000,'receipt_pending');
      let row=await this.row(id);
      if(!row)return observation('skipped','admission');
      if(closedRows.has(row.state)||row.state==='failed'&&row.attempts>=maxAttempts)return this.observation(row);
      const action=(await db.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
      const captured=await this.archive.captured(row.event_id),intake=(await db.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[row.event_id])).rows[0];
      // Only a live Telegram message has a chat to answer in; a browser run reads its operations itself.
      if(captured.origin!=='live'||captured.channel!=='telegram'||captured.kind!=='telegram_update'||intake?.transport!=='capture'||intake?.state!=='ready')
        return this.close(id,'skipped','not_telegram_turn');
      if(await this.access.retirements?.isRetired(captured.reference)&&row.state!=='running')return this.close(id,'cancelled','source_retired');
      if(row.state==='running'&&row.attempts) {
        const saved=await this.derived.checkpoint(`action-continuation-result:${id}:${row.attempts}`);
        if(saved) {
          const value=JSON.parse(saved.content.toString());if(digest(saved.content)!==saved.content_hash||!closedTurnStates.has(value.state))throw new HttpError(409,'dispatch_result_conflict');
          return await this.finish(row,value,{store:'derived',kind:'artifact',id:saved.id,input_hash:saved.content_hash});
        }
      }
      if(row.next_attempt>new Date())return this.observation(row);
      let input:TurnInput,credential:string|undefined;
      if(row.state==='running') {
        const attempt=continuationAttempt(id,row.attempts);let observed:TurnReceipt;
        input=await this.input(row.input_reference);
        try{observed=await this.brain.observeTurn({channel:'telegram',event_id:row.event_id,attempt});}
        catch{return await this.receive(row,{state:'running'});}
        if(closedTurnStates.has(String(observed.state)))return await this.settle(row,input,observed);
        try{credential=await this.credential(input);}catch(error){
          if(!(error instanceof HttpError)||!withdrawnCodes.includes(error.code))throw error;
          // As for a reply: a newer epoch rebuilds a turn that never started, and a running one's reply is not sent.
          const renewed=renewedCodes.includes(error.code);
          if(renewed&&observed.state==='not_found') {
            await this.control.query(`UPDATE action_continuations SET state='failed',error_code=$2,next_attempt=now()+interval '2 seconds',
              updated_at=now() WHERE action_id=$1 AND state='running'`,[id,error.code]);
            return this.observation(await this.row(id));
          }
          if(renewed)return await this.receive(row,observed);
          if(observed.state==='not_found')return await this.storeResult(row,{state:'cancelled'});
          try{return await this.receive(row,await this.brain.cancelTurn({channel:'telegram',event_id:row.event_id,attempt}));}
          catch{return await this.receive(row,{state:'running'});}
        }
        if(!['not_found','queued'].includes(String(observed.state))) {
          await showPresence(this.call,replyTarget(input,attempt,credential));
          return await this.receive(row,observed);
        }
        // Only explicit absence or a never-started native request launches the same attempt again.
      } else {
        if(!this.access.policy().enabled)return observation('waiting','admission',0,Date.now()+60000,'owner_paused');
        const original=(await this.archive.pool.query('SELECT source_key,payload,scope FROM events WHERE id=$1',[row.event_id])).rows[0];
        const payload=JSON.parse(original.payload.toString());let scope:ReturnType<typeof conversationScope>=null;
        try{scope=conversationScope(this.access.policy(),payload,original.scope);}catch(error){if(!(error instanceof HttpError)||error.code!=='source_scope_mismatch')throw error;}
        if(!scope)return this.close(id,'suppressed','conversation_not_selected');
        if(ownerRejected(action,scope.owner))return this.close(id,'skipped','owner_rejected');
        // The asking turn's own reply goes first, then an earlier follow-up not yet ended (claimed, running, or failed with
        // a retry left), then a receipt that may still arrive, then siblings still running or awaiting a late receipt, so
        // they are answered together. Each wait is bounded.
        const age=Date.now()-row.created_at.getTime(),asking=(await db.query('SELECT state FROM dispatches WHERE event_id=$1',[row.event_id])).rows[0];
        if((!asking||!terminalTurnStates.has(asking.state))&&age<askingWaitMs)return this.wait(row,5000);
        if(answeredInTurn(action,asking?.state))return this.close(id,'skipped','answered_in_turn');
        if(age<askingWaitMs&&(await db.query(`SELECT 1 FROM action_continuations WHERE event_id=$1 AND action_id<>$2 AND (state='running'
          OR run_id=action_id AND (state IN ('pending','waiting') OR state='failed' AND attempts<$3))`,[row.event_id,id,maxAttempts])).rowCount)return this.wait(row,5000);
        if(awaitingReceipt(action,row.created_at))return this.wait(row,10000);
        if(age<siblingWaitMs&&(await db.query(`SELECT 1 FROM controlled_actions a WHERE event_id=$1 AND id<>$2 AND job_id IS NULL
          AND (state IN ('approved','running')
            -- One a permission lets run stays proposed until it is claimed (ADR-0214).
            OR state='proposed' AND (EXISTS(SELECT 1 FROM security_events e WHERE e.effect_id=a.id AND e.state='allowed' AND e.permission_id IS NOT NULL)
              OR EXISTS(SELECT 1 FROM action_permissions p WHERE p.grain='chat' AND p.match_key=a.match_key AND p.kind=a.kind AND p.space_id=a.space_id
                AND p.revoked_at IS NULL AND p.expires_at>now() AND p.remaining>0))
            OR state='ambiguous' AND error_code='executor_receipt_missing'
          AND EXISTS(SELECT 1 FROM action_continuations c WHERE c.action_id=a.id AND c.created_at>now()-$3*interval '1 millisecond'))`,
          [row.event_id,id,receiptWaitMs])).rowCount)return this.wait(row,5000);
        // The asking reader, rebuilt as the reply's was, with inspect's rule that it reads only its own space and profile.
        const space=await this.access.space(captured.reference);
        if(!space||space!==action.space_id)return this.close(id,'suppressed','space_changed');
        const binding=await this.guards.state(),principal:Reader={admin:false,scope:scope.owner?null:scope.chat_id,space,turnEvent:row.event_id,
          generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
        await this.turns.binding(principal);
        if(this.turns.profile(principal,action.binding)!==action.profile)return this.close(id,'suppressed','profile_changed');
        await db.query('BEGIN');
        try {
          // One follow-up answers every operation of the asking message that ended by now, at most three per message.
          await db.query("SELECT pg_advisory_xact_lock(hashtextextended('continue-event:'||$1,803364))",[row.event_id]);
          const own=(await db.query('SELECT * FROM action_continuations WHERE action_id=$1 FOR UPDATE',[id])).rows[0];
          if(!['pending','waiting','failed'].includes(own.state)||own.run_id!==null&&own.run_id!==id){await db.query('COMMIT');return this.observation(own);}
          if(own.run_id===null) {
            if(!await followUpLeft(db,row.event_id)) {
              await db.query("UPDATE action_continuations SET state='skipped',error_code='chain_limit',updated_at=now() WHERE action_id=$1",[id]);
              await db.query('COMMIT');return this.observation(await this.row(id));
            }
            const candidates=(await db.query(`SELECT c.action_id,c.created_at AS ended,a.event_id,a.kind,a.state,a.error_code,a.observed_in_turn
              FROM action_continuations c JOIN controlled_actions a ON a.id=c.action_id
              WHERE c.event_id=$1 AND c.action_id<>$2 AND c.run_id IS NULL AND c.state IN ('pending','waiting')
              AND a.space_id=$3 AND a.profile=$4 ORDER BY c.created_at,c.action_id FOR UPDATE OF c`,[row.event_id,id,action.space_id,action.profile])).rows;
            const merged:string[]=[];
            // One that needs no follow-up of its own is left for its own job to skip, and one still awaiting a late receipt for its own wait.
            for(const candidate of candidates)if(!ownerRejected(candidate,scope.owner)&&!awaitingReceipt(candidate,candidate.ended)
              &&!answeredInTurn(candidate,asking?.state))merged.push(candidate.action_id);
            if(merged.length)await db.query(`UPDATE action_continuations SET run_id=$2,state='skipped',error_code='merged',updated_at=now() WHERE action_id=ANY($1::text[])`,[merged,id]);
            await db.query('UPDATE action_continuations SET run_id=action_id,updated_at=now() WHERE action_id=$1',[id]);
          }
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
        // States are read now, so a late receipt shows as done.
        const members=(await db.query(`SELECT c.action_id AS id,a.kind,a.state FROM action_continuations c JOIN controlled_actions a ON a.id=c.action_id
          WHERE c.run_id=$1 ORDER BY a.created_at,c.action_id`,[id])).rows;
        const text=continuationText((await ownerPrompts(this.control))['telegram.action_continued']??actionContinued,members),attempts=row.attempts+1;
        // The asking message's routing, so the answer is a reply to it in its topic; no fixed reply and no group admission.
        const body={channel:'telegram',event_id:row.event_id,source_key:original.source_key,scope:original.scope,payload:dispatchPayload(payload,null,text),
          text,transcripts:[],files:[],attempt:continuationAttempt(id,attempts),continuation:id,guard_mode:binding.mode};
        input={binding,principal,body};await this.prepared.allow(principal,{text});await currentTurn(this,input);
        const reference=await this.derived.record({operation_id:'action-continuation-input:'+digest(canonical(input)),source:captured.reference,
          kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,
          configuration:{binding},provenance:{purpose:'assistant',actions:members.map(member=>member.id)}});
        await db.query('BEGIN');
        try {
          await turnFence(db,binding);
          await db.query(`UPDATE action_continuations SET state='running',attempts=$2,input_reference=$3,result_reference=NULL,binding=$4,error_code=NULL,updated_at=now()
            WHERE action_id=$1 AND state IN ('pending','waiting','failed')`,[id,attempts,reference,binding]);
          await db.query('COMMIT');row=await this.row(id);
        }catch(error){await db.query('ROLLBACK');throw error;}
        if(row.state!=='running')return this.observation(row);
      }
      credential??=await this.credential(input);
      const attempt=continuationAttempt(id,row.attempts);
      if(!await botReady(this.call))return await this.receive(row,{state:'running'});
      await showPresence(this.call,replyTarget(input,attempt,credential));
      let result:TurnReceipt;
      try{result=await this.brain.startTurn({channel:'telegram',event_id:row.event_id,attempt},{...input.body,archive_credential:credential});}
      catch{result={state:'running'};}
      if(closedTurnStates.has(String(result.state)))return await this.settle(row,input,result);
      return await this.receive(row,result);
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query("SELECT pg_advisory_unlock(hashtextextended('continue:'||$1,803364))",[id]);if(held)await leaveFamily(db,'telegram');});}
  }
}
