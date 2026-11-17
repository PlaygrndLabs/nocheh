import {blockingPublications} from './publications.js';
import {followUpTurn,ownerAutonomyGrant} from './owner-autonomy.js';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {conversationScope,ownerChat} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {telegramDestination} from '../chats-telegram.js';
import {fillLine,labelName,placeLabel,quotedName} from '../chat-labels.js';
import {allowedIn,servedDestination} from '../destinations.js';
import {approvalLines,ownerPrompts,type ApprovalText} from '../prompts.js';
import {telegramAddress,telegramTarget} from '../frontdoor/telegram.js';
import type {RuntimeCall} from '../runtime.js';
import {evaluate,recordEffect} from '../security/store.js';
import type {Effect} from '../security/contract.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import type {StorePools} from './connections.js';
import type {SourceReference} from './archive.js';
import {OperationRepository,type OperationReference} from './operations.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import {closedAs,ownerResolutions} from './controlled-action-schema.js';
import type {RuntimeTurnRepository} from './turns.js';
import {currentChats} from './chats.js';
import type {SendClass} from '../send-classes.js';

const protocol='telegram-action-v2';
// Owner-approved memory wording uses the memory input bound; native Telegram
// splitting preserves one action identity and rechecks authority for each chunk.
const trustedTextLimit=12000;
/** A notice as the bot takes it: at most 4000 UTF-16 units, never ending in half a character, with any lone surrogate
 * written as U+FFFD, so a cut name never makes Telegram refuse it. */
const noticeText=(text:string)=>text.slice(0,/[\uD800-\uDBFF]/.test(text.charAt(3999))?3999:4000)
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD');
/** The chat a chat or topic belongs to. */
const chatOf=(space:string)=>chats().parentOf(space)??space;
/** The classes an action's send may carry (ADR-0256); the schema's CHECK holds the same list. */
export type ActionSendClass=Extract<SendClass,'approved_post'|'job_report'|'scheduled_run'|'notice'>;
type PreparedSystemAction={id:string;source:SourceReference;proposal:DerivativeReference;binding:GuardBinding;
  scope:string|null;space:string;profile:string;destination:string;fingerprint:string;text_hash:string;guard_revision:number|null;send_class:ActionSendClass};
/** A trusted send's identity: its workflow key, source, authorization, destination and exact text. */
const systemActionId=(source:SourceReference,binding:GuardBinding,destination:string,text:string,key:string)=>
  digest(canonical(['nocheh-trusted-telegram-v1',key,source,binding,destination,text]));
