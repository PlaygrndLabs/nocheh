import {memberReadId,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {ownerChat} from '../assistant-policy.js';
import {quotedName} from '../chat-labels.js';
import {appBindingOf,telegramTarget} from '../frontdoor/telegram.js';
import {HttpError} from '../http.js';
import type {Agent,TurnReceipt} from '../agent/agent.js';
import type {RuntimeCall} from '../runtime.js';
import {fillTemplate,memberReadFrame,memberReadLines,ownerPrompts} from '../prompts.js';
import {readSetIds} from '../spaces.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import type {ArchiveRepository} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardRepository} from './guards.js';
import type {OwnerMemberAsk,OwnerMemberAskRepository} from './owner-member-asks.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import {closedTurnStates,currentTurn,dispatchPayload,terminalTurnStates,turnFence,type TurnInput} from './telegram-turn.js';
import {botReady,cancelReply,finishPresence,replyTarget,sendReply,showPresence,unansweredFinish} from './telegram-reply.js';

const protocol='owner-member-ask-v1';
/** Two runs at most: a turn that fails before it answers runs once more, then the owner hears it was not answered. */
const maxAttempts=2;
/** The asking turn's own reply goes first: an ask waits for it this long, then is not answered. */
const askingWaitMs=600000;
/** Codes after which an ask is never answered: its record closed, its chat closed, or its asking message is gone. */
const closedCodes=new Set(['member_chat_closed','source_retired','conversation_not_selected']);
/** The answer turn's attempt: never an integer, so it never meets the owner's own turns of the same message. */
export const askAttempt=(id:string,attempts:number)=>'m'+attempts+'-'+id;
/**
 * The dispatch key the answer is sent under, and the row keeps: the asking message's own source key with a continuation
 * named by the ask, the one shape besides a turn's own key the bot sends a reply under (services/telegram/gateway.py). It
 * answers that very message, and its sends are never the asking turn's own.
 */
export const askSendKey=(sourceKey:string,id:string)=>sourceKey+':continuation:'+digest('member-ask:'+id);
/** The claims a turn pass carries, unchecked: only to make sure a pass signed for an ask names that very ask. */
/** Whether the owner's asking turn ended as an ask runs after: its reply went out, it chose silence, or Telegram did not
 * confirm its reply (the owner may have seen it). */
export function askingEnded(dispatch:{state:string;error_code?:string|null}):boolean {
  return dispatch.state==='done'||dispatch.state==='ambiguous'||dispatch.state==='suppressed'&&dispatch.error_code==='intentional_silence';
}
function passClaims(credential:string):Record<string,unknown> {
  try{return JSON.parse(Buffer.from(credential.split('.')[1]??'','base64url').toString());}catch{return {};}
}

/**
 * The worker that answers the owner's ask about a member (step 4b), modelled on the follow-up of an approved operation
 * (action-continuations.ts). After the owner's asking turn ended with its own reply, it runs one read-only turn under a
 * pass that names the ask (memberRead): storage binds it to that member's own private chat and nothing else, on every
 * request, while the row is running and inside its time. The answer goes to the owner's private chat as one separate
 * message of the send class member_read, whose first line names the member's chat as its source, and the turn's profile
 * is never carried into the owner's conversation (Hermes). When the chat closed or no answer came, the owner gets a
 * short fixed notice instead, once.
 */
export class OwnerMemberAskTurns {
  constructor(readonly asks:OwnerMemberAskRepository,readonly archive:ArchiveRepository,readonly access:SourceAccessRepository,
    readonly derived:DerivedRepository,readonly guards:GuardRepository,readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,
    readonly agent:Agent,readonly token:string,readonly call:RuntimeCall){}
  private get control(){return this.access.stores.control;}
  private observation(row:OwnerMemberAsk):Observation {
    const states:Record<string,Observation['state']>={queued:'waiting',running:'running',answered:'completed',failed:'failed',expired:'skipped'};
    return observation(states[row.state]!,row.attempts>0?'assistant':'admission',row.attempts,row.next_attempt.getTime(),
      row.state==='running'?'receipt_pending':row.state==='queued'?'prerequisite':null);
  }
  private async row(id:string):Promise<OwnerMemberAsk|null> {return this.asks.row(id);}
  /** The ask's observation now; one that is gone runs nothing more. */
  private async observed(id:string):Promise<Observation> {
    const row=await this.row(id);
    return row?this.observation(row):observation('skipped','admission');
  }
  /** The observation of an ask that just closed. An ask about a member removed meanwhile (its member_id cleared) is
   * removed now: it closed and the owner was told, and a removed member's asks are not kept. */
  private async closedNow(id:string):Promise<Observation> {
    const observed=await this.observed(id);
    await this.control.query(`DELETE FROM owner_member_asks WHERE id=$1 AND member_id IS NULL AND state NOT IN ('queued','running')`,[id]);
    return observed;
  }
  /** Closes an open ask for good with `code`, and tells the owner once when it will not be answered. */
  private async fail(row:OwnerMemberAsk,code:string,tell:'closed'|'failed'|null):Promise<Observation> {
    const {rowCount}=await this.control.query(`UPDATE owner_member_asks SET state='failed',error_code=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,[row.id,code]);
    if(rowCount&&tell)await this.notice(row,tell);
    return this.closedNow(row.id);
  }
  /** An ask past its time is never answered, and the owner hears it once. */
  private async expire(row:OwnerMemberAsk):Promise<Observation> {
    const {rowCount}=await this.control.query(`UPDATE owner_member_asks SET state='expired',updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,[row.id]);
    if(rowCount)await this.notice(row,'failed');
    return this.closedNow(row.id);
  }
  /** The ask's reader could not be bound (memberAskReads): an ask past its time expired, which is not the member's chat
   * closing, so the owner hears it was not answered; otherwise the chat closed and the owner hears that. */
  private async closed(row:OwnerMemberAsk,code:string):Promise<Observation> {
    if((await this.control.query('SELECT 1 FROM owner_member_asks WHERE id=$1 AND expires_at<=now()',[row.id])).rowCount)return this.expire(row);
    return this.fail(row,code,'closed');
  }
  private async notice(row:OwnerMemberAsk,kind:'closed'|'failed'):Promise<void> {
    const policy=this.access.policy(),owner=ownerChat(policy);
    if(!policy.enabled||!owner)return;
    const texts=memberReadLines((await ownerPrompts(this.control))['telegram.member_read_texts']);
    // The notice's id is the ask's, so the bot sends it at most once however often this runs.
    try{await this.call('telegram.notice',{id:digest('member-ask-closed:'+row.id),...telegramTarget(owner),text:fillTemplate(texts[kind],{member:await this.label(row)})},30000);}
    catch{/* A notice is best effort; the record says why. */}
  }
  /** The member as the answer names them: the name Telegram shows for them now, else the one they had when asked (a
   * member removed since), quoted. */
  private async label(row:OwnerMemberAsk):Promise<string> {
    const {people}=await this.asks.askable();
    return quotedName(people.find(person=>person.id===row.member_id)?.label??row.member_label??'a member');
  }
  /**
   * The ask's reader bound for this request: the owner's private chat as its scope and space, the ask as its memberRead,
   * the asked member's chat as its memberChat and no group to read. Anything else is member_chat_closed.
   */
  private async bound(principal:Reader):Promise<Reader> {
    const {reads:_reads,memberChat:_chat,...bare}=principal,bound=await this.access.bindReads(bare);
    if(bound.memberRead!==principal.memberRead||!bound.memberChat||!bound.reads||readSetIds(bound.reads).length)throw new HttpError(409,'member_chat_closed');
    return bound;
  }
  /** A pass for the turn under the current binding, after the ask is bound again and the turn's source is checked. The
   * pass must name this very ask; one that does not is never used (fail closed). */
  private async credential(input:TurnInput):Promise<string> {
    if(this.token.length<24)throw new HttpError(503,'service_credential_required');
    const bound=await this.bound(input.principal);
    if(bound.memberChat!==input.principal.memberChat)throw new HttpError(409,'member_chat_closed');
    const credential=await this.prepared.audience.turn(this.token,bound,input.principal.turnEvent!,Date.now()+600000);
    if(passClaims(credential).member_read!==input.principal.memberRead)throw new HttpError(409,'member_chat_closed');
    await currentTurn(this,input);
    return credential;
  }
  private async input(reference:DerivativeReference):Promise<TurnInput> {
    const row=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash||digest(row.content)!==row.content_hash)throw new HttpError(409,'dispatch_input_conflict');
    return JSON.parse(row.content.toString());
  }
  /** A turn that ended without an answer runs once more, or fails for good and the owner hears it. */
  private async retry(row:OwnerMemberAsk,code:string):Promise<Observation> {
    if(closedCodes.has(code))return this.closed(row,code);
    if(row.attempts>=maxAttempts)return this.fail(row,code,'failed');
    await this.control.query(`UPDATE owner_member_asks SET state='queued',error_code=NULL,next_attempt=now()+interval '5 seconds',updated_at=now()
      WHERE id=$1 AND state='running'`,[row.id]);
    return this.observed(row.id);
  }
  /** The agent closed the turn: a done answer goes out as one separate member_read message, under its source line. */
  private async settle(row:OwnerMemberAsk,input:TurnInput,receipt:TurnReceipt):Promise<Observation> {
    const attempt=askAttempt(row.id,row.attempts),state=String(receipt.state);
    let credential:string|null=null;
    try{credential=await this.credential(input);}catch(error){
      if(!(error instanceof HttpError)||![409,403].includes(error.status))throw error;
      // Never sent once the ask or its chat closed: the reply is withdrawn and the owner hears why.
      await cancelReply(this.call,row.owner_event,attempt);
      return this.closed(row,closedCodes.has(error.code)?error.code:'member_chat_closed');
    }
    if(state!=='done'||!receipt.reply?.text?.trim()) {
      await finishPresence(this.call,replyTarget(input,attempt,credential),unansweredFinish(state));
      return this.retry(row,state==='done'?'no_answer':String(receipt.error_code??'assistant_runtime_unavailable'));
    }
    const texts=memberReadLines((await ownerPrompts(this.control))['telegram.member_read_texts']);
    const text=fillTemplate(texts.source,{member:String((input.body.member_read as {member?:unknown})?.member??'')})+'\n\n'+receipt.reply.text;
    const target=replyTarget(input,attempt,credential),key=askSendKey(String(input.body.source_key),row.id);
    const sent=await sendReply(this.call,target,key,{...receipt.reply,text},{notify:true,presence:true,sendClass:'member_read',refused:true});
    if(!sent||!closedTurnStates.has(String(sent.state))) {
      await this.control.query(`UPDATE owner_member_asks SET next_attempt=now()+interval '1 second',updated_at=now() WHERE id=$1`,[row.id]);
      return observation('running','delivery',row.attempts,Date.now()+1000,'receipt_pending');
    }
    if(sent.state==='done') {
      await this.control.query(`UPDATE owner_member_asks SET state='answered',answered_at=now(),send_key=$2,updated_at=now() WHERE id=$1 AND state='running'`,
        [row.id,key]);
      return this.closedNow(row.id);
    }
    // An uncertain send is never repeated; a refused one is not answered, and a request the bot refuses as it is (nothing
    // sent) is not asked again every second until the ask expires.
    if(sent.error_code==='reply_refused')await finishPresence(this.call,target,'failed');
    return this.fail(row,sent.state==='ambiguous'?'delivery_unconfirmed':sent.error_code==='reply_refused'?'reply_refused':'telegram_rejected',sent.state==='ambiguous'?null:'failed');
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    if(!memberReadId.test(id))return observation('failed','admission');
    const db=await this.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'telegram',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query("SELECT pg_try_advisory_lock(hashtextextended('member-ask:'||$1,803364)) AS held",[id])).rows[0].held;
      if(!locked)return observation('waiting','assistant',0,Date.now()+2000,'receipt_pending');
      let row=await this.asks.row(id);
      if(!row)return observation('skipped','admission');
      if(!['queued','running'].includes(row.state))return this.observation(row);
      if(row.next_attempt>new Date())return this.observation(row);
      let input:TurnInput,credential:string|undefined;
      if(row.state==='running'&&row.attempts>0&&row.input_reference) {
        const attempt=askAttempt(id,row.attempts);let observed:TurnReceipt;
        input=await this.input(row.input_reference as DerivativeReference);
        try{observed=await this.agent.observeTurn({channel:'telegram',event_id:row.owner_event,attempt});}
        catch{return observation('running','assistant',row.attempts,Date.now()+1000,'receipt_pending');}
        if(closedTurnStates.has(String(observed.state)))return await this.settle(row,input,observed);
        try{credential=await this.credential(input);}catch(error){
          if(!(error instanceof HttpError)||![409,403].includes(error.status))throw error;
          // The ask or its chat closed while the turn ran: it is stopped and never answered.
          try{await this.agent.cancelTurn({channel:'telegram',event_id:row.owner_event,attempt});}catch{/* Its reply is withdrawn below. */}
          await cancelReply(this.call,row.owner_event,attempt);
          return this.closed(row,closedCodes.has(error.code)?error.code:'member_chat_closed');
        }
        if(!['not_found','queued'].includes(String(observed.state))) {
          await showPresence(this.call,replyTarget(input,attempt,credential));
          return observation('running','assistant',row.attempts,Date.now()+1000,'receipt_pending');
        }
        // Only explicit absence or a never-started native request launches the same attempt again.
      } else {
        if(!this.access.policy().enabled)return observation('waiting','admission',0,Date.now()+60000,'owner_paused');
        const age=Date.now()-row.created_at.getTime();
        if((await db.query('SELECT 1 FROM owner_member_asks WHERE id=$1 AND expires_at<=now()',[id])).rowCount)return this.expire(row);
        // The asking turn's own reply goes first. The owner did ask, so the ask also runs after that turn's intentional
        // silence or a reply Telegram did not confirm. A turn that never ends in time, or ends any other way but
        // withdrawn, leaves the owner told once that the ask was not answered; a withdrawn one (cancelled) asked nothing.
        const asking=(await db.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[row.owner_event])).rows[0];
        if(!asking||!terminalTurnStates.has(asking.state)) {
          if(age<askingWaitMs)return observation('waiting','admission',0,Date.now()+5000,'prerequisite');
          return this.fail(row,'asking_turn_not_done','failed');
        }
        if(!askingEnded(asking))return this.fail(row,'asking_turn_not_done',asking.state==='cancelled'?null:'failed');
        const captured=await this.archive.captured(row.owner_event);
        if(await this.access.retirements?.isRetired(captured.reference))return this.fail(row,'source_retired',null);
        const owner=ownerChat(this.access.policy());
        if(!owner)return this.fail(row,'conversation_not_selected',null);
        // Running from here: storage binds the ask's reader only while its row runs (memberAskReads).
        await db.query(`UPDATE owner_member_asks SET state='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1 AND state='queued'`,[id]);
        const started=await this.row(id);
        if(!started)return observation('skipped','admission');
        row=started;
        const binding=await this.guards.state();
        let principal:Reader;
        try {
          principal=await this.bound({admin:false,scope:owner,space:owner,turnEvent:row.owner_event,memberRead:id,
            generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch});
        }catch(error){if(error instanceof HttpError&&error.status===409)return this.closed(row,'member_chat_closed');throw error;}
        await this.turns.binding(principal);
        const original=(await this.archive.pool.query('SELECT source_key,payload,scope FROM events WHERE id=$1',[row.owner_event])).rows[0];
        const payload=JSON.parse(original.payload.toString()),label=await this.label(row),prompts=await ownerPrompts(this.control);
        const text=fillTemplate(prompts['telegram.member_read']??memberReadFrame,{member:label})+'\n\n'+row.question;
        const attempts=row.attempts+1,app=appBindingOf(owner);
        // The asking message's routing, so the answer is a reply to it; no fixed reply, and no speaker or group lines.
        const body={channel:'telegram',event_id:row.owner_event,source_key:original.source_key,scope:original.scope,chat:owner,space:owner,...(app?{app}:{}),
          payload:dispatchPayload(payload,null,text),text,transcripts:[],files:[],attempt:askAttempt(id,attempts),member_read:{ask:id,member:label},
          guard_mode:binding.mode};
        input={binding,principal,body};await this.prepared.allow(principal,{text,member_read:body.member_read});
        try{await currentTurn(this,input);}catch(error){
          if(error instanceof HttpError&&[403,409].includes(error.status)&&closedCodes.has(error.code))return this.fail(row,error.code,null);
          throw error;
        }
        const reference=await this.derived.record({operation_id:'owner-member-ask-input:'+digest(canonical(input)),source:captured.reference,
          kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,
          configuration:{binding},provenance:{purpose:'assistant',ask:id}});
        await db.query('BEGIN');
        try {
          await turnFence(db,binding);
          await db.query(`UPDATE owner_member_asks SET attempts=$2,input_reference=$3,binding=$4,error_code=NULL,updated_at=now() WHERE id=$1 AND state='running'`,
            [id,attempts,reference,binding]);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
        const recorded=await this.row(id);
        if(!recorded)return observation('skipped','admission');
        row=recorded;
        if(row.state!=='running')return this.observation(row);
      }
      try{credential??=await this.credential(input);}catch(error){
        if(!(error instanceof HttpError)||![409,403].includes(error.status))throw error;
        return this.closed(row,closedCodes.has(error.code)?error.code:'member_chat_closed');
      }
      const attempt=askAttempt(id,row.attempts);
      if(!await botReady(this.call))return observation('running','admission',row.attempts,Date.now()+10000,'receipt_pending');
      await showPresence(this.call,replyTarget(input,attempt,credential));
      let result:TurnReceipt;
      try{result=await this.agent.startTurn({channel:'telegram',event_id:row.owner_event,attempt},{...input.body,archive_credential:credential});}
      catch{result={state:'running'};}
      if(closedTurnStates.has(String(result.state)))return await this.settle(row,input,result);
      return observation('running','assistant',row.attempts,Date.now()+1000,'receipt_pending');
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query("SELECT pg_advisory_unlock(hashtextextended('member-ask:'||$1,803364))",[id]);if(held)await leaveFamily(db,'telegram');});}
  }
}
