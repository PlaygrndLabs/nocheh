import {createHash} from 'node:crypto';
import {HttpError} from './http.js';
import {chats,isChatId,type ChatDirectory} from './chats.js';
import {DAILY_MESSAGES_DEFAULT,DAILY_MESSAGES_MAX,DAILY_MESSAGES_MIN,memberPermissions,memberStates,memberTaskModes,type MemberPermission,
  type MemberPresence,type MemberState,type MemberTasks} from './member-wire.js';

export {memberPermissions,memberStates,memberTaskModes};
export type {MemberPermission,MemberPresence,MemberState,MemberTasks};

/*
 * Members in groups (step 3). Who may use Nocheh in a group besides the owner is a member: a members row, linked from
 * the person's account (chat_accounts.member_id), with its permissions and a switch per group (member_chats). The owner
 * is never a member (ADR-0244): the owner stays TELEGRAM_OWNER_ID, and the directory never counts the owner's account as
 * a member's, even when it is linked. Every caller checks the owner first and keeps the owner's own outcome (an owner
 * card or owner approval), then asks this directory. The directory is held in nocheh-app only; a process that never
 * loads it has the empty one, which admits nobody, so only the owner gets through there.
 */

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const digestPattern=/^[a-f0-9]{64}$/;
const isDigest=(value:unknown):value is string=>typeof value==='string'&&digestPattern.test(value);
/** A member's id: digest(canonical(['member', account])) of the first account it was made for, byte for byte as
 * src/archive.ts writes it. It never changes, so later accounts link to the same member. */
export function memberIdFor(account:string):string {
  if(!isDigest(account))throw new HttpError(400,'invalid_account_reference');
  return sha256(`[${JSON.stringify('member')},${JSON.stringify(account)}]`);
}

/** A members row as the loader reads it. */
export interface MemberRow {id:string;state:MemberState;group_talk:boolean;group_jobs:boolean;group_post_other:boolean;group_tools:boolean;tasks:MemberTasks}
/** A chat_accounts row linked to a member (member_id is not null). */
export interface MemberAccountRow {account_id:string;member_id:string}
/** A member_chats row: a member's switch for one group (a group chat id; a topic follows its group). */
export interface MemberChatRow {member_id:string;chat_id:string;enabled:boolean}
/** The newest chat_memberships row of a member account in a group: what Telegram last said of them there. */
export interface MemberPresenceRow {account_id:string;chat_id:string;state:MemberPresence}
/**
 * Everything a member directory is built from. owner_account is the owner's account (accountIdFor('telegram',
 * policy.owner_id)), null when there is no owner; revision is member_directory_state.revision (0 for fixtures) and
 * daily_messages its daily cap (200 when absent).
 */
export interface MemberSnapshot {members:readonly MemberRow[];accounts:readonly MemberAccountRow[];chats:readonly MemberChatRow[];
  presence:readonly MemberPresenceRow[];owner_account:string|null;daily_messages?:number;revision?:number}

/** One member as the directory holds it: the stored permissions (the sub-permissions keep their values while talk is
 * off) and the member's accounts, sorted, never the owner's. */
export interface Member {
  readonly id:string;readonly state:MemberState;readonly talk:boolean;readonly jobs:boolean;readonly post:boolean;readonly tools:boolean;
  readonly tasks:MemberTasks;readonly accounts:readonly string[];
}

/**
 * What every person check asks. Synchronous: a snapshot of the members, their accounts, their group switches, the newest
 * Telegram membership row of each member account in each group and the daily cap, reloaded by its loader (src/stores/
 * members.ts) after every commit that moves the member revision, and every few seconds when another process moved it.
 * `account` is a chat_accounts id (accountIdFor); `chat` a Nocheh chat id, a topic counting as its group. Every answer
 * about an unknown account, an unknown chat, a private chat or a group Nocheh does not serve is false. The `directory`
 * argument is the chat directory to read chats from, chats() by default.
 */
