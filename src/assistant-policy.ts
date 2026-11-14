import { readFileSync } from 'node:fs';
import { HttpError, object } from './http.js';
import { chats, chatsAfterMiss, isChatId } from './chats.js';
import { isTelegramChat } from './chats-telegram.js';

export interface GroupAccess {granted:string[];denied:string[]}
/** Whether every topic of a group shares one memory ('group', the default) or each topic keeps its own ('topic'). */
export type TopicMemory='group'|'topic';
export interface AssistantPolicy {enabled:boolean;
  /** The owner's account: the owner's Telegram user id. Compared only with a sender (who sent, pressed or asked). */
  owner_id:string|null;
  /** Raw Telegram ids (current and old) of the served groups, for comparing archive originals only. A Nocheh chat is
   * served when the chat directory says so (chats().served), never by finding its id here (ADR-0250). */
  group_ids:string[];group_access?:Record<string,GroupAccess>;topic_memory?:TopicMemory;
  /** The owner's private chat, a Nocheh chat id: where the owner talks to Nocheh, separate from the owner's account.
   * Absent in a policy written before step 2b, where the owner's private chat is the chat named by owner_id. */
  owner_chat?:string|null}
/** The owner's private chat (ADR-0250): policy.owner_chat, or for a policy without one the chat owner_id names. */
export const ownerChat=(policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'>):string|null=>policy.owner_chat===undefined?policy.owner_id:policy.owner_chat;
/** The owner as stored rows name them: their private chat (a row's chat) and their account (who asked or decided). */
export interface OwnerIds {chat:string|null;account:string|null}
export const ownerIds=(policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'>):OwnerIds=>({chat:ownerChat(policy),account:policy.owner_id});
export function groupAccess(value:unknown,groups:string[],owner:string|null):Record<string,GroupAccess> {
  const input=object(value),result:Record<string,GroupAccess>={};
  if(Object.keys(input).length>100)throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
  for(const [group,raw] of Object.entries(input)) {
    if(!groups.includes(group))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
    const entry=object(raw);
    if(Object.keys(entry).some(key=>!['granted','denied'].includes(key))||!Array.isArray(entry.granted)||!Array.isArray(entry.denied))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
    const normalize=(values:unknown[]):string[]=>{
      if(values.length>1000||values.some(id=>typeof id!=='string'||!/^[1-9]\d{0,18}$/.test(id)||id===owner))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
      return [...new Set(values as string[])].sort();
    };
    result[group]={granted:normalize(entry.granted),denied:normalize(entry.denied)};
  }
  return result;
}
export function assistantPolicy(path?:string):AssistantPolicy {
  const enabled=process.env.TELEGRAM_ENABLED ?? 'false';
  if (!path && !['true','false'].includes(enabled)) throw new Error('Invalid TELEGRAM_ENABLED');
  const value=path ? object(JSON.parse(readFileSync(path,'utf8'))) : {
    enabled:enabled==='true',owner_id:process.env.TELEGRAM_OWNER_ID || null,
    group_ids:(process.env.TELEGRAM_GROUP_IDS ?? '').split(',').map(v=>v.trim()).filter(Boolean),
    group_access:JSON.parse(process.env.TELEGRAM_GROUP_ACCESS ?? '{}'),
    topic_memory:process.env.TELEGRAM_TOPIC_MEMORY || 'group',
  };
  if (typeof value.enabled!=='boolean' || (value.owner_id!==null && (typeof value.owner_id!=='string' || !/^[1-9]\d{0,18}$/.test(value.owner_id))) ||
      !Array.isArray(value.group_ids) || value.group_ids.some(v=>typeof v!=='string' || !/^-\d{1,19}$/.test(v)) ||
      (value.enabled && !value.owner_id) || !['group','topic',undefined].includes(value.topic_memory as string|undefined)) throw new Error('Invalid assistant policy');
  // Step 2b-1 seeds the owner's private chat under the id it always had: the owner's Telegram user id.
  const ownerChatId=(value as Record<string,unknown>).owner_chat===undefined?value.owner_id as string|null:(value as Record<string,unknown>).owner_chat;
  if(ownerChatId!==null&&!isChatId(ownerChatId)||ownerChatId===null&&value.owner_id!==null)throw new Error('Invalid assistant policy');
  const groups=[...new Set(value.group_ids as string[])];
  return {enabled:value.enabled,owner_id:value.owner_id as string|null,group_ids:groups,
    group_access:groupAccess(value.group_access??{},groups,value.owner_id as string|null),topic_memory:(value.topic_memory as TopicMemory|undefined)??'group',
    owner_chat:ownerChatId as string|null};
}
/**
 * A served group's access lists (ADR-0250). TELEGRAM_GROUP_ACCESS names a group by a raw Telegram id, which may be the
 * id the group had before Telegram upgraded it, so the lists under every Telegram id the chat has had (current and old)
 * are joined; a person denied under any of them stays denied. Undefined when none names the chat.
 */
export function groupAccessFor(policy:Pick<AssistantPolicy,'group_access'>,chat:string):GroupAccess|undefined {
  const found=chats().rawScopes([chat],'telegram').map(id=>policy.group_access?.[id]).filter((entry):entry is GroupAccess=>!!entry);
  if(!found.length)return undefined;
  const join=(values:string[])=>[...new Set(values)].sort();
  return {granted:join(found.flatMap(entry=>entry.granted)),denied:join(found.flatMap(entry=>entry.denied))};
}
/**
 * Whom a live Telegram message comes from, and in which chat Nocheh may answer it: the owner in their own private
 * chat, or someone allowed in a served group. `scope` is the archive's raw Telegram chat id; chat_id is the Nocheh chat
 * it names, from the chat directory (ADR-0250), so a chat with no row is answered nowhere (ADR-0242).
 */
export function conversationScope(policy:AssistantPolicy,payload:unknown,scope:string):{owner:boolean;chat_id:string;user_id:string}|null {
  if (!policy.enabled) return null;
  const update=object(payload);
  if (!update.message) return null; // Edits, reactions and callbacks are archived without creating old replies.
  const message=object(update.message),chat=object(message.chat),sender=object(message.from ?? {});
  if (String(chat.id)!==scope) throw new HttpError(400,'source_scope_mismatch');
  if (sender.is_bot===true || !sender.id) return null;
  const directory=chats(),id=isTelegramChat(scope)?directory.resolve('telegram',scope):null;
  if (id===null) return null;
  const owner=chat.type==='private' && directory.kind(id)==='private' && id===ownerChat(policy) && String(sender.id)===policy.owner_id;
  if (!owner) {
    if (!['group','supergroup'].includes(String(chat.type)) || directory.kind(id)!=='group' || !directory.served(id)) return null;
    const user=String(sender.id),access=groupAccessFor(policy,id);
    if(user!==policy.owner_id && (!access?.granted.includes(user)||access.denied.includes(user)))return null;
  }
  return {owner,chat_id:id,user_id:String(sender.id)};
}

/**
 * A live Telegram update from a chat Nocheh does not serve: a private chat with
 * anyone but the owner, a group or channel the owner has not selected, or a chat
 * the chat directory does not know (ADR-0250). It is kept as received, but never
 * prepared, learned from or read by the assistant.
 */
export function outsideChat(policy:AssistantPolicy,source:{origin:string;channel:string;kind:string;scope:string}):boolean {
  if(!policy.enabled||!policy.owner_id||source.origin!=='live'||source.channel!=='telegram'||source.kind!=='telegram_update')return false;
  // Updates without a chat (scope "system") are not a conversation anyone holds.
  if(!isTelegramChat(source.scope))return false;
  const directory=chats(),id=directory.resolve('telegram',source.scope);
  return id===null||!(id===ownerChat(policy)&&directory.kind(id)==='private'||directory.kind(id)==='group'&&directory.served(id));
}

/**
 * For a decision that cannot be taken back (a turn refused, a message left unprepared): when this process's chat
 * directory does not hold the Telegram chat a live original came from, waits until the loader has looked again
 * (ADR-0250). The capture that recorded the chat, a served group's new id after an upgrade, commits before its
 * workflows run, but this process may not have reloaded yet. A chat still unknown afterwards stays unknown, so the
 * caller fails closed as before.
 */
export async function settleTelegramChat(source:{channel:string;scope:string}):Promise<void> {
  if(source.channel==='telegram'&&isTelegramChat(source.scope)&&chats().resolve('telegram',source.scope)===null)await chatsAfterMiss();
}

/** Final Telegram send authorization uses the captured original, never a prepared representation. An answer reader's
 * pass (ADR-0249) delivers only into the owner's own private chat, from the owner's own update there, and only with
 * its read set bound from its open record; never into a group. */
export function telegramDeliveryAllowed(policy:AssistantPolicy,principal:{scope:string|null;answer?:string;reads?:unknown},source:{origin:string;channel:string;kind:string;scope:string;payload:Buffer}|null):boolean {
  if(!source)return false;
  if(principal.answer!==undefined&&(source.channel!=='telegram'||!principal.reads))return false;
  if(source.channel!=='telegram')return true;
  if(source.origin!=='live'||source.kind!=='telegram_update')return false;
  try {
    const selected=conversationScope(policy,JSON.parse(source.payload.toString()),source.scope);
    if(principal.answer!==undefined)return !!selected&&selected.owner&&selected.chat_id===principal.scope;
    return !!selected&&(selected.owner?null:selected.chat_id)===principal.scope;
  }catch{return false;}
}
