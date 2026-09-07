import { readFileSync } from 'node:fs';
import { HttpError, object } from './http.js';

export interface AssistantPolicy {enabled:boolean;owner_id:string|null;group_ids:string[]}
export function assistantPolicy(path?:string):AssistantPolicy {
  const enabled=process.env.TELEGRAM_ENABLED ?? 'false';
  if (!path && !['true','false'].includes(enabled)) throw new Error('Invalid TELEGRAM_ENABLED');
  const value=path ? object(JSON.parse(readFileSync(path,'utf8'))) : {
    enabled:enabled==='true',owner_id:process.env.TELEGRAM_OWNER_ID || null,
    group_ids:(process.env.TELEGRAM_GROUP_IDS ?? '').split(',').map(v=>v.trim()).filter(Boolean),
  };
  if (typeof value.enabled!=='boolean' || (value.owner_id!==null && (typeof value.owner_id!=='string' || !/^[1-9]\d{0,18}$/.test(value.owner_id))) ||
      !Array.isArray(value.group_ids) || value.group_ids.some(v=>typeof v!=='string' || !/^-\d{1,19}$/.test(v)) ||
      (value.enabled && !value.owner_id)) throw new Error('Invalid assistant policy');
  return {enabled:value.enabled,owner_id:value.owner_id as string|null,group_ids:[...new Set(value.group_ids as string[])]};
}
export function conversationScope(policy:AssistantPolicy,payload:unknown,scope:string):{owner:boolean;chat_id:string;user_id:string}|null {
  if (!policy.enabled) return null;
  const update=object(payload);
  if (!update.message) return null; // Edits, reactions and callbacks are archived without creating old replies.
  const message=object(update.message),chat=object(message.chat),sender=object(message.from ?? {});
  if (String(chat.id)!==scope) throw new HttpError(400,'source_scope_mismatch');
  if (sender.is_bot===true || !sender.id) return null;
  const owner=chat.type==='private' && String(chat.id)===policy.owner_id && String(sender.id)===policy.owner_id;
  if (!owner && (!['group','supergroup'].includes(String(chat.type)) || !policy.group_ids.includes(scope))) return null;
  return {owner,chat_id:scope,user_id:String(sender.id)};
}
