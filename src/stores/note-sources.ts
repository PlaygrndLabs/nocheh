import type pg from 'pg';
import {notesSender,type AssistantPolicy} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {HttpError} from '../http.js';
import {approvalLines,ownerPrompts,reminderLines,sourceLines} from '../prompts.js';
import {sourceChat} from '../spaces.js';
import {bucketOf,eventClass,nochehPinned,nochehQuoted,sourceFacts,type EventClass,type SourceFacts} from '../source-facts.js';
import {fromToken,modelLabel,modelSourceWords,ownerLabel,readTokens,reviewOrigin,type LabelEvent,type NoteFrom,type NoteOrigin,type ReadToken,
  type SourceWords} from '../source-labels.js';
import {nameKeys,type Who} from '../task-reminder-text.js';
import {pinnedSource,sourceObjectId} from '../source-model.js';
import type {SourceReference} from './archive.js';
import {peopleNames} from './people-names.js';
import {recallNames} from './recall-places.js';

type Pools={archive:Pick<pg.Pool,'query'>;derived:Pick<pg.Pool,'query'>;control:Pick<pg.Pool,'query'>};
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;

/** The channels a turn that writes notes runs on; the scheduler's and background jobs' are jobs. */
export const turnChannels=['telegram','browser','scheduler','background'] as const;
/** One origin as Hermes's parent records it (services/hermes/note_sources.py): a notes review by its id, a turn by the
 *  message it answered, its channel, its day and what it read, or nobody known. */
export type StoredOrigin={by:'review';review:string}|
  {by:'turn';event:string;channel:typeof turnChannels[number];at:string;reads:ReadToken[];complete:boolean}|{by:'unknown'};
/** One note as Hermes sends it: its key, its recorded origins and how many more it had to drop, the events it cites and
 *  whether it cites more than were sent, and the chat of the profile it is in. */
export interface NoteInput {key:string;origins:StoredOrigin[];more:number;cites:string[];more_cites:boolean;space:string|null}
/** A note's source: the fixed token trust is keyed on, and its label. */
export interface NoteSource {from:NoteFrom;label:string}

/**
 * The stores' own day count of the memory steps whose failure Hermes never sees (ADR-0257): labelling notes and naming
 * their chats (`notes`), for Hermes's lookups before a turn or review as for recall and the Notes page, and recall's ask
 * of the owner's forwards and files (`memory_read`). /v1/status shows today's, and the owner's notice and System › Health
 * show each as a line of its own (`note_labels`, `forwards_read`), apart from Hermes's lines. `done` counts the steps
 * that worked after the day's first failure of that kind.
 */
