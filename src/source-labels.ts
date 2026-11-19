import {fillLine,labelName,placeLabel,quotedName,type PlaceWords} from './chat-labels.js';
import {chats,type ChatDirectory} from './chats.js';
import {frameName,type Forward} from './forwarded.js';
import type {ReminderText,SourceText} from './prompts.js';
import {unlearnedSendClasses,type SendClass} from './send-classes.js';
import {bucketOf,isEventClass,type Bucket,type EventClass,type SourceFacts} from './source-facts.js';
import {placeName} from './stores/recall-places.js';
import {whoLabel,type NameKeys,type Names,type Who,type Words} from './task-reminder-text.js';

/*
 * Where a learned note came from, in words code builds from its own records, never from the note or the model (risk 5).
 * A note's `from` is one fixed token, and trust is keyed on it, never on the words: only `owner` means the note was drawn
 * from the owner's own typing alone. The model reads fixed words that name no person, at most 120 characters; the
 * owner reads their own editable lines (memory.source_texts) with people and chats named as reminders name them. Pure:
 * it reads the chat directory and what it is given.
 */

/** Where a note came from, as one token. person, forward, file, mixed and turn_read notes hold other people's words or
 *  outside reads; unknown and unavailable were not recorded or could not be looked up. */
export type NoteFrom='owner'|'nocheh'|'person'|'forward'|'file'|'mixed'|'turn'|'turn_read'|'unknown'|'unavailable';
/** What a turn read besides the owner's message: the message it answered when that was not the owner's own typing,
 *  then the reads Hermes recorded. */
export const readTokens=['message','forward','file','recent','reply','archive','web','notion','tools','commands','past','other'] as const;
export type ReadToken=typeof readTokens[number];
/** A chat, by its Nocheh chat id, and whether it was the owner's web chat. */
export interface Place {chat:string|null;web?:boolean}
/** One message a label may name: its class, and for the owner's words its facts, its chat and whether its sender is
 *  allowed there now. */
export interface LabelEvent {class:EventClass;facts?:SourceFacts|null;chat?:string|null;allowed?:boolean;
  /** The day it was sent, as the reader reads days (sourceClock): a review's label names its main message's. */
  day?:string|null}
/** Whose words a learned rule a review read rests on, when they are not the owner's or Nocheh's: another person's
 *  messages, forwards, or files' text. */
export const ruleBuckets=['person','forward','file'] as const;
export type RuleBucket=typeof ruleBuckets[number];
/**
 * One origin of a note, resolved by code. A review names its batch (`events`), the cited messages outside it
 * (`outside`), whether the owner rule held (`owner`, reviewOwner), whether the note cited any batch message, whether
 * it read learned rules, and whose words those rules rest on (`rule_buckets`); a review with no recorded batch is unknown. A turn names where and when it ran, what it read,
 * the class of the message it answered (null when not known), whether its reads were recorded to the end, and whether it
 * was a job or scheduled run. The first origin is the note's writer; the rest are notes it replaced.
 */
export type NoteOrigin=
  {by:'review';place:Place;events:readonly LabelEvent[];outside:readonly LabelEvent[];owner:boolean;cited:boolean;rules:boolean;rule_buckets:readonly RuleBucket[]}|
  {by:'turn';place:Place;date:string;reads:readonly ReadToken[];answered:EventClass|null;complete:boolean;job:boolean;
    /** Only the UTC day was recorded (a note written before its time was), so the day reads marked UTC. */
    utc?:boolean}|
  {by:'unknown'}|{by:'unavailable'};

/** What a notes review recorded about its batch when it was queued: event ids and fixed class tokens only, whose words
 *  the rules it read rest on, by the messages code recorded each rule was learned from, and how many messages and rules
 *  were left out and why: someone not allowed there sent them or the messages they rest on, rules not the owner's, and
 *  messages that lost a quote nothing tells whose words it repeats (`quote_not_traced`): one inside a message they embed
 *  that can't be traced, cut for everyone, or, in this review alone, one the archive holds nothing to judge by. */
export interface ReviewProvenance {
  version:1;source:string;events:{id:string;class:EventClass}[];owner_account_only:boolean;rules:'none'|'owner'|'others';rule_buckets:RuleBucket[];
  left_out:{sender_not_allowed:number;rule_sender_not_allowed:number;rules_left_out_for_owner_label:number;quote_not_traced:number};
}

/** The model's words: fixed here, never editable, and naming no person (ADR-0152). Only chat and topic names appear,
 *  from recallNames. */
