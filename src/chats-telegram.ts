/**
 * The Telegram adapter for chat ids (ADR-0250). Telegram's own formats are read here and nowhere else: a chat's
 * numeric id, a forum topic's thread id, a t.me/c link, a Telegram Desktop export, and the frozen shape of the chat
 * values Nocheh stored before step 2b. Every other module asks the chat directory (src/chats.ts) what a chat is; it
 * never decides private, group or topic, parent or topic from the shape of an id.
 */

/** A Telegram chat id as the Bot API writes it: negative for groups and channels, positive for private chats. */
const telegramChat='-?[1-9][0-9]{0,18}';
/** A Telegram user id, which is also the id of that user's private chat with the bot. */
const telegramAccount='[1-9][0-9]{0,18}';
/** A forum topic's thread id. */
const telegramThread='[1-9][0-9]{0,15}';
const chatPattern=new RegExp(`^${telegramChat}$`),accountPattern=new RegExp(`^${telegramAccount}$`);
export const isTelegramChat=(value:unknown):value is string=>typeof value==='string'&&chatPattern.test(value);
export const isTelegramAccount=(value:unknown):value is string=>typeof value==='string'&&accountPattern.test(value);

/**
 * The frozen shape of a chat value stored before step 2b: a Telegram chat id, optionally followed by one of its
 * topics. Such a value stays that chat's Nocheh id unchanged; chats first seen later get a digest (chatIdFor). This
 * pattern source is part of the shared chat id check (chatIdPattern, chatIdSql) and must never change.
 */
export const legacyChatSource=`${telegramChat}(?:/topic/${telegramThread})?`;
const legacyPattern=new RegExp(`^(${telegramChat})(?:/topic/(${telegramThread}))?$`);

/** What an old stored chat value names. A topic's parent is its chat's own old value. */
export interface LegacyChat {
  readonly id:string;readonly kind:'private'|'group'|'topic';
  /** The Telegram chat id: the chat's own, or a topic's chat. */
  readonly external:string;
  readonly topic_key:string|null;readonly parent_id:string|null;
  /** The kind of the chat itself, for a topic its parent's. */
  readonly chat_kind:'private'|'group';
}

/**
 * The only reader of the old stored format, used once by the seeder (and by importers of older records and the test
 * fixtures). '-1001000000001' is a group, '-1001000000001/topic/7' its topic 7, '123' a private chat. A negative id
 * counts as a group whatever Telegram calls it (a channel too), as it always has. Anything else is not an old chat
 * value and gets null: 'owner', '*', 'system', 'desktop:*', import scopes and digest ids.
 */
export function legacyChat(value:unknown):LegacyChat|null {
  if(typeof value!=='string')return null;
  const match=legacyPattern.exec(value);if(!match)return null;
  const external=match[1]!,topic=match[2]??null,chat_kind=external.startsWith('-')?'group' as const:'private' as const;
  return topic===null?{id:value,kind:chat_kind,external,topic_key:null,parent_id:null,chat_kind}:
    {id:value,kind:'topic',external,topic_key:topic,parent_id:external,chat_kind};
}

/**
 * A private supergroup's t.me/c link, as the owner pastes it: t.me/c/<internal id>[/<n>[/<n>]]. Returns the Bot API
 * chat id and the numbers after it (a topic, then a message; or a message in a group without topics), or null for
 * anything else, a public username link included (that needs a lookup).
 */
export function parseTelegramLink(link:unknown):{external:string;parts:string[]}|null {
  if(typeof link!=='string')return null;
  const match=link.trim().match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/([1-9][0-9]{0,15})((?:\/[1-9][0-9]{0,15}){0,2})\/?$/);
  return match?{external:'-100'+match[1],parts:match[2]!.split('/').filter(Boolean)}:null;
}

/**
 * The forum topic a Telegram message belongs to. Bot API also sets message_thread_id on a reply
 * chain in an ordinary supergroup (the chain's first message); that is not a topic, and Telegram
 * rejects it as a delivery destination. Same rule as the Hermes adapter's routable thread id.
 */
export function telegramTopicId(message:Record<string,any>):unknown {
  const chat=message.chat&&typeof message.chat==='object'?message.chat:{},raw=message.message_thread_id;
  if(raw===undefined||raw===null)return undefined;
  return (chat.type==='group'||chat.type==='supergroup')&&chat.is_forum===true||message.is_topic_message===true?raw:undefined;
}
// Telegram Desktop names a supergroup or channel by its bare id; the Bot API prefixes it with -100.
export const desktopChannelTypes=new Set(['private_supergroup','public_supergroup','private_channel','public_channel']);
/** The forum topic the importer worked out for a Desktop export message, only once the export is
 * mapped to its own live supergroup, where topic ids are the live ones. */
export function desktopTopicId(scope:string,body:Record<string,any>):number|undefined {
  const chat=body.chat&&typeof body.chat==='object'?body.chat:{},topic=body.topic_id;
  if(!desktopChannelTypes.has(chat.type)||!/^[1-9][0-9]{0,15}$/.test(String(chat.id))||scope!=='-100'+chat.id)return undefined;
  return Number.isSafeInteger(topic)&&topic>0?topic:undefined;
}
