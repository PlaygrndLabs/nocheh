import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {OwnerSupervisionRepository} from '../src/stores/owner-supervision.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {chatIdFor} from '../src/chats.js';
import type {ConversationDirectoryItem} from '../src/stores/owner-supervision.js';
import {legacyChats,seedChats} from './fixture-groups.js';

test('stored owner directory and decisions span every page without turning reads into reconciliation',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
    const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
    const admin=new pg.Pool(config);try{assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
    const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
    await initializeStoreDatabases(config,passwords);const base=Date.now(),stores=connectStores(config,passwords),key='supervision:'+base,group='-'+base,second=String(Number(group)-1),owner={admin:true,scope:null};
    let detectorCalls=0;
    const services=fixtureServices(stores,{dataDir:'/tmp',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group,second]}),
      runtime:async(operation)=>{assert.equal(operation,'guard.detect');detectorCalls++;return {literals:[]};},memoryEngine:honchoEngine(async()=>{throw Error('read projection must not call Honcho');})});
    const view=new OwnerSupervisionRepository({...services,knowledge:{proposal:async()=>{throw Error('not used');}}});
    // Both chat id families (ADR-0252): the two groups and topic 19 were stored before step 2b and keep their Telegram
    // values as their ids; topic 21 and a third group are first seen now and get digest ids.
    const topic19=group+'/topic/19',topic21=chatIdFor('telegram',group,'21');
    const all=async()=>{const items:ConversationDirectoryItem[]=[];let after='';
      for(;;){const page=await view.conversations(owner,{limit:100,after});items.push(...page.items);if(!page.next_cursor)return items;after=page.next_cursor;}};
    try {
      await seedChats(stores.control,legacyChats([group,topic19,second],{owner:'123',served:[group,second]}));
      const capture=async(scope:string,index:number,extra:Record<string,unknown>={})=>{
        const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text:'PRIVATE_FIXTURE_BODY',
          payload:{update_id:base*100+index,message:{message_id:index,date:1,chat:{id:Number(scope),type:'supergroup',title:'Repeated synthetic name'},from:{id:123,first_name:'Owner'},text:'PRIVATE_FIXTURE_BODY',...extra}}};
        return (await services.capture.capture(event)).source.reference;
      };
      const source=await capture(group,1);await capture(second,2);await capture(group,3,{message_thread_id:19,is_topic_message:true,forum_topic_created:{name:'Synthetic named topic'}});await capture(group,4,{message_thread_id:19,is_topic_message:true});
      await capture(group,6,{message_thread_id:21,is_topic_message:true,reply_to_message:{message_id:21,date:1,chat:{id:Number(group),type:'supergroup'},forum_topic_created:{name:'Root reply topic'}}});
      const unrepresentableScope=String(Number(group)-2);await capture(unrepresentableScope,5,{text:'Original\u0000message'});
      const suggestions=Array.from({length:131},(_,index)=>({id:digest(key+':suggestion:'+index),name:'Suggestion '+index}));
      await stores.control.query(`INSERT INTO memory_entity_suggestions(id,kind,name,source_reference,reason)
        SELECT value->>'id','person',value->>'name',$2::jsonb,'Synthetic evidence' FROM jsonb_array_elements($1::jsonb) value`,[JSON.stringify(suggestions),source]);
      const first=await view.decisions(owner,{kind:'entity',limit:100});assert.ok(first.total>=131);assert.ok((first.totals.entity??0)>=131);
      const ids=new Set<string>();let page=first;
      // Each item says why it is waiting.
      const mine=new Set(suggestions.map(item=>item.id));
      while(true){for(const row of page.items){ids.add(row.id);if(mine.has(row.id))assert.equal(row.summary,'Synthetic evidence');}if(!page.next_cursor)break;page=await view.decisions(owner,{kind:'entity',limit:100,after:page.next_cursor});}
      for(const item of suggestions)assert.ok(ids.has(item.id));
      const sorted=suggestions.map(item=>item.id).sort(),selected=sorted[130]!,exact=await view.decision(owner,'entity',selected);
      assert.equal(exact.id,selected);assert.equal((exact.detail as any).name,suggestions.find(item=>item.id===selected)!.name);
      await stores.control.query("UPDATE memory_entity_suggestions SET status='rejected',revision=revision+1 WHERE id=$1",[selected]);
      const changed=await view.decision(owner,'entity',selected);assert.equal(changed.state,'rejected');assert.equal(changed.revision,2);
      assert.equal((await view.decisions(owner,{kind:'entity',limit:100})).total,first.total-1);
      const directory=await view.conversations(owner,{q:group,limit:100}),topic=directory.items.find(item=>item.space_id===topic19);
      assert.equal(topic?.name,'Synthetic named topic','later ordinary messages retain the observed topic name');
      const listed=await all(),newTopic=listed.find(item=>item.space_id===topic21);
      assert.equal(newTopic?.name,'Root reply topic','an ordinary topic message names its topic through its root reply');
      // An old-shaped topic and one first seen now carry the same fields from the directory.
      const fields=(item:ConversationDirectoryItem|undefined)=>item&&{kind:item.kind,parent_space:item.parent_space,parent_name:item.parent_name,
        app_ids:item.app_ids,state:item.state,is_forum:item.is_forum,owner:item.owner};
      assert.deepEqual(fields(newTopic),fields(topic));assert.deepEqual([topic?.topic_key,newTopic?.topic_key],['19','21']);
      assert.deepEqual(topic?.app_ids,[{app:'telegram',external:group,state:'current'}]);assert.equal(topic?.state,'active');
      await services.capture.capture({version:1,key:key+':delivered',origin:'live',kind:'telegram_delivered_message',bot_id:key,scope:second,source_id:'99',revision:'1',occurred_at:null,text:'Reply',
        payload:{message:{message_id:99,date:2,chat:{id:Number(second),type:'supergroup'},from:{id:1,is_bot:true},text:'Reply'}}});
      await services.capture.capture({version:1,key:key+':reaction',origin:'live',kind:'telegram_update',bot_id:key,scope:second,source_id:'reaction',revision:'1',occurred_at:null,text:null,
        payload:{update_id:100,message_reaction:{chat:{id:Number(second),type:'supergroup'},message_id:2,date:3,user:{id:123},old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}}});
      const named=(await view.conversations(owner,{q:second,limit:100})).items.find(item=>item.space_id===second);
      assert.equal(named?.name,'Repeated synthetic name','a later reply or reaction without a title keeps the observed name');
      assert.equal(topic?.parent_name,'Repeated synthetic name');assert.equal(topic?.kind,'topic');
      assert.equal((await view.conversations(owner,{q:'Repeated synthetic name'})).items.filter(item=>[group,second].includes(item.space_id)).length,2);
      assert.ok(!JSON.stringify(directory).includes('PRIVATE_FIXTURE_BODY'));
      const unrepresentable=(await all()).find(item=>item.space_id===chatIdFor('telegram',unrepresentableScope));
      assert.ok(unrepresentable,'source JSON that PostgreSQL cannot convert to jsonb still records its chat');
      assert.equal(unrepresentable.name,'Repeated synthetic name');
      const oldGroup=(await all()).find(item=>item.space_id===group)!;
      assert.deepEqual([unrepresentable.kind,unrepresentable.parent_space,unrepresentable.topic_key,unrepresentable.owner,unrepresentable.app_ids],
        ['group',null,null,false,[{app:'telegram',external:unrepresentableScope,state:'current'}]]);
      assert.deepEqual([oldGroup.kind,oldGroup.parent_space,oldGroup.topic_key,oldGroup.owner,oldGroup.app_ids],['group',null,null,false,[{app:'telegram',external:group,state:'current'}]]);
      assert.equal(unrepresentable.state,'off','a group first seen now, with no add by the owner, starts off');
      // A kind or state filter applies before paging: the served groups page whole, one per page here, with a cursor
      // that ends with them, and leave out every other chat (a topic is in its group's state).
      const filtered=async(input:{kind?:string;state?:string})=>{const items:ConversationDirectoryItem[]=[];let after='',pages=0;
        for(;;){const page=await view.conversations(owner,{...input,limit:1,after});pages++;items.push(...page.items);
          assert.equal(page.items.length,page.total?1:0,'no filtered page is empty while chats remain');
          if(!page.next_cursor)return {items,pages,total:page.total};after=page.next_cursor;}};
      const everything=await all(),spaces=(items:ConversationDirectoryItem[])=>items.map(item=>item.space_id);
      const served=await filtered({kind:'group',state:'active'});
      assert.deepEqual(spaces(served.items),spaces(everything.filter(item=>item.kind==='group'&&item.state==='active')));
      assert.ok([group,second].every(id=>spaces(served.items).includes(id)),'both served groups are listed');
      assert.ok(!spaces(served.items).includes(unrepresentable.space_id),'a group that is off is left out');
      assert.equal(served.pages,served.items.length);assert.equal(served.total,served.items.length);
      const topics=await filtered({kind:'topic'});
      assert.ok(topics.items.every(item=>item.kind==='topic')&&[topic19,topic21].every(id=>spaces(topics.items).includes(id)));
      const off=await filtered({state:'off'});
      assert.ok(off.items.every(item=>item.state==='off')&&spaces(off.items).includes(unrepresentable.space_id));
      assert.deepEqual(spaces((await view.conversations(owner,{kind:'group',state:'active',q:second})).items),[second],'a filter and a search narrow together');
      await assert.rejects(view.conversations(owner,{kind:'channel'}),{code:'invalid_conversation_kind'});
      await assert.rejects(view.conversations(owner,{state:'on'}),{code:'invalid_conversation_state'});
      // The route reads both filters.
      const routed=await new OwnerStorageApi(services).request(owner,'GET',new URL('http://fixture/v1/conversations?kind=group&state=active&limit=1')) as {items:ConversationDirectoryItem[];next_cursor:string|null};
      assert.deepEqual(spaces(routed.items),spaces(served.items.slice(0,1)));assert.equal(routed.next_cursor,served.items.length>1?served.items[0]!.space_id:null);
      // A topic first seen now is read as its group's topic, as an old-shaped one is.
      const newContext=await view.context(owner,topic21);
      assert.equal(newContext.conversation.kind,'topic');assert.equal(newContext.conversation.parent_space,group);
      assert.equal(newContext.conversation.parent_name,'Repeated synthetic name');
      const before=await services.guards.state(),context=await view.context(owner,topic19),after=await services.guards.state();
      assert.deepEqual(after,before,'read projections never invalidate the current memory generation');
      assert.deepEqual(context.knowledge_access.sharing_rules,[]);assert.equal(context.organization.effective.project,null);
      const project=await services.projects.save(owner,{name:key+':project',description:'Synthetic project',state:'active',expected_revision:0,operation_id:key+':project'});
      await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign'});
      const entity=await services.entities.ensureProject(project);
      const claim=await services.entities.publishClaim({subject_id:entity.id,predicate:'milestone',content:'Synthetic milestone is ready',attribution:'reported',uncertainty:'supported',evidence:[source]},await services.guards.state(),key+':claim');
      const projectView=await view.projectContext(owner,project.id),fact=projectView.knowledge.items.find(item=>item.id===claim.id);
      assert.equal(fact?.type,'claim');assert.equal(fact?.content,'Synthetic milestone is ready');assert.deepEqual(fact?.evidence,[source]);
      assert.equal(projectView.knowledge.total,1);assert.ok(projectView.conversations.some(item=>item.space_id===topic19&&item.effective.inherited));
      assert.deepEqual((await view.context(owner,topic19)).knowledge_access.sharing_rules,[],'inherited project context never becomes sharing authority');
      assert.equal(detectorCalls,0,'directory, decisions and context do not call the runtime');

      // A project shares nothing between its groups: a group's context lists no rule unless the owner wrote it (ADR-0247).
      await services.projects.assign(owner,{space_id:second,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':assign-second'});
      for(const space of [second,group,topic19]){
        const shown=await view.context(owner,space);
        assert.deepEqual(shown.knowledge_access.sharing_rules,[],space);assert.match(shown.knowledge_access.note,/a project grants no access in a group/);
        assert.match(shown.organization.note,/never moves a group or topic into or out of a project by itself/);
      }
      await services.projects.assign(owner,{space_id:second,project_id:null,mode:'inherit',expected_revision:1,operation_id:key+':second-leaves'});

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
