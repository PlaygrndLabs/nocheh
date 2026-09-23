import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {reader,scopeToken,type Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {SourceAccessRepository} from '../src/stores/access.js';
import {SourceRepository} from '../src/stores/retrieval.js';
import {ProjectRepository} from '../src/stores/projects.js';

test('source-only retrieval keeps derivative links, independent relationship lookup and generation-bound privacy',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),root=await mkdtemp(join(tmpdir(),'nocheh-retrieval-'));
  const access=new SourceAccessRepository(stores,archive,guards,()=>({enabled:true,owner_id:'123',group_ids:['-321','-654']}));
  const sources=new SourceRepository(access,new AttachmentRepository(stores,archive,root),selections),owner:Reader={scope:null,admin:true},key='retrieval:'+Date.now();
  const sequence=Date.now();
  const event=(suffix:string,scope:string,message:Record<string,unknown>):Envelope=>({version:1,key:key+suffix,origin:'live',bot_id:'fixture',
    kind:'telegram_update',scope,source_id:String(message.message_id),revision:'1',occurred_at:null,text:String(message.text??''),payload:{message}});
  const principal=async(scope:string,space=scope):Promise<Reader>=>{const binding=await guards.state();return {scope,space,admin:false,generation:binding.generation,guard_epoch:binding.epoch};};
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const target=(await archive.capture(event(':target','-321',{message_id:sequence+1,chat:{id:-321,type:'group'},text:'Original quillmarsh'}))).source.reference;
    const foreign=(await archive.capture(event(':foreign','-654',{message_id:sequence+2,chat:{id:-654,type:'group'},text:'Foreign hazelwharf'}))).source.reference;
    const reply=(await archive.capture(event(':reply','-321',{message_id:sequence+3,chat:{id:-321,type:'group',title:'Quillmarsh team'},text:'A reply quillmarsh',from:{id:44,username:'alex_quill'},
      reply_to_message:{message_id:sequence+1,chat:{id:-321,type:'group'},text:'embeddedsecret'},external_reply:{message_id:sequence+2,chat:{id:-654},text:'foreignsecret'}}))).source.reference;
    const unknown=(await archive.capture(event(':unknown','-321',{message_id:sequence+4,chat:{id:-321,type:'supergroup',is_forum:true},text:'Unknown membership'}))).source.reference;
    const topic=(await archive.capture(event(':topic','-321',{message_id:sequence+5,chat:{id:-321,type:'supergroup',is_forum:true},message_thread_id:77,text:'Topic quillmarsh'}))).source.reference;
    await assert.rejects(sources.read(await principal('-321'),target.id),{code:'guard_preparation_pending'});
    assert.equal((await sources.read(owner,target.id)).event.text,'Original quillmarsh');
    for(const reference of [target,foreign,reply,unknown,topic])await guards.prepare(reference,'fixture',async()=>[]);
    const transcript=await derived.record({operation_id:key+':transcript',source:target,kind:'transcript',content:Buffer.from('Derivative silverrush'),producer:'fixture',producer_version:'1',configuration:{}});
    const context=await derived.record({operation_id:key+':context',source:target,kind:'runtime_context',content:Buffer.from('runtime_context silverrush'),producer:'fixture',producer_version:'1',configuration:{}});
    await guards.prepare(transcript,'fixture',async()=>[]);await guards.prepare(context,'fixture',async()=>[]);
    await selections.activate(transcript,null,digest(key+':activate'),'automatic');
    assert.equal((await sources.search(owner,'silverrush')).length,0);
    assert.equal((await sources.search(await principal('-321'),'silverrush')).length,0);
    assert.ok((await sources.search(owner,'quillmarsh')).some(row=>row.id===target.id));
    const scoped=await principal('-321'),hits=await sources.search(scoped,'quillmarsh');
    assert.ok(hits.some(row=>row.id===target.id));assert.ok(!hits.some(row=>row.id===topic.id));
    for(const word of ['foreignsecret','embeddedsecret','hazelwharf'])assert.deepEqual(await sources.search(scoped,word),[]);
    const read=await sources.read(scoped,reply.id);
    assert.ok(!JSON.stringify(read).includes('foreignsecret'));assert.ok(!JSON.stringify(read).includes('embeddedsecret'));
    assert.ok(read.relationships.targets.every(r=>r.references.every(ref=>ref.id!==foreign.id)));
    assert.equal(Buffer.from((await sources.read(scoped,target.id)).derived[0]!.content_base64,'base64').toString(),'Derivative silverrush');
    assert.equal((await sources.read(owner,target.id)).derivative_versions,'/v1/sources/'+target.id+'/derivatives');
    await assert.rejects(sources.read(scoped,unknown.id),{code:'source_not_found'});
    await assert.rejects(sources.read(scoped,topic.id),{code:'source_not_found'});
    assert.equal((await sources.read(await principal('-321','-321/topic/77'),topic.id)).event.text,'Topic quillmarsh');
    const graph=await sources.graph(owner,'*','',1,reply.id);
    assert.ok(graph.nodes.some(n=>n.id==='collection:*'&&n.kind==='collection'&&n.label==='All private knowledge'));
    assert.ok(graph.edges.some(e=>e.from==='collection:*'&&e.to==='group:-321'&&e.kind==='contains'));
    assert.ok(graph.nodes.some(n=>n.id==='message:'+target.id),'old target resolves outside the graph page');
    assert.ok(graph.edges.some(e=>e.from==='message:'+reply.id&&e.to==='message:'+target.id&&e.kind==='reply_to_source'));
    assert.ok(graph.nodes.some(n=>n.kind==='user'));
    assert.ok(graph.nodes.some(n=>n.kind==='group'&&n.label==='Quillmarsh team'));
    assert.ok(graph.nodes.some(n=>n.kind==='group'&&n.chat_type==='group'));
    assert.ok(graph.nodes.some(n=>n.kind==='user'&&n.label==='@alex_quill'));
    assert.deepEqual([...new Set(graph.nodes.map(n=>n.kind))].sort(),['collection','group','message','user']);
    assert.ok(!graph.nodes.some(n=>n.label==='runtime_context'));
    await assert.rejects(sources.graph(scoped,'-321'),{code:'owner_required'});

    const projects=new ProjectRepository(stores.control),project=await projects.save(owner,{name:key,state:'active',expected_revision:0,operation_id:key+':project'});
    for(const space of ['-321','-654'])await projects.assign(owner,{space_id:space,mode:'assigned',project_id:project.id,
      expected_revision:(await stores.control.query('SELECT revision FROM project_assignments WHERE space_id=$1',[space])).rows[0]?.revision??0,operation_id:key+space});
    const projectGraph=await sources.graph(owner,'-321','',1,reply.id);
    assert.ok(projectGraph.nodes.some(n=>n.id==='project:'+project.id&&n.kind==='project'));
    assert.ok(projectGraph.edges.some(e=>e.from==='project:'+project.id&&e.to==='group:-321'&&e.kind==='project_context'));
    await assert.rejects(sources.read(await principal('-321'),foreign.id),{code:'source_not_found'},'project membership creates no raw read grant');
    await assert.rejects(sources.read(scoped,target.id),{code:'audience_context_changed'});
    const current=await principal('-321');
    await assert.rejects(sources.read({...current,generation:'00000000-0000-0000-0000-000000000000'},target.id),{code:'audience_context_changed'});
    const token=await sources.audience.turn('synthetic-secret',current,target.id,Date.now()+60000);
    const parsed=reader({headers:{authorization:'Bearer '+token}} as IncomingMessage,'synthetic-secret');
    assert.equal(parsed.generation,current.generation);assert.equal((await sources.read(parsed,target.id)).id,target.id);
    const legacy=reader({headers:{authorization:'Bearer '+scopeToken('synthetic-secret','-321',Date.now()+60000)}} as IncomingMessage,'synthetic-secret');
    await assert.rejects(sources.read(legacy,target.id),{code:'audience_context_changed'});
    await guards.setMode('off');
    await assert.rejects(sources.read(parsed,target.id),{code:'audience_context_changed'});
    const unprepared=(await archive.capture(event(':off','-321',{message_id:sequence+6,chat:{id:-321,type:'group'},text:'Guard off original'}))).source.reference;
    assert.equal((await sources.read(await principal('-321'),unprepared.id)).event.text,'Guard off original');
    await assert.rejects(sources.read({...await principal('-321'),generation:'00000000-0000-0000-0000-000000000000'},unprepared.id),{code:'audience_context_changed'});
  } finally {await guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});
