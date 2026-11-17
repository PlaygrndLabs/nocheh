/**
 * The Telegram adapter for chat ids (ADR-0252). Telegram's own formats are read here and nowhere else: a chat's
 * numeric id, a forum topic's thread id, a t.me/c link, a Telegram Desktop export, and the frozen shape of the chat
 * values Nocheh stored before step 2b. Every other module asks the chat directory (src/chats.ts) what a chat is; it
 * never decides private, group or topic, parent or topic from the shape of an id.
 */
import {HttpError} from './http.js';

/** A Telegram chat id as the Bot API writes it: negative for groups and channels, positive for private chats. */
const telegramChat='-?[1-9][0-9]{0,18}';
/** A Telegram user id, which is also the id of that user's private chat with the bot. */
const telegramAccount='[1-9][0-9]{0,18}';
/** A forum topic's thread id. */
const telegramThread='[1-9][0-9]{0,15}';
const chatPattern=new RegExp(`^${telegramChat}$`),accountPattern=new RegExp(`^${telegramAccount}$`);
/** A Telegram user id as an SQL regex source, for a CHECK that still admits a value an older row holds. */
export const telegramAccountSource=telegramAccount;
export const isTelegramChat=(value:unknown):value is string=>typeof value==='string'&&chatPattern.test(value);
export const isTelegramAccount=(value:unknown):value is string=>typeof value==='string'&&accountPattern.test(value);
/**
 * Whether a Telegram user, as a message shows it, is the bot an update came to: a bot account whose id equals the bot's
 * own account the archive stored with that update (events.bot_id, the bot token's own account). Told by equality alone,
 * so no caller reads an id's shape; a bot id the archive holds in another form (an import's, a fixture's) names no
 * account, and then no user is the bot.
 */
export function isBotAccount(user:unknown,bot:unknown):boolean {
  const found=user&&typeof user==='object'&&!Array.isArray(user)?user as Record<string,unknown>:null;
  return !!found&&found.is_bot===true&&isTelegramAccount(bot)&&(typeof found.id==='number'||typeof found.id==='string')&&String(found.id)===bot;
}

/**
 * The frozen shape of a chat value stored before step 2b: a Telegram chat id, optionally followed by one of its
 * topics. Such a value stays that chat's Nocheh id unchanged; chats first seen later get a digest (chatIdFor). This
 * pattern source is part of the shared chat id check (chatIdPattern, chatIdSql) and must never change.
 */
export const legacyChatSource=`${telegramChat}(?:/topic/${telegramThread})?`;
/**
 * SQL test that a text `expression` is, in the frozen old shape, a group ('group'), a group or one of its topics
 * ('group_space') or a private chat ('private'): the CHECKs a release before step 2b put on the values it writes. Only
 * for a store rule judging a value that no chats row names, so that such a release, redeployed, keeps writing its rows
 * (ADR-0252: 2b-1 is undone by redeploying). Everything Nocheh writes now has a row and is judged by it.
 */
export function legacyShapeSql(expression:string,kind:'group'|'group_space'|'private'):string {
  if(!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(expression))throw Error('invalid_sql_expression');
  const group=`-${telegramAccount}`;
  return `${expression} ~ '^${kind==='private'?telegramAccount:kind==='group'?group:`${group}(?:/topic/${telegramThread})?`}$'`;
}
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
 * A chat value in the frozen old shape, the inverse of legacyChat: a Telegram chat id, or it followed by one of its
 * topics. Only the legacy storage layout's event spaces are built this way (spaces.ts eventSpace); a chat first seen
 * after step 2b gets its id from chatIdFor, and every live reader asks the chat directory.
 */
export function legacyChatValue(external:string,topic?:unknown):string {
  if(topic===undefined||topic===null)return external;
  if(!chatPattern.test(external)||!Number.isSafeInteger(topic)||Number(topic)<=0)throw new HttpError(400,'invalid_topic');
  return `${external}/topic/${topic}`;
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

/** A Telegram public username (4 to 32 letters, digits and underscores, starting with a letter), trimmed and without
 * its @; null for anything else. The one rule for a t.me link and for a person shown by username. */
export function telegramUsername(value:unknown):string|null {
  const name=typeof value==='string'?value.trim():'';
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)?name:null;
}
/**
 * A t.me address of a chat, a topic or a message, from the chat's current Telegram id (`external`): by the chat's public
 * username, or else a private supergroup's t.me/c address, which works only for its members and needs a topic or a
 * message. Null where Telegram has none, such as a basic group. `path` holds Telegram's own topic and message numbers.
 */
