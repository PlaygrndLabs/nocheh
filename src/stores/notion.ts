import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';

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
/** What a job step may fetch without asking: a page by its raw id, a notion.so address, or a data source or
 *  view by id. Any other address, such as a public *.notion.site page someone else runs, asks: it could carry what the job read. */
export function notionJobFetch(input:unknown):boolean {
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null,id=value?.id;
  if(typeof id!=='string'||Object.entries(value!).some(([key,option])=>key!=='id'&&typeof option!=='boolean'))return false;
  if(notionId.test(id))return true;
  const reference=id.match(/^(?:collection|view):\/\/(.+)$/);if(reference)return notionId.test(reference[1]!);
  try {
    const url=new URL(id);
    return url.protocol==='https:'&&['notion.so','www.notion.so'].includes(url.hostname)&&!url.username&&!url.password&&!url.port;
  }catch{return false;}
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
 * on: a live turn there, or a step of a job the owner asked for and approved
 * there. Returns the authority that lets it run without a card under the
 * owner's Notion setting, or null when it waits for approval. `allowed` says
 * the turn may use the setting at all. A job reads group text that anyone
 * there can write, so in a job only reads skip the card (ADR-0203).
 */
export async function notionAuthority(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null},
  args:{operation?:string;tool?:string;input?:unknown},allowed:boolean):Promise<string|null> {
  if(principal.admin||principal.scope!==null||!turn.owner)throw new HttpError(403,'notion_owner_private_only');
  const row=(await db.query('SELECT enabled,approval,revision FROM owner_notion WHERE singleton FOR SHARE')).rows[0];
  if(!row?.enabled)throw new HttpError(409,'notion_not_enabled');
  if(!allowed||(principal.purpose??'assistant')!=='assistant')return null;
  const tool=String(args.tool??''),read=args.operation==='list'||notionReads(tool)&&(!turn.job||tool!=='notion-fetch'||notionJobFetch(args.input));
  return row.approval==='nothing'&&!turn.job||row.approval!=='everything'&&read?'notion_setting:'+row.revision:null;
}

/** What an approved job may do in the owner's Notion without asking: read, or nothing when Notion is off or every call asks. */
export async function notionJobReads(db:Pick<pg.Pool,'query'>):Promise<boolean> {
  const row=(await db.query('SELECT enabled,approval FROM owner_notion WHERE singleton')).rows[0];
  return !!row?.enabled&&row.approval!=='everything';
}
