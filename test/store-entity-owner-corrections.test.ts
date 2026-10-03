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

test('owner entity decisions survive automatic identity and claim refresh',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async t=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive);
  const guards=new GuardRepository(stores,archive),stamp=Date.now(),group='-'+stamp,owner:Reader={admin:true,scope:null};let sequence=0;
  const access=new SourceAccessRepository(stores,archive,guards,()=>({enabled:true,owner_id:'42',group_ids:[group]}));
  const entities=new EntityRepository(stores,access,new ProjectRepository(stores.control));
  const capture=async(actor:number,name:string)=>{
    const index=++sequence,event:Envelope={version:1,key:`owner-entity:${stamp}:${index}`,origin:'live',kind:'telegram_update',bot_id:'fixture',scope:group,
      source_id:String(index),revision:'1',occurred_at:null,text:'Synthetic milestone observation',payload:{message:{message_id:index,date:1,
        chat:{id:Number(group),type:'supergroup'},from:{id:stamp+actor,first_name:name},text:'Synthetic milestone observation'}}};
    return (await archive.capture(event)).source.reference;
  };
  const participant=async(actor:number,name:string)=>{const source=await capture(actor,name),entity=await entities.ensureParticipant(source);assert.ok(entity);return {source,entity};};
  try {
    await t.test('the owner display name survives newer Telegram names',async()=>{
      const {entity}=await participant(1,'Platform name');
      await entities.rename(owner,entity.id,{name:'Owner chosen name',expected_revision:entity.revision,operation_id:`${stamp}:rename`});
      const refreshed=await participant(1,'Changed platform name');assert.equal(refreshed.entity.id,entity.id);
      assert.equal(refreshed.entity.name,'Owner chosen name');assert.equal(refreshed.entity.revision,entity.revision+1);
    });
    await t.test('an untouched platform display name still refreshes',async()=>{
      const {entity}=await participant(2,'Original platform name'),refreshed=await participant(2,'Updated platform name');
      assert.equal(refreshed.entity.id,entity.id);assert.equal(refreshed.entity.name,'Updated platform name');
    });
    await t.test('new messages use the owner-merged identity and respect Undo',async()=>{
      const source=await participant(3,'Source identity'),target=await participant(4,'Canonical identity');
      const merged=await entities.merge(owner,source.entity.id,{target_id:target.entity.id,expected_revision:source.entity.revision,operation_id:`${stamp}:merge`});
      const refreshed=await participant(3,'Later platform name');assert.equal(refreshed.entity.id,target.entity.id);
      assert.equal(refreshed.entity.name,'Canonical identity');assert.equal(refreshed.entity.state,'active');
      await entities.unmerge(owner,source.entity.id,{expected_revision:merged.revision,operation_id:`${stamp}:unmerge`});
      assert.equal((await participant(3,'Another platform name')).entity.id,source.entity.id);
    });
    const factSource=await participant(5,'Reported source'),laterSource=await capture(5,'Reported source');
    const publish=async(predicate:string,content:string,later=false)=>entities.publishClaim({subject_id:factSource.entity.id,predicate,content,
      attribution:'reported',speaker_entity_id:factSource.entity.id,uncertainty:'supported',evidence:[later?laterSource:factSource.source]},await guards.state(),`${stamp}:${predicate}:${later}`);
    for(const retired of [false,true])await t.test(retired?'owner retirement cannot be resurrected by later automatic evidence':'owner corrected wording overrides later automatic interpretation',async()=>{
      const predicate=retired?'retired_milestone':'corrected_milestone',first=await publish(predicate,'The milestone is October.');
      const corrected=await entities.correct(owner,first.id,{content:'The owner says November.',attribution:'reported',uncertainty:'explicit',retired,
        expected_revision:first.revision,operation_id:`${stamp}:correct:${retired}`});
      const refreshed=await publish(predicate,'A new automatic interpretation says December.',true);
      assert.equal(refreshed.revision,corrected.revision,'automatic publication must retain the active owner revision');
      const row=(await stores.derived.query(`SELECT v.* FROM entity_claims e JOIN entity_claim_versions v
        ON v.claim_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[first.id])).rows[0];
      assert.equal(row.content,'The owner says November.');assert.equal(row.author,'owner');assert.equal(row.retired,retired);
    });
    await t.test('automatic claims without owner correction still update and deduplicate',async()=>{
      const first=await publish('automatic_milestone','The milestone is October.'),next=await publish('automatic_milestone','The milestone is November.',true);
      assert.equal(next.revision,first.revision+1);assert.deepEqual(await publish('automatic_milestone','The milestone is November.',true),next);
    });
  } finally {await stores.close();}
});
