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
  /** The message a pin carries: the sender's own typed message, or one with someone else's words in it. A message that
   *  holds words that may be someone else's itself (`held`) is read as 'other' too. */
  pinned:'own'|'other'|null;
  /** Whether the message itself, not a pin, holds words that may be someone else's (othersIn): a checklist that may hold
   *  tasks someone else added, a poll option someone else added, an option's text deleted from a poll, or a message
   *  Telegram shows inside it that is not the sender's own typed message. `pinned` is then 'other'. */
  held:boolean;
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
 *  its artifact's kind and file name; `authors` are its authored_by targets, read for a Telegram Desktop export.
 *  `owner_chat` says the event is in the owner's own private chat with Nocheh, by the caller's equality with ownerChat,
 *  where nobody else can add to a checklist. */
export interface FactsInput {
  channel:string;kind:string;payload:unknown;owner_chat?:boolean;
  derivatives?:readonly {kind:string;artifact:string;file_name?:string|null}[];
  authors?:readonly {namespace:string;kind:string;external_id:string}[];
}

const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const text=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value:null;
const fullId=(value:unknown):string|null=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
/** The recordings of the sender's own voice; any other transcript is of an audio file someone made. */
export const ownVoice:ReadonlySet<string>=new Set(['voice','video_note','voice_message','video_message']);
const none:SourceFacts={author:'unknown',account:null,name:null,act:'other',forward:null,forward_name:null,quote:null,pinned:null,held:false,file:false,
  file_name:null,audio:false,recording:false,send_class:null,answers:null};
/** A Telegram account's id as text, or null when the value names none. Compared by equality only, never by its shape. */
const accountOf=(user:unknown):string|null=>{const id=record(user)?.id;return typeof id==='number'||typeof id==='string'?String(id):null;};

/** A Telegram sender: the owner's account, another person's, or a bot's. */
function sender(user:Record<string,any>|null,owner:string|null):Pick<SourceFacts,'author'|'account'|'name'> {
  if(!user)return {author:'unknown',account:null,name:null};
  const account=typeof user.id==='number'||typeof user.id==='string'?String(user.id):'';
  const name=[text(user.first_name),text(user.last_name)].filter(Boolean).join(' ')||null;
  if(user.is_bot===true)return {author:'bot',account:null,name};
  if(!isTelegramAccount(account))return {author:'unknown',account:null,name};
  return {author:owner!==null&&account===owner?'owner':'person',account:accountIdFor('telegram',account),name};
}

/** A live Telegram update: a message, an edit, a reaction, or something else. `ownChat`: it is in the owner's own private
 *  chat with Nocheh. */
function telegram(payload:unknown,owner:string|null,ownChat:boolean):SourceFacts {
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
  // Only a new message that is not a forward shows its checklist for the first time; a forward, even of the sender's own,
  // shows one that may have been shared since.
  const held=othersIn(message,raw,act==='message'&&!forwardFacts(message),ownChat);
  return {...none,...who,act,...forwarded(message),quote:quoteOf(message,raw,ownChat),...pinnedOf(message,raw,ownChat),...(held?{pinned:'other' as const,held:true}:{}),
    file_name:text(record(message.document)?.file_name)??text(record(message.audio)?.file_name)};
}
/**
 * Whether a message is a checklist that may hold tasks someone else added. Telegram names no one per task, and
 * others_can_add_tasks says only what others may do now: the sender can turn it off once others have added tasks. So a
 * checklist others can add tasks to, and any checklist shown again (`fresh` false: an edit of it, a forward of it, the
 * message a pin carries or a message embeds, the message a quote is from), is read as one with someone else's words in it
 * (pinned 'other', class `pinned`, or quote 'other', class `quote`), never as the sender's own typing; only a new
 * checklist that only its sender can add to stays theirs. In the owner's own private chat with Nocheh (`ownChat`) nobody
 * else can add tasks, so a checklist there that is not a forward is its sender's own, new, edited, pinned or quoted. Its
 * text is still learned.
 */
function sharedChecklist(message:Record<string,any>|null,fresh:boolean,ownChat:boolean):boolean {
  const list=record(message?.checklist);
  if(!list||ownChat&&!forwardFacts(message))return false;
  return list.others_can_add_tasks===true||!fresh;
}
/** Whether a poll holds an option someone other than `sender` added: one added in a chat's name (added_by_chat), or by
 *  an account other than the sender's, told by equality (added_by_user). Every option a member adds names who added
 *  it, so an option naming no one is the poll's own. */
