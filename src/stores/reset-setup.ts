import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {groupAccess,type GroupAccess} from '../assistant-policy.js';
import {validatePolicy} from '../security/contract.js';
import {validateSpace} from '../spaces.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository} from './archive.js';
import {GuardRepository} from './guards.js';
import {SourceAccessRepository} from './access.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';

type AssistantPolicy={enabled:boolean;owner_id:string|null;group_ids:string[];group_access?:Record<string,GroupAccess>};
type SetupSnapshot={format:'nocheh-reset-configuration-v1';layout:'original-only-v1';configuration:{
  security_policy:{document:unknown}[];installation_generation:{generation:string}[];
  guard_mode:{mode:'on'|'off'}[];runtime_configuration:{name:'assistant';document:AssistantPolicy}[];
  projects:{id:string;name:string;description:string;state:'active'|'archived'}[];
  project_assignments:{space_id:string;project_id:string|null;mode:'assigned'|'none'|'inherit'}[];
  sharing_rules:{id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string}[];
  memory_access_settings:{destination:string;suggestions:'related'|'off'|null;notify_owner:boolean|null;auto_followup:boolean|null;request_ttl_seconds:number|null;default_grant_mode:'one_time'|'persistent'|null}[];
  runtime_profiles:{id:string;name:string;owner_id:string}[];
}};
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
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('reset_setup_snapshot_invalid');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!['enabled','owner_id','group_ids','group_access'].includes(key))||
    !['enabled','owner_id','group_ids'].every(key=>key in row))throw Error('reset_setup_snapshot_invalid');
  if(typeof row.enabled!=='boolean'||row.owner_id!==null&&(typeof row.owner_id!=='string'||!/^[1-9]\d{0,18}$/.test(row.owner_id))||
    !Array.isArray(row.group_ids)||row.group_ids.some(id=>typeof id!=='string'||!/^-[1-9]\d{0,18}$/.test(id))||
    row.group_ids.join('\0')!==[...new Set(row.group_ids)].sort().join('\0')||row.enabled&&!row.owner_id)
    throw Error('reset_setup_snapshot_invalid');
  try {groupAccess(row.group_access??{},row.group_ids as string[],row.owner_id as string|null);}catch {throw Error('reset_setup_snapshot_invalid');}
  return row as unknown as AssistantPolicy;
}

