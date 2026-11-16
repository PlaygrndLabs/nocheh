import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,storeNames,type StorePasswords} from '../src/stores/connections.js';
import {storeSchemas} from '../src/stores/schema.js';
import {resetSetupSnapshot,restoreResetSetup} from '../src/stores/reset-setup.js';
import {verifyResetBaseline} from '../src/stores/reset-baseline.js';
import {chatRows,sortedChats} from '../src/stores/reset-setup.js';
import {ChatSeeder} from '../src/stores/chat-seed.js';
import {accountIdFor,chatDirectory,chatIdFor} from '../src/chats.js';
import {loadChatSnapshot} from '../src/stores/chats.js';
import {NG2,NG2_OLD_TG,NG2_TG} from './fixture-groups.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000};
/** Empty stores in a schema of their own, with the grants the services have. */
async function freshStores() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const schema='reset_setup_'+randomUUID().replaceAll('-','');
  for(const name of storeNames) {
    const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema} AUTHORIZATION nocheh_${name}_owner; SET search_path=${schema},pg_catalog; SET ROLE nocheh_${name}_owner`);
      await db.query(storeSchemas[name]);
      if(name==='control')await db.query('INSERT INTO installation(singleton,generation) VALUES(true,$1)',['33333333-3333-4333-8333-333333333333']);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO nocheh_${name}; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA ${schema} TO nocheh_${name}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO nocheh_${name}`);
      if(name==='archive')await db.query('GRANT UPDATE(file_hash,byte_size) ON artifacts TO nocheh_archive');
      else if(name==='derived')await db.query('GRANT UPDATE(active_revision,state) ON guard_sources TO nocheh_derived; GRANT UPDATE(active_revision,imported) ON derivative_selections,learned_entries TO nocheh_derived');
      else await db.query(`GRANT UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO nocheh_control`);
    } finally {await db.end();}
  }
  const stores=connectStores({...config,options:'-c search_path='+schema+',pg_catalog'},passwords);
  return {config,schema,stores,drop:async()=>{
    await stores.close();
    for(const name of storeNames){const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();try{await db.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await db.end();}}
  }};
}

