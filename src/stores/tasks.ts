import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {fillTemplate,ownerPrompts,taskReminder} from '../prompts.js';
import {limit} from '../retrieval.js';
import type {RuntimeCall} from '../runtime.js';
import {groupChatId,groupSpace,groupSpaceSql,inReadSet,parentSpace,readSet,readSetOf,readSetParam,readSetSql,recallScope,validateSpace,type ReadSet} from '../spaces.js';
import {addDays,daysBetween,nextRepeat,readRepeat,readTaskSettings,stateOf,storedTaskSettings,type StatusCategory,type TaskSettings} from './task-settings.js';

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
 origin text NOT NULL CHECK(origin IN ('dashboard','chat','repeat')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 created_by jsonb NOT NULL DEFAULT '{"kind":"owner"}'::jsonb,finished_by jsonb,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),done_at timestamptz,
 archived_at timestamptz,deleted_at timestamptz,
 CHECK(start_time IS NULL OR start_on IS NOT NULL),CHECK(due_time IS NULL OR due_on IS NOT NULL),CHECK(parent_id<>id)
);
-- When a task joined its current audience, its project's list and its group in it: the chats that see it see its
-- comments and history only from then (ADR-0243, ADR-0247).
ALTER TABLE owner_tasks ADD COLUMN IF NOT EXISTS project_since timestamptz;
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
CREATE TABLE IF NOT EXISTS owner_task_comments (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 author jsonb NOT NULL,origin text NOT NULL CHECK(origin IN ('dashboard','chat')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_task_comments_task ON owner_task_comments(task_id,created_at);
-- What changed on a task, by whom and from where.
CREATE TABLE IF NOT EXISTS owner_task_activity (
 id bigserial PRIMARY KEY,
 task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 at timestamptz NOT NULL DEFAULT now(),actor jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('dashboard','chat','repeat','reminder')),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object')
);
CREATE INDEX IF NOT EXISTS owner_task_activity_task ON owner_task_activity(task_id,id DESC);
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
-- The group the task would belong to: null for a task set on the project itself, which every chat of the project
-- sees; otherwise only that group sees it, and the card names only that group (ADR-0247).
ALTER TABLE owner_task_requests ADD COLUMN IF NOT EXISTS group_id text;
`;

export type TaskState='open'|'done'|'dropped';
type Origin='dashboard'|'chat';
/** Who did something to a task: the owner, someone allowed in a project's chat, or Nocheh itself. */
export type TaskActor={kind:'owner'}|{kind:'member';name?:string}|{kind:'nocheh'};
export type TopicMemory='group'|'topic';
/**
 * The live turn asking. `project` null is the owner's private chat, which reaches every list. A group or topic turn
 * names its project, its own conversation (`group`, which a task added there belongs to) and what it reads
 * (`reach`): its own group, with its topics when they share memory. An "Answer privately" answer reads the groups
 * frozen in its record and changes nothing (`readOnly`) (ADR-0247).
 */
type Turn={source:{reference:{id:string}};project:string|null;group:string|null;reach?:ReadSet|null;readOnly?:boolean;actor?:TaskActor};
/** `card`: asked in the owner's private chat, so a change a project's chats would see waits for the owner's card.
 * `approved`: the card the owner approved; its change lands only in the list, and before the chats, the card named,
 * and only while the tasks under a moved task, and a commented task, are as the card showed them. */
type Approved={project:string;group:string|null;chats:string[];family:string|null;revision:number|null};
/** `reach`: in a project's chat (`within`), the groups and topics whose tasks that chat sees besides the tasks set on
 * the project itself. */
type Context={origin:Origin;actor:TaskActor;source:string|null;within:string|null;reach?:ReadSet|null;chat:boolean;card?:boolean;approved?:Approved};
/** Who reads a task: the owner (null), or a project's chat, which sees, in that project's list, the tasks set on the
 * project itself and those of the groups and topics it reaches (`reach`; null reaches none), with the columns the
 * owner shares (ADR-0247). */
type View={project:string;shared:Set<string>;reach:ReadSet|null}|null;
/** A change held for the owner's card instead of written: the list it lands in, the group in it (null: the project
 * itself), the chats that will see the task, whether the task joins them, the task as those chats would see it, the
 * tasks that move with it (`family`) and the revision of a task commented on. */
type Held={held:{project:string;group:string|null;chats:string[];joining:boolean;preview:Record<string,unknown>;family:string|null;revision:number|null}};
const states=['open','done','dropped'];
const hex=/^[a-f0-9]{64}$/;
/** The chats that see a project's list: the groups and topics assigned to it. Anything that is not clearly a group (a
 * negative Telegram chat ID) or a topic of one counts as private and is left out, by the same test as groupSpace, so the
 * chats a card names are the chats that read the list (ADR-0243). */
const projectChats=(project:string)=>`(SELECT coalesce(array_agg(a.space_id ORDER BY a.space_id),'{}'::text[]) FROM project_assignments a
  WHERE a.project_id=${project} AND a.mode='assigned' AND ${groupSpaceSql('a.space_id')})`;
/**
 * Fields a change asked in the owner's private chat may set on a task in a project's list without a card: its status,
 * priority, start and due days and times, archive and trash, and the list it is already in. This is the recommended
 * default of the Members plan, pending the owner's confirmation (TASK.md). Any other field, such as repeat or
 * reminders, a move into a project's list, and a comment wait for the owner's card.
 */
const direct=new Set(['expected_revision','status','state','priority','start_on','start_time','due_on','due_time','archived','trashed','scope']);
/**
 * Whether a reader sees a task (ADR-0247): the owner sees every task; a project's chat sees, in that project's list
 * only, the tasks set on the project itself (no group) and the tasks of the groups and topics it reaches, never another
 * group's. A group that is not clearly a group or topic is never reached (ADR-0242).
 */
const sees=(view:{project:string;reach:ReadSet|null}|null,task:{project_id:string|null;group_id:string|null}):boolean=>
  !view||task.project_id===view.project&&(task.group_id===null||!!view.reach&&inReadSet(view.reach,task.group_id));
/** The same test in SQL on the task columns prefixed `alias`, with the project and readSetParam of the reach bound as
 * the placeholders `project` and `reach`. */
const seesSql=(alias:string,project:string,reach:string)=>
  `(${alias}project_id=${project}::text AND (${alias}group_id IS NULL OR ${readSetSql(alias+'group_id',reach)}))`;
/** A reach as the one SQL parameter seesSql takes; no reach is an empty set, which matches no group. */
const reachParam=(reach:ReadSet|null|undefined)=>reach?readSetParam(reach):[];
/** Whether a reader sees a group or topic named on a task or in its history. */
const seesGroup=(reach:ReadSet|null,space:unknown):space is string=>typeof space==='string'&&!!reach&&inReadSet(reach,space);

const linked=(kind:string,column:string,match:string)=>`coalesce((SELECT json_agg(json_build_object('id',o.id,'title',o.title,'state',o.state,'project_id',o.project_id,'group_id',o.group_id) ORDER BY o.created_at,o.id)
  FROM owner_task_links l JOIN owner_tasks o ON o.id=l.${column} WHERE l.kind='${kind}' AND l.${match}=owner_tasks.id AND o.deleted_at IS NULL),'[]'::json)`;
/** A task's columns; `children` is the SQL condition, on the alias `c`, of the subtasks its counts take: a project's
 * chat counts only the subtasks it sees (ADR-0247). */
const columns=(children='true')=>`id,title,notes,status_id AS status,state,priority,to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(start_time,'HH24:MI') AS start_time,
 to_char(due_on,'YYYY-MM-DD') AS due_on,to_char(due_time,'HH24:MI') AS due_time,repeat,repeated_to,parent_id,position,project_id,project_since,group_id,tags,properties,external,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='person'),'[]'::json) AS people,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='assignee'),'[]'::json) AS assignees,
 (SELECT json_build_object('open',count(*) FILTER (WHERE c.state='open'),'total',count(*)) FROM owner_tasks c WHERE c.parent_id=owner_tasks.id AND c.deleted_at IS NULL AND ${children}) AS subtasks,
 ${linked('blocked_by','other_id','task_id')} AS blocked_by,
 coalesce((SELECT json_agg(json_build_object('at',r.remind_at,'state',r.state) ORDER BY r.remind_at) FROM owner_task_reminders r WHERE r.task_id=owner_tasks.id),'[]'::json) AS reminders,
 coalesce((SELECT json_agg(json_build_object('kind',a.kind,'id',a.event_id,'url',a.url,'title',a.title) ORDER BY a.position) FROM owner_task_attachments a WHERE a.task_id=owner_tasks.id),'[]'::json) AS attachments,
 (SELECT count(*)::int FROM owner_task_comments c WHERE c.task_id=owner_tasks.id) AS comments,
 (SELECT count(*)::int FROM owner_task_comments c WHERE c.task_id=owner_tasks.id AND c.created_at>=coalesce(owner_tasks.project_since,'infinity'::timestamptz)) AS project_comments,
 coalesce(created_at>=project_since,false) AS made_on_list,coalesce(done_at>=project_since,false) AS finished_on_list,
 origin,source_event,created_by,finished_by,revision,created_at,updated_at,done_at,archived_at,deleted_at`;
const fields=columns();
/** A task's columns as a project's chat reads them, with the project and reach bound as `project` and `reach`. */
const seenFields=(view:View,project:string,reach:string)=>view?columns(seesSql('c.',project,reach)):fields;

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
 * A task as its reader sees it. A project's chat sees it only as it is on that project's board: never its outside IDs
 * or the message that asked for it, no archived message attached to it, only the columns the owner shares with project
 * chats, only reminders still to come, links only to tasks it sees, only the comments made since it joined its
 * current audience, its group only when that chat reaches it, and who made or finished it only when that happened
 * there. A project's task with no joining time shows none of these (ADR-0243, ADR-0247).
 */
const row=(value:any,view:View=null)=>{
  if(!value)return value;
  const {project_comments,made_on_list,finished_on_list,...task}=value,reminders=task.reminders.map((item:any)=>({...item,at:new Date(item.at).toISOString()}));
  if(!view)return {...task,revision:Number(task.revision),reminders};
  const {external:_external,source_event:_source,...seen}=task;
  return {...seen,revision:Number(task.revision),comments:project_comments,blocked_by:task.blocked_by.filter((item:any)=>sees(view,item)),
    reminders:reminders.filter((item:any)=>item.state==='pending'),attachments:task.attachments.filter((item:any)=>item.kind==='link'),
    properties:Object.fromEntries(Object.entries(task.properties).filter(([id])=>view.shared.has(id))),
    group_id:seesGroup(view.reach,task.group_id)?task.group_id:null,created_by:made_on_list?task.created_by:null,
    finished_by:finished_on_list?task.finished_by:null};
};
/** The change that brought a task into a project's list, as that project's chats see it: where each field went, never
 * where it came from, such as its earlier list, parent or title. */
const arrived=(changes:Record<string,unknown>)=>Object.fromEntries(Object.entries(changes).map(([key,value])=>
  [key,value&&typeof value==='object'&&!Array.isArray(value)&&'to' in value?{to:(value as {to:unknown}).to}:value]));
/** A history entry as a project's chat sees it: the change that brought the task to its current audience, a change of
 * its list or of its group, shows only where it went, and a group or topic that chat does not reach shows as none
 * (ADR-0243, ADR-0247). */
const boardChange=(changes:Record<string,unknown>,reach:ReadSet|null)=>{
  const shown='project_id' in changes||'group_id' in changes?arrived(changes):changes,group=shown.group_id;
  if(!group||typeof group!=='object')return shown;
  return {...shown,group_id:Object.fromEntries(Object.entries(group).map(([side,space])=>[side,seesGroup(reach,space)?space:null]))};
};
/** A repeat in words, as a card shows it: "every 2 weeks on Mon, Thu, from when it is done". */
const repeatWords=(repeat:{every:number;unit:string;weekdays?:number[];from:string})=>
  `every ${repeat.every} ${repeat.unit}${repeat.every===1?'':'s'}${repeat.weekdays?.length?' on '+repeat.weekdays.map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', '):''}`+
  (repeat.from==='done'?', from when it is done':'');
/** The columns the owner shares with project chats. */
const sharedColumns=(settings:TaskSettings)=>new Set(settings.properties.filter(item=>item.shared).map(item=>item.id));

type ListInput={state?:string;scope?:string;tag?:string;group?:string;person?:string;status?:string;priority?:string;parent?:string;
  in?:string;when?:string;sort?:string;q?:string;after?:string;limit?:string|null};
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
 * only its own group's tasks and the tasks set on the project itself, and sees
 * each task only as it is on that project's board. A change asked in the
 * owner's private chat that a project's chats would see waits for the owner's
 * card, which names them (ADR-0243, ADR-0247).
 */
export class TaskRepository {
  /**
   * The live turn asking; project null is the owner's private chat, which
   * reaches every list. A group's turn names its group, which a task added there belongs to.
   * Reminders go to the owner's private chat through the runtime, when one is given.
   * `topicMemory` is whether a group's topics share what they know, as they share its tasks.
   */
  constructor(readonly control:pg.Pool,private chatTurn:(principal:Reader)=>Promise<Turn>,
    private delivery?:{call:RuntimeCall;owner:()=>string|null|undefined},private topicMemory:()=>TopicMemory=()=>'group'){}

  async list(principal:Reader,input:ListInput={}) {admin(principal);return this.page(input);}
  async get(principal:Reader,id:string) {admin(principal);return this.detail(id,null);}
  async create(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id',...editable,'position','external']);
    return this.insert(string(body.operation_id,200),body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false});
  }
  async update(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','expected_revision',...editable,'position','external','archived','trashed']);
    return this.change(string(body.operation_id,200),id,body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false});
  }
  /** Add a comment, or remove one by its ID. */
  async comment(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','text','remove']);
    return this.discuss(string(body.operation_id,200),id,body,{origin:'dashboard',actor:{kind:'owner'},source:null,within:null,chat:false});
  }
  /** Delete a task for good; only one already in the trash, and its subtasks with it. */
  async remove(principal:Reader,id:string) {
    admin(principal);if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    if(!(await this.control.query('DELETE FROM owner_tasks WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id',[id])).rows.length)
      throw (await this.control.query('SELECT 1 FROM owner_tasks WHERE id=$1',[id])).rows.length?new HttpError(409,'task_not_in_trash'):new HttpError(404,'task_not_found');
    return {deleted:id};
  }
  /** Archive every finished or dropped task in a list, or in all lists. */
  async archiveFinished(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','scope']),every=body.scope===undefined||body.scope==='all',project=every?null:scope(body.scope);
    const archived=(await this.control.query(`UPDATE owner_tasks SET archived_at=now(),revision=revision+1,updated_at=now()
      WHERE state<>'open' AND archived_at IS NULL AND deleted_at IS NULL AND ($1 OR project_id IS NOT DISTINCT FROM $2) RETURNING id`,[every,project])).rows;
    for(const task of archived)await this.record(this.control,task.id,{kind:'owner'},'dashboard',{archived:{from:false,to:true}});
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

  /**
   * Assistant reads. The owner's private chat reads any list; a group or topic
   * in a project reads only its own group's tasks and the tasks set on the
   * project itself, learns of no other group's task, list or project, and sees
   * each task only from when it joined its current audience (ADR-0247).
   */
  async chatList(principal:Reader,input:ListInput={}) {
    const {project,reach}=await this.chatTurn(principal);
    if(project&&input.scope&&input.scope!=='all'&&input.scope!==project)throw new HttpError(403,'task_scope_denied');
    return this.page(project?{...input,scope:project}:input,project,reach??null);
  }
  async chatGet(principal:Reader,id:string) {const {project,reach}=await this.chatTurn(principal);return this.detail(id,project,reach??null);}
  /**
   * Repeating the same request within one turn returns the task it already made. In the owner's private chat, a
   * change that a project's chats would see is held for the owner's card instead (ADR-0243). A task added in a
   * group belongs to that group or topic unless it names another group it reaches, the project itself (group null)
   * or a parent, whose group a subtask takes (ADR-0247).
   */
  async chatCreate(principal:Reader,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),{source,project}=turn,body=exact(input,editable);
    if(project&&body.scope!==undefined&&body.scope!==project)throw new HttpError(403,'task_scope_denied');
    const value={...body,...(project?{scope:project}:{}),...(turn.group&&body.group===undefined&&body.parent===undefined?{group:turn.group}:{})};
    const operation=digest('chat:'+source.reference.id+':'+canonical(value));
    return this.held(turn,'add',null,operation,value,await this.insert(operation,value,this.chatContext(turn)));
  }
  async chatUpdate(principal:Reader,id:string,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),body=exact(input,['expected_revision',...editable,'archived','trashed']);
    if(turn.project&&body.scope!==undefined&&body.scope!==turn.project)throw new HttpError(403,'task_scope_denied');
    const operation=digest('chat:'+turn.source.reference.id+':'+id+':'+canonical(body));
    return this.held(turn,'update',id,operation,body,await this.change(operation,id,body,this.chatContext(turn)));
  }
  async chatComment(principal:Reader,id:string,input:unknown) {
    const turn=this.writable(await this.chatTurn(principal)),body=exact(input,['text']);
    const operation=digest('chat-comment:'+turn.source.reference.id+':'+id+':'+canonical(body));
    return this.held(turn,'comment',id,operation,body,await this.discuss(operation,id,body,this.chatContext(turn)));
  }
  /** An "Answer privately" answer only reads its groups' tasks; it adds, changes and comments on none (ADR-0247). */
  private writable(turn:Turn):Turn {
    if(turn.readOnly)throw new HttpError(403,'task_read_only');
    return turn;
  }
  private chatContext(turn:Turn):Context {
    return {origin:'chat',actor:turn.actor??{kind:'owner'},source:turn.source.reference.id,within:turn.project,reach:turn.reach??null,chat:true,card:turn.project===null};
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
   * `audience` is 'project' for a task set on the project itself, which every chat of the project sees, chats added
   * later included, and 'group' for a group's task, which only that group sees; `group` names that group, or null
   * (ADR-0247).
   */
  async request(principal:Reader,id:string,space:(chat:string)=>Promise<string>) {
    admin(principal);
    const row=(await this.control.query('SELECT r.*,p.name AS project_name FROM owner_task_requests r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');
    const {settings}=await this.current(this.control),preview=row.preview,body=row.body as Record<string,unknown>;
    const names=(items:{name?:string;title?:string}[]|undefined)=>items?.length?items.map(item=>item.name??item.title??''):null;
    const at=(on:string|null,time:string|null)=>on?on+(time?' '+time:''):null;
    const shared=settings.properties.filter(item=>item.shared);
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
        ['Tags',['tags'],()=>task.tags?.length?task.tags:null],['Group',['group'],async()=>task.group_id?await space(task.group_id):null],
        ['People',['people'],()=>names(task.people)],['Assigned to',['assignees'],()=>names(task.assignees)],
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
    const hidden=(Array.isArray(body.attachments)&&body.attachments.some((item:any)=>item?.kind==='message'))||
      (body.properties&&typeof body.properties==='object'&&Object.keys(body.properties as object).some(key=>!shared.some(item=>item.id===key||item.name.toLocaleLowerCase()===key.trim().toLocaleLowerCase())));
    const moving=row.action==='update'&&row.joining,grouped=row.group_id!==null&&row.group_id!==undefined;
    // A move to a group says which group it goes to.
    const moved=moving?(grouped?(family.length?'move_group_family':'move_group'):(family.length?'move_family':'move')):null;
    return {id:row.id,state:row.state as string,fingerprint:row.fingerprint as string,source_reference:row.source_reference,chats:row.chats as string[],
      change:(row.action==='add'?'add':row.action==='comment'?'comment':moved??'change') as 'add'|'move'|'move_family'|'move_group'|'move_group_family'|'change'|'comment',
      project:row.project_name as string|null,group:grouped?row.group_id as string:null,audience:(grouped?'group':'project') as 'group'|'project',subtasks:family.length,
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
        const context:Context={origin:'chat',actor:{kind:'owner'},source:String(row.source_reference?.id??'')||null,within:null,chat:true,
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

  private async current(db:Pick<pg.Pool,'query'>) {
    const row=(await db.query('SELECT settings,revision FROM owner_task_settings WHERE singleton')).rows[0];
    return {settings:storedTaskSettings(row?.settings),revision:Number(row?.revision??0)};
  }
  /** Today, as a calendar day in the owner's task time zone. */
  private async today(db:Pick<pg.Pool,'query'>,zone:string):Promise<string> {
    return (await db.query(`SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') AS day`,[zone])).rows[0].day;
  }

  private async page(input:ListInput,within:string|null=null,reach:ReadSet|null=null) {
    const state=input.state||'open',count=limit(input.limit,100,200),offset=input.after?Number(input.after):0;
    if(state!=='all'&&!states.includes(state))throw new HttpError(400,'invalid_task_state');
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_cursor');
    const place=input.in||'active',when=input.when||'',sort=input.sort||(state==='open'?'due':'finished');
    if(!['active','archive','trash'].includes(place))throw new HttpError(400,'invalid_task_place');
    if(!['','today','upcoming'].includes(when))throw new HttpError(400,'invalid_task_when');
    if(!['due','manual','priority','created','updated','title','finished'].includes(sort))throw new HttpError(400,'invalid_task_sort');
    const {settings}=await this.current(this.control),today=await this.today(this.control,settings.time_zone);
    const view:View=within?{project:within,shared:sharedColumns(settings),reach}:null;
    const values:unknown[]=[],p=(value:unknown)=>{values.push(value);return '$'+values.length;},filters:string[]=['true'];
    // 'all' lists every scope; 'personal' only the owner's own life tasks; a project id only that project.
    const every=!input.scope||input.scope==='all',project=every?null:scope(input.scope);
    if(!every)filters.push(`project_id IS NOT DISTINCT FROM ${p(project)}::text`);
    // A project's chat lists only the tasks set on the project itself and those of the groups and topics it reaches,
    // and every count it gets counts only those (ADR-0247).
    const seen=view?{project:p(view.project),reach:p(reachParam(view.reach))}:null;
    if(seen)filters.push(seesSql('',seen.project,seen.reach));
    // A tag matches whatever its case; a group matches its own tasks and those of its topics.
    if(input.tag)filters.push(`lower(${p(tag(input.tag))}::text) IN (SELECT lower(t) FROM unnest(tags) t)`);
    // A project's chat finds tasks only by a group or topic it reaches, as it sees no other group on them.
    if(input.group){const space=validateSpace(input.group);
      if(view&&!seesGroup(view.reach,space))filters.push('false');
      else {const chat=p(space);filters.push(`(group_id=${chat}::text OR starts_with(group_id,${chat}::text||'/topic/'))`);}}
    if(input.person)filters.push(`EXISTS (SELECT 1 FROM owner_task_people x WHERE x.task_id=owner_tasks.id AND x.entity_id=${p(ids([input.person],'invalid_task_people')[0])}::text)`);
    if(input.status){if(!settings.statuses.some(item=>item.id===input.status))throw new HttpError(400,'invalid_task_status');filters.push(`status_id=${p(input.status)}::text`);}
    if(input.priority){const level=Number(input.priority);if(!Number.isSafeInteger(level)||level<0||level>4)throw new HttpError(400,'invalid_task_priority');filters.push(`priority=${p(level)}::int`);}
    let parent='true';
    if(input.parent==='top')parent='parent_id IS NULL';
    else if(input.parent){if(!hex.test(input.parent))throw new HttpError(400,'invalid_task_parent');parent=`parent_id=${p(input.parent)}::text`;}
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
    const live=places.active,top=`parent_id IS NULL AND ${places.active}`;
    const counts=(await this.control.query(`SELECT count(*) FILTER (WHERE ${top} AND state='open')::int AS open,count(*) FILTER (WHERE ${top} AND state='done')::int AS done,
      count(*) FILTER (WHERE ${top} AND state='dropped')::int AS dropped,count(*) FILTER (WHERE ${live} AND state='open' AND ${isToday})::int AS today,
      count(*) FILTER (WHERE ${live} AND state='open' AND ${isUpcoming})::int AS upcoming,count(*) FILTER (WHERE parent_id IS NULL AND ${places.archive})::int AS archive,
      count(*) FILTER (WHERE parent_id IS NULL AND ${places.trash})::int AS trash FROM owner_tasks WHERE ${base}`,values.slice())).rows[0];
    const chosen=state==='all'?'true':`state=${p(state)}::text`;
    const rows=(await this.control.query(`SELECT ${seen?seenFields(view,seen.project,seen.reach):fields} FROM owner_tasks WHERE ${base} AND ${parent} AND ${places[place as keyof typeof places]} AND ${chosen} AND ${window}
      ORDER BY ${orders[sort]} LIMIT ${p(count+1)}::int OFFSET ${p(offset)}::int`,values)).rows;
    // Every list with its open count: personal first, then each active project with the chats that see its list. A
    // project's chat counts only the tasks it sees.
    const open=`count(t.id) FILTER (WHERE t.state='open' AND t.deleted_at IS NULL AND t.archived_at IS NULL)::int AS open`;
    const scopes=view?(await this.control.query(`SELECT p.id,p.name,${open} FROM projects p LEFT JOIN owner_tasks t ON ${seesSql('t.','p.id','$2')} WHERE p.id=$1 GROUP BY p.id,p.name`,
      [view.project,reachParam(view.reach)])).rows
      :(await this.control.query(`SELECT 'personal' AS id,NULL AS name,${open},'{}'::text[] AS chats FROM (SELECT 1) one LEFT JOIN owner_tasks t ON t.project_id IS NULL
      UNION ALL SELECT * FROM (SELECT p.id,p.name,${open},${projectChats('p.id')} AS chats FROM projects p
        LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.state='active' OR t.id IS NOT NULL GROUP BY p.id,p.name ORDER BY lower(p.name),p.id) listed`)).rows;
    // Tags in use in this list, each once whatever its case, spelled as most recently written; a project's chat learns
    // only the tags of the tasks it sees.
    const tagged=(await this.control.query(`SELECT (array_agg(t ORDER BY updated_at DESC))[1] AS name,count(*) FILTER (WHERE state='open')::int AS open
      FROM owner_tasks,unnest(tags) t WHERE deleted_at IS NULL AND ($1 OR project_id IS NOT DISTINCT FROM $2) AND ${view?seesSql('','$3','$4'):'$3::text IS NULL AND $4::text[] IS NULL'}
      GROUP BY lower(t) ORDER BY lower(t)`,[every,project,view?.project??null,view?reachParam(view.reach):null])).rows;
    // A project's chat learns the names of the shared columns only.
    return {tasks:rows.slice(0,count).map(value=>row(value,view)),next:rows.length>count?String(offset+count):null,counts,scopes,tags:tagged,
      settings:view?{...settings,properties:settings.properties.filter(item=>item.shared)}:settings,today};
  }

  /** One task with its subtasks, links, comments, history and the task it sits under. */
  private async detail(id:string,within:string|null,reach:ReadSet|null=null) {
    if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    // A project's chat binds its project and reach as $2 and $3 to every query that reads tasks.
    const view=await this.view(this.control,within,reach),bound=view?[view.project,reachParam(view.reach)]:[];
    const found=(await this.control.query(`SELECT ${seenFields(view,'$2','$3')},${linked('blocked_by','task_id','other_id')} AS blocking,
      ${linked('related','other_id','task_id')} AS related_to,${linked('related','task_id','other_id')} AS related_from,
      ${linked('duplicate_of','other_id','task_id')} AS duplicate_of,${linked('duplicate_of','task_id','other_id')} AS duplicates
      FROM owner_tasks WHERE id=$1`,[id,...bound])).rows[0];
    // Another list's task, or another group's in the same list, is not found from a project's chat, so its existence
    // stays private (ADR-0247).
    if(!found||!sees(view,found))throw new HttpError(404,'task_not_found');
    const task=row(found,view),visible=(items:any[])=>items.filter(item=>sees(view,item));
    const {related_to,related_from,...rest}=task;
    const seenHere=view?seesSql('','$2','$3'):'true';
    const parent=task.parent_id?(await this.control.query(`SELECT id,title,state FROM owner_tasks WHERE id=$1 AND ${seenHere}`,[task.parent_id,...bound])).rows[0]??null:null;
    const subtasks=(await this.control.query(`SELECT ${seenFields(view,'$2','$3')} FROM owner_tasks WHERE parent_id=$1 AND deleted_at IS NULL AND ${seenHere}
      ORDER BY position,created_at,id`,[id,...bound])).rows.map(value=>row(value,view));
    // A project's chat sees comments and history only from when the task joined its current audience, the change that
    // brought it there shows only where it went, and a group that chat does not reach shows as none (ADR-0243, ADR-0247).
    const since=`($2::boolean OR %s>=coalesce((SELECT project_since FROM owner_tasks WHERE id=$1),'infinity'::timestamptz))`;
    const comments=(await this.control.query(`SELECT id,body,author,origin,created_at FROM owner_task_comments WHERE task_id=$1 AND ${since.replace('%s','created_at')} ORDER BY created_at,id`,[id,!within])).rows;
    const activity=(await this.control.query(`SELECT id::text,at,actor,origin,changes FROM owner_task_activity WHERE task_id=$1 AND ${since.replace('%s','at')} ORDER BY id DESC LIMIT 100`,[id,!within])).rows
      .map(item=>view?{...item,changes:boardChange(item.changes,view.reach)}:item);
    // The owner learns how many tasks sit under it at every level, archived and in the trash too: a move takes them all.
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
      // A project's chat sets only a group or topic it reaches, or none: the project itself (ADR-0247).
      if(context.within&&patch.group_id!==null&&!seesGroup(context.reach??null,patch.group_id))throw new HttpError(403,'task_group_denied');
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
      if(!Array.isArray(body.reminders)||body.reminders.length>10)throw new HttpError(400,'invalid_task_reminders');
      const moments=new Set<string>();
      for(const item of body.reminders){
        const text=string(item,40);
        if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(text))throw new HttpError(400,'invalid_task_reminder');
        // A time without an offset is a wall-clock time in the owner's task time zone.
        const at=await this.control.query(`SELECT (CASE WHEN $1 ~ '(Z|[+-]\\d{2}:?\\d{2})$' THEN $1::timestamptz ELSE $1::timestamp AT TIME ZONE $2 END) AS at`,[text,settings.time_zone])
          .then(result=>new Date(result.rows[0].at).toISOString(),()=>{throw new HttpError(400,'invalid_task_reminder');});
        moments.add(at);
      }
      patch.reminders=[...moments].sort();
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
      // A subtask belongs to its parent's group, as it sits in its parent's list (ADR-0247).
      if(parent&&patch.group_id!==undefined&&patch.group_id!==parent.group_id)throw new HttpError(400,'task_parent_other_group');
      const project=parent?parent.project_id:patch.project_id??null,grouped=parent?parent.group_id:patch.group_id??null;
      if(project)await this.activeProject(db,project);
      // A new task in a project's list is seen by the chats that will see it there.
      const gate=await this.gate(db,context,project,grouped,true);
      const id=digest('task:'+operation);
      const position=patch.position??Number((await db.query(`SELECT coalesce(max(position),0)+1 AS next FROM owner_tasks WHERE project_id IS NOT DISTINCT FROM $1
        AND parent_id IS NOT DISTINCT FROM $2`,[project,patch.parent_id??null])).rows[0].next);
      this.checkDates({start_on:patch.start_on??null,start_time:patch.start_time??null,due_on:patch.due_on??null,due_time:patch.due_time??null});
      const finished=status.category==='done'||status.category==='cancelled';
      await db.query(`INSERT INTO owner_tasks(id,title,notes,status_id,state,priority,start_on,start_time,due_on,due_time,repeat,parent_id,position,project_id,group_id,tags,
        properties,external,origin,source_event,created_by,done_at,finished_by,project_since)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,${finished?'now()':'NULL'},$22,CASE WHEN $14::text IS NULL THEN NULL ELSE now() END)`,
        [id,patch.title,patch.notes??'',status.id,stateOf(status.category),patch.priority??0,patch.start_on??null,patch.start_time??null,patch.due_on??null,patch.due_time??null,
          patch.repeat?JSON.stringify(patch.repeat):null,patch.parent_id??null,position,project,grouped,patch.tags??[],
          JSON.stringify(Object.fromEntries(Object.entries(patch.properties??{}).filter(([,value])=>value!==null))),JSON.stringify(patch.external??{}),
          context.origin,context.source,JSON.stringify(context.actor),finished?JSON.stringify(context.actor):null]);
      await this.attach(db,id,patch,context,true);
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
      // Another list's task, or another group's, is not found from a project's chat, so its existence stays private.
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
      // A subtask stays in its parent's list and group; moving a task moves everything under it.
      const parentId=patch.parent_id!==undefined?patch.parent_id:current.parent_id,newParent=patch.parent_id!==undefined&&patch.parent_id!==current.parent_id;
      const parentTask=!parentId?null:newParent?await this.parentOf(db,parentId,id,context)
        :(await db.query('SELECT project_id,group_id FROM owner_tasks WHERE id=$1',[parentId])).rows[0]??{project_id:null,group_id:null};
      if(patch.parent_id!==undefined)scalar('parent_id',patch.parent_id);
      // An explicit list or group wins; a new parent brings its own list and group; otherwise they stay.
      const project:string|null=patch.project_id!==undefined?patch.project_id:newParent&&parentTask?parentTask.project_id:current.project_id;
      const grouped:string|null=patch.group_id!==undefined?patch.group_id:newParent&&parentTask?parentTask.group_id:current.group_id;
      if(parentTask&&project!==parentTask.project_id)throw new HttpError(400,'task_parent_other_list');
      if(parentTask&&(patch.group_id!==undefined||newParent)&&grouped!==parentTask.group_id)throw new HttpError(400,'task_parent_other_group');
      if(project!==current.project_id){if(project)await this.activeProject(db,project);scalar('project_id',project);}
      scalar('group_id',grouped);
      // A change of list or of group gives the task a new audience. Everything under it moves with it. They are all
      // locked before the joining time is read, so nothing written to any of them before the move counts as written
      // for the new audience (ADR-0243, ADR-0247).
      const moving='project_id' in set||'group_id' in set;
      let since:string|null=null;
      if(moving){
        await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
          SELECT id FROM owner_tasks WHERE id IN (SELECT id FROM down) ORDER BY id FOR UPDATE`,[id]);
        if(project)since=(await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      }
      // A task that joins a project's list or a group in it, or a change to one already there beyond its status,
      // priority, dates, archive and trash, is seen by the chats that see it there.
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
      const sides=await this.attach(db,id,patch,context,false);
      Object.assign(changes,sides);
      // An edit that changes nothing leaves the task and its revision as they were.
      if(assignments.length||Object.keys(sides).length)
        await db.query(`UPDATE owner_tasks SET ${[...assignments,'revision=revision+1','updated_at=now()'].join(',')} WHERE id=$1`,values);
      const family=moving?await this.descendants(db,id,'project_id=$2,group_id=$3,project_since=$4::timestamptz',[project,grouped,since]):null;
      // An approved move takes exactly the tasks under it that its card showed, as the card showed them.
      if(context.approved&&context.approved.family!==family)throw new HttpError(409,'task_request_changed');
      if(changes.archived)await this.descendants(db,id,`archived_at=${patch.archived?'now()':'NULL'}`,[]);
      if(changes.trashed)await this.descendants(db,id,`deleted_at=${patch.trashed?'now()':'NULL'}`,[]);
      // The change that brings a task into a list or a group is the first thing its chats see of it.
      if(Object.keys(changes).length)await this.record(db,id,context.actor,context.origin,changes,since);
      if(status&&next==='done'&&opened&&!current.repeated_to&&('repeat' in set?set.repeat:current.repeat))await this.repeat(db,id,settings);
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      if(gate){const preview={...await this.preview(db,id,gate,joining),task_title:current.title};await db.query('ROLLBACK');
        return {held:{...gate,joining,preview,family,revision:null}} satisfies Held;}
      const updated=await this.one(db,id,context);
      await db.query('COMMIT');return updated;
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
      properties,external,origin,source_event,created_by,project_since) SELECT $2,title,notes,$3,'open',priority,$4,start_time,$5,due_time,repeat,parent_id,position,project_id,group_id,tags,
      properties,'{}'::jsonb,'repeat',source_event,created_by,CASE WHEN project_id IS NULL THEN NULL ELSE now() END FROM owner_tasks WHERE id=$1 ON CONFLICT(id) DO NOTHING`,[id,copy,first.id,move(task.start_day),anchor?move(task.due_day):next]);
    await db.query('INSERT INTO owner_task_people(task_id,entity_id,role) SELECT $2,entity_id,role FROM owner_task_people WHERE task_id=$1 ON CONFLICT DO NOTHING',[id,copy]);
    await db.query('INSERT INTO owner_task_links(task_id,other_id,kind) SELECT $2,other_id,kind FROM owner_task_links WHERE task_id=$1 AND other_id<>$2 ON CONFLICT DO NOTHING',[id,copy]);
    await db.query('INSERT INTO owner_task_attachments(task_id,position,kind,event_id,url,title) SELECT $2,position,kind,event_id,url,title FROM owner_task_attachments WHERE task_id=$1 ON CONFLICT DO NOTHING',[id,copy]);
    if(anchor)await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at) SELECT encode(sha256(convert_to($2||':'||(remind_at+$3*interval '1 day')::text,'UTF8')),'hex'),$2,
      remind_at+$3*interval '1 day' FROM owner_task_reminders WHERE task_id=$1 AND remind_at+$3*interval '1 day'>now() ON CONFLICT DO NOTHING`,[id,copy,shift]);
    await db.query('UPDATE owner_tasks SET repeated_to=$2 WHERE id=$1',[id,copy]);
    await this.record(db,copy,{kind:'nocheh'},'repeat',{repeated_from:id});
  }

  /** People, links, reminders and attachments: each list given replaces the old one. Returns what changed. */
  private async attach(db:pg.PoolClient,id:string,patch:Patch,context:Context,fresh:boolean) {
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
      // A project's chat sees and replaces only the links to tasks it sees; the owner's links to tasks anywhere else,
      // another group's included, stay (ADR-0243, ADR-0247).
      const linkedHere=`($3::text IS NULL OR ${seesSql('o.','$3','$4')})`,bound=[context.within,reachParam(context.reach)];
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
      // The reminders list is the ones still to come; reminders already sent stay as history.
      const before=fresh?[]:(await db.query(`SELECT remind_at FROM owner_task_reminders WHERE task_id=$1 AND state='pending' ORDER BY remind_at`,[id])).rows.map(item=>new Date(item.remind_at).toISOString());
      if(canonical(before)!==canonical(patch.reminders)){
        const now=Date.now();
        if(patch.reminders.some(at=>!before.includes(at)&&Date.parse(at)<now-60000))throw new HttpError(400,'task_reminder_past');
        await db.query(`DELETE FROM owner_task_reminders WHERE task_id=$1 AND state='pending'`,[id]);
        for(const at of patch.reminders)await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at) VALUES($1,$2,$3)
          ON CONFLICT(id) DO UPDATE SET state='pending',sent_at=NULL WHERE owner_task_reminders.state='skipped'`,[digest(id+':'+at),id,at]);
        changes.reminders=true;
      }
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
    return this.detail(id,context.within,context.reach??null);
  }

  /** Send the reminders that are due to the owner's private chat. Returns how many were handled. */
  async remind():Promise<number> {
    const owner=this.delivery?.owner();
    if(!this.delivery||!owner)return 0;
    // A task that is finished, archived or in the trash needs no reminder.
    let handled=(await this.control.query(`UPDATE owner_task_reminders r SET state='skipped' FROM owner_tasks t WHERE t.id=r.task_id AND r.state='pending'
      AND r.remind_at<=now() AND (t.state<>'open' OR t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL)`)).rowCount??0;
    const due=(await this.control.query(`SELECT r.id,r.task_id,t.title,t.notes,to_char(t.due_on,'YYYY-MM-DD') AS due_on,
      to_char(t.due_time,'HH24:MI') AS due_time,p.name AS project FROM owner_task_reminders r JOIN owner_tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE r.state IN ('pending','sending') AND r.remind_at<=now() ORDER BY r.remind_at,r.id LIMIT 20`)).rows;
    if(!due.length)return handled;
    const template=(await ownerPrompts(this.control))['tasks.reminder']??taskReminder;
    for(const item of due){
      await this.control.query(`UPDATE owner_task_reminders SET state='sending' WHERE id=$1 AND state='pending'`,[item.id]);
      const when=item.due_on?new Date(item.due_on+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})+(item.due_time?', '+item.due_time:''):null;
      const text=fillTemplate(template,{title:item.title,due:when,list:item.project,notes:item.notes?item.notes.slice(0,500):null}).slice(0,4000);
      let result:Record<string,unknown>;
      try{result=await this.delivery.call('telegram.notice',{id:item.id,chat_id:owner,text},30000);}catch{return handled;}
      // Telegram not connected yet: try again on a later pass. An unclear send is never repeated.
      if(result.state==='not_started'){await this.control.query(`UPDATE owner_task_reminders SET state='pending' WHERE id=$1`,[item.id]);return handled;}
      await this.control.query(`UPDATE owner_task_reminders SET state=$2,sent_at=now() WHERE id=$1`,[item.id,result.state==='done'?'sent':'uncertain']);
      await this.record(this.control,item.task_id,{kind:'nocheh'},'reminder',{reminded:true});
      handled++;
    }
    return handled;
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
  /** One task as the asking reader sees it; a project's chat does not find a task it no longer sees, such as one the
   * owner moved to another group since (ADR-0247). */
  private async one(db:Pick<pg.Pool,'query'>,id:string,context:{within:string|null;reach?:ReadSet|null}) {
    const view=await this.view(db,context.within,context.reach??null),bound=view?[view.project,reachParam(view.reach)]:[];
    const found=(await db.query(`SELECT ${seenFields(view,'$2','$3')} FROM owner_tasks WHERE id=$1`,[id,...bound])).rows[0];
    if(!found||!sees(view,found))throw new HttpError(404,'task_not_found');
    return row(found,view);
  }
  /** Who reads for a context: the owner, or a project's chat with the groups and topics it reaches. */
  private reader(context:{within:string|null;reach?:ReadSet|null}) {
    return context.within?{project:context.within,reach:context.reach??null}:null;
  }
  /** How a project's chat reads tasks: in that project's list, the tasks set on the project itself and those of the
   * groups and topics it reaches, with the columns the owner shares. */
  private async view(db:Pick<pg.Pool,'query'>,within:string|null,reach:ReadSet|null):Promise<View> {
    return within?{project:within,shared:sharedColumns((await this.current(db)).settings),reach}:null;
  }
  /**
   * What the chats a card names read: a group's task is read by that group as its turns read it; a task set on the
   * project itself by every chat of the project, so the card shows the most any of them sees (ADR-0247).
   */
  private reachOf(project:string,group:string|null,chats:string[]):ReadSet|null {
    const memory=this.topicMemory(),named=chats.filter(groupSpace);
    if(group!==null)return groupSpace(group)?readSetOf(recallScope(group,memory),project):null;
    if(!named.length)return null;
    return readSet({home:named[0]!,project,...(memory==='group'?{whole:named.map(chat=>parentSpace(chat)??chat)}:{exact:named})});
  }
  /**
   * A task as the chats of `audience` would see it, with its related tasks they see and the title of the task it sits
   * under; with `family`, every task under it too, archived and in the trash as well, each after the task it sits under.
   */
  private async preview(db:pg.PoolClient,id:string,audience:{project:string;group:string|null;chats:string[]},family:boolean):Promise<Record<string,unknown>> {
    const view=await this.view(db,audience.project,this.reachOf(audience.project,audience.group,audience.chats)),same=(items:any[])=>items.filter(item=>sees(view,item));
    const select=`SELECT ${fields},${linked('related','other_id','task_id')} AS related_to,${linked('related','task_id','other_id')} AS related_from,
      ${linked('duplicate_of','other_id','task_id')} AS duplicate_of,(SELECT t.title FROM owner_tasks t WHERE t.id=owner_tasks.parent_id) AS parent_title FROM owner_tasks`;
    const seen=(value:any)=>{const {related_to,related_from,...rest}=row(value,view);return {...rest,related:same([...related_to,...related_from]),duplicate_of:same(value.duplicate_of)};};
    const task=seen((await db.query(`${select} WHERE id=$1`,[id])).rows[0]);
    if(!family)return task;
    const under=(await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
      ${select} WHERE id IN (SELECT id FROM down)`,[id])).rows.map(seen);
    const order=(parent:string):any[]=>under.filter(item=>item.parent_id===parent)
      .sort((a,b)=>a.position-b.position||new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||(a.id<b.id?-1:1)).flatMap(item=>[item,...order(item.id)]);
    return {...task,descendants:order(id)};
  }
  /**
   * Asked in the owner's private chat, a change that a project's chats would see is held for the owner's card, with
   * the chats that will see the task. The change of an approved card lands only in the list and group it named, and
   * only while the same chats would see it (ADR-0243, ADR-0247).
   */
  private async gate(db:pg.PoolClient,context:Context,project:string|null,group:string|null,seen:boolean):Promise<{project:string;group:string|null;chats:string[]}|null> {
    if(context.approved) {
      if(project!==context.approved.project||group!==context.approved.group||
        canonical(await this.audienceOf(db,project,group))!==canonical(context.approved.chats))throw new HttpError(409,'task_request_changed');
      return null;
    }
    return context.card&&project&&seen?{project,group,chats:await this.audienceOf(db,project,group)}:null;
  }
  /**
   * The chats that see a task in a project's list (ADR-0247). A task set on the project itself (no group) is seen by
   * every group and topic assigned to the project, and by the chats added to it later. A group's task is seen only by
   * the chats of that group that are in the project: when topics share what they know, the group's chat (and so the
   * topics that follow it) and each of its topics assigned to the project on its own; else only the task's own chat
   * or topic, while it is in the project. A group that is not clearly a group sees nothing (ADR-0242).
   */
  private async audienceOf(db:Pick<pg.Pool,'query'>,project:string,group:string|null):Promise<string[]> {
    if(group===null)return (await db.query(`SELECT ${projectChats('$1')} AS chats`,[project])).rows[0].chats;
    const chat=parentSpace(group)??group;
    if(!groupSpace(group)||!groupChatId(chat))return [];
    const rows:{space_id:string;project_id:string|null;mode:string}[]=(await db.query(`SELECT space_id,project_id,mode FROM project_assignments
      WHERE space_id=$1 OR starts_with(space_id,$1||'/topic/') ORDER BY space_id`,[chat])).rows;
    // A chat's own row decides, unless it follows its group; a topic with no row of its own follows its group.
    const own=(space:string)=>rows.find(row=>row.space_id===space&&row.mode!=='inherit');
    const inProject=(space:string)=>{const row=own(space)??(space===chat?undefined:own(chat));return row?.mode==='assigned'&&row.project_id===project;};
    if(this.topicMemory()==='topic')return inProject(group)?[group]:[];
    return rows.filter(row=>row.mode==='assigned'&&row.project_id===project).map(row=>row.space_id);
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
