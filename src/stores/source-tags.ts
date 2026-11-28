import type pg from 'pg';
import {boundReader,type Reader} from '../access.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {telegramMessage,telegramSenderName,telegramUsername} from '../chats-telegram.js';
import {forwardFacts} from '../forwarded.js';
import {HttpError} from '../http.js';
import {sourceChat} from '../spaces.js';
import {correctionTag,placeTag,shownFileName,sourceClock,sourceDetails,sourceMoment,sourceTag,tagName,unavailableTag,type Tag,type TagDetails,type TagReader,type TagSource} from '../source-tags.js';
import type {SourceReference} from './archive.js';
import {boundChat,type SourceAccessRepository} from './access.js';
import {ownerPeopleNames} from './entities.js';
import type {GuardBinding} from './guards.js';
import {bindingMoved,countMemoryStep,type NoteSourceRepository} from './note-sources.js';
import {recallNames} from './recall-places.js';
import {ownerTimeZone} from './task-settings.js';

type Pools={archive:Pick<pg.Pool,'query'>;derived:Pick<pg.Pool,'query'>;control:Pick<pg.Pool,'query'>};
/** How tags are asked for: a minute or a day; `historical` for evidence already learned, whose reaction may have changed
 *  since (canRead's own option); and `shown`, each source's payload as the caller already read it for this reader (the
 *  guarded copy's payload when the secret check is on), so nothing is read twice. */
export interface TagOptions {precision?:'minute'|'day';historical?:boolean;shown?:ReadonlyMap<string,unknown>;details?:boolean;
  /** Names a person's @username only when another sender in the request shows the same name (a recall block's headers). */
  compact?:boolean;
  /** Also gives each tag's where and when without its sender (`place`, placeTag), checked with the tag in one request. */
  place?:boolean}
/** The one call that runs every request's tag texts through the secret check (PreparedContextRepository.prepare). */
type Prepare=(principal:Reader,value:unknown,detect:(text:string,background?:boolean)=>Promise<unknown>)=>Promise<unknown>;
export {bindingMoved};

/** Where a forward came from (forwardFacts), its kind from the original and its name only from the reader's own copy:
 *  with no such copy, no name. */
function shownForward(original:unknown,shown:unknown) {
  const found=forwardFacts(original,shown&&typeof shown==='object'?shown:{});
  return found&&(shown&&typeof shown==='object'?found:{from:found.from,rawName:null});
}
/** Whether a reader reads as the owner: the owner's private chat, web chat and own jobs, never a bound reader (a private
 *  answer, a member's private chat, the owner's ask about a member). */
export const ownerReader=(principal:Reader)=>principal.admin||principal.scope===null&&boundReader(principal)===null;

/** Why a tag request failed, by code only (an HttpError's, a database's or the error's name), never its message, which
 *  may name what it read. */
function failureCode(error:unknown):string {
  if(error instanceof HttpError)return error.code;
  const code=(error as {code?:unknown})?.code;
  return typeof code==='string'&&/^[A-Za-z0-9_]{1,40}$/.test(code)?code:error instanceof Error?error.name:'unknown';
}

/**
 * Source tags for the sources a reader asked about (ADR-0261), built by code in a few batched reads: who may read each
 * (SourceAccessRepository.readable, which is canRead), what each message is (classesFor), its sender as the reader's own
 * copy shows them, its chat and its moment; the chat names once (Telegram's own names only, for anyone but the owner);
 * and, for the owner alone, the Tasks time zone and the People names the owner chose. Every tag of a request then goes
 * through one secret check. A source the reader cannot read maps to null, which reads "source not available here". A
 * tag that cannot be built never fails the read: it reads "source not available right now" with by=unknown, counted as
 * a `source_tags` problem.
 */
export class SourceTagRepository {
  constructor(readonly stores:Pools,readonly access:SourceAccessRepository,readonly notes:NoteSourceRepository,
    readonly prepare:Prepare|null,readonly detect:(text:string,background?:boolean)=>Promise<unknown>,readonly policy:()=>AssistantPolicy){}