function pollByOthers(message:Record<string,any>,sender:string|null):boolean {
  const options=record(message.poll)?.options;
  return Array.isArray(options)&&options.some(option=>{
    const found=record(option);if(!found)return false;
    if(found.added_by_chat!==undefined&&found.added_by_chat!==null)return true;
    return found.added_by_user!==undefined&&found.added_by_user!==null&&(sender===null||accountOf(found.added_by_user)!==sender);
  });
}
/**
 * Whether a message holds words that may be someone other than `sender`'s, besides a forward, a quote or a pin: a
 * checklist that may hold someone else's tasks (sharedChecklist), a poll option someone else added (pollByOthers), an
 * option's text deleted from a poll (poll_option_deleted), whose adder Telegram does not name, or a message it embeds
 * (embeddedMessages) that is not the sender's own typed message (shownOf). Read for a message itself, the message a pin
 * carries, the one a quote is from, and each message those embed.
 */
function othersIn(message:Record<string,any>,sender:string|null,fresh:boolean,ownChat:boolean):boolean {
  return sharedChecklist(message,fresh,ownChat)||pollByOthers(message,sender)||!!record(message.poll_option_deleted)||
    embeddedMessages(message).some(item=>shownOf(item.message,sender,ownChat).pinned==='other');
}
function forwarded(message:unknown):Pick<SourceFacts,'forward'|'forward_name'> {
  const found=forwardFacts(message);
  return {forward:found?.from??null,forward_name:found?.rawName??null};
}
/**
 * Whose message a reply quotes: the sender's own only when the message it answers is theirs, by their Telegram id, and
 * is not a forward of someone else's (forwardFacts, an inline bot's message included), as a pin's message is read
 * (pinnedOf): the sender's quote of their own forward quotes whoever wrote it, and so does a quote of their own message
 * holding words that may be someone else's (othersIn: a checklist, a poll an option was added to, a message it embeds).
 * A quote of a message in another chat or topic (external_reply) is judged by that message alone, and is never the
 * sender's own: Telegram shows only who first sent it (its origin), not whether it was a forward or sent through an
 * inline bot, and in a forum topic it also sets reply_to_message, to the topic's first message, which the quote is not
 * from.
 */
function quoteOf(message:Record<string,any>,sender:string|null,ownChat:boolean):SourceFacts['quote'] {
  if(!record(message.quote))return null;
  if(record(message.external_reply))return 'other';
  const target=record(message.reply_to_message);
  if(target&&((forwardFacts(target)?.from??'own')!=='own'||othersIn(target,sender,false,ownChat)))return 'other';
  const author=target&&!record(target.sender_chat)?accountOf(target.from):null;
  return sender!==null&&author===sender?'own':'other';
}

/**
 * Whose words a message shown inside another carries: the message a pin carries (a pin has no words of its own), or one
 * a message embeds (embeddedMessages). A forward of someone else's there, an inline bot's message included, is a forward
 * the sender passed on; a message the sender did not write (another person's, or a post in a chat's name), and the
 * sender's own message holding words that may be someone else's (othersIn: a checklist, a poll an option was added to,
 * a message it embeds in turn), is someone else's; only the sender's own typed message stays theirs, with its own quote
 * read as any quote is. A message Telegram no longer shows (date 0) carries nothing.
 */
