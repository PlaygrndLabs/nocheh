import {createHmac,randomBytes} from 'node:crypto';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {approvalLines,fillTemplate,memberReminder,memberReminderLines,ownerPrompts,reminderLines,taskReminder} from '../prompts.js';
import {noticeDigest} from '../notice-authorize.js';
import {limit} from '../retrieval.js';
import type {RuntimeCall} from '../runtime.js';
import {groupChatId,groupSpace,groupSpaces,readSetParam,readSetSql,validateSpace,type ReadSet} from '../spaces.js';
import {telegramTarget} from '../frontdoor/telegram.js';
import {chatIdSql,chats as directory,type ChatDirectory} from '../chats.js';
import {telegramUsername} from '../chats-telegram.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {MEMBER_TASK_CREATE_FIELDS,MEMBER_TASK_PATCH_FIELDS,MEMBER_TASK_REFUSED_FIELDS,memberAppErrors,type MemberActivity,type MemberActor,type MemberComment,
  type MemberDetail,type MemberReminder,type MemberRemindersState,type MemberTask,type MemberTaskColumn,type MemberTaskLink,type MemberTaskPage,type MemberTaskQuery,
  type MemberTaskStatus} from '../member-app-wire.js';
import type {MemberTasks} from '../member-wire.js';
import {cardName} from '../action-text.js';
import {fillLine,labelName,placeLabel,quotedName} from '../chat-labels.js';
import {memberReminderText,mergedReminder,nameKeys,reminderText,setByLine,unitCut,wellFormed,whoKeySql,type MemberWords,type Names,type ReminderRow,type Words,
  type Writer} from '../task-reminder-text.js';
import {MEMBER_RECHECK_HOURS,recheckMemberAppGroups} from './member-reads.js';
import {reloadMembers} from './members.js';
import {memberLane,skippedLine,skippedReference,type MemberSend,type ReminderSkip} from './task-reminder-delivery.js';
import {currentChats} from './chats.js';
import {peopleNames} from './people-names.js';
import {accountPeopleNames} from './entities.js';
import {addDays,daysBetween,nextRepeat,readRepeat,readTaskSettings,setOwnerTimeZone,stateOf,storedTaskSettings,type StatusCategory,type TaskSettings} from './task-settings.js';

export const taskSchema=`
-- Dev mode: a list made before statuses existed is replaced, not converted.
DO $$BEGIN
 IF to_regclass('owner_tasks') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='owner_tasks' AND column_name='status_id') THEN
  DROP TABLE IF EXISTS owner_task_operations,owner_task_people,owner_tasks CASCADE;
 END IF;
END$$;
CREATE TABLE IF NOT EXISTS owner_task_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(settings)='object'),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO owner_task_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
-- The key of the members' task versions (step 5, ADR-0265 D6): random, made once by the first member read, and kept, so a
-- version read before a restart still matches. It is never sent, logged or exported.
CREATE TABLE IF NOT EXISTS owner_task_version_key (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 key bytea NOT NULL CHECK(length(key)=32),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS owner_tasks (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=20000),
 status_id text NOT NULL CHECK(status_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','done','dropped')),
 priority smallint NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 4),
 start_on date,start_time time,due_on date,due_time time,
 repeat jsonb CHECK(repeat IS NULL OR jsonb_typeof(repeat)='object'),
 repeated_to text CHECK(repeated_to IS NULL OR repeated_to ~ '^[a-f0-9]{64}$'),
 parent_id text REFERENCES owner_tasks(id) ON DELETE CASCADE,
 position double precision NOT NULL DEFAULT 0,
 project_id text REFERENCES projects(id),
 group_id text CHECK(group_id IS NULL OR length(group_id) BETWEEN 1 AND 256),
 tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20),
 properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(properties)='object'),
 external jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(external)='object'),
 origin text NOT NULL CHECK(origin IN ('dashboard','chat','repeat','app')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 created_by jsonb NOT NULL DEFAULT '{"kind":"owner"}'::jsonb,finished_by jsonb,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),done_at timestamptz,
 archived_at timestamptz,deleted_at timestamptz,
 CHECK(start_time IS NULL OR start_on IS NOT NULL),CHECK(due_time IS NULL OR due_on IS NOT NULL),CHECK(parent_id<>id)
);
-- When a task joined its project's list: the chats that see it see its comments and history only from then
-- (ADR-0243, ADR-0276).
ALTER TABLE owner_tasks ADD COLUMN IF NOT EXISTS project_since timestamptz;
-- Who made the task, by their account (a chat_accounts id) when a person made it, in a group or the members' app (step
-- 5): the members' app's "Mine" reads it. Null for the owner, Nocheh and a repeat.
ALTER TABLE owner_tasks ADD COLUMN IF NOT EXISTS created_by_account text CHECK(created_by_account IS NULL OR created_by_account ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS owner_tasks_created_by_account ON owner_tasks(created_by_account) WHERE created_by_account IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_tasks_listing ON owner_tasks(state,due_on,created_at);
CREATE INDEX IF NOT EXISTS owner_tasks_scope ON owner_tasks(project_id,state);
CREATE INDEX IF NOT EXISTS owner_tasks_parent ON owner_tasks(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_tasks_group ON owner_tasks(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_tasks_tags ON owner_tasks USING gin(tags);
-- The people a task is for: who does it (assignee) and who it is about (person), from the people Nocheh knows.
CREATE TABLE IF NOT EXISTS owner_task_people (
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 entity_id text NOT NULL REFERENCES memory_entities(id),
 role text NOT NULL DEFAULT 'person' CHECK(role IN ('assignee','person')),
 PRIMARY KEY(task_id,role,entity_id)
);
CREATE INDEX IF NOT EXISTS owner_task_people_entity ON owner_task_people(entity_id);
-- A task waits on another (blocked_by), is related to it, or repeats it (duplicate_of).
CREATE TABLE IF NOT EXISTS owner_task_links (
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 other_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('blocked_by','related','duplicate_of')),
 PRIMARY KEY(task_id,kind,other_id),CHECK(task_id<>other_id)
);
CREATE INDEX IF NOT EXISTS owner_task_links_other ON owner_task_links(other_id);
CREATE TABLE IF NOT EXISTS owner_task_reminders (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 remind_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','skipped')),
 sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_task_reminders_due ON owner_task_reminders(remind_at) WHERE state IN ('pending','sending');
CREATE INDEX IF NOT EXISTS owner_task_reminders_task ON owner_task_reminders(task_id);
-- Who set each reminder and where (ADR-0255): the owner, or a person allowed in a group with their account (a
-- chat_accounts id, digests only) and the name Telegram showed then; the group or topic it was set in and that chat's
-- group at set time, which keys the gap between people's merged reminders. Both are null for the owner's private chat,
-- the dashboard, the API and a card. An insert that names no setter fails. A reminder Telegram refused is 'failed'.
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_by text NOT NULL DEFAULT 'owner';
ALTER TABLE owner_task_reminders ALTER COLUMN set_by DROP DEFAULT;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_by_account_id text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_by_name text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_in_chat_id text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_in_group_id text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS batch_id text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS tries integer NOT NULL DEFAULT 0;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS set_via text NOT NULL DEFAULT 'chat';
ALTER TABLE owner_task_reminders DROP CONSTRAINT IF EXISTS owner_task_reminders_state_check;
ALTER TABLE owner_task_reminders ADD CONSTRAINT owner_task_reminders_state_check CHECK(state IN ('pending','sending','sent','uncertain','skipped','failed'));
ALTER TABLE owner_task_reminders DROP CONSTRAINT IF EXISTS owner_task_reminders_setter_check;
ALTER TABLE owner_task_reminders ADD CONSTRAINT owner_task_reminders_setter_check CHECK(set_by IN ('owner','person')
 AND (set_by='person' OR set_by_account_id IS NULL AND set_by_name IS NULL)
 AND (set_by='owner' OR set_in_chat_id IS NOT NULL OR set_via='app') AND (set_in_chat_id IS NULL)=(set_in_group_id IS NULL)
 AND (set_by_account_id IS NULL OR set_by_account_id ~ '^[a-f0-9]{64}$') AND (set_by_name IS NULL OR length(set_by_name) BETWEEN 1 AND 100)
 AND (set_in_chat_id IS NULL OR ${chatIdSql('set_in_chat_id')}) AND (set_in_group_id IS NULL OR ${chatIdSql('set_in_group_id')})
 AND (batch_id IS NULL OR batch_id ~ '^[a-f0-9]{64}$') AND tries>=0);
-- Step 5 (ADR-0265 D9, D10): where a person's reminder was set, in a chat or in the members' app ('app': no chat and no
-- group, so the member's private chat is never stored as a place), and, while it is being sent to the member who set it,
-- the private chat it goes to and the digest of its text, which the gateway's one-time check (/internal/notices/authorize)
-- compares. The setter check is widened for 'app'.
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS deliver_chat text;
ALTER TABLE owner_task_reminders ADD COLUMN IF NOT EXISTS notice_digest text;
ALTER TABLE owner_task_reminders DROP CONSTRAINT IF EXISTS owner_task_reminders_via_check;
ALTER TABLE owner_task_reminders ADD CONSTRAINT owner_task_reminders_via_check CHECK(set_via IN ('chat','app')
 AND (set_via='chat' OR set_by='person' AND set_by_account_id IS NOT NULL AND set_in_chat_id IS NULL AND set_in_group_id IS NULL)
 AND (deliver_chat IS NULL OR ${chatIdSql('deliver_chat')}) AND (notice_digest IS NULL OR notice_digest ~ '^[a-f0-9]{64}$'));
CREATE INDEX IF NOT EXISTS owner_task_reminders_people ON owner_task_reminders(set_in_group_id,remind_at) WHERE set_by='person' AND state='pending';
CREATE INDEX IF NOT EXISTS owner_task_reminders_batch ON owner_task_reminders(batch_id) WHERE batch_id IS NOT NULL;
-- People's reminders due together in one group, sent as one message (ADR-0255): the text is kept, so a resend after a
-- lost answer sends the same message under the same id. A group gets at most one every 10 minutes; a failed one takes
-- no turn. Kept a day after it went out, or after it was made when it never went.
CREATE TABLE IF NOT EXISTS owner_task_reminder_batches(
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 group_id text NOT NULL CHECK(${chatIdSql('group_id')}),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 4096),
 state text NOT NULL DEFAULT 'sending' CHECK(state IN ('sending','sent','uncertain','failed')),
 tries integer NOT NULL DEFAULT 0 CHECK(tries>=0),
 created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS owner_task_reminder_batches_group ON owner_task_reminder_batches(group_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS owner_task_reminder_batches_open ON owner_task_reminder_batches(group_id) WHERE state='sending';
-- Who last wrote a task's title, notes, due day, or closed it, anywhere but the owner's private chat or the dashboard
-- (ADR-0255): a reminder names them. No row means the owner there.
CREATE TABLE IF NOT EXISTS owner_task_writers(
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 field text NOT NULL CHECK(field IN ('title','notes','due','closed')),
 by text NOT NULL CHECK(by IN ('owner','person')),
 account_id text CHECK(account_id IS NULL OR account_id ~ '^[a-f0-9]{64}$'),
 name text CHECK(name IS NULL OR length(name) BETWEEN 1 AND 100),
 chat_id text NOT NULL CHECK(${chatIdSql('chat_id')}),group_id text NOT NULL CHECK(${chatIdSql('group_id')}),
 at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,field),CHECK(by='person' OR account_id IS NULL AND name IS NULL)
);
-- Step 5 (ADR-0265 D9): a person who wrote in the members' app ('app') is stored with no chat and no group; 'chat'
-- rows keep both.
ALTER TABLE owner_task_writers ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'chat';
ALTER TABLE owner_task_writers ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE owner_task_writers ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE owner_task_writers DROP CONSTRAINT IF EXISTS owner_task_writers_via_check;
ALTER TABLE owner_task_writers ADD CONSTRAINT owner_task_writers_via_check CHECK(via='chat' AND chat_id IS NOT NULL AND group_id IS NOT NULL
 OR via='app' AND by='person' AND account_id IS NOT NULL AND chat_id IS NULL AND group_id IS NULL);
CREATE TABLE IF NOT EXISTS owner_task_comments (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 author jsonb NOT NULL,origin text NOT NULL CHECK(origin IN ('dashboard','chat','app')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_task_comments_task ON owner_task_comments(task_id,created_at);
-- What changed on a task, by whom and from where.
CREATE TABLE IF NOT EXISTS owner_task_activity (
 id bigserial PRIMARY KEY,
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 at timestamptz NOT NULL DEFAULT now(),actor jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('dashboard','chat','repeat','reminder','app')),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object')
);
CREATE INDEX IF NOT EXISTS owner_task_activity_task ON owner_task_activity(task_id,id DESC);
-- Step 5 (ADR-0265 D7): the members' app writes with origin 'app'. A store made before it has the three origin checks
-- without it, under the names Postgres gave them: each check on origin that lacks 'app' is dropped and made again.
DO $$DECLARE item record;BEGIN
 FOR item IN SELECT c.conrelid::regclass::text AS tab,c.conname FROM pg_constraint c
   WHERE c.contype='c' AND c.conrelid IN ('owner_tasks'::regclass,'owner_task_comments'::regclass,'owner_task_activity'::regclass)
     AND pg_get_constraintdef(c.oid) LIKE '%origin%' AND pg_get_constraintdef(c.oid) NOT LIKE '%''app''%' LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',item.tab,item.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='owner_tasks'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%origin%') THEN
  ALTER TABLE owner_tasks ADD CONSTRAINT owner_tasks_origin_check CHECK(origin IN ('dashboard','chat','repeat','app'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='owner_task_comments'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%origin%') THEN
  ALTER TABLE owner_task_comments ADD CONSTRAINT owner_task_comments_origin_check CHECK(origin IN ('dashboard','chat','app'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='owner_task_activity'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%origin%') THEN
  ALTER TABLE owner_task_activity ADD CONSTRAINT owner_task_activity_origin_check CHECK(origin IN ('dashboard','chat','repeat','reminder','app'));
 END IF;
END$$;
-- Archived messages and files, or web links, that belong with a task.
CREATE TABLE IF NOT EXISTS owner_task_attachments (
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 position integer NOT NULL,kind text NOT NULL CHECK(kind IN ('message','link')),
 event_id text CHECK(event_id IS NULL OR event_id ~ '^[a-f0-9]{64}$'),
 url text CHECK(url IS NULL OR length(url) BETWEEN 1 AND 2000),
 title text NOT NULL DEFAULT '' CHECK(length(title)<=200),
 PRIMARY KEY(task_id,position),CHECK((kind='message')=(event_id IS NOT NULL)),CHECK((kind='link')=(url IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS owner_task_operations (
 operation_id text PRIMARY KEY,task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
-- A change asked in the owner's private chat that a project's chats would see, waiting for the owner's card: the exact
-- request, the list and the chats the card names, and the task as those chats would see it (ADR-0243).
CREATE TABLE IF NOT EXISTS owner_task_requests (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('add','update','comment')),
 task_id text CHECK(task_id IS NULL OR task_id ~ '^[a-f0-9]{64}$'),
 operation_id text NOT NULL,body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 project_id text NOT NULL,joining boolean NOT NULL,chats text[] NOT NULL,
 preview jsonb NOT NULL CHECK(jsonb_typeof(preview)='object'),source_reference jsonb NOT NULL,
 -- The tasks under a moved task as the card showed them, and the revision of a commented task.
 family text CHECK(family IS NULL OR family ~ '^[a-f0-9]{64}$'),revision integer,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','done','rejected','changed','refused')),
 error_code text,result_task text,created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz
);
-- The group the task would be labelled with: null for a task set on the project itself. Every chat of the project
-- sees the task whatever its group, and the card names them all (ADR-0276).
ALTER TABLE owner_task_requests ADD COLUMN IF NOT EXISTS group_id text;
`;

export type TaskState='open'|'done'|'dropped';
/** Where a change came from: the dashboard (and the owner's mini app), a chat turn, or the members' app (step 5). */
export type Origin='dashboard'|'chat'|'app';
/** Who did something to a task: the owner, someone allowed in a project's chat, or Nocheh itself. */
export type TaskActor={kind:'owner'}|{kind:'member';name?:string}|{kind:'nocheh'};
/**
 * The live turn asking. `project` null is the owner's private chat, which reaches every list. A group or topic turn
 * names its project and its own conversation (`group`, the label a task added there gets). Every chat of a project
 * reads and changes that project's whole list, whatever each task's group (ADR-0276). An "Answer privately" answer
 * reads its project's list and changes nothing (`readOnly`).
 */
type Turn={source:{reference:{id:string}};project:string|null;group:string|null;readOnly?:boolean;actor?:TaskActor;
  /** A group or topic turn: the conversations that chat shares what it knows with. It grants nothing; it only marks an
   *  answer that shows a task labelled with a group outside it `other_groups` (ADR-0276). */
  reach?:ReadSet;
  /** The person's account (a chat_accounts id) in a group turn; null for the owner, or when it could not be told. */
  account?:string|null;
  /** A member's private chat (D14): one read-only view per active project holding one of their joined groups, each
   *  reading that project's whole list. When present, `project` null never means every list: the turn lists and reads through
   *  these views alone, and writes nothing. */
  views?:readonly TaskView[];
  /** With `views`: every account of the member whose private chat it is, which a task's `mine` and reminders read. */
  accounts?:readonly string[]};
/** One board a member reads (D14, ADR-0265 D5): its project, its name and `home`, the member's first own group in it,
 * which a plain add in the members' app is labelled with. A board holds the project's whole list (ADR-0276). */
export type TaskView={readonly project:string;readonly name:string;readonly home:string};
/**
 * Who calls the members' app (step 5, ADR-0265 D7), as the member listener built it for one request after its checks:
 * never a Reader, never a turn. `member` is the members row; `account` the chat_accounts id of the Telegram user who
 * launched the app, and `accounts` all of that member's accounts ("Mine" counts tasks made, or with reminders set, by
 * any of them); `name` the launch's Telegram name, which a task's history and comments show; `mode` the member's Tasks
 * permission; `reminders` whether "Remind me" may set a reminder now; `views` the member's boards (memberTaskViews over
 * the groups joined and confirmed within MEMBER_RECHECK_HOURS); `chat` the member's open private chat with Nocheh, null
 * when there is none (reminders then unavailable).
 */
export interface MemberAppPrincipal {readonly member:string;readonly account:string;readonly accounts:readonly string[];readonly name:string|null;
  readonly mode:MemberTasks;readonly reminders:MemberRemindersState;readonly views:readonly TaskView[];readonly chat:string|null}
/** At most this many projects are named in one task_project_required refusal; `more` says there are others. */
export const TASK_PROJECTS_NAMED=50;
/** 400 when a member's private chat lists tasks without naming which of several projects (D14): `projects` names the
 *  ones it may choose, and only those, at most TASK_PROJECTS_NAMED (`more: true` when it may choose others too). */
export class TaskProjectRequired extends HttpError {
  readonly details:{projects:{id:string;name:string}[];more?:true};
  constructor(views:readonly TaskView[]){
    super(400,'task_project_required');
    this.details={projects:views.slice(0,TASK_PROJECTS_NAMED).map(view=>({id:view.project,name:view.name})),...(views.length>TASK_PROJECTS_NAMED?{more:true as const}:{})};
  }
}
/**
 * Who sets a reminder or writes a task, and where (ADR-0255): the owner, or a person allowed in a group with their
 * account and the name Telegram showed; the group or topic of the turn and its group. `chat` is null for the owner in
 * their private chat, the dashboard, the mini app, the API and a card the owner approved (OWNER_HERE). A member in the
 * members' app (step 5, ADR-0265 D9) is `via` 'app': a person with their account, and no chat and no group, so their
 * private chat is never stored as a place; every other setter is 'chat' (the default).
 */
/** Who sets a reminder or writes a field, and where. A member in the members' app also carries every account of theirs
 * (`accounts`), so a reminder any of them set is their own there, as the app shows it (memberTask). */
type Setter={by:'owner'|'person';account:string|null;name:string|null;chat:string|null;group:string|null;via?:'chat'|'app';accounts?:readonly string[]};
const OWNER_HERE:Setter=Object.freeze({by:'owner',account:null,name:null,chat:null,group:null});
/** Whether a setter is a member in the members' app: a person with an account and no chat. */
const viaApp=(setter:Setter)=>setter.via==='app'&&setter.by==='person'&&!!setter.account;
/** The owner where only the owner writes (their private chat, the dashboard, the owner's mini app, a card): no writer
 * row and no place. A member in the members' app has no chat either, but is never this. */
const ownerHere=(setter:Setter)=>setter.chat===null&&!viaApp(setter);
/** A writer row's columns for a setter (by, account_id, name, chat_id, group_id, via): a member in the members' app has
 * no chat and no group (never their private chat); a chat setter's group falls back to its chat. */
const writerColumns=(setter:Setter)=>viaApp(setter)?['person',setter.account,setter.name,null,null,'app']
  :[setter.by,setter.by==='person'?setter.account:null,setter.by==='person'?setter.name:null,setter.chat,setter.group??setter.chat,'chat'];
/** A reminder or writer as the stored columns name its setter. */
const whoOf=(by:unknown,account:unknown,name:unknown)=>({by:by==='person'?'person' as const:'owner' as const,account:typeof account==='string'?account:null,name:typeof name==='string'?name:null});
/** What a change tells after it commits: the owner's reminders a person's list left (their times), and the reminders
 * set elsewhere that the owner's message in a group removed (ADR-0255). */
type Effects={kept?:string[];removed?:{chat:string;ids:string[];times:string[]}};
/** A notice's answer: sent, unclear, Telegram not connected, refused (never sent, never tried again), worth the same id
 * again (`retry`, up to 5 tries), or `stop`: Telegram cannot be reached or is not set up, so this pass ends. */
