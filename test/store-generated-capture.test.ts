import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {immutableFile} from '../src/storage.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {OperationRepository} from '../src/stores/operations.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {captureEvidence,GeneratedCaptureRepository} from '../src/stores/generated-capture.js';
import {CaptureCoordinator,drainSourceSpool} from '../src/stores/capture.js';

const message={message_id:7,date:1700000000,chat:{id:123,type:'private'},from:{id:999,is_bot:true},text:'Actually delivered'};
const response=(key:string,result:unknown=message):Envelope=>({version:1,key,origin:'generated',bot_id:'999',kind:'outbound_result',
  scope:'123',source_id:key,revision:'0',occurred_at:null,text:null,
  payload:{intent_key:key+':intent',method:'sendMessage',state:'delivered',status:200,wire_base64:Buffer.from(canonical({ok:true,result})).toString('base64')}});

test('only confirmed Telegram Message responses become original evidence',()=>{
  const result=captureEvidence(response('delivery'));
  assert.equal(result.originals.length,1);assert.equal(result.generated,true);
  assert.equal(result.originals[0]!.text,'Actually delivered');assert.equal(result.originals[0]!.origin,'live');
  assert.deepEqual(captureEvidence(response('duplicate')).originals,result.originals,'delivery identity follows observed message, not attempt ID');
  for(const raw of [true,{message_id:7},{...message,chat:{id:456}},{...message,date:undefined}])
    assert.equal(captureEvidence(response('invalid',raw)).originals.length,0);
  for(const patch of [{state:'ambiguous'},{state:'rejected'},{status:500},{method:'getChat'},{wire_base64:'malformed'}])
    assert.equal(captureEvidence({...response('invalid'),payload:{...response('invalid').payload,...patch}}).originals.length,0);
  assert.equal(captureEvidence(response('album',[message,{...message,message_id:8}])).originals.length,2);
  assert.notEqual(captureEvidence(response('edited',{...message,text:'Edited',edit_date:1700000001})).originals[0]!.key,result.originals[0]!.key);
});

test('generated journals recover outside archive and preserve delivered originals through outages',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally {await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),operations=new OperationRepository(stores.control);
  const derived=new DerivedRepository(stores.derived,archive,operations),guards=new GuardRepository(stores,archive);
  const generated=new GeneratedCaptureRepository(operations,derived),coordinator=new CaptureCoordinator(archive,stores.control,generated);
  const root=await mkdtemp(join(tmpdir(),'nocheh-generated-')),spool=join(root,'spool','pending'),key='generated-fixture:'+Date.now();
  const sent=response(key+':sent',{...message,message_id:Date.now()}),intent={...sent,key:key+':intent',kind:'outbound_intent',text:'Draft',payload:{method:'sendMessage',parameters:{chat_id:123,text:'Draft'},state:'attempting'}};
  const ambiguous={...response(key+':uncertain'),payload:{...response(key+':uncertain').payload,state:'ambiguous'}};
  const schedule:Envelope={...sent,key:key+':schedule',channel:'scheduler',kind:'scheduled_trigger',text:'Private scheduled prompt',payload:{prompt:'Private scheduled prompt'}};
  const incoming:Envelope={...sent,key:key+':incoming',origin:'live',kind:'telegram_update',text:'Received',payload:{message:{...message,text:'Received'}}};
  const inputs=[intent,sent,ambiguous,schedule,incoming];
  try {
    await guards.reconcile();await guards.setMode('on');
    for(const item of inputs)await immutableFile(spool,digest(item.key)+'.json',Buffer.from(canonical(item)));
    const dead=new pg.Pool(config);await dead.end();
    await drainSourceSpool(new CaptureCoordinator(archive,dead),root);
    assert.equal((await readdir(spool)).length,inputs.length);
    const original=captureEvidence(sent).originals[0]!;
    assert.equal((await archive.captured(digest(original.key))).kind,'telegram_delivered_message','delivery evidence commits even when control is unavailable');
    assert.equal((await archive.captured(digest(incoming.key))).kind,'telegram_update');
    for(const item of [intent,sent,ambiguous,schedule])await assert.rejects(archive.captured(digest(item.key)),{code:'source_not_found'});
    await drainSourceSpool(coordinator,root);assert.equal((await readdir(spool)).length,0);
    const operation=await operations.record({key:schedule.key,kind:schedule.kind,scope:schedule.scope,input_hash:digest(canonical(schedule))});
    const row=(await stores.derived.query('SELECT * FROM derived_artifacts WHERE operation_id=$1',['capture:'+operation.id])).rows[0];
    assert.equal(row.event_id,null);assert.deepEqual(row.operation_reference,operation);
    assert.deepEqual(JSON.parse(row.content.toString()),schedule);
    await assert.rejects(operations.record({key:schedule.key,kind:schedule.kind,scope:schedule.scope,input_hash:digest('different')}),{code:'operation_identity_conflict'});
    await assert.rejects(operations.verify({...operation,generation:'00000000-0000-0000-0000-000000000000'}),{code:'operation_reference_conflict'});
    const reference={store:'derived' as const,kind:'artifact' as const,id:row.id,input_hash:row.content_hash};
    await assert.rejects(new SelectionRepository(stores,guards).activate(reference,null,digest(key+':select')),{code:'source_derivative_required'});
    await guards.prepare(reference,'fixture',async text=>text.includes('Private scheduled prompt')?['Private scheduled prompt']:[]);
    assert.ok(!JSON.stringify((await guards.read('derived_artifacts:'+row.id,await guards.state())).value).includes('Private scheduled prompt'));
    const before=(await stores.control.query('SELECT count(*) FROM capture_effect_receipts')).rows[0].count;
    for(const item of inputs)await immutableFile(spool,digest(item.key)+'.json',Buffer.from(canonical(item)));
    await drainSourceSpool(coordinator,root);assert.equal((await readdir(spool)).length,0);
    assert.equal((await stores.control.query('SELECT count(*) FROM capture_effect_receipts')).rows[0].count,before);

    // A lost control completion retains the fsynced journal, then reuses the durable derivative.
    const pending={...schedule,key:key+':lost-completion'};
    await immutableFile(spool,digest(pending.key)+'.json',Buffer.from(canonical(pending)));
    const real=operations.pool,broken=Object.create(real) as pg.Pool;
    broken.query=(async (sql:any,...args:any[])=>{
      if(String(sql).startsWith('INSERT INTO capture_effect_receipts'))throw Error('fixture_lost_completion');
      return (real.query as any)(sql,...args);
    }) as typeof real.query;
    await drainSourceSpool(new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(new OperationRepository(broken),derived)),root);
    assert.deepEqual(JSON.parse((await readFile(join(spool,digest(pending.key)+'.json'))).toString()),pending);
    await drainSourceSpool(coordinator,root);assert.equal((await readdir(spool)).length,0);
    assert.equal((await stores.derived.query('SELECT count(*) FROM derived_artifacts WHERE operation_reference->>\'id\'=$1',[
      (await operations.record({key:pending.key,kind:pending.kind,scope:pending.scope,input_hash:digest(canonical(pending))})).id])).rows[0].count,'1');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
