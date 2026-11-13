import type pg from 'pg';
import {createHmac} from 'node:crypto';
import {admin,answerId,type Reader} from '../access.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import {groupChatId,groupSpace,groupSpaceSql,parentSpace,readSet} from '../spaces.js';
import {projectGroups,projectGroupsSql} from './project-groups.js';

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
/** An unused button expires a day after it is offered; a tap must be followed by /start within ten minutes; a claimed
 * answer has an hour to be delivered. */
export const privateAnswerTimes={offerHours:24,startMinutes:10,answerMinutes:60} as const;
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

type Database=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;
const closed=()=>new HttpError(409,'private_answer_closed');
const event=/^[a-f0-9]{64}$/,account=/^[1-9][0-9]{0,18}$/;
/** What a tap, a /start or a refusal tells the caller, with the row as it now stands. */
const outcome=(row:PrivateAnswer|null,code?:PrivateAnswerRefusal):PrivateAnswerOutcome=>code?{ok:false,code,answer:row}:{ok:true,answer:row!};
/** What a refused row tells a later tap or /start: an answer that never arrived is as good as expired; anything else changed. */
const refusedAs=(row:PrivateAnswer):PrivateAnswerRefusal=>row.refusal_code==='not_delivered'?'expired':'changed';

/**
 * The server-side read set of an answer reader, from its record (ADR-0248). The row must be the one the pass names,
 * claimed by this very turn (its /start event), pressed or answered, inside its time and answered in the asker's private
 * chat, and its project must still be active. The frozen groups are narrowed to the groups Nocheh still serves that are
 * still in that project; a member's groups are also narrowed to the groups they are still in (step 4; the owner is in
 * every group). The asking group must be one of them. Anything else is private_answer_closed: an answer reader never
 * reads without its record, and a later change only narrows or closes it.
 */
export async function bindAnswerReads(db:Database,policy:AssistantPolicy,principal:Reader):Promise<Reader> {
  if(principal.answer===undefined)return principal;
  if(!answerId.test(principal.answer)||principal.admin||principal.scope===null||principal.space!==principal.scope||!principal.turnEvent||!event.test(principal.turnEvent))throw closed();
  if(!policy.enabled||!policy.owner_id)throw closed();
  // The record is `answer`: projectGroupsSql names its own assignments `project_group`.
  const row=(await db.query<PrivateAnswer&{project_groups:string[]}>(`SELECT answer.*,${projectGroupsSql('answer.project_id','$4')} AS project_groups
    FROM private_answers answer JOIN projects p ON p.id=answer.project_id AND p.state='active'
    WHERE answer.id=$1 AND answer.start_event=$2 AND answer.reply_chat_id=$3 AND answer.state IN ('pressed','answered') AND answer.expires_at>now()`,
    [principal.answer,principal.turnEvent,principal.scope,[...new Set(policy.group_ids)].filter(groupChatId)])).rows[0];
  if(!row||!row.read_chats)throw closed();
  const inProject=new Set(row.project_groups);
  const whole=joinedGroups(policy,row,row.read_chats.filter(group=>inProject.has(group))),home=parentSpace(row.from_chat_id)??row.from_chat_id;
  if(!whole.includes(home))throw closed();
  return {...principal,reads:readSet({home:row.from_chat_id,whole,project:row.project_id})};
}
/** The groups of `groups` the asker may read now: served groups only, and for the owner (member_id null) every one of
 * them. A member's groups come in step 4, from their current membership; until then a member reads none. */
function joinedGroups(policy:AssistantPolicy,row:Pick<PrivateAnswer,'member_id'|'asker_account_id'>,groups:readonly string[]):string[] {
  const served=groups.filter(group=>groupChatId(group)&&policy.group_ids.includes(group));
  return row.member_id===null&&row.asker_account_id===policy.owner_id?[...new Set(served)].sort():[];
}

