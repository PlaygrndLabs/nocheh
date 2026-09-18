import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {reader,scopeToken} from '../src/access.js';
import {HttpError,json} from '../src/http.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository,sourceIdentity,type CapturedSource} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {SourcePortabilityRepository} from '../src/stores/source-portability.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';

test('source-only portable records preserve originals and recover imports without live replies or learning',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-source-portable-')),key='source-portable:'+Date.now(),token=digest(key);
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async()=>{throw Error('no runtime calls');},honcho:async()=>{throw Error('no Honcho calls');}}),api=new OwnerStorageApi(s);
  const server=createServer((req,res)=>{void(async()=>{
    if(!await api.handle(reader(req,token),req,res,new URL(req.url!,'http://fixture')))throw new HttpError(404,'not_found');
  })().catch(error=>json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'internal_error'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const request=async(path:string,body?:unknown,status=200)=>{
    const response=await fetch(base+path,{headers:{authorization:'Bearer '+token},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const value=await response.json() as any;assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  const event=(suffix:string):Envelope=>({version:1,key:key+suffix,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'88',revision:'1',
    occurred_at:'2026-08-01T00:00:00Z',text:'Original text \r\n متن',payload:{message:{message_id:88,chat:{id:123,type:'private'},document:{file_id:key+suffix}}},
    wire_base64:Buffer.from('  {"literal":"raw bytes"}\r\n').toString('base64')});
  const record=(suffix:string,bytes=Buffer.from([79,103,103,0,255]))=>{
    const e=event(suffix),id=digest(e.key),artifactId=digest(id+':'+e.key);
    return {id,received_at:'2026-08-01T00:01:00.000Z',event:e,artifacts:[{id:artifactId,source_ref:e.key,kind:'document',metadata:{file_id:e.key},file_hash:digest(bytes),byte_size:bytes.length}]};
  };
  const noLiveWork=async(id:string)=>{
    const jobs=(await stores.control.query('SELECT family FROM workflow_registry WHERE job_id IN ($1,$2)',[id,'source:'+id])).rows.map(r=>r.family);
    assert.ok(jobs.includes('preparation'));assert.ok(!jobs.includes('telegram'));assert.ok(!jobs.includes('memory_review'));
    assert.equal(await s.access.canLearn((await s.archive.captured(id)).reference,await s.guards.state()),false);
  };
  const dead=new pg.Pool(config);await dead.end();
  try {
    const input=record(':roundtrip'),bytes=Buffer.from([79,103,103,0,255]);
    const denied=await fetch(base+'/v1/imports/sources',{method:'POST',headers:{authorization:'Bearer '+scopeToken(token,'123',Date.now()+60000)},body:'not json'});
    assert.equal(denied.status,403,'owner authority precedes parsing');
    await request('/v1/imports/sources',{...input,derived:[{content_base64:'YQ=='}]},400);
    assert.equal((await stores.control.query('SELECT 1 FROM source_intakes WHERE event_id=$1',[input.id])).rowCount,0);
    await request('/v1/imports/sources',{...input,id:digest('wrong')},409);
    await request('/v1/imports/sources',{...input,event:{...input.event,origin:'generated'}},400);
    assert.equal((await request('/v1/imports/sources',input)).duplicate,false);
    assert.equal((await request('/v1/imports/sources',input)).duplicate,true);
    await noLiveWork(input.id);
    const exported=await s.sourcePortability.record(owner,input.id);
    assert.deepEqual(exported.event,input.event);assert.equal(exported.received_at,input.received_at);assert.equal(exported.reference.input_hash,sourceIdentity(input.event).inputHash);
    assert.equal(exported.artifacts[0]!.file_hash,digest(bytes));assert.ok(!('derived' in exported));assert.ok(!('guarded' in exported));
    let downloads=0;await s.attachments.fetch(input.id,async()=>{downloads++;return bytes;},{owner:'inngest',epoch:1});
    assert.equal(downloads,0);assert.equal((await stores.control.query('SELECT error_code FROM attachment_retrievals WHERE event_id=$1',[input.id])).rows[0].error_code,'import_bytes_pending');
    const filePath='/v1/original-files/'+input.artifacts[0]!.id+'/bytes';
    await request(filePath,{bytes_base64:Buffer.from('wrong').toString('base64'),sha256:digest('wrong')},409);
    await request(filePath,{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});
    const downloaded=await fetch(base+filePath,{headers:{authorization:'Bearer '+token}});
    assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    await s.attachments.fetch(input.id,async()=>{downloads++;return bytes;},{owner:'inngest',epoch:1});assert.equal(downloads,0);
    await s.access.setConsent(owner,exported.reference,{enabled:true,expected_revision:0,operation_id:key+':consent'});
    assert.equal(await s.access.canLearn(exported.reference,await s.guards.state()),true,'explicit owner consent is separate from observed origin');
    const empty=record(':empty',Buffer.alloc(0));await s.sourcePortability.import(owner,empty);
    await s.sourcePortability.upload(owner,empty.artifacts[0]!.id,{bytes_base64:'',sha256:digest(Buffer.alloc(0))});
    assert.equal((await s.sourcePortability.bytes(owner,empty.artifacts[0]!.id)).length,0);
    const omitted=record(':omitted-manifest');await s.sourcePortability.import(owner,{...omitted,artifacts:[]});
    assert.equal((await s.sourcePortability.record(owner,omitted.id)).artifacts.length,1,'observed attachments cannot disappear from an import');
    await s.attachments.fetch(omitted.id,async()=>{downloads++;return bytes;},{owner:'inngest',epoch:1});assert.equal(downloads,0);
    const bad=record(':bad-manifest');await assert.rejects(s.sourcePortability.import(owner,{...bad,artifacts:[{...bad.artifacts[0],metadata:{invented:true}}]}),{code:'artifact_metadata_conflict'});
    await assert.rejects(s.archive.captured(bad.id),{code:'source_not_found'});

    // Read-only source export remains available without control or derived access.
    const offline=new SourcePortabilityRepository(new CaptureCoordinator(s.archive,dead),s.attachments);
    assert.deepEqual(await offline.record(owner,input.id),await s.sourcePortability.record(owner,input.id));
    assert.equal((await offline.page(owner)).format,'nocheh-sources-v1');
    const unavailable=record(':control-down');await assert.rejects(offline.import(owner,unavailable));
    await assert.rejects(s.archive.captured(unavailable.id),{code:'source_not_found'});

    class InterruptedArchive extends ArchiveRepository {
      override async capture(...args:Parameters<ArchiveRepository['capture']>):ReturnType<ArchiveRepository['capture']> {await super.capture(...args);throw Error('crash_after_archive_commit');}
    }
    const interrupted=record(':after-archive');
    await assert.rejects(new SourcePortabilityRepository(new CaptureCoordinator(new InterruptedArchive(stores.archive),stores.control),s.attachments).import(owner,interrupted),/crash_after_archive_commit/);
    assert.equal((await stores.control.query('SELECT state FROM source_intakes WHERE event_id=$1',[interrupted.id])).rows[0].state,'pending');
    assert.equal(await s.access.canLearn((await s.archive.captured(interrupted.id)).reference,await s.guards.state()),false);
    // Bounded full sweeps repair the pending import independently of the client.
    for(let i=0;i<1000;i++){await s.capture.reconcile(200);if((await stores.control.query('SELECT 1 FROM capture_handoffs WHERE event_id=$1',[interrupted.id])).rowCount)break;}
    await noLiveWork(interrupted.id);assert.equal((await s.sourcePortability.import(owner,interrupted)).duplicate,true);
    class InterruptedHandoff extends CaptureCoordinator {override async handoff(_source:CapturedSource){throw Error('crash_before_handoff');}}
    const handed=record(':before-handoff');await assert.rejects(new SourcePortabilityRepository(new InterruptedHandoff(s.archive,stores.control),s.attachments).import(owner,handed),/crash_before_handoff/);
    for(let i=0;i<1000;i++){await s.capture.reconcile(200);if((await stores.control.query('SELECT 1 FROM capture_handoffs WHERE event_id=$1',[handed.id])).rowCount)break;}
    await noLiveWork(handed.id);
    // A duplicate import cannot demote an already admitted live observation.
    const live=(await s.capture.capture(event(':live'))).source;
    await s.sourcePortability.import(owner,await s.sourcePortability.record(owner,live.reference.id));
    assert.equal((await stores.control.query('SELECT transport FROM source_intakes WHERE event_id=$1',[live.reference.id])).rows[0].transport,'capture');
    assert.equal(await s.access.canLearn(live.reference,await s.guards.state()),true);
    const page=await request('/v1/exports/sources?limit=3');assert.equal(page.format,'nocheh-sources-v1');assert.equal(page.records.length,3);
    for(const r of page.records){assert.ok(!('derived' in r));assert.ok(!('guarded' in r));assert.notEqual(r.event.origin,'generated');}
    await request('/v1/exports/sources?limit=51',undefined,400);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await stores.close();await rm(root,{recursive:true,force:true});}
});
