import {accountIdFor} from './chats.js';
import {isBotAccount,isTelegramAccount} from './chats-telegram.js';
import {forwardFacts,type Forward} from './forwarded.js';
import {sendClassOf,unlearnedSendClasses,type SendClass} from './send-classes.js';

/*
 * What code knows about one archived message: who wrote it and what it carries, read from the platform's own fields and
 * Nocheh's records, never from what the message says. Labels and the notes review trust these facts, never a display
 * name, so a person named "Owner" is still a person. Pure: one reader per channel, and a channel or kind it does not
 * know reads as written by someone unknown, who is never the owner.
 */

/** Who wrote a message: the owner's account, another person's, an anonymous admin or a chat's own name, a bot, Nocheh
 *  itself, or someone code cannot tell. */
export type Author='owner'|'person'|'anonymous'|'bot'|'nocheh'|'unknown';
/** What the archived event is: a new message, an edit, a reaction, the owner's web chat, a message Nocheh delivered,
 *  or anything else. */
export type Act='message'|'edit'|'reaction'|'browser'|'delivered'|'other';
export interface SourceFacts {
  author:Author;
  /** The sender's account, a Nocheh account id (accountIdFor), when Telegram names one. */
  account:string|null;
  /** The sender's name as Telegram showed it then, unchecked: only the owner's labels write it, through labelName. */
  name:string|null;
  act:Act;
  /** Where it was forwarded from (forwardFacts): 'own' is the sender's own earlier message, 'bot' an inline bot's. */
  forward:Forward['from']|null;
  /** The name the forward showed, unchecked, as `name` is. */
  forward_name:string|null;
  /** A quote inside a reply: of the sender's own message, or of someone else's. */
  quote:'own'|'other'|null;
  /** The message a pin carries: the sender's own typed message, or one with someone else's words in it. A checklist that
   *  may hold tasks someone else added, sent, edited or pinned, is read as 'other' too (sharedChecklist). */
  pinned:'own'|'other'|null;
  /** Text read from a file or an image the sender sent, and that file's name, unchecked. */
  file:boolean;file_name:string|null;
  /** A transcript of an audio file, which is not the sender's own voice. */
  audio:boolean;
  /** A transcript of the sender's own voice or video note. */
  recording:boolean;
  /** Nocheh's own message: its send class, and the message it answered (a full event id). */
  send_class:SendClass|null;answers:string|null;
}
/** One archived event as the facts read it. `derivatives` are its selected transcripts and extracted texts, each with
 *  its artifact's kind and file name; `authors` are its authored_by targets, read for a Telegram Desktop export. */
export interface FactsInput {
  channel:string;kind:string;payload:unknown;
  derivatives?:readonly {kind:string;artifact:string;file_name?:string|null}[];
  authors?:readonly {namespace:string;kind:string;external_id:string}[];
}

const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const text=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value:null;
const fullId=(value:unknown):string|null=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
/** The recordings of the sender's own voice; any other transcript is of an audio file someone made. */
export const ownVoice:ReadonlySet<string>=new Set(['voice','video_note','voice_message','video_message']);
const none:SourceFacts={author:'unknown',account:null,name:null,act:'other',forward:null,forward_name:null,quote:null,pinned:null,file:false,file_name:null,
  audio:false,recording:false,send_class:null,answers:null};

/** A Telegram sender: the owner's account, another person's, or a bot's. */
function sender(user:Record<string,any>|null,owner:string|null):Pick<SourceFacts,'author'|'account'|'name'> {
  if(!user)return {author:'unknown',account:null,name:null};
  const account=typeof user.id==='number'||typeof user.id==='string'?String(user.id):'';
  const name=[text(user.first_name),text(user.last_name)].filter(Boolean).join(' ')||null;
  if(user.is_bot===true)return {author:'bot',account:null,name};
  if(!isTelegramAccount(account))return {author:'unknown',account:null,name};
  return {author:owner!==null&&account===owner?'owner':'person',account:accountIdFor('telegram',account),name};
}

