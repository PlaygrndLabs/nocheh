import type pg from 'pg';
import {chats} from '../chats.js';
import type {RuntimeCall} from '../runtime.js';
import {membershipChecked} from './chats.js';

/*
 * What a member reads in their own private chat with Nocheh (step 4, ADR-0262), resolved in SQL so both processes that
 * bind readers (nocheh-app and nocheh-security) answer the same without a member directory. Also what the owner's ask
 * about a member (step 4b) reads: that member's own private chat, and nothing else.
 *
 * Both answer from the control store as it is now, for every request: a member paused, removed or switched off, a group
 * left, switched off or no longer served, or an ask answered or expired closes or narrows the reads at the next request.
 * Anything this cannot tell is closed (null), never widened.
 */

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/** One group a member reads from their private chat, with when Telegram's newest 'in' row for one of their accounts
 * there was last confirmed (chat_memberships.checked_at). */
export interface MemberReadGroup {readonly chat:string;readonly checked_at:Date}
/** A member's own private chat and the groups it reads, sorted by chat id. */
export interface MemberReads {readonly member:string;readonly chat:string;readonly groups:readonly MemberReadGroup[]}
/** Refused when a chat is not, or no longer, an open member private chat: 409. */
export const memberChatClosed='member_chat_closed';
/** A membership row older than this no longer counts as 'in' (D5): the member is left out of that group. */
export const MEMBER_READ_STALE_DAYS=30;
/** Before a private turn, joined groups confirmed longer ago than this are asked again (telegram.member_status). */
export const MEMBER_RECHECK_HOURS=6;
/** At most this many groups are asked again before one private turn; the rest that needed it are left out of it. */
export const MEMBER_RECHECK_LIMIT=10;

/** The owner's private chat as this process's chat directory holds it; null when it holds none, which closes every
 * member chat (a chat that might be the owner's is never a member's). */
const ownerChatNow=()=>chats().ownerChat();

/**
 * SQL for the open member private chat `$1`, given the owner's private chat as `$2`: its row with the member it belongs
 * to (`member`) when it is a private chat itself (never a topic), not the owner's chat, of a person who is not the
 * owner's account, linked to a member that is active with private chat on. Group talk and the group switches do not
 * count (design: group talk off does not stop private chat).
 */
const openMemberChat=`SELECT c.id AS chat,m.id AS member FROM chats c JOIN chat_accounts a ON a.id=c.account_id JOIN members m ON m.id=a.member_id
  WHERE c.id=$1 AND c.kind='private' AND c.parent_id IS NULL AND c.id<>$2 AND m.state='active' AND m.private_chat
    AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=c.account_id)`;

/**
 * The reads of `chat` when it is a member's own private chat that is open now, else null. A chat counts when it is a
 * chats row of kind private, not the owner's, whose account is linked to a member that is active with private_chat on.
 * Its groups are the served groups where member_chats.enabled is not false and the newest chat_memberships row of one
 * of the member's accounts says 'in' with checked_at within MEMBER_READ_STALE_DAYS. Group talk does not count.
 * Never throws for an unknown or closed chat: null, which callers refuse as memberChatClosed.
 *
 * `owner` is the owner's private chat (default: this process's chat directory); without one every chat is closed.
 */
export async function memberReads(db:Db,chat:string,owner:string|null=ownerChatNow()):Promise<MemberReads|null> {
  if(typeof chat!=='string'||!chat||owner===null||chat===owner)return null;
  // A chat this process knows as anything but a private chat that is not the owner's is never a member's; one it does not
  // know yet is asked of the store, which decides by its own rows.
  const known=chats().get(chat);
  if(known&&(known.kind!=='private'||known.owner))return null;
  const rows=(await db.query<{chat:string;member:string;group:string|null;checked_at:Date|null}>(`WITH own AS (${openMemberChat}),
    accounts AS (SELECT a.id FROM chat_accounts a JOIN own ON a.member_id=own.member
      WHERE NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=a.id)),
    newest AS (SELECT DISTINCT ON (s.chat_id) s.chat_id,s.state,s.checked_at FROM chat_memberships s WHERE s.account_id IN (SELECT id FROM accounts)
      ORDER BY s.chat_id,s.checked_at DESC NULLS LAST,s.since DESC)
    SELECT own.chat,own.member,n.chat_id AS group,n.checked_at FROM own LEFT JOIN newest n ON n.state='in' AND n.checked_at IS NOT NULL
      AND n.checked_at>now()-make_interval(days=>$3::int)
      AND EXISTS(SELECT 1 FROM chats g WHERE g.id=n.chat_id AND g.kind='group' AND g.parent_id IS NULL AND g.state='active')
      AND NOT EXISTS(SELECT 1 FROM member_chats w WHERE w.member_id=own.member AND w.chat_id=n.chat_id AND NOT w.enabled)`,
    [chat,owner,MEMBER_READ_STALE_DAYS])).rows;
  if(!rows.length)return null;
  const groups=rows.filter(row=>row.group!==null).map(row=>({chat:row.group!,checked_at:row.checked_at!}))
    .sort((a,b)=>a.chat<b.chat?-1:a.chat>b.chat?1:0);
  return {member:rows[0]!.member,chat:rows[0]!.chat,groups:Object.freeze(groups.map(group=>Object.freeze(group)))};
}

