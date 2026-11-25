import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor,isChatId} from '../chats.js';
import {isProxyAccount} from '../chats-telegram-updates.js';
import {HttpError} from '../http.js';
import {installMembers,memberIdFor,members,setMemberLoader,type MemberDirectory,type MemberLoader,type MemberPresenceRow,
  type MemberSnapshot} from '../members.js';
import type {ChatState} from '../chat-wire.js';
import type {MemberAddRequest,MemberChangeRequest,MemberGroup,MemberGroupRef,MemberItem,MemberList,MemberPerson,MemberRemoved,MemberRemoveRequest,
  MemberResult,MemberSettingsRequest,MemberSettingsResult} from '../member-wire.js';
import type {MemberRepository} from './member-api.js';
import {bumpMemberRevision} from './member-schema.js';
import {OwnerCommands} from './owner-commands.js';
import {closePerson} from './one-time-keys.js';
import {chatLabel,ensureAccount,ensureConnection} from './chats.js';

/*
 * Members in groups (step 3): the store side of the member directory (src/members.ts). The loader keeps this process's
 * directory current; the repository is the owner's Members routes. The directory is held in nocheh-app only.
 */

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;
type Policy=()=>Pick<AssistantPolicy,'owner_id'>;
/** The owner's account (chat_accounts id), null when there is no owner or the id does not parse. */
export function ownerAccount(policy:Pick<AssistantPolicy,'owner_id'>):string|null {
  if(!policy.owner_id)return null;
  try{return accountIdFor('telegram',policy.owner_id);}catch{return null;}
}
/** SQL: a group Nocheh is in (as setState refuses the others): not left, removed from or known only from history. */
export const joined=(c:string)=>`${c}.kind='group' AND ${c}.state NOT IN ('left','removed','archived')`;

/**
 * The rows the member directory is built from, read in one snapshot (REPEATABLE READ): members, the accounts linked to
 * them, their group switches, the newest Telegram membership row of each member account in each group, and the member
 * revision and daily cap.
 */
export async function loadMemberSnapshot(control:pg.Pool,policy:Policy):Promise<MemberSnapshot> {
  const db=await control.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows=(await db.query('SELECT id,state,group_talk,group_jobs,group_post_other,group_tools,tasks,private_chat,assistant FROM members')).rows;
    const accounts=(await db.query('SELECT id AS account_id,member_id FROM chat_accounts WHERE member_id IS NOT NULL')).rows;
    const chats=(await db.query('SELECT member_id,chat_id,enabled FROM member_chats')).rows;
    const presence=(await db.query<MemberPresenceRow>(`SELECT m.account_id,m.chat_id,m.state FROM chat_memberships m JOIN chat_accounts a ON a.id=m.account_id
      JOIN chats c ON c.id=m.chat_id WHERE a.member_id IS NOT NULL AND c.kind='group'`)).rows;
    const state=(await db.query('SELECT revision,daily_messages FROM member_directory_state WHERE singleton')).rows[0];
    await db.query('COMMIT');
    return {members:rows,accounts,chats,presence,owner_account:ownerAccount(policy()),revision:Number(state?.revision??0),
      ...(state?{daily_messages:Number(state.daily_messages)}:{})};
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
}

const failed=(error:unknown)=>console.warn(JSON.stringify({event:'member_directory_load_failed',code:(error as {code?:string})?.code??'unknown'}));
/**
 * Keeps this process's member directory (members()) current. It loads at start, again after every commit in this
 * process that moved the member revision (reloadMembers), and checks the revision every `interval` ms (watch), for
 * writes from another container (a reset or a backup restore). A load that fails, or rows that break the directory's
 * rules, leave the previous directory in place.
 */