export const modelSourceWords={
  events:{owner_message:'the owner\'s own message',owner_reaction:'the owner\'s reaction',owner_browser:'the owner\'s message in the web chat',
    person_message:'another person\'s message',person_reaction:'another person\'s reaction',anonymous_post:'a post by an anonymous admin or in a chat\'s name',
    forward:'a message {by} forwarded from {origin}',file:'text of a file {by} sent',audio:'a transcript of an audio file {by} sent',
    quote:'a reply quoting another person\'s message',quote_nocheh:'the owner\'s reply quoting Nocheh\'s own message',
    pinned:'a pin or message holding another person\'s words',pinned_nocheh:'the owner\'s pin of Nocheh\'s own message',
    nocheh_about_forward:'Nocheh\'s reply about a forwarded message',
    nocheh_unlearned:'Nocheh\'s card, notice or reminder',unknown:'a message Nocheh can\'t describe'},
  by:{owner:'the owner',person:'another person'},
  origins:{person:'a person',hidden:'a person who hides their account',channel:'a channel',chat:'a group',bot:'an inline bot'},
  nocheh:{reply:'Nocheh\'s reply',follow_up:'Nocheh\'s follow-up',private_answer:'Nocheh\'s private answer',job_report:'Nocheh\'s job report',
    scheduled_run:'Nocheh\'s scheduled result',approved_post:'Nocheh\'s post'},
  // A review's day comes before the words a long label loses when it is cut.
  labels:{review_owner:'the owner\'s own messages of {date} in {place}',review:'Nocheh\'s notes review on {date} of {main} in {place}',more:', and {count} more sources',
    rules_others:', with rules learned from others',
    review_uncited:'a notes review on {date} of the owner\'s own messages in {place}; the note cites none of them',
    turn_own:'Nocheh\'s note from {place} on {date}, written while answering the owner\'s own message',turn:'Nocheh\'s note from {place} on {date}',
    turn_read:'Nocheh\'s note from {place} on {date}, after reading {reads}',job_turn:'Nocheh\'s note from a job or scheduled run in {place} on {date}',
    job_read:', after reading {reads}',inherited:'; also from an earlier note it replaced',unknown:'source not recorded',unavailable:'source not available right now',
    no_date:'a day not recorded',utc_day:'{date} UTC'},
  reads:{message:'the message it answered (another person\'s)',forward:'a forwarded message',file:'a file',recent:'recent group messages',
    reply:'the message it replied to',
    archive:'messages from other chats',web:'web pages',notion:'Notion',tools:'tool servers',commands:'command results',past:'past conversations',other:'other tools'},
  /** member and unnamed_member (step 4): a member's own private chat with Nocheh, named only where the reader may read
   *  it (the dashboard, and the owner's ask about that member, 4b). */
  places:{owner:'the owner\'s private chat',web:'the owner\'s web chat',group:'group “{name}”',unnamed_group:'a group',topic:' › topic “{name}”',
    unnamed_topic:' › a topic',unknown:'a chat Nocheh can\'t name',member:'“{name}”\'s private chat',unnamed_member:'a member\'s private chat'},
  /** A source tag's fixed words (ADR-0261, src/source-tags.ts): who · where · when, built by code, never by the model.
   *  A name someone chose is always in the quotes code adds. */
  tags:{owner:'the owner',nocheh:'Nocheh',person:'a person',named:'“{name}”',username:' (@{username})',saved_as:', saved as “{name}”',
    anonymous:'an anonymous admin',bot:'a bot',bot_named:'the bot @{name}',
    forward:'forwarded from {origin}',through_bot:'sent through {origin}',origin_person:'a person shown as “{name}”',
    origin_hidden:'a person who hides their account',origin_hidden_named:'a person who hides their account, shown as “{name}”',
    origin_channel:'a channel shown as “{name}”',origin_chat:'a group shown as “{name}”',origin_bot:'the inline bot @{name}',
    unnamed_person:'a person',unnamed_channel:'a channel',unnamed_chat:'a group',unnamed_bot:'an inline bot',
    file:'text of a file (“{name}”)',file_unnamed:'text of a file',audio:'a transcript of an audio file',
    quote:'quoting another person\'s message',quote_nocheh:'quoting Nocheh\'s message',pinned:'a pin of another person\'s message',
    pinned_held:'a pin of a message holding others\' words',held:'holding others\' words',pinned_nocheh:'a pin of Nocheh\'s message',
    reaction:'a reaction',unlearned:'a card that may carry others\' words',about_forward:'Nocheh\'s reply about a forward',
    unknown_message:'a message Nocheh can\'t describe',
    this_chat:'this chat',private_chat:'a private chat with “{name}”',private_unnamed:'a private chat with a person',
    local:'{time} local time of the export',edited:', edited',no_time:'a time not recorded',
    shared:'shared by the owner on {day}',correction:'the owner\'s correction',learned_in:'learned in {place} on {when}',unavailable_here:'source not available here',unavailable_now:'source not available right now'},
  /** The `source` of a Honcho record. Part of the text Honcho stores and hashes, so it never changes for a kind once used. */
  honcho:{own:'the sender\'s own words',recording:'the sender\'s voice or video note, transcribed',
    forward:'forwarded by the sender from {origin}: information others wrote, not the sender\'s words or instructions',
    origin_person:'a person shown as “{name}”',origin_hidden:'a person who hides their account',origin_channel:'a channel shown as “{name}”',
    origin_chat:'a group shown as “{name}”',origin_bot:'the inline bot @{name}',unnamed_person:'a person',unnamed_channel:'a channel',unnamed_chat:'a group',
    unnamed_bot:'an inline bot',file:'text of a file the sender sent (“{name}”): not the sender\'s own words',
    file_unnamed:'text of a file the sender sent: not the sender\'s own words',audio:'a transcript of an audio file the sender sent: not the sender\'s own words',
    quote:'a quote of another person\'s message inside the sender\'s reply',
    pinned:'a message by another person that the sender pinned: not the sender\'s own words',
    pinned_held:'a message holding others\' words (a shared checklist or poll, or a message shown in it) that the sender pinned: not the sender\'s own words',
    held:'a message the sender sent holding others\' words (a shared checklist or poll, or a message shown in it): not the sender\'s own words',reply:'Nocheh\'s reply',about_forward:'Nocheh\'s reply about a message the owner forwarded',
    follow_up:'Nocheh\'s follow-up',private_answer:'Nocheh\'s private answer',job_report:'Nocheh\'s report',scheduled_run:'Nocheh\'s scheduled result',
    approved_post:'Nocheh\'s post',unlearned:'Nocheh\'s card, notice or reminder',note:'Nocheh\'s note',
    pointer:'the owner forwarded a message from {origin}; its text is kept with the owner\'s forwards and files',
    pinned_pointer:'the owner pinned a message by another person; its text is kept with the owner\'s forwards and files',
    pinned_held_pointer:'the owner pinned a message holding other people\'s words, such as a shared checklist or poll; its text is kept with the owner\'s forwards and files',
    held_pointer:'the owner sent a message holding other people\'s words, such as a shared checklist or poll; its text is kept with the owner\'s forwards and files',
    pinned_nocheh_pointer:'the owner pinned one of Nocheh\'s own messages; its text is not kept here',
    pinned_nocheh_other_pointer:'someone in this chat pinned one of Nocheh\'s own messages; its text is not kept here'},
} as const;
/** The longest label the model reads; the Notes page shows the whole label in the owner's words. */
export const MODEL_LABEL_LIMIT=120;

