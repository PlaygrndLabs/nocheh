import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {readSet} from '../src/spaces.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ownerPeopleNames} from '../src/stores/entities.js';
import {memoryProblemSchema,memoryProblems,type NoteSourceRepository} from '../src/stores/note-sources.js';
import {recallNames} from '../src/stores/recall-places.js';
import {SourceTagRepository} from '../src/stores/source-tags.js';
import {fixtureServices} from './fixture-brain.js';
import {chatRowForTest} from './fixture-seeded-chats.js';

test('source tags: readable() is canRead, members read only their groups in UTC by Telegram\'s names, the owner reads the Tasks zone and People names (ADR-0261)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-source-tags-'));
  // Synthetic groups GP1 (a forum, A) and GP2 (B), served, and one Nocheh does not serve (U). The owner is account 123.
  const run=Date.now(),A='-100'+run,B='-100'+(run+1),U='-100'+(run+2),T77=A+'/topic/77',T78=A+'/topic/78';
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A,B],topic_memory:'group'};
  let detects=0;
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async(operation:string)=>{if(operation==='guard.detect')detects++;return {literals:[]};},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const zone=(await stores.control.query('SELECT settings FROM owner_task_settings WHERE singleton')).rows[0]?.settings??{};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0;
    const capture=async(scope:string,payload:Record<string,any>,extra:Partial<Envelope>={}):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message??payload.edited_message??payload.message_reaction;
      const value={version:1,key:`source-tags:${run}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(inner?.message_id??update),
        revision:String(update),occurred_at:typeof inner?.date==='number'?String(inner.date):null,text:inner?.text??null,payload:{update_id:update,...payload},...extra} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    // 2025-11-03 14:12 UTC, 15:12 in Europe/Berlin.
    const T=1762179120,chat=(id:string,title:string)=>({id:Number(id),type:'supergroup',title,is_forum:true});
    const sam={id:123,is_bot:false,first_name:'Sam',username:'sam_owner'},bob={id:456,is_bot:false,first_name:'Bob',username:'bob_gp'};
    const ana={id:789,is_bot:false,first_name:'Ana'},nameless={id:999,is_bot:false};
    let message=0;
    const say=(scope:string,where:Record<string,unknown>,from:Record<string,unknown>,text:string,more:Record<string,unknown>={})=>
      capture(scope,{message:{message_id:++message,date:T,chat:where,from,text,...more}});
    const ownerPrivate=await say('123',{id:123,type:'private',first_name:'Sam'},sam,'Owner private');
    const bobA=await say(A,chat(A,'GP1'),bob,'Bob in general');
    const bobMessage=message;
    const samA=await say(A,chat(A,'GP1'),sam,'Owner in general');
    const opening=await say(A,chat(A,'GP1'),bob,'',{message_thread_id:77,is_topic_message:true,forum_topic_created:{name:'Trips',icon_color:1}});
    const t77=await say(A,chat(A,'GP1'),bob,'Bob in trips',{message_thread_id:77,is_topic_message:true});
    const t78=await say(A,chat(A,'GP1'),ana,'Ana in a topic the owner named',{message_thread_id:78,is_topic_message:true});
    const anon=await say(A,chat(A,'GP1'),nameless,'No name');
    const bobB=await say(B,chat(B,'GP2'),bob,'Bob in GP2');
    const unserved=await say(U,chat(U,'GU'),bob,'Bob where Nocheh is not served');
    const retired=await say(A,chat(A,'GP1'),bob,'Bob retired');
    const edited=await capture(A,{edited_message:{message_id:bobMessage,date:T,edit_date:T+60,chat:chat(A,'GP1'),from:bob,text:'Bob in general, edited'}});
    const delivered=await capture(A,{message:{message_id:++message,date:T,chat:chat(A,'GP1'),from:{id:123456,is_bot:true,first_name:'Nocheh'},text:'Noted'},
      send_class:'reply',answers:bobA.id},{kind:'telegram_delivered_message',occurred_at:null});
    const react=(update:number,before:unknown[],after:unknown[])=>capture(A,{message_reaction:{chat:chat(A,'GP1'),message_id:bobMessage,date:T+update,user:bob,old_reaction:before,new_reaction:after}});
    const added=await react(1,[],[{type:'emoji',emoji:'👍'}]),removed=await react(2,[{type:'emoji',emoji:'👍'}],[]);
    await s.retirements.set({admin:true,scope:null},retired.id,{retired:true,expected_revision:0,operation_id:`source-tags:${run}:retire`});
    // The owner named topic 78 in Nocheh; Telegram showed no name for it. Telegram named topic 77 "Trips".
    await chatRowForTest(stores.control,T78,{title:'Secret plan',title_source:'owner'});
    // The owner renamed Bob "Brother" in People; Ana and the nameless sender keep the names Nocheh gave them.
    const admin:Reader={admin:true,scope:null};
    const people=await Promise.all([bobA,t78,anon].map(source=>s.entities.ensureParticipant(source)));
    assert.deepEqual([...(await ownerPeopleNames(stores,[bobA.id,t78.id,anon.id])).keys()],[],'names Nocheh gave by itself are not the owner\'s');
    assert.equal(people[2]!.name,'telegram actor 999');
    await s.entities.rename(admin,people[0]!.id,{name:'Brother',expected_revision:people[0]!.revision,operation_id:`source-tags:${run}:rename`});
    await stores.control.query('UPDATE memory_entities SET revision=revision+1 WHERE id=$1',[people[2]!.id]);
    assert.deepEqual(Object.fromEntries(await ownerPeopleNames(stores,[bobA.id,t77.id,t78.id,anon.id])),{[bobA.id]:'Brother',[t77.id]:'Brother'},
      'a rename is the owner\'s; an automatic "telegram actor <id>" name never is, whatever its revision');
    await stores.control.query(`UPDATE owner_task_settings SET settings=jsonb_set(settings,'{time_zone}','"Europe/Berlin"') WHERE singleton`);

    const binding=await s.guards.state();
    const reader=(scope:string|null,space:string,extra:Partial<Reader>={}):Reader=>({admin:false,scope,space,generation:binding.generation,guard_epoch:binding.epoch,...extra});
    const owner=reader(null,'123',{turnEvent:ownerPrivate.id}),general=reader(A,A,{turnEvent:bobA.id}),topic=reader(A,T77,{turnEvent:t77.id}),other=reader(B,B,{turnEvent:bobB.id});
    const answer=reader('456','456',{answer:'a'.repeat(32),reads:readSet({home:A,whole:[A]}),turnEvent:bobA.id}),closed=reader('456','456',{answer:'b'.repeat(32)});
    const all=[ownerPrivate,bobA,samA,opening,t77,t78,anon,bobB,unserved,retired,edited,delivered,added,removed];

    // readable() is canRead: every reader, both topic settings, both historical values (property test).
    const sameAsCanRead=async()=>{
      for(const principal of [admin,owner,general,topic,other,answer,closed])for(const historical of [false,true]) {
        const batch=await s.access.readable(principal,all,binding,{historical});
        for(const source of all) {
          const one=await s.access.canRead(principal,source,binding,{historical}).catch(()=>false);
          assert.equal(batch.get(source.id),one,`${JSON.stringify({scope:principal.scope,space:principal.space,answer:principal.answer,historical})} ${all.indexOf(source)}`);
        }
      }
    };
    await sameAsCanRead();policy.topic_memory='topic';await sameAsCanRead();policy.topic_memory='group';
    // The checks are meaningful: what each reader may read differs.
    const readableBy=async(principal:Reader,historical=false)=>(await s.access.readable(principal,all,binding,{historical}));
    const groupView=await readableBy(general);
    assert.deepEqual([ownerPrivate,bobA,t77,bobB,unserved,retired,added,removed].map(source=>groupView.get(source.id)),[false,true,true,false,false,false,false,true]);
    assert.equal((await readableBy(general,true)).get(added.id),true,'a replaced reaction is still evidence already learned');
    const ownerView=await readableBy(owner);
    assert.deepEqual([ownerPrivate,bobB,unserved,retired].map(source=>ownerView.get(source.id)),[true,true,false,false]);
    // A reference the archive does not hold, or one naming another revision, is not readable.
    const conflict={...bobA,revision:'999'},missing={...bobA,id:digest('source-tags:missing:'+run)};
    assert.deepEqual(Object.fromEntries(await s.access.readable(owner,[conflict,missing],binding)),{[bobA.id]:false,[missing.id]:false});
    assert.equal((await s.access.readable(owner,[bobA,conflict],binding)).get(bobA.id),false,'a conflicting copy of the same id is refused');

    // The owner: "the owner" for the owner's own words, the Tasks zone, People names and the owner-typed topic name.
    const tags=async(principal:Reader,sources:SourceReference[],repository=s.tags)=>{
      const found=await repository.tags(principal,binding,sources);
      return sources.map(source=>{const tag=found.get(source.id);return tag?`${tag.by}: ${tag.tag}`:null;});
    };
    const before=detects;
    const ownerTags=await tags(owner,[ownerPrivate,bobA,samA,t77,t78,anon,bobB,unserved,edited]);
    assert.equal(detects-before,1,'every tag of a request goes through one secret check');
    assert.deepEqual(ownerTags,[
      'owner: the owner · this chat · 2025-11-03 15:12 Europe/Berlin',
      'person: “Bob” (@bob_gp), saved as “Brother” · group “GP1” · 2025-11-03 15:12 Europe/Berlin',
      'owner: the owner · group “GP1” · 2025-11-03 15:12 Europe/Berlin',
      'person: “Bob” (@bob_gp), saved as “Brother” · group “GP1” › topic “Trips” · 2025-11-03 15:12 Europe/Berlin',
      'person: “Ana” · group “GP1” › topic “Secret plan” · 2025-11-03 15:12 Europe/Berlin',
      'person: a person · group “GP1” · 2025-11-03 15:12 Europe/Berlin',
      'person: “Bob” (@bob_gp), saved as “Brother” · group “GP2” · 2025-11-03 15:12 Europe/Berlin',
      null,
      'person: “Bob” (@bob_gp), saved as “Brother” · group “GP1” · 2025-11-03 15:12 Europe/Berlin, edited']);
    const again=detects;await tags(owner,[ownerPrivate,bobA]);assert.equal(detects,again,'a tag already checked this epoch costs nothing');
    const nocheh=(await s.tags.tags(owner,binding,[delivered])).get(delivered.id)!;
    assert.equal(nocheh.by,'nocheh');assert.match(nocheh.tag,/^Nocheh, Nocheh's reply · group “GP1” · \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Berlin$/,'timed when it was saved');
    assert.equal((await s.tags.tags(owner,binding,[bobA])).get(bobA.id)!.at,'2025-11-03T14:12:00.000Z');

    // A group member: only their own group, UTC, Telegram's names; the owner by their Telegram name with by=owner.
    const topicTags=await tags(topic,[t77,bobA,samA,t78,anon,ownerPrivate,bobB,unserved,retired,added]);
    assert.deepEqual(topicTags,[
      'person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC',
      'person: “Bob” (@bob_gp) · group “GP1” · 2025-11-03 14:12 UTC',
      'owner: “Sam” (@sam_owner) · group “GP1” · 2025-11-03 14:12 UTC',
      'person: “Ana” · group “GP1” › a topic · 2025-11-03 14:12 UTC',
      'person: a person · group “GP1” · 2025-11-03 14:12 UTC',
      null,null,null,null,null]);
    assert.deepEqual(await tags(general,[t77,bobA]),['person: “Bob” (@bob_gp) · group “GP1” › topic “Trips” · 2025-11-03 14:12 UTC','person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC']);
    assert.deepEqual(await tags(other,[bobB,bobA,t77]),['person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC',null,null],'another group reads nothing of GP1');
    const memberText=JSON.stringify([topicTags,await tags(general,all),await tags(other,all)]);
    for(const never of ['Brother','Secret plan','Europe/Berlin','the owner','private chat',A.slice(1),B.slice(1),'123','456','789','999'])
      assert.ok(!memberText.includes(never),`a member's tags never hold ${never}`);
    // An unshared sibling topic is unreadable when topics keep their own memory.
    policy.topic_memory='topic';
    try{assert.deepEqual(await tags(reader(A,T77,{turnEvent:t77.id}),[t77,bobA,t78]),['person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC',null,null]);}
    finally{policy.topic_memory='group';}
    // A private answer reads only its frozen groups, as members do (no detector here: the stores' answer pass is not this test's).
    const unchecked=new SourceTagRepository(stores,s.access,s.noteSources,null,s.detect,()=>policy);
    assert.deepEqual(await tags(answer,[bobA,bobB,ownerPrivate],unchecked),['person: “Bob” (@bob_gp) · group “GP1” · 2025-11-03 14:12 UTC',null,null]);

    // A tag that cannot be built reads "source not available right now" and is counted; an unreadable source stays null.
    const today=async()=>(await memoryProblems(stores.control)).find(row=>row.kind==='source_tags')??{done:0,failed:0};
    const failing=new SourceTagRepository(stores,s.access,{classesFor:async()=>{throw Error('down');}} as unknown as NoteSourceRepository,null,s.detect,()=>policy);
    const was=await today(),lost=await failing.tags(topic,binding,[t77,ownerPrivate]);
    assert.deepEqual(lost.get(t77.id),{source:'nocheh:event:'+t77.id,tag:'source not available right now',by:'unknown',at:null});
    assert.equal(lost.get(ownerPrivate.id),null);
    assert.equal((await today()).failed,was.failed+1,'counted as source_tags');
    await unchecked.tags(topic,binding,[t77]);assert.ok((await today()).done>was.done,'a tag built after a failure counts as working again');
    // A binding that moved on is the caller's to retry, never a failed tag.
    const counted=await today();
    await stores.control.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton');
    await assert.rejects(unchecked.tags(admin,binding,[t77]),{code:'guard_context_changed'});
    assert.equal((await today()).failed,counted.failed);

    // Members' place names: only names Telegram showed (recallNames shownOnly).
    assert.equal((await recallNames(stores,[A,T77,T78])).get(T78),'Secret plan');
    assert.deepEqual(Object.fromEntries(await recallNames(stores,[A,T77,T78],{shownOnly:true})),{[A]:'GP1',[T77]:'Trips'});
  } finally {
    await stores.control.query('UPDATE owner_task_settings SET settings=$1 WHERE singleton',[JSON.stringify(zone)]).catch(()=>{});
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});

