import type pg from 'pg';
import type {Reader} from '../access.js';
import {digest} from '../archive.js';
import {cardName} from '../action-text.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {fillLine,labelName,quotedName,type PlaceWords} from '../chat-labels.js';
import {chatShortId} from '../chats.js';
import {telegramAddress} from '../frontdoor/telegram.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {approvalLines,chatAddLines,ownerPrompts,type ChatAddText} from '../prompts.js';
import {currentChats,type ChatRepository} from './chats.js';
import {OwnerCommands} from './owner-commands.js';
import {writeAssignment,writeProject} from './projects.js';

/*
 * What is left to do once someone adds Nocheh to a group or removes it (ADR-0253). Capture writes one content-free
 * chat_state_events row per add or removal (ChatRepository.adopt); this stage, run by the storage worker every few
 * seconds, does the rest outside any capture: it leaves a group someone else added it to and may tell the owner, gives a
 * group the owner added its own project with a card in the owner's private chat, and tells the owner when Nocheh was
 * removed from a group it was on in. Every Telegram call is made at most once by its id, and every owner command once by
 * its operation id, so a row tried again after a crash or a lost answer never leaves, sends or makes a project twice.
 */

/** The card's buttons: `ng`, the choice (0, 1 or 2 moves the group to that offered project, x takes it out of projects,
 *  o turns Nocheh off there) and the first 32 hex of the add's event id. */
export const chatAddButton=/^ng([012xo])([a-f0-9]{32})$/;
export type ChatAddChoice='0'|'1'|'2'|'x'|'o';
export const chatAddData=(choice:ChatAddChoice,event:string)=>'ng'+choice+event.slice(0,32);
/** The wait before a call that did not go is tried again, by how many tries failed before: 1, 2, 4… minutes, at most an hour. */
export const retryMinutes=(attempts:number)=>Math.min(2**Math.max(0,attempts),60);
/** Rows claimed at once, how long a claim holds, how many tries a notice gets, and the caps on notes about leaving a group
 *  in 24 hours: one per group, ten in all (a stranger making new groups cannot flood the owner). A removal's line is
 *  outside them. */
const BATCH=20,LEASE="interval '5 minutes'",NOTICE_TRIES=10,GROUP_NOTES=1,ALL_NOTES=10;
/** The tries after which a leave Telegram still answers with the group's upgrade ends as could_not_leave: six waits of 1,
 *  2, 4… 32 minutes, over an hour. */
const MIGRATED_TRIES=6;
/** How many projects a card offers to move the group to. */
const OFFERED=3;
/** The owner's authority, for the commands the card makes and its buttons run. */
const asOwner:Reader={admin:true,scope:null};

type Button={text:string;callback:string};
export type ChatAddRow={event_id:string;chat_id:string;kind:'added'|'removed';role:'owner'|'other'|'anonymous'|'unknown'|null;account_id:string|null;
  member:boolean;action:'card'|'leave'|'tell'|'none';outcome:string|null;attempts:number;project_id:string|null;offered:string[];notice:string;created_at:Date};
type Outcome='carded'|'answered'|'left'|'could_not_leave'|'told'|'superseded';

/** The note after a leave: only for an add by a member (their account is linked to one, step 3), or by someone who hid
 *  who they were. Strangers get the content-free record alone. */
export function noteLine(row:Pick<ChatAddRow,'role'|'member'>,outcome:string|null):'left_member'|'left_anonymous'|'could_not_leave'|null {
  if(!row.member&&row.role!=='anonymous')return null;
  if(outcome==='left')return row.role==='anonymous'?'left_anonymous':'left_member';
  return outcome==='could_not_leave'?'could_not_leave':null;
}
/** At most `size` code points, as Telegram counts a button's label and a press's answer. */
const points=(text:string,size:number)=>Array.from(text).slice(0,size).join('');
/** At most `size` UTF-16 units, as Telegram counts a message, never cut inside a character. */
const units=(text:string,size:number)=>{const part=text.slice(0,size);return /[\ud800-\udbff]$/.test(part)?part.slice(0,-1):part;};
/** The card's own project, once no group is in it, is archived, so it does not linger in the owner's list. Returns
 *  whether it was. */