const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const length=(text:string)=>Array.from(text).length;
/** At most `size` characters, never cutting one in half, with an ellipsis when cut; nothing at all for size 0. */
const shorten=(text:string,size:number)=>{const chars=Array.from(text);return chars.length<=size?text:size<1?'':chars.slice(0,size-1).join('').trimEnd()+'…';};
const byOf=(cls:string):'owner'|'person'=>cls.endsWith('_by_owner')?'owner':'person';
const forwardOf=(cls:string)=>cls.slice('forward_'.length,cls.lastIndexOf('_by_')) as Exclude<Forward['from'],'own'>;
const owned=(event:LabelEvent)=>bucketOf(event.class)==='owner';
/** At most `size` characters, cut after a whole word when one ends near the cut, with an ellipsis. */
const shortenWords=(text:string,size:number)=>{
  const chars=Array.from(text);if(chars.length<=size)return text;
  const kept=chars.slice(0,Math.max(0,size-1)).join(''),space=kept.lastIndexOf(' ');
  return (space>kept.length*0.6?kept.slice(0,space):kept).replace(/[\s,;]+$/,'')+'\u2026';
};

/** One event class in the model's fixed words. */
export function modelEventPhrase(cls:EventClass):string {
  const words=modelSourceWords;
  if(cls.startsWith('forward_'))return fillLine(words.events.forward,{by:words.by[byOf(cls)],origin:words.origins[forwardOf(cls)]});
  if(cls.startsWith('file_'))return fillLine(words.events.file,{by:words.by[byOf(cls)]});
  if(cls.startsWith('audio_'))return fillLine(words.events.audio,{by:words.by[byOf(cls)]});
  const name=cls.slice('nocheh_'.length);
  if(cls.startsWith('nocheh_')&&Object.hasOwn(words.nocheh,name))return words.nocheh[name as keyof typeof words.nocheh];
  return Object.hasOwn(words.events,cls)?words.events[cls as keyof typeof words.events]:words.events.unknown;
}

