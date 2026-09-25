import {admin,type Reader} from '../access.js';
import {HttpError,string} from '../http.js';
import {matchesArchiveFilters,type ArchiveFilters} from '../archive-filters.js';
import {actionReviews} from '../action-review-summary.js';
import {sourceContentTypes} from '../source-content.js';
import {reactionPreview} from '../reaction-preview.js';
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
import {archiveReplyPreviews} from './archive-reply-links.js';
import {archiveTranscriptPreviews} from './archive-transcript-previews.js';

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
    const selected=(await this.stores.derived.query(`SELECT s.artifact_id,s.kind,r.derived_id,d.content,d.provenance FROM derivative_selections s
      JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
      JOIN derived_artifacts d ON d.id=r.derived_id WHERE s.event_id=$1 AND s.kind IN ('transcript','extracted_text','extraction_status') ORDER BY s.id`,[id])).rows;
    const derived=[];
    for(const item of selected) {
      const value=binding?(await this.selections.current(id,item.artifact_id,item.kind,binding)).value as any:{text:item.content.toString(),kind:item.kind,provenance:item.provenance};
      derived.push({id:item.derived_id,event_id:id,artifact_id:item.artifact_id,kind:value.kind,representation:binding?.mode==='on'?'guarded':'derived',
        content_base64:Buffer.from(value.text).toString('base64'),provenance:value.provenance,source:'nocheh:derivative:'+item.derived_id});
    }
    const relationships=await this.access.relationships.context(reference,binding&&principal.scope!==null?{
      kind:'conversation',chat_id:principal.scope,topic_id:principal.space?.includes('/topic/')?principal.space.split('/topic/')[1]!:null}:{kind:'owner'},20);
    if(binding){await this.permitted(principal,id,binding);await this.audience.assert(principal);}
    const result={id,source:'nocheh:event:'+id,reference,received_at:row.received_at.toISOString(),representation:binding?.mode==='on'?'guarded':'original',
      guarded_revision:guardedRevision,event,artifacts,derived,relationships,derivative_versions:'/v1/sources/'+id+'/derivatives'};
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
    const hits:any[]=[];
    for(const candidate of rows.rows) {
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
        ...(principal.admin?{reaction_preview:reactionPreview(original.kind,JSON.parse(payload.toString()))}:{})});
      if(hits.length===count)break;
    }
    if(binding){for(const hit of hits)await this.permitted(principal,hit.id,binding);await this.audience.assert(principal);}
    if(principal.admin){
      const retired=await this.access.retirements?.retiredEvents(hits.map(hit=>hit.id));
      for(const hit of hits)hit.retired=retired?.has(hit.id)??false;
      const [replies,transcripts]=await Promise.all([
        archiveReplyPreviews(this.stores.archive,this.stores.control,hits),archiveTranscriptPreviews(this.stores.derived,hits)]);
      for(const hit of hits){hit.reply_messages=replies.get(hit.id)??[];hit.transcript_preview=transcripts.get(hit.id)??null;}
    }
    await this.allowPrepared(principal,hits);return hits;
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
