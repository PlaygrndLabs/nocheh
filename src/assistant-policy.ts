import { readFileSync } from 'node:fs';
import { HttpError, object } from './http.js';
import { accountIdFor, chats, chatsAfterMiss, isChatId } from './chats.js';
import { isTelegramAccount, isTelegramChat } from './chats-telegram.js';
import { isProxyAccount } from './chats-telegram-updates.js';
import { freshMembers, members } from './members.js';
import { boundReader, boundReaderReadOnly, type Reader } from './access.js';
import { memberPrivate, otherPrivate } from './spaces.js';

/** Whether every topic of a group shares one memory ('group', the default) or each topic keeps its own ('topic'). */
export type TopicMemory='group'|'topic';
export interface AssistantPolicy {enabled:boolean;
  /** The owner's account: the owner's Telegram user id. Compared only with a sender (who sent, pressed or asked). */
  owner_id:string|null;
  /** Derived, never configured: the raw Telegram ids (current and old) of the active groups, which servedPolicy (stores/chats.ts)
   * fills from the chat directory, for comparing archive originals only. Settings and policy files never set it, and a
   * Nocheh chat is served when the directory says so (chats().served), never by finding its id here (ADR-0252, ADR-0253). */
  group_ids:string[];topic_memory?:TopicMemory;
  /** The owner's private chat, a Nocheh chat id: where the owner talks to Nocheh, separate from the owner's account.
   * Absent in a policy written before step 2b, where the owner's private chat is the chat named by owner_id. */
  owner_chat?:string|null}
