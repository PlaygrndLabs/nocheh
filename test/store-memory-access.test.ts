import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('fact grants authorize exact destinations while relationships only create reject-once suggestions',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-access-'));
  const key='memory-access:'+Date.now(),group='-'+Date.now(),otherGroup=String(Number(group)-1),owner:Reader={admin:true,scope:null};
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group]};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>operation==='guard.detect'?{literals:[]}:{state:'done'},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const capture=async(scope:string,index:number,text:string)=>{const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text,
    payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:scope==='123'?'private':'group'},from:{id:Number(scope==='123'?'123':'456'),first_name:'Fixture'},text}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;};
  const principal=async(source:{id:string},space=group):Promise<Reader>=>{const binding=await services.guards.state();return {admin:false,scope:group,space,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch};};
  const find=async(kind:'requests'|'grants',id:string)=>{
    let after='';do {
      const page=kind==='requests'?await services.memoryAccess.list(owner,after):await services.memoryAccess.grants(owner,after);
      const rows='requests' in page?page.requests:page.grants,row=rows.find(item=>item.id===id);if(row)return row;
      if(page.next)assert.ok(page.next>after,'memory access pagination must advance');after=page.next??'';
    }while(after);assert.fail('Synthetic memory access row was not found across its pages');
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const project=await services.projects.save(owner,{name:'Apollo',description:'Fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'});
    const privateSource=await capture('123',1,'Apollo financial checkpoint and launch schedule'),groupSource=await capture(group,2,'What is the Apollo launch schedule?');
    const otherSource=await capture(otherGroup,4,'Apollo launch schedule milestone is October.');
    const projectEntity=await services.entities.ensureProject(project),personId=digest(key+':private-person');
    await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Private colleague','active')",[personId]);
    let binding=await services.guards.state();
    const grantedFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'checkpoint',content:'Apollo financial checkpoint is complete.',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},binding,key+':grant-fact');
    // A fact from the owner's private chat is shared only once the owner confirms it after seeing where it came from, and only into a group.
    const manual={fact_id:grantedFact.id,fact_revision:grantedFact.revision,destination:group,wording:'The checkpoint is complete.',operation_id:key+':grant'};
    await assert.rejects(services.memoryAccess.grant(owner,manual),{code:'memory_grant_private_sources'});
    for(const destination of ['123','123/topic/5','desktop:personal_chat:9'])
      await assert.rejects(services.memoryAccess.grant(owner,{...manual,destination,private_evidence_confirmed:true,operation_id:key+':private-destination'}),{code:'memory_grant_private_destination'},destination);
    const grant=await services.memoryAccess.grant(owner,{...manual,private_evidence_confirmed:true});
    assert.ok((await services.memoryAccess.grants(owner,'',group)).grants.some(item=>item.id===grant.id),'a chat lists its own grants');
    assert.ok(!(await services.memoryAccess.grants(owner,'','-1'+Date.now())).grants.some(item=>item.id===grant.id),'another chat does not list them');
    let actor=await principal(groupSource),context=await services.memoryAccess.context(actor,'checkpoint complete');
    assert.equal(context.sources.length,1);assert.equal(context.sources[0]!.text,'The checkpoint is complete.');
    assert.equal((await services.memoryAccess.context(await principal(groupSource,group+'/topic/7'),'checkpoint complete')).sources[0]?.text,'The checkpoint is complete.',
      'every topic of a group shares its grants by default');
    policy.topic_memory='topic';
    assert.equal((await services.memoryAccess.context(await principal(groupSource,group+'/topic/7'),'checkpoint complete')).sources.length,0,'separate topics keep their own boundary');
    delete policy.topic_memory;
    // A grant on a private source made without the owner's confirm, as before it existed, pauses until they share it again.
    const olderFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'budget',content:'Apollo budget review is done.',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},await services.guards.state(),key+':older-grant-fact');
    const placed=services.access.space;services.access.space=async()=>otherGroup;let olderGrants:{id:string}[];
    try {olderGrants=[await services.memoryAccess.grant(owner,{fact_id:olderFact.id,fact_revision:olderFact.revision,destination:group,operation_id:key+':older-grant'}),
      await services.memoryAccess.grant(owner,{fact_id:olderFact.id,fact_revision:olderFact.revision,destination:otherGroup,operation_id:key+':older-grant-other'})];
    }finally{services.access.space=placed;}
    actor=await principal(groupSource);
    assert.equal((await services.memoryAccess.context(actor,'Apollo budget review done')).sources.length,0,'never served without the confirm');
    const paused=await find('grants',olderGrants[0]!.id);assert.deepEqual([paused.state,paused.suspended_reason],['suspended','private_evidence_unconfirmed']);
    const listed=(await services.memoryAccess.grants(owner,'',otherGroup)).grants.find(item=>item.id===olderGrants[1]!.id);
    assert.deepEqual([listed?.state,listed?.suspended_reason],['suspended','private_evidence_unconfirmed'],'the list shows it paused before any turn there');
    assert.equal((await services.memoryAccess.context(actor,'checkpoint complete')).sources.length,1,'a share the owner confirmed keeps working');
    assert.equal((await services.memoryAccess.settings(owner,group)).global.auto_followup,false,'automatic follow-up starts off');
    // Never a fact whose evidence includes the owner's private chat.
    const privateFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'launch_window',content:'Apollo launch schedule milestone is October.',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},await services.guards.state(),key+':private-fact');
    assert.equal(await services.memoryAccess.suggest(actor,'Apollo launch schedule October'),null,'a private fact is never suggested');
    // A request suggested before that rule never shares the private fact: approving it cancels it.
    const space=services.access.space;services.access.space=async()=>otherGroup;let older:{id:string}|null;
    try {older=await services.memoryAccess.suggest(actor,'Apollo launch schedule October');}finally{services.access.space=space;}
    assert.ok(older);const olderRequest=await find('requests',older.id);assert.equal(olderRequest.fact_id,privateFact.id);
    await assert.rejects(services.memoryAccess.decide(owner,older.id,{decision:'one_time',expected_revision:olderRequest.revision,operation_id:key+':older'}),{code:'memory_access_private_evidence'});
    assert.equal((await find('requests',older.id)).state,'cancelled');
    // Evidence from another group is suggested, and the card names where it came from and who will see it.
    const suggestedFact=await services.entities.publishClaim({subject_id:projectEntity.id,predicate:'launch_schedule',content:'Apollo launch schedule milestone is October.',object_entity_id:personId,relationship_kind:'responsible',attribution:'reported',uncertainty:'supported',evidence:[otherSource]},await services.guards.state(),key+':suggest-fact');
    const suggestion=await services.memoryAccess.suggest(actor,'Apollo launch schedule October');assert.ok(suggestion);
    let pending=await find('requests',suggestion.id);
    assert.equal(pending.wording,'Apollo launch schedule milestone is October.');assert.equal(pending.state,'pending');assert.equal(pending.fact_id,suggestedFact.id);
    assert.deepEqual(pending.provenance.evidence_spaces,[otherGroup]);assert.deepEqual(pending.source_spaces,[otherGroup]);
    assert.deepEqual(pending.audience,{space:group,group});assert.equal(pending.post_default,false);
    for(const space of ['123','456','123/topic/5'])
      assert.equal(await services.memoryAccess.suggest({...actor,scope:space.split('/topic/')[0]!,space},'Apollo launch schedule October'),null,'never into a private chat: '+space);
    // An older request into a private chat is cancelled rather than shared.
    const intoPrivate=digest(key+':into-private');
    await stores.control.query(`INSERT INTO memory_access_requests(id,request_hash,source_reference,destination,source_scope,logical_profile,query_hash,fact_id,fact_revision,
      proposal_reference,binding,relationship_path,evidence,expires_at) SELECT $2,$3,source_reference,'456',source_scope,logical_profile,query_hash,fact_id,fact_revision,
      proposal_reference,binding,relationship_path,evidence,expires_at FROM memory_access_requests WHERE id=$1`,[pending.id,intoPrivate,digest(key+':into-private-hash')]);
    await assert.rejects(services.memoryAccess.decide(owner,intoPrivate,{decision:'persistent',expected_revision:1,operation_id:key+':into-private'}),{code:'memory_access_private_destination'});
    assert.equal((await find('requests',intoPrivate)).state,'cancelled');
    // A passing store failure while placing the evidence is not a private source: the request stays to be decided.
    services.access.space=async()=>{throw Error('synthetic store outage');};
    try {await assert.rejects(services.memoryAccess.decide(owner,pending.id,{decision:'one_time',expected_revision:pending.revision,operation_id:key+':outage'}),/synthetic store outage/);}
    finally{services.access.space=space;}
    assert.equal((await find('requests',pending.id)).state,'pending','an outage never cancels a request');
    const rejected=await services.memoryAccess.decide(owner,pending.id,{decision:'reject',expected_revision:pending.revision,operation_id:key+':reject'});assert.equal(rejected.state,'rejected');
    const nextSource=await capture(group,3,'Apollo launch schedule October?'),again=await services.memoryAccess.suggest(await principal(nextSource),'Apollo launch schedule October');assert.ok(again);assert.notEqual(again!.id,pending.id,'a later independent request may suggest again');
    const corrected=await services.entities.correct(owner,suggestedFact.id,{content:'Apollo launch schedule milestone is November.',relationship_kind:'associated',attribution:'reported',uncertainty:'supported',retired:false,expected_revision:suggestedFact.revision,operation_id:key+':correct'});
    assert.equal(corrected.revision,suggestedFact.revision+1);assert.equal((await stores.derived.query('SELECT relationship_kind FROM entity_claim_versions WHERE claim_id=$1 AND revision=$2',[suggestedFact.id,corrected.revision])).rows[0].relationship_kind,'associated');
    pending=await find('requests',again.id);
    await assert.rejects(services.memoryAccess.decide(owner,pending.id,{decision:'persistent',expected_revision:pending.revision,operation_id:key+':stale'}),{code:'memory_fact_changed'});
    assert.equal((await find('requests',again.id)).state,'suspended','stale requests require a new review');
    actor=await principal(groupSource);context=await services.memoryAccess.context(actor,'checkpoint complete');assert.equal(context.sources.length,0,'authorization generation changes suspend prior grants');
    const saved=await find('grants',grant.id);assert.equal(saved.state,'suspended');
    let after='',relationship=false,accessEdge=false;do {
      const map=await services.memoryMap.read(owner,{after,limit:250,focus:'',query:'',kind:'',state:''});
      relationship ||=map.edges.some(edge=>edge.kind==='relationship'&&!edge.authoritative&&edge.detail?.claim_id===suggestedFact.id&&edge.detail?.relationship_kind==='associated');
      accessEdge ||=map.edges.some(edge=>edge.kind==='access'&&edge.authoritative&&edge.detail?.grant_id===grant.id);
      if(map.next)assert.notEqual(map.next,after,'memory map pagination must advance');after=map.next??'';
    }while(after&&(!relationship||!accessEdge));assert.ok(relationship);assert.ok(accessEdge);
    await assert.rejects(services.memoryMap.read(actor,{after:'',limit:10,focus:'',query:'',kind:'',state:''}),{code:'owner_required'});
    // A project assignment never grants access: a project shares nothing between its groups (ADR-0246).
    const contains=async()=>{const edge=(await services.memoryMap.read(owner,{after:'',limit:250,focus:'',query:group,kind:'conversation',state:''})).edges
      .find(row=>row.id==='project_assignment:'+group)!;return {label:edge.label,authoritative:edge.authoritative,detail:Object.keys(edge.detail??{}).sort()};};
    const other=String(Number(group)-1),plain={label:'contains',authoritative:false,detail:['destination','mode','project_id','revision']};
    assert.deepEqual(await contains(),plain);
    await services.projects.assign(owner,{space_id:other,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign-other'});
    assert.deepEqual(await contains(),plain,'two groups in one project share nothing');
    assert.equal((await services.memoryAccess.settings(owner,group)).effective.default_grant_mode,'one_time');
    assert.equal((await services.memoryAccess.settings(owner,group)).effective.request_ttl_seconds,86400);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('canary: what the owner says about a member in the private chat never reaches a group',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-canary-'));
  const key='memory-canary:'+Date.now(),group='-'+Date.now(),owner:Reader={admin:true,scope:null},mark='zephyrquill';
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group]};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>operation==='guard.detect'?{literals:[]}:{state:'done'},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const capture=async(scope:string,index:number,text:string)=>{const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text,
    payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:scope==='123'?'private':'group'},from:{id:Number(scope==='123'?'123':'456'),first_name:'Bob'},text}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;};
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const project=await services.projects.save(owner,{name:'Apollo',description:'Fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'});
    const said=await capture('123',1,'Bob is leaving the Apollo team next month '+mark),asked=await capture(group,2,'Is Bob leaving the Apollo team?');
    const projectEntity=await services.entities.ensureProject(project),bob=digest(key+':member');
    await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Bob','active')",[bob]);
    const fact=await services.entities.publishClaim({subject_id:bob,predicate:'plans',content:'Bob is leaving the Apollo team next month '+mark,object_entity_id:projectEntity.id,
      relationship_kind:'participates',attribution:'reported',uncertainty:'explicit',evidence:[said]},await services.guards.state(),key+':fact');
    const binding=await services.guards.state();
    const actor:Reader={admin:false,scope:group,space:group,turnEvent:asked.id,generation:binding.generation,guard_epoch:binding.epoch};
    const query='Is Bob leaving the Apollo team next month?';
    assert.equal(await services.memoryAccess.suggest(actor,query),null,'never suggested to the group');
    assert.ok(!JSON.stringify(await services.memoryAccess.context(actor,query)).includes(mark),'never in its approved facts');
    assert.ok(!JSON.stringify(await services.shared.context(actor,query)).includes(mark),'never in what is shared with it');
    assert.ok(!JSON.stringify(await services.entities.connected(actor,query)).includes(mark),'never in the people it may look up');
    await assert.rejects(services.entities.inspect(actor,bob),{code:'entity_not_found'});
    const audience=await services.entities.audience(owner,fact.id);
    assert.deepEqual([audience.owner_private,audience.private_sources,audience.readers],[true,['123'],null],'only the owner can read it');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
