import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {approvalAction,approvalCard,approvalLines,approvalTask,fillTemplate,labeledLines,ownerPrompts,problemButtons,type ApprovalText} from '../prompts.js';
import {controls,cut,entityLimit,exactJson,fields,heading,linked,operationCard,operationText,type Link,type OperationText} from '../action-text.js';
import {retryFailedWorkflows} from './workflow-owner.js';
import {followUpLeft} from './action-continuations.js';
import {evaluate} from '../security/store.js';
import type {Effect} from '../security/contract.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {ControlledActionRepository} from './controlled-actions.js';
import {closedStates,type BackgroundJobRepository} from './background-jobs.js';
import type {TaskRepository} from './tasks.js';

type ActionKind='telegram'|'controlled'|'background'|'list'|'task';
/** One card of a job's waiting changes, as frozen when it was sent. */
type ListCard={id:string;fingerprint:string;members:[string,string][];long?:number};
// Telegram allows 64 bytes of button data: a marker, the choice (approve, deny, stop a job, or approve and
// allow here for a session or always, ADR-0214), and prefixes of the action ID and of the fingerprint of its exact content.
const buttonData=/^n([adscw])([a-f0-9]{40})([a-f0-9]{16})$/;
/** An operation's buttons: a web read can be allowed here for a session or always, an exact command always;
 * the rest, and a job's operations, are approved one by one. */
const ruleButtons:Record<string,[ApprovalText,string][]>={
  browser:[['allow_once','a'],['allow_here','c'],['allow_always','w'],['reject','d']],
  shell:[['allow_once','a'],['allow_command','w'],['reject','d']]};
/** The rule buttons an operation's card may offer: none for a job's operation, a follow-up's, or one without a rule key (ADR-0214). */
const ruleChoices=(row:{job_id:string|null;match_key:string|null;kind:string})=>!row.job_id&&row.match_key?ruleButtons[row.kind]??null:null;
/** The Retry failed button under a problem notice in the owner's private chat. */
export const retryButton='nr';
const reviewLimit=2200;
// Telegram's message limit in UTF-16 units, less room for the outcome a decided card adds.
const cardLimit=4096,outcomeRoom=300;
const clean=(value:unknown,length=100)=>typeof value==='string'&&value.replace(controls,'').trim()?value.replace(controls,'').replace(/\s+/g,' ').trim().slice(0,length):null;
type Mark=(label:string,url:string|null)=>string;
/** Why an operation failed or did not run, from fixed codes only: no tool or service text reaches a card. */
const reasons:Record<string,ApprovalText>={notion_not_connected:'reason_sign_in',notion_reconnect_needed:'reason_sign_in',notion_unavailable:'reason_unreachable',
  notion_not_enabled:'reason_turned_off',tool_disabled_by_owner:'reason_turned_off',tool_reported_error:'reason_refused',owner_cancelled:'reason_cancelled',job_stopped:'reason_stopped',
  guard_context_changed:'reason_changed',guard_transition_pending:'reason_changed',action_proposal_changed:'reason_changed',security_start_denied:'reason_changed',
  permission_no_longer_valid:'reason_changed',execution_lease_expired:'reason_changed',notion_owner_private_only:'reason_changed',notion_job_not_approved:'reason_changed',
  tool_sandbox_missing:'reason_sandbox',
  remote_unauthorized:'reason_refused',remote_response_rejected:'reason_refused'};
/** An approval that fails because what the operation used changed since it was asked. */
const outdated=new Set(['guard_context_changed','action_proposal_changed']);
/** Failures where the executor stopped before it sent anything. */
const unsent=new Set(['tool_disabled_by_owner','tool_policy_unavailable','tool_sandbox_missing','notion_not_connected','notion_reconnect_needed','notion_unavailable',
  'public_https_required','private_destination_denied']);
/** Card edits for one action, across every repository in this process, in the order they were asked for. */
const editing=new Map<string,Promise<void>>();
/** The card a button was pressed on, as Telegram names it. A card whose send lost its answer has no saved message
 *  id, yet still reached the chat; the press names it, so its decision can still be shown (the gateway checks it). */
type Seen={chat:string;message:string}|undefined;
const seenIn=(seen:Seen,chat:string)=>seen&&seen.chat===chat?{message_id:seen.message}:{};

/** One change on a list card: its number and what it does in bold, what the asker says it does, then its exact arguments. */
const entryText=(number:number,operation:OperationText)=>heading(`${number}. ⚙️ ${operation.title}`)+(operation.summary?'\n📝 '+operation.summary:'')+(operation.body?'\n'+operation.body:'');
/** A list card: how many changes and from which job, which card of how many, then each change exactly. */
function listText(line:Record<ApprovalText,string>,title:string,count:number,index:number,parts:number,long:number,items:string[]):string {
  const fill=(text:string,values:Record<string,string>)=>fillTemplate(text.replace(controls,''),values);
  return [fill(line.list,{count:String(count),title}),parts>1?fill(line.list_part,{part:String(index+1),parts:String(parts)}):null,
    line.list_note.replace(controls,''),...items.flatMap(item=>['',item]),...(long?['',fill(line.list_long,{count:String(long)})]:[])]
    .filter((value):value is string=>value!==null).join('\n');
}

/** A change as one entry of a list card with `room` left, or null when it would not fit one. */
const listEntry=(text:OperationText|null,room:number)=>{
  const shown=text?linked(entryText(999,text)):null;
  return shown&&shown.text.length+2<=room&&shown.links.length<=entityLimit?shown:null;
};
/** How an operation reads on a card, in the owner's words for its kind and with what the asker says it does,
 * or null when it is too long to review in Telegram. */
const operation=(action:{kind:string;arguments:Record<string,any>;summary?:string|null},line:Record<ApprovalText,string>)=>
  canonical(action.arguments).length>reviewLimit?null:operationText(action.kind,action.arguments,line,action.summary??null);
/** A change as a list card with `room` left shows it: with its summary while that fits, otherwise as it reads
 * without one, so a summary never sends a change to the Inbox. The same every time, so a decided card keeps its text. */
const listed=(action:{kind:string;arguments:Record<string,any>;summary?:string|null},line:Record<ApprovalText,string>,room:number)=>{
  const shown=operation(action,line);
  return shown?.summary&&!listEntry(shown,room)?operation({...action,summary:null},line):shown;
};

/** A t.me address of a group, topic or message, or null where Telegram has none, such as a basic group. */
export function telegramLink(chat:string,username:string|null,path:(string|null|undefined)[]):string|null {
  const parts=path.filter((part):part is string=>!!part&&/^[1-9][0-9]{0,15}$/.test(part));
  if(username&&/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username))return ['https://t.me/'+username,...parts].join('/');
  // A private supergroup's address works only for its members and needs a topic or message.
  const internal=chat.match(/^-100([1-9][0-9]{0,15})$/)?.[1];
  return internal&&parts.length?['https://t.me/c/'+internal,...parts].join('/'):null;
}

