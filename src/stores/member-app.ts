import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import type {KeyObject} from 'node:crypto';
import type pg from 'pg';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor} from '../chats.js';
import {isTelegramAccount} from '../chats-telegram.js';
import {HttpError,json,object,string} from '../http.js';
import {MEMBER_APP_BODY_MAX,MEMBER_APP_CORE_PREFIX,MEMBER_APP_QUERY_MAX,MEMBER_APP_TASK_WRITES,MEMBER_APP_WRITES_PER_10_MIN,
  MEMBER_APP_WRITES_PER_DAY,MEMBER_LAUNCH_HEADER,memberAppErrors,memberAppRoute,memberTaskQuery,
  type MemberBoardGroup,type MemberGroupBoard,type MemberMe,type MemberMeGroup,type MemberRemindersState,type MemberSchedule,
  type MemberScheduleRequest,type MemberScheduleResult,type MemberSchedules,type MemberTimeZone} from '../member-app-wire.js';
import type {MemberTasks} from '../member-wire.js';
import type {RuntimeCall} from '../runtime.js';
import {groupWithTopics} from '../spaces.js';
import {MEMBER_LAUNCH_MAX_AGE,verifyLaunchUser,type LaunchUser} from '../telegram-launch.js';
import {chatLabel} from './chats.js';
import {assertStorageActive} from './lifecycle.js';
import {MEMBER_RECHECK_HOURS,joinedGroups,recheckMemberAppGroups} from './member-reads.js';
import {memberTaskViews} from './member-task-views.js';
import {reloadMembers} from './members.js';
import {memberTimeZoneValue,setMemberTimeZone} from './schedules.js';
import type {MemberAppPrincipal,TaskRepository} from './tasks.js';

/*
 * The members' app's own listener in nocheh-app (step 5, ADR-0265 D2-D4, D13). nocheh-miniapp forwards the member page's
 * `/api/member/<route>` here as `/v1/member-app/<route>` over its own network; nothing else is served on this port, and
 * the main listener (8780) refuses this prefix. A member is named only by Telegram's signed launch data, checked again
 * here on every call; there is no password, session or token, and no Reader, turn pass or service token ever mixes in.
 *
 * Each call, in this order:
 *  1. no Authorization header (400 member_app_no_bearer);
 *  2. a route of MEMBER_APP_ROUTES, a query on GET tasks only and at most MEMBER_APP_QUERY_MAX characters (404);
 *  3. a body of at most MEMBER_APP_BODY_MAX bytes (413);
 *  4. the launch data verifies for this bot, within MEMBER_LAUNCH_MAX_AGE, from the member's own chat with the bot
 *     (401 member_app_launch_invalid);
 *  5. the launch is not the owner's, by the policy (403 member_required);
 *  6. one query from the account: linked to an active member, not the owner's account, with the owner's private chat
 *     known (403 member_app_closed, the one answer for a stranger, a paused or removed member, or an unlinked account,
 *     before any task is read);
 *  7. the launch is no older than when the member was added or un-paused (members.app_since, 60 s of slack; 401
 *     member_app_launch_old) and newer than their last sign-out (401 member_app_signed_out), on Telegram's clock;
 *  8. on GET me and before each task write, Telegram is asked again about the member's groups (at most once per member
 *     every ten minutes);
 *  9. on task writes, the Tasks permission (403 task_read_only), then the write limit (429 member_app_busy);
 * 10. the principal from the groups confirmed within MEMBER_RECHECK_HOURS, the repository call, and a no-store answer.
 * The launch data is never logged, and no answer names why beyond its fixed code.
 */

/** What the member listener reads and calls: the control store, the task repository's member methods, the policy (who
 * the owner is), Nocheh's runtime calls (the group check) and the data folder (a restored installation stays
 * inactive). */
export interface MemberAppServices {
  control:pg.Pool;
  tasks:Pick<TaskRepository,'memberList'|'memberGet'|'memberCreate'|'memberUpdate'|'memberComment'|'memberReminders'>;
  policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>;
  call:RuntimeCall;
  /** The agent's schedule list and actions, as the owner's Schedules page calls them (members' schedules). */
  schedules?:(input:Record<string,unknown>)=>Promise<Record<string,unknown>>;
  dataDir?:string;
}
/** The public bot id and the key launch data is checked with (launchKey); `now` for tests. */
export interface MemberAppOptions {botId:string;key:KeyObject;now?:()=>number}

