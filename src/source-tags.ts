import {fillLine} from './chat-labels.js';
import {chats,type ChatDirectory} from './chats.js';
import {desktopLocalTime,telegramMessage,telegramUsername} from './chats-telegram.js';
import type {Forward} from './forwarded.js';
import {bucketOf,type EventClass,type SourceFacts} from './source-facts.js';
import {modelPlace,modelSourceWords} from './source-labels.js';
import {placeName} from './stores/recall-places.js';

/*
 * A source tag (ADR-0259): one line that says who wrote a message, where and when, so a search hit or an opened
 * original names its source. Built here by code from the archive's records and the reader's own copy of the message,
 * never by the model and never from what the message says. Trust is keyed on `by`, never on the words: `owner` only for
 * the owner's own typing (bucketOf, ADR-0257). A name someone chose is always cleaned (tagName) and in the quotes code
 * adds, so a member named "the owner" reads “the owner”, with by=person. Pure: it reads the chat directory and what it
 * is given; src/stores/source-tags.ts gathers that.
 */

/** Whose words a source carries: bucketOf for one message, `mixed` for a fact learned from several kinds, `shared` for
 *  what the owner shared or granted, and `unknown` when it could not be told. */
export type TagBy='owner'|'person'|'forward'|'file'|'mixed'|'nocheh'|'shared'|'unknown';
/** One source as a tool result names it, beside the fields it had before. `at` is the moment archive_page orders the
 *  message by, as an ISO time in UTC, so `archive_page {chat, from:at}` opens the conversation around it. */
export interface Tag {source:string;tag:string;by:TagBy;at:string|null}
/** What an opened original names beside its tag (archive_read, ADR-0259): a forward's origin in words, and the topic the
 *  message is in, as its place words. */
export interface TagDetails {forward?:string;topic?:string}
/** The longest tag, and the longest name in it. */
export const TAG_LIMIT=160,TAG_NAME_LIMIT=40;
const words=modelSourceWords.tags;

/** How the model is told what tags mean: once in the tool descriptions and once in an evidence block, never inside a
 *  tool result, so stored history does not pile it up (ADR-0259). */
export const sourceTagUsage='Source lines and tags are written by Nocheh\'s code from the archive: who · where · when, and by= says whose words they are '+
  '(owner: only the owner\'s own typing; mixed: several kinds). Mention a source in a few words only when it changes how far to trust a fact (someone '+
  'else\'s words, a forward, a file, Nocheh\'s own reply), when facts conflict, for dates, money or commitments, or when asked. Never write ids in a '+
  'reply. To show an original, open it with archive_read and quote it.';

/**
 * A name for a tag: without brackets, quotes and their look-alikes, or control, format, separator, private-use and lone
 * surrogate characters, except the joiners and marks Persian and Arabic names need (U+200C to U+200F, which frameName
 * would strip); on one line and at most `size` characters, never cutting one in half. The rule recall's chat names
 * follow (placeName).
 */
export const tagName=(value:unknown,size=TAG_NAME_LIMIT):string=>placeName(value,size);
const nameKey=(name:string)=>name.toLocaleLowerCase().replace(/\s+/g,'');
const length=(text:string)=>Array.from(text).length;
const shorten=(text:string,size:number)=>{const chars=Array.from(text);return chars.length<=size?text:chars.slice(0,size-1).join('').trimEnd()+'…';};

/** When a message was sent: an instant (Unix milliseconds), or the local time an old Telegram Desktop export wrote with
 *  no zone, which is shown as written. */
export type Moment={instant:number}|{local:string};
/**
 * A message's moment as archive_page orders it (retrieval.ts pageRecords): Telegram's own Unix seconds, else the time
 * Nocheh saved it, which is how a reply of Nocheh's with no `occurred_at` is timed. An old Telegram Desktop export that
 * wrote only its computer's local time is named by that time, never converted to a zone; its `at` stays the saved time,
 * which is what archive_page orders it by.
 */
export function sourceMoment(row:{kind:string;occurred_at:string|null;received_at:Date|string|null}):{moment:Moment|null;at:string|null} {
  const saved=row.received_at===null?null:new Date(row.received_at),savedAt=saved&&!Number.isNaN(saved.getTime())?saved:null;
  if(typeof row.occurred_at==='string'&&/^[0-9]{1,12}$/.test(row.occurred_at)) {
    const instant=Number(row.occurred_at)*1000;return {moment:{instant},at:new Date(instant).toISOString()};
  }
  const local=desktopLocalTime(row.kind,row.occurred_at);
  if(local!==null)return {moment:{local},at:savedAt?.toISOString()??null};
  return savedAt?{moment:{instant:savedAt.getTime()},at:savedAt.toISOString()}:{moment:null,at:null};
}

