import type {Reader} from '../access.js';
import {admin} from '../access.js';
import {outsideChat,type AssistantPolicy} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {groupSpace,inReadSet,inRecall,parentSpace,readSetGroups,readSetOf,recallScope,type ReadSet,type RecallScope} from '../spaces.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {RelationshipRepository} from './relationships.js';
import {OwnerCommands} from './owner-commands.js';
import type {SourceRetirementRepository} from './source-retirement.js';
import type {ReactionStateRepository} from './reaction-state.js';
import {bindAnswerReads} from './private-answers.js';

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
    const own=answer&&reference.id===principal.turnEvent&&source.scope===principal.scope;
    if(answer?!own&&!readSetGroups(reads!).includes(source.scope):source.scope!==principal.scope)return false;
    const observed=(await this.relationships.describe(reference)).audience;
    const space=!observed||observed.topic_state==='unknown'?null:observed.topic_state==='known'?observed.chat_id+'/topic/'+observed.topic_id:observed.chat_id;
    const allowed=!!observed&&observed.chat_id===source.scope&&space!==null&&
      (answer?own?space===principal.space:inReadSet(reads!,space):observed.chat_id===principal.scope&&inRecall(this.recall(principal)!,space));
    await this.guards.assertCurrent(binding);return allowed;
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
    if(source.channel==='browser') {
      if(!['browser_input','browser_delivered_message'].includes(source.kind)||source.scope!==policy.owner_id&&!policy.group_ids.includes(source.scope))return false;
      const space=await this.space(reference);await this.guards.assertCurrent(binding);return space!==null;
    }
    if(source.channel!=='telegram'||!['telegram_update','telegram_delivered_message'].includes(source.kind))return false;
    if(!policy.group_ids.includes(source.scope)&&source.scope!==policy.owner_id)return false;
    const observed=(await this.relationships.describe(reference)).audience;
    // A reaction to an unseen forum message waits for context, never learns at group scope.
    if(!observed||observed.topic_state==='unknown')return false;
    await this.guards.assertCurrent(binding);return true;
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
    if(!observed&&source.channel==='browser'&&source.scope===this.policy().owner_id)return source.scope;
    return !observed||observed.topic_state==='unknown'?null:observed.topic_state==='known'?observed.chat_id+'/topic/'+observed.topic_id:observed.chat_id;
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
    const effective=await this.canLearn(reference,binding);await this.guards.assertCurrent(binding);
    return {source:reference,enabled:saved?.enabled??null,revision:saved?.revision??0,effective,
      authority:saved?'owner':'capture_policy',transport:intake?.transport??source.origin,intake_state:intake?.state??null,updated_at:saved?.updated_at??null};
  }
  principal(space:string):Reader {
    return {admin:false,scope:space===this.policy().owner_id?null:parentSpace(space)??space,space};
  }
}
