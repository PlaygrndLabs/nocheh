import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {validatePolicy} from '../security/contract.js';
import {validateSpace} from '../spaces.js';
import {chatApps,chatDirectory,chatIdStates,chatKinds,chatStates,isChatId,type ChatApp,type ChatDirectory,type ChatIdRow,type ChatRow} from '../chats.js';
import {isTelegramAccount} from '../chats-telegram.js';
import {DAILY_MESSAGES_DEFAULT,DAILY_MESSAGES_MAX,DAILY_MESSAGES_MIN,memberStates,memberTaskModes,type MemberState,type MemberTasks} from '../member-wire.js';
import type {StorePools} from './connections.js';
import {ChatSeeder} from './chat-seed.js';
import {bumpChatRevision,ensureAccount,ensureConnection} from './chats.js';
import {bumpMemberRevision} from './member-schema.js';
import {ArchiveRepository} from './archive.js';
import {GuardRepository} from './guards.js';
import {SourceAccessRepository} from './access.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';

/** A snapshot's runtime document: whether Nocheh is on and the owner's account. Which groups are served is chats.state
 * (ADR-0253), and who may use Nocheh in a group is members (step 3), so neither is in it. */
type AssistantPolicy={enabled:boolean;owner_id:string|null};
/** A chats row in a reset snapshot (ADR-0252): a name only when the owner gave it. */
type SnapshotChat={id:string;app:ChatApp;kind:ChatRow['kind'];parent_id:string|null;topic_key:string|null;app_type:string|null;
  title:string|null;title_source:'owner'|null;is_forum:boolean;state:ChatRow['state']};
type SnapshotChatId={app:ChatApp;external_id:string;chat_id:string;state:ChatIdRow['state'];reason:'migrated'|'id_changed'|null};
/** A member as a snapshot carries it: its permissions; its group switches and accounts are rows of their own. */
type SnapshotMember={id:string;state:MemberState;group_talk:boolean;group_jobs:boolean;group_post_other:boolean;group_tools:boolean;tasks:MemberTasks;
  private_chat:boolean};
/** An account linked to a member, by its app id, so the restore makes the same account (ensureAccount) and links it. */
type SnapshotMemberAccount={member_id:string;app:ChatApp;external_id:string};
type SnapshotMemberChat={member_id:string;chat_id:string;enabled:boolean};
/**
 * Version 3 (step 3) carries the chats and their app ids (ADR-0252), so every value names the same chat after the reset,
 * and the members: their permissions (private_chat too, step 4), the accounts linked to them, their group switches and the daily message cap. It
 * is the only version: a snapshot taken by an older version (v1, v2), or a runtime document that still lists groups or
 * who may talk in them, is refused (development mode).
 */
type SetupSnapshot={format:'nocheh-reset-configuration-v3';layout:'original-only-v1';configuration:{
  security_policy:{document:unknown}[];installation_generation:{generation:string}[];
  guard_mode:{mode:'on'|'off'}[];runtime_configuration:{name:'assistant';document:AssistantPolicy}[];
  projects:{id:string;name:string;description:string;state:'active'|'archived'}[];
  project_assignments:{space_id:string;project_id:string|null;mode:'assigned'|'none'|'inherit'}[];
  sharing_rules:{id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string}[];
  memory_access_settings:{destination:string;suggestions:'related'|'off'|null;notify_owner:boolean|null;auto_followup:boolean|null;request_ttl_seconds:number|null;default_grant_mode:'one_time'|'persistent'|null}[];
  chat_tool_settings:{space_id:string;shell:boolean|null;browser:boolean|null;mcp:boolean|null}[];
  runtime_profiles:{id:string;name:string;owner_id:string}[];
  chats:SnapshotChat[];chat_ids:SnapshotChatId[];
  members:SnapshotMember[];member_accounts:SnapshotMemberAccount[];member_chats:SnapshotMemberChat[];daily_messages:{daily_messages:number}[];
}};
const VERSION_3='nocheh-reset-configuration-v3';
const CHAT_TABLES=['chats','chat_ids'],MEMBER_TABLES=['members','member_accounts','member_chats','daily_messages'];
const SETUP_TABLES=['security_policy','installation_generation','guard_mode','runtime_configuration',
  'projects','project_assignments','sharing_rules','memory_access_settings','chat_tool_settings','runtime_profiles'];
