import type pg from 'pg';
import { canonical,digest,ingest } from './archive.js';
import { HttpError,object,string } from './http.js';
import type { Reader } from './access.js';
import {assertAudience} from './access.js';
import {admin} from './access.js';
import {randomUUID} from 'node:crypto';
import type { RuntimeCall } from './runtime.js';
import { conversationScope,type AssistantPolicy } from './assistant-policy.js';
import {controlledAction,controlledList,decideControlled,revokePermission} from './controlled-actions.js';

export async function telegramActions(pool:pg.Pool,principal:Reader) {
  admin(principal);
  return (await pool.query('SELECT id,event_id,scope,destination,original_text,state,error_code,created_at FROM action_requests ORDER BY created_at DESC LIMIT 100')).rows.map(row=>{
    const args={destination:row.destination,text:row.original_text.toString()};
    return {id:row.id,event_id:row.event_id,scope:row.scope,kind:'telegram_message',arguments:args,fingerprint:digest(canonical(args)),state:row.state,error_code:row.error_code,created_at:row.created_at};
  });
}
export async function decideTelegram(pool:pg.Pool,principal:Reader,value:unknown) {
  admin(principal);const input=object(value),rows=await telegramActions(pool,principal),row=rows.find(r=>r.id===input.id);
  if(!row)throw new HttpError(404,'action_not_found');
  if(input.fingerprint!==row.fingerprint)throw new HttpError(409,'action_changed');
  if(!['approve','deny'].includes(String(input.decision)))throw new HttpError(400,'invalid_decision');
  const evidence=await ingest(pool,{version:1,key:'owner-telegram-action:'+randomUUID(),channel:'browser',origin:'live',kind:'owner_action_decision',bot_id:'nocheh',scope:row.scope,
    source_id:row.id,revision:'0',occurred_at:null,text:null,payload:{action_id:row.id,decision:input.decision,fingerprint:row.fingerprint}});
  const result=await pool.query("UPDATE action_requests SET state=$2,decision_event_id=$3,updated_at=now() WHERE id=$1 AND state='proposed' RETURNING state",[row.id,input.decision==='approve'?'approved':'rejected',evidence.id]);
  if(!result.rowCount)throw new HttpError(409,'action_already_started_or_closed');
  return {id:row.id,state:result.rows[0].state};
}

