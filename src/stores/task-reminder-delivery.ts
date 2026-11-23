import type pg from 'pg';
import type {ChatDirectory} from '../chats.js';
import {telegramAddress,type TelegramTarget} from '../frontdoor/telegram.js';
import {joinedGroups} from './member-reads.js';
import {memberTaskViews} from './member-task-views.js';
import type {TaskView} from './tasks.js';

/*
 * Who a person's task reminder goes to (step 5, ADR-0265 D9): the reminder goes to whoever set it. The recipient is
 * resolved when the reminder is claimed, from the store as it is now:
 *
 *   set_by_account_id → chat_accounts.member_id → an active member with "Reminders to themselves" (members.reminders) on
 *   → the open private chat of that account with Nocheh (private chat on, never a topic, never the owner's chat or account)
 *   → the task still on one of that member's boards (joinedGroups, then memberTaskViews: its project is one of an active
 *   project holding a group they are in, whatever the task's group and the project's "Share group chats", ADR-0276). As
 *   in the members' app, the member's groups are first asked of Telegram
 *   again (recheckMemberAppGroups, at most once per member every MEMBER_APP_RECHECK_MINUTES, capped) and only those
 *   confirmed within MEMBER_RECHECK_HOURS count; a re-check that cannot run reaches no board.
 *
 * When all of that holds, the reminder goes into that chat, one message per reminder at its time (the member lane: it
 * reaches only the member, so no 10-minute merge). When any of it fails, a reminder a member set in a group goes to the
 * owner as before (ADR-0255, merged per group), and one set in the members' app is skipped, with one line in System ›
 * Health per member per day (an app reminder never falls back to the owner, so the app cannot flood the owner's chat).
 * A guest who is not a member keeps the owner lane. Anything this cannot tell is never the member's chat.
 */

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/** Why a person's reminder cannot reach the member who set it. */
export type ReminderSkipReason='not_member'|'paused'|'reminders_off'|'private_chat_off'|'not_visible';
/** Where one person's reminder goes: the member's own private chat (`chat`, a Nocheh chat id, and where it is in
 * Telegram), the owner (merged per group as before), or nowhere (`skip`, a reminder set in the members' app). */
export type ReminderRecipient={lane:'member';member:string;chat:string;target:TelegramTarget}|{lane:'owner';reason:ReminderSkipReason|null}
  |{lane:'skip';member:string|null;reason:ReminderSkipReason};
/** What recipientOf reads of a reminder: its setter, where it was set ('chat', or 'app' for the members' app) and its
 * task's project and group. */
export interface ReminderSetter {set_by:'owner'|'person';account:string|null;via:'chat'|'app';project:string|null;group:string|null}
/** What resolving reads besides the store: the owner's private chat (null closes every member chat), the chat directory
 * (where each chat is in Telegram), how fresh a group's membership must be (hours; default the member's private chat's
 * own MEMBER_READ_STALE_DAYS), and `recheck`, which asks Telegram again about a member's groups before they are read (a
 * throw leaves that member no board: fail closed). */
export interface RecipientContext {owner:string|null;directory:ChatDirectory;freshHours?:number;
  recheck?:(member:string)=>Promise<void>}

/** One account's side of the chain, resolved once per pass: the member, why it stops, or the chat and boards. */
type Person={member:string|null;reason:ReminderSkipReason|null;chat:string|null;target:TelegramTarget|null;views:readonly TaskView[]};

/** The person behind `account`: their member, its state and switches, the account's own private chat with Nocheh, and
 * the boards that member reads now. Never the owner's account. */
async function personOf(db:Db,account:string,context:RecipientContext):Promise<Person> {
  const none=(reason:ReminderSkipReason,member:string|null=null):Person=>({member,reason,chat:null,target:null,views:[]});
  const owner=context.owner;
  if(owner===null||!/^[a-f0-9]{64}$/.test(account))return none('not_member');
  const row=(await db.query<{member:string|null;state:string|null;reminders:boolean|null;private_chat:boolean|null;chat:string|null}>(`SELECT m.id AS member,
      m.state,m.reminders,m.private_chat,(SELECT c.id FROM chats c WHERE c.account_id=a.id AND c.kind='private' AND c.parent_id IS NULL AND c.id<>$2
        ORDER BY c.id LIMIT 1) AS chat
    FROM chat_accounts a LEFT JOIN members m ON m.id=a.member_id
    WHERE a.id=$1 AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=a.id)`,[account,owner])).rows[0];
  if(!row?.member)return none('not_member');
  if(row.state!=='active')return none('paused',row.member);
  if(row.reminders!==true)return none('reminders_off',row.member);
  if(row.private_chat!==true||!row.chat)return none('private_chat_off',row.member);
  // The chat as this process knows it: a private chat that is not the owner's, with a Telegram id and no topic.
  const known=context.directory.get(row.chat),target=telegramAddress(row.chat,context.directory);
  if(!known||known.kind!=='private'||known.owner||row.chat===context.directory.ownerChat()||!target||target.topic!==undefined)
    return none('private_chat_off',row.member);
  if(context.recheck){try{await context.recheck(row.member);}catch{return none('not_visible',row.member);}}
  const groups=(await joinedGroups(db,row.member,{owner,...(context.freshHours===undefined?{}:{freshHours:context.freshHours})}))
    .filter(group=>group.fresh).map(group=>group.chat);
  return {member:row.member,reason:null,chat:row.chat,target,views:await memberTaskViews(db,groups)};
}