type ProfileCommand={id:string;name:string;state:'active';expected_revision:0;operation_id:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID=/^[a-f0-9]{64}$/;
const PROFILE=/^profile-[a-f0-9]{48}$/;
const exact=(value:unknown,keys:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))
    throw Error('reset_setup_snapshot_invalid');
  return value as Record<string,unknown>;
};
const text=(value:unknown,limit:number)=>{
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>limit)throw Error('reset_setup_snapshot_invalid');return value;
};
const identifier=(value:unknown,pattern:RegExp)=>{const result=text(value,100);if(!pattern.test(result))throw Error('reset_setup_snapshot_invalid');return result;};
const same=(left:unknown,right:unknown)=>canonical(left)===canonical(right);

function policy(value:unknown):AssistantPolicy {
  const row=exact(value,['enabled','owner_id']);
  // The policy holds the owner's account: their Telegram user id.
  if(typeof row.enabled!=='boolean'||row.owner_id!==null&&!isTelegramAccount(row.owner_id)||row.enabled&&!row.owner_id)
    throw Error('reset_setup_snapshot_invalid');
  return row as unknown as AssistantPolicy;
}
/** A runtime document as this version admits it: exactly whether Nocheh is on and the owner's account. */
export const admittedDocument=(document:AssistantPolicy):AssistantPolicy=>({enabled:document.enabled,owner_id:document.owner_id});

const appId=/^[A-Za-z0-9._:-]{1,128}$/;
/** The chats and app ids of a snapshot, checked row by row. */
function snapshotChats(snapshot:SetupSnapshot):{chats:SnapshotChat[];ids:SnapshotChatId[]} {
  const c=snapshot.configuration as unknown as Record<string,unknown>,seen=new Set<string>(),keys=new Set<string>();
  for(const name of ['chats','chat_ids'])if(!Array.isArray(c[name])||(c[name] as unknown[]).length>10000)throw Error('reset_setup_snapshot_invalid');
  const chats=(c.chats as unknown[]).map(item=>{
    const row=exact(item,['id','app','kind','parent_id','topic_key','app_type','title','title_source','is_forum','state']);
    if(!isChatId(row.id)||seen.has(row.id)||!(chatApps as readonly unknown[]).includes(row.app)||!(chatKinds as readonly unknown[]).includes(row.kind)||
      !(chatStates as readonly unknown[]).includes(row.state)||typeof row.is_forum!=='boolean'||
      row.app_type!==null&&(typeof row.app_type!=='string'||!/^[a-z_]{1,32}$/.test(row.app_type))||
      row.title!==null&&(typeof row.title!=='string'||row.title.length>256)||row.title_source!==(row.title===null?null:'owner'))
      throw Error('reset_setup_snapshot_invalid');
    seen.add(row.id);return row as unknown as SnapshotChat;
  });
  const ids=(c.chat_ids as unknown[]).map(item=>{
    const row=exact(item,['app','external_id','chat_id','state','reason']);
    if(!(chatApps as readonly unknown[]).includes(row.app)||typeof row.external_id!=='string'||!appId.test(row.external_id)||!seen.has(row.chat_id as string)||
      keys.has(row.app+'\n'+row.external_id)||!(chatIdStates as readonly unknown[]).includes(row.state)||![null,'migrated','id_changed'].includes(row.reason as string|null))
      throw Error('reset_setup_snapshot_invalid');
    keys.add(row.app+'\n'+row.external_id);return row as unknown as SnapshotChatId;
  });
  return {chats,ids};
}
/**
 * The chat directory a snapshot describes: its own chats rows, and for every value with none, the row the stores' seeder
 * would give it. Rows that break the schema's rules make the snapshot invalid.
 */