export async function requestAction(pool:pg.Pool,principal:Reader,value:unknown) {
  await assertAudience(pool,principal);
  if (!principal.turnEvent)throw new HttpError(403,'assistant_turn_required');
  const input=object(value),destination=string(input.destination,32),text=string(input.text,3500);
  if (!/^-?[1-9]\d{0,18}$/.test(destination) || !text.trim())throw new HttpError(400,'invalid_action');
  const event=(await pool.query<{scope:string;bot_id:string}>('SELECT scope,bot_id FROM events WHERE id=$1',[principal.turnEvent])).rows[0];
  if(!event || (principal.scope!==null && principal.scope!==event.scope))throw new HttpError(403,'action_scope_denied');
  const id=digest(canonical({event_id:principal.turnEvent,destination,text}));
  await ingest(pool,{version:1,key:'action-request:'+id,origin:'generated',kind:'action_request',bot_id:event.bot_id,scope:event.scope,
    source_id:id,revision:'0',occurred_at:null,text,payload:{source_event_id:principal.turnEvent,kind:'telegram_message',destination}});
  await pool.query('INSERT INTO action_requests(id,event_id,scope,destination,original_text) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id,principal.turnEvent,event.scope,destination,Buffer.from(text)]);
  return {id,state:'proposed',message:'Owner must review /action '+id+' and type /approve '+id+' in their private DM.'};
}

export async function controlReply(pool:pg.Pool,policy:AssistantPolicy,eventId:string):Promise<string|null> {
  const event=(await pool.query<{scope:string;payload:Buffer;bot_id:string}>("SELECT scope,payload,bot_id FROM events WHERE id=$1 AND origin='live' AND kind='telegram_update'",[eventId])).rows[0];
  if(!event)return null;
  const payload=JSON.parse(event.payload.toString()) as {message?:{text?:string}};
  const text=payload.message?.text;
  if(typeof text!=='string')return null;
  const command=text.trim().match(/^\/(actions|action|approve|deny|permissions|revoke)(?:\s+([a-f0-9]{64}))?$/);
  if(!command)return null;
  if(!conversationScope(policy,payload,event.scope)?.owner)return 'Only the owner can review or approve actions in their private DM.';
  const owner={scope:null,admin:true};
  if(command[1]==='permissions') {
    const list=await controlledList(pool,owner);
    return list.permissions.length?list.permissions.map(p=>`${p.id}\n${p.kind} · profile ${p.profile}\nRemaining: ${p.remaining}; expires ${p.expires_at}; revoked: ${!!p.revoked_at}\nRevoke: /revoke ${p.id}`).join('\n\n').slice(0,3500):'No standing permissions.';
  }
  if(command[1]==='revoke') {
    if(!command[2])return 'Include the full permission ID.';
    try{await revokePermission(pool,owner,{id:command[2]},eventId);return 'Permission revoked. Already-started operations cannot be undone.';}
    catch(error){if(error instanceof HttpError&&error.status===404)return 'Permission not found.';throw error;}
  }
  const observed=(await pool.query<{original_text:Buffer}>('SELECT original_text FROM events WHERE source_key=$1',['action-decision:'+eventId])).rows[0];
  if(observed)return observed.original_text.toString();
  if(command[1]==='actions') {
    const {rows}=await pool.query<{id:string;destination:string;state:string}>("SELECT id,destination,state FROM action_requests WHERE state IN ('proposed','approved','running','ambiguous') ORDER BY created_at DESC LIMIT 10");
    const tools=(await controlledList(pool,owner)).actions.filter(a=>['proposed','approved','running','ambiguous'].includes(a.state)).slice(0,10);
    const lines=[...tools.map(a=>`${a.id}\n${a.kind} · ${a.state}\nReview: /action ${a.id}`),...rows.map(r=>`${r.id}\nTelegram destination: ${r.destination}\nStatus: ${r.state}\nReview: /action ${r.id}`)];
    return lines.length?lines.join('\n\n').slice(0,3500):'No pending actions.';
  }
  if(!command[2])return 'Include the full action ID.';
  const action=(await pool.query<{id:string;destination:string;original_text:Buffer;state:string;decision_event_id:string}>('SELECT id,destination,original_text,state,decision_event_id FROM action_requests WHERE id=$1',[command[2]])).rows[0];
  if(!action) {
    try {
      const tool=await controlledAction(pool,owner,command[2]);
      if(command[1]==='action') {
        const detail=canonical(tool.arguments);
        if(detail.length>2200)return `${tool.kind} · ${tool.state}\nArguments are too long to review in Telegram. Open Nocheh Activity to review this action in full.\nID: ${tool.id}`;
        return `${tool.kind} · ${tool.state}\nProfile: ${tool.profile}\nExact arguments:\n${detail}\n\nApprove: /approve ${tool.id}\nReject: /deny ${tool.id}`;
      }
      if(command[1]==='approve'&&canonical(tool.arguments).length>2200)return 'Review and approve this large action in Nocheh Activity.';
      const decided=await decideControlled(pool,owner,{id:tool.id,fingerprint:tool.fingerprint,decision:command[1]},eventId);
      return `Action ${tool.id} ${decided.state}.`;
    }catch(error){if(error instanceof HttpError)return error.code==='action_not_found'?'Action not found.':error.code.replaceAll('_',' ');throw error;}
  }
  if(command[1]==='action')return `Telegram destination: ${action.destination}\nStatus: ${action.state}\nExact message:\n${action.original_text.toString()}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`;
  const decision=command[1]==='approve'?'approved':'rejected';
  const updated=await pool.query("UPDATE action_requests SET state=$2,decision_event_id=$3,updated_at=now() WHERE id=$1 AND state='proposed' RETURNING id",[action.id,decision,eventId]);
  // The command's captured original is authoritative; the generated observation
  // keeps decisions in portable exports without replaying external effects.
  const applied=!!updated.rowCount || action.decision_event_id===eventId;
  const reply=applied?`Action ${action.id} ${decision}.`:`Action ${action.id} is already ${action.state}.`;
  await ingest(pool,{version:1,key:`action-decision:${eventId}`,origin:'generated',kind:'action_decision',bot_id:event.bot_id,scope:event.scope,source_id:action.id,revision:eventId,occurred_at:null,text:reply,payload:{action_id:action.id,decision,decision_event_id:eventId,applied}});
  return reply;
}

export async function executeApproved(pool:pg.Pool,call:RuntimeCall) {
  const client=await pool.connect();let held=false;
  try {
    held=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(803303) AS locked')).rows[0]!.locked;
    if(!held)return;
    const row=(await client.query<{id:string;destination:string;original_text:Buffer}>("SELECT id,destination,original_text FROM action_requests WHERE (state='approved' OR (state='running' AND updated_at < now()-interval '30 seconds')) AND decision_event_id IS NOT NULL ORDER BY updated_at LIMIT 1")).rows[0];
    if(!row)return;
    await client.query("UPDATE action_requests SET state='running',updated_at=now() WHERE id=$1",[row.id]);
    try {
      const result=await call('action.execute',{id:row.id,destination:row.destination,text:row.original_text.toString()},60000);
      if(!['done','ambiguous'].includes(String(result.state)))throw Error('invalid_receipt');
      await client.query('UPDATE action_requests SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[row.id,result.state,result.state==='ambiguous'?'delivery_unconfirmed':null]);
    } catch {await client.query("UPDATE action_requests SET error_code='awaiting_action_receipt',updated_at=now() WHERE id=$1",[row.id]);}
  } finally {if(held)await client.query('SELECT pg_advisory_unlock(803303)');client.release();}
}
