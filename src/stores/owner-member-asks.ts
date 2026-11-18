import type pg from 'pg';
import {randomBytes} from 'node:crypto';
import {memberReadId,type Reader} from '../access.js';
import {conversationScope,type AssistantPolicy} from '../assistant-policy.js';
import {labelName,nameKey} from '../chat-labels.js';
import {chats} from '../chats.js';
import {telegramUsername} from '../chats-telegram.js';
import {HttpError,object,string} from '../http.js';
import {freshMembers,type Member} from '../members.js';
import {memberPrivate} from '../spaces.js';
import {requestWorkflow} from '../workflows/store.js';
import type {CapturedSource} from './archive.js';
import {peopleNames} from './people-names.js';

/*
 * The owner asks about a member (step 4b, ADR-0262). When the owner's own, not forwarded, message in the owner's private
 * chat names a member and asks what they said to Nocheh, the owner's turn records one row here and answers only that it
 * is queued. After that turn ends, a worker runs one read-only turn whose pass carries the row's id (the memberRead
 * claim, src/access.ts) and reads only that member's own private chat. Its answer goes to the owner's private chat as
 * a separate message of the never learned, never consentable send class member_read, and is then dropped: it is never
 * carried into the owner's ongoing conversation.
 *
 * In the control store after the member tables (member-schema.ts). Created only if missing, so the control bootstrap
 * runs again as a no-op. Removing a member removes their asks.
 * - id: the ask's id, 32 hex, also the memberRead claim.
 * - owner_event: the owner's message that asked (an event id).
 * - member_id: the member asked about.
 * - question: the owner's question as the owner's turn put it.
 * - state: queued, running, answered, failed or expired; error_code says why it failed.
 * - created_at, started_at, answered_at, expires_at: when it was asked, its turn started, its answer went out, and the
 *   time after which it no longer runs.
 * - send_key: the dispatch key its answer was sent under, to find the member_read send.
 *
 * The repository and the ask guard are below; the worker that answers an ask is owner-member-ask-turns.ts.
 */
export const ownerMemberAskStates=['queued','running','answered','failed','expired'] as const;
export type OwnerMemberAskState=typeof ownerMemberAskStates[number];
/** The longest question a row keeps. */
export const OWNER_MEMBER_ASK_QUESTION_LIMIT=4000;

export const ownerMemberAskSchema=`
CREATE TABLE IF NOT EXISTS owner_member_asks (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 owner_event text NOT NULL CHECK(owner_event ~ '^[a-f0-9]{64}$'),
 member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 question text NOT NULL CHECK(length(btrim(question))>0 AND length(question)<=${OWNER_MEMBER_ASK_QUESTION_LIMIT}),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN (${ownerMemberAskStates.map(state=>`'${state}'`).join(',')})),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 answered_at timestamptz,
 expires_at timestamptz NOT NULL,
 send_key text CHECK(send_key IS NULL OR length(send_key) BETWEEN 1 AND 256),
 UNIQUE(owner_event,member_id),
 CHECK(state<>'answered' OR answered_at IS NOT NULL),
 CHECK(state<>'failed' OR error_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS owner_member_asks_open ON owner_member_asks(state,created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS owner_member_asks_member ON owner_member_asks(member_id);
-- The worker's own columns (owner-member-ask-turns.ts): its attempt count, the turn input and binding it built, when it
-- may run next, and when the row last changed.
ALTER TABLE owner_member_asks ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE owner_member_asks ADD COLUMN IF NOT EXISTS input_reference jsonb;
ALTER TABLE owner_member_asks ADD COLUMN IF NOT EXISTS binding jsonb;
ALTER TABLE owner_member_asks ADD COLUMN IF NOT EXISTS next_attempt timestamptz NOT NULL DEFAULT now();
ALTER TABLE owner_member_asks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
`;
/** How long an ask may wait for its turn: past this it expires and is never answered. */
export const OWNER_MEMBER_ASK_MINUTES=30;
/** How many members one owner message may ask about. */
export const OWNER_MEMBER_ASKS_PER_MESSAGE=3;
/** The workflow job that answers an ask, in the telegram family: `ask:<id>`. */
export const ownerMemberAskJob=(id:string)=>'ask:'+id;

export interface OwnerMemberAsk {id:string;owner_event:string;member_id:string;question:string;state:OwnerMemberAskState;error_code:string|null;
  created_at:Date;started_at:Date|null;answered_at:Date|null;expires_at:Date;send_key:string|null;attempts:number;
  input_reference:unknown;binding:unknown;next_attempt:Date;updated_at:Date}

