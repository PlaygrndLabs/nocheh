/** Browser transport keeps content in the archive and protected native journal. */
import type pg from 'pg';
import type {Settings} from '../config.js';
import type {RuntimeCall} from '../runtime.js';
import {HttpError,object,string} from '../http.js';
import {preparationStatus} from './preparation-status.js';
import {guardState} from '../guarded.js';
import {policyRevision} from '../spaces.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority,type WorkflowState} from './store.js';
import {observation,type WorkflowOperation} from './pipeline.js';

async function scopedRun(client:pg.Pool|pg.PoolClient,config:Settings,input:unknown,lock=false) {
  const b=object(input),scope=string(b.scope,64),profile=string(b.profile,128);
  if(scope!==config.assistant.owner_id&&!config.assistant.group_ids.includes(scope))throw new HttpError(403,'run_scope_denied');
  const row=(await client.query(`SELECT r.*,e.scope,e.payload,d.content FROM managed_runs r JOIN events e ON e.id=r.event_id
    LEFT JOIN derived_artifacts d ON d.id=r.result_id WHERE e.channel='browser' AND r.event_id=$1 AND e.scope=$2 ${lock?'FOR UPDATE OF r':''}`,[string(b.event_id,64),scope])).rows[0];
  if(!row)throw new HttpError(404,'captured_run_not_found');
  row.payload=JSON.parse(row.payload.toString());
  if(row.payload.profile!==profile||b.conversation!==undefined&&b.conversation!==row.payload.conversation_id)throw new HttpError(403,'run_profile_mismatch');
  if(scope!==config.assistant.owner_id&&row.payload.revision!==await policyRevision(client))throw new HttpError(409,'browser_audience_changed');
  return row;
}

export async function admitBrowser(pool:pg.Pool,config:Settings,input:unknown) {
  const client=await pool.connect();let held=false;
  try {
    const owner=(await client.query("SELECT * FROM workflow_owners WHERE family='browser'")).rows[0];
    held=await enterFamily(client,'browser',owner.owner,owner.epoch);if(!held)throw new HttpError(409,'workflow_owner_changed');
    await client.query('BEGIN');
    // Concurrent submissions in one native session cannot both be admitted.
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('browser-admission'))");
    const row=await scopedRun(client,config,input,true);
    if(row.state==='captured'&&!row.admitted){
      const busy=await client.query(`SELECT 1 FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE e.channel='browser'
        AND r.event_id<>$1 AND r.admitted AND r.state IN ('captured','running') AND e.scope=$2
        AND convert_from(e.payload,'UTF8')::jsonb->>'conversation_id'=$3`,[row.event_id,row.scope,row.payload.conversation_id]);
      if(busy.rowCount)throw new HttpError(409,'session_busy');
      await client.query('UPDATE managed_runs SET admitted=true,updated_at=now() WHERE event_id=$1',[row.event_id]);
      await client.query("SELECT nocheh_workflow_request('browser',$1)",[row.event_id]);
    }
    await client.query('COMMIT');return {owned:owner.owner==='inngest',state:row.state,event_id:row.event_id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await releaseOperation(client,async()=>{if(held)await leaveFamily(client,'browser');});}
}

