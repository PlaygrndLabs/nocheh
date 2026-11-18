// Synthetic groups, projects and members shared by the Members tests (ADR-0247, ADR-0248, ADR-0249, ADR-0252, step 3,
// step 4: members' private chats).
// Never live values.
import type pg from 'pg';
import {digest} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,connectionIdFor,installChatsForTest,type ChatDirectory,type ChatIdRow,type ChatRow,
  type ChatSnapshot,type ChatState} from '../src/chats.js';
import {legacyChat} from '../src/chats-telegram.js';
import {memberDirectory,memberIdFor,type MemberDirectory,type MemberRow,type MemberSnapshot} from '../src/members.js';

/* Two families of chats, so no test hides a parsing site behind old-shaped ids:
 * - old-shaped chats, stored before step 2b, keep their Telegram value as their Nocheh id: OWNER, GP1-GP4, GP1_TOPIC,
 *   UNSERVED;
 * - chats first seen after step 2b have digest ids from chatIdFor: NG1, NG1_TOPIC, NG2 (a group Telegram upgraded,
 *   with an old and a current Telegram id) and BOB_CHAT (someone else's private chat). Their Telegram ids are *_TG.
 * Each family also holds two members' own private chats (step 4): MEMBER_GP_CHAT and MEMBER_GP_OFF_CHAT are old-shaped,
 * MEMBER_NG_CHAT and MEMBER_NG_OFF_CHAT have digest ids. */

/** The owner's Telegram user id (the owner's account), which is also the owner's private chat's old-shaped id. */
export const OWNER='123';
/** Groups GP1, GP2 and GP3 are in project P1; GP4 is in no project. */
export const GP1='-1001000000001',GP2='-1001000000002',GP3='-1001000000003',GP4='-1001000000004';
/** A forum topic of GP1, which follows GP1's project. Its key in Telegram is GP1_TOPIC_KEY. */
export const GP1_TOPIC=GP1+'/topic/7',GP1_TOPIC_KEY='7';
/** A group assigned to P1 that Nocheh does not serve: never one of P1's groups. */
export const UNSERVED='-1001000000009';
/** P1 holds GP1, GP2, GP3 and UNSERVED; P2 holds nothing. */
export const P1=digest('fixture:project:P1'),P2=digest('fixture:project:P2');
/** The served groups of P1, in the order projectGroups gives them. */
export const P1_GROUPS=[GP1,GP2,GP3] as const;
/** The Telegram ids of the groups a fixture serves by default (chats.state active, ADR-0253): GP1-GP4. */
export const GP_GROUP_IDS=[GP1,GP2,GP3,GP4] as const;

/** NG1, a forum supergroup first seen after step 2b, and its topic 7. */
export const NG1_TG='-1002000000001',NG1=chatIdFor('telegram',NG1_TG),NG1_TOPIC_KEY='7',NG1_TOPIC=chatIdFor('telegram',NG1_TG,NG1_TOPIC_KEY);
/** NG2, first seen after step 2b as a basic group (NG2_OLD_TG), which Telegram then upgraded to a supergroup (NG2_TG).
 * It keeps the id made from the first Telegram id it was seen under. */
export const NG2_OLD_TG='-4000000000002',NG2_TG='-1002000000002',NG2=chatIdFor('telegram',NG2_OLD_TG);
/** Every Telegram id of NG1 and NG2, current and old: a fixture that serves both turns their chats on. */
export const NG_GROUP_IDS=[NG1_TG,NG2_TG,NG2_OLD_TG] as const;
/** Bob's Telegram user id and his private chat with Nocheh, first seen after step 2b. Not served. */
export const BOB='456',BOB_CHAT=chatIdFor('telegram',BOB);
/*
 * The fixture members' Telegram user ids and their own private chats with Nocheh (step 3, step 4). In the old-shaped
 * family a private chat's id is its Telegram user id, as the owner's is; in the family first seen after step 2b it is
 * chatIdFor. MEMBER_GP and MEMBER_NG have private chat on; MEMBER_GP_OFF and MEMBER_NG_OFF have it off.
 */
