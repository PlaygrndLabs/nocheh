import type {Reader} from '../access.js';
import {admin,boundReader,memberClaimId,sharedReads,type BoundReader} from '../access.js';
import {outsideChat,ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {groupSpace,inReadSet,inRecall,observedChat,otherPrivate,parentSpace,readSet,readSetGroups,readSetOf,recallScope,servedGroup,servedGroups,sourceChat,type ReadSet,type RecallScope} from '../spaces.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository,type CapturedSource,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {RelationshipRepository} from './relationships.js';
import {OwnerCommands} from './owner-commands.js';
import type {SourceRetirementRepository} from './source-retirement.js';
import type {ReactionStateRepository} from './reaction-state.js';
import {bindAnswerReads} from './private-answers.js';
import {chats} from '../chats.js';
import {deliveredKinds,sendClassOf,unconsentableSendClasses,unlearnedSendClasses,type SendClass} from '../send-classes.js';
import {memberAskReads,memberChatClosed,memberReads} from './member-reads.js';
import {sharedProjectGroups,withSharedGroups} from './project-groups.js';

/** The 409 a bound reader gets when its reads can't be bound now: an answer keeps ADR-0249's code; a member's private
 * chat and the owner's ask about a member share step 4's. */
const closedCode:Readonly<Record<BoundReader,string>>={answer:'private_answer_closed',member:memberChatClosed,memberRead:memberChatClosed};
/** The one private chat that is not the owner's a reader may read (step 4): a member's own chat for a member reader, the
 * asked member's chat for the owner's ask about a member, as bindReads set it for this request; null for every other
 * reader, an answer reader included. */
export function boundChat(principal:Reader):string|null {
  const kind=boundReader(principal);
  return (kind==='member'||kind==='memberRead')&&typeof principal.memberChat==='string'&&principal.memberChat?principal.memberChat:null;
}
/** Whether a bound reader of this kind reads its own turn's message in the owner's private chat: an answer its /start
 * (ADR-0249), and the owner's ask about a member the owner's own question that asked it (step 4b). A member reads their
 * own chat whole, through boundChat. */
const ownTurn=(kind:ReturnType<typeof boundReader>)=>kind==='answer'||kind==='memberRead';
/** Why an original can never be learned, nor made learnable by the owner's yes (step 4): it is in a private chat that is
 * not the owner's (`member_chat`, a member's or anyone else's, any kind, imports included), or it is Nocheh's answer to
 * the owner's ask about a member (`member_read`). Null for anything else. */
export type PrivateHold='member_chat'|'member_read';

/** Source access is independent of project membership and sharing configuration. */
export class SourceAccessRepository {
  readonly relationships:RelationshipRepository;
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly guards:GuardRepository,readonly policy:()=>AssistantPolicy,
    readonly retirements?:SourceRetirementRepository,readonly reactions?:ReactionStateRepository) {
    this.relationships=new RelationshipRepository(archive);
  }
  /**
   * `historical` rechecks evidence that was already learned: a later reaction change adds new evidence and does not
   * retract the earlier reaction.
   *
   * The order (step 4, ADR-0262): the dashboard reads everything; then retired and stale reaction sources are refused;
   * then what someone Nocheh doesn't serve wrote, unless it is the reader's own bound member chat (boundChat); then any
   * private chat that is not the owner's, of every kind, unless it is that bound chat; then Nocheh's answer to the
   * owner's ask about a member (send class member_read), for every reader but the dashboard; only then the owner's own
   * reads, and last the scoped readers' own conversations.
   */
  async canRead(principal:Reader,reference:SourceReference,binding:GuardBinding,options:{historical?:boolean}={}):Promise<boolean> {
    await this.guards.assertCurrent(binding);const source=await this.archive.verify(reference);
    if(!principal.admin&&source.channel==='telegram'){
      if(await this.retirements?.isRetired(reference))return false;
      if(!options.historical&&this.reactions&&!await this.reactions.isCurrent(reference))return false;
    }
    if(!principal.admin&&!this.privatelyOpen(principal,source))return false;
    if(!principal.admin&&deliveredKinds.has(source.kind)&&(await this.sendClasses([reference.id])).get(reference.id)==='member_read')return false;
    if(principal.admin||principal.scope===null){await this.guards.assertCurrent(binding);return true;}
    if(!['telegram','browser'].includes(source.channel))return false;
    // A bound reader reads what bindReads resolved for this request (ADR-0249, ADR-0262): an answer the groups frozen in
    // its record and of its own private chat only its own turn's message (the /start that opened it); a member their
    // joined groups and all of their own private chat; the owner's ask about a member that member's chat and the owner's
    // own question that asked it. Nothing without its binding.
    // A group reader whose project shares its group chats reads the project's groups as bindReads gave them (ADR-0267).
    const kind=boundReader(principal),reads=kind?principal.reads:undefined,mine=boundChat(principal),shared=sharedReads(principal);
    if(kind&&!reads)return false;
    // An original belongs to the chat its raw scope names through chat_ids (current or old id), and to the topic its
    // observed audience names through that chat's topic rows; an id with no row reads nothing (ADR-0252).
    const chat=sourceChat(source);
    const own=ownTurn(kind)&&reference.id===principal.turnEvent&&chat!==null&&chat===principal.scope,inMine=mine!==null&&chat===mine;
    if(chat===null||(kind?!own&&!inMine&&!readSetGroups(reads!).includes(chat):shared?!readSetGroups(shared).includes(chat):chat!==principal.scope))return false;
    const observed=(await this.relationships.describe(reference)).audience;
    const space=observed&&observed.chat_id===source.scope?observedChat(source.channel,observed):null;
    const allowed=space!==null&&(chats().parentOf(space)??space)===chat&&
      (kind?own?space===principal.space:inMine||inReadSet(reads!,space):shared?inReadSet(shared,space):inRecall(this.recall(principal)!,space));
    await this.guards.assertCurrent(binding);return allowed;
  }
  /**
   * Steps 3 and 4 of canRead's order for a reader that is not the dashboard: what someone Nocheh doesn't serve wrote
   * stays out of every conversation, the owner's included, and so does any private chat that is not the owner's, of
   * every kind (a member's updates, Nocheh's replies there, a stranger's chat), unless it is the reader's own bound
   * member chat (boundChat), which bindReads checks in the store for every request.
   */
  private privatelyOpen(principal:Reader,source:CapturedSource):boolean {
    const chat=sourceChat(source),mine=boundChat(principal),bound=mine!==null&&chat===mine;
    if(outsideChat(this.policy(),source)&&!bound)return false;
    return !otherPrivate(chat)||bound;
  }
  /** The send class each of these delivered messages was stamped with, by id; an id with none, or not a delivered
   * message, is left out. */
  async sendClasses(ids:readonly string[]):Promise<Map<string,SendClass>> {
    const wanted=[...new Set(ids)],found=new Map<string,SendClass>();
    if(!wanted.length)return found;
    for(const row of (await this.stores.archive.query('SELECT id,payload FROM events WHERE id=ANY($1::text[]) AND kind=ANY($2::text[])',[wanted,[...deliveredKinds]])).rows) {
      let value:unknown=null;try{value=JSON.parse((row.payload as Buffer).toString()).send_class;}catch{}
      const sendClass=sendClassOf(value);if(sendClass)found.set(row.id as string,sendClass);
    }
    return found;
  }
  /** Why an original may never be learned or made learnable (PrivateHold), or null. */
  async privateHold(reference:SourceReference):Promise<PrivateHold|null> {
    // By the event alone, whatever revision the reference names: where an original is never changes with its revisions.
    const source=await this.archive.captured(reference.id);
    if(otherPrivate(sourceChat(source)))return 'member_chat';
    if(deliveredKinds.has(source.kind)&&unconsentableSendClasses.has((await this.sendClasses([reference.id])).get(reference.id)!))return 'member_read';
    return null;
  }
  /**
   * Whether evidence rests on a private chat that is not the owner's, or on Nocheh's answer to the owner's ask about a
   * member (step 4): such a fact is never granted, requested or suggested to anyone, whatever the owner confirms. A
   * source the archive no longer holds can't be told apart, so it counts (fail closed).
   */
  async memberChatEvidence(evidence:readonly SourceReference[]):Promise<boolean> {
    for(const reference of evidence)if(await this.privateHold(reference).catch(error=>{if(error instanceof HttpError)return 'member_chat';throw error;}))return true;
    return false;
  }
  /** Of these events, the ones that reply to Nocheh's answer to the owner's ask about a member (send class member_read),
   * by the archive's reply relation: a read of them shows no quote of that answer (D13). */
  async repliesToMemberRead(ids:readonly string[]):Promise<Set<string>> {
    const wanted=[...new Set(ids)];if(!wanted.length)return new Set();
    const rows=(await this.stores.archive.query(`SELECT r.event_id,o.event_id AS target FROM source_relations r
      JOIN source_revisions v ON v.object_id=r.target_id JOIN source_observations o ON o.revision_id=v.id
      WHERE r.event_id=ANY($1::text[]) AND r.kind='reply_to'`,[wanted])).rows;
    const classes=await this.sendClasses(rows.map(row=>row.target as string));
    return new Set(rows.filter(row=>classes.get(row.target)==='member_read').map(row=>row.event_id as string));
  }
  /**
   * canRead for many sources at once (ADR-0261): true exactly where canRead returns true, and false where it returns
   * false or refuses the reference (one the archive does not hold, or that names another revision). The same checks in
   * the same order, each batched, so a page of tags costs a few reads instead of about five per source. A guard binding
   * that is no longer current is refused, as canRead refuses it.
   */
  async readable(principal:Reader,references:readonly SourceReference[],binding:GuardBinding,options:{historical?:boolean}={}):Promise<Map<string,boolean>> {
    await this.guards.assertCurrent(binding);
    const result=new Map<string,boolean>(),deny=(id:string)=>result.set(id,false);
    const captured=await this.archive.capturedMany(references.filter(ref=>ref.store==='archive'&&ref.kind==='event').map(ref=>ref.id));
    let open:{reference:SourceReference;source:CapturedSource}[]=[];
    for(const reference of references) {
      const source=reference.store==='archive'&&reference.kind==='event'?captured.get(reference.id):undefined;
      if(!source||source.reference.revision!==reference.revision||source.reference.input_hash!==reference.input_hash||result.get(reference.id)===false)deny(reference.id);
      else if(!open.some(item=>item.reference.id===reference.id))open.push({reference,source});
    }
    open=open.filter(item=>result.get(item.reference.id)!==false);
    if(!principal.admin) {
      const telegram=open.filter(item=>item.source.channel==='telegram').map(item=>item.reference.id);
      const [retired,stale]=await Promise.all([this.retirements?.retiredAmong(telegram)??new Set<string>(),
        !options.historical&&this.reactions?this.reactions.staleAmong(telegram):new Set<string>()]);
      for(const id of telegram)if(retired.has(id)||stale.has(id))deny(id);
      open=open.filter(item=>result.get(item.reference.id)!==false);
      // canRead's steps 3 to 5: outside chats, other private chats and the owner's asks' answers.
      for(const item of open)if(!this.privatelyOpen(principal,item.source))deny(item.reference.id);
      open=open.filter(item=>result.get(item.reference.id)!==false);
      const classes=await this.sendClasses(open.filter(item=>deliveredKinds.has(item.source.kind)).map(item=>item.reference.id));
      for(const item of open)if(classes.get(item.reference.id)==='member_read')deny(item.reference.id);
      open=open.filter(item=>result.get(item.reference.id)!==false);
    }
    if(principal.admin||principal.scope===null){for(const item of open)result.set(item.reference.id,true);await this.guards.assertCurrent(binding);return result;}
    const kind=boundReader(principal),reads=kind?principal.reads:undefined,mine=boundChat(principal),shared=sharedReads(principal);
    const placed:{reference:SourceReference;source:CapturedSource;chat:string;own:boolean;inMine:boolean}[]=[];
    for(const item of open) {
      if(!['telegram','browser'].includes(item.source.channel)||kind&&!reads){deny(item.reference.id);continue;}
      const chat=sourceChat(item.source),own=ownTurn(kind)&&item.reference.id===principal.turnEvent&&chat!==null&&chat===principal.scope,
        inMine=mine!==null&&chat===mine;
      if(chat===null||(kind?!own&&!inMine&&!readSetGroups(reads!).includes(chat):shared?!readSetGroups(shared).includes(chat):chat!==principal.scope)){deny(item.reference.id);continue;}
      placed.push({...item,chat,own,inMine});
    }
    const described=await this.relationships.describeMany(placed.map(item=>item.reference.id));
    for(const item of placed) {
      const found=described.get(item.reference.id);
      // canRead's describe() refuses an original with no observation.
      if(!found){deny(item.reference.id);continue;}
      const observed=found.audience,space=observed&&observed.chat_id===item.source.scope?observedChat(item.source.channel,observed):null;
      const allowed=space!==null&&(chats().parentOf(space)??space)===item.chat&&
        (kind?item.own?space===principal.space:item.inMine||inReadSet(reads!,space):shared?inReadSet(shared,space):inRecall(this.recall(principal)!,space));
      result.set(item.reference.id,allowed);
    }
    await this.guards.assertCurrent(binding);return result;
  }
  async canLearn(reference:SourceReference,binding:GuardBinding,options:{historical?:boolean}={}):Promise<boolean> {
    await this.guards.assertCurrent(binding);const source=await this.archive.verify(reference);
    if(source.channel==='telegram'){
      if(await this.retirements?.isRetired(reference))return false;
      if(!options.historical&&this.reactions&&!await this.reactions.isCurrent(reference))return false;
    }
    // Never from a private chat that is not the owner's, of any kind and imports included, nor from Nocheh's answer to the
    // owner's ask about a member: before the owner's yes is read, which can't make either learnable (step 4).
    if(await this.privateHold(reference))return false;
    const intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[reference.id])).rows[0];
    if(intake?.state==='pending')return false;
    const consent=(await this.stores.control.query('SELECT enabled FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    if(consent){await this.guards.assertCurrent(binding);return consent.enabled===true;}
    if(intake?.transport==='import')return false;
    if(source.origin!=='live'||source.kind==='telegram_wire')return false;
    const policy=this.policy();if(!policy.enabled||!policy.owner_id)return false;
    // Learned from: the owner's private chat and the groups Nocheh serves, by the chat each original belongs to (ADR-0252).
    const chat=sourceChat(source),served=chat!==null&&(chat===ownerChat(policy)||servedGroup(chat));
    if(source.channel==='browser') {
      if(!['browser_input','browser_delivered_message'].includes(source.kind)||!served)return false;
      const space=await this.space(reference);await this.guards.assertCurrent(binding);return space!==null;
    }
    if(source.channel!=='telegram'||!['telegram_update','telegram_delivered_message'].includes(source.kind))return false;
    if(!served)return false;
    const observed=(await this.relationships.describe(reference)).audience;
    // A reaction to an unseen forum message waits for context, never learns at group scope.
    if(!observed||observed.topic_state==='unknown')return false;
    await this.guards.assertCurrent(binding);return true;
  }
  /**
   * Why an original is kept but not learned, or null (ADR-0256): Nocheh's own card, card update, refusal, notice or
   * reminder, by the send class the bot kept with it, unless the owner turned learning on for that message. It is never
   * part of canLearn, so a card stays context for the owner's reply to it and what memory already holds stays valid.
   */
  async notLearned(reference:SourceReference):Promise<'nocheh_message'|null> {
    const source=await this.archive.verify(reference);
    if(!deliveredKinds.has(source.kind))return null;
    const row=(await this.stores.archive.query('SELECT payload FROM events WHERE id=$1',[reference.id])).rows[0];
    const sendClass=row?sendClassOf(JSON.parse((row.payload as Buffer).toString()).send_class):null;
    if(!sendClass||!unlearnedSendClasses.has(sendClass))return null;
    // Nocheh's answer to the owner's ask about a member is never learned, whatever the owner said (step 4b).
    if(unconsentableSendClasses.has(sendClass))return 'nocheh_message';
    const consent=(await this.stores.control.query('SELECT enabled FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    return consent?.enabled===true?null:'nocheh_message';
  }
  /** The conversations a scoped principal recalls; null for the owner and administration, which read everything.
   * For a bound reader, its read set's home: for an answer the asking group or topic (what its shared and granted
   * context is for, ADR-0249); for a member their own private chat and for the owner's ask the owner's private chat,
   * neither of which is given shared or granted context (step 4). A bound reader whose reads were not bound reads nothing. */
  recall(principal:Reader):RecallScope|null {
    if(principal.admin||principal.scope===null)return null;
    const kind=boundReader(principal);
    if(kind!==null){if(!principal.reads)throw new HttpError(409,closedCode[kind]);return recallScope(principal.reads.home,this.policy().topic_memory);}
    return recallScope(principal.space??principal.scope,this.policy().topic_memory);
  }
  /** The conversations a scoped principal reads, as a read set; null for the owner and administration. A bound reader
   * reads its bound set (groups only: a member's own chat and an asked member's chat are its boundChat, never in a set);
   * a group reader whose project shares its group chats the project's groups bindReads gave it (ADR-0267); anyone else
   * its recall scope (ADR-0249). */
  reads(principal:Reader):ReadSet|null {
    if(principal.admin||principal.scope===null)return null;
    const kind=boundReader(principal);
    if(kind!==null){if(!principal.reads)throw new HttpError(409,closedCode[kind]);return principal.reads;}
    return sharedReads(principal)??readSetOf(this.recall(principal)!);
  }
  /**
   * A bound reader with its reads resolved in the store for this request (ADR-0249, ADR-0262); any other reader is
   * returned as it is. An answer from its open record (private_answer_closed otherwise). A member from their own private
   * chat: the pass's chat must be, now, a member's open private chat, of the very member the pass names, and its reads
   * are their joined groups (memberReads) and that chat (memberChat). The owner's ask about a member from its running
   * row: no group, and the asked member's own chat (memberAskReads). Anything else is member_chat_closed.
   */
  async bindReads(principal:Reader):Promise<Reader> {
    const kind=boundReader(principal);
    if(kind===null)return this.bindShared(principal);
    if(kind==='answer'){const {memberChat:_,...rest}=principal;return bindAnswerReads(this.stores.control,this.policy(),rest);}
    const closed=()=>new HttpError(409,memberChatClosed),policy=this.policy(),owner=ownerChat(policy);
    if(principal.admin||principal.scope===null||principal.space!==principal.scope||!principal.turnEvent||!policy.enabled||!policy.owner_id||!owner)throw closed();
    if(kind==='member') {
      if(!memberClaimId.test(principal.member!)||principal.scope===owner)throw closed();
      const found=await memberReads(this.stores.control,principal.scope,owner);
      if(!found||found.member!==principal.member||found.chat!==principal.scope)throw closed();
      // The groups this turn leaves out (re-checks past the cap), as its dispatch wrote them; a turn with none written
      // reads nothing.
      let left=(await this.stores.control.query<{left_out:string[]}>('SELECT left_out FROM member_turns WHERE member_id=$1 AND event_id=$2 AND left_out IS NOT NULL',
        [found.member,principal.turnEvent])).rows[0]?.left_out;
      // A run of one of the member's own schedules in this chat, while the member has Personal assistant on, leaves out no
      // joined group (members' schedules): it reads what their private chat reads.
      if(!left&&(await this.stores.control.query(`SELECT 1 FROM managed_runs r JOIN members m ON m.id=$3 AND m.assistant
        WHERE r.event_id=$1 AND r.channel='scheduler' AND r.scope=$2 AND r.space_id=$2 AND r.state IN ('captured','running')`,
        [principal.turnEvent,found.chat,found.member])).rowCount)left=[];
      if(!left)throw closed();
      // Each joined group brings the other served groups of its project while that project shares its group chats (ADR-0267).
      const joined=found.groups.map(group=>group.chat).filter(group=>!left.includes(group));
      const whole=await withSharedGroups(this.stores.control,joined,servedGroups());
      return {...principal,reads:readSet({home:found.chat,whole}),memberChat:found.chat};
    }
    if(principal.scope!==owner)throw closed();
    // Only the turn of the owner's own message that asked it: its pass names that message as its turn.
    const found=await memberAskReads(this.stores.control,principal.memberRead!,owner);
    if(!found||found.event!==principal.turnEvent)throw closed();
    return {...principal,reads:readSet({home:owner}),memberChat:found.chat};
  }
  /**
   * An ordinary reader with its shared reads resolved in the store for this request (ADR-0267). A group or topic reader
   * whose group Nocheh serves, in an active project whose "Share group chats" is on with at least one other served
   * group, reads every served group of that project (sharedProjectGroups): each whole, its own too, when a group's
   * topics share memory, else its own conversation exactly and the others whole. Anyone else, the owner and the
   * dashboard included, gets no read set and reads its own recall scope; a read set it came with is dropped, so only
   * this decides.
   */
  private async bindShared(principal:Reader):Promise<Reader> {
    const {reads:_given,...bare}=principal;
    if(bare.admin||bare.scope===null||!this.policy().enabled||chats().kind(bare.scope)!=='group')return bare;
    const space=bare.space??bare.scope;
    if(chats().groupOf(space)!==bare.scope)return bare;
    const found=await sharedProjectGroups(this.stores.control,bare.scope,servedGroups());
    if(!found)return bare;
    const reads=(this.policy().topic_memory??'group')==='group'?readSet({home:space,whole:found.groups,project:found.project}):
      readSet({home:space,exact:[space],whole:found.groups.filter(group=>group!==bare.scope),project:found.project});
    return {...bare,reads};
  }
  async space(reference:SourceReference):Promise<string|null> {
    const source=await this.archive.verify(reference);
    const observed=(await this.relationships.describe(reference)).audience;
    // Legacy owner originals can lack topic metadata; that exception cannot
    // promote a group/topic submission into a broader audience.
    const owner=ownerChat(this.policy());
    if(!observed&&source.channel==='browser'&&owner!==null&&source.scope===owner)return source.scope;
    // The chat or topic the observed audience names, through chat_ids and topic rows; null when no row names it.
    const space=observed&&observed.chat_id===source.scope?observedChat(source.channel,observed):null;
    return space!==null&&(chats().parentOf(space)??space)===sourceChat(source)?space:null;
  }
  /** The conversation each piece of evidence came from; null for one Nocheh cannot place. A store failure is not an
   * unknown conversation: it is thrown, so a passing outage never decides anything (ADR-0242). */
  async evidenceSpaces(evidence:SourceReference[]):Promise<(string|null)[]> {
    return Promise.all(evidence.map(reference=>this.space(reference).catch(error=>{if(error instanceof HttpError)return null;throw error;})));
  }
  /** Whether evidence rests on anything but group or topic messages: a private chat, the owner's included, or a
   * conversation Nocheh cannot place. Such a fact never reaches a group unless the owner confirms it (ADR-0242). */
  async privateEvidence(evidence:SourceReference[]):Promise<boolean> {
    const spaces=await this.evidenceSpaces(evidence);return !spaces.length||spaces.some(space=>!groupSpace(space));
  }
  async setConsent(principal:Reader,reference:SourceReference,input:unknown) {
    admin(principal);await this.archive.verify(reference);const body=object(input);
    // A private chat that is not the owner's, and Nocheh's answer to the owner's ask about a member, are never learned:
    // no yes can change that, so none is kept (step 4).
    const hold=await this.privateHold(reference);
    if(hold)throw new HttpError(409,hold==='member_chat'?'learning_consent_member_chat':'learning_consent_member_read');
    if(Object.keys(body).some(k=>!['enabled','expected_revision','operation_id'].includes(k))||typeof body.enabled!=='boolean'||
      !Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)throw new HttpError(400,'invalid_learning_consent');
    return new OwnerCommands(this.stores.control).run(principal,string(body.operation_id,200),{kind:'learning_consent',reference,...body},async db=>{
      const current=(await db.query('SELECT revision FROM learning_consent WHERE event_id=$1 FOR UPDATE',[reference.id])).rows[0];
      if((current?.revision??0)!==body.expected_revision)throw new HttpError(409,'learning_consent_conflict');
      const revision=Number(body.expected_revision)+1;
      await db.query(`INSERT INTO learning_consent(event_id,enabled,reason,revision) VALUES($1,$2,'owner',$3)
        ON CONFLICT(event_id) DO UPDATE SET enabled=$2,reason='owner',revision=$3,updated_at=now()`,[reference.id,body.enabled,revision]);
      return {event_id:reference.id,enabled:body.enabled,revision};
    });
  }
  async consent(principal:Reader,reference:SourceReference) {
    admin(principal);const source=await this.archive.verify(reference),binding=await this.guards.state();
    const saved=(await this.stores.control.query('SELECT enabled,revision,updated_at FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    const intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[reference.id])).rows[0];
    // Nocheh's own card or notice is not learned unless the owner turns it on, which the existing switch does.
    const skipped=!saved&&await this.notLearned(reference)!==null,hold=await this.privateHold(reference);
    const effective=!skipped&&await this.canLearn(reference,binding);await this.guards.assertCurrent(binding);
    // `consentable` false: the owner's yes can't make it learnable (step 4), so no switch is offered.
    return {source:reference,enabled:saved?.enabled??null,revision:saved?.revision??0,effective,consentable:hold===null,
      authority:saved?'owner':skipped?'send_class':'capture_policy',transport:intake?.transport??source.origin,intake_state:intake?.state??null,updated_at:saved?.updated_at??null};
  }
  principal(space:string):Reader {
    return {admin:false,scope:space===ownerChat(this.policy())?null:parentSpace(space)??space,space};
  }
}
