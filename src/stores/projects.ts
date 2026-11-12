import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {groupChatId,groupSpace,parentSpace,recallCondition,validateSpace} from '../spaces.js';
import {OwnerCommands} from './owner-commands.js';

const id=(value:unknown):string=>{const v=string(value,64);if(!/^[a-f0-9]{64}$/.test(v))throw new HttpError(400,'invalid_project_id');return v;};
const revision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
function exact(body:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_policy_field');
}
export interface Project {id:string;name:string;description:string;state:'active'|'archived';sharing_enabled:boolean;sharing_mode:'approved'|'filtered';revision:number}
export interface Assignment {space_id:string;project_id:string|null;mode:'assigned'|'none'|'inherit';share_into:boolean;revision:number}
export interface SharingRule {id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string;revision:number;project_id?:string|null}

const chatOf=(space:string)=>parentSpace(space)??space;
const projectRuleId=(project:string,destination:string)=>digest('project-sharing:'+project+':'+destination);
/** A rule ID a project of this installation uses, or would use for this destination. */
const projectRuleTaken=`SELECT 1 FROM projects p CROSS JOIN (SELECT space_id FROM project_assignments UNION SELECT $2::text) d(space_id)
  WHERE encode(sha256(convert_to('project-sharing:'||p.id||':'||d.space_id,'UTF8')),'hex')=$1 LIMIT 1`;
/** A project's rule into a chat that no longer gets one stays stored for its previews and releases, unlisted (ADR-0226). */
export const listedRule=(rule:string)=>`(${rule}.project_id IS NULL OR ${rule}.enabled OR (EXISTS(SELECT 1 FROM project_assignments a
  WHERE a.project_id=${rule}.project_id AND a.mode='assigned' AND a.space_id=${rule}.destination) AND NOT EXISTS(SELECT 1 FROM project_assignments g
  WHERE g.project_id=${rule}.project_id AND g.mode='assigned' AND g.space_id<>${rule}.destination AND g.space_id=split_part(${rule}.destination,'/topic/',1))))`;

/** A turn runs at most ten automatic filters (`sharing_rule_limit` in sharing.ts); a write past that is refused (ADR-0226).
 * Counted for the whole group, its General chat and every topic, whichever topic memory is set. */
async function filteredLimit(db:Pick<pg.PoolClient,'query'>,destination:string):Promise<void> {
  const chat=chatOf(destination),group=groupChatId(chat)?chat:null;
  const {rows}=await db.query(`SELECT count(*)::int AS n FROM sharing_rules WHERE enabled AND mode='filtered' AND ${recallCondition('destination','$1','$2')}`,[destination,group]);
  if(rows[0].n>10)throw new HttpError(409,'sharing_rule_limit');
}

/**
 * A project's own sharing rules: one per group or topic assigned to it, never one for a topic whose group is
 * assigned too. Written by the project and assignment writes that hold guard_state: here, and by writeAssignment's
 * revision rise when a topic stops following a source group; the reset restore puts them back as saved (ADR-0226).
 * Rows are turned off, never deleted, because previews and releases point at them.
 */