type Outcome={kind:'done'|'ambiguous'|'not_started'|'refused'|'retry'|'stop';status:number};
/** A due day in a reminder's words, as before: "Fri 4 Jan 2030, 09:30". */
const dueWords=(on:string|null,time:string|null)=>on?new Date(on+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})+
  (time?', '+time:''):null;
/** A group's turn for a merged reminder is taken while one is being sent or one went out in the last 10 minutes; a
 * refused one takes none. `group` is the SQL of the group. */
const busy=(group:string)=>`SELECT 1 FROM owner_task_reminder_batches b WHERE b.group_id=${group} AND (b.state='sending'
  OR b.state IN ('sent','uncertain') AND coalesce(b.sent_at,b.created_at)>now()-interval '10 minutes')`;
/** What a reminder can tell a person about the owner's reminders it kept (ADR-0255), model-facing. */
const OWNER_KEPT='The owner\'s reminders stay; only the owner can remove them.';
/** Delivery for reminders: the runtime, the owner's private chat, the assistant policy (with it, reminder labels read
 * who is a member now from the member directory) and a record for System › Health of a reminder Telegram refused or
 * never confirmed. */
type Delivery={call:RuntimeCall;owner:()=>string|null|undefined;policy?:()=>Pick<AssistantPolicy,'owner_id'>;
  record?:(send:ReminderRecord)=>Promise<void>};
/** A reminder System › Health shows (ChatSendRepository.recordLocal): one Telegram refused or never confirmed, or (step 5)
 * the app reminders a member set that could not reach them, one line per member per day: `count` how many this pass
 * skipped, added to the day's line, and `detail` that line as one and as many ({count} filled in with the day's total). */
export type ReminderRecord={kind:'notice';chat:string|null;state:'failed'|'uncertain';status:number;reference:string}&(
  {error_code:'reminder_refused'|'reminder_unconfirmed'}|{error_code:'reminder_skipped';count:number;detail:{one:string;many:string}});
/** `card`: asked in the owner's private chat, so a change a project's chats would see waits for the owner's card.
 * `approved`: the card the owner approved; its change lands only in the list, and before the chats, the card named,
 * and only while the tasks under a moved task, and a commented task, are as the card showed them. */
type Approved={project:string;group:string|null;chats:string[];family:string|null;revision:number|null};
/** `within`: in a project's chat, the members' app or a member's private chat, the project whose whole list it reads
 * and changes (ADR-0276). */
type Context={origin:Origin;actor:TaskActor;source:string|null;within:string|null;chat:boolean;card?:boolean;approved?:Approved;setter:Setter};
/** Who reads a task: the owner (null), or a project's chat, which sees that project's whole list with the columns the
 * owner shares, and a task's group only when it is one of `groups`, the groups assigned to the project now (ADR-0276). */
type View={project:string;shared:Set<string>;groups:ReadonlySet<string>}|null;
/** A change held for the owner's card instead of written: the list it lands in, the group in it (null: the project
 * itself), the chats that will see the task, whether the task joins them, the task as those chats would see it, the
 * tasks that move with it (`family`) and the revision of a task commented on. */
type Held={held:{project:string;group:string|null;chats:string[];joining:boolean;preview:Record<string,unknown>;family:string|null;revision:number|null}};
const states=['open','done','dropped'];
const hex=/^[a-f0-9]{64}$/;
/** The chats that see a project's list: the groups and topics assigned to it. `groups` is the placeholder of a `text[]`
 * holding groupSpaces(), so anything the chat directory does not hold as a group or a topic of one counts as private
 * and is left out, by the same test as groupSpace, and the chats a card names are the chats that read the list
 * (ADR-0243, ADR-0252). */
const projectChats=(project:string,groups:string)=>`(SELECT coalesce(array_agg(a.space_id ORDER BY a.space_id),'{}'::text[]) FROM project_assignments a
  WHERE a.project_id=${project} AND a.mode='assigned' AND a.space_id=ANY(${groups}::text[]))`;
/**
 * Fields a change asked in the owner's private chat may set on a task in a project's list without a card: its status,
 * priority, start and due days and times, archive and trash, its group, which is only a label every chat of the
 * project already sees past (ADR-0276), and the list it is already in. This is the recommended
 * default of the Members plan, pending the owner's confirmation (TASK.md). Any other field, such as repeat or
 * reminders, a move into a project's list, and a comment wait for the owner's card.
 */
const direct=new Set(['expected_revision','status','state','priority','start_on','start_time','due_on','due_time','archived','trashed','scope','group']);
/** Whether a reader sees a task (ADR-0276): the owner sees every task; a project's chat sees every task of that
 * project's list, whatever its group, and no other. */
const sees=(view:{project:string}|null,task:{project_id:string|null}):boolean=>!view||task.project_id===view.project;
/** The same test in SQL on the task columns prefixed `alias`, with the project bound as the placeholder `project`. */
const seesSql=(alias:string,project:string)=>`(${alias}project_id=${project}::text)`;
/** Whether a project view shows a group or topic named on a task or in its history: a group, or one of its topics,
 * assigned to the view's project now. A group that left the project, another project's, and anything that is not
 * clearly a group or topic show as none (ADR-0242, ADR-0276). */
const seesGroup=(view:{groups:ReadonlySet<string>}|null,space:unknown):space is string=>
  typeof space==='string'&&!!view&&groupSpace(space)&&view.groups.has(directory().groupOf(space)!);
/** A linked task as a project's chat sees it: its group only when that is a group or topic of the project now, else
 * none, as on the task itself (ADR-0276). */
const seenLink=(view:View,item:any)=>view?{...item,group_id:seesGroup(view,item.group_id)?item.group_id:null}:item;
/** The groups assigned to a project now, as the chats of its list are (projectChats): groups only, never a topic. */
async function projectGroupSet(db:Pick<pg.Pool,'query'>,project:string):Promise<ReadonlySet<string>> {
  return new Set(((await db.query(`SELECT ${projectChats('$1','$2')} AS chats`,[project,groupSpaces()])).rows[0].chats as string[]).filter(groupChatId));
}

const linked=(kind:string,column:string,match:string)=>`coalesce((SELECT json_agg(json_build_object('id',o.id,'title',o.title,'state',o.state,'project_id',o.project_id,'group_id',o.group_id) ORDER BY o.created_at,o.id)
  FROM owner_task_links l JOIN owner_tasks o ON o.id=l.${column} WHERE l.kind='${kind}' AND l.${match}=owner_tasks.id AND o.deleted_at IS NULL),'[]'::json)`;
/** A task's columns; `children` is the SQL condition, on the alias `c`, of the subtasks its counts take: a project's
 * chat counts only the subtasks on its list. */
const columns=(children='true')=>`id,title,notes,status_id AS status,state,priority,to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(start_time,'HH24:MI') AS start_time,
 to_char(due_on,'YYYY-MM-DD') AS due_on,to_char(due_time,'HH24:MI') AS due_time,repeat,repeated_to,parent_id,position,project_id,project_since,group_id,tags,properties,external,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='person'),'[]'::json) AS people,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='assignee'),'[]'::json) AS assignees,
 (SELECT json_build_object('open',count(*) FILTER (WHERE c.state='open'),'total',count(*)) FROM owner_tasks c WHERE c.parent_id=owner_tasks.id AND c.deleted_at IS NULL AND ${children}) AS subtasks,
 ${linked('blocked_by','other_id','task_id')} AS blocked_by,
 coalesce((SELECT json_agg(json_build_object('id',r.id,'at',r.remind_at,'state',r.state,'set_by',r.set_by,'set_in',r.set_in_chat_id,'via',r.set_via,'account',r.set_by_account_id,'name',r.set_by_name)
  ORDER BY r.remind_at,r.id) FROM owner_task_reminders r WHERE r.task_id=owner_tasks.id),'[]'::json) AS reminders,
 coalesce((SELECT json_agg(json_build_object('kind',a.kind,'id',a.event_id,'url',a.url,'title',a.title) ORDER BY a.position) FROM owner_task_attachments a WHERE a.task_id=owner_tasks.id),'[]'::json) AS attachments,
 (SELECT count(*)::int FROM owner_task_comments c WHERE c.task_id=owner_tasks.id) AS comments,
 (SELECT count(*)::int FROM owner_task_comments c WHERE c.task_id=owner_tasks.id AND c.created_at>=coalesce(owner_tasks.project_since,'infinity'::timestamptz)) AS project_comments,
 coalesce(created_at>=project_since,false) AS made_on_list,coalesce(done_at>=project_since,false) AS finished_on_list,
 origin,source_event,created_by,created_by_account,finished_by,revision,created_at,updated_at,done_at,archived_at,deleted_at`;
const fields=columns();
/** A task's columns as a project's chat reads them, with the project bound as `project`. */
const seenFields=(view:View,project:string)=>view?columns(seesSql('c.',project)):fields;

const exact=(input:unknown,keys:string[])=>{const body=object(input);if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_task_field');return body;};
const title=(value:unknown)=>{const text=string(value,300).trim();if(!text)throw new HttpError(400,'task_title_required');return text;};
const notes=(value:unknown)=>value===undefined||value===null?'':string(value,20000).trim();
/** A calendar day (YYYY-MM-DD), so it means the same day wherever the owner is; null clears it. */
const day=(value:unknown,code='invalid_task_due'):string|null=>{
  if(value===null||value===undefined||value==='')return null;
  const text=string(value,40),date=new Date(text+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==text)throw new HttpError(400,code);
  return text;
};
/** A time of day, HH:MM, in the owner's task time zone; null clears it. */
const clock=(value:unknown):string|null=>{
  if(value===null||value===undefined||value==='')return null;
  const text=string(value,8);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))throw new HttpError(400,'invalid_task_time');return text;
};
/** One tag, such as Health or Money: up to 40 characters, spaces collapsed. */
const tag=(value:unknown):string=>{const text=string(value,200).trim().replace(/\s+/g,' ');if(!text||text.length>40)throw new HttpError(400,'invalid_task_tag');return text;};
/** Tags like a multi-select column: up to 20, each once whatever its case, in the order given. */
const tags=(value:unknown):string[]=>{
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>20)throw new HttpError(400,'invalid_task_tags');
  const seen=new Set<string>(),kept:string[]=[];
  for(const item of value){const text=tag(item),key=text.toLocaleLowerCase();if(!seen.has(key)){seen.add(key);kept.push(text);}}
  return kept;
};
/** The group, or one topic of it, that a task belongs to; null clears it. */
const group=(value:unknown):string|null=>value===undefined||value===null||value===''?null:validateSpace(value);
/** IDs, of known people or of other tasks; each once. */
const ids=(value:unknown,code:string,max=20):string[]=>{
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!hex.test(item)))throw new HttpError(400,code);
  return [...new Set(value as string[])].sort();
};
/** Personal tasks have no project; a project's tasks form that project's own list. */
const scope=(value:unknown):string|null=>{
  if(value===undefined||value===null||value===''||value==='personal')return null;
  const text=string(value,64);if(!hex.test(text))throw new HttpError(400,'invalid_task_scope');return text;
};
/** A web address: http or https only. */
const url=(value:unknown):string=>{
  const text=string(value,2000).trim();
  try{if(['http:','https:'].includes(new URL(text).protocol))return text;}catch{}
  throw new HttpError(400,'invalid_task_url');
};
type Attachment={kind:'message';id:string;title:string}|{kind:'link';url:string;title:string};
/** Up to 20 archived messages and up to 20 links, each counted on its own, so a project's chat, which sees only the
 * links, can always set 20 of them whatever the owner attached (ADR-0243). */
const attachments=(value:unknown):Attachment[]=>{
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>40)throw new HttpError(400,'invalid_task_attachments');
  const read=value.map((item):Attachment=>{
    const body=exact(item,['kind','id','url','title']),label=body.title===undefined||body.title===null?'':string(body.title,200).trim();
    if(body.kind==='message'&&typeof body.id==='string'&&hex.test(body.id)&&body.url===undefined)return {kind:'message',id:body.id,title:label};
    if(body.kind==='link'&&body.id===undefined)return {kind:'link',url:url(body.url),title:label};
    throw new HttpError(400,'invalid_task_attachments');
  });
  if(['message','link'].some(kind=>read.filter(item=>item.kind===kind).length>20))throw new HttpError(400,'invalid_task_attachments');
  return read;
};
/** Outside IDs, such as a Notion page's, kept for a later sync: a short name to a short ID. */
const external=(value:unknown):Record<string,string>=>{
  const body=object(value),entries=Object.entries(body);
  if(entries.length>10||entries.some(([name,id])=>!/^[a-z][a-z0-9_-]{0,31}$/.test(name)||typeof id!=='string'||!id||id.length>200))throw new HttpError(400,'invalid_task_external');
  return Object.fromEntries(entries.sort(([a],[b])=>a<b?-1:1)) as Record<string,string>;
};
/**
 * A task's assignees as a project view sees them (owner answer Q4, ADR-0265 D6, ADR-0276): `names` are the Telegram names
 * of those the owner bound in Memory › People to a Telegram account that is in one of the project's groups now, `other` how many
 * others there are, and `mine` whether one of them is bound to an account of the member reading. Never the owner's own
 * names for people, nor any id.
 */
type AssigneesSeen={names:string[];other:number;mine:boolean};
/** The source identity (src/source-model.ts sourceObjectId) a Telegram account's live messages are authored by, in SQL
 * over the chat_accounts alias `alias`: Telegram's Bot API actor with the account's user id, the mapping source-facts.ts
 * makes the other way. */
const actorSourceSql=(alias:string)=>`encode(sha256(convert_to('["telegram","bot-api","actor",'||to_json(${alias}external_id)::text||']','UTF8')),'hex')`;
/** The accounts whose source identity can be told: a person's account on the Telegram connection with a plain user id. */
const telegramPersonSql=(alias:string)=>`${alias}team='' AND ${alias}kind='human' AND ${alias}external_id ~ '^[0-9]{1,20}$'
  AND EXISTS(SELECT 1 FROM chat_connections k WHERE k.id=${alias}connection_id AND k.app='telegram')`;
/** SQL: the task whose id is the column `task` is assigned to someone the owner bound to one of the accounts bound as
 * `accounts` (text[]): the members' app's "Mine". */
const assignedToSql=(task:string,accounts:string)=>`EXISTS (SELECT 1 FROM owner_task_people x JOIN memory_entity_bindings b ON b.entity_id=x.entity_id
  AND b.binding_kind='source_identity' AND b.state IN ('exact','confirmed') WHERE x.task_id=${task} AND x.role='assignee' AND b.source_object_id IN
  (SELECT ${actorSourceSql('a.')} FROM chat_accounts a WHERE a.id=ANY(${accounts}::text[]) AND ${telegramPersonSql('a.')}))`;
/** A Telegram name as a label shows it: the name Telegram showed, else the @username; null when neither is usable. */
const telegramName=(display:unknown,username:unknown):string|null=>{
  const user=telegramUsername(username);
  return labelName(display)??(user?labelName('@'+user):null);
};
/**
 * A task as its reader sees it. A project's chat sees it only as it is on that project's board: never its outside IDs
 * or the message that asked for it, no archived message attached to it, only the columns the owner shares with project
 * chats, only reminders still to come and whether the owner or a person set each, never who or where, and never a
 * member's private reminder set in the members' app (ADR-0265 D9; the app counts it among the others), links only to
 * tasks on its list, only the comments made since it joined the list, its group only when that is a group or topic
 * assigned to the project now (seesGroup), no manual position, and who made or finished it only when that happened
 * there. A project's task with no joining time shows none of these (ADR-0243, ADR-0255, ADR-0276). Nor does any project
 * view (a group or topic, a member's private chat, the members' app) see the owner's names for people: no people, no
 * person columns (sharedColumns), and not whose account made the task (ADR-0265 D6). Its assignees show only by their
 * Telegram name, and only those linked to a Telegram account in one of the project's groups now; every other assignee
 * is only counted (`assignees_other`, assigneesSeen). The owner's reminders carry where they were set until `sourced`
 * names it.
 */
const row=(value:any,view:View=null)=>{
  if(!value)return value;
  const {project_comments,made_on_list,finished_on_list,assignees_seen,...task}=value,reminders=task.reminders.map((item:any)=>({...item,at:new Date(item.at).toISOString()}));
  if(!view)return {...task,revision:Number(task.revision),reminders};
  const {external:_external,source_event:_source,position:_position,people:_people,assignees:_assignees,created_by_account:_account,...seen}=task;
  // Assignees only by the Telegram name of one in a group of the project (assigneesSeen); every other is counted.
  const shown:AssigneesSeen=assignees_seen??{names:[],other:Array.isArray(task.assignees)?task.assignees.length:0,mine:false};
  return {...seen,assignees:shown.names.map(name=>({name})),assignees_other:shown.other,
    revision:Number(task.revision),comments:project_comments,blocked_by:task.blocked_by.filter((item:any)=>sees(view,item)).map((item:any)=>seenLink(view,item)),
    reminders:reminders.filter((item:any)=>item.state==='pending'&&item.via!=='app').map((item:any)=>({at:item.at,state:item.state,set_by:item.set_by})),
    attachments:task.attachments.filter((item:any)=>item.kind==='link'),
    properties:Object.fromEntries(Object.entries(task.properties).filter(([id])=>view.shared.has(id))),
    group_id:seesGroup(view,task.group_id)?task.group_id:null,created_by:made_on_list?task.created_by:null,
    finished_by:finished_on_list?task.finished_by:null};
};
/** The change that brought a task into a project's list, as that project's chats see it: where each field went, never
 * where it came from, such as its earlier list, parent or title. */
const arrived=(changes:Record<string,unknown>)=>Object.fromEntries(Object.entries(changes).map(([key,value])=>
  [key,value&&typeof value==='object'&&!Array.isArray(value)&&'to' in value?{to:(value as {to:unknown}).to}:value]));
/** A history entry as a project's chat sees it: the change that brought the task to its list (a change of its list,
 * or `joined`, the entry made when it last joined, such as an earlier group move did) shows only where it went; a
 * group or topic that is not one of the project's now shows as none (ADR-0243, ADR-0276). */
const boardChange=(changes:Record<string,unknown>,view:View,joined=false)=>{
  const shown='project_id' in changes||joined?arrived(changes):changes,group=shown.group_id;
  if(!group||typeof group!=='object')return shown;
  return {...shown,group_id:Object.fromEntries(Object.entries(group).map(([side,space])=>[side,seesGroup(view,space)?space:null]))};
};
/** A task's version for the members' app (ADR-0265 D6): opaque, keyed by the installation's own random key
 * (owner_task_version_key, TaskRepository.versionKey), so a version tells nothing of a task's revision, which counts
 * every edit, those from before it joined the board too. The same task and revision give the same version across
 * restarts and processes. */
const taskVersion=(key:Buffer,id:string,revision:number)=>createHmac('sha256',key).update(`member-task-version-v1:${id}:${revision}`).digest('hex').slice(0,32);
/** How many revisions back an expected_version is looked for: a retried write whose answer was lost still replays. */
const VERSIONS_BACK=50;
const iso=(value:unknown):string|null=>value===null||value===undefined?null:new Date(value as string).toISOString();
/** Who did something, as the members' app shows it: the owner, a member by the Telegram name written then, or Nocheh.
 * Anything else shows as Nocheh, never as stored. */
export function memberActor(value:unknown):MemberActor {
  const actor=value&&typeof value==='object'?value as {kind?:unknown;name?:unknown}:{};
  if(actor.kind==='owner')return {kind:'owner'};
  if(actor.kind==='member')return typeof actor.name==='string'&&actor.name.trim()?{kind:'member',name:actor.name.trim().slice(0,100)}:{kind:'member'};
  return {kind:'nocheh'};
}
/**
 * A task as the members' app and a member's private chat show it (ADR-0265 D6), from its stored row as `view` reads it
 * (row: the project's board only) and named field by field, so a column added later is never shown by default. Its
 * `version` stands for its revision; `created_at` and `created_by` only when it was made on this board, else
 * `on_board_since` says when it joined, and `updated_at` and `done_at` are never earlier than that; reminders are the
 * reader's own still to come and how many others there are, never whose; `mine` when one of `accounts` made it, set a
 * reminder on it or is bound to one of its assignees; assignees by Telegram name only as row() shows them. Never its
 * origin, its repeat's next task, outside ids, the message that asked for it, its position, its revision, people, the
 * owner's names for assignees or person columns.
 */
function memberTask(value:any,view:NonNullable<View>,accounts:readonly string[],key:Buffer):MemberTask {
  const seen=row(value,view),since=value.project_since?new Date(value.project_since).getTime():null;
  const after=(at:unknown)=>at===null||at===undefined?null:new Date(since===null?new Date(at as string).getTime():Math.max(new Date(at as string).getTime(),since)).toISOString();
  const reminders:any[]=value.reminders??[],pending=reminders.filter(item=>item.state==='pending');
  const own=(item:any)=>item.set_by==='person'&&typeof item.account==='string'&&accounts.includes(item.account);
  const made=value.made_on_list===true,finished=value.finished_on_list===true;
  // A task in one of a group's topics shows under that group, which the member's groups name (me.groups lists no topic).
  const group=typeof seen.group_id==='string'?directory().groupOf(seen.group_id)??seen.group_id:null;
  return {id:seen.id,version:taskVersion(key,seen.id,Number(seen.revision)),project:seen.project_id,group,parent_id:seen.parent_id??null,
    title:seen.title,status:seen.status,state:seen.state,priority:Number(seen.priority),
    start_on:seen.start_on??null,start_time:seen.start_time??null,due_on:seen.due_on??null,due_time:seen.due_time??null,
    tags:[...seen.tags??[]],properties:{...seen.properties},assignees:(seen.assignees??[]).map((item:{name:string})=>({name:item.name})),
    assignees_other:Number(seen.assignees_other??0),subtasks:{open:Number(seen.subtasks?.open??0),total:Number(seen.subtasks?.total??0)},comments:Number(seen.comments??0),
    archived:!!seen.archived_at,trashed:!!seen.deleted_at,
    mine:(typeof value.created_by_account==='string'&&accounts.includes(value.created_by_account))||reminders.some(own)||value.assignees_seen?.mine===true,
    on_board_since:iso(value.project_since),...(made?{created_at:iso(seen.created_at)!}:{}),updated_at:after(seen.updated_at)!,done_at:after(seen.done_at),
    ...(made&&seen.created_by?{created_by:memberActor(seen.created_by)}:{}),...(finished&&seen.finished_by?{finished_by:memberActor(seen.finished_by)}:{}),
    reminders:{mine:pending.filter(own).map(item=>({id:String(item.id),at:iso(item.at)!,state:'pending' as const})),others:pending.filter(item=>!own(item)).length}};
}
/** What the members' page names a task's status and shared columns by (MemberTaskPage): every status with what it
 * means, and the columns the owner shares with project chats, never a private or person column (seenColumns). */
