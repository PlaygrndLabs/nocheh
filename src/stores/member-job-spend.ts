import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {cardName} from '../action-text.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {backgroundMemberPaused,backgroundMemberSpend,backgroundMemberTexts,fillTemplate,labeledLines,ownerPrompts} from '../prompts.js';

/**
 * What jobs members approved themselves spend in a UTC day, the owner's notice when they pass the notice mark, and the
 * pause of member jobs, by the owner's tap or by itself at the high mark (ADR-0251). A pause is a hold, never a
 * reroute: members still see their cards and press Approve, nothing is refused and no card goes to the owner; an
 * approved member job only waits to start until the pause ends. Jobs the owner asked for or approved never wait.
 */
export const memberJobSchema=`
-- Whether jobs members approved themselves wait to start, and which notices about their spend went out (ADR-0251).
-- Runtime state, not an owner setting: it is never exported, and neither it nor the notices move the settings' revision.
-- A pause by the owner holds until they resume; one made by itself at the high mark until 00:00 UTC. notice_id and
-- pause_id name the UTC day and mark each was made for, so each comes once a day per mark, and a pause the owner
-- resumed does not come back that day. shown is the last notice sent, which Pause and Resume edit.
CREATE TABLE IF NOT EXISTS member_job_pause (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 paused_by text CHECK(paused_by IN ('owner','auto')),paused_at timestamptz,paused_until timestamptz,
 notice_id text,notice_sent boolean NOT NULL DEFAULT false,pause_id text,pause_sent boolean NOT NULL DEFAULT false,shown jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((paused_by IS NULL)=(paused_at IS NULL)),CHECK(paused_until IS NULL OR paused_by='auto')
);
INSERT INTO member_job_pause(singleton) VALUES(true) ON CONFLICT DO NOTHING;
`;

/** Whole cents, rounded up, of a dollar amount, without float drift: 0.53 is 53 cents, 0.333 is 34. */
const centsUp=(value:number)=>Math.ceil(Math.round(value*1e6)/1e4);
/** A cap or mark in dollars as cards and notices show it: to the cent, rounded up, so it never reads as less than it is. */
export const cents=(value:number)=>'$'+(centsUp(value)/100).toFixed(2);
/** A member's job's cost cap: the owner's limit, or half again over its estimate when that is higher, both in whole
 *  cents, so a $0.50 limit gives a small job $0.50, not a whole dollar, and a job near the limit still has room to
 *  finish: at most $7.50 for a job a member may approve under a $5 limit (ADR-0251). */
export function memberCostLimit(limit:number,estimate:number|null):number {
  return Math.max(centsUp(limit),Math.ceil(centsUp(estimate??0)*3/2))/100;
}

/** Whether a job is one a member asked for and approved themselves. The owner's own jobs, and members' jobs the owner
 *  approved (in their private chat or by pressing Approve in the group), never count and never wait. */
export const memberDecided=(row:{requester?:string|null;decided_by?:string|null},owner:string|null|undefined)=>
  !!row.requester&&!!row.decided_by&&row.decided_by!==owner;
/** The same over a job row `j`, with the owner's ID as $1. */
const decidedSql='j.requester IS NOT NULL AND j.decided_by IS NOT NULL AND j.decided_by IS DISTINCT FROM $1';
/** SQL: whether member jobs are paused now. */
const activeSql="paused_by IS NOT NULL AND (paused_until IS NULL OR paused_until>now())";
/** SQL: the start of today, and of tomorrow, in UTC. */
const dayStart="(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
const nextDay="((date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')";
// At most this many members are named on a notice; the rest are summed in one line.
const NAMED=10;
/** At most `size` UTF-16 units of a text, as Telegram counts, never cut inside a character; with the line Pause or Resume
 *  adds, a notice stays below Telegram's 4,096. */
const cut=(text:string,size:number)=>{const part=text.slice(0,size);return /[\ud800-\udbff]$/.test(part)?part.slice(0,-1):part;};
/** The Pause and Resume buttons under a notice about members' job spend; only the owner's press in their private chat counts. */
export const memberPause='njp',memberResume='nju';

export type MemberPause={by:'owner'|'auto';since:string;until:string|null};
type Spender={requester:string;scope:string;cost:number;source:any};
type Button={text:string;callback:string};