export const MEMBER_GP='701',MEMBER_NG='702',MEMBER_GP_OFF='705',MEMBER_NG_OFF='706';
export const MEMBER_GP_CHAT=MEMBER_GP,MEMBER_NG_CHAT=chatIdFor('telegram',MEMBER_NG),MEMBER_GP_OFF_CHAT=MEMBER_GP_OFF,
  MEMBER_NG_OFF_CHAT=chatIdFor('telegram',MEMBER_NG_OFF);
/** Every fixture member's private chat: [Telegram user id, Nocheh chat id, title]. */
const memberPrivateChats:readonly (readonly [string,string,string])[]=[[MEMBER_GP,MEMBER_GP_CHAT,'Mira'],[MEMBER_NG,MEMBER_NG_CHAT,'Nils'],
  [MEMBER_GP_OFF,MEMBER_GP_OFF_CHAT,'Gita'],[MEMBER_NG_OFF,MEMBER_NG_OFF_CHAT,'Noor']];

/** A chat directory snapshot with the accounts its private chats name, for seedChats. */
export interface FixtureChats extends ChatSnapshot {accounts:{id:string;app:'telegram';external_id:string}[]}
const account=(external:string)=>({id:accountIdFor('telegram',external),app:'telegram' as const,external_id:external});
/** Which chats are on (chats.state, ADR-0253): a group is active when any of its Telegram ids is in `groupIds` (the
 * groups the owner added Nocheh to or turned on); the owner's private chat is active; every other chat is off. A topic
 * carries its parent's state. */
const stateOf=(kind:ChatRow['kind'],externals:readonly string[],groupIds:readonly string[],owner:boolean):ChatState=>
  owner?'active':kind!=='private'&&externals.some(id=>groupIds.includes(id))?'active':'off';

/** Both fixture families as directory rows, with the groups `groupIds` names on (GP1-GP4 by default). */
export function fixtureChats(groupIds:readonly string[]=GP_GROUP_IDS):FixtureChats {
  const chats:ChatRow[]=[],ids:ChatIdRow[]=[];
  const chat=(id:string,kind:'private'|'group',externals:{current:string;old?:string[]},extra:Partial<ChatRow>={})=>{
    const state=stateOf(kind,[externals.current,...externals.old??[]],groupIds,id===OWNER);
    chats.push({id,app:'telegram',kind,parent_id:null,topic_key:null,state,title:null,is_forum:false,account_id:null,app_type:kind==='private'?'private':'supergroup',...extra});
    ids.push({app:'telegram',external_id:externals.current,chat_id:id,state:'current'},
      ...(externals.old??[]).map(external=>({app:'telegram' as const,external_id:external,chat_id:id,state:'old' as const})));
    return state;
  };
  const topic=(id:string,parent:string,key:string,state:ChatState)=>chats.push({id,app:'telegram',kind:'topic',parent_id:parent,topic_key:key,state,title:null,is_forum:false,account_id:null,app_type:null});
  chat(OWNER,'private',{current:OWNER},{account_id:account(OWNER).id,title:'Owner'});
  chat(BOB_CHAT,'private',{current:BOB},{account_id:account(BOB).id,title:'Bob'});
  // Each fixture member's own private chat with Nocheh (step 4): off, as every private chat but the owner's is.
  for(const [person,id,title] of memberPrivateChats)chat(id,'private',{current:person},{account_id:account(person).id,title});
  for(const [i,group] of [GP1,GP2,GP3,GP4].entries()){const state=chat(group,'group',{current:group},{title:'GP'+(i+1),is_forum:group===GP1});if(group===GP1)topic(GP1_TOPIC,GP1,GP1_TOPIC_KEY,state);}
  chat(UNSERVED,'group',{current:UNSERVED},{title:'Unserved'});
  topic(NG1_TOPIC,NG1,NG1_TOPIC_KEY,chat(NG1,'group',{current:NG1_TG},{title:'NG1',is_forum:true}));
  chat(NG2,'group',{current:NG2_TG,old:[NG2_OLD_TG]},{title:'NG2'});
  return {chats,ids,owner_chat:OWNER,accounts:[account(OWNER),account(BOB),...memberPrivateChats.map(([person])=>account(person))]};
}
/** The fixture directory: both families, served by `groupIds` (GP1-GP4 by default). */
export const fixtureDirectory=(groupIds:readonly string[]=GP_GROUP_IDS):ChatDirectory=>chatDirectory(fixtureChats(groupIds));

