import {canonical} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {approvalAction,approvalCard,approvalLines,fillTemplate,labeledLines,ownerPrompts,problemButtons,type ApprovalText} from '../prompts.js';
import {retryFailedWorkflows} from './workflow-owner.js';
import {evaluate} from '../security/store.js';
import type {Effect} from '../security/contract.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {ControlledActionRepository} from './controlled-actions.js';
import type {BackgroundJobRepository} from './background-jobs.js';

type ActionKind='telegram'|'controlled'|'background';
// Telegram allows 64 bytes of button data: a marker, the choice, and prefixes
// of the action ID and of the fingerprint of its exact content.
const buttonData=/^n([ad])([a-f0-9]{40})([a-f0-9]{16})$/;
/** The Retry failed button under a problem notice in the owner's private chat. */
export const retryButton='nr';
const reviewLimit=2200;
// While a card is filled, \u0001N\u0002label\u0003 marks a label linked to the Nth
// address. These control characters are removed from every other text first.
const controls=/[\u0001-\u0003]/g,marked=/\u0001(\d+)\u0002([^\u0001-\u0003]*)\u0003/g;
const clean=(value:unknown,length=100)=>typeof value==='string'&&value.replace(controls,'').trim()?value.replace(controls,'').replace(/\s+/g,' ').trim().slice(0,length):null;
type Link={offset:number;length:number;url:string};
type Mark=(label:string,url:string|null)=>string;