export async function browserObservation(pool:pg.Pool,config:Settings,input:unknown) {
  const row=await scopedRun(pool,config,input),guard=await guardState(pool);
  const visible=row.guard_epoch===null||Number(row.guard_epoch)===guard.epoch;
  return {event_id:row.event_id,state:row.state,admitted:row.admitted,visible,
    text:visible?row.content?.toString()??'':'',conversation:row.payload.conversation_id,owner_epoch:row.owner_epoch};
}
export async function activeBrowser(pool:pg.Pool,config:Settings,input:unknown) {
  const b=object(input),rows=await pool.query(`SELECT r.event_id FROM managed_runs r JOIN events e ON e.id=r.event_id
    WHERE e.channel='browser' AND e.scope=$1 AND convert_from(e.payload,'UTF8')::jsonb->>'conversation_id'=$2
    AND (r.owner_epoch IS NOT NULL OR EXISTS(SELECT 1 FROM workflow_owners WHERE family='browser' AND owner='inngest'))
    AND r.admitted AND r.state IN ('captured','running') ORDER BY r.created_at DESC LIMIT 1`,[b.scope,b.conversation]);
  if(!rows.rowCount)return {active:false,event_id:null};
  return {active:true,...await browserObservation(pool,config,{...b,event_id:rows.rows[0].event_id})};
}
export async function cancelBrowser(pool:pg.Pool,config:Settings,input:unknown) {
  const client=await pool.connect();try {
    await client.query('BEGIN');const row=await scopedRun(client,config,input,true);
    await client.query(`UPDATE managed_runs SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,updated_at=now()
      WHERE event_id=$1 AND state IN ('captured','running')`,[row.event_id]);
    await client.query('COMMIT');return {cancel_requested:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function browserWorkflowContext(pool:pg.Pool,config:Settings,input:unknown) {
  const b=object(input),row=(await pool.query(`SELECT r.admitted,r.owner_epoch,e.scope,e.payload,o.epoch,o.owner,o.admission
    FROM managed_runs r JOIN events e ON e.id=r.event_id CROSS JOIN workflow_owners o
    WHERE r.event_id=$1 AND e.channel='browser' AND o.family='browser'`,[b.event_id])).rows[0];
  if(!row||!row.admitted||row.owner!=='inngest'||row.epoch!==b.owner_epoch||!row.admission)throw new HttpError(409,'workflow_owner_changed');
  const payload=JSON.parse(row.payload.toString());
  await scopedRun(pool,config,{event_id:b.event_id,scope:row.scope,profile:payload.profile});
  return {event_id:b.event_id,scope:row.scope,profile:payload.profile,conversation:payload.conversation_id,actor:'run_'+b.event_id,owner_epoch:row.epoch};
}
export async function browserAuthority(pool:pg.Pool,config:Settings,input:unknown):Promise<ExecutionAuthority> {
  const b=object(input);await browserWorkflowContext(pool,config,b);
  if(b.actor!=='run_'+b.event_id)throw new HttpError(409,'run_actor_mismatch');
  return {owner:'inngest',epoch:Number(b.owner_epoch)};
}

export function browserOperation(pool:pg.Pool,config:Settings,call:RuntimeCall):WorkflowOperation {
  return managedRunOperation(pool,config,call,'browser');
}
export function managedRunOperation(pool:pg.Pool,config:Settings,call:RuntimeCall,channel:'browser'|'scheduler'):WorkflowOperation {
  const family=channel==='browser'?'browser':'schedules';
  return async(event,authority)=>{
    const load=async()=> (await pool.query('SELECT * FROM managed_runs WHERE event_id=$1',[event])).rows[0];
    let row=await load();if(!row?.admitted)return observation('skipped','admission');
    if(row.state==='captured'&&!row.cancel_requested) {
      const prepared=await preparationStatus(pool,event);
      if(prepared.state!=='completed')return observation('waiting',prepared.stage,0,prepared.next_attempt,'prerequisite');
    }
    if(['captured','running'].includes(row.state)) {
      const body={channel,event_id:event,attempt:1,owner_epoch:authority.epoch,asynchronous:true};
      let runtime:Record<string,unknown>;
      try {
        if(row.cancel_requested)await call('run.cancel',body);
        runtime=await call('run.resume',body);
        if(runtime.state==='not_found') {
          if(row.state==='captured'&&!row.cancel_requested)runtime=await call('run.start',body);
          else if(row.state==='running')await pool.query("UPDATE managed_runs SET state='interrupted',error_code='runtime_receipt_missing',lease_until=NULL WHERE event_id=$1 AND state='running'",[event]);
        }
        if(['ambiguous','failed','cancelled'].includes(String(runtime.state)))await pool.query(`UPDATE managed_runs SET state=$2,error_code=$3,lease_until=NULL WHERE event_id=$1 AND state IN ('captured','running')`,
          [event,runtime.state==='ambiguous'?'interrupted':runtime.state,'runtime_execution_interrupted']);
      }catch{
        row=await load();
        return observation(row.state==='running'?'running':'waiting','assistant',row.actor?1:0,Date.now()+30000,row.state==='running'?'receipt_pending':'runtime_unavailable');
      }
      row=await load();
    }
    const state:WorkflowState=row.state==='done'?'completed':row.state==='interrupted'?'ambiguous':row.state==='captured'?'waiting':row.state==='cancelled'&&/^scheduled_(missed|overlap)$/.test(row.error_code??'')?'skipped':row.state;
    if(row.actor)await pool.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state,receipt_id)
      SELECT id,$4,1,$2,$3 FROM workflow_registry WHERE family=$4 AND job_id=$1
      ON CONFLICT(workflow_id,step,attempt) DO UPDATE SET state=excluded.state,receipt_id=excluded.receipt_id,updated_at=now() WHERE workflow_receipts.state='started'`,
      [channel==='browser'?event:'run:'+event,row.state==='running'?'started':row.state==='interrupted'?'ambiguous':row.state==='done'?'done':'failed',row.result_id,family]);
    return observation(state,row.state==='captured'?'admission':'assistant',row.actor?1:0,Date.now()+1000,state==='running'?'receipt_pending':state==='waiting'?'prerequisite':null);
  };
}
