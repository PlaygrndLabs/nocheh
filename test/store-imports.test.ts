import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {scopeToken} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageServer} from '../src/stores/server.js';
import {workflowDetail} from '../src/workflows/owner.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';

test('host imports preserve originals through retries and fence job writes, learning consent, and owner controls',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-import-')),key='import:'+Date.now(),token=digest(key);
  const owner={admin:true,scope:null},policy={enabled:true,owner_id:'123',group_ids:[]};
  const runtime=async()=>{throw Error('imports must not execute an agent or provider');};
  const s=storageServices(stores,{dataDir:root,serviceToken:token,detectorVersion:'fixture',policy:()=>policy,runtime,honcho:runtime});
  const settings:Settings={service:'nocheh-app',host:'127.0.0.1',port:0,token,databasePassword:'',storageLayout:'original-only-v1',dataDir:root,
    hermesUrl:'http://fixture',honchoUrl:'http://fixture',memoryToken:'',guardMode:'on',guardTrusted:[],detectorVersion:'fixture',assistant:policy};
  await s.guards.reconcile();await s.configuration.configure(policy,'on');
  const server=storageServer(s,settings,runtime);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const request=async(path:string,body?:unknown,status=200,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{headers:{authorization:'Bearer '+token,...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const value=await response.json() as any;assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  const job=async(review:boolean)=>{
    const id=randomUUID(),input={id,configuration_hash:digest(key+id),review_approved:review,total:1};
    await request('/v1/workflows/imports/confirm',input);
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='imports' AND job_id=$1 ORDER BY generation DESC LIMIT 1",[id])).rows[0];
    const claim=await request('/v1/workflows/host/claim',{workflow_id:row.id,dispatch:row.dispatch,family:'imports',run_id:digest(key+id)});assert.equal(claim.claimed,true);
    return {id,input,row,claim,headers:{'x-nocheh-import-job':id,'x-nocheh-import-lease':claim.job.lease_token,'x-nocheh-import-owner':'inngest'}};
  };
  const record=(suffix:string)=>{
    const bytes=Buffer.from('Original imported file \r\n'+suffix),source=key+suffix,id=digest(source),ref='file:'+suffix;
    const event:Envelope={version:1,key:source,origin:'import',bot_id:'desktop-export',kind:'telegram_desktop_message',scope:'123',source_id:'44',revision:'1',occurred_at:null,text:'original '+suffix,
      payload:{chat:{id:123,type:'personal_chat'},message:{id:44,type:'message',text:'original '+suffix}}};
    const artifact={id:digest(id+':'+ref),source_ref:ref,kind:'document',metadata:{},file_hash:digest(bytes),byte_size:bytes.length};
    return {input:{id,event,artifacts:[artifact],derived:[]},bytes,artifact};
  };
  try{
    const first=await job(true),second=await job(false),original=record(':first');
    await request('/v1/import',original.input,403,{authorization:'Bearer '+scopeToken(token,'123',Date.now()+60000)});
    await request('/v1/projects',{},403,first.headers);
    await request('/v1/import',{...original.input,event:{...original.input.event,origin:'live'}},403,first.headers);
    // Simulate a lost archive acknowledgment before membership/handoff commits.
    const capture=s.archive.capture.bind(s.archive);s.archive.capture=async(...args)=>{await capture(...args);throw Error('fixture import archive acknowledgment lost');};
    try{await request('/v1/import',original.input,503,first.headers);}finally{s.archive.capture=capture;}
    assert.equal((await stores.control.query('SELECT 1 FROM import_sources WHERE job_id=$1',[first.id])).rowCount,0);
    assert.equal((await request('/v1/import',original.input,200,first.headers)).duplicate,true);
    assert.equal((await request('/v1/import',original.input,200,first.headers)).duplicate,true);
    const reference=(await s.archive.captured(original.input.id)).reference;
    assert.equal(await s.access.canLearn(reference,await s.guards.state()),false);
    assert.equal((await stores.control.query("SELECT 1 FROM workflow_registry WHERE family='telegram' AND job_id=$1",[original.input.id])).rowCount,0);
    const upload={bytes_base64:original.bytes.toString('base64'),sha256:digest(original.bytes)};
    await request('/v1/artifacts/'+original.artifact.id+'/bytes',upload,403,second.headers);
    await request('/v1/artifacts/'+original.artifact.id+'/bytes',upload,200,first.headers);
    assert.deepEqual(await s.sourcePortability.bytes(owner,original.artifact.id),original.bytes);
    await request('/v1/memory/reviews',{approved:true,batch:second.id,event_ids:[original.input.id]},403,second.headers);
    const foreign=record(':foreign');await request('/v1/import',foreign.input,200,second.headers);
    await request('/v1/memory/reviews',{approved:true,batch:first.id,event_ids:[foreign.input.id]},403,first.headers);
    const consent={approved:true,batch:first.id,event_ids:[original.input.id]};
    const approved=await request('/v1/memory/reviews',consent,200,first.headers);assert.equal(approved.newly_enabled,1);assert.equal(approved.telegram_replies,0);
    const binding=await s.guards.state();assert.equal(await s.access.canLearn(reference,binding),true);
    await request('/v1/memory/reviews',consent,200,first.headers);assert.equal((await s.guards.state()).epoch,binding.epoch);
    await s.access.setConsent(owner,reference,{enabled:false,expected_revision:1,operation_id:key+':revoke'});
    await request('/v1/memory/reviews',consent,200,first.headers);assert.equal(await s.access.canLearn(reference,await s.guards.state()),false,'replay cannot undo owner revocation');
    const finish={workflow_id:first.row.id,token:first.claim.token,import_token:first.claim.job.lease_token,result:{completed:1,duplicates:1,learning_after:1,complete:true}};
    const receipt=await request('/v1/workflows/host/finish',finish);assert.equal(receipt.state,'completed');
    assert.deepEqual(await request('/v1/workflows/host/finish',finish),receipt);
    await request('/v1/import',original.input,409,first.headers);
    let detail=await workflowDetail(stores.control,first.row.id);assert.equal(detail.completed,1);assert.equal(detail.total,1);assert.equal(detail.duplicates,1);assert.equal(detail.learning_after,1);
    assert.equal(detail.can_cancel,false);assert.equal(detail.source_event_id,null);
    const secondFinish={workflow_id:second.row.id,token:second.claim.token,import_token:second.claim.job.lease_token,failure_code:'transient'};
    await request('/v1/workflows/host/finish',secondFinish);
    detail=await workflowDetail(stores.control,second.row.id);assert.equal(detail.can_retry,true);assert.equal(detail.can_cancel,true);
    await controlStorageWorkflow(stores.control,owner,second.row.id,'retry',{revision:detail.revision});
    detail=await workflowDetail(stores.control,second.row.id);await controlStorageWorkflow(stores.control,owner,second.row.id,'cancel',{revision:detail.revision});
    assert.equal((await request('/v1/workflows/imports/'+second.id)).job.state,'cancelled');
    await request('/v1/import',foreign.input,409,second.headers);
    const third=await job(false);await stores.control.query("UPDATE workflow_imports SET lease_until=now()-interval '1 second' WHERE id=$1",[third.id]);
    await request('/v1/import',record(':expired').input,409,third.headers);
    await request('/v1/workflows/imports/cancel',{id:third.id});
    await request('/v1/workflows/imports/confirm',{...third.input,resume:true});
    await request('/v1/import',record(':old-generation').input,409,third.headers);
    // A held source write and cancellation serialize on the control job row.
    const fourth=await job(false),racing=record(':racing');
    let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    s.archive.capture=async(...args)=>{entered();await gate;return capture(...args);};
    const pending=request('/v1/import',racing.input,200,fourth.headers);await started;
    const db=await stores.control.connect();try{await db.query('BEGIN');await assert.rejects(db.query('SELECT id FROM workflow_imports WHERE id=$1 FOR UPDATE NOWAIT',[fourth.id]),{code:'55P03'});await db.query('ROLLBACK');}finally{db.release();}
    const cancelling=request('/v1/workflows/imports/cancel',{id:fourth.id});release();
    try{await pending;await cancelling;}finally{s.archive.capture=capture;}
    await request('/v1/import',racing.input,409,fourth.headers);
    assert.equal((await s.sourcePortability.record(owner,racing.input.id)).event.text,racing.input.event.text);
    await request('/v1/workflows/host/heartbeat',{});
    assert.equal((await stores.control.query("SELECT app FROM workflow_worker_registrations WHERE family='imports'")).rows[0].app,'host');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await stores.close();await rm(root,{recursive:true,force:true});}
});
