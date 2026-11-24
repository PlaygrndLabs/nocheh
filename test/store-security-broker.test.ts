import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {reader} from '../src/access.js';
import {keyPass,openKey} from './one-time-key-pass.js';
import type {IncomingMessage} from 'node:http';
import {preparedAudience} from '../src/stores/prepared-context.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {brokerServer} from '../src/security/broker.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('three-store broker binds original and scheduled turns, isolates generations and stops revoked output',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-broker-')),key='broker:'+Date.now(),token='synthetic-service-token-only-for-tests',agentKey='synthetic-agent-login-only-for-tests-0001';
  let detectors=0,revocation=false,refuse=(_url:string):Response|null=>null;const calls:{url:string;body:unknown}[]=[],transports:(string|null)[]=[];
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async(_operation,input)=>{detectors++;return {literals:String(input.text).includes('saffronpass')?['saffronpass']:[]};},memoryEngine:honchoEngine(async()=>{throw Error('no native provider');})});
  const mock:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null});
    if(String(url).endsWith('/internal/security/transport'))transports.push(new Headers(init?.headers).get('authorization'));
    const refused=refuse(String(url));if(refused)return refused;
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000});
    if(revocation)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      setTimeout(()=>{void services.guards.setMode('off').then(()=>{controller.enqueue(new TextEncoder().encode('data: stale\n\n'));controller.close();});},40);
    }}),{headers:{'content-type':'text/event-stream'}});
    return Response.json({ok:true});
  };
  const server=brokerServer({pool:stores.control,storage:services.turns,token,agentKey,archive:'http://archive',hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(services),fetch:mock});
  const principal=async(id:string,space='123',scope:string|null=null):Promise<Reader>=>{
    const state=await services.guards.state();return {admin:false,scope,space,turnEvent:id,generation:state.generation,guard_epoch:state.epoch,revision:state.epoch};
  };
  const credential=async(actor:Reader)=>openKey(stores.control,keyPass(token,actor.scope,Date.now()+600000,actor.turnEvent!,{space:actor.space!,revision:actor.revision!,guard_epoch:actor.guard_epoch!,generation:actor.generation!}));
  const previousRoute=process.env.NOCHEH_REPLY_ROUTE_URL;process.env.NOCHEH_REPLY_ROUTE_URL='https://gateway.example.test/v1';
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
    const scheduled={...await principal(operation.id,'-321/topic/9','-321'),logical_profile:'fixture-project'};
    await assert.rejects(services.turns.binding(scheduled),{code:'runtime_turn_not_admitted'});
    await services.turns.register(scheduled,{logical_profile:'fixture-project',job:'fixture-job'});
    const managed=await services.turns.binding(scheduled);assert.equal(managed.scope,'-321');assert.equal(managed.logical_profile,'fixture-project');assert.equal(managed.job,'fixture-job');
    const {logical_profile:ignoredProfile,...missingProfile}=scheduled;
    await assert.rejects(services.turns.binding(missingProfile),{code:'runtime_profile_changed'});
    await assert.rejects(services.turns.binding({...scheduled,logical_profile:'different'}),{code:'runtime_profile_changed'});
    const namedToken=await services.prepared.audience.turn(token,scheduled,operation.id,Date.now()+60000,{kind:'scheduled',subject:operation.id,attempt:1,person:'owner'});
    const parsed=reader({headers:{authorization:'Bearer '+namedToken}} as IncomingMessage,token);
    assert.equal(parsed.logical_profile,'fixture-project');assert.equal((await services.turns.binding(parsed)).profile,managed.profile);
    const otherOperation=await services.operations.record({key:key+':other-profile',kind:'scheduled_trigger',scope:'-321/topic/9',input_hash:digest('schedule')});
    const other={...scheduled,turnEvent:otherOperation.id,logical_profile:'fixture-research'};
    await services.turns.register(other,{logical_profile:other.logical_profile,job:'fixture-job'});
    assert.notEqual((await services.turns.binding(other)).profile,managed.profile,'named profiles cannot share native state');
    assert.notEqual(preparedAudience(other),preparedAudience(scheduled),'prepared context cannot cross named profiles');
    await services.prepared.allow(scheduled,'saffronpass');
    assert.equal(await services.prepared.prepare(other,'saffronpass',async()=>['saffronpass']),'***','another named profile cannot reuse an allowed fragment');
    const named={...actor,logical_profile:'research'},state=await services.guards.state();
    assert.equal(services.turns.profile(named,state),'nocheh-'+digest(JSON.stringify([state.generation,'123','owner',state.epoch,'assistant','research'])).slice(0,24));
    assert.equal(services.turns.profile({...actor,logical_profile:binding.logical_profile},state),binding.profile,'default native profile still shares owner notes');
    await assert.rejects(services.turns.binding(named),{code:'runtime_turn_not_admitted'});
    for(const invalid of ['../owner','a/b','a.b','x'.repeat(65)]) {
      const bad=keyPass(token,null,Date.now()+60000,actor.turnEvent!,{space:'123',revision:state.epoch,guard_epoch:state.epoch,generation:state.generation,logical_profile:invalid,kind:'scheduled'});
      assert.throws(()=>reader({headers:{authorization:'Bearer '+bad}} as IncomingMessage,token),{code:'invalid_scope_token'});
    }
    await services.turns.close(operation.id);
    await assert.rejects(services.turns.binding(scheduled),{code:'runtime_turn_changed'});

    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();const base='http://127.0.0.1:'+address.port;
    const request=async(path:string,body:unknown,key?:string)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+(key??await credential(actor)),'content-type':'application/json'},body:JSON.stringify(body)});
    const payload={model:'fixture-model',input:[{role:'user',content:'Observed words. Password is saffronpass.'}]};
    await services.sources.read(actor,source.reference.id);
    assert.equal((await request('/v1/chat/completions',payload)).status,200);
    const provider=calls.at(-1)!;assert.ok(!JSON.stringify(provider.body).includes('saffronpass'));
    // The broker checks the one-time key before anything else (ADR-0301): never minted, closed, or outside its kind's routes.
    const keyed=(error:string)=>async(answer:Response)=>assert.equal((await answer.json() as any).error,error);
    const unminted=keyPass(token,actor.scope,Date.now()+600000,actor.turnEvent!,{space:actor.space!,revision:actor.revision!,guard_epoch:actor.guard_epoch!,generation:actor.generation!});
    const beforeKeys=calls.length;
    await request('/v1/chat/completions',payload,unminted).then(keyed('one_time_key_unknown'));
    const closing=await credential(actor);
    await stores.control.query("UPDATE one_time_keys SET closed_at=now(),closed_reason='delivered' WHERE jti=$1",[JSON.parse(Buffer.from(closing.split('.')[1]!,'base64url').toString()).jti]);
    await request('/v1/chat/completions',payload,closing).then(keyed('one_time_key_closed'));
    const filterKey=await openKey(stores.control,keyPass(token,actor.scope,Date.now()+600000,actor.turnEvent!,{space:actor.space!,revision:actor.revision!,guard_epoch:actor.guard_epoch!,generation:actor.generation!,purpose:'filter'}));
    await request('/v1/member-asks',{},filterKey).then(keyed('one_time_key_route_denied'));
    assert.equal(calls.length,beforeKeys,'a refused key reaches no provider and no relay');
    // Hermes is asked for the provider with the agent login, never the master key (ADR-0295).
    assert.ok(transports.length&&transports.every(authorization=>authorization==='Bearer '+agentKey),JSON.stringify(transports));assert.ok(JSON.stringify(provider.body).includes('Observed words.'));
    assert.equal((await stores.archive.query("SELECT 1 FROM events WHERE kind IN ('runtime_context','guard_result')")).rowCount,0);
    assert.ok((await stores.derived.query("SELECT 1 FROM derived_artifacts WHERE event_id=$1 AND kind='runtime_context'",[source.reference.id])).rowCount!>0);
    assert.ok((await stores.control.query('SELECT 1 FROM security_events WHERE source_event_id=$1',[source.reference.id])).rowCount!>0);
    assert.deepEqual((await stores.control.query('SELECT source_reference FROM security_events WHERE source_event_id=$1 LIMIT 1',[source.reference.id])).rows[0].source_reference,source.reference);
    assert.equal((await request('/v1/chat/completions',payload,token)).status,403);
    const before=calls.length;
    const oldGeneration=await credential({...actor,generation:'00000000-0000-0000-0000-000000000000'});
    assert.equal((await request('/v1/chat/completions',payload,oldGeneration)).status,409);assert.equal(calls.length,before);
    // The system guard takes the agent login only (ADR-0295): the master key is refused there, and the agent login reaches
    // nothing else on the broker.
    const guarded=await request('/v1/guard',{destination:'https://fixture.example',payload:{text:'Administrative saffronpass'}},token);
    assert.equal(guarded.status,403);assert.equal((await guarded.json() as any).error,'agent_login_required');
    const system=await request('/v1/guard',{destination:'https://fixture.example',payload:{text:'Administrative saffronpass'}},agentKey);
    assert.equal(system.status,200);assert.ok(!JSON.stringify(await system.json()).includes('saffronpass'));
    for(const path of ['/v1/chat/completions','/mcp','/v1/context/prepare','/v1/guard?x=1'])
      assert.equal((await (await request(path,payload,agentKey)).json() as any).error,'agent_route_not_allowed',path);
    assert.equal((await (await fetch(base+'/v1/security/binding',{headers:{authorization:'Bearer '+agentKey}})).json() as any).error,'agent_route_not_allowed');
    assert.equal((await (await fetch(base+'/anthropic/v1/messages',{method:'POST',headers:{'x-api-key':agentKey,'content-type':'application/json'},body:'{}'})).json() as any).error,'agent_route_not_allowed');
    const adminGuard=(await stores.control.query("SELECT id FROM content_operations WHERE kind='service_guard' ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.ok(adminGuard);assert.ok((await stores.derived.query("SELECT 1 FROM derived_artifacts WHERE operation_reference->>'id'=$1",[adminGuard.id])).rowCount!>0);
    // A message request is told that its chat is not one Nocheh serves, and a task change why a reminder time was not saved
    // (ADR-0254, ADR-0255); any other code, a code from another route's list, or a server error stays opaque.
    const relayed=async(path:string,body:unknown)=>{const answer=await request(path,body);return {status:answer.status,body:await answer.json()};};
    const answering=(path:string,status:number,error:string)=>{refuse=url=>new URL(url).pathname===path?Response.json({error},{status}):null;};
    answering('/v1/action-requests',403,'destination_not_served');
    assert.deepEqual(await relayed('/v1/action-requests',{destination:'b'.repeat(64),text:'Synthetic note'}),{status:403,body:{error:'destination_not_served'}});
    // A member's own switches (ADR-0260): their post to another group, and their web page or outside tool request.
    answering('/v1/action-requests',403,'member_post_not_allowed');
    assert.deepEqual(await relayed('/v1/action-requests',{destination:'b'.repeat(64),text:'Synthetic note'}),{status:403,body:{error:'member_post_not_allowed'}});
    answering('/v1/tools/propose',403,'tool_not_permitted');
    assert.deepEqual(await relayed('/v1/tools/propose',{kind:'browser',input:{url:'https://fixture.example'}}),{status:403,body:{error:'tool_not_permitted'}});
    answering('/v1/owner/tasks',400,'task_reminder_limit');
    assert.deepEqual(await relayed('/v1/owner/tasks',{title:'Synthetic',reminders:['2030-01-04T09:00']}),{status:400,body:{error:'task_reminder_limit'}});
    answering('/v1/owner/tasks/'+'c'.repeat(64),400,'task_reminder_past');
    assert.deepEqual(await relayed('/v1/owner/tasks/'+'c'.repeat(64),{expected_revision:1,reminders:['2001-01-01T09:00']}),{status:400,body:{error:'task_reminder_past'}});
    for(const [path,status,error] of [['/v1/action-requests',403,'made_up_refusal'],['/v1/action-requests',400,'task_reminder_limit'],['/v1/owner/tasks',400,'destination_not_served'],
      ['/v1/action-requests',503,'destination_not_served'],['/v1/owner/tasks',500,'task_reminder_limit']] as const) {
      answering(path,status,error);
      assert.deepEqual(await relayed(path,{title:'Synthetic',destination:'current',text:'Synthetic'}),{status,body:{error:'scoped_archive_unavailable'}},path+' '+status+' '+error);
    }
    // A schedule set by asking (ADR-0290): the turn hears why Nocheh did not save it; any other code stays opaque.
    const definition={scope:'123',profile:'nocheh-'+'0'.repeat(24),job_id:'a1b2c3d4e5f6',definition:{},workflow_cursor:'0'.repeat(64),workflow_sequence:1};
    for(const [status,error] of [[403,'schedule_limit_reached'],[403,'schedule_turn_not_allowed'],[400,'schedule_cron_unsupported'],[409,'schedule_sequence_conflict']] as const) {
      answering('/v1/schedules/turn/definition',status,error);
      assert.deepEqual(await relayed('/v1/schedules/turn/definition',definition),{status,body:{error}},error);
    }
    for(const [status,error] of [[403,'fire_grant_clock'],[400,'task_reminder_limit'],[503,'schedule_limit_reached']] as const) {
      answering('/v1/schedules/turn/definition',status,error);
      assert.deepEqual(await relayed('/v1/schedules/turn/definition',definition),{status,body:{error:'scoped_archive_unavailable'}},error);
    }
    refuse=()=>null;
    assert.deepEqual(await relayed('/v1/schedules/turn/definition',definition),{status:200,body:{ok:true}});
    assert.deepEqual(calls.at(-1),{url:'http://archive/v1/schedules/turn/definition',body:definition});
    // The owner's ask about a member (step 4b) goes on to storage from the owner's own private turn, with the refusals its
    // tool explains; any other code stays opaque, and no other turn may ask.
    const ask={member:'Mira Test',question:'What did she say?'};
    answering('/v1/member-asks',409,'member_chat_several');
    assert.deepEqual(await relayed('/v1/member-asks',ask),{status:409,body:{error:'member_chat_several'}});
    answering('/v1/member-asks',404,'member_not_found');
    assert.deepEqual(await relayed('/v1/member-asks',ask),{status:404,body:{error:'member_not_found'}});
    answering('/v1/member-asks',409,'task_reminder_limit');
    assert.deepEqual(await relayed('/v1/member-asks',ask),{status:409,body:{error:'scoped_archive_unavailable'}});
    refuse=()=>null;
    assert.deepEqual(await relayed('/v1/member-asks',ask),{status:200,body:{ok:true}});
    assert.deepEqual(calls.at(-1),{url:'http://archive/v1/member-asks',body:ask});
    const relays=calls.length,scoped=await request('/v1/member-asks',ask,await credential({...actor,scope:'123'}));
    assert.deepEqual({status:scoped.status,body:await scoped.json()},{status:403,body:{error:'owner_private_turn_required'}});
    assert.equal(calls.length,relays,'a turn that is not the owner\'s own reaches nothing');
    refuse=()=>null;
    revocation=true;
    const streaming=await request('/v1/chat/completions',payload);await assert.rejects(streaming.text());
    revocation=false;const previousDetectors=detectors,offActor=await principal(source.reference.id);
    assert.equal((await request('/v1/chat/completions',payload,await credential(offActor))).status,200);assert.equal(detectors,previousDetectors);
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes('saffronpass'));
    assert.equal((await request('/v1/chat/completions',payload)).status,409,'guard off cannot revive an old capability');
  } finally {if(previousRoute===undefined)delete process.env.NOCHEH_REPLY_ROUTE_URL;else process.env.NOCHEH_REPLY_ROUTE_URL=previousRoute;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});