/** A member the ask guard may name: their id, the names Telegram shows for their accounts now (peopleNames: a display
 * name and an @username each), and how the answer names them. */
export interface AskableMember {readonly id:string;readonly names:readonly string[];readonly label:string}
export type AskRefusal='member_ask_not_owner'|'member_ask_forwarded'|'member_ask_not_named'|'member_not_found'|'member_name_ambiguous';

/** A message Telegram says was forwarded, or sent on automatically from a channel: never the owner's own words. */
export function forwardedMessage(message:Record<string,unknown>):boolean {
  return ['forward_origin','forward_from','forward_from_chat','forward_from_message_id','forward_sender_name','forward_signature','forward_date']
    .some(key=>message[key]!==undefined&&message[key]!==null)||message.is_automatic_forward===true;
}
const letter=/[\p{L}\p{N}\p{M}_]/u;
/** A name's comparable form: lower-cased first, as the skeleton keeps a capital I apart from a small one, then its skeleton
 * (nameKey). */
const askKey=(name:string)=>nameKey(name.toLowerCase());
/** Whether `text` holds `name` as a name of its own: compared as the same lower-cased skeleton (askKey), and not part of a
 * longer word. */
export function namesIn(text:string,name:string):boolean {
  const haystack=askKey(text),needle=askKey(name.trim());
  if(!needle)return false;
  for(let at=haystack.indexOf(needle);at>=0;at=haystack.indexOf(needle,at+1)) {
    const before=Array.from(haystack.slice(0,at)).at(-1),after=Array.from(haystack.slice(at+needle.length))[0];
    if((before===undefined||!letter.test(before))&&(after===undefined||!letter.test(after)))return true;
  }
  return false;
}
/** Whether `asked` (the ask tool's member argument) is this name: the same skeleton, an @username with or without its @. */
const sameName=(asked:string,name:string)=>{
  const wanted=asked.trim(),key=askKey(wanted);
  return !!key&&(key===askKey(name.trim())||name.startsWith('@')&&!wanted.startsWith('@')&&askKey('@'+wanted)===askKey(name));
};

/**
 * The ask guard (D12): the message a turn answers may ask about a member only when it is the owner's own message in the
 * owner's private chat (conversationScope says so), not forwarded, and its own text names that very member by a name
 * Telegram shows for them now. The member is the one `asked` names (the tool's argument); a name two members share is
 * refused rather than guessed. A name only in the tool's arguments, a quote, a forward or a tool's output records
 * nothing: only the message's own text and caption are read.
 */
export function askGuard(policy:AssistantPolicy,payload:unknown,scope:string,people:readonly AskableMember[],asked:string):{member:AskableMember}|{refused:AskRefusal} {
  let selected:ReturnType<typeof conversationScope>=null;
  try{selected=conversationScope(policy,payload,scope);}catch{selected=null;}
  const message=(payload as {message?:unknown}|null)?.message;
  if(!selected?.owner||!message||typeof message!=='object'||String((message as {from?:{id?:unknown}}).from?.id)!==policy.owner_id||
    (message as {sender_chat?:unknown}).sender_chat!=null)return {refused:'member_ask_not_owner'};
  if(forwardedMessage(message as Record<string,unknown>))return {refused:'member_ask_forwarded'};
  const found=people.filter(person=>person.names.some(name=>sameName(asked,name)));
  if(!found.length)return {refused:'member_not_found'};
  if(found.length>1)return {refused:'member_name_ambiguous'};
  const own=[(message as {text?:unknown}).text,(message as {caption?:unknown}).caption].filter((part):part is string=>typeof part==='string').join('\n');
  return found[0]!.names.some(name=>namesIn(own,name))?{member:found[0]!}:{refused:'member_ask_not_named'};
}

/** What an ask tells the owner's turn: the record's id and state, and who it asks about as the answer will name them. */
export interface AskQueued {id:string;state:OwnerMemberAskState;member:string}

/**
 * The owner's asks about a member (step 4b). An ask is recorded only from a live owner-private turn (ownerTurn, checked
 * first), only for the owner's own Telegram message there that passes the ask guard, and only about an active member
 * whose own private chat with Nocheh is open (memberPrivate). The same message asking again about the same member gets
 * the same row. A new row requests its workflow job in the same commit; the worker answers it after the asking turn.
 */
