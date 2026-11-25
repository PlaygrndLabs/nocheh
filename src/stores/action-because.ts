import type pg from 'pg';
import {accountPeopleNames} from './entities.js';

/*
 * "Because you said" (ADR-0294): why an action ran, named from the records Nocheh already keeps. The first time Nocheh
 * allowed it (its security event's grant) says which kind of authority it was; the asking message says whose words they
 * were. Code writes every line from these fields; no model does.
 */

/** Why one action ran or may run, in the owner's terms. */
export type Because=
  /** Someone's own message asked for it and that was enough: the owner's "Do what I ask", a same-group post, a link they gave. */
  |{kind:'said';who:'owner'|'member';name:string|null;words:string|null}
  /** The owner, or a member for their own post, approved its card. */
  |{kind:'approved'}
  /** A chat rule or an exact allowance the owner gave on an earlier card. */
  |{kind:'rule';what:'site'|'file'|'command'|'tool'|'exact';target:string|null;chat:string|null;until:string|null}
  /** The owner's own setting for a connection: Gmail and GitHub lookups read, Notion as its setting says. */
  |{kind:'setting';connection:'gmail'|'github'|'notion'}
  /** A member's group permission for web pages and outside tools. */
  |{kind:'group_tools';who:'owner'|'member';name:string|null}
  /** A schedule's run, with the words that set it when Nocheh has them. */
  |{kind:'schedule';name:string|null;words:string|null}
  /** A background job the owner or a member approved. */
  |{kind:'job';title:string|null};

/** One action as its row says: its id, the message or run that asked, the member who asked and what it read. */
export interface BecauseRow {id:string;event_id:string;source_store?:string|null;asker_account?:string|null;free_read?:string|null;
  authority?:string|null;send_class?:string|null}

const WORDS=160;
/** A message's own words: its text or caption, on one line, cut. */
function words(payload:any):string|null {
  const message=payload?.message??payload?.edited_message,text=message?.text??message?.caption;
  if(typeof text!=='string')return null;
  const line=text.replace(/\s+/g,' ').trim();if(!line)return null;
  const points=Array.from(line);
  return points.length<=WORDS?line:points.slice(0,WORDS-1).join('').trimEnd()+'…';
}

/** What a chat rule covers, from its key (ADR-0214, ADR-0263): a site, one shared file, an exact command or one tool. */
export function ruleTarget(key:string):{what:'site'|'file'|'command'|'tool';target:string|null} {
  if(key.startsWith('nocheh_browser:')){const target=key.slice(15);return {what:target.includes('/')?'file':'site',target};}
  if(key.startsWith('nocheh_mcp:'))return {what:'tool',target:key.slice(11).split(':')[0]||null};
  return {what:'command',target:null};
}

export class ActionBecause {
  /** `derived` reads a schedule's saved definition, for its name; `jobTitle` a background run's job title. */
  constructor(readonly control:Pick<pg.Pool,'query'>,readonly archive:Pick<pg.Pool,'query'>,readonly schedule:(version:string)=>Promise<{name:string|null}|null>,readonly jobTitle:(event:string)=>Promise<string|null>){}

