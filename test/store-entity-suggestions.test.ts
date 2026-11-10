import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {EntityRepository,nameKey} from '../src/stores/entities.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerSupervisionRepository} from '../src/stores/owner-supervision.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('a name compares without case, a leading @ or a trailing "(…)"',()=>{
  assert.equal(nameKey('Atlas (اطلس)'),'atlas');
  assert.equal(nameKey('@Atlas'),'atlas');
  assert.equal(nameKey('Atlas project'),'atlas project');
});

test('learning joins a waiting card only by a listed card of the same kind, and never re-suggests a known project',async()=>{
  const source={id:digest('waiting-source'),kind:'event',store:'archive',revision:'1',input_hash:digest('waiting-input')} as any;
  const card=digest('waiting-project-card'),personCard=digest('waiting-person-card'),seen:{name:string;sameAs:string|undefined}[]=[];
  const entities=Object.create(EntityRepository.prototype) as EntityRepository;
  (entities as any).suggest=async(_kind:string,name:string,_source:unknown,_reason:string,_candidate?:string,sameAs?:string)=>{seen.push({name,sameAs});return {name};};
  const context:any={source,evidence:[{reference:source,text:'synthetic evidence',space:'synthetic'}],
    entities:{speaker:null,project:{id:digest('known-project'),kind:'project',name:'Beacon'},mentioned_projects:[],mentioned_people:[],
      waiting:[{id:card,kind:'project',name:'Atlas',also_called:[]},{id:personCard,kind:'person',name:'Jordan',also_called:[]}]}};
  const project=(name:string,same_as?:unknown)=>({kind:'project',name,reason:'synthetic',evidence_ids:[source.id],...(same_as===undefined?{}:{same_as})});
  const result=await entities.publishDiscoveries(context,{entity_suggestions:[project('Atlas project',card),project('Atlas app',personCard),
    project('Atlas web',digest('unlisted-card')),project('Atlas mobile','Atlas'),project('Beacon (بیکن)')],entity_claims:[]},'waiting:same-as');
  assert.deepEqual(seen,[{name:'Atlas project',sameAs:card},{name:'Atlas app',sameAs:undefined},{name:'Atlas web',sameAs:undefined},{name:'Atlas mobile',sameAs:undefined}],
    'only a listed card of the same kind is joined; anything else stays its own card');
  assert.deepEqual(result.rejected,[{section:'entity_suggestions',code:'entity_already_known'}],'a known project under another spelling is not suggested');
});