/** A launch from before the member was added or un-paused, by more than this, is refused (D4); a sign-out refuses every
 * launch opened more than this before it (D13). Both cover the difference between Telegram's clock and this one. */
export const MEMBER_APP_SINCE_SLACK_SECONDS=60;
const refuse=(code:keyof typeof memberAppErrors,status:number)=>new HttpError(status,memberAppErrors[code]);

/** Who launched the app, as the store says now (check 6): the member, the launching account and all their accounts but
 * the owner's, their Tasks permission, Reminders to themselves, the launching account's open private chat with Nocheh,
 * their last sign-out and when they were added or un-paused. */
interface Identity {member:string;account:string;accounts:string[];mode:MemberTasks;reminders:boolean;chat:string|null;display:string|null;
  appSince:Date;signedOut:Date|null;assistant:boolean;scheduleLimit:number;timeZone:string|null}

/**
 * Check 6 in one query: the account of Telegram user `account` linked to an active member, never the owner's account
 * (the account of the owner's private chat `owner`), with that member's other accounts, the launching account's own
 * private chat when it is open (a private chat itself, not the owner's, with private chat on, as memberReads opens it),
 * and the member's last sign-out. Null for anyone else.
 */
async function identify(db:Pick<pg.Pool,'query'>,account:string,owner:string):Promise<Identity|null> {
  const row=(await db.query(`SELECT m.id AS member,a.id AS account,m.tasks,m.reminders,m.assistant,m.time_zone,m.app_since,a.display_name,p.signed_out_auth_date,
      (SELECT d.member_schedules FROM member_directory_state d WHERE d.singleton) AS schedule_limit,
      ARRAY(SELECT x.id FROM chat_accounts x WHERE x.member_id=m.id AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=x.id) ORDER BY x.id) AS accounts,
      (SELECT c.id FROM chats c WHERE c.account_id=a.id AND c.kind='private' AND c.parent_id IS NULL AND c.id<>$2 AND m.private_chat ORDER BY c.id LIMIT 1) AS chat
    FROM chat_accounts a JOIN chat_connections n ON n.id=a.connection_id AND n.app='telegram'
    JOIN members m ON m.id=a.member_id AND m.state='active' LEFT JOIN member_app_prefs p ON p.member_id=m.id
    WHERE a.id=$1 AND a.kind='human' AND EXISTS(SELECT 1 FROM chats o WHERE o.id=$2) AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.id=$2 AND o.account_id=a.id)`,
  [account,owner])).rows[0];
  if(!row||(row.tasks!=='write'&&row.tasks!=='read'))return null;
  return {member:row.member,account:row.account,accounts:row.accounts as string[],mode:row.tasks,reminders:row.reminders===true,chat:row.chat??null,
    display:row.display_name??null,appSince:row.app_since,signedOut:row.signed_out_auth_date??null,assistant:row.assistant===true,
    scheduleLimit:Number(row.schedule_limit??5),timeZone:row.time_zone??null};
}

/** The Telegram name the signed launch data gives (first and last name), or null. */
function launchName(raw:string):string|null {
  try {
    const user=JSON.parse(new URLSearchParams(raw).get('user')??'') as {first_name?:unknown;last_name?:unknown};
    const name=[user.first_name,user.last_name].filter(part=>typeof part==='string').join(' ').replace(/\s+/g,' ').trim().slice(0,100);
    return name||null;
  } catch {return null;}
}

/** Whether "Remind me" may set a reminder now (D9, Q3): write access, Reminders to themselves on, and an open private chat. */
export function remindersState(identity:Pick<Identity,'mode'|'reminders'|'chat'>):MemberRemindersState {
  if(identity.mode!=='write')return {available:false,reason:'read_only'};
  if(!identity.reminders)return {available:false,reason:'reminders_off'};
  if(!identity.chat)return {available:false,reason:'private_chat_off'};
  return {available:true};
}

