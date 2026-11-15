/**
 * Part of the Telegram adapter for chat ids (ADR-0251): what one captured Telegram update says about its chat, its
 * topic, the people in it and an upgrade to a supergroup. Pure: it reads the update as Telegram sent it and decides
 * nothing; the chat records store (src/stores/chats.ts) turns these facts into chats, chat_ids, accounts and
 * memberships. Telegram's own id formats stay in src/chats-telegram.ts.
 */
import {isTelegramAccount,isTelegramChat,telegramTopicId} from './chats-telegram.js';

/**
 * Accounts that post on someone else's behalf, so they are never a person in the chat: an anonymous group admin
 * (GroupAnonymousBot), a channel posting in a group (Channel_Bot), and Telegram's service account, which forwards a
 * linked channel's posts into its discussion group.
 */
const proxyAccounts=new Set(['1087968824','136817688','777000']);
const record=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const clean=(value:unknown,length=200):string|null=>typeof value==='string'&&value.trim()?value.replace(/\s+/g,' ').trim().slice(0,length):null;
const external=(value:unknown):string=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'?value:'';
const appTypes=new Set(['private','group','supergroup','channel']);

export interface TelegramPerson {external:string;bot:boolean;display_name:string|null;username:string|null}
export interface TelegramChatFacts {
  /** The chat's Telegram id. */
  external:string;
  /** A private chat with one person, or a group (a basic group, supergroup or channel). */
  kind:'private'|'group';
  /** Telegram's own word for the chat: private, group, supergroup or channel. */
  app_type:string;
  /** A group's title, or the person's name in a private chat. */
  title:string|null;
  is_forum:boolean|null;username:string|null;
}
export interface TelegramMembership {person:TelegramPerson;state:'in'|'left';source:'message'|'event'}
export interface TelegramUpdateFacts {
  /** Telegram's update_id: the order every change from this update is applied in. */
  update_id:number|null;
  chat:TelegramChatFacts|null;
  /** The forum topic a message is in, its name when the message names it, and whether it closed or reopened it. */
  topic:{key:string;name:string|null;closed:boolean|null}|null;
  /** Every account the update names (people and bots), for chat_accounts. */
  people:TelegramPerson[];
  /** Who is in or left the chat. A bot, an anonymous admin, a channel and a sender_chat never count. */
  memberships:TelegramMembership[];
  /** An upgrade from a basic group to a supergroup: the old and the new Telegram id. */
  migration:{from:string;to:string}|null;
  /** The update is a message (or a message edit), which counts as the chat being seen. */
  message:boolean;
}

function person(value:unknown):TelegramPerson|null {
  const actor=record(value),id=external(actor.id);
  if(!isTelegramAccount(id))return null;
  const name=[clean(actor.first_name),clean(actor.last_name)].filter(Boolean).join(' ')||null;
  return {external:id,bot:actor.is_bot===true||proxyAccounts.has(id),display_name:name,username:clean(actor.username,64)?.replace(/^@+/,'')||null};
}
function chat(value:unknown):TelegramChatFacts|null {
  const item=record(value),id=external(item.id),type=clean(item.type,32);
  if(!isTelegramChat(id)||!type||!appTypes.has(type))return null;
  const name=[clean(item.first_name),clean(item.last_name)].filter(Boolean).join(' ')||null;
  return {external:id,kind:type==='private'?'private':'group',app_type:type,title:type==='private'?name:clean(item.title,256),
    is_forum:typeof item.is_forum==='boolean'?item.is_forum:null,username:clean(item.username,64)?.replace(/^@+/,'')||null};
}
/** A chat member's status as Telegram reports it: in the chat, or not. */
function present(member:Record<string,any>):boolean|null {
  const status=member.status;
  if(['creator','administrator','member'].includes(status))return true;
  if(status==='restricted')return member.is_member===true;
  if(['left','kicked'].includes(status))return false;
  return null;
}
/** A topic's name from a message: its own creation or edit, or the root message every forum topic message replies to. */
function topicName(message:Record<string,any>,key:string):string|null {
  const own=clean(record(message.forum_topic_edited).name,128)??clean(record(message.forum_topic_created).name,128);
  if(own)return own;
  const root=record(message.reply_to_message);
  if(external(root.message_id)!==key)return null;
  return clean(record(root.forum_topic_edited).name,128)??clean(record(root.forum_topic_created).name,128);
}

/**
 * The facts in one Telegram update whose archive scope is `scope` (the chat's Telegram id). An update about another
 * chat, or one with no chat, has no chat facts. Membership is only what Telegram shows: a person who sent a message is
 * in, new_chat_members are in, left_chat_member is out, and a chat_member update says either.
 */
export function telegramUpdateFacts(payload:unknown,scope:string):TelegramUpdateFacts {
  const update=record(payload),message=record(update.message??update.edited_message??update.channel_post??update.edited_channel_post);
  const memberUpdate=record(update.chat_member);
  const source=Object.keys(message).length?message.chat:update.chat_member?.chat??update.my_chat_member?.chat??update.message_reaction?.chat??
    update.message_reaction_count?.chat??update.chat_join_request?.chat??update.chat_boost?.chat;
  const found=chat(source),facts:TelegramUpdateFacts={update_id:Number.isSafeInteger(update.update_id)&&update.update_id>=0?update.update_id:null,
    chat:found&&found.external===scope?found:null,topic:null,people:[],memberships:[],migration:null,message:Object.keys(message).length>0};
  if(!facts.chat)return facts;
  const people=new Map<string,TelegramPerson>(),seen=(value:TelegramPerson|null)=>{if(value&&!people.has(value.external))people.set(value.external,value);return value;};
  // One membership per person: what the update says last about them wins, so leaving outranks the leave message's sender.
  const members=new Map<string,TelegramMembership>(),member=(value:TelegramPerson|null,state:'in'|'left',source:'message'|'event')=>{
    if(facts.chat!.kind==='group'&&value&&!value.bot)members.set(value.external,{person:value,state,source});
  };
  if(facts.message) {
    const key=telegramTopicId(message),topic=typeof key==='number'&&Number.isSafeInteger(key)&&key>0?String(key):null;
    if(topic)facts.topic={key:topic,name:topicName(message,topic),closed:'forum_topic_closed' in message?true:'forum_topic_reopened' in message?false:null};
    // A message sent as a chat (a channel or an anonymous admin) names no person.
    const sender=seen(person(message.from));if(message.sender_chat===undefined)member(sender,'in','message');
    for(const value of Array.isArray(message.new_chat_members)?message.new_chat_members.slice(0,100):[])member(seen(person(value)),'in','event');
    member(seen(person(message.left_chat_member)),'left','event');
    const to=external(message.migrate_to_chat_id),from=external(message.migrate_from_chat_id);
    if(isTelegramChat(to)&&to!==scope)facts.migration={from:scope,to};
    else if(isTelegramChat(from)&&from!==scope)facts.migration={from,to:scope};
  }
  if(Object.keys(memberUpdate).length) {
    const update=record(memberUpdate.new_chat_member),state=present(update);seen(person(memberUpdate.from));
    const who=seen(person(update.user));if(state!==null)member(who,state?'in':'left','event');
  }
  facts.memberships=[...members.values()];
  facts.people=[...people.values()];
  return facts;
}
