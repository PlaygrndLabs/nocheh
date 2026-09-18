import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {scopeToken} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageServer} from '../src/stores/server.js';
import {startStorageCapture} from '../src/stores/worker.js';

test('separated application captures through control outages, exposes owner repositories and fences inactive restores',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const connected=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-http-')),key='http:'+Date.now(),token=digest(key);
  let controlDown=false,archiveDown=false;
  const unavailable=(pool:pg.Pool,down:()=>boolean)=>new Proxy(pool,{get(target,key){
    const value=Reflect.get(target,key);if(typeof value!=='function')return value;
    return (...args:unknown[])=>{if(down()&&['query','connect'].includes(String(key)))return Promise.reject(Error('fixture database outage'));return value.apply(target,args);};
  }});
  const stores:StorePools={...connected,archive:unavailable(connected.archive,()=>archiveDown),control:unavailable(connected.control,()=>controlDown)};
  const policy={enabled:true,owner_id:'123',group_ids:['-42']};let nativeCalls=0;
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='memory.recall'){nativeCalls++;assert.equal(input.generation,(await services.guards.state()).generation);assert.equal(input.guard_epoch,(await services.guards.state()).epoch);return {hits:[]};}
    throw Error('unexpected external operation');
  };
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,serviceToken:token,runtime,honcho:async()=>{throw Error('no native provider calls');}});
  const settings:Settings={service:'nocheh-app',host:'127.0.0.1',port:0,token,databasePassword:'',storageLayout:'original-only-v1',dataDir:root,
    hermesUrl:'http://fixture',honchoUrl:'http://fixture',memoryToken:'',guardMode:'on',guardTrusted:[],detectorVersion:'fixture',assistant:policy};
  await mkdir(join(root,'workflows'),{recursive:true});await writeFile(join(root,'workflows/inactive'),'fixture: no Inngest connection');
  await services.guards.reconcile();await services.guards.setMode('on');
  const worker=startStorageCapture(services,settings,25),server=storageServer(services,settings,runtime,worker.status);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const request=async(path:string,body?:unknown,status=200,credential=token)=>{
    const response=await fetch(base+path,{headers:{authorization:'Bearer '+credential},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const result=await response.json() as any;assert.equal(response.status,status,JSON.stringify(result));return result;
  };
  const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<400;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}assert.fail('fixture progress timeout');};
  try {
    assert.deepEqual((await request('/health')).databases,{archive:'ready',derived:'ready',control:'ready'});
    assert.equal((await request('/v1/security/policy')).source,'owner security policy');
    await request('/v1/security/preview',{action_id:digest(key)},404);
    const project=await request('/v1/projects',{name:key,description:'HTTP rehearsal',state:'active',expected_revision:0,operation_id:key+':project'});
    assert.equal(project.name,key);
    const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:String(Date.now()),revision:'1',occurred_at:null,text:'Original HTTP observation',
      payload:{message:{message_id:Date.now(),chat:{id:123,type:'private'},from:{id:123},text:'Original HTTP observation'}}};
    controlDown=true;archiveDown=true;
    await request('/health',undefined,503);
    await request('/v1/ingest',event,403,scopeToken(token,'123',Date.now()+60000));
    const accepted=await request('/v1/ingest',event,202);assert.equal(accepted.state,'spooled');
    const path=join(root,'spool/pending',digest(key)+'.json');assert.equal(JSON.parse(await readFile(path,'utf8')).text,event.text);
    await request('/v1/ingest',event,202);
    await request('/v1/ingest',{...event,text:'Changed observation'},409);
    archiveDown=false;
    await until(async()=>!!(await connected.archive.query('SELECT 1 FROM events WHERE id=$1',[digest(key)])).rowCount);
    assert.ok((await readdir(join(root,'spool/pending'))).includes(digest(key)+'.json'),'control outage retains the spool after archive commit');
    controlDown=false;
    await until(async()=>!(await readdir(join(root,'spool/pending'))).includes(digest(key)+'.json'));
    assert.equal((await connected.archive.query('SELECT count(*)::int AS count FROM events WHERE id=$1',[digest(key)])).rows[0].count,1);
    assert.equal((await connected.control.query('SELECT state FROM source_intakes WHERE event_id=$1',[digest(key)])).rows[0].state,'ready');
    const captured=(await services.archive.captured(digest(key))).reference;
    const output=await services.derived.record({operation_id:key+':derivative',source:captured,kind:'extracted_text',content:Buffer.from('Synthetic derived reading'),producer:'fixture',producer_version:'1',configuration:{}});
    await services.guards.prepare(output,'fixture',services.detect);
    const finish=services.selections.finish.bind(services.selections);services.selections.finish=async()=>{throw Error('lost selection completion');};
    try{await assert.rejects(services.selections.activate(output,null,key+':selection'),/lost selection completion/);}finally{services.selections.finish=finish;}
    await until(async()=>!(await connected.control.query("SELECT 1 FROM guard_publications WHERE id=$1 AND state='pending'",[key+':selection'])).rowCount);
    assert.equal((await services.selections.current(captured.id,null,'extracted_text',await services.guards.state())).id,output.id,'worker repairs interrupted selection publication');
    await services.guards.prepare((await services.archive.captured(digest(key))).reference,'fixture',services.detect);
    const binding=await services.guards.state(),credential=await services.prepared.audience.turn(token,{scope:null,space:'123'},digest(key),Date.now()+60000);
    assert.equal((await request('/v1/events/'+digest(key),undefined,200,credential)).event.text,event.text);
    await request('/v1/memory/recall',{query:'observation',generation:'untrusted',guard_epoch:-1},200,credential);assert.equal(nativeCalls,1);
    const proposal=await request('/v1/action-requests',{destination:'current',text:'Synthetic approval preview'},200,credential);
    const tool=await request('/v1/tools/propose',{kind:'shell',arguments:{command:'pwd'}},200,credential);
    assert.equal((await request('/v1/tools/actions/'+tool.id)).arguments.command,'pwd');
    assert.equal((await request('/v1/security/preview',{action_id:tool.id})).decision.outcome,'ask');
    await request('/v1/tools/decide',{id:tool.id,fingerprint:tool.fingerprint,decision:'approve'},403,credential);
    assert.equal((await request('/v1/tools/decide',{id:tool.id,fingerprint:tool.fingerprint,decision:'approve'})).state,'approved');
    const toolWorkflow=(await connected.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[tool.id])).rows[0];
    await request('/v1/workflows/host/heartbeat',{});
    await request('/v1/workflows/host/claim',{workflow_id:toolWorkflow.id,dispatch:1,family:'tools',run_id:'fixture'},403,credential);
    const toolLease=await request('/v1/workflows/host/claim',{workflow_id:toolWorkflow.id,dispatch:1,family:'tools',run_id:'fixture'});
    const toolIdentity={id:tool.id,actor:'wf-'+toolWorkflow.id,workflow_id:toolWorkflow.id,workflow_token:toolLease.token};
    await request('/v1/tools/claim',toolIdentity,403,credential);
    assert.equal((await request('/v1/tools/claim',toolIdentity)).arguments.command,'pwd');
    assert.equal((await request('/v1/tools/start',toolIdentity)).started,true);
    assert.equal((await request('/v1/tools/start',toolIdentity)).started,false);
    await request('/v1/tools/finish',{id:tool.id,actor:toolIdentity.actor,state:'done',result:{stdout:'synthetic HTTP result'}});
    assert.equal((await request('/v1/workflows/host/finish',{workflow_id:toolWorkflow.id,token:toolLease.token,result:{observed:true}})).state,'completed');
    assert.equal(proposal.state,'proposed');assert.equal((await request('/v1/tools/actions/'+proposal.id,undefined,200,credential)).arguments.text,'Synthetic approval preview');
    await request('/v1/tools/telegram-decision',{id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve'},403,credential);
    assert.equal((await request('/v1/tools/telegram-decision',{id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve'})).state,'approved');
    assert.ok((await request('/v1/tools/actions')).telegram.some((row:any)=>row.id===proposal.id));
    await request('/internal/actions/authorize',{id:proposal.id,destination:'123',text:'Synthetic approval preview'},401,credential);
    await request('/internal/actions/authorize',{id:proposal.id,destination:'123',text:'Synthetic approval preview'},403);
    await connected.control.query("UPDATE telegram_action_requests SET state='running' WHERE id=$1",[proposal.id]);
    assert.equal((await request('/internal/actions/authorize',{id:proposal.id,destination:'123',text:'Synthetic approval preview'})).valid,true);
    await request('/internal/actions/authorize',{id:proposal.id,destination:'123',text:'different message'},403);
    assert.equal((await request('/v1/exports/sources?limit=1')).format,'nocheh-sources-v1');
    assert.ok(Array.isArray((await request('/v1/workflows?limit=1')).workflows));
    assert.ok(Array.isArray((await request('/v1/workflows/health')).workers));
    assert.ok(Array.isArray((await request('/v1/workflows/metrics?range=24h')).buckets));
    await request('/v1/workflows',undefined,403,credential);
    await request('/v1/workflows/migrations',{},409);
    await request('/v1/export',undefined,404);
    await services.guards.setMode('off');
    await request('/v1/memory/check',undefined,409,credential);assert.notEqual((await services.guards.state()).epoch,binding.epoch);
    const offCredential=await services.prepared.audience.turn(token,{scope:null,space:'123'},digest(key),Date.now()+60000);
    await request('/v1/memory/check',undefined,503,offCredential);
    settings.guardMode='off';
    assert.equal((await request('/v1/events/'+digest(key),undefined,200,offCredential)).representation,'original');
    await writeFile(join(root,'spool/.restore-inactive'),'inactive restored installation');
    await request('/v1/projects',undefined,503);await request('/v1/ingest',{...event,key:key+':inactive'},503);
    await until(async()=>Object.values(worker.status()).every(value=>value==='inactive'));
    assert.equal((await request('/health')).inactive,true);
  }finally {
    controlDown=false;archiveDown=false;await worker.stop();
    await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});await connected.close();await rm(root,{recursive:true,force:true});
  }
});

test('actual application and security entrypoints start with domain credentials and remain inactive after restore',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:90000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'nocheh-entrypoint-')),token=digest('entrypoint-fixture');
  await mkdir(join(root,'spool'),{recursive:true});await writeFile(join(root,'spool/.restore-inactive'),'synthetic inactive restore');
  const env={...process.env,PGPASSWORD:'',PGPASSWORD_FILE:'',INNGEST_POSTGRES_PASSWORD:'',INNGEST_POSTGRES_PASSWORD_FILE:'',
    NOCHEH_ARCHIVE_PASSWORD:digest('archive-fixture'),NOCHEH_DERIVED_PASSWORD:digest('derived-fixture'),NOCHEH_CONTROL_PASSWORD:digest('control-fixture'),
    NOCHEH_STORAGE_LAYOUT:'original-only-v1',NOCHEH_DATA_DIR:root,SERVICE_TOKEN:token,PORT:'0',HOST:'127.0.0.1',TELEGRAM_ENABLED:'false',GUARD_MODE:'on'};
  try {for(const entry of ['main','security/main']) {
    const child=spawn(process.execPath,['dist/src/'+entry+'.js'],{env,stdio:['ignore','pipe','pipe']});
    let output='',error='',code:number|null=null;child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{error+=String(chunk);});child.on('exit',value=>{code=value;});
    try {
      let port=entry==='security/main'?8786:0,ready=false;
      for(let i=0;i<400;i++) {
        assert.equal(code,null,'entrypoint exited: '+error);
        if(!port){const line=output.split('\n').find(line=>line.includes('"event":"ready"'));if(line)port=JSON.parse(line).port;}
        if(port)try {const response=await fetch('http://127.0.0.1:'+port+'/health');if(response.ok){ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.ok(ready,'entrypoint health unavailable: '+error);
      const response=await fetch('http://127.0.0.1:'+port+'/v1/security/policy',{headers:{authorization:'Bearer '+token}});
      assert.equal(response.status,503);assert.equal((await response.json() as any).error,'restored_installation_inactive');
    }finally {
      if(child.exitCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exit;}
    }
  }}finally{await rm(root,{recursive:true,force:true});}
});
