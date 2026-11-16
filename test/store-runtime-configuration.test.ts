import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {RuntimeConfigurationRepository} from '../src/stores/runtime-configuration.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {AudienceRepository} from '../src/stores/audience.js';

test('saved allowlist admission revokes old capabilities atomically and stale service configurations fail closed',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:90000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),configuration=new RuntimeConfigurationRepository(stores.control),guards=new GuardRepository(stores,new ArchiveRepository(stores.archive));
  // Which groups are on is chats.state (ADR-0253): the admitted document is the owner and who may use Nocheh where.
  const first={enabled:true,owner_id:'123',group_ids:[],group_access:{'-9001':{granted:['301'],denied:[]},'-9002':{granted:['302'],denied:[]}}};
  try {
    await guards.reconcile();
    const before=await configuration.configure(first,'on');await configuration.assert(first);
    const generation=(await guards.state()).generation,principal={admin:false,scope:'-9001',space:'-9001',guard_epoch:before.epoch,generation};
    await new AudienceRepository(guards).assert(principal);
    const repeated=await Promise.all([configuration.configure(first,'on'),configuration.configure({...first,group_ids:['-9002','-9001']},'on')]);
    assert.deepEqual(repeated,[before,before],'a repeat, or a different list of groups that are on, does not revoke current work');
    const removed={...first,group_access:{'-9002':first.group_access['-9002']}},next=await configuration.configure(removed,'on');
    assert.equal(next.revision,before.revision+1);assert.equal(next.epoch,before.epoch+1);
    await assert.rejects(new AudienceRepository(guards).assert(principal),{code:'audience_context_changed'});
    await assert.rejects(configuration.assert(first),{code:'assistant_configuration_pending'});await configuration.assert(removed);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family IN ('honcho','memory_review') AND job_id='refresh' AND generation=$1",[next.epoch])).rows[0].count,2);
    const restored=await configuration.configure(first,'off');
    assert.equal(restored.revision,next.revision+1,'returning to an older policy cannot reuse its previous authority');
    assert.equal(restored.epoch,next.epoch+1);assert.equal((await guards.state()).mode,'off');
    const history=(await stores.control.query("SELECT document FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1",[next.revision])).rows[0];
    assert.deepEqual(history.document,{enabled:true,owner_id:'123',group_access:removed.group_access},'the saved policy never holds a group list');
    await assert.rejects(configuration.configure({...first,owner_id:'invalid'},'on'),{code:'invalid_assistant_policy'});
    // A failure during handoff rolls back the new policy and epoch together.
    const proxy=new Proxy(stores.control,{get(target,key){
      if(key==='connect')return async()=>{
        const client=await target.connect(),query=client.query.bind(client);
        return new Proxy(client,{get(connection,field){if(field==='query')return (sql:any,...args:any[])=>String(sql).startsWith('INSERT INTO workflow_outbox')?Promise.reject(Error('lost workflow write')):(query as any)(sql,...args);
          const value=Reflect.get(connection,field);return typeof value==='function'?value.bind(connection):value;}});
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(new RuntimeConfigurationRepository(proxy).configure(removed,'on'),/lost workflow write/);
    await configuration.assert(first);assert.equal((await guards.state()).epoch,restored.epoch);assert.equal((await guards.state()).mode,'off');
    const {group_access:_access,...bare}=first,empty=await configuration.configure(bare,'off');
    assert.deepEqual((await stores.control.query("SELECT document FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1",[empty.revision])).rows[0].document,
      {enabled:true,owner_id:'123',group_access:{}},'saved policy includes the explicit empty participant-access map');
  }finally{await stores.close();}
});

test('the first start after group_ids left the admitted document writes exactly one new revision and one epoch; a repeat writes none',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:90000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),configuration=new RuntimeConfigurationRepository(stores.control),guards=new GuardRepository(stores,new ArchiveRepository(stores.archive));
  try {
    await guards.reconcile();
    // The document the last step 2b-1 start admitted: it still listed the groups TELEGRAM_GROUP_IDS named.
    const legacy={enabled:true,owner_id:'123',group_ids:['-9001','-9002'],group_access:{'-9001':{granted:['301'],denied:[]}}};
    const current=(await stores.control.query("SELECT coalesce(max(revision),0) AS revision FROM runtime_configuration_versions WHERE name='assistant'")).rows[0].revision;
    await stores.control.query(`INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',$1,$2,$3)`,
      [Number(current)+1,legacy,digest(canonical(legacy))]);
    await stores.control.query(`INSERT INTO runtime_configuration(name,revision) VALUES('assistant',$1) ON CONFLICT(name) DO UPDATE SET revision=$1`,[Number(current)+1]);
    const mode=(await guards.state()).mode as 'on'|'off',epoch=(await guards.state()).epoch;
    // The same installation starts on this version: the env list is no longer read, and the access map stays.
    const policy={enabled:true,owner_id:'123',group_ids:[],group_access:legacy.group_access};
    await assert.rejects(configuration.assert(policy),{code:'assistant_configuration_pending'});
    const upgraded=await configuration.configure(policy,mode);
    assert.deepEqual(upgraded,{revision:Number(current)+2,epoch:epoch+1});
    assert.deepEqual((await stores.control.query("SELECT document FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1",[upgraded.revision])).rows[0].document,
      {enabled:true,owner_id:'123',group_access:legacy.group_access});
    await configuration.assert(policy);
    assert.deepEqual(await configuration.configure(policy,mode),upgraded,'a second start writes nothing');
    assert.deepEqual(await configuration.configure({...policy,group_ids:['-9003']},mode),upgraded,'a group turned on or off never moves the fingerprint');
  }finally{await stores.close();}
});
