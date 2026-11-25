import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, object, string } from './http.js';
import type pg from 'pg';
import {policyRevision,validateSpace,type ReadSet} from './spaces.js';
import {guardState} from './guarded.js';
import {activeAgent} from './agent/agents.js';
import {chatApps,type AppBinding} from './chat-wire.js';
import {chats,chatsAfterMiss} from './chats.js';

export interface Reader {readonly scope:string|null; readonly admin:boolean;readonly turnEvent?:string;readonly space?:string;readonly revision?:number;readonly guard_epoch?:number;readonly generation?:string;readonly logical_profile?:string;readonly purpose?:'assistant'|'memory-review'|'filter';readonly agent?:string;
  /** The "Answer privately" record this turn answers (32 hex, ADR-0249). Signed in a turn pass, and only in one whose
   * scope and space are the asker's private chat; it never makes the pass an owner pass. */
  readonly answer?:string;
  /** The conversations an answer reader may read, resolved on the server from the frozen record for every request.
   * Never taken from a pass: a pass that names one is refused. Absent means the reader's own recall scope. */
  readonly reads?:ReadSet;
  /** The app a turn pass is bound to (ADR-0252): its chat's current app id and topic. Signed only in a turn pass and
   * checked by the front door that receives the turn; storage does not require it, so job passes carry none. */
  readonly app?:AppBinding;
  /** The member whose own private chat this turn is in (64 hex, a members.id; step 4, ADR-0262). Signed in a turn pass,
   * and only in one whose scope and space are a private chat that is not the owner's (otherPrivate); refused anywhere
   * else. It never makes the pass an owner pass, and storage never trusts it alone: bindReads checks it against the
   * chat's account on every request. */
  readonly member?:string;
  /** The owner's ask about a member this turn answers (32 hex, an owner_member_asks.id; step 4b). Signed in a turn pass
   * under the claim name member_read, and only in one whose scope and space are the owner's private chat, as answer is;
   * it never makes the pass an owner pass. */
  readonly memberRead?:string;
  /** The one private chat that is not the owner's which this reader may read: a member's own chat for a member reader,
   * the asked member's chat for a memberRead reader. Set only on the server, by bindReads, for every request; never
   * taken from a pass: a pass that names one is refused, as reads is. Every other reader reads no such chat. */
  readonly memberChat?:string;
  /** What a run of a job on the owner's machine may read: only what its card showed, frozen when the owner approved it
   * (machine jobs' reads). Set only on the server, by bindMachine, for every request of a pass whose turn is such a run;
   * never taken from a pass: a pass that names one is refused, as reads is. */
  readonly machineReads?:MachineReads;
  /** Who this one-time key is for (ADR-0305): 'owner' or a members.id. Signed in every pass and checked against its claims;
   * it never widens what the pass reads, which the server derives for every request as before. */
  readonly person?:string;
  /** The one-time key's own id (32 hex, a one_time_keys.jti), checked open on every request. */
  readonly jti?:string;
  /** What the one-time key is for (KeyKind): it decides which routes the pass reaches (key-routes.ts). */
  readonly keyKind?:KeyKind}
/** What a one-time key is for (ADR-0305): a reply turn, a follow-up after actions, the owner's ask about a member, a
 * scheduled run, a background job's run, a memory review or a sharing filter. */
export const keyKinds=['turn','follow_up','member_ask','scheduled','background','review','filter'] as const;
export type KeyKind=typeof keyKinds[number];
export const isKeyKind=(value:unknown):value is KeyKind=>(keyKinds as readonly unknown[]).includes(value);
/** A one-time key's id: 32 lowercase hex. */
export const keyIdPattern=/^[a-f0-9]{32}$/;
/** A machine job's reads (machine jobs' reads): its one chat, its period (dates as the job was asked, or null for the
 * whole chat), the last archive capture sequence when the owner approved it (a decimal string), and the Notion pages its
 * card named. */
export type MachineReads={readonly job:string;readonly chat:string;readonly from:string|null;readonly to:string|null;readonly until:string;readonly notion:readonly string[]};
/** The id of an "Answer privately" record: also the button's data after `np` and the private chat's /start parameter. */
export const answerId=/^[a-f0-9]{32}$/;
/** A member id (members.id) and a lane (the member id of a member's turn, step 4): 64 hex. */
export const memberClaimId=/^[a-f0-9]{64}$/;
/** The id of an owner's ask about a member (owner_member_asks.id, step 4b): 32 hex. */
export const memberReadId=/^[a-f0-9]{32}$/;
/** A one-time key's person: the owner, or a member by their members.id (ADR-0305). */
export const personClaim=(value:unknown):value is string=>value==='owner'||typeof value==='string'&&memberClaimId.test(value);
/** The bound readers: a turn that reads as someone other than the owner, its reads resolved on the server for every
 * request (bindReads) and limited to reading (ADR-0249, ADR-0262). */
