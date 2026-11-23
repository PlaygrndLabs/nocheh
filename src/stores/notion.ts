import type pg from 'pg';
import {admin,boundReader,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import {plainHost} from '../action-arguments.js';
import {carriesData,dataLimit} from '../link-check.js';
import {canonical} from '../archive.js';
import {parentSpace} from '../spaces.js';
import {chats} from '../chats.js';
import {activeChatProject} from './projects.js';
import {memberChatProjects} from './member-reads.js';
import {scheduleRunning} from './scheduled-lookups.js';
import type {OwnerIds} from '../assistant-policy.js';

/**
 * Notion connections (ADR-0268): the owner's own (`notion:own`) and one per project (`notion:project:<id>`), each on or off
 * with its own choice of which calls ask first. The sign-ins are kept by the management service with the other keys;
 * this store never sees them. The single owner_notion row before them is dropped (development mode): the owner turns
 * Notion on again once, and the owner's sign-in is kept.
 */
export const notionSchema=`
DROP TABLE IF EXISTS owner_notion;
CREATE TABLE IF NOT EXISTS connections (
 id text PRIMARY KEY CHECK(id ~ '^notion:(own|project:[a-f0-9]{64})$'),
 service text NOT NULL CHECK(service='notion'),
 project_id text REFERENCES projects(id),
 enabled boolean NOT NULL DEFAULT false,
 approval text NOT NULL DEFAULT 'changes' CHECK(approval IN ('changes','everything','nothing')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(CASE WHEN project_id IS NULL THEN id='notion:own' ELSE id='notion:project:'||project_id END)
);
INSERT INTO connections(id,service) VALUES('notion:own','notion') ON CONFLICT DO NOTHING;
`;
/** Which Notion a call or a setting names: the owner's own (null), or a project's by its id. */
export type NotionTarget=string|null;
const projectId=/^[a-f0-9]{64}$/;
export const notionConnectionId=(project:NotionTarget)=>project===null?'notion:own':'notion:project:'+project;
/** The target a request names: absent, null or "own" is the owner's own; else a project id. */
export function notionTarget(value:unknown):NotionTarget {
  if(value===undefined||value===null||value==='own')return null;
  if(typeof value!=='string'||!projectId.test(value))throw new HttpError(400,'invalid_notion_connection');
  return value;
}
export type NotionApproval='changes'|'everything'|'nothing';
const approvals:NotionApproval[]=['changes','everything','nothing'];

/** The Notion MCP tools known to only read. Any other tool, including one Notion adds later, asks first. */
const reads=new Set(['notion-search','notion-fetch','notion-get-comments','notion-get-users','notion-get-user','notion-get-self','notion-get-teams',
  'notion-query-data-sources','notion-query-database-view']);
export const notionReads=(tool:string)=>reads.has(tool);
/** The Notion tools that read, save or edit the owner's pages, which Nothing asks me lets run without a card. Calendar,
 *  AI agents, uploads and any tool Notion adds later reach other people or send more, and ask (ADR-0263). */
const pageTools=new Set([...reads,'notion-create-pages','notion-update-page','notion-move-pages','notion-duplicate-page','notion-create-database',
  'notion-update-database','notion-update-data-source','notion-create-view','notion-update-view','notion-create-comment','notion-delete-pages','notion-restore-pages']);
export const notionPageTool=(tool:string)=>pageTools.has(tool);
const notionId=/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const reference=/^(collection|view|user|discussion):\/\/(.+)$/i,queryKeys=new Set(['v','p','pvs','source']),plain=/^[\w-]{1,64}$/;
/** An address in the owner's own Notion (ADR-0225): a raw id; a data source, view or user by id; a discussion by its ids;
 *  or a notion.so page written plainly, with no user, port or second address in it, and only Notion's own view and peek keys
 *  in its query. Any other address, such as a public *.notion.site page someone else runs, is outside. */
export function notionAddress(value:string):boolean {
  if(notionId.test(value))return true;
  const named=value.match(reference);
  if(named){const parts=named[2]!.split('/');return parts.length<=(named[1]!.toLowerCase()==='discussion'?3:1)&&parts.every(part=>notionId.test(part));}
  if(!/^https:\/\//i.test(value)||value.indexOf('://')!==value.lastIndexOf('://'))return false;
  try {
    const url=new URL(value);
    // Notion's own server fetches another address from its image and signed-file paths, so those are outside (ADR-0263).
    let path=url.pathname;try{path=decodeURIComponent(path);}catch{/* an address with a broken escape is outside */return false;}
    if(/^\/(?:image|signed)(?:\/|$)/i.test(path))return false;
    return ['notion.so','www.notion.so'].includes(url.hostname)&&plainHost(value,url)&&!url.username&&!url.password&&!url.port&&
      [...url.searchParams].every(([key,option])=>queryKeys.has(key)&&plain.test(option))&&(!url.hash||plain.test(url.hash.slice(1)));
  }catch{return false;}
}
/** The input keys whose value is an address to read, whatever its form. */
const addressKeys=new Set(['id','page_id','page_url','data_source_url','data_source_urls','view_url','discussion_id','url','urls']);
// A backslash does not end an address: some parsers read it as a slash, so it stays in what is checked.
const schemeLetter=/[a-z0-9+.-]/i,ends=/[\s"'`<>()[\]{},;|]/;
/** Every address a URL parser could read in a text, found in one pass even in a long text: from each `http:` or `https:`,
 *  however its slashes are written, and from each other `scheme:` followed by a slash or backslash, to the next stop. Tabs
 *  and newlines, which parsers drop, are dropped first. A web address with an `@` before its first slash is kept whole up
 *  to that slash, stops included, since a parser reads the host after the `@`. */
export function addresses(input:string):string[] {
  const text=input.replace(/[\t\n\r]/g,''),starts:{at:number;web:boolean}[]=[];
  for(const found of text.matchAll(/https?:|:[/\\]/gi)) {
    const web=found[0].length>2;let at=found.index!;
    if(!web){while(at>0&&schemeLetter.test(text[at-1]!))at--;while(at<found.index!&&!/[a-z]/i.test(text[at]!))at++;if(at===found.index)continue;}
    starts.push({at,web});
  }
  return starts.map(({at,web},n)=>{
    const limit=starts[n+1]?.at??text.length,host=text.indexOf(':',at)+1;let end=host,edge=host;
    while(end<limit&&!ends.test(text[end]!))end++;
    if(web){while(edge<limit&&/[/\\]/.test(text[edge]!))edge++;while(edge<limit&&!/[/\\?#]/.test(text[edge]!))edge++;}
    return text.slice(at,web&&text.slice(host,edge).includes('@')?Math.max(end,edge):end);
  });
}
/** Whether a read's input stays in the owner's Notion (ADR-0225): every value under an address key is an owner address, and
 *  so is every address written with a scheme anywhere else in it, keys included. Free text without one, such as a search
 *  query or a bare host name, is fine. */
export function notionOwnInput(input:unknown,key='',given:(address:string)=>boolean=()=>false):boolean {
  const own=(address:string)=>notionAddress(address)||given(address);
  if(typeof input==='string')return (!addressKeys.has(key)||own(input))&&addresses(input).every(own);
  if(Array.isArray(input))return input.every(item=>notionOwnInput(item,key,given));
  if(input&&typeof input==='object')return Object.entries(input).every(([name,value])=>notionOwnInput(name,'',given)&&notionOwnInput(value,name,given));
  return true;
}
/** Whether an address stands in a text only as a plain link someone may click: a Markdown link, or bare text, never an
 *  image, an attribute such as an embed's or a file's source, or a whole field such as a page's cover. Notion, or the
 *  browser of whoever opens the page, fetches those by themselves. */
function plainLink(text:string,address:string):boolean {
  const line=text.replace(/[\t\n\r]/g,'');
  if(line.trim()===address)return false;
  let at=line.indexOf(address),seen=false;
  for(;at>=0;at=line.indexOf(address,at+1)) {
    seen=true;const before=line.slice(0,at);
    if(/(?:=|<)\s*["']?$/.test(before))return false;
    if(before.endsWith('](')&&/!\[[^\]]*\]\($/.test(before))return false;
    if(!before.endsWith('](')&&!/(?:^|[\s(\[{,;])$/.test(before))return false;
  }
  return seen;
}
/** Whether a change Nothing asks me runs without a card leaves nothing to fetch outside the owner's Notion (ADR-0263):
 *  every outside address in it is one the owner gave this turn, or a plain link of at most dataLimit characters with
 *  no other address inside it. */
export function notionSafeChange(input:unknown,given:(address:string)=>boolean,key=''):boolean {
  if(typeof input==='string')return (!addressKeys.has(key)||notionAddress(input)||given(input))&&addresses(input).every(address=>
    notionAddress(address)||given(address)||Array.from(address).length<=dataLimit&&!carriesData(address)&&plainLink(input,address));
  if(Array.isArray(input))return input.every(item=>notionSafeChange(item,given,key));
  if(input&&typeof input==='object')return Object.entries(input).every(([name,value])=>notionOwnInput(name)&&notionSafeChange(value,given,name));
  return true;
}
/** What a job run may fetch without asking, on top of `notionOwnInput`: a page by its raw id or notion.so address, or a data
 *  source or view by id, with nothing beside it but switches, so no other address rides along (ADR-0203, ADR-0225). */
export function notionJobFetch(input:unknown):boolean {
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null,id=value?.id;
  if(typeof id!=='string'||Object.entries(value!).some(([key,option])=>key!=='id'&&typeof option!=='boolean'))return false;
  return !/^(?:user|discussion):/i.test(id)&&notionAddress(id);
}
/** A Notion page as a machine job's card names it, to compare with what a run fetches (machine jobs' reads): the last
 *  32-digit id in a raw id, a data source or view reference, or a notion.so address's path (never its query, where a peek
 *  names another page), lower case and without dashes. Null when there is none. */
export function notionPageKey(value:string):string|null {
  let text=value;
  if(/^https:\/\//i.test(value))try{text=new URL(value).pathname;}catch{return null;}
  const found=text.toLowerCase().replace(/-/g,'').match(/[0-9a-f]{32}(?![0-9a-f])/g);
  return found?found[found.length-1]!:null;
}
/** Whether a machine job's run may make this Notion call without its own card (machine jobs' reads): the list of tools, or
 *  a fetch of a page its card named, as a job's fetch takes it. */
export function notionMachineRead(args:{operation?:unknown;tool?:unknown;input?:unknown},pages:readonly string[]):boolean {
  if(args.operation==='list')return true;
  if(args.tool!=='notion-fetch'||!notionJobFetch(args.input))return false;
  const key=notionPageKey(String((args.input as {id:string}).id));
  return key!==null&&pages.some(page=>notionPageKey(page)===key);
}

/**
 * Whether Nocheh may use a Notion connection, and which of its calls ask first: the owner's own, or a project's
 * (ADR-0268). The sign-ins are kept by the management service with the other keys; this store never sees them.
 */
export class NotionRepository {
  constructor(readonly control:pg.Pool){}
  /** One connection's settings. A project's connection reads as off until it is first saved. */
  async get(principal:Reader,target:NotionTarget=null) {
    admin(principal);
    if(target!==null&&!(await this.control.query('SELECT 1 FROM projects WHERE id=$1',[target])).rowCount)throw new HttpError(404,'project_not_found');
    const row=(await this.control.query('SELECT enabled,approval,revision,updated_at FROM connections WHERE id=$1',[notionConnectionId(target)])).rows[0];
    return {project:target,enabled:!!row?.enabled,approval:(row?.approval??'changes') as NotionApproval,revision:Number(row?.revision??0),updated_at:row?.updated_at??null};
  }
  async save(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['project','enabled','approval','expected_revision'].includes(key))||body.enabled!==undefined&&typeof body.enabled!=='boolean'||
      body.approval!==undefined&&!approvals.includes(body.approval as NotionApproval)||!Number.isSafeInteger(body.expected_revision))throw new HttpError(400,'invalid_notion_settings');
    const target=notionTarget(body.project),id=notionConnectionId(target);
    // Anyone in a project's groups can ask for a call, so its changes always ask: Nothing asks me is the owner's own only.
    if(target!==null&&body.approval==='nothing')throw new HttpError(400,'invalid_notion_settings');
    if(target!==null) {
      if(!(await this.control.query('SELECT 1 FROM projects WHERE id=$1',[target])).rowCount)throw new HttpError(404,'project_not_found');
      await this.control.query(`INSERT INTO connections(id,service,project_id) VALUES($1,'notion',$2) ON CONFLICT DO NOTHING`,[id,target]);
    }
    const row=(await this.control.query(`UPDATE connections SET enabled=coalesce($1,enabled),approval=coalesce($2,approval),revision=revision+1,updated_at=now()
      WHERE id=$4 AND revision=$3 RETURNING revision`,[body.enabled??null,body.approval??null,body.expected_revision,id])).rows[0];
    if(!row)throw new HttpError(409,'notion_settings_changed');
    return this.get(principal,target);
  }
}

/**
 * Where a Notion connection may be used (ADR-0268): the owner's own only from the owner's private chat, in a live turn
 * or a job the owner approved there; a project's from the owner's private chat in a live turn, or from a live turn in one
 * of that project's groups or topics while the project is active; a project's also from a member's own private chat while a
 * group it reads is in that active project, to read only (ADR-0278). No job reaches a project's Notion. Throws 403
 * `notion_owner_private_only` for the owner's own and `notion_not_here` for a project's.
 */
export async function assertNotionHere(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean},target:NotionTarget) {
  if(principal.admin)throw new HttpError(403,target===null?'notion_owner_private_only':'notion_not_here');
  if(target===null){if(principal.scope!==null||!turn.owner)throw new HttpError(403,'notion_owner_private_only');return;}
  // A schedule's run reads a project's Notion where its chat may (ADR-0278); a background job never does.
  if(turn.job&&!turn.scheduled)throw new HttpError(403,'notion_not_here');
  // A member's own private chat: a project holding a group it reads, whether or not that project shares its chats (ADR-0278).
  if(boundReader(principal)==='member') {
    const own=principal.scope===null||(principal.space??principal.scope)!==principal.scope?null:await memberChatProjects(db,principal.scope);
    if(!own||own.member!==principal.member||!own.projects.includes(target))throw new HttpError(403,'notion_not_here');
    return;
  }
  if(principal.scope===null&&turn.owner) {
    if(!(await db.query("SELECT 1 FROM projects WHERE id=$1 AND state='active'",[target])).rowCount)throw new HttpError(403,'notion_not_here');
    return;
  }
  if(principal.scope===null||!['group','topic'].includes(chats().kind(principal.space??principal.scope)??'')||
    await activeChatProject(db,principal.space??principal.scope)!==target)throw new HttpError(403,'notion_not_here');
}

/**
 * A Notion call may come from where its connection may be used (`assertNotionHere`) while that connection is on.
 * Returns the authority that lets it run without a card under the connection's setting, or null when it waits for
 * approval. `allowed` says the turn may use the setting at all. A job reads group text that anyone there can write, so
 * in a job only reads skip the card (ADR-0203). A read whose input names an address outside the owner's Notion counts as
 * a change, in a live turn and in a job (ADR-0225). Nothing asks me lets only the page tools run in a live turn, and only
 * while nothing outside is fetched: an outside read of an address the owner gave this turn (`given`), and a change
 * whose outside addresses are given or plain links (ADR-0263).
 */
export async function notionAuthority(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean},
  args:{operation?:string;tool?:string;input?:unknown;project?:unknown},allowed:boolean,given:(address:string)=>boolean=()=>false):Promise<string|null> {
  const target=notionTarget(args.project);
  await assertNotionHere(db,principal,turn,target);
  // A machine job's run reads only the Notion pages its card named; any other read is refused, never offered as a card.
  // Its changes still ask (machine jobs' reads).
  const tool=String(args.tool??'');
  if(principal.machineReads&&(args.operation==='list'||notionReads(tool))&&!notionMachineRead(args,principal.machineReads.notion))throw new HttpError(403,'notion_page_not_on_card');
  const row=(await db.query('SELECT enabled,approval,revision FROM connections WHERE id=$1 FOR SHARE',[notionConnectionId(target)])).rows[0];
  if(!row?.enabled)throw new HttpError(409,'notion_not_enabled');
  if(!allowed||(principal.purpose??'assistant')!=='assistant')return null;
  const read=args.operation==='list'||notionReads(tool)&&notionOwnInput(args.input)&&(!turn.job||tool!=='notion-fetch'||notionJobFetch(args.input));
  // Nothing asks me covers the page tools in a live turn: reads of the owner's Notion or of an address the owner gave, and
  // changes that leave nothing outside to fetch (ADR-0263).
  const nothing=row.approval==='nothing'&&target===null&&!turn.job&&(args.operation==='list'||notionPageTool(tool)&&
    (notionReads(tool)?notionOwnInput(args.input,'',given):notionSafeChange(args.input,given)));
  return nothing||row.approval!=='everything'&&read?'notion_setting:'+(target===null?'':target+':')+row.revision:null;
}

/** What a newly asked private job's card offers in the owner's own Notion: reads without asking, or nothing when it is off
 *  or every call asks. The job row keeps it, narrowed again by this when the job is approved (ADR-0225). */
export async function notionJobReads(db:Pick<pg.PoolClient,'query'>):Promise<boolean> {
  const row=(await db.query("SELECT enabled,approval FROM connections WHERE id='notion:own'")).rows[0];
  return !!row?.enabled&&row.approval!=='everything';
}

/**
 * Why a saved Notion call may not run, checked again right before it runs (ADR-0225, ADR-0268): the connection it names
 * is off; a call on the owner's own Notion is not from the owner's private chat, or its job is not one the owner asked
 * for and approved there, or the setting let a job's read through that the job was not approved to make; a call on a
 * project's Notion is from a job, or from neither the owner's private chat nor a group or topic still in that active
 * project. A scheduled task's call, which has no background job, runs only by its own card or the owner's exact
 * permission. Null when it may run.
 */
export async function notionRunRefusal(db:Pick<pg.PoolClient,'query'>,row:any,ownerIds:OwnerIds|string|null,
  args:{project?:unknown;operation?:unknown;tool?:unknown;input?:unknown}={}):Promise<string|null> {
  let target:NotionTarget;try{target=notionTarget(args.project);}catch{return 'notion_not_here';}
  const setting=(await db.query('SELECT enabled FROM connections WHERE id=$1',[notionConnectionId(target)])).rows[0];
  if(!setting?.enabled)return 'notion_not_enabled';
  // The owner's private chat (a row's chat, ADR-0252) and the owner's account (who decided). A plain string is both, as
  // before step 2b, when the owner's private chat had the owner's Telegram user id.
  const {chat:owner,account}=typeof ownerIds==='string'||!ownerIds?{chat:ownerIds,account:ownerIds}:ownerIds;
  const ownChat=!!owner&&row.scope===owner&&(parentSpace(row.space_id)??row.space_id)===owner;
  if(target!==null) {
    if(row.job_id&&!await scheduleRunning(db,row.job_id))return 'notion_not_here';
    if(ownChat)return (await db.query("SELECT 1 FROM projects WHERE id=$1 AND state='active'",[target])).rowCount?null:'notion_not_here';
    if(row.scope!==owner&&await activeChatProject(db,row.space_id)===target)return null;
    // A member's own private chat: still open, still reading a group of that active project, and only a read (ADR-0278).
    const member=!!owner&&typeof row.scope==='string'&&row.space_id===row.scope?await memberChatProjects(db,row.scope,owner):null;
    return member?.projects.includes(target)&&notionMemberRead(args)?null:'notion_not_here';
  }
  if(!owner||!account||!ownChat)return 'notion_owner_private_only';
  // A schedule's run in the owner's private chat, still running (ADR-0278).
  if(!row.job_id||await scheduleRunning(db,row.job_id))return null;
  const bySetting=row.state==='approved'&&canonical(row.decision_reference)===canonical(row.source_reference);
  const job=(await db.query('SELECT scope,requester,decided_by,logical_profile,notion_reads,machine,notion_pages FROM background_jobs WHERE id=$1',[row.job_id])).rows[0];
  if(!job)return bySetting?'notion_job_not_approved':null;
  // A machine job's read runs by the setting only for a page its card named (machine jobs' reads).
  const pages=job.machine?Array.isArray(job.notion_pages)?job.notion_pages:[]:null;
  return job.scope===owner&&job.requester===null&&job.decided_by===account&&job.logical_profile===row.logical_profile&&
    (!bySetting||job.notion_reads&&(!pages||notionMachineRead(args,pages)))?null:'notion_job_not_approved';
}

/** Whether a call on a project's Notion only reads, as a member's private chat may ask (ADR-0278): Notion's list of tools, or
 *  one of its known read tools on that Notion's own pages alone. */
export const notionMemberRead=(args:{operation?:unknown;tool?:unknown;input?:unknown})=>
  args.operation==='list'||notionReads(String(args.tool??''))&&notionOwnInput(args.input);

/** The Notion connections a turn may use, named for the agent (ADR-0268): the owner's own and every active project's
 *  in the owner's private chat; its own project's in a group or topic; in a member's private chat, each project holding a
 *  group it reads, to read only (ADR-0278). Only those that are on. */
export async function notionConnectionsHere(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean}) {
  const rows=(await db.query(`SELECT c.project_id,p.name FROM connections c LEFT JOIN projects p ON p.id=c.project_id
    WHERE c.enabled AND (c.project_id IS NULL OR p.state='active') ORDER BY c.project_id IS NOT NULL,p.name,c.id`)).rows;
  const usable=[];
  for(const row of rows) {
    const target=(row.project_id??null) as NotionTarget;
    try{await assertNotionHere(db,principal,turn,target);}catch(error){if(error instanceof HttpError&&error.status===403)continue;throw error;}
    usable.push(target===null?{connection:'own',name:'The owner\'s own Notion'}:{connection:target,name:'Notion of the project '+String(row.name)});
  }
  return usable;
}
