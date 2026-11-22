import {digest} from '../archive.js';
import {HttpError} from '../http.js';
import type {TurnReceipt} from '../agent/agent.js';
import type {RuntimeCall} from '../runtime.js';
import type {TurnInput} from './telegram-turn.js';
import {telegramTarget} from '../frontdoor/telegram.js';
import type {SendClass} from '../send-classes.js';

/**
 * Nocheh's own bot answers a Telegram turn (ADR-0235). The agent only returns the reply; Nocheh shows typing and the
 * working reaction while the agent works, then asks its bot to send the reply. The bot keeps a receipt per reply id, so
 * asking again after a lost answer never sends twice.
 */
export type ReplyFinish='answered'|'failed'|'clear';

/** One id per turn attempt for its presence and its reply in the bot. */
export const deliveryId=(event:string,attempt:number|string)=>digest(event+':'+attempt);

/** The asking message, from the routed payload, in the turn's chat and topic where Telegram has them now: the front
 * door's translation of the turn's space, the same the turn pass is bound to (ADR-0252). A space with no chat row is
 * never sent to. */
export function replyTarget(input:TurnInput,attempt:number|string,credential:string) {
  const message=(input.body.payload as {message?:{message_id?:unknown}})?.message??{},target=telegramTarget(input.principal.space);
  const event=input.principal.turnEvent??String(input.body.event_id);
  return {id:deliveryId(event,attempt),event_id:event,attempt,chat_id:target.chat_id,message_id:String(message.message_id),
    ...(target.topic!==undefined?{topic:target.topic}:{}),archive_credential:credential};
}

/** Whether the bot is connected to Telegram, so a turn's reply can be sent. An agent turn starts only then, as a reply
 * that cannot be sent would cost a model call for nothing. */
export async function botReady(call:RuntimeCall):Promise<boolean> {
  try{return ['connected','recovering'].includes(String((await call('telegram.identity',{},5000)).state));}catch{return false;}
}

/** Show typing and 👀 while the agent works, or keep them showing; they lapse on their own if Nocheh stops asking. */
export async function showPresence(call:RuntimeCall,target:ReturnType<typeof replyTarget>):Promise<void> {
  try{await call('telegram.presence',target,5000);}catch{/* Presence is cosmetic. */}
}

/** Stop typing and leave 👍, 👎 or no reaction. */
export async function finishPresence(call:RuntimeCall,target:ReturnType<typeof replyTarget>,finish:ReplyFinish):Promise<void> {
  try{await call('telegram.presence',{...target,finish},10000);}catch{/* The bot clears an unrenewed presence itself. */}
}

/** How a closed agent receipt that has no reply to send ends the working reaction. */
export const unansweredFinish=(state:string):ReplyFinish=>state==='failed'?'failed':'clear';

/** The one button a group reply may carry: Answer privately under the owner's own answer (ADR-0249). Its data is `np`
 * and the record's id, which the bot checks is the one for this turn's question. */
export interface ReplyButton {text:string;data:string}
/**
 * Send a done turn's reply. A follow-up notifies, as nobody watched it being typed. The answer is the bot's closed
 * receipt, `running` while it still sends, or null when the bot did not answer, so the same call is made again. The send
 * class says what kind of message it is, so memory can leave Nocheh's own cards out (ADR-0256). With `refused`, a
 * request the bot refuses as malformed (400: nothing was sent, and the same request is refused again) comes back as a
 * failed receipt (`reply_refused`) instead of null, so the caller stops asking.
 */
export async function sendReply(call:RuntimeCall,target:ReturnType<typeof replyTarget>,dispatchKey:string,reply:{text:string;session_id:string},
  options:{notify:boolean;presence:boolean;button?:ReplyButton;sendClass:SendClass;refused?:boolean}):Promise<Record<string,unknown>|null> {
  const {button,sendClass,refused,...rest}=options;
  try{return await call('telegram.reply',{...target,dispatch_key:dispatchKey,text:reply.text,session_id:reply.session_id,...rest,send_class:sendClass,...(button?{button}:{})},30000);}
  catch(error){return refused&&error instanceof HttpError&&error.status===400?{state:'failed',error_code:'reply_refused'}:null;}
}

/** Withdraw a reply that has not gone out yet; one already sent keeps its receipt. */
export async function cancelReply(call:RuntimeCall,event:string,attempt:number|string):Promise<void> {
  try{await call('telegram.reply',{id:deliveryId(event,attempt),cancel:true},10000);}catch{/* The bot's receipt stays authoritative. */}
}

/** Stops a reply the bot may still be sending and returns what became of it, or null when the bot did not answer. */
export async function withdrawReply(call:RuntimeCall,event:string,attempt:number|string):Promise<Record<string,unknown>|null> {
  try{return await call('telegram.reply',{id:deliveryId(event,attempt),cancel:true},10000);}catch{return null;}
}
/** A withdrawn reply that the bot already sent, may have sent, or settled as silence: its receipt stands. */
export const replyOutcome=(sent:Record<string,unknown>)=>['done','ambiguous','suppressed'].includes(String(sent.state));

/** The turn's receipt with the agent's timings and the bot's send: queued and assistant from the agent, delivery and
 * finished from the bot. */
export function deliveredReceipt(agent:TurnReceipt,delivery:Record<string,unknown>):Record<string,unknown> {
  const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const window=record(agent.window),sent=record(delivery.window);
  return {...delivery,timings:{...record(agent.timings),...record(delivery.timings)},
    window:{...(window.queued!==undefined?{queued:window.queued}:{}),...(window.assistant!==undefined?{assistant:window.assistant}:{}),
      ...(sent.delivery!==undefined?{delivery:sent.delivery}:{}),finished:sent.finished??window.finished}};
}