/** What the owner's ask about a member reads (step 4b): the ask, the owner's message that asked it (`event`), its member
 * and that member's own private chat. */
export interface MemberAskReads {readonly ask:string;readonly event:string;readonly member:string;readonly chat:string}
/**
 * The reads of the owner's ask `ask` when it is running and inside its time: the asked member's own private chat, open
 * now as memberReads opens it (the member active with private chat on). A member with no such chat, or with more than
 * one (several accounts), reads nothing: null, refused as memberChatClosed. The ask reads no group: only that chat.
 */
export async function memberAskReads(db:Db,ask:string,owner:string|null=ownerChatNow()):Promise<MemberAskReads|null> {
  if(typeof ask!=='string'||!/^[a-f0-9]{32}$/.test(ask)||owner===null)return null;
  const rows=(await db.query<{chat:string;member:string;event:string}>(`SELECT c.id AS chat,m.id AS member,k.owner_event AS event FROM owner_member_asks k JOIN members m ON m.id=k.member_id
    JOIN chat_accounts a ON a.member_id=m.id JOIN chats c ON c.account_id=a.id
    WHERE k.id=$1 AND k.state='running' AND k.expires_at>now() AND m.state='active' AND m.private_chat
      AND c.kind='private' AND c.parent_id IS NULL AND c.id<>$2 AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=a.id)
    ORDER BY c.id`,[ask,owner])).rows;
  if(rows.length!==1)return null;
  const known=chats().get(rows[0]!.chat);
  if(known&&(known.kind!=='private'||known.owner))return null;
  return {ask,event:rows[0]!.event,member:rows[0]!.member,chat:rows[0]!.chat};
}

/**
 * Which of a member's groups to ask Telegram about again before a private turn (D5): those confirmed longer ago than
 * MEMBER_RECHECK_HOURS, oldest first, at most MEMBER_RECHECK_LIMIT (`ask`); the rest that needed it (`past`) are left out
 * of that turn.
 */
export function memberRechecks(reads:Pick<MemberReads,'groups'>,now=Date.now()):{ask:string[];past:string[]} {
  const due=reads.groups.filter(group=>now-group.checked_at.getTime()>MEMBER_RECHECK_HOURS*3600000)
    .sort((a,b)=>a.checked_at.getTime()-b.checked_at.getTime()||(a.chat<b.chat?-1:a.chat>b.chat?1:0)).map(group=>group.chat);
  return {ask:due.slice(0,MEMBER_RECHECK_LIMIT),past:due.slice(MEMBER_RECHECK_LIMIT)};
}

/** What Telegram says of a person in a group, as the bot's telegram.member_status answers: 'in' or 'left' ('kicked' and
 * a restricted person who is not a member count as left), or null for anything it cannot tell, which changes nothing. */
export function memberStatus(answer:unknown):'in'|'left'|null {
  if(answer===null||typeof answer!=='object'||Array.isArray(answer))return null;
  const {state,status}=answer as Record<string,unknown>;
  if(state!==undefined&&state!=='done')return null;
  return status==='in'||status==='left'?status:null;
}

/**
 * Before a member's private turn (D5): asks Telegram (telegram.member_status) about each group memberRechecks names, for
 * the account whose newest row there says 'in', and writes the answer (membershipChecked: source 'checked', checked_at
 * now). 'left' moves the member revision. A call that fails or an answer it cannot read changes nothing. Returns the
 * groups that needed a check past the cap (left out of this turn) and whether any membership moved.
 */
export async function recheckMemberGroups(control:pg.Pool,call:RuntimeCall,reads:MemberReads,now=Date.now()):Promise<{past:string[];moved:boolean}> {
  const {ask,past}=memberRechecks(reads,now);let moved=false;
  const owner=chats().get(chats().ownerChat())?.account_id??null;
  for(const group of ask) {
    const target=chats().appIds(group);if(!target||target.app!=='telegram')continue;
    const account=(await control.query<{id:string;external_id:string}>(`SELECT a.id,a.external_id FROM chat_memberships p
      JOIN chat_accounts a ON a.id=p.account_id JOIN chat_connections n ON n.id=a.connection_id AND n.app='telegram'
      WHERE a.member_id=$1 AND ($3::text IS NULL OR a.id<>$3) AND p.chat_id=$2 AND p.state='in'
      ORDER BY p.checked_at DESC NULLS LAST,a.id LIMIT 1`,[reads.member,group,owner])).rows[0];
    if(!account)continue;
    let state:'in'|'left'|null;
    try{state=memberStatus(await call('telegram.member_status',{chat_id:target.chat,user_id:account.external_id},10000));}catch{state=null;}
    if(state===null)continue;
    moved=await membershipChecked(control,group,account.id,state)||moved;
  }
  return {past,moved};
}
