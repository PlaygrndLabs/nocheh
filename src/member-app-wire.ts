// The members' app (step 5, ADR-0265): its routes, the shapes it sends and gets, and its error codes, shared by
// nocheh-miniapp (the edge), the member listener in nocheh-app and the member page (dashboard/member). Values and type
// imports only: the page reads this file too, so it imports nothing that runs on a server.
import type {MemberTasks} from './member-wire.js';

/** The edge's public prefix: the page calls `/api/member/<route>`. */
export const MEMBER_APP_PUBLIC_PREFIX='/api/member';
/** The member listener's prefix in nocheh-app: the edge forwards `/api/member/<route>` to `/v1/member-app/<route>`. */
export const MEMBER_APP_CORE_PREFIX='/v1/member-app';
/** The member listener's port in nocheh-app; the main listener (8780) refuses MEMBER_APP_CORE_PREFIX with 404. */
export const MEMBER_APP_PORT=8790;
/** The page itself, served by nocheh-miniapp beside the owner's `/`. */
export const MEMBER_APP_PAGE='/m/';
/** The header carrying Telegram's signed launch data on every call; it is never logged. */
export const MEMBER_LAUNCH_HEADER='x-telegram-init-data';
/** A request body over this many bytes is refused (413 body_too_large). */
export const MEMBER_APP_BODY_MAX=64*1024;
/** A query string (GET tasks only) over this many characters is refused with 404, as the owner's mini app does. */
export const MEMBER_APP_QUERY_MAX=600;
/** Writes per member: at most this many in 10 minutes and in a UTC day (member_app_limits), else 429 member_app_busy. */
export const MEMBER_APP_WRITES_PER_10_MIN=60,MEMBER_APP_WRITES_PER_DAY=500;
/** The page's own storage keys; it never reads the owner page's (nocheh.mini-session, nocheh.telegram-launch). */
export const MEMBER_APP_STORAGE_KEYS={launch:'nocheh.member-launch',ui:'nocheh.member-ui'} as const;

const TASK='[a-f0-9]{64}';
/** Each route's name, as memberAppRoute answers it. */
export type MemberAppRouteName='me'|'tasks'|'task'|'create'|'update'|'comment'|'reminders'|'sign_out';
/**
 * Every route of the members' app, as [method, path after the prefix, name]. Nothing else is forwarded by the edge or
 * answered by the member listener (404). Only `GET /tasks` takes a query.
 * - GET /me: MemberMe
 * - GET /tasks?MemberTaskQuery: MemberTaskPage
 * - GET /tasks/:id: MemberDetail
 * - POST /tasks MemberTaskCreateRequest: MemberDetail
 * - POST /tasks/:id MemberTaskUpdateRequest: MemberDetail (finish is {state:'done'}, trash {trashed:true}, the member's
 *   own reminders {reminders:[...ISO times with an offset]})
 * - POST /tasks/:id/comments MemberTaskCommentRequest: MemberDetail
 * - GET /reminders: MemberReminder[]
 * - POST /sign-out (no body): {}
 */
export const MEMBER_APP_ROUTES:readonly (readonly ['GET'|'POST',RegExp,MemberAppRouteName])[]=Object.freeze([
  ['GET',/^\/me$/,'me'],
  ['GET',/^\/tasks$/,'tasks'],
  ['GET',new RegExp(`^/tasks/(${TASK})$`),'task'],
  ['POST',/^\/tasks$/,'create'],
  ['POST',new RegExp(`^/tasks/(${TASK})$`),'update'],
  ['POST',new RegExp(`^/tasks/(${TASK})/comments$`),'comment'],
  ['GET',/^\/reminders$/,'reminders'],
  ['POST',/^\/sign-out$/,'sign_out'],
] as const);
/** The routes that write tasks: each needs write access and counts against the write limit (sign-out, which every member
 * has, does neither). */
export const MEMBER_APP_TASK_WRITES:readonly MemberAppRouteName[]=['create','update','comment'];
export interface MemberAppRouteMatch {name:MemberAppRouteName;task?:string}
/** The route `method path` names (path after the prefix, starting with '/', without the query), or null. */
export function memberAppRoute(method:string,path:string):MemberAppRouteMatch|null {
  for(const [m,re,name] of MEMBER_APP_ROUTES) {
    if(m!==method)continue;
    const found=re.exec(path);
    if(found)return found[1]?{name,task:found[1]}:{name};
  }
  return null;
}

/**
 * The members' app's own error codes, with the HTTP status each goes with (MEMBER_APP_ERROR_STATUS). The page shows the
 * reopen screen on any 401, the closed screen on member_app_closed, the members-only screen on member_required, and
 * reloads the drawer on conflict.
 */