export class PrivateAnswerRepository {
  constructor(readonly control:pg.Pool,readonly policy:()=>AssistantPolicy){}
  /**
   * The project a group or topic answer may offer the button for, and that project's groups, as projectGroups gives
   * them: the asking group is served and assigned to an active project that has at least one other served group.
   * Null otherwise, which means no button. A topic follows its group's project.
   */
  async offerable(space:string,db:Database=this.control):Promise<{project_id:string;groups:string[]}|null> {
    const policy=this.policy(),group=parentSpace(space)??space;
    if(!policy.enabled||!policy.owner_id||!groupSpace(space)||!groupChatId(group)||!policy.group_ids.includes(group))return null;
    const row=(await db.query(`SELECT a.project_id FROM project_assignments a JOIN projects p ON p.id=a.project_id
      WHERE a.space_id=$1 AND a.mode='assigned' AND p.state='active'`,[group])).rows[0];
    if(!row)return null;
    const groups=await projectGroups(db,row.project_id,policy.group_ids);
    return groups.includes(group)&&groups.length>1?{project_id:row.project_id,groups}:null;
  }
  /** Records the button under the owner's group answer; repeating it for the same question returns the same row. A new
   * row needs a question the owner asked (step 2; members get the button in step 4) and the place to be offerable for
   * that project now; an existing one is returned as it is, and a tap checks it again. */
  async offer(input:PrivateAnswerOffer):Promise<PrivateAnswer> {
    const member=input.member_id??null;
    if(!answerId.test(input.id)||!event.test(input.question_event)||!groupSpace(input.from_chat_id)||!event.test(input.project_id)||
      !account.test(input.asker_account_id)||member!==null)throw new HttpError(400,'invalid_private_answer');
    const same=(row:PrivateAnswer|undefined)=>{
      if(row&&(row.id!==input.id||row.from_chat_id!==input.from_chat_id||row.asker_account_id!==input.asker_account_id||row.member_id!==member))
        throw new HttpError(409,'private_answer_conflict');
      return row;
    };
    const existing=same((await this.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE question_event=$1',[input.question_event])).rows[0]);
    if(existing)return existing;
    if(input.asker_account_id!==this.policy().owner_id||(await this.offerable(input.from_chat_id))?.project_id!==input.project_id)
      throw new HttpError(409,'private_answer_unavailable');
    await this.control.query(`INSERT INTO private_answers(id,question_event,from_chat_id,project_id,member_id,asker_account_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7)) ON CONFLICT DO NOTHING`,
      [input.id,input.question_event,input.from_chat_id,input.project_id,member,input.asker_account_id,privateAnswerTimes.offerHours]);
    const saved=same((await this.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE question_event=$1',[input.question_event])).rows[0]);
    if(!saved)throw new HttpError(409,'private_answer_conflict');
    return saved;
  }
  /** One row under lock, for a tap or a /start, and whether its time is up by the database's clock; the work runs
   * inside the transaction. */
  private async locked(id:string,work:(db:pg.PoolClient,row:PrivateAnswer|null,stale:boolean)=>Promise<PrivateAnswerOutcome>):Promise<PrivateAnswerOutcome> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const found=answerId.test(id)?(await db.query<PrivateAnswer&{stale:boolean}>('SELECT *,expires_at<=now() AS stale FROM private_answers WHERE id=$1 FOR UPDATE',[id])).rows[0]:undefined;
      const {stale,...row}=found??{stale:false};
      const result=await work(db,found?row as PrivateAnswer:null,stale);
      await db.query('COMMIT');return result;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  private async update(db:pg.PoolClient,id:string,set:string,values:unknown[]=[]):Promise<PrivateAnswer> {
    return (await db.query<PrivateAnswer>(`UPDATE private_answers SET ${set},revision=revision+1 WHERE id=$1 RETURNING *`,[id,...values])).rows[0]!;
  }
  private async expired(db:pg.PoolClient,row:PrivateAnswer):Promise<PrivateAnswerOutcome> {
    return outcome(await this.update(db,row.id,"state='expired'"),'expired');
  }
  /** The project and groups this row may still read, or null when the project changed: it is no longer active, the asking
   * group left it or is no longer served, or no other group the asker may read is left in it. */
  private async current(db:pg.PoolClient,row:PrivateAnswer):Promise<string[]|null> {
    const now=await this.offerable(row.from_chat_id,db);
    if(!now||now.project_id!==row.project_id)return null;
    const groups=joinedGroups(this.policy(),row,now.groups);
    return groups.length>1&&groups.includes(parentSpace(row.from_chat_id)??row.from_chat_id)?groups:null;
  }
  /**
   * A tap. Only the asker may tap; anyone else gets only_asker and the row is unchanged. An answered row is used, a
   * refused one changed and a stale one expired. A valid tap on an offered row checks the project again and freezes its
   * groups: every served group of the project that the asker may read, the asking group included (for the owner, all of
   * them). The asker then has ten minutes to send /start. Tapping again while that window is open returns the same row
   * without freezing again.
   */
  async press(id:string,tap:PrivateAnswerTap):Promise<PrivateAnswerOutcome> {
    if(!account.test(tap.account_id)||!event.test(tap.press_event)||!groupSpace(tap.space))throw new HttpError(400,'invalid_private_answer');
    return this.locked(id,async(db,row,stale)=>{
      if(!row)return outcome(null,'expired');
      if(row.asker_account_id!==tap.account_id)return outcome(row,'only_asker');
      // The button sits under the group answer, so a tap from anywhere else is refused and changes nothing.
      if((parentSpace(tap.space)??tap.space)!==(parentSpace(row.from_chat_id)??row.from_chat_id))return outcome(row,'changed');
      if(row.state==='answered')return outcome(row,'used');
      if(row.state==='refused')return outcome(row,refusedAs(row));
      if(row.state==='expired')return outcome(row,'expired');
      if(stale)return this.expired(db,row);
      if(row.state==='pressed')return row.start_event===null?outcome(row):outcome(row,'used');
      const groups=await this.current(db,row);
      if(!groups)return outcome(await this.update(db,row.id,"state='refused',refusal_code='changed'"),'changed');
      return outcome(await this.update(db,row.id,`state='pressed',read_chats=$2,press_event=$3,pressed_at=now(),
        expires_at=now()+make_interval(mins=>$4)`,[groups,tap.press_event,privateAnswerTimes.startMinutes]));
    });
  }
  /**
   * A /start in the asker's private chat. It takes a pressed row for that one start event, only from the asker, only
   * in the asker's own private chat and only within ten minutes of the tap. The project must still hold the asking
   * group, and the frozen groups are narrowed to the groups still in it, never widened: when no other frozen group is
   * left, the row is refused as changed. The answer then has an hour to be delivered. The same start event claims the
   * same row again, so a retried turn reads the same groups. Any other /start gets why the row is closed: used only
   * once it was answered or while another /start's answer is on its way, else changed or expired.
   */
  async claim(id:string,start:PrivateAnswerStart):Promise<PrivateAnswerOutcome> {
    if(!account.test(start.account_id)||!event.test(start.start_event)||!account.test(start.reply_chat_id))throw new HttpError(400,'invalid_private_answer');
    return this.locked(id,async(db,row,stale)=>{
      if(!row)return outcome(null,'expired');
      if(row.asker_account_id!==start.account_id||start.reply_chat_id!==start.account_id)return outcome(row,'not_yours');
      if(row.state==='refused')return outcome(row,refusedAs(row));
      if(row.state==='answered')return outcome(row,row.start_event===start.start_event&&!stale?undefined:'used');
      // A row never tapped, or expired, has no open /start.
      if(row.state!=='pressed')return outcome(row,'expired');
      if(stale)return this.expired(db,row);
      if(row.start_event!==null)return row.start_event===start.start_event?outcome(row):outcome(row,'used');
      const now=await this.current(db,row),groups=row.read_chats!.filter(group=>now?.includes(group));
      if(groups.length<2||!groups.includes(parentSpace(row.from_chat_id)??row.from_chat_id))
        return outcome(await this.update(db,row.id,"state='refused',refusal_code='changed'"),'changed');
      return outcome(await this.update(db,row.id,`start_event=$2,reply_chat_id=$3,read_chats=$5,expires_at=now()+make_interval(mins=>$4)`,
        [start.start_event,start.reply_chat_id,privateAnswerTimes.answerMinutes,groups]));
    });
  }
  /** The server-side read set of an answer reader, from its record on every request (bindAnswerReads); a reader without
   * `answer` is returned as it is. */
  async bind(principal:Reader):Promise<Reader> {return bindAnswerReads(this.control,this.policy(),principal);}
  /** The answer was delivered: records its send. Repeating it with the same send changes nothing. */
  async answered(id:string,sendKey:string):Promise<void> {
    if(!answerId.test(id)||typeof sendKey!=='string'||!sendKey||sendKey.length>200)throw new HttpError(400,'invalid_private_answer');
    const {rowCount}=await this.control.query(`UPDATE private_answers SET state='answered',answered_at=now(),send_key=$2,revision=revision+1
      WHERE id=$1 AND state='pressed' AND start_event IS NOT NULL`,[id,sendKey]);
    if(rowCount)return;
    if(!(await this.control.query("SELECT 1 FROM private_answers WHERE id=$1 AND state='answered' AND send_key=$2",[id,sendKey])).rowCount)throw closed();
  }
  /**
   * The answer this /start claimed will not arrive: its turn ended without a reply, or its record closed before or while
   * it ran. A row still pressed for that start closes, expired once its hour is up, else refused with `code`, so a later
   * tap or /start says why rather than "already answered". Returns the row as it now stands for that start, or null
   * when that start claimed none; repeating it changes nothing.
   */
  async undelivered(id:string,startEvent:string,code:'changed'|'not_delivered'):Promise<PrivateAnswer|null> {
    if(!answerId.test(id)||!event.test(startEvent))throw new HttpError(400,'invalid_private_answer');
    const closed=(await this.control.query<PrivateAnswer>(`UPDATE private_answers SET state=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'refused' END,
      refusal_code=CASE WHEN expires_at<=now() THEN NULL ELSE $3 END,revision=revision+1
      WHERE id=$1 AND start_event=$2 AND state='pressed' RETURNING *`,[id,startEvent,code])).rows[0];
    return closed??(await this.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE id=$1 AND start_event=$2',[id,startEvent])).rows[0]??null;
  }
  /** The group reply that carried a button did not go out: its untapped row is refused as not_delivered, so the record
   * never lists a button nobody saw as waiting for a tap. */
  async unshown(questionEvent:string):Promise<void> {
    if(!event.test(questionEvent))throw new HttpError(400,'invalid_private_answer');
    await this.control.query(`UPDATE private_answers SET state='refused',refusal_code='not_delivered',revision=revision+1
      WHERE question_event=$1 AND state='offered'`,[questionEvent]);
  }
  /** Rows whose button, tap or answer went stale become expired; returns how many. An unused button lasts a day, a tap
   * ten minutes without /start, and a claimed answer an hour. Rows are the record: they are never deleted here. */
  async expire(now:Date=new Date()):Promise<number> {
    return (await this.control.query(`UPDATE private_answers SET state='expired',revision=revision+1
      WHERE state IN ('offered','pressed','needs_private_chat') AND expires_at<=$1`,[now])).rowCount??0;
  }
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

/**
 * The routes an answer reader may call: reads only (ADR-0248). Archive search, read and page; plain long-term memory
 * search and the turn's memory context (limited for an answer reader); the asking group's shared and granted context;
 * the delivery check; the task list in read mode; context preparation; the turn's own files; and, at the broker, its
 * binding, guard preparation and model calls. Every other route, every write and every post among them, is refused
 * with private_answer_read_only, including in_turn notes and owner views. One list for the storage service and the
 * broker, so neither lets more through than the other.
 */
const answerRoutes:readonly [string,RegExp][]=[
  ['GET',/^\/v1\/(?:search|archive\/page|imports\/pending|events\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64}\/bytes|memory\/check|memory\/context|memory\/(?:shared|filtered)\/[a-f0-9]{64}|owner\/tasks(?:\/[a-f0-9]{64})?|security\/binding|turn-files\/[a-f0-9]{64})$/],
  ['POST',/^\/(?:mcp|v1\/(?:context\/prepare|memory\/longterm\/(?:search|context)|guard|chat\/completions)|anthropic\/v1\/messages)$/],
];
export function privateAnswerRoute(method:string,path:string):boolean {return answerRoutes.some(([verb,route])=>verb===method&&route.test(path));}
/** Refuses an answer reader's call to anything but a read route (privateAnswerRoute). */
export function assertPrivateAnswerRoute(principal:Reader,method:string|undefined,path:string):void {
  if(principal.answer!==undefined&&!privateAnswerRoute(method??'',path))throw new HttpError(403,'private_answer_read_only');
}
/** The data tools an answer reader is offered and may run, each in read mode only; tasks lists and reads, never writes. */
export const privateAnswerTools:ReadonlySet<string>=new Set(['archive_search','archive_read','archive_page','memory_search','tasks']);
export const privateAnswerTaskActions:ReadonlySet<string>=new Set(['list','get']);