/** Whether a task is on one of these boards: its project is one of theirs, whatever its group (ADR-0276). A personal
 * task (no project) never is. */
const onBoards=(views:readonly TaskView[],task:{project:string|null})=>task.project!==null&&views.some(view=>view.project===task.project);

/** What a person who cannot be reached means for their reminder: the owner for one set in a group or by a guest, a skip
 * for one set in the members' app. */
const unreachable=(setter:ReminderSetter,person:Pick<Person,'member'|'reason'>,reason:ReminderSkipReason):ReminderRecipient=>
  setter.via==='app'?{lane:'skip',member:person.member,reason}:{lane:'owner',reason};

/**
 * Where one reminder goes now (see the top of this file). The owner's own reminders go to the owner. `people` caches each
 * account's side for one pass, so a pass reads each person once however many reminders they set.
 */
export async function recipientOf(db:Db,setter:ReminderSetter,context:RecipientContext,people=new Map<string,Promise<Person>>()):Promise<ReminderRecipient> {
  if(setter.set_by!=='person')return {lane:'owner',reason:null};
  if(!setter.account)return unreachable(setter,{member:null,reason:'not_member'},'not_member');
  let found=people.get(setter.account);
  if(!found){found=personOf(db,setter.account,context);people.set(setter.account,found);}
  const person=await found;
  if(person.reason||!person.member||!person.chat||!person.target)return unreachable(setter,person,person.reason??'not_member');
  if(!onBoards(person.views,setter))return unreachable(setter,person,'not_visible');
  return {lane:'member',member:person.member,chat:person.chat,target:person.target};
}

/** A due person's reminder routed to its setter's private chat: its id and that chat; `resend` when its notice was
 * already authorized by core (the gateway holds it), so the same id goes again for the gateway's receipt. */
export interface MemberSend {id:string;chat:string;target:TelegramTarget;resend:boolean}
/** App reminders skipped in one pass for one member (or account, when no member is left), with the name Telegram showed
 * when they were set and why. */
export interface ReminderSkip {key:string;name:string|null;reason:ReminderSkipReason;count:number}
/** One pass of the lanes: the member lane's sends, the ids that go to the owner merged per group, and the skips. */
export interface ReminderLanes {member:MemberSend[];owner:string[];skipped:ReminderSkip[]}

/** At most this many due people's reminders are routed in one pass; the rest wait for the next one. */
export const REMINDER_ROUTE_LIMIT=500;

/**
 * Routes the due people's reminders of one pass (ADR-0265 D9): each pending one, and each one this lane claimed earlier
 * that is still being sent (state 'sending' with a deliver_chat and no merged message), oldest due first. A claimed one
 * whose notice core already authorized (notice_digest cleared) goes again as it is: the gateway holds it. Any other is
 * resolved again: to its member (`member`), back to waiting for the owner's merged message (`owner`, its claim undone),
 * or, set in the members' app, skipped here (`skipped`). Only an unauthorized claim is undone or skipped, so nothing
 * the gateway may have sent is sent again elsewhere.
 */