test('startup widens the memory problem kinds so source tags are counted (add if missing)',{skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  // Startup runs the control schema as the store's owner role (initializeStoreDatabases); so does this check, in a
  // transaction it rolls back.
  const db=new pg.Client({...config,database:'nocheh_control'});await db.connect();
  try {
    await db.query('BEGIN');await db.query('SET LOCAL ROLE nocheh_control_owner');
    // A control store from before this change: only notes and memory_read (rows other tests counted are rolled back too).
    await db.query("DELETE FROM memory_problem_days WHERE kind NOT IN ('notes','memory_read')");
    await db.query('ALTER TABLE memory_problem_days DROP CONSTRAINT IF EXISTS memory_problem_days_kind_check');
    await db.query("ALTER TABLE memory_problem_days ADD CONSTRAINT memory_problem_days_kind_check CHECK(kind IN ('notes','memory_read'))");
    await db.query('SAVEPOINT old');
    await assert.rejects(db.query("INSERT INTO memory_problem_days(day,kind,failed) VALUES('2000-01-01','source_tags',1)"),{code:'23514'});
    await db.query('ROLLBACK TO SAVEPOINT old');
    await db.query(memoryProblemSchema);
    await db.query("INSERT INTO memory_problem_days(day,kind,failed) VALUES('2000-01-01','source_tags',1)");
    assert.equal((await db.query("SELECT failed FROM memory_problem_days WHERE day='2000-01-01' AND kind='source_tags'")).rows[0].failed,1);
  } finally {await db.query('ROLLBACK').catch(()=>{});await db.end();}
});