  /** Who asked in message `event` and their words; null for a run Nocheh started itself. */
  private async asker(event:string,account?:string|null):Promise<{who:'owner'|'member';name:string|null;words:string|null}|null> {
    const row=(await this.archive.query<{payload:Buffer}>('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    if(!row)return null;
    let payload:any=null;try{payload=JSON.parse(row.payload.toString());}catch{return null;}
    // The member whose turn asked is on the action's row; none means the owner asked.
    return account?{who:'member',name:await this.name(account),words:words(payload)}:{who:'owner',name:null,words:words(payload)};
  }
  private async name(account:string):Promise<string|null> {
    const chosen=(await accountPeopleNames(this.control as pg.Pool,[account])).get(account);
    if(chosen)return chosen;
    const row=(await this.control.query<{name:string|null}>('SELECT coalesce(display_name,username) AS name FROM chat_accounts WHERE id=$1',[account])).rows[0];
    return row?.name??null;
  }
  /** The schedule a run belongs to, by name, and the words that first set it. */
  private async scheduleOf(event:string):Promise<Because|null> {
    const row=(await this.control.query<{version_id:string;created_turn:string|null}>(`SELECT s.version_id,s.created_turn FROM managed_runs r
      JOIN workflow_schedules s ON s.logical_profile=r.logical_profile AND s.job_id=r.job_id WHERE r.event_id=$1 AND r.channel='scheduler'`,[event])).rows[0];
    if(!row)return null;
    const saved=await this.schedule(row.version_id).catch(()=>null),set=row.created_turn?await this.asker(row.created_turn).catch(()=>null):null;
    return {kind:'schedule',name:saved?.name??null,words:set?.who==='owner'||set?.who==='member'?set.words:null};
  }
  /** An action by its table and id: why it ran (`because`) and who or what asked (`asked`). Unknown ids read as nothing. */
  async describe(table:'controlled'|'telegram',id:string):Promise<{because:Because|null;asked:Because|null}> {
    const row=(await this.control.query<BecauseRow>(table==='controlled'?
      'SELECT id,event_id,asker_account,free_read,authority,NULL AS send_class FROM controlled_actions WHERE id=$1':
      "SELECT id,source_reference->>'id' AS event_id,asker_account,NULL AS free_read,authority,send_class FROM telegram_action_requests WHERE id=$1",[id])).rows[0];
    if(!row)return {because:null,asked:null};
    return {because:await this.because(row),asked:await this.asked(row)};
  }
  /** Who or what asked, whatever allowed it: the message's words, or the schedule or job whose run asked. */
  async asked(row:BecauseRow):Promise<Because|null> {
    const kind=(await this.control.query<{kind:string}>('SELECT kind FROM content_operations WHERE id=$1',[row.event_id])).rows[0]?.kind;
    if(kind==='scheduled_trigger')return this.scheduleOf(row.event_id);
    if(kind==='background_run')return {kind:'job',title:await this.jobTitle(row.event_id).catch(()=>null)};
    const asker=await this.asker(row.event_id,row.asker_account);
    return asker?{kind:'said',...asker}:null;
  }
  /** Why it ran, from the grant Nocheh first allowed it under; null while it waits or when it never ran. */
  async because(row:BecauseRow):Promise<Because|null> {
    const allowed=(await this.control.query<{rule:string;permission_id:string|null}>(`SELECT rule,permission_id FROM security_events
      WHERE effect_id=$1 AND state='allowed' AND origin='grant' ORDER BY id LIMIT 1`,[row.id])).rows[0];
    if(!allowed)return null;
    const rule=allowed.rule;
    if(rule==='exact_owner_approval')return {kind:'approved'};
    if(rule==='owner_scheduled_chat'||rule==='member_scheduled_chat'||row.send_class==='scheduled_run')return this.scheduleOf(row.event_id).then(found=>found??{kind:'schedule',name:null,words:null});
    if(rule.startsWith('gmail_read:'))return {kind:'setting',connection:'gmail'};
    if(rule.startsWith('github_read:'))return {kind:'setting',connection:'github'};
    if(rule.startsWith('notion_setting:'))return {kind:'setting',connection:'notion'};
    if(rule==='group_tools'||row.authority==='group_tools') {
      const asker=await this.asker(row.event_id,row.asker_account);
      return {kind:'group_tools',who:asker?.who??'owner',name:asker?.name??null};
    }
    if(rule.startsWith('owner_autonomy:')||rule==='same_group_request'||rule==='owner_private_request') {
      const asked=await this.asked(row);return asked??{kind:'said',who:'owner',name:null,words:null};
    }
    // Anything else Nocheh allowed is an allowance the owner gave on a card: a chat rule or an exact grant.
    const permission=(await this.control.query<{grain:string;match_key:string|null;space_id:string|null;expires_at:Date}>(
      'SELECT grain,match_key,space_id,expires_at FROM action_permissions WHERE id=$1',[allowed.permission_id??rule])).rows[0];
    const until=permission?.expires_at?new Date(permission.expires_at).toISOString():null;
    if(permission?.grain!=='chat'||!permission.match_key)return {kind:'rule',what:'exact',target:null,chat:null,until};
    return {kind:'rule',...ruleTarget(permission.match_key),chat:permission.space_id,until};
  }
}
