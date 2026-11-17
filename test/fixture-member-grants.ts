// Tests only: the members that older tests' group access lists stand for (step 3). Synthetic values only.
import type pg from 'pg';
import {accountIdFor,connectionIdFor} from '../src/chats.js';
import {installMembersForTest,memberDirectory,memberIdFor,type MemberDirectory,type MemberRow} from '../src/members.js';

/** People allowed and denied per group, as the lists before step 3 named them: Nocheh group chat id to Telegram user ids. */
export type GroupGrants=Readonly<Record<string,{readonly granted:readonly string[];readonly denied?:readonly string[]}>>;
export interface GrantOptions {
  /** The owner's Telegram user id: never a member, and the directory's owner account. */
  owner?:string|null;
  /** The other groups the people's switches cover, besides the keys of the grants: switched off for everyone not granted
   * there. A group named nowhere has no row, so it counts as on. */
  groups?:readonly string[];
  /** A person's members row changed, keyed by Telegram user id (a pause, a permission off). */
  changes?:Readonly<Record<string,Partial<Omit<MemberRow,'id'>>>>;
  /** Groups where Telegram last saw a person leave, keyed by Telegram user id. */
  left?:Readonly<Record<string,readonly string[]>>;
  /** The daily message cap. */
  dailyMessages?:number;
}

/**
 * Tests only: the member directory the carry makes from per-group lists. Each person granted in some group and not
 * the owner becomes an active member with every permission on and tasks write, switched on in each group they are
 * granted and not denied in and off in every other group named (a deny wins), and seen 'in' each group they are on in,
 * unless `left` says they left it.
 */
export function grantedMembers(grants:GroupGrants,options:GrantOptions={}):MemberDirectory {
  const owner=options.owner??null,groups=[...new Set([...Object.keys(grants),...options.groups??[]])].sort();
  const people=[...new Set(Object.values(grants).flatMap(entry=>entry.granted))].filter(person=>person!==owner).sort();
  const on=(person:string,group:string)=>!!grants[group]?.granted.includes(person)&&!grants[group]?.denied?.includes(person);
  const members:MemberRow[]=[],accounts=[],memberChats=[],presence=[];
  for(const person of people) {
    const account=accountIdFor('telegram',person),id=memberIdFor(account);
    members.push({id,state:'active',group_talk:true,group_jobs:true,group_post_other:true,group_tools:true,tasks:'write',...options.changes?.[person]});
    accounts.push({account_id:account,member_id:id});
    for(const group of groups) {
      memberChats.push({member_id:id,chat_id:group,enabled:on(person,group)});
      if(on(person,group))presence.push({account_id:account,chat_id:group,state:options.left?.[person]?.includes(group)?'left' as const:'in' as const});
    }
  }
  return memberDirectory({members,accounts,chats:memberChats,presence,owner_account:owner?accountIdFor('telegram',owner):null,
    ...options.dailyMessages===undefined?{}:{daily_messages:options.dailyMessages}});
}

/** Tests only: installs grantedMembers for the whole process and returns the function that puts the previous directory
 * back. */
export function grantMembers(grants:GroupGrants,options:GrantOptions={}):()=>void {
  return installMembersForTest(grantedMembers(grants,options));
}

/** Tests only: makes the Telegram user `external` one of the owner's members in a control database, with every
 * permission on: their account, a members row and the link. Plain inserts that skip rows already there. */
export async function seedMemberAccount(db:Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>,external:string):Promise<void> {
  const connection=connectionIdFor('telegram'),account=accountIdFor('telegram',external),member=memberIdFor(account);
  await db.query(`INSERT INTO chat_connections(id,app,secret_ref) VALUES($1,'telegram','env:TELEGRAM_BOT_TOKEN') ON CONFLICT DO NOTHING`,[connection]);
  await db.query('INSERT INTO chat_accounts(id,connection_id,external_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[account,connection,external]);
  await db.query('INSERT INTO members(id) VALUES($1) ON CONFLICT DO NOTHING',[member]);
  await db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1 AND member_id IS NULL',[account,member]);
}
