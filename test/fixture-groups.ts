// Synthetic groups and projects shared by the Members tests (ADR-0246, ADR-0247, ADR-0248). Never live values.
import type pg from 'pg';
import {digest} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';

/** The owner's Telegram user ID, which is also the owner's private chat. */
export const OWNER='123';
/** Groups GP1, GP2 and GP3 are in project P1; GP4 is in no project. */
export const GP1='-1001000000001',GP2='-1001000000002',GP3='-1001000000003',GP4='-1001000000004';
/** A forum topic of GP1, which follows GP1's project. */
export const GP1_TOPIC=GP1+'/topic/7';
/** A group assigned to P1 that Nocheh does not serve: never one of P1's groups. */
export const UNSERVED='-1001000000009';
/** P1 holds GP1, GP2, GP3 and UNSERVED; P2 holds nothing. */
export const P1=digest('fixture:project:P1'),P2=digest('fixture:project:P2');
/** The served groups of P1, in the order projectGroups gives them. */
export const P1_GROUPS=[GP1,GP2,GP3] as const;

/** Nocheh on, serving GP1-GP4 for the owner, with topics sharing their group's memory unless overridden. */
export function groupsPolicy(overrides:Partial<AssistantPolicy>={}):AssistantPolicy {
  return {enabled:true,owner_id:OWNER,group_ids:[GP1,GP2,GP3,GP4],group_access:{},topic_memory:'group',...overrides};
}

/** Writes P1 and P2 and the group-level assignments into a control database. Plain rows, no owner command or
 * guard change, so a test sees exactly this layout; repeated calls change nothing. */
export async function seedGroups(db:Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>):Promise<void> {
  await db.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,'P1','',$3,1),($2,'P2','',$3,1) ON CONFLICT(id) DO NOTHING`,[P1,P2,'active']);
  await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) SELECT space,$1,'assigned',1 FROM unnest($2::text[]) space
    ON CONFLICT(space_id) DO NOTHING`,[P1,[GP1,GP2,GP3,UNSERVED]]);
}
