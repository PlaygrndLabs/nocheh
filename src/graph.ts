import type pg from 'pg';
import type { Reader } from './access.js';
import {assertAudience} from './access.js';
import {parentSpace} from './spaces.js';
import { HttpError, string } from './http.js';
import { limit } from './retrieval.js';

type Node = {id:string; kind:string; label:string; event_id?:string; source_id?:string; state?:string; provenance?:unknown};
type Edge = {from:string; to:string; kind:string};
export async function evidenceGraph(pool:pg.Pool, principal:Reader, scope:string, after='', count=20, focus='') {
  await assertAudience(pool,principal);
  string(scope,256); limit(count,20,50);
  if (!scope || (principal.scope!==null && (principal.space??principal.scope)!==scope)) throw new HttpError(403,'graph_scope_denied');
  for(const id of [after,focus]) if(id && !/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400,'invalid_graph_cursor');
  const {rows}=await pool.query<{id:string;source_id:string;bot_id:string;revision:string;payload:Buffer;text:string;scope:string;space_id:string}>(
    `SELECT id,source_id,bot_id,revision,payload,left(search_text,160) AS text,scope,
     (SELECT space_id FROM event_spaces WHERE event_id=events.id) AS space_id FROM events
     WHERE ($1='*' OR scope=$1) AND ($6::boolean OR origin<>'generated') AND id>$2 AND ($3='' OR id=$3) AND ($5::text IS NULL OR id IN(SELECT event_id FROM event_spaces WHERE space_id=$5)) ORDER BY id LIMIT $4`,[parentSpace(scope)??scope,after,focus,count+1,principal.space??(parentSpace(scope)?scope:null),principal.scope===null]);
  const events=rows.slice(0,count).map(event=>{
    const payload=JSON.parse(event.payload.toString());const message=payload.message||payload.edited_message||payload.channel_post||payload.edited_channel_post||{};
    const chat=payload.chat||message.chat||{};
    return {...event,message,namespace:JSON.stringify([event.bot_id,chat.type??'unknown',String(chat.id??event.scope)])};
  }), ids=events.map(e=>e.id);
  const nodes:Node[]=[{id:'scope:'+scope,kind:'scope',label:scope==='*'?'All private knowledge':scope}],edges:Edge[]=[];
  const add=(node:Node)=>{if(!nodes.some(n=>n.id===node.id))nodes.push(node);};
  const link=(from:string,to:string,kind:string)=>{if(!edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))edges.push({from,to,kind});};
  const sources=new Map<string,string[]>();
  for(const event of events){const key=event.namespace+':'+event.source_id;sources.set(key,[...(sources.get(key)||[]),event.id]);}
  let unresolvedReplies=0;
  for(const event of events){
    const ownScope=scope==='*'?event.space_id:scope;
    if(scope==='*'){add({id:'scope:'+ownScope,kind:'scope',label:ownScope});link('scope:*','scope:'+ownScope,'contains');}
    const id='event:'+event.id;
    add({id,kind:'message',label:event.text||'(message without text)',event_id:event.id,source_id:event.source_id});link('scope:'+ownScope,id,'contains');
    const message=event.message;
    const author=message.from?.id??message.sender_chat?.id??message.from_id;
    if(author!==undefined&&author!==null){const authorId='author:'+scope+':'+event.bot_id+':'+String(author);add({id:authorId,kind:'author',label:String(author)});link(authorId,id,'authored');}
    const reply=message.reply_to_message?.message_id??message.reply_to_message_id;
    if(reply!==undefined&&reply!==null){const targets=sources.get(event.namespace+':'+String(reply));if(!targets)unresolvedReplies++;else for(const target of targets)link(id,'event:'+target,'reply_to_source');}
  }
  for(const revisions of sources.values())if(revisions.length>1){
    // Same original source identity, with no inferred temporal ordering.
    for(const id of revisions.slice(1))link('event:'+revisions[0],'event:'+id,'same_source_revision');
  }
  const artifacts=await pool.query<{id:string;event_id:string;kind:string;state:string}>(
    'SELECT id,event_id,kind,state FROM artifacts WHERE event_id=ANY($1::text[]) ORDER BY id LIMIT 201',[ids]);
  for(const artifact of artifacts.rows.slice(0,200)){add({id:'artifact:'+artifact.id,kind:'attachment',label:artifact.kind,event_id:artifact.event_id,state:artifact.state});link('event:'+artifact.event_id,'artifact:'+artifact.id,'attachment');}
  const derived=await pool.query<{id:string;event_id:string;artifact_id:string|null;kind:string;provenance:unknown}>(
    'SELECT id,event_id,artifact_id,kind,provenance FROM derived_artifacts WHERE event_id=ANY($1::text[]) ORDER BY id LIMIT 201',[ids]);
  for(const item of derived.rows.slice(0,200)){add({id:'derived:'+item.id,kind:'derived',label:item.kind,event_id:item.event_id,provenance:item.provenance});
    const parent=item.artifact_id?'artifact:'+item.artifact_id:'event:'+item.event_id;
    if(nodes.some(n=>n.id===parent))link(parent,'derived:'+item.id,'derived_from');}
  await assertAudience(pool,principal);
  return {format:'nocheh-evidence-graph-v1',scope,nodes,edges,next:rows.length>count?events.at(-1)?.id:null,
    bounds:{messages:count,attachments:200,derived:200,truncated:artifacts.rows.length>200||derived.rows.length>200},
    unresolved_replies:unresolvedReplies,note:'Observed relationships within this page. Native note citations are references, not verified claims.'};
}
