import type pg from 'pg';

export type MessageSender={name:string|null;username:string|null;id:string|null};
export type AgentCopy={state:'none'|'pending'|'ready';revision:number|null};

/** Who wrote an original message, for the owner's lists only. Assistant replies have no sender. */
export function messageSender(kind:string,original:any):MessageSender|null {
  if(kind.endsWith('_delivered_message'))return null;
  // Desktop exports keep the display name as a string and the id beside it.
  const message=original?.message??original?.edited_message??original?.channel_post??original?.edited_channel_post;
  if(typeof message?.from==='string')return {name:message.from||null,username:null,id:message.from_id==null?null:String(message.from_id)};
  const from=message?.from??original?.message_reaction?.user;
  if(!from||typeof from!=='object')return null;
  const name=[from.first_name,from.last_name].filter(part=>typeof part==='string'&&part).join(' ');
  return {name:name||null,username:typeof from.username==='string'?from.username:null,id:from.id==null?null:String(from.id)};
}

/** Whether each message's assistant copy (its guarded version) exists and is ready. */
export async function agentCopies(derived:pg.Pool,ids:string[]):Promise<Map<string,AgentCopy>> {
  const copies=new Map<string,AgentCopy>(ids.map(id=>[id,{state:'none',revision:null}]));
  if(!ids.length)return copies;
  const rows=(await derived.query(`SELECT source_id,state,active_revision FROM guard_sources WHERE kind='events' AND source_id=ANY($1::text[])`,[ids])).rows;
  for(const row of rows)copies.set(row.source_id,{state:row.state,revision:row.active_revision});
  return copies;
}
