import {boundReader,memberClaimId,memberReadId,turnToken,type KeyKind,type Reader} from '../access.js';
import {activeAgent} from '../agent/agents.js';
import {chats} from '../chats.js';
import {HttpError} from '../http.js';
import {otherPrivate,readSetIds} from '../spaces.js';
import {memberChatClosed} from './member-reads.js';
import {appBindingOf} from '../frontdoor/telegram.js';
import {GuardRepository,carriesForward,jobRun,type GuardBinding} from './guards.js';
import {ProjectRepository} from './projects.js';
import {OneTimeKeyRepository} from './one-time-keys.js';

/**
 * The one-time key a pass is (ADR-0301): what it is for (kind), what it answers (subject and attempt: the same reply signed
 * again gets the same key), its person ('owner' or a members.id; null when nobody can be named, which refuses the pass)
 * and, for a run made earlier, the agent its row was made for (undefined or null: none recorded).
 */
export type KeyRequest={kind:KeyKind;subject:string;attempt:string|number;person:string|null;agent?:string|null};

/** Preserved signing credentials cannot revive capabilities after a content reset. */
export class AudienceRepository {
  constructor(readonly guards:GuardRepository){}
  /** The current binding, for a credential of the current epoch, or of a background job's live run whose own binding still
   *  carries to it (ADR-0208). What the run then reads is checked under the current binding. */
  async assert(principal:Reader):Promise<GuardBinding> {
    const binding=await this.guards.state();
    if(!principal.admin&&(principal.generation!==binding.generation||principal.guard_epoch!==binding.epoch)&&!await this.carried(principal,binding))
      throw new HttpError(409,'audience_context_changed');
    return binding;
  }
  /** Only as its own credential names it: the job's run, waiting or running with a live lease and not stopped, under its own binding. */
  private async carried(principal:Reader,current:GuardBinding):Promise<boolean> {
    if(!jobRun(principal)||!principal.turnEvent)return false;
    const run=(await this.guards.stores.control.query(`SELECT binding FROM managed_runs WHERE event_id=$1 AND channel='background' AND logical_profile=$2
      AND NOT cancel_requested AND (state='captured' OR state='running' AND lease_until>now())`,[principal.turnEvent,principal.logical_profile])).rows[0];
    return !!run&&run.binding.generation===principal.generation&&Number(run.binding.epoch)===principal.guard_epoch&&
      await carriesForward(this.guards.stores.control,run.binding,current);
  }
  /**
   * A turn's credential, for the current binding, or for `own`, a job run's kept binding while it carries (ADR-0208).
   * A bound reader's pass names it and is signed only as storage bound it (ADR-0249, step 4):
   * - `answer`: an "Answer privately" answer, in the owner's private chat, with its read set;
   * - `member`: a member in their own private chat, with its reads and memberChat bound to that very chat;
   * - `memberRead` (the claim member_read): the owner's ask about a member, in the owner's private chat, with the asked
   *   member's chat bound and no group to read.
   * A private chat that is not the owner's gets a pass only as its own member's. `lane` (a member id) is signed on a
   * member's private pass (their own id) and on a group pass a member's message started; never on the owner's, an
   * answer's or an ask's, and a lane that fits none of these is left out, as it grants nothing.
   * Every pass is a one-time key (ADR-0301): it names `key.person`, who must fit the pass (a member's own chat is that
   * member's, a lane its member's, the owner's chat, an answer, an ask, a review and a filter the owner's), and the agent
   * plugged in now; its row is written before it is signed. No person, no pass (409 one_time_key_person_required).
   */
  async turn(secret:string,principal:Pick<Reader,'scope'|'space'|'purpose'|'logical_profile'|'answer'|'reads'|'member'|'memberRead'|'memberChat'>&{lane?:string},
    eventId:string,expires:number,key:KeyRequest,own?:GuardBinding):Promise<string> {
    if(!principal.space)throw new HttpError(400,'conversation_required');
    const bound=boundReader(principal);
    // A private answer's pass names its record and reads as the asker's private chat, never as the owner (ADR-0249).
    const answer=principal.answer;
    if(answer!==undefined&&(!principal.reads||principal.scope===null||principal.scope!==principal.space))throw new HttpError(409,'private_answer_closed');
    // A member's pass reads as their own private chat, a chat that is not the owner's, and only as storage bound it.
    const member=bound==='member'?principal.member!:undefined;
    if(member!==undefined&&(!memberClaimId.test(member)||principal.scope===null||principal.scope!==principal.space||chats().kind(principal.scope)!=='private'||
      !otherPrivate(principal.scope)||principal.memberChat!==principal.scope||!principal.reads||principal.reads.home!==principal.scope))throw new HttpError(409,memberChatClosed);
    // The owner's ask about a member reads as the owner's private chat, never as the owner: the asked member's chat and
    // no group.
    const memberRead=bound==='memberRead'?principal.memberRead!:undefined;
    if(memberRead!==undefined&&(!memberReadId.test(memberRead)||principal.scope===null||principal.scope!==principal.space||chats().kind(principal.scope)!=='private'||
      !chats().isOwner(principal.scope)||!principal.memberChat||!otherPrivate(principal.memberChat)||!principal.reads||readSetIds(principal.reads).length))
      throw new HttpError(409,memberChatClosed);
    // Nobody else's pass is ever for a private chat that is not the owner's (fail closed, step 4).
    if(member===undefined&&(otherPrivate(principal.scope)||otherPrivate(principal.space)))throw new HttpError(409,memberChatClosed);
    const lane=principal.lane!==undefined&&memberClaimId.test(principal.lane)&&(member!==undefined?principal.lane===member:
      bound===null&&principal.scope!==null&&chats().groupOf(principal.scope)!==null)?principal.lane:undefined;
    // Whose key it is (ADR-0301): somebody it can be named for, who fits the pass, for the agent plugged in now.
    const person=key.person;
    if(person===null)throw new HttpError(409,'one_time_key_person_required');
    const owners=principal.scope===null||bound==='answer'||bound==='memberRead'||principal.purpose==='memory-review'||principal.purpose==='filter';
    if(member!==undefined&&person!==member||lane!==undefined&&person!==lane||owners&&person!=='owner'||
      person!=='owner'&&!memberClaimId.test(person))throw new HttpError(409,'one_time_key_person_mismatch');
    if((principal.purpose==='memory-review')!==(key.kind==='review')||(principal.purpose==='filter')!==(key.kind==='filter')||
      (memberRead!==undefined)!==(key.kind==='member_ask')||(key.kind==='scheduled'||key.kind==='background')&&!principal.logical_profile)
      throw new HttpError(409,'one_time_key_kind_mismatch');
    if(key.agent!==undefined&&key.agent!==null&&key.agent!==activeAgent)throw new HttpError(409,'one_time_key_agent_changed');
    const binding=own?(await this.guards.assertCarried(own),own):await this.guards.state();
    // The chat's active project gives the turn that project's role and skills; a private answer's, the project of its
    // record, while that project is active. A member's private chat and an ask about a member have none.
    const control=this.guards.stores.control;
    const project=answer!==undefined?principal.reads!.project===null?null:
      (await control.query<{id:string;state:string}>('SELECT id,state FROM projects WHERE id=$1',[principal.reads!.project])).rows[0]??null:
      member!==undefined||memberRead!==undefined?null:(await new ProjectRepository(control).effective(principal.space)).project;
    // The app the turn's chat lives in, as the front door that receives the turn checks it: the chat's current app id
    // and topic now, so a reply follows a group Telegram upgraded (ADR-0252). A chat the directory does not address
    // gets none, and no front door accepts a turn without it; storage itself does not require it, so job passes work.
    const app=appBindingOf(principal.space);
    const jti=await new OneTimeKeyRepository(control).mint({kind:key.kind,subject:key.subject,attempt:String(key.attempt),person,agent:activeAgent,
      event:eventId,expires});
    return turnToken(secret,principal.scope,expires,eventId,{space:principal.space,revision:binding.epoch,
      guard_epoch:binding.epoch,generation:binding.generation,...(principal.purpose?{purpose:principal.purpose}:{}),...(principal.logical_profile?{logical_profile:principal.logical_profile}:{}),
      ...(project?.state==='active'?{project:project.id}:{}),...(answer!==undefined?{answer}:{}),...(member!==undefined?{member}:{}),
      ...(memberRead!==undefined?{memberRead}:{}),...(lane!==undefined?{lane}:{}),...(app?{app}:{}),
      agent:activeAgent,person,jti,kind:key.kind});
  }
}
