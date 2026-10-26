import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {fillTemplate,ownerPrompts,taskReminder} from '../prompts.js';
import {limit} from '../retrieval.js';
import type {RuntimeCall} from '../runtime.js';
import {validateSpace} from '../spaces.js';
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
`;

export type TaskState='open'|'done'|'dropped';
type Origin='dashboard'|'chat';
/** Who did something to a task: the owner, someone allowed in a project's chat, or Nocheh itself. */
export type TaskActor={kind:'owner'}|{kind:'member';name?:string}|{kind:'nocheh'};
type Turn={source:{reference:{id:string}};project:string|null;group:string|null;actor?:TaskActor};
type Context={origin:Origin;actor:TaskActor;source:string|null;within:string|null;chat:boolean};
const states=['open','done','dropped'];
const hex=/^[a-f0-9]{64}$/;

const linked=(kind:string,column:string,match:string)=>`coalesce((SELECT json_agg(json_build_object('id',o.id,'title',o.title,'state',o.state,'project_id',o.project_id) ORDER BY o.created_at,o.id)
  FROM owner_task_links l JOIN owner_tasks o ON o.id=l.${column} WHERE l.kind='${kind}' AND l.${match}=owner_tasks.id AND o.deleted_at IS NULL),'[]'::json)`;
const fields=`id,title,notes,status_id AS status,state,priority,to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(start_time,'HH24:MI') AS start_time,
 to_char(due_on,'YYYY-MM-DD') AS due_on,to_char(due_time,'HH24:MI') AS due_time,repeat,repeated_to,parent_id,position,project_id,group_id,tags,properties,external,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='person'),'[]'::json) AS people,
 coalesce((SELECT json_agg(json_build_object('id',e.id,'name',e.name) ORDER BY lower(e.name),e.id) FROM owner_task_people p
  JOIN memory_entities e ON e.id=p.entity_id WHERE p.task_id=owner_tasks.id AND p.role='assignee'),'[]'::json) AS assignees,
 (SELECT json_build_object('open',count(*) FILTER (WHERE c.state='open'),'total',count(*)) FROM owner_tasks c WHERE c.parent_id=owner_tasks.id AND c.deleted_at IS NULL) AS subtasks,
 ${linked('blocked_by','other_id','task_id')} AS blocked_by,
 coalesce((SELECT json_agg(json_build_object('at',r.remind_at,'state',r.state) ORDER BY r.remind_at) FROM owner_task_reminders r WHERE r.task_id=owner_tasks.id),'[]'::json) AS reminders,
 coalesce((SELECT json_agg(json_build_object('kind',a.kind,'id',a.event_id,'url',a.url,'title',a.title) ORDER BY a.position) FROM owner_task_attachments a WHERE a.task_id=owner_tasks.id),'[]'::json) AS attachments,
 (SELECT count(*)::int FROM owner_task_comments c WHERE c.task_id=owner_tasks.id) AS comments,
 origin,source_event,created_by,finished_by,revision,created_at,updated_at,done_at,archived_at,deleted_at`;

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
const attachments=(value:unknown):Attachment[]=>{
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>20)throw new HttpError(400,'invalid_task_attachments');
  return value.map(item=>{
    const body=exact(item,['kind','id','url','title']),label=body.title===undefined||body.title===null?'':string(body.title,200).trim();
    if(body.kind==='message'&&typeof body.id==='string'&&hex.test(body.id)&&body.url===undefined)return {kind:'message',id:body.id,title:label};
    if(body.kind==='link'&&body.id===undefined)return {kind:'link',url:url(body.url),title:label};
    throw new HttpError(400,'invalid_task_attachments');
  });
};
/** Outside IDs, such as a Notion page's, kept for a later sync: a short name to a short ID. */
const external=(value:unknown):Record<string,string>=>{
  const body=object(value),entries=Object.entries(body);
  if(entries.length>10||entries.some(([name,id])=>!/^[a-z][a-z0-9_-]{0,31}$/.test(name)||typeof id!=='string'||!id||id.length>200))throw new HttpError(400,'invalid_task_external');
  return Object.fromEntries(entries.sort(([a],[b])=>a<b?-1:1)) as Record<string,string>;
};
const row=(value:any,within:string|null=null)=>{
  if(!value)return value;
  const visible=(items:any[])=>within?items.filter(item=>item.project_id===within):items;
  return {...value,revision:Number(value.revision),blocked_by:visible(value.blocked_by),reminders:value.reminders.map((item:any)=>({...item,at:new Date(item.at).toISOString()}))};
};

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
 * the owner's private chat reaches every list, a project's chat only its own.
 */
export class TaskRepository {
  /**
   * The live turn asking; project null is the owner's private chat, which
   * reaches every list. A group's turn names its group, which a task added there points to.
   * Reminders go to the owner's private chat through the runtime, when one is given.
   */
  constructor(readonly control:pg.Pool,private chatTurn:(principal:Reader)=>Promise<Turn>,
    private delivery?:{call:RuntimeCall;owner:()=>string|null|undefined}){}

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
   * Assistant reads. The owner's private chat reads any list; a project's chat
   * reads only that project's list and learns of no other list or project.
   */
  async chatList(principal:Reader,input:ListInput={}) {
    const {project}=await this.chatTurn(principal);
    if(project&&input.scope&&input.scope!=='all'&&input.scope!==project)throw new HttpError(403,'task_scope_denied');
    return this.page(project?{...input,scope:project}:input,project);
  }
  async chatGet(principal:Reader,id:string) {const {project}=await this.chatTurn(principal);return this.detail(id,project);}
  /** Repeating the same request within one turn returns the task it already made. */
  async chatCreate(principal:Reader,input:unknown) {
    const turn=await this.chatTurn(principal),{source,project}=turn,body=exact(input,editable);
    if(project&&body.scope!==undefined&&body.scope!==project)throw new HttpError(403,'task_scope_denied');
    const value={...body,...(project?{scope:project}:{}),...(turn.group&&body.group===undefined?{group:turn.group}:{})};
    return this.insert(digest('chat:'+source.reference.id+':'+canonical(value)),value,this.chatContext(turn));
  }
  async chatUpdate(principal:Reader,id:string,input:unknown) {
    const turn=await this.chatTurn(principal),body=exact(input,['expected_revision',...editable,'archived','trashed']);
    if(turn.project&&body.scope!==undefined&&body.scope!==turn.project)throw new HttpError(403,'task_scope_denied');
    return this.change(digest('chat:'+turn.source.reference.id+':'+id+':'+canonical(body)),id,body,this.chatContext(turn));
  }
  async chatComment(principal:Reader,id:string,input:unknown) {
    const turn=await this.chatTurn(principal),body=exact(input,['text']);
    return this.discuss(digest('chat-comment:'+turn.source.reference.id+':'+id+':'+canonical(body)),id,body,this.chatContext(turn));
  }
  private chatContext(turn:Turn):Context {
    return {origin:'chat',actor:turn.actor??{kind:'owner'},source:turn.source.reference.id,within:turn.project,chat:true};
  }

  private async current(db:Pick<pg.Pool,'query'>) {
    const row=(await db.query('SELECT settings,revision FROM owner_task_settings WHERE singleton')).rows[0];
    return {settings:storedTaskSettings(row?.settings),revision:Number(row?.revision??0)};
  }
  /** Today, as a calendar day in the owner's task time zone. */
  private async today(db:Pick<pg.Pool,'query'>,zone:string):Promise<string> {
    return (await db.query(`SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') AS day`,[zone])).rows[0].day;
  }

  private async page(input:ListInput,within:string|null=null) {
    const state=input.state||'open',count=limit(input.limit,100,200),offset=input.after?Number(input.after):0;
    if(state!=='all'&&!states.includes(state))throw new HttpError(400,'invalid_task_state');
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_cursor');
    const place=input.in||'active',when=input.when||'',sort=input.sort||(state==='open'?'due':'finished');
    if(!['active','archive','trash'].includes(place))throw new HttpError(400,'invalid_task_place');
    if(!['','today','upcoming'].includes(when))throw new HttpError(400,'invalid_task_when');
    if(!['due','manual','priority','created','updated','title','finished'].includes(sort))throw new HttpError(400,'invalid_task_sort');
    const {settings}=await this.current(this.control),today=await this.today(this.control,settings.time_zone);
    const values:unknown[]=[],p=(value:unknown)=>{values.push(value);return '$'+values.length;},filters:string[]=['true'];
    // 'all' lists every scope; 'personal' only the owner's own life tasks; a project id only that project.
    const every=!input.scope||input.scope==='all',project=every?null:scope(input.scope);
    if(!every)filters.push(`project_id IS NOT DISTINCT FROM ${p(project)}::text`);
    // A tag matches whatever its case; a group matches its own tasks and those of its topics.
    if(input.tag)filters.push(`lower(${p(tag(input.tag))}::text) IN (SELECT lower(t) FROM unnest(tags) t)`);
    if(input.group){const chat=p(validateSpace(input.group));filters.push(`(group_id=${chat}::text OR starts_with(group_id,${chat}::text||'/topic/'))`);}
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
    const rows=(await this.control.query(`SELECT ${fields} FROM owner_tasks WHERE ${base} AND ${parent} AND ${places[place as keyof typeof places]} AND ${chosen} AND ${window}
      ORDER BY ${orders[sort]} LIMIT ${p(count+1)}::int OFFSET ${p(offset)}::int`,values)).rows;
    // Every list with its open count: personal first, then each active project.
    const open=`count(t.id) FILTER (WHERE t.state='open' AND t.deleted_at IS NULL AND t.archived_at IS NULL)::int AS open`;
    const scopes=within?(await this.control.query(`SELECT p.id,p.name,${open} FROM projects p LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.id=$1 GROUP BY p.id,p.name`,[within])).rows
      :(await this.control.query(`SELECT 'personal' AS id,NULL AS name,${open} FROM (SELECT 1) one LEFT JOIN owner_tasks t ON t.project_id IS NULL
      UNION ALL SELECT * FROM (SELECT p.id,p.name,${open} FROM projects p
        LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.state='active' OR t.id IS NOT NULL GROUP BY p.id,p.name ORDER BY lower(p.name),p.id) listed`)).rows;
    // Tags in use in this list, each once whatever its case, spelled as most recently written.
    const tagged=(await this.control.query(`SELECT (array_agg(t ORDER BY updated_at DESC))[1] AS name,count(*) FILTER (WHERE state='open')::int AS open
      FROM owner_tasks,unnest(tags) t WHERE deleted_at IS NULL AND ($1 OR project_id IS NOT DISTINCT FROM $2) GROUP BY lower(t) ORDER BY lower(t)`,[every,project])).rows;
    return {tasks:rows.slice(0,count).map(value=>row(value,within)),next:rows.length>count?String(offset+count):null,counts,scopes,tags:tagged,settings,today};
  }

  /** One task with its subtasks, links, comments, history and the task it sits under. */
  private async detail(id:string,within:string|null) {
    if(!hex.test(id))throw new HttpError(400,'invalid_identity');
    const task=row((await this.control.query(`SELECT ${fields},${linked('blocked_by','task_id','other_id')} AS blocking,
      ${linked('related','other_id','task_id')} AS related_to,${linked('related','task_id','other_id')} AS related_from,
      ${linked('duplicate_of','other_id','task_id')} AS duplicate_of,${linked('duplicate_of','task_id','other_id')} AS duplicates
      FROM owner_tasks WHERE id=$1`,[id])).rows[0],within);
    // Another list's task is not found from a project's chat, so its existence stays private.
    if(!task||within&&task.project_id!==within)throw new HttpError(404,'task_not_found');
    const visible=(items:any[])=>within?items.filter(item=>item.project_id===within):items;
    const {related_to,related_from,...rest}=task;
    const parent=task.parent_id?(await this.control.query('SELECT id,title,state FROM owner_tasks WHERE id=$1',[task.parent_id])).rows[0]??null:null;
    const subtasks=(await this.control.query(`SELECT ${fields} FROM owner_tasks WHERE parent_id=$1 AND deleted_at IS NULL ORDER BY position,created_at,id`,[id])).rows.map(value=>row(value,within));
    const comments=(await this.control.query('SELECT id,body,author,origin,created_at FROM owner_task_comments WHERE task_id=$1 ORDER BY created_at,id',[id])).rows;
    const activity=(await this.control.query('SELECT id::text,at,actor,origin,changes FROM owner_task_activity WHERE task_id=$1 ORDER BY id DESC LIMIT 100',[id])).rows;
    return {...rest,blocking:visible(task.blocking),related:visible([...related_to,...related_from]),duplicate_of:visible(task.duplicate_of),
      duplicates:visible(task.duplicates),parent,subtasks,comments,activity};
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
    if('group' in body)patch.group_id=group(body.group);
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
    if(body.properties!==undefined)patch.properties=this.properties(body.properties,settings);
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

  /** Values for the owner's own columns, by column ID or name; null clears one. */
  private properties(value:unknown,settings:TaskSettings):Record<string,unknown> {
    const body=object(value),values:Record<string,unknown>={};
    for(const [key,item] of Object.entries(body)){
      const wanted=key.trim().toLocaleLowerCase(),property=settings.properties.find(entry=>entry.id===key||entry.name.toLocaleLowerCase()===wanted);
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
      const prior=await this.replay(db,operation,hash,context.within);if(prior){await db.query('COMMIT');return prior;}
      const status=patch.status_id?settings.statuses.find(item=>item.id===patch.status_id)!:this.statusFor(settings,patch.state??'open',null);
      const parent=patch.parent_id?await this.parentOf(db,patch.parent_id,null,context.within):null;
      if(parent&&patch.project_id!==undefined&&patch.project_id!==parent.project_id)throw new HttpError(400,'task_parent_other_list');
      const project=parent?parent.project_id:patch.project_id??null;
      if(project)await this.activeProject(db,project);
      const id=digest('task:'+operation);
      const position=patch.position??Number((await db.query(`SELECT coalesce(max(position),0)+1 AS next FROM owner_tasks WHERE project_id IS NOT DISTINCT FROM $1
        AND parent_id IS NOT DISTINCT FROM $2`,[project,patch.parent_id??null])).rows[0].next);
      this.checkDates({start_on:patch.start_on??null,start_time:patch.start_time??null,due_on:patch.due_on??null,due_time:patch.due_time??null});
      const finished=status.category==='done'||status.category==='cancelled';
      await db.query(`INSERT INTO owner_tasks(id,title,notes,status_id,state,priority,start_on,start_time,due_on,due_time,repeat,parent_id,position,project_id,group_id,tags,
        properties,external,origin,source_event,created_by,done_at,finished_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,${finished?'now()':'NULL'},$22)`,
        [id,patch.title,patch.notes??'',status.id,stateOf(status.category),patch.priority??0,patch.start_on??null,patch.start_time??null,patch.due_on??null,patch.due_time??null,
          patch.repeat?JSON.stringify(patch.repeat):null,patch.parent_id??null,position,project,patch.group_id??null,patch.tags??[],
          JSON.stringify(Object.fromEntries(Object.entries(patch.properties??{}).filter(([,value])=>value!==null))),JSON.stringify(patch.external??{}),
          context.origin,context.source,JSON.stringify(context.actor),finished?JSON.stringify(context.actor):null]);
      await this.attach(db,id,patch,context,true);
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await this.record(db,id,context.actor,context.origin,{created:true});
      const created=await this.one(db,id,context.within);
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
      const prior=await this.replay(db,operation,hash,context.within);if(prior){await db.query('COMMIT');return prior;}
      const current=(await db.query(`SELECT id,title,notes,status_id,state,priority,to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(start_time,'HH24:MI') AS start_time,
        to_char(due_on,'YYYY-MM-DD') AS due_on,to_char(due_time,'HH24:MI') AS due_time,repeat,repeated_to,parent_id,position,project_id,group_id,tags,properties,
        archived_at,deleted_at,revision FROM owner_tasks WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      // Another list's task is not found from a project's chat, so its existence stays private.
      if(!current||context.within&&current.project_id!==context.within)throw new HttpError(404,'task_not_found');
      if(Number(current.revision)!==Number(body.expected_revision))throw new HttpError(409,'task_revision_conflict');
      if(current.deleted_at&&patch.trashed!==false&&Object.keys(patch).some(key=>key!=='trashed'))throw new HttpError(409,'task_in_trash');
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
      if(patch.group_id!==undefined)scalar('group_id',patch.group_id);
      if(patch.tags!==undefined)scalar('tags',patch.tags,false);
      if(patch.external!==undefined)scalar('external',patch.external,false);
      if(patch.properties!==undefined){
        const merged={...current.properties};for(const [key,value] of Object.entries(patch.properties))if(value===null)delete merged[key];else merged[key]=value;
        scalar('properties',merged,false);
      }
      // A subtask stays in its parent's list; moving a task moves everything under it.
      const parentId=patch.parent_id!==undefined?patch.parent_id:current.parent_id,newParent=patch.parent_id!==undefined&&patch.parent_id!==current.parent_id;
      const parentProject=!parentId?null:(newParent?await this.parentOf(db,parentId,id,context.within)
        :(await db.query('SELECT project_id FROM owner_tasks WHERE id=$1',[parentId])).rows[0]??{project_id:null}).project_id;
      if(patch.parent_id!==undefined)scalar('parent_id',patch.parent_id);
      // An explicit list wins; a new parent brings its own list; otherwise the list stays.
      const project:string|null=patch.project_id!==undefined?patch.project_id:newParent&&parentId?parentProject:current.project_id;
      if(parentId&&project!==parentProject)throw new HttpError(400,'task_parent_other_list');
      if(project!==current.project_id){if(project)await this.activeProject(db,project);scalar('project_id',project);}
      const dates={start_on:'start_on' in set?set.start_on:current.start_on,start_time:'start_time' in set?set.start_time:current.start_time,
        due_on:'due_on' in set?set.due_on:current.due_on,due_time:'due_time' in set?set.due_time:current.due_time} as Record<string,string|null>;
      this.checkDates(dates);
      const category=(status??now).category,opened=stateOf(now.category)==='open',next=stateOf(category);
      const columns=Object.entries(set),values:unknown[]=[id];
      const assignments=columns.map(([column,value])=>{values.push(['repeat','properties','external'].includes(column)?(value===null?null:JSON.stringify(value)):value);return `${column}=$${values.length}`;});
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
      if('project_id' in set)await this.descendants(db,id,'project_id=$2',[project]);
      if(changes.archived)await this.descendants(db,id,`archived_at=${patch.archived?'now()':'NULL'}`,[]);
      if(changes.trashed)await this.descendants(db,id,`deleted_at=${patch.trashed?'now()':'NULL'}`,[]);
      if(Object.keys(changes).length)await this.record(db,id,context.actor,context.origin,changes);
      if(status&&next==='done'&&opened&&!current.repeated_to&&('repeat' in set?set.repeat:current.repeat))await this.repeat(db,id,settings);
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      const updated=await this.one(db,id,context.within);
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
      properties,external,origin,source_event,created_by) SELECT $2,title,notes,$3,'open',priority,$4,start_time,$5,due_time,repeat,parent_id,position,project_id,group_id,tags,
      properties,'{}'::jsonb,'repeat',source_event,created_by FROM owner_tasks WHERE id=$1 ON CONFLICT(id) DO NOTHING`,[id,copy,first.id,move(task.start_day),anchor?move(task.due_day):next]);
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
      const before=fresh?[]:(await db.query('SELECT other_id FROM owner_task_links WHERE task_id=$1 AND kind=$2 ORDER BY other_id',[id,kind])).rows.map(item=>item.other_id);
      if(canonical(before)===canonical(chosen))continue;
      if(chosen.includes(id))throw new HttpError(400,'invalid_task_links');
      const found=(await db.query('SELECT id,project_id FROM owner_tasks WHERE id=ANY($1) AND deleted_at IS NULL',[chosen])).rows;
      if(found.length!==chosen.length||context.within&&found.some(item=>item.project_id!==context.within))throw new HttpError(404,'task_not_found');
      await db.query('DELETE FROM owner_task_links WHERE task_id=$1 AND kind=$2',[id,kind]);
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
      const before=fresh?[]:(await db.query('SELECT kind,event_id AS id,url,title FROM owner_task_attachments WHERE task_id=$1 ORDER BY position',[id])).rows
        .map(item=>item.kind==='message'?{kind:item.kind,id:item.id,title:item.title}:{kind:item.kind,url:item.url,title:item.title});
      if(canonical(before)!==canonical(patch.attachments)){
        await db.query('DELETE FROM owner_task_attachments WHERE task_id=$1',[id]);
        for(const [index,item] of patch.attachments.entries())await db.query('INSERT INTO owner_task_attachments(task_id,position,kind,event_id,url,title) VALUES($1,$2,$3,$4,$5,$6)',
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
      const task=(await db.query('SELECT project_id FROM owner_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!task||context.within&&task.project_id!==context.within)throw new HttpError(404,'task_not_found');
      if(!prior){
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
  /** The task a subtask sits under: it exists, is not in the trash, and is not the task itself or below it. */
  private async parentOf(db:pg.PoolClient,parent:string,self:string|null,within:string|null) {
    const found=(await db.query('SELECT id,project_id FROM owner_tasks WHERE id=$1 AND deleted_at IS NULL',[parent])).rows[0];
    if(!found||within&&found.project_id!==within)throw new HttpError(404,'task_not_found');
    if(self&&(await db.query(`WITH RECURSIVE up AS (SELECT id,parent_id FROM owner_tasks WHERE id=$1 UNION SELECT t.id,t.parent_id FROM owner_tasks t JOIN up ON t.id=up.parent_id)
      SELECT 1 FROM up WHERE id=$2`,[parent,self])).rows.length)throw new HttpError(400,'task_parent_cycle');
    return found as {id:string;project_id:string|null};
  }
  private async descendants(db:pg.PoolClient,id:string,assignment:string,values:unknown[]) {
    await db.query(`WITH RECURSIVE down AS (SELECT id FROM owner_tasks WHERE parent_id=$1 UNION SELECT t.id FROM owner_tasks t JOIN down ON t.parent_id=down.id)
      UPDATE owner_tasks SET ${assignment},revision=revision+1,updated_at=now() WHERE id IN (SELECT id FROM down)`,[id,...values]);
  }
  private async record(db:Pick<pg.Pool,'query'>,id:string,actor:TaskActor,origin:string,changes:Record<string,unknown>) {
    await db.query('INSERT INTO owner_task_activity(task_id,actor,origin,changes) VALUES($1,$2,$3,$4)',[id,JSON.stringify(actor),origin,JSON.stringify(changes)]);
  }
  private async one(db:Pick<pg.Pool,'query'>,id:string,within:string|null) {
    return row((await db.query(`SELECT ${fields} FROM owner_tasks WHERE id=$1`,[id])).rows[0],within);
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
  private async replay(db:pg.PoolClient,operation:string,hash:string,within:string|null) {
    const prior=(await db.query('SELECT task_id,request_hash FROM owner_task_operations WHERE operation_id=$1',[operation])).rows[0];
    if(!prior)return null;
    if(prior.request_hash!==hash)throw new HttpError(409,'task_operation_conflict');
    return this.one(db,prior.task_id,within);
  }
}