/**
 * Counts one write against the member's limits (D4): at most MEMBER_APP_WRITES_PER_10_MIN in a 10-minute window and
 * MEMBER_APP_WRITES_PER_DAY in a UTC day. Over either, nothing is counted and 429 member_app_busy is thrown.
 */
export async function countMemberWrite(db:Pick<pg.Pool,'query'>,member:string):Promise<void> {
  const written=(await db.query(`INSERT INTO member_app_limits AS l(member_id,window_start,window_writes,day,day_writes) VALUES($1,now(),1,(now() AT TIME ZONE 'UTC')::date,1)
    ON CONFLICT(member_id) DO UPDATE SET
      window_start=CASE WHEN l.window_start<=now()-interval '10 minutes' OR l.window_start>now() THEN now() ELSE l.window_start END,
      window_writes=CASE WHEN l.window_start<=now()-interval '10 minutes' OR l.window_start>now() THEN 1 ELSE l.window_writes+1 END,
      day=(now() AT TIME ZONE 'UTC')::date,
      day_writes=CASE WHEN l.day<>(now() AT TIME ZONE 'UTC')::date THEN 1 ELSE l.day_writes+1 END,updated_at=now()
    WHERE NOT (l.window_start>now()-interval '10 minutes' AND l.window_start<=now() AND l.window_writes>=$2)
      AND NOT (l.day=(now() AT TIME ZONE 'UTC')::date AND l.day_writes>=$3)
    RETURNING l.member_id`,[member,MEMBER_APP_WRITES_PER_10_MIN,MEMBER_APP_WRITES_PER_DAY])).rowCount;
  if(!written)throw refuse('busy',429);
}

/** GET me: the member's name, Tasks permission, reminders, boards and groups (each with its Telegram title, its board,
 * and the open tasks labelled with that group or one of its topics on an open board). Each board also names the
 * project's groups now, by Telegram title, which its tasks' group labels show (ADR-0276). Nothing names the owner,
 * another member, or the owner's time zone. */
async function me(db:Pick<pg.Pool,'query'>,principal:MemberAppPrincipal,groups:readonly string[],assistant:boolean):Promise<MemberMe> {
  const rows=groups.length?(await db.query(`SELECT c.id,c.kind,c.title,c.app_type,d.username,p.id AS project,p.state AS project_state FROM chats c
      LEFT JOIN chat_details d ON d.chat_id=c.id LEFT JOIN project_assignments a ON a.space_id=c.id AND a.mode='assigned' LEFT JOIN projects p ON p.id=a.project_id
    WHERE c.id=ANY($1::text[]) AND c.kind='group'`,[[...groups]])).rows:[];
  const open=new Set(principal.views.map(view=>view.project)),items:MemberMeGroup[]=[];
  for(const row of rows) {
    const board:MemberGroupBoard=!row.project?'none':row.project_state==='active'&&open.has(row.project)?'open':'closed';
    const item:MemberMeGroup={id:row.id,title:chatLabel({kind:'group',title:row.title,app_type:row.app_type},row.username,null),board,project:board==='open'?row.project:null};
    if(board==='open')item.open_count=(await db.query(`SELECT count(*)::int AS n FROM owner_tasks WHERE project_id=$1 AND state='open' AND archived_at IS NULL
      AND deleted_at IS NULL AND group_id=ANY($2::text[])`,[row.project,groupWithTopics(row.id)??[]])).rows[0].n;
    items.push(item);
  }
  const byTitle=(a:{id:string;title:string|null},b:{id:string;title:string|null})=>(a.title??'').localeCompare(b.title??'')||(a.id<b.id?-1:a.id>b.id?1:0);
  items.sort(byTitle);
  // Each board's groups: every group assigned to its project now, the member's own and the others alike.
  const named=principal.views.length?(await db.query(`SELECT a.project_id AS project,c.id,c.title,c.app_type,d.username FROM project_assignments a
      JOIN chats c ON c.id=a.space_id AND c.kind='group' LEFT JOIN chat_details d ON d.chat_id=c.id
    WHERE a.project_id=ANY($1::text[]) AND a.mode='assigned'`,[principal.views.map(view=>view.project)])).rows:[];
  const boardGroups=(project:string):MemberBoardGroup[]=>named.filter(row=>row.project===project)
    .map(row=>({id:row.id as string,title:chatLabel({kind:'group',title:row.title,app_type:row.app_type},row.username,null)})).sort(byTitle);
  return {name:principal.name??'',mode:principal.mode,reminders:principal.reminders,
    projects:principal.views.map(view=>({id:view.project,name:view.name,groups:boardGroups(view.project)})),groups:items,assistant};
}