test('reset setup restores only current configuration under a new generation and replays exactly',fixture,async()=>{
  const {config,schema,stores,drop}=await freshStores(),profile='profile-'+'c'.repeat(48);
  const snapshot={format:'nocheh-reset-configuration-v1',layout:'original-only-v1',configuration:{
    security_policy:[{document:{version:1,rules:[{id:'fixture-deny-shell',kind:'shell',outcome:'deny'}]}}],
    installation_generation:[{generation:'11111111-1111-4111-8111-111111111111'}],guard_mode:[{mode:'off'}],
    runtime_configuration:[{name:'assistant',document:{enabled:true,owner_id:'123',group_ids:['-1001','-1002']}}],
    projects:[{id:'a'.repeat(64),name:'Saved project',description:'Configuration only',state:'archived'}],
    // A topic follows its group's project, so its only row says so (ADR-0247).
    project_assignments:[{space_id:'-1001',project_id:'a'.repeat(64),mode:'assigned'},{space_id:'-1001/topic/3',project_id:null,mode:'inherit'},{space_id:'-1002',project_id:'a'.repeat(64),mode:'assigned'}],
    sharing_rules:[{id:'b'.repeat(64),name:'Saved share',sources:['-1001'],destination:'-1002',enabled:true,mode:'approved',instructions:'Share only approved text'}],
    // A fresh install starts with automatic follow-up off; the owner's saved choice comes back over it.
    memory_access_settings:[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:true,request_ttl_seconds:86400,default_grant_mode:'one_time'}],
    chat_tool_settings:[{space_id:'*',shell:false,browser:null,mcp:null},{space_id:'-1001/topic/3',shell:null,browser:null,mcp:false}],
    runtime_profiles:[{id:profile,name:'research',owner_id:'123'}]}} as const;
  const input={snapshot,generation:'22222222-2222-4222-8222-222222222222',reset_id:'44444444-4444-4444-8444-444444444444',
    profile_commands:[{id:profile,name:'research',state:'active',expected_revision:0,operation_id:'restore-preferences:'+profile}]};
  try {
    assert.deepEqual(resetSetupSnapshot(snapshot),snapshot);
    // A project never shares between its groups: a snapshot that still carries the share box is refused (ADR-0247).
    const [project]=snapshot.configuration.projects,[assigned]=snapshot.configuration.project_assignments,[ownerRule]=snapshot.configuration.sharing_rules;
    for(const configuration of [{projects:[{...project,sharing_enabled:false}]},{projects:[{...project,sharing_mode:'filtered'}]},
      {project_assignments:[{...assigned,share_into:true}]},{sharing_rules:[{...ownerRule,project_id:null}]}])
      assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,...configuration}}),/snapshot_invalid/,JSON.stringify(configuration));
    // A topic always follows its group's project.
    for(const row of [{space_id:'-1001/topic/3',project_id:'a'.repeat(64),mode:'assigned'},{space_id:'-1001/topic/3',project_id:null,mode:'none'}])
      assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,project_assignments:[assigned,row]}}),/snapshot_invalid/,row.mode);
    // A private chat, the owner's included, never joins a project or a sharing rule (ADR-0242).
    const saved=snapshot.configuration.sharing_rules[0];
    for(const forged of [{...saved,sources:['-1001','123']},{...saved,sources:['123/topic/5']},{...saved,destination:'123'},{...saved,sources:['desktop:personal_chat:9']}])
      assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,sharing_rules:[forged]}}),/snapshot_invalid/,'a rule never names a private chat');
    const assignment={space_id:'123',project_id:'a'.repeat(64),mode:'assigned'};
    assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,project_assignments:[assignment]}}),/snapshot_invalid/,'a private chat never joins a project');
    const keptOut={...snapshot,configuration:{...snapshot.configuration,project_assignments:[{...assignment,project_id:null,mode:'none'}]}};
    assert.deepEqual(resetSetupSnapshot(keptOut),keptOut,'a private chat may be kept out of every project');
    for(const forged of [{space_id:'every',shell:false,browser:null,mcp:null},{space_id:'-1001',shell:'off',browser:null,mcp:null},{space_id:'-1001',shell:null,browser:null}])
      assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,chat_tool_settings:[forged]}}),/snapshot_invalid/,'a tool switch row is exact');
    await assert.rejects(restoreResetSetup(stores,{...input,unexpected:true} as any),/snapshot_invalid/);
    await assert.rejects(restoreResetSetup(stores,{...input,generation:snapshot.configuration.installation_generation[0].generation}),/generation_reused/);
    await assert.rejects(restoreResetSetup(stores,{...input,profile_commands:[{...input.profile_commands[0],operation_id:'forged'}]}),/profiles_invalid/);
    assert.deepEqual((await stores.control.query('SELECT destination,auto_followup FROM memory_access_settings')).rows,[{destination:'*',auto_followup:false}],
      'a fresh install starts with automatic follow-up off');
    const first=await restoreResetSetup(stores,input),again=await restoreResetSetup(stores,input);
    assert.equal((await stores.control.query("SELECT auto_followup FROM memory_access_settings WHERE destination='*'")).rows[0].auto_followup,true);
    assert.deepEqual(again,first);assert.equal(first.generation,input.generation);assert.equal(first.binding.generation,input.generation);
    assert.equal(first.binding.mode,'off');assert.equal(first.binding.epoch,2);assert.equal(first.configuration_records,13);
    assert.equal((await stores.archive.query('SELECT count(*)::int AS count FROM events')).rows[0].count,0);
    assert.equal((await stores.derived.query('SELECT count(*)::int AS count FROM derived_artifacts')).rows[0].count,0);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM owner_commands')).rows[0].count,1);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family IN ('honcho','memory_review')")).rows[0].count,2);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM security_policy_versions')).rows[0].count,2);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM runtime_configuration_versions')).rows[0].count,1);
    assert.deepEqual((await stores.control.query('SELECT space_id,shell,browser,mcp,revision FROM chat_tool_settings ORDER BY space_id')).rows,
      snapshot.configuration.chat_tool_settings.map(row=>({...row,revision:1})),'the tool switches come back as saved');
    const baseline=await verifyResetBaseline(stores,input);
    assert.equal(baseline.generation,input.generation);assert.equal(baseline.archive_rows,0);assert.equal(baseline.derived_rows,0);
    // Schema comments are not tables, but an unexpected real table must still
    // block acceptance even when it contains no data.
    const extra=new pg.Client({...config,database:'nocheh_control'});await extra.connect();
    try {
      await extra.query(`SET search_path=${schema},pg_catalog; SET ROLE nocheh_control_owner; CREATE TABLE unexpected_history(id text)`);
      await assert.rejects(verifyResetBaseline(stores,input),/reset_baseline_schema_changed/);
      await extra.query('DROP TABLE unexpected_history');
      assert.deepEqual(await verifyResetBaseline(stores,input),baseline);
    }finally{await extra.end();}
    await stores.derived.query(`INSERT INTO derived_artifacts(id,kind,content,content_hash,provenance,source_revision,input_hash,
      producer,producer_version,configuration_hash,operation_id,operation_reference) VALUES($1,'runtime_context','x',$2,'{}','1',$2,'fixture','1',$2,'fixture',$3)`,
      ['e'.repeat(64),digest('x'),{store:'control',kind:'operation',id:'fixture',generation:input.generation,input_hash:digest('fixture')}]);
    await assert.rejects(verifyResetBaseline(stores,input),/not_empty/);
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'foreign','active',1)",['d'.repeat(64)]);
    await assert.rejects(restoreResetSetup(stores,input),/target_changed/);
    // A version 1 snapshot, taken before step 2b, names chats by their old values: it restores none, and the seeder
    // gives each value its row, with the same id, when the app starts (ADR-0252). Its group_ids is ignored: its groups
    // come up off until the owner turns them on, and only the owner's private chat is on (ADR-0253).
    assert.deepEqual(await chatRows(stores.control),{chats:[],chat_ids:[]});
    assert.deepEqual((await stores.control.query(`SELECT v.document FROM runtime_configuration c JOIN runtime_configuration_versions v USING(name,revision)`)).rows[0].document,
      {enabled:true,owner_id:'123'},'the restored runtime document leaves the old group list out');
    await new ChatSeeder(stores,{owner_id:'123'}).seed();
    assert.deepEqual((await chatRows(stores.control)).chats.map(row=>[row.id,row.kind,row.parent_id,row.state]),
      [['-1001','group',null,'off'],['-1001/topic/3','topic','-1001','off'],['-1002','group',null,'off'],['123','private',null,'active']]);
  } finally {await drop();}
});

