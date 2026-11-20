import {admin,boundReader,sharedReads,type Reader} from '../access.js';
import {HttpError,string} from '../http.js';
import {matchesArchiveFilters,privateChatsParams,type ArchiveFilters} from '../archive-filters.js';
import {actionReviews} from '../action-review-summary.js';
import {sourceContentTypes} from '../source-content.js';
import {reactionPreview} from '../reaction-preview.js';
import {reactionObservation} from '../reaction-observation.js';
import {limit} from '../retrieval.js';
import {type Envelope} from '../archive.js';
import {SourceAccessRepository,boundChat} from './access.js';
import {AudienceRepository} from './audience.js';
import {AttachmentRepository} from './attachments.js';
import {SelectionRepository} from './selections.js';
import type {SourceReference} from './archive.js';
import {afterEpoch,jobRun,type GuardBinding} from './guards.js';
import {evidenceNodeLabel,graphChatType,graphGroupLabel,graphUserLabel} from '../graph-labels.js';
import {ProjectRepository} from './projects.js';
import type {RelationshipAudience} from './relationships.js';
import {archiveReplyPreviews} from './archive-reply-links.js';
import {archiveTranscriptPreviews} from './archive-transcript-previews.js';
import {agentCopies,messageSender} from './archive-row-details.js';
import {BOX_PAGE_BUDGET,PAGE_BUDGET,cursor,pageDate,pageEntry,pageItem} from '../conversation-page.js';
import {archiveScopes,otherPrivate,parentSpace,readSetGroups,sourceChat} from '../spaces.js';
import {chats} from '../chats.js';
import {ownerChat} from '../assistant-policy.js';
import {albumMembers} from './albums.js';
import {unavailableTag,zonedDay,type Tag,type TagDetails} from '../source-tags.js';
import {bindingMoved,ownerReader,type SourceTagRepository,type TagOptions} from './source-tags.js';
import {NOTE_SOURCES_SHOWN,countMemoryStep} from './note-sources.js';
import {bucketOf,sourceFacts} from '../source-facts.js';
import {isTelegramChat,telegramMessage,telegramTopicOpening} from '../chats-telegram.js';
import {repliesElsewhere} from '../observed-source.js';
import type {LearnedMemoryRepository} from './learned.js';
import {ownerTimeZone} from './task-settings.js';
import type {OwnerOriginals} from './owner-originals.js';
import {placeLabel} from '../chat-labels.js';

const pending=(error:unknown)=>error instanceof HttpError&&error.code==='guard_preparation_pending';
// One chat's records in time order, under every id the chat has had ($1, archiveScopes: ADR-0252). Telegram gives a
// message's own time; an assistant reply has only the time it was saved.
const pageRecords=`FROM (SELECT id,kind,at,(extract(epoch FROM at)*1000000)::bigint AS micros FROM (SELECT id,kind,
  CASE WHEN occurred_at ~ '^[0-9]{1,12}$' THEN to_timestamp(occurred_at::bigint) ELSE received_at END AS at FROM events
  WHERE scope=ANY($1::text[]) AND origin<>'generated' AND kind NOT IN ('telegram_wire','import_manifest')) a) e
  WHERE ($2::timestamptz IS NULL OR e.at>=$2) AND ($3::timestamptz IS NULL OR e.at<$3)`;

/** Embedded reply snapshots never substitute for an independently authorized target. `hideQuote` also drops the quote
 *  of the message replied to: a reply to Nocheh's answer to the owner's ask about a member never shows that answer's
 *  words again (D13, SourceAccessRepository.repliesToMemberRead). */
