import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,storeNames,type StorePasswords} from '../src/stores/connections.js';
import {verifyFreshAcceptance} from '../src/stores/reset-acceptance.js';
import {storeSchemas} from '../src/stores/schema.js';

const idNames=['owner','group','reply','target','reaction','reactionTarget','transcript','recall','entry','learned','correction',
  'isolation','silence','action','decision','restart','memory','receipt'] as const;
const ids=Object.fromEntries(idNames.map(name=>[name,digest(name)])) as Record<(typeof idNames)[number],string>;
const boundary='2026-09-18T00:00:00.000Z',fresh=new Date('2026-09-18T01:00:00.000Z');
const input=()=>({format:'nocheh-fresh-acceptance-v1',reset_id:'11111111-1111-4111-8111-111111111111',
  generation:'22222222-2222-4222-8222-222222222222',mode:'live',boundary_confirmed_at:boundary,
  dedicated_group_sha256:digest('-100'),human_participant_sha256:digest('999'),checks:{
    owner_dm:{event_id:ids.owner,owner_inspected:true},dedicated_group:{event_id:ids.group},
    reply:{event_id:ids.reply,target_event_id:ids.target},
    human_reaction:{event_id:ids.reaction,target_event_id:ids.reactionTarget,actor_observed:true},
    subscription_transcription:{event_id:ids.transcript,artifact_id:'a'.repeat(64),derived_id:'b'.repeat(64)},
    learned_recall:{entry_id:ids.entry,version_operation_id:ids.correction,memory_receipt_id:ids.receipt,dispatch_event_id:ids.recall,owner_inspected:true},
    owner_correction:{entry_id:ids.entry,operation_id:ids.correction,revision:2},
    isolation:{event_id:ids.isolation,dispatch_event_id:ids.isolation,owner_inspected:true,private_source_absent:true},
    intentional_silence:{event_id:ids.silence},
    exact_approval:{action_id:ids.action,decision_operation_id:ids.decision,owner_inspected:true},
    restart_recovery:{event_id:ids.restart,dispatch_event_id:ids.restart,single_delivery:true,owner_inspected:true},
    honcho:{generation_id:ids.memory,ingestion_receipt_id:ids.receipt,owner_inspected:true}}});

function stores(eventTime=fresh) {
  const archive={query:async(sql:string,params:any[])=>{
    if(sql.includes('FROM events e JOIN source_observations'))return {rows:[{origin:'live',channel:'telegram',received_at:eventTime,
      operation:params[0]===ids.reaction?'reaction_change':'snapshot',metadata:{audience:{chat_id:[ids.owner,ids.transcript].includes(params[0])?'123':'-100'},
        ...(params[0]===ids.reaction?{reaction:{mode:'individual'}}:{})}}]};
    if(sql.includes('FROM source_relations x'))return {rows:[{present:1}]};
    if(sql.includes("r.kind='authored_by'"))return {rows:[{external_id:'999'}]};
    if(sql.includes('FROM artifacts'))return {rows:[{file_hash:'f'.repeat(64),byte_size:42}]};
    throw Error('unexpected archive query '+sql);
  }};
  const derived={query:async(sql:string,params:any[])=>{
    if(sql.includes('FROM derived_artifacts d'))return {rows:[{kind:'transcript',producer:'nocheh-subscription',created_at:fresh}]};
    if(sql.includes('FROM learned_entries x'))return {rows:[params[1]===ids.correction?
      {revision:2,author:'owner',retired:false,created_at:fresh}:
      {operation_id:ids.learned,author:'honcho',retired:false,created_at:fresh}]};
    throw Error('unexpected derived query '+sql);
  }};
  const control={query:async(sql:string,params:any[]=[])=>{
    if(sql.startsWith('SELECT generation::text'))return {rows:[{generation:'22222222-2222-4222-8222-222222222222'}]};
    if(sql.includes('FROM runtime_configuration c'))return {rows:[{document:{enabled:true,owner_id:'123',group_ids:['-100']}}]};
    if(sql.includes('FROM dispatches'))return {rows:[{state:params[0]===ids.silence?'suppressed':'done',
      attempts:1,result_reference:params[0]===ids.silence?null:{id:'result'},
      error_code:params[0]===ids.silence?'intentional_silence':null,created_at:fresh,updated_at:fresh}]};
    if(sql.includes('FROM telegram_action_requests'))return {rows:[{state:'done',result_reference:{id:'sent'},created_at:fresh,
      security_decision:{outcome:'allow'},decision:'approve',decided_at:fresh}]};
    if(sql.includes('FROM memory_engine_connection'))return {rows:[{attached:true,verified:true,acceptance:{format:'nocheh-honcho-live-v1',
      recorded_at:fresh.toISOString(),checks:Object.fromEntries(['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'].map(name=>[name,'passed']))}}]};
    if(sql.includes('FROM memory_generations g'))return {rows:[{state:'ready',installation_generation:'22222222-2222-4222-8222-222222222222',
      last_ready_at:fresh,refreshed_at:fresh}]};
    if(sql.includes('FROM memory_ingestion_receipts'))return {rows:[sql.includes('projection_reference')?
      {state:'done',projection_reference:{id:ids.entry,revision:1},created_at:fresh}:
      {state:'done',attempts:1,created_at:fresh}]};
    throw Error('unexpected control query '+sql);
  }};
  return {archive,derived,control,close:async()=>{}} as any;
}