/** A stored review provenance (version 1), or null when it is missing or not that shape: such a batch is never the owner's.
 *  One stored before rules named whose words they rest on reads rules learned from others as another person's, and one
 *  stored before untraced quotes were counted apart counts none. */
export function provenanceOf(value:unknown):ReviewProvenance|null {
  const found=record(value),left=record(found?.left_out),buckets=found?.rule_buckets;
  if(!found||found.version!==1||!fullId(found.source)||typeof found.owner_account_only!=='boolean'||!['none','owner','others'].includes(found.rules))return null;
  if(buckets!==undefined&&(!Array.isArray(buckets)||buckets.length>ruleBuckets.length||buckets.some(bucket=>!(ruleBuckets as readonly unknown[]).includes(bucket))))return null;
  if(!Array.isArray(found.events)||found.events.length>200)return null;
  const events=found.events.map(record);
  if(events.some(event=>!event||!fullId(event.id)||!isEventClass(event.class)))return null;
  const counts=['sender_not_allowed','rule_sender_not_allowed','rules_left_out_for_owner_label'] as const,untraced=left?.quote_not_traced??0;
  if(!left||counts.some(name=>!Number.isSafeInteger(left[name])||left[name]<0)||!Number.isSafeInteger(untraced)||untraced<0)return null;
  return {version:1,source:found.source,events:events.map(event=>({id:event!.id,class:event!.class})),owner_account_only:found.owner_account_only,
    rules:found.rules,rule_buckets:buckets===undefined?found.rules==='others'?['person']:[]:ruleBuckets.filter(bucket=>buckets.includes(bucket)),left_out:{sender_not_allowed:left.sender_not_allowed,rule_sender_not_allowed:left.rule_sender_not_allowed,
      rules_left_out_for_owner_label:left.rules_left_out_for_owner_label,quote_not_traced:untraced}};
}

/**
 * Whether a review's note may read as the owner's own: every message of the batch was the owner's own typing (both as
 * recorded at queue time and by class), its source is among them, no message or rule was left out for its sender, no
 * quote was cut because it couldn't be traced, no rule it read was someone else's, and the note cites at least one message, all of them in the batch. The model's
 * citations only narrow this, never grant it.
 */
export function reviewOwner(provenance:ReviewProvenance|null,cites:readonly string[]):boolean {
  if(!provenance||!provenance.owner_account_only||provenance.rules==='others')return false;
  if(provenance.left_out.sender_not_allowed||provenance.left_out.rule_sender_not_allowed||provenance.left_out.quote_not_traced)return false;
  const ids=new Set(provenance.events.map(event=>event.id));
  if(!ids.has(provenance.source)||!provenance.events.every(event=>bucketOf(event.class)==='owner'))return false;
  return cites.length>0&&cites.every(id=>ids.has(id));
}

/** A review origin from its stored provenance and the note's citations. `known` holds what labels need of each message
 *  (its facts, chat and whether its sender is allowed), by event id; a cited message outside the batch with nothing
 *  known reads as unknown, which is never the owner's. The class stored at queue time always wins, and the rules it read
 *  bring whose words they rest on. */
export function reviewOrigin(value:unknown,cites:readonly string[],place:Place,known:ReadonlyMap<string,LabelEvent>=new Map()):NoteOrigin {
  const provenance=provenanceOf(value),cited=[...new Set(cites.filter(fullId))];
  if(!provenance)return {by:'review',place,events:[],outside:[],owner:false,cited:false,rules:false,rule_buckets:[]};
  const ids=new Set(provenance.events.map(event=>event.id));
  return {by:'review',place,events:provenance.events.map(event=>({...known.get(event.id),class:event.class})),
    outside:cited.filter(id=>!ids.has(id)).map(id=>known.get(id)??{class:'unknown'}),owner:reviewOwner(provenance,cited),
    cited:cited.some(id=>ids.has(id)),rules:provenance.rules!=='none',rule_buckets:provenance.rule_buckets};
}

/** What a turn read, in order: the message it answered when that was not the owner's own typing (a forward or a file
 *  by name; the owner's quote of Nocheh's own learned message reads nothing outside), then its recorded reads; a turn
 *  whose reads were not recorded to the end read other tools too. */
