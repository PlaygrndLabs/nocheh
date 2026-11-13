import type pg from 'pg';
import {groupChatId,groupChatSql} from '../spaces.js';

type Database=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/**
 * SQL for a project's groups as a `text[]`: every group Nocheh serves that is assigned to the project itself
 * (a group-level 'assigned' row; a topic follows its group and is never listed). `project` is the SQL for the project
 * id and `served` the placeholder of a `text[]` parameter holding the served group IDs (the policy's group_ids).
 * Anything that is not a group's own chat ID is left out, the owner's private chat included (ADR-0242). Sorted by
 * code point, the order JavaScript's sort gives, whatever the database collation. The project's state is not
 * checked: callers that need an active project check it. Its own rows are named `project_group`, an alias no caller
 * uses, so `project` never silently binds to the subquery's own row instead of the caller's.
 */
export const projectGroupsSql=(project:string,served:string)=>`(SELECT coalesce(array_agg(project_group.space_id ORDER BY project_group.space_id COLLATE "C"),'{}'::text[])
  FROM project_assignments project_group WHERE project_group.project_id=${project} AND project_group.mode='assigned'
  AND ${groupChatSql('project_group.space_id')} AND project_group.space_id=ANY(${served}::text[]))`;

/**
 * A project's groups: the served groups assigned to it, as projectGroupsSql decides (ADR-0246, ADR-0248). The one
 * answer to "which groups are in this project" for the project page, its confirmations, the Answer privately button
 * and the groups an answer may read.
 */
export async function projectGroups(db:Database,projectId:string,served:readonly string[]):Promise<string[]> {
  const groups=[...new Set(served)].filter(groupChatId);
  if(!groups.length)return [];
  const {rows}=await db.query(`SELECT ${projectGroupsSql('$1','$2')} AS groups`,[projectId,groups]);
  return (rows[0].groups as string[]).filter(groupChatId);
}
