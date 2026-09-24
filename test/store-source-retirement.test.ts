import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {SourceRetirementRepository} from '../src/stores/source-retirement.js';
import {ArchiveRepository} from '../src/stores/archive.js';

test('owner retirement covers every message revision, preserves evidence and delivery, and can be undone',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),group=String(-Date.now()),owner={admin:true,scope:null};
  const cancelled:string[]=[];
  const s=storageServices(stores,{dataDir:'/tmp/nocheh-retirement-fixture',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'42',group_ids:[group]}),
    runtime:async(operation,input)=>{if(operation==='run.cancel'){cancelled.push(String(input.event_id));return {state:'cancelled'};}throw Error('runtime_not_expected');},
    honcho:async()=>{throw Error('honcho_not_expected');}});
  const prefix='retirement:'+Date.now();
  const event=(label:string,id:number,update:number,body:any,kind='telegram_update'):Envelope=>({version:1,key:prefix+':'+label,origin:'live',bot_id:'fixture',
    kind,scope:group,source_id:String(id),revision:String(update),occurred_at:null,text:body.message?.text??body.edited_message?.text??null,payload:{update_id:update,...body}});
  const capture=async(value:Envelope)=>(await s.capture.capture(value)).source.reference;
  try{
    const originals=[
      event('text',1,1,{message:{message_id:1,chat:{id:group,type:'group'},from:{id:7},text:'old text'}}),
      event('voice',2,2,{message:{message_id:2,chat:{id:group,type:'group'},from:{id:7},voice:{file_id:'voice-fixture'}}}),
      event('media',3,3,{message:{message_id:3,chat:{id:group,type:'group'},from:{id:7},photo:[{file_id:'photo-fixture'}]}}),
      event('assistant',4,4,{message:{message_id:4,chat:{id:group,type:'group'},from:{id:99,is_bot:true},text:'Sent reply'}},'telegram_delivered_message'),
    ];
    for(const original of originals){
      const ref=await capture(original),before=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[ref.id])).rows[0].payload;
      const manifests=(await s.archive.captured(ref.id)).artifact_ids;
      const result=await s.retirements.set(owner,ref.id,{retired:true,expected_revision:0,operation_id:prefix+':retire:'+ref.id});
      assert.equal(result.retired,true);assert.equal(await s.retirements.isRetired(ref),true);
      assert.equal((await s.retirements.get(owner,ref.id)).history[0]?.decision_authority,'owner');
      assert.equal(await s.access.canRead({admin:false,scope:null,space:group},ref,await s.guards.state()),false);
      assert.equal(await s.access.canLearn(ref,await s.guards.state()),false);
      assert.deepEqual((await stores.archive.query('SELECT payload FROM events WHERE id=$1',[ref.id])).rows[0].payload,before);
      assert.deepEqual((await s.archive.captured(ref.id)).artifact_ids,manifests);
      assert.deepEqual(await s.retirements.set(owner,ref.id,{retired:true,expected_revision:0,operation_id:prefix+':retire:'+ref.id}),result);
      await assert.rejects(s.retirements.set(owner,ref.id,{retired:false,expected_revision:0,operation_id:prefix+':stale:'+ref.id}),{code:'source_retirement_conflict'});
      await assert.rejects(s.retirements.set({admin:false,scope:null},ref.id,{retired:false,expected_revision:1,operation_id:prefix+':denied:'+ref.id}),{status:403});
      if(original===originals[0]){
        assert.equal((await s.sources.search(owner,'old text')).find(hit=>hit.id===ref.id)?.retired,true);
        const edit=await capture(event('edit',1,10,{edited_message:{message_id:1,chat:{id:group,type:'group'},from:{id:7},text:'revised'}}));
        assert.equal(await s.retirements.isRetired(edit),true);
        assert.equal((await s.retirements.get(owner,edit.id)).revision,1);
        await s.retirements.set(owner,edit.id,{retired:false,expected_revision:1,operation_id:prefix+':undo'});
        assert.equal(await s.retirements.isRetired(ref),false);assert.equal((await s.retirements.get(owner,ref.id)).history.length,2);
        assert.equal(await s.access.canRead({admin:false,scope:null,space:group},ref,await s.guards.state()),true);
        assert.equal(await s.access.canLearn(ref,await s.guards.state()),true);
        assert.equal((await s.sources.search(owner,'old text')).find(hit=>hit.id===ref.id)?.retired,false);
      }
    }
    const pending=await capture(event('pending',5,5,{message:{message_id:5,chat:{id:group,type:'group'},from:{id:7},text:'Waiting'}}));
    const done=await capture(event('done',6,6,{message:{message_id:6,chat:{id:group,type:'group'},from:{id:7},text:'Already answered'}}));
    const uncertain=await capture(event('uncertain',7,7,{message:{message_id:7,chat:{id:group,type:'group'},from:{id:7},text:'Unknown delivery'}}));
    const running=await capture(event('running',8,8,{message:{message_id:8,chat:{id:group,type:'group'},from:{id:7},text:'Turn in progress'}}));
    for(const [ref,state] of [[pending,'pending'],[done,'done'],[uncertain,'ambiguous']] as const)
      await stores.control.query('INSERT INTO dispatches(event_id,source_reference,state) VALUES($1,$2,$3)',[ref.id,ref,state]);
    await stores.control.query("INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,'running',1)",[running.id,running]);
    for(const ref of [pending,done,uncertain])await s.retirements.set(owner,ref.id,{retired:true,expected_revision:0,operation_id:prefix+':dispatch:'+ref.id});
    const api=new OwnerStorageApi(s),url=new URL('http://local/v1/sources/'+running.id+'/retirement');
    await assert.rejects(api.request({admin:false,scope:null},'GET',url),{status:403});
    const action=await api.request(owner,'POST',url,{retired:true,expected_revision:0,operation_id:prefix+':running'});
    assert.equal((action as any).retired,true);assert.deepEqual(cancelled,[running.id]);
    assert.equal((await stores.control.query('SELECT state FROM dispatches WHERE event_id=$1',[running.id])).rows[0].state,'running',
      'running delivery is never mislabeled cancelled before its native receipt');
    const rows=(await stores.control.query('SELECT event_id,state FROM dispatches WHERE event_id=ANY($1::text[])',[[pending.id,done.id,uncertain.id]])).rows;
    assert.equal(rows.find(row=>row.event_id===pending.id)?.state,'cancelled');
    assert.equal(rows.find(row=>row.event_id===done.id)?.state,'done');
    assert.equal(rows.find(row=>row.event_id===uncertain.id)?.state,'ambiguous');
    const restarted=connectStores(config,passwords);
    try{
      const recovered=new SourceRetirementRepository(restarted,new ArchiveRepository(restarted.archive));
      assert.equal(await recovered.isRetired(pending),true,'retirement survives fresh store pools');
      assert.equal((await recovered.get(owner,pending.id)).authority,'owner');
    }finally{await restarted.close();}
  }finally{await stores.close();}
});