async function archiveEmpty(db:pg.PoolClient,project:string):Promise<boolean> {
  const made=(await db.query('SELECT name,description,state,revision FROM projects WHERE id=$1 FOR UPDATE',[project])).rows[0];
  if(made?.state!=='active'||(await db.query(`SELECT 1 FROM project_assignments WHERE project_id=$1 AND mode='assigned'`,[project])).rowCount)return false;
  await writeProject(db,{id:project,name:made.name,description:made.description,state:'archived',expected_revision:Number(made.revision)});
  return true;
}
/** The card's buttons: one row moving the group to each offered project still there (by its index on the row), then No
 *  project and Turn off. Labels are cut to Telegram's 40 characters. */
export function cardRows(lines:Record<ChatAddText,string>,event:string,offered:readonly {index:number;name:string|null}[]):Button[][] {
  const moves=offered.slice(0,OFFERED).map(({index,name})=>({text:points(fillLine(lines.move,{project:name??lines.unnamed_project}),40),
    callback:chatAddData(String(index) as ChatAddChoice,event)}));
  const last=[{text:points(lines.no_project,40),callback:chatAddData('x',event)},{text:points(lines.turn_off,40),callback:chatAddData('o',event)}];
  return moves.length?[moves,last]:[last];
}
/** A group as a notice names it: its title someone chose, quoted, with the short id the dashboard's chat list shows, in the
 *  owner's words for it (ADR-0254); a group with no name is "a Telegram group" with its short id. */
export function groupName(words:Pick<PlaceWords,'name_id'|'unnamed_group'>,chat:string,title:unknown):string {
  const name=labelName(title);
  return fillLine(words.name_id,{name:name===null?words.unnamed_group:quotedName(name),id:chatShortId(chat)});
}

export class ChatAdds {
  private readonly commands:OwnerCommands;
  /** `policy` names the owner's private chat, where notes and cards go; `chats` turns a group off from the card. */
  constructor(readonly control:pg.Pool,readonly policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>,readonly call:RuntimeCall,readonly chats:ChatRepository){
    this.commands=new OwnerCommands(control);
  }

