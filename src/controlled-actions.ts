import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {canonical,digest,ingest} from './archive.js';
import {HttpError,object,string} from './http.js';
import {guardState} from './guarded.js';
import {admin,assertAudience,type Reader} from './access.js';
import {evaluate,recordEffect,type EffectState} from './security/store.js';
import type {Effect,Decision} from './security/contract.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from './workflows/store.js';

export const controlledSchema=`
CREATE TABLE IF NOT EXISTS controlled_actions (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), scope text NOT NULL,
 profile text NOT NULL, kind text NOT NULL, arguments bytea NOT NULL, fingerprint text NOT NULL,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','running','done','failed','ambiguous')),
 decision_event_id text REFERENCES events(id), permission_id text, actor text, lease_until timestamptz,
 result bytea, result_id text REFERENCES derived_artifacts(id), error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS guard_epoch bigint;
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS job_id text;
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS security_decision jsonb;
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS execution_owner text;
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS owner_epoch integer;
CREATE TABLE IF NOT EXISTS action_permissions (
 id text PRIMARY KEY, fingerprint text NOT NULL, scope text NOT NULL, profile text NOT NULL,
 kind text NOT NULL, arguments bytea NOT NULL, expires_at timestamptz NOT NULL,
 remaining integer NOT NULL CHECK(remaining>=0), revoked_at timestamptz,
 event_id text NOT NULL REFERENCES events(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS controlled_action_queue ON controlled_actions(state,created_at);
ALTER TABLE action_permissions ADD COLUMN IF NOT EXISTS job_id text;
`;
const owner:Reader={scope:null,admin:true};
const idValue=(value:unknown)=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_action_id');return id;};
export function actionArguments(kind:unknown,value:unknown) {
  const args=object(value), keys=Object.keys(args);
  if(kind==='shell') {
    const command=string(args.command,16000);
    if(keys.some(k=>k!=='command')||!command.trim()||command.includes('\0'))throw new HttpError(400,'invalid_shell_action');
    return {command};
  }
  if(kind==='browser'||kind==='mcp') {
    const address=string(args.url,4096);let url:URL;
    try {url=new URL(address);}catch{throw new HttpError(400,'invalid_action_url');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||url.hostname==='localhost')throw new HttpError(400,'public_https_required');
    if(kind==='browser') {
      if(keys.some(k=>k!=='url'))throw new HttpError(400,'invalid_browser_action');
      return {url:address};
    }
    if(args.operation==='list') {
      if(keys.some(k=>!['url','operation'].includes(k)))throw new HttpError(400,'invalid_mcp_action');
      return {url:address,operation:'list'};
    }
    const tool=string(args.tool,128),input=object(args.input);
    if(keys.some(k=>!['url','tool','input','operation'].includes(k))||(args.operation!==undefined&&args.operation!=='call')||!/^[\w.:-]{1,128}$/.test(tool)||canonical(input).length>32000)throw new HttpError(400,'invalid_mcp_action');
    return {url:address,tool,input};
  }
  throw new HttpError(400,'unsupported_controlled_tool');
}
type Row={guard_epoch:string|null;job_id:string|null;security_decision:Decision|null;id:string;event_id:string;scope:string;profile:string;kind:string;arguments:Buffer;fingerprint:string;state:string;
 decision_event_id:string|null;permission_id:string|null;actor:string|null;result:Buffer|null;result_id:string|null;error_code:string|null};
function view(row:Row) {return {...row,arguments:JSON.parse(row.arguments.toString()),result:row.result?JSON.parse(row.result.toString()):null};}
function effect(row:Pick<Row,'id'|'kind'|'scope'|'profile'|'fingerprint'|'job_id'>):Effect {
  return {id:row.id,kind:row.kind as Effect['kind'],scope:row.scope,profile:row.profile,fingerprint:row.fingerprint,...(row.job_id?{job:row.job_id}:{})};
}