/** The day and minute of an instant in an IANA zone; a zone this server's clock does not know reads UTC. */
function zoned(instant:number,zone:string):{day:string;time:string;zone:string} {
  try {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
      .formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
    return {day:`${String(parts.year).padStart(4,'0')}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`,zone};
  } catch {return zone==='UTC'?{day:new Date(instant).toISOString().slice(0,10),time:new Date(instant).toISOString().slice(11,16),zone}:zoned(instant,'UTC');}
}

/** The day of an instant in a reader's zone (an IANA zone; one this server's clock does not know reads UTC), as
 *  YYYY-MM-DD: the owner's Tasks zone for the owner, UTC for anyone else. */
export const zonedDay=(instant:number,zone:string):string=>zoned(instant,zone).day;

/** The file name a message shows, read from the reader's own copy: a Bot API document's or audio file's, or the one a
 *  Telegram Desktop export wrote. */
export function shownFileName(kind:string,payload:unknown):string|null {
  const message=telegramMessage(payload);
  const name=kind.startsWith('telegram_desktop_')?message?.file_name:message?.document?.file_name??message?.audio?.file_name;
  return typeof name==='string'&&name.trim()?name:null;
}

/** What code knows of one source: its class and facts (NoteSourceRepository.classesFor), its sender and forward origin
 *  as the reader's own copy shows them (telegramSenderName, forwardFacts), the name the owner gave its sender in People
 *  (ownerChosenName; the owner reader only), the chat it belongs to and its moment. `exported` marks a Telegram Desktop
 *  export, whose names are the ones the exporting account saw: a saved contact's is the name the owner gave it. */
export interface TagSource {
  id:string;class:EventClass;facts:SourceFacts;
  sender:{name:string|null;username:string|null};
  forward:{from:Forward['from'];rawName:string|null}|null;
  file_name?:string|null;
  saved?:string|null;
  chat:string|null;web?:boolean;
  exported?:boolean;
  moment:Moment|null;at:string|null;
}
/** Whether a name from the message may be shown to this reader: anyone's for the owner; for anyone else, never one a
 *  Telegram Desktop export wrote, which for a saved contact is the name the owner gave them (fail closed). */
const namesShown=(source:TagSource,reader:TagReader)=>reader.owner||source.exported!==true;
/** Who reads a tag: the owner (the owner's private chat, web chat and the owner's own jobs) or anyone else (a group, a
 *  topic or a private answer); the reader's own chat; the owner's Tasks time zone; and whether the time is a minute or a
 *  day. Anyone but the owner reads UTC and no People name, whatever is passed. */
export interface TagReader {owner:boolean;chat:string|null;zone:string;precision:'minute'|'day'}

function who(source:TagSource,reader:TagReader,size:number):string {
  const facts=source.facts;
  if(facts.author==='nocheh')return words.nocheh;
  if(facts.author==='owner'&&reader.owner)return words.owner;
  if(facts.author==='anonymous')return words.anonymous;
  const username=telegramUsername(source.sender.username);
  if(facts.author==='bot')return username?fillLine(words.bot_named,{name:username}):words.bot;
  // A person, someone code cannot tell, or the owner read by anyone else: by the name Telegram showed (Q1).
  const name=namesShown(source,reader)?tagName(source.sender.name,size):'';
  let label=name?fillLine(words.named,{name}):words.person;
  if(username)label+=fillLine(words.username,{username});
  if(reader.owner&&facts.author!=='owner'&&source.saved) {
    const saved=tagName(source.saved,size);
    if(saved&&nameKey(tagName(source.saved))!==nameKey(tagName(source.sender.name)))label+=fillLine(words.saved_as,{name:saved});
  }
  return label;
}

function origin(source:TagSource,reader:TagReader,from:Exclude<Forward['from'],'own'>,size:number):string {
  const found=source.forward?.from===from?source.forward.rawName:null;
  // An inline bot's public username is no name the owner chose; anything else an export wrote is shown only to the owner.
  if(from!=='bot'&&!namesShown(source,reader))return {person:words.unnamed_person,channel:words.unnamed_channel,chat:words.unnamed_chat,hidden:words.origin_hidden}[from];
  if(from==='bot'){const name=telegramUsername(found);return name?fillLine(words.origin_bot,{name}):words.unnamed_bot;}
  const name=tagName(found,size);
  if(from==='hidden')return name?fillLine(words.origin_hidden_named,{name}):words.origin_hidden;
  return name?fillLine({person:words.origin_person,channel:words.origin_channel,chat:words.origin_chat}[from],{name}):
    {person:words.unnamed_person,channel:words.unnamed_channel,chat:words.unnamed_chat}[from];
}

