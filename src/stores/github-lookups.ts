import type pg from 'pg';
import {boundReader,type Reader} from '../access.js';
import {HttpError} from '../http.js';
import {parentSpace} from '../spaces.js';
import {chats} from '../chats.js';
import type {OwnerIds} from '../assistant-policy.js';
import {activeChatProject} from './projects.js';
import {memberChatProjects} from './member-reads.js';
import {scheduleRunning} from './scheduled-lookups.js';

/**
 * Live GitHub lookups (ADR-0270): a few fixed read-only calls on one repository, run by the executor with a key GitHub
 * makes for that repository alone. A repository linked to a project (ADR-0269) is looked up in that project's groups and
 * in the owner's private chat; any other is the owner's own, looked up only in the owner's private chat. Never in a job.
 */
import {GITHUB_REPO} from '../github-arguments.js';

/** The project a repository is linked to, or null for the owner's own. */
const linkOf=async(db:Pick<pg.PoolClient,'query'>,repo:string,lock=false)=>
  (await db.query(`SELECT project_id FROM github_projects WHERE repo=lower($1)${lock?' FOR SHARE':''}`,[repo])).rows[0]?.project_id as string|undefined??null;

/** Where a lookup may run, or why not: the owner's private chat in a live turn reads the owner's own repositories and an
 *  active project's; a group or topic of an active project reads only that project's; a member's own private chat reads
 *  those of each active project holding a group it reads (ADR-0278). Refused in a job, a stranger's private chat, and a
 *  group in no project (403 `github_not_here`). */
export async function assertGithubHere(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean},repo:string,lock=false):Promise<string|null> {
  const refused=new HttpError(403,'github_not_here');
  // A schedule's run looks up where its chat may (ADR-0278); a background job never does.
  if(principal.admin||turn.job&&!turn.scheduled||(principal.purpose??'assistant')!=='assistant')throw refused;
  const project=await linkOf(db,repo,lock);
  if(principal.scope===null) {
    if(!turn.owner)throw refused;
    if(project&&!(await db.query("SELECT 1 FROM projects WHERE id=$1 AND state='active'",[project])).rowCount)throw refused;
    return project;
  }
  const space=principal.space??principal.scope;
  if(boundReader(principal)==='member') {
    const own=space===principal.scope?await memberChatProjects(db,principal.scope):null;
    if(!own||own.member!==principal.member||!project||!own.projects.includes(project))throw refused;
    return project;
  }
  if(!['group','topic'].includes(chats().kind(space)??'')||!project||await activeChatProject(db,space)!==project)throw refused;
  return project;
}

/** Why a lookup may run without a card: every lookup reads, so one asked where it may run, in a live turn, runs. */
export async function githubAuthority(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean},
  args:{input?:unknown},live:boolean,lock=false):Promise<string|null> {
  const repo=String((args.input as Record<string,unknown>|undefined)?.repo??'');
  const project=await assertGithubHere(db,principal,turn,repo,lock);
  return live?'github_read:'+(project??'own'):null;
}

/** Why a saved lookup may not run, checked again right before it runs: from a job, or no longer from the owner's private
 *  chat, a group still in the active project its repository is linked to, or a member's private chat still reading a
 *  group of that project (`github_not_here`). Null when it may run. */
export async function githubRunRefusal(db:Pick<pg.PoolClient,'query'>,row:any,ownerIds:OwnerIds|string|null,args:{input?:unknown}):Promise<string|null> {
  if(row.job_id&&!await scheduleRunning(db,row.job_id))return 'github_not_here';
  const repo=String((args.input as Record<string,unknown>|undefined)?.repo??'');
  if(!GITHUB_REPO.test(repo))return 'github_not_here';
  const {chat:owner}=typeof ownerIds==='string'||!ownerIds?{chat:ownerIds}:ownerIds;
  const project=await linkOf(db,repo);
  // The owner's own repositories are only ever for the owner's key (ADR-0301).
  if(!!owner&&row.scope===owner&&(parentSpace(row.space_id)??row.space_id)===owner)
    return row.person&&row.person!=='owner'?'github_not_here':!project||(await db.query("SELECT 1 FROM projects WHERE id=$1 AND state='active'",[project])).rowCount?null:'github_not_here';
  if(!project||row.scope===null)return 'github_not_here';
  if(await activeChatProject(db,row.space_id)===project)return null;
  // A member's own private chat (ADR-0278).
  const member=!!owner&&row.space_id===row.scope?await memberChatProjects(db,row.scope,owner):null;
  return member?.projects.includes(project)?null:'github_not_here';
}

/** The repositories this chat may look up: in the owner's private chat every linked repository of an active project and,
 *  as the owner's own, those the GitHub card lists (`own`); in a project's group only that project's; in a member's private
 *  chat those of each project holding a group it reads (ADR-0278). */
export async function githubReposHere(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean}) {
  if(principal.admin||turn.job&&!turn.scheduled)throw new HttpError(403,'github_not_here');
  if(principal.scope===null) {
    if(!turn.owner)throw new HttpError(403,'github_not_here');
    const linked=(await db.query(`SELECT g.repo,p.name FROM github_projects g JOIN projects p ON p.id=g.project_id AND p.state='active' ORDER BY g.repo`)).rows;
    return {repos:linked.map(row=>({repo:row.repo as string,project:row.name as string})),own:'Any other repository the GitHub app reads is the owner\'s own and may be looked up here.'};
  }
  if(boundReader(principal)==='member') {
    const own=(principal.space??principal.scope)===principal.scope?await memberChatProjects(db,principal.scope):null;
    if(!own||own.member!==principal.member||!own.projects.length)return {repos:[]};
    return {repos:(await db.query(`SELECT g.repo,p.name FROM github_projects g JOIN projects p ON p.id=g.project_id
      WHERE g.project_id=ANY($1::text[]) ORDER BY g.repo`,[own.projects])).rows.map(row=>({repo:row.repo as string,project:row.name as string}))};
  }
  const project=await activeChatProject(db,principal.space??principal.scope);
  if(!project)return {repos:[]};
  return {repos:(await db.query('SELECT repo FROM github_projects WHERE project_id=$1 ORDER BY repo',[project])).rows.map(row=>({repo:row.repo as string}))};
}