export async function proposeControlled(pool:pg.Pool,principal:Reader,value:unknown) {
  await assertAudience(pool,principal);
  if(!principal.turnEvent)throw new HttpError(403,'assistant_turn_required');
  if(principal.purpose&&principal.purpose!=='assistant')throw new HttpError(403,'external_effect_scope_denied');
  const input=object(value),args=actionArguments(input.kind,input.arguments);
  const event=(await pool.query<{scope:string;payload:Buffer;channel:string;origin:string}>('SELECT scope,payload,channel,origin FROM events WHERE id=$1',[principal.turnEvent])).rows[0];
  if(!event||(principal.scope!==null&&principal.scope!==event.scope))throw new HttpError(403,'action_scope_denied');
  if(event.origin!=='live')throw new HttpError(403,'external_effect_requires_live_turn');
  // Profiles are read from the trusted captured envelope, never from tool arguments.
  const payload=JSON.parse(event.payload.toString());
  const profile=event.channel==='browser'||event.channel==='scheduler'?payload.profile:
    'nocheh-'+digest(principal.scope!==null&&principal.space&&principal.revision?principal.space+':policy:'+principal.revision:event.scope).slice(0,24);
  if(typeof profile!=='string'||!/^[\w-]{1,128}$/.test(profile))throw new HttpError(403,'action_profile_unbound');
  const fingerprint=digest(canonical({scope:event.scope,profile,kind:input.kind,arguments:args}));
  const id=digest(canonical({event_id:principal.turnEvent,fingerprint}));
  await ingest(pool,{version:1,key:'controlled-action:'+id,origin:'generated',kind:'controlled_action_request',bot_id:'nocheh',scope:event.scope,
    source_id:id,revision:'0',occurred_at:null,text:canonical(args),payload:{source_event_id:principal.turnEvent,kind:input.kind,profile,fingerprint}});
  await pool.query(`INSERT INTO controlled_actions(id,event_id,scope,profile,kind,arguments,fingerprint,guard_epoch,job_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[id,principal.turnEvent,event.scope,profile,input.kind,Buffer.from(canonical(args)),fingerprint,(await guardState(pool)).epoch,event.channel==='scheduler'?payload.job_id??null:null]);
  const current=await controlledAction(pool,principal,id),proposal=effect(current);
  const grant=(await pool.query<{id:string}>(`SELECT id FROM action_permissions WHERE fingerprint=$1 AND (job_id IS NULL OR job_id=$2) AND remaining>0 AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at LIMIT 1`,[fingerprint,current.job_id])).rows[0];
  const decision=await evaluate(pool,proposal,current.state==='approved'?'exact_owner_approval':grant?.id);
  await recordEffect(pool,proposal,'proposed',decision,principal.turnEvent);
  await recordEffect(pool,proposal,decision.outcome==='deny'?'blocked':decision.outcome==='allow'?'allowed':'awaiting_approval',decision,principal.turnEvent,grant?.id);
  return {id,state:(await controlledAction(pool,principal,id)).state,message:'Review the exact operation in Nocheh Activity or /action '+id+'. Execution waits for owner approval or a matching bounded permission.'};
}
export async function controlledAction(pool:pg.Pool,principal:Reader,id:unknown) {
  await assertAudience(pool,principal);
  const row=(await pool.query<Row>('SELECT * FROM controlled_actions WHERE id=$1',[idValue(id)])).rows[0];
  if(!row)throw new HttpError(404,'action_not_found');
  if(!principal.admin&&(await guardState(pool)).mode==='on'&&Number(row.guard_epoch)!==(await guardState(pool)).epoch)throw new HttpError(409,'guard_context_changed');
  if(!principal.admin&&(!principal.turnEvent||(principal.scope!==null&&principal.scope!==row.scope)))throw new HttpError(403,'action_scope_denied');
  if(principal.scope!==null&&principal.space&&principal.revision&&row.profile!=='nocheh-'+digest(principal.space+':policy:'+principal.revision).slice(0,24))throw new HttpError(403,'action_audience_denied');
  return view(row);
}
export async function controlledList(pool:pg.Pool,principal:Reader) {
  admin(principal);
  const actions=(await pool.query<Row>('SELECT * FROM controlled_actions ORDER BY created_at DESC LIMIT 100')).rows.map(view);
  const permissions=(await pool.query('SELECT * FROM action_permissions ORDER BY created_at DESC LIMIT 100')).rows.map(row=>({...row,arguments:JSON.parse(row.arguments.toString())}));
  return {actions,permissions};
}
async function decisionEvidence(pool:pg.Pool,row:{scope:string;id:string},action:string,payload:unknown,source?:string) {
  if(source)return source;
  return (await ingest(pool,{version:1,key:'owner-action:'+randomUUID(),origin:'live',channel:'browser',kind:'owner_action_decision',bot_id:'nocheh',scope:row.scope,
    source_id:row.id,revision:'0',occurred_at:null,text:null,payload:{action_id:row.id,action,decision:payload}})).id;
}
export async function decideControlled(pool:pg.Pool,principal:Reader,value:unknown,source?:string) {
  admin(principal);const input=object(value),id=idValue(input.id);
  const row=await controlledAction(pool,owner,id);
  // The decision binds the full fingerprint shown by the reviewing client.
  if(input.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
  if(!['approve','deny'].includes(String(input.decision)))throw new HttpError(400,'invalid_decision');
  if(source&&row.decision_event_id===source)return row;
  const evidence=await decisionEvidence(pool,row,String(input.decision),{fingerprint:row.fingerprint},source);
  const result=await pool.query(`UPDATE controlled_actions SET state=$2,decision_event_id=$3,permission_id=NULL,updated_at=now()
    WHERE id=$1 AND state IN ('proposed','approved') RETURNING id`,[id,input.decision==='approve'?'approved':'rejected',evidence]);
  if(!result.rowCount)throw new HttpError(409,'action_already_started_or_closed');
  return controlledAction(pool,owner,id);
}
export async function grantPermission(pool:pg.Pool,principal:Reader,value:unknown) {
  admin(principal);const input=object(value),row=await controlledAction(pool,owner,input.action_id);
  if(input.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
  const uses=input.uses,minutes=input.minutes;
  if(!Number.isInteger(uses)||Number(uses)<1||Number(uses)>1000||!Number.isInteger(minutes)||Number(minutes)<1||Number(minutes)>43200)throw new HttpError(400,'invalid_permission_bounds');
  const id=digest(randomUUID()),event=await decisionEvidence(pool,{...row,id},'grant',{fingerprint:row.fingerprint,uses,minutes});
  await pool.query(`INSERT INTO action_permissions(id,fingerprint,scope,profile,kind,arguments,expires_at,remaining,event_id,job_id)
    VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 minute',$8,$9,$10)`,[id,row.fingerprint,row.scope,row.profile,row.kind,Buffer.from(canonical(row.arguments)),minutes,uses,event,row.job_id]);
  return {id};
}
export async function revokePermission(pool:pg.Pool,principal:Reader,value:unknown,source?:string) {
  admin(principal);const id=idValue(object(value).id);
  const row=(await pool.query<{id:string;scope:string}>('SELECT id,scope FROM action_permissions WHERE id=$1',[id])).rows[0];
  if(!row)throw new HttpError(404,'permission_not_found');
  await decisionEvidence(pool,row,'revoke',{},source);
  await pool.query('UPDATE action_permissions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',[id]);
  return {id,revoked:true};
}
export async function claimControlled(pool:pg.Pool,value:unknown,jobId:string|null=null,authority:ExecutionAuthority) {
  const actor=string(object(value).actor,128);if(!/^[\w-]{1,128}$/.test(actor))throw new HttpError(400,'invalid_actor');
  if(jobId!==null)idValue(jobId);
  const client=await pool.connect();let fenced=false;
  try {
    fenced=await enterFamily(client,'tools',authority.owner,authority.epoch);if(!fenced)return {claimed:false};
    await client.query('BEGIN');
    if(authority.owner==='inngest')await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':controlled-operation',803322))");
    // No retry after a crashed executor. Missing outcomes stay explicitly ambiguous.
    const expired=(await client.query<Row>("UPDATE controlled_actions SET state='ambiguous',error_code='executor_receipt_missing',updated_at=now() WHERE state='running' AND lease_until<now() AND ($1::text IS NULL OR id=$1) RETURNING *",[jobId])).rows;
    for(const row of expired)await recordEffect(client,effect(row),'ambiguous',row.security_decision??await evaluate(client,effect(row)),row.event_id,row.permission_id??undefined);
    if(jobId){
      const stale=(await client.query<Row>("SELECT * FROM controlled_actions WHERE id=$1 AND state IN ('proposed','approved') AND (SELECT mode FROM guard_state)='on' AND guard_epoch IS DISTINCT FROM (SELECT epoch FROM guard_state) FOR UPDATE",[jobId])).rows[0];
      if(stale){
        const decision:Decision={...await evaluate(client,effect(stale)),outcome:'deny',origin:'mandatory',rule:'guard_context_changed'};
        await recordEffect(client,effect(stale),'blocked',decision,stale.event_id);
        await client.query("UPDATE controlled_actions SET state='rejected',security_decision=$2,error_code='guard_context_changed',updated_at=now() WHERE id=$1",[jobId,decision]);
        await client.query('COMMIT');return {claimed:false,blocked:jobId,reason:'guard_context_changed'};
      }
    }
    if(authority.owner==='inngest'&&(await client.query("SELECT 1 FROM controlled_actions WHERE state='running' LIMIT 1")).rowCount){await client.query('COMMIT');return {claimed:false};}
    const row=(await client.query<Row>(`SELECT a.* FROM controlled_actions a WHERE (a.state='approved' OR (a.state='proposed' AND EXISTS
      (SELECT 1 FROM action_permissions p WHERE p.fingerprint=a.fingerprint AND (p.job_id IS NULL OR p.job_id=a.job_id) AND p.revoked_at IS NULL AND p.remaining>0 AND p.expires_at>now())))
      AND ((SELECT mode FROM guard_state)='off' OR a.guard_epoch=(SELECT epoch FROM guard_state))
      AND ($1::text IS NULL OR a.id=$1)
      ORDER BY a.created_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,[jobId])).rows[0];
    if(!row){await client.query('COMMIT');return {claimed:false};}
    let permission:string|null=null;
    if(row.state==='proposed') {
      const grant=(await client.query<{id:string}>(`SELECT id FROM action_permissions WHERE fingerprint=$1 AND (job_id IS NULL OR job_id=$2) AND revoked_at IS NULL AND remaining>0 AND expires_at>now()
        ORDER BY expires_at LIMIT 1 FOR UPDATE`,[row.fingerprint,row.job_id])).rows[0];
      if(!grant){await client.query('COMMIT');return {claimed:false};}
      permission=grant.id;
    }
    const decision=await evaluate(client,effect(row),permission??'exact_owner_approval',true);
    if(decision.outcome!=='allow') {
      await recordEffect(client,effect(row),'blocked',decision,row.event_id,permission??undefined);
      await client.query("UPDATE controlled_actions SET state='rejected',security_decision=$2,updated_at=now() WHERE id=$1",[row.id,decision]);
      await client.query('COMMIT');return {claimed:false,blocked:row.id,reason:decision.rule};
    }
    if(permission)await client.query('UPDATE action_permissions SET remaining=remaining-1 WHERE id=$1',[permission]);
    await recordEffect(client,effect(row),'allowed',decision,row.event_id,permission??undefined);
    await recordEffect(client,effect(row),'claimed',decision,row.event_id,permission??undefined);
    await client.query(`UPDATE controlled_actions SET state='running',actor=$2,permission_id=$3,security_decision=$4,lease_until=now()+interval '120 seconds',
      execution_owner=$5,owner_epoch=(SELECT epoch FROM workflow_owners WHERE family='tools'),updated_at=now() WHERE id=$1`,[row.id,actor,permission,decision,authority.owner]);
    await client.query('COMMIT');return {claimed:true,...view({...row,state:'running',actor,permission_id:permission})};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await releaseOperation(client,async()=>{if(fenced)await leaveFamily(client,'tools');});}
}
export async function startControlled(pool:pg.Pool,value:unknown,authority:ExecutionAuthority) {
  const input=object(value),id=idValue(input.id),actor=string(input.actor,128),client=await pool.connect();
  let fenced=false;
  try {
    await client.query('BEGIN');
    const row=(await client.query<Row&{started_at:string|null;lease_until:Date;execution_owner:'legacy'|'inngest'|null;owner_epoch:number|null}>('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.actor!==actor||row.state!=='running')throw new HttpError(403,'action_actor_denied');
    const epoch=row.owner_epoch??(await client.query("SELECT epoch FROM workflow_owners WHERE family='tools'")).rows[0].epoch;
    if((row.execution_owner??'legacy')!==authority.owner||(authority.epoch!==undefined&&authority.epoch!==epoch))throw new HttpError(409,'workflow_owner_changed');
    fenced=await enterFamily(client,'tools',authority.owner,epoch,true);
    if(!fenced)throw new HttpError(409,'workflow_owner_changed');
    if(row.started_at){await client.query('COMMIT');return {started:false,reason:'execution_already_started'};}
    let blocked:string|undefined;
    const guard=await guardState(client);
    if(guard.mode==='on'&&Number(row.guard_epoch)!==guard.epoch)blocked='guard_context_changed';
    if(row.lease_until.getTime()<=Date.now())blocked='execution_lease_expired';
    if(row.permission_id){const grant=(await client.query('SELECT revoked_at,expires_at FROM action_permissions WHERE id=$1 FOR SHARE',[row.permission_id])).rows[0];if(!grant||grant.revoked_at||grant.expires_at.getTime()<=Date.now())blocked='permission_no_longer_valid';}
    const decision=await evaluate(client,effect(row),row.permission_id??'exact_owner_approval',true);
    if(blocked||decision.outcome!=='allow') {
      await recordEffect(client,effect(row),'blocked',blocked?{...decision,outcome:'deny',origin:'mandatory',rule:blocked}:decision,row.event_id,row.permission_id??undefined);
      await client.query('COMMIT');return {started:false,reason:blocked??decision.rule};
    }
    await client.query('UPDATE controlled_actions SET started_at=now(),security_decision=$2 WHERE id=$1',[id,decision]);
    await recordEffect(client,effect(row),'started',decision,row.event_id,row.permission_id??undefined);
    await client.query('COMMIT');return {started:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await releaseOperation(client,async()=>{if(fenced)await leaveFamily(client,'tools');});}
}
export async function finishControlled(pool:pg.Pool,value:unknown) {
  const input=object(value),id=idValue(input.id),actor=string(input.actor,128),result=object(input.result);
  if(!['done','failed','ambiguous'].includes(String(input.state))||canonical(result).length>1024*1024)throw new HttpError(400,'invalid_action_result');
  const content=Buffer.from(canonical({state:input.state,result})),client=await pool.connect();
  try {
    await client.query('BEGIN');const row=(await client.query<Row>('SELECT * FROM controlled_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.actor!==actor)throw new HttpError(403,'action_actor_denied');
    if(row.result) {
      if(!row.result.equals(content))throw new HttpError(409,'action_result_changed');
      await client.query('COMMIT');return {id,state:row.state};
    }
    if(!['running','ambiguous'].includes(row.state))throw new HttpError(409,'action_not_running');
    const derived=digest(canonical({action:id,content:digest(content)}));
    await client.query(`INSERT INTO derived_artifacts(id,event_id,kind,content,provenance,search_text)
      VALUES($1,$2,'controlled_action_result',$3,$4,$5) ON CONFLICT DO NOTHING`,[derived,row.event_id,content,{guard_epoch:row.guard_epoch===null?null:Number(row.guard_epoch),action_id:id,kind:row.kind,profile:row.profile,fingerprint:row.fingerprint,permission_id:row.permission_id},content.toString().replaceAll('\0','').slice(0,100000)]);
    const state=row.state==='ambiguous'?'ambiguous':input.state;
    await client.query('UPDATE controlled_actions SET state=$2,result=$3,result_id=$4,updated_at=now() WHERE id=$1',[id,state,content,derived]);
    await recordEffect(client,effect(row),(state==='done'?'completed':state) as EffectState,row.security_decision??await evaluate(client,effect(row)),row.event_id,row.permission_id??undefined);
    await client.query('COMMIT');return {id,state};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
