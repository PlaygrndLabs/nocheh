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
 origin text NOT NULL CHECK(origin IN ('dashboard','chat')),
 source_event text CHECK(source_event IS NULL OR source_event ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),done_at timestamptz
);
CREATE INDEX IF NOT EXISTS owner_tasks_listing ON owner_tasks(state,due_on,created_at);
CREATE TABLE IF NOT EXISTS owner_task_operations (
 operation_id text PRIMARY KEY,task_id text NOT NULL REFERENCES owner_tasks(id) ON DELETE CASCADE,
 request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;
export type TaskState='open'|'done'|'dropped';
type Origin='dashboard'|'chat';
const states=['open','done','dropped'];
const fields="id,title,notes,state,to_char(due_on,'YYYY-MM-DD') AS due_on,origin,source_event,revision,created_at,updated_at,done_at";
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
const row=(value:any)=>({...value,revision:Number(value.revision)});

/**
 * The owner's own task list in the control store. The dashboard edits it as the
 * owner; the assistant reaches it only from a current live owner-private turn.
 */
export class TaskRepository {
  constructor(readonly control:pg.Pool,private ownerTurn:(principal:Reader)=>Promise<{source:{reference:{id:string}}}>){}

  async list(principal:Reader,input:{state?:string;after?:string;limit?:string|null}={}) {
    admin(principal);return this.page(input);
  }
  async create(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','title','notes','due_on']);
    return this.insert(string(body.operation_id,200),body,'dashboard',null);
  }
  async update(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['operation_id','expected_revision','title','notes','due_on','state']);
    return this.change(string(body.operation_id,200),id,body);
  }

  /** Assistant reads; the turn proves the owner is asking in their private chat. */
  async chatList(principal:Reader,input:{state?:string;after?:string;limit?:string|null}={}) {
    await this.ownerTurn(principal);return this.page(input);
  }
  /** Repeating the same request within one turn returns the task it already made. */
  async chatCreate(principal:Reader,input:unknown) {
    const {source}=await this.ownerTurn(principal),body=exact(input,['title','notes','due_on']);
    return this.insert(digest('chat:'+source.reference.id+':'+canonical(body)),body,'chat',source.reference.id);
  }
  async chatUpdate(principal:Reader,id:string,input:unknown) {
    const {source}=await this.ownerTurn(principal),body=exact(input,['expected_revision','title','notes','due_on','state']);
    return this.change(digest('chat:'+source.reference.id+':'+id+':'+canonical(body)),id,body);
  }

  private async page(input:{state?:string;after?:string;limit?:string|null}) {
    const state=input.state||'open',count=limit(input.limit,100,200),offset=input.after?Number(input.after):0;
    if(state!=='all'&&!states.includes(state))throw new HttpError(400,'invalid_task_state');
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_cursor');
    // Open work sorts by what is due first; finished work by when it finished.
    const order=state==='open'?'due_on ASC NULLS LAST,created_at ASC,id':"CASE state WHEN 'open' THEN 0 ELSE 1 END,coalesce(done_at,updated_at) DESC,id";
    const rows=(await this.control.query(`SELECT ${fields} FROM owner_tasks WHERE $1='all' OR state=$1 ORDER BY ${order} LIMIT $2 OFFSET $3`,[state,count+1,offset])).rows;
    const counts=Object.fromEntries(states.map(name=>[name,0]));
    for(const value of (await this.control.query('SELECT state,count(*)::int AS count FROM owner_tasks GROUP BY state')).rows)counts[value.state]=value.count;
    return {tasks:rows.slice(0,count).map(row),next:rows.length>count?String(offset+count):null,counts};
  }

  private async insert(operation:string,body:Record<string,unknown>,origin:Origin,sourceEvent:string|null) {
    const value={title:title(body.title),notes:notes(body.notes),due_on:due(body.due_on)},hash=digest(canonical(value));
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash);if(prior){await db.query('COMMIT');return prior;}
      const id=digest('task:'+operation);
      const created=(await db.query(`INSERT INTO owner_tasks(id,title,notes,due_on,origin,source_event) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,
        [id,value.title,value.notes,value.due_on,origin,sourceEvent])).rows[0];
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await db.query('COMMIT');return row(created);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  private async change(operation:string,id:string,body:Record<string,unknown>) {
    if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_identity');
    if(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<1)throw new HttpError(400,'invalid_expected_revision');
    if(body.state!==undefined&&!states.includes(String(body.state)))throw new HttpError(400,'invalid_task_state');
    const patch:Record<string,unknown>={};
    if(body.title!==undefined)patch.title=title(body.title);
    if(body.notes!==undefined)patch.notes=notes(body.notes);
    if('due_on' in body)patch.due_on=due(body.due_on);
    if(body.state!==undefined)patch.state=body.state;
    if(!Object.keys(patch).length)throw new HttpError(400,'task_change_required');
    const hash=digest(canonical({id,expected_revision:body.expected_revision,...patch})),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=await this.replay(db,operation,hash);if(prior){await db.query('COMMIT');return prior;}
      const current=(await db.query('SELECT state,revision FROM owner_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!current)throw new HttpError(404,'task_not_found');
      if(Number(current.revision)!==Number(body.expected_revision))throw new HttpError(409,'task_revision_conflict');
      const next={title:null,notes:null,due_on:undefined,state:null,...patch} as Record<string,any>;
      const finished=next.state===null?null:next.state==='open'?'clear':current.state==='open'?'set':'keep';
      const updated=(await db.query(`UPDATE owner_tasks SET title=coalesce($2,title),notes=coalesce($3,notes),
        due_on=CASE WHEN $4 THEN $5::date ELSE due_on END,state=coalesce($6,state),
        done_at=CASE $7::text WHEN 'clear' THEN NULL WHEN 'set' THEN now() ELSE done_at END,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${fields}`,
        [id,next.title,next.notes,'due_on' in patch,next.due_on??null,next.state,finished])).rows[0];
      await db.query('INSERT INTO owner_task_operations(operation_id,task_id,request_hash) VALUES($1,$2,$3)',[operation,id,hash]);
      await db.query('COMMIT');return row(updated);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  /** A repeated operation returns the task's current state; a different request under the same id conflicts. */
  private async replay(db:pg.PoolClient,operation:string,hash:string) {
    const prior=(await db.query('SELECT task_id,request_hash FROM owner_task_operations WHERE operation_id=$1',[operation])).rows[0];
    if(!prior)return null;
    if(prior.request_hash!==hash)throw new HttpError(409,'task_operation_conflict');
    return row((await db.query(`SELECT ${fields} FROM owner_tasks WHERE id=$1`,[prior.task_id])).rows[0]);
  }
}
