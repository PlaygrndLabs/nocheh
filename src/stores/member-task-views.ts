import type pg from 'pg';
import {readSet} from '../spaces.js';
import type {TaskView,TopicMemory} from './tasks.js';

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/**
 * The task boards a member reads (ADR-0262 D14, ADR-0265 D5): one view per active project assigned one of `groups` (the
 * member's joined groups, as the caller resolved them), named by the project, reaching only those of `groups` in it, with
 * their topics when topics share what their group knows (`topicMemory` 'group'), else the groups alone. Groups in no
 * project, or in a project that is not active, have no board. The member's private chat (D14) and the members' app read
 * through this one rule, so the two never drift apart. Sorted by project id, each reach by group id.
 */
export async function memberTaskViews(db:Db,groups:readonly string[],topicMemory:TopicMemory):Promise<TaskView[]> {
  if(!groups.length)return [];
  const rows=(await db.query<{group:string;project:string;name:string}>(`SELECT a.space_id AS group,p.id AS project,p.name FROM project_assignments a
    JOIN projects p ON p.id=a.project_id AND p.state='active' WHERE a.space_id=ANY($1::text[]) AND a.mode='assigned' ORDER BY p.id,a.space_id`,[[...groups]])).rows;
  const byProject=new Map<string,{name:string;groups:string[]}>();
  for(const row of rows){const found=byProject.get(row.project)??{name:row.name,groups:[]};found.groups.push(row.group);byProject.set(row.project,found);}
  return [...byProject].map(([project,found])=>({project,name:found.name,
    reach:readSet({home:found.groups[0]!,project,...(topicMemory==='group'?{whole:found.groups}:{exact:found.groups})})}));
}
