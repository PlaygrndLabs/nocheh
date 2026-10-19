import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {limit} from '../retrieval.js';

export const taskSchema=`
CREATE TABLE IF NOT EXISTS owner_tasks (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','done','dropped')),
 due_on date,
 project_id text REFERENCES projects(id),
 domain text NOT NULL DEFAULT '' CHECK(length(domain)<=40),
 origin text NOT NULL CHECK(origin IN ('dashboard','chat')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),done_at timestamptz
);
-- Added when missing on a list made before tasks had a scope and a domain.
ALTER TABLE owner_tasks ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
ALTER TABLE owner_tasks ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT '' CHECK(length(domain)<=40);
CREATE INDEX IF NOT EXISTS owner_tasks_listing ON owner_tasks(state,due_on,created_at);
CREATE INDEX IF NOT EXISTS owner_tasks_scope ON owner_tasks(project_id,state);
CREATE TABLE IF NOT EXISTS owner_task_operations (
 operation_id text PRIMARY KEY,task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;
export type TaskState='open'|'done'|'dropped';
type Origin='dashboard'|'chat';
const states=['open','done','dropped'];
const fields="id,title,notes,state,to_char(due_on,'YYYY-MM-DD') AS due_on,project_id,domain,origin,source_event,revision,created_at,updated_at,done_at";
const exact=(input:unknown,keys:string[])=>{const body=object(input);if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_task_field');return body;};
const title=(value:unknown)=>{const text=string(value,300).trim();if(!text)throw new HttpError(400,'task_title_required');return text;};
const notes=(value:unknown)=>value===undefined?'':string(value,4000).trim();
/** A calendar day (YYYY-MM-DD), so it means the same day wherever the owner is; null clears it. */
const due=(value:unknown):string|null=>{
  if(value===null||value===undefined||value==='')return null;
  const text=string(value,40),date=new Date(text+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==text)throw new HttpError(400,'invalid_task_due');
  return text;
};
/** A short label such as Health or Money; empty means none. */
const domain=(value:unknown):string=>value===undefined||value===null?'':string(value,200).trim().replace(/\s+/g,' ').slice(0,40);
/** Personal tasks have no project; a project's tasks form that project's own list. */
const scope=(value:unknown):string|null=>{
  if(value===undefined||value===null||value===''||value==='personal')return null;
  const text=string(value,64);if(!/^[a-f0-9]{64}$/.test(text))throw new HttpError(400,'invalid_task_scope');return text;
};
const row=(value:any)=>({...value,revision:Number(value.revision)});
type ListInput={state?:string;scope?:string;domain?:string;after?:string;limit?:string|null};

/**
 * The owner's own task list in the control store. The dashboard edits it as the
 * owner; the assistant reaches it only from a current live owner-private turn.
 */
export class TaskRepository {
  /** The live turn asking; project null is the owner's private chat, which reaches every list. */
  constructor(readonly control:pg.Pool,private chatTurn:(principal:Reader)=>Promise<{source:{reference:{id:string}};project:string|null}>){}

  async list(principal:Reader,input:ListInput={}) {
    admin(principal);return this.page(input);
  }
  async create(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','title','notes','due_on','scope','domain']);
    return this.insert(string(body.operation_id,200),body,'dashboard',null);
  }
  async update(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','expected_revision','title','notes','due_on','state','scope','domain']);
    return this.change(string(body.operation_id,200),id,body);
  }

  /**
   * Assistant reads. The owner's private chat reads any list; a project's chat
   * reads only that project's list and learns of no other list or project.
   */
  async chatList(principal:Reader,input:ListInput={}) {
    const {project}=await this.chatTurn(principal);
    if(project&&input.scope&&input.scope!==project)throw new HttpError(403,'task_scope_denied');
    return this.page(project?{...input,scope:project}:input,project);
  }
  /** Repeating the same request within one turn returns the task it already made. */
  async chatCreate(principal:Reader,input:unknown) {
    const {source,project}=await this.chatTurn(principal),body=exact(input,['title','notes','due_on','scope','domain']);
    if(project&&body.scope!==undefined&&body.scope!==project)throw new HttpError(403,'task_scope_denied');
    const value=project?{...body,scope:project}:body;
    return this.insert(digest('chat:'+source.reference.id+':'+canonical(value)),value,'chat',source.reference.id);
  }
  async chatUpdate(principal:Reader,id:string,input:unknown) {
    const {source,project}=await this.chatTurn(principal),body=exact(input,['expected_revision','title','notes','due_on','state','scope','domain']);
    if(project&&body.scope!==undefined&&body.scope!==project)throw new HttpError(403,'task_scope_denied');
    return this.change(digest('chat:'+source.reference.id+':'+id+':'+canonical(body)),id,body,project);
  }

  private async page(input:ListInput,within:string|null=null) {
    const state=input.state||'open',count=limit(input.limit,100,200),offset=input.after?Number(input.after):0;
    if(state!=='all'&&!states.includes(state))throw new HttpError(400,'invalid_task_state');
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_cursor');
    // 'all' lists every scope; 'personal' only the owner's own life tasks; a project id only that project.
    const every=!input.scope||input.scope==='all',project=every?null:scope(input.scope),label=input.domain===undefined?null:domain(input.domain);
    const where="($1='all' OR state=$1) AND ($2 OR project_id IS NOT DISTINCT FROM $3) AND ($4::text IS NULL OR domain=$4)";
    // Open work sorts by what is due first; finished work by when it finished.
    const order=state==='open'?'due_on ASC NULLS LAST,created_at ASC,id':"CASE state WHEN 'open' THEN 0 ELSE 1 END,coalesce(done_at,updated_at) DESC,id";
    const rows=(await this.control.query(`SELECT ${fields} FROM owner_tasks WHERE ${where} ORDER BY ${order} LIMIT $5 OFFSET $6`,[state,every,project,label,count+1,offset])).rows;
    const counts=Object.fromEntries(states.map(name=>[name,0]));
    for(const value of (await this.control.query(`SELECT state,count(*)::int AS count FROM owner_tasks WHERE ($1 OR project_id IS NOT DISTINCT FROM $2) AND ($3::text IS NULL OR domain=$3) GROUP BY state`,[every,project,label])).rows)counts[value.state]=value.count;
    // Every list with its open count: personal first, then each active project.
    const scopes=within?(await this.control.query(`SELECT p.id,p.name,count(t.id) FILTER (WHERE t.state='open')::int AS open FROM projects p
        LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.id=$1 GROUP BY p.id,p.name`,[within])).rows:(await this.control.query(`SELECT 'personal' AS id,NULL AS name,count(t.id) FILTER (WHERE t.state='open')::int AS open
        FROM (SELECT 1) one LEFT JOIN owner_tasks t ON t.project_id IS NULL
      UNION ALL SELECT * FROM (SELECT p.id,p.name,count(t.id) FILTER (WHERE t.state='open')::int AS open FROM projects p
        LEFT JOIN owner_tasks t ON t.project_id=p.id WHERE p.state='active' OR t.id IS NOT NULL GROUP BY p.id,p.name ORDER BY lower(p.name),p.id) listed`)).rows;
    const domains=(await this.control.query(`SELECT domain AS name,count(*) FILTER (WHERE state='open')::int AS open FROM owner_tasks
      WHERE domain<>'' AND ($1 OR project_id IS NOT DISTINCT FROM $2) GROUP BY domain ORDER BY lower(domain)`,[every,project])).rows;
    return {tasks:rows.slice(0,count).map(row),next:rows.length>count?String(offset+count):null,counts,scopes,domains};
  }

  private async insert(operation:string,body:Record<string,unknown>,origin:Origin,sourceEvent:string|null) {
    const value={title:title(body.title),notes:notes(body.notes),due_on:due(body.due_on),project_id:scope(body.scope),domain:domain(body.domain)},hash=digest(canonical(value));
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash);if(prior){await db.query('COMMIT');return prior;}
      if(value.project_id)await this.activeProject(db,value.project_id);
      const id=digest('task:'+operation);
      const created=(await db.query(`INSERT INTO owner_tasks(id,title,notes,due_on,project_id,domain,origin,source_event) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${fields}`,
        [id,value.title,value.notes,value.due_on,value.project_id,value.domain,origin,sourceEvent])).rows[0];
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await db.query('COMMIT');return row(created);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  private async change(operation:string,id:string,body:Record<string,unknown>,within:string|null=null) {
    if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_identity');
    if(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<1)throw new HttpError(400,'invalid_expected_revision');
    if(body.state!==undefined&&!states.includes(String(body.state)))throw new HttpError(400,'invalid_task_state');
    const patch:Record<string,unknown>={};
    if(body.title!==undefined)patch.title=title(body.title);
    if(body.notes!==undefined)patch.notes=notes(body.notes);
    if('due_on' in body)patch.due_on=due(body.due_on);
    if(body.state!==undefined)patch.state=body.state;
    if(body.scope!==undefined)patch.project_id=scope(body.scope);
    if(body.domain!==undefined)patch.domain=domain(body.domain);
    if(!Object.keys(patch).length)throw new HttpError(400,'task_change_required');
    const hash=digest(canonical({id,expected_revision:body.expected_revision,...patch})),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash);if(prior){await db.query('COMMIT');return prior;}
      const current=(await db.query('SELECT state,revision,project_id FROM owner_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      // Another list's task is not found from a project's chat, so its existence stays private.
      if(!current||within&&current.project_id!==within)throw new HttpError(404,'task_not_found');
      if(Number(current.revision)!==Number(body.expected_revision))throw new HttpError(409,'task_revision_conflict');
      if(patch.project_id)await this.activeProject(db,String(patch.project_id));
      const next={title:null,notes:null,due_on:undefined,state:null,domain:null,...patch} as Record<string,any>;
      const finished=next.state===null?null:next.state==='open'?'clear':current.state==='open'?'set':'keep';
      const updated=(await db.query(`UPDATE owner_tasks SET title=coalesce($2,title),notes=coalesce($3,notes),
        due_on=CASE WHEN $4 THEN $5::date ELSE due_on END,state=coalesce($6,state),
        done_at=CASE $7::text WHEN 'clear' THEN NULL WHEN 'set' THEN now() ELSE done_at END,
        project_id=CASE WHEN $8 THEN $9 ELSE project_id END,domain=coalesce($10,domain),
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${fields}`,
        [id,next.title,next.notes,'due_on' in patch,next.due_on??null,next.state,finished,'project_id' in patch,next.project_id??null,next.domain])).rows[0];
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await db.query('COMMIT');return row(updated);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  /** A task can move into an active project only; one already in an archived project stays readable. */
  private async activeProject(db:pg.PoolClient,id:string) {
    const project=(await db.query('SELECT state FROM projects WHERE id=$1',[id])).rows[0];
    if(!project)throw new HttpError(404,'task_project_not_found');
    if(project.state!=='active')throw new HttpError(409,'task_project_archived');
  }

  /** A repeated operation returns the task's current state; a different request under the same id conflicts. */
  private async replay(db:pg.PoolClient,operation:string,hash:string) {
    const prior=(await db.query('SELECT task_id,request_hash FROM owner_task_operations WHERE operation_id=$1',[operation])).rows[0];
    if(!prior)return null;
    if(prior.request_hash!==hash)throw new HttpError(409,'task_operation_conflict');
    return row((await db.query(`SELECT ${fields} FROM owner_tasks WHERE id=$1`,[prior.task_id])).rows[0]);
  }
}