test('fresh reset acceptance requires current live source, derivative, action, learning and Honcho rows',async()=>{
  const result=await verifyFreshAcceptance(stores(),input());
  assert.equal(result.mode,'live');assert.equal(result.live_only,true);assert.equal(result.fixtures_accepted,false);
  assert.deepEqual(Object.values(result.checks),Array(12).fill('passed'));assert.ok(result.source_events>=8);
});

test('fresh reset acceptance rejects historical rows and fixture-labelled reports',async()=>{
  await assert.rejects(verifyFreshAcceptance(stores(new Date('2026-09-17T23:59:59.000Z')),input()),/historical/);
  await assert.rejects(verifyFreshAcceptance(stores(),{...input(),fixture:true}),/invalid/);
});

test('fresh reset acceptance queries the three real isolated PostgreSQL stores',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const marker=new pg.Client(config);await marker.connect();
  try{assert.equal((await marker.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally{await marker.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const schema='fresh_acceptance_'+randomUUID().replaceAll('-','');
  const clients:Record<string,pg.Client>={};
  try {
    for(const name of storeNames) {
      const client=new pg.Client({...config,database:'nocheh_'+name});clients[name]=client;await client.connect();
      await client.query(`CREATE SCHEMA ${schema} AUTHORIZATION nocheh_${name}_owner; SET search_path=${schema},pg_catalog; SET ROLE nocheh_${name}_owner`);
      await client.query(storeSchemas[name]);
    }
    const archive=clients.archive!,derived=clients.derived!,control=clients.control!,e=input(),when='2026-09-18T01:00:00.000Z';
    const objectIds:Record<string,string>={};
    for(const eventId of new Set([ids.owner,ids.group,ids.reply,ids.target,ids.reaction,ids.reactionTarget,ids.transcript,
      ids.recall,ids.isolation,ids.silence,ids.restart])) {
      const object=digest('object:'+eventId),revision=digest('revision:'+eventId);objectIds[eventId]=object;
      const chat=[ids.owner,ids.transcript].includes(eventId)?'123':'-100',operation=eventId===ids.reaction?'reaction_change':'snapshot';
      await archive.query(`INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,received_at,payload,payload_hash)
        VALUES($1,$2,'telegram','fixture',$3,$4,'1','live','telegram_update',$5,'{}',$6)`,
        [eventId,'source:'+eventId,chat,eventId,when,digest('{}')]);
      await archive.query("INSERT INTO source_objects(id,platform,namespace,kind,external_id) VALUES($1,'telegram','fixture','message',$2)",[object,eventId]);
      await archive.query("INSERT INTO source_revisions(id,object_id,revision,revision_hash) VALUES($1,$2,'1',$3)",[revision,object,digest('1')]);
      await archive.query(`INSERT INTO source_observations(event_id,revision_id,model_version,adapter,adapter_version,operation,completeness,descriptor,metadata,provenance)
        VALUES($1,$2,1,'telegram.bot-api','2',$3,'full','{}',$4,'{}')`,
        [eventId,revision,operation,{audience:{chat_id:chat,topic_state:'none'},...(eventId===ids.reaction?{reaction:{mode:'individual'}}:{})}]);
    }
    await archive.query("INSERT INTO source_relations(event_id,kind,target_id,metadata) VALUES($1,'reply_to',$2,'{}')",[ids.reply,objectIds[ids.target]]);
    await archive.query("INSERT INTO source_relations(event_id,kind,target_id,metadata) VALUES($1,'reaction_to',$2,'{}')",[ids.reaction,objectIds[ids.reactionTarget]]);
    const actor=digest('human-actor');
    await archive.query("INSERT INTO source_objects(id,platform,namespace,kind,external_id) VALUES($1,'telegram','bot-api','actor','999')",[actor]);
    await archive.query("INSERT INTO source_relations(event_id,kind,target_id,metadata) VALUES($1,'authored_by',$2,'{}')",[ids.reaction,actor]);
    await archive.query("INSERT INTO artifacts(id,event_id,kind,source_ref,file_hash,byte_size) VALUES($1,$2,'voice','fixture',$3,42)",['a'.repeat(64),ids.transcript,'f'.repeat(64)]);

    await derived.query(`INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,content_hash,provenance,source_revision,input_hash,
      producer,producer_version,configuration_hash,operation_id,created_at) VALUES($1,$2,$3,'transcript','fixture',$4,'{}','1',$4,'nocheh-subscription','1',$4,$5,$6)`,
      ['b'.repeat(64),ids.transcript,'a'.repeat(64),digest('fixture'),'transcript-operation',when]);
    await derived.query("INSERT INTO derivative_selections(id,event_id,artifact_id,kind,active_revision) VALUES($1,$2,$3,'transcript',1)",
      [digest('selection'),ids.transcript,'a'.repeat(64)]);
    await derived.query("INSERT INTO derivative_selection_revisions(operation_id,selection_id,revision,derived_id,author,created_at) VALUES($1,$2,1,$3,'automatic',$4)",
      [digest('selection-operation'),digest('selection'),'b'.repeat(64),when]);
    await derived.query("INSERT INTO learned_entries(id,scope_kind,scope_id,kind,subject,active_revision,created_at) VALUES($1,'conversation','-100','meaning','fixture',2,$2)",[ids.entry,when]);
    for(const [operation,revision,author] of [[ids.learned,1,'honcho'],[ids.correction,2,'owner']] as const) {
      const artifact=digest('learned-artifact:'+revision);
      await derived.query(`INSERT INTO derived_artifacts(id,event_id,kind,content,content_hash,provenance,source_revision,input_hash,
        producer,producer_version,configuration_hash,operation_id,created_at) VALUES($1,$2,'learned_memory','fixture',$3,'{}','1',$3,'fixture','1',$3,$4,$5)`,
        [artifact,ids.group,digest('learned:'+revision),'artifact-operation:'+revision,when]);
      await derived.query(`INSERT INTO learned_versions(operation_id,entry_id,revision,derived_id,request_hash,author,evidence,dependencies,input_binding,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'[]','[]','{}',$7)`,[operation,ids.entry,revision,artifact,digest('request:'+revision),author,when]);
    }

    await control.query('INSERT INTO installation(singleton,generation) VALUES(true,$1)',[e.generation]);
    const policy={enabled:true,owner_id:'123',group_ids:['-100']};
    await control.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint,created_at) VALUES('assistant',1,$1,$2,$3)",[policy,digest(JSON.stringify(policy)),when]);
    await control.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
    for(const eventId of [ids.owner,ids.recall,ids.isolation,ids.silence,ids.restart])
      await control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts,result_reference,error_code,created_at,updated_at)
        VALUES($1,'{}',$2,1,$3,$4,$5,$5)`,[eventId,eventId===ids.silence?'suppressed':'done',eventId===ids.silence?null:{id:'result'},
        eventId===ids.silence?'intentional_silence':null,when]);
    await control.query(`INSERT INTO telegram_action_requests(id,source_reference,proposal_reference,binding,scope,space_id,profile,destination,
      fingerprint,text_hash,state,result_reference,security_decision,created_at,updated_at) VALUES($1,'{}','{}','{}','owner','owner','assistant','fixture',$2,$2,'done','{}','{}',$3,$3)`,
      [ids.action,digest('action'),when]);
    await control.query("INSERT INTO telegram_action_decisions(operation_id,request_hash,action_id,decision,revision,created_at) VALUES($1,$2,$3,'approve',1,$4)",
      [ids.decision,digest('decision'),ids.action,when]);
    const honchoChecks=Object.fromEntries(['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'].map(name=>[name,'passed']));
    await control.query('UPDATE memory_engine_connection SET attached=true,verified=true,acceptance=$1 WHERE singleton',
      [{format:'nocheh-honcho-live-v1',recorded_at:when,checks:honchoChecks}]);
    await control.query(`INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience,state,last_ready_at)
      VALUES($1,$2,1,'owner','ready',$3)`,[ids.memory,e.generation,when]);
    await control.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,content_hash,state,remote_id,attempts,created_at,projection_reference)
      VALUES($1,$2,'{}','fixture','fixture',$3,'done','remote',1,$4,$5)`,[ids.receipt,ids.memory,digest('memory'),when,{id:ids.entry,revision:2}]);
    await control.query("INSERT INTO memory_context_snapshots(generation,derived_id,content_hash,refreshed_at) VALUES($1,$2,$3,$4)",
      [ids.memory,digest('context'),digest('context-content'),when]);
    for(const name of storeNames)await clients[name]!.query(`GRANT USAGE ON SCHEMA ${schema} TO nocheh_${name}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO nocheh_${name}`);
    const connected=connectStores({...config,options:'-c search_path='+schema+',pg_catalog'},passwords);
    try {const result=await verifyFreshAcceptance(connected,e);assert.equal(result.live_only,true);assert.equal(result.source_events,11);}
    finally{await connected.close();}
  } finally {
    for(const name of storeNames) {
      const client=clients[name];if(!client)continue;
      try{await client.query('RESET ROLE; SET search_path=public,pg_catalog; DROP SCHEMA '+schema+' CASCADE');}finally{await client.end();}
    }
  }
});
