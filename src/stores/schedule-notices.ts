import type pg from 'pg';
import {digest} from '../archive.js';
import {cardName} from '../action-text.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {noticeDigest} from '../notice-authorize.js';
import {memberAssistant} from '../spaces.js';
import type {Agent} from '../agent/agent.js';
import {agentOperation} from '../agent/agent.js';
import {telegramAddress} from '../frontdoor/telegram.js';
import {HttpError,object,string} from '../http.js';
import {fillTemplate,ownerPrompts,scheduleNoticeLines,type ScheduleNoticeText} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';
import {memberReads} from './member-reads.js';
import {issueScheduleGrant,scheduleKey} from './schedules.js';

/*
 * The owner's own message when a reply in their private chat set a schedule with the agent's own schedule tool (ADR-0266).
 * Nocheh records the new schedule from that turn, then sends this message once (ADR-0290): code writes it from its fields,
 * with Pause and Delete buttons that only the owner's press in that chat acts on. The schedule's results later come to
 * the same chat with no card each time. A member with Personal assistant on gets the same message in their own private
 * chat for a schedule they set there, and only their own press there acts on it (members' schedules).
 */

/** A member's schedule message, waiting for nocheh-telegram to ask before it sends it (/internal/notices/authorize):
 *  its notice id, the member's chat and the digest of its exact text. The ask spends it. */
export const scheduleNoticeSchema=`
CREATE TABLE IF NOT EXISTS schedule_notice_grants (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),chat_id text NOT NULL,text_digest text NOT NULL CHECK(text_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);`;

/** nocheh-telegram's one ask before it sends a member's schedule message: allowed once, for that notice id, that chat in
 *  Telegram and that exact text, while the chat is a member's own with Personal assistant on. */
export async function authorizeScheduleNotice(db:Pick<pg.Pool,'query'>,request:{id:string;chat:string;text_digest:string}):Promise<boolean> {
  const row=(await db.query<{chat_id:string}>('DELETE FROM schedule_notice_grants WHERE id=$1 AND text_digest=$2 RETURNING chat_id',
    [request.id,request.text_digest])).rows[0];
  if(!row||!memberAssistant(row.chat_id))return false;
  const target=telegramAddress(row.chat_id,chats());
  return !!target&&target.topic===undefined&&target.chat_id===request.chat;
}

/** A button's data: `nk`, the choice (p pauses, s starts one saved paused, d deletes), the 24 hex of the chat's schedule
 *  store and the schedule's 12 hex id, as Hermes makes them. */
export const scheduleButton=/^nk([psd])([a-f0-9]{24})([a-f0-9]{12})$/;
export type ScheduleChoice='p'|'s'|'d';
/** How much of a schedule's saved instruction its message shows; the Schedules page shows all of it. */
const PROMPT_POINTS=700;
const PROFILE=/^nocheh-([a-f0-9]{24})$/,JOB=/^[a-f0-9]{12}$/;
/** At most `size` code points, as Telegram counts a button's label and a press's answer. */
const points=(text:string,size:number)=>Array.from(text).slice(0,size).join('');
/** One short line someone else (the agent) wrote: the schedule's name or how often it runs. */
const line=(value:unknown,size:number)=>cardName(value,size);

