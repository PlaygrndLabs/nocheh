import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {groupChatId,groupSpace,parentSpace,recallCondition,validateSpace} from '../spaces.js';
import {OwnerCommands} from './owner-commands.js';
import {projectGroupsSql} from './project-groups.js';
import {moveGroupTasks} from './tasks.js';

const id=(value:unknown):string=>{const v=string(value,64);if(!/^[a-f0-9]{64}$/.test(v))throw new HttpError(400,'invalid_project_id');return v;};
const revision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
function exact(body:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_policy_field');
}
export interface Project {id:string;name:string;description:string;state:'active'|'archived';revision:number}
export interface Assignment {space_id:string;project_id:string|null;mode:'assigned'|'none'|'inherit';revision:number}
export interface SharingRule {id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string;revision:number}

const chatOf=(space:string)=>parentSpace(space)??space;

/** A turn runs at most ten automatic filters (`sharing_rule_limit` in sharing.ts); an owner rule past that is refused.
 * Counted for the whole group, its General chat and every topic, whichever topic memory is set. */
async function filteredLimit(db:Pick<pg.PoolClient,'query'>,destination:string):Promise<void> {
  const chat=chatOf(destination),group=groupChatId(chat)?chat:null;
  const {rows}=await db.query(`SELECT count(*)::int AS n FROM sharing_rules WHERE enabled AND mode='filtered' AND ${recallCondition('destination','$1','$2')}`,[destination,group]);
  if(rows[0].n>10)throw new HttpError(409,'sharing_rule_limit');
}

/** Trusted callers hold the guard lock and own the surrounding receipt transaction. A project decides its role and
 * skills, its task board and what an Answer privately answer may add; it never shares between its groups (ADR-0247). */
export async function writeProject(db:pg.PoolClient,change:Omit<Project,'revision'>&{expected_revision:number}):Promise<Project> {
  const prior=(await db.query('SELECT revision FROM projects WHERE id=$1 FOR UPDATE',[change.id])).rows[0];
  if((prior?.revision??0)!==change.expected_revision)throw new HttpError(409,'project_revision_conflict');
  const result:Project={id:change.id,name:change.name,description:change.description,state:change.state,revision:change.expected_revision+1};
  await db.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,state=$4,revision=$5,updated_at=now()`,
    [result.id,result.name,result.description,result.state,result.revision]);
  return result;
}

/**
 * Only a group joins a project, and a topic always follows its group's project: a topic's only choice is to follow
 * it (ADR-0247). A private chat, the owner's included, never joins one (ADR-0242). This one check covers the owner's
 * assignment, an applied organization proposal and its undo.
 */
export async function writeAssignment(db:pg.PoolClient,change:Omit<Assignment,'revision'>&{expected_revision:number}):Promise<Assignment> {
  if(change.mode==='assigned'&&!groupSpace(change.space_id))throw new HttpError(400,'project_private_chat');
  if(parentSpace(change.space_id)&&change.mode!=='inherit')throw new HttpError(400,'project_topic_follows_group');
  const previous=(await db.query('SELECT revision,project_id,mode FROM project_assignments WHERE space_id=$1 FOR UPDATE',[change.space_id])).rows[0];
  if((previous?.revision??0)!==change.expected_revision)throw new HttpError(409,'assignment_revision_conflict');
  if(change.project_id&&!(await db.query("SELECT id FROM projects WHERE id=$1 AND state='active'",[change.project_id])).rowCount)throw new HttpError(409,'active_project_required');
  const result:Assignment={space_id:change.space_id,project_id:change.project_id,mode:change.mode,revision:change.expected_revision+1};
  await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,$3,$4)
    ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode=$3,revision=$4,updated_at=now()`,[result.space_id,result.project_id,result.mode,result.revision]);
  // A group moving from one project to another takes its tasks and its topics' tasks with it; leaving every project
  // leaves them on the old board, where only the owner sees them (ADR-0248).
  if(groupChatId(change.space_id))await moveGroupTasks(db,change.space_id,previous?.mode==='assigned'?previous.project_id:null,result.mode==='assigned'?result.project_id:null);
  return result;
}

