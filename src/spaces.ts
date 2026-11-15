import type pg from 'pg';
import { HttpError, object, string } from './http.js';
import { chats, isChatId } from './chats.js';
import { desktopTopicId, legacyChatValue, telegramTopicId } from './chats-telegram.js';
import type { ObservedAudience } from './observed-source.js';

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
// The Telegram adapter owns Telegram's own formats (ADR-0251); these stay importable from here.
export {telegramTopicId,desktopChannelTypes,desktopTopicId} from './chats-telegram.js';
/**
 * The space of a captured event, for the legacy storage layout only, which refuses to start (database.ts): a Telegram
 * event's chat value in the frozen old shape, as the Telegram adapter builds it, or a browser or scheduler event's own
 * space. Live code places an event with sourceChat and observedChat below, through the chat directory.
 */
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
  if(desktop!==undefined)return legacyChatValue(scope,desktop);
  return message ? legacyChatValue(scope,telegramTopicId(object(message))) : scope;
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
/**
 * A conversation value as given: a Nocheh chat id, or a name that is no chat ('owner', '*', 'system', 'desktop:*').
 * Its size and characters are checked, and a value with a slash must be a well-formed chat id (isChatId, the one shared
 * check), as no name has one; what it is, and whether it is one at all, comes from the chat directory (ADR-0251), so an
 * id the directory does not know is private and reads nothing.
 */
export function validateSpace(id:unknown):string {
  const value=string(id,256);
  if(!value.trim() || /[\x00-\x1f]/.test(value) || value.includes('/')&&!isChatId(value)) throw new HttpError(400,'invalid_space');
  return value;
}
/** A topic's chat, from its row; null for a group, a private chat and an id with no row. */
export function parentSpace(id:string):string|null {return chats().parentOf(id);}
/** Whether the chat directory holds `id` as a group itself, not one of its topics (ADR-0251). */
export const groupChatId=(id:string)=>chats().kind(id)==='group';
/**
 * Whether a conversation is a group or one of its topics, the only conversations that may share or be shared
 * with, as the chat directory holds them (ADR-0251). Everything else counts as private and fails closed: the owner's
 * private chat and its topics, any other private chat, `desktop:*` imports, `system`, and any id with no chat row,
 * however it looks (ADR-0242).
 */
export const groupSpace=(space:string|null|undefined):space is string=>chats().isGroup(space);
/** Every group and topic of a group the chat directory holds: the SQL id list for "a.space_id is a group or one of
 * its topics" (`a.space_id=ANY($n::text[])`), served or not. */
export const groupSpaces=():string[]=>chats().all().filter(chat=>chats().isGroup(chat.id)).map(chat=>chat.id);
/** The groups Nocheh serves, as the chat directory holds them (in step 2b-1 the bridge sets them from
 * TELEGRAM_GROUP_IDS): groups themselves, never topics or private chats. */
export const servedGroups=():string[]=>chats().all().filter(chat=>chat.kind==='group'&&chats().served(chat.id)).map(chat=>chat.id);
/** Whether `id` is a group Nocheh serves (one of servedGroups()). */
export const servedGroup=(id:string|null|undefined):boolean=>chats().kind(id)==='group'&&chats().served(id);
/** The conversations a group or topic turn recalls: its own, or, when the group's topics share
 * memory, the group's base conversation and every one of its topics. Owner turns read everything.
 * The single-conversation form that ReadSet generalizes; inRecall and recallCondition keep their
 * meaning for the callers that still use them. */
export interface RecallScope {space:string;group:string|null}
export function recallScope(space:string,topicMemory:'group'|'topic'='group'):RecallScope {
  return {space,group:topicMemory==='group'?chats().groupOf(space):null};
}
export const inRecall=(scope:RecallScope,space:string)=>space===scope.space||scope.group!==null&&chats().groupOf(space)===scope.group;
/** A group and every topic it has a row for, as one SQL id list; null for no group. The `group` parameter of
 * recallCondition. */
export const groupWithTopics=(group:string|null):string[]|null=>group===null?null:chats().expand([group]).filter(id=>chats().groupOf(id)===group);
/** SQL test that `column` names a conversation of a recall scope: the scope's own conversation bound as `space`, or one
 * of the ids of its group bound as `group`, a `text[]` holding groupWithTopics(scope.group) (null: no group). */
export const recallCondition=(column:string,space:string,group:string)=>
  `(${column}=${space} OR ${column}=ANY(${group}::text[]))`;

/**
 * The conversations a scoped reader may read (ADR-0249). A group or topic turn reads its own recall scope; an
 * "Answer privately" answer reads the groups frozen when the button was tapped.
 * - `home`: the conversation the reads are for (the asking group or topic). It names the reader; it grants nothing.
 * - `exact`: groups or topics read as themselves only (a topic, or a group's General chat, when topics keep their
 *   own memory).
 * - `whole`: groups read with every one of their topics.
 * - `project`: the project the reads belong to, or null.
 * A read set never holds anything but a group or one of its topics: the owner's private chat and its topics, any
 * other private chat, `desktop:*` imports, `system` and an id with no chat row are left out wherever a set is made,
 * and inReadSet and readSetParam never match one even in a set built by hand (ADR-0242, fail closed).
 */
export interface ReadSet {readonly home:string;readonly exact:readonly string[];readonly whole:readonly string[];readonly project:string|null}
/** The one way to make a read set: drops every conversation groupSpace refuses, every `whole` entry that is not a
 * group itself, and every `exact` entry a `whole` group already covers; sorted and without repeats. */