/** Administrative commands use original owner-DM evidence, never editable text.
 * Approve and Reject buttons on an exact pending action go to the owner's
 * private chat, where only the owner's press decides it. A message from one
 * group to another that its requester reviews gets its card in the group where
 * it was asked, where that person or the owner decides it. */
export class ActionCommandRepository {
  constructor(readonly access:SourceAccessRepository,readonly telegram:TelegramActionRepository,readonly tools:ControlledActionRepository,
    readonly call?:RuntimeCall,readonly jobs?:BackgroundJobRepository,readonly tasks?:TaskRepository){}
  private async approval(input:Record<string,unknown>,timeout=15000) {
    if(!this.call)return null;
    try{return await this.call('telegram.approval',input,timeout);}catch{return null;}
  }
  /** Where a live request was asked: its chat, topic and message. Null for background work. */
  private async asked(source:any):Promise<{chat:string;topic?:string;message?:string;from?:string}|null> {
    if(source?.store!=='archive')return null;
    const original=await this.access.archive.verify(source);
    if(original.origin!=='live'||original.channel!=='telegram')return null;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0];
    let message:any=null;try{const payload=JSON.parse(row.payload.toString());message=payload.message??payload.edited_message;}catch{}
    const id=String(message?.message_id??''),topic=message?.is_topic_message===true?String(message.message_thread_id??''):'',from=String(message?.from?.id??'');
    return {chat:String(original.scope),...(/^[1-9][0-9]{0,15}$/.test(topic)?{topic}:{}),...(/^[1-9][0-9]{0,15}$/.test(id)?{message:id}:{}),...(/^[1-9][0-9]{0,15}$/.test(from)?{from}:{})};
  }
  /** The owner's card templates and texts from Settings › Instructions, or the defaults. */
  private async texts() {
    const prompts=await ownerPrompts(this.access.stores.control);
    return {card:prompts['telegram.approval_card']??approvalCard,action:prompts['telegram.approval_action']??approvalAction,
      task:prompts['telegram.approval_task']??approvalTask,line:approvalLines(prompts['telegram.approval_texts'])};
  }
  /** A group's name, public username, topic flag and latest message, from its captured messages or else the owner's last refresh. */
  private async chat(chat:string) {
    const facts={title:null as string|null,username:null as string|null,forum:null as boolean|null,message:null as string|null};
    const rows=(await this.access.stores.archive.query(`SELECT payload FROM events WHERE scope=$1 AND channel='telegram'
      AND kind IN ('telegram_update','telegram_delivered_message') ORDER BY received_at DESC LIMIT 50`,[chat])).rows;
    for(const row of rows) {
      let message:any;try{const payload=JSON.parse(row.payload.toString());message=payload.message??payload.edited_message??payload;}catch{continue;}
      if(String(message?.chat?.id)!==chat)continue;
      facts.title??=clean(message.chat.title);facts.username??=clean(message.chat.username,32);
      if(typeof message.chat.is_forum==='boolean')facts.forum??=message.chat.is_forum;
      if(/^[1-9][0-9]{0,15}$/.test(String(message.message_id)))facts.message??=String(message.message_id);
    }
    const seen=(await this.access.stores.control.query("SELECT title,username,is_forum FROM telegram_chat_observations WHERE chat_id=$1 AND state='available'",[chat])).rows[0];
    facts.title??=clean(seen?.title);facts.username??=clean(seen?.username,32);if(typeof seen?.is_forum==='boolean')facts.forum??=seen.is_forum;
    return facts;
  }
  /** A topic's name from its creation or latest edit, or the name the owner gave it. */
  private async topicName(chat:string,topic:string):Promise<string|null> {
    const named=(await this.access.stores.archive.query(`SELECT name FROM (
        SELECT received_at,m ? 'forum_topic_edited' AS edited,coalesce(m#>>'{forum_topic_edited,name}',m#>>'{forum_topic_created,name}',
          CASE WHEN m#>>'{reply_to_message,message_id}'=$2 THEN m#>>'{reply_to_message,forum_topic_created,name}' END) AS name
        FROM (SELECT received_at,coalesce(p->'message',p->'edited_message',p) AS m FROM (
          SELECT received_at,convert_from(payload,'UTF8')::jsonb AS p FROM events WHERE scope=$1 AND channel='telegram'
            AND kind IN ('telegram_update','telegram_delivered_message') AND pg_input_is_valid(convert_from(payload,'UTF8'),'jsonb')) e) messages
        WHERE m->>'message_thread_id'=$2) topics WHERE name IS NOT NULL ORDER BY edited DESC,received_at DESC LIMIT 1`,[chat,topic])).rows[0]?.name;
    if(clean(named))return clean(named);
    const added=(await this.access.stores.control.query('SELECT name FROM telegram_topic_registrations WHERE chat_id=$1 AND topic_id=$2',[chat,Number(topic)])).rows[0]?.name;
    return clean(added);
  }
  /** A chat's name, linked to a message in it, and to a topic and its name when there is one. */
  private async where(chat:string,line:Record<ApprovalText,string>,mark:Mark,at:{topic?:string|undefined;message?:string|undefined;showTopic?:boolean}={}) {
    if(chat===this.access.policy().owner_id)return line.private_chat;
    const facts=await this.chat(chat),name=facts.title?`“${facts.title}”`:line.unnamed_group;
    const group=mark(name,telegramLink(chat,facts.username,at.message?[at.topic,at.message]:[facts.message??at.topic]));
    if(!at.showTopic)return group;
    const topic=at.topic?await this.topicName(chat,at.topic)??line.unnamed_topic:facts.forum?line.general_topic:null;
    if(!topic)return group;
    const label=mark(topic,at.topic?telegramLink(chat,facts.username,[at.topic]):null);
    return group+' '+(line.topic.includes('{topic}')?line.topic.replace('{topic}',()=>label):line.topic);
  }
  /** Where an action's card goes: the requester's own chat and topic, or the owner's private chat. */
  private async place(kind:ActionKind,id:string):Promise<{chat:string;topic?:string;reviewer?:string}|null> {
    const reviewer=kind==='telegram'?await this.telegram.reviewer(id):null,owner=this.access.policy().owner_id;
    if(!reviewer)return owner?{chat:owner}:null;
    const [chat,topic]=reviewer.space.split('/topic/');
    return {chat:chat!,...(topic?{topic}:{}),reviewer:reviewer.user};
  }
  /** A background job's run or a scheduled task that asked for an operation, by the job's name; a scheduled task with the
   *  chat it runs for, when `chat` names it. */
  private async work(source:any,line:Record<ApprovalText,string>,chat?:()=>Promise<string>):Promise<string|null> {
    const kind=(await this.access.stores.control.query('SELECT kind FROM content_operations WHERE id=$1',[source.id])).rows[0]?.kind;
    if(kind==='scheduled_trigger')return chat?fillTemplate(line.from_schedule_in,{chat:await chat()}):line.from_schedule;
    const title=kind==='background_run'&&this.jobs?clean(await this.jobs.runJob(source.id)):null;
    return title?fillTemplate(line.from_job,{title}):null;
  }
  /** The exact content to decide on, or null when it is too long to review in Telegram. `rules` says whether the card
   *  may offer its operation's chat rule buttons. */
  private async card(kind:ActionKind,id:string,source:any,reviewed=false):Promise<{text:string;links:Link[];fingerprint:string;state:string;code:string|null;started:boolean;resolution:string|null;line:Record<ApprovalText,string>;rules:boolean}|null> {
    const owner={admin:true,scope:null},texts=await this.texts(),urls:string[]=[];
    const line=Object.fromEntries(Object.entries(texts.line).map(([key,value])=>[key,value.replace(controls,'')])) as Record<ApprovalText,string>;
    const mark:Mark=(label,url)=>url?`\u0001${urls.push(url)-1}\u0002${label}\u0003`:label;
    // A chat rule covers everyone allowed where it was asked, so a card that offers one names that chat and its topic, and says
    // so above its buttons; not in the owner's private chat, where only the owner asks (ADR-0225).
    const row=kind==='controlled'?await this.tools.row(id):null,ruled=!!row&&!!ruleChoices(row);
    const [space,spaceTopic]=String(row?.space_id??'').split('/topic/'),shared=ruled&&space!==this.access.policy().owner_id;
    // The card under a request in its own chat does not say where it was asked. One that offers a rule always names the chat
    // and topic it would cover, even for a request with no Telegram message to point to, such as a dashboard run for a group.
    const asked=reviewed?null:await this.asked(source);
    const origin=(asked&&asked.chat!==this.access.policy().owner_id?await this.where(asked.chat,line,mark,{topic:asked.topic,message:asked.message,showTopic:shared}):
      source?.store==='control'?await this.work(source,line,shared?()=>this.where(space!,line,mark,{topic:spaceTopic,showTopic:true}):undefined):null)??
      (shared?await this.where(space!,line,mark,{topic:spaceTopic,showTopic:true}):null);
    if(kind==='telegram') {
      const action=await this.telegram.inspect(owner,id),[chat,topic]=String(action.arguments.destination).split('/topic/');
      const place=await this.where(chat!,line,mark,{topic,showTopic:true});
      const filled=fillTemplate(texts.card.replace(controls,''),{destination:place,origin,text:String(action.arguments.text).replace(controls,'')});
      return {...linked(filled,urls),fingerprint:action.fingerprint,state:action.state,code:null,started:true,resolution:action.resolution,line,rules:false};
    }
    const action=await this.tools.inspect(owner,id);
    const shown=operation(action,line);if(!shown)return null;
    // Room is kept for the line that says how it ended, and for the note above a chat rule's buttons. A summary never keeps
    // a card from Telegram: one that does not fit with it goes without it, before the note does.
    const room=cardLimit-outcomeRoom,note=shared?'\n\n'+line.rule_note:'';
    let card=linked(operationCard(texts.action,shown,origin),urls);
    if(card.text.length+note.length>room&&shown.summary) {
      const bare=operation({...action,summary:null},line);if(!bare)return null;
      const plain=linked(operationCard(texts.action,bare,origin),urls);
      // The summary gives way to the note only when that makes room for it; a card the note cannot fit either way keeps its summary.
      if(card.text.length>room||plain.text.length+note.length<=room)card=plain;
    }
    if(card.text.length>room)return null;
    // A card the note does not fit offers no chat rule, so a rule is never offered without saying whom it covers.
    // The note goes last, so no entity before it moves.
    const noted=!!note&&card.text.length+note.length<=room;
    if(noted)card={...card,text:card.text+note};
    const code=action.error_code??(typeof action.result?.result?.error==='string'?action.result.result.error:null);
    // The executor runs only after its start is recorded, so an operation never started did not run.
    const started=!!(await this.tools.row(id)).started_at;
    return {...card,fingerprint:action.fingerprint,state:action.state,code,started,resolution:action.resolution,line,rules:ruled&&(!shared||noted)};
  }
  private outcome(kind:ActionKind,state:string,line:Record<ApprovalText,string>,code:string|null=null,started=true,resolution:string|null=null) {
    if(state==='proposed')return null;
    // An unclear outcome the owner closed with their word (ADR-0218); a dismissed one stays unsure.
    if(state==='ambiguous'&&(resolution==='ran'||resolution==='not_run'))
      return kind==='telegram'?resolution==='ran'?line.marked_sent:line.marked_not_sent:resolution==='ran'?line.marked_ran:line.marked_not_run;
    if(kind==='controlled') {
      const reason=line[code&&Object.hasOwn(reasons,code)?reasons[code]!:'reason_other'];
      if(state==='rejected'&&code||['failed','ambiguous'].includes(state)&&(!started||unsent.has(code??'')))return fillTemplate(line.not_run,{reason});
      if(state==='failed')return fillTemplate(line.failed_action,{reason});
      // A page read that started and got no answer closed itself.
      if(state==='ambiguous')return resolution==='read_closed'?line.read_closed:line.unsure;
    }
    if(state==='rejected')return kind==='telegram'?line.rejected:line.rejected_action;
    if(state==='cancelled')return line.cancelled;
    if(state==='done')return kind==='telegram'?line.sent:line.done;
    if(['failed','ambiguous'].includes(state))return line.failed;
    return kind==='telegram'?line.sending:line.approved;
  }
  /** Offer buttons on a new pending action to whoever reviews it; best
   * effort, the owner's Inbox always remains. */
  async offer<T extends Record<string,any>>(kind:ActionKind,result:T):Promise<T> {
    if(kind==='task')return this.offerTask(result);
    const owner=this.access.policy().owner_id;
    if(result?.state!=='proposed'||typeof result.id!=='string'||!this.call||!owner)return result;
    if(kind==='background')return this.offerJob(result);
    try {
      const table=kind==='telegram'?'telegram_action_requests':'controlled_actions',control=this.access.stores.control;
      const row=(await control.query(`SELECT * FROM ${table} WHERE id=$1`,[result.id])).rows[0];if(!row)return result;
      // Only an action that waits for the owner gets buttons: a deny rule
      // blocks it anyway, and a standing permission runs it without a decision.
      const effect:Effect=kind==='telegram'?{id:row.id,kind:'telegram.send',scope:row.scope,profile:row.profile,fingerprint:row.fingerprint}:this.tools.effect(row);
      if((await evaluate(control,effect)).outcome!=='ask'||kind==='controlled'&&(await this.tools.grants(row)).length)return result;
      // A running job's operations wait for its end, when the owner approves them on one card (ADR-0204).
      const job=kind==='controlled'&&row.job_id?(await control.query("SELECT * FROM background_jobs WHERE id=$1 AND state IN ('approved','running') AND changes IS NULL",[row.job_id])).rows[0]:null;
      if(job) {
        const {line}=await this.texts(),{room}=await this.listRoom(job,line);
        return {...result,message:!listEntry(listed(await this.tools.inspect({admin:true,scope:null},row.id),line,room),room)?
          'Kept with this job\'s other changes. It is too long for a Telegram card, so the owner reviews it in the dashboard Inbox when the job ends. Do not wait for it. Say in your report what you asked for.':
          'Kept with this job\'s other changes. When the job ends, the owner approves them together on one card. Do not wait for it. Say in your report what you asked for.'};
      }
      const place=await this.place(kind,result.id),card=place?await this.card(kind,result.id,row.source_reference,!!place.reviewer):null;
      if(place&&!card)return {...result,message:'This request is too long for a Telegram card. The owner can review and approve it in the dashboard Inbox.'};
      if(!place||!card||card.state!=='proposed')return result;
      // In the chat and topic where it was asked, the card answers the request itself.
      const asked=await this.asked(row.source_reference);
      const here=asked&&asked.chat===place.chat&&(asked.topic??'')===(place.topic??'')?asked.message??null:null;
      const choices:[ApprovalText,string][]=(kind==='controlled'&&card.rules&&ruleChoices(row))||[['approve','a'],['reject','d']];
      const sent=await this.approval({kind:'card',chat_id:place.chat,...(place.topic?{topic:place.topic}:{}),...(here?{reply_to:here}:{}),id:result.id,
        text:card.text,links:card.links,buttons:choices.map(([label,choice])=>[card.line[label].slice(0,40),'n'+choice+result.id.slice(0,40)+card.fingerprint.slice(0,16)])});
      if(sent?.state!=='done')return result;
      // Only an operation answers later in the chat that asked, at most three times per asking message (ADR-0212); a message is simply sent.
      const follows=kind==='controlled'&&!!asked&&await followUpLeft(control,row.event_id);
      return {...result,message:here?
        'A card with Approve and Reject buttons for this exact request was posted here as the reply to it. It names where the message goes and shows it exactly, so it is the whole answer: do not repeat or announce it; return [NO_REPLY] unless something else needs an answer.':
        place.reviewer?
        'This exact message for the other group was posted here with Approve and Reject buttons for the person who asked; nothing is sent until they press Approve. Say only, briefly, that they can check and approve it; do not repeat the draft.':
        // The owner asking in a group is told where their card is, not that someone else was asked.
        asked&&asked.chat!==owner&&asked.from===owner?follows?
        'The person who asked is the owner, so the decision is theirs: Approve and Reject buttons for this exact request were sent to them in their private chat with you. In this chat answer them as "you", briefly: their card is waiting in their private chat, and the answer will follow here. Do not say it waits for the owner or anyone else; do not show the draft or details.':
        'The person who asked is the owner, so the decision is theirs: Approve and Reject buttons for this exact request were sent to them in their private chat with you. In this chat answer them as "you", briefly: their card is waiting in their private chat. Do not say it waits for the owner or anyone else; do not show the draft or details.':
        asked&&asked.chat!==owner?follows?
        'The owner was asked privately, with Approve and Reject buttons, to approve this exact request. In this chat say only, briefly, that you asked the owner and that the answer will follow here; do not show the draft or details.':
        'The owner was asked privately, with Approve and Reject buttons, to approve this exact request. In this chat say only, briefly, that you asked the owner; do not show the draft or details.':
        // A job's run or a scheduled task runs on without a chat to wait in.
        row.source_reference?.store==='control'?
        'The owner was sent Approve and Reject buttons for this exact request in their private chat. It runs only if they approve, maybe after you finish. Do not wait for it. Say in your answer what you asked for.':
        'Approve and Reject buttons for this exact request were sent to you in this chat. It waits for your decision; it can also be reviewed in the dashboard Inbox.'+
        (follows?' Once it has run, its answer follows here as a reply.':'')};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /**
   * A task card: what changes in which project's list, every group and topic that sees that list by name, what stays
   * private, then exactly what those chats will see, with each task that moves in under it. Null when it does not fit
   * one Telegram card (ADR-0243).
   */
  private async taskCard(id:string) {
    const texts=await this.texts(),urls:string[]=[],owner={admin:true,scope:null};
    const line=Object.fromEntries(Object.entries(texts.line).map(([key,value])=>[key,value.replace(controls,'')])) as Record<ApprovalText,string>;
    const mark:Mark=(label,url)=>url?`\u0001${urls.push(url)-1}\u0002${label}\u0003`:label;
    // A group or topic among the task's fields is named in plain words, as every field's value is.
    const space=async(chat:string)=>{const [group,topic]=chat.split('/topic/'),facts=await this.chat(group!),name=facts.title??line.unnamed_group;
      return topic?`${name} › ${await this.topicName(group!,topic)??line.unnamed_topic}`:name;};
    const request=await this.tasks!.request(owner,id,space);
    const chats=[];for(const chat of request.chats){const [group,topic]=chat.split('/topic/');chats.push(await this.where(group!,line,mark,{topic,showTopic:true}));}
    const project=`“${(request.project??'').replace(controls,'')}”`,slot='\u0001\u0003';
    const filled=fillTemplate(texts.task.replace(controls,''),{change:fillTemplate(line[`task_${request.change}`],{project,count:String(request.subtasks)}),chats:chats.length?chats.join(', '):line.task_no_chats,
      private:request.private?line[`task_private_${request.private}`]:null,fields:slot});
    const card=linked(filled.replaceAll(slot,()=>fields(request.fields)),urls);
    if(card.text.length>cardLimit-outcomeRoom||card.links.length>entityLimit)return null;
    return {...card,line,state:request.state,fingerprint:request.fingerprint,source:request.source_reference};
  }
  /** Approve and Reject buttons on a held task change, in the owner's private chat; there, the reply to the request. */
  private async offerTask<T extends Record<string,any>>(result:T):Promise<T> {
    const owner=this.access.policy().owner_id,id=result?.request_id;
    if(result?.state!=='proposed'||typeof id!=='string'||!this.tasks)return result;
    try {
      const card=await this.taskCard(id);
      if(!card){await this.tasks.refuse({admin:true,scope:null},id);return {...result,state:'refused',error:'task_card_too_long',
        note:'Nothing changed: this change is too long to show exactly on a Telegram card. Tell the owner they can make it in the dashboard\'s Tasks page.'};}
      const unsent={...result,message:'The card for this change could not be posted, so nothing changed. If no card shows up, the owner can make it in the dashboard\'s Tasks page.'};
      if(card.state!=='proposed')return result;
      if(!owner||!this.call)return unsent;
      const asked=await this.asked(card.source),here=asked&&asked.chat===owner?asked.message??null:null;
      const sent=await this.approval({kind:'card',chat_id:owner,...(here?{reply_to:here}:{}),id,text:card.text,links:card.links,
        buttons:[[card.line.approve.slice(0,40),'na'+id.slice(0,40)+card.fingerprint.slice(0,16)],[card.line.reject.slice(0,40),'nd'+id.slice(0,40)+card.fingerprint.slice(0,16)]]});
      if(sent?.state!=='done')return unsent;
      return {...result,message:here?
        'A card with Approve and Reject buttons for this exact change was posted here as the reply to it. It names the project\'s list, every chat that sees that list and what stays private, and shows the change exactly, so it is the whole answer: do not repeat or announce it; return [NO_REPLY] unless something else needs an answer. Nothing changes until the owner approves.':
        'Approve and Reject buttons for this exact change were sent to the owner\'s private Telegram chat, on a card that names the chats that will see it. Nothing changes until the owner approves; say so briefly.'};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /** A decided task card keeps its text and says how it ended. */
  private async settleTask(id:string,seen?:Seen) {
    const owner=this.access.policy().owner_id;if(!owner||!this.tasks)return;
    const card=await this.taskCard(id);if(!card)return;
    const outcome=card.state==='done'?card.line.task_done:card.state==='rejected'?card.line.task_rejected:card.state==='changed'?card.line.task_changed:null;
    if(outcome)await this.approval({kind:'settle',chat_id:owner,id,text:`${card.text}\n\n${outcome}`,links:card.links,...seenIn(seen,owner)});
  }
  /** Where a job's card goes: the chat and topic where it was asked, or the owner's private chat when the owner approves a
   * member's job or any machine job; there it answers the request when it was asked there. */
  private async jobPlace(row:any):Promise<{chat:string;topic?:string;here:string|null}> {
    const owner=this.access.policy().owner_id!;
    if(row.approver==='owner'){const asked=row.requester?null:await this.asked(row.source_reference);return {chat:owner,here:asked&&asked.chat===owner?asked.message??null:null};}
    const [chat,topic]=String(row.space_id).split('/topic/'),asked=await this.asked(row.source_reference);
    return {chat:chat!,...(topic?{topic}:{}),here:asked&&asked.chat===chat&&(asked.topic??'')===(topic??'')?asked.message??null:null};
  }
  /** Approve and Reject buttons on a proposed background job, for whoever approves it. */
  private async offerJob<T extends Record<string,any>>(result:T):Promise<T> {
    if(!this.jobs)return result;
    try {
      const card=await this.jobs.card(result.id),{line}=await this.texts();
      if(card.state!=='proposed')return result;
      const place=await this.jobPlace(card.row);
      const sent=await this.approval({kind:'card',chat_id:place.chat,...(place.topic?{topic:place.topic}:{}),...(place.here?{reply_to:place.here}:{}),id:result.id,
        text:card.text,links:[],buttons:[[line.approve.slice(0,40),'na'+result.id.slice(0,40)+card.fingerprint.slice(0,16)],[line.reject.slice(0,40),'nd'+result.id.slice(0,40)+card.fingerprint.slice(0,16)]]});
      if(sent?.state!=='done')return result;
      // A Remove that withdrew the job while its card was being posted settled a card that did not exist yet.
      if((await this.jobs.card(result.id)).state!=='proposed')await this.settle('background',result.id);
      const asked=card.row.approver==='owner'&&!card.row.requester?await this.asked(card.row.source_reference):null;
      return {...result,message:card.row.approver==='owner'&&card.row.requester?
        'The owner was asked privately, with Approve and Reject buttons, to approve this job, because its cost is over what a member may start or cannot be measured. Say so briefly with the estimate; nothing runs until the owner approves.':
        // The owner asking in a group is told where their card is, as for an operation they asked for there.
        asked&&asked.chat!==this.access.policy().owner_id?
        'The person who asked is the owner, so the decision is theirs: a card with Approve and Reject buttons for this job was sent to them in their private chat with you. In this chat answer them as "you", briefly: their card is waiting in their private chat, and the report will follow here once it runs. Do not say it waits for the owner or anyone else; do not show the plan or details.':
        'A card with Approve and Reject buttons for this job was posted here as the reply to the request. It shows the job, its size, time and cost, so say at most one short sentence; nothing runs until it is approved.'};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /** A decided job's card keeps its text and shows where the job is: Stop while it waits or runs, no button once it
   *  stops or ends. A job that ended at a limit says a short note is in the chat. */
  private async settleJob(id:string,seen?:Seen) {
    if(!this.jobs)return;
    const card=await this.jobs.card(id),place=await this.jobPlace(card.row),row=card.row,{line}=await this.texts();
    const state=row.error_code==='job_repo_removed'?'repo_removed':row.error_code==='job_machine_off'?'machine_off':row.cancel_requested&&!closedStates.has(row.state)?'stopping':row.cancel_requested&&row.state!=='done'?'stopped':
      row.state==='done'&&row.ended?'limited':row.state;
    // A card in the owner's private chat for a job asked elsewhere does not say the report comes here.
    const away=String(row.space_id).split('/topic/')[0]!==place.chat;
    const outcome=state==='approved'&&card.waiting?card.lines.queued:['approved','running','reporting'].includes(state)?card.lines[away?'running_elsewhere':'running']:card.lines[state];
    const buttons=['approved','running','reporting'].includes(state)?[[line.stop.slice(0,40),'ns'+id.slice(0,40)+card.fingerprint.slice(0,16)]]:null;
    if(outcome)await this.approval({kind:'settle',chat_id:place.chat,id,text:`${card.text}\n\n${outcome}`,links:[],...(buttons?{buttons}:{}),...seenIn(seen,place.chat)});
    if(['done','failed','limited'].includes(state)&&!row.cancel_requested)await this.offerList(row);
  }
  /** The changes a job left waiting, on as few cards as Telegram allows; each card is decided as a whole.
   * The split is frozen once, before any card is sent, so a card's text and buttons never change. */
  private async offerList(job:any) {
    const owner=this.access.policy().owner_id,control=this.access.stores.control;
    if(!owner||job.changes)return;
    const rows=(await control.query("SELECT * FROM controlled_actions WHERE job_id=$1 AND state='proposed' ORDER BY created_at,id",[job.id])).rows;
    const {line}=await this.texts(),{title,room}=await this.listRoom(job,line),cards:ListCard[]=[];
    let entries:[string,string][]=[],used=0,marks=0,long=0;
    const close=()=>{if(!entries.length)return;const id=digest(canonical(['action-list-v1',job.id,cards.length]));
      cards.push({id,fingerprint:digest(canonical(['action-list-v1',id,entries])),members:entries});entries=[];used=0;marks=0;};
    for(const row of rows) {
      if((await evaluate(control,this.tools.effect(row))).outcome!=='ask'||(await this.tools.grants(row)).length)continue;
      const action=await this.tools.inspect({admin:true,scope:null},row.id).catch(error=>{if(error instanceof HttpError)return null;throw error;});
      // A card holds what fits Telegram's length and its number of entities.
      const shown=listEntry(action&&'arguments' in action?listed(action,line,room):null,room);
      if(!shown){long++;continue;}
      const size=shown.text.length+2,count=shown.links.length;
      if(used+size>room||marks+count>entityLimit)close();
      entries.push([row.id,action!.fingerprint]);used+=size;marks+=count;
    }
    close();
    if(long&&cards.length)cards.at(-1)!.long=long;
    const saved=await control.query('UPDATE background_jobs SET changes=$2 WHERE id=$1 AND changes IS NULL RETURNING id',[job.id,JSON.stringify(cards)]);
    if(!saved.rowCount)return;
    // Nothing fits a card: the owner is still told where the job's changes wait.
    if(long&&!cards.length)try{await this.call!('telegram.notice',{id:digest(canonical(['action-list-inbox-v1',job.id])),chat_id:owner,
      text:fillTemplate(line.list_inbox.replace(controls,''),{count:String(long),title})},30000);}catch{}
    for(const [index,card] of cards.entries()) {
      const shown=linked(listText(line,title,card.members.length,index,cards.length,card.long??0,await this.entries(card,line,room)));
      await this.approval({kind:'card',chat_id:owner,id:card.id,text:shown.text,links:shown.links,
        buttons:[[line.approve.slice(0,40),'na'+card.id.slice(0,40)+card.fingerprint.slice(0,16)],[line.reject.slice(0,40),'nd'+card.id.slice(0,40)+card.fingerprint.slice(0,16)]]});
    }
  }
  /** A job's title, and the room for its changes on a list card: what is left after the card's own lines at
   * their longest, so every card fits whatever its place. */
  private async listRoom(job:any,line:Record<ApprovalText,string>) {
    const title=clean((await this.jobs!.proposal(job)).title)??'';
    return {title,room:cardLimit-outcomeRoom-listText(line,title,999,98,99,999,[]).length};
  }
  /** A list card's changes, read again from its members, so a decided card shows what it showed before. */
  private async entries(card:ListCard,line:Record<ApprovalText,string>,room:number):Promise<string[]> {
    const items=[];
    for(const [number,[id]] of card.members.entries()) {
      const action=await this.tools.inspect({admin:true,scope:null},id).catch(error=>{if(error instanceof HttpError)return null;throw error;});
      items.push(entryText(number+1,(action&&'arguments' in action?listed(action,line,room):null)??{title:action?.kind??'',summary:null,body:''}));
    }
    return items;
  }
  /** The job and card a list card's ID names, or the card that lists an operation. */
  private async listCard(by:{card?:string;member?:string}):Promise<{job:any;card:ListCard;index:number}|null> {
    const rows=(await this.access.stores.control.query(by.card?`SELECT j.* FROM background_jobs j WHERE j.changes @> jsonb_build_array(jsonb_build_object('id',$1::text))`:
      `SELECT j.* FROM background_jobs j JOIN controlled_actions a ON a.job_id=j.id WHERE a.id=$1 AND j.changes IS NOT NULL`,[by.card??by.member])).rows;
    for(const job of rows)for(const [index,card] of (job.changes as ListCard[]).entries())
      if(card.id===by.card||card.members.some(([id])=>id===by.member))return {job,card,index};
    return null;
  }
  /** A decided list card keeps its text and says how its changes ended. */
  private async settleList(id:string,seen?:Seen) {
    const found=await this.listCard({card:id}),owner=this.access.policy().owner_id;if(!found||!owner)return;
    const {line}=await this.texts(),states=(await this.access.stores.control.query('SELECT id,state,error_code,resolution FROM controlled_actions WHERE id=ANY($1)',
      [found.card.members.map(([member])=>member)])).rows;
    if(states.some(row=>row.state==='proposed'))return;
    // An unclear change the owner said ran counts as done, as it does in Health (ADR-0218).
    const count=String(found.card.members.length),done=states.filter(row=>row.state==='done'||row.state==='ambiguous'&&row.resolution==='ran').length;
    // Every change ended without running: the owner rejected it, or what it used changed since.
    const unrun=states.every(row=>row.state==='rejected'),code=states.find(row=>row.error_code)?.error_code;
    const outcome=unrun&&states.some(row=>!row.error_code)?line.rejected_action:
      unrun?fillTemplate(line.not_run,{reason:line[code&&Object.hasOwn(reasons,code)?reasons[code]!:'reason_other']}):
      states.some(row=>['approved','running'].includes(row.state))?line.approved:
      done===states.length?fillTemplate(line.list_done,{count}):fillTemplate(line.list_some,{done:String(done),count});
    const cards=found.job.changes as ListCard[],{title,room}=await this.listRoom(found.job,line);
    const shown=linked(listText(line,title,found.card.members.length,found.index,cards.length,found.card.long??0,await this.entries(found.card,line,room)));
    // Texts edited since the card was sent can make it longer; a decided card has no buttons, so its end may be cut.
    const kept=cut(shown,cardLimit-outcome.length-3);
    await this.approval({kind:'settle',chat_id:owner,id,text:`${kept.text}\n\n${outcome}`,links:kept.links,...seenIn(seen,owner)});
  }
  /** Show the decision on a card and remove its buttons; best effort. Edits of one card run one after
   * another and each reads the state when it starts, so the last edit shows the latest state. */
  async settle(kind:ActionKind,id:string,seen?:Seen) {
    const key=kind+':'+id,run=(editing.get(key)??Promise.resolve()).then(()=>this.edit(kind,id,seen)),tail=run.catch(()=>{});
    editing.set(key,tail);
    try{await run;}finally{if(editing.get(key)===tail)editing.delete(key);}
  }
  private async edit(kind:ActionKind,id:string,seen?:Seen) {
    try {
      if(kind==='background')return await this.settleJob(id,seen);
      if(kind==='list')return await this.settleList(id,seen);
      if(kind==='task')return await this.settleTask(id,seen);
      // An operation on a list card shows on that card.
      const listed=kind==='controlled'?await this.listCard({member:id}):null;
      if(listed)return await this.settle('list',listed.card.id);
      const table=kind==='telegram'?'telegram_action_requests':'controlled_actions';
      const row=(await this.access.stores.control.query(`SELECT source_reference FROM ${table} WHERE id=$1`,[id])).rows[0];
      const place=row?await this.place(kind,id):null,card=place?await this.card(kind,id,row.source_reference,!!place.reviewer):null,outcome=card?this.outcome(kind,card.state,card.line,card.code,card.started,card.resolution):null;
      if(place&&card&&outcome)await this.approval({kind:'settle',chat_id:place.chat,id,text:`${card.text}\n\n${outcome}`,links:card.links,...seenIn(seen,place.chat)});
    }catch(error){if(!(error instanceof HttpError))throw error;}
  }
  /** A button press: true when it was an approval button, whatever its outcome. */
  async callback(source:SourceReference):Promise<boolean> {
    const original=await this.access.archive.verify(source);
    if(original.kind!=='telegram_update'||original.origin!=='live')return false;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0];
    const query=row?JSON.parse(row.payload.toString()).callback_query:null,data=typeof query?.data==='string'?query.data.match(buttonData):null;
    if(query?.data===retryButton&&typeof query.id==='string')return this.retryPressed(query);
    if(!data||typeof query.id!=='string')return false;
    const chat=String(query.message?.chat?.id??''),policy=this.access.policy(),{line}=await this.texts();
    const answer=(text:string)=>this.approval({kind:'answer',chat_id:chat,callback_query_id:query.id,text:text.slice(0,200)},10000);
    const found=(await this.access.stores.control.query(`SELECT 'telegram' AS kind,id,fingerprint FROM telegram_action_requests WHERE left(id,40)=$1
      UNION ALL SELECT 'controlled',id,fingerprint FROM controlled_actions WHERE left(id,40)=$1
      UNION ALL SELECT 'background',id,fingerprint FROM background_jobs WHERE left(id,40)=$1
      UNION ALL SELECT 'list',c->>'id',c->>'fingerprint' FROM background_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.changes) c
        WHERE j.changes IS NOT NULL AND left(c->>'id',40)=$1
      UNION ALL SELECT 'task',id,fingerprint FROM owner_task_requests WHERE left(id,40)=$1`,[data[2]])).rows;
    const action=found.length===1&&found[0].fingerprint.startsWith(data[3])?found[0]:null,presser=String(query.from?.id??'');
    // Telegram fills in the pressed message; only one that carries this very button names this card's message.
    const carries=(query.message?.reply_markup?.inline_keyboard??[]).flat().some((button:any)=>button?.callback_data===query.data);
    const message=String(query.message?.message_id??''),seen:Seen=carries&&chat&&/^[1-9]\d{0,15}$/.test(message)?{chat,message}:undefined;
    // Allow here and Always allow are only an operation's buttons, and only the owner's (ADR-0214).
    if(['c','w'].includes(data[1]!)&&action&&action.kind!=='controlled'){await answer(line.changed);return true;}
    if(action?.kind==='background'&&this.jobs)return data[1]==='s'?this.stopPressed(action,presser,chat,query.id,seen):this.jobPressed(action,data[1]==='a',presser,chat,query.id,source,seen);
    // Stop is only a job's button; it never decides anything else.
    if(data[1]==='s'){await answer(line.changed);return true;}
    if(action?.kind==='list'&&presser===policy.owner_id)return this.listPressed(action.id,data[1]==='a',chat,query.id,source,seen);
    const reviewer=action?.kind==='telegram'?(await this.telegram.reviewer(action.id))?.user:undefined;
    // The owner decides any card; the person who asked decides only their own card in their group.
    if(!policy.owner_id||presser!==policy.owner_id&&!(reviewer&&presser===reviewer&&chat===(await this.place('telegram',action.id))?.chat)){
      await answer(reviewer?line.only_requester:line.only_owner);return true;}
    if(!action){await answer(line.changed);return true;}
    const kind=action.kind as ActionKind,decision=data[1]==='d'?'deny':'approve',owner={admin:true,scope:null};
    const allow=data[1]==='c'?'here':data[1]==='w'?'always':undefined;
    const body={id:action.id,fingerprint:action.fingerprint,decision,operation_id:'telegram-button:'+source.id,...(allow?{allow}:{})};
    let reply:string;
    try {
      if(kind==='task') {
        // Only the owner decides a task card; its change is made as the owner's own, from their private chat (ADR-0243).
        if(!this.tasks){await answer(line.changed);return true;}
        const result=await this.tasks.decide(owner,body);
        reply=result.state==='rejected'?line.task_rejected:result.state==='changed'?line.task_changed:line.task_done;
      }
      else {
        const result=kind==='telegram'?await this.telegram.decide(owner,body,source):await this.tools.decide(owner,body,source);
        reply=result.state==='rejected'?(kind==='telegram'?line.rejected:line.rejected_action):allow==='here'?line.allowed_here:allow?line.allowed_always:line.approved;
      }
    }catch(error) {
      if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;
      reply=kind==='controlled'&&outdated.has(error.code)?fillTemplate(line.not_run,{reason:line.reason_changed}):line.decided;
    }
    await answer(reply);await this.settle(kind,action.id,seen);return true;
  }
  /** Approve or Reject on a list card: the owner decides each change on it, exactly as it was shown. */
  private async listPressed(id:string,approve:boolean,chat:string,query:string,source:SourceReference,seen?:Seen):Promise<boolean> {
    const {line}=await this.texts(),answer=(text:string)=>this.approval({kind:'answer',chat_id:chat,callback_query_id:query,text:text.slice(0,200)},10000);
    const found=await this.listCard({card:id});if(!found){await answer(line.changed);return true;}
    // A change decided since, in the Inbox or by an earlier press, keeps that decision; the revision makes a
    // decision that lands meanwhile win too.
    const rows=new Map((await this.access.stores.control.query('SELECT id,state,revision FROM controlled_actions WHERE id=ANY($1)',
      [found.card.members.map(([member])=>member)])).rows.map(row=>[row.id,row]));
    let decided=0;
    for(const [member,fingerprint] of found.card.members) {
      const row=rows.get(member);if(row?.state!=='proposed')continue;
      try {
        await this.tools.decide({admin:true,scope:null},{id:member,fingerprint,decision:approve?'approve':'deny',expected_revision:row.revision,
          operation_id:'telegram-button:'+source.id+':'+member},source);decided++;
      }catch(error){if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;}
    }
    const count=String(found.card.members.length);
    await answer(!decided?line.decided:decided<found.card.members.length?fillTemplate(approve?line.list_partly:line.list_partly_rejected,{done:String(decided),count}):
      approve?line.approved:line.rejected_action);
    await this.settle('list',id,seen);return true;
  }
  /** Approve or Reject on a job's card: the owner, or the person who asked on their own job's card. */
  private async jobPressed(action:{id:string;fingerprint:string},approve:boolean,presser:string,chat:string,query:string,source:SourceReference,seen?:Seen):Promise<boolean> {
    const {line}=await this.texts(),answer=(text:string)=>this.approval({kind:'answer',chat_id:chat,callback_query_id:query,text:text.slice(0,200)},10000);
    if(!await this.jobs!.presser(action.id,presser,chat)){await answer(presser===this.access.policy().owner_id?line.only_owner:line.only_requester);return true;}
    let reply:string;
    try {
      const result=await this.jobs!.decide(presser,{id:action.id,fingerprint:action.fingerprint,decision:approve?'approve':'deny'},source);
      reply=result.state==='rejected'?line.rejected_action:line.approved;
    }catch(error) {
      if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;
      reply=line.decided;
    }
    await answer(reply);await this.settle('background',action.id,seen);return true;
  }
  /** Stop on a running job's card: the owner, or the person who asked on their own job's card, stops it as the tool's
   *  stop does. Its card then says it is stopping and loses the button. */
  private async stopPressed(action:{id:string;fingerprint:string},presser:string,chat:string,query:string,seen?:Seen):Promise<boolean> {
    const {line}=await this.texts(),answer=(text:string)=>this.approval({kind:'answer',chat_id:chat,callback_query_id:query,text:text.slice(0,200)},10000);
    if(!await this.jobs!.presser(action.id,presser,chat)){await answer(line.only_stop);return true;}
    let reply:string;
    try{await this.jobs!.halt(action.id);reply=line.stopping_job;}
    catch(error) {
      if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;
      reply=line.job_ended;
    }
    await answer(reply);await this.settle('background',action.id,seen);return true;
  }
  /** Retry failed under a problem notice: only the owner's press in their private chat retries anything. */
  private async retryPressed(query:any):Promise<boolean> {
    const chat=String(query.message?.chat?.id??''),owner=this.access.policy().owner_id;
    const labels=labeledLines(problemButtons,(await ownerPrompts(this.access.stores.control))['system.problem_buttons']);
    let reply=labels.only_owner!;
    if(owner&&String(query.from?.id??'')===owner&&chat===owner) {
      const {retried}=await retryFailedWorkflows(this.access.stores.control,{admin:true,scope:null});
      reply=retried?fillTemplate(labels.retried!,{count:String(retried)}):labels.nothing!;
    }
    await this.approval({kind:'answer',chat_id:chat,callback_query_id:query.id,text:reply.slice(0,200)},10000);
    return true;
  }
  async controlReply(source:SourceReference):Promise<string|null> {
    const original=await this.access.archive.verify(source);
    if(original.kind!=='telegram_update'||original.origin!=='live')return null;
    const intake=(await this.access.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
    if(intake?.transport==='import'||intake?.state==='pending')return null;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0],payload=JSON.parse(row.payload.toString()),text=payload.message?.text;
    const command=typeof text==='string'?text.trim().match(/^\/(actions|action|approve|deny|permissions|revoke)(?:\s+([a-f0-9]{64}))?$/):null;if(!command)return null;
    if(!conversationScope(this.access.policy(),payload,original.scope)?.owner)return 'Only the owner can review or approve actions in their private DM.';
    const owner={admin:true,scope:null},operation_id='telegram-command:'+source.id;let controlled=false;
    if(command[1]==='actions') {
      const tools=(await this.tools.list(owner)).actions,telegram=await this.telegram.list(owner);
      // An unclear one waits until it is closed (ADR-0218).
      const rows=[...tools,...telegram].filter(row=>['proposed','approved','running'].includes(row.state)||row.state==='ambiguous'&&!row.resolution)
        .sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,10);
      return rows.length?rows.map(row=>`${row.id}\n${row.kind} · ${row.state}\nReview: /action ${row.id}`).join('\n\n').slice(0,3500):'No pending actions.';
    }
    if(command[1]==='permissions') {
      const permissions=(await this.tools.list(owner)).permissions;
      return permissions.length?permissions.slice(0,10).map(p=>`${p.id}\n${p.kind} · profile ${p.profile}\nRemaining: ${p.remaining}; expires ${p.expires_at}; revoked: ${!!p.revoked_at}\nRevoke: /revoke ${p.id}`).join('\n\n').slice(0,3500):'No standing permissions.';
    }
    if(!command[2])return command[1]==='revoke'?'Include the full permission ID.':'Include the full action ID.';
    try {
      if(command[1]==='revoke') {
        await this.tools.revoke(owner,{id:command[2],operation_id},source);
        return 'Permission revoked. Already-started operations cannot be undone.';
      }
      controlled=!!(await this.access.stores.control.query('SELECT 1 FROM controlled_actions WHERE id=$1',[command[2]])).rowCount;
      const action=controlled?await this.tools.inspect(owner,command[2]):await this.telegram.inspect(owner,command[2]);
      const args=canonical(action.arguments);
      if(controlled&&args.length>2200&&['action','approve'].includes(command[1]!))return `${action.kind} · ${action.state}\nArguments are too long to review in Telegram. Open the dashboard Inbox to review and approve this action in full.\nID: ${action.id}`;
      if(command[1]==='action')return controlled?
        `${action.kind} · ${action.state}\nProfile: ${action.logical_profile}\nExact arguments:\n${exactJson(action.arguments)}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`:
        `Telegram destination: ${action.arguments.destination}\nStatus: ${action.state}\nExact message:\n${action.arguments.text}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`;
      const body={id:action.id,fingerprint:action.fingerprint,decision:command[1],operation_id};
      const result=controlled?await this.tools.decide(owner,body,source):await this.telegram.decide(owner,body,source);
      await this.settle(controlled?'controlled':'telegram',result.id);
      return `Action ${result.id} ${result.state}.`;
    }catch(error) {
      if(error instanceof HttpError&&controlled&&outdated.has(error.code)){const {line}=await this.texts();return fillTemplate(line.not_run,{reason:line.reason_changed});}
      if(error instanceof HttpError&&[400,403,404,409].includes(error.status))return error.code==='action_not_found'?'Action not found.':
        error.code==='permission_not_found'?'Permission not found.':'This action or permission cannot be changed in its current state. Review it in the dashboard Inbox.';
      throw error;
    }
  }
}