function shownOf(shown:Record<string,any>,sender:string|null,ownChat:boolean):Partial<Pick<SourceFacts,'forward'|'forward_name'|'quote'|'pinned'>> {
  if(shown.date===0)return {};
  const found=forwardFacts(shown);
  if(found&&found.from!=='own')return {forward:found.from,forward_name:found.rawName,pinned:'other'};
  if(sender===null||record(shown.sender_chat)||accountOf(shown.from)!==sender||othersIn(shown,sender,false,ownChat))return {pinned:'other'};
  const quote=quoteOf(shown,sender,ownChat);
  return {pinned:'own',...(quote?{quote}:{})};
}
/** What a pin carries, read as any message shown inside another is (shownOf). An update without a pin carries none. */
function pinnedOf(message:Record<string,any>,sender:string|null,ownChat:boolean):Partial<Pick<SourceFacts,'forward'|'forward_name'|'quote'|'pinned'>> {
  const pinned=record(message.pinned_message);
  return pinned?shownOf(pinned,sender,ownChat):{};
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
/** A place in a Telegram message: the fields and list indexes that lead to it. */
export type HeldPath=readonly (string|number)[];
/** One message another embeds, and where. */
export interface Embedded {path:HeldPath;message:Record<string,any>}
/** A message's reply fields hold the message it answers, read through the archive's reply relation, never one it embeds. */
const replyFields=new Set(['reply_to_message','external_reply']);
/**
 * Every message a Telegram message embeds, at any depth, each with its place (ADR-0257): the checklist a service message
 * reports on (checklist_message), the poll an option was added to or deleted from (poll_message), a giveaway's or a
 * suggested post's message, and any field Telegram adds later that holds a message. The message it answers is not one
 * (reply_to_message, external_reply, also skipped inside each message listed), nor is the message a pin carries
 * (pinned_message), which has rules of its own; with `pinned`, the messages that one embeds are listed too. A message
 * inside an embedded one comes after it. Code reads only the shape, never a field's name or an id, so a field Telegram
 * adds later fails closed.
 */
export function embeddedMessages(message:Record<string,any>,pinned=false):Embedded[] {
  const found:Embedded[]=[];
  const fields=(value:Record<string,any>,path:HeldPath,shown:boolean):void=>{
    for(const [key,item] of Object.entries(value))if(!shown||!replyFields.has(key))visit(item,[...path,key]);
  };
  const visit=(value:unknown,path:HeldPath):void=>{
    if(Array.isArray(value)){value.forEach((item,index)=>visit(item,[...path,index]));return;}
    const object=record(value);if(!object)return;
    if(messageShaped(object))found.push({path,message:object});
    fields(object,path,messageShaped(object));
  };
  for(const [key,item] of Object.entries(message)) {
    if(replyFields.has(key))continue;
    if(key==='pinned_message'){const inner=record(item);if(pinned&&inner)fields(inner,[key],true);continue;}
    visit(item,[key]);
  }
  return found;
}
/**
 * What a Telegram message holds that may be someone else's, each with its place, for the owner's notes review and for
 * Nocheh's own words (ADR-0257): every message it embeds (embeddedMessages, those inside the message a pin carries
 * included) and the quote inside one, whose reply Telegram leaves out; each poll option someone added (added_by_user,
 * added_by_chat), in the message's own poll, the pinned message's or an embedded message's; and an option deleted from
 * a poll (poll_option_deleted) with its text, whose adder Telegram does not name. Every value is the message's own
 * object, so cutHeld takes it out of that message.
 */
export interface Held {kind:'message'|'quote'|'option'|'deleted_option';path:HeldPath;value:Record<string,any>}
export function heldBy(message:Record<string,any>):Held[] {
  const embedded=embeddedMessages(message,true),pinned=record(message.pinned_message),found:Held[]=[];
  for(const item of embedded) {
    found.push({kind:'message',path:item.path,value:item.message});
    if(record(item.message.quote))found.push({kind:'quote',path:[...item.path,'quote'],value:item.message});
  }
  for(const holder of [{path:[] as HeldPath,message},...(pinned?[{path:['pinned_message'] as HeldPath,message:pinned}]:[]),...embedded]) {
    const options=record(holder.message.poll)?.options;
    if(Array.isArray(options))options.forEach((option,index)=>{
      const added=record(option);
      if(added&&(added.added_by_user!==undefined&&added.added_by_user!==null||added.added_by_chat!==undefined&&added.added_by_chat!==null))
        found.push({kind:'option',path:[...holder.path,'poll','options',index],value:added});
    });
    const deleted=record(holder.message.poll_option_deleted);
    if(deleted&&(deleted.option_text!==undefined||deleted.option_text_entities!==undefined))
      found.push({kind:'deleted_option',path:[...holder.path,'poll_option_deleted'],value:deleted});
  }
  return found;
}
/** A place as one comparable key. */
export const heldKey=(path:HeldPath):string=>JSON.stringify(path);
/** Whether `inner` is at or inside `outer`. */
export const heldWithin=(inner:HeldPath,outer:HeldPath):boolean=>outer.length<=inner.length&&outer.every((part,index)=>inner[index]===part);
/**
 * Takes out of a message what heldBy found in it: an embedded message, the quote inside one or a poll option goes whole,
 * and a deleted option loses its text, while the rest of the message stays. The deepest places go first, and a list's
 * later items before its earlier ones, so each place still names what it named.
 */
export function cutHeld(message:Record<string,any>,items:readonly Held[]):void {
  const ordered=[...items].sort((a,b)=>b.path.length-a.path.length||String(b.path.at(-1)).localeCompare(String(a.path.at(-1)),undefined,{numeric:true}));
  for(const item of ordered) {
    if(item.kind==='deleted_option'){delete item.value.option_text;delete item.value.option_text_entities;continue;}
    let parent:unknown=message;
    for(const part of item.path.slice(0,-1))parent=(parent as any)?.[part];
    const last=item.path.at(-1);
    if(Array.isArray(parent)&&typeof last==='number'&&parent[last]===item.value)parent.splice(last,1);
    else if(record(parent)&&typeof last==='string')delete (parent as Record<string,any>)[last];
  }
}
/** The places (heldKey) of what a message holds that is Nocheh's own words, by the bot the update came to, compared by
 *  equality alone (nochehWords): a message it embeds that Nocheh sent or first sent, or a quote inside one that quotes
 *  Nocheh's words (nochehQuoted). Everyone's copy loses them; with no known bot, none is. */
export function nochehHeld(message:unknown,bot:string|null):string[] {
  const found=record(message);if(!found)return [];
  return heldBy(found).filter(item=>item.kind==='message'?nochehWords(item.value,bot):item.kind==='quote'&&nochehQuoted(item.value,bot)).map(item=>heldKey(item.path));
}

/**
 * A Telegram Desktop export: its author is the account the archive proved for it (authored_by), never a name. An
 * export's checklist (todo_list) and poll (its answers) name no one per task or answer and show their final state, so
 * either may hold someone else's entries: such a message holds words that may be someone else's (`held`, pinned
 * 'other'), whoever sent it. Its text is still learned.
 */
function desktop(kind:string,payload:unknown,authors:FactsInput['authors'],owner:string|null):SourceFacts {
  const body=record(payload),message=record(body?.message);
  if(!message)return none;
  const found=(authors??[]).length===1?authors![0]!:null;
  const author:Author=!found?'unknown':found.kind==='conversation'?'anonymous':found.kind!=='actor'?'unknown':
    found.namespace==='bot-api'&&owner!==null&&found.external_id===owner?'owner':'person';
  const account=found?.kind==='actor'&&found.namespace==='bot-api'&&isTelegramAccount(found.external_id)?accountIdFor('telegram',found.external_id):null;
  const held=!!record(message.todo_list)||!!record(message.poll);
  return {...none,author,account,name:text(message.from),act:kind==='telegram_desktop_message'?'message':'other',...forwarded(message),
    ...(held?{pinned:'other' as const,held:true}:{}),file_name:text(message.file_name)};
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
  if(input.channel==='telegram'&&input.kind==='telegram_update')facts=telegram(input.payload,owner,input.owner_chat===true);
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
 *  else's message, nothing it holds that may be someone else's (a checklist or poll others may have added to, a deleted
 *  option's text, a message it embeds that is not the owner's own) and no text read from a file or audio file. The
 *  owner's own voice, transcribed, is the owner's. */
export const ownerTyped=(f:SourceFacts):boolean=>f.author==='owner'&&['message','edit','reaction','browser'].includes(f.act)&&
  (f.forward===null||f.forward==='own')&&f.quote!=='other'&&f.pinned!=='other'&&!f.file&&!f.audio;

type By='owner'|'person';
type LearnedClass=Exclude<SendClass,'card'|'card_update'|'refusal'|'notice'|'reminder'>;
/** One fixed token for what kind of message an event is. `quote_nocheh` is the owner's reply quoting Nocheh's own learned
 *  message, and `pinned_nocheh` the owner's pin of one, which only NoteSourceRepository.classesFor tells, by the archive's
 *  reply relation and the pinned message found the same way; eventClass alone calls them a quote and a pin. `pinned` is
 *  also a message that holds words that may be someone else's itself (SourceFacts.held), which is not a pin. */
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
 * a file's or an audio file's text, then a quote of someone else's message, then a pin of someone else's message or a
 * message holding words that may be someone else's; only what is left is the sender's own message.
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
