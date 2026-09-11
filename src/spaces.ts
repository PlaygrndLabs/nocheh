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
  return message ? spaceId(scope,object(message).message_thread_id) : scope;
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