/** A time the agent wrote, as UTC, so no offset of the owner's time zone shows; null when there is none. */
const utc=(value:unknown):string|null=>{
  if(typeof value!=='string'||!value)return null;
  const at=new Date(value);return Number.isNaN(at.getTime())?null:at.toISOString();
};
/** What the members' app shows of one schedule the agent listed: no prompt text, profile, chat or time zone. */
function memberSchedule(item:Record<string,unknown>):MemberSchedule {
  const state:MemberSchedule['state']=item.running===true?'running':item.state==='completed'?'finished':item.enabled===false?'paused':'scheduled';
  return {id:String(item.id),name:typeof item.name==='string'?item.name.slice(0,200):'',schedule:typeof item.schedule==='string'?item.schedule.slice(0,200):'',
    state,next_run_at:utc(item.next_run_at),last_run_at:utc(item.last_run_at),
    last_ok:item.last_status==='success'?true:item.last_status==='error'||item.last_status==='skipped'?false:null};
}
/** The schedules the agent keeps for this private chat now (the agent's list, filtered to the chat). */
async function chatScheduleList(manage:NonNullable<MemberAppServices['schedules']>,chat:string):Promise<Record<string,unknown>[]> {
  const listed=(await manage({operation:'list'})).schedules;
  return Array.isArray(listed)?listed.filter((item:any)=>item&&typeof item==='object'&&item.scope===chat&&typeof item.id==='string'
    &&typeof item.profile==='string'):[];
}
const SCHEDULE_ACTIONS:Record<MemberScheduleRequest['action'],string>={pause:'pause',resume:'resume',run:'run',delete:'delete'};
/** POST /schedules/:id: one of the member's own schedules paused, resumed, run now or deleted, as the owner's Schedules
 * page does it; the schedule must be one of their private chat's now. */
async function changeSchedule(manage:NonNullable<MemberAppServices['schedules']>,chat:string,job:string,body:unknown):Promise<MemberScheduleResult> {
  const request=object(body),action=string(request.action,10) as MemberScheduleRequest['action'],operation=string(request.operation_id,64);
  if(!Object.hasOwn(SCHEDULE_ACTIONS,action))throw new HttpError(400,'invalid_schedule_action');
  if(!/^[a-zA-Z0-9-]{8,64}$/.test(operation))throw new HttpError(400,'invalid_operation_id');
  const found=(await chatScheduleList(manage,chat)).find(item=>item.id===job);
  if(!found)throw refuse('scheduleGone',404);
  let result:Record<string,unknown>;
  try{result=await manage({operation:SCHEDULE_ACTIONS[action],profile:found.profile,job_id:job,request_id:'member-'+operation});}
  catch(error){if(error instanceof HttpError&&error.status<500&&error.status!==429)throw refuse('scheduleGone',404);throw error;}
  if(action==='delete')return {schedule:null};
  const now=result.schedule&&typeof result.schedule==='object'?result.schedule as Record<string,unknown>:found;
  return {schedule:memberSchedule(now)};
}

async function readBody(req:IncomingMessage):Promise<Buffer> {
  const declared=Number(req.headers['content-length']??0);
  if(Number.isFinite(declared)&&declared>MEMBER_APP_BODY_MAX)throw new HttpError(413,'body_too_large');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);size+=bytes.length;
    if(size>MEMBER_APP_BODY_MAX)throw new HttpError(413,'body_too_large');chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
