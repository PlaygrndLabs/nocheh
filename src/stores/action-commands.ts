import {canonical} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {evaluate} from '../security/store.js';
import type {Effect} from '../security/contract.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {ControlledActionRepository} from './controlled-actions.js';

type ActionKind='telegram'|'controlled';
type Place={chat_id:string;topic?:string};
// Telegram allows 64 bytes of button data: a marker, the choice, and prefixes
// of the action ID and of the fingerprint of its exact content.
const buttonData=/^n([ad])([a-f0-9]{40})([a-f0-9]{16})$/;
const reviewLimit=2200;

/** Administrative commands use original owner-DM evidence, never editable text.
 * Approve and Reject buttons are offered on an exact pending action; only the
 * owner's own press decides it, in their private chat or in an allowed group. */
export class ActionCommandRepository {
  constructor(readonly access:SourceAccessRepository,readonly telegram:TelegramActionRepository,readonly tools:ControlledActionRepository,
    readonly call?:RuntimeCall){}
  private async approval(input:Record<string,unknown>,timeout=15000) {
    if(!this.call)return null;
    try{return await this.call('telegram.approval',input,timeout);}catch{return null;}
  }
  /** Where a card goes: the group or topic the request came from when the
   * action stays in that group, otherwise the owner's private chat. */
  private async place(source:any,destination:string|null):Promise<Place|null> {
    const policy=this.access.policy(),owner=policy.owner_id;if(!owner)return null;
    if(source?.store!=='archive')return {chat_id:owner};
    const original=await this.access.archive.verify(source);
    if(original.scope===owner||!policy.group_ids.includes(original.scope)||destination!==null&&destination.split('/topic/')[0]!==original.scope)return {chat_id:owner};
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0];
    const message=row?JSON.parse(row.payload.toString()).message:null,topic=message?.is_topic_message===true&&Number.isSafeInteger(message.message_thread_id)?String(message.message_thread_id):null;
    return {chat_id:original.scope,...(topic?{topic}:{})};
  }
  private async label(destination:string,place:Place) {
    const chat=destination.split('/topic/')[0]!;
    if(chat===this.access.policy().owner_id)return 'your private chat';
    if(chat===place.chat_id)return destination.includes('/topic/')&&destination!==place.chat_id+'/topic/'+place.topic?'another topic of this group':'this chat';
    const title=(await this.access.stores.control.query("SELECT title FROM telegram_chat_observations WHERE chat_id=$1 AND state='available'",[chat])).rows[0]?.title;
    return typeof title==='string'&&title.trim()?`"${title.trim().slice(0,100)}"`+(destination.includes('/topic/')?' (a topic)':''):'another Telegram chat';
  }
  /** The exact content an owner decides on, or null when it is too long to review in Telegram. */
  private async card(kind:ActionKind,id:string,place:Place):Promise<{text:string;fingerprint:string;state:string}|null> {
    const owner={admin:true,scope:null};
    if(kind==='telegram') {
      const action=await this.telegram.inspect(owner,id);
      return {text:`Send this message to ${await this.label(action.arguments.destination,place)}?\n\n${action.arguments.text}`,fingerprint:action.fingerprint,state:action.state};
    }
    const action=await this.tools.inspect(owner,id),args=canonical(action.arguments);
    if(args.length>reviewLimit)return null;
    return {text:`Allow this ${action.kind}?\n\n${args}`,fingerprint:action.fingerprint,state:action.state};
  }
  private outcome(kind:ActionKind,state:string) {
    if(state==='proposed')return null;
    if(state==='rejected')return kind==='telegram'?'Rejected. Nothing was sent.':'Rejected. Nothing ran.';
    if(state==='cancelled')return 'Cancelled. Nothing was sent.';
    if(state==='done')return kind==='telegram'?'Approved and sent.':'Approved and done.';
    if(['failed','ambiguous'].includes(state))return 'Approved. See the dashboard Inbox for the result.';
    return kind==='telegram'?'Approved. Sending now.':'Approved.';
  }
  /** Offer buttons on a new pending action; best effort, the Inbox always remains. */
  async offer<T extends Record<string,any>>(kind:ActionKind,result:T):Promise<T> {
    if(result?.state!=='proposed'||typeof result.id!=='string'||!this.call)return result;
    try {
      const table=kind==='telegram'?'telegram_action_requests':'controlled_actions',control=this.access.stores.control;
      const row=(await control.query(`SELECT * FROM ${table} WHERE id=$1`,[result.id])).rows[0];if(!row)return result;
      // Only an action that waits for the owner gets buttons: a deny rule
      // blocks it anyway, and a standing permission runs it without a decision.
      const effect:Effect=kind==='telegram'?{id:row.id,kind:'telegram.send',scope:row.scope,profile:row.profile,fingerprint:row.fingerprint}:this.tools.effect(row);
      if((await evaluate(control,effect)).outcome!=='ask'||kind==='controlled'&&(await this.tools.grants(row)).length)return result;
      const place=await this.place(row.source_reference,row.destination??null),card=place?await this.card(kind,result.id,place):null;
      if(!place||!card||card.state!=='proposed')return result;
      const sent=await this.approval({kind:'card',...place,id:result.id,text:card.text,
        buttons:[['Approve','na'+result.id.slice(0,40)+card.fingerprint.slice(0,16)],['Reject','nd'+result.id.slice(0,40)+card.fingerprint.slice(0,16)]]});
      if(sent?.state!=='done')return result;
      return {...result,message:(place.chat_id===this.access.policy().owner_id?
        'Approve and Reject buttons for this exact request were sent to the owner\'s private chat. ':
        'Approve and Reject buttons for this exact request were posted in this chat; only the owner can press them. ')+
        'It waits for the owner; it can also be reviewed in the dashboard Inbox.'};
    }catch(error){if(error instanceof HttpError)return result;throw error;}
  }
  /** Show the decision on a card and remove its buttons; best effort. */
  async settle(kind:ActionKind,id:string,at?:Place) {
    try {
      const table=kind==='telegram'?'telegram_action_requests':'controlled_actions';
      const row=(await this.access.stores.control.query(`SELECT source_reference${kind==='telegram'?',destination':''} FROM ${table} WHERE id=$1`,[id])).rows[0];
      const place=at??(row?await this.place(row.source_reference,row.destination??null):null),card=place?await this.card(kind,id,place):null;
      const outcome=card?this.outcome(kind,card.state):null;
      if(place&&card&&outcome)await this.approval({kind:'settle',...place,id,text:`${card.text}\n\n${outcome}`});
    }catch(error){if(!(error instanceof HttpError))throw error;}
  }
  /** A button press: true when it was an approval button, whatever its outcome. */
  async callback(source:SourceReference):Promise<boolean> {
    const original=await this.access.archive.verify(source);
    if(original.kind!=='telegram_update'||original.origin!=='live')return false;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0];
    const query=row?JSON.parse(row.payload.toString()).callback_query:null,data=typeof query?.data==='string'?query.data.match(buttonData):null;
    if(!data||typeof query.id!=='string')return false;
    const chat=String(query.message?.chat?.id??''),policy=this.access.policy();
    const answer=(text:string)=>this.approval({kind:'answer',chat_id:chat,callback_query_id:query.id,text},10000);
    if(!policy.owner_id||String(query.from?.id)!==policy.owner_id){await answer('Only the owner can approve or reject this.');return true;}
    const found=(await this.access.stores.control.query(`SELECT 'telegram' AS kind,id,fingerprint FROM telegram_action_requests WHERE left(id,40)=$1
      UNION ALL SELECT 'controlled',id,fingerprint FROM controlled_actions WHERE left(id,40)=$1`,[data[2]])).rows;
    const action=found.length===1&&found[0].fingerprint.startsWith(data[3])?found[0]:null;
    if(!action){await answer('This request changed or no longer exists. Review it in the dashboard Inbox.');return true;}
    const kind=action.kind as ActionKind,decision=data[1]==='a'?'approve':'deny',owner={admin:true,scope:null};
    const body={id:action.id,fingerprint:action.fingerprint,decision,operation_id:'telegram-button:'+source.id};
    let reply:string;
    try {
      const result=kind==='telegram'?await this.telegram.decide(owner,body,source):await this.tools.decide(owner,body,source);
      reply=result.state==='rejected'?'Rejected.':'Approved.';
    }catch(error) {
      if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;
      reply='This request was already decided or can no longer change. Review it in the dashboard Inbox.';
    }
    const topic=query.message?.is_topic_message===true&&Number.isSafeInteger(query.message.message_thread_id)?String(query.message.message_thread_id):undefined;
    await answer(reply);await this.settle(kind,action.id,{chat_id:chat,...(topic?{topic}:{})});return true;
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