/** The owner's private chat (ADR-0252): policy.owner_chat, or for a policy without one the chat owner_id names. */
export const ownerChat=(policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'>):string|null=>policy.owner_chat===undefined?policy.owner_id:policy.owner_chat;
/** The owner as stored rows name them: their private chat (a row's chat) and their account (who asked or decided). */
export interface OwnerIds {chat:string|null;account:string|null}
export const ownerIds=(policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'>):OwnerIds=>({chat:ownerChat(policy),account:policy.owner_id});
/**
 * The configured policy. Which groups Nocheh serves is never configured: the owner adds Nocheh to a group or turns it on
 * in Chats (chats.state, ADR-0253), so TELEGRAM_GROUP_IDS is not read and a policy file's group_ids is ignored; group_ids
 * starts empty and servedPolicy fills it from the chat directory.
 */
export function assistantPolicy(path?:string):AssistantPolicy {
  const enabled=process.env.TELEGRAM_ENABLED ?? 'false';
  if (!path && !['true','false'].includes(enabled)) throw new Error('Invalid TELEGRAM_ENABLED');
  const value=path ? object(JSON.parse(readFileSync(path,'utf8'))) : {
    enabled:enabled==='true',owner_id:process.env.TELEGRAM_OWNER_ID || null,
    topic_memory:process.env.TELEGRAM_TOPIC_MEMORY || 'group',
  };
  if (typeof value.enabled!=='boolean' || (value.owner_id!==null && (typeof value.owner_id!=='string' || !/^[1-9]\d{0,18}$/.test(value.owner_id))) ||
      (value.enabled && !value.owner_id) || !['group','topic',undefined].includes(value.topic_memory as string|undefined)) throw new Error('Invalid assistant policy');
  // Step 2b-1 seeds the owner's private chat under the id it always had: the owner's Telegram user id.
  const ownerChatId=(value as Record<string,unknown>).owner_chat===undefined?value.owner_id as string|null:(value as Record<string,unknown>).owner_chat;
  if(ownerChatId!==null&&!isChatId(ownerChatId)||ownerChatId===null&&value.owner_id!==null)throw new Error('Invalid assistant policy');
  return {enabled:value.enabled,owner_id:value.owner_id as string|null,group_ids:[],topic_memory:(value.topic_memory as TopicMemory|undefined)??'group',
    owner_chat:ownerChatId as string|null};
}
/** A Telegram user's account (chat_accounts id), or null for a value that names none. */
export const telegramAccount=(user:string|null|undefined):string|null=>{if(!user)return null;try{return accountIdFor('telegram',user);}catch{return null;}};
/**
 * Whether a person (a raw Telegram user id) may talk to Nocheh in `chat` (a group or one of its topics): the owner, or a
 * member who talks there (members().talks: the group is served, the member active with talk on, and the group's switch
 * on or never set, step 3). Owner first, so the owner's outcome never depends on the member directory. A proxy account
 * (an anonymous admin, a channel, Telegram's service account) is nobody and never talks.
 */
export function talksIn(policy:Pick<AssistantPolicy,'owner_id'>,chat:string,user:string):boolean {
  if(policy.owner_id!==null&&user===policy.owner_id)return true;
  if(isProxyAccount(user))return false;
  return members().talks(telegramAccount(user),chat);
}
/**
 * Who wrote a live Telegram message in `scope` (its raw Telegram chat id), whether or not they may talk there: the owner,
 * or a person's account. Null for an edit or anything but a message, one in a channel's or group's own name (sender_chat),
 * one from a bot or a proxy account, and one it cannot read. For the effect sites that check a member again (step 3).
 */
export function messageSender(policy:Pick<AssistantPolicy,'owner_id'>,payload:unknown,scope:string):{owner:true;account:null}|{owner:false;account:string}|null {
  const message=payload!==null&&typeof payload==='object'?(payload as Record<string,any>).message:null;
  const sender=message!==null&&typeof message==='object'?message.from:null;
  if(!sender||typeof sender!=='object'||sender.is_bot===true||message.sender_chat!==undefined&&message.sender_chat!==null||String(message.chat?.id)!==scope)return null;
  const user=typeof sender.id==='number'||typeof sender.id==='string'?String(sender.id):'';
  if(!isTelegramAccount(user)||isProxyAccount(user))return null;
  if(policy.owner_id!==null&&user===policy.owner_id)return {owner:true,account:null};
  const account=telegramAccount(user);
  return account?{owner:false,account}:null;
}
/**
 * Whom a live message turn is for, as conversationScope admits it: the owner (in their own private chat or a served
 * group), a member who talks in a served group, or a member in their own private chat with Nocheh (step 4, ADR-0262).
 * `member` (a members.id) is set only for the last: it says the turn reads and answers as that member's own private
 * chat, never as the owner and never as a group.
 */
export interface ConversationScope {owner:boolean;chat_id:string;user_id:string;member?:string}
/**
 * Whom a live Telegram message comes from, and in which chat Nocheh may answer it: the owner in their own private
 * chat, the owner or a member who talks there (talksIn) in a served group, or a member in their own private chat when
 * the member directory admits it (privateTalks: active, private chat on; group talk and group switches do not count,
 * step 4). A message in a channel's or group's own name (sender_chat) or from a proxy account is nobody's, so it is
 * never admitted in a group. `scope` is the archive's raw Telegram chat id; chat_id is the Nocheh chat it names, from the
 * chat directory (ADR-0252), so a chat with no row is answered nowhere (ADR-0242).
 */
export function conversationScope(policy:AssistantPolicy,payload:unknown,scope:string):ConversationScope|null {
  if (!policy.enabled) return null;
  const update=object(payload);
  if (!update.message) return null; // Edits, reactions and callbacks are archived without creating old replies.
  const message=object(update.message),chat=object(message.chat),sender=object(message.from ?? {});
  if (String(chat.id)!==scope) throw new HttpError(400,'source_scope_mismatch');
  if (sender.is_bot===true || !sender.id) return null;
  const directory=chats(),id=isTelegramChat(scope)?directory.resolve('telegram',scope):null;
  if (id===null) return null;
  const owner=chat.type==='private' && directory.kind(id)==='private' && id===ownerChat(policy) && String(sender.id)===policy.owner_id;
  if (owner) return {owner,chat_id:id,user_id:String(sender.id)};
  if (chat.type==='private') {
    const member=privateMember(policy,id,String(sender.id),String(chat.id));
    return member===null?null:{owner:false,chat_id:id,user_id:String(sender.id),member};
  }
  if (!['group','supergroup'].includes(String(chat.type)) || directory.kind(id)!=='group' || !directory.served(id)) return null;
  if (message.sender_chat!==undefined && message.sender_chat!==null || isProxyAccount(String(sender.id))) return null;
  if (!talksIn(policy,id,String(sender.id))) return null;
  return {owner,chat_id:id,user_id:String(sender.id)};
}
/**
 * The member whose own private chat `chat` (a Nocheh chat id) is, when that member may talk to Nocheh there now; else
 * null. The chat is a private chat itself (never a topic) that is not the owner's, its person (chats.account_id) wrote
 * the message (`user`, the sender, is the chat's own Telegram id `external`, as in every private chat), the person is
 * not the owner nor a proxy account, and the member directory admits them (memberPrivate: active, private chat on).
 * A stranger, a paused or removed member and one with private chat off get null, and so the fixed private reply.
 */
function privateMember(policy:Pick<AssistantPolicy,'owner_id'>,chat:string,user:string,external:string):string|null {
  const directory=chats(),row=directory.get(chat);
  if(!row||row.kind!=='private'||row.owner||user!==external||!isTelegramAccount(user)||isProxyAccount(user))return null;
  if(policy.owner_id!==null&&user===policy.owner_id)return null;
  const account=telegramAccount(user);
  if(account===null||row.account_id!==account||!memberPrivate(chat,directory))return null;
  return members().memberOf(account)?.id??null;
}
/**
 * Why a reader may not have Nocheh do anything but read and answer (ADR-0249, step 4): the read-only code of its bound
 * reader (an "Answer privately" answer, a member in their own private chat, the owner's ask about a member), or, for a
 * turn whose chat is a private chat that is not the owner's without a member bound to it, the member code too (fail
 * closed: such a turn may only ever be a member's). Null for every other reader. Every effect site asks this before it
 * records anything.
 */
export function readOnlyReader(principal:Pick<Reader,'scope'|'space'|'answer'|'member'|'memberRead'>):string|null {
  const bound=boundReader(principal);
  if(bound!==null)return boundReaderReadOnly[bound];
  return otherPrivate(principal.scope)||otherPrivate(principal.space)?boundReaderReadOnly.member:null;
}
/** readOnlyReader as a refusal: 403 with the reader's read-only code. */
export function assertActingReader(principal:Pick<Reader,'scope'|'space'|'answer'|'member'|'memberRead'>):void {
  const code=readOnlyReader(principal);if(code!==null)throw new HttpError(403,code);
}

/**
 * Whether a captured Telegram message, new or edited, or a reaction, was sent by the owner or by a member who talks in
 * that served group (talksIn). Telegram does not say who an anonymous admin is, nor who wrote a post or reacted in a
 * channel's or group's own name (sender_chat, actor_chat), so none of them counts as a member, nor as the owner; neither
 * do bots, proxy accounts, reaction counts, other updates and senders it cannot identify (ADR-0251). Unlike
 * conversationScope, it reads edits and reactions and does not depend on Telegram replies being on. `scope` is the
 * archive's raw Telegram chat id; the group is the chat the directory finds for it, so a chat with no row allows only
 * the owner (ADR-0252).
 */
export function allowedSender(policy:AssistantPolicy,payload:unknown,scope:string):boolean {
  if(payload===null||typeof payload!=='object'||Array.isArray(payload))return false;
  const update=payload as Record<string,unknown>,reaction=update.message_reaction,found=update.message??update.edited_message??reaction;
  if(found===null||typeof found!=='object'||Array.isArray(found))return false;
  // A reaction names who reacted as `user`, or the chat it was made in the name of as `actor_chat`.
  const message=found as Record<string,unknown>,chat=message.chat as Record<string,unknown>|undefined,
    sender=(found===reaction?message.user:message.from) as Record<string,unknown>|undefined;
  if(message.sender_chat!==undefined&&message.sender_chat!==null||message.actor_chat!==undefined&&message.actor_chat!==null)return false;
  if(!chat||typeof chat!=='object'||!sender||typeof sender!=='object'||sender.is_bot===true)return false;
  const user=typeof sender.id==='number'||typeof sender.id==='string'?String(sender.id):'';
  if(!isTelegramAccount(user)||String(chat.id)!==scope)return false;
  if(policy.owner_id!==null&&user===policy.owner_id)return true;
  if(!['group','supergroup'].includes(String(chat.type)))return false;
  const directory=chats(),id=isTelegramChat(scope)?directory.resolve('telegram',scope):null;
  if(id===null||directory.kind(id)!=='group'||!directory.served(id))return false;
  return talksIn(policy,id,user);
}

/**
 * Whether an archived event may go into the owner's own notes review: a live Telegram update only from an allowed
 * sender (allowedSender), Nocheh's own messages in the owner's chat or a group, and the owner's web chat always. Nocheh's
 * messages in anyone else's private chat (a member's, step 4) or in a chat the directory does not know are refused. Any
 * other kind is refused, so a kind added later stays out until it is named here. Group memory and replies do not ask this.
 */
export function notesSender(policy:AssistantPolicy,event:{channel:string;kind:string;scope:string;payload:unknown}):'review'|'sender_not_allowed' {
  if(event.channel==='telegram'&&event.kind==='telegram_update')return allowedSender(policy,event.payload,event.scope)?'review':'sender_not_allowed';
  if(event.channel==='telegram'&&event.kind==='telegram_delivered_message') {
    const directory=chats(),id=isTelegramChat(event.scope)?directory.resolve('telegram',event.scope):null;
    return id!==null&&(id===ownerChat(policy)&&directory.kind(id)==='private'||directory.kind(id)==='group')?'review':'sender_not_allowed';
  }
  if(event.channel==='browser'&&['browser_input','browser_delivered_message'].includes(event.kind))return 'review';
  return 'sender_not_allowed';
}

/**
 * A live Telegram update from a chat Nocheh does not serve: a private chat with
 * anyone but the owner, a group or channel that is not active, or a chat
 * the chat directory does not know (ADR-0252). It is kept as received, but never
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
 * Whether a live Telegram update that outsideChat keeps out is from a member's own private chat that is open now
 * (memberPrivate, step 4): it is prepared like the owner's, so the member's turn can read it. Read, learned from and
 * shown to the owner's turns it still is not: storage reads such a chat only for the reader bound to it. Skipping is
 * final, so a member this process has not loaded yet (added or switched on a moment ago) is looked up again first.
 * Only nocheh-app holds a member directory; without one no chat is admitted here.
 */
export async function preparedMemberChat(policy:AssistantPolicy,source:{origin:string;channel:string;kind:string;scope:string}):Promise<boolean> {
  if(!policy.enabled||!policy.owner_id||source.origin!=='live'||source.channel!=='telegram'||source.kind!=='telegram_update'||!isTelegramChat(source.scope))return false;
  const id=chats().resolve('telegram',source.scope);
  if(id===null||chats().kind(id)!=='private'||chats().isOwner(id))return false;
  if(memberPrivate(id))return true;
  await freshMembers();
  return memberPrivate(id);
}

/**
 * For a decision that cannot be taken back (a turn refused, a message left unprepared): when this process's chat
 * directory does not hold the Telegram chat a live original came from, or holds it but does not serve it, waits until
 * the loader has looked again (ADR-0252). The capture that recorded the chat, a served group's new id after an
 * upgrade, or the owner's add that turned it on (ADR-0253) commits before its workflows run, but this process may not
 * have reloaded yet. A chat still unknown or unserved afterwards stays so, and the caller fails closed as before.
 */
export async function settleTelegramChat(source:{channel:string;scope:string}):Promise<void> {
  if(source.channel!=='telegram'||!isTelegramChat(source.scope))return;
  const id=chats().resolve('telegram',source.scope);
  if(id===null||!chats().served(id))await chatsAfterMiss();
}

/** Final Telegram send authorization uses the captured original, never a prepared representation. An answer reader's
 * pass (ADR-0249) delivers only into the owner's own private chat, from the owner's own update there, and only with
 * its read set bound from its open record; never into a group. The owner's ask about a member (memberRead, step 4b)
 * delivers the same way, only into the owner's own private chat from the owner's own update there, and only with the
 * asked member's chat bound from its running record. A member in their own private chat (step 4) delivers only into
 * that chat, from their own update there, and only with that very chat bound as theirs. */
export function telegramDeliveryAllowed(policy:AssistantPolicy,principal:{scope:string|null;answer?:string;reads?:unknown;member?:string;memberRead?:string;memberChat?:string},
  source:{origin:string;channel:string;kind:string;scope:string;payload:Buffer}|null):boolean {
  if(!source)return false;
  // Every bound reader answers only in Telegram and only with its reads bound for this request; one bound to a member's
  // chat (a member, or the owner's ask about a member) only with that chat bound too.
  const bound=boundReader(principal);
  if(bound!==null&&(source.channel!=='telegram'||!principal.reads))return false;
  if((bound==='member'||bound==='memberRead')&&!principal.memberChat)return false;
  if(source.channel!=='telegram')return true;
  if(source.origin!=='live'||source.kind!=='telegram_update')return false;
  try {
    const selected=conversationScope(policy,JSON.parse(source.payload.toString()),source.scope) as {owner:boolean;chat_id:string;member?:string}|null;
    if(bound==='answer'||bound==='memberRead')return !!selected&&selected.owner&&selected.chat_id===principal.scope;
    if(bound==='member')return !!selected&&!selected.owner&&selected.member===principal.member&&selected.chat_id===principal.scope&&
      principal.memberChat===principal.scope;
    // A private chat that is not the owner's delivers only for its own member's reader (fail closed).
    if(selected&&!selected.owner&&chats().kind(selected.chat_id)==='private')return false;
    return !!selected&&(selected.owner?null:selected.chat_id)===principal.scope;
  }catch{return false;}
}
