import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {storeSchemas} from '../src/stores/schema.js';
import {connectStores,initializeStoreDatabases,storeNames,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {portableDerivativeTypes,type PortableRecord} from '../src/stores/derivative-portability.js';
import type {DerivativeReference} from '../src/stores/derived.js';

test('complete derivative transfer retains edits and lineage while imported authority remains inert',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  // Separate empty namespaces in all three fixture databases, using the actual
  // domain roles. Never drop/replace the fixture's public schema or another task.
  const schema='portable_fixture_'+randomUUID().replaceAll('-','');
  for(const name of storeNames) {
    const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema} AUTHORIZATION nocheh_${name}_owner`);
      await db.query(`SET search_path=${schema},pg_catalog`);await db.query(`SET ROLE nocheh_${name}_owner`);
      await db.query(storeSchemas[name]);
      if(name==='control')await db.query('INSERT INTO installation(singleton,generation) VALUES(true,$1)',[randomUUID()]);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO nocheh_${name}`);
      await db.query(`GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA ${schema} TO nocheh_${name}`);
      await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO nocheh_${name}`);
      if(name==='archive')await db.query('GRANT UPDATE(file_hash,byte_size) ON artifacts TO nocheh_archive');
      else if(name==='derived') {
        await db.query('GRANT UPDATE(active_revision,state) ON guard_sources TO nocheh_derived');
        await db.query('GRANT UPDATE(active_revision,imported) ON derivative_selections,learned_entries TO nocheh_derived');
        await db.query('GRANT UPDATE(active_revision) ON entity_claims TO nocheh_derived');
      } else await db.query(`GRANT UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO nocheh_control`);
    } finally {await db.end();}
  }
  const stores=connectStores(config,passwords),target=connectStores({...config,options:'-c search_path='+schema+',pg_catalog'},passwords);
  const root=await mkdtemp(join(tmpdir(),'nocheh-derivative-portable-')),owner={admin:true,scope:null},key='portable:'+randomUUID();
  const options=(directory:string)=>({dataDir:join(root,directory),detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async()=>({literals:[]}),honcho:async()=>{throw Error('no native calls');}});
  const source=storageServices(stores,options('source')),restored=storageServices(target,options('target'));
  try {
    const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'88',revision:'1',occurred_at:null,text:'Original evidence',
      payload:{message:{message_id:88,chat:{id:123,type:'private'},from:{id:123,first_name:'Owner'},voice:{file_id:key}}}};
    const original=(await source.capture.capture(event)).source,bytes=Buffer.from([79,103,103,0,255]),file=await source.attachments.commit(original.artifact_ids[0]!,bytes);
    await source.guards.prepare(original.reference,'fixture',async()=>[]);
    await source.guards.prepare(file,'fixture',async()=>[]);
    const outputs:DerivativeReference[]=[];
    for(const version of ['one','two']) {
      const output=await source.derived.record({operation_id:key+':'+version,source:original.reference,file,kind:'transcript',content:Buffer.from('Reading '+version),producer:'fixture',producer_version:version,configuration:{exact:true}});
      await source.guards.prepare(output,'fixture',async()=>[]);outputs.push(output);
    }
    await source.guards.edit('derived_artifacts:'+outputs[0]!.id,1,{text:'Durable owner wording',kind:'transcript',provenance:{}},key+':edit');
    await source.selections.activate(outputs[0]!,null,key+':select-one');await source.selections.activate(outputs[1]!,1,key+':select-two');
    const child=await source.derived.record({operation_id:key+':child',source:original.reference,parents:[outputs[0]!],kind:'runtime_context',content:Buffer.from('Interpreted context'),producer:'fixture',producer_version:'1',configuration:{}});
    await source.guards.prepare(child,'fixture',async()=>[]);
    const entry=digest(key+':meaning'),binding=await source.guards.state(),guard=await source.guards.read('events:'+original.reference.id,binding);
    await source.learned.publishAutomatic(entry,{kind:'meaning',subject:'blue square',text:'A contextual interpretation',scope:{kind:'conversation',id:'123'},
      uncertainty:'supported',evidence:[original.reference],conflicts:[]},null,key+':learned',[{source_id:'events:'+original.reference.id,revision:guard.revision,value_hash:digest(canonical(guard.value))}],binding,'fixture',async()=>[]);
    await source.learned.correct(owner,entry,{expected_revision:1,operation_id:key+':correction',text:'Owner interpretation',retired:false},async()=>[]);
    const project=await source.projects.save(owner,{name:'Portable project',description:'Entity portability fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    const assignmentRevision=(await stores.control.query('SELECT revision FROM project_assignments WHERE space_id=$1',['123'])).rows[0]?.revision??0;
    await source.projects.assign(owner,{space_id:'123',project_id:project.id,mode:'assigned',expected_revision:assignmentRevision,operation_id:key+':assign'});
    const entityContext=await source.entities.context(original.reference,[]),entityBinding=await source.guards.state();
    const entityClaim=await source.entities.publishClaim({subject_id:entityContext.project!.id,predicate:'commitment',content:'The owner reported a portable commitment.',
      attribution:'reported',speaker_entity_id:entityContext.speaker!.id,uncertainty:'supported',evidence:[original.reference]},entityBinding,key+':entity-claim');
    const operation=await source.operations.record({key:key+':runtime',kind:'scheduled_trigger',scope:'123',input_hash:digest('trigger')});
    const generated=await source.derived.record({operation_id:key+':generated',source:operation,kind:'runtime_context',content:Buffer.from('Runtime content'),producer:'fixture',producer_version:'1',configuration:{}});
    await source.guards.prepare(generated,'fixture',async()=>[]);
    const current=await source.guards.state(),cacheId=digest(key+':cache');
    await stores.derived.query('INSERT INTO runtime_prepared_values(id,audience,generation,epoch,content) VALUES($1,$2,$3,$4,$5)',[cacheId,'owner',current.generation,current.epoch,Buffer.from('Do not resurrect this authorization')]);
    await stores.derived.query('INSERT INTO runtime_prepared_inputs(id,audience,generation,epoch,source_id) VALUES($1,$2,$3,$4,$5)',[cacheId,'owner',current.generation,current.epoch,'events:'+original.reference.id]);
    // Deliberately match the old generation and epoch: cache inertness must not
    // depend merely on coincidentally different installation identifiers.
    await target.control.query('UPDATE installation SET generation=$1',[current.generation]);await target.control.query('UPDATE guard_state SET epoch=$1,mode=$2',[current.epoch,'off']);
    await restored.sourcePortability.import(owner,await source.sourcePortability.record(owner,original.reference.id));
    await restored.attachments.commit(file.id,bytes);
    const records:PortableRecord[]=[],keys=new Set<string>([entry,cacheId,operation.id]),entityKeys=new Set([project.id,entityContext.project!.id,entityContext.speaker!.id,entityClaim.id]);
    for(const type of portableDerivativeTypes) {
      let after='';do {
        const page=await source.derivativePortability.page(owner,type,after,100);
        for(const record of page.records) {
          const v=record.value,entityRelated=entityKeys.has(record.key)||v.entity_id===entityContext.project!.id||v.entity_id===entityContext.speaker!.id||
            v.subject_entity_id===entityContext.project!.id||v.claim_id===entityClaim.id||v.project_id===project.id;
          const related=v.event_id===original.reference.id||v.source_id==='events:'+original.reference.id||entityRelated||
            (v.provenance as any)?.source?.id===operation.id||keys.has(record.key)||[v.source_id,v.selection_id,v.entry_id,v.operation_id].some(x=>typeof x==='string'&&keys.has(x));
          if(related){records.push(record);keys.add(record.key);if(typeof v.operation_id==='string')keys.add(v.operation_id);}
        }
        after=page.next??'';
      }while(after);
    }
    assert.ok(records.some(r=>r.type==='runtime_prepared_values'));assert.ok(records.some(r=>r.type==='learned_versions'));assert.ok(records.some(r=>r.type==='guard_revisions'&&r.value.author==='owner'));
    assert.ok(records.some(r=>r.type==='memory_entities'));assert.ok(records.some(r=>r.type==='entity_claim_versions'));
    // File/transcript parents can be sorted after their children in export order.
    // Retry only missing-parent records after another successful insertion.
    for(const type of portableDerivativeTypes) {
      let pending=records.filter(r=>r.type===type);
      while(pending.length) {
        const next:PortableRecord[]=[];
        for(const record of pending)try {await restored.derivativePortability.restore(owner,[record]);}
        catch(error){if((error as any).code!=='portable_parent_pending')throw error;next.push(record);}
        assert.ok(next.length<pending.length,'parent graph must make progress');pending=next;
      }
    }
    for(let i=0;i<records.length;i+=100)assert.equal((await restored.derivativePortability.verify(owner,records.slice(i,i+100))).activated,false);
    assert.deepEqual(await restored.attachments.bytes(await restored.attachments.file(file.id)),bytes);
    assert.equal((await target.archive.query('SELECT count(*) FROM events')).rows[0].count,'1');
    assert.equal((await target.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[generated.id])).rows[0].content.toString(),'Runtime content');
    assert.equal((await target.derived.query('SELECT imported FROM derived_artifacts WHERE id=$1',[child.id])).rows[0].imported,true);
    assert.equal((await target.derived.query('SELECT content FROM entity_claim_versions WHERE claim_id=$1',[entityClaim.id])).rows[0].content,'The owner reported a portable commitment.');
    await assert.rejects(restored.derived.checkpoint(key+':child'),{code:'imported_result_not_execution_receipt'});
    await assert.rejects(restored.derived.record({operation_id:key+':child',source:original.reference,parents:[outputs[0]!],kind:'runtime_context',content:Buffer.from('Interpreted context'),producer:'fixture',producer_version:'1',configuration:{}}),{code:'imported_result_not_execution_receipt'});
    assert.equal((await source.derived.checkpoint(key+':child')).id,child.id,'a local checkpoint still repairs lost workflow completion');
    assert.equal((await target.derived.query('SELECT count(*) FROM runtime_prepared_values')).rows[0].count,'0');
    assert.equal((await target.derived.query('SELECT count(*) FROM runtime_prepared_inputs')).rows[0].count,'0');
    await assert.rejects(restored.operations.verify(operation),{code:'operation_reference_conflict'});
    await assert.rejects(restored.operations.record({key:key+':runtime',kind:'scheduled_trigger',scope:'123',input_hash:digest('trigger')}),{code:'operation_identity_conflict'});
    await assert.rejects(restored.selections.current(file.event.id,file.id,'transcript',await restored.guards.state()),{code:'derivative_selection_pending'});
    await assert.rejects(restored.learned.read({admin:false,scope:null,space:'123'},entry,await restored.guards.state(),async()=>true),{code:'learned_memory_not_found'});
    assert.equal((await restored.learned.list(owner)).entries[0]!.text,'Owner interpretation');
    await restored.guards.setMode('on');await assert.rejects(restored.guards.read('derived_artifacts:'+outputs[0]!.id,await restored.guards.state()),{code:'guard_preparation_pending'});
    assert.equal(await restored.guards.prepare(outputs[0]!,'different-engine',async()=>{throw Error('must preserve owner history');}),null);
    assert.equal((await restored.guards.history('derived_artifacts:'+outputs[0]!.id)).revisions.length,2);
    await restored.guards.restore('derived_artifacts:'+outputs[0]!.id,2,2,key+':restore-edited');
    await restored.selections.activate(outputs[0]!,2,key+':activate-import');
    assert.equal(((await restored.selections.current(file.event.id,file.id,'transcript',await restored.guards.state())).value as any).text,'Durable owner wording');
    await restored.learned.correct(owner,entry,{expected_revision:2,operation_id:key+':adopt-correction',text:'Reviewed imported interpretation',retired:false},async()=>[]);
    assert.equal((await restored.learned.read({admin:false,scope:null,space:'123'},entry,await restored.guards.state(),async()=>true)).text,'Reviewed imported interpretation');
    for(const record of records)await restored.derivativePortability.restore(owner,[record]);
    assert.equal(((await restored.selections.current(file.event.id,file.id,'transcript',await restored.guards.state())).value as any).text,'Durable owner wording','duplicate import cannot replace subsequent edits or selection');
    const originalRecord=records.find(r=>r.type==='derived_artifacts'&&r.key===outputs[0]!.id)!;
    await assert.rejects(restored.derivativePortability.restore(owner,[{...originalRecord,value:{...originalRecord.value,content:'ZmFrZQ=='}}]),{code:'portable_record_integrity'});
    await assert.rejects(restored.derivativePortability.restore(owner,[{...originalRecord,type:'workflow_registry'}]),{code:'invalid_portable_record'});
    const history=await restored.derivativePortability.history(owner);assert.ok(history.records.length);
  } finally {
    await stores.close();await target.close();await rm(root,{recursive:true,force:true});
    assert.match(schema,/^portable_fixture_[a-f0-9]{32}$/);
    for(const name of storeNames) {
      const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();
      try {assert.equal((await db.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');await db.query(`DROP SCHEMA ${schema} CASCADE`);}
      finally{await db.end();}
    }
  }
});