export class MemberDirectoryLoader implements MemberLoader {
  private running:Promise<MemberDirectory>|null=null;private again=false;
  private timer:ReturnType<typeof setInterval>|null=null;private failing=false;
  constructor(readonly control:pg.Pool,readonly policy:Policy,readonly interval=2000){}
  /** Loads and installs a new snapshot; a call while one runs loads once more after it. */
  load():Promise<MemberDirectory> {
    if(this.running){this.again=true;return this.running;}
    const run=async():Promise<MemberDirectory>=>{
      try {
        do{this.again=false;installMembers(await loadMemberSnapshot(this.control,this.policy));}while(this.again);
        return members();
      } finally{this.running=null;}
    };
    return this.running=run();
  }
  /** Whether the stored member revision differs from the installed directory's. */
  async stale():Promise<boolean> {
    const row=(await this.control.query('SELECT revision FROM member_directory_state WHERE singleton')).rows[0];
    return Number(row?.revision??0)!==members().revision;
  }
  /** The directory as of now: reloaded first when the revision moved. */
  async current():Promise<MemberDirectory> {return await this.stale()?this.load():members();}
  /** Reloads within `interval` ms of a change another process made; never keeps the process alive, and stops with its pool. */
  watch():void {
    if(this.timer)return;
    this.timer=setInterval(()=>{
      if(this.control.ended){this.stop();return;}
      if(this.running)return;
      void this.stale().then(stale=>stale?this.load():undefined).then(()=>{this.failing=false;},error=>{if(!this.failing)failed(error);this.failing=true;});
    },this.interval);
    this.timer.unref();
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=null;}
}

let active:MemberDirectoryLoader|null=null;
/** Installs the member loader for this process, loads the first snapshot and starts watching the member revision. */
export async function startMembers(control:pg.Pool,policy:Policy):Promise<MemberDirectoryLoader> {
  active?.stop();
  const loader=new MemberDirectoryLoader(control,policy);active=loader;setMemberLoader(loader);
  await loader.load().catch(failed);
  loader.watch();
  return loader;
}
/** After a commit that moved the member revision: this process answers from the new rows at once. Without a loader
 * (tests) nothing happens. */
export async function reloadMembers():Promise<void> {await active?.load().catch(failed);}

/** Each group row as the Members page names it. */
interface GroupRow {chat_id:string;title:string|null;state:ChatState}
const byTitle=(a:{title:string|null;chat_id:string},b:{title:string|null;chat_id:string})=>
  (a.title??'￿').localeCompare(b.title??'￿')||(a.chat_id<b.chat_id?-1:a.chat_id>b.chat_id?1:0);
const personName=(row:{display_name?:string|null;username?:string|null;external_id?:string|null})=>row.display_name??row.username??row.external_id??'';

/**
 * Everything GET /v1/members shows, read with `db` (one snapshot for the list; the command's own transaction for an add
 * or a change, so its receipt shows the member as written). `only` limits the members to one id; `withPeople` (by
 * default unless `only` is given) adds the people who are not members. It reads chat_memberships directly, with no cap
 * on groups or people.
 */
