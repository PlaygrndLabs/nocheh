import type pg from 'pg';
import {canonical, digest, type Envelope} from './archive.js';
import {HttpError, object, string} from './http.js';

/** External identity belongs to the source, never to an importer or local audience. */
export interface SourceIdentity {
  platform:string; namespace:string; kind:string; external_id:string;
}
export interface SourceRelation {
  kind:string; target:SourceIdentity; metadata?:Record<string,unknown>;
}
export interface SourceDescriptor {
  version:1;
  adapter:string; adapter_version:string;
  object:SourceIdentity;
  operation:string;
  completeness:'full'|'partial'|'unknown';
  relations:SourceRelation[];
  metadata?:Record<string,unknown>;
  provenance?:Record<string,unknown>;
}

export const sourceModelSchema=`
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_descriptor bytea;
CREATE TABLE IF NOT EXISTS source_model_migrations (
 version integer PRIMARY KEY,completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_objects (
 id text PRIMARY KEY,platform text NOT NULL,namespace text NOT NULL,
 kind text NOT NULL,external_id text NOT NULL,
 CHECK(platform<>'' AND namespace<>'' AND kind<>'' AND external_id<>''),
 UNIQUE(platform,namespace,kind,external_id)
);
CREATE TABLE IF NOT EXISTS source_revisions (
 id text PRIMARY KEY,object_id text NOT NULL REFERENCES source_objects(id),
 revision text NOT NULL CHECK(revision<>''),revision_hash text NOT NULL,
 UNIQUE(object_id,revision_hash)
);
CREATE TABLE IF NOT EXISTS source_observations (
 event_id text PRIMARY KEY REFERENCES events(id),
 revision_id text NOT NULL REFERENCES source_revisions(id),
 model_version integer NOT NULL CHECK(model_version=1),
 adapter text NOT NULL,adapter_version text NOT NULL,operation text NOT NULL,
 completeness text NOT NULL CHECK(completeness IN ('full','partial','unknown')),
 descriptor bytea NOT NULL,metadata jsonb NOT NULL,provenance jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS source_observations_revision ON source_observations(revision_id,event_id);
CREATE TABLE IF NOT EXISTS source_relations (
 event_id text NOT NULL REFERENCES source_observations(event_id),
 kind text NOT NULL CHECK(kind<>''),target_id text NOT NULL REFERENCES source_objects(id),
 metadata jsonb NOT NULL,PRIMARY KEY(event_id,kind,target_id)
);
CREATE INDEX IF NOT EXISTS source_relations_target ON source_relations(target_id,event_id);
`;

export function sourceLabel(value:unknown):string {
  const label=string(value,64);
  if(!/^[a-z][a-z0-9_.-]*$/.test(label))throw new HttpError(400,'invalid_source_label');
  return label;
}
const malformedUnicode=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function opaque(value:unknown):string {
  const id=string(value,1024);
  if(!id.length||Buffer.byteLength(id)>768||/[\x00-\x1f\x7f]/.test(id)||malformedUnicode.test(id))throw new HttpError(400,'invalid_source_identity');
  return id;
}
function keys(value:Record<string,unknown>,allowed:string[]) {
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw new HttpError(400,'unknown_source_field');
}
function identity(value:unknown):SourceIdentity {
  const v=object(value);keys(v,['platform','namespace','kind','external_id']);
  return {platform:sourceLabel(v.platform),namespace:opaque(v.namespace),kind:sourceLabel(v.kind),external_id:opaque(v.external_id)};
}
function metadata(value:unknown):Record<string,unknown> {
  const result=object(value),raw=JSON.stringify(result);
  // jsonb is an indexable extension, not the store for arbitrary original bytes.
  if(Buffer.byteLength(raw)>65536)throw new HttpError(400,'invalid_source_metadata');
  function validate(item:unknown,depth=0):void {
    if(depth>20)throw new HttpError(400,'invalid_source_metadata');
    if(typeof item==='string'&&(item.includes('\0')||malformedUnicode.test(item)))throw new HttpError(400,'invalid_source_metadata');
    if(item&&typeof item==='object')for(const [key,v] of Object.entries(item)){validate(key,depth+1);validate(v,depth+1);}
  }
  validate(result);
  return result;
}
export const sourceObjectId=(value:SourceIdentity):string=>digest(canonical([value.platform,value.namespace,value.kind,value.external_id]));

