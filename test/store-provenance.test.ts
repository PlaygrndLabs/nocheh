import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {HonchoProvenanceRepository} from '../src/stores/honcho-provenance.js';

test('Honcho ancestry maps only verified ingestion receipts and current authorized workspaces to original evidence',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const key='provenance:'+Date.now(),workspace=digest(key),conclusion='c'.repeat(21),message='m'.repeat(21),receipt=digest(key+':receipt');
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-42',source_id:'1',revision:'1',occurred_at:null,text:'Synthetic evidence',payload:{}};
  let mutate=false,calls=0;
  const call=async(path:string,body:any)=>{
    calls++;assert.equal(path,'/v3/workspaces/'+workspace+'/nocheh/provenance');assert.deepEqual(body,{conclusion_ids:[conclusion]});
    if(mutate)await stores.control.query('UPDATE guard_state SET epoch=epoch+1');
    return {roots:[conclusion],nodes:[{id:conclusion,parents:[],deleted:false}],messages:[{message_id:message,receipt_id:receipt},{message_id:'x'.repeat(21),receipt_id:digest('unknown')}],limitations:[],exact_citations:true};
  };
  const provenance=new HonchoProvenanceRepository(stores,archive,guards,call);
  try {
    const source=(await archive.capture(event)).source.reference,binding=await guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    await stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,content_hash,state,remote_id)
      VALUES($1,$2,$3,$4,$5,$6,'done',$7)`,[receipt,workspace,JSON.stringify(source),'events:'+source.id,digest(key+':prepared'),digest('fixture'),message]);
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],binding),{code:'memory_context_retired'});
    assert.equal(calls,0,'detached memory does not invoke native readers');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true');
    const result=await provenance.read(workspace,'owner',[conclusion],binding);
    assert.deepEqual(result.evidence,[source]);assert.equal(result.exact_citations,false,'ancestry never claims exact citation precision');
    assert.ok(result.limitations.includes('ingestion_reference_unavailable'));
    await assert.rejects(provenance.read(workspace,'-42',[conclusion],binding),{code:'memory_context_retired'});
    mutate=true;
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],binding),{code:'guard_context_changed'});
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],await guards.state()),{code:'memory_context_retired'});
  } finally {
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false');
    await stores.close();
  }
});
