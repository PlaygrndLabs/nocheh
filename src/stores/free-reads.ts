import type pg from 'pg';
import {digest} from '../archive.js';
import {freeReadLimit,messageLinks,noLinks,pageLinkLimit,type MessageLinks,type OpenedPage} from '../link-check.js';

/**
 * What one asking message lets Nocheh open without a card (ADR-0263): its own links and words, the pages already opened
 * for it, and how many reads it has opened without a card so far.
 */

/** The links and words of the message a turn answers, from its captured original; none for anything else. */
export async function turnMessageLinks(archive:Pick<pg.Pool,'query'>,event:string):Promise<MessageLinks> {
  const row=(await archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
  if(!row)return noLinks();
  try{return messageLinks(JSON.parse(row.payload.toString()));}catch{return noLinks();}
}

/** The pages opened for a message so far: each finished page read's address, the links it returned, and why it opened.
 *  A result whose content no longer matches its record is left out. */
export async function turnPages(control:Pick<pg.Pool,'query'>,derived:Pick<pg.Pool,'query'>,event:string):Promise<OpenedPage[]> {
  const rows=(await control.query(`SELECT result_reference,free_read FROM controlled_actions
    WHERE event_id=$1 AND kind='browser' AND state='done' AND result_reference IS NOT NULL ORDER BY created_at,id LIMIT 50`,[event])).rows;
  const pages:OpenedPage[]=[];
  for(const row of rows) {
    const output=(await derived.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0];
    if(!output||output.content_hash!==row.result_reference.input_hash||digest(output.content)!==output.content_hash)continue;
    try {
      const result=JSON.parse(output.content.toString())?.result;
      if(typeof result?.url==='string')pages.push({url:result.url,links:result.links,free:row.free_read});
    }catch{continue;}
  }
  return pages;
}

/** How many more reads a message may open without a card, in all and from links on its pages. Call it inside the
 *  proposal's transaction: the lock orders the message's proposals, so two at once cannot both take the last one. */
export async function freeReadsLeft(db:Pick<pg.PoolClient,'query'>,event:string):Promise<{all:number;pages:number}> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,263))',['free-reads:'+event]);
  const row=(await db.query(`SELECT count(*) FILTER (WHERE free_read IS NOT NULL) AS total,count(*) FILTER (WHERE free_read='page') AS pages
    FROM controlled_actions WHERE event_id=$1`,[event])).rows[0];
  return {all:freeReadLimit-Number(row.total),pages:pageLinkLimit-Number(row.pages)};
}