export async function memberLane(db:Db,context:RecipientContext,limit=REMINDER_ROUTE_LIMIT):Promise<ReminderLanes> {
  const rows=(await db.query<{id:string;state:string;account:string|null;name:string|null;via:'chat'|'app';deliver_chat:string|null;notice_digest:string|null;
    project:string|null;group:string|null}>(`SELECT r.id,r.state,r.set_by_account_id AS account,r.set_by_name AS name,r.set_via AS via,r.deliver_chat,r.notice_digest,
      t.project_id AS project,t.group_id AS group FROM owner_task_reminders r JOIN owner_tasks t ON t.id=r.task_id
    WHERE r.set_by='person' AND r.remind_at<=now() AND r.batch_id IS NULL AND (r.state='pending' OR r.state='sending' AND r.deliver_chat IS NOT NULL)
    ORDER BY r.remind_at,r.id LIMIT $1`,[Math.max(1,Math.floor(limit))])).rows;
  const people=new Map<string,Promise<Person>>(),lanes:ReminderLanes={member:[],owner:[],skipped:[]},skips=new Map<string,ReminderSkip>();
  for(const row of rows) {
    if(row.state==='sending'&&row.notice_digest===null) {
      // Core said yes to this notice already: only the same id again, to the same chat, finds out what happened.
      const target=telegramAddress(row.deliver_chat,context.directory);
      if(target)lanes.member.push({id:row.id,chat:row.deliver_chat!,target,resend:true});
      continue;
    }
    const to=await recipientOf(db,{set_by:'person',account:row.account,via:row.via==='app'?'app':'chat',project:row.project,group:row.group},context,people);
    if(to.lane==='member'){lanes.member.push({id:row.id,chat:to.chat,target:to.target,resend:false});continue;}
    if(to.lane==='owner') {
      if(row.state==='sending'&&!(await db.query(`UPDATE owner_task_reminders SET state='pending',deliver_chat=NULL,notice_digest=NULL
        WHERE id=$1 AND state='sending' AND batch_id IS NULL AND notice_digest IS NOT NULL`,[row.id])).rowCount)continue;
      lanes.owner.push(row.id);continue;
    }
    const skipped=(await db.query(`UPDATE owner_task_reminders SET state='skipped',deliver_chat=NULL,notice_digest=NULL
      WHERE id=$1 AND batch_id IS NULL AND (state='pending' OR state='sending' AND notice_digest IS NOT NULL)`,[row.id])).rowCount??0;
    if(!skipped)continue;
    const key=to.member??'account:'+(row.account??'none'),entry=skips.get(key)??{key,name:row.name,reason:to.reason,count:0};
    entry.count++;entry.reason=to.reason;skips.set(key,entry);
  }
  lanes.skipped=[...skips.values()];
  return lanes;
}

/** Why, in the owner's words, for the Health line. */
const skipWhy:Record<ReminderSkipReason,string>={
  not_member:'they are no longer a member',
  paused:'they are paused',
  reminders_off:'“Reminders to themselves” is off for them',
  private_chat_off:'their private chat with Nocheh is off',
  not_visible:'the task is no longer on their boards',
};
/**
 * The System › Health line for a member's skipped app reminders, as one and as many ({count} is filled in when the day's
 * total is known): "2 reminders “Mira” set in the members’ app were not sent: their private chat with Nocheh is off."
 * `name` is shown quoted and isolated; a member Nocheh cannot name is "a member".
 */
export function skippedLine(skip:Pick<ReminderSkip,'name'|'reason'>,quoted:(name:string)=>string|null):{one:string;many:string} {
  const who=(skip.name?quoted(skip.name):null)??'a member',why=skipWhy[skip.reason];
  return {one:`1 reminder ${who} set in the members’ app was not sent: ${why}.`,many:`{count} reminders ${who} set in the members’ app were not sent: ${why}.`};
}
/** The Health record's reference for one member's skips on one UTC day: one line per member per day. */
export const skippedReference=(key:string,now=new Date())=>'reminders-skipped:'+key+':'+now.toISOString().slice(0,10);

/**
 * Core's one-time yes for a member's reminder (POST /internal/notices/authorize, ADR-0265 D10): nocheh-telegram asks
 * before it sends a notice to any chat but the owner's private chat. Allowed only when the reminder with that id is a
 * person's, being sent in the member lane (state 'sending', no merged message), its notice_digest is the digest of the
 * exact text asked about, its deliver_chat is still the open private chat of the account that set it (an active member
 * with private chat and "Reminders to themselves" on, never a topic, never the owner's chat or account), and that chat
 * is in Telegram the very chat asked about, with no topic. The yes clears notice_digest in the same statement that checks
 * it, so a second ask for the same id, or one for another text, is never allowed. Anything else, a chat this process
 * does not know included, is false.
 */
export async function authorizeNotice(db:Db,request:{id:string;chat:string;text_digest:string},directory:ChatDirectory):Promise<boolean> {
  const owner=directory.ownerChat();
  if(owner===null)return false;
  const row=(await db.query<{chat:string}>(`SELECT r.deliver_chat AS chat FROM owner_task_reminders r JOIN chats c ON c.id=r.deliver_chat
      JOIN chat_accounts a ON a.id=c.account_id AND a.id=r.set_by_account_id JOIN members m ON m.id=a.member_id
    WHERE r.id=$1 AND r.state='sending' AND r.batch_id IS NULL AND r.set_by='person' AND r.notice_digest=$2
      AND c.kind='private' AND c.parent_id IS NULL AND c.id<>$3 AND m.state='active' AND m.private_chat AND m.reminders
      AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$3 AND o.account_id=a.id)`,[request.id,request.text_digest,owner])).rows[0];
  if(!row)return false;
  const known=directory.get(row.chat),target=telegramAddress(row.chat,directory);
  if(!known||known.kind!=='private'||known.owner||!target||target.topic!==undefined||target.chat_id!==request.chat)return false;
  return ((await db.query(`UPDATE owner_task_reminders SET notice_digest=NULL WHERE id=$1 AND state='sending' AND batch_id IS NULL AND deliver_chat=$2
    AND notice_digest=$3`,[request.id,row.chat,request.text_digest])).rowCount??0)===1;
}
