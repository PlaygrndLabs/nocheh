import { readFileSync } from 'node:fs';
import { HttpError, object } from './http.js';

export interface GroupAccess {granted:string[];denied:string[]}
export interface AssistantPolicy {enabled:boolean;owner_id:string|null;group_ids:string[];group_access?:Record<string,GroupAccess>}
export function groupAccess(value:unknown,groups:string[],owner:string|null):Record<string,GroupAccess> {
  const input=object(value),result:Record<string,GroupAccess>={};
  if(Object.keys(input).length>100)throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
  for(const [group,raw] of Object.entries(input)) {
    if(!groups.includes(group))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
    const entry=object(raw);
    if(Object.keys(entry).some(key=>!['granted','denied'].includes(key))||!Array.isArray(entry.granted)||!Array.isArray(entry.denied))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
    const normalize=(values:unknown[]):string[]=>{
      if(values.length>1000||values.some(id=>typeof id!=='string'||!/^[1-9]\d{0,18}$/.test(id)||id===owner))throw new Error('Invalid TELEGRAM_GROUP_ACCESS');
      return [...new Set(values as string[])].sort();
    };
    result[group]={granted:normalize(entry.granted),denied:normalize(entry.denied)};
  }
  return result;
}
export function assistantPolicy(path?:string):AssistantPolicy {
  const enabled=process.env.TELEGRAM_ENABLED ?? 'false';
  if (!path && !['true','false'].includes(enabled)) throw new Error('Invalid TELEGRAM_ENABLED');
  const value=path ? object(JSON.parse(readFileSync(path,'utf8'))) : {
    enabled:enabled==='true',owner_id:process.env.TELEGRAM_OWNER_ID || null,
    group_ids:(process.env.TELEGRAM_GROUP_IDS ?? '').split(',').map(v=>v.trim()).filter(Boolean),
    group_access:JSON.parse(process.env.TELEGRAM_GROUP_ACCESS ?? '{}'),
  };
  if (typeof value.enabled!=='boolean' || (value.owner_id!==null && (typeof value.owner_id!=='string' || !/^[1-9]\d{0,18}$/.test(value.owner_id))) ||
      !Array.isArray(value.group_ids) || value.group_ids.some(v=>typeof v!=='string' || !/^-\d{1,19}$/.test(v)) ||
      (value.enabled && !value.owner_id)) throw new Error('Invalid assistant policy');
  const groups=[...new Set(value.group_ids as string[])];
  return {enabled:value.enabled,owner_id:value.owner_id as string|null,group_ids:groups,
    group_access:groupAccess(value.group_access??{},groups,value.owner_id as string|null)};
}
export function conversationScope(policy:AssistantPolicy,payload:unknown,scope:string):{owner:boolean;chat_id:string;user_id:string}|null {
  if (!policy.enabled) return null;
  const update=object(payload);
  if (!update.message) return null; // Edits, reactions and callbacks are archived without creating old replies.
  const message=object(update.message),chat=object(message.chat),sender=object(message.from ?? {});
  if (String(chat.id)!==scope) throw new HttpError(400,'source_scope_mismatch');
  if (sender.is_bot===true || !sender.id) return null;
  const owner=chat.type==='private' && String(chat.id)===policy.owner_id && String(sender.id)===policy.owner_id;
  if (!owner) {
    if (!['group','supergroup'].includes(String(chat.type)) || !policy.group_ids.includes(scope)) return null;
    const user=String(sender.id),access=policy.group_access?.[scope];
    if(user!==policy.owner_id && (!access?.granted.includes(user)||access.denied.includes(user)))return null;
  }
  return {owner,chat_id:scope,user_id:String(sender.id)};
}

/** Final Telegram send authorization uses the captured original, never a prepared representation. */
export function telegramDeliveryAllowed(policy:AssistantPolicy,principal:{scope:string|null},source:{origin:string;channel:string;kind:string;scope:string;payload:Buffer}|null):boolean {
  if(!source)return false;
  if(source.channel!=='telegram')return true;
  if(source.origin!=='live'||source.kind!=='telegram_update')return false;
  try {
    const selected=conversationScope(policy,JSON.parse(source.payload.toString()),source.scope);
    return !!selected&&(selected.owner?null:selected.chat_id)===principal.scope;
  }catch{return false;}
}