function snapshotDirectory(snapshot:SetupSnapshot):ChatDirectory {
  const {chats,ids}=snapshotChats(snapshot),c=snapshot.configuration,assistant=c.runtime_configuration[0]?.document;
  const known=new Set(ids.filter(row=>row.app==='telegram').map(row=>row.external_id)),named=new Set(chats.map(row=>row.id));
  const seeder=new ChatSeeder(undefined as never,{owner_id:assistant?.owner_id??null});
  for(const value of [assistant?.owner_id,...c.project_assignments.map(row=>row.space_id),
    ...c.sharing_rules.flatMap(row=>Array.isArray(row.sources)?[...row.sources,row.destination]:[row.destination]),
    ...c.memory_access_settings.map(row=>row.destination),...c.chat_tool_settings.map(row=>row.space_id)])seeder.value(value);
  const rows:ChatRow[]=chats.map(row=>({id:row.id,app:row.app,kind:row.kind,parent_id:row.parent_id,topic_key:row.topic_key,state:row.state,
    title:row.title,is_forum:row.is_forum,app_type:row.app_type})),appIds:ChatIdRow[]=ids.map(row=>({app:row.app,external_id:row.external_id,chat_id:row.chat_id,state:row.state}));
  for(const planned of seeder.plan.values()) {
    if(named.has(planned.id)||planned.kind!=='topic'&&known.has(planned.external))continue;
    rows.push({id:planned.id,app:'telegram',kind:planned.kind,parent_id:planned.kind==='topic'?planned.parent:null,topic_key:planned.key,state:'off'});
    if(planned.kind!=='topic')appIds.push({app:'telegram',external_id:planned.external,chat_id:planned.id,state:'current'});
  }
  // A seeded topic's chat is the chat its Telegram id names now.
  const byExternal=new Map(appIds.map(row=>[row.external_id,row.chat_id]));
  for(const row of rows)if(row.kind==='topic'&&row.parent_id&&!rows.some(other=>other.id===row.parent_id))row.parent_id=byExternal.get(row.parent_id)??row.parent_id;
  const owner=assistant?.owner_id?byExternal.get(assistant.owner_id)??null:null;
  try{return chatDirectory({chats:rows,ids:appIds,owner_chat:owner});}catch{throw Error('reset_setup_snapshot_invalid');}
}
/** A store's chats as a snapshot reads them, in a fixed order. */
export async function chatRows(control:pg.Pool|pg.PoolClient):Promise<{chats:SnapshotChat[];chat_ids:SnapshotChatId[]}> {
  const chats=(await control.query(`SELECT c.id,n.app,c.kind,c.parent_id,c.topic_key,c.app_type,CASE WHEN c.title_source='owner' THEN c.title END AS title,
    CASE WHEN c.title_source='owner' THEN 'owner' END AS title_source,c.is_forum,c.state FROM chats c JOIN chat_connections n ON n.id=c.connection_id`)).rows;
  const ids=(await control.query(`SELECT n.app,i.external_id,i.chat_id,i.state,i.reason FROM chat_ids i JOIN chat_connections n ON n.id=i.connection_id`)).rows;
  return sortedChats({chats,chat_ids:ids});
}
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Chats and app ids in one order, whatever order a snapshot or a database gave them in. */
export function sortedChats(value:{chats?:SnapshotChat[]|undefined;chat_ids?:SnapshotChatId[]|undefined}) {
  return {chats:[...value.chats??[]].sort((a,b)=>order(a.id,b.id)),chat_ids:[...value.chat_ids??[]].sort((a,b)=>order(a.app,b.app)||order(a.external_id,b.external_id))};
}
/**
 * The chats as a restore writes them. A group still waiting to be left, and its topics, come back off: the reset does not
 * carry its leave, so no add is on record, and a group seen with no add stays silent and Off (ADR-0253). Only for a
 * snapshot's chats: a live store's are read as they are.
 */
export function restoredChats(value:{chats?:SnapshotChat[]|undefined;chat_ids?:SnapshotChatId[]|undefined}) {
  const sorted=sortedChats(value);
  return {...sorted,chats:sorted.chats.map(row=>row.state==='pending'?{...row,state:'off' as const}:row)};
}

/**
 * A store's members as a snapshot reads them, in a fixed order: the members, the accounts linked to them by app id,
 * their group switches and the daily message cap.
 */
