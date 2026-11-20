import type pg from 'pg';
import {digest} from '../archive.js';
import {cardName} from '../action-text.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import type {Brain} from '../brain/brain.js';
import {brainOperation} from '../brain/brain.js';
import {telegramAddress} from '../frontdoor/telegram.js';
import {HttpError,object,string} from '../http.js';
import {fillTemplate,ownerPrompts,scheduleNoticeLines,type ScheduleNoticeText} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';

/*
 * The owner's own message when a reply in their private chat set a schedule with the brain's own schedule tool (ADR-0266).
 * The scheduler captures the new schedule, then asks for this message once: code writes it from the schedule's fields,
 * with Pause and Delete buttons that only the owner's press in that chat acts on. The schedule's results later come to
 * the same chat with no card each time.
 */

/** A button's data: `nk`, the choice (p pauses, d deletes), the 24 hex of the chat's schedule store and the schedule's
 *  12 hex id, as Hermes makes them. */
export const scheduleButton=/^nk([pd])([a-f0-9]{24})([a-f0-9]{12})$/;
export type ScheduleChoice='p'|'d';
const PROFILE=/^nocheh-([a-f0-9]{24})$/,JOB=/^[a-f0-9]{12}$/;
/** At most `size` code points, as Telegram counts a button's label and a press's answer. */
const points=(text:string,size:number)=>Array.from(text).slice(0,size).join('');
/** One short line someone else (the brain) wrote: the schedule's name or how often it runs. */
const line=(value:unknown,size:number)=>cardName(value,size);

/** An instant as the owner reads it, in their Tasks time zone: "Mon 24 Nov, 08:00". A zone the server does not know reads UTC. */
export function ownerTime(value:unknown,zone:string):string|null {
  if(typeof value!=='string')return null;
  const instant=Date.parse(value);if(!Number.isFinite(instant))return null;
  const format=(timeZone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .format(new Date(instant));
  try{return format(zone);}catch{return format('UTC')+' UTC';}
}

export class ScheduleNotices {
  constructor(readonly control:pg.Pool,readonly policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>,readonly call:RuntimeCall,readonly brain:Brain){}

  private async lines():Promise<Record<ScheduleNoticeText,string>> {
    return scheduleNoticeLines((await ownerPrompts(this.control))['schedules.notice_texts']);
  }
  private static id(profile:string,job:string){return digest('schedule-notice:'+profile+':'+job);}

  /** The message's text from the schedule's fields: its name, how often and in which zone it runs, and its next run. */
  text(lines:Record<ScheduleNoticeText,string>,body:Record<string,unknown>):string {
    const zone=typeof body.timezone==='string'?body.timezone:null,when=line(body.schedule,120)??'';
    return [fillTemplate(lines.set,{name:line(body.name,80)??lines.unnamed}),
      fillTemplate(lines.when,{when:when&&zone?`${when} (${zone})`:when||zone}),
      fillTemplate(lines.next,{next:ownerTime(body.next_run_at,zone??'UTC')??lines.no_next}),lines.note].filter(Boolean).join('\n');
  }

  /**
   * The scheduler's request once it captured a schedule a reply set (POST /v1/scheduler/announce): the message in the
   * owner's private chat, at most once by the schedule's id. Only a schedule in the owner's private chat gets one. A
   * Telegram service that refuses its buttons gets the text alone; one that does not answer is not tried again, so the
   * scheduler is never held up by it.
   */
  async announce(input:unknown):Promise<{state:string}> {
    const body=object(input),scope=string(body.scope,64),profile=string(body.profile,64),job=string(body.job_id,128);
    const owner=ownerChat(this.policy()),target=telegramAddress(owner);
    if(!owner||scope!==owner||!target)return {state:'skipped'};
    if(!PROFILE.test(profile))throw new HttpError(400,'invalid_schedule_identity');
    const lines=await this.lines(),text=this.text(lines,body);
    const notice={id:ScheduleNotices.id(profile,job),...target,text,send_class:'notice'};
    const buttons=JOB.test(job)?[[{text:points(lines.pause,40),callback:'nkp'+profile.slice(7)+job},{text:points(lines.delete,40),callback:'nkd'+profile.slice(7)+job}]]:null;
    try{return {state:String((await this.call('telegram.notice',buttons?{...notice,buttons}:notice,30000))?.state??'failed')};}
    catch(error) {
      if(!buttons||!(error instanceof HttpError)||error.code!=='telegram_rejected_request')return {state:'failed'};
      try{return {state:String((await this.call('telegram.notice',notice,30000))?.state??'failed')};}catch{return {state:'failed'};}
    }
  }

  /**
   * A press on the message, already checked to be the owner's own in their private chat: pause or delete the schedule
   * through the brain, as the Schedules page does. The message then shows the answer under its text and loses its
   * buttons. Returns the answer to the press.
   */
  async press(choice:ScheduleChoice,store:string,job:string,press:string):Promise<string> {
    const lines=await this.lines(),profile='nocheh-'+store,owner=ownerChat(this.policy()),target=telegramAddress(owner);
    const manage=brainOperation(this.brain,'manageSchedules');
    let reply:string,text:string;
    try {
      // Only a schedule of the owner's private chat that is still there; its message shows it as it is now.
      const listed=(await manage({operation:'list'})).schedules;
      const found=Array.isArray(listed)?listed.find((item:any)=>item?.profile===profile&&item?.id===job&&item?.scope===owner):undefined;
      if(!found)return lines.changed;
      const result=await manage({operation:choice==='p'?'pause':'delete',profile,job_id:job,request_id:'press-'+press.slice(0,64)});
      text=this.text(lines,choice==='p'&&result.schedule&&typeof result.schedule==='object'?result.schedule as Record<string,unknown>:found);
      reply=choice==='p'?lines.paused:lines.deleted;
    }catch(error){if(!(error instanceof HttpError)||error.status>=500&&error.code!=='brain_rejected')throw error;return lines.changed;}
    // The message shows the answer and loses its buttons; an edit that fails changes nothing else.
    if(target)await this.call('telegram.notice',{id:ScheduleNotices.id(profile,job),...target,text:text+'\n\n'+points(reply,280),edit:true},30000).catch(()=>{});
    return reply;
  }
}
