import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {turnToken} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {brokerServer} from '../src/security/broker.js';

test('three-store broker binds original and scheduled turns, isolates generations and stops revoked output',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-broker-')),key='broker:'+Date.now(),token='synthetic-service-token-only-for-tests';
  let detectors=0,revocation=false;const calls:{url:string;body:unknown}[]=[];
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async(_operation,input)=>{detectors++;return {literals:String(input.text).includes('saffronpass')?['saffronpass']:[]};},honcho:async()=>{throw Error('no native provider');}});
  const mock:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null});
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://chatgpt.com/backend-api/codex',api_mode:'codex_responses',api_key:'synthetic-credential',model_context_length:100000});
    if(revocation)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      setTimeout(()=>{void services.guards.setMode('off').then(()=>{controller.enqueue(new TextEncoder().encode('data: stale\n\n'));controller.close();});},40);
    }}),{headers:{'content-type':'text/event-stream'}});
    return Response.json({ok:true});
  };
  const server=brokerServer({pool:stores.control,storage:services.turns,token,archive:'http://archive',hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(services),fetch:mock});
  const principal=async(id:string,space='123',scope:string|null=null):Promise<Reader>=>{
    const state=await services.guards.state();return {admin:false,scope,space,turnEvent:id,generation:state.generation,guard_epoch:state.epoch,revision:state.epoch};
  };
  const credential=(actor:Reader)=>turnToken(token,actor.scope,Date.now()+600000,actor.turnEvent!,{space:actor.space!,revision:actor.revision!,guard_epoch:actor.guard_epoch!,generation:actor.generation!});
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:'fixture',scope:'123',source_id:key,revision:'1',occurred_at:null,text:'Observed words',
      payload:{message:{message_id:1,date:1,chat:{id:123,type:'private'},from:{id:123},text:'Observed words',document:{file_id:key,mime_type:'text/plain'}}}};
    const source=(await services.capture.capture(event)).source;
    await services.guards.prepare(source.reference,'fixture',async()=>[]);
    const actor=await principal(source.reference.id),binding=await services.turns.binding(actor);
    assert.equal(binding.generation,actor.generation);assert.notEqual(binding.profile,services.turns.profile({...actor,purpose:'filter'},await services.guards.state()));
    const file=await services.archive.attach(source.artifact_ids[0]!,digest('fixture bytes'),13);
    await services.guards.prepare(file,'fixture',async()=>[]);
    assert.equal(await services.turns.turnFile(actor,file.input_hash),file.id);
    await assert.rejects(services.turns.turnFile(actor,digest('different bytes')),{code:'turn_file_not_found'});
    await assert.rejects(services.turns.binding({...actor,space:'-321'}),{code:'turn_source_denied'});
    await assert.rejects(services.turns.binding({...actor,scope:'-321',space:'-321'}),{code:'turn_source_denied'});
    await assert.rejects(services.turns.binding({...actor,generation:'00000000-0000-0000-0000-000000000000'}),{code:'audience_context_changed'});

    const operation=await services.operations.record({key:key+':scheduled',kind:'scheduled_trigger',scope:'-321/topic/9',input_hash:digest('schedule')});
    const scheduled=await principal(operation.id,'-321/topic/9','-321');
    await assert.rejects(services.turns.binding(scheduled),{code:'runtime_turn_not_admitted'});
    await services.turns.register(scheduled,{logical_profile:'fixture-project',job:'fixture-job'});
    const managed=await services.turns.binding(scheduled);assert.equal(managed.scope,'-321');assert.equal(managed.logical_profile,'fixture-project');assert.equal(managed.job,'fixture-job');
    await services.turns.close(operation.id);
    await assert.rejects(services.turns.binding(scheduled),{code:'runtime_turn_changed'});

    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();const base='http://127.0.0.1:'+address.port;
    const request=(path:string,body:unknown,key=credential(actor))=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});
    const payload={model:'fixture-model',input:[{role:'user',content:'Observed words. Password is saffronpass.'}]};
    await services.sources.read(actor,source.reference.id);
    assert.equal((await request('/codex/responses',payload)).status,200);
    const provider=calls.at(-1)!;assert.ok(!JSON.stringify(provider.body).includes('saffronpass'));assert.ok(JSON.stringify(provider.body).includes('Observed words.'));
    assert.equal((await stores.archive.query("SELECT 1 FROM events WHERE kind IN ('runtime_context','guard_result')")).rowCount,0);
    assert.ok((await stores.derived.query("SELECT 1 FROM derived_artifacts WHERE event_id=$1 AND kind='runtime_context'",[source.reference.id])).rowCount!>0);
    assert.ok((await stores.control.query('SELECT 1 FROM security_events WHERE source_event_id=$1',[source.reference.id])).rowCount!>0);
    assert.deepEqual((await stores.control.query('SELECT source_reference FROM security_events WHERE source_event_id=$1 LIMIT 1',[source.reference.id])).rows[0].source_reference,source.reference);
    assert.equal((await request('/codex/responses',payload,token)).status,403);
    const before=calls.length;
    const oldGeneration=credential({...actor,generation:'00000000-0000-0000-0000-000000000000'});
    assert.equal((await request('/codex/responses',payload,oldGeneration)).status,409);assert.equal(calls.length,before);
    assert.equal((await request('/v1/guard',{destination:'https://fixture.example',payload:{text:'Administrative saffronpass'}},token)).status,200);
    const adminGuard=(await stores.control.query("SELECT id FROM content_operations WHERE kind='service_guard' ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.ok(adminGuard);assert.ok((await stores.derived.query("SELECT 1 FROM derived_artifacts WHERE operation_reference->>'id'=$1",[adminGuard.id])).rowCount!>0);
    revocation=true;
    const streaming=await request('/codex/responses',payload);await assert.rejects(streaming.text());
    revocation=false;const previousDetectors=detectors,offActor=await principal(source.reference.id);
    assert.equal((await request('/codex/responses',payload,credential(offActor))).status,200);assert.equal(detectors,previousDetectors);
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes('saffronpass'));
    assert.equal((await request('/codex/responses',payload)).status,409,'guard off cannot revive an old capability');
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});