export async function memberRows(control:pg.Pool|pg.PoolClient) {
  const members=(await control.query('SELECT id,state,group_talk,group_jobs,group_post_other,group_tools,tasks,private_chat FROM members')).rows as SnapshotMember[];
  const accounts=(await control.query(`SELECT a.member_id,n.app,a.external_id FROM chat_accounts a JOIN chat_connections n ON n.id=a.connection_id
    WHERE a.member_id IS NOT NULL`)).rows as SnapshotMemberAccount[];
  const switches=(await control.query('SELECT member_id,chat_id,enabled FROM member_chats')).rows as SnapshotMemberChat[];
  const daily=(await control.query('SELECT daily_messages FROM member_directory_state WHERE singleton')).rows as {daily_messages:number}[];
  return sortedMembers({members,member_accounts:accounts,member_chats:switches,daily_messages:daily});
}
/** Members, their accounts and switches in one order, whatever order a snapshot or a database gave them in. */
export function sortedMembers(value:Pick<SetupSnapshot['configuration'],'members'|'member_accounts'|'member_chats'|'daily_messages'>) {
  return {members:[...value.members].sort((a,b)=>order(a.id,b.id)),
    member_accounts:[...value.member_accounts].sort((a,b)=>order(a.app,b.app)||order(a.external_id,b.external_id)),
    member_chats:[...value.member_chats].sort((a,b)=>order(a.member_id,b.member_id)||order(a.chat_id,b.chat_id)),
    daily_messages:value.daily_messages.map(row=>({daily_messages:row.daily_messages}))};
}
/** The members of a snapshot, checked row by row against its own chats: each switch names a group. */
function snapshotMembers(c:Record<string,unknown>,directory:ChatDirectory):void {
  const ids=new Set<string>(),accounts=new Set<string>(),switches=new Set<string>();
  for(const item of c.members as unknown[]) {
    const row=exact(item,['id','state','group_talk','group_jobs','group_post_other','group_tools','tasks','private_chat']),id=identifier(row.id,ID);
    if(ids.has(id)||!(memberStates as readonly unknown[]).includes(row.state)||!(memberTaskModes as readonly unknown[]).includes(row.tasks)||
      [row.group_talk,row.group_jobs,row.group_post_other,row.group_tools,row.private_chat].some(value=>typeof value!=='boolean'))throw Error('reset_setup_snapshot_invalid');
    ids.add(id);
  }
  for(const item of c.member_accounts as unknown[]) {
    const row=exact(item,['member_id','app','external_id']),key=row.app+'\n'+row.external_id;
    if(!ids.has(row.member_id as string)||row.app!=='telegram'||!isTelegramAccount(row.external_id)||accounts.has(key))throw Error('reset_setup_snapshot_invalid');
    accounts.add(key);
  }
  for(const item of c.member_chats as unknown[]) {
    const row=exact(item,['member_id','chat_id','enabled']),key=row.member_id+'\n'+row.chat_id;
    if(!ids.has(row.member_id as string)||typeof row.chat_id!=='string'||directory.kind(row.chat_id)!=='group'||typeof row.enabled!=='boolean'||switches.has(key))
      throw Error('reset_setup_snapshot_invalid');
    switches.add(key);
  }
  const daily=c.daily_messages as unknown[];
  if(daily.length!==1)throw Error('reset_setup_snapshot_invalid');
  const cap=exact(daily[0],['daily_messages']).daily_messages;
  if(typeof cap!=='number'||!Number.isSafeInteger(cap)||cap<DAILY_MESSAGES_MIN||cap>DAILY_MESSAGES_MAX)throw Error('reset_setup_snapshot_invalid');
}