/** A live Telegram update: a message, an edit, a reaction, or something else. */
function telegram(payload:unknown,owner:string|null):SourceFacts {
  const update=record(payload);if(!update)return none;
  const reaction=record(update.message_reaction);
  // A reaction made in a chat's own name (actor_chat) is never the owner's, as a post in a chat's name is not.
  if(reaction)return {...none,act:'reaction',...(record(reaction.actor_chat)?{author:'anonymous'}:sender(record(reaction.user),owner))};
  if(update.message_reaction_count!==undefined)return {...none,act:'reaction'};
  const channel=record(update.channel_post??update.edited_channel_post),message=record(update.message??update.edited_message)??channel;
  if(!message)return none;
  const act=update.edited_message!==undefined||update.edited_channel_post!==undefined?'edit':'message';
  // An anonymous admin and a post in a channel's or group's name (sender_chat) are never the owner (ADR-0251).
  const who=channel||record(message.sender_chat)?{author:'anonymous' as const,account:null,name:text(record(message.sender_chat)?.title)}:sender(record(message.from),owner);
  const raw=who.account===null?null:String(record(message.from)?.id);
  return {...none,...who,act,...forwarded(message),quote:quoteOf(message,raw),...pinnedOf(message,raw),...(sharedChecklist(message,act==='message')?{pinned:'other' as const}:{}),
    file_name:text(record(message.document)?.file_name)??text(record(message.audio)?.file_name)};
}
/**
 * Whether a message is a checklist that may hold tasks someone else added. Telegram names no one per task, and
 * others_can_add_tasks says only what others may do now: the sender can turn it off once others have added tasks. So a
 * checklist others can add tasks to, and any checklist shown again (`fresh` false: an edit of it, the message a pin
 * carries, the message a quote is from), is read as one with someone else's words in it (pinned 'other', class `pinned`,
 * or quote 'other', class `quote`), never as the sender's own typing; only a new checklist that only its sender can add
 * to stays theirs. Its text is still learned.
 */
function sharedChecklist(message:Record<string,any>|null,fresh=false):boolean {
  const list=record(message?.checklist);
  return !!list&&(list.others_can_add_tasks===true||!fresh);
}
function forwarded(message:unknown):Pick<SourceFacts,'forward'|'forward_name'> {
  const found=forwardFacts(message);
  return {forward:found?.from??null,forward_name:found?.rawName??null};
}
/**
 * Whose message a reply quotes: the sender's own only when the message it answers is theirs, by their Telegram id, and
 * is not a forward of someone else's (forwardFacts, an inline bot's message included), as a pin's message is read
 * (pinnedOf): the sender's quote of their own forward quotes whoever wrote it, and so does a quote of their own checklist
 * (sharedChecklist), which may hold someone else's tasks. A quote of a message in another chat or topic (external_reply)
 * is judged by that message alone, and is never the sender's own: Telegram shows only who first sent it (its origin),
 * not whether it was a forward or sent through an inline bot, and in a forum topic it also sets reply_to_message, to the
 * topic's first message, which the quote is not from.
 */
function quoteOf(message:Record<string,any>,sender:string|null):SourceFacts['quote'] {
  if(!record(message.quote))return null;
  if(record(message.external_reply))return 'other';
  const target=record(message.reply_to_message);
  if(target&&((forwardFacts(target)?.from??'own')!=='own'||sharedChecklist(target)))return 'other';
  const author=target&&!record(target.sender_chat)?record(target.from)?.id:null;
  return sender!==null&&(typeof author==='number'||typeof author==='string')&&String(author)===sender?'own':'other';
}

/**
 * What a pin carries: a pin has no words of its own, so it carries those of the message it pinned. A forward of someone
 * else's there, an inline bot's message included, is a forward the sender passed on; a message the sender did not write
 * (another person's, or a post in a chat's name), and the sender's own checklist, which may hold someone else's tasks
 * (sharedChecklist), is someone else's; only the sender's own typed message stays theirs, with its own quote read as any
 * quote is. A message Telegram no longer shows (date 0) carries nothing.
 */
