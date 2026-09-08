import type pg from 'pg';
import {canonical,digest,ingest} from './archive.js';
import {runInput} from './run-source.js';
import {HttpError,object,string} from './http.js';
import {turnToken} from './access.js';
import {immutableFile} from './storage.js';
import {join} from 'node:path';
import type {Settings} from './config.js';
import {readFile} from 'node:fs/promises';
import {prepareTranscripts} from './assistant.js';
import type {RuntimeCall} from './runtime.js';
import {validateSpace,parentSpace,policyRevision} from './spaces.js';
import {requestAction} from './actions.js';

export const managedRunSchema=`CREATE TABLE IF NOT EXISTS managed_runs (
  event_id text PRIMARY KEY REFERENCES events(id),
  state text NOT NULL CHECK(state IN ('captured','running','done','failed','cancelled','interrupted')),
  actor text, result_id text REFERENCES derived_artifacts(id), error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS job_id text;
ALTER TABLE managed_runs ADD COLUMN IF NOT EXISTS logical_profile text;
CREATE INDEX IF NOT EXISTS managed_runs_job ON managed_runs(logical_profile,job_id,created_at DESC);
CREATE INDEX IF NOT EXISTS managed_runs_lease ON managed_runs(lease_until) WHERE state='running';`;
const identifier=(value:unknown)=>{const id=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HttpError(400,'invalid_run_identity');return id;};
function scopeFor(config:Settings,value:unknown) {
  const scope=string(value,64),owner=scope===config.assistant.owner_id;
  if(!config.assistant.owner_id||(!owner&&!config.assistant.group_ids.includes(scope)))throw new HttpError(403,'run_scope_denied');
  return {scope,owner};
}
export async function captureInput(pool:pg.Pool,config:Settings,input:unknown,channel:'browser'|'scheduler'='browser') {
  const body=object(input),{scope}=scopeFor(config,body.scope);
  const id=identifier(body.id),conversation=identifier(body.conversation),profile=identifier(body.profile);
  const space=validateSpace(body.space??scope),revision=body.revision??0;
  if((parentSpace(space)??space)!==scope||!Number.isSafeInteger(revision)||Number(revision)<0)throw new HttpError(400,'invalid_run_audience');
  const text=string(body.text,100000),files=body.files??[];
  if(!Array.isArray(files)||files.length>10)throw new HttpError(400,'invalid_attachments');
  const attachments=[];
  let total=0;
  for(const item of files) {
    const file=object(item),name=string(file.name,255),kind=string(file.kind,32),encoded=string(file.bytes_base64,36*1024*1024);
    if(!name||/[\x00-\x1f/\\]/.test(name)||!['file','image','voice','audio'].includes(kind)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new HttpError(400,'invalid_attachment');
    const bytes=Buffer.from(encoded,'base64');total+=bytes.length;
    if(!bytes.length||total>25*1024*1024)throw new HttpError(413,'attachment_limit');
    const hash=digest(bytes);await immutableFile(join(config.dataDir,'files'),hash,bytes);
    attachments.push({name,kind,sha256:hash,bytes:bytes.length});
  }
  const submission=body.submission??'composer';
  if(!['composer','resubmission'].includes(String(submission)))throw new HttpError(400,'invalid_submission');
  const display=string(body.display??text,200000);
  const scheduled=channel==='scheduler'?{job_id:identifier(body.job_id),job_revision:string(body.job_revision,64),
    scheduled_for:string(body.scheduled_for,64),fire_reason:string(body.fire_reason,32),definition:object(body.definition)}:{};
  if(channel==='scheduler'&&(!['scheduled','manual','catch_up','missed','overlap'].includes(String(body.fire_reason))||!Number.isFinite(Date.parse(String(body.scheduled_for)))))throw new HttpError(400,'invalid_scheduled_fire');
  const value=runInput({channel,scope,conversation,id,text,payload:{profile,space,revision,attachments,submission,display,...scheduled}});
  const captured=await ingest(pool,value,false);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for(const [index,file] of attachments.entries()) {
      const ref='browser:'+index+':'+file.sha256;
      await client.query(`INSERT INTO artifacts(id,event_id,kind,source_ref,metadata,state,file_hash,byte_size)
        VALUES($1,$2,$3,$4,$5,'ready',$6,$7) ON CONFLICT(id) DO NOTHING`,
        [digest(captured.id+':'+ref),captured.id,file.kind,ref,JSON.stringify({file_name:file.name}),file.sha256,file.bytes]);
    }
    const missed=channel==='scheduler'&&['missed','overlap'].includes(String(body.fire_reason));
    await client.query('INSERT INTO managed_runs(event_id,state,error_code,job_id,logical_profile) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [captured.id,missed?'cancelled':'captured',missed?'scheduled_'+body.fire_reason:null,channel==='scheduler'?body.job_id:null,channel==='scheduler'?identifier(object(body.definition).profile):null]);
    await client.query('COMMIT');
    return {event_id:captured.id,source_key:value.key,duplicate:captured.duplicate,attachments};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function claimRun(pool:pg.Pool,config:Settings,input:unknown,channel:'browser'|'scheduler'='browser') {
  const body=object(input),event=string(body.event_id,64),actor=identifier(body.actor),profile=identifier(body.profile);
  const {scope,owner}=scopeFor(config,body.scope);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query<{state:string;actor:string|null;original_text:Buffer;payload:Buffer;source_key:string;content:Buffer|null;error_code:string|null}>(
      `SELECT r.state,r.actor,e.original_text,e.payload,e.source_key,d.content,r.error_code FROM managed_runs r JOIN events e ON e.id=r.event_id
       LEFT JOIN derived_artifacts d ON d.id=r.result_id
       WHERE r.event_id=$1 AND e.channel=$3 AND e.scope=$2 FOR UPDATE OF r`,[event,scope,channel]);
    const row=rows[0];if(!row)throw new HttpError(404,'captured_run_not_found');
    const payload=object(JSON.parse(row.payload.toString()));
    if(payload.profile!==profile)throw new HttpError(403,'run_profile_mismatch');
    if(row.state!=='captured') {await client.query('COMMIT');return {event_id:event,state:row.state,claimed:false,text:row.content?.toString()??'',error_code:row.error_code};}
    const space=validateSpace(payload.space??scope),revision=await policyRevision(client);
    if(!owner&&(payload.revision!==revision||profile!=='nocheh-'+digest(space+':policy:'+revision).slice(0,24)))throw new HttpError(409,'browser_audience_changed');
    await client.query("UPDATE managed_runs SET state='running',actor=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE event_id=$1",[event,actor]);
    await client.query('COMMIT');
    return {event_id:event,state:'running',claimed:true,text:row.original_text.toString(),payload,source_key:row.source_key,channel,
      archive_credential:turnToken(config.token,owner?null:scope,Date.now()+600000,event,{space,revision}),owner,scope};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function finishRun(pool:pg.Pool,input:unknown) {
  const body=object(input),event=string(body.event_id,64),actor=identifier(body.actor),state=string(body.state,32);
  if(!['done','failed','cancelled','interrupted'].includes(state))throw new HttpError(400,'invalid_run_state');
  const text=string(body.text??'',1000000),session=identifier(body.session),code=body.error_code?identifier(body.error_code):null;
  const content=Buffer.from(text),provenance={runtime:'hermes',version:'7166071fcaadb36df26f6d753dda97da6b5d699e',session_id:session,state};
  const resultId=digest(canonical({event,text,provenance,code})),client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query<{state:string;actor:string;result_id:string;cancel_requested:boolean;channel:string}>('SELECT r.state,r.actor,r.result_id,r.cancel_requested,e.channel FROM managed_runs r JOIN events e ON e.id=r.event_id WHERE event_id=$1 FOR UPDATE OF r',[event]);
    const row=rows[0];if(!row||row.actor!==actor)throw new HttpError(403,'run_actor_mismatch');
    if(row.state!=='running' && !(row.state==='interrupted' && !row.result_id)) {
      if(row.result_id!==resultId)throw new HttpError(409,'run_result_conflict');
      await client.query('COMMIT');return {event_id:event,state:row.state,duplicate:true};
    }
    await client.query(`INSERT INTO derived_artifacts(id,event_id,kind,content,search_text,provenance) VALUES($1,$2,$6,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [resultId,event,content,text.replaceAll('\0',''),JSON.stringify(provenance),row.channel==='scheduler'?'scheduled_result':'browser_result']);
    // A late durable receipt is retained as evidence, but cannot turn an expired
    // lease into a claim that execution was continuously supervised.
    const finalState=row.state==='interrupted'?'interrupted':row.cancel_requested?'cancelled':state;
    await client.query('UPDATE managed_runs SET state=$2,result_id=$3,error_code=$4,lease_until=NULL,updated_at=now() WHERE event_id=$1',[event,finalState,resultId,finalState==='interrupted'?'execution_interrupted':code]);
    await client.query('COMMIT');return {event_id:event,state:finalState,duplicate:false};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function renewRun(pool:pg.Pool,input:unknown) {
  const body=object(input),event=string(body.event_id,64),actor=identifier(body.actor);
  const result=await pool.query("UPDATE managed_runs SET lease_until=now()+interval '60 seconds',updated_at=now() WHERE event_id=$1 AND actor=$2 AND state='running' AND lease_until>now() RETURNING event_id,cancel_requested",[event,actor]);
  if(!result.rowCount)throw new HttpError(409,'run_lease_lost');
  return {event_id:event,state:'running',cancel_requested:result.rows[0].cancel_requested};
}
export async function cancelScheduled(pool:pg.Pool,input:unknown) {
  const event=string(object(input).event_id,64);
  const result=await pool.query(`UPDATE managed_runs r SET cancel_requested=true,state=CASE WHEN state='captured' THEN 'cancelled' ELSE state END,updated_at=now()
    FROM events e WHERE r.event_id=e.id AND e.channel='scheduler' AND r.event_id=$1 AND r.state IN ('captured','running') RETURNING r.state`,[event]);
  return {event_id:event,cancel_requested:!!result.rowCount,state:result.rows[0]?.state??'closed'};
}
export async function recoverScheduled(pool:pg.Pool) {
  await pool.query(`UPDATE managed_runs r SET state='interrupted',error_code='scheduler_restarted',lease_until=NULL,updated_at=now()
    FROM events e WHERE r.event_id=e.id AND e.channel='scheduler' AND r.state IN ('captured','running')`);
  return {recovered:true};
}
export async function scheduleDefinition(pool:pg.Pool,config:Settings,input:unknown) {
  const body=object(input),{scope}=scopeFor(config,body.scope),profile=identifier(body.profile),job=identifier(body.job_id);
  const definition=object(body.definition),version=digest(canonical(definition));
  return ingest(pool,{version:1,key:'schedule-definition:'+digest(canonical({profile,job,version})),channel:'scheduler',origin:'live',kind:'schedule_definition',
    bot_id:'',scope,source_id:job,revision:version,occurred_at:null,text:string(definition.prompt,100000),payload:{profile,job_id:job,definition}});
}
export async function scheduledRuns(pool:pg.Pool,input:unknown) {
  const body=object(input),profile=body.profile?identifier(body.profile):null,job=body.job_id?identifier(body.job_id):null;
  const {rows}=await pool.query(`SELECT r.*,e.scope,e.payload,d.content,d.provenance->>'session_id' AS native_session FROM managed_runs r JOIN events e ON e.id=r.event_id
    LEFT JOIN derived_artifacts d ON d.id=r.result_id WHERE e.channel='scheduler' AND ($1::text IS NULL OR r.logical_profile=$1) AND ($2::text IS NULL OR r.job_id=$2)
    ORDER BY r.created_at DESC LIMIT 100`,[profile,job]);
  return {runs:rows.map(r=>({...r,payload:JSON.parse(r.payload.toString()),text:r.content?.toString()??'',content:undefined}))};
}
export async function scheduledDelivery(pool:pg.Pool,input:unknown) {
  const event=string(object(input).event_id,64);
  const row=(await pool.query(`SELECT r.state,e.scope,e.payload,d.content FROM managed_runs r JOIN events e ON e.id=r.event_id
    LEFT JOIN derived_artifacts d ON d.id=r.result_id WHERE r.event_id=$1 AND e.channel='scheduler'`,[event])).rows[0];
  if(!row||row.state!=='done')return {state:'withheld',reason:'run_not_complete'};
  const payload=JSON.parse(row.payload.toString()),text=row.content?.toString()??'';
  if(payload.definition.deliver!=='telegram'||!text.trim())return {state:'local'};
  if(text.length>3500)return {state:'withheld',reason:'result_exceeds_telegram_limit'};
  if(payload.space!==row.scope)return {state:'withheld',reason:'topic_delivery_unavailable'};
  if(payload.revision&&payload.revision!==await policyRevision(pool))return {state:'withheld',reason:'audience_changed'};
  return requestAction(pool,{scope:row.scope,admin:false,turnEvent:event,space:payload.space,revision:await policyRevision(pool)},
    {destination:row.scope,text});
}
export async function recoverRuns(pool:pg.Pool) {
  await pool.query("UPDATE managed_runs SET state='interrupted',error_code='execution_interrupted',lease_until=NULL,updated_at=now() WHERE state='running' AND (lease_until IS NULL OR lease_until<=now())");
}
export async function prepareRun(pool:pg.Pool,config:Settings,input:unknown,call:RuntimeCall) {
  const body=object(input),event=string(body.event_id,64),actor=identifier(body.actor);
  const client=await pool.connect();
  try {
    const held=await client.query("SELECT event_id FROM managed_runs WHERE event_id=$1 AND actor=$2 AND state='running' AND lease_until>now()",[event,actor]);
    if(!held.rowCount)throw new HttpError(409,'run_lease_lost');
    const transcripts=await prepareTranscripts(client,config.dataDir,event,call);
    if(transcripts===null)throw new HttpError(503,'transcription_unavailable');
    const {rows}=await client.query<{file_hash:string;metadata:{file_name:string};kind:string}>('SELECT file_hash,metadata,kind FROM artifacts WHERE event_id=$1 ORDER BY id',[event]);
    const files=[];let total=0;
    for(const row of rows) {
      if(!/^[a-f0-9]{64}$/.test(row.file_hash))throw new HttpError(503,'file_hash_invalid');
      const data=await readFile(join(config.dataDir,'files',row.file_hash));
      if(digest(data)!==row.file_hash)throw new HttpError(503,'file_hash_mismatch');
      let text:string|null=null;
      if(row.kind==='file' && data.length<=200000 && total+data.length<=1000000 && !data.includes(0)) {
        try {text=new TextDecoder('utf-8',{fatal:true}).decode(data);total+=data.length;} catch { /* retained binary */ }
      }
      files.push({sha256:row.file_hash,name:row.metadata.file_name,kind:row.kind,text});
    }
    return {transcripts,files};
  }finally{client.release();}
}