export async function syncProjectSharing(db:pg.PoolClient,projectId:string):Promise<void> {
  const project=(await db.query('SELECT name,state,sharing_enabled,sharing_mode FROM projects WHERE id=$1',[projectId])).rows[0];
  const assigned=((await db.query("SELECT space_id,share_into FROM project_assignments WHERE project_id=$1 AND mode='assigned'",[projectId])).rows as
    {space_id:string;share_into:boolean}[]).filter(row=>groupSpace(row.space_id));
  const members=assigned.map(row=>row.space_id).sort(),own=new Set(members.filter(space=>!members.includes(parentSpace(space)??'')));
  // A group's topics read its rules when they share memory, so leaving out one of its chats leaves out the whole group.
  const closed=new Set(assigned.filter(row=>!row.share_into).map(row=>chatOf(row.space_id)));
  const existing=new Map((await db.query('SELECT * FROM sharing_rules WHERE project_id=$1 FOR UPDATE',[projectId])).rows.map(row=>[row.destination as string,row]));
  const on=project.state==='active'&&project.sharing_enabled,filtered:string[]=[];
  for(const destination of [...new Set([...own,...existing.keys()])].sort()) {
    const prior=existing.get(destination),member=own.has(destination);
    // A chat never reads its own group through the project: it already shares that memory.
    let sources:string[]=member?members.filter(space=>chatOf(space)!==chatOf(destination)):prior.sources;
    const enabled=on&&member&&sources.length>0&&!closed.has(chatOf(destination));
    if(!prior&&!enabled)continue;
    if(sources.length>100){if(enabled)throw new HttpError(409,'sharing_rule_limit');sources=prior.sources;}
    if(prior&&prior.name===project.name&&prior.enabled===enabled&&prior.mode===project.sharing_mode&&canonical(prior.sources)===canonical(sources))continue;
    // Only a narrower rule makes earlier texts invalid: turned off, another mode, or a chat it no longer reads.
    const narrower=!!prior&&(prior.enabled&&!enabled||prior.mode!==project.sharing_mode||prior.sources.some((space:string)=>!sources.includes(space)));
    const written=await db.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision,project_id) VALUES($1,$2,$3,$4,$5,$6,'',1,$7)
      ON CONFLICT(id) DO UPDATE SET name=$2,sources=$3,enabled=$5,mode=$6,revision=sharing_rules.revision+$8,updated_at=now() WHERE sharing_rules.project_id=$7`,
      [projectRuleId(projectId,destination),project.name,JSON.stringify(sources),destination,enabled,project.sharing_mode,projectId,narrower?1:0]);
    // An owner rule that holds this ID is never taken over.
    if(!written.rowCount)throw new HttpError(409,'sharing_rule_project_managed');
    if(enabled&&project.sharing_mode==='filtered')filtered.push(destination);
  }
  for(const destination of filtered)await filteredLimit(db,destination);
}

/** Trusted callers hold the guard lock and own the surrounding receipt transaction.
 * Sharing settings a caller leaves out keep their saved values; a new project shares nothing. */
export async function writeProject(db:pg.PoolClient,change:Omit<Project,'revision'|'sharing_enabled'|'sharing_mode'>&
  Partial<Pick<Project,'sharing_enabled'|'sharing_mode'>>&{expected_revision:number}):Promise<Project> {
  const prior=(await db.query('SELECT revision,sharing_enabled,sharing_mode FROM projects WHERE id=$1 FOR UPDATE',[change.id])).rows[0];
  if((prior?.revision??0)!==change.expected_revision)throw new HttpError(409,'project_revision_conflict');
  const result:Project={id:change.id,name:change.name,description:change.description,state:change.state,
    sharing_enabled:change.sharing_enabled??prior?.sharing_enabled??false,sharing_mode:change.sharing_mode??prior?.sharing_mode??'filtered',revision:change.expected_revision+1};
  await db.query(`INSERT INTO projects(id,name,description,state,sharing_enabled,sharing_mode,revision) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,state=$4,sharing_enabled=$5,sharing_mode=$6,revision=$7,updated_at=now()`,
    [result.id,result.name,result.description,result.state,result.sharing_enabled,result.sharing_mode,result.revision]);
  await syncProjectSharing(db,result.id);
  return result;
}

/** "Don't share into this chat" (`share_into`) a caller leaves out keeps its saved value, and stays when a chat moves.
 * Only a group or topic joins a project; a private chat, the owner's included, never does (ADR-0242). This one check
 * covers the owner's assignment, an applied organization proposal and its undo. */
export async function writeAssignment(db:pg.PoolClient,change:Omit<Assignment,'revision'|'share_into'>&{share_into?:boolean;expected_revision:number}):Promise<Assignment> {
  if(change.mode==='assigned'&&!groupSpace(change.space_id))throw new HttpError(400,'project_private_chat');
  const previous=(await db.query('SELECT revision,project_id,mode,share_into FROM project_assignments WHERE space_id=$1 FOR UPDATE',[change.space_id])).rows[0];
  if((previous?.revision??0)!==change.expected_revision)throw new HttpError(409,'assignment_revision_conflict');
  if(change.project_id&&!(await db.query("SELECT id FROM projects WHERE id=$1 AND state='active'",[change.project_id])).rowCount)throw new HttpError(409,'active_project_required');
  const result:Assignment={space_id:change.space_id,project_id:change.project_id,mode:change.mode,share_into:change.share_into??previous?.share_into??true,revision:change.expected_revision+1};
  await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,share_into,revision) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode=$3,share_into=$4,revision=$5,updated_at=now()`,[result.space_id,result.project_id,result.mode,result.share_into,result.revision]);
  // The project it left and the one it is in; sorted, so concurrent writers lock rules in one order.
  for(const project of [...new Set([previous?.project_id,result.project_id].filter((value):value is string=>!!value))].sort())await syncProjectSharing(db,project);
  // A topic that stops following its group out of the group's project is no longer read through the group:
  // the project's rules that read the group narrow, so texts made from the topic stay invalid if it comes back (ADR-0226).
  const parent=parentSpace(change.space_id);
  if(parent&&(!previous||previous.mode==='inherit')&&result.mode!=='inherit')await db.query(`UPDATE sharing_rules SET revision=revision+1,updated_at=now()
    WHERE project_id=(SELECT project_id FROM project_assignments WHERE space_id=$1 AND mode='assigned') AND project_id IS DISTINCT FROM $2 AND sources ? $1`,
    [parent,result.mode==='assigned'?result.project_id:null]);
  return result;
}

