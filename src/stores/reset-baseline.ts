import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {families} from '../workflows/store.js';
import type {StorePools} from './connections.js';
import {storeSchemas} from './schema.js';
import {resetSetupSnapshot} from './reset-setup.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(value:unknown,keys:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))
    throw Error('reset_baseline_request_invalid');
  return value as Record<string,unknown>;
};
const same=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
const tables=(schema:string)=>[...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/g)].map(match=>match[1]!).sort();

async function counts(pool:pg.Pool,schema:keyof typeof storeSchemas) {
  const expected=tables(storeSchemas[schema]);
  const actual=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map(row=>row.tablename);
  if(!same(actual,expected))throw Error('reset_baseline_schema_changed');
  const result:Record<string,number>={};
  for(const table of expected)result[table]=Number((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count);
  return result;
}

function only(value:Record<string,number>,allowed:Record<string,number|number[]>) {
  for(const [table,count] of Object.entries(value)) {
    const expected=allowed[table]??0,accepted=Array.isArray(expected)?expected:[expected];
    if(!accepted.includes(count))throw Error('reset_baseline_not_empty');
  }
}

/** Prove that fresh stores contain setup only and no pre-reset content/history. */
export async function verifyResetBaseline(stores:StorePools,input:unknown) {
  const request=exact(input,['snapshot','generation','reset_id','profile_commands']);
  const snapshot=resetSetupSnapshot(request.snapshot),generation=request.generation;
  if(typeof generation!=='string'||!UUID.test(generation)||typeof request.reset_id!=='string'||!UUID.test(request.reset_id))
    throw Error('reset_baseline_request_invalid');
  if(!Array.isArray(request.profile_commands))throw Error('reset_baseline_request_invalid');
  const configuration=snapshot.configuration,profileCount=configuration.runtime_profiles.length;
  const [archive,derived,control]=await Promise.all([counts(stores.archive,'archive'),counts(stores.derived,'derived'),counts(stores.control,'control')]);
  only(archive,{});only(derived,{});
  only(control,{installation:1,guard_state:1,capture_reconciliation:1,memory_engine_connection:1,
    security_policy:1,security_policy_versions:[1,2],runtime_configuration:1,runtime_configuration_versions:1,
    workflow_owners:families.length,projects:configuration.projects.length,
    project_assignments:configuration.project_assignments.length,sharing_rules:configuration.sharing_rules.length,
    runtime_profiles:profileCount,owner_commands:profileCount,workflow_registry:profileCount*2,workflow_outbox:profileCount*2});
  const installed=(await stores.control.query('SELECT generation::text AS generation FROM installation WHERE singleton')).rows;
  if(!same(installed,[{generation}]))throw Error('reset_baseline_generation_changed');
  const guard=(await stores.control.query('SELECT epoch::int AS epoch,mode FROM guard_state WHERE singleton')).rows;
  if(!same(guard,[{epoch:1+profileCount,mode:configuration.guard_mode[0]!.mode}]))throw Error('reset_baseline_setup_changed');
  const runtime=(await stores.control.query(`SELECT c.name,v.document FROM runtime_configuration c
    JOIN runtime_configuration_versions v USING(name,revision) ORDER BY c.name`)).rows;
  if(!same(runtime,configuration.runtime_configuration))throw Error('reset_baseline_setup_changed');
  const runtimeHistory=(await stores.control.query('SELECT name,revision,document,fingerprint FROM runtime_configuration_versions ORDER BY name,revision')).rows;
  const assistant=configuration.runtime_configuration[0]!;
  if(!same(runtimeHistory,[{name:'assistant',revision:1,document:assistant.document,fingerprint:digest(canonical(assistant.document))}]))
    throw Error('reset_baseline_setup_changed');
  const security=(await stores.control.query(`SELECT v.document FROM security_policy p
    JOIN security_policy_versions v USING(revision)`)).rows;
  if(!same(security,configuration.security_policy))throw Error('reset_baseline_setup_changed');
  const desiredPolicy=configuration.security_policy[0]!.document,defaultPolicy={version:1,rules:[]};
  const securityHistory=(await stores.control.query('SELECT revision::int AS revision,document,actor FROM security_policy_versions ORDER BY revision')).rows;
  const expectedSecurity=same(desiredPolicy,defaultPolicy)?[{revision:1,document:defaultPolicy,actor:'owner'}]:
    [{revision:1,document:defaultPolicy,actor:'owner'},{revision:2,document:desiredPolicy,actor:'reset'}];
  if(!same(securityHistory,expectedSecurity))throw Error('reset_baseline_setup_changed');
  const setupRows={
    projects:(await stores.control.query('SELECT id,name,description,state FROM projects ORDER BY id')).rows,
    project_assignments:(await stores.control.query('SELECT space_id,project_id,mode FROM project_assignments ORDER BY space_id')).rows,
    sharing_rules:(await stores.control.query('SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules ORDER BY id')).rows,
    runtime_profiles:(await stores.control.query("SELECT id,name,owner_id FROM runtime_profiles WHERE state='active' ORDER BY id")).rows};
  for(const [name,rows] of Object.entries(setupRows))if(!same(rows,(configuration as any)[name]))throw Error('reset_baseline_setup_changed');
  const commands=request.profile_commands as any[];
  const owner=configuration.runtime_configuration[0]!.document.owner_id;
  const ownerCommands=(await stores.control.query("SELECT id,request_hash,result,epoch::int AS epoch FROM owner_commands ORDER BY id")).rows;
  const expectedCommands=commands.map((command,index)=>({id:command.operation_id,
    request_hash:digest(canonical({kind:'runtime_profile',id:command.id,name:command.name,state:'active',expected:0,owner})),
    result:{id:command.id,name:command.name,state:'active',revision:1,owner_id:owner},epoch:index+2})).sort((a,b)=>a.id.localeCompare(b.id));
  if(!same(ownerCommands,expectedCommands))throw Error('reset_baseline_setup_changed');
  const workflows=(await stores.control.query(`SELECT family,job_id,generation,state,stage,attempts,owner_epoch,lease_token
    FROM workflow_registry ORDER BY family,generation`)).rows;
  const expectedWorkflows=commands.flatMap((_command,index)=>['honcho','memory_review'].map(family=>({family,job_id:'refresh',generation:index+2,
    state:'queued',stage:'admission',attempts:0,owner_epoch:null,lease_token:null}))).sort((a,b)=>a.family.localeCompare(b.family)||a.generation-b.generation);
  if(!same(workflows,expectedWorkflows))throw Error('reset_baseline_setup_changed');
  const outbox=(await stores.control.query('SELECT attempts,failures,published_at,lease_token,error_code FROM workflow_outbox')).rows;
  if(outbox.some(row=>row.attempts!==0||row.failures!==0||row.published_at!==null||row.lease_token!==null||row.error_code!==null))
    throw Error('reset_baseline_setup_changed');
  const owners=(await stores.control.query('SELECT family,owner,epoch,admission FROM workflow_owners ORDER BY family')).rows;
  if(!same(owners,[...families].sort().map(family=>({family,owner:'inngest',epoch:1,admission:true}))))throw Error('reset_baseline_setup_changed');
  const memory=(await stores.control.query('SELECT attached,verified,include_history,revision FROM memory_engine_connection WHERE singleton')).rows;
  if(!same(memory,[{attached:false,verified:false,include_history:false,revision:0}]))throw Error('reset_baseline_setup_changed');
  const reconciliation=(await stores.control.query('SELECT after_sequence::int AS after_sequence FROM capture_reconciliation WHERE singleton')).rows;
  if(!same(reconciliation,[{after_sequence:0}]))throw Error('reset_baseline_setup_changed');
  return {generation,archive_rows:Object.values(archive).reduce((a,b)=>a+b,0),
    derived_rows:Object.values(derived).reduce((a,b)=>a+b,0),control_setup_rows:Object.values(control).reduce((a,b)=>a+b,0),
    profiles:profileCount,setup_only:true,source_content_present:false,derivative_content_present:false,history_present:false};
}
