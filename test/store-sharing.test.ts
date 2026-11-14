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
import {fixtureServices} from './fixture-brain.js';
import {SharingContentRepository} from '../src/stores/sharing.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('sharing publishes exact prepared text with private provenance, revocation and durable filter checkpoints',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-sharing-'));
  const key='sharing:'+Date.now(),group='-'+Date.now(),other=group+'7',origin=group+'9',token='synthetic-sharing-token-not-a-real-credential',owner:Reader={admin:true,scope:null};
  let calls=0,mode:'safe'|'citation'|'outside'|'instruction'='safe',duringFilter:(()=>Promise<void>)|null=null;
  const filterInputs:string[]=[];
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group,other,origin]};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:String(input.text).includes('saffronpass')?['saffronpass']:[]};
      assert.equal(operation,'memory.filter');calls++;
      const actor=reader({headers:{authorization:'Bearer '+input.archive_credential}} as IncomingMessage,token);
      assert.equal(actor.purpose,'filter');assert.equal(actor.scope,null);assert.equal((await services.turns.binding(actor)).scope,origin);
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
    const original=await source(origin,1),destination=await source(group,2),unrelated=await source(other,3),unknown=await source(other,4,true);
    const rule=await request('/v1/sharing/rules',{name:key,sources:[origin],destination:group,enabled:true,mode:'approved',instructions:'Only selected facts',expected_revision:0,operation_id:key+':rule'});
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

    const filteredRule=await request('/v1/sharing/rules',{name:key+':filter',sources:[origin],destination:group,enabled:true,mode:'filtered',instructions:'Share only project knowledge',expected_revision:0,operation_id:key+':filter-rule'});
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

    const voice=await source(origin,5,false,true),manifest=(await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[voice.id])).rows[0];
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

    // The owner's private chat is never a source: no rule takes it, and an older rule that names it never reads it again.
    const mine=await source('123',6);
    await assert.rejects(request('/v1/sharing/rules',{name:key+':mine',sources:['123'],destination:group,enabled:true,mode:'approved',instructions:'',expected_revision:0,operation_id:key+':mine-rule'}),{code:'sharing_private_chat'});
    const olderRule=digest(key+':older-private-rule');
    await stores.control.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,'Older private rule','["123"]',$2,true,'approved','',1)`,[olderRule,group]);
    const olderAsk={rule_id:olderRule,expected_revision:1,source_ids:[mine.id],content:'copperbridge Private plan',operation_id:key+':older-preview'};
    await assert.rejects(services.shared.preview(owner,olderAsk),{code:'sharing_source_not_selected'});
    // A text approved while such a rule could still read the private chat is not served any more.
    const covers=services.sharing.covers;services.sharing.covers=async()=>true;let olderRelease:{id:string};
    try {const older=await services.shared.preview(owner,{...olderAsk,operation_id:key+':older-before'});
      olderRelease=await services.shared.approve(owner,older.id,{expected_revision:1,guard_revision:older.guard_revision,text_hash:older.text_hash,operation_id:key+':older-approve'});
    } finally {services.sharing.covers=covers;}
    await assert.rejects(services.shared.read(await principal(group,destination.id),olderRelease.id),{code:'sharing_source_not_selected'});
    assert.ok(!(await services.shared.context(await principal(group,destination.id),'')).sources.some(item=>item.id===olderRelease.id));
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a group answer uses only that group: groups in one project share nothing, and only the owner\'s own rule lets another group in',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-project-groups-'));
  const key='project-groups:'+Date.now(),group='-'+Date.now(),other=group+'3',token='synthetic-sharing-token-not-a-real-credential',owner:Reader={admin:true,scope:null};
  const filterInputs:string[]=[];let calls=0;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group,other]};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'memory.filter');calls++;
      const candidates=input.candidates as {id:string;text:string}[];filterInputs.push(candidates.map(c=>c.text).join('\n'));
      return {producer:{name:'fixture',version:'deterministic-1',model:'fixture',provider:'offline',api_mode:'fixture'},
        items:[{text:'tidewater summary from the other group',source_ids:[candidates[0]!.id]}]};
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
    await source(other,3,'tidewater notes written in a topic over there',{message_thread_id:5,is_topic_message:true});
    await assert.rejects(request('/v1/projects',{name:key,description:'',state:'active',sharing_enabled:true,expected_revision:0,operation_id:op('box')}),
      {code:'unknown_policy_field'},'the project share box is gone');
    const project=await request('/v1/projects',{name:key,description:'',state:'active',expected_revision:0,operation_id:op('project')});
    for(const space of [group,other])await request('/v1/projects/assignments',{space_id:space,mode:'assigned',project_id:project.id,
      expected_revision:(await request('/v1/projects/effective?space='+encodeURIComponent(space))).own_assignment?.revision??0,operation_id:op('assign')});
    let listed:any=null;for(let after='';!listed;){const page=await request('/v1/projects?after='+after);listed=page.projects.find((row:any)=>row.id===project.id);if(!page.next)break;after=page.next;}
    assert.deepEqual(listed?.groups,[group,other].sort(),'the project lists both groups');
    // The same project gives a group nothing from another of its groups, for the owner too: no rule, no filter, no source.
    for(const [space,turn] of [[group,here.id],[other,there.id]] as const){
      const context=await services.shared.context(await principal(space,turn),'tidewater');
      assert.deepEqual(context.sources,[],space);
    }
    assert.equal(calls,0,'nothing is ever filtered between the groups of a project');
    for(const space of [group,other])assert.deepEqual(await services.sharing.forDestination(space,space),[],'no rule is written for a project');

    // The owner's own rule is the one exception, and it reads only the exact chats it names.
    await request('/v1/sharing/rules',{name:key+':owner',sources:[other],destination:group,enabled:true,mode:'filtered',instructions:'',expected_revision:0,operation_id:op('rule')});
    const items=(await services.shared.context(await principal(group,here.id),'tidewater')).sources.filter(item=>item.kind==='privacy_filtered_inference');
    assert.equal(items.length,1);assert.equal(calls,1);
    assert.ok(filterInputs.at(-1)!.includes('the other group')&&!filterInputs.at(-1)!.includes('a topic over there'),'never a topic the rule does not name');
    assert.deepEqual((await services.shared.context(await principal(other,there.id),'tidewater')).sources,[],'nothing flows back the other way');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('starting up deletes a project\'s own rules with their texts and the share box columns, keeping the owner\'s rules',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),db=stores.control,key='share-box-cleanup:'+Date.now(),group='-'+Date.now(),other=group+'3';
  const project=digest(key+':project'),projectRule=digest(key+':project-rule'),ownerRule=digest(key+':owner-rule');
  const columns=async()=>(await db.query(`SELECT table_name||'.'||column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND
    (table_name,column_name) IN (('projects','sharing_enabled'),('projects','sharing_mode'),('project_assignments','share_into'),('sharing_rules','project_id')) ORDER BY 1`)).rows.map(row=>row.name);
  const rows=async(table:string,ids:string[])=>(await db.query(`SELECT id FROM ${table} WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows.map(row=>row.id);
  try {
    // The control schema as the share box left it: its four columns, a project's rule with a preview and a release,
    // the owner's rule with its own, and a topic that chose a project of its own.
    const schemaOwner=new pg.Client({...config,database:'nocheh_control'});await schemaOwner.connect();
    try {
      await schemaOwner.query(`SET ROLE nocheh_control_owner;
        ALTER TABLE projects ADD COLUMN sharing_enabled boolean NOT NULL DEFAULT false,ADD COLUMN sharing_mode text NOT NULL DEFAULT 'filtered';
        ALTER TABLE project_assignments ADD COLUMN share_into boolean NOT NULL DEFAULT true;
        ALTER TABLE sharing_rules ADD COLUMN project_id text REFERENCES projects(id);
        CREATE INDEX sharing_rules_project ON sharing_rules(project_id,destination) WHERE project_id IS NOT NULL`);
    } finally {await schemaOwner.end();}
    assert.equal((await columns()).length,4);
    await db.query("INSERT INTO projects(id,name,description,state,revision,sharing_enabled) VALUES($1,'P1','','active',1,true)",[project]);
    await db.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$3,'assigned',1),($2,$3,'assigned',1),($1||'/topic/7',NULL,'none',1),($2||'/topic/8',$3,'assigned',2)`,[group,other,project]);
    await db.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision,project_id) VALUES
      ($1,'P1',$3,$4,true,'filtered','',1,$5),($2,'Owner rule',$3,$4,true,'approved','',1,NULL)`,[projectRule,ownerRule,JSON.stringify([other]),group,project]);
    const generation=(await db.query('SELECT generation FROM installation WHERE singleton')).rows[0].generation;
    for(const rule of [projectRule,ownerRule]){
      await db.query(`INSERT INTO sharing_previews(id,request_hash,operation_reference,rule_id,rule_revision,generation,guard_epoch,guard_mode,input_reference,state)
        VALUES($1,$2,'{}'::jsonb,$3,1,$4,1,'on','{}'::jsonb,'ready')`,[digest(rule+':preview'),digest(rule),rule,generation]);
      await db.query(`INSERT INTO sharing_releases(id,preview_id,rule_id,rule_revision,generation,guard_mode,guard_revision,text_hash,mode)
        VALUES($1,$2,$3,1,$4,'on',1,$5,'approved')`,[digest(rule+':release'),digest(rule+':preview'),rule,generation,digest(rule+':text')]);
    }
    await initializeStoreDatabases(config,passwords);
    assert.deepEqual(await rows('sharing_rules',[projectRule,ownerRule]),[ownerRule],'the project\'s rule is deleted, never kept as the owner\'s');
    assert.deepEqual(await rows('sharing_previews',[digest(projectRule+':preview'),digest(ownerRule+':preview')]),[digest(ownerRule+':preview')]);
    assert.deepEqual(await rows('sharing_releases',[digest(projectRule+':release'),digest(ownerRule+':release')]),[digest(ownerRule+':release')]);
    assert.deepEqual(await columns(),[],'the share box columns are gone');
    assert.equal((await db.query("SELECT 1 FROM pg_indexes WHERE indexname='sharing_rules_project'")).rowCount,0);
    const assignments=(await db.query('SELECT space_id,project_id,mode,revision FROM project_assignments WHERE space_id=ANY($1::text[]) ORDER BY space_id COLLATE "C"',
      [[group,other,group+'/topic/7',other+'/topic/8']])).rows;
    assert.deepEqual(assignments.map(row=>[row.space_id,row.mode,row.project_id]),[[group,'assigned',project],[group+'/topic/7','inherit',null],[other,'assigned',project],[other+'/topic/8','inherit',null]],
      'groups keep their project; a topic\'s own choice becomes following its group');
    assert.deepEqual(assignments.filter(row=>row.space_id.includes('/topic/')).map(row=>row.revision),[2,3],'and its revision rises');
    // Starting again changes nothing more.
    await initializeStoreDatabases(config,passwords);
    assert.deepEqual(await rows('sharing_rules',[projectRule,ownerRule]),[ownerRule]);
    assert.equal((await db.query("SELECT revision FROM project_assignments WHERE space_id=$1",[group+'/topic/7'])).rows[0].revision,2);
  } finally {await stores.close();}
});
