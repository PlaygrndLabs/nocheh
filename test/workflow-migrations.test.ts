import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {settings} from '../src/config.js';
import {ingest,type Envelope} from '../src/archive.js';
import {beginMigration,finishMigration,migrationStatus,reconcileMigration,migrationHostReady,stageMigrationImport} from '../src/workflows/migrations.js';
import {cancelImport,confirmImport,finishLegacyImport} from '../src/workflows/imports.js';
import {hash,enterFamily,leaveFamily,registerWorker,publishOutbox,claimWorkflow,families} from '../src/workflows/store.js';

test('family cutover survives lost responses, atomic rollback, capture during pause and compatible ownership rollback',{skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:settings().databasePassword};
  const admin=new pg.Pool(connection),schema='migration_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${schema}`,max:8}),client=await pool.connect();
  const source=(key:string):Envelope=>({version:1,key,origin:'live',channel:'telegram',kind:'telegram_update',bot_id:'fixture',scope:'42',source_id:key,revision:'1',occurred_at:null,text:'private migration canary',payload:{message:{text:'private migration canary'}}});
  try{
    await initialize(pool);
    const pending=await ingest(pool,source('pending')),done=await ingest(pool,source('done')),ambiguous=await ingest(pool,source('ambiguous'));
    await pool.query("UPDATE dispatches SET state='done',attempts=1 WHERE event_id=$1",[done.id]);
    const ids=(await pool.query("SELECT job_id,id FROM workflow_registry WHERE family='telegram'")).rows;
    const wid=(event:string)=>ids.find(r=>r.job_id===event).id;
    await pool.query("UPDATE workflow_registry SET state='ambiguous' WHERE id=$1",[wid(ambiguous.id)]);
    await pool.query("UPDATE workflow_registry SET state='running' WHERE id=$1",[wid(done.id)]);
    await pool.query("INSERT INTO workflow_receipts(workflow_id,step,attempt,state) VALUES($1,'telegram',1,'started')",[wid(done.id)]);
    const id=hash('migration-one'),request={id,family:'telegram',owner:'inngest',epoch:1};
    assert.equal(await enterFamily(client,'telegram','legacy'),true);
    assert.equal((await beginMigration(pool,request)).state,'paused');
    assert.equal((await beginMigration(pool,request)).id,id,'lost pause response is idempotent');
    await assert.rejects(beginMigration(pool,{...request,owner:'legacy'}),{code:'migration_identity_conflict'});
    await assert.rejects(finishMigration(pool,id,'switch'),{code:'workflow_family_not_drained'});
    await leaveFamily(client,'telegram');
    assert.equal(await enterFamily(client,'telegram','legacy'),false);
    assert.equal(await publishOutbox(pool,async()=>{throw Error('must not publish');}),0);
    const during=await ingest(pool,source('captured-while-paused'));assert.ok(during.id);
    const native=await ingest(pool,source('native-receipt'));await pool.query("UPDATE dispatches SET state='running',attempts=1 WHERE event_id=$1",[native.id]);
    await reconcileMigration(pool,id,async(operation,body)=>{assert.equal(operation,'run.resume');assert.equal(body.observe_only,true);assert.equal(body.event_id,native.id);return {state:'not_found'};},'42');
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[native.id])).rows[0].state,'running','unknown receipt cannot authorize a replacement effect');
    await reconcileMigration(pool,id,async(_operation,body)=>{assert.equal(body.observe_only,true);return {state:'done'};},'42');
    await assert.rejects(finishMigration(pool,id,'switch'),{code:'workflow_worker_not_ready'});
    await registerWorker(pool,'pipeline',['telegram']);
    await pool.query("UPDATE workflow_registry SET lease_until=now()+interval '1 minute' WHERE id=$1",[wid(pending.id)]);
    await assert.rejects(finishMigration(pool,id,'switch'),{code:'workflow_family_not_drained'});
    await pool.query('UPDATE workflow_registry SET lease_until=NULL');
    await pool.query(`CREATE FUNCTION reject_migration_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'migration_fault'; END; $$;
      CREATE TRIGGER reject_migration_outbox BEFORE INSERT ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION reject_migration_outbox()`);
    await assert.rejects(finishMigration(pool,id,'switch'),/migration_fault/);
    assert.equal((await migrationStatus(pool,id)).owner.epoch,1);
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE id=$1',[wid(done.id)])).rows[0].state,'completed','the separately committed reconciliation survives failed publication');
    await pool.query('DROP TRIGGER reject_migration_outbox ON workflow_outbox; DROP FUNCTION reject_migration_outbox()');
    const result=await finishMigration(pool,id,'switch');assert.equal(result.state,'switched');assert.equal(result.to_epoch,2);assert.equal(result.redispatched,2);
    assert.deepEqual(await finishMigration(pool,id,'switch'),result,'lost commit response returns the same migration receipt');
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE id=$1',[wid(done.id)])).rows[0].state,'completed');
    assert.equal((await pool.query('SELECT state FROM workflow_receipts WHERE workflow_id=$1',[wid(done.id)])).rows[0].state,'done');
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE id=$1',[wid(ambiguous.id)])).rows[0].state,'ambiguous');
    assert.equal(await claimWorkflow(client,wid(pending.id),1,'old-dispatch',2),null);
    assert.equal(await enterFamily(client,'telegram','legacy'),false);
    const published:unknown[]=[];assert.equal(await publishOutbox(pool,async e=>{published.push(e);}),2);
    assert.ok(!JSON.stringify(result).includes('private migration canary'));assert.ok(!JSON.stringify(published).includes('private migration canary'));
    const rollback=hash('migration-rollback');await beginMigration(pool,{id:rollback,family:'telegram',owner:'legacy',epoch:2});
    await assert.rejects(finishMigration(pool,rollback,'switch'),{code:'rollback_closed_domain_unreconciled'});
    await pool.query("UPDATE dispatches SET state='ambiguous' WHERE event_id=$1",[ambiguous.id]);
    assert.equal((await finishMigration(pool,rollback,'switch')).to_epoch,3);
    assert.equal(await enterFamily(client,'telegram','inngest',2),false);
    assert.equal(await enterFamily(client,'telegram','legacy',3),true);await leaveFamily(client,'telegram');
    assert.equal(await publishOutbox(pool,async()=>{}),0);
    const abort=hash('migration-abort');await beginMigration(pool,{id:abort,family:'telegram',owner:'inngest',epoch:3});
    assert.equal((await finishMigration(pool,abort,'abort')).state,'aborted');
    assert.equal((await finishMigration(pool,abort,'abort')).owner.epoch,3);
    // Every family executes its real registration query and both ownership paths.
    // Only existing durable domain jobs are candidates; no host import or native
    // schedule identity is inferred from an archive event.
    for(const f of families.filter(f=>f!=='telegram')){
      await registerWorker(pool,['imports','tools'].includes(f)?'host':'pipeline',[f]);
      const forward=hash('forward-'+f),back=hash('back-'+f);
      await beginMigration(pool,{id:forward,family:f,owner:'inngest',epoch:1});
      if(['imports','tools'].includes(f)){
        await assert.rejects(finishMigration(pool,forward,'switch'),{code:'migration_host_handoff_required'});
        if(f==='imports'){
          const body={id:'11111111-1111-4111-8111-111111111111',configuration_hash:hash('private configuration'),review_approved:false,total:4,completed:1,duplicates:0,learning_after:0};
          await stageMigrationImport(pool,forward,body);await stageMigrationImport(pool,forward,body);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM workflow_imports')).rows[0].n,1);
          await assert.rejects(stageMigrationImport(pool,forward,{...body,review_approved:true}),{code:'import_configuration_changed'});
        }
        if(f==='tools'){
          await pool.query("INSERT INTO controlled_actions(id,event_id,scope,profile,kind,arguments,fingerprint,state) VALUES($1,$2,'42','owner','shell',$3,$1,'approved')",[hash('unclaimed-tool'),pending.id,Buffer.from('{"command":"synthetic only"}')]);
          await pool.query("UPDATE workflow_registry SET state='running' WHERE family='tools'");
        }
        await migrationHostReady(pool,forward);
      }
      assert.equal((await finishMigration(pool,forward,'switch')).to_epoch,2);
      await beginMigration(pool,{id:back,family:f,owner:'legacy',epoch:2});
      if(['imports','tools'].includes(f))await migrationHostReady(pool,back);
      assert.equal((await finishMigration(pool,back,'switch')).to_epoch,3);
      if(f==='imports'){
        const job='11111111-1111-4111-8111-111111111111';await cancelImport(pool,job);
        const resumed=await confirmImport(pool,{id:job,configuration_hash:hash('private configuration'),review_approved:false,total:4,completed:1,duplicates:0,resume:true});
        assert.equal(resumed.owned,false);assert.equal(resumed.job.generation,2,'explicit legacy resume creates a fresh generation after cancellation');
        assert.equal((await finishLegacyImport(pool,{id:job,configuration_hash:hash('private configuration'),completed:4,duplicates:1,learning_after:0})).state,'completed');
      }
    }
  }finally{client.release();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
