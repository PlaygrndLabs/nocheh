import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('schedule definitions and fires are recoverable control operations with durable guarded derivatives',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-schedules-')),base=Date.now();let fail='',lostCommit=false,detectorDown=false;
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(lostCommit&&sql==='COMMIT'){lostCommit=false;return (client.query as any)(sql,...args).then(()=>{throw Error('lost commit acknowledgement');});}
      if(fail&&String(sql).startsWith(fail)){fail='';return Promise.reject(Error('lost control write'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const owner={admin:true,scope:null},profile='nocheh-'+digest('123').slice(0,24),job='fixture-'+base;
  const s=storageServices({...stores,control},{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-123']}),
    runtime:async(op,body)=>{assert.equal(op,'guard.detect');if(detectorDown)throw Error('detector unavailable');return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};},
    honcho:async()=>{throw Error('no providers');}});
  let definition:any={profile,name:'Synthetic job',prompt:'Exact\r\nfixture-secret\0 schedule',schedule:{kind:'interval',minutes:60},deliver:'local',repeat:null,
    enabled:true,removed:false,preferences:{'agent.max_iterations':4},execution_version:'v1'};
  let sequence=0;
  const publish=(changes:Record<string,unknown>={})=>s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition,
    workflow_cursor:digest('cursor-'+(++sequence)),workflow_sequence:sequence,...changes});
  const input=async(id:string,changes:Record<string,unknown>={})=>({scope:'123',space:'123',profile,job_id:job,id,conversation:job,
    text:definition.prompt,files:[],definition,job_revision:digest(canonical(definition)),scheduled_for:'2026-09-18T12:00:00Z',
    fire_reason:'scheduled',owner_epoch:(await s.schedules.ownership()).epoch,...changes});
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    await assert.rejects(s.schedules.definition({admin:false,scope:'123'},{}),{status:403});
    const before=Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count);
    const record=s.derived.record.bind(s.derived);let missing=true;
    s.derived.record=async value=>{if(missing&&value.kind==='scheduled_prompt'){missing=false;throw Error('derived outage');}return record(value);};
    await assert.rejects(publish({workflow_sequence:1,workflow_cursor:digest('cursor-1')}),/derived outage/);s.derived.record=record;
    fail='INSERT INTO schedule_versions';await assert.rejects(publish({workflow_sequence:1,workflow_cursor:digest('cursor-1')}),/lost control write/);
    const initial=await publish({workflow_sequence:1,workflow_cursor:digest('cursor-1')});assert.ok('prompt' in initial);
    const prompt=initial.prompt!,reference=initial.definition!;
    assert.equal((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[prompt.id])).rows[0].content.toString(),definition.prompt);
    const guarded=await s.guards.read('derived_artifacts:'+prompt.id,await s.guards.state());assert.ok(!JSON.stringify(guarded).includes('fixture-secret'));
    assert.equal(JSON.parse((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0].content.toString()).prompt,definition.prompt);
    const duplicate=await publish({workflow_sequence:1,workflow_cursor:digest('cursor-1')});assert.equal(duplicate.duplicate,true);
    await assert.rejects(publish({workflow_sequence:1}),{code:'schedule_sequence_conflict'});
    await assert.rejects(publish({workflow_sequence:0}),{code:'invalid_schedule_sequence'});
    const first=await input('first');fail='INSERT INTO managed_runs';await assert.rejects(s.schedules.capture(owner,first),/lost control write/);
    lostCommit=true;await assert.rejects(s.schedules.capture(owner,first),/lost commit acknowledgement/);
    const committed=await s.schedules.capture(owner,first);assert.equal(committed.state,'captured');
    assert.equal((await s.schedules.capture(owner,first)).event_id,committed.event_id);
    await assert.rejects(s.schedules.capture(owner,{...first,text:'changed'}),{code:'schedule_input_conflict'});
    await assert.rejects(s.schedules.capture(owner,{...first,owner_epoch:999}),{code:'workflow_owner_changed'});
    const run=await row(committed.event_id);assert.equal(run.source_reference.store,'control');assert.equal(run.trigger_reference.store,'derived');
    assert.equal((await s.schedules.capture(owner,await input('overlap'))).fire_reason,'overlap');
    const epoch=(await s.guards.state()).epoch;
    definition={...definition,enabled:false};await publish();assert.equal((await s.guards.state()).epoch,epoch,'clock completion must not revoke its admitted run');
    assert.equal((await row(committed.event_id)).state,'captured');
    await assert.rejects(s.schedules.capture(owner,await input('disabled')),{code:'schedule_definition_changed'});
    const old=definition;definition={...definition,prompt:'Different text'};
    await assert.rejects(publish(),{code:'schedule_execution_version_conflict'});definition=old;
    definition={...definition,prompt:'Owner revised prompt',enabled:true,execution_version:'v2'};await publish();
    assert.equal((await row(committed.event_id)).state,'cancelled');assert.ok((await s.guards.state()).epoch>epoch);
    await assert.rejects(s.schedules.capture(owner,{...first,id:'obsolete'}),{code:'schedule_definition_changed'});
    assert.equal((await s.schedules.capture(owner,await input('missed',{fire_reason:'missed'}))).state,'cancelled');
    const manual=await s.schedules.capture(owner,await input('manual',{fire_reason:'manual'}));assert.equal(manual.state,'captured');
    definition={...definition,removed:true,enabled:false,execution_version:'v3'};await publish();
    assert.equal((await row(manual.event_id)).state,'cancelled');
    await assert.rejects(s.schedules.capture(owner,await input('removed',{fire_reason:'manual'})),{code:'schedule_definition_changed'});
    const version=(await stores.control.query('SELECT * FROM schedule_versions WHERE schedule_id=$1 ORDER BY created_at DESC LIMIT 1',[digest(canonical([profile,job]))])).rows[0];
    assert.equal('prompt' in version.configuration,false);assert.equal(version.operation_reference.store,'control');
    assert.equal(Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count),before);
    assert.equal((await stores.archive.query("SELECT count(*)::int AS count FROM events WHERE channel='scheduler'")).rows[0].count,0);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='schedules' AND job_id=$1",['run:'+committed.event_id])).rows[0].count,1);
    await s.guards.setMode('off');detectorDown=true;
    definition={...definition,removed:false,enabled:true,execution_version:'v4',prompt:'Unguarded explicit off mode'};await publish();
    assert.equal((await s.schedules.capture(owner,await input('off'))).state,'captured');
    await assert.rejects(publish({profile:'nocheh-'+digest('-123').slice(0,24)}),{code:'profile_scope_denied'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
