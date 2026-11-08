import {blockingPublications} from './publications.js';
import {followUpTurn,ownerAutonomyGrant} from './owner-autonomy.js';
import {followUpLeft} from './action-continuations.js';
import {notionAuthority} from './notion.js';
import {ownerApprovedJob,relaunchedRun} from './background-jobs.js';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {actionArguments,ruleKey} from '../action-arguments.js';
import {HttpError,object,string} from '../http.js';
import {decide,validatePolicy,type Effect} from '../security/contract.js';
import {evaluate,policySnapshot,recordEffect} from '../security/store.js';
import {requestWorkflow} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository} from './derived.js';
import {afterEpoch,carriesForward,jobRun,type GuardRepository,type GuardBinding} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {SourceReference} from './archive.js';
import {closedAs,ownerResolutions} from './controlled-action-schema.js';

const protocol='controlled-action-v2';
const identity=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_action_id');return id;};
const exact=(value:unknown,keys:string[])=>{const body=object(value);if(Object.keys(body).some(k=>!keys.includes(k)))throw new HttpError(400,'unknown_action_field');return body;};
/** How long a chat rule from a card button lasts, in minutes, by what it covers (ADR-0214): a site here for a
 * session of 12 hours or for 30 days, an exact command for 30 days. Telegram and Notion keep their own decisions. */
export const ruleMinutes:Record<string,Partial<Record<'here'|'always',number>>>={browser:{here:720,always:43200},shell:{always:43200}};
const ruleUses=1000;
/** Whether a standing permission still covers an operation: an exact grant its fingerprint and epoch, a chat rule its
 * site or command, kind, chat or topic, profile and installation generation, never a job's operation (ADR-0214). */
export const covers=(grant:any,row:any)=>grant.grain==='chat'?row.job_id===null&&!!row.match_key&&grant.match_key===row.match_key&&grant.kind===row.kind&&
  grant.space_id===row.space_id&&grant.logical_profile===row.logical_profile&&grant.binding?.generation===row.binding?.generation:
  grant.fingerprint===row.fingerprint&&canonical(grant.binding)===canonical(row.binding)&&(grant.job_id===null||grant.job_id===row.job_id);