  /** Does what is due: up to 20 rows, claimed in one short statement so another run skips them while this one works.
   *  Returns how many it claimed; a full batch means more may be due. */
  async settle():Promise<number> {
    const rows=(await this.control.query(`UPDATE chat_state_events SET due_at=now()+${LEASE} WHERE event_id IN (SELECT event_id FROM chat_state_events
      WHERE state='waiting' AND due_at<=now() ORDER BY due_at,event_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING *`)).rows as ChatAddRow[];
    rows.sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||a.event_id.localeCompare(b.event_id));
    for(const row of rows) {
      // A row that fails here is claimed again once its claim runs out.
      try{await this.one(row);}catch(error){console.warn(JSON.stringify({event:'chat_add_failed',action:row.action,code:(error as {code?:string})?.code??'unknown'}));}
    }
    return rows.length;
  }

  private async one(row:ChatAddRow):Promise<void> {
    if(row.action==='leave')return this.leave(row);
    if(row.action==='card')return this.card(row);
    if(row.action==='tell')return this.tell(row);
    await this.finish(row,{});
  }

  /** The group as it is now: its state, the add that last served or pended it, its title and its Telegram id now. */
  private async chat(id:string):Promise<{state:string;add_event:string|null;title:string|null;external:string|null}|null> {
    const row=(await this.control.query(`SELECT c.state,c.add_event,c.title,i.external_id FROM chats c LEFT JOIN chat_ids i ON i.chat_id=c.id AND i.state='current'
      WHERE c.id=$1`,[id])).rows[0];
    return row?{state:row.state,add_event:row.add_event,title:row.title,external:row.external_id}:null;
  }
  private async lines() {
    const prompts=await ownerPrompts(this.control);
    return {lines:chatAddLines(prompts['telegram.chat_adds']),words:approvalLines(prompts['telegram.approval_texts'])};
  }
  private async finish(row:ChatAddRow,values:{outcome?:Outcome;notice?:'sent'|'capped'|'failed'}):Promise<void> {
    await this.control.query(`UPDATE chat_state_events SET state='done',outcome=coalesce($2,outcome),notice=coalesce($3,notice),updated_at=now()
      WHERE event_id=$1 AND state='waiting'`,[row.event_id,values.outcome??null,values.notice??null]);
  }
  /** Tried again later: a leave Telegram did not answer, or a notice that did not go; a notice that failed ten times is
   *  given up. */
  private async later(row:ChatAddRow,notice=false):Promise<void> {
    if(notice&&row.attempts+1>=NOTICE_TRIES){await this.finish(row,{notice:'failed'});return;}
    await this.control.query(`UPDATE chat_state_events SET attempts=attempts+1,due_at=now()+$2::int*interval '1 minute',updated_at=now()
      WHERE event_id=$1 AND state='waiting'`,[row.event_id,retryMinutes(row.attempts)]);
  }
  /** What the row has done so far, kept before a notice is sent, so a notice tried again never redoes it. */
  private async keep(row:ChatAddRow,values:{outcome:Outcome;project_id?:string;offered?:string[]}):Promise<void> {
    await this.control.query(`UPDATE chat_state_events SET outcome=$2,project_id=coalesce($3,project_id),offered=coalesce($4,offered),attempts=0,updated_at=now()
      WHERE event_id=$1 AND state='waiting'`,[row.event_id,values.outcome,values.project_id??null,values.offered??null]);
    Object.assign(row,{outcome:values.outcome,attempts:0},values.project_id?{project_id:values.project_id}:{},values.offered?{offered:values.offered}:{});
  }

  /**
   * Leave a group someone else added Nocheh to, 30 s after the add (so an upgrade's two halves fold first): only while the
   * group is still pending from this very add. The owner turning it on or off meanwhile, or adding it again, supersedes the
   * leave. Telegram leaving, or saying Nocheh is gone already, makes it left; refusing makes it could_not_leave, which the
   * owner can still turn on or off, and so does Telegram still saying the group was upgraded after over an hour of tries.
   * Then the note, for a person the owner allowed or a hidden adder.
   */
  private async leave(row:ChatAddRow):Promise<void> {
    if(!row.outcome) {
      const chat=await this.chat(row.chat_id);
      if(!chat||chat.add_event!==row.event_id||!['pending','left','could_not_leave'].includes(chat.state)){await this.finish(row,{outcome:'superseded'});return;}
      let outcome:Outcome;
      // Left or refused already: an earlier try got this far, or Telegram told Nocheh it left before that try's answer came.
      if(chat.state!=='pending')outcome=chat.state as Outcome;
      else {
        if(!chat.external){await this.later(row);return;}
        let result:Record<string,unknown>;
        try{result=await this.call('telegram.leave',{id:row.event_id,chat_id:chat.external},30000);}
        catch{await this.later(row);return;}
        if(result.state==='done')outcome='left';else if(result.state==='failed')outcome='could_not_leave';
        // Still the old basic group's id after over an hour: its new id never reached storage (the upgrade's messages were
        // lost, or the two chats stayed apart), so the dead id would be tried forever. It ends as a refusal does.
        else if(result.error_code==='telegram_chat_migrated'&&row.attempts>=MIGRATED_TRIES)outcome='could_not_leave';
        else{await this.later(row);return;}
        await this.chats.leaveSettled(row.chat_id,row.event_id,outcome);
      }
      await this.keep(row,{outcome});
    }
    const line=noteLine(row,row.outcome);
    if(!line){await this.finish(row,{});return;}
    const {lines,words}=await this.lines(),title=(await this.chat(row.chat_id))?.title;
    const name=line==='left_anonymous'||row.role==='anonymous'?lines.someone:await this.person(row.account_id,lines.someone);
    await this.note(row,'chat-add-note:',fillLine(lines[line],{name,group:groupName(words,row.chat_id,title)}));
  }
  /** The bot's last check before it leaves (POST /internal/chats/leave): whether the group whose Telegram id is now
   *  `external` is still pending from the add `event`. One the owner turned on or off, or that was added again, while the
   *  leave waited behind other sends is not left. */
  async leaveStands(event:string,external:string):Promise<boolean> {
    return !!(await this.control.query(`SELECT 1 FROM chats c JOIN chat_ids i ON i.chat_id=c.id AND i.state='current'
      WHERE c.state='pending' AND c.add_event=$1 AND i.external_id=$2`,[event,external])).rowCount;
  }

  /**
   * The owner added Nocheh, so the group is on: 30 s later it gets its own project, named after it, in one owner command,
   * unless the group already has a project answer (a re-add keeps its project) or the owner turned it off or added it
   * again meanwhile. The card then says so in the owner's private chat, offering the three projects updated last, No
   * project and Turn off.
   */
  private async card(row:ChatAddRow):Promise<void> {
    if(!row.outcome) {
      const chat=await this.chat(row.chat_id);
      if(!chat||chat.state!=='active'||chat.add_event!==row.event_id){await this.finish(row,{outcome:'superseded'});return;}
      // A project answer of the group's own, but the one an earlier try of this very row made (its command's receipt says so).
      const project=digest('project:chat-add-project:'+row.event_id);
      if((await this.control.query('SELECT 1 FROM project_assignments WHERE space_id=$1 AND project_id IS DISTINCT FROM $2',[row.chat_id,project])).rowCount){
        await this.finish(row,{outcome:'answered'});return;}
      // The assignment checks the group against this process's chat directory: a group recorded a moment ago is in it.
      await currentChats();
      const made=await this.commands.run(asOwner,'chat-add-project:'+row.event_id,{kind:'chat_add_project',event_id:row.event_id,chat_id:row.chat_id},async db=>{
        const now=(await db.query('SELECT state,add_event,title FROM chats WHERE id=$1 FOR UPDATE',[row.chat_id])).rows[0];
        if(!now||now.state!=='active'||now.add_event!==row.event_id)return {outcome:'superseded' as Outcome,project_id:null};
        if((await db.query('SELECT 1 FROM project_assignments WHERE space_id=$1 FOR UPDATE',[row.chat_id])).rowCount)return {outcome:'answered' as Outcome,project_id:null};
        await writeProject(db,{id:project,name:cardName(now.title,200)??'Group',description:'',state:'active',expected_revision:0});
        await writeAssignment(db,{space_id:row.chat_id,project_id:project,mode:'assigned',expected_revision:0});
        return {outcome:'carded' as Outcome,project_id:project};
      // A new project holding only this group changes no one's reach, so it moves no guard epoch: a reply already running
      // in the group still sends on its first try (step 3). A Move to press keeps the epoch move.
      },{epoch:false});
      if(made.outcome!=='carded'||!made.project_id){await this.finish(row,{outcome:made.outcome});return;}
      const offered=(await this.control.query(`SELECT id FROM projects WHERE state='active' AND id<>$1 ORDER BY updated_at DESC,id LIMIT ${OFFERED}`,[made.project_id])).rows.map(item=>item.id as string);
      await this.keep(row,{outcome:'carded',project_id:made.project_id,offered});
    } else {
      // A card tried again after its send did not go says only what is still true: the group is on from this very add and
      // in the card's project. Turned off, removed, added again or moved meanwhile, the row ends with no card. It stays
      // 'carded', so a card a lost answer did deliver still answers presses on the group as it is now. The card's project,
      // left with no group, is archived as a press archives it.
      const now=(await this.control.query(`SELECT c.state,c.add_event,a.mode,a.project_id FROM chats c LEFT JOIN project_assignments a ON a.space_id=c.id
        WHERE c.id=$1`,[row.chat_id])).rows[0];
      if(!now||now.state!=='active'||now.add_event!==row.event_id||now.mode!=='assigned'||now.project_id!==row.project_id) {
        if(row.project_id&&(await this.control.query(`SELECT 1 FROM projects p WHERE p.id=$1 AND p.state='active'
            AND NOT EXISTS(SELECT 1 FROM project_assignments a WHERE a.project_id=p.id AND a.mode='assigned')`,[row.project_id])).rowCount)
          await this.commands.run(asOwner,'chat-add-archive:'+row.event_id,{kind:'chat_add_archive',event_id:row.event_id,project_id:row.project_id},
            // Archiving a project with no group in it takes nothing from any chat (ADR-0289).
            async db=>({project_id:row.project_id,archived:await archiveEmpty(db,row.project_id!)}),{notes:'all'});
        await this.finish(row,{});return;
      }
    }
    const target=this.owner();if(!target){await this.finish(row,{});return;}
    const {lines,words}=await this.lines(),{text}=await this.cardText(row,lines,words);
    // The offered projects still there keep their place on the row, so a press names the one it showed.
    const names=new Map((await this.control.query(`SELECT id,name FROM projects WHERE id=ANY($1::text[]) AND state='active'`,[row.offered])).rows.map(item=>[item.id as string,item.name as string]));
    const offered=row.offered.flatMap((id,index)=>names.has(id)?[{index,name:labelName(names.get(id),32)}]:[]);
    if(await this.send(digest('chat-add-card:'+row.event_id),text,cardRows(lines,row.event_id,offered)))await this.finish(row,{notice:'sent'});
    else await this.later(row,true);
  }
  /** The card's text: the group and the project the card made, as they are named now. */
  private async cardText(row:ChatAddRow,lines:Record<ChatAddText,string>,words:Pick<PlaceWords,'name_id'|'unnamed_group'>) {
    const found=(await this.control.query(`SELECT (SELECT title FROM chats WHERE id=$1) AS title,(SELECT name FROM projects WHERE id=$2) AS project`,[row.chat_id,row.project_id])).rows[0];
    const project=labelName(found?.project),group=groupName(words,row.chat_id,found?.title);
    return {group,text:units(fillLine(lines.card,{group,project:project===null?lines.unnamed_project:quotedName(project)}),3800)};
  }

  /** Nocheh was removed from a group it was on in: one line to the owner, outside the note caps. Only a group the owner
   *  had on gets one, so these cannot flood the owner, and strangers' adds cannot use up a cap to hide one. */
  private async tell(row:ChatAddRow):Promise<void> {
    if(!row.outcome)await this.keep(row,{outcome:'told'});
    const {lines,words}=await this.lines(),title=(await this.chat(row.chat_id))?.title;
    await this.note(row,'chat-add-tell:',fillLine(lines.removed,{group:groupName(words,row.chat_id,title)}));
  }

  /** A note to the owner. One about leaving a group goes unless a cap is reached, counting only such notes sent: one per
   *  group, and ten in all, in 24 hours. A removal's line always goes, once. No owner chat, no note. */
  private async note(row:ChatAddRow,kind:string,text:string):Promise<void> {
    if(!this.owner()){await this.finish(row,{});return;}
    if(row.action==='leave') {
      const sent=(await this.control.query(`SELECT count(*) FILTER (WHERE chat_id=$1)::int AS here,count(*)::int AS everywhere
        FROM chat_state_events WHERE notice='sent' AND action='leave' AND event_id<>$2 AND updated_at>now()-interval '24 hours'`,[row.chat_id,row.event_id])).rows[0];
      if(sent.here>=GROUP_NOTES||sent.everywhere>=ALL_NOTES){await this.finish(row,{notice:'capped'});return;}
    }
    if(await this.send(digest(kind+row.event_id),units(text,3800)))await this.finish(row,{notice:'sent'});
    else await this.later(row,true);
  }
  /** A person as a note names them: the name Telegram last showed, else their @username, quoted; else `fallback`. */
  private async person(account:string|null,fallback:string):Promise<string> {
    const row=account?(await this.control.query('SELECT display_name,username FROM chat_accounts WHERE id=$1',[account])).rows[0]:null;
    const name=labelName(row?.display_name)??(row?.username?labelName('@'+row.username):null);
    return name===null?fallback:quotedName(name);
  }
  private owner() {return telegramAddress(ownerChat(this.policy()));}
  /** A notice in the owner's private chat, at most once by its id. A Telegram service that refuses its buttons before it
   *  sends anything gets the text alone. True once it went, or may have. The card, a note and a removal line are each
   *  Nocheh's own notice, kept but never learned (ADR-0256); the card's edit after a press is a card update. */
  private async send(id:string,text:string,buttons?:Button[][]):Promise<boolean> {
    const target=this.owner();if(!target)return false;
    const notice={id,...target,text,send_class:'notice'};let result;
    try{result=await this.call('telegram.notice',buttons?{...notice,buttons}:notice,30000);}
    catch(error) {
      if(!buttons||!(error instanceof HttpError)||error.code!=='telegram_rejected_request')return false;
      try{result=await this.call('telegram.notice',notice,30000);}catch{return false;}
    }
    return result?.state==='done'||result?.state==='ambiguous';
  }

  /**
   * A press on the card (`choice` and the first 32 hex of the add's event id), already checked to be the owner's own in
   * their private chat: move the group to an offered project or out of projects, in one owner command that also archives
   * the card's own project once no group is in it, or turn Nocheh off there. The card then shows the answer under its text
   * and loses its buttons. Returns the answer to the press.
   * Each press is its own owner command, named by `press`, the press's own archived event: the same press tried again
   * gets its receipt, and a later press runs again on the group as it is now, since a card can keep its buttons (a send
   * whose answer was lost, or an edit that failed).
   */
  async press(choice:ChatAddChoice,event:string,press:string):Promise<string> {
    const {lines,words}=await this.lines();
    const row=(await this.control.query(`SELECT * FROM chat_state_events WHERE left(event_id,32)=$1 AND action='card' AND outcome='carded' AND project_id IS NOT NULL`,
      [event])).rows[0] as ChatAddRow|undefined;
    if(!row)return lines.changed;
    const {group,text}=await this.cardText(row,lines,words);
    const operation='chat-card:'+press;let reply:string;
    try {
      if(choice==='o') {
        await this.chats.setState(asOwner,{chat_id:row.chat_id,state:'off',operation_id:operation});
        reply=fillLine(lines.turned_off,{group});
      } else {
        const project=choice==='x'?null:row.offered[Number(choice)];
        if(project===undefined)return lines.changed;
        await currentChats();
        await this.commands.run(asOwner,operation,{kind:'chat_card',event_id:row.event_id,choice,chat_id:row.chat_id,project_id:project},async db=>{
          const own=(await db.query('SELECT revision FROM project_assignments WHERE space_id=$1',[row.chat_id])).rows[0];
          await writeAssignment(db,{space_id:row.chat_id,project_id:project,mode:project?'assigned':'none',expected_revision:Number(own?.revision??0)});
          await archiveEmpty(db,row.project_id!);
          return {chat_id:row.chat_id,project_id:project};
        },{notes:'owner'});
        const name=project?labelName((await this.control.query('SELECT name FROM projects WHERE id=$1',[project])).rows[0]?.name):null;
        reply=project?fillLine(lines.moved,{group,project:name===null?lines.unnamed_project:quotedName(name)}):fillLine(lines.unassigned,{group});
      }
    }catch(error){if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;return lines.changed;}
    // The card shows the answer and loses its buttons; an edit that fails changes nothing else.
    const target=this.owner();
    if(target)await this.call('telegram.notice',{id:digest('chat-add-card:'+row.event_id),...target,text:units(text,3800)+'\n\n'+units(reply,280),edit:true},30000).catch(()=>{});
    return reply;
  }
}
