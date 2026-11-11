import {digest} from '../archive.js';
import type {TurnReceipt} from '../brain/brain.js';
import type {RuntimeCall} from '../runtime.js';
import type {TurnInput} from './telegram-turn.js';

/**
 * Nocheh's own bot answers a Telegram turn (ADR-0235). The brain only returns the reply; Nocheh shows typing and the
 * working reaction while the brain works, then asks its bot to send the reply. The bot keeps a receipt per reply id, so
 * asking again after a lost answer never sends twice.
 */
export type ReplyFinish='answered'|'failed'|'clear';

/** One id per turn attempt for its presence and its reply in the bot. */
export const deliveryId=(event:string,attempt:number|string)=>digest(event+':'+attempt);

/** The asking message, its chat and its topic, from the routed payload and the turn's space. */
export function replyTarget(input:TurnInput,attempt:number|string,credential:string) {
  const message=(input.body.payload as {message?:{message_id?:unknown;chat?:{id?:unknown}}})?.message??{},space=input.principal.space??'';
  const topic=space.includes('/topic/')?Number(space.split('/topic/')[1]):undefined;
  const event=input.principal.turnEvent??String(input.body.event_id);
  return {id:deliveryId(event,attempt),event_id:event,attempt,chat_id:String(message.chat?.id),message_id:String(message.message_id),
    ...(topic?{topic}:{}),archive_credential:credential};
}

/** Whether the bot is connected to Telegram, so a turn's reply can be sent. A brain turn starts only then, as a reply
 * that cannot be sent would cost a model call for nothing. */
export async function botReady(call:RuntimeCall):Promise<boolean> {
  try{return ['connected','recovering'].includes(String((await call('telegram.identity',{},5000)).state));}catch{return false;}
}

/** Show typing and 👀 while the brain works, or keep them showing; they lapse on their own if Nocheh stops asking. */
export async function showPresence(call:RuntimeCall,target:ReturnType<typeof replyTarget>):Promise<void> {
  try{await call('telegram.presence',target,5000);}catch{/* Presence is cosmetic. */}
}

/** Stop typing and leave 👍, 👎 or no reaction. */
export async function finishPresence(call:RuntimeCall,target:ReturnType<typeof replyTarget>,finish:ReplyFinish):Promise<void> {
  try{await call('telegram.presence',{...target,finish},10000);}catch{/* The bot clears an unrenewed presence itself. */}
}

/** How a closed brain receipt that has no reply to send ends the working reaction. */
export const unansweredFinish=(state:string):ReplyFinish=>state==='failed'?'failed':'clear';

/**
 * Send a done turn's reply. A follow-up notifies, as nobody watched it being typed. The answer is the bot's closed
 * receipt, `running` while it still sends, or null when the bot did not answer, so the same call is made again.
 */
export async function sendReply(call:RuntimeCall,target:ReturnType<typeof replyTarget>,dispatchKey:string,reply:{text:string;session_id:string},
  options:{notify:boolean;presence:boolean}):Promise<Record<string,unknown>|null> {
  try{return await call('telegram.reply',{...target,dispatch_key:dispatchKey,text:reply.text,session_id:reply.session_id,...options},30000);}
  catch{return null;}
}

/** Withdraw a reply that has not gone out yet; one already sent keeps its receipt. */
export async function cancelReply(call:RuntimeCall,event:string,attempt:number|string):Promise<void> {
  try{await call('telegram.reply',{id:deliveryId(event,attempt),cancel:true},10000);}catch{/* The bot's receipt stays authoritative. */}
}

/** The turn's receipt with the brain's timings and the bot's send: queued and assistant from the brain, delivery and
 * finished from the bot. */
export function deliveredReceipt(brain:TurnReceipt,delivery:Record<string,unknown>):Record<string,unknown> {
  const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const window=record(brain.window),sent=record(delivery.window);
  return {...delivery,timings:{...record(brain.timings),...record(delivery.timings)},
    window:{...(window.queued!==undefined?{queued:window.queued}:{}),...(window.assistant!==undefined?{assistant:window.assistant}:{}),
      ...(sent.delivery!==undefined?{delivery:sent.delivery}:{}),finished:sent.finished??window.finished}};
}
