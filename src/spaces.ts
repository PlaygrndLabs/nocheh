import type pg from 'pg';
import { HttpError, object, string } from './http.js';

export const spaceSchema = `
CREATE TABLE IF NOT EXISTS memory_policy_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL DEFAULT 1);
INSERT INTO memory_policy_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS memory_spaces (id text PRIMARY KEY, overrides jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS event_spaces (event_id text PRIMARY KEY REFERENCES events(id), space_id text NOT NULL);
CREATE INDEX IF NOT EXISTS event_spaces_space ON event_spaces(space_id,event_id);
CREATE TABLE IF NOT EXISTS memory_shares (id text PRIMARY KEY, destination text NOT NULL, content text NOT NULL,
 source_ids jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE INDEX IF NOT EXISTS memory_shares_destination ON memory_shares(destination) WHERE revoked_at IS NULL;
`;
export type SpaceMode = 'isolated' | 'approved' | 'filtered';
export interface SpacePreferences {mode:SpaceMode; sources:string[]; privacy_instructions:string}
export const defaults:SpacePreferences = {mode:'approved', sources:[], privacy_instructions:'Do not disclose personal relationships, health, finances, identity details, credentials, private plans, or information about other people. Release only relevant non-personal knowledge. When uncertain, omit it.'};
/**
 * The forum topic a Telegram message belongs to. Bot API also sets message_thread_id on a reply
 * chain in an ordinary supergroup (the chain's first message); that is not a topic, and Telegram
 * rejects it as a delivery destination. Same rule as the Hermes adapter's routable thread id.
 */
export function telegramTopicId(message:Record<string,any>):unknown {
  const chat=message.chat&&typeof message.chat==='object'?message.chat:{},raw=message.message_thread_id;
  if(raw===undefined||raw===null)return undefined;
  return (chat.type==='group'||chat.type==='supergroup')&&chat.is_forum===true||message.is_topic_message===true?raw:undefined;
}
export function spaceId(scope:string, topic?:unknown):string {
  if (topic===undefined || topic===null) return scope;
  if (!/^-?\d+$/.test(scope) || !Number.isSafeInteger(topic) || Number(topic)<=0) throw new HttpError(400,'invalid_topic');
  return `${scope}/topic/${topic}`;
}
export function eventSpace(scope:string, payload:unknown, channel='telegram'):string {
  if(channel==='browser'||channel==='scheduler') {
    const space=object(payload).space;
    if(space===undefined)return scope;
    const value=validateSpace(space);
    if((parentSpace(value)??value)!==scope)throw new HttpError(400,'source_space_mismatch');
    return value;
  }
  if(channel!=='telegram')return scope;
  const body=object(payload), message=body.message ?? body.edited_message ?? body.channel_post ?? body.edited_channel_post;
  const desktop=desktopTopicId(scope,body);
  if(desktop!==undefined)return spaceId(scope,desktop);
  return message ? spaceId(scope,telegramTopicId(object(message))) : scope;
}
// Telegram Desktop names a supergroup or channel by its bare id; the Bot API prefixes it with -100.
export const desktopChannelTypes=new Set(['private_supergroup','public_supergroup','private_channel','public_channel']);
/** The forum topic the importer worked out for a Desktop export message, only once the export is
 * mapped to its own live supergroup, where topic ids are the live ones. */
export function desktopTopicId(scope:string,body:Record<string,any>):number|undefined {
  const chat=body.chat&&typeof body.chat==='object'?body.chat:{},topic=body.topic_id;
  if(!desktopChannelTypes.has(chat.type)||!/^[1-9][0-9]{0,15}$/.test(String(chat.id))||scope!=='-100'+chat.id)return undefined;
  return Number.isSafeInteger(topic)&&topic>0?topic:undefined;
}

export async function backfillSpaces(db:pg.PoolClient) {
  // PostgreSQL JSON cannot represent literal NUL; originals remain exact bytea.
  for(;;) {
    const {rows}=await db.query<{id:string;scope:string;channel:string;payload:Buffer}>(`SELECT e.id,e.scope,e.channel,e.payload FROM events e
      WHERE NOT EXISTS(SELECT 1 FROM event_spaces s WHERE s.event_id=e.id) ORDER BY e.id LIMIT 500`);
    if(!rows.length)return;
    const spaces=rows.map(row=>{try{return eventSpace(row.scope,JSON.parse(row.payload.toString()),row.channel);}catch{return row.scope;}});
    await db.query('INSERT INTO event_spaces(event_id,space_id) SELECT * FROM unnest($1::text[],$2::text[]) ON CONFLICT DO NOTHING',[rows.map(row=>row.id),spaces]);
  }
}
export function validateSpace(id:unknown):string {
  const value=string(id,256);
  if(!value.trim() || /[\x00-\x1f]/.test(value) || (value.includes('/topic/') && !/^-?\d+\/topic\/[1-9]\d{0,15}$/.test(value))) throw new HttpError(400,'invalid_space');
  return value;
}
export function parentSpace(id:string):string|null {return id.includes('/topic/')?id.split('/topic/')[0]!:null;}
/** A Telegram group's chat ID, as Telegram writes it: negative, with no leading zero (private chats are positive;
 * assistant-policy.ts). A group or topic is this ID, or it followed by one of its topics. Every test of whether a
 * conversation is a group uses these, in code and in SQL, so they always agree. */