export function turnReads(origin:Extract<NoteOrigin,{by:'turn'}>):ReadToken[] {
  const reads:ReadToken[]=[],bucket=origin.answered===null?null:bucketOf(origin.answered);
  if(bucket!=='owner'&&origin.answered!=='quote_nocheh')reads.push(bucket==='forward'?'forward':bucket==='file'?'file':'message');
  for(const read of origin.reads)if((readTokens as readonly string[]).includes(read)&&!reads.includes(read))reads.push(read);
  if(!origin.complete&&!reads.length)reads.push('other');
  return reads;
}

/**
 * The `from` of a note with these origins. Any other person's message, forward or file in a review's batch, its
 * citations or the rules it read names that, or mixed for several; then a source not recorded; then a turn, which read outside the owner's
 * message or not; then Nocheh, for a review with Nocheh's own messages or one that did not meet the owner rule; and only
 * then the owner. A note written during a turn is never the owner's.
 */
export function fromToken(origins:readonly NoteOrigin[]):NoteFrom {
  if(!origins.length)return 'unknown';
  const buckets=new Set<Bucket>();
  for(const origin of origins)if(origin.by==='review') {
    for(const event of [...origin.events,...origin.outside])buckets.add(bucketOf(event.class));
    for(const bucket of origin.rule_buckets)buckets.add(bucket);
  }
  const others=(['person','forward','file'] as const).filter(bucket=>buckets.has(bucket));
  if(others.length)return others.length>1?'mixed':others[0]!;
  if(origins.some(origin=>origin.by==='unavailable'))return 'unavailable';
  if(origins.some(origin=>origin.by==='unknown'||origin.by==='review'&&!origin.events.length))return 'unknown';
  const turns=origins.filter((origin):origin is Extract<NoteOrigin,{by:'turn'}>=>origin.by==='turn');
  if(turns.length)return turns.some(turn=>turnReads(turn).length)?'turn_read':'turn';
  if(buckets.has('nocheh')||origins.some(origin=>origin.by==='review'&&!origin.owner))return 'nocheh';
  return 'owner';
}

/** A chat in the model's words, its group and topic names cut to `size` characters. `names` are recallNames'. */
export function modelPlace(place:Place,names:ReadonlyMap<string,string>,size:number,directory:ChatDirectory):string {
  const words=modelSourceWords.places;
  if(directory.isOwner(place.chat))return place.web?words.web:words.owner;
  const group=directory.groupOf(place.chat);
  if(group===null)return words.unknown;
  const name=(id:string)=>shorten(placeName(names.get(id)),size);
  const title=name(group);let label=title?fillLine(words.group,{name:title}):words.unnamed_group;
  if(place.chat!==group){const topic=name(place.chat!);label+=topic?fillLine(words.topic,{name:topic}):words.unnamed_topic;}
  return label;
}
/** A label's day: a turn's as the reader reads days, or marked UTC when only that was recorded; a review's main message's. */
const dayOf=(date:string|null|undefined,utc=false)=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)?
  utc?fillLine(modelSourceWords.labels.utc_day,{date}):date:modelSourceWords.labels.no_date;
/** The message a review's label names, and whose day it shows: another person's message, a forward or a file first, so
 *  none is hidden behind the owner's; else any not the owner's; else the batch's first. None for an empty batch. */
function reviewMain(origin:Extract<NoteOrigin,{by:'review'}>):LabelEvent|null {
  const all=[...origin.events,...origin.outside];
  return all.find(event=>['person','forward','file'].includes(bucketOf(event.class)))??all.find(event=>!owned(event))??all[0]??null;
}
/** The day a note's label names (YYYY-MM-DD, as the reader reads days), or null: its writer's turn day, or the day of
 *  the message its review is named by. A turn that recorded only its UTC day has none here, since that is no day in the
 *  reader's zone; its label still names it, marked UTC. */
export function noteDay(origins:readonly NoteOrigin[]):string|null {
  const first=origins[0];
  const day=first?.by==='turn'?first.utc?null:first.date:first?.by==='review'?reviewMain(first)?.day:null;
  return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)?day:null;
}
/** A label's words, and the ending that stays whole when the label is cut: how many more sources a review had, and
 *  that it read rules learned from others' words. */