export class TelegramActionRepository {
  constructor(readonly stores:StorePools,readonly access:SourceAccessRepository,readonly derived:DerivedRepository,
    readonly guards:GuardRepository,readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>){}
  private async row(id:string) {
    if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_action');
    const row=(await this.stores.control.query('SELECT * FROM telegram_action_requests WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');return row;
  }
  private effect(row:any):Effect {return {id:row.id,kind:'telegram.send',scope:row.scope,profile:row.profile,fingerprint:row.fingerprint};}
  private async memoryAuthority(row:any,workflow:unknown) {
    if(typeof workflow!=='string'||!workflow.startsWith('memory-access-followup:'))return;
    const id=workflow.slice('memory-access-followup:'.length);
    const grant=(await this.stores.control.query(`SELECT g.* FROM memory_fact_grants g JOIN memory_access_requests r ON r.id=g.request_id
      WHERE g.id=$1 AND g.delivery_action_id=$2 AND r.followup_action_id=$2 AND r.grant_id=g.id
      AND g.state='active' AND r.state='approved' AND (g.expires_at IS NULL OR g.expires_at>now())
      AND g.destination=$3 AND r.destination=$3 AND g.binding=$4 AND r.binding=$4
      AND g.text_hash=$5 AND r.source_reference=$6 AND g.fact_id=r.fact_id AND g.fact_revision=r.fact_revision`,
      [id,row.id,row.destination,row.binding,row.text_hash,row.source_reference])).rows[0];
    if(!grant)throw new HttpError(403,'action_delivery_denied');
    let current=false;
    try {
      const guarded=await this.guards.read('derived_artifacts:'+grant.representation_reference.id,row.binding),raw=String((guarded.value as any).text??'');
      const fact=(await this.stores.derived.query(`SELECT e.active_revision,v.retired,v.evidence FROM entity_claims e
        JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[grant.fact_id])).rows[0];
      current=!!fact&&!fact.retired&&fact.active_revision===grant.fact_revision&&guarded.revision===grant.guard_revision&&
        (digest(raw)===grant.text_hash||digest(raw.trim())===grant.text_hash);
      // A follow-up staged before private sources were left out never posts a fact that rests on one (ADR-0242).
      if(current&&await this.access.privateEvidence(fact.evidence))current=false;
    } catch(error) {if(!(error instanceof HttpError))throw error;}
    if(!current) {
      await this.stores.control.query(`UPDATE memory_fact_grants SET state='suspended',suspended_reason='followup_authority_changed',
        revision=revision+1,updated_at=now() WHERE id=$1 AND state='active' AND revision=$2`,[id,grant.revision]);
      throw new HttpError(403,'action_delivery_denied');
    }
    // A read or guard check can yield while the grant is consumed or expires.
    if(!(await this.stores.control.query(`SELECT 1 FROM memory_fact_grants WHERE id=$1 AND state='active' AND revision=$2
      AND (expires_at IS NULL OR expires_at>now())`,[id,grant.revision])).rowCount)throw new HttpError(403,'action_delivery_denied');
  }
  private async text(row:any,current=true):Promise<string> {
    if(current)await this.guards.assertCurrent(row.binding);
    const source=(await this.stores.derived.query('SELECT content_hash,provenance FROM derived_artifacts WHERE id=$1',[row.proposal_reference.id])).rows[0];
    if(source?.content_hash!==row.proposal_reference.input_hash)throw new HttpError(409,'action_proposal_changed');
    let value:any;
    if(row.guard_revision===null) {
      value=JSON.parse((await this.stores.derived.query('SELECT input FROM guard_sources WHERE id=$1',['derived_artifacts:'+row.proposal_reference.id])).rows[0]?.input.toString()??'null');
    } else {
      const guarded=(await this.stores.derived.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',
        ['derived_artifacts:'+row.proposal_reference.id,row.guard_revision])).rows[0];value=guarded?JSON.parse(guarded.content.toString()):null;
    }
    if(typeof value?.text!=='string'||digest(value.text)!==row.text_hash||digest(canonical({destination:row.destination,text:value.text}))!==row.fingerprint)
      throw new HttpError(409,'action_proposal_changed');
    if(current) {
      const active=await this.guards.read('derived_artifacts:'+row.proposal_reference.id,row.binding);
      if(active.revision!==row.guard_revision||digest(String((active.value as any).text))!==row.text_hash)throw new HttpError(409,'action_proposal_changed');
      await this.memoryAuthority(row,source.provenance?.trusted_workflow);
      await this.guards.assertCurrent(row.binding);
    }
    return value.text;
  }
  private async fence(db:pg.PoolClient,binding:GuardBinding) {
    const state=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(!state||canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode})!==canonical(binding))throw new HttpError(409,'action_context_changed');
    if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async request(principal:Reader,value:unknown) {
    if(principal.admin||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'external_effect_scope_denied');
    // A private answer only reads and talks; its own private chat is not a group it may post in (ADR-0249).
    if(principal.answer!==undefined)throw new HttpError(403,'private_answer_read_only');
    const turn=await this.turns.binding(principal),binding=await this.guards.state(),source=await this.prepared.root(principal,binding),input=object(value);
    if(Object.keys(input).some(key=>!['destination','text'].includes(key)))throw new HttpError(400,'invalid_action');
    let channel:string|undefined,requester:string|null=null;
    if(source.store==='archive') {
      const original=await this.access.archive.verify(source),intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
      if(original.origin!=='live'||intake?.transport==='import'||intake?.state==='pending')throw new HttpError(403,'external_effect_requires_live_turn');
      channel=original.channel;
      // Only a person allowed to talk to Nocheh in a group may post there without the owner.
      if(channel==='telegram')requester=await this.requester(source.id,original.scope);
    }
    return this.propose(principal,turn,binding,source,input,'approved_post',channel,requester);
  }
  /** Only a trusted completion path can stage delivery from a closed scheduled
   * run. This creates an exact proposal; it never reopens the runtime capability. */
  async requestScheduled(principal:Reader,id:string){
    admin(principal);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_run_identity');
    const row=(await this.stores.control.query("SELECT * FROM managed_runs WHERE event_id=$1 AND channel='scheduler'",[id])).rows[0];
    if(!row||row.state!=='done'||row.cancel_requested||!row.result_reference)return {state:'withheld',reason:'run_not_complete'};
    const version=(await this.stores.control.query(`SELECT v.*,a.execution_version AS active_execution,a.configuration AS active_configuration
      FROM schedule_versions v JOIN workflow_schedules s ON s.id=v.schedule_id JOIN schedule_versions a ON a.id=s.version_id WHERE v.id=$1`,[row.schedule_version])).rows[0];
    // A result held back for its chat is told to the owner once per run (ADR-0254); one kept in Nocheh was never to be sent.
    const telegram=version?.configuration?.deliver==='telegram';
    const untold=(reason:ApprovalText)=>telegram?this.ownerNotice(digest(canonical(['schedule-result-not-sent-v1',id])),'schedule_not_sent',{chat:row.scope,reason}):undefined;
    // Checked before the guard and the profile, which would refuse first and silently: a chat Nocheh no longer serves.
    if(telegram&&!servedDestination(this.access.policy(),row.scope,await currentChats())){await untold('reason_not_served');return {state:'withheld',reason:'destination_not_served'};}
    try{await this.guards.assertCurrent(row.binding);}catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;
      await untold('reason_settings_changed');return {state:'withheld',reason:'guard_context_changed'};}
    if(!version||version.execution_version!==version.active_execution||version.active_configuration.removed)return {state:'withheld',reason:'schedule_definition_changed'};
    const selected=await new RuntimeProfileRepository(this.access).resolve(principal,{profile:row.logical_profile});
    if(selected.logical_profile!==row.logical_profile||selected.scope!==row.scope||row.space_id!==row.scope)throw new HttpError(403,'profile_scope_denied');
    await new OperationRepository(this.stores.control).verify(row.source_reference);
    const result=await this.derived.checkpoint('scheduler-result:'+id);
    if(!result||result.id!==row.result_reference.id||result.content_hash!==row.result_reference.input_hash||result.kind!=='scheduled_result'||
      result.producer!=='hermes'||result.producer_version!=='managed-scheduler-v2'||canonical(result.operation_reference)!==canonical(row.source_reference))
      throw new HttpError(409,'run_result_conflict');
    const output=JSON.parse(result.content.toString());if(output.state!=='done')return {state:'withheld',reason:'run_not_complete'};
    const text=string(output.text,1000000);if(version.configuration.deliver!=='telegram'||!text.trim())return {state:'local'};
    if(text.length>3500)return {state:'withheld',reason:'result_exceeds_telegram_limit'};
    const audience:Reader={admin:false,scope:row.scope===ownerChat(this.access.policy())?null:row.scope,space:row.space_id,
      turnEvent:row.event_id,logical_profile:row.logical_profile,generation:row.binding.generation,guard_epoch:row.binding.epoch,revision:row.binding.epoch};
    return this.propose(audience,{scope:row.scope,logical_profile:row.logical_profile},row.binding,row.source_reference,{destination:row.scope,text},'scheduled_run');
  }
  /** The person who wrote a live group turn, when they are allowed to talk to Nocheh there; null for the owner's private chat. */
  private async requester(event:string,scope:string):Promise<string|null> {
    const row=(await this.stores.archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    const sender=row?conversationScope(this.access.policy(),JSON.parse(row.payload.toString()),scope):null;
    return sender&&!sender.owner?sender.user_id:null;
  }
  /** Groups where this person may talk to Nocheh, by their chat ids: the owner in every served group, others where
   * granted and not denied under any Telegram id the group has had, so an upgrade keeps who may talk there. */
  private allowedGroups(user:string):string[] {
    const policy=this.access.policy(),directory=chats();
    return directory.all().filter(chat=>chat.kind==='group'&&directory.served(chat.id)&&(user===policy.owner_id||allowedIn(policy,chat.id,user,directory))).map(chat=>chat.id);
  }
  /** Why a live group request needs no approval, or null: a post in the same
   * group, or the owner's own request for their private chat, which already
   * sees everything. */
  private groupRequest(principal:Reader,turn:{owner?:boolean;job?:string|null},destination:string,requester:string|null) {
    if(!requester||turn.owner||turn.job||!principal.scope||!principal.space||principal.purpose&&principal.purpose!=='assistant')return null;
    const policy=this.access.policy();
    if(requester===policy.owner_id&&destination===ownerChat(policy))return 'owner_private_request';
    // With separate topic memory a topic is its own audience; otherwise the whole group is.
    return (policy.topic_memory==='topic'?destination===principal.space:chatOf(destination)===principal.scope)?'same_group_request':null;
  }
  /** A message from one group to another, or from one topic to another when
   * topics keep separate memory, is reviewed by the person who asked when they
   * are allowed in both: the approval only lets them see what will be sent. The
   * owner reviews everything else, including their own requests. */
  async reviewer(id:string):Promise<{user:string;space:string}|null> {
    const row=(await this.stores.control.query('SELECT source_reference,space_id,destination FROM telegram_action_requests WHERE id=$1',[id])).rows[0];
    const source=row?.source_reference;if(source?.store!=='archive'||!row.space_id)return null;
    const original=await this.access.archive.verify(source);if(original.origin!=='live'||original.channel!=='telegram')return null;
    const user=await this.requester(source.id,original.scope),target=chatOf(String(row.destination));
    // A same-audience post never waits, so a pending one here crosses groups or separate topics.
    if(!user||user===this.access.policy().owner_id||String(row.destination)===row.space_id||!this.allowedGroups(user).includes(target))return null;
    return {user,space:row.space_id};
  }
  /** The groups where a live group turn's writer is allowed, with their known names, for exact destinations. */
  async destinations(principal:Reader) {
    if(principal.admin||!principal.scope||principal.answer!==undefined||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'group_turn_required');
    const turn=await this.turns.binding(principal);if(turn.owner||turn.job)throw new HttpError(403,'group_turn_required');
    const source=await this.prepared.root(principal,await this.guards.state());
    if(source.store!=='archive')throw new HttpError(403,'external_effect_requires_live_turn');
    const original=await this.access.archive.verify(source);
    if(original.origin!=='live'||original.channel!=='telegram')throw new HttpError(403,'external_effect_requires_live_turn');
    const requester=await this.requester(source.id,original.scope),groups=requester?this.allowedGroups(requester):[];
    // A group's name once the owner has refreshed it and Telegram answered, as before step 2b: the name that refresh
    // answered, never one a later update shows (ADR-0252; the old refresh table is only the seeder's now).
    const titles=new Map((await this.stores.control.query(`SELECT chat_id,refreshed_title FROM chat_details
      WHERE chat_id=ANY($1::text[]) AND refreshed_state='available' AND refreshed_title IS NOT NULL`,[groups])).rows
      .map(row=>[row.chat_id as string,row.refreshed_title as string]));
    return {groups:groups.map(group=>({destination:group,name:titles.get(group)??null,current:group===principal.scope})),
      note:'Use \'current\', or a chat id from this list or from owner_read; a topic has its own chat id. Nocheh posts only in the owner\'s private chat and its topics, the owner\'s selected groups and their topics, and the private chats of people the owner allowed in those groups. A message to this same group is posted without approval; a message to another group or to a person\'s private chat is shown to the owner to approve first.'};
  }
  private async propose(principal:Reader,turn:{scope:string;logical_profile:string;owner?:boolean;job?:string|null},binding:GuardBinding,
    source:SourceReference|OperationReference,input:Record<string,unknown>,sendClass:ActionSendClass,channel?:string,requester:string|null=null){
    // 'current' is the chat or topic of the live turn; anything else must name a chat the directory knows (ADR-0252), and
    // either must be a chat Nocheh serves (ADR-0254). An unknown chat and one not served answer alike, so nothing is learned
    // by asking. A turn with no live Telegram message (a job, a schedule, the web chat) has no 'current': a bad request as
    // before, never a claim that its chat is not served.
    const requested=string(input.destination,200),text=string(input.text,3500),directory=await currentChats();
    if(!text.trim()||requested==='current'&&channel!=='telegram')throw new HttpError(400,'invalid_action');
    const destination=requested==='current'?principal.space??turn.scope:telegramDestination(requested,directory);
    if(!destination||!servedDestination(this.access.policy(),destination,directory))throw new HttpError(403,'destination_not_served');
    const id=digest(canonical([protocol,source,binding,destination,text]));
    const proposal=await this.derived.record({operation_id:'telegram-proposal:'+id,source,kind:'action_request',content:Buffer.from(text),
      producer:'nocheh',producer_version:protocol,configuration:{destination,binding},provenance:{purpose:'exact_owner_approval'}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),preparedText=string((representation.value as any).text,3500);
    if(!preparedText.trim())throw new HttpError(400,'invalid_action');
    // The request names its chat by its Nocheh id, as its space and destination do (ADR-0252): a group first seen after
    // step 2b, or upgraded since, has no archive scope that is its id.
    const chat=principal.scope??chatOf(principal.space??turn.scope);
    const fingerprint=digest(canonical({destination,text:preparedText})),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');await this.fence(db,binding);
      await db.query(`INSERT INTO telegram_action_requests(id,source_reference,proposal_reference,binding,scope,space_id,profile,destination,fingerprint,text_hash,guard_revision,send_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [id,source,proposal,binding,chat,principal.space,turn.logical_profile,destination,fingerprint,digest(preparedText),representation.revision,sendClass]);
      const row=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1',[id])).rows[0];
      if(row.fingerprint!==fingerprint||canonical(row.proposal_reference)!==canonical(proposal))throw new HttpError(409,'action_proposal_changed');
      const effect=this.effect(row);let decision=await evaluate(db,effect);
      // The owner freedom setting lets the owner's own live private request
      // approve itself. Deny rules are evaluated first and still block it.
      // A person allowed to talk to Nocheh in a group can have it post in that
      // same group: the group's memory is all such a turn can read, so the post
      // reveals nothing a reply there could not. A message built from one
      // group's memory for another group waits for the owner. Deny rules still
      // apply first. The owner's own request from a group for their private
      // chat needs no approval either.
      // A follow-up was not asked by the owner: its private chat gets nothing from it without a card (ADR-0212).
      // The freedom setting covers only what stays on the owner's private side: a message for any group or topic
      // always waits for its card in the private chat, which names that chat and shows the exact text (ADR-0244).
      const owner=ownerChat(this.access.policy()),toOwner=!!owner&&chatOf(destination)===owner;
      const group=source.store==='archive'&&row.state==='proposed'&&decision.outcome==='ask'?this.groupRequest(principal,turn,destination,requester):null;
      const autonomy=source.store==='archive'&&row.state==='proposed'&&decision.outcome==='ask'?
        (group==='owner_private_request'&&await followUpTurn(db,principal)?null:group)??(toOwner?await ownerAutonomyGrant(db,principal,turn):null):null;
      if(autonomy)decision=await evaluate(db,effect,autonomy);
      await recordEffect(db,effect,'proposed',decision,source);
      if(autonomy&&decision.outcome==='allow') {
        const revision=row.revision+1,hash=digest(canonical({id,fingerprint:row.fingerprint,decision:'approve',source,authority:autonomy}));
        await db.query("UPDATE telegram_action_requests SET state='approved',revision=$2,decision_reference=$3,updated_at=now() WHERE id=$1 AND state='proposed'",[id,revision,source]);
        await db.query(`INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision,source_reference)
          VALUES($1,$2,$3,'approve',$4,$5) ON CONFLICT DO NOTHING`,['owner-autonomy:'+id,hash,id,revision,source]);
        await recordEffect(db,effect,'allowed',decision,source);await requestWorkflow(db,'actions',id);
        await db.query('COMMIT');return {id,state:'approved',fingerprint,message:autonomy==='owner_private_request'?'Approved: this goes to the owner\'s own private chat, so it is being sent there now. Confirm in one short sentence without repeating the message.':
          autonomy!=='same_group_request'?'Approved by your own request under the owner freedom setting; sending now.':
          destination===principal.space?'Approved: you were asked here for a message to this same chat, so it is being posted now. Do not repeat or announce it; return [NO_REPLY] unless something else needs an answer.':
          'Approved: this is for the same group, so it is being posted there now. Confirm in one short sentence without repeating the message.'};
      }
      await recordEffect(db,effect,decision.outcome==='deny'?'blocked':'awaiting_approval',decision,source);
      await db.query('COMMIT');return {id,state:row.state,fingerprint,message:'Owner approval is required for this exact message and destination.'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Stage an exact message from a trusted owner-policy workflow. The caller
   * supplies the durable source and audience; the normal guard, security,
   * delivery authorization, workflow, and receipt path still applies. */
  async approvedSystem(principal:Reader,source:SourceReference,binding:GuardBinding,destination:string,text:string,key:string,sendClass:ActionSendClass) {
    const prepared=await this.prepareSystem(principal,source,binding,destination,text,key,sendClass),db=await this.stores.control.connect();
    try {await db.query('BEGIN');const action=await this.stageSystem(db,prepared);await db.query('COMMIT');return action;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Whether this exact trusted send was ever prepared: the proposal `prepareSystem` records first, before any commit. */
  async systemPrepared(source:SourceReference,binding:GuardBinding,destination:string,text:string,key:string):Promise<boolean> {
    return !!(await this.stores.derived.query('SELECT 1 FROM derived_artifacts WHERE operation_id=$1',['telegram-system-proposal:'+systemActionId(source,binding,destination,text,key)])).rowCount;
  }
  /** Prepare derived bytes before acquiring control locks; preparation can itself publish guard records. Every caller says
   * what kind of message it sends; the class is not part of the action's identity. */
  async prepareSystem(principal:Reader,source:SourceReference,binding:GuardBinding,destination:string,text:string,key:string,sendClass:ActionSendClass):Promise<PreparedSystemAction> {
    if(principal.admin||!principal.space||!principal.logical_profile)throw new HttpError(403,'bound_guard_context_required');
    if(!text.trim()||text.length>trustedTextLimit)throw new HttpError(400,'invalid_action');
    if(!servedDestination(this.access.policy(),destination,await currentChats()))throw new HttpError(403,'destination_not_served');
    await this.guards.assertCurrent(binding);await this.access.archive.verify(source);
    const id=systemActionId(source,binding,destination,text,key);
    const proposal=await this.derived.record({operation_id:'telegram-system-proposal:'+id,source,kind:'action_request',content:Buffer.from(text),
      producer:'nocheh',producer_version:protocol,configuration:{destination,binding,key},provenance:{purpose:'exact_owner_approval',trusted_workflow:key}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,binding),preparedText=string((representation.value as any).text,trustedTextLimit);
    if(!preparedText.trim())throw new HttpError(400,'invalid_action');
    // The owner's own audience is stored by the owner's chat, as their requests are.
    return {id,source,proposal,binding,scope:principal.scope??ownerChat(this.access.policy()),space:principal.space,profile:principal.logical_profile,destination,
      fingerprint:digest(canonical({destination,text:preparedText})),text_hash:digest(preparedText),guard_revision:representation.revision,send_class:sendClass};
  }
  /** Trusted callers commit this action and its workflow request with their own control decision. */
  async stageSystem(db:pg.PoolClient,prepared:PreparedSystemAction,options:{resumeUnstarted?:boolean}={}) {
    const {id,source,proposal,binding,scope,space,profile,destination,fingerprint,text_hash,guard_revision,send_class}=prepared;
    await this.fence(db,binding);
    await db.query(`INSERT INTO telegram_action_requests(id,source_reference,proposal_reference,binding,scope,space_id,profile,destination,fingerprint,text_hash,guard_revision,state,authority,send_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved','exact_owner_approval',$12) ON CONFLICT DO NOTHING`,
        [id,source,proposal,binding,scope,space,profile,destination,fingerprint,text_hash,guard_revision,send_class]);
    let row=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(row.fingerprint!==fingerprint||canonical(row.proposal_reference)!==canonical(proposal))throw new HttpError(409,'action_proposal_changed');
    // Exact owner-command recovery may finish an older interrupted handoff.
    // A native attempt or result permanently excludes this resumption path.
    if(options.resumeUnstarted&&row.state==='cancelled'&&row.error_code==='action_delivery_denied'&&
      row.security_decision===null&&row.result_reference===null)row=(await db.query(`UPDATE telegram_action_requests
        SET state='approved',error_code=NULL,next_attempt=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id])).rows[0];
    const effect=this.effect(row),decision=await evaluate(db,effect,row.authority,true);
    if(decision.outcome!=='allow')throw new HttpError(403,'action_delivery_denied');
    await recordEffect(db,effect,'allowed',decision,source);await requestWorkflow(db,'actions',id);
    return {id,state:row.state,fingerprint};
  }
  async inspect(principal:Reader,id:string) {
    const row=await this.row(id);
    if(!principal.admin) {
      // Any later turn of the same chat and profile can follow its own requests, as with controlled actions.
      const turn=await this.turns.binding(principal);
      if(principal.space!==row.space_id||turn.logical_profile!==row.profile)throw new HttpError(404,'action_not_found');
    }
    const text=await this.text(row,!principal.admin),result=row.result_reference?(await this.stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0]:null;
    if(!principal.admin){await this.prepared.allow(principal,{text});await this.turns.assertAudience(principal);}
    return {id:row.id,event_id:row.source_reference.id,scope:row.scope,profile:row.profile,kind:'telegram_message',arguments:{destination:row.destination,text},
      fingerprint:row.fingerprint,state:row.state,revision:row.revision,error_code:row.error_code,...closedAs(row),created_at:row.created_at,result:result?JSON.parse(result.content.toString()):null};
  }
  /** This chat's most recent message requests and their states, for a later turn that no longer holds their IDs. */
  async recent(principal:Reader) {
    const turn=await this.turns.binding(principal);
    // States and destinations only, so a quick look needs no content check; a request's text is read by its ID.
    const rows=(await this.stores.control.query(`SELECT id,destination,state,error_code,resolution,created_at FROM telegram_action_requests
      WHERE space_id=$1 AND profile=$2 ORDER BY created_at DESC,id DESC LIMIT 10`,[principal.space,turn.logical_profile])).rows;
    return rows.map(row=>({id:row.id,destination:row.destination,state:row.state,error_code:row.error_code,resolution:closedAs(row).resolution,created_at:row.created_at.toISOString()}));
  }
  async list(principal:Reader) {
    admin(principal);const rows=(await this.stores.control.query('SELECT id FROM telegram_action_requests ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    return Promise.all(rows.map(row=>this.inspect(principal,row.id)));
  }
  /** Tells the owner, in their private chat, that a scheduled task's result, a schedule's run or a job's report did not
   * reach its chat, and why, in the owner's editable words (ADR-0254). The id makes the bot send it once. A notice that
   * fails shows in System › Health and never causes another (SPECS.md); the caller goes on either way. */
  async ownerNotice(id:string,key:'schedule_not_sent'|'schedule_not_run'|'job_report_not_sent',values:{chat:string;reason:ApprovalText;title?:string}):Promise<void> {
    try {
      const owner=ownerChat(this.access.policy());if(!owner)return;
      const line=approvalLines((await ownerPrompts(this.stores.control))['telegram.approval_texts']),directory=await currentChats();
      // One pass: a name that holds {chat} or {reason} stays as written, and the line is never dropped.
      const text=noticeText(fillLine(line[key],{chat:placeLabel(values.chat,line,directory),reason:line[values.reason],
        ...(values.title===undefined?{}:{title:quotedName(labelName(values.title)??'')})}));
      await this.call('telegram.notice',{id,...telegramTarget(owner,directory),text},30000);
    }catch{/* Shown in System › Health by the bot; nothing here waits for it. */}
  }
  /** Trusted native sender rechecks the exact approved payload immediately before sending. */
  async authorizeDelivery(value:unknown) {
    const body=object(value),row=await this.row(string(body.id,64));
    // The bot sends to the chat and topic the destination has in Telegram now, which storage gave it (ADR-0252).
    const target=telegramAddress(row.destination);
    if(row.state!=='running'||body.destination!==row.destination||typeof body.text!=='string'||
      digest(canonical({destination:body.destination,text:body.text}))!==row.fingerprint||!target||
      String(body.chat_id)!==target.chat_id||(body.topic==null?undefined:String(body.topic))!==(target.topic===undefined?undefined:String(target.topic))||
      // The last word, asked by the bot before each message it sends: a chat Nocheh no longer serves gets nothing.
      !servedDestination(this.access.policy(),row.destination,await currentChats()))
      throw new HttpError(403,'action_delivery_denied');
    await this.text(row);
    if((await evaluate(this.stores.control,this.effect(row),row.authority??'exact_owner_approval')).outcome!=='allow')
      throw new HttpError(403,'action_delivery_denied');
    await this.guards.assertCurrent(row.binding);return {valid:true};
  }
  async decide(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=object(value);
    if(Object.keys(body).some(key=>!['id','fingerprint','decision','operation_id','expected_revision'].includes(key))||
      !['approve','deny'].includes(String(body.decision)))throw new HttpError(400,'invalid_decision');
    const id=string(body.id,64),row=await this.row(id);
    if(body.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
    if(source)await this.access.archive.verify(source);
    const request={id,fingerprint:row.fingerprint,decision:body.decision,source:source??null},hash=digest(canonical(request));
    const operation=body.operation_id===undefined?'telegram-decision:'+hash:string(body.operation_id,200),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const current=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const prior=(await db.query('SELECT * FROM telegram_action_decisions WHERE operation_id=$1',[operation])).rows[0];
      if(prior) {
        if(prior.request_hash!==hash)throw new HttpError(409,'action_decision_conflict');
        await db.query('COMMIT');return {id,state:current.state,revision:current.revision,...(current.state==='cancelled'?{error_code:current.error_code as string|null}:{})};
      }
      if(body.expected_revision!==undefined&&body.expected_revision!==current.revision)throw new HttpError(409,'action_revision_changed');
      if(current.state!=='proposed')throw new HttpError(409,'action_already_started_or_closed');
      if(body.decision==='approve') {
        // A send that can never go out now is closed, its approval kept, so the press, /approve and the card say why instead of
        // buttons that fail on every press (ADR-0254). An unserved chat is asked first: the settings change that deselects a
        // group also moves the epoch. A pending publication passes, so it stays an error.
        let closed:string|null=servedDestination(this.access.policy(),current.destination,await currentChats())?null:'destination_not_served';
        if(!closed)try{await this.fence(db,current.binding);await this.text(current);}catch(error){
          if(!(error instanceof HttpError)||!['action_context_changed','guard_context_changed','action_proposal_changed','action_delivery_denied'].includes(error.code))throw error;
          closed=error.code==='guard_context_changed'?'action_context_changed':error.code;
        }
        if(closed) {
          const revision=current.revision+1;
          await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code=$4,revision=$2,decision_reference=$3,updated_at=now() WHERE id=$1",[id,revision,source??null,closed]);
          await db.query("INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision,source_reference) VALUES($1,$2,$3,'approve',$4,$5)",[operation,hash,id,revision,source??null]);
          // The reason rides along for the dashboard; the press and /approve read it from the row.
          await db.query('COMMIT');return {id,state:'cancelled',revision,error_code:closed};
        }
      }
      const state=body.decision==='approve'?'approved':'rejected',revision=current.revision+1;
      await db.query('UPDATE telegram_action_requests SET state=$2,revision=$3,decision_reference=$4,updated_at=now() WHERE id=$1',[id,state,revision,source??null]);
      await db.query('INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision,source_reference) VALUES($1,$2,$3,$4,$5,$6)',[operation,hash,id,body.decision,revision,source??null]);
      if(state==='approved')await requestWorkflow(db,'actions',id);
      await db.query('COMMIT');return {id,state,revision};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** The owner's word on an unclear send, after looking in the chat: it arrived, it did not, or dismiss it. The state
   *  stays as observed, its checks stop, and it is never sent again (ADR-0218). */
  async resolve(principal:Reader,value:unknown) {
    admin(principal);const body=object(value);
    if(Object.keys(body).some(key=>!['id','fingerprint','outcome','operation_id','expected_revision'].includes(key))||
      !ownerResolutions.includes(body.outcome as any))throw new HttpError(400,'invalid_decision');
    const id=string(body.id,64),row=await this.row(id);
    if(body.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
    const request={id,fingerprint:row.fingerprint,decision:body.outcome},hash=digest(canonical(request));
    const operation=body.operation_id===undefined?'telegram-resolution:'+hash:string(body.operation_id,200),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      // The lock a check of this send holds, so a check in flight finishes before the owner's word is saved.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803363))',[id]);
      const current=(await db.query('SELECT * FROM telegram_action_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const prior=(await db.query('SELECT * FROM telegram_action_decisions WHERE operation_id=$1',[operation])).rows[0];
      if(prior) {
        if(prior.request_hash!==hash)throw new HttpError(409,'action_decision_conflict');
        await db.query('COMMIT');return {id,state:current.state,resolution:current.resolution,revision:current.revision};
      }
      if(body.expected_revision!==undefined&&body.expected_revision!==current.revision)throw new HttpError(409,'action_changed');
      if(current.state!=='ambiguous'||current.resolution)throw new HttpError(409,'action_already_started_or_closed');
      const revision=current.revision+1;
      await db.query('UPDATE telegram_action_requests SET resolution=$2,resolved_at=now(),revision=$3,updated_at=now() WHERE id=$1',[id,body.outcome,revision]);
      await db.query('INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision) VALUES($1,$2,$3,$4,$5)',[operation,hash,id,body.outcome,revision]);
      await db.query('COMMIT');return {id,state:current.state,resolution:body.outcome,revision};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    const db=await this.stores.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'actions',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803363)) AS held',[id])).rows[0].held;
      if(!locked)return observation('waiting','action',0,Date.now()+2000,'receipt_pending');
      let row=await this.row(id);
      if(['done','rejected','cancelled'].includes(row.state))return observation(row.state==='done'?'completed':row.state==='rejected'?'denied':'cancelled','action');
      // The owner closed an unclear send: nothing is checked or sent any more (ADR-0218).
      const closed=row.state==='ambiguous'&&!!row.resolution;
      if(row.state==='proposed')return observation('waiting','action',0,Date.now()+30000,'approval_required');
      if(!closed&&row.next_attempt>new Date())return observation('waiting','action',0,row.next_attempt.getTime(),'receipt_pending');
      const observe=['running','ambiguous'].includes(row.state),effect=this.effect(row);
      let decision=row.security_decision,text:string|undefined;
      const finish=async(state:'done'|'denied'|'ambiguous',result:unknown,code?:string)=>{
        await db.query('BEGIN');
        try {
          // A check that finds the same unclear outcome changes nothing, so its revision stays and an open review stays usable.
          await db.query(`UPDATE telegram_action_requests SET state=$2,result_reference=$3,error_code=$4,next_attempt=now()+interval '60 seconds',
            revision=revision+CASE WHEN state IS DISTINCT FROM $2 OR result_reference IS DISTINCT FROM $3::jsonb OR error_code IS DISTINCT FROM $4 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`,
            [id,state==='denied'?'rejected':state,result,state==='done'?null:code??(state==='denied'?'action_delivery_denied':'delivery_unconfirmed')]);
          if(decision)await recordEffect(db,effect,state==='done'?'completed':state==='denied'?'blocked':'ambiguous',decision,row.source_reference);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
        return observation(state==='done'?'completed':state==='denied'?'denied':'waiting',state==='ambiguous'?'reconcile':'action',1,Date.now()+60000,state==='ambiguous'?'receipt_pending':null);
      };
      // A send the bot refused because Nocheh no longer serves its chat keeps that reason, so its card says so.
      const refused=async(state:string)=>state==='denied'&&!servedDestination(this.access.policy(),row.destination,await currentChats())?'destination_not_served':undefined;
      const durable=await this.derived.checkpoint('telegram-action-result:'+id+':done')??await this.derived.checkpoint('telegram-action-result:'+id+':denied');
      if(durable) {
        const state=JSON.parse(durable.content.toString()).state;
        if(digest(durable.content)!==durable.content_hash||!['done','denied'].includes(state)||durable.content.toString()!==canonical({state}))throw new HttpError(409,'action_result_conflict');
        return await finish(state,{store:'derived',kind:'artifact',id:durable.id,input_hash:durable.content_hash},await refused(state));
      }
      // A receipt saved before the owner's word still settles it, above; otherwise the word stands.
      if(closed)return observation(row.resolution==='ran'?'completed':'skipped','action');
      if(!observe) {
        try{text=await this.text(row);}catch(error){
          if(error instanceof HttpError&&error.code==='action_delivery_denied') {
            await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code='action_delivery_denied',revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved'",[id]);
            // The request keeps its own reason; the workflow observation uses a reason the boundary allows.
            return observation('cancelled','action',0,Date.now(),'superseded');
          }
          if(error instanceof HttpError&&error.code==='guard_context_changed') {
            await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code='action_context_changed',revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved'",[id]);
            return observation('cancelled','action',0,Date.now(),'superseded');
          }throw error;
        }
        // A chat Nocheh stopped serving after the approval, or one the directory no longer knows, gets nothing: the send is
        // closed with its reason instead of waiting for a chat that never comes back (ADR-0254).
        if(!servedDestination(this.access.policy(),row.destination,await currentChats())) {
          await db.query("UPDATE telegram_action_requests SET state='cancelled',error_code='destination_not_served',revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved'",[id]);
          return observation('cancelled','action',0,Date.now(),'superseded');
        }
        await db.query('BEGIN');
        try {
          await this.fence(db,row.binding);decision=await evaluate(db,effect,row.authority??'exact_owner_approval',true);
          if(decision.outcome!=='allow') {
            // A rule refused it at the start: its own reason, so the approved card does not read like the owner's Reject.
            await recordEffect(db,effect,'blocked',decision,row.source_reference);await db.query("UPDATE telegram_action_requests SET state='rejected',error_code='security_start_denied',security_decision=$2,revision=revision+1,updated_at=now() WHERE id=$1",[id,decision]);
            await db.query('COMMIT');return observation('denied','action');
          }
          const claimed=await db.query("UPDATE telegram_action_requests SET state='running',security_decision=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='approved' AND revision=$3 RETURNING id",[id,decision,row.revision]);
          if(!claimed.rowCount)throw new HttpError(409,'action_changed');
          await recordEffect(db,effect,'allowed',decision,row.source_reference);await recordEffect(db,effect,'started',decision,row.source_reference);await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
      }
      let response:Record<string,unknown>;
      // The bot is given the destination's chat and topic in Telegram now, so a send follows a group Telegram upgraded.
      // A destination the directory no longer knows is refused before anything is sent.
      let target:ReturnType<typeof telegramTarget>|null=null;
      if(!observe)try{target=telegramTarget(row.destination);}catch(error){if(!(error instanceof HttpError))throw error;}
      try {response=observe?await this.call('action.execute',{id,observe_only:true},10000):
        target?await this.call('action.execute',{id,destination:row.destination,...target,text:text!,send_class:row.send_class??'approved_post'},60000):{state:'not_started'};}
      catch {response={state:'ambiguous'};}
      if(!observe&&response.state==='not_started') {
        // The runtime refused before recording any send intent: nothing was
        // attempted. Return to the approved queue; authority is rechecked.
        await db.query(`UPDATE telegram_action_requests SET state='approved',error_code='telegram_unavailable',next_attempt=now()+interval '30 seconds',
          revision=revision+1,updated_at=now() WHERE id=$1 AND state='running'`,[id]);
        if(decision)await recordEffect(db,effect,'failed',decision,row.source_reference);
        return observation('waiting','action',1,Date.now()+30000,'runtime_unavailable');
      }
      const state=response.state==='done'?'done':response.state==='denied'?'denied':'ambiguous',result=await this.derived.record({operation_id:'telegram-action-result:'+id+':'+(state==='ambiguous'?'uncertain':state),
        source:row.source_reference,parents:[row.proposal_reference],kind:'action_result',content:Buffer.from(canonical({state})),
        producer:'hermes',producer_version:protocol,configuration:{id},provenance:{binding:row.binding,native_receipt:id}});
      return await finish(state,result,await refused(state));
    }finally{await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803363))',[id]);if(held)await leaveFamily(db,'actions');});}
  }
}
