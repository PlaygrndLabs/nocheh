import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import {plainHost} from '../action-arguments.js';

export const notionSchema=`
CREATE TABLE IF NOT EXISTS owner_notion (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 approval text NOT NULL DEFAULT 'changes' CHECK(approval IN ('changes','everything','nothing')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO owner_notion(singleton) VALUES(true) ON CONFLICT DO NOTHING;
`;
export type NotionApproval='changes'|'everything'|'nothing';
const approvals:NotionApproval[]=['changes','everything','nothing'];

/** The Notion MCP tools known to only read. Any other tool, including one Notion adds later, asks first. */
const reads=new Set(['notion-search','notion-fetch','notion-get-comments','notion-get-users','notion-get-user','notion-get-self','notion-get-teams',
  'notion-query-data-sources','notion-query-database-view']);
export const notionReads=(tool:string)=>reads.has(tool);
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
function addresses(input:string):string[] {
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
export function notionOwnInput(input:unknown,key=''):boolean {
  if(typeof input==='string')return (!addressKeys.has(key)||notionAddress(input))&&addresses(input).every(notionAddress);
  if(Array.isArray(input))return input.every(item=>notionOwnInput(item,key));
  if(input&&typeof input==='object')return Object.entries(input).every(([name,value])=>notionOwnInput(name)&&notionOwnInput(value,name));
  return true;
}
/** What a job run may fetch without asking, on top of `notionOwnInput`: a page by its raw id or notion.so address, or a data
 *  source or view by id, with nothing beside it but switches, so no other address rides along (ADR-0203, ADR-0225). */
export function notionJobFetch(input:unknown):boolean {
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null,id=value?.id;
  if(typeof id!=='string'||Object.entries(value!).some(([key,option])=>key!=='id'&&typeof option!=='boolean'))return false;
  return !/^(?:user|discussion):/i.test(id)&&notionAddress(id);
}

/**
 * Whether Nocheh may use the owner's Notion, and which Notion calls ask the
 * owner first. The sign-in itself is kept by the management service with the
 * other keys; this store never sees it.
 */
export class NotionRepository {
  constructor(readonly control:pg.Pool){}
  async get(principal:Reader) {
    admin(principal);
    const row=(await this.control.query('SELECT enabled,approval,revision,updated_at FROM owner_notion WHERE singleton')).rows[0];
    return {enabled:!!row?.enabled,approval:(row?.approval??'changes') as NotionApproval,revision:Number(row?.revision??0),updated_at:row?.updated_at??null};
  }
  async save(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['enabled','approval','expected_revision'].includes(key))||body.enabled!==undefined&&typeof body.enabled!=='boolean'||
      body.approval!==undefined&&!approvals.includes(body.approval as NotionApproval)||!Number.isSafeInteger(body.expected_revision))throw new HttpError(400,'invalid_notion_settings');
    const row=(await this.control.query(`UPDATE owner_notion SET enabled=coalesce($1,enabled),approval=coalesce($2,approval),revision=revision+1,updated_at=now()
      WHERE singleton AND revision=$3 RETURNING revision`,[body.enabled??null,body.approval??null,body.expected_revision])).rows[0];
    if(!row)throw new HttpError(409,'notion_settings_changed');
    return this.get(principal);
  }
}

/**
 * A Notion call may come only from the owner's private chat while Notion is
 * on: a live turn there, or a run of a job the owner asked for and approved
 * there. Returns the authority that lets it run without a card under the
 * owner's Notion setting, or null when it waits for approval. `allowed` says
 * the turn may use the setting at all. A job reads group text that anyone
 * there can write, so in a job only reads skip the card (ADR-0203). A read
 * whose input names an address outside the owner's Notion counts as a change,
 * in a live turn and in a job (ADR-0225).
 */
export async function notionAuthority(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null},
  args:{operation?:string;tool?:string;input?:unknown},allowed:boolean):Promise<string|null> {
  if(principal.admin||principal.scope!==null||!turn.owner)throw new HttpError(403,'notion_owner_private_only');
  const row=(await db.query('SELECT enabled,approval,revision FROM owner_notion WHERE singleton FOR SHARE')).rows[0];
  if(!row?.enabled)throw new HttpError(409,'notion_not_enabled');
  if(!allowed||(principal.purpose??'assistant')!=='assistant')return null;
  const tool=String(args.tool??''),read=args.operation==='list'||notionReads(tool)&&notionOwnInput(args.input)&&(!turn.job||tool!=='notion-fetch'||notionJobFetch(args.input));
  return row.approval==='nothing'&&!turn.job||row.approval!=='everything'&&read?'notion_setting:'+row.revision:null;
}

/** What an approved job may do in the owner's Notion without asking: read, or nothing when Notion is off or every call asks. */
export async function notionJobReads(db:Pick<pg.Pool,'query'>):Promise<boolean> {
  const row=(await db.query('SELECT enabled,approval FROM owner_notion WHERE singleton')).rows[0];
  return !!row?.enabled&&row.approval!=='everything';
}