  async tags(principal:Reader,binding:GuardBinding,references:readonly SourceReference[],options:TagOptions={}):Promise<Map<string,(Tag&TagDetails)|null>> {
    const result=new Map<string,(Tag&TagDetails)|null>(),ids=[...new Set(references.map(reference=>reference.id))];
    if(!ids.length)return result;
    let readable:Map<string,boolean>|null=null;
    try {
      readable=await this.access.readable(principal,references,binding,{historical:options.historical===true});
      const open=ids.filter(id=>readable!.get(id)===true);
      for(const id of ids)if(!open.includes(id))result.set(id,null);
      if(open.length) {
        const built=await this.build(principal,binding,open,options);
        // One secret check for every tag of the request, and the forward and topic words an opened original names beside
        // it; a text repeated in this epoch costs nothing.
        const partsOf=(tag:Tag&TagDetails)=>[tag.tag,...options.details?[tag.forward??'',tag.topic??'']:[],...options.place?[tag.place??'']:[]];
        const width=partsOf(built[0]!).length,parts=built.flatMap(partsOf);
        const texts=!principal.admin&&this.prepare?await this.prepare(principal,parts,this.detect) as unknown[]:parts;
        if(!Array.isArray(texts)||texts.length!==parts.length||texts.some(text=>typeof text!=='string'))throw new HttpError(500,'source_tags_unprepared');
        built.forEach((tag,index)=>{
          const at=index*width,{forward,topic,place,...plain}=tag,placeAt=at+(options.details?3:1);
          result.set(open[index]!,{...plain,tag:texts[at] as string,...(forward?{forward:texts[at+1] as string}:{}),...(topic?{topic:texts[at+2] as string}:{}),
            ...(options.place&&place?{place:texts[placeAt] as string}:{})});
        });
      }
      await countMemoryStep(this.stores.control,'source_tags',true);
      return result;
    } catch(error) {
      if(bindingMoved(error))throw error;
      console.warn(JSON.stringify({event:'source_tags_failed',code:failureCode(error)}));
      await countMemoryStep(this.stores.control,'source_tags',false);
      const failed=unavailableTag('now');
      for(const id of ids)result.set(id,readable&&readable.get(id)!==true?null:{source:'nocheh:event:'+id,tag:failed.tag,by:failed.by,at:null});
      return result;
    }
  }

  /**
   * tags() for references no access check has passed yet, such as the messages a note's ref or a recalled note names:
   * canRead first (readable()), and only those this reader may read are tagged; the rest map to null. A check that
   * fails tags none of them, counted as a `source_tags` problem, since tags() alone would then name every one as "source
   * not available right now", the placeholder for a source already checked.
   */
  async checked(principal:Reader,binding:GuardBinding,references:readonly SourceReference[],options:TagOptions={}):Promise<Map<string,(Tag&TagDetails)|null>> {
    const result=new Map<string,(Tag&TagDetails)|null>(references.map(reference=>[reference.id,null]));
    if(!references.length)return result;
    let open:SourceReference[];
    try {
      const readable=await this.access.readable(principal,references,binding,{historical:options.historical===true});
      open=references.filter(reference=>readable.get(reference.id)===true);
    } catch(error) {
      if(bindingMoved(error))throw error;
      console.warn(JSON.stringify({event:'source_tags_failed',code:failureCode(error)}));
      await countMemoryStep(this.stores.control,'source_tags',false);
      return result;
    }
    for(const [id,tag] of await this.tags(principal,binding,open,options))result.set(id,tag);
    return result;
  }

  /**
   * Owner corrections' tags (B3.6), in the order given: each conversation it corrects as this reader names chats, and the
   * day it was made in this reader's zone, all through one secret check. One that can't be built reads "source not
   * available right now", counted as a `source_tags` problem.
   */
  async corrections(principal:Reader,items:readonly {chat:string|null;made:Date|null}[]):Promise<string[]> {
    if(!items.length)return [];
    try {
      const owner=ownerReader(principal),policy=this.policy();
      const [zone,names]=await Promise.all([owner?ownerTimeZone(this.stores.control):Promise.resolve('UTC'),
        recallNames(this.stores,[...new Set(items.map(item=>item.chat).filter((chat):chat is string=>chat!==null))],{shownOnly:!owner})]);
      const reader:TagReader={owner,chat:owner?principal.space??ownerChat(policy):principal.space??principal.scope,zone,precision:'day'};
      const parts=items.map(item=>correctionTag(item.chat,item.made,reader,names));
      const texts=!principal.admin&&this.prepare?await this.prepare(principal,parts,this.detect) as unknown[]:parts;
      if(!Array.isArray(texts)||texts.length!==parts.length||texts.some(text=>typeof text!=='string'))throw new HttpError(500,'source_tags_unprepared');
      await countMemoryStep(this.stores.control,'source_tags',true);
      return texts as string[];
    } catch(error) {
      if(bindingMoved(error))throw error;
      await countMemoryStep(this.stores.control,'source_tags',false);
      return items.map(()=>unavailableTag('now').tag);
    }
  }

