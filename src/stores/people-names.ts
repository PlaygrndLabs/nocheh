import type pg from 'pg';
import type {AssistantPolicy} from '../assistant-policy.js';
import type {ChatDirectory} from '../chats.js';
import {allowedAccounts} from '../destinations.js';
import type {Names,Person} from '../task-reminder-text.js';
import {accountPeopleNames} from './entities.js';

/**
 * What labels that name people read (ADR-0255): the directory, the members who reach a served group now (step 3), and
 * these people and every such member as Telegram last showed them, or by the People name the owner set (ADR-0274).
 * Reminder lines and note sources read the same names, so a person reads alike in both. Without a policy nobody reads as
 * no longer allowed.
 */
export async function peopleNames(db:Pick<pg.Pool,'query'>,chats:ChatDirectory,policy:Pick<AssistantPolicy,'owner_id'>|null|undefined,
  people:Iterable<{account:string|null}>):Promise<Names> {
  const allowed=policy?allowedAccounts(chats):null;
  const accounts=[...new Set([...allowed?.keys()??[],...[...people].map(who=>who.account).filter((id):id is string=>!!id)])];
  const rows=accounts.length?(await db.query(`SELECT a.id,a.display_name,coalesce(a.username,d.username) AS username FROM chat_accounts a
    LEFT JOIN chats c ON c.account_id=a.id AND c.kind='private' LEFT JOIN chat_details d ON d.chat_id=c.id
    WHERE a.id=ANY($1::text[]) ORDER BY a.id,coalesce(a.username,d.username) NULLS LAST`,[accounts])).rows:[];
  const found=new Map<string,Person>(),chosen=await accountPeopleNames(db,accounts);
  for(const item of rows)if(!found.has(item.id))found.set(item.id,{display_name:chosen.get(item.id)??item.display_name??null,username:item.username??null});
  return {directory:chats,allowed,people:found};
}