export function scopedObservation(value:unknown,hideQuote=false):any {
  const result=structuredClone(value) as any;
  for(const kind of ['message','edited_message','channel_post','edited_channel_post'])if(result.payload?.[kind]) {
    delete result.payload[kind].reply_to_message;delete result.payload[kind].external_reply;
    if(hideQuote)delete result.payload[kind].quote;
  }
  return result;
}
/** A payload without the quote of the message it replies to, and otherwise as it is. */
const withoutQuote=(payload:unknown):unknown=>{
  const result=structuredClone(payload) as any;
  for(const kind of ['message','edited_message','channel_post','edited_channel_post'])if(result?.[kind])delete result[kind].quote;
  return result;
};
/** Whether a payload (or an observation holding one) carries a quote of the message it replies to. */
const quoting=(value:unknown):boolean=>{
  const payload=(value as any)?.payload??value;
  return ['message','edited_message','channel_post','edited_channel_post'].some(kind=>!!payload?.[kind]?.quote);
};
/** How much of a related message archive_read shows: what it answers or replies to, and each further one (ADR-0261). */
const ANSWER_TEXT=500,THREAD_TEXT=300;
/** The replies to a message the owner's Thread section lists; the rest are counted. */
const OWNER_THREAD_REPLIES=20;
/** How many sources an opened learned entry names (ADR-0261). */
const LEARNED_EVIDENCE=5;
/** At most `size` characters of a text, never half of one that takes two. */
const clip=(text:string,size:number)=>{const chars=Array.from(text);return chars.length>size?{text:chars.slice(0,size).join(''),truncated:true as const}:{text};};
type Tagged=Pick<Tag,'tag'|'by'|'at'>;
export class SourceRepository {
  readonly audience:AudienceRepository;
  /** `tags` names each hit's and each opened original's source (ADR-0261); without it, results keep today's shapes. */
  constructor(readonly access:SourceAccessRepository,readonly attachments:AttachmentRepository,readonly selections:SelectionRepository,
    readonly allowPrepared:(principal:Reader,value:unknown)=>Promise<void>=async()=>{},readonly tags:SourceTagRepository|null=null,
    readonly learned:LearnedMemoryRepository|null=null) {
    this.audience=new AudienceRepository(access.guards);
  }
  private get stores(){return this.access.stores;}
  /**
   * Who · where · when for what a reader is shown (ADR-0261), by id: one batched read and one secret check for the whole
   * request (SourceTagRepository). A source the reader cannot read reads "source not available here". Nothing for the
   * owner's dashboard (admin), whose shapes stay as they were, nor for a reader outside a turn, which has no turn to
   * secret-check new text for (PreparedContextRepository.prepare): it reads today's shapes too.
   */
  private async tagsFor(principal:Reader,binding:GuardBinding|null,references:readonly SourceReference[],options:TagOptions={}):Promise<Map<string,Tagged>> {
    const found=new Map<string,Tagged>();
    if(principal.admin||!principal.turnEvent||!binding||!this.tags||!references.length)return found;
    const tags=await this.tags.tags(principal,binding,references,options);
    for(const reference of references){const tag=tags.get(reference.id);found.set(reference.id,tag?{tag:tag.tag,by:tag.by,at:tag.at}:{...unavailableTag('here'),at:null});}
    return found;
  }
  /** The archive scopes a member's private chat, or the owner's ask about a member, searches (step 4): the groups of its
   *  reads and its bound chat, under every id each has had; null for any other reader (an answer included, whose own
   *  /start is in the owner's chat), which searches everything and is narrowed by canRead alone. A group reader whose
   *  project shares its group chats searches the project's groups (ADR-0267). */
  private boundScopes(principal:Reader):string[]|null {
    const chat=boundChat(principal);
    if(chat===null){const shared=sharedReads(principal);return shared?archiveScopes(readSetGroups(shared)):null;}
    return archiveScopes([...readSetGroups(this.access.reads(principal)!),chat]);
  }
  /** Relations are shown within the conversations the principal recalls. */
  private relationAudience(principal:Reader):RelationshipAudience {
    // A bound reader sees relations within its bound groups (an answer's frozen in its record, ADR-0249), and a member,
    // or the owner's ask about one, within that member's own chat too (step 4).
    if(boundReader(principal)!==null){const chat=boundChat(principal);return {kind:'reads',set:this.access.reads(principal)!,...(chat?{chat}:{})};}
    // A group reader whose project shares its group chats sees relations within the project's groups (ADR-0267).
    const shared=sharedReads(principal);
    if(shared)return {kind:'reads',set:shared};
    const scope=this.access.recall(principal);
    return scope?{kind:'recall',scope}:{kind:'owner'};
  }
  async status(principal:Reader) {
    admin(principal);
    const [events,artifacts]=await Promise.all([
      this.stores.archive.query('SELECT count(*) AS count FROM events'),
      this.stores.archive.query(`SELECT CASE WHEN file_hash IS NULL THEN 'pending' ELSE 'ready' END AS state,
        count(*)::integer AS count FROM artifacts GROUP BY 1 ORDER BY 1`),
    ]);
    return {events:Number(events.rows[0].count),artifacts:artifacts.rows};
  }
  private async permitted(principal:Reader,id:string,binding:GuardBinding|null):Promise<SourceReference> {
    const reference=(await this.access.archive.captured(id)).reference;
    if(binding&&!await this.access.canRead(principal,reference,binding))throw new HttpError(404,'source_not_found');
    return reference;
  }
  /** Whether a scoped read of this event drops the quote it carries (D13): it quotes Nocheh's answer to the owner's ask
   *  about a member. Asked only of a message that quotes anything. */
  private async hiddenQuote(id:string,payload:unknown):Promise<boolean> {
    return quoting(payload)&&(await this.access.repliesToMemberRead([id])).has(id);
  }
  private async currentReactionSources(principal:Reader,reference:SourceReference,binding:GuardBinding|null) {
    const {object_id}=await this.access.relationships.describe(reference);
    const rows=(await this.stores.control.query(`SELECT event_id FROM reaction_states
      WHERE target_id=$1 ORDER BY event_id LIMIT 20`,[object_id])).rows;
    const sources:string[]=[];
    for(const row of rows) {
      const reaction=(await this.access.archive.captured(row.event_id)).reference;
      if(binding&&!await this.access.canRead(principal,reaction,binding))continue;
      sources.push('nocheh:event:'+reaction.id);
    }
    // Captured updates are bounded evidence, never a complete platform inventory.
    return {sources,complete:false as const};
  }
  /** Discover observed current reactions without guessing the target's words or ID. */
  async currentReactions(principal:Reader,count=5){return afterEpoch(jobRun(principal),()=>this.currentReactionsOnce(principal,count));}
  private async currentReactionsOnce(principal:Reader,count:number) {
    limit(count,5,10);
    const binding=principal.admin?null:await this.audience.assert(principal);
    const rows=(await this.stores.control.query(`SELECT event_id FROM reaction_states
      ORDER BY updated_at DESC,event_id LIMIT 200`)).rows;
    const sources:{source:string;kind:'captured_reaction';target_sources:string[];reaction_observation:Record<string,unknown>|null;
      targets:{source:string;text:string;truncated:boolean}[]}[]=[],references:SourceReference[]=[];
    for(const row of rows) {
      const reference=(await this.access.archive.captured(row.event_id)).reference;
      if(binding&&!await this.access.canRead(principal,reference,binding))continue;
      const context=await this.access.relationships.context(reference,binding?this.relationAudience(principal):{kind:'owner'},20);
      const targets:SourceReference[]=[];
      for(const relation of context.targets)if(relation.kind==='reaction_to')for(const target of relation.references) {
        if(binding&&!await this.access.canRead(principal,target,binding))continue;
        targets.push(target);
      }
      // Return the observed change through the guarded read path so finding a
      // handle is sufficient to inspect it. Control-store state is never content.
      const reaction=await this.read(principal,reference.id),previews=[];
      for(const target of targets.slice(0,3)) {
        const record=await this.read(principal,target.id),text=String(record.event.text??'');
        previews.push({source:record.source,text:text.slice(0,2000),truncated:text.length>2000});
      }
      references.push(reference,...targets);
      sources.push({source:'nocheh:event:'+reference.id,kind:'captured_reaction',target_sources:[...new Set(targets.map(target=>'nocheh:event:'+target.id))],
        reaction_observation:reactionObservation(reaction.event.payload),targets:previews});
      if(sources.length===count)break;
    }
    // The reaction and each target it shows name their source (ADR-0261); the reaction's own fields are unchanged.
    const tags=await this.tagsFor(principal,binding,references);
    const tagOf=(source:string)=>{const tag=tags.get(source.slice('nocheh:event:'.length));return tag?{tag:tag.tag,by:tag.by}:{};};
    for(const item of sources){Object.assign(item,tagOf(item.source));for(const target of item.targets)Object.assign(target,tagOf(target.source));}
    if(binding){for(const reference of references)await this.permitted(principal,reference.id,binding);await this.audience.assert(principal);}
    // Empty or bounded results never establish that a message has no reactions.
    const result={sources,complete:false as const};await this.allowPrepared(principal,result);return result;
  }
  /** A message's file and voice texts, guarded for a scoped reader. A status that a reading replaced,
   * such as a voice note saved before transcription was set up, is not shown. */
  private async derivedTexts(id:string,binding:GuardBinding|null) {
    const selected=(await this.stores.derived.query(`SELECT s.artifact_id,s.kind,r.derived_id,d.content,d.provenance FROM derivative_selections s
      JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
      JOIN derived_artifacts d ON d.id=r.derived_id WHERE s.event_id=$1 AND s.kind IN ('transcript','extracted_text','extraction_status')
        AND NOT (s.kind='extraction_status' AND EXISTS(SELECT 1 FROM derivative_selections t WHERE t.artifact_id=s.artifact_id
          AND t.kind IN ('transcript','extracted_text') AND t.active_revision IS NOT NULL)) ORDER BY s.id`,[id])).rows;
    const texts:{id:string;artifact_id:string;kind:string;text:string;provenance:unknown}[]=[];
    for(const item of selected) {
      const value=binding?(await this.selections.current(id,item.artifact_id,item.kind,binding)).value as any:{text:item.content.toString(),kind:item.kind,provenance:item.provenance};
      texts.push({id:item.derived_id,artifact_id:item.artifact_id,kind:value.kind,text:String(value.text),provenance:value.provenance});
    }
    return texts;
  }
  // A job run's read runs again when an epoch it carries across commits meanwhile (ADR-0208).
  async read(principal:Reader,id:string){return afterEpoch(jobRun(principal),()=>this.readOnce(principal,id));}
  private async readOnce(principal:Reader,id:string) {
    const binding=principal.admin?null:await this.audience.assert(principal),reference=await this.permitted(principal,id,binding);
    const row=(await this.stores.archive.query('SELECT * FROM events WHERE id=$1',[id])).rows[0];
    let content:any={text:row.original_text?.toString()??null,payload:JSON.parse(row.payload.toString())},guardedRevision:number|null=null;
    const hideQuote=!!binding&&await this.hiddenQuote(id,content.payload);
    if(binding?.mode==='on') {
      const guarded=await this.access.guards.read('events:'+id,binding);content=scopedObservation(guarded.value,hideQuote);guardedRevision=guarded.revision;
    }
    else if(binding)content=scopedObservation(content,hideQuote);
    const event:Envelope={version:1,key:principal.admin?row.source_key:'nocheh:event:'+id,channel:row.channel,bot_id:principal.admin?row.bot_id:'',
      origin:row.origin,scope:row.scope,source_id:row.source_id,revision:row.revision,kind:row.kind,occurred_at:row.occurred_at,...content,
      ...(principal.admin&&row.wire?{wire_base64:row.wire.toString('base64')}:{}),
      ...(principal.admin&&row.source_descriptor?{source:JSON.parse(row.source_descriptor.toString())}:{})};
    const manifests=(await this.stores.archive.query('SELECT * FROM artifacts WHERE event_id=$1 ORDER BY id',[id])).rows;
    const artifacts=[];
    for(const item of manifests) {
      let metadata={kind:item.kind,metadata:item.metadata};
      if(binding?.mode==='on') {
        if(!item.file_hash)continue;
        metadata=(await this.access.guards.read('artifacts:'+item.id,binding)).value as typeof metadata;
      }
      artifacts.push({id:item.id,...metadata,state:item.file_hash?'ready':'pending',...(principal.admin?{file_hash:item.file_hash,byte_size:item.byte_size}:{}),source:'nocheh:artifact:'+item.id});
    }
    const derived=(await this.derivedTexts(id,binding)).map(item=>({id:item.id,event_id:id,artifact_id:item.artifact_id,kind:item.kind,
      representation:binding?.mode==='on'?'guarded':'derived',content_base64:Buffer.from(item.text).toString('base64'),provenance:item.provenance,
      source:'nocheh:derivative:'+item.id}));
    const relationships=await this.access.relationships.context(reference,binding?this.relationAudience(principal):{kind:'owner'},20);
    if(binding){await this.permitted(principal,id,binding);await this.audience.assert(principal);}
    const replies=principal.admin?await archiveReplyPreviews(this.stores.archive,this.stores.control,[{id,kind:row.kind,scope:row.scope}]):new Map();
    // The owner's detail view shows the same reply state as the message lists.
    const ownerState=principal.admin?{...(await this.stores.control.query(`SELECT state AS assistant_state,runtime_stage AS assistant_stage,error_code AS assistant_error,
      attempts AS assistant_attempts FROM dispatches WHERE event_id=$1`,[id])).rows[0] as Record<string,unknown>|undefined,
      ...(await actionReviews(this.stores.control,row.kind==='telegram_update'?[id]:[],'separated').then(reviews=>reviews.has(id)?{action_review:reviews.get(id)}:{})),
      agent_copy:(await agentCopies(this.stores.derived,[id])).get(id),reaction_preview:reactionPreview(row.kind,JSON.parse(row.payload.toString())),
      sender:messageSender(row.kind,JSON.parse(row.payload.toString()))}:{};
    const current_reactions=await this.currentReactionSources(principal,reference,binding);
    if(binding){await this.permitted(principal,id,binding);await this.audience.assert(principal);}
    const result={id,source:'nocheh:event:'+id,reference,received_at:row.received_at.toISOString(),representation:binding?.mode==='on'?'guarded':'original',
      guarded_revision:guardedRevision,event,artifacts,derived,relationships,current_reactions,derivative_versions:'/v1/sources/'+id+'/derivatives',
      ...(principal.admin?{reply_messages:replies.get(id)??[],...ownerState}:{})};
    await this.allowPrepared(principal,result);return result;
  }