export function sourceDescriptor(value:unknown,channel?:string,sourceId?:string):SourceDescriptor {
  const v=object(value);
  keys(v,['version','adapter','adapter_version','object','operation','completeness','relations','metadata','provenance']);
  if(v.version!==1)throw new HttpError(400,'unsupported_source_version');
  const source=identity(v.object);
  if((channel!==undefined&&source.platform!==channel)||(sourceId!==undefined&&source.external_id!==sourceId))throw new HttpError(400,'source_identity_mismatch');
  if(!['full','partial','unknown'].includes(String(v.completeness)))throw new HttpError(400,'invalid_source_completeness');
  if(!Array.isArray(v.relations)||v.relations.length>100)throw new HttpError(400,'invalid_source_relations');
  const seen=new Set<string>();
  const relations=v.relations.map(raw=>{
    const r=object(raw);keys(r,['kind','target','metadata']);
    const kind=sourceLabel(r.kind),target=identity(r.target),key=canonical([kind,sourceObjectId(target)]);
    if(seen.has(key))throw new HttpError(400,'duplicate_source_relation');seen.add(key);
    return {kind,target,...(r.metadata===undefined?{}:{metadata:metadata(r.metadata)})};
  });
  const result:SourceDescriptor={version:1,adapter:sourceLabel(v.adapter),adapter_version:opaque(v.adapter_version),object:source,
    operation:sourceLabel(v.operation),completeness:v.completeness as SourceDescriptor['completeness'],relations,
    ...(v.metadata===undefined?{}:{metadata:metadata(v.metadata)}),...(v.provenance===undefined?{}:{provenance:metadata(v.provenance)})};
  if(Buffer.byteLength(canonical(result))>262144)throw new HttpError(400,'source_descriptor_too_large');
  return result;
}

const record=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
// Never coerce an unsafe numeric external ID: its original precision is unknown.
const external=(value:unknown):string|undefined=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=768&&!/[\x00-\x1f\x7f]/.test(value)&&!malformedUnicode.test(value)?value:
  typeof value==='number'&&Number.isSafeInteger(value)?String(value):undefined;

/** Frozen v1 projections for existing captures; originals and event hashes are untouched. */
export function legacySource(value:Envelope):SourceDescriptor {
  const platform=value.channel??'telegram',body=record(value.payload);
  const fallback:SourceDescriptor={version:1,adapter:'nocheh.legacy',adapter_version:'1',
    object:{platform,namespace:'legacy-observations',kind:'event',external_id:digest(value.key)},
    operation:'observation',completeness:'unknown',relations:[],provenance:{connector_id:value.bot_id}};
  if(platform==='telegram') {
    const raw=body.message??body.edited_message??body.channel_post??body.edited_channel_post;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return fallback;
    const message=record(raw),desktop=value.bot_id==='desktop-export'||value.kind.startsWith('telegram_desktop_');
    if(value.kind!=='telegram_update'&&!value.kind.startsWith('telegram_desktop_'))return fallback;
    const chat=record(body.chat??message.chat),chatId=external(chat.id)??external(value.scope);
    const messageId=external(value.source_id);
    if(!chatId||!messageId)return fallback;
    // Desktop and Bot API namespaces intentionally do not assert an unproven mapping.
    const authority=desktop?'desktop':'bot-api';
    const namespace=canonical([authority,desktop?external(chat.type)??'unknown':'chat',chatId]);
    const source:SourceIdentity={platform,namespace,kind:'message',external_id:messageId};
    const relations:SourceRelation[]=[{kind:'contained_in',target:{platform,namespace:authority,kind:'conversation',external_id:desktop?canonical([external(chat.type)??'unknown',chatId]):chatId}}];
    const sender=record(message.from),senderChat=record(message.sender_chat);
    const authorUser=external(sender.id),authorChat=external(senderChat.id),author=authorUser??authorChat??external(message.from_id);
    const chatAuthor=authorUser===undefined&&authorChat!==undefined;
    if(author)relations.push({kind:'authored_by',target:{platform,namespace:authority,kind:chatAuthor?'conversation':'actor',
      external_id:desktop&&chatAuthor?canonical([external(senderChat.type)??'unknown',author]):author}});
    const reply=external(record(message.reply_to_message).message_id)??external(message.reply_to_message_id);
    if(reply)relations.push({kind:'reply_to',target:{...source,external_id:reply}});
    const thread=external(message.message_thread_id);
    if(thread)relations.push({kind:'in_thread',target:{...source,kind:'thread',external_id:thread}});
    return {...fallback,adapter:desktop?'telegram.desktop':'telegram.bot-api',object:source,
      operation:body.edited_message||body.edited_channel_post?'update':'snapshot',relations};
  }
  if(platform==='browser'||platform==='scheduler') {
    const conversation=external(body.conversation_id)??value.key;
    return {...fallback,adapter:'nocheh.'+platform,object:{platform,namespace:digest(canonical([value.scope,conversation])),
      kind:platform==='browser'?'message':'schedule_occurrence',external_id:external(value.source_id)??digest(value.key)}};
  }
  return fallback;
}

