// Real repositories, exact original bytes, and durable owner-edited derivatives.
import assert from 'node:assert/strict';
import {connectStores} from '../dist/src/stores/connections.js';
import {storageServices} from '../dist/src/stores/services.js';
const config={host:'nocheh-db'};
const stores=connectStores(config,Object.fromEntries(['archive','derived','control'].map(s=>[s,process.env['NOCHEH_'+s.toUpperCase()+'_PASSWORD']])));
try {
  assert.equal((await stores.archive.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-recovery-fixture');
  const s=storageServices(stores,{dataDir:'/data',serviceToken:'synthetic-coordinated-recovery-token',policy:()=>({enabled:false,owner_id:'123',group_ids:[]}),
    runtime:async()=>{throw Error('no_provider_allowed');},honcho:async()=>{throw Error('no_provider_allowed');}});
  const source=(await s.capture.capture({version:1,key:'coordinated-recovery',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',
    source_id:'1',revision:'1',occurred_at:null,text:'Original observation\r\n',payload:{message:{message_id:1,date:1700000000,
      chat:{id:123,type:'private'},from:{id:123},text:'Original observation\r\n',voice:{file_id:'synthetic-voice'}}}})).source;
  const file=await s.attachments.commit(source.artifact_ids[0],Buffer.from('Original immutable audio\0\r\n'));
  for(const version of ['1','2']){
    const output=await s.derived.record({operation_id:'recovery-engine-'+version,source:file.event,file,kind:'transcript',content:Buffer.from('Engine reading '+version),
      producer:'fixture',producer_version:version,configuration:{deterministic:true}});
    await s.guards.prepare(output,'fixture',async()=>[]);
    if(version==='1')await s.guards.edit('derived_artifacts:'+output.id,1,{text:'Durable owner wording\r\n',kind:'transcript',provenance:{}},'recovery-owner-edit');
  }
  assert.equal(Number((await stores.derived.query("SELECT count(*) FROM guard_revisions WHERE author='owner'")).rows[0].count),1);
  console.log(JSON.stringify({seeded:true,originals:1,files:1,engine_versions:2,owner_edits:1}));
}finally{await stores.close();}
