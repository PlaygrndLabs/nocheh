import type pg from 'pg';
import type {Reader} from '../access.js';
import {telegramTopicOpening} from '../chats-telegram.js';
import {forwardOrigin} from '../forwarded.js';
import {HttpError,object} from '../http.js';
import {ownerTyped,sourceFacts} from '../source-facts.js';
import {albumMembers} from './albums.js';

/**
 * What reached an owner turn's agent besides the owner's own typed words (ADR-0293). "Do what I ask" runs a command
 * with no card only when nothing did: no forward, file, quoted reply or voice note in the message, nothing outside
 * earlier in the agent's conversation, and nothing read in the turn before the command was asked for.
 *
 * Three sources, read by code, never by what the content says:
 * - the asking message itself, read here from its captured original, album parts included;
 * - the conversation the agent's runtime loads for the turn, which only the runtime holds: its parent process, outside
 *   the model's reach, reports what it holds before the model starts ('conversation'), and a turn it has not reported
 *   counts as outside, so an agent that never reports always gets a card;
 * - each tool result the runtime hands the model during the turn ('turn'), recorded before the model sees it, and each
 *   operation of this message that came back with a result.
 * Reads only accumulate: a turn never turns clean again.
 */

/** The read tokens a runtime reports, as Hermes's notes record them (services/hermes/note_sources.py READS), less the
 *  ones a command never counts: a command's own output ('commands'). */
export const turnReadTokens=['forward','file','recent','reply','archive','web','notion','tools','past','other'] as const;
export type TurnRead=typeof turnReadTokens[number];
/** Why a command asked first: a read token, or 'unchecked' for a conversation its runtime did not report. */
export type OutsideRead=TurnRead|'unchecked';
export const isTurnRead=(value:unknown):value is TurnRead=>typeof value==='string'&&(turnReadTokens as readonly string[]).includes(value);

export const turnReadsSchema=`
CREATE TABLE IF NOT EXISTS turn_reads (
 event_id text NOT NULL CHECK(event_id ~ '^[a-f0-9]{64}$'),
 origin text NOT NULL CHECK(origin IN ('conversation','turn')),
 read text NOT NULL CHECK(read IN ('none',${turnReadTokens.map(token=>`'${token}'`).join(',')})),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id,origin,read)
);
`;

/** Records what a turn's runtime reports, for the turn's own message. A conversation report with nothing outside is kept
 *  as 'none', so a reported conversation tells from one never reported; a tool result that read nothing outside is not
 *  kept. Only adds: nothing removes a read. */
export async function recordTurnReads(control:Pick<pg.Pool,'query'>,principal:Reader,origin:'conversation'|'turn',reads:readonly TurnRead[]):Promise<void> {
  if(principal.admin||!principal.turnEvent||!/^[a-f0-9]{64}$/.test(principal.turnEvent))throw new HttpError(403,'scoped_turn_required');
  const values=[...new Set(reads)];
  if(!values.length&&origin==='turn')return;
  await control.query(`INSERT INTO turn_reads(event_id,origin,read) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`,
    [principal.turnEvent,origin,values.length?values:['none']]);
}
/** A conversation report's body: {reads:[...]} with known tokens only; anything else is refused whole. */
export function conversationReads(value:unknown):TurnRead[] {
  const body=object(value),reads=body.reads;
  if(Object.keys(body).some(key=>key!=='reads')||!Array.isArray(reads)||reads.length>turnReadTokens.length*2||!reads.every(isTurnRead))
    throw new HttpError(400,'invalid_turn_reads');
  return reads;
}

const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
/** The parts of a Telegram message that carry a file or recording: what the agent reads as an attachment or a transcript. */
const fileFields=['document','photo','audio','voice','video','video_note','animation','sticker','paid_media','story'];
const carriesFile=(message:Record<string,any>)=>fileFields.some(field=>message[field]!==undefined&&message[field]!==null);
/** Whether a message the owner's message replies to is the owner's own typed message: theirs, no forward of someone
 *  else's, no quote, pin or embedded words of someone else's, and no file or recording. Nocheh's own messages and
 *  anyone else's are not. */
function ownTypedTarget(target:Record<string,any>,owner:string|null):boolean {
  const facts=sourceFacts({channel:'telegram',kind:'telegram_update',payload:{message:target},owner_chat:true},owner);
  return ownerTyped(facts)&&!carriesFile(target);
}
/** What one captured Telegram message carries besides its sender's typed words, for the owner's private chat. */
export function messageReads(payload:unknown,owner:string|null):TurnRead[] {
  const reads=new Set<TurnRead>();
  const message=record(record(payload)?.message);
  if(!message)return ['other'];
  const forward=forwardOrigin(message);
  if(forward&&forward.from!=='own')reads.add('forward');
  const facts=sourceFacts({channel:'telegram',kind:'telegram_update',payload,owner_chat:true},owner);
  if(facts.author!=='owner')reads.add('other');
  if(facts.quote==='other')reads.add('reply');
  if(facts.pinned==='other')reads.add('other');
  if(carriesFile(message))reads.add('file');
  // A reply shows the agent the message it answers; a forum topic's opening is no reply (ADR-0261).
  const target=record(message.reply_to_message);
  if(target&&!telegramTopicOpening(target)&&!ownTypedTarget(target,owner))reads.add('reply');
  if(record(message.external_reply))reads.add('reply');
  return [...reads];
}
/** What the message a turn answers carries besides the owner's typed words, album parts and archived files included. */
export async function askingMessageReads(archive:pg.Pool,event:string,owner:string|null):Promise<TurnRead[]> {
  const ids=[...new Set([event,...(await albumMembers(archive,event)).map(member=>member.id)])];
  const rows=(await archive.query('SELECT id,payload FROM events WHERE id=ANY($1::text[])',[ids])).rows;
  const reads=new Set<TurnRead>();
  if(!rows.some(row=>row.id===event))reads.add('other');
  for(const row of rows) {
    let payload:unknown=null;
    try{payload=JSON.parse((row.payload as Buffer).toString());}catch{reads.add('other');continue;}
    for(const read of messageReads(payload,owner))reads.add(read);
  }
  if((await archive.query('SELECT 1 FROM artifacts WHERE event_id=ANY($1::text[]) LIMIT 1',[ids])).rowCount)reads.add('file');
  return [...reads];
}
/**
 * Why a command in this turn may not run under "Do what I ask", or an empty list when only the owner's typed words
 * reached it (ADR-0293): its message, its runtime's report of the conversation and of each tool result, and the
 * operations of this message that came back with a result. Call it inside the proposal's transaction.
 */
export async function outsideReads(db:Pick<pg.PoolClient,'query'>,archive:pg.Pool,event:string,owner:string|null):Promise<OutsideRead[]> {
  const reads=new Set<OutsideRead>(await askingMessageReads(archive,event,owner));
  const reported=(await db.query('SELECT origin,read FROM turn_reads WHERE event_id=$1',[event])).rows;
  if(!reported.some(row=>row.origin==='conversation'))reads.add('unchecked');
  for(const row of reported)if(isTurnRead(row.read))reads.add(row.read);
  // A page read, a connected service's lookup or another server's tool that came back for this message.
  const results=(await db.query(`SELECT DISTINCT kind FROM controlled_actions WHERE event_id=$1 AND kind IN ('browser','mcp')
    AND state IN ('done','ambiguous') AND result_reference IS NOT NULL`,[event])).rows;
  for(const row of results)reads.add(row.kind==='browser'?'web':'tools');
  return [...reads].sort();
}
