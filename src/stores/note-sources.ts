import type pg from 'pg';
import {notesSender,type AssistantPolicy} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {HttpError} from '../http.js';
import {approvalLines,ownerPrompts,reminderLines,sourceLines} from '../prompts.js';
import {sourceChat} from '../spaces.js';
import {eventClass,sourceFacts,type EventClass,type SourceFacts} from '../source-facts.js';
import {fromToken,modelLabel,modelSourceWords,ownerLabel,readTokens,reviewOrigin,type LabelEvent,type NoteFrom,type NoteOrigin,type ReadToken,
  type SourceWords} from '../source-labels.js';
import {nameKeys,type Who} from '../task-reminder-text.js';
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

  /** The facts and class of each of these events. A reply of Nocheh's is read with the message it answered, so a reply
   *  about someone else's forward is classed as being about that forward. */
  async classesFor(ids:readonly string[]):Promise<Map<string,{facts:SourceFacts;class:EventClass}>> {
    const facts=await this.factsFor(ids);
    const answered=[...facts.values()].map(item=>item.answers).filter((id):id is string=>!!id&&!facts.has(id));
    const targets=answered.length?await this.factsFor(answered):new Map<string,SourceFacts>();
    const of=(id:string|null)=>id===null?null:facts.get(id)??targets.get(id)??null;
    return new Map([...facts].map(([id,item])=>[id,{facts:item,class:eventClass(item,of(item.answers))}]));
  }

  /**
   * Each note's origins, resolved from what was recorded: a review from the batch it stored when it was queued, its
   * place from its source message, and the note's citations; a turn from the class of the message it answered and the
   * chat of its profile. A review whose row is gone reads as not recorded; a note that cites more than were sent can't
   * be the owner's; one that had to drop origins has an unknown one too. `detail` also reads each message's chat and
   * whether its sender is allowed there now, which only the owner's words name.
   */
  private async resolve(notes:readonly NoteInput[],detail:boolean) {
    const reviewIds=[...new Set(notes.flatMap(note=>note.origins.flatMap(origin=>origin.by==='review'?[origin.review]:[])))];
    const rows=reviewIds.length?(await this.stores.control.query('SELECT id,provenance,source_reference FROM native_review_jobs WHERE id=ANY($1::text[])',[reviewIds])).rows:[];
    // Each review's place is read from its source message, all at once; one that can't be read is a chat Nocheh can't name.
    const places=await Promise.all(rows.map(row=>this.access?this.access.space(row.source_reference).catch(()=>null):null));
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
        if(!row)return {by:'review',place:{chat:null},events:[],outside:[],owner:false,cited:false,rules:false};
        const found=reviewOrigin(row.provenance,note.cites,{chat:row.place},known);
        return note.more_cites&&found.by==='review'?{...found,owner:false}:found;
      }
      return {by:'turn',place:{chat:place(note.space),web:stored.channel==='browser'},date:stored.at,reads:stored.reads,
        answered:classes.get(stored.event)?.class??null,complete:stored.complete,job:stored.channel==='scheduler'||stored.channel==='background'};
    };
    const origins=new Map(notes.map(note=>[note.key,[...note.origins.map(stored=>origin(stored,note)),...note.more?[{by:'unknown'} as NoteOrigin]:[]]]));
    const chatsNamed=new Set<string>();
    for(const list of origins.values())for(const item of list)if(item.by==='review'||item.by==='turn')if(item.place.chat)chatsNamed.add(item.place.chat);
    for(const item of known.values())if(item.chat)chatsNamed.add(item.chat);
    return {origins,known,chats:[...chatsNamed]};
  }

  /** Each note's source in the model's fixed words, by its key (ADR-0257): no person is named, and only group and topic
   *  names Nocheh saved appear, which the request guard still checks since they are never let through beforehand. */
  async labels(notes:readonly NoteInput[]):Promise<Map<string,NoteSource>> {
    if(!notes.length)return new Map();
    const {origins,chats:named}=await this.resolve(notes,false),names=await recallNames(this.stores,named);
    return new Map([...origins].map(([key,list])=>[key,{from:fromToken(list),label:modelLabel(list,names)}]));
  }

  /** Each note's source in the owner's own words (memory.source_texts), naming people and chats as reminders do, for
   *  the Notes page. */
  async ownerLabels(notes:readonly NoteInput[]):Promise<Map<string,NoteSource>> {
    if(!notes.length)return new Map();
    const {origins,known}=await this.resolve(notes,true),prompts=await ownerPrompts(this.stores.control);
    const words:SourceWords={lines:sourceLines(prompts['memory.source_texts']),reminder:reminderLines(prompts['tasks.reminder_texts']),
      places:approvalLines(prompts['telegram.approval_texts'])};
    const people:Who[]=[...known.values()].flatMap(item=>item.facts?.author==='person'?[{by:'person' as const,account:item.facts.account,name:item.facts.name}]:[]);
    const names=await peopleNames(this.stores.control,chats(),this.policy() as AssistantPolicy,people),keys=nameKeys(names,people);
    return new Map([...origins].map(([key,list])=>[key,{from:fromToken(list),label:ownerLabel(list,words,names,keys)}]));
  }

  /**
   * The internal lookup Hermes makes before a turn or review (POST /internal/notes/sources): its notes checked, then
   * their labels in the model's words. A body that is not as Hermes's parent writes it is refused whole.
   */
  async lookup(body:unknown):Promise<{labels:Record<string,NoteSource>}> {
    const found=record(body),space=found?.space;
    if(!found||!Array.isArray(found.notes)||found.notes.length>200||Object.keys(found).some(name=>name!=='notes'&&name!=='space')||
      space!==undefined&&(typeof space!=='string'||!space||space.length>200))throw new HttpError(400,'invalid_note_sources');
    const notes=found.notes.map(note=>noteInput(note,space??null));
    if(notes.some(note=>note===null))throw new HttpError(400,'invalid_note_sources');
    return {labels:Object.fromEntries(await this.labels(notes as NoteInput[]))};
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
      return item&&Array.isArray(item.entries)?{item,entries:item.entries.map(entry=>({entry:record(entry),input:input(entry,count++)}))}:{item:memory,entries:null};
    });
    let labels:Map<string,NoteSource>|null=null;
    try{labels=await this.ownerLabels(memories.flatMap(memory=>memory.entries?.map(entry=>entry.input)??[]));}catch{}
    const unavailable:NoteSource={from:'unavailable',label:sourceLines(undefined).unavailable};
    return {...value,memories:memories.map(({item,entries})=>entries===null?item:{...item as object,entries:entries.map(({entry,input})=>
      ({target:entry?.target,text:entry?.text,...labels?.get(input.key)??unavailable}))})};
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
    let labels:Map<string,NoteSource>|null=null;
    try{labels=await this.labels(inputs.filter(input=>input!==null));}catch{}
    const words=modelSourceWords.labels,unknown:NoteSource={from:'unknown',label:words.unknown};
    return {...value,hits:hits.map((hit,index)=>{
      const {note,role,...rest}=hit,input=inputs[index];
      if(hit.kind==='native_note')return {...rest,source:labels===null?{from:'unavailable',label:words.unavailable}:input&&labels.get(input.key)||unknown};
      if(hit.kind==='native_session')return {...rest,role:role==='assistant'?recallRoleWords.assistant:role==='tool'?recallRoleWords.tool:recallRoleWords.message};
      return rest;
    })};
  }
}

/** The fixed words for who wrote a past conversation's row that the owner's recall finds. */
export const recallRoleWords={assistant:'Nocheh\'s reply',tool:'a tool result',message:'a message'} as const;
