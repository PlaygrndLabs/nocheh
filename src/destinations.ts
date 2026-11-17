import {telegramAccount,type AssistantPolicy} from './assistant-policy.js';
import {chats,type ChatDirectory} from './chats.js';
import {members,type MemberPermission} from './members.js';

/*
 * The chats Nocheh sends to (Risk 3, ADR-0254): the owner's private chat and its topics, the selected groups and their
 * topics, and the private chats of members who reach a served group (step 3). Everything else, a stranger's private
 * chat, a group the owner did not select or turned off, and a chat the directory does not know, is not served. This
 * reads the chat directory and the member directory only; it never reads an id's shape.
 */

/** A chat Nocheh serves as a destination: the owner's, a selected group's (its group), or a member's (their account,
 * and the served groups they reach, sorted). */
export type Destination={kind:'owner'}|{kind:'group';group:string}|{kind:'person';account:string;groups:readonly string[]};

/**
 * Whether a person (a raw app user id), not the owner, reaches `group` as a member, for a decision made without a live
 * message from that group: a running job, a post into another group, a card's presser. members().reaches: the group is
 * served, the member active with talk on, the group's switch on or never set, the permission on when one is named, and
 * Telegram's newest row for one of their accounts there says 'in' (no row, or 'left', is not reached). Callers check the
 * owner first.
 */
export function allowedIn(group:string,user:string,permission:MemberPermission|null=null,directory:ChatDirectory=chats()):boolean {
  return members().reaches(telegramAccount(user),group,permission,directory);
}

/** Every member account that reaches a served group, with the served groups it reaches, sorted (members().accounts). */
export function allowedAccounts(directory:ChatDirectory=chats()):ReadonlyMap<string,readonly string[]> {
  return members().accounts(directory);
}

/**
 * What a send's chat is, when Nocheh serves it; null otherwise. The owner's chat and its topics come first; then a
 * served group or one of its topics (a topic follows its group); then the private chat (or a topic of it) of a person,
 * not the owner, whose account is a member's that reaches a served group. A stranger's private chat, an unselected or
 * turned-off group and its topics, a private chat with no account, and an id the directory does not know are null.
 */
export function servedDestination(policy:Pick<AssistantPolicy,'owner_id'>,id:string,directory:ChatDirectory=chats()):Destination|null {
  if(typeof id!=='string')return null;
  if(directory.isOwner(id))return {kind:'owner'};
  const group=directory.groupOf(id);
  if(group!==null)return directory.served(id)?{kind:'group',group}:null;
  const base=directory.parentOf(id)??id,chat=directory.get(base);
  if(chat?.kind!=='private'||directory.isOwner(base)||!chat.account_id||chat.account_id===telegramAccount(policy.owner_id))return null;
  const groups=allowedAccounts(directory).get(chat.account_id);
  return groups?.length?{kind:'person',account:chat.account_id,groups}:null;
}
