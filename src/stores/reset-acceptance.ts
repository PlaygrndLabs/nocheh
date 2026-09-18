import {canonical,digest} from '../archive.js';
import type {StorePools} from './connections.js';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const checks=['owner_dm','dedicated_group','reply','human_reaction','subscription_transcription','learned_recall',
  'owner_correction','isolation','intentional_silence','exact_approval','restart_recovery','honcho'] as const;
const exact=(value:unknown,keys:string[],code='reset_fresh_acceptance_invalid')=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))throw Error(code);
  return value as Record<string,any>;
};
const hash=(value:unknown)=>{if(typeof value!=='string'||!HASH.test(value))throw Error('reset_fresh_acceptance_invalid');return value;};
const truth=(value:unknown)=>{if(value!==true)throw Error('reset_fresh_acceptance_incomplete');return true;};
const date=(value:unknown)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('reset_fresh_acceptance_invalid');
  return new Date(value);
};

function request(value:unknown) {
  const input=exact(value,['format','reset_id','generation','mode','boundary_confirmed_at','dedicated_group_sha256',
    'human_participant_sha256','checks']);
  if(input.format!=='nocheh-fresh-acceptance-v1'||input.mode!=='live'||typeof input.reset_id!=='string'||!UUID.test(input.reset_id)||
    typeof input.generation!=='string'||!UUID.test(input.generation))throw Error('reset_fresh_acceptance_invalid');
  const evidence=exact(input.checks,[...checks]);hash(input.dedicated_group_sha256);hash(input.human_participant_sha256);
  const owner=exact(evidence.owner_dm,['event_id','owner_inspected']);hash(owner.event_id);truth(owner.owner_inspected);
  const group=exact(evidence.dedicated_group,['event_id']);hash(group.event_id);
  const reply=exact(evidence.reply,['event_id','target_event_id']);hash(reply.event_id);hash(reply.target_event_id);
  const reaction=exact(evidence.human_reaction,['event_id','target_event_id','actor_observed']);
  hash(reaction.event_id);hash(reaction.target_event_id);truth(reaction.actor_observed);
  const transcript=exact(evidence.subscription_transcription,['event_id','artifact_id','derived_id']);
  hash(transcript.event_id);hash(transcript.artifact_id);hash(transcript.derived_id);
  const recall=exact(evidence.learned_recall,['entry_id','version_operation_id','memory_receipt_id','dispatch_event_id','owner_inspected']);
  hash(recall.entry_id);hash(recall.version_operation_id);hash(recall.memory_receipt_id);hash(recall.dispatch_event_id);truth(recall.owner_inspected);
  const correction=exact(evidence.owner_correction,['entry_id','operation_id','revision']);
  hash(correction.entry_id);hash(correction.operation_id);
  if(!Number.isSafeInteger(correction.revision)||correction.revision<1)throw Error('reset_fresh_acceptance_invalid');
  const isolation=exact(evidence.isolation,['event_id','dispatch_event_id','owner_inspected','private_source_absent']);
  hash(isolation.event_id);hash(isolation.dispatch_event_id);truth(isolation.owner_inspected);truth(isolation.private_source_absent);
  const silence=exact(evidence.intentional_silence,['event_id']);hash(silence.event_id);
  const approval=exact(evidence.exact_approval,['action_id','decision_operation_id','owner_inspected']);
  hash(approval.action_id);hash(approval.decision_operation_id);truth(approval.owner_inspected);
  const restart=exact(evidence.restart_recovery,['event_id','dispatch_event_id','single_delivery','owner_inspected']);
  hash(restart.event_id);hash(restart.dispatch_event_id);truth(restart.single_delivery);truth(restart.owner_inspected);
  const honcho=exact(evidence.honcho,['generation_id','ingestion_receipt_id','owner_inspected']);
  hash(honcho.generation_id);hash(honcho.ingestion_receipt_id);truth(honcho.owner_inspected);
  return Object.assign(input,{boundary:date(input.boundary_confirmed_at),checks:evidence}) as
    Record<string,any>&{boundary:Date;checks:Record<string,any>};
}

const same=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
const after=(value:unknown,boundary:Date)=>{
  const observed=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(observed.getTime())||observed<boundary)throw Error('reset_fresh_acceptance_historical');
};

/** Validate fresh live acceptance against the current post-reset stores.
 *
 * Human-observed assertions remain explicit in the request; every referenced
 * source, derivative, action, learning and memory receipt is independently
 * anchored to current database rows created after the confirmed reset boundary.
 */