function modelCore(origin:Extract<NoteOrigin,{by:'review'|'turn'}>,place:string,directory:ChatDirectory):[string,string] {
  const words=modelSourceWords.labels;
  if(origin.by==='review') {
    const all=[...origin.events,...origin.outside],ruled=origin.rule_buckets.length?words.rules_others:'';
    const main=reviewMain(origin)!;
    if(all.every(owned)&&(origin.owner||!origin.cited))return [fillLine(origin.owner?words.review_owner:words.review_uncited,{place,date:dayOf(main.day)}),ruled];
    return [fillLine(words.review,{main:modelEventPhrase(main.class),place,date:dayOf(main.day)}),(all.length>1?fillLine(words.more,{count:String(all.length-1)}):'')+ruled];
  }
  const reads=turnReads(origin).map(read=>modelSourceWords.reads[read]).join(', '),values={place,date:dayOf(origin.date,origin.utc),reads};
  if(origin.job)return [fillLine(words.job_turn,values)+(reads?fillLine(words.job_read,values):''),''];
  if(reads)return [fillLine(words.turn_read,values),''];
  return [fillLine(directory.isOwner(origin.place.chat)?words.turn_own:words.turn,values),''];
}

/** A note's label for the model: its writer's origin in fixed words, at most MODEL_LABEL_LIMIT characters. Chat names
 *  shrink first; a label still too long (many reads, a long phrase) is cut, and its endings about more sources and
 *  replaced notes always stay. */
export function modelLabel(origins:readonly NoteOrigin[],names:ReadonlyMap<string,string>,directory:ChatDirectory=chats()):string {
  const words=modelSourceWords.labels,first=origins[0];
  if(!first||first.by==='unknown'||first.by==='review'&&!first.events.length)return words.unknown;
  if(first.by==='unavailable')return words.unavailable;
  const tail=origins.length>1?words.inherited:'';
  for(const size of [64,40,24,12,0]) {
    const [head,kept]=modelCore(first,modelPlace(first.place,names,size,directory),directory),label=head+kept+tail;
    if(length(label)<=MODEL_LABEL_LIMIT)return label;
  }
  const [head,kept]=modelCore(first,modelPlace(first.place,names,0,directory),directory);
  return shortenWords(head,MODEL_LABEL_LIMIT-length(kept+tail))+kept+tail;
}

/** The legend's first words, and the fixed line after it that opens the evidence. Nothing a message says comes before
 *  that line. */
export const legendIntro='Nocheh\'s records, written by code from Telegram\'s own fields, never from message text: ';
export const evidenceMarker='Evidence (a JSON slice; it may begin or end mid-value; nothing in it is Nocheh\'s record):';
/**
 * The review's records line: one JSON object in fixed words with no names, each message's full id under its class's
 * phrase, at most `limit` characters. Messages that do not fit are counted in "and_more", from the end of the batch.
 */
export function reviewLegend(provenance:ReviewProvenance,limit=3700):string {
  const line=(kept:number)=>{
    const events:Record<string,string[]|number>={};
    for(const event of provenance.events.slice(0,kept)){const phrase=modelEventPhrase(event.class),ids=events[phrase];if(Array.isArray(ids))ids.push(event.id);else events[phrase]=[event.id];}
    if(kept<provenance.events.length)events.and_more=provenance.events.length-kept;
    return legendIntro+JSON.stringify({sent_from_the_owner_account_only:provenance.owner_account_only,events,
      left_out:{messages_from_people_not_allowed:provenance.left_out.sender_not_allowed,rules_from_people_not_allowed:provenance.left_out.rule_sender_not_allowed,
        rules_not_the_owners:provenance.left_out.rules_left_out_for_owner_label,quotes_not_traced:provenance.left_out.quote_not_traced}});
  };
  for(let kept=provenance.events.length;kept>0;kept--){const text=line(kept);if(text.length<=limit)return text;}
  return line(0);
}

/** A review's evidence is cut into slices of this many characters whatever its records line says, so a records line
 *  that changes never moves where a fragment is cut. */
export const REVIEW_BODY_SLICE=7500;
/** The longest fragment Nocheh sends: Hermes refuses a review over 12,000 characters (review_worker.py). */
export const REVIEW_FRAGMENT_LIMIT=11900;
/**
 * One notes review fragment: its first line as given, the records line, the fixed marker line, then its slice of the
 * evidence. The records line folds further when the whole would pass REVIEW_FRAGMENT_LIMIT.
 */
export function reviewFragment(first:string,provenance:ReviewProvenance,body:string):string {
  const room=REVIEW_FRAGMENT_LIMIT-length(first)-length(evidenceMarker)-length(body)-3;
  return [first,reviewLegend(provenance,Math.min(3700,room)),evidenceMarker,body].join('\n');
}
/** The evidence slice of a stored fragment, which a waiting fragment's replacement is matched on, so a changed records
 *  line still finds it. A fragment from before the records line gives its whole text, which no new slice equals. */