function pinnedOf(message:Record<string,any>,sender:string|null):Partial<Pick<SourceFacts,'forward'|'forward_name'|'quote'|'pinned'>> {
  const pinned=record(message.pinned_message);
  if(!pinned||pinned.date===0)return {};
  const found=forwardFacts(pinned);
  if(found&&found.from!=='own')return {forward:found.from,forward_name:found.rawName,pinned:'other'};
  const author=record(pinned.from)?.id;
  if(sender===null||record(pinned.sender_chat)||!(typeof author==='number'||typeof author==='string')||String(author)!==sender||sharedChecklist(pinned))return {pinned:'other'};
  const quote=quoteOf(pinned,sender);
  return {pinned:'own',...(quote?{quote}:{})};
}

/**
 * Whether a message Telegram shows inside another carries Nocheh's own words, by Telegram's own fields and the bot the
 * update came to (`bot`, the archive's events.bot_id): sent by Nocheh's own account, or a forward first sent by it
 * (forward_origin, or the older forward_from). The account is told by equality alone (isBotAccount), never an id's
 * shape; with no known bot, no message is. Another bot's message is someone else's and is learned as such, and so is one
 * sent through an inline bot (via_bot), which a person wrote: neither is Nocheh's.
 */
function nochehWords(message:Record<string,any>|null,bot:string|null):boolean {
  if(!message)return false;
  const origin=record(message.forward_origin);
  return isBotAccount(message.from,bot)||origin?.type==='user'&&isBotAccount(origin.sender_user,bot)||!origin&&isBotAccount(message.forward_from,bot);
}
/** Whether the message a pin carries is Nocheh's own words (nochehWords). One Telegram no longer shows (date 0) carries none. */
export function nochehPinned(message:unknown,bot:string|null):boolean {
  const pinned=record(record(message)?.pinned_message);
  return !!pinned&&pinned.date!==0&&nochehWords(pinned,bot);
}
/** Whether a message's quote is of Nocheh's own words: the message it answers in the same chat carries them
 *  (nochehWords), or the one it answers in another chat (external_reply) was first sent by Nocheh's own account. A
 *  message with no quote quotes nothing. */
export function nochehQuoted(message:unknown,bot:string|null):boolean {
  const found=record(message);if(!found||!record(found.quote))return false;
  const origin=record(record(found.external_reply)?.origin);
  return nochehWords(record(found.reply_to_message),bot)||origin?.type==='user'&&isBotAccount(origin.sender_user,bot);
}

/** Whether a value is shaped as a Telegram message: an object with a message_id and a chat, and no `type`, which every
 *  MessageOrigin has (a channel's forward origin names its post the same way, and carries no words). */
function messageShaped(value:unknown):boolean {
  const found=record(value);
  return !!found&&'message_id' in found&&'chat' in found&&typeof found.type!=='string';
}
/**
 * Takes out of a Telegram message every other message it embeds, at any depth (ADR-0257): the one it replies to, a
 * checklist a service message reports on (checklist_message), a giveaway's or suggested post's message, and any field
 * Telegram adds later that holds a message. Such a message is someone else's, or the sender's own earlier one, and is
 * learned from its own event when Nocheh got it, as a reply's is, never as part of this one. The message a pin carries
 * (pinned_message) stays, with what it embeds taken out the same way; everything else the message holds stays, the
 * sender's own data beside an embedded message included (a checklist's added tasks, the ids of tasks marked done).
 * Code reads only the shape, never an id. Returns whether anything was taken out.
 */
export function cutEmbeddedMessages(message:Record<string,any>):boolean {
  let cut=false;
  const walk=(value:unknown,top:boolean):void=>{
    if(Array.isArray(value)) {
      for(let index=value.length-1;index>=0;index--)if(messageShaped(value[index])){value.splice(index,1);cut=true;}else walk(value[index],false);
      return;
    }
    const found=record(value);if(!found)return;
    for(const [key,item] of Object.entries(found)) {
      if(top&&key==='pinned_message'){walk(item,false);continue;}
      if(messageShaped(item)){delete found[key];cut=true;}else walk(item,false);
    }
  };
  walk(message,true);
  return cut;
}

