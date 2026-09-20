import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SourceAccessRepository} from '../src/stores/access.js';
import {ProjectRepository} from '../src/stores/projects.js';
import {EntityRepository} from '../src/stores/entities.js';

test('people and projects keep stable identity, attributed evidence, connected recall paths and audience privacy',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const stamp=String(Date.now()),atlasGroup='-'+stamp,privateGroup='-'+String(Number(stamp)+1),userBase=Number(stamp.slice(-7))*10,owner:Reader={admin:true,scope:null};
  const access=new SourceAccessRepository(stores,archive,guards,()=>({enabled:true,owner_id:'42',group_ids:[atlasGroup,privateGroup]}));
  const projects=new ProjectRepository(stores.control),entities=new EntityRepository(stores,access,projects);
  const capture=async(label:string,user:number,text:string,group=atlasGroup)=>{
    const envelope:Envelope={version:1,key:`entities:${stamp}:${label}`,origin:'live',kind:'telegram_update',bot_id:'fixture',scope:group,
      source_id:label,revision:'1',occurred_at:null,text,payload:{update_id:Number(stamp.slice(-8))+user,message:{message_id:Number(label.replace(/\D/g,''))||user,
        date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:user,first_name:'Alex'},text}}};
    return (await archive.capture(envelope)).source.reference;
  };
  try {
    const atlas=await projects.save(owner,{name:'Atlas',description:'Atlas project',state:'active',expected_revision:0,operation_id:`${stamp}:atlas`});
    const beacon=await projects.save(owner,{name:'Beacon',description:'Beacon project',state:'active',expected_revision:0,operation_id:`${stamp}:beacon`});
    await projects.assign(owner,{space_id:atlasGroup,project_id:atlas.id,mode:'assigned',expected_revision:0,operation_id:`${stamp}:assign`});
    const samSource=await capture('1',userBase+1,'Beacon needs Alex to deliver Friday.');
    const otherAlexSource=await capture('2',userBase+2,'I am a different Alex.');
    const sam=await entities.ensureParticipant(samSource),samAgain=await entities.ensureParticipant(samSource),otherAlex=await entities.ensureParticipant(otherAlexSource);
    assert.ok(sam&&otherAlex);assert.equal(sam!.name,'Alex');assert.equal(otherAlex!.name,'Alex');
    assert.equal(sam!.id,samAgain!.id);assert.notEqual(sam!.id,otherAlex!.id,'same display name never merges exact platform identities');

    const context=await entities.context(samSource,[beacon],'Beacon needs Alex to deliver Friday.');
    assert.equal(context.project?.project_id,atlas.id);assert.equal(context.mentioned_projects[0]?.project_id,beacon.id);
    const binding=await guards.state(),prepared:any={source:samSource,source_object:'fixture',space:atlasGroup,binding,evidence:[{reference:samSource,text:'',space:atlasGroup}],
      dependencies:[],observations:[],rules:[],rule_ids:[],projects:[],entities:context,limitations:[]};
    await entities.publishDiscoveries(prepared,{entity_suggestions:[],entity_claims:[{subject_id:context.mentioned_projects[0]!.id,predicate:'commitment',
      content:'Alex promised Friday according to the speaker.',attribution:'reported',speaker_entity_id:sam!.id,uncertainty:'supported',evidence_ids:[samSource.id]}]},`${stamp}:discover`);

    const atlasReader=access.principal(atlasGroup),privateReader=access.principal(privateGroup);
    const connected=await entities.connected(atlasReader,'Atlas');
    assert.equal(connected.entities[0]!.entity.name,'Atlas');
    assert.match(connected.entities.find(item=>item.entity.name==='Beacon')!.path.join(' '),/contextual: Beacon/);
    const fromBeacon=await entities.connected(atlasReader,'Beacon');
    assert.equal(new Set(fromBeacon.entities.map(item=>item.entity.id)).size,fromBeacon.entities.length,'cycles never duplicate an entity');
    assert.ok(fromBeacon.entities.some(item=>item.entity.id===sam!.id),'useful multi-step paths reach a participant');
    assert.equal((await entities.connectedFrom(atlasReader,[context.project!.id],1)).partial,true,'bounded traversal reports partial results');
    const beaconMemory=await entities.inspect(atlasReader,context.mentioned_projects[0]!.id);
    const reported=beaconMemory.claims.find((claim:any)=>claim.predicate==='commitment');
    assert.equal(reported.attribution,'reported');assert.equal(reported.speaker_entity_id,sam!.id);
    await assert.rejects(entities.inspect(privateReader,context.mentioned_projects[0]!.id),{code:'entity_not_found'});
    assert.equal((await entities.list(privateReader,{query:'Beacon'})).entities.length,0,'private entity names do not leak through search');

    await entities.merge(owner,otherAlex!.id,{target_id:sam!.id,expected_revision:otherAlex!.revision,operation_id:`${stamp}:merge`});
    assert.equal((await stores.control.query('SELECT entity_id FROM memory_entity_bindings WHERE source_object_id IS NOT NULL AND entity_id=$1',[sam!.id])).rowCount,2);
    await entities.unmerge(owner,otherAlex!.id,{expected_revision:otherAlex!.revision+1,operation_id:`${stamp}:unmerge`});
    assert.equal((await stores.control.query('SELECT entity_id FROM memory_entity_bindings WHERE source_object_id IS NOT NULL AND entity_id=$1',[otherAlex!.id])).rowCount,1,
      'undo restores original identity bindings');
  } finally {await stores.close();}
 });