export function readSet(input:{home:string;exact?:Iterable<string>;whole?:Iterable<string>;project?:string|null}):ReadSet {
  const project=input.project??null;
  if(project!==null&&!/^[a-f0-9]{64}$/.test(project))throw new HttpError(400,'invalid_project_id');
  const whole=[...new Set(input.whole??[])].filter(groupChatId).sort();
  const exact=[...new Set(input.exact??[])].filter(space=>groupSpace(space)&&!whole.includes(chats().groupOf(space)!)).sort();
  return Object.freeze({home:validateSpace(input.home),exact:Object.freeze(exact),whole:Object.freeze(whole),project});
}
/** A group or topic turn's recall scope as a read set: the whole group when its topics share memory, else just its
 * own conversation. A private chat's scope reads nothing here. */
export function readSetOf(scope:RecallScope,project:string|null=null):ReadSet {
  return scope.group!==null?readSet({home:scope.space,whole:[scope.group],project}):readSet({home:scope.space,exact:[scope.space],project});
}
/** Whether a read set reads `space`: one of its `exact` conversations, or a `whole` group or one of its topics. */
export const inReadSet=(set:ReadSet,space:string|null|undefined):boolean=>
  groupSpace(space)&&(set.exact.includes(space)||set.whole.includes(chats().groupOf(space)!));
/** The groups whose chats a read set reads from: each `whole` group and the group of each `exact` conversation. Read
 * the archive with their archiveScopes, then narrow by each original's observed chat. */
export const readSetGroups=(set:ReadSet):string[]=>
  [...new Set([...set.whole,...set.exact.map(space=>chats().groupOf(space)??'')])].filter(groupChatId).sort();
/**
 * The ids a read set reads: each `exact` conversation as itself and each `whole` group with every topic it has a row
 * for. Only groups and their topics are written, whatever the set holds, so no list can name a private chat.
 */
export const readSetIds=(set:ReadSet):string[]=>
  [...new Set([...set.exact.filter(space=>groupSpace(space)),...chats().expand(set.whole.filter(groupChatId)).filter(groupSpace)])].sort();
/** The mark readSetParam puts before every id it writes. readSetSql reads only marked entries, so a list of ids made by
 * hand, which skipped readSetIds' filter, matches nothing in SQL: the database never opens a private chat because a
 * caller bound the wrong list (ADR-0242). */
const readMark='read:';
/** A read set as one SQL `text[]` parameter for readSetSql: readSetIds, each id marked. */
export const readSetParam=(set:ReadSet):string[]=>readSetIds(set).map(id=>readMark+id);
/**
 * SQL test that `column` names a conversation of a read set bound as ONE `text[]` parameter holding readSetParam(set):
 * `param` is its position (2 for `$2`) or its literal placeholder. Only the parameter's marked entries count, so an
 * empty parameter, or one not made by readSetParam, matches nothing.
 */
export const readSetSql=(column:string,param:number|string)=>{
  if(typeof param==='number'?!Number.isSafeInteger(param)||param<1:!param.trim())throw Error('invalid_read_set_parameter');
  return `${column}=ANY(ARRAY(SELECT substr(entry,${readMark.length+1}) FROM unnest(${typeof param==='number'?'$'+param:param}::text[]) entry `+
    `WHERE left(entry,${readMark.length})='${readMark}'))`;
};

/**
 * The Nocheh chat an archive original belongs to (ADR-0251): a Telegram original's chat by its raw id, current or
 * old, through chat_ids; a browser or scheduler original's scope is the chat's own id. Null when no chat row names it,
 * which reads nothing.
 */
export function sourceChat(source:{channel:string;scope:string}):string|null {
  if(source.channel==='telegram')return chats().resolve('telegram',source.scope);
  if(source.channel==='browser'||source.channel==='scheduler')return chats().get(source.scope)?.id??null;
  return null;
}
/**
 * The Nocheh chat or topic of an original's observed audience (its {chat_id, topic_state, topic_id}): on Telegram the
 * raw chat id and thread id, through chat_ids and the topic's row; on the browser and the scheduler the chat's own id
 * and its topic key. Null when the topic is unknown or no row names it: a missing topic row reads nothing.
 */
export function observedChat(channel:string,observed:ObservedAudience|null|undefined):string|null {
  if(!observed||observed.topic_state==='unknown')return null;
  const topic=observed.topic_state==='known'?observed.topic_id??null:null;
  if(observed.topic_state==='known'&&topic===null)return null;
  if(channel==='telegram')return chats().resolve('telegram',observed.chat_id,topic);
  if(channel!=='browser'&&channel!=='scheduler')return null;
  const chat=chats().get(observed.chat_id);
  return !chat||chat.kind==='topic'?null:topic===null?chat.id:chats().topicOf(chat.id,topic);
}
/** The events.scope values the archive holds a chat's originals under: for each known chat (a topic counting as its
 * chat), its own id (browser and scheduler originals) and every app id it has had, current and old. Ids with no row
 * give none. */
export function archiveScopes(ids:Iterable<string>):string[] {
  const out=new Set<string>();
  for(const id of ids){const chat=chats().get(id);if(!chat)continue;const base=chat.parent_id??chat.id;out.add(base);for(const raw of chats().rawScopes([base]))out.add(raw);}
  return [...out].sort();
}
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