export type BoundReader='answer'|'member'|'memberRead';
/** The 403 code each bound reader gets for anything but reading: an answer keeps ADR-0249's, a member's private chat and
 * the owner's ask about a member share step 4's. */
export const boundReaderReadOnly:Readonly<Record<BoundReader,string>>={answer:'private_answer_read_only',member:'member_private_read_only',
  memberRead:'member_private_read_only'};
/**
 * Which bound reader a reader is: an "Answer privately" answer, a member in their own private chat, or the owner's ask
 * about a member; null for every other reader. A parsed pass carries at most one of the three claims. Every check that
 * holds for any bound reader asks this, never one claim alone.
 */
export function boundReader(principal:Pick<Reader,'answer'|'member'|'memberRead'>):BoundReader|null {
  if(principal.answer!==undefined)return 'answer';
  if(principal.memberRead!==undefined)return 'memberRead';
  if(principal.member!==undefined)return 'member';
  return null;
}
/**
 * The read set an ordinary scoped reader was given for this request: its project's groups while that project shares its
 * group chats (ADR-0267). Undefined for the owner, the dashboard, a bound reader (whose reads are its own) and a group
 * reader whose project does not share, which read their own recall scope. Set only on the server by bindReads, as a
 * bound reader's reads are; a pass that names one is refused.
 */
export function sharedReads(principal:Pick<Reader,'admin'|'scope'|'reads'|'answer'|'member'|'memberRead'>):ReadSet|undefined {
  return !principal.admin&&principal.scope!==null&&boundReader(principal)===null?principal.reads:undefined;
}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
/** The agent a turn's pass is for: the one plugged into the agent socket (ADR-0234). The pass names it so its effects can be told apart (ADR-0233). */
export const defaultAgent=activeAgent;
const agentName=/^[a-z][a-z0-9-]{0,31}$/;
/**
 * A turn pass. `member` (a member's own private chat), `lane` (a member's turn, in a group or their private chat: the
 * member id, for Hermes to run one turn at a time per member; storage parses it and drops it) and `memberRead` (signed
 * as the claim member_read: the owner's ask about a member) are step 4's claims; verifiedReader says where each is
 * allowed. Every pass is a one-time key (ADR-0305): `person`, `jti` and `kind` (signed as key_kind) are required by
 * verifiedReader, which refuses a pass without them; they are optional here only for code that never reaches a server.
 * Only AudienceRepository.turn mints passes, each with its key row.
 */