export class MemberJobSpend {
  constructor(readonly control:pg.Pool,readonly archive:pg.Pool,readonly owner:()=>string|null,readonly call:RuntimeCall){}
  /** The pause that holds now, or null. */
  async pause():Promise<MemberPause|null> {
    const row=(await this.control.query(`SELECT paused_by,paused_at,paused_until FROM member_job_pause WHERE singleton AND ${activeSql}`)).rows[0];
    return row?{by:row.paused_by,since:new Date(row.paused_at).toISOString(),until:row.paused_until?new Date(row.paused_until).toISOString():null}:null;
  }
  /** Whether a job waits to start: one a member approved, while member jobs are paused. */
  async holds(row:{requester?:string|null;decided_by?:string|null}):Promise<boolean> {
    return memberDecided(row,this.owner())&&!!await this.pause();
  }
  /** What jobs members approved themselves spent today (UTC), by each member in each group: the cost of their runs that
   *  started today, so a run that crosses midnight counts toward the day it started. */
  async today(owner:string):Promise<{day:string;spent:number;spenders:Spender[]}> {
    const day=String((await this.control.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0].day);
    const spenders=(await this.control.query(`SELECT j.requester,j.scope,sum(r.cost_usd) AS cost,(array_agg(j.source_reference ORDER BY j.created_at DESC))[1] AS source
      FROM background_runs r JOIN background_jobs j ON j.id=r.job_id WHERE ${decidedSql} AND r.created_at>=${dayStart}
      GROUP BY j.requester,j.scope ORDER BY sum(r.cost_usd) DESC,j.requester,j.scope`,[owner])).rows
      .map(row=>({requester:String(row.requester),scope:String(row.scope),cost:Number(row.cost),source:row.source}));
    return {day,spent:spenders.reduce((sum,row)=>sum+row.cost,0),spenders};
  }
  /** The marks the owner set: the notice mark and the high mark, in dollars a UTC day. */
  private async marks():Promise<{notice:number;high:number}> {
    const row=(await this.control.query('SELECT member_notice_usd,member_pause_usd FROM background_settings WHERE singleton')).rows[0];
    return {notice:Number(row.member_notice_usd),high:Number(row.member_pause_usd)};
  }
  /** Today's spend, the marks and the pause, for the dashboard. */
  async summary(owner:string|null) {
    const {notice,high}=await this.marks(),spend=owner?await this.today(owner):{day:'',spent:0,spenders:[]};
    return {day:spend.day,spent_usd:Math.round(spend.spent*100)/100,notice_usd:notice,pause_usd:high,paused:await this.pause()};
  }
  /** Look at today's spend on a member job's tick, held ones' too: the notice at the notice mark, the pause at the high
   *  mark. Never throws, so it never fails a job's tick; a check that fails, or a notice that did not go, is made again on
   *  the next one. */
  async check():Promise<void> {
    try{await this.checkNow();}catch{/* The next tick of a member job, held or running, checks again. */}
  }
  private async checkNow():Promise<void> {
    const owner=this.owner();if(!owner)return;
    const {notice,high}=await this.marks(),spend=await this.today(owner);
    // A mark the owner changes makes a new id, so the new mark gets its own notice and pause that day.
    const noticeId=digest(canonical(['member-job-spend-v1',spend.day,String(notice)])),pauseId=digest(canonical(['member-job-pause-v1',spend.day,String(high)]));
    if(spend.spent>=high)await this.pauseByItself(pauseId,noticeId);
    else if(spend.spent>=notice)await this.control.query('UPDATE member_job_pause SET notice_id=$1,notice_sent=false,updated_at=now() WHERE singleton AND notice_id IS DISTINCT FROM $1',[noticeId]);
    await this.tell(owner,spend,{notice,high,noticeId,pauseId});
  }
  /** The pause at the high mark, once a day per mark, even when two jobs' ticks see it at once. A pause the owner made
   *  already holds and gets no second notice; neither does the notice mark, which this pause's notice covers. */
  private async pauseByItself(pauseId:string,noticeId:string):Promise<void> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const row=(await db.query(`SELECT pause_id,${activeSql} AS active FROM member_job_pause WHERE singleton FOR UPDATE`)).rows[0];
      if(row&&row.pause_id!==pauseId)await db.query(`UPDATE member_job_pause SET pause_id=$1,pause_sent=$2,notice_id=$3,notice_sent=true,
        paused_by=CASE WHEN $2 THEN paused_by ELSE 'auto' END,paused_at=CASE WHEN $2 THEN paused_at ELSE now() END,
        paused_until=CASE WHEN $2 THEN paused_until ELSE ${nextDay} END,updated_at=now() WHERE singleton`,[pauseId,!!row.active,noticeId]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Send the notice that is due and not sent yet: the pause's while it still holds, else the notice mark's. */
  private async tell(owner:string,spend:{spent:number;spenders:Spender[]},marks:{notice:number;high:number;noticeId:string;pauseId:string}):Promise<void> {
    const row=(await this.control.query(`SELECT *,${activeSql} AS active FROM member_job_pause WHERE singleton`)).rows[0];
    if(!row)return;
    const prompts=await ownerPrompts(this.control),lines=labeledLines(backgroundMemberTexts,prompts['background.member_texts']);
    if(row.pause_id===marks.pauseId&&!row.pause_sent) {
      // Resumed before it could be told: nothing holds any more, so nothing is said.
      if(!(row.active&&row.paused_by==='auto')){await this.control.query('UPDATE member_job_pause SET pause_sent=true WHERE singleton AND pause_id=$1',[marks.pauseId]);return;}
      const text=cut(fillTemplate(prompts['background.member_paused']??backgroundMemberPaused,{spent:cents(spend.spent),mark:cents(marks.high),
        members:await this.members(spend.spenders,lines)}),3800);
      if(await this.send(owner,marks.pauseId,text,this.button(true,lines)))
        await this.control.query('UPDATE member_job_pause SET pause_sent=true,shown=$2,updated_at=now() WHERE singleton AND pause_id=$1',[marks.pauseId,{id:marks.pauseId,text}]);
      return;
    }
    if(row.notice_id!==marks.noticeId||row.notice_sent)return;
    const text=cut(fillTemplate(prompts['background.member_spend']??backgroundMemberSpend,{spent:cents(spend.spent),mark:cents(marks.notice),pause_mark:cents(marks.high),
      members:await this.members(spend.spenders,lines)}),3800);
    if(await this.send(owner,marks.noticeId,text,this.button(!!row.active,lines)))
      await this.control.query('UPDATE member_job_pause SET notice_sent=true,shown=$2,updated_at=now() WHERE singleton AND notice_id=$1',[marks.noticeId,{id:marks.noticeId,text}]);
  }
  /** Pause while member jobs go on, Resume while they are paused; a label the owner made longer is cut to Telegram's 40
   *  characters, never inside one. */
  private button(paused:boolean,lines:Record<string,string>):Button {
    return paused?{text:cut(lines.resume!,40),callback:memberResume}:{text:cut(lines.pause!,40),callback:memberPause};
  }
  /** One line for each member in each group, by what they spent, named from the message that asked for their latest job. */
  private async members(spenders:Spender[],lines:Record<string,string>):Promise<string> {
    const named=[];
    for(const row of spenders.slice(0,NAMED)) {
      let message:any=null;
      if(row.source?.store==='archive')try {
        const event=(await this.archive.query('SELECT payload FROM events WHERE id=$1',[row.source.id])).rows[0];
        const payload=event?JSON.parse(event.payload.toString()):null;message=payload?.message??payload?.edited_message??null;
      }catch{message=null;}
      const from=String(message?.from?.id??'')===row.requester?message.from:null;
      const name=cardName([from?.first_name,from?.last_name].filter(part=>typeof part==='string').join(' '))??cardName(from?.username?'@'+from.username:null)??
        fillTemplate(lines.unnamed_member!,{id:row.requester});
      const title=String(message?.chat?.id??'')===row.scope?cardName(message.chat.title):null;
      named.push(fillTemplate(lines.member!,{name,group:title?`“${title}”`:lines.unnamed_group!,spent:cents(row.cost)}));
    }
    const rest=spenders.slice(NAMED);
    if(rest.length)named.push(fillTemplate(lines.more!,{count:String(rest.length),spent:cents(rest.reduce((sum,row)=>sum+row.cost,0))}));
    return named.join('\n');
  }
  /** A notice in the owner's private chat, sent at most once by its id. A Telegram service older than these buttons
   *  refuses them before it sends anything, so the text then goes alone. True once it went, or may have. */
  private async send(owner:string,id:string,text:string,button:Button):Promise<boolean> {
    const notice={id,chat_id:owner,text};let result;
    try{result=await this.call('telegram.notice',{...notice,buttons:[button]},30000);}
    catch(error) {
      if(!(error instanceof HttpError)||error.code!=='telegram_rejected_request')return false;
      try{result=await this.call('telegram.notice',notice,30000);}catch{return false;}
    }
    return result?.state==='done'||result?.state==='ambiguous';
  }
  /** Pause member jobs until the owner resumes them, or resume them: from a notice's button or the dashboard. The last
   *  notice then says so and offers the other button. A pause the owner makes holds past midnight. */
  async setPaused(paused:boolean):Promise<MemberPause|null> {
    await this.control.query(paused?
      `UPDATE member_job_pause SET paused_by='owner',paused_at=CASE WHEN paused_by='owner' AND paused_until IS NULL THEN paused_at ELSE now() END,paused_until=NULL,updated_at=now() WHERE singleton`:
      'UPDATE member_job_pause SET paused_by=NULL,paused_at=NULL,paused_until=NULL,updated_at=now() WHERE singleton');
    const owner=this.owner(),shown=(await this.control.query('SELECT shown FROM member_job_pause WHERE singleton')).rows[0]?.shown;
    if(owner&&shown?.id&&typeof shown.text==='string') {
      const lines=labeledLines(backgroundMemberTexts,(await ownerPrompts(this.control))['background.member_texts']);
      const edit={id:shown.id,chat_id:owner,text:shown.text+'\n\n'+cut(paused?lines.paused!:lines.resumed!,200),edit:true};
      try{await this.call('telegram.notice',{...edit,buttons:[this.button(paused,lines)]},30000);}
      catch(error){if(error instanceof HttpError&&error.code==='telegram_rejected_request')await this.call('telegram.notice',edit,30000).catch(()=>{});}
    }
    return this.pause();
  }
}
