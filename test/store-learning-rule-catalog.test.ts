import {test} from 'node:test';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {ProjectRepository} from '../src/stores/projects.js';
import {EntityRepository} from '../src/stores/entities.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {LearnedMemoryRepository} from '../src/stores/learned.js';
import {SourceAccessRepository} from '../src/stores/access.js';
import {LearningContextRepository} from '../src/stores/learning-context.js';

test('a chat with more than 100 learned rules keeps learning with the owner\'s and the newest rules',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive),guards=new GuardRepository(stores,archive);
  const key='rule-catalog:'+Date.now(),group=String(-Date.now()),space=group+'/topic/17';
  const policy:AssistantPolicy={enabled:true,owner_id:'42',group_ids:[group]},access=new SourceAccessRepository(stores,archive,guards,()=>policy);
  const learned=new LearnedMemoryRepository(stores,archive,derived,guards),projects=new ProjectRepository(stores.control),selections=new SelectionRepository(stores,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects,new EntityRepository(stores,access,projects));
  const detect=async()=>[];
  const message=(id:number,text:string):Envelope=>({version:1,key:key+':'+id,origin:'live',bot_id:key,kind:'telegram_update',scope:group,
    source_id:String(id),revision:String(id),occurred_at:null,text,
    payload:{update_id:id,message:{message_id:id,chat:{id:group,type:'supergroup'},message_thread_id:17,is_topic_message:true,from:{id:7},text}}});
  try {
    await guards.setMode('on');
    const source=(await archive.capture(message(1,'In this topic a green mark means ready.'))).source.reference;
    await guards.prepare(source,'fixture',detect);
    const dependencies=(await contexts.prepare(source,await guards.state())).dependencies,ids:string[]=[];
    for(let index=0;index<101;index++) {
      const id=digest(key+':rule:'+index);ids.push(id);
      await learned.publishAutomatic(id,{kind:'convention',subject:'mark '+index,text:'Mark '+index+' means ready.',scope:{kind:'conversation',id:space},
        uncertainty:'explicit',evidence:[source],quote:{source_id:source.id,text:'In this topic a green mark means ready.'},conflicts:[]},
        null,key+':publish:'+index,dependencies,await guards.state(),'fixture',detect);
    }
    // The owner's correction of the oldest rule keeps it ahead of every automatic rule.
    await learned.correct({admin:true,scope:null},ids[0]!,{expected_revision:1,operation_id:key+':owner',text:'Owner rule.',retired:false},detect);
    // Rules are offered when learning from another message than their own evidence.
    const next=(await archive.capture(message(2,'Green mark on the draft.'))).source.reference;
    await guards.prepare(next,'fixture',detect);
    const prepared=await contexts.prepare(next,await guards.state());
    assert.equal(prepared.rule_ids.length,100);
    assert.ok(prepared.limitations.includes('rule_catalog_limit'));
    assert.ok(prepared.rule_ids.includes(ids[0]!),'the owner\'s rule is kept');
    assert.ok(prepared.rule_ids.includes(ids[100]!),'the newest rule is kept');
    assert.ok(!prepared.rule_ids.includes(ids[1]!),'the oldest automatic rule is left out');
  } finally {await stores.close();}
});
