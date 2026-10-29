import {HttpError} from './http.js';
import {messageSender} from './stores/archive-row-details.js';
import {reactionPreview} from './reaction-preview.js';
import {sourceContentTypes} from './source-content.js';

/** How a conversation is read in order: one page of messages, oldest first. */
export const PAGE_TEXT=1500,FILE_TEXT=1000,PAGE_BUDGET=30000;
export type PageEntry='message'|'edit'|'reaction'|'assistant'|'service';

const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const identifier=(value:unknown):string|null=>typeof value==='number'&&Number.isSafeInteger(value)||typeof value==='string'&&/^-?\d{1,20}$/.test(value)?String(value):null;
const cut=(text:string,limit:number)=>({text:text.slice(0,limit),...(text.length>limit?{truncated:true}:{})});

/** What a stored record is in a conversation; null for updates that are not part of it, such as button presses. */
export function pageEntry(kind:string,payload:unknown):PageEntry|null {
  const value=object(payload);
  if(kind.endsWith('_delivered_message'))return 'assistant';
  if(kind==='browser_input')return 'message';
  if(kind==='telegram_desktop_message')return 'message';
  if(kind.startsWith('telegram_desktop_'))return 'service';
  if(kind!=='telegram_update')return null;
  if(value.message||value.channel_post)return 'message';
  if(value.edited_message||value.edited_channel_post)return 'edit';
  if(value.message_reaction||value.message_reaction_count)return 'reaction';
  return null;
}

/** Reactions an exported message carries, as counts with the names Telegram listed. */
function exportedReactions(message:Record<string,any>) {
  if(!Array.isArray(message.reactions))return undefined;
  return message.reactions.slice(0,20).map((item:unknown)=>{
    const reaction=object(item),recent=Array.isArray(reaction.recent)?reaction.recent:[];
    const by=recent.map(entry=>object(entry).from).filter((name:unknown):name is string=>typeof name==='string'&&name.length>0).slice(0,10);
    return {reaction:reaction.type==='emoji'&&typeof reaction.emoji==='string'?reaction.emoji.slice(0,16):'custom',
      count:Number.isSafeInteger(reaction.count)?reaction.count:by.length,...(by.length?{by}:{})};
  });
}

/** One record in the compact form the agent pages through. Reply and topic ids are Telegram message ids. */
export function pageItem(input:{id:string;kind:string;at:Date;payload:unknown;text:string;files?:{kind:string;text:string}[]}) {
  const entry=pageEntry(input.kind,input.payload)!,value=object(input.payload);
  const message=object(value.message??value.edited_message??value.channel_post??value.edited_channel_post);
  const exported=input.kind.startsWith('telegram_desktop_');
  const reaction=entry==='reaction'?reactionPreview(input.kind,input.payload):null;
  const sender=entry==='assistant'||entry==='reaction'?null:messageSender(input.kind,input.payload);
  const reply=exported?identifier(message.reply_to_message_id):identifier(object(message.reply_to_message).message_id);
  const topic=exported?identifier(value.topic_id):message.is_topic_message?identifier(message.message_thread_id):null;
  const id=identifier(exported?message.id:message.message_id);
  const reactions=exported?exportedReactions(message):undefined;
  const types=sourceContentTypes(input.kind,input.payload).filter(type=>type!=='reaction');
  return {source:'nocheh:event:'+input.id,at:input.at.toISOString(),type:entry,
    ...(id?{message_id:id}:{}),...(reply?{reply_to:reply}:{}),...(topic?{topic}:{}),
    ...(sender?{from:sender.name??(sender.username?'@'+sender.username:sender.id)}:{}),
    ...(reaction?{reaction:{change:reaction.change,by:reaction.actor,message_id:reaction.target}}:{}),
    ...(input.text?cut(input.text,PAGE_TEXT):{}),...(types.length?{content:types}:{}),
    ...(reactions?.length?{reactions}:{}),
    ...(input.files?.length?{files:input.files.slice(0,5).map(file=>({kind:file.kind,...cut(file.text,FILE_TEXT)}))}:{})};
}

/** A page boundary is the last record's time, in microseconds, and its id, so a page never repeats or skips one. */
export function cursor(value:string):{micros:string;id:string}|null {
  if(!value)return null;
  const match=value.match(/^(\d{1,18})-([a-f0-9]{64})$/);
  if(!match)throw new HttpError(400,'invalid_cursor');
  return {micros:match[1]!,id:match[2]!};
}

/** A day (2026-10-01) or a moment with its zone; a day for `to` includes that whole day. */
export function pageDate(value:string,end=false):Date|null {
  if(!value)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day=new Date(value+'T00:00:00Z');if(Number.isNaN(day.getTime()))throw new HttpError(400,'invalid_date');
    return end?new Date(day.getTime()+86400000):day;
  }
  const moment=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)?new Date(value):null;
  if(!moment||Number.isNaN(moment.getTime()))throw new HttpError(400,'invalid_date');
  return moment;
}