/**
 * Tests only: a directory for values stored before step 2b, made the way the seeder makes rows, through legacyChat.
 * Each value becomes its chat (a topic adds its parent); values that name no chat ('owner', '*', 'system',
 * 'desktop:*', digests) are left out. `owner` is the owner's private chat; a group is served when its Telegram id is
 * in `served`, as the 2b-1 bridge serves it.
 */
export function legacyChats(values:Iterable<string>,options:{owner?:string|null;served?:readonly string[]}={}):FixtureChats {
  const owner=options.owner??null,served=options.served??[],chats=new Map<string,ChatRow>(),ids:ChatIdRow[]=[],accounts=new Map<string,FixtureChats['accounts'][number]>();
  const add=(id:string,kind:'private'|'group')=>{
    if(chats.has(id))return chats.get(id)!.state;
    const state=stateOf(kind,[id],served,id===owner),person=kind==='private'?account(id):null;
    if(person)accounts.set(person.id,person);
    chats.set(id,{id,app:'telegram',kind,parent_id:null,topic_key:null,state,title:null,is_forum:false,account_id:person?.id??null,app_type:null});
    ids.push({app:'telegram',external_id:id,chat_id:id,state:'current'});return state;
  };
  for(const value of [...(owner?[owner]:[]),...values]) {
    const chat=legacyChat(value);if(!chat)continue;
    const state=add(chat.external,chat.chat_kind);
    if(chat.kind==='topic'&&!chats.has(chat.id))chats.set(chat.id,{id:chat.id,app:'telegram',kind:'topic',parent_id:chat.parent_id,topic_key:chat.topic_key,
      state,title:null,is_forum:false,account_id:null,app_type:null});
  }
  return {chats:[...chats.values()],ids,owner_chat:owner!==null&&legacyChat(owner)?.kind==='private'?owner:null,accounts:[...accounts.values()]};
}
export const legacyDirectory=(values:Iterable<string>,options:{owner?:string|null;served?:readonly string[]}={}):ChatDirectory=>
  chatDirectory(legacyChats(values,options));
/** Tests only: the legacy directory a hand-built policy implies: its owner's chat and its groups, on as its derived
 * group_ids says (servedPolicy fills it from the directory), plus any other old values the test uses (topics, unserved
 * groups, private chats). */
export const policyDirectory=(policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'|'group_ids'>,extra:Iterable<string>=[]):ChatDirectory=>
  legacyDirectory([...policy.group_ids,...extra],{owner:policy.owner_chat===undefined?policy.owner_id:policy.owner_chat,served:policy.group_ids});

/** Nocheh on, serving GP1-GP4 for the owner, with topics sharing their group's memory unless overridden. Installs the
 * fixture directory with the policy's group_ids on: group_ids is derived from chats.state (servedPolicy), so the
 * policy and the directory a test sees agree. */
export function groupsPolicy(overrides:Partial<AssistantPolicy>={}):AssistantPolicy {
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[...GP_GROUP_IDS],topic_memory:'group',owner_chat:OWNER,...overrides};
  if(overrides.owner_chat===undefined&&overrides.owner_id!==undefined)policy.owner_chat=overrides.owner_id;
  installChatsForTest(fixtureDirectory(policy.group_ids));
  return policy;
}

/** Writes P1 and P2 and the group-level assignments into a control database. Plain rows, no owner command or
 * guard change, so a test sees exactly this layout; repeated calls change nothing. */