const memberBoardWords=(settings:TaskSettings):{statuses:MemberTaskStatus[];columns:MemberTaskColumn[]}=>({
  statuses:settings.statuses.map(item=>({id:item.id,name:item.name,state:stateOf(item.category) as MemberTaskStatus['state']})),
  columns:seenColumns(settings).map(item=>({id:item.id,name:item.name,type:item.type,
    ...(item.type==='select'||item.type==='multi_select'?{options:item.options.map(option=>({id:option.id,name:option.name}))}:{})}))});
/** The history a member sees of a task: these changes only, a parent or the task repeated from as changed, never
 * which, assignees only as changed, and people and outside ids never. */
const memberChanges=new Set(['created','title','notes','status_id','state','priority','start_on','start_time','due_on','due_time','repeat','tags','properties','assignees',
  'parent_id','project_id','group_id','archived','trashed','blocked_by','related','duplicate_of','attachments','reminders','repeated_from','reminded','reminder_failed']);
const memberLink=(item:any):MemberTaskLink=>({id:item.id,title:item.title,state:item.state});
/** A task in the members' drawer (ADR-0265 D6): the row (memberTask), its notes and repeat, the links and subtasks the
 * reader sees, its web links, and its comments and history from when it joined the board (detail() cut them). */
function memberDetail(found:any,view:NonNullable<View>,accounts:readonly string[],key:Buffer,parts:{related:any[];duplicate_of:any[];children:any[];comments:any[];activity:any[]}):MemberDetail {
  const seen=row(found,view),once=(items:any[])=>[...new Map(items.map(item=>[item.id,item])).values()];
  return {...memberTask(found,view,accounts,key),notes:typeof seen.notes==='string'?seen.notes:'',repeat:seen.repeat&&typeof seen.repeat==='object'?{...seen.repeat}:null,
    blocked_by:(seen.blocked_by??[]).map(memberLink),related:once(parts.related).map(memberLink),duplicate_of:parts.duplicate_of.map(memberLink),
    children:parts.children.map(memberLink),
    attachments:(seen.attachments??[]).filter((item:any)=>item.kind==='link').map((item:any)=>({kind:'link' as const,url:String(item.url),title:String(item.title??'')})),
    comment_list:parts.comments.map((item:any):MemberComment=>({id:item.id,body:item.body,author:memberActor(item.author),created_at:iso(item.created_at)!})),
    activity:parts.activity.map((item:any):MemberActivity=>({at:iso(item.at)!,actor:memberActor(item.actor),changes:Object.fromEntries(Object.entries(item.changes??{})
      .filter(([key])=>memberChanges.has(key)).map(([key,change])=>[key,key==='parent_id'||key==='repeated_from'?true:change]))}))};
}
/** A repeat in words, as a card shows it: "every 2 weeks on Mon, Thu, from when it is done". */
const repeatWords=(repeat:{every:number;unit:string;weekdays?:number[];from:string})=>
  `every ${repeat.every} ${repeat.unit}${repeat.every===1?'':'s'}${repeat.weekdays?.length?' on '+repeat.weekdays.map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', '):''}`+
  (repeat.from==='done'?', from when it is done':'');
/** The columns the owner shares with project chats, as they read them: a person column's values are the owner's names
 * for people, so no project view reads one, shared or not (ADR-0265 D6). Writing one from a group is unchanged. */
const seenColumns=(settings:TaskSettings)=>settings.properties.filter(item=>item.shared&&item.type!=='person');
const sharedColumns=(settings:TaskSettings)=>new Set(seenColumns(settings).map(item=>item.id));

type ListInput={state?:string;scope?:string;tag?:string;group?:string;person?:string;status?:string;priority?:string;parent?:string;
  in?:string;when?:string;sort?:string;q?:string;after?:string;limit?:string|null;
  /** Never read from an address (taskQuery): only the tasks these accounts made or set a reminder on (the members' app's
   *  "Mine"). */
  mine?:readonly string[]};
/** A task listing's filters, read from the address. */
export const taskQuery=(params:URLSearchParams):ListInput=>Object.fromEntries(
  ['state','scope','tag','group','person','status','priority','parent','in','when','sort','q','after','limit'].map(key=>[key,key==='limit'?params.get(key):params.get(key)??''])) as ListInput;

/** What the owner's edit asks for, read and checked against the task settings. */
type Patch={title?:string;notes?:string;status_id?:string;priority?:number;start_on?:string|null;start_time?:string|null;due_on?:string|null;due_time?:string|null;
  repeat?:unknown;parent_id?:string|null;position?:number;project_id?:string|null;group_id?:string|null;tags?:string[];properties?:Record<string,unknown>;
  external?:Record<string,string>;people?:string[];assignees?:string[];reminders?:string[];blocked_by?:string[];related?:string[];duplicate_of?:string[];
  attachments?:Attachment[];archived?:boolean;trashed?:boolean;state?:TaskState};
const editable=['title','notes','status','state','priority','start_on','start_time','due_on','due_time','repeat','parent','scope','group','people','assignees','tags',
  'properties','reminders','blocked_by','related','duplicate_of','attachments'];

/**
 * The owner's task lists in the control store. The dashboard and mini app edit
 * them as the owner; the assistant reaches them only from a current live turn:
 * the owner's private chat reaches every list, a group or topic in a project
 * that project's whole list, whatever each task's group, and sees each task
 * only as it is on that project's board. A change asked in the owner's private
 * chat that a project's chats would see waits for the owner's card, which names
 * them (ADR-0243, ADR-0276).
 */
export class TaskRepository {
  /**
   * The live turn asking; project null is the owner's private chat, which
   * reaches every list. A group's turn names its group, the label a task added there gets.
   * Reminders go to the owner's private chat through the runtime, when one is given.
   */
  constructor(readonly control:pg.Pool,private chatTurn:(principal:Reader)=>Promise<Turn>,private delivery?:Delivery){}

