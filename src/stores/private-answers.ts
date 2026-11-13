import type pg from 'pg';
import {createHmac} from 'node:crypto';
import {admin,answerId,type Reader} from '../access.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import {groupSpaceSql} from '../spaces.js';

/**
 * One row per "Answer privately" button Nocheh offered (ADR-0248): who asked, where, in which project, which groups
 * the answer may read and what became of it. The groups (`read_chats`, whole groups) are frozen when the button is
 * tapped, so a later change can't widen an old answer. Columns are named like the Members data design and hold raw
 * Telegram IDs until chats, members and accounts get their own IDs; `member_id` null is the owner. Rows are the
 * record: expiry changes their state and never deletes them.
 */
export const privateAnswerSchema=`
CREATE TABLE IF NOT EXISTS private_answers (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 question_event text NOT NULL UNIQUE CHECK(question_event ~ '^[a-f0-9]{64}$'),
 from_chat_id text NOT NULL CHECK(${groupSpaceSql('from_chat_id')}),
 project_id text NOT NULL CHECK(project_id ~ '^[a-f0-9]{64}$'),
 member_id text,
 asker_account_id text NOT NULL CHECK(asker_account_id ~ '^[1-9][0-9]{0,18}$'),
 read_chats text[] CHECK(read_chats IS NULL OR cardinality(read_chats)>0 AND array_position(read_chats,NULL) IS NULL
   AND array_to_string(read_chats,',') ~ '^-[1-9][0-9]{0,18}(,-[1-9][0-9]{0,18})*$'),
 reply_chat_id text CHECK(reply_chat_id ~ '^[1-9][0-9]{0,18}$'),
 state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','pressed','answered','needs_private_chat','refused','expired')),
 refusal_code text CHECK(refusal_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 press_event text CHECK(press_event ~ '^[a-f0-9]{64}$'),
 start_event text UNIQUE CHECK(start_event ~ '^[a-f0-9]{64}$'),
 offered_at timestamptz NOT NULL DEFAULT now(),
 pressed_at timestamptz,
 answered_at timestamptz,
 expires_at timestamptz NOT NULL,
 send_key text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 CHECK(state NOT IN ('pressed','answered') OR read_chats IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS private_answers_due ON private_answers(state,expires_at);
CREATE INDEX IF NOT EXISTS private_answers_asker ON private_answers(asker_account_id,offered_at DESC);
`;

export const privateAnswerStates=['offered','pressed','answered','needs_private_chat','refused','expired'] as const;
export type PrivateAnswerState=typeof privateAnswerStates[number];
/** An unused button expires a day after it is offered; a tap must be followed by /start within ten minutes. */
export const privateAnswerTimes={offerHours:24,startMinutes:10} as const;
/** Why a tap or a /start is refused; each is a fixed, editable reply that needs no model. */
export type PrivateAnswerRefusal='only_asker'|'used'|'expired'|'changed'|'not_yours';
export interface PrivateAnswer {id:string;question_event:string;from_chat_id:string;project_id:string;member_id:string|null;asker_account_id:string;
  read_chats:string[]|null;reply_chat_id:string|null;state:PrivateAnswerState;refusal_code:string|null;press_event:string|null;start_event:string|null;
  offered_at:Date;pressed_at:Date|null;answered_at:Date|null;expires_at:Date;send_key:string|null;revision:number}
/** What the group answer offers: the question's event, the group or topic it was asked in, that place's project and
 * who asked (the raw Telegram user ID; `member_id` null for the owner). */
export interface PrivateAnswerOffer {id:string;question_event:string;from_chat_id:string;project_id:string;asker_account_id:string;member_id?:string|null}
/** A tap on the button: who tapped, the captured callback event and the group or topic of the tapped message. */
export interface PrivateAnswerTap {account_id:string;press_event:string;space:string}
/** The /start message in the asker's private chat: who sent it, its event (the private turn's event) and that chat. */
export interface PrivateAnswerStart {account_id:string;start_event:string;reply_chat_id:string}
export type PrivateAnswerOutcome={ok:true;answer:PrivateAnswer}|{ok:false;code:PrivateAnswerRefusal;answer:PrivateAnswer|null};

/** A record's id from the question it answers: deterministic, so a retried reply offers the same button, and checkable
 * by the Telegram service, which holds the same service token. HMAC-SHA256 of `private-answer:<event>`, first 32 hex. */
export function privateAnswerId(secret:string,questionEvent:string):string {
  if(!secret||!/^[a-f0-9]{64}$/.test(questionEvent))throw new HttpError(400,'invalid_private_answer');
  return createHmac('sha256',secret).update('private-answer:'+questionEvent).digest('hex').slice(0,32);
}

const pending=():never=>{throw new HttpError(501,'not_implemented');};

export class PrivateAnswerRepository {
  constructor(readonly control:pg.Pool,readonly policy:()=>AssistantPolicy){}
  /** Records the button under the owner's group answer; repeating it for the same question returns the same row. */
  async offer(input:PrivateAnswerOffer):Promise<PrivateAnswer> {void input;return pending();}
  /** A tap: refuses anyone but the asker, a used or expired row, or a changed project; otherwise freezes the groups. */
  async press(id:string,tap:PrivateAnswerTap):Promise<PrivateAnswerOutcome> {void id;void tap;return pending();}
  /** A /start: takes the row for that one start event, only from the asker and only while the tap is fresh. */
  async claim(id:string,start:PrivateAnswerStart):Promise<PrivateAnswerOutcome> {void id;void start;return pending();}
  /** The server-side read set of an answer reader, from its record on every request; a reader without `answer` is
   * returned as it is. Until it is built, an answer reader is refused (fail closed). */
  async bind(principal:Reader):Promise<Reader> {
    if(principal.answer===undefined)return principal;
    if(!answerId.test(principal.answer))throw new HttpError(409,'private_answer_closed');
    return pending();
  }
  /** The answer was delivered: records its send. */
  async answered(id:string,sendKey:string):Promise<void> {void id;void sendKey;return pending();}
  /** Rows whose button or tap went stale become expired; returns how many. */
  async expire(now:Date=new Date()):Promise<number> {void now;return pending();}
  /** The owner's record of private answers, newest first, optionally for one project; `after` is the last id seen. */
  async list(principal:Reader,query:{project?:unknown;after?:unknown}={}):Promise<{answers:PrivateAnswer[];next:string|null}> {
    admin(principal);
    const project=query.project===undefined||query.project===''?null:query.project,after=query.after===undefined||query.after===''?null:query.after;
    if(project!==null&&(typeof project!=='string'||!/^[a-f0-9]{64}$/.test(project)))throw new HttpError(400,'invalid_project_id');
    if(after!==null&&(typeof after!=='string'||!answerId.test(after)))throw new HttpError(400,'invalid_cursor');
    const {rows}=await this.control.query<PrivateAnswer>(`SELECT * FROM private_answers p WHERE ($1::text IS NULL OR p.project_id=$1)
      AND ($2::text IS NULL OR (p.offered_at,p.id)<(SELECT offered_at,id FROM private_answers WHERE id=$2)) ORDER BY p.offered_at DESC,p.id DESC LIMIT 101`,[project,after]);
    return {answers:rows.slice(0,100),next:rows.length>100?rows[99]!.id:null};
  }
}
