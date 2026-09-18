import {HttpError,string} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation,type WorkflowOperation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority,type WorkflowFamily} from '../workflows/store.js';
import type {StorageServices} from './services.js';
import type {GuardBinding} from './guards.js';

const waiting=(stage='admission',reason='prerequisite',delay=30000)=>observation('waiting',stage,0,Date.now()+delay,reason);
const superseded=new Set(['guard_context_changed','audience_context_changed','memory_context_retired','memory_refresh_required','learned_memory_not_found']);
const pending=new Set(['guard_transition_pending','guard_preparation_pending','guard_source_pending','derivative_selection_pending','learning_context_pending','learning_job_busy','native_review_busy','honcho_sync_busy']);

/** Bound admission before borrowing any pool connection, including nested publication work. */
export function boundStorageOperations(operations:Partial<Record<WorkflowFamily,WorkflowOperation>>,maximum=2) {
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>2)throw Error('invalid_storage_workflow_concurrency');
  let active=0;
  return Object.fromEntries(Object.entries(operations).map(([family,operation])=>[family,async(...args:Parameters<WorkflowOperation>)=>{
    if(active>=maximum)return waiting('admission','receipt_pending',2000);
    active++;try{return await operation(...args);}finally{active--;}
  }])) as Partial<Record<WorkflowFamily,WorkflowOperation>>;
}

