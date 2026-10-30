import {admin,type Reader} from '../access.js';
import {HttpError,string} from '../http.js';
import {matchesArchiveFilters,type ArchiveFilters} from '../archive-filters.js';
import {actionReviews} from '../action-review-summary.js';
import {sourceContentTypes} from '../source-content.js';
import {reactionPreview} from '../reaction-preview.js';
import {reactionObservation} from '../reaction-observation.js';
import {limit} from '../retrieval.js';
import {type Envelope} from '../archive.js';
import {SourceAccessRepository} from './access.js';
import {AudienceRepository} from './audience.js';
import {AttachmentRepository} from './attachments.js';
import {SelectionRepository} from './selections.js';
import type {SourceReference} from './archive.js';
import type {GuardBinding} from './guards.js';
import {evidenceNodeLabel,graphChatType,graphGroupLabel,graphUserLabel} from '../graph-labels.js';
import {ProjectRepository} from './projects.js';
import type {RelationshipAudience} from './relationships.js';
import {archiveReplyPreviews} from './archive-reply-links.js';
import {archiveTranscriptPreviews} from './archive-transcript-previews.js';
import {agentCopies,messageSender} from './archive-row-details.js';
import {PAGE_BUDGET,cursor,pageDate,pageEntry,pageItem} from '../conversation-page.js';
import {parentSpace} from '../spaces.js';

const pending=(error:unknown)=>error instanceof HttpError&&error.code==='guard_preparation_pending';

