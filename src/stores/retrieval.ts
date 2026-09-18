import {admin,type Reader} from '../access.js';
import {HttpError,string} from '../http.js';
import {limit} from '../retrieval.js';
import {type Envelope} from '../archive.js';
import {SourceAccessRepository} from './access.js';
import {AudienceRepository} from './audience.js';
import {AttachmentRepository} from './attachments.js';
import {SelectionRepository} from './selections.js';
import type {SourceReference} from './archive.js';
import type {GuardBinding} from './guards.js';

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
  constructor(readonly access:SourceAccessRepository,readonly attachments:AttachmentRepository,readonly selections:SelectionRepository) {
    this.audience=new AudienceRepository(access.guards);
  }
  private get stores(){return this.access.stores;}
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
    return {id,source:'nocheh:event:'+id,reference,received_at:row.received_at.toISOString(),representation:binding?.mode==='on'?'guarded':'original',
      guarded_revision:guardedRevision,event,artifacts,derived,relationships,derivative_versions:'/v1/sources/'+id+'/derivatives'};
  }

  /** Archive search deliberately excludes transcripts, contexts and learned results. */
  async search(principal:Reader,query:string,count=20) {
    string(query,2000);limit(count);if(!query.trim())throw new HttpError(400,'empty_query');
    const binding=principal.admin?null:await this.audience.assert(principal);
    const rows=await (binding?.mode==='on'?this.stores.derived.query(`SELECT s.event_id AS id,r.content FROM guard_sources s
      JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision
      WHERE s.kind='events' AND s.state='ready' AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1)
      ORDER BY ts_rank(to_tsvector('simple',r.search_text),plainto_tsquery('simple',$1)) DESC,s.id LIMIT 200`,[query]):
      this.stores.archive.query(`SELECT id FROM events WHERE to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1)
        ORDER BY ts_rank(to_tsvector('simple',search_text),plainto_tsquery('simple',$1)) DESC,id LIMIT 200`,[query]));
    const hits=[];
    for(const candidate of rows.rows) {
      const reference=(await this.access.archive.captured(candidate.id)).reference;
      if(binding&&!await this.access.canRead(principal,reference,binding))continue;
      const original=(await this.stores.archive.query('SELECT scope,source_id,revision,kind,origin,occurred_at,original_text FROM events WHERE id=$1',[reference.id])).rows[0];
      const value=binding?.mode==='on'?scopedObservation((await this.access.guards.read('events:'+reference.id,binding)).value):{text:original.original_text?.toString()??''};
      // The lexical index includes payload metadata, but a scoped hit must also
      // match the independent message text, never a stripped reply snapshot.
      const text=String(value.text??'');
      if(binding&&!(await this.stores.derived.query("SELECT to_tsvector('simple',$1) @@ plainto_tsquery('simple',$2) AS matches",[text,query])).rows[0].matches)continue;
      hits.push({id:reference.id,source:'nocheh:event:'+reference.id,...original,original_text:undefined,representation:binding?.mode==='on'?'guarded':'original',
        derived_id:null,text:text.slice(0,2000),truncated:text.length>2000});
      if(hits.length===count)break;
    }
    if(binding){for(const hit of hits)await this.permitted(principal,hit.id,binding);await this.audience.assert(principal);}return hits;
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
    const candidates=(await this.stores.archive.query(`SELECT id FROM events WHERE id>$1 AND ($2='' OR id=$2) ORDER BY id LIMIT 201`,[after,focus])).rows;
    const nodes:any[]=[{id:'scope:'+scope,kind:'scope',label:scope==='*'?'All private knowledge':scope}],edges:any[]=[],selected:string[]=[];
    const add=(node:any)=>{if(!nodes.some(n=>n.id===node.id))nodes.push(node);};
    const link=(from:string,to:string,kind:string)=>{if(!edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))edges.push({from,to,kind});};
    const allowed=async(id:string)=>scope==='*'||await this.access.space((await this.access.archive.captured(id)).reference)===scope;
    const addEvent=async(id:string)=>{
      const row=(await this.stores.archive.query('SELECT id,scope,source_id,kind,search_text FROM events WHERE id=$1',[id])).rows[0];
      const space=await this.access.space((await this.access.archive.captured(id)).reference)??row.scope;
      add({id:'scope:'+space,kind:'scope',label:space});if(scope==='*')link('scope:*','scope:'+space,'contains');
      add({id:'event:'+id,kind:'event',label:row.search_text.slice(0,160)||'(source without text)',event_id:id,source_id:row.source_id});
      link('scope:'+space,'event:'+id,'contains');
    };
    let cursor=after,hasMore=candidates.length>200,unresolved=0,truncated=false;
    for(const candidate of candidates.slice(0,200)) {
      if(!await allowed(candidate.id)){cursor=candidate.id;continue;}
      if(selected.length===count){hasMore=true;break;}
      cursor=candidate.id;selected.push(candidate.id);await addEvent(candidate.id);
    }
    for(const id of selected) {
      const source=(await this.access.archive.captured(id)).reference,context=await this.access.relationships.context(source,{kind:'owner'},5);
      for(const target of context.targets) {
        if(target.unresolved)unresolved++;if(target.next)truncated=true;
        for(const reference of target.references) {
          if(nodes.length>=250){truncated=true;break;}
          if(!await allowed(reference.id))continue;await addEvent(reference.id);
          link('event:'+id,'event:'+reference.id,target.kind==='reply_to'?'reply_to_source':target.kind);
        }
      }
      const authors=(await this.stores.archive.query(`SELECT o.id,o.external_id FROM source_relations r JOIN source_objects o ON o.id=r.target_id
        WHERE r.event_id=$1 AND r.kind='authored_by' ORDER BY o.id LIMIT 20`,[id])).rows;
      for(const author of authors) {
        if(nodes.length>=250){truncated=true;break;}
        add({id:'author:'+author.id,kind:'author',label:author.external_id});link('author:'+author.id,'event:'+id,'authored');
      }
      const files=(await this.stores.archive.query('SELECT id,kind,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id LIMIT 51',[id])).rows;
      if(files.length>50)truncated=true;
      for(const file of files.slice(0,50)) {
        if(nodes.length>=250){truncated=true;break;}
        add({id:'artifact:'+file.id,kind:'attachment',label:file.kind,event_id:id,state:file.file_hash?'ready':'pending'});
        link('event:'+id,'artifact:'+file.id,'attachment');
      }
    }
    return {format:'nocheh-evidence-graph-v1',scope,nodes,edges,next:hasMore?cursor:null,
      bounds:{messages:count,attachments:50,derived:0,truncated},unresolved_replies:unresolved,
      note:'Original evidence only. Reply and reaction targets are resolved independently of this page; derivatives are linked from source details.'};
  }
}