/** Validate the content-free setup projection captured before erasure. */
export function resetSetupSnapshot(input:unknown):SetupSnapshot {
  const snapshot=exact(input,['format','layout','configuration']);
  if(snapshot.format!==VERSION_3||snapshot.layout!=='original-only-v1')throw Error('reset_setup_snapshot_invalid');
  const c=exact(snapshot.configuration,[...SETUP_TABLES,...CHAT_TABLES,...MEMBER_TABLES]);
  for(const value of Object.values(c))if(!Array.isArray(value)||value.length>10000)throw Error('reset_setup_snapshot_invalid');
  if((c.security_policy as unknown[]).length!==1||(c.installation_generation as unknown[]).length!==1||
    (c.guard_mode as unknown[]).length!==1||(c.runtime_configuration as unknown[]).length!==1)throw Error('reset_setup_snapshot_invalid');
  const security=exact((c.security_policy as unknown[])[0],['document']);validatePolicy(security.document);
  const generation=exact((c.installation_generation as unknown[])[0],['generation']);identifier(generation.generation,UUID);
  const guard=exact((c.guard_mode as unknown[])[0],['mode']);if(!['on','off'].includes(String(guard.mode)))throw Error('reset_setup_snapshot_invalid');
  const runtime=exact((c.runtime_configuration as unknown[])[0],['name','document']);if(runtime.name!=='assistant')throw Error('reset_setup_snapshot_invalid');
  const assistant=policy(runtime.document);const owner=assistant.owner_id;if(!owner)throw Error('reset_setup_owner_required');
  // What each value names comes from the snapshot's own chats, never from this process's directory or an id's shape.
  const directory=snapshotDirectory(snapshot as unknown as SetupSnapshot);
  snapshotMembers(c,directory);
  const projects=new Set<string>();
  for(const item of c.projects as unknown[]) {const row=exact(item,['id','name','description','state']),id=identifier(row.id,ID);
    text(row.name,200);if(typeof row.description!=='string'||Buffer.byteLength(row.description)>4000||!['active','archived'].includes(String(row.state))||
      projects.has(id))throw Error('reset_setup_snapshot_invalid');projects.add(id);}
  const assignments=new Set<string>();
  for(const item of c.project_assignments as unknown[]) {const row=exact(item,['space_id','project_id','mode']),space=validateSpace(row.space_id),mode=String(row.mode);
    // A private chat never joins a project (ADR-0242), and a topic always follows its group's (ADR-0247).
    if(assignments.has(space)||!['assigned','none','inherit'].includes(mode)||directory.kind(space)==='topic'&&mode!=='inherit'||
      (mode==='assigned'?(typeof row.project_id!=='string'||!projects.has(row.project_id)||!directory.isGroup(space)):row.project_id!==null))
      throw Error('reset_setup_snapshot_invalid');assignments.add(space);}
  const rules=new Set<string>();
  for(const item of c.sharing_rules as unknown[]) {const row=exact(item,['id','name','sources','destination','enabled','mode','instructions']),id=identifier(row.id,ID);
    if(rules.has(id)||typeof row.name!=='string'||Buffer.byteLength(row.name)>200||typeof row.instructions!=='string'||Buffer.byteLength(row.instructions)>4000||
      typeof row.enabled!=='boolean'||!['approved','filtered'].includes(String(row.mode))||!Array.isArray(row.sources)||row.sources.length>100)throw Error('reset_setup_snapshot_invalid');
    // A rule never reads from or shares into a private chat (ADR-0242).
    const sources=row.sources.map(validateSpace),destination=validateSpace(row.destination);
    if(sources.join('\0')!==[...new Set(sources)].sort().join('\0')||sources.includes(destination)||row.enabled&&!sources.length||![...sources,destination].every(space=>directory.isGroup(space)))
      throw Error('reset_setup_snapshot_invalid');rules.add(id);}
  const destinations=new Set<string>();for(const item of c.memory_access_settings as unknown[]) {const row=exact(item,['destination','suggestions','notify_owner','auto_followup','request_ttl_seconds','default_grant_mode']);
    const destination=row.destination==='*'?'*':validateSpace(row.destination);if(destinations.has(destination)||row.suggestions!==null&&!['related','off'].includes(String(row.suggestions))||
      row.notify_owner!==null&&typeof row.notify_owner!=='boolean'||row.auto_followup!==null&&typeof row.auto_followup!=='boolean'||
      row.request_ttl_seconds!==null&&(!Number.isSafeInteger(row.request_ttl_seconds)||Number(row.request_ttl_seconds)<60||Number(row.request_ttl_seconds)>2592000)||
      row.default_grant_mode!==null&&!['one_time','persistent'].includes(String(row.default_grant_mode))||destination==='*'&&Object.values(row).some(value=>value===null))throw Error('reset_setup_snapshot_invalid');destinations.add(destination);}
  if(!destinations.has('*'))throw Error('reset_setup_snapshot_invalid');
  // Tool switches: '*', a chat or a topic; no row means every switch inherits, down to the built-in on.
  const toolSpaces=new Set<string>();
  for(const item of c.chat_tool_settings as unknown[]) {const row=exact(item,['space_id','shell','browser','mcp']);
    if(typeof row.space_id!=='string'||row.space_id!=='*'&&!isChatId(row.space_id)||toolSpaces.has(row.space_id)||
      [row.shell,row.browser,row.mcp].some(value=>value!==null&&typeof value!=='boolean'))throw Error('reset_setup_snapshot_invalid');toolSpaces.add(row.space_id);}
  const profiles=new Set<string>(),names=new Set<string>();
  for(const item of c.runtime_profiles as unknown[]) {const row=exact(item,['id','name','owner_id']),id=identifier(row.id,PROFILE),name=text(row.name,64);
    if(row.owner_id!==owner||profiles.has(id)||names.has(name))throw Error('reset_setup_snapshot_invalid');profiles.add(id);names.add(name);}
  return snapshot as unknown as SetupSnapshot;
}