export async function memberView(db:Db,owner:string|null,only:string|null=null,withPeople=only===null):Promise<MemberList> {
  const state=(await db.query('SELECT revision,daily_messages,member_schedules FROM member_directory_state WHERE singleton')).rows[0];
  const groupRows=(await db.query(`SELECT c.id,c.kind,c.title,c.app_type,c.state,d.username,i.external_id FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id
    LEFT JOIN chat_ids i ON i.chat_id=c.id AND i.state='current' WHERE c.kind='group'`)).rows;
  const groups=new Map<string,GroupRow>(groupRows.map(row=>[row.id as string,{chat_id:row.id,title:chatLabel(row,row.username,row.external_id),state:row.state}]));
  const isIn=(group:GroupRow|undefined)=>!!group&&!['left','removed','archived'].includes(group.state);
  const ref=(group:GroupRow):MemberGroupRef=>({chat_id:group.chat_id,title:group.title,state:group.state});
  const memberRows=(await db.query(`SELECT id,state,group_talk,group_jobs,group_post_other,group_tools,tasks,private_chat,reminders,assistant,time_zone,added_at FROM members
    WHERE $1::text IS NULL OR id=$1 ORDER BY added_at,id`,[only])).rows;
  const accountRows=(await db.query(`SELECT a.id,a.member_id,a.external_id,a.display_name,a.username FROM chat_accounts a
    WHERE a.member_id IS NOT NULL AND ($1::text IS NULL OR a.member_id=$1) ORDER BY a.id`,[only])).rows;
  const switches=(await db.query('SELECT member_id,chat_id,enabled FROM member_chats WHERE $1::text IS NULL OR member_id=$1',[only])).rows;
  const presence=(await db.query(`SELECT a.member_id,m.chat_id,m.state FROM chat_memberships m JOIN chat_accounts a ON a.id=m.account_id
    JOIN chats c ON c.id=m.chat_id WHERE a.member_id IS NOT NULL AND c.kind='group' AND ($1::text IS NULL OR a.member_id=$1)`,[only])).rows;
  const accountsOf=new Map<string,typeof accountRows>(),switchesOf=new Map<string,Map<string,boolean>>(),seenOf=new Map<string,Map<string,'in'|'left'>>();
  for(const row of accountRows){const list=accountsOf.get(row.member_id)??[];list.push(row);accountsOf.set(row.member_id,list);}
  for(const row of switches){const map=switchesOf.get(row.member_id)??new Map();map.set(row.chat_id,row.enabled);switchesOf.set(row.member_id,map);}
  // One of the member's accounts 'in' is 'in', as the directory's reaches reads it.
  for(const row of presence){const map=seenOf.get(row.member_id)??new Map();if(map.get(row.chat_id)!=='in')map.set(row.chat_id,row.state);seenOf.set(row.member_id,map);}
  const items:MemberItem[]=memberRows.map(row=>{
    const accounts=accountsOf.get(row.id)??[],own=accounts.find(account=>memberIdFor(account.id)===row.id)??accounts[0];
    const rows=switchesOf.get(row.id)??new Map<string,boolean>(),seen=seenOf.get(row.id)??new Map<string,'in'|'left'>();
    const listed=new Set([...rows.keys(),...[...seen.keys()].filter(chat=>isIn(groups.get(chat)))]);
    const memberGroups:MemberGroup[]=[...listed].filter(chat=>groups.has(chat)).map(chat=>{
      const group=groups.get(chat)!,telegram=seen.get(chat)??null;
      return {...ref(group),on:rows.get(chat)??true,telegram,new:telegram==='in'&&!rows.has(chat)};
    }).sort(byTitle);
    return {id:row.id,account_id:own?.id??'',state:row.state,name:own?.display_name??null,username:own?.username??null,telegram_id:own?.external_id??null,
      owner_linked:owner!==null&&accounts.some(account=>account.id===owner),added_at:new Date(row.added_at).toISOString(),
      permissions:{talk:row.group_talk,jobs:row.group_jobs,post:row.group_post_other,tools:row.group_tools,tasks:row.tasks,private_chat:row.private_chat,
        reminders:row.reminders,assistant:row.assistant},
      groups:memberGroups,time_zone:row.time_zone??null};
  });
  const people:MemberPerson[]=[];
  if(withPeople) {
    // People seen in groups Nocheh is in who are not members: Telegram's newest row says 'in', never the owner, a bot
    // or a proxy account.
    const rows=(await db.query(`SELECT a.id,a.external_id,a.display_name,a.username,m.chat_id FROM chat_memberships m JOIN chat_accounts a ON a.id=m.account_id
      JOIN chat_connections n ON n.id=a.connection_id AND n.app='telegram' JOIN chats c ON c.id=m.chat_id
      WHERE m.state='in' AND a.member_id IS NULL AND a.kind='human' AND ${joined('c')} ORDER BY a.id,m.chat_id`)).rows;
    const byAccount=new Map<string,MemberPerson>();
    for(const row of rows) {
      if(row.id===owner||isProxyAccount(row.external_id))continue;
      const person:MemberPerson=byAccount.get(row.id)??{account_id:row.id,name:row.display_name??null,username:row.username??null,telegram_id:row.external_id,groups:[]};
      person.groups.push(ref(groups.get(row.chat_id)!));byAccount.set(row.id,person);
    }
    for(const person of byAccount.values()){person.groups.sort(byTitle);people.push(person);}
    people.sort((a,b)=>personName(a).localeCompare(personName(b))||(a.account_id<b.account_id?-1:1));
  }
  const joinedGroups=[...groups.values()].filter(group=>isIn(group)).map(ref).sort(byTitle);
  return {revision:Number(state?.revision??0),daily_messages:Number(state?.daily_messages??200),member_schedules:Number(state?.member_schedules??5),groups:joinedGroups,members:items,people};
}

