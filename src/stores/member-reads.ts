import type pg from 'pg';
import {chats} from '../chats.js';
import type {RuntimeCall} from '../runtime.js';
import {servedGroups} from '../spaces.js';
import {membershipChecked} from './chats.js';

/*
 * What a member reads in their own private chat with Nocheh (step 4, ADR-0262), resolved in SQL so both processes that
 * bind readers (nocheh-app and nocheh-security) answer the same without a member directory: only the chat directory,
 * which both hold, says which chats are served and which private chat is the owner's.
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

/**
 * The reads of `chat` when it is a member's own private chat that is open now, else null. A chat counts when it is a
 * chats row of kind private (never a topic), not the owner's, whose account is linked to a member that is active with
 * private_chat on. Its groups are the served groups where member_chats.enabled is not false and the newest
 * chat_memberships row of one of the member's accounts says 'in' with checked_at within MEMBER_READ_STALE_DAYS. Group
 * talk does not count. Never throws for an unknown or closed chat: null, which callers refuse as memberChatClosed.
 */
export async function memberReads(db:Db,chat:string):Promise<MemberReads|null> {
  const directory=chats(),row=directory.get(chat);
  // The chat directory decides what a chat is (ADR-0252): a member's chat is a private chat itself that is not the owner's.
  if(!row||row.kind!=='private'||row.owner||row.account_id===null)return null;
  const owner=directory.get(directory.ownerChat())?.account_id??null;
  if(owner!==null&&row.account_id===owner)return null;
  const found=(await db.query<{member:string}>(`SELECT m.id AS member FROM chats c JOIN chat_accounts a ON a.id=c.account_id
    JOIN members m ON m.id=a.member_id WHERE c.id=$1 AND c.kind='private' AND c.account_id=$2 AND m.state='active' AND m.private_chat`,
    [chat,row.account_id])).rows[0];
  if(!found)return null;
  const groups=servedGroups();
  if(!groups.length)return {member:found.member,chat,groups:[]};
  // Per group, the newest row of any of the member's accounts (the owner's account never counts as theirs).
  const rows=(await db.query<{chat:string;checked_at:Date}>(`SELECT g.chat_id AS chat,g.checked_at FROM (
      SELECT DISTINCT ON (p.chat_id) p.chat_id,p.state,p.checked_at FROM chat_memberships p JOIN chat_accounts a ON a.id=p.account_id
      WHERE a.member_id=$1 AND ($3::text IS NULL OR a.id<>$3) AND p.chat_id=ANY($2::text[])
      ORDER BY p.chat_id,p.checked_at DESC NULLS LAST,p.since DESC) g
    WHERE g.state='in' AND g.checked_at IS NOT NULL AND g.checked_at>now()-make_interval(days=>$4)
      AND NOT EXISTS(SELECT 1 FROM member_chats s WHERE s.member_id=$1 AND s.chat_id=g.chat_id AND NOT s.enabled)
    ORDER BY g.chat_id`,[found.member,groups,owner,MEMBER_READ_STALE_DAYS])).rows;
  return {member:found.member,chat,groups:Object.freeze(rows.map(item=>Object.freeze({chat:item.chat,checked_at:item.checked_at})))};
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