function profileCommands(input:unknown,snapshot:SetupSnapshot):ProfileCommand[] {
  if(!Array.isArray(input)||input.length!==snapshot.configuration.runtime_profiles.length)throw Error('reset_setup_profiles_invalid');
  const expected=new Map(snapshot.configuration.runtime_profiles.map(row=>[row.id,row]));const seen=new Set<string>();
  return input.map(value=>{const row=exact(value,['id','name','state','expected_revision','operation_id']);const id=identifier(row.id,PROFILE),saved=expected.get(id);
    if(!saved||seen.has(id)||row.name!==saved.name||row.state!=='active'||row.expected_revision!==0||row.operation_id!=='restore-preferences:'+id)
      throw Error('reset_setup_profiles_invalid');seen.add(id);return row as unknown as ProfileCommand;});
}

export async function setupRows(control:pg.Pool|pg.PoolClient) {
  const queries={projects:'SELECT id,name,description,state FROM projects ORDER BY id',
    project_assignments:'SELECT space_id,project_id,mode FROM project_assignments ORDER BY space_id',
    sharing_rules:'SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules ORDER BY id',
    memory_access_settings:'SELECT destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode FROM memory_access_settings ORDER BY destination',
    chat_tool_settings:'SELECT space_id,shell,browser,mcp FROM chat_tool_settings ORDER BY space_id'};
  const result:Record<string,unknown[]>={};for(const [key,sql] of Object.entries(queries))result[key]=(await control.query(sql)).rows;return result;
}