export async function verifyFreshAcceptance(stores:StorePools,value:unknown) {
  const input=request(value),boundary=input.boundary,e=input.checks;
  const installed=(await stores.control.query('SELECT generation::text AS generation FROM installation WHERE singleton')).rows;
  if(!same(installed,[{generation:input.generation}]))throw Error('reset_fresh_acceptance_generation_changed');
  const policy=(await stores.control.query(`SELECT v.document FROM runtime_configuration c
    JOIN runtime_configuration_versions v USING(name,revision) WHERE c.name='assistant'`)).rows[0]?.document;
  if(!policy?.enabled||typeof policy.owner_id!=='string'||!Array.isArray(policy.group_ids))throw Error('reset_fresh_acceptance_configuration_changed');
  const group=policy.group_ids.find((id:unknown)=>typeof id==='string'&&digest(id)===input.dedicated_group_sha256);
  if(!group)throw Error('reset_fresh_acceptance_group_not_allowlisted');
  if(digest(policy.owner_id)===input.human_participant_sha256)throw Error('reset_fresh_acceptance_human_required');

  const event=async(id:string,audience?:string)=>{
    const rows=(await stores.archive.query(`SELECT e.origin,e.channel,e.received_at,o.operation,o.metadata
      FROM events e JOIN source_observations o ON o.event_id=e.id WHERE e.id=$1`,[id])).rows;
    if(rows.length!==1||rows[0].origin!=='live'||rows[0].channel!=='telegram')throw Error('reset_fresh_acceptance_source_missing');
    after(rows[0].received_at,boundary);
    if(audience!==undefined&&rows[0].metadata?.audience?.chat_id!==audience)throw Error('reset_fresh_acceptance_audience_mismatch');
    return rows[0];
  };
  const dispatch=async(id:string,state='done')=>{
    const rows=(await stores.control.query('SELECT state,attempts,result_reference,error_code,created_at,updated_at FROM dispatches WHERE event_id=$1',[id])).rows;
    if(rows.length!==1||rows[0].state!==state)throw Error('reset_fresh_acceptance_dispatch_missing');
    after(rows[0].created_at,boundary);after(rows[0].updated_at,boundary);return rows[0];
  };
  const relation=async(id:string,target:string,kind:string)=>{
    const rows=(await stores.archive.query(`SELECT 1 FROM source_relations x
      JOIN source_observations target_o ON target_o.event_id=$2
      JOIN source_revisions target_r ON target_r.id=target_o.revision_id
      WHERE x.event_id=$1 AND x.kind=$3 AND x.target_id=target_r.object_id`,[id,target,kind])).rows;
    if(rows.length!==1)throw Error('reset_fresh_acceptance_relationship_missing');
  };

  await event(e.owner_dm.event_id,policy.owner_id);await dispatch(e.owner_dm.event_id);
  await event(e.dedicated_group.event_id,group);
  await event(e.reply.event_id,group);await event(e.reply.target_event_id,group);await relation(e.reply.event_id,e.reply.target_event_id,'reply_to');
  const reaction=await event(e.human_reaction.event_id,group);await event(e.human_reaction.target_event_id,group);
  if(!['reaction_change','reaction_counts'].includes(reaction.operation)||!reaction.metadata?.reaction)throw Error('reset_fresh_acceptance_reaction_missing');
  await relation(e.human_reaction.event_id,e.human_reaction.target_event_id,'reaction_to');
  const actors=(await stores.archive.query(`SELECT o.external_id FROM source_relations r JOIN source_objects o ON o.id=r.target_id
    WHERE r.event_id=$1 AND r.kind='authored_by' AND o.kind='actor'`,[e.human_reaction.event_id])).rows;
  if(actors.length!==1||digest(actors[0].external_id)!==input.human_participant_sha256)throw Error('reset_fresh_acceptance_human_required');

  await event(e.subscription_transcription.event_id,policy.owner_id);
  const transcript=(await stores.archive.query('SELECT file_hash,byte_size FROM artifacts WHERE id=$1 AND event_id=$2',
    [e.subscription_transcription.artifact_id,e.subscription_transcription.event_id])).rows;
  const derived=(await stores.derived.query(`SELECT d.kind,d.producer,d.created_at FROM derived_artifacts d
    JOIN derivative_selections s ON s.event_id=d.event_id AND s.artifact_id=d.artifact_id AND s.kind=d.kind
    JOIN derivative_selection_revisions v ON v.selection_id=s.id AND v.revision=s.active_revision AND v.derived_id=d.id
    WHERE d.id=$1 AND d.event_id=$2 AND d.artifact_id=$3`,[e.subscription_transcription.derived_id,
      e.subscription_transcription.event_id,e.subscription_transcription.artifact_id])).rows;
  if(transcript.length!==1||!transcript[0].file_hash||Number(transcript[0].byte_size)<1||derived.length!==1||
    derived[0].kind!=='transcript'||derived[0].producer!=='nocheh-subscription')throw Error('reset_fresh_acceptance_transcription_missing');
  after(derived[0].created_at,boundary);

  await event(e.learned_recall.dispatch_event_id);await dispatch(e.learned_recall.dispatch_event_id);
  const learned=(await stores.derived.query(`SELECT v.operation_id,v.author,v.retired,v.created_at
    FROM learned_entries x JOIN learned_versions v ON v.entry_id=x.id AND v.revision=x.active_revision
    WHERE x.id=$1 AND v.operation_id=$2`,[e.learned_recall.entry_id,e.learned_recall.version_operation_id])).rows;
  if(learned.length!==1||learned[0].retired)throw Error('reset_fresh_acceptance_learning_missing');after(learned[0].created_at,boundary);
  const learnedReceipt=(await stores.control.query(`SELECT state,projection_reference,created_at FROM memory_ingestion_receipts
    WHERE id=$1`,[e.learned_recall.memory_receipt_id])).rows;
  if(learnedReceipt.length!==1||learnedReceipt[0].state!=='done'||learnedReceipt[0].projection_reference?.id!==e.learned_recall.entry_id)
    throw Error('reset_fresh_acceptance_learning_missing');
  after(learnedReceipt[0].created_at,boundary);
  const corrected=(await stores.derived.query(`SELECT v.revision,v.author,v.retired,v.created_at FROM learned_entries x
    JOIN learned_versions v ON v.entry_id=x.id AND v.revision=x.active_revision
    WHERE x.id=$1 AND v.operation_id=$2`,[e.owner_correction.entry_id,e.owner_correction.operation_id])).rows;
  if(corrected.length!==1||corrected[0].revision!==e.owner_correction.revision||corrected[0].author!=='owner'||corrected[0].retired)
    throw Error('reset_fresh_acceptance_correction_missing');
  after(corrected[0].created_at,boundary);

  await event(e.isolation.event_id,group);
  if(e.isolation.event_id!==e.isolation.dispatch_event_id)throw Error('reset_fresh_acceptance_invalid');
  await dispatch(e.isolation.dispatch_event_id);
  await event(e.intentional_silence.event_id,group);
  const silent=await dispatch(e.intentional_silence.event_id,'suppressed');
  if(silent.error_code!=='intentional_silence'||silent.result_reference!==null)throw Error('reset_fresh_acceptance_silence_missing');

  const approval=(await stores.control.query(`SELECT r.state,r.result_reference,r.security_decision,r.created_at,d.decision,d.created_at AS decided_at
    FROM telegram_action_requests r JOIN telegram_action_decisions d ON d.action_id=r.id
    WHERE r.id=$1 AND d.operation_id=$2`,[e.exact_approval.action_id,e.exact_approval.decision_operation_id])).rows;
  if(approval.length!==1||approval[0].state!=='done'||approval[0].decision!=='approve'||!approval[0].result_reference||!approval[0].security_decision)
    throw Error('reset_fresh_acceptance_approval_missing');
  after(approval[0].created_at,boundary);after(approval[0].decided_at,boundary);
  await event(e.restart_recovery.event_id);
  if(e.restart_recovery.event_id!==e.restart_recovery.dispatch_event_id)throw Error('reset_fresh_acceptance_invalid');
  const recovered=await dispatch(e.restart_recovery.dispatch_event_id);
  if(recovered.attempts!==1)throw Error('reset_fresh_acceptance_restart_missing');

  const memory=(await stores.control.query('SELECT attached,verified,acceptance FROM memory_engine_connection WHERE singleton')).rows;
  const accepted=memory[0]?.acceptance,required=['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'];
  if(memory.length!==1||!memory[0].attached||!memory[0].verified||accepted?.format!=='nocheh-honcho-live-v1'||
    required.some(name=>accepted?.checks?.[name]!=='passed'))throw Error('reset_fresh_acceptance_honcho_missing');
  after(accepted.recorded_at,boundary);
  const generation=(await stores.control.query(`SELECT g.state,g.installation_generation::text AS installation_generation,g.last_ready_at,
    s.refreshed_at FROM memory_generations g JOIN memory_context_snapshots s ON s.generation=g.id WHERE g.id=$1`,[e.honcho.generation_id])).rows;
  if(generation.length!==1||generation[0].state!=='ready'||generation[0].installation_generation!==input.generation||!generation[0].last_ready_at)
    throw Error('reset_fresh_acceptance_honcho_missing');
  after(generation[0].last_ready_at,boundary);after(generation[0].refreshed_at,boundary);
  const ingestion=(await stores.control.query(`SELECT state,attempts,created_at FROM memory_ingestion_receipts
    WHERE id=$1 AND generation=$2`,[e.honcho.ingestion_receipt_id,e.honcho.generation_id])).rows;
  if(ingestion.length!==1||ingestion[0].state!=='done'||ingestion[0].attempts<1)throw Error('reset_fresh_acceptance_honcho_missing');
  after(ingestion[0].created_at,boundary);

  const sourceEvents=new Set([e.owner_dm.event_id,e.dedicated_group.event_id,e.reply.event_id,e.reply.target_event_id,
    e.human_reaction.event_id,e.human_reaction.target_event_id,e.subscription_transcription.event_id,e.learned_recall.dispatch_event_id,
    e.isolation.event_id,e.intentional_silence.event_id,e.restart_recovery.event_id]);
  return {reset_id:input.reset_id,generation:input.generation,mode:'live',boundary_confirmed_at:input.boundary_confirmed_at,
    checks:Object.fromEntries(checks.map(name=>[name,'passed'])),source_events:sourceEvents.size,live_only:true,historical_evidence:false,
    fixtures_accepted:false,dedicated_group_sha256:input.dedicated_group_sha256,
    human_participant_sha256:input.human_participant_sha256};
}