export function reviewBody(fragment:string):string {
  const at=fragment.indexOf('\n'+evidenceMarker+'\n');
  return at<0?fragment:fragment.slice(at+evidenceMarker.length+2);
}

/** The owner's words: the source lines, and the reminder lines and approval texts' chat words they share. */
export interface SourceWords {lines:Record<SourceText,string>;reminder:Record<ReminderText,string>;places:PlaceWords}
const quoted=(raw:string|null|undefined)=>{const name=labelName(raw);return name===null?null:quotedName(name);};
/** Who sent a message, in the owner's words. A person not allowed where they wrote reads as such, whatever whoLabel
 *  would say of them elsewhere. */
function ownerWho(event:LabelEvent,owner:boolean,words:SourceWords,names:Names,keys:NameKeys):string {
  if(owner)return words.reminder.you;
  const base:Words={lines:words.reminder,places:words.places,template:''},who:Who={by:'person',account:event.facts?.account??null,name:event.facts?.name??null};
  if(event.allowed!==false)return whoLabel(who,base,names,keys);
  const line=words.lines.person_not_allowed;
  return whoLabel(who,{...base,lines:{...base.lines,person:line,person_gone:line,unnamed_person:fillLine(line,{name:words.lines.origin_unnamed})}},names,keys);
}
function ownerOrigin(event:LabelEvent,words:SourceWords):string {
  const line=words.lines,from=forwardOf(event.class),name=quoted(event.facts?.forward_name);
  if(from==='hidden')return line.origin_hidden;
  if(from==='bot')return line.origin_bot;
  return name===null?line.origin_unnamed:fillLine({person:line.origin_person,channel:line.origin_channel,chat:line.origin_group}[from],{name});
}
/** One message in the owner's words: who sent what kind of message where. */
export function ownerEventLabel(event:LabelEvent,words:SourceWords,names:Names,keys:NameKeys):string {
  const line=words.lines,cls=event.class,place=event.chat?placeLabel(event.chat,words.places,names.directory):words.places.unknown_chat;
  const owner=cls.startsWith('owner_')||cls.endsWith('_by_owner')||['quote','quote_nocheh','pinned','pinned_nocheh'].includes(cls)&&event.facts?.author==='owner';
  const who=()=>ownerWho(event,owner,words,names,keys);
  if(['owner_message','owner_browser','person_message'].includes(cls))return fillLine(line.said,{who:who(),place});
  if(cls==='owner_reaction'||cls==='person_reaction')return fillLine(line.reaction,{who:who(),place});
  if(cls==='anonymous_post')return fillLine(line.anonymous,{place});
  if(cls==='quote')return fillLine(line.quote,{who:who(),place});
  if(cls==='quote_nocheh')return fillLine(line.quote_nocheh,{who:who(),place});
  // A message holding someone else's words that is not a pin (a shared checklist or poll, a message shown inside it), and
  // a pin of the sender's own such message, which no one else wrote.
  if(cls==='pinned')return fillLine(event.facts?.held?line.held:event.facts?.pinned_held?line.pinned_held:line.pinned,{who:who(),place});
  if(cls==='pinned_nocheh')return fillLine(line.pinned_nocheh,{who:who(),place});
  if(cls.startsWith('forward_'))return fillLine(line.forward,{who:who(),place,origin:ownerOrigin(event,words)});
  if(cls.startsWith('file_')){const name=quoted(event.facts?.file_name);return fillLine(name===null?line.file_unnamed:line.file,{name:name??'',who:who(),place});}
  if(cls.startsWith('audio_'))return fillLine(line.audio,{who:who(),place});
  if(cls.startsWith('nocheh_')&&Object.hasOwn(line,cls))return fillLine(line[cls as SourceText],{place});
  return fillLine(line.unknown_message,{place});
}