export class ProjectRepository {
  private readonly commands:OwnerCommands;
  /** `served` gives the groups Nocheh serves now (the policy's group_ids), for each project's `groups`. */
  constructor(readonly control:pg.Pool,private readonly served:()=>readonly string[]=()=>[]){this.commands=new OwnerCommands(control);}
  async save(principal:Reader,input:unknown):Promise<Project> {
    admin(principal);const body=object(input);exact(body,['id','name','description','state','expected_revision','operation_id']);
    const operationId=string(body.operation_id,200),projectId=body.id===undefined?digest('project:'+operationId):id(body.id);
    const name=string(body.name,200).trim(),description=string(body.description??'',4000),expected=revision(body.expected_revision);
    if(!name||!['active','archived'].includes(String(body.state)))throw new HttpError(400,'invalid_project');
    const change={id:projectId,name,description,state:body.state as Project['state'],expected_revision:expected};
    return this.commands.run(principal,operationId,{kind:'project',...change},db=>writeProject(db,change));
  }
  async assign(principal:Reader,input:unknown):Promise<Assignment> {
    admin(principal);const body=object(input);exact(body,['space_id','project_id','mode','expected_revision','operation_id']);
    const space=validateSpace(body.space_id),mode=body.mode as Assignment['mode'],expected=revision(body.expected_revision);
    if(!['assigned','none','inherit'].includes(mode))throw new HttpError(400,'invalid_project_assignment');
    const projectId=mode==='assigned'?id(body.project_id):null;
    if(mode!=='assigned'&&body.project_id!==undefined&&body.project_id!==null)throw new HttpError(400,'invalid_project_assignment');
    return this.commands.run(principal,string(body.operation_id,200),{kind:'project_assignment',space,mode,projectId,expected},
      db=>writeAssignment(db,{space_id:space,project_id:projectId,mode,expected_revision:expected}));
  }
  async effective(space:string):Promise<{space:string;own_assignment:Assignment|null;assignment:Assignment|null;project:Project|null;inherited:boolean}> {
    validateSpace(space);const parent=parentSpace(space);
    const {rows}=await this.control.query(`SELECT a.*,row_to_json(p) AS project FROM project_assignments a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.space_id=$1 OR a.space_id=$2`,[space,parent]);
    const assignment=(row:any):Assignment=>({space_id:row.space_id,project_id:row.project_id,mode:row.mode,revision:row.revision});
    const own=rows.find(r=>r.space_id===space);
    // A private chat is in no project, even through a row written before private chats were refused. That row is
    // still returned as its own, so the owner sees it and can clear it (ADR-0242).
    if(!groupSpace(space))return {space,own_assignment:own?assignment(own):null,assignment:null,project:null,inherited:false};
    // A topic always follows its group, whatever row of its own was written before that rule (ADR-0247).
    const inherited=!!parent||!own||own.mode==='inherit',chosen=inherited?rows.find(r=>r.space_id===parent):own;
    return {space,own_assignment:own?assignment(own):null,assignment:chosen?assignment(chosen):null,project:chosen?.project??null,inherited:!!chosen&&inherited};
  }
  /** Each project lists its groups: the served groups assigned to it, as projectGroups decides (ADR-0247). */
  async list(principal:Reader,after='') {
    admin(principal);const served=[...new Set(this.served())].filter(groupChatId);
    const {rows}=await this.control.query(`SELECT p.*,${projectGroupsSql('p.id','$2')} AS groups FROM projects p WHERE p.id>$1 ORDER BY p.id LIMIT 101`,[after,served]);
    return {projects:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  }
  async assignments(principal:Reader,after='') {
    admin(principal);const {rows}=await this.control.query('SELECT * FROM project_assignments WHERE space_id>$1 ORDER BY space_id LIMIT 101',[after]);
    return {assignments:rows.slice(0,100),next:rows.length>100?rows[99].space_id:null};
  }
}

export class SharingPolicyRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool){this.commands=new OwnerCommands(control);}
  async save(principal:Reader,input:unknown):Promise<SharingRule> {
    admin(principal);const body=object(input);exact(body,['id','name','sources','destination','enabled','mode','instructions','expected_revision','operation_id']);
    const operationId=string(body.operation_id,200),ruleId=body.id===undefined?digest('sharing:'+operationId):id(body.id);
    if(!Array.isArray(body.sources)||body.sources.length>100)throw new HttpError(400,'invalid_sharing_sources');
    const sources=[...new Set(body.sources.map(validateSpace))].sort(),destination=validateSpace(body.destination),expected=revision(body.expected_revision);
    const privateSources=sources.filter(space=>!groupSpace(space)),privateDestination=!groupSpace(destination);
    // A rule never reads from or shares into a private chat, the owner's included (ADR-0242).
    if((privateSources.length||privateDestination)&&body.enabled!==false)throw new HttpError(400,'sharing_private_chat');
    if(sources.includes(destination)||typeof body.enabled!=='boolean'||!['approved','filtered'].includes(String(body.mode))||body.enabled&&!sources.length)
      throw new HttpError(400,'invalid_sharing_rule');
    const rule:SharingRule={id:ruleId,name:string(body.name,200),sources,destination,enabled:body.enabled,mode:body.mode as SharingRule['mode'],
      instructions:string(body.instructions??'',4000),revision:expected+1};
    return this.commands.run(principal,operationId,{kind:'sharing_rule',...rule,expected_revision:expected},async db=>{
      const prior=(await db.query('SELECT revision,sources,destination FROM sharing_rules WHERE id=$1 FOR UPDATE',[ruleId])).rows[0];
      // A rule saved earlier that still names a private chat can be turned off and kept off as it is, so the owner can
      // stop it; it never gains a private chat, and turning it on needs them removed first.
      if((privateSources.length||privateDestination)&&(!prior||privateSources.some(space=>!prior.sources.includes(space))||privateDestination&&prior.destination!==destination))
        throw new HttpError(400,'sharing_private_chat');
      if((prior?.revision??0)!==expected)throw new HttpError(409,'sharing_revision_conflict');
      await db.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET name=$2,sources=$3,destination=$4,enabled=$5,mode=$6,instructions=$7,revision=$8,updated_at=now()`,
        [ruleId,rule.name,JSON.stringify(sources),destination,rule.enabled,rule.mode,rule.instructions,rule.revision]);
      if(rule.enabled&&rule.mode==='filtered')await filteredLimit(db,destination);
      return rule;
    });
  }
  /** Each rule names the private chats it would read or share into, which Nocheh skips (ADR-0242). */
  async list(principal:Reader,after='') {
    admin(principal);const {rows}=await this.control.query('SELECT * FROM sharing_rules s WHERE s.id>$1 ORDER BY s.id LIMIT 101',[after]);
    return {rules:rows.slice(0,100).map(row=>({...row,private_sources:[...row.sources,row.destination].filter((space:string)=>!groupSpace(space))})),
      next:rows.length>100?rows[99].id:null};
  }
  /** Configuration for preparing a separate permitted projection; never authorizes raw source reads.
   * With `group`, rules for that group's base conversation and every one of its topics apply too. */
  async forDestination(destination:string,group:string|null=null):Promise<SharingRule[]> {
    // A private chat gets nothing, even from a rule written before private chats were refused (ADR-0242).
    return (await this.control.query(`SELECT * FROM sharing_rules WHERE ${recallCondition('destination','$1','$2')} AND enabled ORDER BY id`,[validateSpace(destination),group])).rows
      .filter(rule=>groupSpace(rule.destination));
  }
  /** Whether a rule reads a conversation: only the exact groups and topics it names. It never reads a private chat,
   * whatever an older or imported rule says (ADR-0242), and a project never adds one (ADR-0247). Async for its callers. */
  async covers(rule:SharingRule,space:string):Promise<boolean> {
    return groupSpace(space)&&rule.sources.includes(space);
  }
}
