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

/** Notion MCP tools that only read: search, fetch, and the get, list and query tools. Any other tool changes something. */
export const notionReads=(tool:string)=>/^notion-(?:search|fetch|ai-search|connector-search|(?:get|list|query)-[a-z0-9-]+)$/.test(tool);

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
 * A Notion call may come only from the owner's own live private chat while
 * Notion is on. Returns the authority that lets it run without a card under
 * the owner's Notion setting, or null when it waits for approval.
 */
export async function notionAuthority(db:Pick<pg.PoolClient,'query'>,principal:Reader,turn:{owner?:boolean;job?:string|null},
  args:{operation?:string;tool?:string},live:boolean):Promise<string|null> {
  if(principal.admin||principal.scope!==null||!turn.owner)throw new HttpError(403,'notion_owner_private_only');
  const row=(await db.query('SELECT enabled,approval,revision FROM owner_notion WHERE singleton FOR SHARE')).rows[0];
  if(!row?.enabled)throw new HttpError(409,'notion_not_enabled');
  if(!live||turn.job||(principal.purpose??'assistant')!=='assistant')return null;
  const read=args.operation==='list'||notionReads(String(args.tool??''));
  return row.approval==='nothing'||row.approval==='changes'&&read?'notion_setting:'+row.revision:null;
}