const groupChat='-[1-9][0-9]{0,18}',groupTopic='/topic/[1-9][0-9]{0,15}';
const groupChatPattern=new RegExp(`^${groupChat}$`),groupSpacePattern=new RegExp(`^${groupChat}(${groupTopic})?$`);
export const groupChatId=(id:string)=>groupChatPattern.test(id);
/**
 * Whether a conversation is a group or one of its topics, the only conversations that may share or be shared
 * with. Everything else counts as private and fails closed: the owner's private chat and its topics, any other
 * private chat, `desktop:*` imports, `system`, and an unknown conversation (null) (ADR-0242).
 */
export const groupSpace=(space:string|null|undefined):space is string=>!!space&&groupSpacePattern.test(space);
/** SQL test that `column` names a group or one of its topics, exactly as groupSpace decides it. */
export const groupSpaceSql=(column:string)=>`${column} ~ '^${groupChat}(${groupTopic})?$'`;
/** SQL test that `column` names a group itself, not one of its topics, exactly as groupChatId decides it. */
export const groupChatSql=(column:string)=>`${column} ~ '^${groupChat}$'`;
/** The conversations a group or topic turn recalls: its own, or, when the group's topics share
 * memory, the group's base conversation and every one of its topics. Owner turns read everything.
 * The single-conversation form that ReadSet generalizes; inRecall and recallCondition keep their
 * meaning for the callers that still use them. */
export interface RecallScope {space:string;group:string|null}
export function recallScope(space:string,topicMemory:'group'|'topic'='group'):RecallScope {
  const chat=parentSpace(space)??space;
  return {space,group:topicMemory==='group'&&groupChatId(chat)?chat:null};
}
export const inRecall=(scope:RecallScope,space:string)=>space===scope.space||scope.group!==null&&(parentSpace(space)??space)===scope.group;
/** SQL test that `column` names a conversation of the recall scope bound as `space` and `group`. */
export const recallCondition=(column:string,space:string,group:string)=>
  `(${column}=${space} OR (${group}::text IS NOT NULL AND (${column}=${group} OR starts_with(${column},${group}||'/topic/'))))`;

/**
 * The conversations a scoped reader may read (ADR-0249). A group or topic turn reads its own recall scope; an
 * "Answer privately" answer reads the groups frozen when the button was tapped.
 * - `home`: the conversation the reads are for (the asking group or topic). It names the reader; it grants nothing.
 * - `exact`: groups or topics read as themselves only (a topic, or a group's General chat, when topics keep their
 *   own memory).
 * - `whole`: groups read with every one of their topics.
 * - `project`: the project the reads belong to, or null.
 * A read set never holds anything but a group or one of its topics: the owner's private chat and its topics, any
 * other private chat, `desktop:*` imports, `system` and an unknown conversation are left out wherever a set is made,
 * and inReadSet and readSetSql never match one even in a set built by hand (ADR-0242, fail closed).
 */
export interface ReadSet {readonly home:string;readonly exact:readonly string[];readonly whole:readonly string[];readonly project:string|null}
/** The one way to make a read set: drops every conversation groupSpace refuses, every `whole` entry that is not a
 * group itself, and every `exact` entry a `whole` group already covers; sorted and without repeats. */
export function readSet(input:{home:string;exact?:Iterable<string>;whole?:Iterable<string>;project?:string|null}):ReadSet {
  const project=input.project??null;
  if(project!==null&&!/^[a-f0-9]{64}$/.test(project))throw new HttpError(400,'invalid_project_id');
  const whole=[...new Set(input.whole??[])].filter(groupChatId).sort();
  const exact=[...new Set(input.exact??[])].filter(space=>groupSpace(space)&&!whole.includes(parentSpace(space)??space)).sort();
  return Object.freeze({home:validateSpace(input.home),exact:Object.freeze(exact),whole:Object.freeze(whole),project});
}
/** A group or topic turn's recall scope as a read set: the whole group when its topics share memory, else just its
 * own conversation. A private chat's scope reads nothing here. */
