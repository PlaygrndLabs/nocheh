import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import {decide,defaultPolicy,validatePolicy,type Policy,type Effect,type Decision} from './contract.js';
import type {SourceReference} from '../stores/archive.js';
import type {OperationReference} from '../stores/operations.js';
type Db=pg.Pool|pg.PoolClient;
export const securityCoreSchema=`
CREATE TABLE IF NOT EXISTS security_policy_versions (
 revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, document jsonb NOT NULL,
 actor text NOT NULL DEFAULT 'owner',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS security_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision bigint NOT NULL REFERENCES security_policy_versions(revision)
);
INSERT INTO security_policy_versions(document) SELECT '{"version":1,"rules":[]}' WHERE NOT EXISTS(SELECT 1 FROM security_policy);
INSERT INTO security_policy(singleton,revision) SELECT true,max(revision) FROM security_policy_versions ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS security_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, effect_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('proposed','allowed','blocked','awaiting_approval','claimed','started','completed','failed','ambiguous')),
 kind text NOT NULL, scope text NOT NULL, profile text NOT NULL, source_event_id text,
 policy_revision bigint NOT NULL REFERENCES security_policy_versions(revision),
 origin text NOT NULL, rule text NOT NULL, permission_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(effect_id,state,policy_revision,rule)
);
CREATE INDEX IF NOT EXISTS security_events_effect ON security_events(effect_id,id);
ALTER TABLE security_events ADD COLUMN IF NOT EXISTS source_reference jsonb;
`;
export const securitySchema=securityCoreSchema+`ALTER TABLE action_requests ADD COLUMN IF NOT EXISTS security_decision jsonb;`;
export async function policySnapshot(db:Db,lock=false):Promise<{revision:number;policy:Policy}> {
  const row=(await db.query<{revision:string;document:unknown}>(`SELECT p.revision,v.document FROM security_policy p JOIN security_policy_versions v USING(revision)${lock?' FOR SHARE OF p':''}`)).rows[0];
  if(!row)throw new HttpError(503,'security_policy_unavailable');
  return {revision:Number(row.revision),policy:validatePolicy(row.document)};
}
export async function configuration(pool:pg.Pool,principal:Reader) {
  admin(principal);const snapshot=await policySnapshot(pool);
  return {...snapshot,defaults:defaultPolicy,precedence:['mandatory','deny','bounded_grant','ask','default'],
    takes_effect:'next authorization; running effects cannot be undone',source:'owner security policy',
    permissions:'Exact, expiring, revocable grants are managed through /v1/tools/grant and /v1/tools/revoke.'};
}
export async function savePolicy(pool:pg.Pool,principal:Reader,input:unknown) {
  admin(principal);const body=object(input),policy=validatePolicy(body.policy);
  if(!Number.isSafeInteger(body.expected_revision))throw new HttpError(400,'expected_security_revision_required');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const current=(await client.query<{revision:string}>('SELECT revision FROM security_policy FOR UPDATE')).rows[0];
    if(Number(current?.revision)!==body.expected_revision)throw new HttpError(409,'security_policy_conflict');
    const row=(await client.query<{revision:string}>('INSERT INTO security_policy_versions(document) VALUES($1) RETURNING revision',[policy])).rows[0]!;
    await client.query('UPDATE security_policy SET revision=$1',[row.revision]);
    await client.query('COMMIT');return {revision:Number(row.revision),policy,takes_effect:'next authorization'};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function evaluate(db:Db,effect:Effect,grant?:string,lock=false):Promise<Decision> {
  const {revision,policy}=await policySnapshot(db,lock);
  return decide(policy,revision,effect,grant?{grant}:{});
}
export type EffectState='proposed'|'allowed'|'blocked'|'awaiting_approval'|'claimed'|'started'|'completed'|'failed'|'ambiguous';
export async function recordEffect(db:Db,effect:Effect,state:EffectState,decision:Decision,source?:string|SourceReference|OperationReference,permission?:string) {
  // A closed schema prevents payloads, URLs, headers or exception strings from entering logs.
  await db.query(`INSERT INTO security_events(effect_id,state,kind,scope,profile,source_event_id,policy_revision,origin,rule,permission_id,source_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [effect.id,state,effect.kind,effect.scope,effect.profile,typeof source==='string'?source:source?.id??null,
      decision.revision,decision.origin,decision.rule,permission??null,typeof source==='string'?null:source??null]);
}
export async function effectLog(pool:pg.Pool,principal:Reader,after='0',effect?:string) {
  admin(principal);
  if(!/^\d{1,18}$/.test(after)||effect!==undefined&&!/^[\w:.-]{1,128}$/.test(effect))throw new HttpError(400,'invalid_effect_cursor');
  const rows=(await pool.query('SELECT * FROM security_events WHERE id>$1 AND ($2::text IS NULL OR effect_id=$2) ORDER BY id LIMIT 201',[after,effect??null])).rows;
  return {events:rows.slice(0,200),next:rows.length>200?rows[199].id:null,receipt_semantics:'allowed is authority; completed is an observed result; ambiguous requires investigation and is never retried automatically'};
}
