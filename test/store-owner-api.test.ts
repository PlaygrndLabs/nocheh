import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {reader,scopeToken} from '../src/access.js';
import {HttpError,json} from '../src/http.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';

test('owner HTTP manages versions, provenance, corrections, project assignments and sharing with revision checks',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-owner-api-')),key='owner-api:'+Date.now(),token=digest(key);
  let engines=0;
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no provider calls');},
    transcription:{name:'fixture',version:'1',outputKind:'transcript',async run(bytes){engines++;assert.equal(bytes.toString(),'Original voice bytes');return 'Generated reading';}}});
  const api=new OwnerStorageApi(services);
  const server=createServer((req,res)=>{void(async()=>{
    const principal=reader(req,token);if(!await api.handle(principal,req,res,new URL(req.url!,'http://fixture')))throw new HttpError(404,'not_found');
  })().catch(error=>json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'internal_error'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const request=async(path:string,body?:unknown,status=200)=>{
    const response=await fetch(base+path,{headers:{authorization:'Bearer '+token},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const value=await response.json() as any;assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  try {
    const unauthorized=await fetch(base+'/v1/projects',{method:'POST',body:'not json',headers:{authorization:'Bearer '+scopeToken(token,'123',Date.now()+60000)}});
    assert.equal(unauthorized.status,403,'owner authority is checked before body parsing');
    assert.equal((await fetch(base+'/v1/projects')).status,401);
    assert.equal((await request('/v1/derivation-engines')).engines.length,2);
    const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'88',revision:'1',occurred_at:null,text:'A convention',
      payload:{message:{message_id:88,chat:{id:123,type:'private'},voice:{file_id:key}}}};
    const captured=(await services.capture.capture(event)).source,file=await services.attachments.commit(captured.artifact_ids[0]!,Buffer.from('Original voice bytes'));
    const body={artifact_id:file.id,input_hash:file.input_hash,producer:'fixture',producer_version:'1',configuration:{},operation_id:key+':reprocess'};
    const first=await request('/v1/sources/'+file.event.id+'/reprocess',body);
    assert.equal((await request('/v1/sources/'+file.event.id+'/reprocess',body)).id,first.id);
    await request('/v1/sources/'+file.event.id+'/reprocess',{...body,input_hash:digest('other')},409);
    const output=await services.reprocessing.run(first.id,'fixture',services.detect,{owner:'inngest',epoch:1});assert.ok(output);assert.equal(engines,1);
    assert.equal((await request('/v1/sources/'+file.event.id+'/reprocess',body)).state,'done');
    const versions=await request('/v1/sources/'+file.event.id+'/derivatives');assert.equal(versions.versions.length,1);assert.equal(versions.versions[0].producer,'fixture');
    const detail=await request('/v1/derivatives/'+output.id);assert.equal(detail.input_hash,file.input_hash);assert.equal(detail.source,'nocheh:event:'+file.event.id);
    assert.equal(Buffer.from(detail.content_base64,'base64').toString(),'Generated reading');
    const activation={expected_revision:null,operation_id:key+':activate'};
    assert.equal((await request('/v1/derivatives/'+output.id+'/activate',activation)).revision,1);
    assert.equal((await request('/v1/derivatives/'+output.id+'/activate',activation)).revision,1);
    await request('/v1/derivatives/'+output.id+'/activate',{...activation,operation_id:key+':stale'},409);
    const guardPath='/v1/guards/derived_artifacts/'+output.id,guard=await request(guardPath);
    const edit={expected_revision:guard.active_revision,operation_id:key+':guard',content:{text:'Owner guarded reading',kind:'transcript',provenance:{}}};
    await request(guardPath,edit);await request(guardPath,{...edit,operation_id:key+':staleguard'},409);
    assert.equal((await request(guardPath+'/history')).revisions.length,2);
    assert.equal((await request(guardPath+'/revisions/'+guard.active_revision)).content.text,'Generated reading');

    const project=await request('/v1/projects',{name:key,description:'Synthetic',state:'active',expected_revision:0,operation_id:key+':project'});
    const space='-'+Date.now(),assignment={space_id:space,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'};
    await request('/v1/projects/assignments',assignment);
    assert.equal((await request('/v1/projects/effective?space='+encodeURIComponent(space+'/topic/77'))).project.id,project.id);
    await request('/v1/projects/assignments',{...assignment,operation_id:key+':staleassignment'},409);
    const sharing=await request('/v1/sharing/rules',{name:key,sources:[space],destination:'123',enabled:true,mode:'approved',instructions:'Only the selected facts',expected_revision:0,operation_id:key+':share'});
    assert.equal(sharing.mode,'approved');assert.ok((await request('/v1/sharing/rules')).rules.some((r:any)=>r.id===sharing.id));
    const archived=await request('/v1/projects',{id:project.id,name:key,description:'Synthetic',state:'archived',expected_revision:project.revision,operation_id:key+':archive'});
    assert.equal(archived.state,'archived');

    await services.guards.prepare(file.event,'fixture',services.detect);
    const binding=await services.guards.state(),guarded=await services.guards.read('events:'+file.event.id,binding),entry=digest(key+':learned');
    await services.learned.publishAutomatic(entry,{kind:'meaning',subject:'check mark',text:'A contextual meaning',scope:{kind:'conversation',id:'123'},
      uncertainty:'supported',evidence:[file.event],conflicts:[]},null,key+':learned',[{source_id:'events:'+file.event.id,revision:guarded.revision,value_hash:digest(canonical(guarded.value))}],binding,'fixture',services.detect);
    assert.equal((await request('/v1/learned/'+entry)).active_revision,1);
    const correction={expected_revision:1,operation_id:key+':correct',text:'Owner corrected meaning',retired:false};
    assert.equal((await request('/v1/learned/'+entry+'/correct',correction)).revision,2);
    assert.equal((await request('/v1/learned/'+entry+'/correct',correction)).revision,2);
    await request('/v1/learned/'+entry+'/correct',{...correction,operation_id:key+':stalecorrection'},409);
    assert.equal((await request('/v1/learned/'+entry+'/correct',{expected_revision:2,operation_id:key+':retire',retired:true})).revision,3);
    const history=await request('/v1/learned/'+entry+'/history');assert.equal(history.versions.length,3);assert.equal(history.versions[0].author,'owner');assert.equal(history.versions[0].retired,true);
    assert.ok((await request('/v1/learned?scope_kind=conversation&scope_id=123')).entries.some((e:any)=>e.id===entry&&e.retired));
    await request('/v1/learned?scope_kind=invalid&scope_id=123',undefined,400);
    assert.equal(engines,1,'owner inspection/corrections never rerun the source engine');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await stores.close();await rm(root,{recursive:true,force:true});}
});
