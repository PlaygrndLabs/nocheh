import type {Reader} from '../access.js';
import {admin} from '../access.js';
import {outsideChat,ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {groupSpace,inReadSet,inRecall,observedChat,parentSpace,readSetGroups,readSetOf,recallScope,servedGroup,sourceChat,type ReadSet,type RecallScope} from '../spaces.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository,type CapturedSource,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {RelationshipRepository} from './relationships.js';
import {OwnerCommands} from './owner-commands.js';
import type {SourceRetirementRepository} from './source-retirement.js';
import type {ReactionStateRepository} from './reaction-state.js';
import {bindAnswerReads} from './private-answers.js';
import {chats} from '../chats.js';
import {deliveredKinds,sendClassOf,unlearnedSendClasses} from '../send-classes.js';

/** Source access is independent of project membership and sharing configuration. */
export class SourceAccessRepository {
  readonly relationships:RelationshipRepository;
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly guards:GuardRepository,readonly policy:()=>AssistantPolicy,
    readonly retirements?:SourceRetirementRepository,readonly reactions?:ReactionStateRepository) {
    this.relationships=new RelationshipRepository(archive);
  }
  /** `historical` rechecks evidence that was already learned: a later reaction
   * change adds new evidence and does not retract the earlier reaction. */
  async canRead(principal:Reader,reference:SourceReference,binding:GuardBinding,options:{historical?:boolean}={}):Promise<boolean> {
    await this.guards.assertCurrent(binding);const source=await this.archive.verify(reference);
    if(!principal.admin&&source.channel==='telegram'){
      if(await this.retirements?.isRetired(reference))return false;
      if(!options.historical&&this.reactions&&!await this.reactions.isCurrent(reference))return false;
    }
    // What someone Nocheh doesn't serve wrote stays out of every conversation, the owner's included.
    if(!principal.admin&&outsideChat(this.policy(),source))return false;
    if(principal.admin||principal.scope===null){await this.guards.assertCurrent(binding);return true;}
    if(!['telegram','browser'].includes(source.channel))return false;
    // An answer reader reads the groups frozen in its record, and of its own private chat only its own turn's message
    // (the /start that opened it): never the rest of that chat, and nothing without its record (ADR-0249).
    const answer=principal.answer!==undefined,reads=answer?principal.reads:undefined;
    if(answer&&!reads)return false;
    // An original belongs to the chat its raw scope names through chat_ids (current or old id), and to the topic its
    // observed audience names through that chat's topic rows; an id with no row reads nothing (ADR-0252).
    const chat=sourceChat(source);
    const own=answer&&reference.id===principal.turnEvent&&chat!==null&&chat===principal.scope;
    if(chat===null||(answer?!own&&!readSetGroups(reads!).includes(chat):chat!==principal.scope))return false;
    const observed=(await this.relationships.describe(reference)).audience;
    const space=observed&&observed.chat_id===source.scope?observedChat(source.channel,observed):null;
    const allowed=space!==null&&(chats().parentOf(space)??space)===chat&&
      (answer?own?space===principal.space:inReadSet(reads!,space):inRecall(this.recall(principal)!,space));
    await this.guards.assertCurrent(binding);return allowed;
  }
  /**
   * canRead for many sources at once (ADR-0259): true exactly where canRead returns true, and false where it returns
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
      // What someone Nocheh doesn't serve wrote stays out of every conversation, the owner's included.
      for(const item of open)if(outsideChat(this.policy(),item.source))deny(item.reference.id);
      open=open.filter(item=>result.get(item.reference.id)!==false);
    }
    if(principal.admin||principal.scope===null){for(const item of open)result.set(item.reference.id,true);await this.guards.assertCurrent(binding);return result;}
    const answer=principal.answer!==undefined,reads=answer?principal.reads:undefined;
    const placed:{reference:SourceReference;source:CapturedSource;chat:string;own:boolean}[]=[];
    for(const item of open) {
      if(!['telegram','browser'].includes(item.source.channel)||answer&&!reads){deny(item.reference.id);continue;}
      const chat=sourceChat(item.source),own=answer&&item.reference.id===principal.turnEvent&&chat!==null&&chat===principal.scope;
      if(chat===null||(answer?!own&&!readSetGroups(reads!).includes(chat):chat!==principal.scope)){deny(item.reference.id);continue;}
      placed.push({...item,chat,own});
    }
    const described=await this.relationships.describeMany(placed.map(item=>item.reference.id));
    for(const item of placed) {
      const found=described.get(item.reference.id);
      // canRead's describe() refuses an original with no observation.
      if(!found){deny(item.reference.id);continue;}
      const observed=found.audience,space=observed&&observed.chat_id===item.source.scope?observedChat(item.source.channel,observed):null;
      const allowed=space!==null&&(chats().parentOf(space)??space)===item.chat&&
        (answer?item.own?space===principal.space:inReadSet(reads!,space):inRecall(this.recall(principal)!,space));
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
    const consent=(await this.stores.control.query('SELECT enabled FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    return consent?.enabled===true?null:'nocheh_message';
  }
  /** The conversations a scoped principal recalls; null for the owner and administration, which read everything.
   * For an answer reader, the asking group or topic (its read set's home): what its shared and granted context is for
   * (ADR-0249). An answer reader whose read set was not bound reads nothing. */
  recall(principal:Reader):RecallScope|null {
    if(principal.admin||principal.scope===null)return null;
    if(principal.answer!==undefined){if(!principal.reads)throw new HttpError(409,'private_answer_closed');return recallScope(principal.reads.home,this.policy().topic_memory);}
    return recallScope(principal.space??principal.scope,this.policy().topic_memory);
  }
  /** The conversations a scoped principal reads, as a read set; null for the owner and administration. An answer
   * reader reads the groups frozen in its record; anyone else its recall scope (ADR-0249). */
  reads(principal:Reader):ReadSet|null {
    if(principal.admin||principal.scope===null)return null;
    if(principal.answer!==undefined){if(!principal.reads)throw new HttpError(409,'private_answer_closed');return principal.reads;}
    return readSetOf(this.recall(principal)!);
  }
  /** A reader with its read set resolved on the server from its record, for every request; a reader without an answer is
   * returned as it is. An answer whose record is closed, expired or not this turn's is refused (private_answer_closed). */
  bindReads(principal:Reader):Promise<Reader> {return bindAnswerReads(this.stores.control,this.policy(),principal);}
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
    const skipped=!saved&&await this.notLearned(reference)!==null;
    const effective=!skipped&&await this.canLearn(reference,binding);await this.guards.assertCurrent(binding);
    return {source:reference,enabled:saved?.enabled??null,revision:saved?.revision??0,effective,
      authority:saved?'owner':skipped?'send_class':'capture_policy',transport:intake?.transport??source.origin,intake_state:intake?.state??null,updated_at:saved?.updated_at??null};
  }
  principal(space:string):Reader {
    return {admin:false,scope:space===ownerChat(this.policy())?null:parentSpace(space)??space,space};
  }
}