export class ProjectRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly control:pg.Pool){this.commands=new OwnerCommands(control);}
  async save(principal:Reader,input:unknown):Promise<Project> {
    admin(principal);const body=object(input);exact(body,['id','name','description','state','sharing_enabled','sharing_mode','expected_revision','operation_id']);
    const operationId=string(body.operation_id,200),projectId=body.id===undefined?digest('project:'+operationId):id(body.id);
    const name=string(body.name,200).trim(),description=string(body.description??'',4000),expected=revision(body.expected_revision);
    if(!name||!['active','archived'].includes(String(body.state))||body.sharing_enabled!==undefined&&typeof body.sharing_enabled!=='boolean'||
      body.sharing_mode!==undefined&&!['approved','filtered'].includes(String(body.sharing_mode)))throw new HttpError(400,'invalid_project');
    const change={id:projectId,name,description,state:body.state as Project['state'],
      ...(body.sharing_enabled===undefined?{}:{sharing_enabled:body.sharing_enabled as boolean}),
      ...(body.sharing_mode===undefined?{}:{sharing_mode:body.sharing_mode as Project['sharing_mode']}),expected_revision:expected};
    return this.commands.run(principal,operationId,{kind:'project',...change},db=>writeProject(db,change));
  }
  async assign(principal:Reader,input:unknown):Promise<Assignment> {
    admin(principal);const body=object(input);exact(body,['space_id','project_id','mode','share_into','expected_revision','operation_id']);
    const space=validateSpace(body.space_id),mode=body.mode as Assignment['mode'],expected=revision(body.expected_revision);
    if(!['assigned','none','inherit'].includes(mode))throw new HttpError(400,'invalid_project_assignment');
    const projectId=mode==='assigned'?id(body.project_id):null;
    if(mode!=='assigned'&&body.project_id!==undefined&&body.project_id!==null)throw new HttpError(400,'invalid_project_assignment');
    if(body.share_into!==undefined&&(typeof body.share_into!=='boolean'||mode!=='assigned'))throw new HttpError(400,'invalid_project_assignment');
    const share=body.share_into===undefined?{}:{share_into:body.share_into as boolean};
    return this.commands.run(principal,string(body.operation_id,200),{kind:'project_assignment',space,mode,projectId,expected,...share},
      db=>writeAssignment(db,{space_id:space,project_id:projectId,mode,...share,expected_revision:expected}));
  }
  async effective(space:string):Promise<{space:string;own_assignment:Assignment|null;assignment:Assignment|null;project:Project|null;inherited:boolean}> {
    validateSpace(space);const parent=parentSpace(space);
    // A private chat is in no project, even through a row written before private chats were refused (ADR-0242).
    if(!groupSpace(space))return {space,own_assignment:null,assignment:null,project:null,inherited:false};
    const {rows}=await this.control.query(`SELECT a.*,row_to_json(p) AS project FROM project_assignments a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.space_id=$1 OR a.space_id=$2`,[space,parent]);
    const own=rows.find(r=>r.space_id===space),inherited=!own||own.mode==='inherit';
    const chosen=inherited?rows.find(r=>r.space_id===parent):own;
    const assignment=(row:any):Assignment=>({space_id:row.space_id,project_id:row.project_id,mode:row.mode,share_into:row.share_into,revision:row.revision});
    return {space,own_assignment:own?assignment(own):null,assignment:chosen?assignment(chosen):null,project:chosen?.project??null,inherited:!!chosen&&inherited};
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
    // A rule never reads from or shares into a private chat, the owner's included (ADR-0242).
    if(![...sources,destination].every(groupSpace))throw new HttpError(400,'sharing_private_chat');
    if(sources.includes(destination)||typeof body.enabled!=='boolean'||!['approved','filtered'].includes(String(body.mode))||body.enabled&&!sources.length)
      throw new HttpError(400,'invalid_sharing_rule');
    const rule:SharingRule={id:ruleId,name:string(body.name,200),sources,destination,enabled:body.enabled,mode:body.mode as SharingRule['mode'],
      instructions:string(body.instructions??'',4000),revision:expected+1};
    return this.commands.run(principal,operationId,{kind:'sharing_rule',...rule,expected_revision:expected},async db=>{
      const prior=(await db.query('SELECT revision,project_id FROM sharing_rules WHERE id=$1 FOR UPDATE',[ruleId])).rows[0];
      // A project's own rules change only from the project, and no owner rule takes an ID a project uses (ADR-0226).
      if(prior?.project_id||!prior&&(await db.query(projectRuleTaken,[ruleId,destination])).rowCount)throw new HttpError(409,'sharing_rule_project_managed');
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
    admin(principal);const {rows}=await this.control.query(`SELECT * FROM sharing_rules s WHERE s.id>$1 AND ${listedRule('s')} ORDER BY s.id LIMIT 101`,[after]);
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
  /** Whether a rule reads a conversation. A project's rule also reads each topic that follows one of its groups (ADR-0226).
   * It never reads a private chat, whatever an older or imported rule says (ADR-0242). */
  async covers(rule:SharingRule,space:string):Promise<boolean> {
    if(!groupSpace(space))return false;
    if(rule.sources.includes(space))return true;
    const parent=parentSpace(space);
    if(!rule.project_id||!parent||!rule.sources.includes(parent))return false;
    const own=(await this.control.query('SELECT mode FROM project_assignments WHERE space_id=$1',[space])).rows[0];
    return !own||own.mode==='inherit';
  }
}