/** Content and owner-edit history remain derived; authority and effects remain control. */
export class ControlledActionRepository {
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly guards:GuardRepository,
    readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,readonly detect:(text:string)=>Promise<unknown>){}
  get control(){return this.access.stores.control;}
  async row(id:unknown) {
    const row=(await this.control.query('SELECT * FROM controlled_actions WHERE id=$1',[identity(id)])).rows[0];
    if(!row)throw new HttpError(404,'action_not_found');return row;
  }
  effect(row:any):Effect {return {id:row.id,kind:row.kind,scope:row.scope,profile:row.logical_profile,fingerprint:row.fingerprint,...(row.job_id?{job:row.job_id}:{})};}
  async fence(db:pg.PoolClient,binding:GuardBinding) {
    const state=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    // An action stays bound to its own epoch; only later quiet epochs carry it (ADR-0200).
    if(!state||!await carriesForward(db,binding,{generation:state.generation,epoch:Number(state.epoch),mode:state.mode}))throw new HttpError(409,'guard_context_changed');
    if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  async arguments(row:any,current=true) {
    const live=current?await this.guards.assertCarried(row.binding):null;
    const reference=row.proposal_reference,id='derived_artifacts:'+reference.id;
    const artifact=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(artifact?.content_hash!==reference.input_hash)throw new HttpError(409,'action_proposal_changed');
    const saved=row.guard_revision===null?(await this.derived.pool.query('SELECT input AS content FROM guard_sources WHERE id=$1',[id])).rows[0]:
      (await this.derived.pool.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,row.guard_revision])).rows[0];
    if(!saved)throw new HttpError(409,'action_proposal_changed');
    const document=JSON.parse(saved.content.toString()),args=actionArguments(row.kind,JSON.parse(document.text),true);
    if(digest(canonical(args))!==row.arguments_hash||digest(canonical({binding:row.binding,scope:row.scope,profile:row.logical_profile,kind:row.kind,arguments:args,job:row.job_id}))!==row.fingerprint)
      throw new HttpError(409,'action_proposal_changed');
    if(live) {
      const active=await this.guards.read(id,live);
      if(active.revision!==row.guard_revision||canonical(active.value)!==canonical(document))throw new HttpError(409,'action_proposal_changed');
    }
    return args;
  }
  /** A job run's request runs again when an epoch it carries across commits meanwhile (ADR-0208); its ids come from its own binding. */
  async propose(principal:Reader,value:unknown) {return afterEpoch(jobRun(principal),()=>this.proposeOnce(principal,value));}
  private async proposeOnce(principal:Reader,value:unknown) {
    if(principal.admin||principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'external_effect_scope_denied');
    const body=exact(value,['kind','arguments']),raw=actionArguments(body.kind,body.arguments),turn=await this.turns.binding(principal),current=await this.guards.state();
    // Bound to the asking turn's own binding: the current one, or the earlier one of a job's run that carries to it (ADR-0208).
    // It carries from there; its profile, the run's own, holds the run's workspace and lets the run read it back.
    const binding={...current,generation:turn.generation??current.generation,epoch:turn.guard_epoch};
    const source=await this.prepared.root(principal,current);
    if('connection' in raw)await notionAuthority(this.control,principal,turn,raw,false);
    let telegram=false;
    if(source.store==='archive') {
      const original=await this.access.archive.verify(source),intake=(await this.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
      if(original.origin!=='live'||intake?.transport==='import'||intake?.state==='pending')throw new HttpError(403,'external_effect_requires_live_turn');
      telegram=original.channel==='telegram';
    }
    const id=digest(canonical([protocol,source,binding,body.kind,raw])),proposal=await this.derived.record({operation_id:'controlled-proposal:'+id,
      source,kind:'controlled_action_request',content:Buffer.from(canonical(raw)),producer:'nocheh',producer_version:protocol,configuration:{binding,kind:body.kind}});
    await this.guards.prepareContext(proposal,protocol,principal,this.prepared,this.detect);
    const representation=await this.guards.read('derived_artifacts:'+proposal.id,current),args=actionArguments(body.kind,JSON.parse((representation.value as any).text));
    const fingerprint=digest(canonical({binding,scope:turn.scope,profile:turn.logical_profile,kind:body.kind,arguments:args,job:turn.job??null}));
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');await this.fence(db,binding);
      // A stopping or ended job asks for nothing more. The lock orders this against Stop, so what commits
      // first is ended by Stop's sweep (ADR-0204). A scheduled task's job is no background job.
      const job=turn.job?(await db.query('SELECT state,cancel_requested FROM background_jobs WHERE id=$1 FOR SHARE',[turn.job])).rows[0]:null;
      if(job&&(job.state!=='running'||job.cancel_requested))throw new HttpError(409,'job_not_running');
      // A follow-up was started by Nocheh after a result came back, not asked by anyone: like a job's operation, what it
      // asks for has no rule key, so no chat rule covers it and its card offers no rule (ADR-0212, ADR-0214).
      const followUp=source.store==='archive'&&await followUpTurn(db,principal);
      await db.query(`INSERT INTO controlled_actions(id,event_id,source_reference,proposal_reference,binding,guard_revision,scope,space_id,profile,logical_profile,kind,fingerprint,arguments_hash,job_id,match_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
        [id,source.id,source,proposal,binding,representation.revision,turn.scope,principal.space,turn.profile,turn.logical_profile,body.kind,fingerprint,digest(canonical(args)),turn.job??null,
          turn.job||followUp?null:ruleKey(body.kind as string,args)]);
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
      if(row.fingerprint!==fingerprint)throw new HttpError(409,'action_proposal_changed');
      const grant=(await this.grants(row,db))[0];let decision=await evaluate(db,this.effect(row),row.state==='approved'?'exact_owner_approval':grant?.id);
      // The owner freedom setting lets the owner's own live private request
      // approve itself. Deny rules are evaluated first and still block it.
      // Notion is used only from the owner's private chat while it is on; the
      // owner's Notion setting can let reads, or every call, run without a card,
      // from a live turn there or a run of a job the owner approved there
      // (ADR-0203). It replaces the owner freedom setting for Notion calls; that
      // setting never applies to jobs. A relaunched run of a job (attempt > 1) gets
      // no autonomy: every change it asks for waits for a card (ADR-0207), and
      // neither does a follow-up turn, which no owner request started (ADR-0212).
      const connected='connection' in args,live=source.store==='archive'&&!followUp,fresh=!turn.job||!await relaunchedRun(db,source.id);
      const notion=connected?await notionAuthority(db,principal,turn,args,turn.job?fresh&&await ownerApprovedJob(db,this.access.policy().owner_id,source,turn):live):null;
      const autonomy=row.state==='proposed'&&decision.outcome==='ask'?connected?notion:live?await ownerAutonomyGrant(db,principal,turn):null:null;
      if(autonomy)decision=await evaluate(db,this.effect(row),autonomy);
      if(autonomy&&decision.outcome==='allow')
        await db.query("UPDATE controlled_actions SET state='approved',decision_reference=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='proposed'",[id,source]);
      await recordEffect(db,this.effect(row),'proposed',decision,source);
      await recordEffect(db,this.effect(row),decision.outcome==='deny'?'blocked':decision.outcome==='allow'?'allowed':'awaiting_approval',decision,source,grant?.id);
      await requestWorkflow(db,'tools',id);await db.query('COMMIT');
      if(autonomy&&decision.outcome==='allow')return {id,state:'approved',fingerprint,allowed:true,message:autonomy===notion?'Allowed by the owner\'s Notion setting; it will run now.':
        // Only a Telegram chat gets the follow-up turn, at most three per asking message (ADR-0212); a browser turn reads the operation itself.
        telegram&&await followUpLeft(db,source.id)?'Approved by your own request under the owner freedom setting; it runs now. Its answer will follow here as a reply; do not wait for it, say only that it is running.':
        'Approved by your own request under the owner freedom setting; it will run now.'};
      // A rule the owner set for this chat, or an exact permission, lets it run without a card.
      if(row.state==='proposed'&&grant&&decision.outcome==='allow')return {id,state:row.state,fingerprint,allowed:true,message:
        telegram&&!turn.job&&await followUpLeft(db,source.id)?'Allowed by a rule the owner set for this chat; it runs now. Its answer will follow here as a reply; do not wait for it, say only that it is running.':
        'Allowed by a rule the owner set; it runs now.'};
      return {id,state:row.state,fingerprint,message:'Review the exact operation. Execution requires owner approval or a current bounded permission.'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** `inTurn` is the asking turn's own note, sent once its tool holds the ended result, of the state it read (ADR-0215). */
  async inspect(principal:Reader,id:unknown,inTurn:string|null=null) {
    const row=await this.row(id);
    if(!principal.admin) {
      // The same chat, owner or member, purpose and profile as the asker, under the action's own epoch.
      await this.turns.binding(principal);
      if(principal.space!==row.space_id||this.turns.profile(principal,row.binding)!==row.profile)throw new HttpError(404,'action_not_found');
    }
    if(inTurn!==null) {
      if(principal.admin)throw new HttpError(403,'scoped_turn_required');
      // Only the state still current counts, and only from the asking turn: a follow-up's reply is not the asking reply,
      // so its own follow-up still answers. A lost note leaves a follow-up that repeats the answer, never one dropped.
      if(principal.turnEvent===row.event_id&&inTurn===row.state&&['done','failed','rejected','ambiguous'].includes(row.state)&&!await followUpTurn(this.control,principal))
        await this.control.query('UPDATE controlled_actions SET observed_in_turn=$2 WHERE id=$1 AND state=$2',[row.id,row.state]);
      return {id:row.id,state:row.state};
    }
    let args:unknown;
    try{args=await this.arguments(row,!principal.admin);}
    catch(error) {
      // What it used may have been withdrawn since, so only its state is shown. Only an action that
      // has not run yet is stopped by that; a finished or running one keeps its own outcome.
      if(principal.admin||!(error instanceof HttpError)||error.code!=='guard_context_changed')throw error;
      return {id:row.id,kind:row.kind,state:row.state,error_code:row.error_code??(['proposed','approved'].includes(row.state)?error.code:null),resolution:closedAs(row).resolution,created_at:row.created_at};
    }
    let result:unknown=null;
    if(row.result_reference) {
      const output=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[row.result_reference.id])).rows[0];
      if(!output||output.content_hash!==row.result_reference.input_hash||digest(output.content)!==output.content_hash)throw new HttpError(409,'action_result_changed');
      result=JSON.parse(output.content.toString());
    }
    const view={id:row.id,event_id:row.event_id,scope:row.scope,profile:row.profile,logical_profile:row.logical_profile,kind:row.kind,arguments:args,fingerprint:row.fingerprint,
      state:row.state,revision:row.revision,job_id:row.job_id,created_at:row.created_at,permission_id:row.permission_id,error_code:row.error_code,...closedAs(row),result};
    // Results are untrusted generated content and need their own guarded context.
    if(principal.admin)return view;
    await this.prepared.allow(principal,args);return await this.prepared.prepare(principal,view,this.detect) as any;
  }
  /** This chat's recent operations, such as Notion calls, for a later turn or job run that no longer holds their IDs.
   * States only, so a quick look needs no content check; one is read whole by its ID, with the same audience. */
  async recent(principal:Reader) {
    const turn=await this.turns.binding(principal);
    if((principal.purpose??'assistant')!=='assistant')return [];
    // The owner and a member of one group share its space, so the reader's own 20 come from a wider window.
    const rows=(await this.control.query(`SELECT id,kind,state,error_code,resolution,created_at,binding,profile FROM controlled_actions
      WHERE space_id=$1 AND logical_profile=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,[principal.space,turn.logical_profile])).rows;
    return rows.filter(row=>this.turns.profile(principal,row.binding)===row.profile).slice(0,20)
      .map(row=>({id:row.id,kind:row.kind,state:row.state,error_code:row.error_code,resolution:closedAs(row).resolution,created_at:row.created_at.toISOString()}));
  }
  /** A stopped job's operations that still wait for the owner end without running (ADR-0204). */
  async stopJob(job:string):Promise<string[]> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const rows=(await db.query("SELECT * FROM controlled_actions WHERE job_id=$1 AND state='proposed' ORDER BY id FOR UPDATE",[job])).rows;
      for(const row of rows) {
        const decision={...await evaluate(db,this.effect(row)),outcome:'deny' as const,origin:'mandatory' as const,rule:'job_stopped'};
        await recordEffect(db,this.effect(row),'blocked',decision,row.source_reference);
        await db.query("UPDATE controlled_actions SET state='rejected',security_decision=$2,error_code='job_stopped',revision=revision+1,updated_at=now() WHERE id=$1",[row.id,decision]);
      }
      await db.query('COMMIT');return rows.map(row=>row.id);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Standing permissions that cover an operation; none for one a relaunched job run asked for (ADR-0207). */
  async grants(row:any,db:Pick<pg.Pool,'query'>=this.control,lock=false) {
    // The same matching as covers(): the exact grant, or a chat rule for this site or command here (ADR-0214).
    return (await db.query(`SELECT id,remaining,expires_at,revision,grain FROM action_permissions WHERE remaining>0 AND revoked_at IS NULL AND expires_at>now()
      AND (grain='exact' AND fingerprint=$1 AND binding=$2 AND (job_id IS NULL OR job_id=$3)
        OR grain='chat' AND $3::text IS NULL AND job_id IS NULL AND match_key=$5 AND kind=$6 AND space_id=$7 AND logical_profile=$8 AND binding->'generation'=$2::jsonb->'generation')
      AND NOT EXISTS (SELECT 1 FROM background_runs r WHERE r.event_id=$4 AND r.attempt>1) ORDER BY expires_at,id${lock?' LIMIT 1 FOR UPDATE':''}`,
      [row.fingerprint,row.binding,row.job_id,row.event_id,row.match_key,row.kind,row.space_id,row.logical_profile])).rows;
  }
  private async command<T>(principal:Reader,body:Record<string,unknown>,request:unknown,change:(db:pg.PoolClient)=>Promise<T>,source?:SourceReference) {
    admin(principal);if(source)await this.access.archive.verify(source);
    const hash=digest(canonical(source?{request,source}:request)),id=body.operation_id===undefined?'action-owner:'+hash:string(body.operation_id,200),db=await this.control.connect();
    try {
      await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,803365))',[id]);
      const prior=(await db.query('SELECT * FROM action_owner_commands WHERE id=$1',[id])).rows[0];
      if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'owner_command_conflict');await db.query('COMMIT');return prior.result as T;}
      const result=await change(db);await db.query('INSERT INTO action_owner_commands(id,request_hash,result,source_reference) VALUES($1,$2,$3,$4)',[id,hash,result,source??null]);
      await db.query('COMMIT');return result;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async decide(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=exact(value,['id','fingerprint','decision','expected_revision','operation_id','allow']),id=identity(body.id);
    if(!['approve','deny'].includes(String(body.decision)))throw new HttpError(400,'invalid_decision');
    // Approve can also allow the same site or exact command in this chat from now on (ADR-0214).
    if(body.allow!==undefined&&(body.decision!=='approve'||!['here','always'].includes(String(body.allow))))throw new HttpError(400,'invalid_decision');
    return this.command(principal,body,{...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(body.fingerprint!==row.fingerprint||body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'action_changed');
      if(!['proposed','approved'].includes(row.state))throw new HttpError(409,'action_already_started_or_closed');
      const minutes=body.allow===undefined?null:ruleMinutes[row.kind]?.[body.allow as 'here'|'always'];
      if(minutes!==null&&(!minutes||!row.match_key||row.job_id))throw new HttpError(400,'rule_not_available');
      if(body.decision==='approve'){await this.fence(db,row.binding);await this.arguments(row);}
      const state=body.decision==='approve'?'approved':'rejected';
      await db.query('UPDATE controlled_actions SET state=$2,permission_id=NULL,decision_reference=$3,revision=revision+1,updated_at=now() WHERE id=$1',[id,state,source??null]);
      await requestWorkflow(db,'tools',id);
      if(!minutes)return {id,state,revision:row.revision+1};
      const rule=digest(canonical(['rule',id,body.allow,body.operation_id??null]));
      await db.query(`INSERT INTO action_permissions(id,action_id,fingerprint,proposal_reference,binding,scope,profile,kind,job_id,expires_at,remaining,grain,match_key,space_id,logical_profile)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,now()+$9*interval '1 minute',$10,'chat',$11,$12,$13)`,
        [rule,id,row.fingerprint,row.proposal_reference,row.binding,row.scope,row.profile,row.kind,minutes,ruleUses,row.match_key,row.space_id,row.logical_profile]);
      // Other operations waiting here for the same site or command run under the rule now.
      const waiting=(await db.query(`SELECT id FROM controlled_actions WHERE state='proposed' AND job_id IS NULL AND match_key=$1 AND kind=$2 AND space_id=$3 AND id<>$4 ORDER BY id`,
        [row.match_key,row.kind,row.space_id,id])).rows;
      for(const other of waiting)await requestWorkflow(db,'tools',other.id);
      return {id,state,revision:row.revision+1,rule};
    },source);
  }
  /** The owner's word on an unclear outcome: it ran, it did not run, or dismiss it. It is not a receipt: the state and
   *  receipt stay as observed, a later receipt still settles the action, and nothing runs again (ADR-0218). */
  async resolve(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=exact(value,['id','fingerprint','outcome','expected_revision','operation_id']),id=identity(body.id);
    if(!ownerResolutions.includes(body.outcome as any))throw new HttpError(400,'invalid_decision');
    return this.command(principal,body,{kind:'resolve',...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(body.fingerprint!==row.fingerprint||body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'action_changed');
      if(row.state!=='ambiguous'||row.resolution)throw new HttpError(409,'action_already_started_or_closed');
      await db.query('UPDATE controlled_actions SET resolution=$2,resolved_at=now(),revision=revision+1,updated_at=now() WHERE id=$1',[id,body.outcome]);
      return {id,state:row.state,resolution:body.outcome,revision:row.revision+1};
    },source);
  }
  async grant(principal:Reader,value:unknown) {
    admin(principal);const body=exact(value,['action_id','fingerprint','uses','minutes','expected_revision','operation_id']),id=identity(body.action_id);
    if(!Number.isSafeInteger(body.uses)||Number(body.uses)<1||Number(body.uses)>1000||!Number.isSafeInteger(body.minutes)||Number(body.minutes)<1||Number(body.minutes)>43200)throw new HttpError(400,'invalid_permission_bounds');
    return this.command(principal,body,{kind:'grant',...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT * FROM controlled_actions WHERE id=$1 FOR SHARE',[id])).rows[0];
      if(!row)throw new HttpError(404,'action_not_found');
      if(body.fingerprint!==row.fingerprint||body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'action_changed');
      await this.fence(db,row.binding);await this.arguments(row);
      const permission=digest(canonical(['permission',id,body.operation_id??null,body.uses,body.minutes,row.fingerprint]));
      await db.query(`INSERT INTO action_permissions(id,action_id,fingerprint,proposal_reference,binding,scope,profile,kind,job_id,expires_at,remaining)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10*interval '1 minute',$11)`,[permission,id,row.fingerprint,row.proposal_reference,row.binding,row.scope,row.profile,row.kind,row.job_id,body.minutes,body.uses]);
      const queued=(await db.query("SELECT id FROM controlled_actions WHERE fingerprint=$1 AND state IN ('proposed','approved') ORDER BY id",[row.fingerprint])).rows;
      for(const candidate of queued)await requestWorkflow(db,'tools',candidate.id);
      return {id:permission,revision:1};
    });
  }
  async revoke(principal:Reader,value:unknown,source?:SourceReference) {
    admin(principal);const body=exact(value,['id','expected_revision','operation_id']),id=identity(body.id);
    return this.command(principal,body,{kind:'revoke',...body,operation_id:undefined},async db=>{
      const row=(await db.query('SELECT revision,revoked_at FROM action_permissions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw new HttpError(404,'permission_not_found');
      if(body.expected_revision!==undefined&&body.expected_revision!==row.revision)throw new HttpError(409,'permission_changed');
      if(!row.revoked_at)await db.query('UPDATE action_permissions SET revoked_at=now(),revision=revision+1 WHERE id=$1',[id]);
      return {id,revoked:true,revision:row.revision+(row.revoked_at?0:1)};
    },source);
  }
  async list(principal:Reader) {
    admin(principal);const rows=(await this.control.query('SELECT id FROM controlled_actions ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    const permissions=(await this.control.query('SELECT * FROM action_permissions ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
    for(const permission of permissions)permission.arguments=await this.arguments(await this.row(permission.action_id),false);
    return {actions:await Promise.all(rows.map(row=>this.inspect(principal,row.id))),permissions};
  }
  async preview(principal:Reader,value:unknown) {
    admin(principal);const body=exact(value,['action_id','policy']),row=await this.row(body.action_id),snapshot=await policySnapshot(this.control);
    const grants=await this.grants(row),effect=this.effect(row),policy=body.policy===undefined?snapshot.policy:validatePolicy(body.policy);
    let stale=false;try{await this.arguments(row);}catch(error){if(error instanceof HttpError&&[403,409].includes(error.status))stale=true;else throw error;}
    return {effect,decision:decide(policy,snapshot.revision,effect,{...(stale?{mandatoryDenial:'guard_context_changed'}:{}),
      ...(row.state==='approved'?{grant:'exact_owner_approval'}:grants[0]?{grant:grants[0].id}:{})}),grants,consumes_permission:false,execution:false,candidate_policy:body.policy!==undefined};
  }
}
