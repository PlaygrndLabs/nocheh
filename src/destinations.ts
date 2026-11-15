import {groupAccessOf,type AssistantPolicy} from './assistant-policy.js';
import {accountIdFor,chats,type ChatDirectory} from './chats.js';

/*
 * The chats Nocheh sends to (Risk 3, ADR-0254): the owner's private chat and its topics, the selected groups and their
 * topics, and the private chats of people the owner allowed in those groups. Everything else, a stranger's private
 * chat, a group the owner did not select or turned off, and a chat the directory does not know, is not served. This
 * reads the chat directory and the access lists only; it never reads an id's shape.
 */

/** A chat Nocheh serves as a destination: the owner's, a selected group's (its group), or an allowed person's (their
 * account, and the served groups they are allowed in, sorted). */
export type Destination={kind:'owner'}|{kind:'group';group:string}|{kind:'person';account:string;groups:readonly string[]};

const account=(user:string|null|undefined)=>{if(!user)return null;try{return accountIdFor('telegram',user);}catch{return null;}};

/** Whether a person (a raw app user id) may use Nocheh in `group` by its access lists: granted under any of the group's
 * Telegram ids and denied under none. It does not ask whether the group is served; the owner is never in the lists. */
export function allowedIn(policy:Pick<AssistantPolicy,'group_access'>,group:string,user:string,directory:ChatDirectory=chats()):boolean {
  const access=groupAccessOf(policy,directory.rawScopes([group],'telegram'));
  return !!access&&access.granted.includes(user)&&!access.denied.includes(user);
}

/** Kept per directory while the policy (servedPolicy keeps its identity until something changes) and its lists stay the same. */
const allowed=new WeakMap<ChatDirectory,{policy:object;access:unknown;map:ReadonlyMap<string,readonly string[]>}>();
/** Every person allowed in a served group, by account id, with the served groups they are allowed in, sorted. */
export function allowedAccounts(policy:Pick<AssistantPolicy,'group_access'>,directory:ChatDirectory=chats()):ReadonlyMap<string,readonly string[]> {
  const cached=allowed.get(directory);
  if(cached&&cached.policy===policy&&cached.access===policy.group_access)return cached.map;
  const found=new Map<string,string[]>();
  for(const chat of directory.all()) {
    if(chat.kind!=='group'||!directory.served(chat.id))continue;
    const access=groupAccessOf(policy,directory.rawScopes([chat.id],'telegram'));if(!access)continue;
    for(const user of access.granted) {
      const id=access.denied.includes(user)?null:account(user);if(!id)continue;
      found.set(id,[...found.get(id)??[],chat.id]);
    }
  }
  const map:ReadonlyMap<string,readonly string[]>=new Map([...found].map(([id,groups])=>[id,Object.freeze([...new Set(groups)].sort())]));
  allowed.set(directory,{policy,access:policy.group_access,map});
  return map;
}

/**
 * What a send's chat is, when Nocheh serves it; null otherwise. The owner's chat and its topics come first; then a
 * served group or one of its topics (a topic follows its group); then the private chat (or a topic of it) of a person,
 * not the owner, whose account is allowed in a served group. A stranger's private chat, an unselected or turned-off
 * group and its topics, a private chat with no account, and an id the directory does not know are null.
 */
export function servedDestination(policy:Pick<AssistantPolicy,'group_access'|'owner_id'>,id:string,directory:ChatDirectory=chats()):Destination|null {
  if(typeof id!=='string')return null;
  if(directory.isOwner(id))return {kind:'owner'};
  const group=directory.groupOf(id);
  if(group!==null)return directory.served(id)?{kind:'group',group}:null;
  const base=directory.parentOf(id)??id,chat=directory.get(base);
  if(chat?.kind!=='private'||directory.isOwner(base)||!chat.account_id||chat.account_id===account(policy.owner_id))return null;
  const groups=allowedAccounts(policy,directory).get(chat.account_id);
  return groups?.length?{kind:'person',account:chat.account_id,groups}:null;
}
