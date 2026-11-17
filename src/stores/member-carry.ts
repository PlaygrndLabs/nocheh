import type pg from 'pg';
import type {AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor} from '../chats.js';
import {isTelegramAccount} from '../chats-telegram.js';
import {isProxyAccount} from '../chats-telegram-updates.js';
import {memberIdFor} from '../members.js';
import {bumpMemberRevision} from './member-schema.js';
import {chatOfApp,ensureAccount,ensureConnection} from './chats.js';

/*
 * The one-time carry of the lists in force before step 3 ("Who can talk to Nocheh" in each group) into members. It runs
 * once, at the app's start after the chat seeder, guarded by member_directory_state.carried_at, and only inserts. Its
 * source is the newest assistant runtime document that still has a group_access key: the lists the last start before
 * step 3 admitted. No setting is read, so a fresh install, which has no such document, only sets the marker.
 *
 * Each list is keyed by a group's Telegram id, current or old; the lists under every id of one group are joined, and a
 * person denied there under any of them is denied there. Each person granted somewhere becomes a member with every
 * permission on and tasks read and write (what they could do before), with their exact reach kept: a switched-on row
 * for each group they were granted in, and a switched-off row for every other group chat, so a group with no row (which
 * counts as on) never lets a carried person talk where they could not before. Talk works there because each message
 * proves its sender is in the group; a decision made without a message still needs Telegram's row (the directory's
 * reaches). The owner's own list is the authority here, so Telegram's rows are not asked.
 *
 * Parsing never throws on data: anything not shaped as {group id: {granted: [user ids], denied: [user ids]}} is skipped
 * and counted, as are keys naming no group Nocheh has a row for, the owner, Telegram's proxy accounts, accounts
 * recorded as bots, ids that are no Telegram user id, people only ever denied, and a group a granted person is denied
 * in. A database error fails the start like any other start step; the transaction leaves nothing behind.
 */

export interface MemberCarry {carried:boolean;members:number;groups:number;skipped:Record<string,number>}
const strings=(value:unknown):string[]|null=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):null;

export async function carryMembers(control:pg.Pool,policy:Pick<AssistantPolicy,'owner_id'>):Promise<MemberCarry> {
  const db=await control.connect();
  const skipped:Record<string,number>={malformed:0,no_group:0,owner:0,proxy:0,bot:0,invalid:0,denied_only:0,denied:0};
  try {
    await db.query('BEGIN');
    const state=(await db.query('SELECT carried_at FROM member_directory_state WHERE singleton FOR UPDATE')).rows[0];
    if(!state||state.carried_at!==null){await db.query('COMMIT');return {carried:false,members:0,groups:0,skipped};}
    const source=(await db.query(`SELECT document->'group_access' AS access FROM runtime_configuration_versions
      WHERE name='assistant' AND document ? 'group_access' ORDER BY revision DESC LIMIT 1`)).rows[0]?.access;
    // The lists, joined per group chat: who was granted and who denied there.
    const lists=new Map<string,{granted:Set<string>;denied:Set<string>}>();
    const connection=await ensureConnection(db,'telegram');
    if(source&&typeof source==='object'&&!Array.isArray(source))for(const [key,raw] of Object.entries(source as Record<string,unknown>)) {
      const entry=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null,granted=strings(entry?.granted),denied=strings(entry?.denied);
      if(!granted||!denied){skipped.malformed!++;continue;}
      const chat=await chatOfApp(db,connection,key);
      if(chat?.kind!=='group'){skipped.no_group!++;continue;}
      const list=lists.get(chat.id)??{granted:new Set<string>(),denied:new Set<string>()};
      for(const user of granted)list.granted.add(user);for(const user of denied)list.denied.add(user);
      lists.set(chat.id,list);
    }
    // Who keeps which groups: granted and not denied there.
    const reach=new Map<string,Set<string>>(),people=new Set<string>();
    for(const [chat,list] of lists)for(const user of new Set([...list.granted,...list.denied])) {
      people.add(user);
      if(!list.granted.has(user))continue;
      if(list.denied.has(user)){skipped.denied!++;continue;}
      const groups=reach.get(user)??new Set<string>();groups.add(chat);reach.set(user,groups);
    }
    for(const user of people)if(!reach.has(user))skipped.denied_only!++;
    const allGroups=(await db.query(`SELECT id FROM chats WHERE kind='group' ORDER BY id`)).rows.map(row=>row.id as string);
    let carried=0,rows=0;const kept=new Set<string>();
    for(const [user,groups] of [...reach].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      if(policy.owner_id&&user===policy.owner_id){skipped.owner!++;continue;}
      if(isProxyAccount(user)){skipped.proxy!++;continue;}
      let account:string;try{if(!isTelegramAccount(user))throw Error('invalid');account=accountIdFor('telegram',user);}catch{skipped.invalid!++;continue;}
      const known=(await db.query('SELECT kind FROM chat_accounts WHERE id=$1',[account])).rows[0];
      if(known?.kind==='bot'){skipped.bot!++;continue;}
      if(!known)await ensureAccount(db,connection,{external:user});
      await db.query('INSERT INTO members(id) VALUES($1) ON CONFLICT DO NOTHING',[memberIdFor(account)]);
      await db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1 AND member_id IS NULL',[account,memberIdFor(account)]);
      const member=(await db.query('SELECT member_id FROM chat_accounts WHERE id=$1',[account])).rows[0].member_id as string;
      for(const group of allGroups)rows+=(await db.query('INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [member,group,groups.has(group)])).rowCount??0;
      for(const group of groups)kept.add(group);
      carried++;
    }
    await db.query('UPDATE member_directory_state SET carried_at=now() WHERE singleton');
    if(carried)await bumpMemberRevision(db);
    await db.query('COMMIT');
    console.log(JSON.stringify({event:'member_carry',members:carried,groups:kept.size,rows,skipped}));
    return {carried:true,members:carried,groups:kept.size,skipped};
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
}