export function storageWorkflowOperations(s:StorageServices,call:RuntimeCall):Partial<Record<WorkflowFamily,WorkflowOperation>> {
  const control=s.stores.control;
  const submit=async(family:WorkflowFamily,job:string,generation:number)=>{
    const db=await control.connect();try{await db.query('BEGIN');await requestWorkflow(db,family,job,generation);await db.query('COMMIT');}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  };
  const fenced=async(family:WorkflowFamily,authority:ExecutionAuthority,run:()=>Promise<Observation>)=>{
    const db=await control.connect();let held=false;
    try{held=await enterFamily(db,family,authority.owner,authority.epoch);return held?await run():waiting('admission','owner_paused');}
    finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,family);});}
  };
  /** Persist bounded sweep progress alongside deterministic requests in control. */
  const refresh=async(family:'honcho'|'memory_review',authority:ExecutionAuthority)=>fenced(family,authority,async()=>{
    const binding=await s.guards.state(),db=await control.connect();
    try {
      await db.query('BEGIN');
      const state=(await db.query('SELECT mode,epoch FROM guard_state WHERE singleton FOR SHARE')).rows[0];
      if(Number(state.epoch)!==binding.epoch||state.mode!==binding.mode)throw new HttpError(409,'guard_context_changed');
      if((await db.query("SELECT 1 FROM guard_publications WHERE state='pending' LIMIT 1")).rowCount)throw new HttpError(409,'guard_transition_pending');
      await db.query(`INSERT INTO learning_refresh_sweeps(installation_generation,guard_epoch,family) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[binding.generation,binding.epoch,family]);
      const row=(await db.query('SELECT * FROM learning_refresh_sweeps WHERE installation_generation=$1 AND guard_epoch=$2 AND family=$3 FOR UPDATE',
        [binding.generation,binding.epoch,family])).rows[0];
      if(family==='honcho')await db.query("UPDATE memory_generations SET state='retired' WHERE installation_generation<>$1 OR guard_epoch<>$2",[binding.generation,binding.epoch]);
      let stage=row.stage,after=row.source_after_sequence,learnedAfter=row.learned_after;
      if(stage==='sources') {
        const sources=await s.archive.page(String(after),25);
        for(const source of sources) {
          await requestWorkflow(db,'preparation',source.reference.id,binding.epoch);
          await requestWorkflow(db,family,'source:'+source.reference.id,binding.epoch);
        }
        after=sources.at(-1)?.sequence??after;if(sources.length<25)stage=family==='honcho'?'learned':'done';
      } else if(stage==='learned') {
        const rows=(await s.stores.derived.query(`SELECT e.id FROM learned_entries e JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
          WHERE NOT e.imported AND NOT v.retired AND e.id>$1 ORDER BY e.id LIMIT 25`,[learnedAfter])).rows;
        for(const entry of rows)await requestWorkflow(db,'honcho','projection:'+entry.id,binding.epoch);
        learnedAfter=rows.at(-1)?.id??learnedAfter;if(rows.length<25)stage='done';
      }
      await db.query(`UPDATE learning_refresh_sweeps SET stage=$4,source_after_sequence=$5,learned_after=$6,updated_at=now()
        WHERE installation_generation=$1 AND guard_epoch=$2 AND family=$3`,[binding.generation,binding.epoch,family,stage,after,learnedAfter]);
      await db.query('COMMIT');return stage==='done'?observation('completed','sync'):waiting('sync','prerequisite',100);
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  });
  const sourceReady=async(id:string):Promise<{source:Awaited<ReturnType<typeof s.archive.captured>>;binding:GuardBinding}|Observation>=>{
    const source=await s.archive.captured(id),binding=await s.guards.state();
    if(!await s.access.space(source.reference))return waiting('review','prerequisite');
    if(!await s.access.canLearn(source.reference,binding))return observation('denied','review',0,Date.now(),'consent_required');
    const ready=await s.preparation.status(id);if(ready.state!=='completed')return waiting(ready.stage,'prerequisite',Math.max(1000,ready.next_attempt-Date.now()));
    return {source,binding};
  };
  const operations:Partial<Record<WorkflowFamily,WorkflowOperation>>={
    preparation:async(job,authority)=>{
      const match=/^reprocess:([a-f0-9]{64})$/.exec(job);
      if(match) {
        const result=await s.reprocessing.run(match[1]!,s.detectorVersion,s.detect,authority);
        const row=(await control.query('SELECT state,attempts FROM reprocess_jobs WHERE id=$1',[match[1]])).rows[0];
        return result?observation('completed','transcription',row.attempts):waiting('transcription','receipt_pending',2000);
      }
      if(!/^[a-f0-9]{64}$/.test(job))return observation('failed','admission');
      const before=await s.preparation.status(job);if(before.state==='completed'||before.next_attempt>Date.now()+30000)return before;
      return s.preparation.run(job,async ref=>Buffer.from(string((await call('source.file',{file_id:ref})).bytes_base64,70*1024*1024),'base64'),s.detectorVersion,s.detect,authority);
    },
    memory_review:async(job,authority)=>{
      if(job==='refresh')return refresh('memory_review',authority);
      const match=/^(source|native|interpret):([a-f0-9]{64})$/.exec(job);if(!match)return observation('failed','admission');
      const kind=match[1],id=match[2]!;
      if(kind==='source')return fenced('memory_review',authority,async()=>{
        const ready=await sourceReady(id);if('state' in ready)return ready;
        await s.reviews.queue(ready.source.reference);
        await submit('honcho','source:'+id,ready.binding.epoch);
        await s.guards.assertCurrent(ready.binding);return observation('completed','review');
      });
      if(kind==='interpret') {
        await s.learning.run(id,s.detect,authority);
        return observation('completed','review',Number((await control.query('SELECT attempts FROM interpretation_jobs WHERE id=$1',[id])).rows[0].attempts));
      }
      let row=await s.reviews.inspect(id);
      if(row.paused)return waiting('review','owner_paused');
      if(row.state==='done')return observation('completed','review',row.attempts);
      if(row.next_attempt<=new Date()){await s.reviews.run(id,authority);row=await s.reviews.inspect(id);}
      // Uncertain native effects are observed under the same identity. Inngest
      // schedules reconciliation; no timer or fresh execution identity retries it.
      return observation(row.state==='done'?'completed':row.state==='running'?'running':'waiting',
        row.state==='ambiguous'?'reconcile':'review',row.attempts,Math.max(Date.now()+1000,row.next_attempt.getTime()),row.state==='done'?null:'receipt_pending');
    },
    honcho:async(job,authority)=>{
      const connection=(await control.query('SELECT attached,verified FROM memory_engine_connection WHERE singleton')).rows[0];
      if(!connection.attached||!connection.verified)return waiting('sync','prerequisite',60000);
      if(job==='refresh')return refresh('honcho',authority);
      const match=/^(source|projection|receipt|reconcile|generation|context):([a-f0-9]{64})$/.exec(job);if(!match)return observation('failed','admission');
      const kind=match[1],id=match[2]!;
      if(kind==='source')return fenced('honcho',authority,async()=>{
        const ready=await sourceReady(id);if('state' in ready)return ready;
        const queued=await s.memory.queueSource(ready.source.reference);if(!queued.length)return observation('skipped','sync',0,Date.now(),'consent_required');
        const space=await s.access.space(ready.source.reference),audience=space===s.access.policy().owner_id?'owner':space;
        const selected=queued.find(value=>value.audience===audience);if(!selected)return observation('failed','sync');
        const generation=(await s.memory.current(selected.workspace)).row;
        if(generation.state!=='ready')return waiting('sync','prerequisite',1000);
        await s.learning.request(ready.source.reference,selected.workspace,selected.audience);return observation('completed','sync');
      });
      if(kind==='projection')return fenced('honcho',authority,async()=>{await s.memory.queueProjection(id);return observation('completed','sync');});
      if(kind==='context'||kind==='generation')return fenced('honcho',authority,async()=>{
        if(kind==='generation') {
          const ready=await s.memory.observe(id);if(!ready)return waiting('sync','prerequisite');
          await s.memory.refreshContext(id);return observation('completed','sync');
        }
        const ready=await s.memory.refreshContext(id);return waiting('sync',ready?'refresh_interval':'prerequisite',ready?120000:30000);
      });
      const load=async()=>{const row=(await control.query('SELECT state,attempts,next_attempt FROM memory_ingestion_receipts WHERE id=$1',[id])).rows[0];
        if(!row)throw new HttpError(404,'honcho_receipt_missing');return row;};
      let row=await load();if(row.state==='done')return observation('completed','sync',row.attempts);
      if(row.next_attempt>new Date())return observation('waiting','sync',row.attempts,row.next_attempt.getTime(),'prerequisite');
      try {
        if(kind==='reconcile'||row.state==='uncertain')await fenced('honcho',authority,async()=>{
          const done=await s.memory.reconcileReceipt(id);
          if(!done)await control.query("UPDATE memory_ingestion_receipts SET next_attempt=now()+interval '60 seconds' WHERE id=$1 AND state='uncertain'",[id]);
          return observation(done?'completed':'waiting','reconcile',row.attempts,Date.now()+60000,'receipt_pending');
        });
        else await s.memory.syncReceipt(id,authority);
      }catch(error){row=await load();if(row.state!=='uncertain')throw error;}
      row=await load();return observation(row.state==='done'?'completed':'waiting',row.state==='uncertain'?'reconcile':'sync',row.attempts,
        Math.max(Date.now()+1000,row.next_attempt.getTime()),row.state==='done'?null:'receipt_pending');
    },
  };
  return boundStorageOperations(Object.fromEntries(Object.entries(operations).map(([family,operation])=>[family,async(...args:Parameters<WorkflowOperation>)=>{
    try{return await operation(...args);}catch(error){
      if(error instanceof HttpError) {
        if(superseded.has(error.code))return observation('skipped','admission',0,Date.now(),'superseded');
        if(pending.has(error.code))return waiting('admission',error.code.includes('guard')?'guard_pending':'prerequisite');
        if(error.code==='learning_consent_required')return observation('denied','review',0,Date.now(),'consent_required');
        if(error.code==='workflow_owner_changed')return waiting('admission','owner_paused');
      }
      throw error;
    }
  }])));
}