export async function seedGroups(db:Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>):Promise<void> {
  await db.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,'P1','',$3,1),($2,'P2','',$3,1) ON CONFLICT(id) DO NOTHING`,[P1,P2,'active']);
  await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) SELECT space,$1,'assigned',1 FROM unnest($2::text[]) space
    ON CONFLICT(space_id) DO NOTHING`,[P1,[GP1,GP2,GP3,UNSERVED]]);
}

/** Writes a fixture's chat records (connection, accounts, chats parents first, chat ids) into a control database.
 * Plain inserts that skip rows already there, so repeated calls change nothing. */
export async function seedChats(db:Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>,fixture:FixtureChats=fixtureChats()):Promise<void> {
  const connection=connectionIdFor('telegram');
  await db.query(`INSERT INTO chat_connections(id,app,secret_ref) VALUES($1,'telegram','env:TELEGRAM_BOT_TOKEN') ON CONFLICT DO NOTHING`,[connection]);
  for(const person of fixture.accounts)await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [person.id,connection,person.external_id]);
  for(const chat of [...fixture.chats.filter(row=>row.kind!=='topic'),...fixture.chats.filter(row=>row.kind==='topic')])
    await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,app_type,account_id,title,is_forum,state,added_by_role)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'seeded') ON CONFLICT DO NOTHING`,
      [chat.id,connection,chat.kind,chat.parent_id,chat.topic_key,chat.app_type??null,chat.account_id??null,chat.title??null,chat.is_forum===true,chat.state]);
  for(const row of fixture.ids)await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [connection,row.external_id,row.chat_id,row.state,row.state==='old'?'migrated':null]);
}

/*
 * Members (step 3, step 4), two in each family. Synthetic Telegram user ids; their accounts are accountIdFor('telegram',
 * id) and their member ids memberIdFor(account). All are active with every permission on and tasks read and write unless
 * a test changes them (fixtureMembers(changes)); private chat is on for MEMBER_GP and MEMBER_NG and off for
 * MEMBER_GP_OFF and MEMBER_NG_OFF. Each has their own private chat in the chat fixtures (MEMBER_*_CHAT).
 * - MEMBER_GP: GP1 and GP2 switched on, GP3 switched off. Telegram last saw them 'in' GP1 and GP3, 'left' GP2, and 'in'
 *   UNSERVED. GP4 has no row and no Telegram row: they talk there (no row counts as on) but do not reach it.
 * - MEMBER_NG: NG1 switched on; NG2 has no row. Telegram saw them 'in' both, so NG2 is "New here" and reached.
 * - MEMBER_GP_OFF: GP4 switched on and MEMBER_NG_OFF: NG2 switched on, both added by Telegram user ID and never seen in a
 *   group, so they talk there but reach no group (no Telegram row), and accounts() never lists them.
 * BOB stays a stranger; the owner is never a member.
 */
export const OWNER_ACCOUNT=accountIdFor('telegram',OWNER),BOB_ACCOUNT=accountIdFor('telegram',BOB);
export const MEMBER_GP_ACCOUNT=accountIdFor('telegram',MEMBER_GP),MEMBER_NG_ACCOUNT=accountIdFor('telegram',MEMBER_NG);
export const MEMBER_GP_OFF_ACCOUNT=accountIdFor('telegram',MEMBER_GP_OFF),MEMBER_NG_OFF_ACCOUNT=accountIdFor('telegram',MEMBER_NG_OFF);
export const MEMBER_GP_ID=memberIdFor(MEMBER_GP_ACCOUNT),MEMBER_NG_ID=memberIdFor(MEMBER_NG_ACCOUNT);
export const MEMBER_GP_OFF_ID=memberIdFor(MEMBER_GP_OFF_ACCOUNT),MEMBER_NG_OFF_ID=memberIdFor(MEMBER_NG_OFF_ACCOUNT);

/** A member directory snapshot with the member people's accounts, for seedMembers. */
export interface FixtureMembers extends MemberSnapshot {people:{id:string;app:'telegram';external_id:string}[]}
const allOn=(id:string):MemberRow=>({id,state:'active',group_talk:true,group_jobs:true,group_post_other:true,group_tools:true,tasks:'write',
  private_chat:id!==MEMBER_GP_OFF_ID&&id!==MEMBER_NG_OFF_ID});
/** Every fixture member as directory rows, each members row changed by `changes` (keyed by member id). */
export function fixtureMembers(changes:Readonly<Record<string,Partial<Omit<MemberRow,'id'>>>>={}):FixtureMembers {
  const row=(id:string):MemberRow=>({...allOn(id),...changes[id],id});
  return {members:[row(MEMBER_GP_ID),row(MEMBER_NG_ID),row(MEMBER_GP_OFF_ID),row(MEMBER_NG_OFF_ID)],
    accounts:[{account_id:MEMBER_GP_ACCOUNT,member_id:MEMBER_GP_ID},{account_id:MEMBER_NG_ACCOUNT,member_id:MEMBER_NG_ID},
      {account_id:MEMBER_GP_OFF_ACCOUNT,member_id:MEMBER_GP_OFF_ID},{account_id:MEMBER_NG_OFF_ACCOUNT,member_id:MEMBER_NG_OFF_ID}],
    chats:[{member_id:MEMBER_GP_ID,chat_id:GP1,enabled:true},{member_id:MEMBER_GP_ID,chat_id:GP2,enabled:true},{member_id:MEMBER_GP_ID,chat_id:GP3,enabled:false},
      {member_id:MEMBER_NG_ID,chat_id:NG1,enabled:true},{member_id:MEMBER_GP_OFF_ID,chat_id:GP4,enabled:true},{member_id:MEMBER_NG_OFF_ID,chat_id:NG2,enabled:true}],
    presence:[{account_id:MEMBER_GP_ACCOUNT,chat_id:GP1,state:'in'},{account_id:MEMBER_GP_ACCOUNT,chat_id:GP2,state:'left'},
      {account_id:MEMBER_GP_ACCOUNT,chat_id:GP3,state:'in'},{account_id:MEMBER_GP_ACCOUNT,chat_id:UNSERVED,state:'in'},
      {account_id:MEMBER_NG_ACCOUNT,chat_id:NG1,state:'in'},{account_id:MEMBER_NG_ACCOUNT,chat_id:NG2,state:'in'}],
    owner_account:OWNER_ACCOUNT,daily_messages:200,revision:0,
    people:[MEMBER_GP,MEMBER_NG,MEMBER_GP_OFF,MEMBER_NG_OFF].map(account)};
}
/** The fixture member directory; install it with installMembersForTest. */
export const fixtureMemberDirectory=(changes:Parameters<typeof fixtureMembers>[0]={}):MemberDirectory=>memberDirectory(fixtureMembers(changes));

/** Writes a fixture's members into a control database that already holds its chats (seedChats with both families):
 * the member people's accounts, the members rows linked from them, their group switches and Telegram's membership rows.
 * Plain inserts that skip rows already there, and no revision move, so repeated calls change nothing. */
export async function seedMembers(db:Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>,fixture:FixtureMembers=fixtureMembers()):Promise<void> {
  const connection=connectionIdFor('telegram');
  for(const person of fixture.people)await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [person.id,connection,person.external_id]);
  for(const row of fixture.members)await db.query(`INSERT INTO members(id,state,group_talk,group_jobs,group_post_other,group_tools,tasks,private_chat)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[row.id,row.state,row.group_talk,row.group_jobs,row.group_post_other,row.group_tools,row.tasks,row.private_chat]);
  for(const link of fixture.accounts)await db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1 AND member_id IS NULL',[link.account_id,link.member_id]);
  for(const row of fixture.chats)await db.query('INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [row.member_id,row.chat_id,row.enabled]);
  for(const row of fixture.presence)await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source) VALUES($1,$2,$3,'message') ON CONFLICT DO NOTHING`,
    [row.chat_id,row.account_id,row.state]);
}
