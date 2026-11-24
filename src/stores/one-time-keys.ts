import {randomBytes} from 'node:crypto';
import type pg from 'pg';
import {keyIdPattern,keyKinds,personClaim,type KeyKind,type Reader} from '../access.js';
import {HttpError} from '../http.js';

/**
 * One-time keys (ADR-0301): every pass Nocheh mints is one key for one reply or run, kept here by its id (jti). The row
 * names the key's person, its agent, what it answers (its kind, subject and attempt) and the event its pass names; a pass
 * whose row is missing, does not match it, is closed or has expired reaches nothing. A pass signed again for the same
 * reply (a presence renewal, the delivery) carries the same jti, so closing the row ends every copy of it at once.
 * Rows stay for 30 days after they close or expire, for the owner's later list of keys; they hold no secret.
 */
export const oneTimeKeySchema=`
CREATE TABLE IF NOT EXISTS one_time_keys (
 jti text PRIMARY KEY CHECK(jti ~ '^[a-f0-9]{32}$'),
 kind text NOT NULL CHECK(kind IN (${keyKinds.map(kind=>`'${kind}'`).join(',')})),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
 attempt text NOT NULL CHECK(length(attempt) BETWEEN 1 AND 100),
 person text NOT NULL CHECK(person='owner' OR person ~ '^[a-f0-9]{64}$'),
 agent text NOT NULL CHECK(agent ~ '^[a-z][a-z0-9-]{0,31}$'),
 event_id text NOT NULL CHECK(event_id ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 closed_at timestamptz,
 closed_reason text CHECK(closed_reason IS NULL OR closed_reason ~ '^[a-z][a-z_]{0,39}$'),
 UNIQUE(kind,subject,attempt)
);
CREATE INDEX IF NOT EXISTS one_time_keys_open_person ON one_time_keys(person) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS one_time_keys_event ON one_time_keys(event_id);
CREATE INDEX IF NOT EXISTS one_time_keys_expires ON one_time_keys(expires_at);
`;
/** Why a key closed: its reply went out or did not, its run ended, its review or filter finished, its schedule or owner
 * changed. `stopped` is kept for the owner's "Stop everything now". */
export const keyCloseReasons=['delivered','not_delivered','run_finished','run_cancelled','run_interrupted','review_finished','filter_finished',
  'schedule_changed','owner_changed','stopped'] as const;
export type KeyCloseReason=typeof keyCloseReasons[number];
/** What one mint names: the key's kind, what it answers (subject and attempt), its person, agent and event, and when it
 * expires (epoch milliseconds). */
export type KeyMint={kind:KeyKind;subject:string;attempt:string;person:string;agent:string;event:string;expires:number};
type Queryable=Pick<pg.Pool,'query'>;
const agentName=/^[a-z][a-z0-9-]{0,31}$/,eventId=/^[a-f0-9]{64}$/;
/** Old rows go at most once a minute per process, as mints happen. */
let swept=0;

/** Closes every open key of one reply or run (each of its attempts); idempotent. */
export async function closeSubject(db:Queryable,kind:KeyKind,subject:string,reason:KeyCloseReason):Promise<number> {
  return (await db.query(`UPDATE one_time_keys SET closed_at=now(),closed_reason=$3 WHERE kind=$1 AND subject=$2 AND closed_at IS NULL`,
    [kind,subject,reason])).rowCount??0;
}
/** Closes every open key of `kinds` whose pass names `event`; idempotent. A managed run's keys close this way, in the
 * transaction that ends the run. */
export async function closeEvent(db:Queryable,event:string,kinds:readonly KeyKind[],reason:KeyCloseReason):Promise<number> {
  return (await db.query(`UPDATE one_time_keys SET closed_at=now(),closed_reason=$3 WHERE event_id=$1 AND kind=ANY($2::text[]) AND closed_at IS NULL`,
    [event,kinds,reason])).rowCount??0;
}

