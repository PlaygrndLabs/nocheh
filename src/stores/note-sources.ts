import type pg from 'pg';
import {notesSender,ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {HttpError} from '../http.js';
import {approvalLines,ownerPrompts,reminderLines,sourceLines} from '../prompts.js';
import {sourceChat} from '../spaces.js';
import {telegramMessage} from '../chats-telegram.js';
import {bucketOf,eventClass,heldBy,heldKey,nochehHeld,nochehPinned,nochehQuoted,quotesToTrace,sourceFacts,type EventClass,type SourceFacts} from '../source-facts.js';
import {fromToken,modelLabel,modelSourceWords,noteDay,ownerEventLabel,ownerLabel,ownerOrigin,readTokens,reviewOrigin,type LabelEvent,type NoteFrom,type NoteOrigin,type ReadToken,
  type SourceWords} from '../source-labels.js';
import {nameKeys,type Who} from '../task-reminder-text.js';
import {embeddedSource,pinnedSource,sourceObjectId,type SourceIdentity} from '../source-model.js';
import type {SourceReference} from './archive.js';
import {peopleNames} from './people-names.js';
import {recallNames} from './recall-places.js';
import {sourceClock,sourceMoment,zonedDay} from '../source-tags.js';
import {ownerTimeZone} from './task-settings.js';

type Pools={archive:Pick<pg.Pool,'query'>;derived:Pick<pg.Pool,'query'>;control:Pick<pg.Pool,'query'>};
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
/** Whether a message answers another, as the archive's reply relation is made from it: in this chat, or in another. */
const replies=(message:Record<string,any>|null|undefined)=>!!record(message?.reply_to_message)||!!record(message?.external_reply);
/** Whether a message answers anything at all: as replies() tells it, or as a Telegram Desktop export records its reply
 *  (reply_to_message_id), which the archive's reply relation is made from too. */
const answers=(message:Record<string,any>|null|undefined)=>replies(message)||(message?.reply_to_message_id!==undefined&&message?.reply_to_message_id!==null);

/** The channels a turn that writes notes runs on; the scheduler's and background jobs' are jobs. */
export const turnChannels=['telegram','browser','scheduler','background'] as const;
/** One origin as Hermes's parent records it (services/hermes/note_sources.py): a notes review by its id, a turn by the
 *  message it answered, its channel, its day and what it read, or nobody known. */
export type StoredOrigin={by:'review';review:string}|
  {by:'turn';event:string;channel:typeof turnChannels[number];at:string;at_time?:number;reads:ReadToken[];complete:boolean}|{by:'unknown'};
/** One note as Hermes sends it: its key, its recorded origins and how many more it had to drop, the events it cites and
 *  whether it cites more than were sent, and the chat of the profile it is in. */
export interface NoteInput {key:string;origins:StoredOrigin[];more:number;cites:string[];more_cites:boolean;space:string|null}
/** A note's source: the fixed token trust is keyed on, and its label. */
export interface NoteSource {from:NoteFrom;label:string}
/** What of the words a message carries is Nocheh's own (NoteSourceRepository.carried), and the quotes inside the messages
 *  it embeds that can't be traced (`untraced`), which are cut for everyone too. */
export interface Carried {pinned:'learned'|'unlearned'|'bot'|null;quote:boolean;pinned_quote:boolean;held:string[];untraced:string[]}

/**
 * The stores' own day count of the memory steps whose failure Hermes never sees (ADR-0257): labelling notes and naming
 * their chats (`notes`), for Hermes's lookups before a turn or review as for recall and the Notes page, recall's ask
 * of the owner's forwards and files (`memory_read`), and building the source tags of search hits and opened originals
 * (`source_tags`, ADR-0261), and keeping a turn's note refs (`note_refs`, ADR-0261). /v1/status shows today's, and the
 * owner's notice and System › Health show each as a line of its own (`note_labels`, `forwards_read`, `source_tags`,
 * `note_refs`), apart from Hermes's lines. `done` counts the steps that worked
 * after the day's first failure of that kind.
 */
export const memoryProblemSchema=`
CREATE TABLE IF NOT EXISTS memory_problem_days (
 day date NOT NULL,kind text NOT NULL CHECK(kind IN ('notes','memory_read','source_tags','note_refs')),done integer NOT NULL DEFAULT 0,failed integer NOT NULL DEFAULT 0,
 PRIMARY KEY(day,kind)
);
-- Source tags and note refs are counted too (ADR-0261).
ALTER TABLE memory_problem_days DROP CONSTRAINT IF EXISTS memory_problem_days_kind_check;
ALTER TABLE memory_problem_days ADD CONSTRAINT memory_problem_days_kind_check CHECK(kind IN ('notes','memory_read','source_tags','note_refs'));
`;
export type MemoryProblemKind='notes'|'memory_read'|'source_tags'|'note_refs';

/**
 * What a turn's notes came from, kept for that turn alone (ADR-0261): each note's ref (the first 12 hex of its key) with
 * the messages it was written from, the review's batch or the message the turn answered, as Hermes's lookup before the
 * turn named them. archive_read {note} opens them within that turn, each through canRead. Rows go after seven days.
 * No chat is kept: the reader's own access decides what a ref opens, so nothing here is a chat value to seed.
 */
export const noteLookupSchema=`
CREATE TABLE IF NOT EXISTS note_lookups (
 turn_event text PRIMARY KEY CHECK(turn_event ~ '^[a-f0-9]{64}$'),notes jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
`;
/** How long a turn's note refs open. */
export const NOTE_LOOKUP_DAYS=7;
/** The most messages kept for one note's ref, and the most a ref opens. */
const NOTE_SOURCES_KEPT=10;
export const NOTE_SOURCES_SHOWN=5;
/** A note's ref: the first 12 hex of its key, which the turn's evidence shows beside it. */
export const noteRef=(key:string)=>key.slice(0,12);
/** Counts one step that worked or failed, today in UTC. Every failure is counted. A step that worked is counted only once
 *  today's count for its kind already holds a failure, which is all the owner's notice needs to say it works again, so
 *  the Notes page's polls, recall and each turn's lookup write nothing while nothing fails. A count that can't be
 *  written is left out: it never fails the step it counts. */
export async function countMemoryStep(control:Pick<pg.Pool,'query'>,kind:MemoryProblemKind,ok:boolean):Promise<void> {
  try {
    if(ok)await control.query(`UPDATE memory_problem_days SET done=done+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND kind=$1 AND failed>0`,[kind]);
    else await control.query(`INSERT INTO memory_problem_days(day,kind,done,failed) VALUES((now() AT TIME ZONE 'UTC')::date,$1,0,1)
      ON CONFLICT(day,kind) DO UPDATE SET failed=memory_problem_days.failed+1`,[kind]);
  }catch{}
}
/** A guard binding that moved on is the caller's to retry, never a memory step that failed (source-tags.ts re-exports it). */
export const bindingMoved=(error:unknown)=>error instanceof HttpError&&['guard_context_changed','guard_transition_pending'].includes(error.code);
/** Today's counts, in the shape the provider monitor reads Hermes's own (usage.note_rows). */
export async function memoryProblems(control:Pick<pg.Pool,'query'>):Promise<{day:string;kind:MemoryProblemKind;done:number;failed:number}[]> {
  return (await control.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,kind,done,failed FROM memory_problem_days
    WHERE day=(now() AT TIME ZONE 'UTC')::date ORDER BY kind`)).rows;
}

function storedOrigin(value:unknown):StoredOrigin|null {
  const found=record(value),keys=found?Object.keys(found).sort().join(','):'';
  if(found?.by==='unknown'&&keys==='by')return {by:'unknown'};
  if(found?.by==='review'&&keys==='by,review'&&fullId(found.review))return {by:'review',review:found.review};
  // A turn's moment (at_time, Unix seconds) came with its UTC day; a note written before it was has the day alone.
  const timed=keys==='at,at_time,by,channel,complete,event,reads';
  if(found?.by!=='turn'||keys!=='at,by,channel,complete,event,reads'&&!timed||!fullId(found.event)||!(turnChannels as readonly string[]).includes(found.channel)||
    typeof found.at!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(found.at)||typeof found.complete!=='boolean'||!Array.isArray(found.reads)||found.reads.length>12||
    found.reads.some((read:unknown)=>!(readTokens as readonly unknown[]).includes(read)))return null;
  if(timed&&!(Number.isSafeInteger(found.at_time)&&found.at_time>=0&&found.at_time<=1e11&&new Date(found.at_time*1000).toISOString().slice(0,10)===found.at))return null;
  return {by:'turn',event:found.event,channel:found.channel,at:found.at,...timed?{at_time:found.at_time as number}:{},reads:[...new Set(found.reads as ReadToken[])],complete:found.complete};
}
/**
 * A note as Hermes sends it, checked, or null: at most 10 origins of the shapes its parent writes, a count of more, at
 * most 20 cited event ids and whether it cites more. The chat it is in comes from the caller. Nothing in it is text.
 */
export function noteInput(value:unknown,space:string|null=null):NoteInput|null {
  const found=record(value);
  if(!found||!fullId(found.key)||!Array.isArray(found.origins)||found.origins.length<1||found.origins.length>10)return null;
  const origins=found.origins.map(storedOrigin),more=found.more??0,cites=found.cites??[],extra=found.more_cites??false;
  if(origins.some(origin=>origin===null)||!Number.isSafeInteger(more)||more<0||!Array.isArray(cites)||cites.length>20||!cites.every(fullId)||typeof extra!=='boolean')return null;
  if(Object.keys(found).some(name=>!['key','origins','more','cites','more_cites'].includes(name)))return null;
  return {key:found.key,origins:origins as StoredOrigin[],more,cites:[...new Set(cites as string[])],more_cites:extra,space:typeof space==='string'&&space.length<=200?space:null};
}

/**
 * Where learned notes came from (risk 5): the facts code reads about archived messages, from their originals, their
 * selected transcripts and extracted texts, and the archive's own authors, never from what they say. Event ids only go
 * in; a message that is gone or cannot be read is simply not in the result, which callers treat as unknown. Labels are
 * built here from those facts and from what Hermes's parent recorded about who wrote each note (ADR-0257).
 */
export class NoteSourceRepository {
  constructor(readonly stores:Pools,readonly policy:()=>Pick<AssistantPolicy,'owner_id'>&Partial<AssistantPolicy>,
    readonly access?:{space(reference:SourceReference):Promise<string|null>}){}

  /** The facts of each of these events, by id, in three batched reads. Whether an event is in the owner's own private
   *  chat with Nocheh is told by equality with ownerChat, as the notes review tells it, never by an id's shape. */
  async factsFor(ids:readonly string[]):Promise<Map<string,SourceFacts>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,SourceFacts>();
    if(!wanted.length)return found;
    // The authors the archive proved for an event (authored_by): only a Telegram Desktop export reads them.
    const events=(await this.stores.archive.query(`SELECT e.id,e.kind,e.channel,e.scope,e.payload,a.authors FROM events e
      LEFT JOIN LATERAL (SELECT coalesce(json_agg(json_build_object('namespace',o.namespace,'kind',o.kind,'external_id',o.external_id) ORDER BY o.id),'[]') AS authors
        FROM source_relations r JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=e.id AND r.kind='authored_by') a ON true
      WHERE e.id=ANY($1::text[])`,[wanted])).rows;
    const selected=(await this.stores.derived.query(`SELECT event_id,artifact_id,kind FROM derivative_selections WHERE event_id=ANY($1::text[])
      AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY event_id,id`,[wanted])).rows;
    const artifacts=new Map<string,{kind:string;file_name:string|null}>();
    const files=[...new Set(selected.map(item=>item.artifact_id).filter((id):id is string=>typeof id==='string'))];
    if(files.length)for(const item of (await this.stores.archive.query(`SELECT id,kind,metadata->>'file_name' AS file_name FROM artifacts WHERE id=ANY($1::text[])`,[files])).rows)
      artifacts.set(item.id,{kind:item.kind,file_name:item.file_name??null});
    const policy=this.policy(),owner=policy.owner_id,ownChat=owner===null?null:ownerChat(policy);
    for(const event of events) {
      let payload:unknown=null;
      try{payload=JSON.parse((event.payload as Buffer).toString());}catch{}
      // A derivative whose artifact is not found reads as an audio file's transcript or a file's text: never the sender's own voice.
      const derivatives=selected.filter(item=>item.event_id===event.id).map(item=>({kind:item.kind as string,artifact:artifacts.get(item.artifact_id)?.kind??'',
        file_name:artifacts.get(item.artifact_id)?.file_name??null}));
      const chat=ownChat===null?null:sourceChat({channel:event.channel,scope:event.scope});
      found.set(event.id,sourceFacts({channel:event.channel,kind:event.kind,payload,derivatives,authors:Array.isArray(event.authors)?event.authors:[],
        owner_chat:chat!==null&&chat===ownChat},owner));
    }
    return found;
  }

  /**
   * The facts and class of each of these events. A reply of Nocheh's is read with the message it answered, so a reply
   * about someone else's forward is classed as being about that forward. The owner's quote is read with the message it
   * replies to, by the archive's reply relation: a quote of Nocheh's own learned message, which is already learned as
   * Nocheh's, is `quote_nocheh`. The owner's pin is read with the message it carries, found the same way (pinnedTo): a
   * pin of Nocheh's own learned message is `pinned_nocheh`. A quote or pin of Nocheh's card, notice or reminder, of its
   * reply about a forward, of a message not found, or of anyone else's stays a quote or pin of someone else's message.
   */
  async classesFor(ids:readonly string[]):Promise<Map<string,{facts:SourceFacts;class:EventClass}>> {
    const facts=await this.factsFor(ids),owners=(test:(item:SourceFacts)=>boolean)=>[...facts].filter(([,item])=>item.author==='owner'&&test(item)).map(([id])=>id);
    const [replies,pins]=await Promise.all([this.repliedTo(owners(item=>item.quote==='other')),this.pinnedTo(owners(item=>eventClass(item)==='pinned'))]);
    const quoted=[...new Set([...replies.values(),...pins.values()].flat())].filter(id=>!facts.has(id));
    const read=new Map([...quoted.length?await this.factsFor(quoted):[],...facts]);
    const answered=[...read.values()].map(item=>item.answers).filter((id):id is string=>!!id&&!read.has(id));
    const targets=answered.length?await this.factsFor(answered):new Map<string,SourceFacts>();
    const of=(id:string|null)=>id===null?null:read.get(id)??targets.get(id)??null,classOf=(item:SourceFacts)=>eventClass(item,of(item.answers));
    const learned=(id:string)=>{const target=read.get(id);return !!target&&target.author==='nocheh'&&bucketOf(classOf(target))==='nocheh';};
    const all=(found:readonly string[]|undefined)=>!!found?.length&&found.every(learned);
    return new Map([...facts].map(([id,item])=>{
      const cls=classOf(item);
      return [id,{facts:item,class:cls==='quote'&&all(replies.get(id))?'quote_nocheh':cls==='pinned'&&all(pins.get(id))?'pinned_nocheh':cls}];
    }));
  }
  /**
   * Whether each of these pins carries Nocheh's own message, found as classesFor finds it, whoever pinned it: `learned`
   * when every revision the archive holds of it is one Nocheh learns, `unlearned` when one is Nocheh's card, notice or
   * reminder. A pin of anyone else's message, another bot's included, or of one the archive does not hold, is left out.
   */
  async pinnedNocheh(ids:readonly string[]):Promise<Map<string,'learned'|'unlearned'>> {
    return this.nochehOf(await this.pinnedTo(ids));
  }
  /** Whether each of these messages replies to Nocheh's own message, by the archive's reply relation as classesFor finds a
   *  quote's, whoever sent it: `learned` or `unlearned` as pinnedNocheh says. A reply to anyone else's message, or to one
   *  the archive does not hold, is left out. */
  async repliesToNocheh(ids:readonly string[]):Promise<Map<string,'learned'|'unlearned'>> {
    return this.nochehOf(await this.repliedTo(ids));
  }
  /**
   * What of the words each of these messages carries is Nocheh's own (ADR-0256, ADR-0257), from the archive's relations,
   * Telegram's own fields and the bot the message came to (events.bot_id, compared by equality alone: isBotAccount),
   * never an id's shape or what anything says. `pinned`: the message a pin carries is Nocheh's own, `learned` or
   * `unlearned` (pinnedNocheh), or else `bot`, Nocheh's own account's words the archive does not hold as Nocheh's message
   * (nochehPinned): a pin handled before Nocheh's delivery of that message is archived or after its capture failed, or a
   * pin of a forward of Nocheh's message, which cannot tell a card from a learned reply. `quote`: its quote is of Nocheh's
   * own words (repliesToNocheh, or nochehQuoted: a forward of Nocheh's message and a reply in another chat included).
   * `pinned_quote`: the message a pin carries quotes Nocheh's words, as the pin shows it or as the archive holds that
   * message. `held`: the places (heldKey) of what it holds that is Nocheh's own words (nochehHeld: a message it embeds,
   * or the quote inside one). A quote inside a message it embeds, whose reply Telegram leaves out (quotesToTrace), is
   * traced as the pinned message's is, through that message's own archived event (embeddedTo): it is `held` when a
   * revision of that message answers Nocheh's words, and `untraced` when the archive does not hold that message, holds
   * a revision of it that answers nothing, or holds none that shows its reply as Telegram sent it (replies): a Telegram
   * Desktop export's revision shows it only as reply_to_message_id, which can't tell Nocheh's card from a learned reply,
   * so it traces nothing alone but answers as a live revision beside it does. Both are cut for everyone, since a quote
   * only repeats part of a message that is learned from its own event. Only a message that carries any of these is in
   * the result. Another bot's message, and one sent through an inline bot, is someone else's: it carries none of these,
   * and is learned labelled as someone else's.
   */
  async carried(ids:readonly string[]):Promise<Map<string,Carried>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,Carried>();
    if(!wanted.length)return found;
    const [messages,pinnedTo,replied,embedded]=await Promise.all([this.messages(wanted),this.pinnedTo(wanted),this.repliesToNocheh(wanted),this.embeddedTo(wanted)]);
    const shown=[...new Set([...pinnedTo.values(),...[...embedded.values()].flatMap(places=>[...places.values()])].flat())];
    const [pins,shownMessages,shownReplies]=await Promise.all([this.nochehOf(pinnedTo),this.messages(shown),this.repliesToNocheh(shown)]);
    for(const id of wanted) {
      // The bot the pin or reply came to is the one whose own messages it may carry.
      const {message=null,bot=null}=messages.get(id)??{},inner=record(message?.pinned_message);
      const nocheh=(target:string)=>shownReplies.has(target)||nochehQuoted(shownMessages.get(target)?.message,bot);
      const pinned=pins.get(id)??(nochehPinned(message,bot)?'bot':null),quote=replied.has(id)||nochehQuoted(message,bot);
      const pinnedQuote=!!record(inner?.quote)&&(nochehQuoted(inner,bot)||(pinnedTo.get(id)??[]).some(nocheh));
      const held=nochehHeld(message,bot),untraced:string[]=[];
      for(const item of quotesToTrace(message)) {
        const place=heldKey(item.path),targets=embedded.get(id)?.get(place)??[];
        if(targets.some(nocheh))held.push(place);
        else {
          const revisions=targets.map(target=>shownMessages.get(target)?.message);
          if(!revisions.some(replies)||!revisions.every(answers))untraced.push(place);
        }
      }
      if(pinned||quote||pinnedQuote||held.length||untraced.length)found.set(id,{pinned,quote,pinned_quote:pinnedQuote,held,untraced});
    }
    return found;
  }
  /** The Telegram message each of these archived events holds, as it was received, by id, with the bot it came to as the
   *  archive stored it (events.bot_id). */
  private async messages(ids:readonly string[]):Promise<Map<string,{message:Record<string,any>;bot:string|null}>> {
    const found=new Map<string,{message:Record<string,any>;bot:string|null}>();
    if(!ids.length)return found;
    for(const row of (await this.stores.archive.query('SELECT id,payload,bot_id FROM events WHERE id=ANY($1::text[])',[ids])).rows) {
      let payload:unknown=null;try{payload=JSON.parse((row.payload as Buffer).toString());}catch{}
      const message=telegramMessage(payload);
      if(message)found.set(String(row.id),{message,bot:typeof row.bot_id==='string'?row.bot_id:null});
    }
    return found;
  }
  private async nochehOf(related:Map<string,string[]>):Promise<Map<string,'learned'|'unlearned'>> {
    const targets=await this.factsFor([...new Set([...related.values()].flat())]),found=new Map<string,'learned'|'unlearned'>();
    for(const [id,list] of related) {
      const read=list.map(target=>targets.get(target));
      if(!read.length||read.some(item=>item?.author!=='nocheh'))continue;
      found.set(id,read.some(item=>eventClass(item!)==='nocheh_unlearned')?'unlearned':'learned');
    }
    return found;
  }
  /** Every archived message each of these events replies to, by the archive's reply relation: each revision observed. */
  private async repliedTo(ids:readonly string[]):Promise<Map<string,string[]>> {
    const found=new Map<string,string[]>();
    if(!ids.length)return found;
    for(const row of (await this.stores.archive.query(`SELECT r.event_id,o.event_id AS target FROM source_relations r
      JOIN source_revisions v ON v.object_id=r.target_id JOIN source_observations o ON o.revision_id=v.id
      WHERE r.event_id=ANY($1::text[]) AND r.kind='reply_to' ORDER BY r.event_id,o.event_id`,[ids])).rows)
      found.set(String(row.event_id),[...found.get(String(row.event_id))??[],String(row.target)]);
    return found;
  }
  /**
   * Every archived message each of these pins carries: the same chat's message the pin names, from the pin's own archived
   * message as a reply's target is (pinnedSource), then each revision observed of it, as repliedTo reads one. An event
   * that is not a pin is left out. The owner's notes review reads it too, to judge a quote inside a pinned message.
   */
  async pinnedTo(ids:readonly string[]):Promise<Map<string,string[]>> {
    return this.shownTo(ids,(id,object,payload)=>{const target=pinnedSource(object,payload);return target?[[id,target]]:[];});
  }
  /**
   * Every archived message each quote inside a message these events embed is from (quotesToTrace, or with `every` each
   * one heldBy lists, those whose embedded message keeps its reply too), by event id and the quote's place (heldKey): the
   * same chat's message the embedded one is, found as a pin's is (embeddedSource), then each revision observed of it. A
   * quote whose message names another chat or none, or one the archive does not hold, is left out. The owner's notes
   * review reads every one, to judge each quote by the message it answers (quotedSender), in this chat or in another.
   */
  async embeddedTo(ids:readonly string[],every=false):Promise<Map<string,Map<string,string[]>>> {
    const found=new Map<string,Map<string,string[]>>();
    const shown=await this.shownTo(ids,(id,object,payload)=>{
      const message=telegramMessage(payload),quotes=!every?quotesToTrace(message):message?heldBy(message).filter(item=>item.kind==='quote'):[];
      return quotes.flatMap(item=>{const target=embeddedSource(object,message,item.value);return target?[[JSON.stringify([id,heldKey(item.path)]),target]]:[];});
    });
    for(const [key,targets] of shown) {
      const [id,place]=JSON.parse(key) as [string,string];
      if(targets.length)found.set(id,(found.get(id)??new Map<string,string[]>()).set(place,targets));
    }
    return found;
  }
  /** Each archived revision of the messages `find` names from each of these events' own archived message (an event that
   *  names none is left out), by the key `find` gives each. */
  private async shownTo(ids:readonly string[],find:(id:string,object:SourceIdentity,payload:unknown)=>[string,SourceIdentity][]):Promise<Map<string,string[]>> {
    const found=new Map<string,string[]>(),objects=new Map<string,string>();
    if(!ids.length)return found;
    for(const row of (await this.stores.archive.query(`SELECT o.event_id,s.platform,s.namespace,s.kind,s.external_id,e.payload FROM source_observations o
      JOIN source_revisions v ON v.id=o.revision_id JOIN source_objects s ON s.id=v.object_id JOIN events e ON e.id=o.event_id
      WHERE o.event_id=ANY($1::text[])`,[ids])).rows) {
      let payload:unknown=null;try{payload=JSON.parse((row.payload as Buffer).toString());}catch{}
      const object={platform:row.platform,namespace:row.namespace,kind:row.kind,external_id:row.external_id};
      for(const [key,target] of find(String(row.event_id),object,payload))objects.set(key,sourceObjectId(target));
    }
    if(!objects.size)return found;
    const observed=(await this.stores.archive.query(`SELECT v.object_id,o.event_id FROM source_revisions v JOIN source_observations o ON o.revision_id=v.id
      WHERE v.object_id=ANY($1::text[]) ORDER BY o.event_id`,[[...new Set(objects.values())]])).rows;
    for(const [key,object] of objects)found.set(key,observed.filter(row=>row.object_id===object).map(row=>String(row.event_id)));
    return found;
  }

  /**
   * Each note's origins, resolved from what was recorded: a review from the batch it stored when it was queued, its
   * place from its source message, and the note's citations; a turn from the class of the message it answered and the
   * chat of its profile. A review whose row is gone reads as not recorded; a note that cites more than were sent can't
   * be the owner's; one that had to drop origins has an unknown one too. `detail` also reads each message's chat and
   * whether its sender is allowed there now, which only the owner's words name. Origins come back in the order of
   * `notes`, so two notes with the same key in different profiles keep their own; `partial` says a place read failed.
   * Days are the reader's (B1.4): the owner's Tasks zone for the owner, UTC for anyone else. A review's is its messages'
   * days, read in one batch; a turn's is its recorded moment's, or the UTC day it recorded alone, marked so. `sources`
   * names, for each note, the messages its writer read: a review's batch, or the message a turn answered.
   */
  private async resolve(notes:readonly NoteInput[],detail:boolean,owner=false) {
    const reviewIds=[...new Set(notes.flatMap(note=>note.origins.flatMap(origin=>origin.by==='review'?[origin.review]:[])))];
    const rows=reviewIds.length?(await this.stores.control.query('SELECT id,provenance,source_reference FROM native_review_jobs WHERE id=ANY($1::text[])',[reviewIds])).rows:[];
    // Each review's place is read from its source message, all at once; one that can't be read is a chat Nocheh can't
    // name. A message that is gone has no place; any other failure is counted, and the labels still go out.
    let partial=false;
    const places=await Promise.all(rows.map(row=>this.access?this.access.space(row.source_reference).catch(error=>{if(!(error instanceof HttpError))partial=true;return null;}):null));
    const reviews=new Map<string,{provenance:unknown;place:string|null;events:string[]}>(rows.map((row,index)=>[String(row.id),{provenance:row.provenance,
      place:places[index]??null,events:Array.isArray(row.provenance?.events)?row.provenance.events.map((event:any)=>event?.id).filter(fullId):[]}]));
    const ids=new Set<string>();
    for(const note of notes) {
      for(const cite of note.cites)ids.add(cite);
      for(const origin of note.origins) {
        if(origin.by==='turn')ids.add(origin.event);
        if(origin.by==='review'&&detail)for(const id of reviews.get(origin.review)?.events??[])ids.add(id);
      }
    }
    const batch=[...new Set([...ids,...[...reviews.values()].flatMap(row=>row.events)])];
    const [classes,zone,moments]=await Promise.all([this.classesFor([...ids]),owner?ownerTimeZone(this.stores.control):Promise.resolve('UTC'),
      batch.length?this.stores.archive.query('SELECT id,kind,occurred_at,received_at FROM events WHERE id=ANY($1::text[])',[batch]):Promise.resolve({rows:[]})]);
    const known=new Map<string,LabelEvent>();
    for(const [id,found] of classes)known.set(id,{class:found.class,facts:found.facts});
    // Each message's day as this reader reads days; a review's own record gives each batch message its class.
    for(const row of moments.rows as {id:string;kind:string;occurred_at:string|null;received_at:Date|null}[]) {
      const day=sourceClock(sourceMoment(row).moment,{owner,zone})?.day??null;
      known.set(row.id,{...known.get(row.id)??{class:'unknown'},day});
    }
    if(detail&&ids.size) {
      const policy=this.policy();
      for(const event of (await this.stores.archive.query('SELECT id,channel,kind,scope,payload FROM events WHERE id=ANY($1::text[])',[[...ids]])).rows) {
        const item=known.get(event.id);if(!item)continue;
        let payload:unknown=null;try{payload=JSON.parse((event.payload as Buffer).toString());}catch{}
        item.chat=sourceChat({channel:event.channel,scope:event.scope});
        // Only a person's message can come from someone not allowed there now.
        if(item.facts?.author==='person')item.allowed=notesSender(policy as AssistantPolicy,{channel:event.channel,kind:event.kind,scope:event.scope,payload})==='review';
      }
    }
    const directory=chats(),place=(space:string|null)=>space!==null&&directory.get(space)?space:null;
    const origin=(stored:StoredOrigin,note:NoteInput):NoteOrigin=>{
      if(stored.by==='unknown')return {by:'unknown'};
      if(stored.by==='review') {
        const row=reviews.get(stored.review);
        if(!row)return {by:'review',place:{chat:null},events:[],outside:[],owner:false,cited:false,rules:false,rule_buckets:[]};
        const found=reviewOrigin(row.provenance,note.cites,{chat:row.place},known);
        return note.more_cites&&found.by==='review'?{...found,owner:false}:found;
      }
      const timed=stored.at_time!==undefined;
      return {by:'turn',place:{chat:place(note.space),web:stored.channel==='browser'},date:timed?zonedDay(stored.at_time!*1000,zone):stored.at,
        ...timed?{}:{utc:true},reads:stored.reads,answered:classes.get(stored.event)?.class??null,complete:stored.complete,
        job:stored.channel==='scheduler'||stored.channel==='background'};
    };
    // What each note's writer read, for its ref: a review's batch, its first message first, or the turn's message.
    const sources=notes.map(note=>{
      const first=note.origins[0];
      if(first?.by==='turn')return [first.event];
      if(first?.by!=='review')return [];
      return (reviews.get(first.review)?.events??[]).slice(0,NOTE_SOURCES_KEPT);
    });
    const origins=notes.map(note=>[...note.origins.map(stored=>origin(stored,note)),...note.more?[{by:'unknown'} as NoteOrigin]:[]]);
    const chatsNamed=new Set<string>();
    for(const list of origins)for(const item of list)if(item.by==='review'||item.by==='turn')if(item.place.chat)chatsNamed.add(item.place.chat);
    for(const item of known.values())if(item.chat)chatsNamed.add(item.chat);
    return {origins,known,chats:[...chatsNamed],partial,sources};
  }
  /** Counts one labelling in the stores' day count: it failed when it threw or could not name a chat. */
  private async counted(ok:boolean){await countMemoryStep(this.stores.control,'notes',ok);}

  /** Each note's source in the model's fixed words, in the order of `notes` (ADR-0257): no person is named, and only
   *  group and topic names Nocheh saved appear, which the request guard still checks since they are never let through
   *  beforehand. */
  async labels(notes:readonly NoteInput[]):Promise<NoteSource[]> {
    return (await this.labelled(notes,false)).labels;
  }
  /** labels(), with the messages each note's writer read (resolve's `sources`). `owner`: the owner reads them. */
  private async labelled(notes:readonly NoteInput[],owner:boolean):Promise<{labels:NoteSource[];sources:string[][];days:(string|null)[]}> {
    if(!notes.length)return {labels:[],sources:[],days:[]};
    const {origins,chats:named,partial,sources}=await this.resolve(notes,false,owner),names=await recallNames(this.stores,named);
    await this.counted(!partial);
    return {labels:origins.map(list=>({from:fromToken(list),label:modelLabel(list,names)})),sources,days:origins.map(noteDay)};
  }

  /** The owner's own words (memory.source_texts, and the reminder and approval texts' words for people and chats). */
  async ownerWords():Promise<SourceWords> {
    const prompts=await ownerPrompts(this.stores.control);
    return {lines:sourceLines(prompts['memory.source_texts']),reminder:reminderLines(prompts['tasks.reminder_texts']),places:approvalLines(prompts['telegram.approval_texts'])};
  }
  /** People and chats named as reminders name them, for these messages' senders. */
  private async ownerNames(known:Iterable<LabelEvent>) {
    const people:Who[]=[...known].flatMap(item=>item.facts?.author==='person'?[{by:'person' as const,account:item.facts.account,name:item.facts.name}]:[]);
    const names=await peopleNames(this.stores.control,chats(),this.policy() as AssistantPolicy,people);
    return {names,keys:nameKeys(names,people)};
  }
  /** Each note's source in the owner's own words (memory.source_texts), naming people and chats as reminders do, for
   *  the Notes page, in the order of `notes`, with a review's day (its main message's, in the owner's zone; a turn's label
   *  names its own) and the messages its writer read: a review's batch, its first message first, or the turn's message. */
  async ownerLabels(notes:readonly NoteInput[]):Promise<(NoteSource&{day:string|null;sources:string[]})[]> {
    if(!notes.length)return [];
    const {origins,known,partial,sources}=await this.resolve(notes,true,true),words=await this.ownerWords();
    const {names,keys}=await this.ownerNames(known.values());
    await this.counted(!partial);
    // A turn's label names its day already ({date}, which the owner's words must keep); a review's day is shown beside it.
    return origins.map((list,index)=>({from:fromToken(list),label:ownerLabel(list,words,names,keys),day:list[0]?.by==='turn'?null:noteDay(list),
      sources:sources[index]??[]}));
  }
  /**
   * Each of these messages in the owner's words, for the owner's dashboard (ADR-0261 step 4): who sent what kind of
   * message where (ownerEventLabel, as the Notes page names a review's), where a forward came from, and when it was sent
   * (sourceMoment). A message the archive does not hold reads "Source not recorded". Throws when they can't be built.
   */
  async ownerEventLabels(ids:readonly string[]):Promise<Map<string,{label:string;at:string|null;forward?:string;missing?:true}>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,{label:string;at:string|null;forward?:string;missing?:true}>();
    if(!wanted.length)return found;
    const [classes,rows,words]=await Promise.all([this.classesFor(wanted),
      this.stores.archive.query('SELECT id,channel,kind,scope,payload,occurred_at,received_at FROM events WHERE id=ANY($1::text[])',[wanted]),this.ownerWords()]);
    const policy=this.policy() as AssistantPolicy,events=new Map<string,LabelEvent>(),moments=new Map<string,string|null>();
    for(const row of rows.rows) {
      const known=classes.get(row.id);if(!known)continue;
      let payload:unknown=null;try{payload=JSON.parse((row.payload as Buffer).toString());}catch{}
      const event:LabelEvent={class:known.class,facts:known.facts,chat:sourceChat({channel:row.channel,scope:row.scope})};
      // Only a person's message can come from someone not allowed there now.
      if(known.facts.author==='person')event.allowed=notesSender(policy,{channel:row.channel,kind:row.kind,scope:row.scope,payload})==='review';
      events.set(row.id,event);moments.set(row.id,sourceMoment(row).at);
    }
    const {names,keys}=await this.ownerNames(events.values());
    for(const id of wanted) {
      const event=events.get(id);
      if(!event){found.set(id,{label:words.lines.unknown,at:null,missing:true});continue;}
      found.set(id,{label:ownerEventLabel(event,words,names,keys),at:moments.get(id)??null,...event.class.startsWith('forward_')?{forward:ownerOrigin(event,words)}:{}});
    }
    return found;
  }

  /**
   * The internal lookup Hermes makes before a turn or review (POST /internal/notes/sources): its notes checked, then
   * their labels in the model's words. A body that is not as Hermes's parent writes it is refused whole.
   */
  async lookup(body:unknown):Promise<{labels:Record<string,NoteSource&{ref?:string}>}> {
    const found=record(body),space=found?.space,turn=found?.turn_event;
    if(!found||!Array.isArray(found.notes)||found.notes.length>200||Object.keys(found).some(name=>!['notes','space','turn_event'].includes(name))||
      space!==undefined&&(typeof space!=='string'||!space||space.length>200)||turn!==undefined&&!fullId(turn))throw new HttpError(400,'invalid_note_sources');
    const notes=found.notes.map(note=>noteInput(note,space??null)) as (NoteInput|null)[];
    if(notes.some(note=>note===null))throw new HttpError(400,'invalid_note_sources');
    // One profile's notes: two with the same key are the same entry, so keying by it loses nothing. The owner's own chat
    // reads days in the owner's zone; any other, or none named, in UTC.
    const {labels,sources}=await this.labelled(notes as NoteInput[],typeof space==='string'&&chats().isOwner(space));
    // A turn's notes each get a ref that opens, in that turn alone, the messages its writer read (archive_read {note}).
    // When they can't be kept, the labels still go out, without refs, and the failure is counted as `note_refs`.
    const kept=typeof turn==='string'&&await this.keep(turn,notes as NoteInput[],sources);
    return {labels:Object.fromEntries((notes as NoteInput[]).map((note,index)=>[note.key,{...labels[index]!,...kept?{ref:noteRef(note.key)}:{}}]))};
  }
  /** Keeps a turn's note refs with the messages each opens, beside any this turn's earlier lookups kept, and drops
   *  every turn's that is older than NOTE_LOOKUP_DAYS. Whether they were kept. */
  private async keep(turn:string,notes:readonly NoteInput[],sources:readonly string[][]):Promise<boolean> {
    const refs:Record<string,string[]>={};
    notes.forEach((note,index)=>{const ref=noteRef(note.key);refs[ref]=[...new Set([...refs[ref]??[],...sources[index]??[]])].slice(0,NOTE_SOURCES_KEPT);});
    try {
      await this.stores.control.query(`DELETE FROM note_lookups WHERE created_at<now()-make_interval(days=>$1)`,[NOTE_LOOKUP_DAYS]);
      await this.stores.control.query(`INSERT INTO note_lookups(turn_event,notes) VALUES($1,$2::jsonb)
        ON CONFLICT(turn_event) DO UPDATE SET notes=note_lookups.notes||excluded.notes`,[turn,JSON.stringify(refs)]);
      await countMemoryStep(this.stores.control,'note_refs',true);
      return true;
    }catch{await countMemoryStep(this.stores.control,'note_refs',false);return false;}
  }
  /**
   * The messages a note's ref opens in this turn (archive_read {note}): those the turn's lookup kept for it, while they
   * are not older than NOTE_LOOKUP_DAYS, at most NOTE_SOURCES_SHOWN of them once the caller keeps those the reader may
   * read. A ref this turn never had opens nothing.
   */
  async noteSources(turn:string,ref:string):Promise<string[]|null> {
    if(!fullId(turn)||!/^[a-f0-9]{12}$/.test(ref))return null;
    const row=(await this.stores.control.query(`SELECT notes->$2 AS sources FROM note_lookups WHERE turn_event=$1
      AND created_at>=now()-make_interval(days=>$3)`,[turn,ref,NOTE_LOOKUP_DAYS])).rows[0];
    return Array.isArray(row?.sources)?row.sources.filter(fullId):null;
  }

  /**
   * The Notes page's notes (the brain's `memory` result), each with its source in the owner's words in place of what
   * Hermes recorded; the records themselves stay in Hermes. A note whose source can't be read now says so.
   */
  async withOwnerLabels(result:unknown,originals?:(ids:string[])=>Promise<ReadonlyMap<string,unknown>>):Promise<unknown> {
    const value=record(result);
    if(!value||!Array.isArray(value.memories))return result;
    const space=typeof value.scope==='string'?value.scope:null;
    // A record not as Hermes's parent writes it reads as not recorded; its stand-in key can't match a real one.
    const input=(entry:unknown,index:number):NoteInput=>noteInput(Object.fromEntries(Object.entries(record(entry)??{})
      .filter(([name])=>['key','origins','more','cites','more_cites'].includes(name))),space)??
      {key:'invalid:'+index,origins:[{by:'unknown'}],more:0,cites:[],more_cites:false,space};
    let count=0;
    const memories=value.memories.map(memory=>{
      const item=record(memory);
      return item&&Array.isArray(item.entries)?{item,entries:item.entries.map(entry=>{const index=count++;return {entry:record(entry),input:input(entry,index),index};})}:
        {item:memory,entries:null};
    });
    // A failed lookup is counted for the owner's notice, and every note still shows, as not available right now.
    let labels:Awaited<ReturnType<NoteSourceRepository['ownerLabels']>>|null=null;
    try{labels=await this.ownerLabels(memories.flatMap(memory=>memory.entries?.map(entry=>entry.input)??[]));}catch{await this.counted(false);}
    const unavailable:NoteSource={from:'unavailable',label:sourceLines(undefined).unavailable};
    // Each note's day and the messages its writer read (a review's batch, a turn's message), named as originals are
    // (OwnerOriginals counts its own failure and fails closed).
    const named=originals&&labels?await originals([...new Set(labels.flatMap(label=>label.sources))]):null;
    const shown=(index:number)=>{
      const found=labels?.[index];if(!found)return unavailable;
      const {sources,...label}=found;
      return {...label,...named?{originals:sources.flatMap(id=>named.get(id)??[])}:{}};
    };
    return {...value,memories:memories.map(({item,entries})=>entries===null?item:{...item as object,entries:entries.map(({entry,index})=>
      ({target:entry?.target,text:entry?.text,...shown(index)}))})};
  }

  /**
   * The owner's recall (the brain's `recall` result) with each note hit's source in the model's words and each past
   * conversation hit's writer in fixed words; what Hermes recorded stays behind. Run before the hits' places are named,
   * since a note's source reads the chat of the profile it is in. Each note hit also gets its day, in the owner's zone,
   * and with `tag` (the owner's SourceTagRepository.checked, which checks canRead first and keeps only what the owner may
   * read) up to
   * RECALL_NOTE_SOURCES of the messages its writer read, tagged (B3.6).
   */
  async withRecallSources(result:unknown,tag?:(ids:string[])=>Promise<ReadonlyMap<string,{source:string;tag:string;by:string}|null>>):Promise<unknown> {
    const value=record(result);
    if(!value||!Array.isArray(value.hits))return result;
    const hits=value.hits.map(hit=>record(hit)).filter(hit=>hit!==null);
    const inputs=hits.map(hit=>hit.kind==='native_note'?noteInput(hit.note,typeof hit.space==='string'?hit.space:null):null);
    // Each hit is labelled on its own, by its place among the notes asked: the same note in two profiles keeps each one's source.
    const asked=inputs.flatMap((input,index)=>input?[{input,index}]:[]),position=new Map(asked.map((item,at)=>[item.index,at]));
    let found:Awaited<ReturnType<NoteSourceRepository['labelled']>>|null=null;
    try{found=await this.labelled(asked.map(item=>item.input),true);}catch{await this.counted(false);}
    const labels=found?.labels??null,words=modelSourceWords.labels,unknown:NoteSource={from:'unknown',label:words.unknown};
    // Every hit's sources tagged in one batch; one that fails leaves the hits without them, never with a source not checked.
    let tagged:ReadonlyMap<string,{source:string;tag:string;by:string}|null>=new Map();
    const firstOf=(at:number)=>(found?.sources[at]??[]).slice(0,NOTE_SOURCES_SHOWN),read=[...new Set(asked.flatMap((_item,at)=>firstOf(at)))];
    if(tag&&read.length)try{tagged=await tag(read);}catch(error){
      if(bindingMoved(error))throw error;
      await countMemoryStep(this.stores.control,'source_tags',false);}
    const sourcesOf=(at:number)=>firstOf(at).flatMap(id=>{const item=tagged.get(id);return item?[{source:item.source,tag:item.tag,by:item.by}]:[];})
      .slice(0,RECALL_NOTE_SOURCES);
    return {...value,hits:hits.map((hit,index)=>{
      const {note,role,...rest}=hit,at=position.get(index);
      if(hit.kind==='native_note')return {...rest,source:labels===null?{from:'unavailable',label:words.unavailable}:at!==undefined&&labels[at]||unknown,
        ...found&&at!==undefined?{day:found.days[at]??null,...tag?{sources:sourcesOf(at)}:{}}:{}};
      if(hit.kind==='native_session')return {...rest,role:role==='assistant'?recallRoleWords.assistant:role==='tool'?recallRoleWords.tool:recallRoleWords.message};
      return rest;
    })};
  }
}

/** The most messages a note hit in the owner's recall names, tagged (B3.6). */
const RECALL_NOTE_SOURCES=3;
/** The fixed words for who wrote a past conversation's row that the owner's recall finds. */
export const recallRoleWords={assistant:'Nocheh\'s reply',tool:'a tool result',message:'a message'} as const;
