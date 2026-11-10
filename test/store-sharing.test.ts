import {test} from 'node:test';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {SharingContentRepository} from '../src/stores/sharing.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('sharing publishes exact prepared text with private provenance, revocation and durable filter checkpoints',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-sharing-'));
  const key='sharing:'+Date.now(),group='-'+Date.now(),other=group+'7',token='synthetic-sharing-token-not-a-real-credential',owner:Reader={admin:true,scope:null};
  let calls=0,mode:'safe'|'citation'|'outside'|'instruction'='safe',duringFilter:(()=>Promise<void>)|null=null;
  const filterInputs:string[]=[];
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group,other]};
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:String(input.text).includes('saffronpass')?['saffronpass']:[]};
      assert.equal(operation,'memory.filter');calls++;
      const actor=reader({headers:{authorization:'Bearer '+input.archive_credential}} as IncomingMessage,token);
      assert.equal(actor.purpose,'filter');assert.equal(actor.scope,null);assert.equal((await services.turns.binding(actor)).scope,'123');
      const candidates=input.candidates as {id:string;text:string}[];
      filterInputs.push(candidates.map(c=>c.text).join('\n'));
      assert.ok(candidates.length);assert.ok(candidates.every(c=>!c.text.includes('saffronpass')));
      if(duringFilter){const mutation=duringFilter;duringFilter=null;await mutation();}
      const producer={name:'fixture',version:'deterministic-1',model:'fixture',provider:'offline',api_mode:'fixture'};
      if(mode==='instruction')return {items:[],grant_admin:true,producer};
      return {producer,items:[{text:mode==='citation'?'Private reference '+candidates[0]!.id:'copperbridge Planning summary',
        source_ids:[mode==='outside'?digest('not a selected source'):candidates[0]!.id]}]};
    },memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const api=new OwnerStorageApi(services),request=(path:string,body?:unknown)=>api.request(owner,body===undefined?'GET':'POST',new URL(path,'http://fixture'),body) as Promise<any>;
  const source=async(scope:string,n:number,unknown=false,voice=false)=>{
    const event:Envelope={version:1,key:key+':source:'+n,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(n),revision:'1',occurred_at:null,
      text:'copperbridge Planning saffronpass',payload:{message:{message_id:n,date:1,chat:{id:Number(scope),type:unknown?'supergroup':scope==='123'?'private':'group'},text:'copperbridge Planning saffronpass',...(unknown?{is_topic_message:true}:{}),...(voice?{voice:{file_id:key+':voice'}}:{})}}};
    const reference=(await services.capture.capture(event)).source.reference;await services.guards.prepare(reference,'fixture',services.detect);return reference;
  };
  const principal=async(space:string,turn:string):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:space.split('/topic/')[0]!,space,turnEvent:turn,generation:binding.generation,guard_epoch:binding.epoch};
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const original=await source('123',1),destination=await source(group,2),unrelated=await source(other,3),unknown=await source(other,4,true);
    const rule=await request('/v1/sharing/rules',{name:key,sources:['123'],destination:group,enabled:true,mode:'approved',instructions:'Only selected facts',expected_revision:0,operation_id:key+':rule'});
    const initial={rule_id:rule.id,expected_revision:rule.revision,source_ids:[original.id],content:'copperbridge Approved plan saffronpass',operation_id:key+':preview'};
    const preview=await request('/v1/sharing/preview',initial);assert.equal(preview.current,true);assert.ok(!preview.text.includes('saffronpass'));
    assert.equal((await request('/v1/sharing/preview',initial)).id,preview.id);
    await assert.rejects(request('/v1/sharing/preview',{...initial,content:'Different text'}),{code:'sharing_operation_conflict'});
    await assert.rejects(request('/v1/sharing/preview',{...initial,source_ids:[unrelated.id],operation_id:key+':wrong-source'}),{code:'sharing_source_not_selected'});
    assert.equal((await request('/v1/sharing/previews/'+preview.id)).input.sources[0].id,original.id);
    const approval={expected_revision:1,guard_revision:preview.guard_revision,text_hash:preview.text_hash,operation_id:key+':approve'};
    await assert.rejects(request('/v1/sharing/previews/'+preview.id+'/approve',{...approval,text_hash:digest('other')}),{code:'sharing_preview_changed'});
    const beforeApproval=await principal(group,destination.id),released=await request('/v1/sharing/previews/'+preview.id+'/approve',approval);
    await assert.rejects(services.shared.read(beforeApproval,released.id),{code:'audience_context_changed'});
    assert.deepEqual(await request('/v1/sharing/previews/'+preview.id+'/approve',approval),released);
    let actor=await principal(group,destination.id),shared=await services.shared.read(actor,released.id);
    assert.equal(shared.text,preview.text);assert.equal(shared.kind,'owner_approved');assert.ok(!JSON.stringify(shared).includes(original.id));
    await assert.rejects(services.sources.read(actor,original.id),{code:'source_not_found'});
    await assert.rejects(services.shared.read(await principal(other,unrelated.id),released.id),{code:'shared_source_not_found'});
    assert.equal((await services.shared.read(await principal(group+'/topic/77',destination.id),released.id)).text,preview.text,'every topic of the group shares its releases');
    policy.topic_memory='topic';
    await assert.rejects(services.shared.read(await principal(group+'/topic/77',destination.id),released.id),{code:'shared_source_not_found'});
    delete policy.topic_memory;
    assert.equal((await services.shared.context(actor,'Approved')).sources.length,1);
    assert.ok((await request('/v1/sharing/releases')).releases.some((r:any)=>r.id===released.id));
    await request('/v1/sharing/releases/'+released.id+'/revoke',{expected_revision:1,operation_id:key+':revoke'});
    await assert.rejects(services.shared.read(actor,released.id),{code:'audience_context_changed'});
    await assert.rejects(services.shared.read(await principal(group,destination.id),released.id),{code:'shared_source_not_found'});
    assert.deepEqual(await request('/v1/sharing/previews/'+preview.id+'/approve',approval),released,'repeating approval cannot revive a revoked release');

    const second=await request('/v1/sharing/previews/'+preview.id+'/approve',{...approval,operation_id:key+':approve-second'});
    const guardId='derived_artifacts:'+preview.output_reference.id,output=await services.guards.read(guardId,await services.guards.state());
    await services.guards.edit(guardId,output.revision,{...(output.value as object),text:JSON.stringify({items:[{text:'Different approved text'}]})},key+':edit-output');
    await assert.rejects(services.shared.read(await principal(group,destination.id),second.id),{code:'sharing_preview_changed'});
    await assert.rejects(request('/v1/sharing/previews/'+preview.id+'/approve',{...approval,operation_id:key+':stale-approval'}),{code:'sharing_preview_changed'});
    const thirdPreview=await request('/v1/sharing/preview',{...initial,operation_id:key+':fresh-preview'});
    const third=await request('/v1/sharing/previews/'+thirdPreview.id+'/approve',{...approval,guard_revision:thirdPreview.guard_revision,text_hash:thirdPreview.text_hash,operation_id:key+':third'});
    const originalGuard=await services.guards.read('events:'+original.id,await services.guards.state());
    await services.guards.edit('events:'+original.id,originalGuard.revision,{...(originalGuard.value as object),text:'copperbridge Planning revised'},key+':source-edit');
    await assert.rejects(services.shared.read(await principal(group,destination.id),third.id),{code:'memory_refresh_required'});
    assert.equal((await request('/v1/sharing/previews/'+thirdPreview.id)).current,false);

    const filteredRule=await request('/v1/sharing/rules',{name:key+':filter',sources:['123'],destination:group,enabled:true,mode:'filtered',instructions:'Share only project knowledge',expected_revision:0,operation_id:key+':filter-rule'});
    actor=await principal(group,destination.id);
    const filtered=await services.shared.context(actor,'copperbridge');assert.equal(filtered.filter_status,'passed');assert.equal(calls,1);
    const item=filtered.sources.find(s=>s.kind==='privacy_filtered_inference')!;assert.ok(item);assert.ok(!JSON.stringify(item).includes(original.id));
    assert.equal((await services.shared.context(actor,'copperbridge')).filter_status,'passed');assert.equal(calls,1,'same durable result reused');
    assert.equal((await services.shared.read(actor,item.id)).text,'copperbridge Planning summary');
    await stores.control.query('UPDATE sharing_releases SET expires_at=now()-interval \'1 second\' WHERE id=$1',[item.id]);
    await assert.rejects(services.shared.read(actor,item.id),{code:'shared_source_not_found'});

    const control=Object.create(stores.control) as pg.Pool;let fail=true;
    control.query=(async(sql:any,...args:any[])=>{
      if(fail&&String(sql).startsWith("UPDATE sharing_previews SET state='ready'")){fail=false;throw Error('synthetic_sharing_completion_lost');}
      return (stores.control.query as any)(sql,...args);
    }) as typeof control.query;control.connect=stores.control.connect.bind(stores.control);
    const access=Object.assign(Object.create(services.access),{stores:{...stores,control}});
    const recovering=new SharingContentRepository(access,services.derived,services.prepared,services.selections,services.learned,services.sharing,services.shared.call,services.detect,token);
    const filterPreview={rule_id:filteredRule.id,expected_revision:1,source_ids:[original.id],query:'copperbridge',operation_id:key+':recover'};
    await assert.rejects(recovering.preview(owner,filterPreview),/synthetic_sharing_completion_lost/);const count=calls;
    const recovered=await services.shared.preview(owner,filterPreview);assert.equal(recovered.state,'ready');assert.equal(calls,count,'saved result precedes control completion');
    for(const bad of ['citation','outside','instruction'] as const) {
      mode=bad;await assert.rejects(services.shared.preview(owner,{...filterPreview,operation_id:key+':'+bad}));
    }
    mode='safe';
    await assert.rejects(services.shared.preview({...owner,admin:false},filterPreview),{code:'owner_required'});
    // A full General message omits topic fields. An explicit topic marker
    // without its thread identity is incomplete and cannot authorize sharing.
    assert.equal(await services.access.space(unknown),null);
    const unknownRule=await request('/v1/sharing/rules',{name:key+':unknown',sources:[other],destination:group,enabled:true,mode:'approved',instructions:'',expected_revision:0,operation_id:key+':unknown-rule'});
    await assert.rejects(services.shared.preview(owner,{...initial,rule_id:unknownRule.id,source_ids:[unknown.id],operation_id:key+':unknown'}),{code:'sharing_source_not_selected'});
    const beforeDisable=await principal(group,destination.id);
    const {revision:ruleRevision,...ruleFields}=filteredRule;
    duringFilter=async()=>{await request('/v1/sharing/rules',{...ruleFields,enabled:false,expected_revision:ruleRevision,operation_id:key+':disable'});};
    await assert.rejects(services.shared.preview(owner,{...filterPreview,operation_id:key+':revocation-race'}),{code:'sharing_policy_changed'});
    await assert.rejects(services.shared.read(beforeDisable,item.id),{code:'audience_context_changed'});
    await assert.rejects(services.shared.read(await principal(group,destination.id),item.id),{code:'shared_source_not_found'});
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('sharing_previews','sharing_releases') AND table_schema='public'")).rows.map(r=>r.column_name);
    assert.ok(!columns.includes('content'));assert.ok(!columns.includes('source_ids'));assert.ok(!columns.includes('candidates'));
    assert.equal((await stores.archive.query("SELECT 1 FROM events WHERE kind='shared_knowledge'")).rowCount,0);
    const saved=(await stores.derived.query('SELECT content,provenance FROM derived_artifacts WHERE id=$1',[recovered.output_reference!.id])).rows[0];
    assert.equal(saved.provenance.sources[0].id,original.id);assert.equal(saved.provenance.parents.length,2);

    const voice=await source('123',5,false,true),manifest=(await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[voice.id])).rows[0];
    const file=await services.attachments.commit(manifest.id,Buffer.from('Original voice bytes'));
    const versions=[];
    for(const version of ['1','2']) {
      const result=await services.derived.record({operation_id:key+':engine:'+version,source:voice,file,kind:'transcript',content:Buffer.from('Engine '+version+' reading'),
        producer:'fixture',producer_version:version,configuration:{}});
      await services.guards.prepare(result,'fixture',services.detect);versions.push(result);
    }
    await services.selections.activate(versions[0]!,null,key+':select-1');
    await request('/v1/sharing/rules',{...ruleFields,enabled:true,expected_revision:2,operation_id:key+':reenable'});
    const transcriptShare=await services.shared.context(await principal(group,destination.id),'Engine');
    assert.equal(transcriptShare.filter_status,'passed');assert.ok(filterInputs.at(-1)!.includes('Engine 1 reading'));
    const voicePreview=await services.shared.preview(owner,{...initial,source_ids:[voice.id],operation_id:key+':voice-preview'});
    const voiceRelease=await services.shared.approve(owner,voicePreview.id,{...approval,guard_revision:voicePreview.guard_revision,text_hash:voicePreview.text_hash,operation_id:key+':voice-approve'});
    assert.ok((await services.shared.read(await principal(group,destination.id),voiceRelease.id)).text);
    await services.selections.activate(versions[1]!,1,key+':select-2');
    await assert.rejects(services.shared.read(await principal(group,destination.id),voiceRelease.id),{code:'memory_refresh_required'});
    await assert.rejects(services.shared.read(await principal(group,destination.id),transcriptShare.sources[0]!.id),{code:'memory_refresh_required'});
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a project whose chats share what they know filters or publishes only the other chats\' knowledge, and stops when a chat leaves',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-project-sharing-'));
  const key='project-sharing:'+Date.now(),group='-'+Date.now(),other=group+'3',token='synthetic-sharing-token-not-a-real-credential',owner:Reader={admin:true,scope:null};
  const filterInputs:string[]=[];let calls=0;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group,other]};
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'memory.filter');calls++;
      const actor=reader({headers:{authorization:'Bearer '+input.archive_credential}} as IncomingMessage,token);
      assert.equal((await services.turns.binding(actor)).scope,other,'the filter reads as the source chat');
      const candidates=input.candidates as {id:string;text:string}[];filterInputs.push(candidates.map(c=>c.text).join('\n'));
      return {producer:{name:'fixture',version:'deterministic-1',model:'fixture',provider:'offline',api_mode:'fixture'},
        items:[{text:'tidewater summary from the other chat',source_ids:[candidates[0]!.id]}]};
    },memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const api=new OwnerStorageApi(services),request=(path:string,body?:unknown)=>api.request(owner,body===undefined?'GET':'POST',new URL(path,'http://fixture'),body) as Promise<any>;
  const source=async(scope:string,n:number,text:string,extra:Record<string,unknown>={})=>{
    const event:Envelope={version:1,key:key+':source:'+n,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:String(n),revision:'1',occurred_at:null,
      text,payload:{message:{message_id:n,date:1,chat:{id:Number(scope),type:'group'},text,...extra}}};
    const reference=(await services.capture.capture(event)).source.reference;await services.guards.prepare(reference,'fixture',services.detect);return reference;
  };
  const principal=async(space:string,turn:string):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:space,space,turnEvent:turn,generation:binding.generation,guard_epoch:binding.epoch};
  };
  let n=0;const op=(label:string)=>key+':'+label+':'+(++n);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const here=await source(group,1,'tidewater notes written in this group'),there=await source(other,2,'tidewater notes written in the other group');
    // A topic of the other group with no project of its own follows its group into the project.
    const topic=other+'/topic/5',inTopic=await source(other,3,'tidewater notes written in a topic over there',{message_thread_id:5,is_topic_message:true});
    let project=await request('/v1/projects',{name:key,description:'',state:'active',expected_revision:0,operation_id:op('project')});
    const save=async(changes:Record<string,unknown>)=>project=await request('/v1/projects',{id:project.id,name:key,description:'',state:'active',
      ...changes,expected_revision:project.revision,operation_id:op('save')});
    const assign=async(space:string,body:Record<string,unknown>)=>request('/v1/projects/assignments',{space_id:space,
      expected_revision:(await request('/v1/projects/effective?space='+encodeURIComponent(space))).own_assignment?.revision??0,operation_id:op('assign'),...body});
    for(const space of [group,other])await assign(space,{mode:'assigned',project_id:project.id});
    const filtered=async()=>(await services.shared.context(await principal(group,here.id),'tidewater')).sources.filter(s=>s.kind==='privacy_filtered_inference');
    assert.deepEqual(await filtered(),[],'membership alone shares nothing');assert.equal(calls,0);

    await save({sharing_enabled:true});
    const items=await filtered();assert.equal(items.length,1);assert.equal(items[0]!.text,'tidewater summary from the other chat');
    assert.ok(filterInputs.at(-1)!.includes('the other group')&&!filterInputs.at(-1)!.includes('this group'),'a chat\'s own messages are never filtered into it');
    assert.ok(filterInputs.at(-1)!.includes('a topic over there'),'a topic that follows a group in the project is read with it');
    assert.ok(!JSON.stringify(items).includes(there.id));
    assert.ok((await request('/v1/sharing/rules')).rules.every((r:any)=>r.project_id!==project.id||r.name===key),'project rules carry the project name');

    await save({sharing_mode:'approved'});
    const ruleId=digest('project-sharing:'+project.id+':'+group);
    let rule=(await stores.control.query('SELECT * FROM sharing_rules WHERE id=$1',[ruleId])).rows[0];
    const ask={rule_id:ruleId,expected_revision:rule.revision,source_ids:[there.id],content:'tidewater approved plan'};
    await assert.rejects(request('/v1/sharing/preview',{...ask,source_ids:[here.id],operation_id:op('own')}),{code:'sharing_source_not_selected'});
    const approve=async(body:Record<string,unknown>)=>{
      const preview=await request('/v1/sharing/preview',{...body,operation_id:op('preview')});
      return {preview,release:await request('/v1/sharing/previews/'+preview.id+'/approve',{expected_revision:body.expected_revision,guard_revision:preview.guard_revision,
        text_hash:preview.text_hash,operation_id:op('approve')})};
    };
    const {preview,release}=await approve(ask);
    const turn=await principal(group,here.id);
    assert.equal((await services.shared.read(turn,release.id)).text,'tidewater approved plan');
    assert.deepEqual(await filtered(),[],'approved mode publishes only texts the owner approved');
    await assert.rejects(request('/v1/sharing/rules',{id:ruleId,name:'Owner edit',sources:[other],destination:group,enabled:false,mode:'approved',
      instructions:'',expected_revision:rule.revision,operation_id:op('owner-edit')}),{code:'sharing_rule_project_managed'});

    // A text from the following topic is approved like one from its group, and stays invalid once the topic stops following, even when it comes back.
    const fromTopic=(await approve({...ask,source_ids:[inTopic.id],content:'tidewater topic plan'})).release;
    assert.equal((await services.shared.read(await principal(group,here.id),fromTopic.id)).text,'tidewater topic plan');
    await assign(topic,{mode:'none',project_id:null});
    await assert.rejects(services.shared.read(await principal(group,here.id),fromTopic.id),{code:'shared_source_not_found'});
    rule=(await stores.control.query('SELECT * FROM sharing_rules WHERE id=$1',[ruleId])).rows[0];
    assert.equal(rule.revision,ask.expected_revision+1,'the rule that read the topic through its group narrowed');
    await assert.rejects(request('/v1/sharing/preview',{...ask,expected_revision:rule.revision,source_ids:[inTopic.id],operation_id:op('left')}),{code:'sharing_source_not_selected'});
    await assign(topic,{mode:'inherit',project_id:null});
    await assert.rejects(services.shared.read(await principal(group,here.id),fromTopic.id),{code:'shared_source_not_found'},'a topic that comes back does not revive texts');

    await assign(other,{mode:'inherit',project_id:null});
    await assert.rejects(services.shared.read(turn,release.id),{code:'audience_context_changed'});
    await assert.rejects(services.shared.read(await principal(group,here.id),release.id),{code:'shared_source_not_found'});
    assert.equal((await request('/v1/sharing/previews/'+preview.id)).current,false);
    await assign(other,{mode:'assigned',project_id:project.id});
    rule=(await stores.control.query('SELECT * FROM sharing_rules WHERE id=$1',[ruleId])).rows[0];assert.equal(rule.enabled,true);
    await assert.rejects(services.shared.read(await principal(group,here.id),release.id),{code:'shared_source_not_found'},'a chat that comes back does not revive texts');

    await save({sharing_mode:'filtered'});assert.equal((await filtered()).length,1);assert.ok(filterInputs.at(-1)!.includes('a topic over there'));
    await assign(topic,{mode:'none',project_id:null});const before=calls;
    assert.equal((await filtered()).length,1);assert.equal(calls,before+1);
    assert.ok(filterInputs.at(-1)!.includes('the other group')&&!filterInputs.at(-1)!.includes('a topic over there'),'a topic that stops following its group is not filtered');
    await assign(group,{mode:'assigned',project_id:project.id,share_into:false});
    assert.deepEqual(await filtered(),[],'a chat left out receives nothing from the project');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