/** A Telegram Desktop export: its author is the account the archive proved for it (authored_by), never a name. */
function desktop(kind:string,payload:unknown,authors:FactsInput['authors'],owner:string|null):SourceFacts {
  const body=record(payload),message=record(body?.message);
  if(!message)return none;
  const found=(authors??[]).length===1?authors![0]!:null;
  const author:Author=!found?'unknown':found.kind==='conversation'?'anonymous':found.kind!=='actor'?'unknown':
    found.namespace==='bot-api'&&owner!==null&&found.external_id===owner?'owner':'person';
  const account=found?.kind==='actor'&&found.namespace==='bot-api'&&isTelegramAccount(found.external_id)?accountIdFor('telegram',found.external_id):null;
  return {...none,author,account,name:text(message.from),act:kind==='telegram_desktop_message'?'message':'other',...forwarded(message),file_name:text(message.file_name)};
}

/** The owner's web chat, and Nocheh's answers there. */
function browser(kind:string,payload:unknown):SourceFacts {
  const body=record(payload);
  if(kind==='browser_input'){
    const files=Array.isArray(body?.attachments)?body!.attachments.map(record).filter(Boolean) as Record<string,any>[]:[];
    return {...none,author:'owner',act:'browser',file_name:text(files.find(file=>['file','image'].includes(file.kind))?.name)};
  }
  if(kind==='browser_delivered_message')return {...none,author:'nocheh',act:'delivered',send_class:sendClassOf(body?.send_class)??'reply'};
  return none;
}

/** The facts of one archived event. `owner` is the owner's Telegram account (policy.owner_id). */
export function sourceFacts(input:FactsInput,owner:string|null):SourceFacts {
  let facts:SourceFacts=none;
  if(input.channel==='telegram'&&input.kind==='telegram_update')facts=telegram(input.payload,owner);
  else if(input.channel==='telegram'&&input.kind==='telegram_delivered_message') {
    const body=record(input.payload);
    facts={...none,author:'nocheh',act:'delivered',send_class:sendClassOf(body?.send_class),answers:fullId(body?.answers)};
  }
  else if(input.channel==='telegram'&&input.kind.startsWith('telegram_desktop_'))facts=desktop(input.kind,input.payload,input.authors,owner);
  else if(input.channel==='browser')facts=browser(input.kind,input.payload);
  if(facts.author==='nocheh'||facts.act==='reaction'||facts.act==='other')return facts;
  // What its files say: a transcript of the sender's own voice, of an audio file, or text read from a file or an image.
  const derivatives=input.derivatives??[],read=derivatives.find(item=>item.kind==='extracted_text');
  return {...facts,recording:derivatives.some(item=>item.kind==='transcript'&&ownVoice.has(item.artifact)),
    audio:derivatives.some(item=>item.kind==='transcript'&&!ownVoice.has(item.artifact)),
    file:!!read,file_name:facts.file_name??text(read?.file_name)};
}

/** Whether a message is the owner's own typing: the owner's account, a new message, edit, reaction or web chat message,
 *  not a forward of someone else's (an inline bot's included), no quote of someone else's message, no pin of someone
 *  else's message, no checklist that may hold someone else's tasks and no text read from a file or audio file. The
 *  owner's own voice, transcribed, is the owner's. */
export const ownerTyped=(f:SourceFacts):boolean=>f.author==='owner'&&['message','edit','reaction','browser'].includes(f.act)&&
  (f.forward===null||f.forward==='own')&&f.quote!=='other'&&f.pinned!=='other'&&!f.file&&!f.audio;

type By='owner'|'person';
type LearnedClass=Exclude<SendClass,'card'|'card_update'|'refusal'|'notice'|'reminder'>;
/** One fixed token for what kind of message an event is. `quote_nocheh` is the owner's reply quoting Nocheh's own learned
 *  message, and `pinned_nocheh` the owner's pin of one, which only NoteSourceRepository.classesFor tells, by the archive's
 *  reply relation and the pinned message found the same way; eventClass alone calls them a quote and a pin. */