/** Embedded reply snapshots never substitute for an independently authorized target. */
export function scopedObservation(value:unknown):any {
  const result=structuredClone(value) as any;
  for(const kind of ['message','edited_message','channel_post','edited_channel_post'])if(result.payload?.[kind]) {
    delete result.payload[kind].reply_to_message;delete result.payload[kind].external_reply;
  }
  return result;
}
export class SourceRepository {
  readonly audience:AudienceRepository;
  constructor(readonly access:SourceAccessRepository,readonly attachments:AttachmentRepository,readonly selections:SelectionRepository,
    readonly allowPrepared:(principal:Reader,value:unknown)=>Promise<void>=async()=>{}) {
    this.audience=new AudienceRepository(access.guards);
  }
  private get stores(){return this.access.stores;}
  /** Relations are shown within the conversations the principal recalls. */
  private relationAudience(principal:Reader):RelationshipAudience {
    const scope=this.access.recall(principal);
    return scope?{kind:'conversation',chat_id:principal.scope!,topic_id:scope.space.includes('/topic/')?scope.space.split('/topic/')[1]!:null,group:scope.group!==null}:{kind:'owner'};
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
  async currentReactions(principal:Reader,count=5) {
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
  async read(principal:Reader,id:string) {
    const binding=principal.admin?null:await this.audience.assert(principal),reference=await this.permitted(principal,id,binding);
    const row=(await this.stores.archive.query('SELECT * FROM events WHERE id=$1',[id])).rows[0];
    let content:any={text:row.original_text?.toString()??null,payload:JSON.parse(row.payload.toString())},guardedRevision:number|null=null;
    if(binding?.mode==='on') {
      const guarded=await this.access.guards.read('events:'+id,binding);content=scopedObservation(guarded.value);guardedRevision=guarded.revision;
    }
    else if(binding)content=scopedObservation(content);
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

  /** Archive search deliberately excludes transcripts, contexts and learned results. */
  async search(principal:Reader,query:string,count=20,filters:ArchiveFilters={kind:'',scope:'',reply:''}) {
    string(query,2000);limit(count);if(!query.trim())throw new HttpError(400,'empty_query');
    const binding=principal.admin?null:await this.audience.assert(principal);
    const rows=await (binding?.mode==='on'?this.stores.derived.query(`SELECT s.event_id AS id,r.content FROM guard_sources s
      JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision
      WHERE s.kind='events' AND s.state='ready' AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1)
      ORDER BY ts_rank(to_tsvector('simple',r.search_text),plainto_tsquery('simple',$1)) DESC,s.id LIMIT 200`,[query]):
      this.stores.archive.query(`SELECT id FROM events WHERE to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1)
        ORDER BY ts_rank(to_tsvector('simple',search_text),plainto_tsquery('simple',$1)) DESC,id LIMIT 200`,[query]));
    const stateRows=principal.admin&&rows.rows.length?(await this.stores.control.query('SELECT event_id,state FROM dispatches WHERE event_id=ANY($1::text[])',[rows.rows.map(row=>row.id)])).rows:[];
    const states=new Map(stateRows.map(row=>[row.event_id,row.state]));
    const reviews=principal.admin?await actionReviews(this.stores.control,rows.rows.map(row=>row.id),'separated'):new Map();
    // An exported copy of a message the bot also captured live is the same message; the owner sees it marked, the agent once.
    const liveCopies=await this.access.retirements?.liveCopies(rows.rows.map(row=>row.id))??new Set<string>();
    const hits:any[]=[];
    for(const candidate of rows.rows) {
      if(!principal.admin&&liveCopies.has(candidate.id))continue;
      const reference=(await this.access.archive.captured(candidate.id)).reference;
      if(binding&&!await this.access.canRead(principal,reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT scope,source_id,revision,kind,origin,occurred_at,original_text,payload FROM events WHERE id=$1',[reference.id])).rows[0];
      if(!matchesArchiveFilters(original,states.get(reference.id),filters,reviews.get(reference.id)?.state))continue;
      const value=binding?.mode==='on'?scopedObservation((await this.access.guards.read('events:'+reference.id,binding)).value):{text:original.original_text?.toString()??''};
      // The lexical index includes payload metadata, but a scoped hit must also
      // match the independent message text, never a stripped reply snapshot.
      const text=String(value.text??'');
      if(binding&&!(await this.stores.derived.query("SELECT to_tsvector('simple',$1) @@ plainto_tsquery('simple',$2) AS matches",[text,query])).rows[0].matches)continue;
      const artifactKinds=principal.admin?(await this.stores.archive.query('SELECT kind FROM artifacts WHERE event_id=$1 ORDER BY id',[reference.id])).rows.map(row=>row.kind as string):[];
      const {payload,...fields}=original;
      hits.push({id:reference.id,source:'nocheh:event:'+reference.id,...fields,...(states.has(reference.id)?{assistant_state:states.get(reference.id)}:{}),...(reviews.has(reference.id)?{action_review:reviews.get(reference.id)}:{}),original_text:undefined,representation:binding?.mode==='on'?'guarded':'original',
        derived_id:null,text:text.slice(0,2000),truncated:text.length>2000,
        content_types:sourceContentTypes(original.kind,binding?.mode==='on'?(value as {payload?:unknown}).payload:JSON.parse(payload.toString()),artifactKinds),
        ...(principal.admin?{reaction_preview:reactionPreview(original.kind,JSON.parse(payload.toString())),sender:messageSender(original.kind,JSON.parse(payload.toString())),
          ...(liveCopies.has(reference.id)?{live_copy:true}:{})}:{})});
      if(hits.length===count)break;
    }
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
  /** Messages another index found, such as memory search by meaning, read back through the reader's own access. */
  async found(principal:Reader,ids:string[],count:number) {
    const binding=principal.admin?null:await this.audience.assert(principal);
    const liveCopies=await this.access.retirements?.liveCopies(ids)??new Set<string>();
    const hits:{source:string;scope:string;kind:string;occurred_at:string|null;text:string;truncated?:true}[]=[];
    for(const id of ids) {
      if(hits.length===count)break;
      if(!principal.admin&&liveCopies.has(id))continue;
      const captured=await this.access.archive.captured(id).catch(()=>null);
      if(!captured||binding&&!await this.access.canRead(principal,captured.reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT occurred_at,original_text FROM events WHERE id=$1',[id])).rows[0];
      let text=original.original_text?.toString()??'';
      if(binding?.mode==='on') {
        const guarded=await this.access.guards.read('events:'+id,binding).catch(error=>{if(pending(error))return null;throw error;});
        if(!guarded)continue;
        text=String(scopedObservation(guarded.value).text??'');
      }
      hits.push({source:'nocheh:event:'+id,scope:captured.scope,kind:captured.kind,occurred_at:original.occurred_at,text:text.slice(0,2000),...(text.length>2000?{truncated:true as const}:{})});
    }
    if(binding){for(const hit of hits)await this.permitted(principal,hit.source.slice(13),binding);await this.audience.assert(principal);}
    await this.allowPrepared(principal,hits);return hits;
  }
  /** A conversation in time order, one page at a time, with only what the reader may read.
   * The owner may name any chat; anyone else reads the chat they are in. */
  async page(principal:Reader,input:{chat:string;from:string;to:string;after:string;count:number}) {
    string(input.chat,256);
    const from=pageDate(input.from),to=pageDate(input.to,true),after=cursor(input.after);
    const binding=principal.admin?null:await this.audience.assert(principal),owner=principal.admin||principal.scope===null;
    if(!owner&&input.chat&&input.chat!==principal.scope)throw new HttpError(403,'conversation_not_permitted');
    // A topic is read with the rest of its group, as a group reader reads it.
    const space=principal.space?parentSpace(principal.space)??principal.space:null;
    const chat=owner?input.chat||(principal.admin?'':space??this.access.policy().owner_id):principal.scope!;
    if(!chat)throw new HttpError(400,'conversation_required');
    // Telegram gives a message's own time; an assistant reply has only the time it was saved.
    const records=`FROM (SELECT id,kind,at,(extract(epoch FROM at)*1000000)::bigint AS micros FROM (SELECT id,kind,
      CASE WHEN occurred_at ~ '^[0-9]{1,12}$' THEN to_timestamp(occurred_at::bigint) ELSE received_at END AS at FROM events
      WHERE scope=$1 AND origin<>'generated' AND kind NOT IN ('telegram_wire','import_manifest')) a) e
      WHERE ($2::timestamptz IS NULL OR e.at>=$2) AND ($3::timestamptz IS NULL OR e.at<$3)`;
    const rows=(await this.stores.archive.query(`SELECT id,kind,at,micros ${records} AND ($4::bigint IS NULL OR (e.micros,e.id)>($4::bigint,$5))
      ORDER BY e.micros,e.id LIMIT 201`,[chat,from,to,after?.micros??null,after?.id??''])).rows;
    const liveCopies=principal.admin?new Set<string>():await this.access.retirements?.liveCopies(rows.map(row=>row.id))??new Set<string>();
    const items:Record<string,unknown>[]=[],shown:string[]=[];let last:{micros:string;id:string}|null=null,size=0,full=false;
    for(const row of rows.slice(0,200)) {
      if(items.length===input.count||size>=PAGE_BUDGET){full=true;break;}
      last=row;
      if(liveCopies.has(row.id))continue;
      const captured=await this.access.archive.captured(row.id);
      if(binding&&!await this.access.canRead(principal,captured.reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[row.id])).rows[0];
      let value:any={text:original.original_text?.toString()??'',payload:JSON.parse(original.payload.toString())};
      const type=pageEntry(row.kind,value.payload);
      if(!type)continue;
      shown.push(row.id);
      if(binding?.mode==='on') {
        const guarded=await this.access.guards.read('events:'+row.id,binding).catch(error=>{if(pending(error))return null;throw error;});
        if(!guarded){items.push({source:'nocheh:event:'+row.id,at:row.at.toISOString(),type,checking:true});continue;}
        value=guarded.value;
      }
      const files=captured.artifact_ids.length?await this.derivedTexts(row.id,binding).catch(error=>{if(pending(error))return null;throw error;}):[];
      const item=pageItem({id:row.id,kind:row.kind,at:row.at,payload:value.payload,text:String(value.text??''),files:files??[]});
      const entry=files===null?{...item,files_checking:true}:item;
      size+=JSON.stringify(entry).length;items.push(entry);
    }
    const more=full||rows.length>200;
    const position=(await this.stores.archive.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE $4::bigint IS NOT NULL AND (e.micros,e.id)<=($4::bigint,$5))::integer AS through ${records}`,
      [chat,from,to,last?.micros??after?.micros??null,last?.id??after?.id??''])).rows[0];
    if(binding){for(const id of shown)await this.permitted(principal,id,binding);await this.audience.assert(principal);}
    const result={chat,items,next:more&&last?last.micros+'-'+last.id:null,position:{through:position.through,total:position.total},complete:!more};
    await this.allowPrepared(principal,result);return result;
  }
  async bytes(principal:Reader,id:string):Promise<Buffer> {
    const binding=principal.admin?null:await this.audience.assert(principal);
    if(binding?.mode==='on')throw new HttpError(403,'original_file_requires_owner');
    const file=await this.attachments.file(id);await this.permitted(principal,file.event.id,binding);
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
