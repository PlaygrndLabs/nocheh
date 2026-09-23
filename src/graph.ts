import type pg from 'pg';
import type { Reader } from './access.js';
import {assertAudience} from './access.js';
import {parentSpace} from './spaces.js';
import { HttpError, string } from './http.js';
import { limit } from './retrieval.js';
import {evidenceNodeLabel,graphChatType,graphGroupLabel,graphUserLabel,type GraphChatType} from './graph-labels.js';

type Node = {id:string; kind:'collection'|'group'|'user'|'message'; label:string; chat_type?:GraphChatType; event_id?:string; source_id?:string};
type Edge = {from:string; to:string; kind:string};
export async function evidenceGraph(pool:pg.Pool, principal:Reader, scope:string, after='', count=20, focus='') {
  await assertAudience(pool,principal);
  string(scope,256); limit(count,20,50);
  if (!scope || (principal.scope!==null && (principal.space??principal.scope)!==scope)) throw new HttpError(403,'graph_scope_denied');
  for(const id of [after,focus]) if(id && !/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400,'invalid_graph_cursor');
  const {rows}=await pool.query<{id:string;source_id:string;object_id:string;object_kind:string;event_kind:string;text:string;scope:string;space_id:string;payload:Buffer}>(
    `SELECT e.id,e.source_id,e.kind AS event_kind,o.id AS object_id,o.kind AS object_kind,left(e.search_text,160) AS text,e.scope,e.payload,
     (SELECT space_id FROM event_spaces WHERE event_id=e.id) AS space_id FROM events e
     JOIN source_observations s ON s.event_id=e.id JOIN source_revisions r ON r.id=s.revision_id JOIN source_objects o ON o.id=r.object_id
     WHERE o.kind='message' AND ($1='*' OR e.scope=$1) AND e.origin<>'generated' AND e.id>$2 AND ($3='' OR e.id=$3)
     AND ($5::text IS NULL OR e.id IN(SELECT event_id FROM event_spaces WHERE space_id=$5)) ORDER BY e.id LIMIT $4`,[parentSpace(scope)??scope,after,focus,count+1,principal.space??(parentSpace(scope)?scope:null)]);
  const events=rows.slice(0,count),ids=events.map(e=>e.id);
  const nodes:Node[]=scope==='*'?[{id:'collection:*',kind:'collection',label:'All private knowledge'}]:[{id:'group:'+scope,kind:'group',label:scope}],edges:Edge[]=[];
  const add=(node:Node,fallback?:string)=>{const current=nodes.find(n=>n.id===node.id);if(!current)nodes.push(node);else {
    if(fallback&&current.label===fallback&&node.label!==fallback)current.label=node.label;
    if(node.chat_type&&!current.chat_type)current.chat_type=node.chat_type;
  }};
  const link=(from:string,to:string,kind:string)=>{if(!edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))edges.push({from,to,kind});};
  const sources=new Map<string,string[]>();
  for(const event of events)sources.set(event.object_id,[...(sources.get(event.object_id)||[]),event.id]);
  const relations=await pool.query<{event_id:string;kind:string;target_id:string;external_id:string}>(`SELECT r.event_id,r.kind,r.target_id,o.external_id
    FROM source_relations r JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=ANY($1::text[]) ORDER BY r.event_id,r.kind,r.target_id`,[ids]);
  let unresolvedReplies=0;
  for(const event of events){
    const ownScope=scope==='*'?event.space_id:scope,chatType=graphChatType(event.payload,ownScope);
    add({id:'group:'+ownScope,kind:'group',label:graphGroupLabel(event.payload,ownScope)??ownScope,...(chatType?{chat_type:chatType}:{})},ownScope);
    if(scope==='*')link('collection:*','group:'+ownScope,'contains');
    const id='message:'+event.id;
    add({id,kind:'message',label:evidenceNodeLabel(event.text,event.event_kind,event.id),event_id:event.id,source_id:event.source_id});link('group:'+ownScope,id,'contains');
    for(const relation of relations.rows.filter(r=>r.event_id===event.id)) {
      if(relation.kind==='authored_by') {
        const authorId='user:'+ownScope+':'+relation.target_id;
        add({id:authorId,kind:'user',label:graphUserLabel(event.payload,relation.external_id)??relation.external_id},relation.external_id);link(authorId,id,'authored');continue;
      }
      // Resolve only against this already-authorized page. A foreign key is not access.
      const targets=sources.get(relation.target_id);
      if(!targets){if(relation.kind==='reply_to')unresolvedReplies++;continue;}
      for(const target of targets)link(id,'message:'+target,relation.kind==='reply_to'?'reply_to_source':relation.kind);
    }
  }
  for(const revisions of sources.values())if(revisions.length>1){
    // Same original source identity, with no inferred temporal ordering.
    for(const id of revisions.slice(1))link('message:'+revisions[0],'message:'+id,'same_source_revision');
  }
  await assertAudience(pool,principal);
  return {format:'nocheh-context-graph-v1',scope,nodes,edges,next:rows.length>count?events.at(-1)?.id:null,
    bounds:{messages:count,groups:nodes.filter(node=>node.kind==='group').length,users:nodes.filter(node=>node.kind==='user').length,projects:0,truncated:false},
    unresolved_replies:unresolvedReplies,note:'Context entities only: users, projects, groups or private chats, and original messages. Actions, events, files, runtime context, and generated artifacts are excluded.'};
}