  private async build(principal:Reader,binding:GuardBinding,ids:string[],options:TagOptions):Promise<(Tag&TagDetails)[]> {
    const owner=ownerReader(principal),policy=this.policy(),directory=chats();
    const rows=new Map((await this.stores.archive.query('SELECT id,kind,channel,scope,occurred_at,received_at,payload FROM events WHERE id=ANY($1::text[])',[ids])).rows
      .map(row=>[row.id as string,row]));
    const [classes,described,zone,saved]=await Promise.all([this.notes.classesFor(ids),this.access.relationships.describeMany(ids),
      owner?ownerTimeZone(this.stores.control):Promise.resolve('UTC'),ownerPeopleNames(this.stores,ids)]);
    // The copy this reader reads: the guarded copy when the secret check is on, else the original. A guarded copy not
    // ready yet names nobody.
    const shown=new Map<string,unknown>(),guarded=!principal.admin&&binding.mode==='on';
    for(const id of ids)if(!rows.has(id))throw new HttpError(404,'source_not_found');
    // Every guarded copy in one read, never one round trip per source.
    const copies=guarded?await this.access.guards.readMany(ids.filter(id=>!options.shown?.has(id)).map(id=>'events:'+id),binding):new Map<string,unknown>();
    for(const id of ids) {
      if(options.shown?.has(id)){shown.set(id,options.shown.get(id));continue;}
      if(guarded){const copy=copies.get('events:'+id);shown.set(id,copy?(copy as {payload?:unknown}).payload??null:null);}
      else shown.set(id,JSON.parse((rows.get(id)!.payload as Buffer).toString()));
    }
    const sources:TagSource[]=ids.map(id=>{
      const row=rows.get(id)!,found=classes.get(id),payload=shown.get(id),original=JSON.parse((row.payload as Buffer).toString());
      if(!found)throw new HttpError(404,'source_not_found');
      const {moment,at}=sourceMoment(row);
      return {id,class:found.class,facts:found.facts,sender:telegramSenderName(row.kind,payload),
        forward:row.channel==='telegram'?shownForward(telegramMessage(original),telegramMessage(payload)):null,
        file_name:shownFileName(row.kind,payload),saved:saved.get(id)??null,
        chat:described.get(id)?.chat??sourceChat({channel:row.channel,scope:row.scope}),web:row.channel==='browser',
        exported:row.kind.startsWith('telegram_desktop_'),moment,at};
    });
    // Chat and topic names once; anyone but the owner reads only the names Telegram showed.
    const names=await recallNames(this.stores,[...new Set(sources.map(source=>source.chat).filter((chat):chat is string=>chat!==null))],{shownOnly:!owner});
    const reader:TagReader={owner,chat:owner?principal.space??ownerChat(policy):principal.space??principal.scope,zone,precision:options.precision??'minute',
      member_chat:boundChat(principal)};
    // Compact: a person's @username only tells apart two senders the request shows by the same name.
    const key=(source:TagSource)=>tagName(source.sender.name).toLocaleLowerCase().replace(/\s+/g,''),handles=new Map<string,Set<string>>();
    if(options.compact)for(const source of sources) {
      const name=key(source);if(!name)continue;
      if(!handles.has(name))handles.set(name,new Set());handles.get(name)!.add(telegramUsername(source.sender.username)??'');
    }
    return sources.map(source=>{
      const usernames=!options.compact||(handles.get(key(source))?.size??0)>1,clock=reader.precision==='day'?sourceClock(source.moment,reader):null;
      return {...sourceTag(source,reader,names,directory,{usernames}),...(options.details?sourceDetails(source,reader,names,directory):{}),...(clock??{}),
        ...(options.place?{place:placeTag(source,reader,names,directory)}:{})};
    });
  }
}