test('reaction state rejects superseded and delayed observations while keeping anonymous counts separate',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),group=String(-Date.now()),prefix='reactions:'+Date.now();
  const s=storageServices(stores,{dataDir:'/tmp/nocheh-reaction-fixture',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'42',group_ids:[group]}),
    runtime:async()=>{throw Error('runtime_not_expected');},honcho:async()=>{throw Error('honcho_not_expected');}});
  const checkmark={type:'emoji',emoji:'✅'},heart={type:'emoji',emoji:'❤️'};
  const capture=async(label:string,update:number,body:any)=>{
    const value:Envelope={version:1,key:prefix+':'+label,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:group,source_id:'1',revision:String(update),
      occurred_at:null,text:body.message?.text??null,payload:{update_id:update,...body}};
    return (await s.capture.capture(value)).source.reference;
  };
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    const target=await capture('target',1,{message:{message_id:1,chat:{id:group,type:'group'},from:{id:7},text:'Old task'}});
    const change=(old:any[],next:any[])=>({chat:{id:group},message_id:1,date:1700000000,user:{id:7},old_reaction:old,new_reaction:next});
    const added=await capture('add',10,{message_reaction:change([],[checkmark])});
    for(const reference of [target,added])await s.guards.prepare(reference,'fixture',async()=>[]);
    const initialBinding=await s.guards.state(),dependencies=[];
    for(const reference of [target,added]){
      const guarded=await s.guards.read('events:'+reference.id,initialBinding);
      dependencies.push({source_id:'events:'+reference.id,revision:guarded.revision,value_hash:digest(canonical(guarded.value))});
    }
    const learnedId=digest(prefix+':learned'),principal=s.access.principal(group);
    await s.learned.publishAutomatic(learnedId,{kind:'state',subject:'Old task',text:'The old task appears done.',
      scope:{kind:'conversation',id:group},uncertainty:'supported',evidence:[added,target],conflicts:[]},null,
      prefix+':inference',dependencies,initialBinding,'fixture',async()=>[]);
    assert.equal((await s.learned.read(principal,learnedId,await s.guards.state(),reference=>
      s.access.canRead(principal,reference,initialBinding))).text,'The old task appears done.');
    const replaced=await capture('replace',11,{message_reaction:change([checkmark],[heart])});
    const removed=await capture('remove',12,{message_reaction:change([heart],[])});
    const delayed=await capture('delayed',9,{message_reaction:change([],[checkmark])});
    const counts=await capture('counts',13,{message_reaction_count:{chat:{id:group},message_id:1,date:1700000001,reactions:[{type:heart,total_count:2}]}});
    const binding=await s.guards.state();
    for(const stale of [added,replaced,delayed])assert.equal(await s.reactions.isCurrent(stale),false);
    assert.equal(await s.reactions.isCurrent(removed),true);assert.equal(await s.reactions.isCurrent(counts),true);
    assert.equal(await s.access.canLearn(added,binding),false);
    assert.equal(await s.access.canLearn(removed,binding),true);
    assert.equal(await s.access.canLearn(counts,binding),true);
    await assert.rejects(s.learned.read(principal,learnedId,binding,reference=>s.access.canRead(principal,reference,binding)),
      {code:'learned_memory_not_found'},'removed reaction retires stale inferred meaning even without a replacement');
    await s.retirements.set({admin:true,scope:null},target.id,{retired:true,expected_revision:0,operation_id:prefix+':retire'});
    assert.equal(await s.access.canLearn(removed,await s.guards.state()),false);
    assert.equal(await s.access.canLearn(counts,await s.guards.state()),false);
  }finally{await stores.close();}
});