/** Plain card text with Telegram text links; offsets count UTF-16 units, as Telegram's do. */
function linked(text:string,urls:string[]):{text:string;links:Link[]} {
  let plain='',last=0;const links:Link[]=[];
  for(const match of text.matchAll(marked)) {
    plain+=text.slice(last,match.index);
    if(match[2])links.push({offset:plain.length,length:match[2].length,url:urls[Number(match[1])]!});
    plain+=match[2];last=match.index+match[0].length;
  }
  return {text:plain+text.slice(last),links};
}

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
    readonly call?:RuntimeCall,readonly jobs?:BackgroundJobRepository){}
  private async approval(input:Record<string,unknown>,timeout=15000) {
    if(!this.call)return null;
    try{return await this.call('telegram.approval',input,timeout);}catch{return null;}
  }
  /** Where a live request was asked: its chat, topic and message. Null for background work. */
  private async asked(source:any):Promise<{chat:string;topic?:string;message?:string}|null> {
    if(source?.store!=='archive')return null;
    const original=await this.access.archive.verify(source);
    if(original.origin!=='live'||original.channel!=='telegram')return null;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0];
    let message:any=null;try{const payload=JSON.parse(row.payload.toString());message=payload.message??payload.edited_message;}catch{}
    const id=String(message?.message_id??''),topic=message?.is_topic_message===true?String(message.message_thread_id??''):'';
    return {chat:String(original.scope),...(/^[1-9][0-9]{0,15}$/.test(topic)?{topic}:{}),...(/^[1-9][0-9]{0,15}$/.test(id)?{message:id}:{})};
  }
  /** The owner's card templates and texts from Settings › Instructions, or the defaults. */
  private async texts() {
    const prompts=await ownerPrompts(this.access.stores.control);
    return {card:prompts['telegram.approval_card']??approvalCard,action:prompts['telegram.approval_action']??approvalAction,
      line:approvalLines(prompts['telegram.approval_texts'])};
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
  /** The exact content to decide on, or null when it is too long to review in Telegram. */
  private async card(kind:ActionKind,id:string,source:any,reviewed=false):Promise<{text:string;links:Link[];fingerprint:string;state:string;line:Record<ApprovalText,string>}|null> {
    const owner={admin:true,scope:null},texts=await this.texts(),urls:string[]=[];
    const line=Object.fromEntries(Object.entries(texts.line).map(([key,value])=>[key,value.replace(controls,'')])) as Record<ApprovalText,string>;
    const mark:Mark=(label,url)=>url?`\u0001${urls.push(url)-1}\u0002${label}\u0003`:label;
    // The card under a request in its own chat does not say where it was asked.
    const asked=reviewed?null:await this.asked(source);
    const origin=asked&&asked.chat!==this.access.policy().owner_id?await this.where(asked.chat,line,mark,{topic:asked.topic,message:asked.message}):null;
    if(kind==='telegram') {
      const action=await this.telegram.inspect(owner,id),[chat,topic]=String(action.arguments.destination).split('/topic/');
      const place=await this.where(chat!,line,mark,{topic,showTopic:true});
      const filled=fillTemplate(texts.card.replace(controls,''),{destination:place,origin,text:String(action.arguments.text).replace(controls,'')});
      return {...linked(filled,urls),fingerprint:action.fingerprint,state:action.state,line};
    }
    const action=await this.tools.inspect(owner,id),args=canonical(action.arguments);
    if(args.length>reviewLimit)return null;
    const filled=fillTemplate(texts.action.replace(controls,''),{kind:action.kind,origin,arguments:args.replace(controls,'')});
    return {...linked(filled,urls),fingerprint:action.fingerprint,state:action.state,line};
  }
  private outcome(kind:ActionKind,state:string,line:Record<ApprovalText,string>) {
    if(state==='proposed')return null;
    if(state==='rejected')return kind==='telegram'?line.rejected:line.rejected_action;
    if(state==='cancelled')return line.cancelled;
    if(state==='done')return kind==='telegram'?line.sent:line.done;
    if(['failed','ambiguous'].includes(state))return line.failed;
    return kind==='telegram'?line.sending:line.approved;
  }
  /** Offer buttons on a new pending action to whoever reviews it; best
   * effort, the owner's Inbox always remains. */
  async offer<T extends Record<string,any>>(kind:ActionKind,result:T):Promise<T> {
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
      const place=await this.place(kind,result.id),card=place?await this.card(kind,result.id,row.source_reference,!!place.reviewer):null;
      if(!place||!card||card.state!=='proposed')return result;
      // In the chat and topic where it was asked, the card answers the request itself.
      const asked=await this.asked(row.source_reference);
      const here=asked&&asked.chat===place.chat&&(asked.topic??'')===(place.topic??'')?asked.message??null:null;
      const sent=await this.approval({kind:'card',chat_id:place.chat,...(place.topic?{topic:place.topic}:{}),...(here?{reply_to:here}:{}),id:result.id,
        text:card.text,links:card.links,
        buttons:[[card.line.approve.slice(0,40),'na'+result.id.slice(0,40)+card.fingerprint.slice(0,16)],[card.line.reject.slice(0,40),'nd'+result.id.slice(0,40)+card.fingerprint.slice(0,16)]]});
      if(sent?.state!=='done')return result;
      return {...result,message:here?
        'A card with Approve and Reject buttons for this exact request was posted here as the reply to it. It names where the message goes and shows it exactly, so it is the whole answer: do not repeat or announce it; return [NO_REPLY] unless something else needs an answer.':
        place.reviewer?
        'This exact message for the other group was posted here with Approve and Reject buttons for the person who asked; nothing is sent until they press Approve. Say only, briefly, that they can check and approve it; do not repeat the draft.':
        asked&&asked.chat!==owner?
        'The owner was asked privately, with Approve and Reject buttons, to approve this exact request. In this chat say only, briefly, that you asked the owner; do not show the draft or details.':
        'Approve and Reject buttons for this exact request were sent to you in this chat. It waits for your decision; it can also be reviewed in the dashboard Inbox.'};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /** Where a job's card goes: the chat and topic where it was asked, or the owner's private chat
   * when the owner approves a member's job. */
  private async jobPlace(row:any):Promise<{chat:string;topic?:string;here:string|null}> {
    const owner=this.access.policy().owner_id!;
    if(row.approver==='owner')return {chat:owner,here:null};
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
      return {...result,message:card.row.approver==='owner'&&card.row.requester?
        'The owner was asked privately, with Approve and Reject buttons, to approve this job, because its cost is over what a member may start. Say so briefly with the estimate; nothing runs until the owner approves.':
        'A card with Approve and Reject buttons for this job was posted here as the reply to the request. It shows the job, its size, time and cost, so say at most one short sentence; nothing runs until it is approved.'};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /** A decided job's card keeps its text, shows where the job is and loses its buttons. */
  private async settleJob(id:string) {
    if(!this.jobs)return;
    const card=await this.jobs.card(id),place=await this.jobPlace(card.row),state=card.row.cancel_requested&&card.state!=='done'?'stopped':card.state;
    const outcome=state==='approved'&&card.waiting?card.lines.queued:['approved','running','reporting'].includes(state)?card.lines.running:card.lines[state];
    if(outcome)await this.approval({kind:'settle',chat_id:place.chat,id,text:`${card.text}\n\n${outcome}`,links:[]});
  }
  /** Show the decision on a card and remove its buttons; best effort. */
  async settle(kind:ActionKind,id:string) {
    try {
      if(kind==='background')return await this.settleJob(id);
      const table=kind==='telegram'?'telegram_action_requests':'controlled_actions';
      const row=(await this.access.stores.control.query(`SELECT source_reference FROM ${table} WHERE id=$1`,[id])).rows[0];
      const place=row?await this.place(kind,id):null,card=place?await this.card(kind,id,row.source_reference,!!place.reviewer):null,outcome=card?this.outcome(kind,card.state,card.line):null;
      if(place&&card&&outcome)await this.approval({kind:'settle',chat_id:place.chat,id,text:`${card.text}\n\n${outcome}`,links:card.links});
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
      UNION ALL SELECT 'background',id,fingerprint FROM background_jobs WHERE left(id,40)=$1`,[data[2]])).rows;
    const action=found.length===1&&found[0].fingerprint.startsWith(data[3])?found[0]:null,presser=String(query.from?.id??'');
    if(action?.kind==='background'&&this.jobs)return this.jobPressed(action,data[1]==='a',presser,chat,query.id,source);
    const reviewer=action?.kind==='telegram'?(await this.telegram.reviewer(action.id))?.user:undefined;
    // The owner decides any card; the person who asked decides only their own card in their group.
    if(!policy.owner_id||presser!==policy.owner_id&&!(reviewer&&presser===reviewer&&chat===(await this.place('telegram',action.id))?.chat)){
      await answer(reviewer?line.only_requester:line.only_owner);return true;}
    if(!action){await answer(line.changed);return true;}
    const kind=action.kind as ActionKind,decision=data[1]==='a'?'approve':'deny',owner={admin:true,scope:null};
    const body={id:action.id,fingerprint:action.fingerprint,decision,operation_id:'telegram-button:'+source.id};
    let reply:string;
    try {
      const result=kind==='telegram'?await this.telegram.decide(owner,body,source):await this.tools.decide(owner,body,source);
      reply=result.state==='rejected'?(kind==='telegram'?line.rejected:line.rejected_action):line.approved;
    }catch(error) {
      if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;
      reply=line.decided;
    }
    await answer(reply);await this.settle(kind,action.id);return true;
  }
  /** Approve or Reject on a job's card: the owner, or the person who asked on their own job's card. */
  private async jobPressed(action:{id:string;fingerprint:string},approve:boolean,presser:string,chat:string,query:string,source:SourceReference):Promise<boolean> {
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
    await answer(reply);await this.settle('background',action.id);return true;
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
    const owner={admin:true,scope:null},operation_id='telegram-command:'+source.id;
    if(command[1]==='actions') {
      const tools=(await this.tools.list(owner)).actions,telegram=await this.telegram.list(owner);
      const rows=[...tools,...telegram].filter(row=>['proposed','approved','running','ambiguous'].includes(row.state))
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
      const controlled=!!(await this.access.stores.control.query('SELECT 1 FROM controlled_actions WHERE id=$1',[command[2]])).rowCount;
      const action=controlled?await this.tools.inspect(owner,command[2]):await this.telegram.inspect(owner,command[2]);
      const args=canonical(action.arguments);
      if(controlled&&args.length>2200&&['action','approve'].includes(command[1]!))return `${action.kind} · ${action.state}\nArguments are too long to review in Telegram. Open the dashboard Inbox to review and approve this action in full.\nID: ${action.id}`;
      if(command[1]==='action')return controlled?
        `${action.kind} · ${action.state}\nProfile: ${action.logical_profile}\nExact arguments:\n${args}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`:
        `Telegram destination: ${action.arguments.destination}\nStatus: ${action.state}\nExact message:\n${action.arguments.text}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`;
      const body={id:action.id,fingerprint:action.fingerprint,decision:command[1],operation_id};
      const result=controlled?await this.tools.decide(owner,body,source):await this.telegram.decide(owner,body,source);
      await this.settle(controlled?'controlled':'telegram',result.id);
      return `Action ${result.id} ${result.state}.`;
    }catch(error) {
      if(error instanceof HttpError&&[400,403,404,409].includes(error.status))return error.code==='action_not_found'?'Action not found.':
        error.code==='permission_not_found'?'Permission not found.':'This action or permission cannot be changed in its current state. Review it in the dashboard Inbox.';
      throw error;
    }
  }
}
