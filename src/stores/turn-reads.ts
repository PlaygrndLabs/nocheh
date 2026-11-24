import type pg from 'pg';
import {forwardedMessage} from './owner-member-asks.js';

/*
 * What outside content reached one turn: anything other than the asker's own typed words. A schedule a turn sets after
 * reading outside content is saved paused until its person presses Start (ADR-0294).
 */

/** Why a turn counts as having read outside content: a forward, a file or voice note, a reply to someone else's
 *  message, a web page, or another server's tool (Gmail, Notion, GitHub and the like). */
export type OutsideRead='forward'|'file'|'reply'|'web'|'tools';

const FILES=['document','photo','video','audio','voice','video_note','animation','sticker'];

/**
 * The outside content that reached turn `eventId` so far: from its asking message (a forward, a file, a reply to a
 * message that is not the asker's own) and from the reads it ran (a web page or another server's tool that started).
 * Empty when only the asker's own typed words reached it. A message that cannot be read counts as a forward.
 */
export async function outsideReads(control:Pick<pg.Pool,'query'>,archive:Pick<pg.Pool,'query'>,eventId:string):Promise<OutsideRead[]> {
  const reads=new Set<OutsideRead>();
  const row=(await archive.query<{payload:Buffer}>('SELECT payload FROM events WHERE id=$1',[eventId])).rows[0];
  let message:Record<string,any>|null=null;
  try{const payload=row?JSON.parse(row.payload.toString()):null;message=payload?.message??payload?.edited_message??null;}catch{message=null;}
  if(!message||typeof message!=='object')reads.add('forward');
  else {
    if(forwardedMessage(message))reads.add('forward');
    if(FILES.some(key=>message![key]!==undefined&&message![key]!==null))reads.add('file');
    const replied=message.reply_to_message,quoted=message.external_reply??message.quote;
    if(quoted||replied&&typeof replied==='object'&&(replied.from?.id===undefined||replied.from.id!==message.from?.id||forwardedMessage(replied)||
      FILES.some(key=>replied[key]!==undefined&&replied[key]!==null)))reads.add('reply');
  }
  const ran=(await control.query<{kind:string}>(`SELECT DISTINCT kind FROM controlled_actions WHERE event_id=$1 AND kind IN ('browser','mcp')
    AND state IN ('running','done','ambiguous','failed')`,[eventId])).rows;
  for(const {kind} of ran)reads.add(kind==='browser'?'web':'tools');
  return [...reads].sort();
}