test('a version 2 snapshot restores its chats and app ids exactly, and decides what each value is from them',fixture,async()=>{
  const {stores,drop}=await freshStores(),project='a'.repeat(64),topic='-1001/topic/3',bob=chatIdFor('telegram','456');
  // Both families: an old-shaped group and its topic keep their Telegram values; NG2 has a digest id, an old and a current Telegram id.
  const chat=(id:string,kind:'group'|'topic'|'private',extra:Record<string,unknown>={})=>({id,app:'telegram',kind,parent_id:null,topic_key:null,
    app_type:kind==='topic'?null:kind==='private'?'private':'supergroup',title:null,title_source:null,is_forum:false,state:'active',...extra});
  const chats=[chat('-1001','group',{is_forum:true}),chat(topic,'topic',{parent_id:'-1001',topic_key:'3',title:'Seeds',title_source:'owner'}),chat(NG2,'group'),
    chat('123','private'),chat(bob,'private',{state:'off'})];
  const chatIds=[{app:'telegram',external_id:'-1001',chat_id:'-1001',state:'current',reason:null},{app:'telegram',external_id:NG2_OLD_TG,chat_id:NG2,state:'old',reason:'migrated'},
    {app:'telegram',external_id:NG2_TG,chat_id:NG2,state:'current',reason:null},{app:'telegram',external_id:'123',chat_id:'123',state:'current',reason:null},
    {app:'telegram',external_id:'456',chat_id:bob,state:'current',reason:null}];
  const snapshot={format:'nocheh-reset-configuration-v2',layout:'original-only-v1',configuration:{
    security_policy:[{document:{version:1,rules:[]}}],installation_generation:[{generation:'11111111-1111-4111-8111-111111111111'}],guard_mode:[{mode:'off'}],
    runtime_configuration:[{name:'assistant',document:{enabled:true,owner_id:'123',group_ids:['-1001',NG2_TG]}}],
    projects:[{id:project,name:'Saved project',description:'',state:'active'}],
    project_assignments:[{space_id:'-1001',project_id:project,mode:'assigned'},{space_id:topic,project_id:null,mode:'inherit'},{space_id:NG2,project_id:project,mode:'assigned'}],
    sharing_rules:[{id:'b'.repeat(64),name:'Saved share',sources:['-1001'],destination:NG2,enabled:true,mode:'approved',instructions:''}],
    memory_access_settings:[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:false,request_ttl_seconds:86400,default_grant_mode:'one_time'}],
    chat_tool_settings:[{space_id:'-1001',shell:false,browser:null,mcp:null}],runtime_profiles:[],chats,chat_ids:chatIds}};
  const input={snapshot,generation:'22222222-2222-4222-8222-222222222222',reset_id:'44444444-4444-4444-8444-444444444444',profile_commands:[]};
  try {
    assert.deepEqual(resetSetupSnapshot(snapshot),snapshot);
    // A digest id is a group only because its row says so; a private chat never joins a project or a rule, whatever its id looks like.
    const forged=[{sharing_rules:[{...snapshot.configuration.sharing_rules[0]!,destination:bob}]},
      {project_assignments:[{space_id:bob,project_id:project,mode:'assigned'}]},
      {project_assignments:[{space_id:chatIdFor('telegram','-1002000000009'),project_id:project,mode:'assigned'}]},
      {chats:chats.filter(row=>row.id!==NG2)},{chats:chats.map(row=>row.id===topic?{...row,title_source:'observed'}:row)}];
    for(const change of forged)assert.throws(()=>resetSetupSnapshot({...snapshot,configuration:{...snapshot.configuration,...change}}),/snapshot_invalid/,JSON.stringify(change));
    const first=await restoreResetSetup(stores,input),again=await restoreResetSetup(stores,input);
    assert.deepEqual(again,first);assert.equal(first.chats,chats.length);
    assert.deepEqual(await chatRows(stores.control),sortedChats({chats:chats as any,chat_ids:chatIds as any}),'every chat keeps its id, its app ids and the owner\'s names');
    await verifyResetBaseline(stores,input);
    // The app's start then finds every value already has its row...
    const people=async()=>(await stores.control.query(`SELECT id,account_id FROM chats WHERE kind='private'`)).rows.map(row=>[row.id,row.account_id]).sort();
    assert.deepEqual(await people(),[['123',null],[bob,null]].sort(),'a snapshot carries no person');
    assert.deepEqual(await new ChatSeeder(stores,{owner_id:'123'}).seed(),{chats:0,topics:0});
    // ...and names each restored private chat's person by its Telegram id, so the owner's and a member's private chat are
    // theirs again: Answer privately claims only in the asker's own private chat, found by its person (ADR-0249).
    assert.deepEqual(await people(),[['123',accountIdFor('telegram','123')],[bob,accountIdFor('telegram','456')]].sort());
    const directory=chatDirectory(await loadChatSnapshot(stores.control,{owner_id:'123'}));
    assert.equal(directory.get(bob)?.account_id,accountIdFor('telegram','456'));assert.equal(directory.ownerChat(),'123');
    assert.deepEqual(await new ChatSeeder(stores,{owner_id:'123'}).seed(),{chats:0,topics:0});
    assert.deepEqual(await people(),[['123',accountIdFor('telegram','123')],[bob,accountIdFor('telegram','456')]].sort(),'a second start changes nothing');
  } finally {await drop();}
});
