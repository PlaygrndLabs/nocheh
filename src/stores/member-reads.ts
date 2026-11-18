import type pg from 'pg';

/*
 * What a member reads in their own private chat with Nocheh (step 4, ADR-0262), resolved in SQL so both processes that
 * bind readers (nocheh-app and nocheh-security) answer the same without a member directory.
 *
 * The signature is the step 4 contract; part B writes the query. Until then it admits nothing: every member chat is
 * closed (fail closed).
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
 * chats row of kind private, not the owner's, whose account is linked to a member that is active with private_chat on.
 * Its groups are the served groups where member_chats.enabled is not false and the newest chat_memberships row of one
 * of the member's accounts says 'in' with checked_at within MEMBER_READ_STALE_DAYS. Group talk does not count.
 * Never throws for an unknown or closed chat: null, which callers refuse as memberChatClosed.
 */
export async function memberReads(db:Db,chat:string):Promise<MemberReads|null> {
  void db;void chat;
  return null;
}