export class OneTimeKeyRepository {
  constructor(readonly control:Queryable){}
  /**
   * The key for one reply or run: a new row, or the open row already minted for the same kind, subject and attempt with
   * the same person, agent and event, whose expiry moves to the later of the two. Its jti is returned. A row that closed
   * is never opened again (409 one_time_key_closed); one that names another person, agent or event refuses the mint (409
   * one_time_key_conflict). A row that only expired, because Nocheh signed nothing for it a while (paused, down, a guard
   * change pending), is signed again for its own attempt: every copy signed before still ends at its own signed expiry,
   * and the reply or run can still settle.
   */
  async mint(input:KeyMint):Promise<string> {
    if(!keyKinds.includes(input.kind)||!input.subject||input.subject.length>200||!input.attempt||input.attempt.length>100||!personClaim(input.person)||
      !agentName.test(input.agent)||!eventId.test(input.event)||!Number.isFinite(input.expires))throw new HttpError(400,'invalid_one_time_key');
    if(Date.now()-swept>60000){swept=Date.now();
      await this.control.query(`DELETE FROM one_time_keys WHERE coalesce(closed_at,expires_at)<now()-interval '30 days'`);}
    const jti=randomBytes(16).toString('hex');
    const row=(await this.control.query<{jti:string}>(`INSERT INTO one_time_keys(jti,kind,subject,attempt,person,agent,event_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::float8/1000))
      ON CONFLICT(kind,subject,attempt) DO UPDATE SET expires_at=GREATEST(one_time_keys.expires_at,EXCLUDED.expires_at)
      WHERE one_time_keys.closed_at IS NULL AND one_time_keys.person=EXCLUDED.person
        AND one_time_keys.agent=EXCLUDED.agent AND one_time_keys.event_id=EXCLUDED.event_id
      RETURNING jti`,[jti,input.kind,input.subject,input.attempt,input.person,input.agent,input.event,input.expires])).rows[0];
    if(row)return row.jti;
    const held=(await this.control.query('SELECT closed_at FROM one_time_keys WHERE kind=$1 AND subject=$2 AND attempt=$3',
      [input.kind,input.subject,input.attempt])).rows[0];
    throw new HttpError(409,held?.closed_at?'one_time_key_closed':'one_time_key_conflict');
  }
  /**
   * The pass's key is open: its row exists with the pass's person, agent, kind and event (401 one_time_key_unknown
   * otherwise), and it has neither closed nor expired (409 one_time_key_closed, which the agent takes as final).
   */
  async assertOpen(principal:Pick<Reader,'jti'|'person'|'agent'|'keyKind'|'turnEvent'>):Promise<void> {
    if(typeof principal.jti!=='string'||!keyIdPattern.test(principal.jti))throw new HttpError(401,'one_time_key_unknown');
    const row=(await this.control.query(`SELECT kind,person,agent,event_id,closed_at IS NOT NULL OR expires_at<=now() AS ended FROM one_time_keys WHERE jti=$1`,
      [principal.jti])).rows[0];
    if(!row||row.person!==principal.person||row.agent!==principal.agent||row.kind!==principal.keyKind||row.event_id!==principal.turnEvent)
      throw new HttpError(401,'one_time_key_unknown');
    if(row.ended)throw new HttpError(409,'one_time_key_closed');
  }
  /** Closes one key; idempotent. */
  async close(jti:string,reason:KeyCloseReason):Promise<void> {
    await this.control.query('UPDATE one_time_keys SET closed_at=now(),closed_reason=$2 WHERE jti=$1 AND closed_at IS NULL',[jti,reason]);
  }
  closeSubject(kind:KeyKind,subject:string,reason:KeyCloseReason):Promise<number> {return closeSubject(this.control,kind,subject,reason);}
  closeEvent(event:string,kinds:readonly KeyKind[],reason:KeyCloseReason):Promise<number> {return closeEvent(this.control,event,kinds,reason);}
}