export function turnToken(secret:string,scope:string|null,expires:number,eventId:string,policy?:{space:string;revision:number;guard_epoch?:number;generation?:string;logical_profile?:string;purpose?:'assistant'|'memory-review'|'filter';project?:string;agent?:string;answer?:string;app?:AppBinding;
  member?:string;lane?:string;memberRead?:string;person?:string;jti?:string;kind?:KeyKind}):string {
  const {memberRead,kind,...claims}=policy??{};
  const body=Buffer.from(JSON.stringify({scope,expires,event_id:eventId,audience:'nocheh-assistant',agent:defaultAgent,...claims,
    ...(memberRead===undefined?{}:{member_read:memberRead}),...(kind===undefined?{}:{key_kind:kind})})).toString('base64url');
  return `turn.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
const appText=/^[A-Za-z0-9._:-]{1,128}$/,appTopic=/^[A-Za-z0-9._-]{1,64}$/;
/** A turn pass's app binding, exactly {app, chat, topic}; anything else refuses the pass. */
export function appBinding(value:unknown):AppBinding {
  const claim=object(value);
  if(Object.keys(claim).sort().join()!=='app,chat,topic'||!(chatApps as readonly unknown[]).includes(claim.app)||
    typeof claim.chat!=='string'||!appText.test(claim.chat)||claim.topic!==null&&(typeof claim.topic!=='string'||!appTopic.test(claim.topic)))
    throw new HttpError(400,'invalid_app_binding');
  return {app:claim.app as AppBinding['app'],chat:claim.chat,topic:claim.topic as string|null};
}
/** The owner's private chat itself, never one of its topics, as the chat directory knows it. */
const ownersPrivateChat=(id:string,missed:()=>void)=>{const chat=chats().get(id);if(!chat)missed();return chat?.kind==='private'&&chat.owner;};
/** A private chat itself that is not the owner's (never a topic), as the chat directory knows it: where a member claim
 * may be. */
const othersPrivateChat=(id:string,missed:()=>void)=>{const chat=chats().get(id);if(!chat)missed();return chat?.kind==='private'&&!chat.owner;};
export function reader(req:IncomingMessage,secret:string,now=Date.now()):Reader {return verifiedReader(req,secret,now,()=>{});}
/**
 * reader() for a server that can wait: a signed pass naming a chat or topic this process's chat directory does not hold
 * yet (another process recorded it a moment ago: a new forum topic's first message) is read again once the directory has
 * looked again, instead of being refused at once. Still unknown after that, it is refused as before (ADR-0252).
 */
export async function currentReader(req:IncomingMessage,secret:string,now=Date.now()):Promise<Reader> {
  let missed=false;
  try {return verifiedReader(req,secret,now,()=>{missed=true;});}
  catch(error) {if(!missed||!await chatsAfterMiss())throw error;}
  return reader(req,secret,now);
}
function verifiedReader(req:IncomingMessage,secret:string,now:number,missed:()=>void):Reader {
  if (!req.headers.authorization?.startsWith('Bearer ')) throw new HttpError(401,'unauthorized');
  const bearer=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
  if (equal(bearer,secret)) return {scope:null,admin:true};
  try {
    const [prefix,body,signature,extra]=bearer.split('.');
    // Every pass is a turn pass and a one-time key (ADR-0305): the archive-wide `scope.` pass is gone.
    if (prefix!=='turn' || !body || !signature || extra || body.length>2048 || !equal(signature,createHmac('sha256',secret).update(body).digest('base64url'))) throw Error();
    const claims=object(JSON.parse(Buffer.from(body,'base64url').toString()));
    if (claims.audience!=='nocheh-assistant' || typeof claims.expires!=='number' || claims.expires<=now || claims.expires>now+3600000) throw Error();
    const scope=claims.scope===null ? null : string(claims.scope,256);
    if (scope==='') throw Error();
    if(typeof claims.event_id!=='string' || !/^[a-f0-9]{64}$/.test(claims.event_id))throw Error();
    let policy:{}|{space:string;revision:number}={};
    if(claims.space!==undefined || claims.revision!==undefined){
      const space=validateSpace(claims.space);
      // A scoped pass reads as its chat, in the chat itself or one of its topics, as the chat directory says; never by
      // the shape of an id, and a topic the directory does not know belongs to no chat (ADR-0252, fail closed).
      if(!Number.isSafeInteger(claims.revision)||Number(claims.revision)<1)throw Error();
      if(scope!==null&&space!==scope&&chats().parentOf(space)!==scope){if(!chats().get(space))missed();throw Error();}
      policy={space,revision:claims.revision as number};
    }
    if(claims.guard_epoch!==undefined&&(!Number.isSafeInteger(claims.guard_epoch)||Number(claims.guard_epoch)<1))throw Error();
    if(claims.generation!==undefined&&(typeof claims.generation!=='string'||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(claims.generation)))throw Error();
    if(claims.purpose!==undefined&&!['assistant','memory-review','filter'].includes(String(claims.purpose)))throw Error();
    if(claims.logical_profile!==undefined&&(!claims.generation||typeof claims.logical_profile!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(claims.logical_profile)))throw Error();
    if(claims.project!==undefined&&(typeof claims.project!=='string'||!/^[a-f0-9]{64}$/.test(claims.project)))throw Error();
    // The pass is for the agent plugged in now, never another (ADR-0305); a pass for any other agent is no pass.
    if(typeof claims.agent!=='string'||!agentName.test(claims.agent)||claims.agent!==activeAgent)throw Error();
    // The one-time key it is (ADR-0305): its id, its person and its kind. Storage and the broker check its row is open.
    if(typeof claims.jti!=='string'||!keyIdPattern.test(claims.jti)||!personClaim(claims.person)||!isKeyKind(claims.key_kind))throw Error();
    const person=claims.person,kind=claims.key_kind;
    // An answer pass reads as the asker's private chat, never as the owner: its scope and space are that chat, a private
    // chat row of the owner's (ADR-0249, ADR-0252).
    if(claims.answer!==undefined&&(typeof claims.answer!=='string'||!answerId.test(claims.answer)||scope===null||
      !ownersPrivateChat(scope,missed)||!('space' in policy)||policy.space!==scope))throw Error();
    // A member pass reads as the member's own private chat: its scope and space are a private chat that is not the
    // owner's (step 4). Which member's chat it is, bindReads checks on the server for every request.
    if(claims.member!==undefined&&(typeof claims.member!=='string'||!memberClaimId.test(claims.member)||scope===null||
      !othersPrivateChat(scope,missed)||!('space' in policy)||policy.space!==scope))throw Error();
    // An ask about a member reads as the owner's private chat, never as the owner, as an answer does (step 4b).
    if(claims.member_read!==undefined&&(typeof claims.member_read!=='string'||!memberReadId.test(claims.member_read)||scope===null||
      !ownersPrivateChat(scope,missed)||!('space' in policy)||policy.space!==scope))throw Error();
    // A pass is at most one bound reader.
    if([claims.answer,claims.member,claims.member_read].filter(claim=>claim!==undefined).length>1)throw Error();
    // A lane is the member id of a member's turn, for Hermes's per-member order. Checked for shape and then dropped: it
    // never reaches a Reader and grants nothing.
    if(claims.lane!==undefined&&(typeof claims.lane!=='string'||!memberClaimId.test(claims.lane)))throw Error();
    // What an answer, a member or an ask may read comes from the server, never from the pass; a claim spelled the
    // Reader's way is no claim and is refused rather than ignored.
    if(claims.reads!==undefined||claims.member_chat!==undefined||claims.memberChat!==undefined||claims.memberRead!==undefined||
      claims.machine_reads!==undefined||claims.machineReads!==undefined)throw Error();
    // The key's person fits the pass: a member's own chat is that member's, a lane is its member's, and the owner's
    // chat, an answer and an ask are the owner's. Its kind fits the pass's purpose (ADR-0305).
    // The claims are checked above, so each present one is a string.
    const bound=boundReader({...('answer' in claims?{answer:String(claims.answer)}:{}),...('member' in claims?{member:String(claims.member)}:{}),
      ...('member_read' in claims?{memberRead:String(claims.member_read)}:{})});
    if(claims.member!==undefined&&person!==claims.member||claims.lane!==undefined&&person!==claims.lane||
      (scope===null||bound==='answer'||bound==='memberRead')&&person!=='owner')throw Error();
    if((claims.purpose==='memory-review')!==(kind==='review')||(claims.purpose==='filter')!==(kind==='filter')||
      (claims.member_read!==undefined)!==(kind==='member_ask')||(kind==='scheduled'||kind==='background')&&claims.logical_profile===undefined)throw Error();
    // The key's fields come from these claims only; one spelled the Reader's way is refused, as reads is.
    if(claims.keyKind!==undefined||claims.turnEvent!==undefined)throw Error();
    const app=claims.app===undefined?undefined:appBinding(claims.app);
    return {scope,admin:false,turnEvent:claims.event_id as string,...policy,...(claims.guard_epoch===undefined?{}:{guard_epoch:claims.guard_epoch as number}),...(claims.generation===undefined?{}:{generation:claims.generation as string}),...(claims.logical_profile===undefined?{}:{logical_profile:claims.logical_profile as string}),...(claims.purpose===undefined?{}:{purpose:claims.purpose as NonNullable<Reader['purpose']>}),...(claims.answer===undefined?{}:{answer:claims.answer as string}),...(app===undefined?{}:{app}),...(claims.member===undefined?{}:{member:claims.member as string}),...(claims.member_read===undefined?{}:{memberRead:claims.member_read as string}),
      agent:claims.agent,person,jti:claims.jti,keyKind:kind};
  } catch { throw new HttpError(401,'invalid_scope_token'); }
}
export function admin(principal:Reader):void { if (!principal.admin) throw new HttpError(403,'owner_required'); }
/**
 * The agent login (ADR-0295): the agent's own processes hold AGENT_KEY instead of SERVICE_TOKEN. It is its own kind of
 * caller, never a Reader, so no owner check that keys on scope===null or admin can take it; it reaches only the routes
 * the agent calls, each listed by the server that answers it.
 */
export type AgentLogin={readonly kind:'agent';readonly agent:string};
/** The agent login when the bearer is exactly the configured AGENT_KEY (32 characters or more); null otherwise. */
export function agentLogin(req:IncomingMessage,key:string|undefined):AgentLogin|null {
  const header=req.headers.authorization;
  if(!key||key.length<32||typeof header!=='string'||!header.startsWith('Bearer '))return null;
  return equal(header.slice(7),key)?{kind:'agent',agent:activeAgent}:null;
}
export const isAgentLogin=(caller:unknown):caller is AgentLogin=>typeof caller==='object'&&caller!==null&&(caller as {kind?:unknown}).kind==='agent';
/** The few repository calls the agent makes as itself take the agent login or the owner's admin bearer; nothing else. */
export function adminOrAgent(caller:Reader|AgentLogin):void { if(!isAgentLogin(caller))admin(caller); }
export async function assertAudience(pool:pg.Pool,principal:Reader) {
  if(!principal.admin){const guard=await guardState(pool);if((guard.mode==='on'||principal.guard_epoch!==undefined)&&principal.guard_epoch!==guard.epoch)throw new HttpError(409,'guard_context_changed');}
  if(principal.scope!==null && principal.space && principal.revision!==await policyRevision(pool))throw new HttpError(409,'space_policy_changed');
}