/** Restore current setup only, with a new generation and repository-admitted profiles. */
export async function restoreResetSetup(stores:StorePools,input:{snapshot:unknown;generation:string;reset_id:string;profile_commands:unknown}) {
  exact(input,['snapshot','generation','reset_id','profile_commands']);
  const snapshot=resetSetupSnapshot(input.snapshot),generation=identifier(input.generation,UUID),resetId=identifier(input.reset_id,UUID);
  const old=snapshot.configuration.installation_generation[0]!.generation;if(generation===old)throw Error('reset_setup_generation_reused');
  const commands=profileCommands(input.profile_commands,snapshot),configuration=snapshot.configuration,assistant=configuration.runtime_configuration[0]!.document;
  if(!assistant.owner_id)throw Error('reset_setup_owner_required');
  const existingProfiles=(await stores.control.query('SELECT id,name,owner_id,state,revision FROM runtime_profiles ORDER BY id')).rows;
  const desiredProfiles=new Map(configuration.runtime_profiles.map(row=>[row.id,row]));
  if(existingProfiles.some(row=>{const saved=desiredProfiles.get(row.id);return !saved||row.name!==saved.name||row.owner_id!==saved.owner_id||row.state!=='active'||row.revision!==1;}))
    throw Error('reset_setup_target_not_fresh');
  const db=await stores.control.connect();
  try {
    await db.query('BEGIN');
    const installed=(await db.query('SELECT generation::text AS generation FROM installation WHERE singleton FOR UPDATE')).rows[0];
    const current=await setupRows(db);
    if(!installed||installed.generation===old)throw Error('reset_setup_target_not_fresh');
    if(installed.generation!==generation)await db.query('UPDATE installation SET generation=$1 WHERE singleton',[generation]);
    const runtime=(await db.query(`SELECT c.name,v.document FROM runtime_configuration c JOIN runtime_configuration_versions v USING(name,revision) ORDER BY c.name`)).rows;
    const documents=(rows:{name:string;document:AssistantPolicy}[])=>rows.map(row=>({name:row.name,document:admittedDocument(row.document)}));
    if(runtime.length&&!same(documents(runtime),documents(configuration.runtime_configuration)))throw Error('reset_setup_target_changed');
    if(!runtime.length) {
      const document=admittedDocument(assistant);
      await db.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)",[JSON.stringify(document),digest(canonical(document))]);
      await db.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
    }
    const guard=(await db.query('SELECT mode FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
    if(!guard)throw Error('reset_setup_target_changed');if(guard.mode!==configuration.guard_mode[0]!.mode)await db.query('UPDATE guard_state SET mode=$1 WHERE singleton',[configuration.guard_mode[0]!.mode]);
    const savedPolicy=(await db.query('SELECT p.revision,v.document FROM security_policy p JOIN security_policy_versions v USING(revision) FOR UPDATE OF p')).rows[0];
    if(!savedPolicy)throw Error('reset_setup_target_changed');const desired=configuration.security_policy[0]!.document;
    if(!same(savedPolicy.document,desired)) {if(Number(savedPolicy.revision)!==1)throw Error('reset_setup_target_changed');
      const revision=(await db.query("INSERT INTO security_policy_versions(document,actor) VALUES($1,'reset') RETURNING revision",[JSON.stringify(desired)])).rows[0].revision;
      await db.query('UPDATE security_policy SET revision=$1',[revision]);}
    // The schema's seeded row: a fresh install starts with automatic follow-up off (ADR-0242).
    const defaultAccess=[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:false,request_ttl_seconds:86400,default_grant_mode:'one_time'}];
    if(!same(current.memory_access_settings,defaultAccess)&&!same(current.memory_access_settings,configuration.memory_access_settings))throw Error('reset_setup_target_changed');
    for(const [name,rows] of Object.entries(current))if(name!=='memory_access_settings'&&(rows as unknown[]).length&&!same(rows,(configuration as any)[name]))throw Error('reset_setup_target_changed');
    // The chats come first, each with its own id and app ids, so every value below names the same chat (ADR-0252).
    const existingChats=await chatRows(db),desiredChats=restoredChats(configuration);
    if((existingChats.chats.length||existingChats.chat_ids.length)&&!same(existingChats,desiredChats))throw Error('reset_setup_target_changed');
    if(!existingChats.chats.length&&desiredChats.chats.length) {
      const connections=new Map<string,string>();
      for(const app of new Set([...desiredChats.chats.map(row=>row.app),...desiredChats.chat_ids.map(row=>row.app)]))connections.set(app,await ensureConnection(db,app));
      for(const row of [...desiredChats.chats.filter(chat=>chat.kind!=='topic'),...desiredChats.chats.filter(chat=>chat.kind==='topic')])
        await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,app_type,title,title_source,is_forum,state,added_by_role,state_changed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'seeded',now())`,[row.id,connections.get(row.app),row.kind,row.parent_id,row.topic_key,row.app_type,row.title,
            row.title_source,row.is_forum,row.state]);
      for(const row of desiredChats.chat_ids)await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,$4,$5)`,
        [connections.get(row.app),row.external_id,row.chat_id,row.state,row.reason]);
      await bumpChatRevision(db);
    }
    // The members, once their groups' chats are there: each account made as Nocheh first records it (ensureAccount) and
    // linked to its member, the switches, the daily cap, and the carry's marker, so the lists from before step 3 are
    // never carried over them (step 3).
    const existingMembers=await memberRows(db),desiredMembers=sortedMembers(configuration);
    const untouched=!existingMembers.members.length&&!existingMembers.member_accounts.length&&!existingMembers.member_chats.length&&
      same(existingMembers.daily_messages,[{daily_messages:DAILY_MESSAGES_DEFAULT}]);
    if(!same(existingMembers,desiredMembers)) {
      if(!untouched)throw Error('reset_setup_target_changed');
      for(const row of desiredMembers.members)await db.query(`INSERT INTO members(id,state,group_talk,group_jobs,group_post_other,group_tools,tasks,private_chat)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,row.state,row.group_talk,row.group_jobs,row.group_post_other,row.group_tools,row.tasks,row.private_chat]);
      for(const row of desiredMembers.member_accounts) {
        const account=await ensureAccount(db,await ensureConnection(db,row.app),{external:row.external_id},row.app);
        await db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1 AND member_id IS NULL',[account,row.member_id]);
      }
      for(const row of desiredMembers.member_chats)await db.query('INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,$3)',
        [row.member_id,row.chat_id,row.enabled]);
      await db.query('UPDATE member_directory_state SET daily_messages=$1 WHERE singleton',[desiredMembers.daily_messages[0]!.daily_messages]);
      await bumpMemberRevision(db);
    }
    await db.query('UPDATE member_directory_state SET carried_at=coalesce(carried_at,now()) WHERE singleton');
    // No preview or release of a rule is restored, so revision 1 is safe.
    for(const row of configuration.projects)await db.query('INSERT INTO projects(id,name,description,state,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING',
      [row.id,row.name,row.description,row.state]);
    for(const row of configuration.project_assignments)await db.query('INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING',
      [row.space_id,row.project_id,row.mode]);
    for(const row of configuration.sharing_rules)await db.query('INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT DO NOTHING',
      [row.id,row.name,JSON.stringify(row.sources),row.destination,row.enabled,row.mode,row.instructions]);
    for(const row of configuration.memory_access_settings)await db.query(`INSERT INTO memory_access_settings(destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode,revision)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(destination) DO UPDATE SET suggestions=$2,notify_owner=$3,auto_followup=$4,request_ttl_seconds=$5,default_grant_mode=$6,revision=1,updated_at=now()`,
      [row.destination,row.suggestions,row.notify_owner,row.auto_followup,row.request_ttl_seconds,row.default_grant_mode]);
    for(const row of configuration.chat_tool_settings)await db.query('INSERT INTO chat_tool_settings(space_id,shell,browser,mcp,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING',
      [row.space_id,row.shell,row.browser,row.mcp]);
    const updated=await setupRows(db);for(const name of Object.keys(updated))if(!same(updated[name],(configuration as any)[name]))throw Error('reset_setup_target_changed');
    if(!same(await chatRows(db),desiredChats)||!same(await memberRows(db),desiredMembers))throw Error('reset_setup_target_changed');
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
  const archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const access=new SourceAccessRepository(stores,archive,guards,()=>({...admittedDocument(assistant),group_ids:[]})),profiles=new RuntimeProfileRepository(access),owner={admin:true,scope:null};
  const admitted=[];for(const command of commands)admitted.push(await profiles.save(owner,command));
  const restored=await setupRows(stores.control),runtimeProfiles=(await stores.control.query('SELECT id,name,owner_id FROM runtime_profiles WHERE state=\'active\' ORDER BY id')).rows;
  if(!same(restored.projects,configuration.projects)||!same(restored.project_assignments,configuration.project_assignments)||
    !same(restored.sharing_rules,configuration.sharing_rules)||!same(restored.memory_access_settings,configuration.memory_access_settings)||
    !same(restored.chat_tool_settings,configuration.chat_tool_settings)||!same(runtimeProfiles,configuration.runtime_profiles)||
    !same(await chatRows(stores.control),restoredChats(configuration))||!same(await memberRows(stores.control),sortedMembers(configuration)))
    throw Error('reset_setup_verification_failed');
  const binding=await guards.state();if(binding.generation!==generation||binding.mode!==configuration.guard_mode[0]!.mode)throw Error('reset_setup_verification_failed');
  return {reset_id:resetId,generation,binding,configuration_records:Object.values(configuration).reduce((count,rows)=>count+rows.length,0),
    projects:configuration.projects.length,assignments:configuration.project_assignments.length,sharing_rules:configuration.sharing_rules.length,memory_access_settings:configuration.memory_access_settings.length,
    chats:configuration.chats.length,members:configuration.members.length,profiles:admitted,source_content_copied:false,history_copied:false};
}