const parse=(raw:Buffer):unknown=>{try{return JSON.parse(raw.toString('utf8')) as unknown;}catch{throw new HttpError(400,'invalid_json');}};

/** An HTTP refusal thrown by this listener or the repository (an HttpError, or the {status,code} memberTaskQuery throws):
 * its status and fixed code, never details. */
function refusalOf(error:unknown):{status:number;code:string}|null {
  if(!error||typeof error!=='object')return null;
  const {status,code}=error as {status?:unknown;code?:unknown};
  return typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<600&&typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?{status,code}:null;
}

/** The members' app listener (MEMBER_APP_PORT in nocheh-app). */
export function memberAppServer(services:MemberAppServices,options:MemberAppOptions):Server {
  const server=createServer((req,res)=>{void handle(services,options,req,res).catch(error=>{
    if(res.headersSent){res.destroy();return;}
    const refusal=refusalOf(error);
    // Only the fixed code is ever written down: never the launch data, a body or a query.
    if(!refusal)console.warn(JSON.stringify({event:'member_app_failed',code:typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code).slice(0,64):'unknown'}));
    json(res,refusal?.status??503,{error:refusal?.code??'member_app_unavailable'});
  });});
  server.requestTimeout=30000;return server;
}

async function handle(services:MemberAppServices,options:MemberAppOptions,req:IncomingMessage,res:ServerResponse):Promise<void> {
  const url=new URL(req.url??'/','http://member.invalid'),method=req.method??'';
  // 1. No bearer of any kind: no turn pass or service token is ever read here.
  if(req.headers.authorization!==undefined)throw refuse('noBearer',400);
  // 2. Only the members' app routes; only GET tasks takes a query.
  const route=url.pathname.startsWith(MEMBER_APP_CORE_PREFIX+'/')?memberAppRoute(method,url.pathname.slice(MEMBER_APP_CORE_PREFIX.length)):null;
  if(!route||url.search&&route.name!=='tasks'||url.search.length>MEMBER_APP_QUERY_MAX)throw new HttpError(404,'not_found');
  // 3. A small body, POST only.
  const raw=method==='POST'?await readBody(req):Buffer.alloc(0);
  if(services.dataDir)assertStorageActive(services.dataDir);
  // 4. Telegram's signature for this bot, at most an hour old, from the member's own chat with the bot.
  const now=(options.now??Date.now)(),header=req.headers[MEMBER_LAUNCH_HEADER];
  const init=typeof header==='string'?header:'';
  let launch:LaunchUser;
  try {
    if(!isTelegramAccount(options.botId))throw Error('no_bot');
    launch=verifyLaunchUser(init,{botId:options.botId,key:options.key,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE,now});
  } catch {throw refuse('launchInvalid',401);}
  // 5. The owner has their own mini app.
  const policy=services.policy();
  if(policy.owner_id&&launch.user_id===String(policy.owner_id))throw refuse('memberRequired',403);
  // 6. An active member, by their account, now; nothing is read for anyone else. Without a known owner nobody is let in.
  const owner=policy.owner_id?ownerChat(policy):null;
  let account:string;try{account=accountIdFor('telegram',launch.user_id);}catch{throw refuse('closed',403);}
  const identity=owner?await identify(services.control,account,owner):null;
  if(!identity)throw refuse('closed',403);
  // 7. Older than the member's add or un-pause, or no newer than their last sign-out, on Telegram's clock.
  if(launch.auth_date<identity.appSince.getTime()/1000-MEMBER_APP_SINCE_SLACK_SECONDS)throw refuse('launchOld',401);
  if(identity.signedOut&&launch.auth_date<=identity.signedOut.getTime()/1000)throw refuse('signedOut',401);
  const db=services.control;
  if(route.name==='sign_out') {
    if(raw.length)object(parse(raw));
    // Every launch opened before now is refused from now on, on every phone (D13): up to this one's auth_date, or, when
    // another phone opened the app after this one, up to now less the minute of slack that covers Telegram's clock.
    const cutoff=Math.max(launch.auth_date,Math.floor(now/1000)-MEMBER_APP_SINCE_SLACK_SECONDS);
    await db.query(`INSERT INTO member_app_prefs AS p(member_id,signed_out_auth_date) VALUES($1,to_timestamp($2)) ON CONFLICT(member_id) DO UPDATE
      SET signed_out_auth_date=GREATEST(p.signed_out_auth_date,excluded.signed_out_auth_date),updated_at=now()`,[identity.member,cutoff]);
    return json(res,200,{});
  }
  // The member's own schedules (members' schedules): Personal assistant on and their private chat open; each change counts
  // as a write. Nothing else is read for them, and only their own private chat's schedules are listed or changed. Their
  // own time zone for new schedules is set here too (members' time zones).
  if(route.name==='schedules'||route.name==='schedule'||route.name==='time_zone') {
    if(!identity.assistant||!identity.chat||!services.schedules)throw refuse('schedulesOff',403);
    if(route.name==='schedules') {
      const answer:MemberSchedules={schedules:(await chatScheduleList(services.schedules,identity.chat)).map(memberSchedule),limit:identity.scheduleLimit,
        time_zone:identity.timeZone};
      return json(res,200,answer);
    }
    const body=parse(raw);
    let zone:string|null=null;
    if(route.name==='time_zone') {
      const request=object(body);
      if(Object.keys(request).some(key=>!['operation_id','time_zone'].includes(key))||!/^[a-zA-Z0-9-]{8,64}$/.test(string(request.operation_id,64)))
        throw new HttpError(400,'invalid_time_zone');
      zone=memberTimeZoneValue(request.time_zone);
    }
    try{await countMemberWrite(db,identity.member);}
    catch(error){if((error as {code?:unknown})?.code==='23503')throw refuse('closed',403);throw error;}
    if(route.name==='time_zone') {
      const answer:MemberTimeZone={time_zone:await setMemberTimeZone(db,identity.member,zone)};
      return json(res,200,answer);
    }
    return json(res,200,await changeSchedule(services.schedules,identity.chat,route.schedule!,body));
  }
  const write=MEMBER_APP_TASK_WRITES.includes(route.name);
  const body=write?parse(raw):undefined,query=route.name==='tasks'?memberTaskQuery(url.searchParams):undefined;
  // 8. The groups, asked of Telegram again on opening and before a change.
  if(route.name==='me'||write) {
    const {moved}=await recheckMemberAppGroups(db,services.call,identity.member,{owner});
    if(moved)await reloadMembers();
  }
  // 9. Write access, then the write limit.
  if(write) {
    if(identity.mode!=='write')throw refuse('readOnly',403);
    try{await countMemberWrite(db,identity.member);}
    catch(error){if((error as {code?:unknown})?.code==='23503')throw refuse('closed',403);throw error;}
  }
  // 10. The member's boards from the groups confirmed lately; a group Telegram could not confirm is left out. Each board is
  // its project's whole list, whatever the project's "Share group chats" (ADR-0276); the member's own list of groups (me)
  // stays the groups they are in.
  const groups=(await joinedGroups(db,identity.member,{owner,freshHours:MEMBER_RECHECK_HOURS})).filter(group=>group.fresh).map(group=>group.chat);
  const principal:MemberAppPrincipal=Object.freeze({member:identity.member,account:identity.account,accounts:Object.freeze([...identity.accounts]),
    name:launchName(init)??identity.display,mode:identity.mode,reminders:remindersState(identity),
    views:Object.freeze(await memberTaskViews(db,groups)),chat:identity.chat});
  switch(route.name) {
    case 'me':return json(res,200,await me(db,principal,groups,identity.assistant&&!!identity.chat&&!!services.schedules));
    case 'tasks':return json(res,200,await services.tasks.memberList(principal,query!));
    case 'task':return json(res,200,await services.tasks.memberGet(principal,route.task!));
    case 'create':return json(res,200,await services.tasks.memberCreate(principal,body));
    case 'update':return json(res,200,await services.tasks.memberUpdate(principal,route.task!,body));
    case 'comment':return json(res,200,await services.tasks.memberComment(principal,route.task!,body));
    case 'reminders':return json(res,200,await services.tasks.memberReminders(principal));
  }
  throw new HttpError(404,'not_found');
}
