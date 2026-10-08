import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerSupervisionRepository} from '../src/stores/owner-supervision.js';

test('stored owner directory and decisions span every page without turning reads into reconciliation',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
    const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
    const admin=new pg.Pool(config);try{assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
    const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
    await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),key='supervision:'+Date.now(),group='-'+Date.now(),second=String(Number(group)-1),owner={admin:true,scope:null};
    let detectorCalls=0;
    const services=storageServices(stores,{dataDir:'/tmp',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group,second]}),
      runtime:async(operation)=>{assert.equal(operation,'guard.detect');detectorCalls++;return {literals:[]};},honcho:async()=>{throw Error('read projection must not call Honcho');}});
    const view=new OwnerSupervisionRepository({...services,knowledge:{proposal:async()=>{throw Error('not used');}}});
    try {
      const capture=async(scope:string,index:number,extra:Record<string,unknown>={})=>{
        const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text:'PRIVATE_FIXTURE_BODY',
          payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:'supergroup',title:'Repeated synthetic name'},from:{id:123,first_name:'Owner'},text:'PRIVATE_FIXTURE_BODY',...extra}}};
        return (await services.capture.capture(event)).source.reference;
      };
      const source=await capture(group,1);await capture(second,2);await capture(group,3,{message_thread_id:19,forum_topic_created:{name:'Synthetic named topic'}});await capture(group,4,{message_thread_id:19});
      await capture(group,6,{message_thread_id:21,is_topic_message:true,reply_to_message:{message_id:21,date:1,chat:{id:Number(group),type:'supergroup'},forum_topic_created:{name:'Root reply topic'}}});
      const unrepresentableScope=String(Number(group)-2);await capture(unrepresentableScope,5,{text:'Original\u0000message'});
      const suggestions=Array.from({length:131},(_,index)=>({id:digest(key+':suggestion:'+index),name:'Suggestion '+index}));
      await stores.control.query(`INSERT INTO memory_entity_suggestions(id,kind,name,source_reference,reason)
        SELECT value->>'id','person',value->>'name',$2::jsonb,'Synthetic evidence' FROM jsonb_array_elements($1::jsonb) value`,[JSON.stringify(suggestions),source]);
      const first=await view.decisions(owner,{kind:'entity',limit:100});assert.ok(first.total>=131);assert.ok((first.totals.entity??0)>=131);
      const ids=new Set<string>();let page=first;
      while(true){for(const row of page.items)ids.add(row.id);if(!page.next_cursor)break;page=await view.decisions(owner,{kind:'entity',limit:100,after:page.next_cursor});}
      for(const item of suggestions)assert.ok(ids.has(item.id));
      const sorted=suggestions.map(item=>item.id).sort(),selected=sorted[130]!,exact=await view.decision(owner,'entity',selected);
      assert.equal(exact.id,selected);assert.equal((exact.detail as any).name,suggestions.find(item=>item.id===selected)!.name);
      await stores.control.query("UPDATE memory_entity_suggestions SET status='rejected',revision=revision+1 WHERE id=$1",[selected]);
      const changed=await view.decision(owner,'entity',selected);assert.equal(changed.state,'rejected');assert.equal(changed.revision,2);
      assert.equal((await view.decisions(owner,{kind:'entity',limit:100})).total,first.total-1);
      const directory=await view.conversations(owner,{q:group,limit:100}),topic=directory.items.find(item=>item.space_id===group+'/topic/19');
      assert.equal(topic?.name,'Synthetic named topic','later ordinary messages retain the observed topic name');
      assert.equal(directory.items.find(item=>item.space_id===group+'/topic/21')?.name,'Root reply topic','an ordinary topic message names its topic through its root reply');
      assert.equal(topic?.parent_name,'Repeated synthetic name');assert.equal(topic?.kind,'topic');
      assert.equal((await view.conversations(owner,{q:'Repeated synthetic name'})).items.filter(item=>[group,second].includes(item.space_id)).length,2);
      assert.ok(!JSON.stringify(directory).includes('PRIVATE_FIXTURE_BODY'));
      const unrepresentable=(await view.conversations(owner,{q:unrepresentableScope})).items.find(item=>item.space_id===unrepresentableScope);
      assert.ok(unrepresentable,'source JSON that PostgreSQL cannot convert to jsonb retains its exact directory identity');assert.equal(unrepresentable.name,null);
      const before=await services.guards.state(),context=await view.context(owner,group+'/topic/19'),after=await services.guards.state();
      assert.deepEqual(after,before,'read projections never invalidate the current memory generation');
      assert.deepEqual(context.knowledge_access.sharing_rules,[]);assert.equal(context.organization.effective.project,null);
      const project=await services.projects.save(owner,{name:key+':project',description:'Synthetic project',state:'active',expected_revision:0,operation_id:key+':project'});
      await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'});
      const entity=await services.entities.ensureProject(project);
      const claim=await services.entities.publishClaim({subject_id:entity.id,predicate:'milestone',content:'Synthetic milestone is ready',attribution:'reported',uncertainty:'supported',evidence:[source]},await services.guards.state(),key+':claim');
      const projectView=await view.projectContext(owner,project.id),fact=projectView.knowledge.items.find(item=>item.id===claim.id);
      assert.equal(fact?.type,'claim');assert.equal(fact?.content,'Synthetic milestone is ready');assert.deepEqual(fact?.evidence,[source]);
      assert.equal(projectView.knowledge.total,1);assert.ok(projectView.conversations.some(item=>item.space_id===group+'/topic/19'&&item.effective.inherited));
      assert.deepEqual((await view.context(owner,group+'/topic/19')).knowledge_access.sharing_rules,[],'inherited project context never becomes sharing authority');
      assert.equal(detectorCalls,0,'directory, decisions and context do not call the runtime');

      await services.guards.reconcile();await services.guards.setMode('on');await services.guards.prepare(source,'fixture',services.detect);
      const rule=await services.sharing.save(owner,{name:key+':share',sources:[group],destination:second,enabled:true,mode:'approved',instructions:'',expected_revision:0,operation_id:key+':share-rule'});
      const release=async(label:string)=>{
        const preview=await services.shared.preview(owner,{rule_id:rule.id,expected_revision:rule.revision,source_ids:[source.id],content:'Synthetic approved project fact',operation_id:key+':preview:'+label});
        const saved=await services.shared.approve(owner,preview.id,{expected_revision:rule.revision,guard_revision:preview.guard_revision,text_hash:preview.text_hash,operation_id:key+':approval:'+label});
        return {preview,id:saved.id};
      };
      const firstRelease=await release('output'),callsBeforeRead=detectorCalls;
      assert.equal((await view.context(owner,second)).knowledge_access.sharing_releases.find(row=>row.id===firstRelease.id)?.current,true);
      assert.equal(detectorCalls,callsBeforeRead,'release inspection must read existing guarded records only');
      const outputId='derived_artifacts:'+firstRelease.preview.output_reference!.id,output=await services.guards.read(outputId,await services.guards.state());
      await services.guards.edit(outputId,output.revision,{...(output.value as object),text:JSON.stringify({items:[{text:'Owner changed the exact output'}]})},key+':edit-output');
      assert.equal((await view.context(owner,second)).knowledge_access.sharing_releases.find(row=>row.id===firstRelease.id)?.current,false,'changed guarded output invalidates the exact published release');
      const secondRelease=await release('source'),original=await services.guards.read('events:'+source.id,await services.guards.state());
      assert.equal((await view.context(owner,second)).knowledge_access.sharing_releases.find(row=>row.id===secondRelease.id)?.current,true);
      await services.guards.edit('events:'+source.id,original.revision,{...(original.value as object),text:'Owner corrected the original evidence'},key+':edit-source');
      const beforeStaleRead=await services.guards.state(),callsBeforeStaleRead=detectorCalls;
      assert.equal((await view.context(owner,second)).knowledge_access.sharing_releases.find(row=>row.id===secondRelease.id)?.current,false,'unchanged policy and generation cannot hide changed source dependencies');
      assert.equal(detectorCalls,callsBeforeStaleRead);assert.deepEqual(await services.guards.state(),beforeStaleRead);
    } finally {await stores.close();}
  });