export async function projectSource(client:pg.PoolClient,eventId:string,value:Envelope):Promise<void> {
  const descriptor=value.source??legacySource(value),source=descriptor.object;
  const identities=new Map([source,...descriptor.relations.map(r=>r.target)].map(v=>[sourceObjectId(v),v]));
  // Stable ordering avoids inverse-relation deadlocks between simultaneous imports.
  const objects=[...identities].sort(([a],[b])=>a.localeCompare(b)).map(([id,v])=>({id,...v}));
  await client.query(`INSERT INTO source_objects(id,platform,namespace,kind,external_id)
    SELECT id,platform,namespace,kind,external_id FROM jsonb_to_recordset($1::jsonb)
    AS x(id text,platform text,namespace text,kind text,external_id text) ORDER BY id ON CONFLICT DO NOTHING`,[JSON.stringify(objects)]);
  const objectId=sourceObjectId(source),revisionId=digest(canonical([objectId,value.revision]));
  await client.query('INSERT INTO source_revisions(id,object_id,revision,revision_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[revisionId,objectId,value.revision,digest(value.revision)]);
  await client.query(`INSERT INTO source_observations(event_id,revision_id,model_version,adapter,adapter_version,operation,completeness,descriptor,metadata,provenance)
    VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,[eventId,revisionId,descriptor.adapter,descriptor.adapter_version,descriptor.operation,descriptor.completeness,
    Buffer.from(canonical(descriptor)),JSON.stringify(descriptor.metadata??{}),JSON.stringify(descriptor.provenance??{})]);
  if(descriptor.relations.length)await client.query(`INSERT INTO source_relations(event_id,kind,target_id,metadata)
    SELECT $1,kind,target_id,metadata FROM jsonb_to_recordset($2::jsonb) AS x(kind text,target_id text,metadata jsonb)`,
    [eventId,JSON.stringify(descriptor.relations.map(r=>({kind:r.kind,target_id:sourceObjectId(r.target),metadata:r.metadata??{}})))]);
}

/** Runs inside initialize's migration transaction and advisory lock. Safe to repeat. */
export async function migrateSourceModel(client:pg.PoolClient):Promise<void> {
  await client.query(sourceModelSchema);
  let after='';
  for(;;) {
    const {rows}=await client.query(`SELECT e.* FROM events e WHERE e.id>$1 AND NOT EXISTS
      (SELECT 1 FROM source_observations s WHERE s.event_id=e.id) ORDER BY e.id LIMIT 200`,[after]);
    if(!rows.length)break;
    for(const row of rows)await projectSource(client,row.id,{version:1,key:row.source_key,channel:row.channel,bot_id:row.bot_id,
      scope:row.scope,source_id:row.source_id,revision:row.revision,origin:row.origin,kind:row.kind,occurred_at:row.occurred_at,
      payload:JSON.parse(row.payload.toString()),text:row.original_text?.toString()??null,
      ...(row.source_descriptor?{source:sourceDescriptor(JSON.parse(row.source_descriptor.toString()),row.channel,row.source_id)}:{})});
    after=rows.at(-1)!.id;
  }
  await client.query('INSERT INTO source_model_migrations(version) VALUES(1) ON CONFLICT DO NOTHING');
}