/** Validate the content-free setup projection captured before erasure. */
export function resetSetupSnapshot(input:unknown):SetupSnapshot {
  const snapshot=exact(input,['format','layout','configuration']);
  if(snapshot.format!=='nocheh-reset-configuration-v1'||snapshot.layout!=='original-only-v1')throw Error('reset_setup_snapshot_invalid');
  const c=exact(snapshot.configuration,['security_policy','installation_generation','guard_mode','runtime_configuration',
    'projects','project_assignments','sharing_rules','memory_access_settings','runtime_profiles']);
  for(const value of Object.values(c))if(!Array.isArray(value)||value.length>10000)throw Error('reset_setup_snapshot_invalid');
  if((c.security_policy as unknown[]).length!==1||(c.installation_generation as unknown[]).length!==1||
    (c.guard_mode as unknown[]).length!==1||(c.runtime_configuration as unknown[]).length!==1)throw Error('reset_setup_snapshot_invalid');
  const security=exact((c.security_policy as unknown[])[0],['document']);validatePolicy(security.document);
  const generation=exact((c.installation_generation as unknown[])[0],['generation']);identifier(generation.generation,UUID);
  const guard=exact((c.guard_mode as unknown[])[0],['mode']);if(!['on','off'].includes(String(guard.mode)))throw Error('reset_setup_snapshot_invalid');
  const runtime=exact((c.runtime_configuration as unknown[])[0],['name','document']);if(runtime.name!=='assistant')throw Error('reset_setup_snapshot_invalid');
  const assistant=policy(runtime.document);const owner=assistant.owner_id;if(!owner)throw Error('reset_setup_owner_required');
  const projects=new Set<string>();
  for(const item of c.projects as unknown[]) {const row=exact(item,['id','name','description','state']),id=identifier(row.id,ID);
    text(row.name,200);if(typeof row.description!=='string'||Buffer.byteLength(row.description)>4000||!['active','archived'].includes(String(row.state))||projects.has(id))throw Error('reset_setup_snapshot_invalid');projects.add(id);}
  const assignments=new Set<string>();
  for(const item of c.project_assignments as unknown[]) {const row=exact(item,['space_id','project_id','mode']),space=validateSpace(row.space_id),mode=String(row.mode);
    if(assignments.has(space)||!['assigned','none','inherit'].includes(mode)||
      (mode==='assigned'?(typeof row.project_id!=='string'||!projects.has(row.project_id)):row.project_id!==null))
      throw Error('reset_setup_snapshot_invalid');assignments.add(space);}
  const rules=new Set<string>();
  for(const item of c.sharing_rules as unknown[]) {const row=exact(item,['id','name','sources','destination','enabled','mode','instructions']),id=identifier(row.id,ID);
    if(rules.has(id)||typeof row.name!=='string'||Buffer.byteLength(row.name)>200||typeof row.instructions!=='string'||Buffer.byteLength(row.instructions)>4000||
      typeof row.enabled!=='boolean'||!['approved','filtered'].includes(String(row.mode))||!Array.isArray(row.sources)||row.sources.length>100)throw Error('reset_setup_snapshot_invalid');
    const sources=row.sources.map(validateSpace);if(sources.join('\0')!==[...new Set(sources)].sort().join('\0')||sources.includes(validateSpace(row.destination))||row.enabled&&!sources.length)throw Error('reset_setup_snapshot_invalid');rules.add(id);}
  const destinations=new Set<string>();for(const item of c.memory_access_settings as unknown[]) {const row=exact(item,['destination','suggestions','notify_owner','auto_followup','request_ttl_seconds','default_grant_mode']);
    const destination=row.destination==='*'?'*':validateSpace(row.destination);if(destinations.has(destination)||row.suggestions!==null&&!['related','off'].includes(String(row.suggestions))||
      row.notify_owner!==null&&typeof row.notify_owner!=='boolean'||row.auto_followup!==null&&typeof row.auto_followup!=='boolean'||
      row.request_ttl_seconds!==null&&(!Number.isSafeInteger(row.request_ttl_seconds)||Number(row.request_ttl_seconds)<60||Number(row.request_ttl_seconds)>2592000)||
      row.default_grant_mode!==null&&!['one_time','persistent'].includes(String(row.default_grant_mode))||destination==='*'&&Object.values(row).some(value=>value===null))throw Error('reset_setup_snapshot_invalid');destinations.add(destination);}
  if(!destinations.has('*'))throw Error('reset_setup_snapshot_invalid');
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

async function setupRows(control:pg.Pool|pg.PoolClient) {
  const queries={projects:'SELECT id,name,description,state FROM projects ORDER BY id',
    project_assignments:'SELECT space_id,project_id,mode FROM project_assignments ORDER BY space_id',
    sharing_rules:'SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules ORDER BY id',
    memory_access_settings:'SELECT destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode FROM memory_access_settings ORDER BY destination'};
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
    if(runtime.length&&!same(runtime,configuration.runtime_configuration))throw Error('reset_setup_target_changed');
    if(!runtime.length) {
      await db.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)",[JSON.stringify(assistant),digest(canonical(assistant))]);
      await db.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
    }
    const guard=(await db.query('SELECT mode FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
    if(!guard)throw Error('reset_setup_target_changed');if(guard.mode!==configuration.guard_mode[0]!.mode)await db.query('UPDATE guard_state SET mode=$1 WHERE singleton',[configuration.guard_mode[0]!.mode]);
    const savedPolicy=(await db.query('SELECT p.revision,v.document FROM security_policy p JOIN security_policy_versions v USING(revision) FOR UPDATE OF p')).rows[0];
    if(!savedPolicy)throw Error('reset_setup_target_changed');const desired=configuration.security_policy[0]!.document;
    if(!same(savedPolicy.document,desired)) {if(Number(savedPolicy.revision)!==1)throw Error('reset_setup_target_changed');
      const revision=(await db.query("INSERT INTO security_policy_versions(document,actor) VALUES($1,'reset') RETURNING revision",[JSON.stringify(desired)])).rows[0].revision;
      await db.query('UPDATE security_policy SET revision=$1',[revision]);}
    const defaultAccess=[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:true,request_ttl_seconds:86400,default_grant_mode:'one_time'}];
    if(!same(current.memory_access_settings,defaultAccess)&&!same(current.memory_access_settings,configuration.memory_access_settings))throw Error('reset_setup_target_changed');
    for(const [name,rows] of Object.entries(current))if(name!=='memory_access_settings'&&(rows as unknown[]).length&&!same(rows,(configuration as any)[name]))throw Error('reset_setup_target_changed');
    for(const row of configuration.projects)await db.query('INSERT INTO projects(id,name,description,state,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING',[row.id,row.name,row.description,row.state]);
    for(const row of configuration.project_assignments)await db.query('INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING',[row.space_id,row.project_id,row.mode]);
    for(const row of configuration.sharing_rules)await db.query('INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT DO NOTHING',
      [row.id,row.name,JSON.stringify(row.sources),row.destination,row.enabled,row.mode,row.instructions]);
    for(const row of configuration.memory_access_settings)await db.query(`INSERT INTO memory_access_settings(destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode,revision)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(destination) DO UPDATE SET suggestions=$2,notify_owner=$3,auto_followup=$4,request_ttl_seconds=$5,default_grant_mode=$6,revision=1,updated_at=now()`,
      [row.destination,row.suggestions,row.notify_owner,row.auto_followup,row.request_ttl_seconds,row.default_grant_mode]);
    const updated=await setupRows(db);for(const name of Object.keys(updated))if(!same(updated[name],(configuration as any)[name]))throw Error('reset_setup_target_changed');
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
  const archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const access=new SourceAccessRepository(stores,archive,guards,()=>assistant),profiles=new RuntimeProfileRepository(access),owner={admin:true,scope:null};
  const admitted=[];for(const command of commands)admitted.push(await profiles.save(owner,command));
  const restored=await setupRows(stores.control),runtimeProfiles=(await stores.control.query('SELECT id,name,owner_id FROM runtime_profiles WHERE state=\'active\' ORDER BY id')).rows;
  if(!same(restored.projects,configuration.projects)||!same(restored.project_assignments,configuration.project_assignments)||
    !same(restored.sharing_rules,configuration.sharing_rules)||!same(restored.memory_access_settings,configuration.memory_access_settings)||!same(runtimeProfiles,configuration.runtime_profiles))throw Error('reset_setup_verification_failed');
  const binding=await guards.state();if(binding.generation!==generation||binding.mode!==configuration.guard_mode[0]!.mode)throw Error('reset_setup_verification_failed');
  return {reset_id:resetId,generation,binding,configuration_records:Object.values(configuration).reduce((count,rows)=>count+rows.length,0),
    projects:configuration.projects.length,assignments:configuration.project_assignments.length,sharing_rules:configuration.sharing_rules.length,memory_access_settings:configuration.memory_access_settings.length,
    profiles:admitted,source_content_copied:false,history_copied:false};
}