export const memberAppErrors={
  /** 400: the member listener refuses any Authorization header, so no turn pass or service token mixes in. */
  noBearer:'member_app_no_bearer',
  /** 401: the launch data is missing, not Telegram's, for another bot, older than an hour, or from a group chat. */
  launchInvalid:'member_app_launch_invalid',
  /** 403: the owner opened the members' app. */
  memberRequired:'member_required',
  /** 403: a stranger, a paused or removed member, or an account linked to nobody; one answer for all, before any read. */
  closed:'member_app_closed',
  /** 401: the launch is older than when the member was added or un-paused (members.app_since, 60 s of slack). */
  launchOld:'member_app_launch_old',
  /** 401: the launch is no newer than the member's last sign-out (member_app_prefs.signed_out_auth_date). */
  signedOut:'member_app_signed_out',
  /** 429: past the write limit. */
  busy:'member_app_busy',
  /** 403: the member's tasks are read only. */
  readOnly:'task_read_only',
  /** 403: a field the app may not set: people, assignees, outside ids, the project, message attachments. A column the page
   * does not show, a person column included, answers 400 unknown_task_property, as a name no column has. */
  fieldNotAllowed:'task_field_not_allowed',
  /** 400: a list filter the app may not use, such as person. */
  filterNotAllowed:'task_filter_not_allowed',
  /** 403: "Reminders to themselves" is off for this member (in the app and in groups). */
  remindersOff:'task_reminders_off',
  /** 409: reminders cannot reach the member now (read only, reminders off, or their private chat is not open). */
  remindersUnavailable:'member_reminders_unavailable',
  /** 409: the task changed since the page read it (expected_version). */
  conflict:'conflict',
} as const;
export type MemberAppError=typeof memberAppErrors[keyof typeof memberAppErrors];
export const MEMBER_APP_ERROR_STATUS:Readonly<Record<MemberAppError,number>>={
  member_app_no_bearer:400,member_app_launch_invalid:401,member_required:403,member_app_closed:403,member_app_launch_old:401,
  member_app_signed_out:401,member_app_busy:429,task_read_only:403,task_field_not_allowed:403,task_filter_not_allowed:400,
  task_reminders_off:403,member_reminders_unavailable:409,conflict:409,
};

/** Why "Remind me" is hidden: tasks read only, "Reminders to themselves" off, or the member's private chat with Nocheh
 * not open (private chat off, or never started). */
export type MemberRemindersReason='read_only'|'reminders_off'|'private_chat_off';
export type MemberRemindersState={available:true}|{available:false;reason:MemberRemindersReason};
/** A group's task board in the members' app: its project is active ('open'), it is in no project ('none'), or its
 * project is not active ('closed'). */
export type MemberGroupBoard='open'|'none'|'closed';
/** One group the member is in now and Nocheh serves, with its Telegram title. `project` (an id in MemberMe.projects)
 * and `open_count` only when board is 'open'. */
export interface MemberMeGroup {id:string;title:string|null;board:MemberGroupBoard;project:string|null;open_count?:number}
/** GET /me. `name` is the member's Telegram name; `projects` the active projects holding one of their groups (one board
 * each), by name. Nothing here names the owner, other members, or the owner's time zone. */
export interface MemberMe {name:string;mode:MemberTasks;reminders:MemberRemindersState;projects:{id:string;name:string}[];
  groups:MemberMeGroup[]}

/** Who did something, as the app shows it: the owner, a member by their Telegram name, or Nocheh. Never the owner's
 * names for people. */
export type MemberActor={kind:'owner'}|{kind:'member';name?:string}|{kind:'nocheh'};
/** An assignee the member may see: by their Telegram name only. */
export interface MemberAssignee {name:string}
/** One of the member's own pending reminders on a task. */
export interface MemberTaskReminder {id:string;at:string;state:'pending'}
/** A task as a row of the members' app (memberTask in src/stores/tasks.ts names every field it emits). `version` is
 * opaque and goes back as expected_version. `created_at` and `created_by` only when the task was made on this board,
 * `finished_by` only when it was finished there; otherwise `on_board_since` says when it joined. `properties` holds the
 * shared columns but person columns. `assignees` are those who do it, each by their Telegram name, shown only when the
 * owner linked them to a Telegram account that is in one of the member's groups on this board now; `assignees_other`
 * counts every other assignee (shown as "N other people"). Never the owner's own names for people, and never who the
 * task is about. `subtasks` counts only the subtasks the member sees. `mine`: the member made it, set a reminder on it,
 * or is one of its assignees. `group` is the group it is set on, a task in one of its topics included; null on the
 * whole project. */
export interface MemberTask {
  id:string;version:string;project:string;group:string|null;parent_id:string|null;
  title:string;status:string;state:'open'|'done'|'dropped';priority:number;
  start_on:string|null;start_time:string|null;due_on:string|null;due_time:string|null;
  tags:string[];properties:Record<string,unknown>;assignees:MemberAssignee[];assignees_other:number;subtasks:{open:number;total:number};comments:number;
  archived:boolean;trashed:boolean;mine:boolean;
  on_board_since:string|null;created_at?:string;updated_at:string;done_at:string|null;
  created_by?:MemberActor;finished_by?:MemberActor;
  reminders:{mine:MemberTaskReminder[];others:number};
}
export interface MemberTaskLink {id:string;title:string;state:'open'|'done'|'dropped'}
export interface MemberComment {id:string;body:string;author:MemberActor;created_at:string}
/** One history entry from when the task joined this board, groups the member does not reach shown as none. */
export interface MemberActivity {at:string;actor:MemberActor;changes:Record<string,unknown>}
/** A task in the drawer: the row, its notes, the links and subtasks the member sees, web links, and the comments and
 * history from when it joined the board. */
