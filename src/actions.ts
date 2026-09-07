import type pg from 'pg';
import { canonical,digest,ingest } from './archive.js';
import { HttpError,object,string } from './http.js';
import type { Reader } from './access.js';
import type { RuntimeCall } from './runtime.js';
import { conversationScope,type AssistantPolicy } from './assistant-policy.js';

export async function requestAction(pool:pg.Pool,principal:Reader,value:unknown) {
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
  const command=text.trim().match(/^\/(actions|action|approve|deny)(?:\s+([a-f0-9]{64}))?$/);
  if(!command)return null;
  if(!conversationScope(policy,payload,event.scope)?.owner)return 'Only the owner can review or approve actions in their private DM.';
  const observed=(await pool.query<{original_text:Buffer}>('SELECT original_text FROM events WHERE source_key=$1',['action-decision:'+eventId])).rows[0];
  if(observed)return observed.original_text.toString();
  if(command[1]==='actions') {
    const {rows}=await pool.query<{id:string;destination:string;state:string}>("SELECT id,destination,state FROM action_requests WHERE state IN ('proposed','approved','running','ambiguous') ORDER BY created_at DESC LIMIT 10");
    return rows.length?rows.map(r=>`${r.id}\nTelegram destination: ${r.destination}\nStatus: ${r.state}\nReview: /action ${r.id}`).join('\n\n'):'No pending actions.';
  }
  if(!command[2])return 'Include the full action ID.';
  const action=(await pool.query<{id:string;destination:string;original_text:Buffer;state:string;decision_event_id:string}>('SELECT id,destination,original_text,state,decision_event_id FROM action_requests WHERE id=$1',[command[2]])).rows[0];
  if(!action)return 'Action not found.';
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
