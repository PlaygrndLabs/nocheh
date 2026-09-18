import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';

test('legacy mixed imports preserve original identity and owner history without archiving generated data or reviving authority',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-legacy-import-')),key=root,owner={admin:true,scope:null};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),runtime:async()=>{throw Error('no runtime');},honcho:async()=>{throw Error('no memory calls');}}),api=new OwnerStorageApi(s);
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'14',revision:'1',occurred_at:null,text:'Exact original \r\n متن',payload:{message:{message_id:14,chat:{id:123,type:'private'},text:'Exact original \r\n متن'}}};
  const id=digest(key),bytes=Buffer.from([79,103,103,0,255]),artifactId=digest(id+':original.wav'),derivativeId=digest(key+':old-transcript'),created='2026-09-01T00:00:00.000Z';
  const artifact={id:artifactId,event_id:id,source_ref:'original.wav',kind:'audio',metadata:{filename:'original.wav'},state:'ready',file_hash:digest(bytes),byte_size:String(bytes.length)};
  const originalDerived={id:derivativeId,event_id:id,artifact_id:artifactId,kind:'transcript',content_base64:Buffer.from('Legacy engine wording').toString('base64'),provenance:{producer:'subscription',version:'old'},created_at:created};
  const guard=(source:string,input:unknown,edited:unknown)=>({id:source,active_revision:2,revisions:[
    {revision:1,input_hash:digest(canonical(input)),content:input,author:'automatic',preparation_version:'old-detector',created_at:created},
    {revision:2,input_hash:digest(canonical(input)),content:edited,author:'owner',preparation_version:'old-detector',created_at:created}]});
  const legacy={id,event,received_at:created,artifacts:[artifact],derived:[originalDerived],guarded:{format:'nocheh-guarded-v1',sources:[
    guard('events:'+id,{text:event.text,payload:event.payload},{text:'Owner source representation',payload:event.payload}),
    guard('derived_artifacts:'+derivativeId,{text:'Legacy engine wording',kind:'transcript',provenance:originalDerived.provenance},{text:'Owner corrected transcript',kind:'transcript',provenance:{}})]}};
  const invoke=(method:string,path:string,input?:unknown)=>api.request(owner,method,new URL(path,'http://fixture'),input);
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    await assert.rejects(api.request({admin:false,scope:'123'},'POST',new URL('/v1/imports/legacy','http://fixture'),legacy),{status:403});
    const result=await invoke('POST','/v1/imports/legacy?restore_guarded=true',legacy) as any;
    assert.equal(result.id,id);assert.equal(result.store,'archive');assert.equal(result.guarded,2);assert.equal(result.activated,false);assert.equal(result.telegram_replies,0);
    assert.deepEqual((await s.sourcePortability.record(owner,id)).event,event);
    await s.sourcePortability.upload(owner,artifactId,{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});assert.deepEqual(await s.sourcePortability.bytes(owner,artifactId),bytes);
    const convertedId=digest('derivative:legacy:derived:'+derivativeId);
    const output=(await stores.derived.query('SELECT * FROM derived_artifacts WHERE id=$1',[convertedId])).rows[0];
    assert.equal(output.content.toString(),'Legacy engine wording');assert.equal(output.imported,true);assert.equal(output.artifact_id,artifactId);
    assert.deepEqual(output.provenance.legacy.provenance,originalDerived.provenance);
    await assert.rejects(s.derived.checkpoint(output.operation_id),{code:'imported_result_not_execution_receipt'});
    await assert.rejects(s.guards.read('derived_artifacts:'+convertedId,await s.guards.state()),{code:'guard_preparation_pending'});
    assert.equal((await stores.derived.query("SELECT content FROM guard_revisions WHERE source_id=$1 AND author='owner'",['derived_artifacts:'+convertedId])).rows[0].content.toString(),canonical({text:'Owner corrected transcript',kind:'transcript',provenance:{}}));
    assert.deepEqual((await invoke('GET','/v1/imports/legacy/'+id) as any).records[0].record,legacy);
    assert.equal((await stores.control.query("SELECT 1 FROM workflow_registry WHERE family='telegram' AND job_id=$1",[id])).rowCount,0);
    assert.equal(await s.access.canLearn((await s.archive.captured(id)).reference,await s.guards.state()),false);
    await invoke('POST','/v1/imports/legacy?restore_guarded=true',legacy);
    await s.guards.restore('derived_artifacts:'+convertedId,2,2,key+':adopt');
    await s.guards.edit('derived_artifacts:'+convertedId,3,{text:'Destination owner correction',kind:'transcript',provenance:{}},key+':local-edit');
    await invoke('POST','/v1/imports/legacy?restore_guarded=true',legacy);
    assert.equal(((await s.guards.read('derived_artifacts:'+convertedId,await s.guards.state())).value as any).text,'Destination owner correction');
    const conflicting=structuredClone(legacy);conflicting.guarded.sources[1]!.revisions[1]!.content={text:'Different historical correction',kind:'transcript',provenance:{}};
    await assert.rejects(invoke('POST','/v1/imports/legacy?restore_guarded=true',conflicting),{code:'portable_identity_conflict'});
    assert.equal((await invoke('GET','/v1/imports/legacy/'+id) as any).records.length,2,'conflicting owner history remains durably inspectable');
    const generated:Envelope={...event,key:key+':runtime',origin:'generated',kind:'runtime_context',text:'Internal runtime prompt',payload:{text:'Internal runtime prompt'}};
    const generatedId=digest(generated.key),generatedArtifact=digest(generatedId+':generated.bin');
    const generatedRecord={id:generatedId,event:generated,received_at:created,artifacts:[{...artifact,id:generatedArtifact,event_id:generatedId,source_ref:'generated.bin'}],derived:[]};
    const generatedResult=await invoke('POST','/v1/imports/legacy',generatedRecord) as any;assert.equal(generatedResult.store,'derived');
    assert.equal((await stores.archive.query('SELECT 1 FROM events WHERE id=$1',[generatedId])).rowCount,0);assert.equal((await stores.archive.query('SELECT 1 FROM artifacts WHERE id=$1',[generatedArtifact])).rowCount,0);
    await invoke('POST','/v1/imports/legacy/files/'+generatedArtifact+'/bytes',{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});
    assert.deepEqual((await stores.derived.query('SELECT content FROM derived_artifacts WHERE operation_id=$1',['legacy:file:'+generatedArtifact])).rows[0].content,bytes);
    await assert.rejects(invoke('POST','/v1/imports/legacy/files/'+generatedArtifact+'/bytes',{bytes_base64:'YQ==',sha256:digest('a')}),{code:'artifact_integrity_failed'});
    const mislabeled={...generatedRecord,id:undefined,event:{...generated,key:key+':mislabeled',origin:'live'},artifacts:[]};
    assert.equal((await invoke('POST','/v1/imports/legacy',mislabeled) as any).store,'derived','known runtime kind cannot become evidence through an origin label');
    const deliveredMessage={message_id:345,date:1700000000,chat:{id:123,type:'private'},text:'Actually delivered message'};
    const delivered={...generatedRecord,id:undefined,artifacts:[],event:{...generated,key:key+':delivered',kind:'outbound_result',payload:{state:'delivered',status:200,method:'sendMessage',wire_base64:Buffer.from(JSON.stringify({ok:true,result:deliveredMessage})).toString('base64')}}};
    const observed=await invoke('POST','/v1/imports/legacy',delivered) as any;assert.equal(observed.sources.length,1);
    assert.equal((await s.sourcePortability.record(owner,observed.sources[0].id)).event.text,deliveredMessage.text);
    assert.equal((await stores.control.query("SELECT 1 FROM workflow_registry WHERE family='telegram' AND job_id=$1",[observed.sources[0].id])).rowCount,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