/** An instant as the owner reads it, in their Tasks time zone: "Mon 24 Nov, 08:00". A zone the server does not know reads UTC. */
export function ownerTime(value:unknown,zone:string):string|null {
  if(typeof value!=='string')return null;
  const instant=Date.parse(value);if(!Number.isFinite(instant))return null;
  const format=(timeZone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .format(new Date(instant));
  try{return format(zone);}catch{return format('UTC')+' UTC';}
}

/** A schedule's saved instruction as its message shows it: the start of it, on one paragraph's worth of lines. */
function instruction(value:unknown):string|null {
  if(typeof value!=='string'||!value.trim())return null;
  const text=value.replace(/\r\n?/g,'\n').replace(/\n{3,}/g,'\n\n').trim(),shown=points(text,PROMPT_POINTS);
  return shown.length<text.length?shown.trimEnd()+'…':shown;
}
/** The outside content a turn read, in the owner's words: "a web page and a file". */
function readsText(lines:Record<ScheduleNoticeText,string>,reads:unknown[]):string {
  const known:Record<string,ScheduleNoticeText>={forward:'read_forward',file:'read_file',reply:'read_reply',web:'read_web',tools:'read_tools',notion:'read_tools',archive:'read_archive'};
  const names=[...new Set(reads.map(read=>lines[known[String(read)]??'read_other']))];
  return names.length<2?names[0]??'':names.slice(0,-1).join(', ')+' '+lines.read_and+' '+names.at(-1);
}

export class ScheduleNotices {
  /** `instruction` reads a schedule's saved instruction now, for its message after a press (ADR-0294). */
  constructor(readonly control:pg.Pool,readonly policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>,readonly call:RuntimeCall,readonly agent:Agent,
    readonly instruction:(profile:string,job:string)=>Promise<string|null>=async()=>null){}

  private async lines():Promise<Record<ScheduleNoticeText,string>> {
    return scheduleNoticeLines((await ownerPrompts(this.control))['schedules.notice_texts']);
  }
  private static id(profile:string,job:string){return digest('schedule-notice:'+profile+':'+job);}

  /**
   * The message's text from the schedule's fields: its name, how often and in which zone it runs, its next run and what
   * it does, its saved instruction (ADR-0294). One saved paused says so, and why when the reply that set it read outside
   * content (`reads`), when its message first announces it (`saved_paused`); `changed` names it as changed rather than new.
   */
  text(lines:Record<ScheduleNoticeText,string>,body:Record<string,unknown>):string {
    const zone=typeof body.timezone==='string'?body.timezone:null,when=line(body.schedule,120)??'',off=body.enabled===false,waiting=off&&body.saved_paused===true;
    const reads=Array.isArray(body.reads)?readsText(lines,body.reads):'';
    return [fillTemplate(body.changed===true?lines.set_changed:lines.set,{name:line(body.name,80)??lines.unnamed}),
      fillTemplate(lines.when,{when:when&&zone?`${when} (${zone})`:when||zone}),
      off?'':fillTemplate(lines.next,{next:ownerTime(body.next_run_at,zone??'UTC')??lines.no_next}),
      fillTemplate(lines.does,{prompt:instruction(body.prompt)}),
      waiting?reads?fillTemplate(lines.held,{reads}):lines.waiting:'',lines.note].filter(Boolean).join('\n');
  }

  /**
   * Once Nocheh recorded a new schedule a reply set by asking (POST /v1/schedules/turn/definition, ADR-0290): the
   * message in that chat, at most once by the schedule's id. Only a schedule in the owner's private chat or a member's
   * own gets one. A Telegram service that refuses its buttons gets the text alone; one that does not answer is not tried
   * again. The turn's post waits for it, so Hermes gives that post time for a guard pass and both tries.
   */
  async announce(input:unknown):Promise<{state:string}> {
    const body=object(input),scope=string(body.scope,64),profile=string(body.profile,64),job=string(body.job_id,128);
    const owner=ownerChat(this.policy()),member=!!owner&&scope!==owner&&memberAssistant(scope),target=telegramAddress(member?scope:owner);
    if(!owner||scope!==owner&&!member||!target)return {state:'skipped'};
    if(!PROFILE.test(profile))throw new HttpError(400,'invalid_schedule_identity');
    // A schedule's first message keeps its id; a later one, about a change saved paused, is its own message (ADR-0294).
    const lines=await this.lines(),text=this.text(lines,{...body,saved_paused:body.enabled===false}),
      id=body.changed===true?digest('schedule-notice:'+profile+':'+job+':'+string(body.version,128)):ScheduleNotices.id(profile,job);
    await this.control.query('UPDATE workflow_schedules SET notice_id=$2 WHERE id=$1',[scheduleKey(profile,job),id]);
    const notice={id,...target,text,send_class:'notice'};
    // A member's chat takes it only after nocheh-telegram's one ask (authorizeScheduleNotice), for each exact text it may
    // send: with its buttons, or without them when Telegram refuses them.
    if(member)await this.control.query(`INSERT INTO schedule_notice_grants(id,chat_id,text_digest) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET chat_id=$2,text_digest=$3,created_at=now()`,[id,scope,noticeDigest(text)]);
    // Pause, or Start for one saved paused, and Delete.
    const first=body.enabled===false?{text:points(lines.start,40),callback:'nks'+profile.slice(7)+job}:{text:points(lines.pause,40),callback:'nkp'+profile.slice(7)+job};
    const buttons=JOB.test(job)?[[first,{text:points(lines.delete,40),callback:'nkd'+profile.slice(7)+job}]]:null;
    try{return {state:String((await this.call('telegram.notice',buttons?{...notice,buttons}:notice,30000))?.state??'failed')};}
    catch(error) {
      if(!buttons||!(error instanceof HttpError)||error.code!=='telegram_rejected_request')return {state:'failed'};
      try{return {state:String((await this.call('telegram.notice',notice,30000))?.state??'failed')};}catch{return {state:'failed'};}
    }
  }

  /**
   * A press on the message, already checked to be the owner's own in their private chat, or a member's own in theirs
   * (`chat`): pause, start (resume) or delete that chat's schedule through the agent, as the Schedules page does. The
   * message then shows the answer under its text and loses its buttons. Nocheh grants that one change first, as the
   * presser's (ADR-0290). Returns the answer to the press.
   */
  async press(choice:ScheduleChoice,store:string,job:string,press:string,chat?:string):Promise<string> {
    const lines=await this.lines(),profile='nocheh-'+store,owner=chat??ownerChat(this.policy()),target=telegramAddress(owner);
    const manage=agentOperation(this.agent,'manageSchedules');
    let reply:string,text:string;
    try {
      // Only a schedule of the pressed chat that is still there; its message shows it as it is now.
      const listed=(await manage({operation:'list'})).schedules;
      const found=Array.isArray(listed)?listed.find((item:any)=>item?.profile===profile&&item?.id===job&&item?.scope===owner):undefined;
      if(!found)return lines.changed;
      // The owner, or the member whose own chat this is; a chat that is no longer a member's changes nothing.
      const person=chat===undefined?'owner':(await memberReads(this.control,chat,ownerChat(this.policy())))?.member;
      if(!person)return lines.changed;
      const operation=choice==='p'?'pause':choice==='s'?'resume':'delete',request='press-'+press.slice(0,64);
      await issueScheduleGrant(this.control,{profile,job_id:job,operation,person,request_id:request,scope:String(found.scope)});
      const result=await manage({operation,profile,job_id:job,request_id:request});
      const now=choice!=='d'&&result.schedule&&typeof result.schedule==='object'?result.schedule as Record<string,unknown>:found;
      text=this.text(lines,{...now,prompt:await this.instruction(profile,job).catch(()=>null)});
      reply=choice==='p'?lines.paused:choice==='s'?lines.started:lines.deleted;
    }catch(error){if(!(error instanceof HttpError)||error.status>=500&&error.code!=='agent_rejected')throw error;return lines.changed;}
    // The message shows the answer and loses its buttons; an edit that fails changes nothing else. The latest message
    // about the schedule is the one with buttons. It is a notice, the only kind a member's chat takes an edit of.
    const notice=(await this.control.query<{notice_id:string|null}>('SELECT notice_id FROM workflow_schedules WHERE id=$1',[scheduleKey(profile,job)])).rows[0]?.notice_id;
    if(target)await this.call('telegram.notice',{id:notice??ScheduleNotices.id(profile,job),...target,text:text+'\n\n'+points(reply,280),edit:true,send_class:'notice'},30000).catch(()=>{});
    return reply;
  }
}
