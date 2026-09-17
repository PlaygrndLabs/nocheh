import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';
import {OwnerCommands} from './owner-commands.js';

const id=(value:unknown):string=>{const v=string(value,64);if(!/^[a-f0-9]{64}$/.test(v))throw new HttpError(400,'invalid_project_id');return v;};
const revision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
function exact(body:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_policy_field');
}
export interface Project {id:string;name:string;description:string;state:'active'|'archived';revision:number}
export interface Assignment {space_id:string;project_id:string|null;mode:'assigned'|'none'|'inherit';revision:number}
export interface SharingRule {id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string;revision:number}

export class ProjectRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool){this.commands=new OwnerCommands(control);}
  async save(principal:Reader,input:unknown):Promise<Project> {
    admin(principal);const body=object(input);exact(body,['id','name','description','state','expected_revision','operation_id']);
    const operationId=string(body.operation_id,200),projectId=body.id===undefined?digest('project:'+operationId):id(body.id);
    const name=string(body.name,200).trim(),description=string(body.description??'',4000),expected=revision(body.expected_revision);
    if(!name||!['active','archived'].includes(String(body.state)))throw new HttpError(400,'invalid_project');
    const change={id:projectId,name,description,state:body.state as Project['state'],expected_revision:expected};
    return this.commands.run(principal,operationId,{kind:'project',...change},async db=>{
      const prior=(await db.query('SELECT revision FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
      if((prior?.revision??0)!==expected)throw new HttpError(409,'project_revision_conflict');
      const result:Project={id:projectId,name,description,state:change.state,revision:expected+1};
      await db.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,state=$4,revision=$5,updated_at=now()`,[projectId,name,description,change.state,result.revision]);
      return result;
    });
  }
  async assign(principal:Reader,input:unknown):Promise<Assignment> {
    admin(principal);const body=object(input);exact(body,['space_id','project_id','mode','expected_revision','operation_id']);
    const space=validateSpace(body.space_id),mode=body.mode as Assignment['mode'],expected=revision(body.expected_revision);
    if(!['assigned','none','inherit'].includes(mode))throw new HttpError(400,'invalid_project_assignment');
    const projectId=mode==='assigned'?id(body.project_id):null;
    if(mode!=='assigned'&&body.project_id!==undefined&&body.project_id!==null)throw new HttpError(400,'invalid_project_assignment');
    return this.commands.run(principal,string(body.operation_id,200),{kind:'project_assignment',space,mode,projectId,expected},async db=>{
      const previous=(await db.query('SELECT revision FROM project_assignments WHERE space_id=$1 FOR UPDATE',[space])).rows[0];
      if((previous?.revision??0)!==expected)throw new HttpError(409,'assignment_revision_conflict');
      if(projectId&&!(await db.query("SELECT id FROM projects WHERE id=$1 AND state='active'",[projectId])).rowCount)throw new HttpError(409,'active_project_required');
      const result:Assignment={space_id:space,project_id:projectId,mode,revision:expected+1};
      await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode=$3,revision=$4,updated_at=now()`,[space,projectId,mode,result.revision]);
      return result;
    });
  }
  async effective(space:string):Promise<{space:string;assignment:Assignment|null;project:Project|null;inherited:boolean}> {
    validateSpace(space);const parent=parentSpace(space);
    const {rows}=await this.control.query(`SELECT a.*,row_to_json(p) AS project FROM project_assignments a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.space_id=$1 OR a.space_id=$2`,[space,parent]);
    const own=rows.find(r=>r.space_id===space),inherited=!own||own.mode==='inherit';
    const chosen=inherited?rows.find(r=>r.space_id===parent):own;
    return {space,assignment:chosen?{space_id:chosen.space_id,project_id:chosen.project_id,mode:chosen.mode,revision:chosen.revision}:null,
      project:chosen?.project??null,inherited:!!chosen&&inherited};
  }
  async list(principal:Reader,after='') {
    admin(principal);const {rows}=await this.control.query('SELECT * FROM projects WHERE id>$1 ORDER BY id LIMIT 101',[after]);
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
    if(sources.includes(destination)||typeof body.enabled!=='boolean'||!['approved','filtered'].includes(String(body.mode))||body.enabled&&!sources.length)
      throw new HttpError(400,'invalid_sharing_rule');
    const rule:SharingRule={id:ruleId,name:string(body.name,200),sources,destination,enabled:body.enabled,mode:body.mode as SharingRule['mode'],
      instructions:string(body.instructions??'',4000),revision:expected+1};
    return this.commands.run(principal,operationId,{kind:'sharing_rule',...rule,expected_revision:expected},async db=>{
      const prior=(await db.query('SELECT revision FROM sharing_rules WHERE id=$1 FOR UPDATE',[ruleId])).rows[0];
      if((prior?.revision??0)!==expected)throw new HttpError(409,'sharing_revision_conflict');
      await db.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET name=$2,sources=$3,destination=$4,enabled=$5,mode=$6,instructions=$7,revision=$8,updated_at=now()`,
        [ruleId,rule.name,JSON.stringify(sources),destination,rule.enabled,rule.mode,rule.instructions,rule.revision]);
      return rule;
    });
  }
  async list(principal:Reader,after='') {
    admin(principal);const {rows}=await this.control.query('SELECT * FROM sharing_rules WHERE id>$1 ORDER BY id LIMIT 101',[after]);
    return {rules:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  }
  /** Configuration for preparing a separate permitted projection; never authorizes raw source reads. */
  async forDestination(destination:string):Promise<SharingRule[]> {
    return (await this.control.query('SELECT * FROM sharing_rules WHERE destination=$1 AND enabled ORDER BY id',[validateSpace(destination)])).rows;
  }
}