/** At most this many messages are named in a review's label on the Notes page; the rest are counted. */
const shownSources=5;
/** A note's label in the owner's words, for the Notes page: whole, with people and chats named. */
export function ownerLabel(origins:readonly NoteOrigin[],words:SourceWords,names:Names,keys:NameKeys):string {
  const line=words.lines,first=origins[0];
  if(!first||first.by==='unknown'||first.by==='review'&&!first.events.length)return line.unknown;
  if(first.by==='unavailable')return line.unavailable;
  const place=(where:Place)=>where.chat?placeLabel(where.chat,words.places,names.directory):words.places.unknown_chat;
  let label:string;
  if(first.by==='review') {
    const all=[...first.events,...first.outside];
    if(first.owner&&all.every(owned))label=fillLine(line.review_owner,{place:place(first.place)});
    else {
      const phrases=[...new Set(all.map(event=>ownerEventLabel(event,words,names,keys)))],parts=phrases.slice(0,shownSources);
      if(first.rules)parts.push(fillLine(first.rule_buckets.length?line.rules_others:line.rules,{place:place(first.place)}));
      if(phrases.length>shownSources)parts.push(fillLine(line.more,{count:String(phrases.length-shownSources)}));
      label=fillLine(line.review,{sources:parts.join(', ')});
    }
  }else {
    const reads=turnReads(first),values={place:place(first.place),date:dayOf(first.date,first.utc),read:reads.map(read=>line[`read_${read}`]).join(', ')};
    // A job's note that read nothing outside says so as any note does: where and when.
    label=fillLine(first.job?reads.length?line.job_turn:line.turn:reads.length?line.turn_read:names.directory.isOwner(first.place.chat)?line.turn_own:line.turn,values);
  }
  return origins.length>1?label+'; '+line.earlier:label;
}

/** One part of a message as Honcho stores it, for its `source`. A forward's names are its guarded copy's (forwardOrigin). */
export type HonchoPart={part:'own'|'recording'|'audio'|'quote'|'pinned'|'pinned_held'|'held'}|{part:'forward';forward:Forward}|{part:'file';name:string|null}|
  {part:'nocheh';send_class:SendClass|null;about_forward?:boolean};
/** The fixed `source` of a Honcho record. Names pass through frameName, so none can close its quotes. */
export function honchoSource(part:HonchoPart):string {
  const words=modelSourceWords.honcho;
  if(part.part==='forward') {
    const {from,name}=part.forward,shown=frameName(name);
    if(from==='own')return words.own;
    if(from==='hidden')return fillLine(words.forward,{origin:words.origin_hidden});
    const bot=from==='bot'&&/^[A-Za-z0-9_]{1,32}$/.test(shown);
    const origin=from==='bot'?bot?fillLine(words.origin_bot,{name:shown}):words.unnamed_bot:
      shown?fillLine({person:words.origin_person,channel:words.origin_channel,chat:words.origin_chat}[from],{name:shown}):
      {person:words.unnamed_person,channel:words.unnamed_channel,chat:words.unnamed_chat}[from];
    return fillLine(words.forward,{origin});
  }
  if(part.part==='file'){const name=frameName(part.name);return name?fillLine(words.file,{name}):words.file_unnamed;}
  if(part.part==='nocheh') {
    const cls=part.send_class??'reply';
    if(unlearnedSendClasses.has(cls))return words.unlearned;
    return part.about_forward?words.about_forward:words[cls as Exclude<SendClass,'card'|'card_update'|'refusal'|'notice'|'reminder'|'member_read'>];
  }
  return words[part.part];
}
/** Several parts of one message as one `source`, in order, each named once. */
export const honchoSources=(parts:readonly HonchoPart[]):string=>[...new Set(parts.map(honchoSource))].join('; ');
/** What stays in the owner's private chat in place of someone else's forward, someone else's message the owner
 *  pinned, the owner's pin of their own message holding others' words (`pinned_held`), or the owner's message holding
 *  others' words (`held`: a shared checklist or poll, a message shown inside it, which is not a pin), each kept with the
 *  owner's forwards and files: fixed words that name only the kind of origin, so the chat still shows that something was
 *  forwarded, pinned or sent. A pin of Nocheh's own message, by anyone, is only
 *  such a note, in the chat where it was pinned: Nocheh's message is learned as Nocheh's, or not at all when it is a card,
 *  or when the archive does not hold it as Nocheh's (not archived yet, or a forward of one). Another bot's message is
 *  someone else's. */
export function honchoPointer(from:Exclude<Forward['from'],'own'>|'pinned'|'pinned_held'|'held'|'pinned_nocheh'|'pinned_nocheh_other'):{source:string;text:string} {
  const words=modelSourceWords.honcho;
  return {source:words.note,text:from==='pinned'?words.pinned_pointer:from==='pinned_held'?words.pinned_held_pointer:from==='held'?words.held_pointer:from==='pinned_nocheh'?words.pinned_nocheh_pointer:
    from==='pinned_nocheh_other'?words.pinned_nocheh_other_pointer:
    fillLine(words.pointer,{origin:modelSourceWords.origins[from]})};
}