export interface MemberDetail extends MemberTask {
  notes:string;repeat:Record<string,unknown>|null;
  blocked_by:MemberTaskLink[];related:MemberTaskLink[];duplicate_of:MemberTaskLink[];children:MemberTaskLink[];
  attachments:{kind:'link';url:string;title:string}[];
  comment_list:MemberComment[];activity:MemberActivity[];
}
/** A status a task may have, from the owner's task settings: `state` is what it means (open, done or dropped). */
export interface MemberTaskStatus {id:string;name:string;state:'open'|'done'|'dropped'}
/** A column the owner shares with project chats, as a task's `properties` key it by id; never a private or person column.
 * `options` only for a select or multi-select column. */
export interface MemberTaskColumn {id:string;name:string;type:string;options?:{id:string;name:string}[]}
/** GET /tasks: one page of one project's board. `next` goes back as `cursor`; `tags` are the tags of tasks the member
 * sees; `statuses` and `columns` name a task's status and shared columns. */
export interface MemberTaskPage {tasks:MemberTask[];next:string|null;tags:string[];statuses:MemberTaskStatus[];columns:MemberTaskColumn[]}
/** GET /reminders: every pending reminder the member set, on tasks they still see. */
export interface MemberReminder {id:string;at:string;task:{id:string;title:string;project:string}}

/** GET /tasks filters. `project` is required (one board at a time); state defaults to open; trash lists the trash. */
export interface MemberTaskQuery {project:string;group?:string;mine?:true;state?:'open'|'done';trash?:true;tag?:string;cursor?:string}
const QUERY_KEYS=['project','group','mine','state','trash','tag','cursor'];
/** Reads GET /tasks filters from the address. Any other key (such as person), a repeated key or a bad value is refused
 * with 400 task_filter_not_allowed (thrown as {status,code}, which HttpError matches). */
export function memberTaskQuery(params:URLSearchParams):MemberTaskQuery {
  const refuse=()=>{throw Object.assign(new Error(memberAppErrors.filterNotAllowed),{status:400,code:memberAppErrors.filterNotAllowed});};
  const keys=[...params.keys()];
  if(new Set(keys).size!==keys.length||keys.some(key=>!QUERY_KEYS.includes(key)))refuse();
  const project=params.get('project')??'';if(!/^[a-f0-9]{64}$/.test(project))refuse();
  const query:MemberTaskQuery={project};
  const group=params.get('group');if(group!==null){if(!group||group.length>256)refuse();query.group=group;}
  const flag=(key:'mine'|'trash')=>{const value=params.get(key);if(value===null)return;if(value!=='1')refuse();query[key]=true;};
  flag('mine');flag('trash');
  const state=params.get('state');if(state!==null){if(state!=='open'&&state!=='done')refuse();query.state=state as 'open'|'done';}
  const tag=params.get('tag');if(tag!==null){if(!tag.trim()||tag.length>40)refuse();query.tag=tag;}
  const cursor=params.get('cursor');if(cursor!==null){if(!/^\d{1,9}$/.test(cursor))refuse();query.cursor=cursor;}
  return query;
}

/** The fields a member may set on a new task or change on one (D7). `group` null is the whole project; `parent` is a
 * task they see; `attachments` take web links only. */
export const MEMBER_TASK_CREATE_FIELDS=['title','notes','status','priority','start_on','start_time','due_on','due_time','repeat','parent','group','tags',
  'properties','blocked_by','related','duplicate_of','attachments'] as const;
export const MEMBER_TASK_PATCH_FIELDS=[...MEMBER_TASK_CREATE_FIELDS,'state','reminders','archived','trashed'] as const;
/** Fields refused with 403 task_field_not_allowed (message attachments too; a person column inside `properties` answers
 * 400 unknown_task_property, as any column the page does not show). */
export const MEMBER_TASK_REFUSED_FIELDS=['people','assignees','external','scope','position','expected_revision'] as const;
export type MemberTaskField=typeof MEMBER_TASK_PATCH_FIELDS[number];
export type MemberTaskPatch=Partial<Record<MemberTaskField,unknown>>;
/** POST /tasks: `operation_id` is one uuid per action (a retry sends the same); `project` one of the member's boards. */
export interface MemberTaskCreateRequest extends Partial<Record<typeof MEMBER_TASK_CREATE_FIELDS[number],unknown>> {operation_id:string;project:string;title:string}
/** POST /tasks/:id. */
export interface MemberTaskUpdateRequest {operation_id:string;expected_version:string;patch:MemberTaskPatch}
/** POST /tasks/:id/comments: text only; a comment is never removed from the app. */
export interface MemberTaskCommentRequest {operation_id:string;text:string}
