import {albumMembers,albumSettleMs} from './albums.js';
import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import type {Brain,TurnReceipt} from '../brain/brain.js';
import {groupReplies as replySettings,groupTurn,identityCache,type GroupReplies} from '../telegram-addressing.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import type {ArchiveRepository,SourceReference} from './archive.js';
import type {SourceRepository} from './retrieval.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardBinding,GuardRepository} from './guards.js';
import type {PreparationRepository} from './preparation.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {ActionCommandRepository} from './action-commands.js';
import type {MemoryAccessRepository} from './memory-access.js';
import {hermesTimings,recordHermesAttempt} from './stage-timings.js';
import {fillTemplate,notAllowedPrivateReply,notAllowedReply,ownerPrompts,privateAnswerFrame,privateAnswerLines} from '../prompts.js';
import {parentSpace,readSetGroups} from '../spaces.js';
import {privateAnswerId,type PrivateAnswer,type PrivateAnswerOutcome,type PrivateAnswerRepository} from './private-answers.js';
import {closedTurnStates as closed,currentTurn,dispatchPayload,terminalTurnStates as terminal,turnFence,turnResultCodes as codes,type TurnInput as Input} from './telegram-turn.js';
import {botReady,cancelReply,deliveredReceipt,finishPresence,replyOutcome,replyTarget,sendReply,showPresence,unansweredFinish,withdrawReply,type ReplyButton} from './telegram-reply.js';

export const telegramDispatchSchema=`
CREATE TABLE IF NOT EXISTS dispatches (
 event_id text PRIMARY KEY,source_reference jsonb NOT NULL,input_reference jsonb,result_reference jsonb,binding jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','ambiguous','suppressed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1,
 runtime_stage text NOT NULL DEFAULT 'admission',error_code text,next_attempt timestamptz NOT NULL DEFAULT now(),
 reconciliation_checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS reconciliation_checked_at timestamptz;
`;
const protocol='telegram-dispatch-v2';
const conversationOrderWaitMs=120000;
/** Checks during a turn renew its presence; between them it lapses after 30 seconds. A done reply is sent this soon. */
const observeMs=1000;
/** Context changes after which a finished turn's reply is not sent: the binding or audience moved on, so it runs again. */
const renewedCodes=['guard_context_changed','audience_context_changed','guard_transition_pending'];
/** A private answer whose record closed (expired, refused or its groups changed) is withdrawn like a retired source (ADR-0249). */
const withdrawnCodes=[...renewedCodes,'conversation_not_selected','source_retired','private_answer_closed'];
/**
 * Who sent a group message and when, as one line for the model. Names come
 * from the guarded representation, the time from the captured original, and
 * no numeric Telegram ID is ever included. The owner's own message ends with
 * a separate `[the owner]` tag, from the captured sender ID. A name loses its
 * brackets, and the runtime shows a look-alike line in message text as text,
 * so no one else can write it (ADR-0222).
 */
export function speakerLine(original:any,representation:any,owner?:string|null):string|null {
  const sender=representation?.message?.from??{},date=original?.message?.date,from=original?.message?.from?.id;
  const part=(value:unknown)=>typeof value==='string'?value.replace(/[\[\]\p{Cc}]+/gu,' ').trim():'';
  const name=[part(sender.first_name),part(sender.last_name)].filter(Boolean).join(' ').slice(0,64).trim()||'Participant';
  const username=typeof sender.username==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(sender.username)?' (@'+sender.username+')':'';
  const sent=Number.isSafeInteger(date)&&date>0?', sent '+new Date(date*1000).toISOString().slice(0,16).replace('T',' ')+' UTC':'';
  const own=!!owner&&from!==undefined&&from!==null&&String(from)===owner?' [the owner]':'';
  return '[Group message from '+name+username+sent+']'+own;
}

/**
 * What in a captured group message can address the bot: a reply to one of its
 * messages or a tap on its name, and the @usernames the message names. The
 * routed message keeps neither, so the runtime receives these facts and
 * compares them, and the message's opening name, with the bot's own identity.
 */
export function groupAddressing(original:any,botId:string):{direct:boolean;handles:string[]}|null {
  const message=original?.message;
  if(!message||!['group','supergroup'].includes(message.chat?.type))return null;
  const reply=message.reply_to_message;
  // Every forum-topic message replies to the topic's opening service message.
  let direct=!!reply&&!reply.forum_topic_created&&String(reply.from?.id)===botId;
  const handles=new Set<string>();
  for(const [text,entities] of [[message.text,message.entities],[message.caption,message.caption_entities]]) {
    if(typeof text!=='string'||!Array.isArray(entities))continue;
    for(const entity of entities) {
      if(entity?.type==='text_mention'&&String(entity.user?.id)===botId)direct=true;
      if(!['mention','bot_command'].includes(entity?.type)||!Number.isSafeInteger(entity.offset)||!Number.isSafeInteger(entity.length))continue;
      // Entity offsets count UTF-16 units, as JavaScript strings do. `/start@name` addresses `name`.
      const span=text.slice(entity.offset,entity.offset+entity.length),at=span.indexOf('@');
      if(at>=0&&at<span.length-1)handles.add(span.slice(at+1).toLowerCase());
    }
  }
  return {direct,handles:[...handles].sort().slice(0,20)};
}

/** The record a `/start <id>` in the owner's private chat opens, from the captured original text, or null (ADR-0249).
 * Only that exact form opens one; a plain /start, or one with anything else, is an ordinary message. */
export function privateStart(original:any):string|null {
  const text=original?.message?.text;
  return typeof text==='string'?/^\/start ([a-f0-9]{32})$/.exec(text)?.[1]??null:null;
}

/** A group's or topic's name for a private answer's first line: no brackets or control characters, so it cannot end
 * that line or start another that looks like Nocheh's own, and never a numeric Telegram ID. */
const placeName=(value:unknown)=>typeof value==='string'?value.replace(/[\[\]\p{Cc}\p{Cf}]+/gu,' ').replace(/\s+/g,' ').trim().slice(0,64).trim():'';

/** The owner's command reply, which Nocheh's bot sends without a brain turn. */
function controlReply(input:Input):TurnReceipt|null {
  const text=input.body.control_reply;
  return typeof text==='string'&&text?{state:'done',reply:{text,session_id:'owner-control'}}:null;
}

