import {randomBytes} from 'node:crypto';
import type pg from 'pg';
import {turnToken,type KeyKind} from '../src/access.js';

/** A one-time key's claims for a synthetic pass (ADR-0305): its person, a fresh jti and its kind. */
export const keyClaims=(person='owner',kind:KeyKind='turn')=>({person,jti:randomBytes(16).toString('hex'),kind});
/** A synthetic event id for a pass that answers no real message. */
export const syntheticEvent='e'.repeat(63)+'1';
type Policy=NonNullable<Parameters<typeof turnToken>[4]>;
/** The kind of key a pass for `policy` is, unless it names one: a review's, a filter's, an ask's, else a turn's. */
export const passKind=(policy:Partial<Policy>):KeyKind=>policy.kind??(policy.purpose==='memory-review'?'review':policy.purpose==='filter'?'filter':
  policy.memberRead!==undefined?'member_ask':'turn');
/**
 * A signed pass that is a one-time key: turnToken with key claims. Unless the policy names them, its person is the member
 * or lane it names, else the owner, and its kind follows its purpose (passKind). Without a row (openKey) storage and the
 * broker refuse it as an unknown key.
 */
export function keyPass(secret:string,scope:string|null,expires:number,event=syntheticEvent,policy:Partial<Policy>={}):string {
  const {person,kind:_kind,...rest}=policy;
  return turnToken(secret,scope,expires,event,{...keyClaims(person??policy.member??policy.lane??'owner',passKind(policy)),...rest} as Policy);
}
/** The claims a pass carries, as Hermes reads them. */
export function passClaims(pass:string):Record<string,any> {return JSON.parse(Buffer.from(pass.split('.')[1]!,'base64url').toString());}
/** Writes the open key row a pass names, as AudienceRepository.turn would have, and returns the pass. */
export async function openKey(db:Pick<pg.Pool,'query'>,pass:string,subject?:string):Promise<string> {
  const claims=passClaims(pass);
  await db.query(`INSERT INTO one_time_keys(jti,kind,subject,attempt,person,agent,event_id,expires_at) VALUES($1,$2,$3,'1',$4,$5,$6,to_timestamp($7::float8/1000))`,
    [claims.jti,claims.key_kind,subject??claims.jti,claims.person,claims.agent,claims.event_id,claims.expires]);
  return pass;
}