test('repeat names for one project wait on one card, fold and split by hand, and one answer remembers every name',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
    const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
    const check=new pg.Pool(config);try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
    const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
    await initializeStoreDatabases(config,passwords);
    const stores=connectStores(config,passwords),stamp=String(Date.now()),group='-'+stamp,other='-'+String(Number(stamp)+1),owner:Reader={admin:true,scope:null};
    const services=storageServices(stores,{dataDir:'/tmp',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group,other]}),
      runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('suggestions never call Honcho');})});
    const {entities,guards,access}=services,view=new OwnerSupervisionRepository({...services,knowledge:{proposal:async()=>{throw Error('not used');}}});
    let index=0;
    const capture=async(text:string,scope=group)=>{
      index++;const event:Envelope={version:1,key:`suggestions:${stamp}:${index}`,origin:'live',kind:'telegram_update',bot_id:'fixture',scope,source_id:String(index),revision:'1',occurred_at:null,text,
        payload:{update_id:Number(stamp.slice(-8))+index,message:{message_id:index,date:1,chat:{id:Number(scope),type:'supergroup',title:'Synthetic group'},from:{id:500+index,first_name:'Sam'},text}}};
      return (await services.capture.capture(event)).source.reference;
    };
    const row=async(id:string)=>(await stores.control.query('SELECT * FROM memory_entity_suggestions WHERE id=$1',[id])).rows[0];
    const waitingCards=async()=>{
      const items=[];let after:string|undefined;
      do{const page=await view.decisions(owner,{kind:'entity',limit:100,...(after?{after}:{})});items.push(...page.items);after=page.next_cursor??undefined;}while(after);
      return items;
    };
    try {
      // The fixture database is shared across runs: only this run's names count.
      const name=(label:string)=>`${label} ${stamp}`;
      const atlas=await entities.suggest('project',name('Atlas'),await capture('first'),'A project the group plans.');
      const spelled=await entities.suggest('project',`${name('Atlas')} (اطلس)`,await capture('second'),'The same project, spelled in Persian.');
      assert.equal(spelled.merged_into,atlas.id,'the same name apart from a trailing "(…)" joins the waiting card');
      const longer=await entities.suggest('project',name('Atlas project'),await capture('third'),'Named with the word project.',undefined,atlas.id);
      assert.equal(longer.merged_into,atlas.id,'learning joins a card it names');
      assert.equal((await row(atlas.id)).revision,3,'every joined name changes the card, so a stale answer cannot skip it');
      const person=await entities.suggest('person',name('Atlas'),await capture('fourth'),'A person with the same name.');
      assert.equal(person.merged_into,null,'a person never joins a project card');
      const binding=await entities.suggest('binding',`${name('Atlas')} (@atlas)`,await capture('fifth'),'An account.');
      assert.equal(binding.merged_into,null,'an account link never joins a card');
      const again=await entities.suggest('project',name('atlas'),await capture('sixth'),'Repeated.');
      assert.equal(again.id,atlas.id,'the same name again is the same card');

      const cards=await waitingCards(),card=cards.find(item=>item.id===atlas.id) as any;
      assert.ok(card,'the card waits');assert.ok(!cards.some(item=>item.id===spelled.id||item.id===longer.id),'a folded name is not its own item');
      assert.equal(card.subject_kind,'project');assert.deepEqual(card.also_called,[`${name('Atlas')} (اطلس)`,name('Atlas project')]);
      const detail=(await view.decision(owner,'entity',atlas.id)).detail as any;
      assert.deepEqual(detail.also_called.map((item:any)=>item.id),[spelled.id,longer.id]);
      assert.equal(((await entities.suggestions(owner)).suggestions.find((item:any)=>item.id===atlas.id) as any).also_called.length,2);

      const binding0=await guards.state(),here=access.principal(group),elsewhere=access.principal(other);
      const seen=(await entities.waiting(here,binding0,100)).waiting.find(item=>item.id===atlas.id);
      assert.deepEqual(seen,{id:atlas.id,kind:'project',name:name('Atlas'),also_called:[`${name('Atlas')} (اطلس)`,name('Atlas project')]});
      assert.ok(!(await entities.waiting(elsewhere,binding0,100)).waiting.some(item=>item.id===atlas.id),'another chat never sees this chat’s waiting names');

      // The owner takes a name out, then folds a separate card in by hand.
      const split=await entities.split(owner,longer.id,{expected_revision:longer.revision,operation_id:`${stamp}:split`});
      assert.equal(split.merged_into,null);
      assert.deepEqual(await entities.split(owner,longer.id,{expected_revision:longer.revision,operation_id:`${stamp}:split`}),split,'a repeated request is answered the same');
      await assert.rejects(entities.split(owner,atlas.id,{expected_revision:(await row(atlas.id)).revision,operation_id:`${stamp}:split-card`}),{code:'entity_suggestion_split_invalid'});
      const separate=await row(longer.id);
      const folded=await entities.fold(owner,longer.id,{target_id:atlas.id,expected_revision:separate.revision,operation_id:`${stamp}:fold`});
      assert.equal(folded.merged_into,atlas.id);
      assert.deepEqual(await entities.fold(owner,longer.id,{target_id:atlas.id,expected_revision:separate.revision,operation_id:`${stamp}:fold`}),
        {...folded,revision:(await row(longer.id)).revision},'a repeated request is answered without a conflict');
      await assert.rejects(entities.fold(owner,person.id,{target_id:atlas.id,expected_revision:person.revision,operation_id:`${stamp}:fold-person`}),{code:'entity_suggestion_fold_invalid'});
      await assert.rejects(entities.fold(owner,atlas.id,{target_id:person.id,expected_revision:0,operation_id:`${stamp}:fold-stale`}),{code:'entity_suggestion_conflict'});
      await assert.rejects(entities.decide(owner,spelled.id,{decision:'confirm',expected_revision:(await row(spelled.id)).revision,operation_id:`${stamp}:decide-folded`}),
        {code:'entity_suggestion_folded'});
      await assert.rejects(entities.decide(owner,atlas.id,{decision:'confirm',expected_revision:atlas.revision,operation_id:`${stamp}:decide-stale`}),
        {code:'entity_suggestion_conflict'},'an answer given before a name joined does not cover it');

      // A second card folded in brings its own folded names along.
      const beacon=await entities.suggest('project',name('Beacon'),await capture('seventh'),'Another name.');
      const beaconSpelled=await entities.suggest('project',`${name('Beacon')} (بیکن)`,await capture('eighth'),'Spelled.');
      assert.equal(beaconSpelled.merged_into,beacon.id);
      await entities.fold(owner,beacon.id,{target_id:atlas.id,expected_revision:(await row(beacon.id)).revision,operation_id:`${stamp}:fold-card`});
      assert.equal((await row(beaconSpelled.id)).merged_into,atlas.id,'a card is never folded twice over');

      const answer=await entities.decide(owner,atlas.id,{decision:'confirm',expected_revision:(await row(atlas.id)).revision,operation_id:`${stamp}:confirm`}) as any;
      assert.equal(answer.status,'confirmed');assert.equal(answer.folded.length,4);
      for(const id of [spelled.id,longer.id,beacon.id,beaconSpelled.id])assert.equal((await row(id)).status,'confirmed');
      const entity=answer.entity;assert.equal(entity.kind,'project');
      const mentions=(await stores.control.query("SELECT mention_key FROM memory_entity_bindings WHERE entity_id=$1 AND binding_kind='mention' ORDER BY mention_key",[entity.id])).rows.map(item=>item.mention_key);
      for(const key of [name('atlas'),`${name('atlas')} (اطلس)`,name('atlas project'),name('beacon'),`${name('beacon')} (بیکن)`])assert.ok(mentions.includes(key),key);
      assert.ok(!(await waitingCards()).some(item=>item.id===atlas.id));
      assert.equal((await entities.suggest('project',`${name('Atlas')} (اطلس)`,await capture('ninth'),'Again.')).status,'confirmed','an answered name never asks again');

      // Learning later finds the confirmed project again, under any of its names.
      const project=(await stores.control.query('SELECT * FROM projects WHERE id=$1',[entity.project_id])).rows[0];
      const reused=await entities.ensureProject(project);
      assert.equal(reused.id,entity.id,'later learning reuses the confirmed project instead of failing on a second entity');
      const aliases=await entities.projectAliases([project.id]);
      assert.ok(aliases.get(project.id)?.includes(`${name('beacon')} (بیکن)`));
      const asked=await capture(`Any news on ${name('Beacon')}?`);await guards.prepare(asked,'fixture',services.detect);
      const prepared=await services.contexts.prepare(asked,await guards.state());
      assert.ok(prepared.projects.some(item=>item.id===project.id),'a message that uses only another confirmed name finds the project');
      assert.ok(Array.isArray(prepared.entities.waiting),'learning sees the cards still waiting');
      assert.ok(prepared.entities.waiting!.some(item=>item.id===person.id),'including other waiting cards from this chat');

      // "Not the same" locks the card before its folded name, as an answer does, so the two never deadlock.
      // Use a pair whose folded name sorts first, where locking both in ID order would take the name first.
      let top,alias,pair=0;
      do{top=await entities.suggest('project',name('Race '+pair),await capture('race card '+pair),'Raced.');
        alias=await entities.suggest('project',`${name('Race '+pair)} (alt)`,await capture('race name '+pair),'Raced.');pair++;}while(alias.id>top.id);
      assert.equal(alias.merged_into,top.id);
      const holder=await stores.control.connect();
      try {
        await holder.query('BEGIN');await holder.query('SELECT 1 FROM memory_entity_suggestions WHERE id=$1 FOR UPDATE',[top.id]);
        const splitting=entities.split(owner,alias.id,{expected_revision:alias.revision,operation_id:`${stamp}:race-split`});
        splitting.catch(()=>{});
        for(let tries=0;!(await stores.control.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()")).rows[0].count;tries++) {
          assert.ok(tries<250,'the split waits for the card');await new Promise(resolve=>setTimeout(resolve,20));
        }
        await holder.query('SELECT 1 FROM memory_entity_suggestions WHERE id=$1 FOR UPDATE NOWAIT',[alias.id]);
        await holder.query('COMMIT');
        assert.equal((await splitting).merged_into,null,'the split goes through once the card is free');
      } catch(error){await holder.query('ROLLBACK');throw error;} finally {holder.release();}
    } finally {await stores.close();}
  });