export function readSetOf(scope:RecallScope,project:string|null=null):ReadSet {
  return scope.group!==null?readSet({home:scope.space,whole:[scope.group],project}):readSet({home:scope.space,exact:[scope.space],project});
}
/** Whether a read set reads `space`: one of its `exact` conversations, or a `whole` group or one of its topics. */
export const inReadSet=(set:ReadSet,space:string|null|undefined):boolean=>
  groupSpace(space)&&(set.exact.includes(space)||set.whole.includes(parentSpace(space)??space));
/** The groups whose chats a read set reads from: each `whole` group and the group of each `exact` conversation. A
 * group's archive records carry the group's chat ID, so a read of the archive starts from these and narrows by space. */
export const readSetGroups=(set:ReadSet):string[]=>
  [...new Set([...set.whole,...set.exact.map(space=>parentSpace(space)??space)])].filter(groupChatId).sort();
/**
 * A read set as one SQL `text[]` parameter for readSetSql: each `exact` conversation as itself, and each `whole`
 * group as the group followed by `/*`. Only groups and topics are written, whatever the set holds.
 */
export const readSetParam=(set:ReadSet):string[]=>[...set.exact.filter(groupSpace),...set.whole.filter(groupChatId).map(group=>group+'/*')];
/**
 * SQL test that `column` names a conversation of a read set bound as ONE `text[]` parameter holding readSetParam(set):
 * `param` is its position (2 for `$2`) or its literal placeholder. The column matches an exact entry, or its group
 * (the part before `/topic/`) followed by `/*` matches a whole entry. A column that is not a group or topic never
 * matches, so no parameter can open a private chat; an empty parameter matches nothing.
 */
export const readSetSql=(column:string,param:number|string)=>{
  if(typeof param==='number'?!Number.isSafeInteger(param)||param<1:!param.trim())throw Error('invalid_read_set_parameter');
  const value=`${typeof param==='number'?'$'+param:param}::text[]`;
  return `(${groupSpaceSql(column)} AND (${column}=ANY(${value}) OR split_part(${column},'/topic/',1)||'/*'=ANY(${value})))`;
};
export function validateOverrides(input:unknown):Partial<SpacePreferences> {
  const body=object(input), result:Partial<SpacePreferences>={};
  for(const key of Object.keys(body)) if(!['mode','sources','privacy_instructions'].includes(key))throw new HttpError(400,'unknown_space_preference');
  if(body.mode!==undefined){if(!['isolated','approved','filtered'].includes(String(body.mode)))throw new HttpError(400,'invalid_memory_mode');result.mode=body.mode as SpaceMode;}
  if(body.sources!==undefined){if(!Array.isArray(body.sources)||body.sources.length>100)throw new HttpError(400,'invalid_memory_sources');result.sources=[...new Set(body.sources.map(validateSpace))];}
  if(body.privacy_instructions!==undefined)result.privacy_instructions=string(body.privacy_instructions,4000);
  return result;
}
type Database=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;
export async function policyRevision(db:Database):Promise<number> {return (await db.query('SELECT revision FROM memory_policy_state WHERE singleton=true')).rows[0].revision;}
export async function spacePolicy(db:Database, id:string) {
  validateSpace(id);const parent=parentSpace(id);
  // One snapshot prevents mixing an old policy with a newly advanced revision.
  const {rows}=await db.query('SELECT revision,(SELECT overrides FROM memory_spaces WHERE id=$1) AS own,(SELECT overrides FROM memory_spaces WHERE id=$2) AS parent FROM memory_policy_state WHERE singleton=true',[id,parent]);
  const row=rows[0], inherited={...defaults,...(row.parent??{})} as SpacePreferences;
  return {id,parent,revision:row.revision as number,overrides:(row.own??{}) as Partial<SpacePreferences>,effective:{...inherited,...(row.own??{})} as SpacePreferences,
    inherited, native_profile_revision:row.revision as number};
}
export async function saveSpace(pool:pg.Pool,id:string,input:unknown,expected:unknown) {
  validateSpace(id);const overrides=validateOverrides(input),client=await pool.connect();
  try {await client.query('BEGIN');const {rows}=await client.query('SELECT revision FROM memory_policy_state WHERE singleton=true FOR UPDATE');
    if(rows[0].revision!==expected)throw new HttpError(409,'space_revision_conflict');
    await client.query('INSERT INTO memory_spaces(id,overrides) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET overrides=$2,updated_at=now()',[id,JSON.stringify(overrides)]);
    await client.query('UPDATE memory_policy_state SET revision=revision+1');await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return spacePolicy(pool,id);
}
export async function listSpaces(db:Database,after='') {
  const {rows}=await db.query(`SELECT id FROM (SELECT space_id AS id FROM event_spaces UNION SELECT id FROM memory_spaces) spaces WHERE id>$1 ORDER BY id LIMIT 101`,[after]);
  return {spaces:await Promise.all(rows.slice(0,100).map(row=>spacePolicy(db,row.id))),next:rows.length>100?rows[99].id:null};
}
