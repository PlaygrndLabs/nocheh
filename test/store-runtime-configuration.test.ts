import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
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
  const first={enabled:true,owner_id:'123',group_ids:['-9001','-9002']};
  try {
    await guards.reconcile();
    const before=await configuration.configure(first,'on');await configuration.assert(first);
    const generation=(await guards.state()).generation,principal={admin:false,scope:'-9001',space:'-9001',guard_epoch:before.epoch,generation};
    await new AudienceRepository(guards).assert(principal);
    const repeated=await Promise.all([configuration.configure(first,'on'),configuration.configure({...first,group_ids:['-9002','-9001','-9002']},'on')]);
    assert.deepEqual(repeated,[before,before],'repeat/reordered saved setup does not revoke current work');
    const removed={...first,group_ids:['-9002']},next=await configuration.configure(removed,'on');
    assert.equal(next.revision,before.revision+1);assert.equal(next.epoch,before.epoch+1);
    await assert.rejects(new AudienceRepository(guards).assert(principal),{code:'audience_context_changed'});
    await assert.rejects(configuration.assert(first),{code:'assistant_configuration_pending'});await configuration.assert(removed);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family IN ('honcho','memory_review') AND job_id='refresh' AND generation=$1",[next.epoch])).rows[0].count,2);
    const restored=await configuration.configure(first,'off');
    assert.equal(restored.revision,next.revision+1,'returning to an older policy cannot reuse its previous authority');
    assert.equal(restored.epoch,next.epoch+1);assert.equal((await guards.state()).mode,'off');
    const history=(await stores.control.query("SELECT document FROM runtime_configuration_versions WHERE name='assistant' AND revision=$1",[next.revision])).rows[0];
    assert.deepEqual(history.document,removed);
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
  }finally{await stores.close();}
});
