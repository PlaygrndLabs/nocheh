import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('fact grants authorize exact destinations while relationships only create reject-once suggestions',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-access-'));
  const key='memory-access:'+Date.now(),group='-'+Date.now(),owner:Reader={admin:true,scope:null};
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async operation=>operation==='guard.detect'?{literals:[]}:{state:'done'},honcho:async()=>{throw Error('no provider');}});
  const capture=async(scope:string,index:number,text:string)=>{const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text,
    payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:scope==='123'?'private':'group'},from:{id:Number(scope==='123'?'123':'456'),first_name:'Fixture'},text}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;};
  const principal=async(source:{id:string},space=group):Promise<Reader>=>{const binding=await services.guards.state();return {admin:false,scope:group,space,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch};};
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const project=await services.projects.save(owner,{name:'Apollo',description:'Fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'});
    const privateSource=await capture('123',1,'Apollo financial checkpoint and launch schedule'),groupSource=await capture(group,2,'What is the Apollo launch schedule?');
    const projectEntity=await services.entities.ensureProject(project),personId=digest(key+':private-person');
    await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Private colleague','active')",[personId]);
    let binding=await services.guards.state();
    const grantedFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'checkpoint',content:'Apollo financial checkpoint is complete.',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},binding,key+':grant-fact');
    const suggestedFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'launch_schedule',content:'Apollo launch schedule milestone is October.',object_entity_id:personId,relationship_kind:'responsible',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},binding,key+':suggest-fact');
    const grant=await services.memoryAccess.grant(owner,{fact_id:grantedFact.id,fact_revision:grantedFact.revision,destination:group,wording:'The checkpoint is complete.',operation_id:key+':grant'});
    let actor=await principal(groupSource),context=await services.memoryAccess.context(actor,'checkpoint complete');
    assert.equal(context.sources.length,1);assert.equal(context.sources[0]!.text,'The checkpoint is complete.');
    assert.equal((await services.memoryAccess.context(await principal(groupSource,group+'/topic/7'),'checkpoint complete')).sources.length,0,'topics keep their own boundary');
    const suggestion=await services.memoryAccess.suggest(actor,'Apollo launch schedule October');assert.ok(suggestion);
    let requests=await services.memoryAccess.list(owner),pending=requests.requests.find(row=>row.id===suggestion!.id)!;
    assert.equal(pending.wording,'Apollo launch schedule milestone is October.');assert.equal(pending.state,'pending');
    const rejected=await services.memoryAccess.decide(owner,pending.id,{decision:'reject',expected_revision:pending.revision,operation_id:key+':reject'});assert.equal(rejected.state,'rejected');
    const nextSource=await capture(group,3,'Apollo launch schedule October?'),again=await services.memoryAccess.suggest(await principal(nextSource),'Apollo launch schedule October');assert.ok(again);assert.notEqual(again!.id,pending.id,'a later independent request may suggest again');
    await services.entities.correct(owner,suggestedFact.id,{content:'Apollo launch schedule milestone is November.',attribution:'reported',uncertainty:'supported',retired:false,expected_revision:suggestedFact.revision,operation_id:key+':correct'});
    requests=await services.memoryAccess.list(owner);pending=requests.requests.find(row=>row.id===again!.id)!;
    await assert.rejects(services.memoryAccess.decide(owner,pending.id,{decision:'persistent',expected_revision:pending.revision,operation_id:key+':stale'}),{code:'memory_fact_changed'});
    requests=await services.memoryAccess.list(owner);assert.equal(requests.requests.find(row=>row.id===again!.id)!.state,'suspended','stale requests require a new review');
    actor=await principal(groupSource);context=await services.memoryAccess.context(actor,'checkpoint complete');assert.equal(context.sources.length,0,'authorization generation changes suspend prior grants');
    const saved=(await services.memoryAccess.grants(owner)).grants.find(row=>row.id===grant.id)!;assert.equal(saved.state,'suspended');
    const map=await services.memoryMap.read(owner,{after:'',limit:250,focus:'',query:'',kind:'',state:''});assert.ok(map.edges.some(edge=>edge.kind==='relationship'&&!edge.authoritative));assert.ok(map.edges.some(edge=>edge.kind==='access'&&edge.authoritative));
    await assert.rejects(services.memoryMap.read(actor,{after:'',limit:10,focus:'',query:'',kind:'',state:''}),{code:'owner_required'});
    assert.equal((await services.memoryAccess.settings(owner,group)).effective.default_grant_mode,'one_time');
    assert.equal((await services.memoryAccess.settings(owner,group)).effective.request_ttl_seconds,86400);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