export const memoryProblemSchema=`
CREATE TABLE IF NOT EXISTS memory_problem_days (
 day date NOT NULL,kind text NOT NULL CHECK(kind IN ('notes','memory_read')),done integer NOT NULL DEFAULT 0,failed integer NOT NULL DEFAULT 0,
 PRIMARY KEY(day,kind)
);
`;
export type MemoryProblemKind='notes'|'memory_read';
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
/** Today's counts, in the shape the provider monitor reads Hermes's own (usage.note_rows). */
export async function memoryProblems(control:Pick<pg.Pool,'query'>):Promise<{day:string;kind:MemoryProblemKind;done:number;failed:number}[]> {
  return (await control.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,kind,done,failed FROM memory_problem_days
    WHERE day=(now() AT TIME ZONE 'UTC')::date ORDER BY kind`)).rows;
}

function storedOrigin(value:unknown):StoredOrigin|null {
  const found=record(value),keys=found?Object.keys(found).sort().join(','):'';
  if(found?.by==='unknown'&&keys==='by')return {by:'unknown'};
  if(found?.by==='review'&&keys==='by,review'&&fullId(found.review))return {by:'review',review:found.review};
  if(found?.by!=='turn'||keys!=='at,by,channel,complete,event,reads'||!fullId(found.event)||!(turnChannels as readonly string[]).includes(found.channel)||
    typeof found.at!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(found.at)||typeof found.complete!=='boolean'||!Array.isArray(found.reads)||found.reads.length>12||
    found.reads.some((read:unknown)=>!(readTokens as readonly unknown[]).includes(read)))return null;
  return {by:'turn',event:found.event,channel:found.channel,at:found.at,reads:[...new Set(found.reads as ReadToken[])],complete:found.complete};
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

  /** The facts of each of these events, by id, in three batched reads. */
  async factsFor(ids:readonly string[]):Promise<Map<string,SourceFacts>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,SourceFacts>();
    if(!wanted.length)return found;
    // The authors the archive proved for an event (authored_by): only a Telegram Desktop export reads them.
    const events=(await this.stores.archive.query(`SELECT e.id,e.kind,e.channel,e.payload,a.authors FROM events e
      LEFT JOIN LATERAL (SELECT coalesce(json_agg(json_build_object('namespace',o.namespace,'kind',o.kind,'external_id',o.external_id) ORDER BY o.id),'[]') AS authors
        FROM source_relations r JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=e.id AND r.kind='authored_by') a ON true
      WHERE e.id=ANY($1::text[])`,[wanted])).rows;
    const selected=(await this.stores.derived.query(`SELECT event_id,artifact_id,kind FROM derivative_selections WHERE event_id=ANY($1::text[])
      AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY event_id,id`,[wanted])).rows;
    const artifacts=new Map<string,{kind:string;file_name:string|null}>();
    const files=[...new Set(selected.map(item=>item.artifact_id).filter((id):id is string=>typeof id==='string'))];
    if(files.length)for(const item of (await this.stores.archive.query(`SELECT id,kind,metadata->>'file_name' AS file_name FROM artifacts WHERE id=ANY($1::text[])`,[files])).rows)
      artifacts.set(item.id,{kind:item.kind,file_name:item.file_name??null});
    const owner=this.policy().owner_id;
    for(const event of events) {
      let payload:unknown=null;
      try{payload=JSON.parse((event.payload as Buffer).toString());}catch{}
      // A derivative whose artifact is not found reads as an audio file's transcript or a file's text: never the sender's own voice.
      const derivatives=selected.filter(item=>item.event_id===event.id).map(item=>({kind:item.kind as string,artifact:artifacts.get(item.artifact_id)?.kind??'',
        file_name:artifacts.get(item.artifact_id)?.file_name??null}));
      found.set(event.id,sourceFacts({channel:event.channel,kind:event.kind,payload,derivatives,authors:Array.isArray(event.authors)?event.authors:[]},owner));
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
   * message. Only a message that carries any of these is in the result. Another bot's message, and one sent through an
   * inline bot, is someone else's: it carries none of these, and is learned labelled as someone else's.
   */
  async carried(ids:readonly string[]):Promise<Map<string,{pinned:'learned'|'unlearned'|'bot'|null;quote:boolean;pinned_quote:boolean}>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,{pinned:'learned'|'unlearned'|'bot'|null;quote:boolean;pinned_quote:boolean}>();
    if(!wanted.length)return found;
    const [messages,pinnedTo,replies]=await Promise.all([this.messages(wanted),this.pinnedTo(wanted),this.repliesToNocheh(wanted)]);
    const held=[...new Set([...pinnedTo.values()].flat())];
    const [pins,heldMessages,heldReplies]=await Promise.all([this.nochehOf(pinnedTo),this.messages(held),this.repliesToNocheh(held)]);
    for(const id of wanted) {
      // The bot the pin or reply came to is the one whose own messages it may carry.
      const {message=null,bot=null}=messages.get(id)??{},inner=record(message?.pinned_message);
      const pinned=pins.get(id)??(nochehPinned(message,bot)?'bot':null),quote=replies.has(id)||nochehQuoted(message,bot);
      const pinnedQuote=!!record(inner?.quote)&&(nochehQuoted(inner,bot)||
        (pinnedTo.get(id)??[]).some(target=>heldReplies.has(target)||nochehQuoted(heldMessages.get(target)?.message,bot)));
      if(pinned||quote||pinnedQuote)found.set(id,{pinned,quote,pinned_quote:pinnedQuote});
    }
    return found;
  }
  /** The Telegram message each of these archived events holds, as it was received, by id, with the bot it came to as the
   *  archive stored it (events.bot_id). */
  private async messages(ids:readonly string[]):Promise<Map<string,{message:Record<string,any>;bot:string|null}>> {
    const found=new Map<string,{message:Record<string,any>;bot:string|null}>();
    if(!ids.length)return found;
    for(const row of (await this.stores.archive.query('SELECT id,payload,bot_id FROM events WHERE id=ANY($1::text[])',[ids])).rows) {
      let payload:Record<string,any>|null=null;try{payload=record(JSON.parse((row.payload as Buffer).toString()));}catch{}
      const message=record(payload?.message??payload?.edited_message??payload?.channel_post??payload?.edited_channel_post);
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
   * that is not a pin is left out.
   */
  private async pinnedTo(ids:readonly string[]):Promise<Map<string,string[]>> {
    const found=new Map<string,string[]>(),objects=new Map<string,string>();
    if(!ids.length)return found;
    for(const row of (await this.stores.archive.query(`SELECT o.event_id,s.platform,s.namespace,s.kind,s.external_id,e.payload FROM source_observations o
      JOIN source_revisions v ON v.id=o.revision_id JOIN source_objects s ON s.id=v.object_id JOIN events e ON e.id=o.event_id
      WHERE o.event_id=ANY($1::text[])`,[ids])).rows) {
      let payload:unknown=null;try{payload=JSON.parse((row.payload as Buffer).toString());}catch{}
      const target=pinnedSource({platform:row.platform,namespace:row.namespace,kind:row.kind,external_id:row.external_id},payload);
      if(target)objects.set(String(row.event_id),sourceObjectId(target));
    }
    if(!objects.size)return found;
    const observed=(await this.stores.archive.query(`SELECT v.object_id,o.event_id FROM source_revisions v JOIN source_observations o ON o.revision_id=v.id
      WHERE v.object_id=ANY($1::text[]) ORDER BY o.event_id`,[[...new Set(objects.values())]])).rows;
    for(const [pin,object] of objects)found.set(pin,observed.filter(row=>row.object_id===object).map(row=>String(row.event_id)));
    return found;
  }

  /**
   * Each note's origins, resolved from what was recorded: a review from the batch it stored when it was queued, its
   * place from its source message, and the note's citations; a turn from the class of the message it answered and the
   * chat of its profile. A review whose row is gone reads as not recorded; a note that cites more than were sent can't
   * be the owner's; one that had to drop origins has an unknown one too. `detail` also reads each message's chat and
   * whether its sender is allowed there now, which only the owner's words name. Origins come back in the order of
   * `notes`, so two notes with the same key in different profiles keep their own; `partial` says a place read failed.
   */
  private async resolve(notes:readonly NoteInput[],detail:boolean) {
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
    const classes=await this.classesFor([...ids]),known=new Map<string,LabelEvent>();
    for(const [id,found] of classes)known.set(id,{class:found.class,facts:found.facts});
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
      return {by:'turn',place:{chat:place(note.space),web:stored.channel==='browser'},date:stored.at,reads:stored.reads,
        answered:classes.get(stored.event)?.class??null,complete:stored.complete,job:stored.channel==='scheduler'||stored.channel==='background'};
    };
    const origins=notes.map(note=>[...note.origins.map(stored=>origin(stored,note)),...note.more?[{by:'unknown'} as NoteOrigin]:[]]);
    const chatsNamed=new Set<string>();
    for(const list of origins)for(const item of list)if(item.by==='review'||item.by==='turn')if(item.place.chat)chatsNamed.add(item.place.chat);
    for(const item of known.values())if(item.chat)chatsNamed.add(item.chat);
    return {origins,known,chats:[...chatsNamed],partial};
  }
  /** Counts one labelling in the stores' day count: it failed when it threw or could not name a chat. */
  private async counted(ok:boolean){await countMemoryStep(this.stores.control,'notes',ok);}

  /** Each note's source in the model's fixed words, in the order of `notes` (ADR-0257): no person is named, and only
   *  group and topic names Nocheh saved appear, which the request guard still checks since they are never let through
   *  beforehand. */
  async labels(notes:readonly NoteInput[]):Promise<NoteSource[]> {
    if(!notes.length)return [];
    const {origins,chats:named,partial}=await this.resolve(notes,false),names=await recallNames(this.stores,named);
    await this.counted(!partial);
    return origins.map(list=>({from:fromToken(list),label:modelLabel(list,names)}));
  }

  /** Each note's source in the owner's own words (memory.source_texts), naming people and chats as reminders do, for
   *  the Notes page, in the order of `notes`. */
  async ownerLabels(notes:readonly NoteInput[]):Promise<NoteSource[]> {
    if(!notes.length)return [];
    const {origins,known,partial}=await this.resolve(notes,true),prompts=await ownerPrompts(this.stores.control);
    const words:SourceWords={lines:sourceLines(prompts['memory.source_texts']),reminder:reminderLines(prompts['tasks.reminder_texts']),
      places:approvalLines(prompts['telegram.approval_texts'])};
    const people:Who[]=[...known.values()].flatMap(item=>item.facts?.author==='person'?[{by:'person' as const,account:item.facts.account,name:item.facts.name}]:[]);
    const names=await peopleNames(this.stores.control,chats(),this.policy() as AssistantPolicy,people),keys=nameKeys(names,people);
    await this.counted(!partial);
    return origins.map(list=>({from:fromToken(list),label:ownerLabel(list,words,names,keys)}));
  }

  /**
   * The internal lookup Hermes makes before a turn or review (POST /internal/notes/sources): its notes checked, then
   * their labels in the model's words. A body that is not as Hermes's parent writes it is refused whole.
   */
  async lookup(body:unknown):Promise<{labels:Record<string,NoteSource>}> {
    const found=record(body),space=found?.space;
    if(!found||!Array.isArray(found.notes)||found.notes.length>200||Object.keys(found).some(name=>name!=='notes'&&name!=='space')||
      space!==undefined&&(typeof space!=='string'||!space||space.length>200))throw new HttpError(400,'invalid_note_sources');
    const notes=found.notes.map(note=>noteInput(note,space??null)) as (NoteInput|null)[];
    if(notes.some(note=>note===null))throw new HttpError(400,'invalid_note_sources');
    // One profile's notes: two with the same key are the same entry, so keying by it loses nothing.
    const labels=await this.labels(notes as NoteInput[]);
    return {labels:Object.fromEntries((notes as NoteInput[]).map((note,index)=>[note.key,labels[index]!]))};
  }

  /**
   * The Notes page's notes (the brain's `memory` result), each with its source in the owner's words in place of what
   * Hermes recorded; the records themselves stay in Hermes. A note whose source can't be read now says so.
   */
  async withOwnerLabels(result:unknown):Promise<unknown> {
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
    let labels:NoteSource[]|null=null;
    try{labels=await this.ownerLabels(memories.flatMap(memory=>memory.entries?.map(entry=>entry.input)??[]));}catch{await this.counted(false);}
    const unavailable:NoteSource={from:'unavailable',label:sourceLines(undefined).unavailable};
    return {...value,memories:memories.map(({item,entries})=>entries===null?item:{...item as object,entries:entries.map(({entry,index})=>
      ({target:entry?.target,text:entry?.text,...labels?.[index]??unavailable}))})};
  }

  /**
   * The owner's recall (the brain's `recall` result) with each note hit's source in the model's words and each past
   * conversation hit's writer in fixed words; what Hermes recorded stays behind. Run before the hits' places are named,
   * since a note's source reads the chat of the profile it is in.
   */
  async withRecallSources(result:unknown):Promise<unknown> {
    const value=record(result);
    if(!value||!Array.isArray(value.hits))return result;
    const hits=value.hits.map(hit=>record(hit)).filter(hit=>hit!==null);
    const inputs=hits.map(hit=>hit.kind==='native_note'?noteInput(hit.note,typeof hit.space==='string'?hit.space:null):null);
    // Each hit is labelled on its own, by its place among the notes asked: the same note in two profiles keeps each one's source.
    const asked=inputs.flatMap((input,index)=>input?[{input,index}]:[]),position=new Map(asked.map((item,at)=>[item.index,at]));
    let labels:NoteSource[]|null=null;
    try{labels=await this.labels(asked.map(item=>item.input));}catch{await this.counted(false);}
    const words=modelSourceWords.labels,unknown:NoteSource={from:'unknown',label:words.unknown};
    return {...value,hits:hits.map((hit,index)=>{
      const {note,role,...rest}=hit,at=position.get(index);
      if(hit.kind==='native_note')return {...rest,source:labels===null?{from:'unavailable',label:words.unavailable}:at!==undefined&&labels[at]||unknown};
      if(hit.kind==='native_session')return {...rest,role:role==='assistant'?recallRoleWords.assistant:role==='tool'?recallRoleWords.tool:recallRoleWords.message};
      return rest;
    })};
  }
}

/** The fixed words for who wrote a past conversation's row that the owner's recall finds. */
export const recallRoleWords={assistant:'Nocheh\'s reply',tool:'a tool result',message:'a message'} as const;
