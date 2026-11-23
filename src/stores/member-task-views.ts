import type pg from 'pg';
import type {TaskView} from './tasks.js';

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/**
 * The task boards a member reads (ADR-0262 D14, ADR-0265 D5, ADR-0276): one view per active project assigned one of
 * `groups` (the groups the caller kept for the member: joined, confirmed lately and not left out), named by the project.
 * Each board holds the project's whole list, whatever each task's group and whatever the project's "Share group chats"
 * switch; `home` is the first of `groups` in it, which a plain add in the members' app is labelled with. Groups in no
 * project, or in a project that is not active, have no board. The member's private chat, the members' app and reminder
 * delivery all read through this one rule. Sorted by project id.
 */
export async function memberTaskViews(db:Db,groups:readonly string[]):Promise<TaskView[]> {
  if(!groups.length)return [];
  const rows=(await db.query<{group:string;project:string;name:string}>(`SELECT a.space_id AS group,p.id AS project,p.name FROM project_assignments a
    JOIN projects p ON p.id=a.project_id AND p.state='active' WHERE a.space_id=ANY($1::text[]) AND a.mode='assigned' ORDER BY p.id,a.space_id`,[[...groups]])).rows;
  const views=new Map<string,TaskView>();
  for(const row of rows)if(!views.has(row.project))views.set(row.project,{project:row.project,name:row.name,home:row.group});
  return [...views.values()];
}