export interface MemberDirectory {
  /** member_directory_state.revision the snapshot was loaded at. */
  readonly revision:number;
  /** The daily message cap: turns per member per UTC day across all groups. */
  readonly dailyMessages:number;
  /** The owner's account this snapshot was loaded for; null when not known. */
  readonly ownerAccount:string|null;
  /** Every member, sorted by id. */
  all():readonly Member[];
  get(id:string|null|undefined):Member|null;
  /** The member an account is linked to; null for the owner's account, an account linked to nobody and anything else. */
  memberOf(account:string|null|undefined):Member|null;
  /**
   * Whether the account may talk to Nocheh in the chat's group: the group is served, and either the account is the
   * owner's, or its member is active, has talk on, and the group's switch is on or the group has no row (a group with no
   * row counts as on). A live message proves its sender is in the group, so this never reads Telegram's rows.
   */
  talks(account:string|null|undefined,chat:string|null|undefined,directory?:ChatDirectory):boolean;
  /** talks, and the member's permission is on (small jobs, posts to their other groups, web pages and outside tools).
   * With talk off every permission is off. The owner's account: talks. */
  may(account:string|null|undefined,chat:string|null|undefined,permission:MemberPermission,directory?:ChatDirectory):boolean;
  /**
   * may (with a permission) or talks (without), and Telegram's newest row for one of the member's accounts in the chat's
   * group says 'in'. No row, or 'left', is not reached (fail closed). For every decision made without a live message
   * from that group: a cross-group post target, a person destination, a running job. The owner's account: talks.
   */
  reaches(account:string|null|undefined,chat:string|null|undefined,permission?:MemberPermission|null,directory?:ChatDirectory):boolean;
  /** The account's tasks permission: the member's, 'write' for the owner's account, null for anyone else. */
  tasks(account:string|null|undefined):MemberTasks|null;
  /** Every member account that reaches at least one served group, with those groups (group chat ids), sorted. Never the
   * owner's account. */
  accounts(directory?:ChatDirectory):ReadonlyMap<string,readonly string[]>;
}

const invalid=(reason:string)=>Error('invalid_member_directory:'+reason);
const key=(...parts:string[])=>parts.join('\n');