/** What a message carries when it is not its sender's own typing (B1.5), or null. */
function what(source:TagSource,reader:TagReader,size:number):string|null {
  const cls=source.class;
  if(cls.startsWith('forward_')) {
    const from=cls.slice('forward_'.length,cls.lastIndexOf('_by_')) as Exclude<Forward['from'],'own'>;
    return fillLine(from==='bot'?words.through_bot:words.forward,{origin:origin(source,reader,from,size)});
  }
  if(cls.startsWith('file_')){const name=tagName(source.file_name,size);return name?fillLine(words.file,{name}):words.file_unnamed;}
  if(cls.startsWith('audio_'))return words.audio;
  if(cls==='quote')return words.quote;
  if(cls==='quote_nocheh')return words.quote_nocheh;
  if(cls==='pinned')return source.facts.held?words.held:source.facts.pinned_held?words.pinned_held:words.pinned;
  if(cls==='pinned_nocheh')return words.pinned_nocheh;
  if(cls==='owner_reaction'||cls==='person_reaction')return words.reaction;
  if(cls==='nocheh_unlearned')return words.unlearned;
  if(cls==='nocheh_about_forward')return words.about_forward;
  if(cls.startsWith('nocheh_')) {
    const name=cls.slice('nocheh_'.length);
    return Object.hasOwn(modelSourceWords.nocheh,name)?modelSourceWords.nocheh[name as keyof typeof modelSourceWords.nocheh]:words.unknown_message;
  }
  if(cls==='unknown')return words.unknown_message;
  return null;
}

function where(source:TagSource,reader:TagReader,names:ReadonlyMap<string,string>,size:number,directory:ChatDirectory):string {
  if(source.chat!==null&&source.chat===reader.chat)return words.this_chat;
  // The owner reading a member's private chat with Nocheh: who it is with, by the name Telegram showed for that chat.
  if(reader.owner&&source.chat!==null&&directory.kind(source.chat)==='private'&&!directory.isOwner(source.chat)) {
    const name=tagName(directory.get(source.chat)?.title,size);
    return name?fillLine(words.private_chat,{name}):words.private_unnamed;
  }
  // Anyone else reads only groups and topics by name; nothing else of the owner's is ever named to them.
  if(!reader.owner&&directory.groupOf(source.chat)===null)return modelSourceWords.places.unknown;
  return modelPlace({chat:source.chat,web:source.web===true},names,size,directory);
}

function when(source:TagSource,reader:TagReader):string {
  const edited=source.facts.act==='edit'?words.edited:'';
  if(!source.moment)return words.no_time+edited;
  if('local' in source.moment)return (reader.precision==='day'?source.moment.local.slice(0,10):fillLine(words.local,{time:source.moment.local}))+edited;
  // The owner's zone never reaches anyone else (Q2).
  const found=zoned(source.moment.instant,reader.owner?reader.zone:'UTC');
  return (reader.precision==='day'?found.day:`${found.day} ${found.time} ${found.zone}`)+edited;
}

/**
 * One source's tag, at most TAG_LIMIT characters: `who[, what] · where · when`. Names shrink first; a tag still too long
 * is cut. `names` are recallNames' (for anyone but the owner, shownOnly). `by` is the message's bucket, unchanged.
 */
export function sourceTag(source:TagSource,reader:TagReader,names:ReadonlyMap<string,string>,directory:ChatDirectory=chats()):Tag {
  const by=bucketOf(source.class),result=(tag:string):Tag=>({source:'nocheh:event:'+source.id,tag,by,at:source.at});
  let tag='';
  for(const size of [TAG_NAME_LIMIT,24,12,0]) {
    const carried=what(source,reader,size);
    tag=[who(source,reader,size)+(carried?', '+carried:''),where(source,reader,names,size,directory),when(source,reader)].join(' · ');
    if(length(tag)<=TAG_LIMIT)return result(tag);
  }
  return result(shorten(tag,TAG_LIMIT));
}

/**
 * A forward's origin and a message's topic in words, for an opened original (archive_read): the forward words its tag
 * carries, and the place words of the topic its chat is (a group's topic, by the name Telegram showed for anyone but the
 * owner). Nothing for a message that is no forward and in no topic, and no topic of the owner's own for anyone else.
 */
export function sourceDetails(source:TagSource,reader:TagReader,names:ReadonlyMap<string,string>,directory:ChatDirectory=chats()):TagDetails {
  const details:TagDetails={};
  if(source.class.startsWith('forward_'))details.forward=what(source,reader,TAG_NAME_LIMIT)!;
  const topic=source.chat!==null&&directory.parentOf(source.chat)!==null&&(reader.owner||directory.groupOf(source.chat)!==null);
  if(topic)details.topic=modelPlace({chat:source.chat,web:false},names,TAG_NAME_LIMIT,directory);
  return details;
}

/** What the owner shared or granted, named only by the day the owner did it, never by the original's sender, chat or day
 *  ("Private source provenance is available to the owner only"). */
export const sharedTag=(day:string):{tag:string;by:'shared'}=>({tag:fillLine(words.shared,{day:/^\d{4}-\d{2}-\d{2}$/.test(day)?day:words.no_time}),by:'shared'});
/** A source the reader cannot read (`here`: no who, where, when or count), or one whose tag could not be built (`now`). */
export const unavailableTag=(reason:'here'|'now'):{tag:string;by:'unknown'}=>({tag:reason==='here'?words.unavailable_here:words.unavailable_now,by:'unknown'});