/** The member revision after a bump in the same transaction. */
async function bump(db:Db):Promise<number> {
  await bumpMemberRevision(db);
  return Number((await db.query('SELECT revision FROM member_directory_state WHERE singleton')).rows[0].revision);
}
/** The member as a result shows it, read in the command's own transaction. */
async function result(db:Db,owner:string|null,id:string,revision:number):Promise<MemberResult> {
  const member=(await memberView(db,owner,id)).members[0];
  if(!member)throw new HttpError(404,'member_not_found');
  return {revision,member};
}
/** Of `ids`, the group chats Nocheh is in; throws 400 member_group_invalid for any other. */
async function groupsIn(db:Db,ids:readonly string[]):Promise<void> {
  if(!ids.length)return;
  const found=new Set((await db.query(`SELECT c.id FROM chats c WHERE c.id=ANY($1::text[]) AND ${joined('c')}`,[ids])).rows.map(row=>row.id as string));
  if(ids.some(id=>!isChatId(id)||!found.has(id)))throw new HttpError(400,'member_group_invalid');
}
/** Of `groups`, those where Telegram's newest row for one of `accounts` says 'in' (Rule 1). */
async function seenIn(db:Db,accounts:readonly string[],groups:readonly string[]):Promise<Set<string>> {
  if(!accounts.length||!groups.length)return new Set();
  return new Set((await db.query(`SELECT DISTINCT chat_id FROM chat_memberships WHERE account_id=ANY($1::text[]) AND chat_id=ANY($2::text[]) AND state='in'`,
    [accounts,groups])).rows.map(row=>row.chat_id as string));
}
/** Writes a member's switches: true on, false off; an existing row changes only when its value does. */
async function writeSwitches(db:Db,member:string,groups:Readonly<Record<string,boolean>>):Promise<void> {
  for(const [chat,enabled] of Object.entries(groups))await db.query(`INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,$3)
    ON CONFLICT(member_id,chat_id) DO UPDATE SET enabled=excluded.enabled,updated_at=now() WHERE member_chats.enabled IS DISTINCT FROM excluded.enabled`,[member,chat,enabled]);
}

/**
 * The owner's Members routes (src/stores/member-api.ts). Each change is one owner command with no new guard epoch
 * (OwnerCommands.run {epoch:false}): the admin check, a receipt, idempotency by operation id and request hash and the
 * conflict error. It moves the member revision in the same transaction and reloads this process's directory once it
 * commits, so a member just added talks at once.
 */