class SnapshotMembers implements MemberDirectory {
  readonly revision:number;readonly dailyMessages:number;readonly ownerAccount:string|null;
  private readonly byId=new Map<string,Member>();private readonly byAccount=new Map<string,Member>();
  private readonly enabled=new Map<string,boolean>();private readonly presence=new Map<string,MemberPresence>();
  private readonly sorted:readonly Member[];
  private readonly reached=new WeakMap<ChatDirectory,ReadonlyMap<string,readonly string[]>>();
  constructor(snapshot:MemberSnapshot) {
    this.revision=snapshot.revision??0;this.dailyMessages=snapshot.daily_messages??DAILY_MESSAGES_DEFAULT;
    if(!Number.isSafeInteger(this.revision)||this.revision<0)throw invalid('revision');
    if(!Number.isSafeInteger(this.dailyMessages)||this.dailyMessages<DAILY_MESSAGES_MIN||this.dailyMessages>DAILY_MESSAGES_MAX)throw invalid('daily_messages');
    if(snapshot.owner_account!==null&&!isDigest(snapshot.owner_account))throw invalid('owner_account');
    this.ownerAccount=snapshot.owner_account;
    const rows=new Map<string,MemberRow>(),links=new Map<string,string[]>();
    for(const row of snapshot.members) {
      if(!isDigest(row.id)||rows.has(row.id))throw invalid('member_id');
      if(!(memberStates as readonly string[]).includes(row.state)||!(memberTaskModes as readonly string[]).includes(row.tasks)||
        [row.group_talk,row.group_jobs,row.group_post_other,row.group_tools].some(value=>typeof value!=='boolean'))throw invalid('member_row');
      rows.set(row.id,row);links.set(row.id,[]);
    }
    const linked=new Set<string>();
    for(const row of snapshot.accounts) {
      if(!isDigest(row.account_id)||!rows.has(row.member_id))throw invalid('member_account');
      if(linked.has(row.account_id))throw invalid('member_account_duplicate');
      linked.add(row.account_id);
      // The owner's account is never a member's, even when it is linked.
      if(row.account_id!==this.ownerAccount)links.get(row.member_id)!.push(row.account_id);
    }
    for(const row of snapshot.chats) {
      if(!rows.has(row.member_id)||!isChatId(row.chat_id)||typeof row.enabled!=='boolean')throw invalid('member_chat');
      const at=key(row.member_id,row.chat_id);if(this.enabled.has(at))throw invalid('member_chat_duplicate');
      this.enabled.set(at,row.enabled);
    }
    for(const row of snapshot.presence) {
      if(!isDigest(row.account_id)||!isChatId(row.chat_id)||row.state!=='in'&&row.state!=='left')throw invalid('member_presence');
      const at=key(row.account_id,row.chat_id);if(this.presence.has(at))throw invalid('member_presence_duplicate');
      this.presence.set(at,row.state);
    }
    for(const row of rows.values()) {
      const member:Member=Object.freeze({id:row.id,state:row.state,talk:row.group_talk,jobs:row.group_jobs,post:row.group_post_other,tools:row.group_tools,
        tasks:row.tasks,accounts:Object.freeze([...links.get(row.id)!].sort())});
      this.byId.set(row.id,member);for(const account of member.accounts)this.byAccount.set(account,member);
    }
    this.sorted=Object.freeze([...this.byId.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  }
  all(){return this.sorted;}
  get(id:string|null|undefined){return typeof id==='string'?this.byId.get(id)??null:null;}
  memberOf(account:string|null|undefined){return typeof account==='string'&&account!==this.ownerAccount?this.byAccount.get(account)??null:null;}
  private owner(account:string|null|undefined){return typeof account==='string'&&account===this.ownerAccount;}
  /** The served group of `chat` (a topic's group), or null. */
  private servedGroup(chat:string|null|undefined,directory:ChatDirectory){
    const group=directory.groupOf(chat);return group!==null&&directory.served(group)?group:null;
  }
  talks(account:string|null|undefined,chat:string|null|undefined,directory:ChatDirectory=chats()):boolean {
    const group=this.servedGroup(chat,directory);if(group===null)return false;
    if(this.owner(account))return true;
    const member=this.memberOf(account);
    return !!member&&member.state==='active'&&member.talk&&this.enabled.get(key(member.id,group))!==false;
  }
  may(account:string|null|undefined,chat:string|null|undefined,permission:MemberPermission,directory:ChatDirectory=chats()):boolean {
    if(!(memberPermissions as readonly string[]).includes(permission)||!this.talks(account,chat,directory))return false;
    return this.owner(account)||this.memberOf(account)![permission];
  }
  reaches(account:string|null|undefined,chat:string|null|undefined,permission?:MemberPermission|null,directory:ChatDirectory=chats()):boolean {
    if(!(permission?this.may(account,chat,permission,directory):this.talks(account,chat,directory)))return false;
    if(this.owner(account))return true;
    const group=this.servedGroup(chat,directory)!;
    return this.memberOf(account)!.accounts.some(own=>this.presence.get(key(own,group))==='in');
  }
  tasks(account:string|null|undefined):MemberTasks|null {
    if(this.owner(account))return 'write';
    return this.memberOf(account)?.tasks??null;
  }
  accounts(directory:ChatDirectory=chats()):ReadonlyMap<string,readonly string[]> {
    const cached=this.reached.get(directory);if(cached)return cached;
    const groups=directory.all().filter(chat=>chat.kind==='group'&&directory.served(chat.id)).map(chat=>chat.id);
    const found=new Map<string,readonly string[]>();
    for(const member of this.sorted)for(const account of member.accounts) {
      const reached=groups.filter(group=>this.reaches(account,group,null,directory));
      if(reached.length)found.set(account,Object.freeze(reached.sort()));
    }
    this.reached.set(directory,found);return found;
  }
}

/** A directory over one snapshot of rows: the loader installs one per load; tests build them from fixtures. Throws when
 * the rows break the schema's rules, so a bad snapshot is never installed. */
export function memberDirectory(snapshot:MemberSnapshot):MemberDirectory {return new SnapshotMembers(snapshot);}

/** What the store's loader (src/stores/members.ts) does when asked: resolves once it has looked again, reloading first
 * when the member revision moved. */
export interface MemberLoader {current():Promise<unknown>}
const empty=():MemberDirectory=>memberDirectory({members:[],accounts:[],chats:[],presence:[],owner_account:null});
let installed:MemberDirectory=empty();
let loader:MemberLoader|null=null;
/** The process's member directory. Before anything is installed it holds no member, so it admits nobody: only the
 * owner, whom every caller checks first, gets through. */
export const members=():MemberDirectory=>installed;
const isDirectory=(value:MemberDirectory|MemberSnapshot):value is MemberDirectory=>typeof (value as MemberDirectory).talks==='function';
/** Installs a new snapshot for the whole process. */
export function installMembers(source:MemberDirectory|MemberSnapshot):MemberDirectory {
  installed=isDirectory(source)?source:memberDirectory(source);return installed;
}
export function setMemberLoader(next:MemberLoader|null):void {loader=next;}
/** The directory as of now, for a caller that can wait: with a loader, it looks again first (reloading when the member
 * revision moved); without one, the installed directory. */
export async function freshMembers():Promise<MemberDirectory> {
  if(loader)await loader.current();
  return installed;
}
/** Tests only: installs `source` with no loader and returns the function that puts the previous directory back. */
export function installMembersForTest(source:MemberDirectory|MemberSnapshot):()=>void {
  const previous=installed,previousLoader=loader;
  loader=null;installed=isDirectory(source)?source:memberDirectory(source);
  return ()=>{installed=previous;loader=previousLoader;};
}