export class OwnerMemberAskRepository {
  constructor(readonly control:pg.Pool,readonly archive:pg.Pool,readonly policy:()=>AssistantPolicy,
    readonly ownerTurn:(principal:Reader)=>Promise<{source:CapturedSource}>){}
  /** The members who may be asked about, with the names Telegram shows for each of their accounts now. */
  async askable():Promise<{people:AskableMember[];members:Map<string,Member>}> {
    const directory=await freshMembers(),all=directory.all(),accounts=all.flatMap(member=>member.accounts.map(account=>({account})));
    const names=await peopleNames(this.control,chats(),this.policy(),accounts);
    const people:AskableMember[]=[],byId=new Map<string,Member>();
    for(const member of all) {
      const shown=member.accounts.flatMap(account=>{const person=names.people.get(account),username=telegramUsername(person?.username);
        return [...(person?.display_name?.trim()?[person.display_name.trim()]:[]),...(username?['@'+username]:[])];});
      if(!shown.length)continue;
      const label=labelName(shown.find(name=>!name.startsWith('@'))??shown[0]!)??'a member';
      people.push({id:member.id,names:[...new Set(shown)],label});byId.set(member.id,member);
    }
    return {people,members:byId};
  }
  async ask(principal:Reader,input:unknown):Promise<AskQueued> {
    const {source}=await this.ownerTurn(principal);
    const body=object(input);
    if(Object.keys(body).some(key=>!['member','question'].includes(key)))throw new HttpError(400,'invalid_member_ask');
    const asked=string(body.member,200),question=string(body.question,OWNER_MEMBER_ASK_QUESTION_LIMIT).trim();
    if(!asked.trim()||!question)throw new HttpError(400,'invalid_member_ask');
    // Only the owner's own Telegram message: the answer goes to the owner's Telegram chat.
    if(source.channel!=='telegram'||source.kind!=='telegram_update'||source.origin!=='live')throw new HttpError(403,'member_ask_not_owner');
    const original=(await this.archive.query('SELECT payload,scope FROM events WHERE id=$1',[source.reference.id])).rows[0];
    if(!original)throw new HttpError(403,'member_ask_not_owner');
    const {people,members}=await this.askable();
    const guard=askGuard(this.policy(),JSON.parse(original.payload.toString()),String(original.scope),people,asked);
    if('refused' in guard)throw new HttpError(guard.refused==='member_not_found'?404:guard.refused==='member_name_ambiguous'?409:403,guard.refused);
    const member=members.get(guard.member.id)!;
    // Their own private chat with Nocheh must be open now, and be the only one: a member paused, removed or with private
    // chat off, or one Nocheh has no private chat with, is not asked about.
    const own=chats().all().filter(chat=>chat.kind==='private'&&chat.account_id!==null&&member.accounts.includes(chat.account_id));
    if(member.state!=='active'||!member.privateChat||own.length!==1||!memberPrivate(own[0]!.id))throw new HttpError(409,'member_chat_closed');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      // One owner message's asks are taken one at a time, so the cap holds.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('member-ask-event:'||$1,803364))",[source.reference.id]);
      let row=(await db.query<OwnerMemberAsk>('SELECT * FROM owner_member_asks WHERE owner_event=$1 AND member_id=$2',[source.reference.id,member.id])).rows[0];
      if(!row) {
        const count=Number((await db.query('SELECT count(*) FROM owner_member_asks WHERE owner_event=$1',[source.reference.id])).rows[0].count);
        if(count>=OWNER_MEMBER_ASKS_PER_MESSAGE)throw new HttpError(409,'member_ask_limit');
        row=(await db.query<OwnerMemberAsk>(`INSERT INTO owner_member_asks(id,owner_event,member_id,question,expires_at)
          VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5)) RETURNING *`,[randomBytes(16).toString('hex'),source.reference.id,member.id,question,OWNER_MEMBER_ASK_MINUTES])).rows[0]!;
        await requestWorkflow(db,'telegram',ownerMemberAskJob(row.id));
      }
      await db.query('COMMIT');
      return {id:row.id,state:row.state,member:guard.member.label};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async row(id:string):Promise<OwnerMemberAsk|null> {
    return memberReadId.test(id)?(await this.control.query<OwnerMemberAsk>('SELECT * FROM owner_member_asks WHERE id=$1',[id])).rows[0]??null:null;
  }
}