export class TelegramDispatchRepository {
  constructor(readonly archive:ArchiveRepository,readonly access:SourceAccessRepository,readonly sources:SourceRepository,
    readonly derived:DerivedRepository,readonly guards:GuardRepository,readonly preparation:PreparationRepository,
    readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,readonly actions:ActionCommandRepository,
    readonly memoryAccess:MemoryAccessRepository,readonly call:RuntimeCall,readonly brain:Brain,readonly token:string,readonly detect:(text:string)=>Promise<unknown>,
    readonly groupReplies:GroupReplies=replySettings(process.env),readonly answers?:PrivateAnswerRepository){}
  private get control(){return this.access.stores.control;}
  /** The bot's own username and display name, which address it in groups. */
  private readonly identity=identityCache(()=>this.call('telegram.identity',{},5000));
  /** Native cancellation is best effort; the durable receipt remains authoritative. */
  async cancelRetired(ids:string[]):Promise<void> {
    if(!ids.length)return;
    const rows=(await this.control.query("SELECT event_id,attempts FROM dispatches WHERE event_id=ANY($1::text[]) AND state='running' AND attempts>0",[ids])).rows;
    for(const row of rows) {
      try{await this.brain.cancelTurn({channel:'telegram',event_id:row.event_id,attempt:row.attempts});}
      catch{/* The running workflow retries observation and cancellation under the revoked guard epoch. */}
      await cancelReply(this.call,row.event_id,row.attempts);
    }
  }
  private observation(row:any):Observation {
    const states:Record<string,Observation['state']>={pending:'waiting',running:'running',done:'completed',failed:'retryable_failed',ambiguous:'ambiguous',suppressed:'skipped',cancelled:'cancelled'};
    return observation(states[row.state]!,row.runtime_stage,row.attempts,row.next_attempt.getTime(),row.state==='running'?'receipt_pending':row.state==='failed'?
      // No model provider is chosen yet: the reply waits and retries after Settings › Models is applied.
      (row.error_code==='provider_not_configured'?'provider_not_configured':'runtime_unavailable'):row.state==='pending'?'prerequisite':null);
  }
  private async row(id:string) {return (await this.control.query('SELECT * FROM dispatches WHERE event_id=$1',[id])).rows[0];}
  private async storeResult(row:any,response:Record<string,unknown>) {
    const state=String(response.state);
    if(!closed.has(state))throw new HttpError(409,'invalid_dispatch_receipt');
    const result={state,...(codes.has(String(response.error_code))?{error_code:String(response.error_code)}:{})};
    // Why a reply did not go out, without message content: the code plus bounded Python identifiers.
    if(['failed','ambiguous'].includes(state)) {
      const bounded=(value:unknown)=>typeof value==='string'&&/^[A-Za-z_]{1,64}$/.test(value)?value:undefined;
      console.warn(JSON.stringify({event:'telegram_dispatch_failed',state,attempt:row.attempts,code:result.error_code??(response.error_code===undefined?null:'unknown'),
        type:bounded(response.error_type),stage:bounded(response.error_stage)}));
    }
    const output=await this.derived.record({operation_id:`telegram-dispatch-result:${row.event_id}:${row.attempts}`,
      source:row.source_reference,parents:[row.input_reference],kind:'runtime_result',content:Buffer.from(canonical(result)),
      producer:this.brain.id,producer_version:protocol,configuration:{attempt:row.attempts},provenance:{binding:row.binding}});
    // Timings are diagnostics outside the durable result; a malformed set is dropped whole.
    const timings=hermesTimings(response);if(timings)await recordHermesAttempt(this.control,row.event_id,row.attempts,timings);
    return this.finish(row,result,output);
  }
  private async finish(row:any,result:{state:string;error_code?:string},reference:DerivativeReference) {
    await this.control.query(`UPDATE dispatches SET state=$2,result_reference=$3,error_code=$4,runtime_stage=$5,
      next_attempt=CASE WHEN $2='failed' THEN now()+least(300,5*power(2,least(attempts,6)))*interval '1 second' ELSE next_attempt END,
      revision=revision+1,updated_at=now() WHERE event_id=$1`,[row.event_id,result.state,reference,result.error_code??null,result.state==='done'?'delivery':'assistant']);
    if(row.input_reference&&['done','cancelled','suppressed'].includes(result.state))try {const input=await this.input(row.input_reference);
      if(result.state!=='done')await this.unanswered(input);
      // A private answer that went out is recorded once, with the send of its /start; nothing else is suggested from it.
      else if(input.principal.answer!==undefined)await this.answers?.answered(input.principal.answer,String(input.body.source_key));
      else if(input.principal.scope!==null)await this.memoryAccess.suggest(input.principal,String(input.body.text??''));
    } catch {/* Suggestions and the answer's record are best effort and never affect the delivered reply; an unrecorded answer expires. */}
    return this.observation(await this.row(row.event_id));
  }
  /**
   * A turn that ended for good without its reply (ADR-0249). A private answer's claimed record closes, so a later tap
   * or /start says why rather than "already answered"; when the record itself closed (its hour passed, or its project or
   * groups changed), the private chat gets that short notice instead of the answer, once. A group reply that never went
   * out takes its untapped button's record with it.
   */
  private async unanswered(input:Input):Promise<void> {
    const principal=input.principal,event=principal.turnEvent,policy=this.access.policy();
    if(!this.answers||!event)return;
    if(principal.answer===undefined){if(principal.scope!==null)await this.answers.unshown(event);return;}
    // Whether the record still lets this answer read what it was given, checked before it is closed below.
    let open:boolean;
    try{const {reads:_given,...bare}=principal;open=canonical((await this.access.bindReads(bare)).reads??null)===canonical(principal.reads??null);}
    catch(error){if(!(error instanceof HttpError)||error.code!=='private_answer_closed')throw error;open=false;}
    const row=await this.answers.undelivered(principal.answer,event,open?'not_delivered':'changed');
    if(open||!row||!(row.state==='expired'||row.state==='refused'&&row.refusal_code==='changed')||!policy.enabled||!policy.owner_id)return;
    const texts=privateAnswerLines((await ownerPrompts(this.control))['telegram.private_answer_texts']);
    // The notice's id is the record's, so the bot sends it at most once however often this runs.
    await this.call('telegram.notice',{id:digest('private-answer-closed:'+row.id),chat_id:policy.owner_id,
      text:row.state==='expired'?texts.expired:texts.changed},30000);
  }
  private async receive(row:any,result:Record<string,unknown>,delay=observeMs) {
    if(closed.has(String(result.state)))return this.storeResult(row,result);
    await this.control.query(`UPDATE dispatches SET state='running',runtime_stage=$2,error_code='awaiting_dispatch_receipt',
      next_attempt=now()+$3*interval '1 millisecond',revision=revision+1,updated_at=now() WHERE event_id=$1`,
      [row.event_id,['admission','assistant','delivery'].includes(String(result.stage))?result.stage:row.runtime_stage,delay]);
    return this.observation(await this.row(row.event_id));
  }
  /** A pass for the turn under the current binding, after the turn's own binding and source are checked. */
  private async credential(input:Input):Promise<string> {
    if(this.token.length<24)throw new HttpError(503,'service_credential_required');
    const credential=await this.prepared.audience.turn(this.token,input.principal,input.principal.turnEvent!,Date.now()+600000);
    await currentTurn(this,input);
    return credential;
  }
  /**
   * The brain closed the turn. A done turn's reply goes out through Nocheh's bot (ADR-0235), after any earlier reply in
   * the same chat, and only while the turn's context still holds; otherwise the reply is withdrawn or runs again.
   * Every other end clears the working reaction, or marks it 👎 when the turn failed and will be retried.
   */
  private async settle(row:any,input:Input,receipt:TurnReceipt):Promise<Observation> {
    const attempt=row.attempts as number,state=String(receipt.state);
    let credential:string|null=null,withdrawn:string|null=null;
    try{credential=await this.credential(input);}catch(error){
      if(!(error instanceof HttpError)||!withdrawnCodes.includes(error.code))throw error;
      withdrawn=error.code;
    }
    if(state!=='done') {
      // Without a current pass the bot cannot be asked; an unrenewed presence lapses on its own.
      if(credential)await finishPresence(this.call,replyTarget(input,attempt,credential),unansweredFinish(state));
      // The brain never sends anything, so a turn it lost to a restart runs again under a new attempt.
      return await this.storeResult(row,state==='ambiguous'?{...receipt,state:'failed',error_code:'assistant_runtime_unavailable'}:receipt);
    }
    // The reply was written for a context that changed: it runs again under the new one, or not at all.
    if(!credential) {
      // An earlier check may have handed the reply to the bot, so the bot's receipt decides: a sent reply is never sent
      // again under a new attempt, nor recorded as withdrawn.
      const sent=await withdrawReply(this.call,row.event_id,attempt);
      if(!sent||sent.state==='running')return await this.receive(row,{state:'running',stage:'delivery'});
      if(replyOutcome(sent))return await this.storeResult(row,deliveredReceipt(receipt,sent));
      return await this.storeResult(row,renewedCodes.includes(withdrawn!)?{...receipt,state:'failed',error_code:'space_policy_changed'}:{state:'cancelled'});
    }
    const target=replyTarget(input,attempt,credential);
    if(!receipt.reply)throw new HttpError(502,'brain_invalid_response');
    if(await this.earlierReply(row,input,receipt))return await this.receive(row,{state:'running',stage:'delivery'});
    const button=await this.privateButton(input,receipt);
    const sent=await sendReply(this.call,target,String(input.body.source_key),receipt.reply,{notify:false,presence:input.body.control_reply==null,...(button?{button}:{})});
    if(!sent||!closed.has(String(sent.state)))return await this.receive(row,{state:'running',stage:'delivery'});
    return await this.storeResult(row,deliveredReceipt(receipt,sent));
  }
  /**
   * The Answer privately button under the owner's own answer in a group or topic whose project has another group Nocheh
   * serves (ADR-0249). Never under a fixed reply, an empty reply, a private answer or anyone else's question; a follow-up,
   * a job's report and a scheduled run are not message turns and never get one. Its record is offered once per question,
   * so a retried reply carries the same button; when it cannot be offered, the reply goes without it.
   */
  private async privateButton(input:Input,receipt:TurnReceipt):Promise<ReplyButton|null> {
    const policy=this.access.policy(),space=input.principal.space,event=input.principal.turnEvent;
    const sender=String((input.body.payload as {message?:{from?:{id?:unknown}}})?.message?.from?.id??'');
    // A reply that is only archive citations renders to nothing, and the bot sends no message to carry a button.
    const visible=receipt.reply?.text?.replace(/\s*【nocheh:event:[a-f0-9]{64}】/g,'').trim();
    if(!this.answers||input.body.control_reply!=null||input.principal.scope===null||input.principal.answer!==undefined||!space||!event||
      !policy.owner_id||sender!==policy.owner_id||!visible||this.token.length<24)return null;
    try {
      const place=await this.answers.offerable(space);if(!place)return null;
      const row=await this.answers.offer({id:privateAnswerId(this.token,event),question_event:event,from_chat_id:space,project_id:place.project_id,asker_account_id:sender});
      const label=privateAnswerLines((await ownerPrompts(this.control))['telegram.private_answer_texts']).button;
      return {text:Array.from(label).slice(0,40).join(''),data:'np'+row.id};
    }catch(error){if(error instanceof HttpError)return null;throw error;}
  }
  /**
   * The brain runs one chat's turns in order, but each is observed on its own, so a quick turn can finish just after a
   * slow one and be seen first. Its reply waits, at most two minutes after its turn ended, while an earlier turn in the
   * same chat is still running.
   */
  private async earlierReply(row:any,input:Input,receipt:TurnReceipt):Promise<boolean> {
    const ended=Number((receipt.window as {finished?:unknown}|undefined)?.finished);
    if(!Number.isSafeInteger(ended)||Date.now()-ended>conversationOrderWaitMs)return false;
    const running=(await this.control.query(`SELECT event_id FROM dispatches WHERE state='running' AND attempts>0 AND event_id<>$1
      AND updated_at>now()-interval '10 minutes' LIMIT 50`,[row.event_id])).rows.map(other=>other.event_id as string);
    if(!running.length)return false;
    // Telegram's update order, as turns start in it (heldByEarlier); local capture order can differ.
    const own=(await this.archive.pool.query(`SELECT scope,convert_from(payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events WHERE id=$1`,[row.event_id])).rows[0];
    if(!own||!/^\d{1,19}$/.test(String(own.update_id)))return false;
    return (await this.archive.pool.query(`SELECT 1 FROM (SELECT convert_from(payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events
      WHERE id=ANY($1::text[]) AND scope=$2) earlier WHERE update_id ~ '^[0-9]{1,19}$' AND update_id::numeric<$3::numeric LIMIT 1`,
      [running,own.scope,own.update_id])).rowCount!>0;
  }
  private async input(reference:DerivativeReference):Promise<Input> {
    const row=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash||digest(row.content)!==row.content_hash)throw new HttpError(409,'dispatch_input_conflict');
    return JSON.parse(row.content.toString());
  }
  /**
   * Conversation messages start in Telegram update order. Updates from one
   * poll can be captured in any order, so local capture order is not used.
   * Native execution serializes started turns in each chat; only an earlier update that has
   * not started can reorder replies, for example when its preparation finishes
   * later. The bound keeps a slow prerequisite such as transcription from
   * holding later messages.
   */
  private async heldByEarlier(source:SourceReference,space:string):Promise<boolean> {
    const current=(await this.control.query('SELECT created_at FROM dispatches WHERE event_id=$1',[source.id])).rows[0];
    if(!current||Date.now()-current.created_at.getTime()>conversationOrderWaitMs)return false;
    const own=(await this.archive.pool.query(`SELECT scope,convert_from(payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events WHERE id=$1`,[source.id])).rows[0];
    if(!own||!/^\d{1,19}$/.test(String(own.update_id)))return false;
    const earlier=(await this.archive.pool.query(`SELECT id FROM (SELECT id,convert_from(payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events
      WHERE scope=$1 AND id<>$2 AND channel='telegram' AND kind='telegram_update' AND origin='live' AND received_at>now()-interval '10 minutes') recent
      WHERE update_id ~ '^[0-9]{1,19}$' AND update_id::numeric<$3::numeric ORDER BY update_id::numeric DESC LIMIT 20`,
      [own.scope,source.id,own.update_id])).rows.map(row=>row.id as string);
    if(!earlier.length)return false;
    const started=new Set((await this.control.query(`SELECT event_id FROM dispatches WHERE event_id=ANY($1::text[])
      AND state NOT IN ('pending','failed')`,[earlier])).rows.map(row=>row.event_id as string));
    const live=new Set((await this.control.query(`SELECT event_id FROM source_intakes WHERE event_id=ANY($1::text[])
      AND transport='capture' AND state='ready'`,[earlier])).rows.map(row=>row.event_id as string));
    for(const id of earlier)
      if(live.has(id)&&!started.has(id)&&await this.access.space((await this.archive.captured(id)).reference)===space)return true;
    return false;
  }
  /**
   * Earlier voice notes in this conversation that are archived but still wait
   * for transcription. A later message may start before them (see above), so
   * its turn is told they exist rather than answering as if none arrived.
   */
  private async untranscribedEarlier(source:SourceReference,space:string):Promise<number> {
    const own=(await this.archive.pool.query(`SELECT scope,convert_from(payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events WHERE id=$1`,[source.id])).rows[0];
    if(!own||!/^\d{1,19}$/.test(String(own.update_id)))return 0;
    const earlier=(await this.archive.pool.query(`SELECT id FROM (SELECT e.id,convert_from(e.payload,'UTF8')::jsonb->>'update_id' AS update_id FROM events e
      WHERE e.scope=$1 AND e.id<>$2 AND e.channel='telegram' AND e.kind='telegram_update' AND e.origin='live' AND e.received_at>now()-interval '1 day'
      AND EXISTS(SELECT 1 FROM artifacts a WHERE a.event_id=e.id AND a.kind IN ('voice','audio','video_note'))) recent
      WHERE update_id ~ '^[0-9]{1,19}$' AND update_id::numeric<$3::numeric ORDER BY update_id::numeric DESC LIMIT 20`,
      [own.scope,source.id,own.update_id])).rows.map(row=>row.id as string);
    if(!earlier.length)return 0;
    const started=new Set((await this.control.query(`SELECT event_id FROM dispatches WHERE event_id=ANY($1::text[])
      AND state NOT IN ('pending','failed')`,[earlier])).rows.map(row=>row.event_id as string));
    const retired=await this.access.retirements?.retiredEvents(earlier);
    let count=0;
    for(const id of earlier) {
      if(started.has(id)||retired?.has(id))continue;
      const status=await this.preparation.status(id);
      if(['attachments','transcription'].includes(status.stage)&&status.state!=='failed'&&await this.access.space((await this.archive.captured(id)).reference)===space)count++;
    }
    return count;
  }
  /**
   * Group messages since this chat's last turn that did not address Nocheh. They
   * never reach Hermes on their own, so a reply would not know what was just said.
   * Each is the guarded copy this conversation may read, labeled with its speaker,
   * and cites its source so retiring it withholds the turn that carried it.
   */
  private async recentGroup(source:SourceReference,space:string,principal:Reader):Promise<{id:string;speaker:string;text:string}[]> {
    const own=(await this.archive.pool.query('SELECT scope,received_at FROM events WHERE id=$1',[source.id])).rows[0];
    if(!own)return [];
    const rows=(await this.archive.pool.query(`SELECT id,payload FROM events WHERE scope=$1 AND id<>$2 AND channel='telegram' AND kind='telegram_update' AND origin='live'
      AND received_at<=$3 AND received_at>$3::timestamptz-interval '12 hours' AND convert_from(payload,'UTF8')::jsonb ? 'message'
      ORDER BY received_at DESC,id DESC LIMIT 100`,[own.scope,source.id,own.received_at])).rows;
    if(!rows.length)return [];
    const states=new Map((await this.control.query('SELECT event_id,state,error_code FROM dispatches WHERE event_id=ANY($1::text[])',
      [rows.map(row=>row.id)])).rows.map(row=>[row.event_id as string,row]));
    const recent:{id:string;speaker:string;text:string}[]=[];
    for(const row of rows) {
      // Members who may not talk to Nocheh are still part of the conversation. Album parts went with
      // their album's turn; any other outcome is the last turn, already in Hermes' history.
      const state=states.get(row.id);
      if(!state||state.state==='suppressed'&&state.error_code==='album_member')continue;
      if(state.state!=='suppressed'||!['not_addressed','not_allowed','conversation_not_selected'].includes(state.error_code))break;
      try {
        if(await this.access.space((await this.archive.captured(row.id)).reference)!==space)continue;
        const guarded=await this.sources.read(principal,row.id),text=typeof guarded.event.text==='string'&&guarded.event.text?guarded.event.text.slice(0,1000):'[A message without text]';
        const speaker=speakerLine(JSON.parse(row.payload.toString()),guarded.event.payload,this.access.policy().owner_id);if(speaker)recent.push({id:row.id,speaker,text});
      } catch {continue;}
      if(recent.length===20)break;
    }
    return recent.reverse();
  }
  /**
   * Telegram sends an album as one message per photo or file. It is answered
   * once: its first part in update order runs one turn with every part's text
   * and files, and the other parts close without a reply of their own.
   */
  private async album(id:string):Promise<{state:'wait'}|{state:'member'}|{state:'leader';others:string[]}|null> {
    const members=await albumMembers(this.archive.pool,id);
    if(!members.length)return null;
    if(members.some(member=>member.age_ms<albumSettleMs))return {state:'wait'};
    if(members.length<2)return null;
    if(members[0]!.id!==id)return {state:'member'};
    return {state:'leader',others:members.slice(1).map(member=>member.id)};
  }
  /** Album parts that can join the turn: ready, not retired, and in the same conversation. */
  private async albumParts(source:SourceReference,space:string,others:string[]):Promise<string[]|null> {
    const retired=await this.access.retirements?.retiredEvents(others),parts:string[]=[];
    const created=(await this.control.query('SELECT created_at FROM dispatches WHERE event_id=$1',[source.id])).rows[0]?.created_at;
    const patient=!!created&&Date.now()-created.getTime()<conversationOrderWaitMs;
    for(const id of others) {
      if(retired?.has(id)||await this.access.space((await this.archive.captured(id)).reference)!==space)continue;
      const status=await this.preparation.status(id);
      if(status.state==='completed')parts.push(id);
      // A slow part holds the album's reply for a bounded time, then the reply goes without it.
      else if(patient&&status.state!=='failed')return null;
    }
    return parts;
  }
  /** Someone not allowed to use Nocheh in an allowed group gets the owner's fixed
   * reply, without a model, when they address it; anyone but the owner who writes
   * privately gets the owner's private fixed reply, at most once a day. Anyone
   * else stays quiet. */
  private async refuse(id:string,key:string,chat:string,payload:any) {
    const policy=this.access.policy(),message=payload?.message,sender=message?.from,personal=message?.chat?.type==='private';
    if(!policy.enabled||!message||!sender?.id||sender.is_bot===true||String(sender.id)===policy.owner_id)return;
    if(personal?String(sender.id)!==chat:!['group','supergroup'].includes(message.chat?.type)||!policy.group_ids.includes(chat))return;
    const texts=await ownerPrompts(this.control),common={event_id:id,chat_id:chat,message_id:String(message.message_id),user_id:String(sender.id)};
    if(personal) {
      try{await this.call('telegram.refusal',{...common,private:true,reply:texts['telegram.not_allowed_private']??notAllowedPrivateReply},15000);}
      catch{/* Best effort: the message stays archived either way. */}
      return;
    }
    // Only a message that addresses Nocheh gets the reply, whatever the group's reply setting.
    const botId=/^telegram:(\d+):update:/.exec(key)?.[1]??'',text=typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:null;
    try {
      if(!groupTurn(this.groupReplies,groupAddressing(payload,botId),text,await this.identity(),true))return;
      await this.call('telegram.refusal',{...common,
        ...(message.is_topic_message===true&&Number.isSafeInteger(message.message_thread_id)?{topic:String(message.message_thread_id)}:{}),
        reply:texts['telegram.not_allowed']??notAllowedReply},15000);
    } catch {/* Best effort: the message stays archived either way. */}
  }
  /**
   * What a turn's message and its album parts hold for the model: their text in order (an album's caption usually sits
   * on one part), voice transcripts, files with their extracted text, and the derivatives these came from. Without
   * `originals`, as in a private answer, a photo is never sent as an image: the turn gets text only (ADR-0249).
   */
  private async contents(album:[string,Awaited<ReturnType<SourceRepository['read']>>][],binding:GuardBinding,originals:boolean) {
    const transcripts:string[]=[],files:any[]=[],parents:DerivativeReference[]=[];let tooLarge=0;
    for(const [id,part] of album) {
      for(const result of part.derived) {
        const row=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[result.id])).rows[0];
        parents.push({store:'derived',kind:'artifact',id:result.id,input_hash:row.content_hash});
        if(result.kind==='transcript')transcripts.push(Buffer.from(result.content_base64,'base64').toString());
      }
      const manifests=(await this.archive.pool.query('SELECT id,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[id])).rows;
      const large=await this.preparation.attachments.tooLarge(id);tooLarge+=large.size;
      for(const file of part.artifacts) {
        if(large.has(file.id))continue;
        const hash=manifests.find(m=>m.id===file.id)?.file_hash;if(!hash)throw new HttpError(409,'source_file_pending');
        const extracted=part.derived.find(d=>d.artifact_id===file.id&&d.kind==='extracted_text');
        files.push({id:file.id,name:typeof file.metadata?.file_name==='string'?file.metadata.file_name:'Attachment',sha256:hash,
          kind:originals&&binding.mode==='off'&&file.kind==='photo'?'image':'file',text:extracted?Buffer.from(extracted.content_base64,'base64').toString():null});
      }
    }
    const text=album.map(([,part])=>part.event.text).filter((value):value is string=>typeof value==='string'&&value.length>0).join('\n\n')||null;
    return {transcripts,files,parents,tooLarge,text};
  }
  /** An archived Telegram message as a model may see it: the guarded copy while the secret guard is on, else the
   * captured original, as the archive's own reads give it (ADR-0222). Null when it has none yet. */
  private async representation(id:string,binding:GuardBinding):Promise<any> {
    let payload:any;
    if(binding.mode==='on')payload=((await this.guards.read('events:'+id,binding)).value as {payload?:unknown})?.payload;
    else payload=JSON.parse((await this.archive.pool.query('SELECT payload FROM events WHERE id=$1',[id])).rows[0].payload.toString());
    return payload?.message??payload?.edited_message??payload??null;
  }
  /** A group's name, from the guarded copy of its latest archived message that the answer may read, else a fixed name;
   * never its numeric ID or a name its secret check would hide. */
  private async groupName(chat:string,principal:Reader,binding:GuardBinding):Promise<string> {
    const rows=(await this.archive.pool.query(`SELECT id FROM events WHERE scope=$1 AND channel='telegram'
      AND kind IN ('telegram_update','telegram_delivered_message') ORDER BY received_at DESC,id DESC LIMIT 20`,[chat])).rows;
    for(const row of rows) {
      try {
        if(!await this.access.canRead(principal,(await this.archive.captured(row.id)).reference,binding))continue;
        const message=await this.representation(row.id,binding);
        if(String(message?.chat?.id)===chat&&placeName(message.chat.title))return '“'+placeName(message.chat.title)+'”';
      }catch(error){if(error instanceof HttpError)continue;throw error;}
    }
    return 'a Telegram group';
  }
  /** A private answer's first line: where the question was asked and every group it may read, the asking one first.
   * Group and topic names come from guarded copies, as in the speaker line. `group` is where it was asked, as that line
   * names it, which the answer's runtime profile keeps so the owner's notes can tell answers apart. */
  private async answerFrame(row:PrivateAnswer,principal:Reader,binding:GuardBinding):Promise<{frame:string;group:string}> {
    const home=parentSpace(row.from_chat_id)??row.from_chat_id;
    let topic:string|null=null;
    if(row.from_chat_id!==home) {
      let name='';
      try{name=placeName((await this.representation(row.question_event,binding))?.reply_to_message?.forum_topic_created?.name);}
      catch(error){if(!(error instanceof HttpError))throw error;}
      topic=name||'a topic';
    }
    const names=new Map<string,string>();
    for(const group of [home,...readSetGroups(principal.reads!).filter(group=>group!==home)])names.set(group,await this.groupName(group,principal,binding));
    const template=(await ownerPrompts(this.control))['telegram.private_answer']??privateAnswerFrame,group=(names.get(home)!+(topic?' › '+topic:'')).slice(0,300);
    return {frame:fillTemplate(template,{group,groups:[...names.values()].join(', ')}).slice(0,4000),group};
  }
  /**
   * A /start <id> in the owner's private chat (ADR-0249). The record is claimed for this very message: only by the asker,
   * only in the asker's own private chat, once, and only while its project still holds the asking group. The turn then
   * runs under the answer's pass, which reads the groups frozen at the tap: the question's own text, transcripts and
   * extracted file text (never an original file), the question's speaker line and the asking group's recent messages,
   * after a first line that says where it was asked and what it may read. A /start that cannot be answered returns the
   * owner's fixed reply for it instead, and no model runs.
   */
  private async answer(source:SourceReference,original:{source_key:string;scope:string},payload:any,space:string,id:string,attempt:number):
    Promise<string|{reference:DerivativeReference;input:Input}> {
    const texts=privateAnswerLines((await ownerPrompts(this.control))['telegram.private_answer_texts']);
    if(!this.answers)return texts.changed;
    let claimed:PrivateAnswerOutcome;
    try{claimed=await this.answers.claim(id,{account_id:String(payload?.message?.from?.id??''),start_event:source.id,reply_chat_id:String(original.scope)});}
    catch(error){if(error instanceof HttpError&&error.status===400)return texts.not_yours;throw error;}
    if(!claimed.ok)return texts[claimed.code];
    const row=claimed.answer,binding=await this.guards.state();
    // Claimed but not answerable after all: the record closes for this /start, so a later one is not told it was used.
    const close=async()=>(await this.answers!.undelivered(row.id,source.id,'changed'))?.state==='expired'?texts.expired:texts.changed;
    let principal:Reader;
    try {
      principal=await this.access.bindReads({admin:false,scope:String(original.scope),space,turnEvent:source.id,answer:row.id,
        generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch});
    }catch(error){if(error instanceof HttpError&&error.code==='private_answer_closed')return await close();throw error;}
    await this.turns.binding(principal);
    const selected=await this.sources.read(principal,source.id);
    // The question itself, read as the answer may read it: retired since, or outside its groups now, it is not answered.
    // A guard or binding change meanwhile (409) is not a refusal: the turn is built again.
    let question:typeof selected;
    try{question=await this.sources.read(principal,row.question_event);}
    catch(error){if(error instanceof HttpError&&[403,404].includes(error.status))return await close();throw error;}
    const asked=(await this.archive.captured(row.question_event)).reference,members=await albumMembers(this.archive.pool,row.question_event);
    const others=members.length>1&&members[0]!.id===row.question_event?members.slice(1).map(member=>member.id):[];
    const album:[string,typeof selected][]=[[row.question_event,question]];
    for(const part of others.length?await this.albumParts(asked,row.from_chat_id,others)??[]:[])album.push([part,await this.sources.read(principal,part)]);
    const {transcripts,files,parents,tooLarge,text}=await this.contents(album,binding,false);
    const questionPayload=JSON.parse((await this.archive.pool.query('SELECT payload FROM events WHERE id=$1',[row.question_event])).rows[0].payload.toString());
    const speaker=speakerLine(questionPayload,question.event.payload,this.access.policy().owner_id),recent=await this.recentGroup(asked,row.from_chat_id,principal);
    const privateAnswer={...await this.answerFrame(row,principal,binding),question_event:row.question_event};
    const body={channel:'telegram',event_id:source.id,source_key:original.source_key,scope:original.scope,
      payload:dispatchPayload(payload,selected.event.payload,text),text,transcripts,files,attempt,control_reply:null,guard_mode:binding.mode,
      private_answer:privateAnswer,...(tooLarge?{files_too_large:tooLarge}:{}),...(speaker?{speaker}:{}),...(recent.length?{recent_group:recent}:{})};
    const input={binding,principal,body};
    await this.prepared.allow(principal,{text,transcripts,files,speaker,recent_group:recent,private_answer:privateAnswer});await currentTurn(this,input);
    const reference=await this.derived.record({operation_id:'telegram-dispatch-input:'+digest(canonical(input)),source,
      ...(parents.length?{parents}:{}),kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,
      configuration:{binding},provenance:{purpose:'assistant',guard_revision:selected.guarded_revision}});
    return {reference,input};
  }
  private async build(source:SourceReference,attempt:number,others:string[]=[]):Promise<{reference:DerivativeReference;input:Input}|Observation|'not_addressed'> {
    const original=(await this.archive.pool.query('SELECT source_key,payload,scope FROM events WHERE id=$1',[source.id])).rows[0];
    const payload=JSON.parse(original.payload.toString()),scope=conversationScope(this.access.policy(),payload,original.scope);
    if(!scope) {
      await this.refuse(source.id,original.source_key,original.scope,payload);
      // Someone's own message that Nocheh may not answer them, as opposed to an
      // edit, a reaction, a bot, or the owner writing in a chat they didn't select.
      const sender=payload?.message?.from,refused=!!sender?.id&&sender.is_bot!==true&&String(sender.id)!==this.access.policy().owner_id;
      return observation('skipped','admission',0,Date.now(),refused?'not_allowed':null);
    }
    const space=await this.access.space(source);if(!space)return observation('waiting','admission',0,Date.now()+30000,'prerequisite');
    const ready=await this.preparation.status(source.id);if(ready.state!=='completed')return ['retryable_failed','failed'].includes(ready.state)?ready:
      observation('waiting',ready.stage,0,ready.next_attempt,ready.waiting_reason);
    if(await this.heldByEarlier(source,space))return observation('waiting','admission',0,Date.now()+2000,'prerequisite');
    const parts=others.length?await this.albumParts(source,space,others):[];
    if(!parts)return observation('waiting','admission',0,Date.now()+1000,'prerequisite');
    // A /start <id> in the owner's private chat opens a private answer: its whole turn is built under that answer's own
    // pass, never as the owner (ADR-0249). One that cannot be answered gets a fixed reply in the owner's own turn.
    const start=scope.owner?privateStart(payload):null;let refusal:string|null=null;
    if(start) {
      const answer=await this.answer(source,original,payload,space,start,attempt);
      if(typeof answer!=='string')return answer;
      refusal=answer;
    }
    const binding=await this.guards.state(),principal:Reader={admin:false,scope:scope.owner?null:scope.chat_id,space,turnEvent:source.id,
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    await this.turns.binding(principal);
    const selected=await this.sources.read(principal,source.id);
    const album:[string,typeof selected][]=[[source.id,selected]];
    for(const id of parts)album.push([id,await this.sources.read(principal,id)]);
    const {transcripts,files,parents,tooLarge,text}=await this.contents(album,binding,true);
    const botId=/^telegram:(\d+):update:/.exec(original.source_key)?.[1]??'';
    let addressing=groupAddressing(payload,botId);
    for(const id of parts) {
      // Any part of an album that addresses the bot addresses the album.
      const other=groupAddressing(JSON.parse((await this.archive.pool.query('SELECT payload FROM events WHERE id=$1',[id])).rows[0].payload.toString()),botId);
      if(addressing&&other)addressing={direct:addressing.direct||other.direct,handles:[...new Set([...addressing.handles,...other.handles])].sort().slice(0,20)};
    }
    // A group message nobody addressed to the bot stays archived without a turn; the next turn sees it as recent.
    if(!scope.owner) {
      const identity=await this.identity().catch(()=>null);
      // Until the bot knows its own name and @username, a mention of either cannot be recognized; skipping the message
      // for good on that guess would lose it, so the decision waits for the bot.
      if(!groupTurn(this.groupReplies,addressing,text,identity))return identity?'not_addressed':observation('waiting','admission',0,Date.now()+10000,'prerequisite');
    }
    // Command authority comes from the original owner DM, never a guarded edit.
    const reply=refusal??await this.actions.controlReply(source),control=reply===null?null:await this.prepared.prepare(principal,reply,this.detect);
    const untranscribed=await this.untranscribedEarlier(source,space);
    const speaker=scope.owner?null:speakerLine(payload,selected.event.payload,this.access.policy().owner_id),recent=scope.owner?[]:await this.recentGroup(source,space,principal);
    const body={channel:'telegram',event_id:source.id,source_key:original.source_key,scope:original.scope,
      payload:dispatchPayload(payload,selected.event.payload,text),text,transcripts,files,attempt,control_reply:control,guard_mode:binding.mode,
      ...(untranscribed?{untranscribed_voice:untranscribed}:{}),...(tooLarge?{files_too_large:tooLarge}:{}),...(addressing?{group_addressing:addressing}:{}),...(speaker?{speaker}:{}),...(recent.length?{recent_group:recent}:{}),...(parts.length?{album_events:parts}:{})};
    const input={binding,principal,body};await this.prepared.allow(principal,{text,transcripts,files,control_reply:control,speaker,recent_group:recent});await currentTurn(this,input);
    const reference=await this.derived.record({operation_id:'telegram-dispatch-input:'+digest(canonical(input)),source,
      ...(parents.length?{parents}:{}),kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,
      configuration:{binding},provenance:{purpose:'assistant',guard_revision:selected.guarded_revision}});
    return {reference,input};
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    if(!/^[a-f0-9]{64}$/.test(id))return observation('failed','admission');
    const db=await this.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'telegram',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803364)) AS held',[id])).rows[0].held;
      if(!locked)return observation('waiting','assistant',0,Date.now()+2000,'receipt_pending');
      const captured=await this.archive.captured(id),intake=(await db.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[id])).rows[0];
      if(captured.origin!=='live'||captured.channel!=='telegram'||captured.kind!=='telegram_update'||intake?.transport!=='capture'||intake?.state!=='ready')
        return observation('skipped','admission');
      await db.query('INSERT INTO dispatches(event_id,source_reference) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,captured.reference]);
      let row=await this.row(id);if(terminal.has(row.state))return this.observation(row);
      if(await this.access.retirements?.isRetired(captured.reference)&&row.state!=='running') {
        await db.query("UPDATE dispatches SET state='cancelled',error_code='source_retired',revision=revision+1,updated_at=now() WHERE event_id=$1 AND state IN ('pending','failed')",[id]);
        return this.observation(await this.row(id));
      }
      if(row.state==='running'&&row.attempts) {
        const saved=await this.derived.checkpoint(`telegram-dispatch-result:${id}:${row.attempts}`);
        if(saved) {
          const value=JSON.parse(saved.content.toString());if(digest(saved.content)!==saved.content_hash||!closed.has(value.state))throw new HttpError(409,'dispatch_result_conflict');
          return await this.finish(row,value,{store:'derived',kind:'artifact',id:saved.id,input_hash:saved.content_hash});
        }
      }
      if(row.next_attempt>new Date())return this.observation(row);
      let input:Input,credential:string|undefined;
      if(row.state==='running') {
        input=await this.input(row.input_reference);
        // A fixed owner reply needs no brain: it is the turn's answer as it stands.
        const fixed=controlReply(input);if(fixed)return await this.settle(row,input,fixed);
        let observed:TurnReceipt;
        try{observed=await this.brain.observeTurn({channel:'telegram',event_id:id,attempt:row.attempts});}
        catch{return await this.receive(row,{state:'running'});}
        if(closed.has(String(observed.state)))return await this.settle(row,input,observed);
        try{credential=await this.credential(input);}catch(error){
          if(!(error instanceof HttpError)||!withdrawnCodes.includes(error.code))throw error;
          // Only a retirement or a deselected chat withdraws the reply. A newer epoch alone means
          // it is rebuilt under that epoch: a turn that never started runs again, and a running
          // turn's reply is not sent when it ends, so it runs again (see settle).
          const renewed=renewedCodes.includes(error.code);
          if(renewed&&observed.state==='not_found') {
            await this.control.query(`UPDATE dispatches SET state='failed',error_code=$2,next_attempt=now()+interval '2 seconds',
              revision=revision+1,updated_at=now() WHERE event_id=$1 AND state='running'`,[id,error.code]);
            return this.observation(await this.row(id));
          }
          if(renewed)return await this.receive(row,observed);
          if(observed.state==='not_found')return await this.storeResult(row,{state:'cancelled'});
          try{return await this.receive(row,await this.brain.cancelTurn({channel:'telegram',event_id:id,attempt:row.attempts}));}
          catch{return await this.receive(row,{state:'running'});}
        }
        if(!['not_found','queued'].includes(String(observed.state))) {
          await showPresence(this.call,replyTarget(input,row.attempts,credential));
          return await this.receive(row,observed);
        }
        // Only explicit absence or a never-started native request may launch the
        // same identity, after current binding checks. Running work is observed.
      } else {
        if(!this.access.policy().enabled)return observation('waiting','admission',0,Date.now()+60000,'owner_paused');
        // An Approve or Reject press decides its action here; it is never a turn.
        if(await this.actions.callback(captured.reference)) {
          await db.query(`UPDATE dispatches SET state='suppressed',error_code='approval_button',revision=revision+1,updated_at=now()
            WHERE event_id=$1 AND state IN ('pending','failed')`,[id]);
          return this.observation(await this.row(id));
        }
        const album=await this.album(id);
        if(album?.state==='wait')return observation('waiting','admission',0,Date.now()+1000,'prerequisite');
        if(album?.state==='member') {
          await db.query(`UPDATE dispatches SET state='suppressed',error_code='album_member',revision=revision+1,updated_at=now()
            WHERE event_id=$1 AND state IN ('pending','failed')`,[id]);
          return this.observation(await this.row(id));
        }
        const attempt=row.attempts+1,built=await this.build(captured.reference,attempt,album?.state==='leader'?album.others:[]);
        if(built==='not_addressed'||'state' in built) {
          if(built==='not_addressed') {
            await db.query(`UPDATE dispatches SET state='suppressed',error_code='not_addressed',revision=revision+1,updated_at=now()
              WHERE event_id=$1 AND state IN ('pending','failed')`,[id]);
            return this.observation(await this.row(id));
          }
          if(built.state==='skipped')await db.query("UPDATE dispatches SET state='suppressed',error_code=$2,updated_at=now() WHERE event_id=$1",
            [id,built.waiting_reason==='not_allowed'?'not_allowed':'conversation_not_selected']);
          // Speech without usable text is a terminal preparation outcome. The
          // original stays archived; no reply is sent as if it were transcribed.
          if(built.state==='failed'&&built.stage==='transcription') {
            await db.query(`UPDATE dispatches SET state='suppressed',error_code='invalid_transcription_response',revision=revision+1,updated_at=now()
              WHERE event_id=$1 AND state IN ('pending','failed')`,[id]);
            return this.observation(await this.row(id));
          }
          return built;
        }
        input=built.input;
        await db.query('BEGIN');
        try {
          await turnFence(db,input.binding);
          await db.query(`UPDATE dispatches SET state='running',attempts=$4,input_reference=$2,result_reference=NULL,binding=$3,error_code=NULL,
            revision=revision+1,updated_at=now() WHERE event_id=$1 AND state IN ('pending','failed')`,[id,built.reference,input.binding,attempt]);
          await db.query('COMMIT');row=await this.row(id);
        }catch(error){await db.query('ROLLBACK');throw error;}
      }
      const fixed=controlReply(input);if(fixed)return await this.settle(row,input,fixed);
      credential??=await this.credential(input);
      // The same ref starts once the bot can send its reply; until then it waits, as it did while Hermes held the bot.
      if(!await botReady(this.call))return await this.receive(row,{state:'running'},10000);
      // Typing and 👀 show while the brain works; Nocheh renews them at each check.
      await showPresence(this.call,replyTarget(input,row.attempts,credential));
      let result:TurnReceipt;
      try{result=await this.brain.startTurn({channel:'telegram',event_id:id,attempt:row.attempts},{...input.body,archive_credential:credential});}
      catch{result={state:'running'};}
      if(closed.has(String(result.state)))return await this.settle(row,input,result);
      return await this.receive(row,result);
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803364))',[id]);if(held)await leaveFamily(db,'telegram');});}
  }
}