export type EventClass='owner_message'|'owner_reaction'|'owner_browser'|'person_message'|'person_reaction'|'anonymous_post'|
  `forward_${Exclude<Forward['from'],'own'>}_by_${By}`|`file_by_${By}`|`audio_by_${By}`|'quote'|'quote_nocheh'|'pinned'|'pinned_nocheh'|`nocheh_${LearnedClass}`|
  'nocheh_about_forward'|'nocheh_unlearned'|'unknown';
const learnedClasses:readonly LearnedClass[]=['reply','follow_up','private_answer','job_report','scheduled_run','approved_post'];
/** Every event class, for checking a stored one. */
export const eventClasses:readonly EventClass[]=['owner_message','owner_reaction','owner_browser','person_message','person_reaction','anonymous_post',
  ...(['person','hidden','channel','chat','bot'] as const).flatMap(from=>(['owner','person'] as const).map(by=>`forward_${from}_by_${by}` as const)),
  'file_by_owner','file_by_person','audio_by_owner','audio_by_person','quote','quote_nocheh','pinned','pinned_nocheh',...learnedClasses.map(name=>`nocheh_${name}` as const),
  'nocheh_about_forward','nocheh_unlearned','unknown'];
export const isEventClass=(value:unknown):value is EventClass=>typeof value==='string'&&(eventClasses as readonly string[]).includes(value);

/**
 * The class of one event. `answered` is the facts of the message Nocheh's reply answered (its `answers`), when known:
 * a reply about someone else's forward is about that forward. Someone else's forward comes first, a pinned one too, then
 * a file's or an audio file's text, then a quote of someone else's message, then a pin of someone else's message; only
 * what is left is the sender's own message.
 */
export function eventClass(f:SourceFacts,answered?:SourceFacts|null):EventClass {
  if(f.author==='nocheh') {
    if(f.act!=='delivered')return 'unknown';
    if(f.send_class!==null&&unlearnedSendClasses.has(f.send_class))return 'nocheh_unlearned';
    if(answered&&answered.forward!==null&&answered.forward!=='own')return 'nocheh_about_forward';
    // A message from before send classes: a reply, which is how it was learned then.
    return `nocheh_${(f.send_class??'reply') as LearnedClass}`;
  }
  if(f.author==='anonymous')return ['message','edit','reaction'].includes(f.act)?'anonymous_post':'unknown';
  if(f.author!=='owner'&&f.author!=='person')return 'unknown';
  const by=f.author;
  if(f.act==='reaction')return `${by}_reaction`;
  if(!['message','edit','browser'].includes(f.act)||f.act==='browser'&&by!=='owner')return 'unknown';
  if(f.forward!==null&&f.forward!=='own')return `forward_${f.forward}_by_${by}`;
  if(f.file)return `file_by_${by}`;
  if(f.audio)return `audio_by_${by}`;
  if(f.quote==='other')return 'quote';
  if(f.pinned==='other')return 'pinned';
  return f.act==='browser'?'owner_browser':`${by}_message`;
}

/** Whose words a class carries, for a note's source: the owner's, Nocheh's learned messages (and the owner's quote or pin
 *  of one), other people's (anonymous posts, quotes, pins of their messages, Nocheh's unlearned messages and anything
 *  unknown included), forwards, or files' and audio files' text. */
export type Bucket='owner'|'nocheh'|'person'|'forward'|'file';
export function bucketOf(cls:EventClass):Bucket {
  if(cls.startsWith('owner_'))return 'owner';
  if(cls.startsWith('forward_')||cls==='nocheh_about_forward')return 'forward';
  if(cls.startsWith('file_')||cls.startsWith('audio_'))return 'file';
  if(cls==='quote_nocheh'||cls==='pinned_nocheh')return 'nocheh';
  if(cls.startsWith('nocheh_')&&cls!=='nocheh_unlearned')return 'nocheh';
  return 'person';
}