  /**
   * The members' app (step 5, ADR-0265 D6, D7). Each call comes with the member as the member listener checked them for
   * this request (MemberAppPrincipal), never a Reader or a turn. A member reads only their boards (`views`): each
   * project's whole list, whatever each task's group (ADR-0276), from when each task joined the board, in the members' shape (memberTask, memberDetail). With write they add, edit, finish, reopen, comment on, archive, trash and
   * restore any task they see, and set their own reminders while reminders reach them; with read they change nothing.
   * They never set people, assignees, person columns, outside ids or archived messages, never move a task to another
   * project, and never remove a comment. Anything else is refused before anything is read or written.
   */
  /** One page of one board (GET /tasks); 403 task_scope_denied for a project that is not one of theirs. */
  async memberList(principal:MemberAppPrincipal,query:MemberTaskQuery):Promise<MemberTaskPage> {
    const keys=['project','group','mine','state','trash','tag','cursor'];
    if(!query||typeof query!=='object'||Object.keys(query).some(key=>!keys.includes(key)))throw new HttpError(400,memberAppErrors.filterNotAllowed);
    const view=this.memberView(principal,query.project);
    if(query.cursor!==undefined&&!/^\d{1,9}$/.test(String(query.cursor)))throw new HttpError(400,memberAppErrors.filterNotAllowed);
    // Open by default; Done lists the done and the dropped; the trash lists every state unless one is asked.
    const state=query.state==='done'?'closed':query.state==='open'||!query.trash?'open':'all';
    // A board lists the tasks at its top; subtasks show in the drawer.
    const input:ListInput={scope:view.project,state,parent:'top',in:query.trash===true?'trash':'active',...(query.group!==undefined?{group:query.group}:{}),
      ...(query.tag!==undefined?{tag:query.tag}:{}),...(query.mine===true?{mine:this.memberAccounts(principal)}:{}),...(query.cursor!==undefined?{after:String(query.cursor)}:{})};
    return this.page(input,view.project,this.memberAccounts(principal));
  }
  /** One task the member sees (GET /tasks/:id); 404 task_not_found for any other, whether or not it exists. */
  async memberGet(principal:MemberAppPrincipal,id:string):Promise<MemberDetail> {
    const {view}=await this.memberSeen(principal,id);
    return this.detail(id,view.project,this.memberAccounts(principal));
  }
  /** Adds a task to one of the member's boards (POST /tasks, MemberTaskCreateRequest). With no group and no parent it is
   * labelled with the member's first group on that board (`home`); group null puts it on the whole project, and a group
   * must be one of the project's (403 task_group_denied). A subtask takes its parent's group unless one is named. */
  async memberCreate(principal:MemberAppPrincipal,input:unknown):Promise<MemberDetail> {
    this.memberWrites(principal);
    const body=object(input);
    await this.memberFields(body,['operation_id','project',...MEMBER_TASK_CREATE_FIELDS]);
    const view=this.memberView(principal,body.project),operation=this.memberOperation(principal,body.operation_id);
    const {operation_id:_operation,project:_project,...fields}=body;
    const own=!('group' in fields)&&(fields.parent===undefined||fields.parent===null||fields.parent==='');
    const created=await this.insert(operation,{...fields,scope:view.project,...(own?{group:view.home}:{})},this.memberContext(principal,view));
    return this.detail(created.id,view.project,this.memberAccounts(principal));
  }
  /** Changes a task the member sees (POST /tasks/:id, MemberTaskUpdateRequest): `expected_version` is the version the
   * page read; another answers 409 conflict, and so does a change in between. */
  async memberUpdate(principal:MemberAppPrincipal,id:string,input:unknown):Promise<MemberDetail> {
    this.memberWrites(principal);
    const body=exact(input,['operation_id','expected_version','patch']),patch=object(body.patch);
    await this.memberFields(patch,MEMBER_TASK_PATCH_FIELDS);
    const operation=this.memberOperation(principal,body.operation_id),{view,revision}=await this.memberSeen(principal,id);
    if('reminders' in patch)await this.memberSetsReminders(principal,id,patch.reminders);
    // The version stands for one revision: the current one, or an earlier one when the same write is sent again.
    const version=typeof body.expected_version==='string'?body.expected_version:'';
    let expected:number|null=null;
    const key=await this.versionKey();
    for(let back=0;back<=VERSIONS_BACK&&revision-back>=1;back++)if(taskVersion(key,id,revision-back)===version){expected=revision-back;break;}
    if(expected===null)throw new HttpError(409,memberAppErrors.conflict);
    try {await this.change(operation,id,{...patch,expected_revision:expected},this.memberContext(principal,view));}
    catch(error){if(error instanceof HttpError&&error.code==='task_revision_conflict')throw new HttpError(409,memberAppErrors.conflict);throw error;}
    return this.detail(id,view.project,this.memberAccounts(principal));
  }
  /** Adds a comment to a task the member sees (POST /tasks/:id/comments, MemberTaskCommentRequest); never removes one. */
  async memberComment(principal:MemberAppPrincipal,id:string,input:unknown):Promise<MemberDetail> {
    this.memberWrites(principal);
    const given=object(input);
    if('remove' in given)throw new HttpError(403,memberAppErrors.fieldNotAllowed);
    const body=exact(given,['operation_id','text']);
    if(body.text===undefined)throw new HttpError(400,'task_comment_required');
    const operation=this.memberOperation(principal,body.operation_id),{view}=await this.memberSeen(principal,id);
    await this.discuss(operation,id,{text:body.text},this.memberContext(principal,view));
    return this.detail(id,view.project,this.memberAccounts(principal));
  }
  /** Every pending reminder the member set, by any of their accounts, in a group or the app, on tasks they still see
   * (on their boards' projects) and that are not in the trash (GET /reminders), soonest first: a task in the trash takes no edit, its reminders
   * included, and one of them comes due skipped (remind); restored, its reminders show again. */
  async memberReminders(principal:MemberAppPrincipal):Promise<MemberReminder[]> {
    const accounts=this.memberAccounts(principal);
    if(!principal.views.length||!accounts.length)return [];
    const rows=(await this.control.query(`SELECT r.id,r.remind_at,t.id AS task,t.title,t.project_id FROM owner_task_reminders r JOIN owner_tasks t ON t.id=r.task_id
      WHERE r.state='pending' AND r.set_by='person' AND r.set_by_account_id=ANY($1::text[]) AND t.deleted_at IS NULL AND t.project_id=ANY($2::text[])
      ORDER BY r.remind_at,r.id LIMIT 1000`,[accounts,principal.views.map(view=>view.project)])).rows;
    return rows.map(item=>({id:item.id,at:iso(item.remind_at)!,task:{id:item.task,title:item.title,project:item.project_id}}));
  }
  /** The member's accounts, the launching one among them; never empty for a member. */
  private memberAccounts(principal:MemberAppPrincipal):string[] {
    const accounts=[...new Set([principal.account,...principal.accounts??[]])].filter(account=>typeof account==='string'&&hex.test(account));
    if(!accounts.includes(principal.account))throw new HttpError(403,'member_app_closed');
    return accounts;
  }
  /** One of the member's boards by its project id; 403 task_scope_denied for any other value. */
  private memberView(principal:MemberAppPrincipal,project:unknown):TaskView {
    this.memberAccounts(principal);
    const view=typeof project==='string'&&hex.test(project)?principal.views.find(item=>item.project===project):undefined;
    if(!view)throw new HttpError(403,'task_scope_denied');
    return view;
  }
  /** The board through which the member sees task `id` (the board of its project), and its revision now; 404
   * task_not_found when none of theirs holds it. */
  private async memberSeen(principal:MemberAppPrincipal,id:string):Promise<{view:TaskView;revision:number}> {
    this.memberAccounts(principal);
    if(typeof id!=='string'||!hex.test(id))throw new HttpError(400,'invalid_identity');
    const task=(await this.control.query('SELECT project_id,revision FROM owner_tasks WHERE id=$1',[id])).rows[0];
    const view=task?principal.views.find(item=>item.project===task.project_id):undefined;
    if(!task||!view)throw new HttpError(404,'task_not_found');
    return {view,revision:Number(task.revision)};
  }
  /** Writes need the member's tasks read and write (403 task_read_only). */
  private memberWrites(principal:MemberAppPrincipal) {
    this.memberAccounts(principal);
    if(principal.mode!=='write')throw new HttpError(403,memberAppErrors.readOnly);
  }
  /** The operation a member's write is kept under: their own id for it, never another member's. */
  private memberOperation(principal:MemberAppPrincipal,value:unknown):string {
    const given=typeof value==='string'?value.trim():'';
    if(!/^[A-Za-z0-9_.:-]{8,200}$/.test(given))throw new HttpError(400,'invalid_operation_id');
    return digest(canonical(['member-app',principal.member,given]));
  }
  /** A member's write as the app sends it: a field the app never sets is 403 task_field_not_allowed (people,
   * assignees, outside ids, the project, the position, a revision, an archived message), any other field not in
   * `allowed` 400 unknown_task_field, and a column the page does not show, a person column included, 400
   * unknown_task_property. */
  private async memberFields(body:Record<string,unknown>,allowed:readonly string[]) {
    const refused:readonly string[]=MEMBER_TASK_REFUSED_FIELDS;
    if(Object.keys(body).some(key=>refused.includes(key)))throw new HttpError(403,memberAppErrors.fieldNotAllowed);
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw new HttpError(400,'unknown_task_field');
    if(Array.isArray(body.attachments)&&body.attachments.some(item=>!item||typeof item!=='object'||(item as {kind?:unknown}).kind!=='link'))
      throw new HttpError(403,memberAppErrors.fieldNotAllowed);
    // A column the page does not show (a person column, shared or not, or one the owner keeps private) answers as unknown,
    // the same as a name no column has, so a member learns no column's name by guessing.
    if(body.properties!==undefined&&body.properties!==null&&typeof body.properties==='object'){
      const seen=seenColumns((await this.current(this.control)).settings);
      for(const key of Object.keys(body.properties)){
        const wanted=key.trim().toLocaleLowerCase();
        if(!seen.some(item=>item.id===key||item.name.toLocaleLowerCase()===wanted))throw new HttpError(400,'unknown_task_property');
      }
    }
  }
  /**
   * Whether a member's reminders list may be saved (ADR-0265 D9). Each time carries its offset, so the owner's time zone
   * never changes what the member meant. While reminders reach the member (`reminders` available and their private chat
   * open) the list sets and removes their own; otherwise it may only remove: a time they have not set already answers 403
   * task_reminders_off when the owner turned their reminders off, else 409 member_reminders_unavailable.
   */
  private async memberSetsReminders(principal:MemberAppPrincipal,id:string,listed:unknown) {
    if(!Array.isArray(listed))throw new HttpError(400,'invalid_task_reminders');
    if(listed.some(item=>typeof item!=='string'||!/(Z|[+-]\d{2}:?\d{2})$/.test(item)||Number.isNaN(Date.parse(item))))throw new HttpError(400,'invalid_task_reminder');
    if(principal.reminders.available&&principal.chat)return;
    const minute=(at:string|Date)=>Math.floor(new Date(at).getTime()/60000);
    const set=new Set((await this.control.query(`SELECT remind_at FROM owner_task_reminders WHERE task_id=$1 AND set_by='person' AND set_by_account_id=ANY($2::text[])
      AND state='pending'`,[id,this.memberAccounts(principal)])).rows.map(item=>minute(item.remind_at)));
    if((listed as string[]).every(item=>set.has(minute(item))))return;
    throw principal.reminders.available===false&&principal.reminders.reason==='reminders_off'?new HttpError(403,memberAppErrors.remindersOff)
      :new HttpError(409,memberAppErrors.remindersUnavailable);
  }
  /** How the members' app writes: as the member, by their Telegram name, in the app (origin 'app'), on one board's whole
   * list; no card, and their private chat is never stored as a place. */
  private memberContext(principal:MemberAppPrincipal,view:TaskView):Context {
    const name=typeof principal.name==='string'&&principal.name.trim()?principal.name.trim().slice(0,100):null;
    return {origin:'app',actor:name?{kind:'member',name}:{kind:'member'},source:null,within:view.project,chat:false,card:false,
      setter:{by:'person',account:principal.account,name,chat:null,group:null,via:'app',accounts:this.memberAccounts(principal)}};
  }
  async list(principal:Reader,input:ListInput={}) {admin(principal);return this.page(input);}
  async get(principal:Reader,id:string) {admin(principal);return this.detail(id,null);}
  async create(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id',...editable,'position','external']);
    return this.insert(string(body.operation_id,200),body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false,setter:OWNER_HERE});
  }
  async update(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','expected_revision',...editable,'position','external','archived','trashed']);
    return this.change(string(body.operation_id,200),id,body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false,setter:OWNER_HERE});
  }
  /** Add a comment, or remove one by its ID. */
  async comment(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','text','remove']);
    return this.discuss(string(body.operation_id,200),id,body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false,setter:OWNER_HERE});
  }
  /** Delete a task for good; only one already in the trash, and its subtasks with it. */
  async remove(principal:Reader,id:string) {
    admin(principal);if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    if(!(await this.control.query('DELETE FROM owner_tasks WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id',[id])).rows.length)
      throw (await this.control.query('SELECT 1 FROM owner_tasks WHERE id=$1',[id])).rows.length?new HttpError(409,'task_not_in_trash'):new HttpError(404,'task_not_found');
    return {deleted:id};
  }
  /**
   * The chats that would see a task after the owner moves it to the list `scope` ('personal' or a project ID) and the
   * group `group` (empty for the project itself); either left out keeps the task's own. A subtask has its own label like
   * any task. Every chat of the project sees the task whatever its group, so `audience` is always 'project' and `group`
   * only a label (ADR-0276). The dashboard and the mini app name them before they save a move, as the task card does.
   */
  async audience(principal:Reader,id:string,query:{scope?:string|null;group?:string|null}={}) {
    admin(principal);if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    const task=(await this.control.query('SELECT project_id,group_id FROM owner_tasks WHERE id=$1',[id])).rows[0];
    if(!task)throw new HttpError(404,'task_not_found');
    const project:string|null=query.scope===undefined||query.scope===null?task.project_id:scope(query.scope);
    const grouped:string|null=query.group===undefined||query.group===null?task.group_id:group(query.group);
    if(!project)return {project:null,group:grouped,audience:null,chats:[] as string[]};
    return {project,group:grouped,audience:'project' as const,chats:await this.audienceOf(this.control,project)};
  }
  /** Archive every finished or dropped task in a list, or in all lists. */
  async archiveFinished(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','scope']),every=body.scope===undefined||body.scope==='all',project=every?null:scope(body.scope);
    const archived=(await this.control.query(`UPDATE owner_tasks SET archived_at=now(),revision=revision+1,updated_at=now()
      WHERE state<>'open' AND archived_at IS NULL AND deleted_at IS NULL AND ($1 OR project_id IS NOT DISTINCT FROM $2) RETURNING id`,[every,project])).rows;
    for(const task of archived)await this.record(this.control,task.id,{kind:'owner'},'dashboard',{archived:{from:false,to:true}});
    // The owner closed them from the dashboard: their own reminders on them stop (ADR-0255).
    if(archived.length)await this.control.query("DELETE FROM owner_task_writers WHERE field='closed' AND task_id=ANY($1::text[])",[archived.map(task=>task.id)]);
    return {archived:archived.length};
  }
  async settings(principal:Reader) {
    admin(principal);const value=await this.current(this.control);
    return {...value.settings,revision:String(value.revision)};
  }
  /**
   * Save statuses, priorities, the owner's own columns and the time zone. A
   * removed status sends its tasks to the first status of the same kind; a
   * removed column or choice leaves the tasks that used it.
   */
  async saveSettings(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(typeof body.revision!=='string')throw new HttpError(400,'invalid_task_settings');
    const given=Object.fromEntries(Object.entries(body).filter(([key])=>key!=='revision'));readTaskSettings(given);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const row=(await db.query('SELECT settings,revision FROM owner_task_settings WHERE singleton FOR UPDATE')).rows[0];
      if(String(row.revision)!==body.revision)throw new HttpError(409,'configuration_conflict');
      // A part left out keeps what is saved.
      const before=storedTaskSettings(row.settings),next=readTaskSettings({...before,...given});
      for(const status of before.statuses.filter(old=>!next.statuses.some(kept=>kept.id===old.id))){
        const home=next.statuses.find(kept=>kept.category===status.category)!;
        await db.query('UPDATE owner_tasks SET status_id=$2,revision=revision+1,updated_at=now() WHERE status_id=$1',[status.id,home.id]);
      }
      // A status that moved to another kind of state moves its tasks' state with it.
      for(const status of next.statuses)await db.query(`UPDATE owner_tasks SET state=$2,done_at=CASE WHEN $2='open' THEN NULL ELSE coalesce(done_at,now()) END,
        revision=revision+1,updated_at=now() WHERE status_id=$1 AND state<>$2`,[status.id,stateOf(status.category)]);
      for(const property of before.properties){
        const kept=next.properties.find(item=>item.id===property.id);
        if(!kept||kept.type!==property.type)await db.query('UPDATE owner_tasks SET properties=properties-$1::text WHERE properties ? $1',[property.id]);
        else for(const option of property.options.filter(old=>!kept.options.some(item=>item.id===old.id))){
          if(kept.type==='select')await db.query(`UPDATE owner_tasks SET properties=properties-$1::text WHERE properties->>$1=$2`,[property.id,option.id]);
          else await db.query(`UPDATE owner_tasks SET properties=jsonb_set(properties,ARRAY[$1],(properties->$1)-$2) WHERE properties->$1 ? $2`,[property.id,option.id]);
        }
      }
      await db.query('UPDATE owner_task_settings SET settings=$1,revision=revision+1,updated_at=now() WHERE singleton',[JSON.stringify(next)]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return this.settings(principal);
  }

  /** Only the owner's time zone, from the Schedules page or the mini app (owner's time zone): the rest stays as saved. */
  async saveTimeZone(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>key!=='time_zone'))throw new HttpError(400,'unknown_task_setting');
    await setOwnerTimeZone(this.control,body.time_zone);
    return this.settings(principal);
  }

  /**
   * Assistant reads. The owner's private chat reads any list; a group or topic
   * in a project reads that project's whole list, learns of no other list or
   * project, and sees each task only from when it joined that list (ADR-0276).
   */
  async chatList(principal:Reader,input:ListInput={}) {
    const turn=await this.chatTurn(principal);
    // A member's private chat lists one project's view at a time: the one it names, or its only one (D14), in the shape
    // the members' app shows (ADR-0265 D6): no person filter, no counts, no settings, no time zone.
    if(turn.views!==undefined) {
      if(input.person)throw new HttpError(400,memberAppErrors.filterNotAllowed);
      const named=input.scope&&input.scope!=='all'?input.scope:null;
      const view=named?turn.views.find(item=>item.project===named):turn.views.length===1?turn.views[0]:undefined;
      if(named&&!view)throw new HttpError(403,'task_scope_denied');
      if(!view)throw turn.views.length?new TaskProjectRequired(turn.views):new HttpError(403,'task_project_required');
      return this.page({...input,scope:view.project},view.project,turn.accounts??[]);
    }
    const {project}=turn;
    if(project&&input.scope&&input.scope!=='all'&&input.scope!==project)throw new HttpError(403,'task_scope_denied');
    return this.marked(turn,await this.page(project?{...input,scope:project}:input,project));
  }
  async chatGet(principal:Reader,id:string) {
    const turn=await this.chatTurn(principal);
    // A member's private chat reads a task through the view of the task's own project (D14).
    if(turn.views!==undefined) {
      if(!hex.test(id))throw new HttpError(400,'invalid_identity');
      const project=(await this.control.query('SELECT project_id FROM owner_tasks WHERE id=$1',[id])).rows[0]?.project_id;
      const view=turn.views.find(item=>item.project===project);
      if(!view)throw new HttpError(404,'task_not_found');
      return this.detail(id,view.project,turn.accounts??[]);
    }
    return this.marked(turn,await this.detail(id,turn.project));
  }
  /**
   * Repeating the same request within one turn returns the task it already made. In the owner's private chat, a
   * change that a project's chats would see is held for the owner's card instead (ADR-0243). A task added in a
   * group is labelled with that group or topic unless it names another group of its project, the project itself
   * (group null) or a parent, whose group a subtask takes unless it names one (ADR-0276). A parent given as null or
   * empty names no parent, and an empty group names no group, so neither puts the task on the whole project.
   */
  async chatCreate(principal:Reader,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),{source,project}=turn,body=exact(input,editable);
    if(project&&body.scope!==undefined&&body.scope!==project)throw new HttpError(403,'task_scope_denied');
    const {group:named,...rest}=body,given:Record<string,unknown>=named===''?rest:body;
    const own=!!turn.group&&given.group===undefined&&(given.parent===undefined||given.parent===null||given.parent==='');
    const value={...given,...(project?{scope:project}:{}),...(own?{group:turn.group}:{})};
    const operation=digest('chat:'+source.reference.id+':'+canonical(value));
    return this.marked(turn,await this.held(turn,'add',null,operation,value,await this.insert(operation,value,this.chatContext(turn))));
  }
  async chatUpdate(principal:Reader,id:string,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),body=exact(input,['expected_revision',...editable,'archived','trashed']);
    if(turn.project&&body.scope!==undefined&&body.scope!==turn.project)throw new HttpError(403,'task_scope_denied');
    const operation=digest('chat:'+turn.source.reference.id+':'+id+':'+canonical(body));
    return this.marked(turn,await this.held(turn,'update',id,operation,body,await this.change(operation,id,body,this.chatContext(turn))));
  }
  async chatComment(principal:Reader,id:string,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),body=exact(input,['text']);
    const operation=digest('chat-comment:'+turn.source.reference.id+':'+id+':'+canonical(body));
    return this.marked(turn,await this.held(turn,'comment',id,operation,body,await this.discuss(operation,id,body,this.chatContext(turn))));
  }
  /**
   * A chat turn's answer, marked so a note written after it says whose words it read.
   * A group or topic turn's answer is marked `other_groups: true` when it shows a task (listed, read, its parent,
   * subtasks or linked tasks) labelled with a group or topic outside what that chat shares what it knows with, or a list
   * names a tag only such tasks carry. While
   * "Share group chats" is off a group learns nothing from such a read (ADR-0276); with it on the reach holds the
   * project's groups, so nothing is marked. A task with no group label never marks.
   * In every chat, each task shown whose title or notes a person other than the owner last wrote, in a group or in the
   * members' app, or that shows a comment a member wrote, lists those parts in `written_by_others`, and the answer is
   * marked `others_wrote: true`: their words, never the owner's, even in the owner's private chat or brief (ADR-0295).
   */
  private async marked<T>(turn:Turn,answer:T):Promise<T> {
    if(!answer||typeof answer!=='object')return answer;
    const shown=new Map<string,Record<string,unknown>[]>();
    const walk=(value:unknown):void=>{
      if(Array.isArray(value)){value.forEach(walk);return;}
      if(!value||typeof value!=='object')return;
      const item=value as Record<string,unknown>;
      if(typeof item.id==='string'&&hex.test(item.id)&&typeof item.title==='string')shown.set(item.id,[...shown.get(item.id)??[],item]);
      Object.values(item).forEach(walk);
    };
    walk(answer);
    const others=await this.othersWrote([...shown.keys()]);
    for(const [id,items] of shown)for(const item of items) {
      const parts=[...others.get(id)??[]].filter(part=>part!=='comments'||Array.isArray(item.comments));
      if(parts.length)item.written_by_others=parts;
    }
    const wrote=[...shown.values()].some(items=>items.some(item=>Array.isArray(item.written_by_others)));
    const marks=wrote?{others_wrote:true}:{};
    if(!turn.reach)return wrote?{...marks,...answer}:answer;
    // A list's tags name the tags in use on the whole list: one only tasks of other groups carry is their text too.
    const listed=(answer as {tags?:unknown}).tags,tags=Array.isArray(listed)&&!('id' in answer)?listed
      .map(item=>typeof item==='string'?item:item&&typeof item==='object'?(item as {name?:unknown}).name:null).filter((item):item is string=>typeof item==='string'):[];
    if(!shown.size&&!tags.length)return answer;
    const reach=readSetParam(turn.reach),outside=(column:string)=>`${column} IS NOT NULL AND NOT ${readSetSql(column,2)}`;
    const other=shown.size>0&&(await this.control.query(`SELECT 1 FROM owner_tasks WHERE id=ANY($1::text[]) AND ${outside('group_id')} LIMIT 1`,[[...shown.keys()],reach])).rows.length>0
      ||tags.length>0&&(await this.control.query(`SELECT 1 FROM unnest($1::text[]) w(tag) WHERE EXISTS (SELECT 1 FROM owner_tasks t,unnest(t.tags) x
        WHERE t.project_id=$3 AND t.deleted_at IS NULL AND lower(x)=lower(w.tag) AND ${outside('t.group_id')})
        AND NOT EXISTS (SELECT 1 FROM owner_tasks t,unnest(t.tags) x WHERE t.project_id=$3 AND t.deleted_at IS NULL AND lower(x)=lower(w.tag)
        AND NOT (${outside('t.group_id')})) LIMIT 1`,[tags,reach,turn.project])).rows.length>0;
    return other?{other_groups:true,...marks,...answer}:wrote?{...marks,...answer}:answer;
  }
  /** The parts of each task someone other than the owner wrote: its title or notes, last written by a person in a group
   *  or the members' app (owner_task_writers), and comments, when a member wrote one. */
  private async othersWrote(ids:string[]):Promise<Map<string,Set<'title'|'notes'|'comments'>>> {
    const found=new Map<string,Set<'title'|'notes'|'comments'>>();if(!ids.length)return found;
    const rows=(await this.control.query(`SELECT task_id,field FROM owner_task_writers WHERE task_id=ANY($1::text[]) AND by='person' AND field IN ('title','notes')
      UNION SELECT DISTINCT task_id,'comments' FROM owner_task_comments WHERE task_id=ANY($1::text[]) AND author->>'kind'='member'`,[ids])).rows;
    for(const row of rows)found.set(row.task_id,(found.get(row.task_id)??new Set()).add(row.field));
    return found;
  }
  /** An "Answer privately" answer and a member's private chat only read; they add, change and comment on none. */
  private writable(turn:Turn):Turn {
    if(turn.readOnly||turn.views!==undefined)throw new HttpError(403,'task_read_only');
    return turn;
  }
  /** A group or topic turn writes as the person who wrote there, or the owner, in that chat; the owner's private chat
   * writes as the owner there (ADR-0255). */
  private chatContext(turn:Turn):Context {
    const actor=turn.actor??{kind:'owner'},chat=turn.group,group=chat?directory().groupOf(chat)??chat:null;
    const setter:Setter=!chat?OWNER_HERE:actor.kind==='member'?{by:'person',account:turn.account??null,name:actor.name??null,chat,group}
      :{by:'owner',account:null,name:null,chat,group};
    return {origin:'chat',actor,source:turn.source.reference.id,within:turn.project,chat:true,card:turn.project===null,setter};
  }

  /**
   * A change held for the owner's card becomes one request, named by the turn and the exact change, so the same call
   * again in that turn returns the same request; anything else passes through (ADR-0243).
   */
  private async held(turn:Turn,action:'add'|'update'|'comment',task:string|null,operation:string,body:Record<string,unknown>,result:any) {
    if(!result||typeof result!=='object'||!('held' in result))return result;
    const {held}=result as Held,id=digest(canonical(['owner-task-request-v1',operation]));
    const fingerprint=digest(canonical(['owner-task-request-v2',id,action,task,body,held.project,held.group,held.joining,held.chats,held.family,held.revision]));
    await this.control.query(`INSERT INTO owner_task_requests(id,action,task_id,operation_id,body,project_id,group_id,joining,chats,preview,source_reference,fingerprint,family,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`,
      [id,action,task,operation,JSON.stringify(body),held.project,held.group,held.joining,held.chats,JSON.stringify(held.preview),JSON.stringify(turn.source.reference),fingerprint,
        held.family,held.revision]);
    const row=(await this.control.query('SELECT id,action,task_id,project_id,state,result_task FROM owner_task_requests WHERE id=$1',[id])).rows[0];
    const base={request_id:row.id,action:row.action,project_id:row.project_id,...(row.task_id?{task_id:row.task_id}:{})};
    if(row.state==='proposed')return {state:'proposed',...base,note:'Nothing is changed yet: the owner approves this exact change on a card first.'};
    if(row.state==='done')return {state:'done',...base,task_id:row.result_task};
    if(row.state==='rejected')return {state:'rejected',...base,note:'The owner rejected this exact change; nothing changed.'};
    if(row.state==='refused')return {state:'refused',...base,error:'task_card_too_long',note:'Nothing changed: this change is too long to show exactly on a Telegram card. The owner can make it in the dashboard\'s Tasks page.'};
    return {state:'changed',...base,note:'Nothing changed: the task, its list or the chats that see it changed before the owner decided. Ask again if it is still wanted.'};
  }

  /**
   * A task card's content: what changes in which project's list, the chats that will see the task, and exactly what
   * they will see, from the task as it would be after the change (ADR-0243). A task that moves in brings every task
   * under it, archived and in the trash too, and the card shows each of them as well. `space` names a group or topic.
   * `audience` is always 'project': every chat of the project sees the task, chats added later included, whatever its
   * group; `group` names the task's group, a label, or null (ADR-0276).
   */
  async request(principal:Reader,id:string,space:(chat:string)=>Promise<string>) {
    admin(principal);
    const row=(await this.control.query('SELECT r.*,p.name AS project_name FROM owner_task_requests r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');
    const {settings}=await this.current(this.control),preview=row.preview,body=row.body as Record<string,unknown>;
    const names=(items:{name?:string;title?:string}[]|undefined)=>items?.length?items.map(item=>item.name??item.title??''):null;
    const at=(on:string|null,time:string|null)=>on?on+(time?' '+time:''):null;
    // The chats never read people or person columns (ADR-0265 D6), so the card shows neither. They read assignees only
    // by Telegram name, and count the rest (row, assigneesSeen), so the card shows them just so.
    const shared=seenColumns(settings);
    const assigned=(task:any)=>{
      const named=Array.isArray(task.assignees)?task.assignees.map((item:{name:string})=>item.name):[],other=Number(task.assignees_other??0);
      return named.length||other?[...named,...other?[other===1?'1 other person':`${other} other people`]:[]]:null;
    };
    // A new task, or one that joins the list, shows all of itself; a change in place shows the task and what it changes.
    const whole=row.action==='add'||row.action==='update'&&row.joining;
    // Each part of a task in words, under the name the owner sees on the dashboard.
    const shown=async(task:any,all:boolean)=>{
      const status=settings.statuses.find(item=>item.id===task.status)?.name??task.status,priority=settings.priorities.find(item=>item.level===task.priority)?.name??String(task.priority);
      const column=(property:TaskSettings['properties'][number])=>{
        const value=task.properties?.[property.id];
        if(value===undefined||value===null)return null;
        const option=(choice:unknown)=>property.options.find(item=>item.id===choice)?.name??choice;
        return property.type==='select'?option(value):property.type==='multi_select'&&Array.isArray(value)?value.map(option):value;
      };
      const parts:[string,string[],()=>Promise<unknown>|unknown][]=[
        ['Title',['title'],()=>task.title],['Notes',['notes'],()=>task.notes||null],['Status',['status','state'],()=>status],
        ['Priority',['priority'],()=>task.priority||!all?priority:null],['Starts',['start_on','start_time'],()=>at(task.start_on,task.start_time)],
        ['Due',['due_on','due_time'],()=>at(task.due_on,task.due_time)],['Repeats',['repeat'],()=>task.repeat?repeatWords(task.repeat):null],
        ['Reminders',['reminders'],()=>task.reminders?.length?task.reminders.map((item:any)=>item.at):null],
        ['Assigned to',['assignees'],()=>assigned(task)],
        ['Tags',['tags'],()=>task.tags?.length?task.tags:null],['Group',['group'],async()=>task.group_id?await space(task.group_id):null],
        ['Links',['attachments'],()=>task.attachments?.length?task.attachments.map((item:any)=>item.title?item.title+' — '+item.url:item.url):null],
        ['Waits on',['blocked_by'],()=>names(task.blocked_by)],['Related',['related'],()=>names(task.related)],
        ['Duplicate of',['duplicate_of'],()=>names(task.duplicate_of)],['Under',['parent'],()=>task.parent_title??null],
        ['Archived',['archived'],()=>!!task.archived_at],['In the trash',['trashed'],()=>!!task.deleted_at]];
      const fields:Record<string,unknown>={};
      // A whole task shows each part it has, and that it is archived or in the trash only when it is.
      for(const [label,keys,value] of parts)if(all||keys.some(key=>key in body)){
        const seen=await value();if(!all||seen!==null&&seen!==false)fields[label]=seen;}
      const given=body.properties&&typeof body.properties==='object'?Object.keys(body.properties as object).map(key=>key.trim().toLocaleLowerCase()):[];
      for(const property of shared)if(all?column(property)!==null:given.some(key=>key===property.id||key===property.name.toLocaleLowerCase()))fields[property.name]=column(property);
      return fields;
    };
    const family:any[]=whole&&Array.isArray(preview.descendants)?preview.descendants:[];
    let fields:Record<string,unknown>;
    // A change in place names the task as it was asked about.
    if(row.action==='comment')fields={Task:preview.task_title??preview.title,Comment:body.text};
    else {
      fields={...(whole?{}:{Task:preview.task_title??preview.title}),...await shown(preview,whole)};
      if(family.length){const under=[];for(const task of family)under.push(await shown(task,true));fields.Subtasks=under;}
    }
    // What the card says stays private: everything from before a task joined, and the parts a project's chats never see.
    const hidden=(Array.isArray(body.attachments)&&body.attachments.some((item:any)=>item?.kind==='message'))||'people' in body||
      (body.properties&&typeof body.properties==='object'&&Object.keys(body.properties as object).some(key=>!shared.some(item=>item.id===key||item.name.toLocaleLowerCase()===key.trim().toLocaleLowerCase())));
    // Only a move into the project's list joins it; a change of group is a change in place (ADR-0276).
    const moving=row.action==='update'&&row.joining,grouped=row.group_id!==null&&row.group_id!==undefined;
    const moved=moving?(family.length?'move_family' as const:'move' as const):null;
    return {id:row.id,state:row.state as string,fingerprint:row.fingerprint as string,source_reference:row.source_reference,chats:row.chats as string[],
      change:(row.action==='add'?'add':row.action==='comment'?'comment':moved??'change') as 'add'|'move'|'move_family'|'change'|'comment',
      project:row.project_name as string|null,group:grouped?row.group_id as string:null,audience:'project' as const,subtasks:family.length,
      private:moving?(family.length?'family' as const:'move' as const):hidden?'parts' as const:null,fields};
  }
  /** A card too long for Telegram never applies its change from chat: a shortened card would not show it exactly. */
  async refuse(principal:Reader,id:string) {
    admin(principal);
    await this.control.query("UPDATE owner_task_requests SET state='refused',error_code='task_card_too_long',decided_at=now() WHERE id=$1 AND state='proposed'",[id]);
  }
  /**
   * The owner's Approve or Reject on a task card. Approve makes exactly the change the card showed, as the owner's
   * own from their private chat, only while the task, its list and the chats that see that list are as the card said;
   * otherwise the request ends as changed and nothing changes (ADR-0243).
   */
  async decide(principal:Reader,input:{id:string;fingerprint:string;decision:string}) {
    admin(principal);
    if(!['approve','deny'].includes(input.decision))throw new HttpError(400,'invalid_decision');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const row=(await db.query('SELECT * FROM owner_task_requests WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(row.fingerprint!==input.fingerprint)throw new HttpError(409,'action_proposal_changed');
      if(row.state!=='proposed')throw new HttpError(409,'action_already_decided');
      let state='rejected',task:string|null=null,code:string|null=null;
      if(input.decision==='approve') {
        const context:Context={origin:'chat',actor:{kind:'owner'},source:String(row.source_reference?.id??'')||null,within:null,chat:true,setter:OWNER_HERE,
          approved:{project:row.project_id,group:row.group_id??null,chats:row.chats,family:row.family??null,revision:row.revision===null?null:Number(row.revision)}};
        try {
          const done=row.action==='add'?await this.insert(row.operation_id,row.body,context):row.action==='update'?await this.change(row.operation_id,row.task_id,row.body,context):
            await this.discuss(row.operation_id,row.task_id,row.body,context);
          state='done';task=done.id;
        }catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;state='changed';code=error.code;}
      }
      await db.query('UPDATE owner_task_requests SET state=$2,result_task=$3,error_code=$4,decided_at=now() WHERE id=$1',[row.id,state,task,code]);
      await db.query('COMMIT');
      return {id:row.id as string,state,...(task?{task_id:task}:{}),...(code?{error:code}:{})};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  /**
   * The assignees of these stored task rows as the project view `view` sees them (owner answer Q4), set on each row as
   * `assignees_seen` for row() and memberTask, in one query for all of them. An assignee shows by the People name the
   * owner set (ADR-0274), else their Telegram name (the name Telegram last showed, else their @username), only when the owner bound them in Memory › People, exactly
   * or as confirmed, to the source identity of a person's Telegram account that is in one of the project's groups now,
   * whichever chat reads (ADR-0276) (its membership 'in', the group an active top-level group, and not switched off for that account's member);
   * every other assignee, unbound or elsewhere, is only counted. `accounts` are the reading member's own: an assignee
   * bound to one of them makes the task theirs. The owner reads every assignee as stored, so nothing is set for them.
   */
  private async assigneesSeen(db:Pick<pg.Pool,'query'>,found:readonly any[],view:View,accounts:readonly string[]=[]):Promise<void> {
    if(!view)return;
    const rows=found.filter(value=>value&&Array.isArray(value.assignees));
    const ids=(value:any):string[]=>value.assignees.map((item:any)=>item?.id).filter((id:unknown):id is string=>typeof id==='string'&&hex.test(id));
    const wanted=[...new Set(rows.flatMap(ids))],groups=[...view.groups],mine=accounts.filter(account=>hex.test(account));
    const named=new Map<string,string>(),ours=new Set<string>();
    if(wanted.length&&(groups.length||mine.length)) {
      const bound=(await db.query(`WITH present AS (SELECT DISTINCT s.account_id FROM chat_memberships s JOIN chat_accounts a ON a.id=s.account_id
          JOIN chats g ON g.id=s.chat_id AND g.kind='group' AND g.parent_id IS NULL AND g.state='active'
          WHERE s.chat_id=ANY($2::text[]) AND s.state='in'
            AND NOT EXISTS(SELECT 1 FROM member_chats w WHERE w.member_id=a.member_id AND w.chat_id=s.chat_id AND NOT w.enabled)),
        known AS (SELECT a.id,a.display_name,a.username,a.id IN (SELECT account_id FROM present) AS shown,a.id=ANY($3::text[]) AS mine,
            ${actorSourceSql('a.')} AS source FROM chat_accounts a WHERE (a.id IN (SELECT account_id FROM present) OR a.id=ANY($3::text[])) AND ${telegramPersonSql('a.')})
        SELECT b.entity_id,k.id AS account,k.display_name,coalesce(k.username,(SELECT d.username FROM chats c JOIN chat_details d ON d.chat_id=c.id
            WHERE c.account_id=k.id AND c.kind='private' AND d.username IS NOT NULL ORDER BY c.id LIMIT 1)) AS username,k.shown,k.mine
          FROM memory_entity_bindings b JOIN known k ON k.source=b.source_object_id
          WHERE b.entity_id=ANY($1::text[]) AND b.binding_kind='source_identity' AND b.state IN ('exact','confirmed') ORDER BY b.entity_id,k.id`,
        [wanted,groups,mine])).rows;
      const chosen=await accountPeopleNames(db,bound.filter(item=>item.shown===true).map(item=>item.account));
      for(const item of bound) {
        if(item.mine===true)ours.add(item.entity_id);
        const name=item.shown===true?chosen.get(item.account)??telegramName(item.display_name,item.username):null;
        if(name!==null&&!named.has(item.entity_id))named.set(item.entity_id,name);
      }
    }
    for(const value of rows) {
      const all=ids(value),names=all.filter(id=>named.has(id)).map(id=>named.get(id)!).sort((a,b)=>a.localeCompare(b));
      value.assignees_seen={names,other:value.assignees.length-names.length,mine:all.some(id=>ours.has(id))} satisfies AssigneesSeen;
    }
  }
  private versionKeyLoad:Promise<Buffer>|null=null;
  /** The installation's key of the members' task versions: read once per repository, made the first time any is needed
   * (a random 32 bytes, kept by whichever instance writes it first). It never leaves this method but as an HMAC key. */
  private versionKey():Promise<Buffer> {
    this.versionKeyLoad??=(async()=>{
      await this.control.query('INSERT INTO owner_task_version_key(singleton,key) VALUES(true,$1) ON CONFLICT DO NOTHING',[randomBytes(32)]);
      const key=(await this.control.query('SELECT key FROM owner_task_version_key WHERE singleton')).rows[0]?.key;
      if(!Buffer.isBuffer(key)||key.length!==32)throw new HttpError(503,'task_version_unavailable');
      return key;
    })().catch(error=>{this.versionKeyLoad=null;throw error;});
    return this.versionKeyLoad;
  }
  private async current(db:Pick<pg.Pool,'query'>) {
    const row=(await db.query('SELECT settings,revision FROM owner_task_settings WHERE singleton')).rows[0];
    return {settings:storedTaskSettings(row?.settings),revision:Number(row?.revision??0)};
  }
  /** Today, as a calendar day in the owner's task time zone. */
  private async today(db:Pick<pg.Pool,'query'>,zone:string):Promise<string> {
    return (await db.query(`SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') AS day`,[zone])).rows[0].day;
  }

  private page(input:ListInput,within:string|null,member:readonly string[]):Promise<MemberTaskPage>;
  private page(input:ListInput,within?:string|null):Promise<any>;
  /** One page of a list. With `member` (the accounts of the member reading, ADR-0265 D6), the page is the members' shape:
   * each task named field by field (memberTask), the tags of the tasks they see, and nothing else, so no count, no other
   * list and no settings, the owner's time zone among them. 'closed' lists the done and the dropped. */
  private async page(input:ListInput,within:string|null=null,member?:readonly string[]):Promise<any> {
    const state=input.state||'open',count=limit(input.limit,100,200),offset=input.after?Number(input.after):0;
    if(state!=='all'&&state!=='closed'&&!states.includes(state))throw new HttpError(400,'invalid_task_state');
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_cursor');
    const place=input.in||'active',when=input.when||'',sort=input.sort||(state==='open'?'due':'finished');
    if(!['active','archive','trash'].includes(place))throw new HttpError(400,'invalid_task_place');
    if(!['','today','upcoming'].includes(when))throw new HttpError(400,'invalid_task_when');
    if(!['due','manual','priority','created','updated','title','finished'].includes(sort))throw new HttpError(400,'invalid_task_sort');
    const {settings}=await this.current(this.control),today=await this.today(this.control,settings.time_zone);
    const view=await this.view(this.control,within,settings);
    const values:unknown[]=[],p=(value:unknown)=>{values.push(value);return '$'+values.length;},filters:string[]=['true'];
    // 'all' lists every scope; 'personal' only the owner's own life tasks; a project id only that project.
    const every=!input.scope||input.scope==='all',project=every?null:scope(input.scope);
    if(!every)filters.push(`project_id IS NOT DISTINCT FROM ${p(project)}::text`);
    // A project's chat lists only its project's tasks, and every count it gets counts only those (ADR-0276).
    const seen=view?p(view.project):null;
    if(seen)filters.push(seesSql('',seen));
    // A tag matches whatever its case; a group matches its own tasks and those of its topics.
    if(input.tag)filters.push(`lower(${p(tag(input.tag))}::text) IN (SELECT lower(t) FROM unnest(tags) t)`);
    // A project's chat finds tasks only by a group or topic of its project now, as it sees no other group on them.
    if(input.group){const space=validateSpace(input.group);
      if(view&&!seesGroup(view,space))filters.push('false');
      else filters.push(`group_id=ANY(${p([...new Set([space,...directory().expand([space])])])}::text[])`);}
    if(input.person)filters.push(`EXISTS (SELECT 1 FROM owner_task_people x WHERE x.task_id=owner_tasks.id AND x.entity_id=${p(ids([input.person],'invalid_task_people')[0])}::text)`);
    if(input.mine){const accounts=p([...input.mine]);filters.push(`(created_by_account=ANY(${accounts}::text[]) OR EXISTS (SELECT 1 FROM owner_task_reminders x
      WHERE x.task_id=owner_tasks.id AND x.set_by='person' AND x.set_by_account_id=ANY(${accounts}::text[])) OR ${assignedToSql('owner_tasks.id',accounts)})`);}
    if(input.status){if(!settings.statuses.some(item=>item.id===input.status))throw new HttpError(400,'invalid_task_status');filters.push(`status_id=${p(input.status)}::text`);}
    if(input.priority){const level=Number(input.priority);if(!Number.isSafeInteger(level)||level<0||level>4)throw new HttpError(400,'invalid_task_priority');filters.push(`priority=${p(level)}::int`);}
    const topLevel='parent_id IS NULL';
    // The trash's top also holds a subtask trashed on its own, under a task that is not in the trash: listed nowhere
    // else, it is found and restored there.
    const trashTop=`(${topLevel} OR NOT EXISTS (SELECT 1 FROM owner_tasks u WHERE u.id=owner_tasks.parent_id AND u.deleted_at IS NOT NULL))`;
    if(input.parent&&input.parent!=='top'&&!hex.test(input.parent))throw new HttpError(400,'invalid_task_parent');
    if(input.q){const words=p('%'+string(input.q,200).trim().replace(/[\\%_]/g,'\\$&')+'%');filters.push(`(title ILIKE ${words}::text OR notes ILIKE ${words}::text)`);}
    const base=filters.join(' AND ');
    // Today holds what is due or starts today or earlier; Upcoming what is due or starts in the next two weeks.
    // Both days come from the database's own clock as YYYY-MM-DD, so they are written in directly.
    if(!/^\d{4}-\d{2}-\d{2}$/.test(today))throw new HttpError(500,'task_clock_unavailable');
    const t=`'${today}'::date`,h=`'${addDays(today,14)}'::date`;
    const isToday=`(due_on<=${t} OR start_on<=${t})`,isUpcoming=`(NOT coalesce(due_on<=${t} OR start_on<=${t},false) AND (due_on<=${h} OR start_on<=${h}))`;
    const places={active:'deleted_at IS NULL AND archived_at IS NULL',archive:'deleted_at IS NULL AND archived_at IS NOT NULL',trash:'deleted_at IS NOT NULL'};
    const window=when==='today'?isToday:when==='upcoming'?isUpcoming:'true';
    const orders:Record<string,string>={
      due:`coalesce(least(due_on,start_on),due_on,start_on) ASC NULLS LAST,coalesce(due_time,start_time) ASC NULLS LAST,priority DESC,position,created_at,id`,
      manual:'position,created_at,id',priority:'priority DESC,due_on ASC NULLS LAST,position,created_at,id',
      created:'created_at DESC,id',updated:'updated_at DESC,id',title:'lower(title),id',
      finished:`CASE state WHEN 'open' THEN 0 ELSE 1 END,coalesce(done_at,updated_at) DESC,id`};
    // Lists count the tasks at the top of each list; Today and Upcoming count subtasks too, as they show them.
    const live=places.active,top=`${topLevel} AND ${places.active}`;
    const counts=member?null:(await this.control.query(`SELECT count(*) FILTER (WHERE ${top} AND state='open')::int AS open,count(*) FILTER (WHERE ${top} AND state='done')::int AS done,
      count(*) FILTER (WHERE ${top} AND state='dropped')::int AS dropped,count(*) FILTER (WHERE ${live} AND state='open' AND ${isToday})::int AS today,
      count(*) FILTER (WHERE ${live} AND state='open' AND ${isUpcoming})::int AS upcoming,count(*) FILTER (WHERE ${topLevel} AND ${places.archive})::int AS archive,
      count(*) FILTER (WHERE ${trashTop} AND ${places.trash})::int AS trash FROM owner_tasks WHERE ${base}`,values.slice())).rows[0];
    // The parent and state bind after the counts, which take neither.
    const parent=input.parent==='top'?(place==='trash'?trashTop:topLevel):input.parent?`parent_id=${p(input.parent)}::text`:'true';
    const chosen=state==='all'?'true':state==='closed'?`state<>'open'`:`state=${p(state)}::text`;
    const rows=(await this.control.query(`SELECT ${seen?seenFields(view,seen):fields} FROM owner_tasks WHERE ${base} AND ${parent} AND ${places[place as keyof typeof places]} AND ${chosen} AND ${window}
      ORDER BY ${orders[sort]} LIMIT ${p(count+1)}::int OFFSET ${p(offset)}::int`,values)).rows;
    const next=rows.length>count?String(offset+count):null;
    await this.assigneesSeen(this.control,rows.slice(0,count),view,member);
    if(member&&view){const key=await this.versionKey();return {tasks:rows.slice(0,count).map(value=>memberTask(value,view,member,key)),next,tags:(await this.tagsSeen(every,project,view)).map(item=>item.name as string),
      ...memberBoardWords(settings)};}
    // Every list with its open count: personal first, then each active project with the chats that see its list. A
    // project's chat counts only its own list.
    const open=`count(t.id) FILTER (WHERE t.state='open' AND t.deleted_at IS NULL AND t.archived_at IS NULL)::int AS open`;
    const scopes=view?(await this.control.query(`SELECT p.id,p.name,${open} FROM projects p LEFT JOIN owner_tasks t ON ${seesSql('t.','p.id')} WHERE p.id=$1 GROUP BY p.id,p.name`,
      [view.project])).rows
      :(await this.control.query(`SELECT 'personal' AS id,NULL AS name,${open},'{}'::text[] AS chats FROM (SELECT 1) one LEFT JOIN owner_tasks t ON t.project_id IS NULL
      UNION ALL SELECT * FROM (SELECT p.id,p.name,${open},${projectChats('p.id','$1')} AS chats FROM projects p
        LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.state='active' OR t.id IS NOT NULL GROUP BY p.id,p.name ORDER BY lower(p.name),p.id) listed`,[groupSpaces()])).rows;
    const tagged=await this.tagsSeen(every,project,view);
    // A project's chat learns the names of the shared columns only.
    const listed=rows.slice(0,count).map(value=>row(value,view));
    return {tasks:view?listed:await this.sourced(listed),next,counts,scopes,tags:tagged,
      settings:view?{...settings,properties:seenColumns(settings)}:settings,today};
  }

  /** The tags in use in a list, each once whatever its case, spelled as most recently written; a project's view learns
   * only the tags of its own list. */
  private async tagsSeen(every:boolean,project:string|null,view:View) {
    return (await this.control.query(`SELECT (array_agg(t ORDER BY updated_at DESC))[1] AS name,count(*) FILTER (WHERE state='open')::int AS open
      FROM owner_tasks,unnest(tags) t WHERE deleted_at IS NULL AND ($1 OR project_id IS NOT DISTINCT FROM $2) AND ${view?seesSql('','$3'):'$3::text IS NULL'}
      GROUP BY lower(t) ORDER BY lower(t)`,[every,project,view?.project??null])).rows;
  }
  /** One task with its subtasks, links, comments, history and the task it sits under. With `member` (the accounts of the
   * member reading), in the members' shape (memberDetail, ADR-0265 D6). */
  private detail(id:string,within:string,member:readonly string[]):Promise<MemberDetail>;
  private detail(id:string,within:string|null):Promise<any>;
  private async detail(id:string,within:string|null,member?:readonly string[]):Promise<any> {
    if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    // A project's chat binds its project as $2 to every query that reads tasks.
    const view=await this.view(this.control,within),bound=view?[view.project]:[];
    const found=(await this.control.query(`SELECT ${seenFields(view,'$2')},${linked('blocked_by','task_id','other_id')} AS blocking,
      ${linked('related','other_id','task_id')} AS related_to,${linked('related','task_id','other_id')} AS related_from,
      ${linked('duplicate_of','other_id','task_id')} AS duplicate_of,${linked('duplicate_of','task_id','other_id')} AS duplicates
      FROM owner_tasks WHERE id=$1`,[id,...bound])).rows[0];
    // Another list's task is not found from a project's chat, so its existence stays private (ADR-0243).
    if(!found||!sees(view,found))throw new HttpError(404,'task_not_found');
    await this.assigneesSeen(this.control,[found],view,member);
    const [task]=view?[row(found,view)]:await this.sourced([row(found,view)]),visible=(items:any[])=>items.filter(item=>sees(view,item)).map(item=>seenLink(view,item));
    const {related_to,related_from,...rest}=task;
    const seenHere=view?seesSql('','$2'):'true';
    const parent=task.parent_id?(await this.control.query(`SELECT id,title,state FROM owner_tasks WHERE id=$1 AND ${seenHere}`,[task.parent_id,...bound])).rows[0]??null:null;
    const below=(await this.control.query(`SELECT ${seenFields(view,'$2')} FROM owner_tasks WHERE parent_id=$1 AND deleted_at IS NULL AND ${seenHere}
      ORDER BY position,created_at,id`,[id,...bound])).rows;
    if(!member)await this.assigneesSeen(this.control,below,view);
    const under=below.map(value=>row(value,view)),subtasks=view?under:await this.sourced(under);
    // A project's chat sees comments and history only from when the task joined its list, the change that brought it
    // there shows only where it went, and a group that is not one of the project's now shows as none (ADR-0243, ADR-0276).
    const since=`($2::boolean OR %s>=coalesce((SELECT project_since FROM owner_tasks WHERE id=$1),'infinity'::timestamptz))`;
    const comments=(await this.control.query(`SELECT id,body,author,origin,created_at FROM owner_task_comments WHERE task_id=$1 AND ${since.replace('%s','created_at')} ORDER BY created_at,id`,[id,!within])).rows;
    const activity=(await this.control.query(`SELECT id::text,at,actor,origin,changes,at=(SELECT project_since FROM owner_tasks WHERE id=$1) AS joined FROM owner_task_activity WHERE task_id=$1 AND ${since.replace('%s','at')} ORDER BY id DESC LIMIT 100`,[id,!within])).rows
      .map(({joined,...item})=>view?{...item,changes:boardChange(item.changes,view,joined===true)}:item);
    // The owner learns how many tasks sit under it at every level, archived and in the trash too: a move takes them all.
    if(member&&view)return memberDetail(found,view,member,await this.versionKey(),{related:visible([...related_to,...related_from]),duplicate_of:visible(task.duplicate_of),children:subtasks,comments,activity});
    const descendants=within?{}:{descendants:Number((await this.control.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1
      UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id) SELECT count(*)::int AS count FROM down`,[id])).rows[0].count)};
    return {...rest,blocking:visible(task.blocking),related:visible([...related_to,...related_from]),duplicate_of:visible(task.duplicate_of),
      duplicates:visible(task.duplicates),parent,subtasks,comments,activity,...descendants};
  }

  /** The fields a request sets, checked and in stored form; nothing is written yet. */
  private async read(body:Record<string,unknown>,settings:TaskSettings,context:Context):Promise<Patch> {
    const patch:Patch={};
    if(body.title!==undefined)patch.title=title(body.title);
    if(body.notes!==undefined)patch.notes=notes(body.notes);
    if(body.status!==undefined&&body.status!==null){
      const wanted=string(body.status,40).trim().toLocaleLowerCase(),status=settings.statuses.find(item=>item.id===wanted||item.name.toLocaleLowerCase()===wanted);
      if(!status)throw new HttpError(400,'invalid_task_status');patch.status_id=status.id;
    } else if(body.state!==undefined){
      if(!states.includes(String(body.state)))throw new HttpError(400,'invalid_task_state');
      patch.state=body.state as TaskState;
    }
    if(body.priority!==undefined&&body.priority!==null){
      const wanted=typeof body.priority==='string'?settings.priorities.find(item=>item.name.toLocaleLowerCase()===String(body.priority).trim().toLocaleLowerCase())?.level
        ??['none','low','medium','high','urgent'].indexOf(String(body.priority).trim().toLowerCase()):body.priority;
      if(!Number.isSafeInteger(wanted)||Number(wanted)<0||Number(wanted)>4)throw new HttpError(400,'invalid_task_priority');
      patch.priority=Number(wanted);
    }
    if('start_on' in body)patch.start_on=day(body.start_on,'invalid_task_start');
    if('start_time' in body)patch.start_time=clock(body.start_time);
    if('due_on' in body)patch.due_on=day(body.due_on);
    if('due_time' in body)patch.due_time=clock(body.due_time);
    if('repeat' in body)patch.repeat=readRepeat(body.repeat);
    if('parent' in body)patch.parent_id=body.parent===null||body.parent===''?null:ids([body.parent],'invalid_task_parent',1)[0]!;
    if(body.position!==undefined){if(typeof body.position!=='number'||!Number.isFinite(body.position)||Math.abs(body.position)>1e12)throw new HttpError(400,'invalid_task_position');patch.position=body.position;}
    if(body.scope!==undefined)patch.project_id=scope(body.scope);
    if('group' in body){
      patch.group_id=group(body.group);
      // A task's group is a label: a group or one of its topics, never a private chat, for every writer (400). A
      // project's chat, the members' app included, names only a group of its project now, or none: the project
      // itself (403) (ADR-0276).
      if(patch.group_id!==null&&!groupSpace(patch.group_id))throw new HttpError(400,'invalid_task_group');
      if(context.within&&patch.group_id!==null&&!seesGroup(await this.view(this.control,context.within),patch.group_id))throw new HttpError(403,'task_group_denied');
    }
    if(body.tags!==undefined)patch.tags=tags(body.tags);
    if(body.people!==undefined)patch.people=ids(body.people,'invalid_task_people');
    if(body.assignees!==undefined)patch.assignees=ids(body.assignees,'invalid_task_assignees');
    if(body.blocked_by!==undefined)patch.blocked_by=ids(body.blocked_by,'invalid_task_links');
    if(body.related!==undefined)patch.related=ids(body.related,'invalid_task_links');
    if(body.duplicate_of!==undefined)patch.duplicate_of=body.duplicate_of===null?[]:ids(Array.isArray(body.duplicate_of)?body.duplicate_of:[body.duplicate_of],'invalid_task_links',1);
    if(body.attachments!==undefined){
      patch.attachments=attachments(body.attachments);
      // Only the owner's private chat or the dashboard can point a task to an archived message.
      if(context.within&&patch.attachments.some(item=>item.kind==='message'))throw new HttpError(403,'task_attachment_denied');
    }
    if(body.external!==undefined)patch.external=external(body.external);
    if(body.archived!==undefined){if(typeof body.archived!=='boolean')throw new HttpError(400,'invalid_task_archived');patch.archived=body.archived;}
    if(body.trashed!==undefined){if(typeof body.trashed!=='boolean')throw new HttpError(400,'invalid_task_trashed');patch.trashed=body.trashed;}
    if(body.properties!==undefined)patch.properties=this.properties(body.properties,settings,context.within);
    if(body.reminders!==undefined){
      // How many a list may hold depends on the task's reminders (attach); far more than any task holds is refused here.
      if(!Array.isArray(body.reminders))throw new HttpError(400,'invalid_task_reminders');
      if(body.reminders.length>1000)throw new HttpError(400,'task_reminder_limit');
      const texts=body.reminders.map(item=>{
        if(typeof item!=='string'||item.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(item))
          throw new HttpError(400,'invalid_task_reminder');
        return item;
      });
      // A time without an offset is a wall-clock time in the owner's task time zone. All are read in one query.
      const read=texts.length?(await this.control.query(`SELECT (CASE WHEN t ~ '(Z|[+-]\\d{2}:?\\d{2})$' THEN t::timestamptz ELSE t::timestamp AT TIME ZONE $2 END) AS at
        FROM unnest($1::text[]) WITH ORDINALITY u(t,ord) ORDER BY ord`,[texts,settings.time_zone]).catch(()=>{throw new HttpError(400,'invalid_task_reminder');})).rows:[];
      patch.reminders=[...new Set(read.map(row=>new Date(row.at).toISOString()))].sort();
    }
    return patch;
  }

  /** Values for the owner's own columns, by column ID or name; null clears one. A project's chat reaches only the
   * columns the owner shares; any other answers as unknown, so its name stays private. */
  private properties(value:unknown,settings:TaskSettings,within:string|null):Record<string,unknown> {
    const body=object(value),values:Record<string,unknown>={};
    for(const [key,item] of Object.entries(body)){
      const wanted=key.trim().toLocaleLowerCase(),property=settings.properties.find(entry=>(entry.id===key||entry.name.toLocaleLowerCase()===wanted)&&(!within||entry.shared));
      if(!property)throw new HttpError(400,'unknown_task_property');
      if(item===null||item===''){values[property.id]=null;continue;}
      const option=(choice:unknown)=>{const text=string(choice,200).trim().toLocaleLowerCase(),found=property.options.find(entry=>entry.id===choice||entry.name.toLocaleLowerCase()===text);
        if(!found)throw new HttpError(400,'invalid_task_property_value');return found.id;};
      const fail=()=>{throw new HttpError(400,'invalid_task_property_value');};
      switch(property.type){
        case 'text':values[property.id]=string(item,2000);break;
        case 'number':if(typeof item!=='number'||!Number.isFinite(item))fail();values[property.id]=item;break;
        case 'checkbox':if(typeof item!=='boolean')fail();values[property.id]=item;break;
        case 'date':values[property.id]=day(item,'invalid_task_property_value');break;
        case 'url':values[property.id]=url(item);break;
        case 'select':values[property.id]=option(item);break;
        case 'multi_select':if(!Array.isArray(item)||item.length>20)fail();values[property.id]=[...new Set((item as unknown[]).map(option))];break;
        case 'person':values[property.id]=ids(item,'invalid_task_property_value');break;
      }
    }
    return values;
  }

  private async insert(operation:string,body:Record<string,unknown>,context:Context) {
    const {settings}=await this.current(this.control);
    const patch=await this.read(body,settings,context);
    if(patch.title===undefined)throw new HttpError(400,'task_title_required');
    const hash=digest(canonical(patch)),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash,context);if(prior){await db.query('COMMIT');return prior;}
      const status=patch.status_id?settings.statuses.find(item=>item.id===patch.status_id)!:this.statusFor(settings,patch.state??'open',null);
      // The parent is held while the new task is added under it, so a move of the parent in the meantime brings it along.
      const parent=patch.parent_id?await this.parentOf(db,patch.parent_id,null,context,true):null;
      if(parent&&patch.project_id!==undefined&&patch.project_id!==parent.project_id)throw new HttpError(400,'task_parent_other_list');
      // A subtask sits in its parent's list and takes its parent's group unless it names one (ADR-0276).
      const project=parent?parent.project_id:patch.project_id??null,grouped=patch.group_id!==undefined?patch.group_id:parent?parent.group_id:null;
      if(project)await this.activeProject(db,project);
      // A new task in a project's list is seen by the chats that will see it there.
      const gate=await this.gate(db,context,project,grouped,true);
      const id=digest('task:'+operation);
      const position=patch.position??Number((await db.query(`SELECT coalesce(max(position),0)+1 AS next FROM owner_tasks WHERE project_id IS NOT DISTINCT FROM $1
        AND parent_id IS NOT DISTINCT FROM $2`,[project,patch.parent_id??null])).rows[0].next);
      this.checkDates({start_on:patch.start_on??null,start_time:patch.start_time??null,due_on:patch.due_on??null,due_time:patch.due_time??null});
      const finished=status.category==='done'||status.category==='cancelled';
      await db.query(`INSERT INTO owner_tasks(id,title,notes,status_id,state,priority,start_on,start_time,due_on,due_time,repeat,parent_id,position,project_id,group_id,tags,
        properties,external,origin,source_event,created_by,done_at,finished_by,project_since,created_by_account)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,${finished?'now()':'NULL'},$22,CASE WHEN $14::text IS NULL THEN NULL ELSE now() END,$23)`,
        [id,patch.title,patch.notes??'',status.id,stateOf(status.category),patch.priority??0,patch.start_on??null,patch.start_time??null,patch.due_on??null,patch.due_time??null,
          patch.repeat?JSON.stringify(patch.repeat):null,patch.parent_id??null,position,project,grouped,patch.tags??[],
          JSON.stringify(Object.fromEntries(Object.entries(patch.properties??{}).filter(([,value])=>value!==null))),JSON.stringify(patch.external??{}),
          context.origin,context.source,JSON.stringify(context.actor),finished?JSON.stringify(context.actor):null,
          // Who made it, by their account, when a person did, in a group or the members' app: the app's "Mine" reads it.
          context.setter.by==='person'?context.setter.account:null]);
      await this.attach(db,id,patch,context,true,settings.time_zone,{});
      if(!ownerHere(context.setter))await this.written(db,id,context.setter,['title',...(patch.notes?['notes']:[]),...(patch.due_on||patch.due_time?['due']:[]),...(finished?['closed']:[])]);
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await this.record(db,id,context.actor,context.origin,{created:true});
      // A change held for the owner's card was checked in full here; it is undone and kept with how it would look.
      if(gate){const preview=await this.preview(db,id,gate,false);await db.query('ROLLBACK');return {held:{...gate,joining:true,preview,family:null,revision:null}} satisfies Held;}
      const created=await this.one(db,id,context);
      await db.query('COMMIT');return created;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  private async change(operation:string,id:string,body:Record<string,unknown>,context:Context) {
    if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    if(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<1)throw new HttpError(400,'invalid_expected_revision');
    const {settings}=await this.current(this.control);
    const patch=await this.read(body,settings,context);
    if(!Object.keys(patch).length)throw new HttpError(400,'task_change_required');
    const hash=digest(canonical({id,expected_revision:body.expected_revision,...patch})),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash,context);if(prior){await db.query('COMMIT');return prior;}
      const current=(await db.query(`SELECT id,title,notes,status_id,state,priority,to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(start_time,'HH24:MI') AS start_time,
        to_char(due_on,'YYYY-MM-DD') AS due_on,to_char(due_time,'HH24:MI') AS due_time,repeat,repeated_to,parent_id,position,project_id,project_since,group_id,tags,properties,
        archived_at,deleted_at,revision FROM owner_tasks WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      // Another list's task is not found from a project's chat, so its existence stays private.
      if(!current||!sees(this.reader(context),current))throw new HttpError(404,'task_not_found');
      if(Number(current.revision)!==Number(body.expected_revision))throw new HttpError(409,'task_revision_conflict');
      if(current.deleted_at&&patch.trashed!==false&&Object.keys(patch).some(key=>key!=='trashed'))throw new HttpError(409,'task_in_trash');
      await this.joined(db,current);
      const set:Record<string,unknown>={},changes:Record<string,unknown>={};
      const scalar=(column:string,value:unknown,show=true)=>{
        const before=current[column]??null,after=value??null;
        if(canonical(before)===canonical(after))return;
        set[column]=value;changes[column]=show?{from:before,to:after}:true;
      };
      if(patch.title!==undefined)scalar('title',patch.title);
      if(patch.notes!==undefined)scalar('notes',patch.notes,false);
      const now=settings.statuses.find(item=>item.id===current.status_id)??this.statusFor(settings,current.state,null);
      const status=patch.status_id?settings.statuses.find(item=>item.id===patch.status_id)!:patch.state?this.statusFor(settings,patch.state,now):null;
      if(status)scalar('status_id',status.id);
      if(patch.priority!==undefined)scalar('priority',patch.priority);
      for(const column of ['start_on','start_time','due_on','due_time'] as const)if(patch[column]!==undefined)scalar(column,patch[column]);
      if(patch.repeat!==undefined)scalar('repeat',patch.repeat);
      if(patch.position!==undefined&&patch.position!==Number(current.position))set.position=patch.position;
      if(patch.tags!==undefined)scalar('tags',patch.tags,false);
      if(patch.external!==undefined)scalar('external',patch.external,false);
      if(patch.properties!==undefined){
        const merged={...current.properties};for(const [key,value] of Object.entries(patch.properties))if(value===null)delete merged[key];else merged[key]=value;
        scalar('properties',merged,false);
      }
      // A subtask stays in its parent's list; moving a task moves everything under it.
      const parentId=patch.parent_id!==undefined?patch.parent_id:current.parent_id,newParent=patch.parent_id!==undefined&&patch.parent_id!==current.parent_id;
      const parentTask=!parentId?null:newParent?await this.parentOf(db,parentId,id,context)
        :(await db.query('SELECT project_id,group_id FROM owner_tasks WHERE id=$1',[parentId])).rows[0]??{project_id:null,group_id:null};
      if(patch.parent_id!==undefined)scalar('parent_id',patch.parent_id);
      // An explicit list or group wins; a new parent brings its own list, and its group unless one is named; otherwise
      // they stay.
      const project:string|null=patch.project_id!==undefined?patch.project_id:newParent&&parentTask?parentTask.project_id:current.project_id;
      const grouped:string|null=patch.group_id!==undefined?patch.group_id:newParent&&parentTask?parentTask.group_id:current.group_id;
      if(parentTask&&project!==parentTask.project_id)throw new HttpError(400,'task_parent_other_list');
      if(project!==current.project_id){if(project)await this.activeProject(db,project);scalar('project_id',project);}
      scalar('group_id',grouped);
      // Only a change of list gives the task a new audience: a group is a label, and every chat of the list sees the
      // task whatever its group (ADR-0276). Everything under a moved task moves with it. They are all locked before the
      // joining time is read, so nothing written to any of them before the move counts as written for the new
      // audience (ADR-0243).
      const moving='project_id' in set;
      let since:string|null=null;
      if(moving){
        await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
          SELECT id FROM owner_tasks WHERE id IN (SELECT id FROM down) ORDER BY id FOR UPDATE`,[id]);
        if(project)since=(await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      }
      // A task that joins a project's list, or a change to one already there beyond its status, priority, dates, group,
      // archive and trash, is seen by the chats that see it there.
      const joining=!!project&&moving;
      const gate=await this.gate(db,context,project,grouped,joining||Object.keys(body).some(key=>!direct.has(key)));
      const dates={start_on:'start_on' in set?set.start_on:current.start_on,start_time:'start_time' in set?set.start_time:current.start_time,
        due_on:'due_on' in set?set.due_on:current.due_on,due_time:'due_time' in set?set.due_time:current.due_time} as Record<string,string|null>;
      this.checkDates(dates);
      const category=(status??now).category,opened=stateOf(now.category)==='open',next=stateOf(category);
      const columns=Object.entries(set),values:unknown[]=[id];
      const assignments=columns.map(([column,value])=>{values.push(['repeat','properties','external'].includes(column)?(value===null?null:JSON.stringify(value)):value);return `${column}=$${values.length}`;});
      if(moving){values.push(since);assignments.push(`project_since=$${values.length}::timestamptz`);}
      if(status&&next!==current.state){
        values.push(next);assignments.push(`state=$${values.length}`);
        if(next==='open')assignments.push('done_at=NULL','finished_by=NULL');
        else if(opened){values.push(JSON.stringify(context.actor));assignments.push('done_at=now()',`finished_by=$${values.length}`);}
        changes.state={from:current.state,to:next};
      }
      if(patch.archived!==undefined&&patch.archived!==!!current.archived_at){assignments.push(`archived_at=${patch.archived?'now()':'NULL'}`);changes.archived={from:!patch.archived,to:patch.archived};}
      if(patch.trashed!==undefined&&patch.trashed!==!!current.deleted_at){assignments.push(`deleted_at=${patch.trashed?'now()':'NULL'}`);changes.trashed={from:!patch.trashed,to:patch.trashed};}
      const effects:Effects={},sides=await this.attach(db,id,patch,context,false,settings.time_zone,effects);
      Object.assign(changes,sides);
      // An edit that changes nothing leaves the task and its revision as they were.
      if(assignments.length||Object.keys(sides).length)
        await db.query(`UPDATE owner_tasks SET ${[...assignments,'revision=revision+1','updated_at=now()'].join(',')} WHERE id=$1`,values);
      const family=moving?await this.descendants(db,id,'project_id=$2,group_id=$3,project_since=$4::timestamptz',[project,grouped,since]):null;
      // An approved move takes exactly the tasks under it that its card showed, as the card showed them.
      if(context.approved&&context.approved.family!==family)throw new HttpError(409,'task_request_changed');
      // Who closed the tasks under it, read before the sweep below closes them (ADR-0255).
      if(changes.archived&&patch.archived||changes.trashed&&patch.trashed)await this.closedFamily(db,id,context.setter);
      if(changes.archived)await this.descendants(db,id,`archived_at=${patch.archived?'now()':'NULL'}`,[]);
      if(changes.trashed)await this.descendants(db,id,`deleted_at=${patch.trashed?'now()':'NULL'}`,[]);
      // The change that brings a task into a list or a group is the first thing its chats see of it.
      // Who wrote the title, notes and due day, and who closed it, for the reminders that name them (ADR-0255).
      // A person closes only a task still fully open: archiving, trashing or dropping one already closed keeps whoever
      // closed it, and one the owner closed keeps no row, so its owner reminders stay skipped. The owner takes it anyway.
      const closing=!!(changes.state&&next!=='open'||changes.archived&&patch.archived||changes.trashed&&patch.trashed);
      const wasOpen=current.state==='open'&&!current.archived_at&&!current.deleted_at;
      await this.written(db,id,context.setter,[...('title' in set?['title']:[]),...('notes' in set?['notes']:[]),
        ...(['due_on','due_time'].some(column=>column in set)?['due']:[]),...(closing&&(context.setter.by!=='person'||wasOpen)?['closed']:[])]);
      if(changes.state||changes.archived||changes.trashed)await db.query(`WITH RECURSIVE down AS (SELECT $1::text AS id UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
        DELETE FROM owner_task_writers w USING owner_tasks t WHERE w.task_id=t.id AND w.field='closed' AND t.id IN (SELECT id FROM down)
        AND t.state='open' AND t.archived_at IS NULL AND t.deleted_at IS NULL`,[id]);
      if(Object.keys(changes).length)await this.record(db,id,context.actor,context.origin,changes,since);
      if(status&&next==='done'&&opened&&!current.repeated_to&&('repeat' in set?set.repeat:current.repeat))await this.repeat(db,id,settings);
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      if(gate){const preview={...await this.preview(db,id,gate,joining),task_title:current.title};await db.query('ROLLBACK');
        return {held:{...gate,joining,preview,family,revision:null}} satisfies Held;}
      const updated=await this.one(db,id,context);
      await db.query('COMMIT');
      if(effects.removed)await this.removedNotice(id,updated.title,effects.removed);
      // A person's list leaves the owner's reminders, and says so, so the person is not told they are gone.
      return effects.kept?.length?{...updated,reminders_kept:effects.kept,note:OWNER_KEPT}:updated;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  /**
   * Finishing a repeating task makes its next one: the same task, back at the
   * first not-started status, its dates and reminders moved to the next time
   * it repeats, counted from its due day or from today as the repeat says.
   */
  private async repeat(db:pg.PoolClient,id:string,settings:TaskSettings) {
    const task=(await db.query(`SELECT *,to_char(start_on,'YYYY-MM-DD') AS start_day,to_char(due_on,'YYYY-MM-DD') AS due_day FROM owner_tasks WHERE id=$1`,[id])).rows[0];
    const rule=readRepeat(task.repeat)!,today=await this.today(db,settings.time_zone),anchor:string|null=task.due_day??task.start_day;
    const next=nextRepeat(rule.from==='done'||!anchor?today:anchor,rule),shift=anchor?daysBetween(anchor,next):0;
    const move=(value:string|null)=>value&&addDays(value,shift);
    const copy=digest('repeat:'+id),first=this.statusFor(settings,'open',null);
    await db.query(`INSERT INTO owner_tasks(id,title,notes,status_id,state,priority,start_on,start_time,due_on,due_time,repeat,parent_id,position,project_id,group_id,tags,
      properties,external,origin,source_event,created_by,project_since,created_by_account) SELECT $2,title,notes,$3,'open',priority,$4,start_time,$5,due_time,repeat,parent_id,position,project_id,group_id,tags,
      properties,'{}'::jsonb,'repeat',source_event,created_by,CASE WHEN project_id IS NULL THEN NULL ELSE now() END,created_by_account FROM owner_tasks WHERE id=$1 ON CONFLICT(id) DO NOTHING`,[id,copy,first.id,move(task.start_day),anchor?move(task.due_day):next]);
    await db.query('INSERT INTO owner_task_people(task_id,entity_id,role) SELECT $2,entity_id,role FROM owner_task_people WHERE task_id=$1 ON CONFLICT DO NOTHING',[id,copy]);
    await db.query('INSERT INTO owner_task_links(task_id,other_id,kind) SELECT $2,other_id,kind FROM owner_task_links WHERE task_id=$1 AND other_id<>$2 ON CONFLICT DO NOTHING',[id,copy]);
    await db.query('INSERT INTO owner_task_attachments(task_id,position,kind,event_id,url,title) SELECT $2,position,kind,event_id,url,title FROM owner_task_attachments WHERE task_id=$1 ON CONFLICT DO NOTHING',[id,copy]);
    // Each reminder keeps who set it and where; a person's keeps an id of its own (ADR-0255).
    if(anchor)await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id,set_via)
      SELECT encode(sha256(convert_to($2||':'||(remind_at+$3*interval '1 day')::text||CASE WHEN set_by='person' THEN ':'||coalesce(set_by_account_id,'name:'||set_by_name,'') ELSE '' END,'UTF8')),'hex'),$2,
      remind_at+$3*interval '1 day',set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id,set_via FROM owner_task_reminders
      WHERE task_id=$1 AND remind_at+$3*interval '1 day'>now() ON CONFLICT DO NOTHING`,[id,copy,shift]);
    await db.query(`INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id,via,at) SELECT $2,field,by,account_id,name,chat_id,group_id,via,at
      FROM owner_task_writers WHERE task_id=$1 AND field<>'closed' ON CONFLICT DO NOTHING`,[id,copy]);
    await db.query('UPDATE owner_tasks SET repeated_to=$2 WHERE id=$1',[id,copy]);
    await this.record(db,copy,{kind:'nocheh'},'repeat',{repeated_from:id});
  }

  /** People, links, reminders and attachments: each list given replaces the old one, except the reminders a person's
   * list leaves to the owner (ADR-0255). Returns what changed; `effects` gets what the caller tells after it commits. */
  private async attach(db:pg.PoolClient,id:string,patch:Patch,context:Context,fresh:boolean,zone:string,effects:Effects) {
    const changes:Record<string,unknown>={};
    for(const role of ['people','assignees'] as const){
      const chosen=patch[role];if(chosen===undefined)continue;
      const kind=role==='people'?'person':'assignee';
      const before=fresh?[]:(await db.query('SELECT entity_id FROM owner_task_people WHERE task_id=$1 AND role=$2 ORDER BY entity_id',[id,kind])).rows.map(item=>item.entity_id);
      if(canonical(before)===canonical(chosen))continue;
      await this.knownPeople(db,chosen);
      await db.query('DELETE FROM owner_task_people WHERE task_id=$1 AND role=$2',[id,kind]);
      if(chosen.length)await db.query('INSERT INTO owner_task_people(task_id,entity_id,role) SELECT $1,unnest($2::text[]),$3',[id,chosen,kind]);
      changes[role]=true;
    }
    for(const kind of ['blocked_by','related','duplicate_of'] as const){
      const chosen=patch[kind];if(chosen===undefined)continue;
      // A project's chat sees and replaces only the links to tasks on its list; the owner's links to tasks anywhere else
      // stay (ADR-0243).
      const linkedHere=`($3::text IS NULL OR ${seesSql('o.','$3')})`,bound=[context.within];
      const before=fresh?[]:(await db.query(`SELECT l.other_id FROM owner_task_links l JOIN owner_tasks o ON o.id=l.other_id
        WHERE l.task_id=$1 AND l.kind=$2 AND ${linkedHere} ORDER BY l.other_id`,[id,kind,...bound])).rows.map(item=>item.other_id);
      if(canonical(before)===canonical(chosen))continue;
      if(chosen.includes(id))throw new HttpError(400,'invalid_task_links');
      const found=(await db.query('SELECT id,project_id,group_id FROM owner_tasks WHERE id=ANY($1) AND deleted_at IS NULL',[chosen])).rows;
      if(found.length!==chosen.length||found.some(item=>!sees(this.reader(context),item)))throw new HttpError(404,'task_not_found');
      await db.query(`DELETE FROM owner_task_links l USING owner_tasks o WHERE l.task_id=$1 AND l.kind=$2 AND o.id=l.other_id
        AND ${linkedHere}`,[id,kind,...bound]);
      if(chosen.length)await db.query('INSERT INTO owner_task_links(task_id,other_id,kind) SELECT $1,unnest($2::text[]),$3',[id,chosen,kind]);
      changes[kind]=true;
    }
    if(patch.reminders!==undefined){
      const sides=await this.remindersOf(db,id,patch.reminders,context.setter,fresh,zone);
      if(sides.changed)changes.reminders=true;
      if(sides.kept.length)effects.kept=sides.kept;
      if(sides.removed)effects.removed=sides.removed;
    }
    if(patch.attachments!==undefined){
      const before:Attachment[]=fresh?[]:(await db.query('SELECT kind,event_id AS id,url,title FROM owner_task_attachments WHERE task_id=$1 ORDER BY position',[id])).rows
        .map(item=>item.kind==='message'?{kind:'message',id:item.id,title:item.title}:{kind:'link',url:item.url,title:item.title});
      // A project's chat sees and replaces only the links; the archived messages the owner attached stay, and do not
      // count against the chat's 20 links (ADR-0243).
      const after:Attachment[]=context.within?[...before.filter(item=>item.kind==='message'),...patch.attachments]:patch.attachments;
      if(canonical(before)!==canonical(after)){
        await db.query('DELETE FROM owner_task_attachments WHERE task_id=$1',[id]);
        for(const [index,item] of after.entries())await db.query('INSERT INTO owner_task_attachments(task_id,position,kind,event_id,url,title) VALUES($1,$2,$3,$4,$5,$6)',
          [id,index,item.kind,item.kind==='message'?item.id:null,item.kind==='link'?item.url:null,item.title]);
        changes.attachments=true;
      }
    }
    return changes;
  }

  private async discuss(operation:string,id:string,body:Record<string,unknown>,context:Context) {
    if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    const text=body.text===undefined?null:string(body.text,4000).trim(),remove=body.remove===undefined?null:ids([body.remove],'invalid_task_comment',1)[0]!;
    if(!text===!remove)throw new HttpError(400,text===''?'task_comment_required':'invalid_task_comment');
    const hash=digest(canonical({id,text,remove})),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=(await db.query('SELECT request_hash FROM owner_task_operations WHERE operation_id=$1',[operation])).rows[0];
      if(prior&&prior.request_hash!==hash)throw new HttpError(409,'task_operation_conflict');
      const task=(await db.query('SELECT project_id,group_id,project_since,title,revision FROM owner_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!task||!sees(this.reader(context),task))throw new HttpError(404,'task_not_found');
      if(!prior){
        // An approved comment lands only on the task as its card showed it.
        if(context.approved&&context.approved.revision!==null&&Number(task.revision)!==context.approved.revision)throw new HttpError(409,'task_request_changed');
        // A comment on a task in a project's list is seen by the chats that see that task.
        const gate=await this.gate(db,context,task.project_id,task.group_id,!!text);
        if(gate){const preview={...await this.preview(db,id,gate,false),task_title:task.title};await db.query('ROLLBACK');
          return {held:{...gate,joining:false,preview,family:null,revision:Number(task.revision)}} satisfies Held;}
        await this.joined(db,{id,...task});
        if(text)await db.query('INSERT INTO owner_task_comments(id,task_id,body,author,origin,source_event) VALUES($1,$2,$3,$4,$5,$6)',
          [digest('comment:'+operation),id,text,JSON.stringify(context.actor),context.origin,context.source]);
        else if(!(await db.query('DELETE FROM owner_task_comments WHERE id=$1 AND task_id=$2 RETURNING id',[remove,id])).rows.length)throw new HttpError(404,'task_comment_not_found');
        await db.query('UPDATE owner_tasks SET updated_at=now() WHERE id=$1',[id]);
        await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return this.detail(id,context.within);
  }

  /**
   * Send the reminders that are due (ADR-0255, ADR-0265 D9), in three lanes. The owner's own come to the owner's private
   * chat one message each at their time, as before; a person who closed the task no longer silences them: they come
   * saying who closed it. A person's reminder goes to whoever set it (task-reminder-delivery.ts): to a member's own
   * private chat, one message each at its time, saying only "Set by you" (the member lane; the gateway sends it only
   * after core's one-time yes, /internal/notices/authorize); when it cannot reach them, one set in a group comes to the
   * owner as before, merged per group, at most one message per group every 10 minutes, and one set in the members' app
   * is skipped, with a line in System › Health. None is dropped. A send Telegram refuses, or never confirms in 5 tries,
   * ends 'failed' or 'uncertain' with a record in System › Health, and the next one goes on. Returns how many were
   * handled; one waiting for its group's turn counts none, so the worker never spins on them.
   */
  async remind():Promise<number> {
    const owner=this.delivery?.owner();
    if(!this.delivery||!owner)return 0;
    // The owner's reminder on a task that is finished, archived or in the trash needs no reminder, unless a person
    // closed it; then too when its repeat holds the owner's reminder at the same minute, so one time never comes twice.
    let handled=(await this.control.query(`UPDATE owner_task_reminders r SET state='skipped' FROM owner_tasks t WHERE t.id=r.task_id AND r.set_by='owner' AND r.state='pending'
      AND r.remind_at<=now() AND (t.state<>'open' OR t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL)
      AND (NOT EXISTS (SELECT 1 FROM owner_task_writers w WHERE w.task_id=t.id AND w.field='closed' AND w.by='person')
       OR EXISTS (SELECT 1 FROM owner_task_reminders c WHERE c.task_id=t.repeated_to AND c.set_by='owner'
        AND date_trunc('minute',c.remind_at)=date_trunc('minute',r.remind_at)))`)).rowCount??0;
    // A person's reminder is skipped only when its task closed before it came due: waiting for its turn changes nothing.
    handled+=(await this.control.query(`UPDATE owner_task_reminders r SET state='skipped' FROM owner_tasks t WHERE t.id=r.task_id AND r.set_by='person' AND r.state='pending'
      AND r.remind_at<=now() AND (t.state<>'open' AND coalesce(t.done_at,'-infinity')<=r.remind_at OR t.archived_at<=r.remind_at OR t.deleted_at<=r.remind_at)`)).rowCount??0;
    const chats=await currentChats();
    // The owner's private chat where it is in Telegram now (ADR-0252); a chat the directory does not know yet waits.
    let target:{chat_id:string;topic?:number};try{target=telegramTarget(owner,chats);}catch{return handled;}
    let said:Words|null=null;const words=async()=>said??=await this.words();
    // The owner's own, one message each.
    const own=await this.reminderRows(this.control,`r.set_by='owner' AND r.state IN ('pending','sending') AND r.remind_at<=now()`,[],20);
    const ownNames=own.length?await this.names(this.control,chats,own.flatMap(item=>[item.setter,...item.writers])):null;
    for(const item of own){
      const text=reminderText(item,await words(),ownNames!);
      await this.control.query(`UPDATE owner_task_reminders SET state='sending',tries=tries+1 WHERE id=$1 AND state IN ('pending','sending')`,[item.id]);
      const sent=await this.notice(item.id,target,text);
      // Telegram not connected yet: try again on a later pass. Unreachable: the same id goes again on a later pass.
      if(sent.kind==='not_started'){await this.control.query(`UPDATE owner_task_reminders SET state='pending',tries=greatest(tries-1,0) WHERE id=$1`,[item.id]);break;}
      if(sent.kind==='stop')break;
      const state=sent.kind==='done'?'sent':sent.kind==='ambiguous'?'uncertain':sent.kind==='refused'?'failed':item.tries+1>=5?'uncertain':null;
      // A 409 or 500 leaves it sending: the same id goes again, up to 5 tries.
      if(!state)continue;
      await this.control.query(`UPDATE owner_task_reminders SET state=$2,sent_at=CASE WHEN $2::text='failed' THEN NULL ELSE now() END WHERE id=$1`,[item.id,state]);
      if(sent.kind==='refused'||sent.kind==='retry')await this.problem(item.id,target,state==='failed'?'failed':'uncertain',sent.status);
      await this.record(this.control,item.task,{kind:'nocheh'},'reminder',state==='failed'?{reminder_failed:true}:{reminded:true});
      handled++;
    }
    // People's: each due one goes to whoever set it, if it can; the rest wait for the owner's merged messages below.
    // A member's groups count as the members' app counts them: asked of Telegram again first (at most once per member every
    // MEMBER_APP_RECHECK_MINUTES), then only those confirmed within MEMBER_RECHECK_HOURS.
    const call=this.delivery.call,ownerChat=chats.ownerChat();
    const lanes=await memberLane(this.control,{owner:ownerChat,directory:chats,freshHours:MEMBER_RECHECK_HOURS,
      recheck:async member=>{if((await recheckMemberAppGroups(this.control,call,member,{owner:ownerChat})).moved)await reloadMembers();}});
    handled+=await this.skipped(lanes.skipped);
    const member=await this.memberSends(lanes.member);
    handled+=member.handled;
    // Then for the owner: first a merged message whose answer was lost goes again, the same text under the same id.
    let open=!member.stop;
    for(const batch of (await this.control.query(`SELECT id,message,tries FROM owner_task_reminder_batches WHERE state='sending' ORDER BY created_at,id`)).rows){
      await this.control.query('UPDATE owner_task_reminder_batches SET tries=tries+1 WHERE id=$1',[batch.id]);
      const settled=await this.settleBatch(batch.id,await this.notice(batch.id,target,batch.message),Number(batch.tries)+1,target);
      handled+=settled.handled;if(settled.stop){open=false;break;}
    }
    // Then each group whose turn it is, the one waiting longest first, gets one message with as many as fit.
    // Only the reminders routed to the owner in this pass: never one bound for a member's chat, or one set in the app.
    const groups=open&&lanes.owner.length?(await this.control.query(`SELECT r.set_in_group_id AS g,min(r.remind_at) AS first FROM owner_task_reminders r WHERE r.set_by='person'
      AND r.state='pending' AND r.set_via='chat' AND r.id=ANY($1::text[]) AND r.remind_at<=now() AND NOT EXISTS (${busy('r.set_in_group_id')}) GROUP BY 1 ORDER BY first,1 LIMIT 20`,
      [lanes.owner])).rows:[];
    for(const {g} of groups){
      const batch=await this.batch(g,chats,words,lanes.owner).catch(error=>{
        console.warn(JSON.stringify({event:'reminder_batch_failed',code:(error as {code?:string})?.code??'unknown'}));return null;});
      if(!batch)continue;
      const settled=await this.settleBatch(batch.id,await this.notice(batch.id,target,batch.text),1,target);
      handled+=settled.handled;if(settled.stop)break;
    }
    // A merged message is kept a day after it went out, far longer than the turn it holds, so one sent after a long
    // outage still holds it; a refused one, which holds none, a day after it was made.
    await this.control.query(`DELETE FROM owner_task_reminder_batches WHERE state<>'sending' AND coalesce(sent_at,created_at)<now()-interval '1 day'`);
    return handled;
  }
  /** The owner's words for reminders: the reminder lines, the chat words of the approval texts and the template. */
  private async words(db:Pick<pg.Pool,'query'>=this.control):Promise<Words> {
    const prompts=await ownerPrompts(db);
    return {lines:reminderLines(prompts['tasks.reminder_texts']),places:approvalLines(prompts['telegram.approval_texts']),template:prompts['tasks.reminder']??taskReminder};
  }
  /** The words of a member's own reminder (step 5): members.reminder and members.reminder_texts, which the owner edits. */
  private async memberWords(db:Pick<pg.Pool,'query'>=this.control):Promise<MemberWords> {
    const prompts=await ownerPrompts(db);
    return {template:prompts['members.reminder']??memberReminder,lines:memberReminderLines(prompts['members.reminder_texts'])};
  }
  /**
   * The member lane (step 5, ADR-0265 D9): each reminder memberLane routed to its setter's private chat, one message each,
   * at most 20 a pass. A new one is claimed with the chat it goes to and the digest of its exact text, which the gateway's
   * one-time check compares (/internal/notices/authorize); a claim core already authorized goes again as it was, under the
   * same id, so the gateway's receipt answers. Its answer settles it as the owner's own lane does. `stop` when Telegram is
   * not connected or cannot be reached, so the pass ends.
   */
  private async memberSends(sends:readonly MemberSend[]):Promise<{handled:number;stop:boolean}> {
    let handled=0,said:MemberWords|null=null;
    for(const item of sends.slice(0,20)) {
      const row=(await this.reminderRows(this.control,`r.id=$1`,[item.id],1))[0];
      if(!row)continue;
      const text=memberReminderText(row,said??=await this.memberWords());
      let tries:number;
      if(item.resend) {
        const claimed=(await this.control.query(`UPDATE owner_task_reminders SET tries=tries+1 WHERE id=$1 AND state='sending' AND batch_id IS NULL AND deliver_chat=$2
          AND notice_digest IS NULL RETURNING tries`,[item.id,item.chat])).rows[0];
        if(!claimed)continue;
        tries=Number(claimed.tries);
      } else {
        const claimed=(await this.control.query(`UPDATE owner_task_reminders SET state='sending',tries=tries+1,deliver_chat=$2,notice_digest=$3 WHERE id=$1 AND batch_id IS NULL
          AND (state='pending' OR state='sending' AND deliver_chat IS NOT NULL AND notice_digest IS NOT NULL) RETURNING tries`,[item.id,item.chat,noticeDigest(text)])).rows[0];
        if(!claimed)continue;
        tries=Number(claimed.tries);
      }
      const sent=await this.notice(item.id,item.target,text);
      if(sent.kind==='not_started') {
        // Telegram not connected: nothing was asked of core, so a new claim waits again, to be routed afresh.
        if(!item.resend)await this.control.query(`UPDATE owner_task_reminders SET state='pending',tries=greatest(tries-1,0),deliver_chat=NULL,notice_digest=NULL
          WHERE id=$1 AND state='sending' AND notice_digest IS NOT NULL`,[item.id]);
        return {handled,stop:true};
      }
      if(sent.kind==='stop')return {handled,stop:true};
      const state=sent.kind==='done'?'sent':sent.kind==='ambiguous'?'uncertain':sent.kind==='refused'?'failed':tries>=5?'uncertain':null;
      // A 409 or 500 leaves it sending: routed again on the next pass while core has not said yes, else the same id again.
      if(!state)continue;
      await this.control.query(`UPDATE owner_task_reminders SET state=$2,sent_at=CASE WHEN $2::text='failed' THEN NULL ELSE now() END,notice_digest=NULL
        WHERE id=$1 AND state='sending'`,[item.id,state]);
      if(sent.kind==='refused'||sent.kind==='retry')await this.problem(item.id,item.target,state==='failed'?'failed':'uncertain',sent.status);
      await this.record(this.control,row.task,{kind:'nocheh'},'reminder',state==='failed'?{reminder_failed:true}:{reminded:true});
      handled++;
    }
    return {handled,stop:false};
  }
  /** App reminders that could not reach the member who set them (step 5): one System › Health line per member per day,
   * telling the owner how many and why, by the name Telegram showed. Best effort. */
  private async skipped(skips:readonly ReminderSkip[]):Promise<number> {
    let count=0;
    for(const skip of skips) {
      count+=skip.count;
      await this.delivery?.record?.({kind:'notice',chat:null,state:'failed',status:0,error_code:'reminder_skipped',reference:skippedReference(skip.key),
        count:skip.count,detail:skippedLine(skip,name=>{const shown=labelName(name);return shown===null?null:quotedName(shown);})}).catch(()=>{});
    }
    return count;
  }
  /**
   * One group's merged message, made while the group's turn is held: its due people's reminders, at most 200 at a time
   * taken by turns per setter, as many as fit in one message, are marked sending under the message's id, and the
   * message is kept. Null when the turn is no longer free or nothing is due.
   */
  private async batch(group:string,chats:ChatDirectory,words:()=>Promise<Words>,owner:readonly string[]):Promise<{id:string;text:string}|null> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('reminder-batch:'||$1::text,0))`,[group]);
      if((await db.query(`SELECT 1 WHERE EXISTS (${busy('$1::text')})`,[group])).rows.length){await db.query('ROLLBACK');return null;}
      // Only those routed to the owner in this pass (memberLane): a member's own go to them, an app one is never merged.
      const due=(alias:string)=>`${alias}set_by='person' AND ${alias}state='pending' AND ${alias}remind_at<=now() AND ${alias}set_in_group_id=$1
        AND ${alias}set_via='chat' AND ${alias}id=ANY($2::text[])`;
      // The 200 read are chosen by the merge's own turns (whoKeySql), so one person's backlog never keeps another's out;
      // unlocked there, they are locked below with the full condition checked again.
      const fair=`r.id IN (SELECT f.id FROM (SELECT q.id,q.remind_at,row_number() OVER (PARTITION BY ${whoKeySql('q.')} ORDER BY q.remind_at,q.id) AS turn
        FROM owner_task_reminders q WHERE ${due('q.')}) f ORDER BY f.turn,f.remind_at,f.id LIMIT 200)`;
      const rows=await this.reminderRows(db,`${due('r.')} AND ${fair}`,[group,owner],200,' FOR UPDATE OF r SKIP LOCKED');
      if(!rows.length){await db.query('ROLLBACK');return null;}
      const total=Number((await db.query(`SELECT count(*)::int AS count FROM owner_task_reminders r WHERE ${due('r.')}`,[group,owner])).rows[0].count);
      const names=await this.names(db,chats,rows.flatMap(item=>[item.setter,...item.writers]));
      const {text,taken}=mergedReminder(rows,await words(),names,group,Math.max(0,total-rows.length));
      const ids=taken.map(item=>item.id).sort(),id=digest(canonical(['owner-task-reminder-batch-v1',group,...ids]));
      await db.query('INSERT INTO owner_task_reminder_batches(id,group_id,message,tries) VALUES($1,$2,$3,1)',[id,group,text]);
      await db.query(`UPDATE owner_task_reminders SET state='sending',batch_id=$2 WHERE id=ANY($1::text[])`,[ids,id]);
      await db.query('COMMIT');
      return {id,text};
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  /**
   * A merged message's answer: its reminders are sent or unclear for good (never sent again); on its first try, back to
   * waiting when Telegram is not connected, the message gone so it takes no turn; failed when Telegram refused it, with a
   * record; or still sending for the same id again, unclear after 5 tries with a record. A resend Telegram is not
   * connected for stays sending under its id and text: the try whose answer was lost may have gone out. The message,
   * its reminders and their history change together.
   */
  private async settleBatch(id:string,sent:Outcome,tries:number,target:{chat_id:string}):Promise<{handled:number;stop:boolean}> {
    if(sent.kind==='not_started'){
      if(tries>1)await this.control.query('UPDATE owner_task_reminder_batches SET tries=greatest(tries-1,0) WHERE id=$1',[id]);
      else await this.control.query(`WITH b AS (DELETE FROM owner_task_reminder_batches WHERE id=$1 RETURNING id)
        UPDATE owner_task_reminders SET state='pending',batch_id=NULL WHERE batch_id IN (SELECT id FROM b) AND state='sending'`,[id]);
      return {handled:0,stop:true};
    }
    const state=sent.kind==='done'?'sent':sent.kind==='ambiguous'?'uncertain':sent.kind==='refused'?'failed':sent.kind==='retry'&&tries>=5?'uncertain':null;
    if(!state)return {handled:0,stop:sent.kind==='stop'};
    const when=`CASE WHEN $2::text='failed' THEN NULL ELSE now() END`,db=await this.control.connect();
    let rows:{task_id:string}[];
    try {
      await db.query('BEGIN');
      await db.query(`UPDATE owner_task_reminder_batches SET state=$2,sent_at=${when} WHERE id=$1`,[id,state]);
      rows=(await db.query(`UPDATE owner_task_reminders SET state=$2,sent_at=${when} WHERE batch_id=$1 AND state='sending' RETURNING task_id`,[id,state])).rows;
      for(const item of rows)await this.record(db,item.task_id,{kind:'nocheh'},'reminder',state==='failed'?{reminder_failed:true}:{reminded:true});
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
    // A remote record, best effort, once the state it tells of is kept.
    if(sent.kind==='refused'||sent.kind==='retry')await this.problem(id,target,state==='failed'?'failed':'uncertain',sent.status);
    return {handled:rows.length,stop:false};
  }
  /** One reminder notice to the owner, and what its answer means for the reminder. It is sent as a reminder, which memory
   * keeps but does not learn (ADR-0256). */
  private async notice(id:string,target:{chat_id:string;topic?:number},text:string):Promise<Outcome> {
    try {
      const result=await this.delivery!.call('telegram.notice',{id,...target,text,send_class:'reminder'},30000);
      return {kind:result.state==='done'?'done':result.state==='not_started'?'not_started':'ambiguous',status:200};
    } catch(error) {
      if(!(error instanceof HttpError))return {kind:'stop',status:0};
      // Refused before anything was sent (gateway.py's invalid_notice and notice_chat_not_allowed): never tried again.
      if(error.status===400)return {kind:'refused',status:400};
      if((error.status===409||error.status===500)&&error.code!=='runtime_capability_unavailable')return {kind:'retry',status:error.status};
      // Unreachable, rate-limited or not set up: the same id is safe to send again on a later pass (gateway receipts).
      return {kind:'stop',status:error.status};
    }
  }
  /** A reminder Telegram refused or never confirmed, recorded for System › Health. Best effort. */
  private async problem(id:string,target:{chat_id:string},state:'failed'|'uncertain',status:number):Promise<void> {
    await this.delivery?.record?.({kind:'notice',chat:target.chat_id,state,status,error_code:state==='failed'?'reminder_refused':'reminder_unconfirmed',
      reference:'notice:'+id}).catch(()=>{});
  }
  /** Due reminders with what their text needs: the task, its project's name and who last wrote it where. */
  private async reminderRows(db:Pick<pg.Pool,'query'>,where:string,values:unknown[],count:number,lock=''):Promise<(ReminderRow&{task:string;tries:number})[]> {
    const rows=(await db.query(`SELECT r.id,r.task_id,r.remind_at,r.set_by,r.set_by_account_id,r.set_by_name,r.set_in_chat_id,r.set_via,r.tries,
      t.title,t.notes,to_char(t.due_on,'YYYY-MM-DD') AS due_on,to_char(t.due_time,'HH24:MI') AS due_time,p.name AS project,
      (t.state<>'open' OR t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL) AS closed
      FROM owner_task_reminders r JOIN owner_tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE ${where} ORDER BY r.remind_at,r.id LIMIT ${Number(count)}${lock}`,values)).rows;
    const writers=await this.writers(db,[...new Set(rows.map(item=>item.task_id as string))]);
    return rows.map(item=>({id:item.id,at:new Date(item.remind_at).getTime(),setter:whoOf(item.set_by,item.set_by_account_id,item.set_by_name),chat:item.set_in_chat_id??null,via:item.set_via==='app'?'app':'chat',
      title:item.title,notes:item.notes,due:dueWords(item.due_on,item.due_time),list:item.project??null,closed:item.closed===true,writers:writers.get(item.task_id)??[],
      task:item.task_id,tries:Number(item.tries)}));
  }
  /** Who last wrote each task's fields, and where: a chat, or the members' app (no chat, step 5). */
  private async writers(db:Pick<pg.Pool,'query'>,tasks:string[]):Promise<Map<string,Writer[]>> {
    const found=new Map<string,Writer[]>();if(!tasks.length)return found;
    for(const item of (await db.query('SELECT task_id,field,by,account_id,name,chat_id,via FROM owner_task_writers WHERE task_id=ANY($1::text[]) ORDER BY task_id,field',[tasks])).rows){
      const list=found.get(item.task_id)??[];
      list.push({...whoOf(item.by,item.account_id,item.name),field:item.field,chat:item.chat_id??null,via:item.via==='app'?'app':'chat'});found.set(item.task_id,list);
    }
    return found;
  }
  /** What reminder labels read (ADR-0255): the directory, the members who reach a served group now (step 3), and these
   * people and every such member as Telegram last showed them. */
  private names(db:Pick<pg.Pool,'query'>,chats:ChatDirectory,people:Iterable<{account:string|null}>):Promise<Names> {
    return peopleNames(db,chats,this.delivery?.policy?.(),people);
  }
  /**
   * The owner's view of each reminder (ADR-0255): whether the owner or a person set it, and its source, the "Set by"
   * line Telegram shows, when it was set anywhere but the owner's private chat or the dashboard; else null.
   */
  private async sourced<T extends {reminders:any[]}>(tasks:T[],db:Pick<pg.Pool,'query'>=this.control):Promise<T[]> {
    const all=tasks.flatMap(task=>task.reminders),who=(item:any)=>whoOf(item.set_by,item.account,item.name);
    let source:(item:any)=>string|null=()=>null;
    if(all.some(item=>item.set_in||item.via==='app')) {
      const words=await this.words(db),names=await this.names(db,directory(),all.map(who)),keys=nameKeys(names,all.map(who));
      source=item=>setByLine({setter:who(item),chat:item.set_in??null,via:item.via==='app'?'app':'chat'},words,names,keys);
    }
    return tasks.map(task=>({...task,reminders:task.reminders.map((item:any)=>({at:item.at,state:item.state,set_by:item.set_by,source:source(item)}))}));
  }
  /**
   * A reminders list from a setter (ADR-0255). Rows match the listed times by the minute. The owner's list changes any
   * reminder still to come; a person's only those people set, so the owner's stay, and come back as kept when the list
   * leaves them out. A listed minute already sent, unclear, refused or sending stays as it is, so a list read before a
   * reminder went out still saves; one only skipped comes back as the editor's. A new time must be in the future, with a
   * minute's grace. A list holds at most the reminders still to come plus 10, and each editor keeps at most 10 of their
   * own. Reminders set elsewhere that the owner's message in a group removed are returned, for a notice.
   */
  private async remindersOf(db:pg.PoolClient,id:string,listed:string[],setter:Setter,fresh:boolean,zone:string) {
    const minute=(at:string|Date)=>Math.floor(new Date(at).getTime()/60000),owner=setter.by==='owner';
    const app=viaApp(setter);
    const own=(item:any)=>owner?item.set_by==='owner':item.set_by==='person'&&(app?(setter.accounts??[setter.account]).includes(item.set_by_account_id)
      :setter.account?item.set_by_account_id===setter.account:item.set_by_account_id===null&&item.set_by_name===setter.name);
    // The reminders this setter's list is about, as each sees them: the owner where only the owner writes, every one; a
    // member in the members' app, only their own, by any of their accounts (they see the others' only as a count, so
    // another's at the same minute never stands in for theirs); a chat, those set in chats, never a member's private
    // app reminder, which no chat sees (row) and so no chat's list removes or matches (ADR-0265 D6, D9).
    const all=fresh?[]:(await db.query(`SELECT id,remind_at,state,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_via,to_char(remind_at AT TIME ZONE $2,'YYYY-MM-DD HH24:MI') AS local
      FROM owner_task_reminders WHERE task_id=$1 ORDER BY remind_at,id FOR UPDATE`,[id,zone])).rows;
    const rows=ownerHere(setter)?all:app?all.filter(own):all.filter(item=>item.set_via!=='app');
    const times=new Map<number,string>();for(const at of listed)if(!times.has(minute(at)))times.set(minute(at),at);
    const pending=rows.filter(item=>item.state==='pending'),left=(item:any)=>!times.has(minute(item.remind_at));
    const removed=pending.filter(item=>(owner||app||item.set_by==='person')&&left(item));
    const kept=owner?[]:pending.filter(item=>item.set_by==='owner'&&left(item)).map(item=>new Date(item.remind_at).toISOString());
    const added:string[]=[],revived:any[]=[];
    for(const [at,time] of times){
      const same=rows.filter(item=>minute(item.remind_at)===at);
      if(same.some(item=>item.state!=='skipped'))continue;
      if(same.length)revived.push(same[0]);else added.push(time);
    }
    if([...added,...revived.map(item=>item.remind_at)].some(at=>new Date(at).getTime()<Date.now()-60000))throw new HttpError(400,'task_reminder_past');
    // A listed minute already sent, unclear, refused or sending is not counted, so a stale list of any length still saves.
    const done=new Set(rows.filter(item=>!['pending','skipped'].includes(item.state)).map(item=>minute(item.remind_at)));
    if([...times.keys()].filter(at=>!done.has(at)).length>pending.length+10||pending.filter(item=>own(item)&&!removed.includes(item)).length+added.length+revived.length>10)
      throw new HttpError(400,'task_reminder_limit');
    // A member whose "Reminders to themselves" the owner turned off (step 5, ADR-0265 D9) sets none, in a group or in the
    // members' app; removing their own still works.
    if(!owner&&added.length+revived.length&&await this.remindersOff(db,setter))throw new HttpError(403,'task_reminders_off');
    if(removed.length)await db.query('DELETE FROM owner_task_reminders WHERE id=ANY($1::text[])',[removed.map(item=>item.id)]);
    // Where it was set: a chat and its group, or the members' app, with neither (step 5).
    const who=[setter.by,owner?null:setter.account,owner?null:setter.name,app?null:setter.chat,!app&&setter.chat?setter.group??setter.chat:null,app?'app':'chat'];
    for(const at of added)await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id,set_via)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET state='pending',sent_at=NULL,tries=0,batch_id=NULL,deliver_chat=NULL,notice_digest=NULL,set_by=excluded.set_by,
      set_by_account_id=excluded.set_by_account_id,set_by_name=excluded.set_by_name,set_in_chat_id=excluded.set_in_chat_id,set_in_group_id=excluded.set_in_group_id,
      set_via=excluded.set_via WHERE owner_task_reminders.state='skipped'`,[owner?digest(id+':'+at):digest(id+':'+at+':'+(setter.account??'name:'+setter.name)),id,at,...who]);
    if(revived.length)await db.query(`UPDATE owner_task_reminders SET state='pending',sent_at=NULL,tries=0,batch_id=NULL,deliver_chat=NULL,notice_digest=NULL,set_by=$2,
      set_by_account_id=$3,set_by_name=$4,set_in_chat_id=$5,set_in_group_id=$6,set_via=$7 WHERE id=ANY($1::text[]) AND state='skipped'`,[revived.map(item=>item.id),...who]);
    const elsewhere=owner&&setter.chat?removed.filter(item=>item.set_in_chat_id!==setter.chat):[];
    return {changed:removed.length+added.length+revived.length>0,kept,
      removed:elsewhere.length?{chat:setter.chat!,ids:elsewhere.map(item=>item.id as string),times:elsewhere.map(item=>item.local as string)}:null};
  }
  /** Whether a person setting reminders is a member whose "Reminders to themselves" is off (members.reminders, step 5):
   * read in the change's own transaction, from the members row linked to their account. A guest who is no member is not. */
  private async remindersOff(db:pg.PoolClient,setter:Setter):Promise<boolean> {
    if(setter.by!=='person'||!setter.account)return false;
    return (await db.query(`SELECT 1 FROM chat_accounts a JOIN members m ON m.id=a.member_id WHERE a.id=$1 AND NOT m.reminders`,[setter.account])).rows.length>0;
  }
  /** Who last wrote these fields (ADR-0255): a setter anywhere but the owner's private chat or the dashboard is kept; the
   * owner there takes them back. */
  private async written(db:pg.PoolClient,id:string,setter:Setter,fields:string[]) {
    if(!fields.length)return;
    if(ownerHere(setter)){await db.query('DELETE FROM owner_task_writers WHERE task_id=$1 AND field=ANY($2::text[])',[id,fields]);return;}
    await db.query(`INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id,via) SELECT $1,f,$3,$4,$5,$6,$7,$8 FROM unnest($2::text[]) f
      ON CONFLICT(task_id,field) DO UPDATE SET by=excluded.by,account_id=excluded.account_id,name=excluded.name,chat_id=excluded.chat_id,group_id=excluded.group_id,
      via=excluded.via,at=now()`,
      [id,fields,...writerColumns(setter)]);
  }
  /** Everything under a task that is archived or trashed with it was closed by the same setter; run before the sweep.
   * A person closes only those still fully open and never takes an earlier closer's place; the owner takes them all. */
  private async closedFamily(db:pg.PoolClient,id:string,setter:Setter) {
    const down='WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)';
    if(ownerHere(setter)){await db.query(`${down} DELETE FROM owner_task_writers WHERE field='closed' AND task_id IN (SELECT id FROM down)`,[id]);return;}
    if(setter.by==='person'){await db.query(`${down} INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id,via) SELECT t.id,'closed',$2,$3,$4,$5,$6,$7
      FROM owner_tasks t WHERE t.id IN (SELECT id FROM down) AND t.state='open' AND t.archived_at IS NULL AND t.deleted_at IS NULL ON CONFLICT(task_id,field) DO NOTHING`,
      [id,...writerColumns(setter)]);return;}
    await db.query(`${down} INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id,via) SELECT id,'closed',$2,$3,$4,$5,$6,$7 FROM down
      ON CONFLICT(task_id,field) DO UPDATE SET by=excluded.by,account_id=excluded.account_id,name=excluded.name,chat_id=excluded.chat_id,group_id=excluded.group_id,
      via=excluded.via,at=now()`,
      [id,...writerColumns(setter)]);
  }
  /** The owner's message in a group removed reminders set elsewhere (ADR-0255). What others posted there may have steered
   * that turn, so the owner is told once, in their private chat, with the times. Best effort. */
  private async removedNotice(task:string,title:string,removed:{chat:string;ids:string[];times:string[]}) {
    const owner=this.delivery?.owner();if(!this.delivery||!owner)return;
    try {
      const words=await this.words(),text=fillLine(words.lines.removed_in_group,{place:placeLabel(removed.chat,words.places),count:String(removed.ids.length),
        title:quotedName(cardName(title,100)??''),times:removed.times.join(', ')});
      await this.delivery.call('telegram.notice',{id:digest(canonical(['reminders-removed-v1',task,...[...removed.ids].sort()])),...telegramTarget(owner),
        text:wellFormed(unitCut(text,4000))},30000);
    }catch{}
  }

  /** The status a coarse state means: the current one when it already fits, else the first of that kind. */
  private statusFor(settings:TaskSettings,state:TaskState,current:{category:StatusCategory;id:string}|null) {
    const kinds:StatusCategory[]=state==='open'?['not_started','active']:state==='done'?['done']:['cancelled'];
    if(current&&kinds.includes(current.category))return settings.statuses.find(item=>item.id===current.id)!;
    return settings.statuses.find(item=>item.category===kinds[0])!;
  }
  private checkDates(dates:Record<string,string|null|undefined>) {
    if(dates.start_time&&!dates.start_on)throw new HttpError(400,'task_start_time_needs_day');
    if(dates.due_time&&!dates.due_on)throw new HttpError(400,'task_due_time_needs_day');
    if(dates.start_on&&dates.due_on&&dates.start_on>dates.due_on)throw new HttpError(400,'task_start_after_due');
  }
  /** The task a subtask sits under: it exists, is not in the trash, the asking chat sees it, and it is not the task
   * itself or below it. */
  private async parentOf(db:pg.PoolClient,parent:string,self:string|null,context:Context,hold=false) {
    const found=(await db.query(`SELECT id,project_id,group_id FROM owner_tasks WHERE id=$1 AND deleted_at IS NULL${hold?' FOR SHARE':''}`,[parent])).rows[0];
    if(!found||!sees(this.reader(context),found))throw new HttpError(404,'task_not_found');
    if(self&&(await db.query(`WITH RECURSIVE up AS (SELECT id,parent_id FROM owner_tasks WHERE id=$1 UNION SELECT t.id,t.parent_id FROM owner_tasks t JOIN up ON t.id=up.parent_id)
      SELECT 1 FROM up WHERE id=$2`,[parent,self])).rows.length)throw new HttpError(400,'task_parent_cycle');
    return found as {id:string;project_id:string|null;group_id:string|null};
  }
  /** Change every task under a task; returns a digest of which they are and their revisions after the change. */
  private async descendants(db:pg.PoolClient,id:string,assignment:string,values:unknown[]):Promise<string> {
    const changed=(await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
      UPDATE owner_tasks SET ${assignment},revision=revision+1,updated_at=now() WHERE id IN (SELECT id FROM down) RETURNING id,revision`,[id,...values])).rows;
    return digest(canonical(changed.map(item=>[item.id as string,Number(item.revision)] as const).sort((a,b)=>a[0]<b[0]?-1:1)));
  }
  /**
   * A task on a project's list with no joining time, such as one listed before joining times were kept, gets one at
   * its next change or comment: nothing from before shows that project's chats, and what is written from then on does.
   */
  private async joined(db:pg.PoolClient,task:{id:string;project_id:string|null;project_since:unknown}) {
    if(task.project_id&&!task.project_since)await db.query('UPDATE owner_tasks SET project_since=now() WHERE id=$1 AND project_since IS NULL',[task.id]);
  }
  private async record(db:Pick<pg.Pool,'query'>,id:string,actor:TaskActor,origin:string,changes:Record<string,unknown>,at:string|null=null) {
    await db.query('INSERT INTO owner_task_activity(task_id,actor,origin,changes,at) VALUES($1,$2,$3,$4,coalesce($5::timestamptz,now()))',
      [id,JSON.stringify(actor),origin,JSON.stringify(changes),at]);
  }
  /** One task as the asking reader sees it; a project's chat does not find a task no longer on its list, such as one the
   * owner moved to another list since. */
  private async one(db:Pick<pg.Pool,'query'>,id:string,context:{within:string|null}) {
    const view=await this.view(db,context.within),bound=view?[view.project]:[];
    const found=(await db.query(`SELECT ${seenFields(view,'$2')} FROM owner_tasks WHERE id=$1`,[id,...bound])).rows[0];
    if(!found||!sees(view,found))throw new HttpError(404,'task_not_found');
    await this.assigneesSeen(db,[found],view);
    return view?row(found,view):(await this.sourced([row(found,view)],db))[0];
  }
  /** Who reads for a context: the owner, or a project's chat, which reads that project's whole list. */
  private reader(context:{within:string|null}) {
    return context.within?{project:context.within}:null;
  }
  /** How a project's chat reads tasks: that project's whole list, with the columns the owner shares and the project's
   * groups now, which a task's group label shows only as one of (ADR-0276). `settings` saves reading them again. */
  private async view(db:Pick<pg.Pool,'query'>,within:string|null,settings?:TaskSettings):Promise<View> {
    return within?{project:within,shared:sharedColumns(settings??(await this.current(db)).settings),groups:await projectGroupSet(db,within)}:null;
  }
  /**
   * A task as the chats of `audience` would see it, with its related tasks they see and the title of the task it sits
   * under; with `family`, every task under it too, archived and in the trash as well, each after the task it sits under.
   */
  private async preview(db:pg.PoolClient,id:string,audience:{project:string;group:string|null;chats:string[]},family:boolean):Promise<Record<string,unknown>> {
    const view=await this.view(db,audience.project),same=(items:any[])=>items.filter(item=>sees(view,item)).map(item=>seenLink(view,item));
    const select=`SELECT ${fields},${linked('related','other_id','task_id')} AS related_to,${linked('related','task_id','other_id')} AS related_from,
      ${linked('duplicate_of','other_id','task_id')} AS duplicate_of,(SELECT t.title FROM owner_tasks t WHERE t.id=owner_tasks.parent_id) AS parent_title FROM owner_tasks`;
    const seen=(value:any)=>{const {related_to,related_from,...rest}=row(value,view);return {...rest,related:same([...related_to,...related_from]),duplicate_of:same(value.duplicate_of)};};
    const top=(await db.query(`${select} WHERE id=$1`,[id])).rows[0];
    await this.assigneesSeen(db,[top],view);
    const task=seen(top);
    if(!family)return task;
    // Ordered as stored, by the manual position the chats themselves are not shown.
    const under=(await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
      ${select} WHERE id IN (SELECT id FROM down)`,[id])).rows;
    await this.assigneesSeen(db,under,view);
    const order=(parent:string):any[]=>under.filter(item=>item.parent_id===parent)
      .sort((a,b)=>a.position-b.position||new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||(a.id<b.id?-1:1)).flatMap(item=>[seen(item),...order(item.id)]);
    return {...task,descendants:order(id)};
  }
  /**
   * Asked in the owner's private chat, a change that a project's chats would see is held for the owner's card, with
   * the chats that will see the task. The change of an approved card lands only in the list and group it named, and
   * only while the same chats would see it (ADR-0243, ADR-0276).
   */
  private async gate(db:pg.PoolClient,context:Context,project:string|null,group:string|null,seen:boolean):Promise<{project:string;group:string|null;chats:string[]}|null> {
    if(context.approved) {
      if(project!==context.approved.project||group!==context.approved.group||
        canonical(await this.audienceOf(db,project))!==canonical(context.approved.chats))throw new HttpError(409,'task_request_changed');
      return null;
    }
    return context.card&&project&&seen?{project,group,chats:await this.audienceOf(db,project)}:null;
  }
  /**
   * The chats that see a task in a project's list: every group assigned to the project, and the chats added to it
   * later, whatever the task's group (ADR-0276). A group that is not clearly a group sees nothing (ADR-0242).
   */
  private async audienceOf(db:Pick<pg.Pool,'query'>,project:string):Promise<string[]> {
    return (await db.query(`SELECT ${projectChats('$1','$2')} AS chats`,[project,groupSpaces()])).rows[0].chats;
  }

  /** A task can move into an active project only; one already in an archived project stays readable. */
  private async activeProject(db:pg.PoolClient,id:string) {
    const project=(await db.query('SELECT state FROM projects WHERE id=$1',[id])).rows[0];
    if(!project)throw new HttpError(404,'task_project_not_found');
    if(project.state!=='active')throw new HttpError(409,'task_project_archived');
  }

  /** People are linked only while they are active in Memory › People. */
  private async knownPeople(db:pg.PoolClient,list:string[]) {
    if(!list.length)return;
    const found=Number((await db.query(`SELECT count(*)::int AS count FROM memory_entities WHERE id=ANY($1) AND kind='person' AND state='active'`,[list])).rows[0].count);
    if(found!==list.length)throw new HttpError(404,'task_person_not_found');
  }

  /** A repeated operation returns the task's current state; a different request under the same id conflicts. */
  private async replay(db:pg.PoolClient,operation:string,hash:string,context:Context) {
    const prior=(await db.query('SELECT task_id,request_hash FROM owner_task_operations WHERE operation_id=$1',[operation])).rows[0];
    if(!prior)return null;
    if(prior.request_hash!==hash)throw new HttpError(409,'task_operation_conflict');
    return this.one(db,prior.task_id,context);
  }
}