export function telegramLink(external:string|null|undefined,username:string|null,path:(string|null|undefined)[]):string|null {
  const parts=path.filter((part):part is string=>!!part&&/^[1-9][0-9]{0,15}$/.test(part)),name=telegramUsername(username);
  if(name)return ['https://t.me/'+name,...parts].join('/');
  const internal=typeof external==='string'?/^-100([1-9][0-9]{0,15})$/.exec(external)?.[1]:undefined;
  return internal&&parts.length?['https://t.me/c/'+internal,...parts].join('/'):null;
}

/** The two questions a destination asks of the chat directory (src/chats.ts), so this adapter needs nothing else of it. */
export interface DestinationDirectory {
  get(id:string):unknown;
  resolve(app:'telegram',external:string,topic?:string|number|null):string|null;
}
/**
 * The chat a send names, as the model or the owner writes it: a chat id the directory knows; a t.me/c link to a group,
 * one of its topics or a message in it; or a Telegram chat id, with `/topic/<n>` for a topic as it was written before
 * step 2b. Every form ends as a chat id the directory holds; anything it does not know is null, so the send is refused
 * (ADR-0242, ADR-0252).
 */
export function telegramDestination(value:unknown,directory:DestinationDirectory):string|null {
  if(typeof value!=='string'||!value.trim()||value.length>200)return null;
  const text=value.trim();
  if(directory.get(text))return text;
  const link=parseTelegramLink(text);
  if(link) {
    const chat=directory.resolve('telegram',link.external);if(!chat)return null;
    // t.me/c/<chat>/<topic>/<message>; with one number it is a topic of a forum, or a message in a group without topics.
    if(link.parts.length===2)return directory.resolve('telegram',link.external,link.parts[0]);
    return link.parts.length?directory.resolve('telegram',link.external,link.parts[0])??chat:chat;
  }
  const old=legacyChat(text);
  return old?directory.resolve('telegram',old.external,old.topic_key):null;
}

const fields=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
/** The Telegram message an archived payload holds: a message, an edit or a channel post, live or as a Telegram Desktop
 *  export wrote it (`message`); null when it holds none. */
export const telegramMessage=(payload:unknown):Record<string,any>|null=>{
  const found=fields(payload);return fields(found?.message??found?.edited_message??found?.channel_post??found?.edited_channel_post);};
const shownText=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value:null;
/**
 * Who sent a message, as Telegram showed them (ADR-0261): a Bot API sender's first and last name and public username,
 * or the name a Telegram Desktop export wrote (`from`), which has no username. Read from those name fields alone,
 * never from an id, so no digits from an id field ever become a name; a post in a chat's name, a bot's own delivered
 * message and anything else name nobody. `payload` is the copy the reader reads (the guarded copy when the secret check
 * is on). The name is returned unchecked: whoever writes it out cleans it.
 */
export function telegramSenderName(kind:string,payload:unknown):{name:string|null;username:string|null} {
  const none={name:null,username:null},body=fields(payload);
  if(!body)return none;
  if(kind.startsWith('telegram_desktop_')){const message=fields(body.message);return {name:shownText(message?.from),username:null};}
  if(kind!=='telegram_update')return none;
  const reaction=fields(body.message_reaction);
  const message=telegramMessage(body);
  if(!reaction&&(!message||fields(message.sender_chat)||body.channel_post!==undefined||body.edited_channel_post!==undefined))return none;
  const user=reaction?fields(reaction.user):fields(message!.from);
  if(!user)return none;
  const name=[shownText(user.first_name),shownText(user.last_name)].filter(Boolean).join(' ')||null;
  return {name,username:telegramUsername(user.username)};
}

/**
 * Whether a message is a forum topic's opening: the service message Telegram writes when a topic is created, which
 * every message in that topic replies to. Such a "reply" only says which topic a message is in, so it is never treated
 * as a reply (ADR-0261). Told by a field being present alone: Bot API's `forum_topic_created`, or a Telegram Desktop
 * export's service message whose action is `topic_created`. No id is read or compared.
 */
export function telegramTopicOpening(message:unknown):boolean {
  const found=fields(message);
  if(!found)return false;
  if(found.forum_topic_created!==undefined&&found.forum_topic_created!==null)return true;
  return found.type==='service'&&found.action==='topic_created';
}

/**
 * The time an old Telegram Desktop export wrote for a message when it had no Unix time (`date` without `date_unixtime`):
 * the exporting computer's local time, with no zone, as `YYYY-MM-DD HH:MM`. Such a time is shown as written, never
 * converted to a zone, since the export did not say which zone it was in. Null for anything else: a live message, or an
 * export that gave Unix seconds.
 */
export function desktopLocalTime(kind:string,occurredAt:unknown):string|null {
  if(!kind.startsWith('telegram_desktop_')||typeof occurredAt!=='string')return null;
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(occurredAt);
  return match?`${match[1]} ${match[2]}`:null;
}
