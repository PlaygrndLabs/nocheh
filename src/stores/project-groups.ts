import type pg from 'pg';
import {groupChatId} from '../spaces.js';

type Database=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/**
 * SQL for a project's groups as a `text[]`: every group Nocheh serves that is assigned to the project itself
 * (a group-level 'assigned' row; a topic follows its group and is never listed). `project` is the SQL for the project
 * id and `served` the placeholder of a `text[]` parameter holding the served groups as the chat directory holds them
 * (servedGroups(), ADR-0252): groups themselves, so a topic, the owner's private chat or any id with no chat row is
 * never one of them (ADR-0242). Sorted by
 * code point, the order JavaScript's sort gives, whatever the database collation. The project's state is not
 * checked: callers that need an active project check it. Its own rows are named `project_group`, an alias no caller
 * uses, so `project` never silently binds to the subquery's own row instead of the caller's.
 */
export const projectGroupsSql=(project:string,served:string)=>`(SELECT coalesce(array_agg(project_group.space_id ORDER BY project_group.space_id COLLATE "C"),'{}'::text[])
  FROM project_assignments project_group WHERE project_group.project_id=${project} AND project_group.mode='assigned'
  AND project_group.space_id=ANY(${served}::text[]))`;

/**
 * A project's groups: the served groups assigned to it, as projectGroupsSql decides (ADR-0247, ADR-0249). `served` is
 * servedGroups(); anything in it the chat directory does not hold as a group is dropped first. The one
 * answer to "which groups are in this project" for the project page, its confirmations, the Answer privately button
 * and the groups an answer may read.
 */
export async function projectGroups(db:Database,projectId:string,served:readonly string[]):Promise<string[]> {
  const groups=[...new Set(served)].filter(groupChatId);
  if(!groups.length)return [];
  const {rows}=await db.query(`SELECT ${projectGroupsSql('$1','$2')} AS groups`,[projectId,groups]);
  return (rows[0].groups as string[]).filter(groupChatId);
}

/**
 * The groups a served group reads while its project shares its group chats (ADR-0267): the project's ticked groups
 * (projectGroupsSql less the project's `own_groups`, ADR-0287), the asking group among them, when `group` is a group
 * Nocheh serves, ticked, assigned to an active project whose "Share group chats" is on and which has at least one other
 * ticked served group. Null otherwise: a group in no project, in an archived project or in one that does not share, an
 * unticked group, a project with no other ticked served group, a topic, a private chat and any id with no chat row read
 * only themselves. `served` is servedGroups().
 */
export async function sharedProjectGroups(db:Database,group:string,served:readonly string[]):Promise<{project:string;groups:string[]}|null> {
  const groups=[...new Set(served)].filter(groupChatId);
  if(!groupChatId(group)||!groups.includes(group))return null;
  const row=(await db.query<{project:string;groups:string[];own_groups:string[]}>(`SELECT p.id AS project,p.own_groups,${projectGroupsSql('p.id','$2')} AS groups
    FROM project_assignments a JOIN projects p ON p.id=a.project_id AND p.state='active' AND p.share_chats
    WHERE a.space_id=$1 AND a.mode='assigned'`,[group,groups])).rows[0];
  const found=(row?.groups??[]).filter(member=>groupChatId(member)&&!row!.own_groups.includes(member));
  return row&&found.includes(group)&&found.length>1?{project:row.project,groups:found}:null;
}

/**
 * A member's groups with, for each, the other served groups of its project while that project shares its group chats
 * (ADR-0267, ADR-0276), sorted. `joined` must already be only the groups the caller keeps for the member (fresh, not
 * left out): a group that is not one of them never adds anything, and the groups added are read, never joined. A
 * member's private chat, the members' app and reminder delivery all widen through this one rule.
 */
export async function withSharedGroups(db:Database,joined:readonly string[],served:readonly string[]):Promise<string[]> {
  const whole=new Set(joined);
  for(const group of joined)for(const other of (await sharedProjectGroups(db,group,served))?.groups??[])whole.add(other);
  return [...whole].sort();
}