  /**
   * archive_read's open (ADR-0261): read() and, for anyone but the owner's dashboard, what names the message and its
   * thread, each part only within what the reader may read. `tag`, `by` and `at` name its source; `chat_id` and `at`
   * open the conversation around it (archive_page); `forward` names where a forward came from and `topic` the topic it
   * is in. `answers` is the message a reply of Nocheh's answers (its own canRead). `reply_to` is the message it replies
   * to, and `chain` the messages before that, `chain` of them, each through the archive's reply relation within the
   * reader's conversations (relationAudience), then canRead. A forum topic's opening is no reply: a message replying to
   * it has no reply_to, and the opening's own `replies` are the whole topic, which archive_page reads. An old Telegram
   * Desktop export whose message replies into another chat keeps no reply link (reply_link_withheld), since its id
   * names that chat's message. `replies` counts the readable messages that reply to it and shows the first `replies`.
   * Texts are the reader's own copies, cut short; the result stays within ARCHIVE_READ_LIMIT characters.
   */
  async opened(principal:Reader,id:string,options:{replies:number;chain:number}){return afterEpoch(jobRun(principal),()=>this.openedOnce(principal,id,options));}
  private async openedOnce(principal:Reader,id:string,options:{replies:number;chain:number}) {
    const found=await this.readOnce(principal,id);
    if(principal.admin||!principal.turnEvent||!this.tags)return found;
    const binding=await this.audience.assert(principal);
    // A thread that cannot be worked out never fails the read: the message opens as before, with its source "not
    // available right now", and the failure is counted as a `source_tags` problem.
    const thread=await this.thread(principal,binding,found.reference,found.event.payload,options).catch(async error=>{
      if(bindingMoved(error))throw error;
      await countMemoryStep(this.stores.control,'source_tags',false);
      return {fields:{...unavailableTag('now'),at:null},linked:[] as string[]};
    });
    for(const linked of thread.linked)await this.permitted(principal,linked,binding);
    await this.audience.assert(principal);
    const result={...found,...thread.fields};
    await this.allowPrepared(principal,result);return result;
  }
  /** Kind, channel, scope and payload of each of these events, as the archive holds them. */
  private async originals(ids:readonly string[]):Promise<Map<string,{kind:string;channel:string;scope:string;payload:any}>> {
    const wanted=[...new Set(ids)];if(!wanted.length)return new Map();
    const rows=(await this.stores.archive.query('SELECT id,kind,channel,scope,payload FROM events WHERE id=ANY($1::text[])',[wanted])).rows;
    return new Map(rows.map(row=>{let payload:any=null;try{payload=JSON.parse(row.payload.toString());}catch{}return [row.id as string,{kind:row.kind,channel:row.channel,scope:row.scope,payload}];}));
  }
  /** Whether an event is an old Telegram Desktop export of a reply into another chat (repliesElsewhere). */
  private static elsewhere(row:{kind:string;payload:any}|undefined):boolean {return !!row&&row.kind.startsWith('telegram_desktop_')&&repliesElsewhere(telegramMessage(row.payload));}
  /** The text of an event as this reader's own copy holds it (the guarded copy when the secret check is on), with its
   *  payload; null while that copy is being checked. */
  private async shownCopy(id:string,binding:GuardBinding):Promise<{text:string;payload:unknown}|null> {
    if(binding.mode==='on') {
      const guarded=await this.access.guards.read('events:'+id,binding).catch(error=>{if(pending(error))return null;throw error;});
      if(!guarded)return null;
      const value=scopedObservation(guarded.value,await this.hiddenQuote(id,(guarded.value as any)?.payload));return {text:String(value.text??''),payload:value.payload??null};
    }
    const row=(await this.stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[id])).rows[0];
    const payload=row?JSON.parse(row.payload.toString()):null;
    return {text:row?.original_text?.toString()??'',payload:payload&&await this.hiddenQuote(id,payload)?withoutQuote(payload):payload};
  }
  private async thread(principal:Reader,binding:GuardBinding,reference:SourceReference,payload:unknown,options:{replies:number;chain:number}) {
    const audience=this.relationAudience(principal),self=(await this.originals([reference.id])).get(reference.id)!;
    const readable=async(references:readonly SourceReference[])=>references.length?await this.access.readable(principal,references,binding):new Map<string,boolean>();
    // What it replies to, then what that replies to: the first readable copy of each, never a topic's opening.
    const hops:SourceReference[]=[];let current=reference.id,withheld=SourceRepository.elsewhere(self);
    for(let step=0;step<=options.chain&&!withheld;step++) {
      // A topic's message carries its topic's opening as a reply; another target is one it replies to in another chat.
      const all=(await this.access.relationships.replyTargets([current],audience)).get(current)??[];
      const openings=await this.topicOpenings(all.map(target=>target.id)),targets=all.filter(target=>!openings.has(target.id));
      if(!targets.length)break;
      const open=await readable(targets),target=targets.find(item=>open.get(item.id)===true);
      if(!target||target.id===reference.id||hops.some(hop=>hop.id===target.id))break;
      hops.push(target);current=target.id;withheld=SourceRepository.elsewhere((await this.originals([target.id])).get(target.id));
    }
    // The message a reply of Nocheh's answers, from the reply's own record, through its own access check.
    const answersId=sourceFacts({channel:self.channel,kind:self.kind,payload:self.payload},this.access.policy().owner_id).answers;
    const answered=answersId?await this.access.archive.captured(answersId).then(found=>found.reference).catch(()=>null):null;
    const answers=answered&&(await readable([answered])).get(answered.id)===true?answered:null;
    // The messages that reply to it: each once, by its first readable copy; never an export's reply into another chat.
    const opening=telegramTopicOpening(telegramMessage(self.payload));
    let replying:SourceReference[]=[],complete=true;
    if(!opening) {
      const object=(await this.access.relationships.describeMany([reference.id])).get(reference.id)?.object_id;
      const found=object?await this.access.relationships.replies(object,audience,100):{replies:[],more:false};
      const candidates=found.replies.flatMap(reply=>reply.references),open=await readable(candidates),rows=await this.originals(candidates.map(item=>item.id));
      replying=found.replies.map(reply=>reply.references.find(item=>open.get(item.id)===true&&!SourceRepository.elsewhere(rows.get(item.id))))
        .filter((item):item is SourceReference=>!!item&&item.id!==reference.id);
      complete=!found.more;
    }
    const shownItems=[...hops,...(answers?[answers]:[]),...replying.slice(0,options.replies)];
    const copies=new Map<string,{text:string;payload:unknown}|null>();
    for(const item of shownItems)if(!copies.has(item.id))copies.set(item.id,await this.shownCopy(item.id,binding));
    const shown=new Map<string,unknown>([[reference.id,binding.mode==='on'?payload:undefined],...[...copies].map(([id,copy])=>[id,copy?.payload] as [string,unknown])]);
    for(const [key,value] of [...shown])if(value===undefined)shown.delete(key);
    const tags=await this.tags!.tags(principal,binding,[reference,...shownItems],{shown,details:true});
    const named=(item:SourceReference,size:number)=>{
      const tag=tags.get(item.id),copy=copies.get(item.id),fallback=unavailableTag('here');
      return {source:'nocheh:event:'+item.id,tag:tag?.tag??fallback.tag,by:tag?.by??fallback.by,
        ...(copy?clip(copy.text,size):{checking:true})};
    };
    const own=tags.get(reference.id) as (Tag&TagDetails)|null|undefined,ownTag=own??{...unavailableTag('here'),at:null};
    const captured=await this.access.archive.captured(reference.id);
    const fields:Record<string,unknown>={tag:ownTag.tag,by:ownTag.by,at:ownTag.at,chat_id:sourceChat(captured),
      ...(own?.forward?{forward:own.forward}:{}),...(own?.topic?{topic:own.topic}:{}),
      ...(answers?{answers:named(answers,ANSWER_TEXT)}:{}),
      ...(hops[0]?{reply_to:named(hops[0],ANSWER_TEXT)}:{}),...(hops.length>1?{chain:hops.slice(1).map(item=>named(item,THREAD_TEXT))}:{}),
      ...(SourceRepository.elsewhere(self)?{reply_link_withheld:'other_chat'}:{}),
      replies:opening?{count:0,items:[],topic:true}:{count:replying.length,items:replying.slice(0,options.replies).map(item=>named(item,THREAD_TEXT)),...(complete?{}:{complete:false})}};
    return {fields,linked:shownItems.map(item=>item.id)};
  }
  /**
   * The Thread section of a message on the owner's dashboard (ADR-0261 step 4), from the archive's relations as
   * archive_read reads them: what it replies to, how many messages reply to it with the first OWNER_THREAD_REPLIES
   * listed, the topic it is in, and where a forward came from, each in the owner's words (OwnerOriginals: a retired
   * message reads only `retired`). The owner reads every chat. A forum topic's opening is no reply: a message replying to
   * it shows its topic, never `reply_to`, and the opening's own replies are the whole topic, which are not listed here.
   * An old Telegram Desktop export's reply into another chat keeps no link (`reply_in_other_chat`). Someone else's private
   * chat stays out of the owner's default view (ADR-0262): seen from any other chat, a reply into it reads only
   * `reply_in_private_chat`, never its message, and a reply from it is left out.
   */
  async ownerThread(principal:Reader,id:string,originals:OwnerOriginals) {
    admin(principal);
    await this.permitted(principal,id,null);
    const self=(await this.originals([id])).get(id)!,audience:RelationshipAudience={kind:'owner'};
    const message=telegramMessage(self.payload) as {reply_to_message?:unknown}|null;
    const elsewhere=SourceRepository.elsewhere(self),opens=telegramTopicOpening(message);
    const described=(await this.access.relationships.describeMany([id])).get(id),chat=described?.chat??sourceChat(self);
    const base=(place:string|null)=>chats().parentOf(place)??place;
    const placesOf=async(ids:readonly string[])=>{const found=await this.access.relationships.describeMany(ids);return (item:string)=>found.get(item)?.chat??null;};
    // A message in someone else's private chat is shown only from inside that chat.
    const shown=(place:string|null)=>!otherPrivate(place)||base(place)===base(chat);
    const targets=elsewhere?[]:((await this.access.relationships.replyTargets([id],audience)).get(id)??[]).filter(target=>target.id!==id);
    const openings=await this.topicOpenings(targets.map(target=>target.id)),placeOf=await placesOf(targets.map(target=>target.id));
    // Every copy of an opening is one, and the message's own embedded reply says so too (as groupAddressing reads it).
    const embedded=telegramTopicOpening(message?.reply_to_message);
    const opening=targets.find(target=>openings.has(target.id))??null,toOpening=!!opening||embedded;
    // A topic's message that replies to one in another chat carries its topic's opening too: what it replies to is that
    // other message, never the opening (when the embedded reply is the opening, only a message in another chat is).
    const target=targets.find(item=>!openings.has(item.id)&&(!embedded||placeOf(item.id)!==null&&base(placeOf(item.id))!==base(chat)))??null;
    const replyTo=target&&shown(placeOf(target.id))?target:null,hidden=!!target&&!replyTo;
    let replying:string[]=[],complete=true;
    if(!opens) {
      const object=described?.object_id;
      const found=object?await this.access.relationships.replies(object,audience,100):{replies:[],more:false};
      const rows=await this.originals(found.replies.flatMap(reply=>reply.references.map(item=>item.id)));
      replying=found.replies.map(reply=>reply.references.find(item=>!SourceRepository.elsewhere(rows.get(item.id)))?.id)
        .filter((item):item is string=>!!item&&item!==id);
      const replyPlace=await placesOf(replying);
      replying=replying.filter(item=>shown(replyPlace(item)));
      complete=!found.more;
    }
    const inTopic=chat!==null&&chats().kind(chat)==='topic',listed=replying.slice(0,OWNER_THREAD_REPLIES);
    const named=await originals.originals([id,...replyTo?[replyTo.id]:[],...opening?[opening.id]:[],...listed]);
    const own=named.get(id),words=inTopic||opens||toOpening?await originals.notes.ownerWords():null;
    return {reply_to:replyTo?named.get(replyTo.id)??null:null,...elsewhere?{reply_in_other_chat:true}:{},...hidden?{reply_in_private_chat:true}:{},
      replies:opens?{count:0,items:[],topic:true}:{count:replying.length,items:listed.flatMap(item=>named.get(item)??[]),...complete?{}:{complete:false}},
      topic:words?{label:chat?placeLabel(chat,words.places):words.places.unknown_chat,...opens?{opens:true}:{},opening:opening?named.get(opening.id)??null:null}:null,
      forwarded_from:own&&'forward' in own?own.forward??null:null};
  }
  /**
   * What the model learned and the owner corrected, opened by its id and revision (archive_read nocheh:learned): only the
   * active revision, read as memory_recall reads it (LearnedMemoryRepository.read: its scope, its evidence through
   * canRead, its guarded copy). It names who wrote it, the day of that revision in the reader's zone, and up to
   * LEARNED_EVIDENCE of its sources, tagged.
   */
  async learnedEntry(principal:Reader,id:string,revision:number){return afterEpoch(jobRun(principal),()=>this.learnedOnce(principal,id,revision));}
  private async learnedOnce(principal:Reader,id:string,revision:number) {
    if(principal.admin||!principal.turnEvent||!this.learned||!this.tags)throw new HttpError(403,'scoped_turn_required');
    const binding=await this.audience.assert(principal);
    const version=await this.learned.read(principal,id,binding,async reference=>this.access.canRead(principal,reference,binding),this.access.recall(principal));
    if(version.revision!==revision)throw new HttpError(404,'learned_memory_not_found');
    const created=(await this.stores.derived.query('SELECT created_at FROM learned_versions WHERE entry_id=$1 AND revision=$2',[id,revision])).rows[0]?.created_at as Date|undefined;
    const zone=ownerReader(principal)?await ownerTimeZone(this.stores.control):'UTC';
    const evidence=(version.evidence??[]).slice(0,LEARNED_EVIDENCE),tags=await this.tags.tags(principal,binding,evidence);
    const result={source:`nocheh:learned:${id}:${revision}`,kind:version.kind,subject:version.subject,text:version.text,author:version.author,
      day:created?zonedDay(created.getTime(),zone):null,
      evidence:evidence.map(item=>{const tag=tags.get(item.id)??{...unavailableTag('here')};return {source:'nocheh:event:'+item.id,tag:tag.tag,by:tag.by};}),
      ...((version.evidence?.length??0)>LEARNED_EVIDENCE?{more:version.evidence.length-LEARNED_EVIDENCE}:{})};
    await this.audience.assert(principal);await this.allowPrepared(principal,result);return result;
  }

  /**
   * What a note in this turn's evidence was written from, by its ref (archive_read {note}, ADR-0261): the messages the
   * turn's own lookup kept for it (a review's batch, or the message a turn answered), each through canRead, at most
   * NOTE_SOURCES_SHOWN of them, tagged. A ref opens only in the turn whose evidence showed it, and not after seven days;
   * it opens nothing for a private answer, which has no notes.
   */
  async noteEntry(principal:Reader,ref:string){return afterEpoch(jobRun(principal),()=>this.noteOnce(principal,ref));}
  private async noteOnce(principal:Reader,ref:string) {
    // No bound reader opens a note's ref (ADR-0262): a private answer, a member's private chat and the owner's ask about a
    // member keep no notes, and the ask shares its turn's message, and so its note refs, with the owner's asking turn.
    if(principal.admin||!principal.turnEvent||boundReader(principal)!==null||!this.tags)throw new HttpError(403,'scoped_turn_required');
    const binding=await this.audience.assert(principal);
    const ids=await this.tags.notes.noteSources(principal.turnEvent,ref);
    if(ids===null)throw new HttpError(404,'note_not_found');
    const captured=await this.access.archive.capturedMany(ids),references=ids.flatMap(id=>captured.has(id)?[captured.get(id)!.reference]:[]);
    // A message the reader may not read is left out, with no count, as an unreadable reference is anywhere; canRead
    // comes first (checked), so a check that fails opens none of them.
    const tags=await this.tags.checked(principal,binding,references),readable=references.flatMap(reference=>{const tag=tags.get(reference.id);return tag?[tag]:[];});
    const shown=readable.slice(0,NOTE_SOURCES_SHOWN);
    const result={note:ref,sources:shown.map(tag=>({source:tag.source,tag:tag.tag,by:tag.by})),...readable.length>shown.length?{more:readable.length-shown.length}:{}};
    await this.audience.assert(principal);await this.allowPrepared(principal,result);return result;
  }

  /** Archive search deliberately excludes transcripts, contexts and learned results. */
  async search(principal:Reader,query:string,count=20,filters:ArchiveFilters={kind:'',scope:'',reply:''}){return afterEpoch(jobRun(principal),()=>this.searchOnce(principal,query,count,filters));}
  private async searchOnce(principal:Reader,query:string,count:number,filters:ArchiveFilters) {
    string(query,2000);limit(count);if(!query.trim())throw new HttpError(400,'empty_query');
    const binding=principal.admin?null:await this.audience.assert(principal);
    // A member's private chat and the owner's ask about a member search only the chats they may read (the bound groups and
    // that member's chat, step 4), so other chats' hits never crowd theirs out of the first 200; canRead still decides each.
    const narrowed=binding?this.boundScopes(principal):null;
    // The private-chat split (step 4) is applied in the query too, so other chats' hits never crowd the asked ones out of
    // the first 200; matchesArchiveFilters still checks each hit.
    const split=privateChatsParams(filters);
    const among=(narrowed||split[0])&&binding?.mode==='on'?(await this.stores.archive.query(`SELECT id FROM events WHERE ($2::text[] IS NULL OR scope=ANY($2::text[]))
      AND ($3::text[] IS NULL OR (scope=ANY($3::text[]))=$4) AND to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1) ORDER BY id LIMIT 5000`,
      [query,narrowed,...split])).rows.map(row=>row.id as string):null;
    const rows=await (binding?.mode==='on'?this.stores.derived.query(`SELECT s.event_id AS id,r.content FROM guard_sources s
      JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision
      WHERE s.kind='events' AND s.state='ready' AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1)
        AND ($2::text[] IS NULL OR s.event_id=ANY($2::text[]))
      ORDER BY ts_rank(to_tsvector('simple',r.search_text),plainto_tsquery('simple',$1)) DESC,s.id LIMIT 200`,[query,among]):
      this.stores.archive.query(`SELECT id FROM events WHERE to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1)
        AND ($2::text[] IS NULL OR scope=ANY($2::text[])) AND ($3::text[] IS NULL OR (scope=ANY($3::text[]))=$4)
        ORDER BY ts_rank(to_tsvector('simple',search_text),plainto_tsquery('simple',$1)) DESC,id LIMIT 200`,[query,narrowed,...split]));
    const stateRows=principal.admin&&rows.rows.length?(await this.stores.control.query('SELECT event_id,state FROM dispatches WHERE event_id=ANY($1::text[])',[rows.rows.map(row=>row.id)])).rows:[];
    const states=new Map(stateRows.map(row=>[row.event_id,row.state]));
    const reviews=principal.admin?await actionReviews(this.stores.control,rows.rows.map(row=>row.id),'separated'):new Map();
    // An exported copy of a message the bot also captured live is the same message; the owner sees it marked, the agent once.
    const liveCopies=await this.access.retirements?.liveCopies(rows.rows.map(row=>row.id))??new Set<string>();
    const hits:any[]=[],references:SourceReference[]=[],shown=new Map<string,unknown>();
    for(const candidate of rows.rows) {
      if(!principal.admin&&liveCopies.has(candidate.id))continue;
      const captured=await this.access.archive.captured(candidate.id),reference=captured.reference;
      if(binding&&!await this.access.canRead(principal,reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT scope,source_id,revision,kind,origin,occurred_at,original_text,payload FROM events WHERE id=$1',[reference.id])).rows[0];
      if(!matchesArchiveFilters(original,states.get(reference.id),filters,reviews.get(reference.id)?.state))continue;
      const value=binding?.mode==='on'?await (async()=>{const guarded=(await this.access.guards.read('events:'+reference.id,binding)).value as any;
        return scopedObservation(guarded,await this.hiddenQuote(reference.id,guarded?.payload));})():{text:original.original_text?.toString()??''};
      // The lexical index includes payload metadata, but a scoped hit must also
      // match the independent message text, never a stripped reply snapshot.
      const text=String(value.text??'');
      if(binding&&!(await this.stores.derived.query("SELECT to_tsvector('simple',$1) @@ plainto_tsquery('simple',$2) AS matches",[text,query])).rows[0].matches)continue;
      const artifactKinds=principal.admin?(await this.stores.archive.query('SELECT kind FROM artifacts WHERE event_id=$1 ORDER BY id',[reference.id])).rows.map(row=>row.kind as string):[];
      const {payload,...fields}=original;
      // `chat_id` is the Nocheh chat the hit's archive original belongs to (ADR-0252); compare chats with it, never with `scope`.
      hits.push({id:reference.id,source:'nocheh:event:'+reference.id,...fields,chat_id:sourceChat(captured),...(states.has(reference.id)?{assistant_state:states.get(reference.id)}:{}),...(reviews.has(reference.id)?{action_review:reviews.get(reference.id)}:{}),original_text:undefined,representation:binding?.mode==='on'?'guarded':'original',
        derived_id:null,text:text.slice(0,2000),truncated:text.length>2000,
        content_types:sourceContentTypes(original.kind,binding?.mode==='on'?(value as {payload?:unknown}).payload:JSON.parse(payload.toString()),artifactKinds),
        ...(principal.admin?{reaction_preview:reactionPreview(original.kind,JSON.parse(payload.toString())),sender:messageSender(original.kind,JSON.parse(payload.toString())),
          ...(liveCopies.has(reference.id)?{live_copy:true}:{})}:{})});
      references.push(reference);if(binding?.mode==='on')shown.set(reference.id,(value as {payload?:unknown}).payload??null);
      if(hits.length===count)break;
    }
    // Each hit names its source (ADR-0261), from the copy this reader was just shown; every field above stays.
    const tags=await this.tagsFor(principal,binding,references,{shown});
    for(const hit of hits)Object.assign(hit,tags.get(hit.id)??{});
    if(binding){for(const hit of hits)await this.permitted(principal,hit.id,binding);await this.audience.assert(principal);}
    if(principal.admin){
      const retired=await this.access.retirements?.retiredEvents(hits.map(hit=>hit.id));
      for(const hit of hits)hit.retired=retired?.has(hit.id)??false;
      const [replies,transcripts,copies]=await Promise.all([
        archiveReplyPreviews(this.stores.archive,this.stores.control,hits),archiveTranscriptPreviews(this.stores.derived,hits),agentCopies(this.stores.derived,hits.map(hit=>hit.id))]);
      for(const hit of hits){hit.reply_messages=replies.get(hit.id)??[];hit.transcript_preview=transcripts.get(hit.id)??null;hit.agent_copy=copies.get(hit.id);}
    }
    await this.allowPrepared(principal,hits);return hits;
  }
  /** Messages another index found, such as memory search by meaning, read back through the reader's own access. Those in
   *  `tagged` name their source (ADR-0261); the rest keep today's fields alone. */
  async found(principal:Reader,ids:string[],count:number,tagged:ReadonlySet<string>=new Set()){return afterEpoch(jobRun(principal),()=>this.foundOnce(principal,ids,count,tagged));}
  private async foundOnce(principal:Reader,ids:string[],count:number,tagged:ReadonlySet<string>) {
    const binding=principal.admin?null:await this.audience.assert(principal);
    const liveCopies=await this.access.retirements?.liveCopies(ids)??new Set<string>();
    const hits:({source:string;scope:string;chat_id:string|null;kind:string;occurred_at:string|null;text:string;truncated?:true}&Partial<Tagged>)[]=[];
    const references:SourceReference[]=[],shown=new Map<string,unknown>();
    for(const id of ids) {
      if(hits.length===count)break;
      if(!principal.admin&&liveCopies.has(id))continue;
      const captured=await this.access.archive.captured(id).catch(()=>null);
      if(!captured||binding&&!await this.access.canRead(principal,captured.reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT occurred_at,original_text FROM events WHERE id=$1',[id])).rows[0];
      let text=original.original_text?.toString()??'',payload:unknown;
      if(binding?.mode==='on') {
        const guarded=await this.access.guards.read('events:'+id,binding).catch(error=>{if(pending(error))return null;throw error;});
        if(!guarded)continue;
        const value=scopedObservation(guarded.value,await this.hiddenQuote(id,(guarded.value as any)?.payload));text=String(value.text??'');payload=value.payload??null;
      }
      hits.push({source:'nocheh:event:'+id,scope:captured.scope,chat_id:sourceChat(captured),kind:captured.kind,occurred_at:original.occurred_at,text:text.slice(0,2000),...(text.length>2000?{truncated:true as const}:{})});
      if(tagged.has(id)){references.push(captured.reference);if(binding?.mode==='on')shown.set(id,payload);}
    }
    const tags=await this.tagsFor(principal,binding,references,{shown});
    for(const hit of hits)Object.assign(hit,tags.get(hit.source.slice(13))??{});
    if(binding){for(const hit of hits)await this.permitted(principal,hit.source.slice(13),binding);await this.audience.assert(principal);}
    await this.allowPrepared(principal,hits);return hits;
  }
  /** A conversation in time order, one page at a time, with only what the reader may read.
   * The owner may name any chat; anyone else reads the chat they are in. */
  /** The chat a page or a size reads: the owner names any chat, an answer reader any group of its record, anyone else
   * only their own. */
  private async conversation(principal:Reader,input:{chat:string;from:string;to:string}) {
    string(input.chat,256);
    const from=pageDate(input.from),to=pageDate(input.to,true);
    const binding=principal.admin?null:await this.audience.assert(principal),owner=principal.admin||principal.scope===null;
    const kind=boundReader(principal);
    // An answer reader reads any group of its record, by default the asking one, and never its own private chat (ADR-0249).
    if(kind==='answer') {
      const reads=this.access.reads(principal)!,chat=input.chat||(parentSpace(reads.home)??reads.home);
      if(!readSetGroups(reads).includes(chat))throw new HttpError(403,'conversation_not_permitted');
      return {chat,scopes:archiveScopes([chat]),from,to,binding};
    }
    // A member reads their own private chat, by default, or any of their joined groups; the owner's ask about a member
    // reads only that member's chat (step 4). Nothing without its binding.
    if(kind!==null) {
      const reads=this.access.reads(principal)!,mine=boundChat(principal);
      if(mine===null)throw new HttpError(409,'member_chat_closed');
      const chat=input.chat||mine;
      if(chat!==mine&&!readSetGroups(reads).includes(chat))throw new HttpError(403,'conversation_not_permitted');
      return {chat,scopes:archiveScopes([chat]),from,to,binding};
    }
    // A group reader whose project shares its group chats may page any of the project's groups (ADR-0267).
    const shared=sharedReads(principal);
    if(!owner&&input.chat&&input.chat!==principal.scope&&!(shared&&readSetGroups(shared).includes(input.chat)))throw new HttpError(403,'conversation_not_permitted');
    // The owner's turns never page a private chat that is not the owner's (a member's or a stranger's); the dashboard
    // does (step 4).
    // A raw Telegram id is read under the chat it names, so it is told apart by that chat too.
    if(owner&&!principal.admin&&(otherPrivate(input.chat)||isTelegramChat(input.chat)&&otherPrivate(chats().resolve('telegram',input.chat))))
      throw new HttpError(403,'conversation_not_permitted');
    // A topic is read with the rest of its group, as a group reader reads it.
    const space=principal.space?parentSpace(principal.space)??principal.space:null;
    const chat=owner?input.chat||(principal.admin?'':space??ownerChat(this.access.policy())??''):input.chat||principal.scope!;
    if(!chat)throw new HttpError(400,'conversation_required');
    // A chat is read under every id it has had, current and old, through chat_ids (ADR-0252). The owner may also name a
    // value no chat row holds (an unmapped import), read as it is; anyone else reads nothing of one.
    return {chat,scopes:chats().get(chat)?archiveScopes([chat]):owner?[chat]:[],from,to,binding};
  }
  /** How much a chat, or a period of it, holds, so a big job can be sized before it starts. */
  async size(principal:Reader,input:{chat:string;from:string;to:string}) {
    const {chat,scopes,from,to}=await this.conversation(principal,input);
    const totals=(await this.stores.archive.query(`SELECT count(*)::integer AS records,
      count(*) FILTER (WHERE r.kind IN ('telegram_update','telegram_desktop_message','browser_input'))::integer AS messages,
      coalesce(sum(octet_length(t.original_text)),0)::bigint AS characters,min(r.at) AS first,max(r.at) AS last
      FROM (SELECT e.id,e.kind,e.at ${pageRecords}) r JOIN events t ON t.id=r.id`,[scopes,from,to])).rows[0];
    // A photo is kept in several sizes, so files are counted by the message that has them.
    const files=(await this.stores.archive.query(`SELECT count(DISTINCT a.event_id) FILTER (WHERE a.kind IN ('document','file'))::integer AS files,
      count(DISTINCT a.event_id) FILTER (WHERE a.kind IN ('photo','image'))::integer AS images,
      count(DISTINCT a.event_id) FILTER (WHERE a.kind IN ('voice','audio','video_note'))::integer AS voice_notes
      FROM (SELECT e.id ${pageRecords}) r JOIN artifacts a ON a.event_id=r.id`,[scopes,from,to])).rows[0];
    return {chat,records:totals.records,messages:totals.messages,characters:Number(totals.characters),
      files:files.files,images:files.images,voice_notes:files.voice_notes,
      first:totals.first?.toISOString()??null,last:totals.last?.toISOString()??null};
  }
  /** `whole` reads a sealed job box's copy (job-box.ts): checked text only, without the page cuts, in bigger pages,
   *  without reaction updates; a message still being checked is left out and counted in `checking`. */
  async page(principal:Reader,input:{chat:string;from:string;to:string;after:string;count:number;whole?:boolean}){return afterEpoch(jobRun(principal),()=>this.pageOnce(principal,input));}
  private async pageOnce(principal:Reader,input:{chat:string;from:string;to:string;after:string;count:number;whole?:boolean}) {
    const after=cursor(input.after),{chat,scopes,from,to,binding}=await this.conversation(principal,input),whole=!!input.whole;
    if(whole&&binding?.mode!=='on')throw new HttpError(409,'job_box_guard_off');
    const records=pageRecords,budget=whole?BOX_PAGE_BUDGET:PAGE_BUDGET;
    const rows=(await this.stores.archive.query(`SELECT id,kind,at,micros ${records} AND ($4::bigint IS NULL OR (e.micros,e.id)>($4::bigint,$5))
      ORDER BY e.micros,e.id LIMIT 201`,[scopes,from,to,after?.micros??null,after?.id??''])).rows;
    const liveCopies=principal.admin?new Set<string>():await this.access.retirements?.liveCopies(rows.map(row=>row.id))??new Set<string>();
    const items:Record<string,unknown>[]=[],shown:string[]=[];let last:{micros:string;id:string}|null=null,size=0,full=false,checking=0;
    for(const row of rows.slice(0,200)) {
      if(items.length===input.count||size>=budget){full=true;break;}
      const previous=last;last=row;
      if(liveCopies.has(row.id))continue;
      const captured=await this.access.archive.captured(row.id);
      if(binding&&!await this.access.canRead(principal,captured.reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[row.id])).rows[0];
      let value:any={text:original.original_text?.toString()??'',payload:JSON.parse(original.payload.toString())};
      const type=pageEntry(row.kind,value.payload);
      if(!type||whole&&type==='reaction')continue;
      shown.push(row.id);
      if(binding?.mode==='on') {
        const guarded=await this.access.guards.read('events:'+row.id,binding).catch(error=>{if(pending(error))return null;throw error;});
        if(!guarded){if(whole)checking++;else items.push({source:'nocheh:event:'+row.id,at:row.at.toISOString(),type,checking:true});continue;}
        value=guarded.value;
      }
      const files=captured.artifact_ids.length?await this.derivedTexts(row.id,binding).catch(error=>{if(pending(error))return null;throw error;}):[];
      if(whole&&files===null){checking++;continue;}
      const item=pageItem({id:row.id,kind:row.kind,at:row.at,payload:value.payload,text:String(value.text??''),files:files??[]},whole,ownerReader(principal));
      const entry=files===null?{...item,files_checking:true}:item,length=JSON.stringify(entry).length;
      // A box page ends before a record that would take it over its size; a record near the size on its own comes alone.
      if(whole&&items.length&&size+length>budget){last=previous;full=true;break;}
      size+=length;items.push(entry);
    }
    const linked=whole||principal.admin?[]:await this.pageLinksOrNone(principal,binding,items,shown);
    const more=full||rows.length>200;
    const position=(await this.stores.archive.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE $4::bigint IS NOT NULL AND (e.micros,e.id)<=($4::bigint,$5))::integer AS through ${records}`,
      [scopes,from,to,last?.micros??after?.micros??null,last?.id??after?.id??''])).rows[0];
    if(binding){for(const id of [...shown,...linked])await this.permitted(principal,id,binding);await this.audience.assert(principal);}
    const result={chat,items,next:more&&last?last.micros+'-'+last.id:null,position:{through:position.through,total:position.total},complete:!more,...(whole?{checking}:{})};
    // A box copy fills the box; what box tools return from it is checked as tool output. Its pages are not kept as prepared values,
    // which every later model call of the job would load.
    if(!whole)await this.allowPrepared(principal,result);return result;
  }
  /** pageLinks, which never fails the page: when it cannot be worked out, the page reads as it did before, without
   *  `owner` or `reply_source`, and the failure is counted as a `source_tags` problem. A guard binding that moved on is
   *  the caller's to retry. */
  private async pageLinksOrNone(principal:Reader,binding:GuardBinding|null,items:Record<string,unknown>[],shown:readonly string[]):Promise<string[]> {
    try {return await this.pageLinks(principal,binding,items,shown);}
    catch(error) {
      if(bindingMoved(error))throw error;
      for(const item of items){delete item.owner;delete item.reply_source;}
      await countMemoryStep(this.stores.control,'source_tags',false);return [];
    }
  }
  /**
   * What a page adds for the agent (ADR-0261): `owner:true` on the owner's own typing (bucketOf, as a tag's by=owner), and
   * `reply_source` on a reply whose message is not on this page: an id that archive_read opens, from the archive's reply
   * relation within what the reader may see (relationAudience, then canRead). A reply to a forum topic's opening is no
   * reply and gets none. Returns the ids it links, to check again with the page.
   */
  private async pageLinks(principal:Reader,binding:GuardBinding|null,items:Record<string,unknown>[],shown:readonly string[]):Promise<string[]> {
    const id=(item:Record<string,unknown>)=>String(item.source).slice('nocheh:event:'.length);
    const classes=this.tags&&shown.length?await this.tags.notes.classesFor(shown):new Map();
    for(const item of items)if(classes.get(id(item))&&bucketOf(classes.get(id(item))!.class)==='owner')item.owner=true;
    const replying=items.filter(item=>item.reply_to!==undefined).map(id);
    if(!replying.length)return [];
    const targets=await this.access.relationships.replyTargets(replying,binding?this.relationAudience(principal):{kind:'owner'});
    const candidates=[...targets.values()].flat(),onPage=new Set(shown);
    const readable=binding?await this.access.readable(principal,candidates,binding):new Map(candidates.map(reference=>[reference.id,true]));
    const openings=await this.topicOpenings(candidates.map(reference=>reference.id));
    const linked:string[]=[];
    for(const item of items) {
      const found=targets.get(id(item))??[];
      if(!found.length||found.some(reference=>onPage.has(reference.id)||openings.has(reference.id)))continue;
      const target=found.find(reference=>readable.get(reference.id)===true);
      if(target){item.reply_source='nocheh:event:'+target.id;linked.push(target.id);}
    }
    return linked;
  }
  /**
   * What each of these messages replies to, for a turn's frame (ADR-0261): the first copy of its target the reader may
   * read (canRead, one batch for all of them), within the reader's conversations (relationAudience), with its tag; with
   * `text`, also that copy's text as this reader's own copy holds it. Targets come from the archive's reply relation in
   * one read for all the messages, or from `targets`, which a message's read() already returned. A forum topic's
   * opening is no reply: told by the target's own captured payload, and by the reply the message itself embeds, by a
   * field's presence alone. An unreadable, retired or never archived target gives nothing; so does one whose copy is
   * still being checked, when its text is asked for.
   */
  async repliedTo(principal:Reader,messages:readonly {id:string;payload:unknown;targets?:readonly SourceReference[]}[],options:{text?:boolean}={}):
    Promise<Map<string,Tag&{text?:string}>> {
    const found=new Map<string,Tag&{text?:string}>();
    if(principal.admin||!principal.turnEvent||!this.tags)return found;
    const binding=await this.audience.assert(principal);
    const replying=messages.filter(message=>!telegramTopicOpening((telegramMessage(message.payload) as {reply_to_message?:unknown}|null)?.reply_to_message));
    const asked=replying.filter(message=>!message.targets).map(message=>message.id);
    const looked=asked.length?await this.access.relationships.replyTargets(asked,this.relationAudience(principal)):new Map<string,SourceReference[]>();
    const targets=new Map(replying.map(message=>[message.id,(message.targets??looked.get(message.id)??[]).filter(target=>target.id!==message.id)]));
    const candidates=[...targets.values()].flat();
    if(!candidates.length)return found;
    const [openings,open]=await Promise.all([this.topicOpenings(candidates.map(target=>target.id)),this.access.readable(principal,candidates,binding)]);
    const chosen=new Map<string,SourceReference>();
    for(const [id,list] of targets) {
      // Every copy of an opening is one: a message replying to it replies to no message.
      if(list.some(target=>openings.has(target.id)))continue;
      const target=list.find(item=>open.get(item.id)===true);if(target)chosen.set(id,target);
    }
    const copies=new Map<string,{text:string;payload:unknown}|null>();
    if(options.text)for(const target of chosen.values())if(!copies.has(target.id))copies.set(target.id,await this.shownCopy(target.id,binding));
    const shown=new Map<string,unknown>([...copies].filter(([,copy])=>copy).map(([id,copy])=>[id,copy!.payload]));
    const wanted=[...chosen.values()].filter(target=>!options.text||copies.get(target.id));
    const tags=wanted.length?await this.tags.tags(principal,binding,wanted,{shown}):new Map();
    for(const [id,target] of chosen) {
      const tag=tags.get(target.id),copy=copies.get(target.id);
      if(!tag||options.text&&!copy)continue;
      found.set(id,{source:tag.source,tag:tag.tag,by:tag.by,at:tag.at,...(options.text?{text:copy!.text}:{})});
    }
    return found;
  }
  /** Which of these events are a forum topic's opening (telegramTopicOpening), told by a field's presence alone. */
  private async topicOpenings(ids:readonly string[]):Promise<Set<string>> {
    const wanted=[...new Set(ids)];if(!wanted.length)return new Set();
    const rows=(await this.stores.archive.query('SELECT id,payload FROM events WHERE id=ANY($1::text[])',[wanted])).rows;
    return new Set(rows.filter(row=>{try{return telegramTopicOpening(telegramMessage(JSON.parse(row.payload.toString())));}catch{return false;}}).map(row=>row.id as string));
  }
  async bytes(principal:Reader,id:string):Promise<Buffer> {
    const binding=principal.admin?null:await this.audience.assert(principal);
    if(binding?.mode==='on')throw new HttpError(403,'original_file_requires_owner');
    const file=await this.attachments.file(id);await this.permitted(principal,file.event.id,binding);
    // A bound reader reads text, transcripts and extracted text; the only original files it opens are its own turn's
    // (an answer's /start, a member's own message, and that message's album), the way the turn's files reach it
    // (ADR-0249, step 4).
    if(boundReader(principal)!==null&&![principal.turnEvent,...(principal.turnEvent?(await albumMembers(this.stores.archive,principal.turnEvent)).map(member=>member.id):[])]
      .includes(file.event.id))throw new HttpError(403,'original_file_requires_owner');
    const bytes=await this.attachments.bytes(file);if(binding)await this.audience.assert(principal);return bytes;
  }

  async graph(principal:Reader,scope:string,after='',count=20,focus='') {
    admin(principal);string(scope,256);limit(count);if(!scope)throw new HttpError(400,'graph_scope_required');
    for(const cursor of [after,focus])if(cursor&&!/^[a-f0-9]{64}$/.test(cursor))throw new HttpError(400,'invalid_graph_cursor');
    const candidates=(await this.stores.archive.query(`SELECT e.id FROM events e
      JOIN source_observations s ON s.event_id=e.id JOIN source_revisions r ON r.id=s.revision_id
      JOIN source_objects o ON o.id=r.object_id
      WHERE o.kind='message' AND e.origin<>'generated' AND e.id>$1 AND ($2='' OR e.id=$2) ORDER BY e.id LIMIT 201`,[after,focus])).rows;
    const nodes:any[]=scope==='*'?[{id:'collection:*',kind:'collection',label:'All private knowledge'}]:[{id:'group:'+scope,kind:'group',label:scope}],edges:any[]=[],selected:string[]=[],spaces=new Set<string>(),payloads=new Map<string,unknown>();
    const add=(node:any,fallback?:string)=>{const current=nodes.find(n=>n.id===node.id);if(!current)nodes.push(node);else {
      if(fallback&&current.label===fallback&&node.label!==fallback)current.label=node.label;
      if(node.chat_type&&!current.chat_type)current.chat_type=node.chat_type;
    }};
    const link=(from:string,to:string,kind:string)=>{if(!edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))edges.push({from,to,kind});};
    const allowed=async(id:string)=>scope==='*'||await this.access.space((await this.access.archive.captured(id)).reference)===scope;
    const addEvent=async(id:string)=>{
      const row=(await this.stores.archive.query(`SELECT e.id,e.scope,e.source_id,e.kind,e.origin,e.search_text,e.payload,o.kind AS object_kind FROM events e
        JOIN source_observations s ON s.event_id=e.id JOIN source_revisions r ON r.id=s.revision_id
        JOIN source_objects o ON o.id=r.object_id WHERE e.id=$1`,[id])).rows[0];
      if(!row||row.object_kind!=='message'||row.origin==='generated')return false;
      const space=await this.access.space((await this.access.archive.captured(id)).reference)??row.scope,chatType=graphChatType(row.payload,space);
      payloads.set(id,row.payload);spaces.add(space);add({id:'group:'+space,kind:'group',label:graphGroupLabel(row.payload,space)??space,...(chatType?{chat_type:chatType}:{})},space);if(scope==='*')link('collection:*','group:'+space,'contains');
      add({id:'message:'+id,kind:'message',label:evidenceNodeLabel(row.search_text.slice(0,160),row.kind,id),event_id:id,source_id:row.source_id});
      link('group:'+space,'message:'+id,'contains');return true;
    };
    let cursor=after,hasMore=candidates.length>200,unresolved=0,truncated=false;
    for(const candidate of candidates.slice(0,200)) {
      if(!await allowed(candidate.id)){cursor=candidate.id;continue;}
      if(selected.length===count){hasMore=true;break;}
      cursor=candidate.id;if(await addEvent(candidate.id))selected.push(candidate.id);
    }
    for(const id of selected) {
      const source=(await this.access.archive.captured(id)).reference,context=await this.access.relationships.context(source,{kind:'owner'},5);
      for(const target of context.targets) {
        if(target.unresolved)unresolved++;if(target.next)truncated=true;
        for(const reference of target.references) {
          if(nodes.length>=250){truncated=true;break;}
          if(!await allowed(reference.id)||!await addEvent(reference.id))continue;
          link('message:'+id,'message:'+reference.id,target.kind==='reply_to'?'reply_to_source':target.kind);
        }
      }
      const authors=(await this.stores.archive.query(`SELECT o.id,o.external_id FROM source_relations r JOIN source_objects o ON o.id=r.target_id
        WHERE r.event_id=$1 AND r.kind='authored_by' ORDER BY o.id LIMIT 20`,[id])).rows;
      for(const author of authors) {
        if(nodes.length>=250){truncated=true;break;}
        add({id:'user:'+author.id,kind:'user',label:graphUserLabel(payloads.get(id),author.external_id)??author.external_id},author.external_id);link('user:'+author.id,'message:'+id,'authored');
      }
    }
    const projects=new ProjectRepository(this.stores.control);
    for(const space of spaces) {
      const project=(await projects.effective(space)).project;if(!project)continue;
      if(nodes.length>=250){truncated=true;break;}
      add({id:'project:'+project.id,kind:'project',label:project.name,state:project.state});
      link('project:'+project.id,'group:'+space,'project_context');
    }
    return {format:'nocheh-context-graph-v1',scope,nodes,edges,next:hasMore?cursor:null,
      bounds:{messages:count,groups:spaces.size,users:nodes.filter(node=>node.kind==='user').length,
        projects:nodes.filter(node=>node.kind==='project').length,truncated},unresolved_replies:unresolved,
      note:'Context entities only: users, projects, groups or private chats, and original messages. Actions, events, files, runtime context, and generated artifacts are excluded.'};
  }
}
