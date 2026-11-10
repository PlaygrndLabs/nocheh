import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {approvalLines,fillTemplate,lateMessages,ownerPrompts} from '../prompts.js';
import type {RuntimeCall} from '../runtime.js';

/** How long no new late message may be skipped before the owner hears about the ones so far. */
export const lateSettleMs=120000;
/** The longest a summary waits for the backlog to settle, so a steady stream of late messages still reaches the owner. */
export const lateWaitMs=600000;
/** Telegram's limit is 4096 UTF-16 units; the list stays well under it. */
const noticeLimit=4000,chatLines=20,nameLimit=64;

/** At most `limit` UTF-16 units, cut between characters so no emoji is split in half. */
export function clipText(text:string,limit:number):string {
  if(text.length<=limit)return text;
  let out='';
  for(const character of text){if(out.length+character.length>limit-1)break;out+=character;}
  return out+'…';
}

// Controls such as line breaks go, so each chat stays on its own line; format characters such as the
// Persian zero-width non-joiner stay, since titles are written with them.
export const chatTitle=(value:unknown):string|null=>{
  if(typeof value!=='string')return null;
  const name=value.replace(/\p{Cc}+/gu,' ').replace(/\s+/g,' ').trim();
  return name?clipText(name,nameLimit):null;
};

/**
 * One message to the owner's private chat about messages Nocheh got late and
 * saved without answering (ADR-0228). It waits until no new late message has
 * been skipped for a while, so the backlog Telegram delivers after Nocheh was
 * offline becomes one summary, but never longer than `lateWaitMs`. Each summary
 * has its own notice ID, which the runtime sends at most once.
 */
export class LateMessageNotices {
  constructor(readonly control:pg.Pool,readonly archive:pg.Pool,readonly call:RuntimeCall,readonly policy:()=>AssistantPolicy){}

  /** Send the summary that is due, if any. Returns how many late messages it covered. */
  async notify(now=Date.now()):Promise<number> {
    const owner=this.policy().owner_id;
    if(!owner)return 0;
    // A summary claimed earlier and not yet answered by the runtime is sent again with the same ID.
    let batch:string|undefined=(await this.control.query("SELECT late_notice FROM dispatches WHERE late_notice IS NOT NULL AND late_notice_state='sending' LIMIT 1")).rows[0]?.late_notice;
    if(!batch) {
      const unreported="state='suppressed' AND error_code='too_old' AND late_notice IS NULL";
      // Telegram is still delivering the backlog: wait for it to settle, but not for ever.
      const span=(await this.control.query(`SELECT min(updated_at) AS oldest,max(updated_at) AS newest FROM dispatches WHERE ${unreported}`)).rows[0];
      if(!span?.newest||now-span.newest.getTime()<lateSettleMs&&now-span.oldest.getTime()<lateWaitMs)return 0;
      // The whole backlog so far is one summary.
      const ids=(await this.control.query(`SELECT event_id FROM dispatches WHERE ${unreported}`)).rows.map(row=>row.event_id as string).sort();
      if(!ids.length)return 0;
      batch=digest('late-messages:'+canonical(ids));
      await this.control.query(`UPDATE dispatches SET late_notice=$1,late_notice_state='sending'
        WHERE event_id=ANY($2::text[]) AND late_notice IS NULL AND state='suppressed' AND error_code='too_old'`,[batch,ids]);
    }
    const ids=(await this.control.query('SELECT event_id FROM dispatches WHERE late_notice=$1',[batch])).rows.map(row=>row.event_id as string);
    if(!ids.length)return 0;
    const summary=await this.text(owner,ids);
    // Only chats Nocheh still serves are listed; nothing is sent when none is left, such as after the owner changed.
    if(!summary) {
      await this.control.query("UPDATE dispatches SET late_notice_state='skipped' WHERE late_notice=$1",[batch]);
      return 0;
    }
    const {text,count}=summary;
    let result:Record<string,unknown>;
    try{result=await this.call('telegram.notice',{id:batch,chat_id:owner,text},30000);}catch{return 0;}
    // Telegram not connected yet: try again on a later pass. An unclear send is never repeated.
    if(result.state==='not_started')return 0;
    await this.control.query('UPDATE dispatches SET late_notice_state=$2 WHERE late_notice=$1',[batch,result.state==='done'?'sent':'uncertain']);
    return count;
  }

  /** The owner's wording, with one "• chat: count" line per chat it still serves: the private chat first, then by count. */
  private async text(owner:string,ids:string[]):Promise<{text:string;count:number}|null> {
    const groups=new Set(this.policy().group_ids);
    const rows=(await this.archive.query(`SELECT scope,convert_from(payload,'UTF8')::jsonb#>>'{message,chat,title}' AS title
      FROM events WHERE id=ANY($1::text[]) ORDER BY received_at DESC`,[ids])).rows.filter(row=>row.scope===owner||groups.has(row.scope));
    if(!rows.length)return null;
    const chats=new Map<string,{count:number;title:string|null}>();
    for(const row of rows) {
      const chat=chats.get(row.scope)??{count:0,title:null};
      chat.count++;chat.title??=chatTitle(row.title);chats.set(row.scope,chat);
    }
    const prompts=await ownerPrompts(this.control),line=approvalLines(prompts['telegram.approval_texts']);
    const unnamed=[...chats].filter(([scope,chat])=>scope!==owner&&!chat.title).map(([scope])=>scope);
    if(unnamed.length) {
      const seen=(await this.control.query("SELECT chat_id,title FROM telegram_chat_observations WHERE state='available' AND chat_id=ANY($1::text[])",[unnamed])).rows;
      for(const row of seen)chats.get(row.chat_id)!.title??=chatTitle(row.title);
    }
    const capital=(value:string)=>value.charAt(0).toUpperCase()+value.slice(1);
    const ordered=[...chats].sort(([a,x],[b,y])=>Number(b===owner)-Number(a===owner)||y.count-x.count||a.localeCompare(b));
    const lines=ordered.slice(0,chatLines).map(([scope,chat])=>`• ${capital(scope===owner?line.private_chat:chat.title??line.unnamed_group)}: ${chat.count}`);
    const rest=ordered.slice(chatLines).reduce((sum,[,chat])=>sum+chat.count,0);
    if(rest)lines.push(`• …: ${rest}`);
    const minutes=this.policy().late_minutes;
    // The owner's wording carries the unit, so {minutes} is only the number and the whole text can be in any language.
    const values={chats:lines.join('\n'),minutes:minutes?String(minutes):null,count:String(rows.length)};
    // A saved wording that leaves nothing to send falls back to the built-in one.
    const text=fillTemplate(prompts['telegram.late_messages']??lateMessages,values)||fillTemplate(lateMessages,values);
    return {text:clipText(text,noticeLimit),count:rows.length};
  }
}