export class Members implements MemberRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool,readonly policy:Policy){this.commands=new OwnerCommands(control);}
  private owner(){return ownerAccount(this.policy());}

  async list(principal:Reader):Promise<MemberList> {
    admin(principal);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const view=await memberView(db,this.owner());
      await db.query('COMMIT');return view;
    } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
    finally{db.release();}
  }

  /**
   * Adds a member: a person Nocheh has seen (account_id; each group switched on needs Telegram's newest row for them
   * 'in', Rule 1), or a Telegram user id (Add by Telegram user ID; the account is made when missing and any group Nocheh
   * is in may be switched on). Every group named must be one Nocheh is in. A group switched on gets an enabled row, one
   * switched off a switched-off row; a group left out gets none, and counts as on.
   */
  async add(principal:Reader,request:MemberAddRequest):Promise<MemberResult> {
    const {operation_id:operation,...rest}=request,owner=this.owner(),ownerId=this.policy().owner_id;
    const done=await this.commands.run(principal,operation,{kind:'member_add',...rest},async db=>{
      let account:string;
      if(request.account_id!==null) {
        const row=(await db.query(`SELECT a.id,a.kind,a.external_id,a.member_id,n.app FROM chat_accounts a JOIN chat_connections n ON n.id=a.connection_id
          WHERE a.id=$1 FOR UPDATE OF a`,[request.account_id])).rows[0];
        if(!row)throw new HttpError(404,'member_account_not_found');
        if(row.kind!=='human'||row.id===owner||row.app==='telegram'&&(isProxyAccount(row.external_id)||row.external_id===ownerId))throw new HttpError(400,'member_account_invalid');
        if(row.member_id!==null)throw new HttpError(409,'member_exists');
        account=row.id;
      } else {
        const external=request.telegram_id!;
        if(external===ownerId||isProxyAccount(external))throw new HttpError(400,'member_account_invalid');
        account=await ensureAccount(db,await ensureConnection(db,'telegram'),{external});
        const row=(await db.query('SELECT kind,member_id FROM chat_accounts WHERE id=$1 FOR UPDATE',[account])).rows[0];
        if(row.kind!=='human'||account===owner)throw new HttpError(400,'member_account_invalid');
        if(row.member_id!==null)throw new HttpError(409,'member_exists');
      }
      const chats=Object.keys(request.groups);
      await groupsIn(db,chats);
      if(request.account_id!==null) {
        const on=chats.filter(chat=>request.groups[chat]),seen=await seenIn(db,[account],on);
        if(on.some(chat=>!seen.has(chat)))throw new HttpError(409,'member_group_not_seen');
      }
      const id=memberIdFor(account);
      // app_since: a members' app launch from before this add is refused, so a launch from before an earlier removal never
      // comes back to life (ADR-0265 D4).
      if(!(await db.query('INSERT INTO members(id,app_since) VALUES($1,now()) ON CONFLICT DO NOTHING RETURNING id',[id])).rowCount)throw new HttpError(409,'member_exists');
      await db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1',[account,id]);
      await writeSwitches(db,id,request.groups);
      return result(db,owner,id,await bump(db));
    },{epoch:false});
    await reloadMembers();
    return done;
  }

  /**
   * Changes a member's state, permissions or group switches. A group switched off gets or changes its row for any group
   * Nocheh is in; switched on, an existing row changes, and a new row is made only where Telegram's newest row for one
   * of the member's accounts says 'in' (Rule 1). An existing row changes either way, also in a group Nocheh has left.
   */
  async change(principal:Reader,id:string,request:MemberChangeRequest):Promise<MemberResult> {
    const owner=this.owner();
    const done=await this.commands.run(principal,request.operation_id,{kind:'member_change',id,changes:request.changes},async db=>{
      const row=(await db.query('SELECT * FROM members WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'member_not_found');
      const c=request.changes;
      const next={state:c.state??row.state,group_talk:c.talk??row.group_talk,group_jobs:c.jobs??row.group_jobs,group_post_other:c.post??row.group_post_other,
        group_tools:c.tools??row.group_tools,tasks:c.tasks??row.tasks,private_chat:c.private_chat??row.private_chat,reminders:c.reminders??row.reminders,
        assistant:c.assistant??row.assistant};
      // Un-pausing sets app_since, so a members' app launch from before it is refused (ADR-0265 D4); a permission change does not.
      if(Object.entries(next).some(([key,value])=>row[key]!==value))await db.query(`UPDATE members SET state=$2,group_talk=$3,group_jobs=$4,group_post_other=$5,group_tools=$6,
        tasks=$7,private_chat=$8,reminders=$9,assistant=$10,app_since=CASE WHEN state='paused' AND $2='active' THEN now() ELSE app_since END,revision=revision+1,updated_at=now() WHERE id=$1`,
        [id,next.state,next.group_talk,next.group_jobs,next.group_post_other,next.group_tools,next.tasks,next.private_chat,next.reminders,next.assistant]);
      // Their own time zone, set by the owner as the member sets it themselves (ADR-0281): new schedules, quiet hours,
      // reminders and their chat's day follow it; schedules already set keep theirs.
      if(c.time_zone!==undefined&&c.time_zone!==(row.time_zone??null))
        await db.query('UPDATE members SET time_zone=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,c.time_zone]);
      // A paused member's keys close with the pause, so a reply or run of theirs under way reads nothing more (ADR-0306).
      if(next.state==='paused'&&row.state!=='paused')await closePerson(db,id,'member_paused');
      if(c.groups) {
        const chats=Object.keys(c.groups),existing=new Set((await db.query('SELECT chat_id FROM member_chats WHERE member_id=$1 AND chat_id=ANY($2::text[])',
          [id,chats])).rows.map(item=>item.chat_id as string));
        const fresh=chats.filter(chat=>!existing.has(chat));
        await groupsIn(db,fresh);
        const accounts=(await db.query('SELECT id FROM chat_accounts WHERE member_id=$1',[id])).rows.map(item=>item.id as string);
        const on=fresh.filter(chat=>c.groups![chat]),seen=await seenIn(db,accounts,on);
        if(on.some(chat=>!seen.has(chat)))throw new HttpError(409,'member_group_not_seen');
        await writeSwitches(db,id,c.groups);
      }
      return result(db,owner,id,await bump(db));
    },{epoch:false});
    await reloadMembers();
    return done;
  }

  /** Removes a member: its switches and daily counts go with it, its accounts are unlinked, and Telegram's membership
   * rows stay. Tasks and reminders name people by account, so they stay as they are. */
  async remove(principal:Reader,id:string,request:MemberRemoveRequest):Promise<MemberRemoved> {
    const done=await this.commands.run(principal,request.operation_id,{kind:'member_remove',id},async db=>{
      // Their closed asks go with them; an open one loses its member, so its worker closes it and tells the owner once
      // (owner-member-asks.ts). Their asks are locked first, so a worker closing one waits for this commit and then sees
      // it has no member and removes it; it never closes one between the delete below and the member going.
      await db.query('SELECT id FROM owner_member_asks WHERE member_id=$1 FOR UPDATE',[id]);
      await db.query("DELETE FROM owner_member_asks WHERE member_id=$1 AND state NOT IN ('queued','running')",[id]);
      if(!(await db.query('DELETE FROM members WHERE id=$1',[id])).rowCount)throw new HttpError(404,'member_not_found');
      await closePerson(db,id,'member_removed');
      return {revision:await bump(db),removed:id};
    },{epoch:false});
    await reloadMembers();
    return done;
  }

  /** The daily message cap (turns per member per UTC day across all groups) and how many schedules each member may keep. */
  async settings(principal:Reader,request:MemberSettingsRequest):Promise<MemberSettingsResult> {
    const {operation_id:_,...changes}=request;
    const done=await this.commands.run(principal,request.operation_id,{kind:'member_settings',...changes},async db=>{
      const row=(await db.query(`UPDATE member_directory_state SET daily_messages=COALESCE($1,daily_messages),member_schedules=COALESCE($2,member_schedules)
        WHERE singleton RETURNING daily_messages,member_schedules`,[request.daily_messages??null,request.member_schedules??null])).rows[0];
      return {revision:await bump(db),daily_messages:Number(row.daily_messages),member_schedules:Number(row.member_schedules)};
    },{epoch:false});
    await reloadMembers();
    return done;
  }
}
