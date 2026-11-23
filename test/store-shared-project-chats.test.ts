import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {installMembersForTest} from '../src/members.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {PrivateAnswerRepository} from '../src/stores/private-answers.js';
import {sharedProjectGroups} from '../src/stores/project-groups.js';
import {ProjectRepository} from '../src/stores/projects.js';
import {readSet,readSetGroups,readSetIds} from '../src/spaces.js';
import {fixtureServices} from './fixture-agent.js';
import {BOB,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_CHAT,MEMBER_GP_ID,NG_GROUP_IDS,OWNER,P1,UNSERVED,fixtureChats,fixtureDirectory,
  seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// "Share group chats" (ADR-0267): while a project shares its group chats, a turn in any of its served groups reads every
// other served group of it, bound on the server for each request; groups in no project or another project, unserved
// groups and every private chat stay out. Off, each group reads only itself and Answer privately comes back. A member's
// private chat reads the other groups of a sharing project they joined a group of.
test('a project that shares its group chats lets each of its groups read the others, and nothing else',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),served=[...GP_GROUP_IDS,...NG_GROUP_IDS],db=stores.control;
  await seedChats(db,fixtureChats(served));await seedMembers(db);await seedGroups(db,true);
  await db.query("UPDATE projects SET share_chats=true WHERE id=$1",[P1]);
  await db.query("UPDATE chat_memberships SET checked_at=now()-interval '1 day' WHERE checked_at IS NULL");
  const root=await mkdtemp(join(tmpdir(),'nocheh-shared-chats-')),key='shared-chats:'+Date.now();
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served,topic_memory:'group' as const};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0;
  const capture=async(raw:string,from:string,text:string,type:'private'|'supergroup')=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:raw,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(raw),type,is_forum:false},from:{id:Number(from),first_name:'Mira'},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const binding=await s.guards.state(),stamp={generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const inGP1=await capture(GP1,OWNER,'Synthetic note in the first group','supergroup'),inGP2=await capture(GP2,OWNER,'Synthetic note in the second group','supergroup');
    const inGP3=await capture(GP3,OWNER,'Synthetic note in the third group','supergroup'),inGP4=await capture(GP4,OWNER,'Synthetic note in a group in no project','supergroup');
    const inUnserved=await capture(UNSERVED,OWNER,'Synthetic note in a group Nocheh does not serve','supergroup');
    const inOwner=await capture(OWNER,OWNER,'Synthetic private owner note','private'),inBob=await capture(BOB,BOB,'Synthetic stranger note','private');
    const inMember=await capture(MEMBER_GP,MEMBER_GP,'Synthetic private member note','private');
    const all=[inGP1,inGP2,inGP3,inGP4,inUnserved,inOwner,inBob,inMember];
    const reads=async(principal:Reader)=>{
      const each=await Promise.all(all.map(source=>s.access.canRead(principal,source,binding))),many=await s.access.readable(principal,all,binding);
      assert.deepEqual(all.map(source=>many.get(source.id)),each,'readable answers as canRead does');
      return each;
    };
    const group=(scope:string,space=scope):Reader=>({admin:false,scope,space,turnEvent:inGP1.id,...stamp});

    // P1 (GP1, GP2, GP3 and the unserved group) shares: its served groups.
    assert.deepEqual(await sharedProjectGroups(db,GP1,served),{project:P1,groups:[GP1,GP2,GP3]});
    for(const outside of [GP4,UNSERVED,OWNER,BOB,GP1_TOPIC])assert.equal(await sharedProjectGroups(db,outside,served),null,outside);

    // A GP1 turn, bound: GP1, GP2 and GP3 whole; never GP4, the unserved group or a private chat.
    const gp1=await s.access.bindReads(group(GP1));
    assert.deepEqual([readSetGroups(gp1.reads!),gp1.reads!.project,gp1.reads!.home],[[GP1,GP2,GP3],P1,GP1]);
    assert.deepEqual(await reads(gp1),[true,true,true,false,false,false,false,false]);
    assert.deepEqual(s.access.reads(gp1),gp1.reads);
    // Unbound, the same turn reads only GP1, as before (fail closed).
    assert.deepEqual(await reads(group(GP1)),[true,false,false,false,false,false,false,false]);
    // A topic turn of GP1 reads the same; with topics keeping their own memory, its own topic exactly and the others whole.
    const topic=await s.access.bindReads(group(GP1,GP1_TOPIC));
    assert.deepEqual([readSetGroups(topic.reads!),topic.reads!.home],[[GP1,GP2,GP3],GP1_TOPIC]);
    policy.topic_memory='topic' as never;
    const own=await s.access.bindReads(group(GP1,GP1_TOPIC));
    assert.deepEqual([own.reads!.exact,own.reads!.whole],[[GP1_TOPIC],[GP2,GP3]]);
    assert.ok(!readSetIds(own.reads!).includes(GP1),'its group\'s General chat is not its own topic');
    policy.topic_memory='group';
    // A read set a reader came with is never trusted: binding decides it again.
    const forged=await s.access.bindReads({...group(GP4),reads:readSet({home:GP4,whole:[GP4,GP1,GP2]})});
    assert.equal(forged.reads,undefined);assert.deepEqual(await reads(forged),[false,false,false,true,false,false,false,false]);
    // GP4 is in no project: it reads only itself, and none of P1's groups reads it.
    assert.deepEqual(await reads(await s.access.bindReads(group(GP4))),[false,false,false,true,false,false,false,false]);
    // The owner and the dashboard read everything they did before; a private chat gets no read set.
    assert.equal((await s.access.bindReads({admin:false,scope:null,space:OWNER,turnEvent:inOwner.id,...stamp})).reads,undefined);

    // No Answer privately in a sharing project: the group answer already reads its groups.
    const answers=new PrivateAnswerRepository(db,()=>policy);
    assert.equal(await answers.offerable(GP1),null);

    // A member who joined GP1 reads P1's other groups from their private chat too, while P1 shares.
    await db.query(`INSERT INTO member_turns(member_id,event_id,day,left_out) VALUES($1,$2,current_date,'{}'::text[]) ON CONFLICT(member_id,event_id) DO UPDATE SET left_out='{}'`,
      [MEMBER_GP_ID,inMember.id]);
    const member=await s.access.bindReads({admin:false,scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,turnEvent:inMember.id,member:MEMBER_GP_ID,...stamp});
    assert.deepEqual(readSetGroups(member.reads!),[GP1,GP2,GP3]);
    assert.deepEqual(await reads(member),[true,true,true,false,false,false,false,true]);

    // The tick list (ADR-0287): GP3 unticked reads only itself and no ticked group reads it; GP1 and GP2 still read each
    // other, the member's private chat follows, and the button comes back for both sides, as their answers miss a group.
    const projects=new ProjectRepository(db,()=>served),current=async()=>(await projects.list({admin:true,scope:null})).projects.find((row:{id:string})=>row.id===P1);
    const tick=async(own_groups:string[],label:string)=>{const p1=await current();
      return projects.save({admin:true,scope:null},{id:P1,name:p1.name,description:p1.description,state:'active',own_groups,expected_revision:p1.revision,operation_id:key+':'+label});};
    for(const bad of [[GP1_TOPIC],[OWNER],[MEMBER_GP_CHAT],['x'],[1]])
      await assert.rejects(tick(bad as string[],'bad:'+JSON.stringify(bad)),{status:400,code:'invalid_project'},JSON.stringify(bad));
    const ticked=await tick([GP3,GP3],'gp3');
    assert.deepEqual([ticked.share_chats,ticked.own_groups],[true,[GP3]],'kept once, sharing still on');
    assert.deepEqual(await sharedProjectGroups(db,GP1,served),{project:P1,groups:[GP1,GP2]});
    assert.equal(await sharedProjectGroups(db,GP3,served),null);
    const fresh=async()=>{const now=await s.guards.state();return {generation:now.generation,guard_epoch:now.epoch,revision:now.epoch};};
    const pair=await s.access.bindReads({...group(GP1),...await fresh()});
    assert.deepEqual(readSetGroups(pair.reads!),[GP1,GP2]);
    assert.deepEqual((await answers.offerable(GP1))?.groups,[GP1,GP2,GP3]);
    assert.deepEqual((await answers.offerable(GP3))?.groups,[GP1,GP2,GP3]);
    const paired=await s.access.bindReads({admin:false,scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,turnEvent:inMember.id,member:MEMBER_GP_ID,...await fresh()});
    assert.deepEqual(readSetGroups(paired.reads!),[GP1,GP2]);
    // One ticked group has no one to share with.
    await tick([GP2,GP3],'gp1-alone');
    assert.equal(await sharedProjectGroups(db,GP1,served),null);
    // A change that does not name the ticks keeps them.
    const kept=await current();
    assert.deepEqual((await projects.save({admin:true,scope:null},{id:P1,name:kept.name,description:'Renamed',state:'active',expected_revision:kept.revision,operation_id:key+':keep'})).own_groups,[GP2,GP3]);
    await tick([],'all');
    assert.deepEqual(await sharedProjectGroups(db,GP1,served),{project:P1,groups:[GP1,GP2,GP3]});

    // Turned off by the owner, as a project change: each group reads only itself again, the member only GP1, and the
    // button comes back.
    const p1=await current();
    const off=await projects.save({admin:true,scope:null},{id:P1,name:p1.name,description:p1.description,state:'active',share_chats:false,expected_revision:p1.revision,operation_id:key+':off'});
    assert.equal(off.share_chats,false);
    const after=await s.guards.state(),now={generation:after.generation,guard_epoch:after.epoch,revision:after.epoch};
    const quiet=await s.access.bindReads({...group(GP1),...now});
    assert.equal(quiet.reads,undefined);assert.deepEqual(await Promise.all([inGP1,inGP2].map(source=>s.access.canRead(quiet,source,after))),[true,false]);
    const alone=await s.access.bindReads({admin:false,scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,turnEvent:inMember.id,member:MEMBER_GP_ID,...now});
    assert.deepEqual(readSetGroups(alone.reads!),[GP1]);
    assert.deepEqual((await answers.offerable(GP1))?.groups,[GP1,GP2,GP3]);
    // An archived project shares nothing, whatever its switch says.
    await db.query("UPDATE projects SET share_chats=true,state='archived' WHERE id=$1",[P1]);
    assert.equal(await sharedProjectGroups(db,GP1,served),null);
    assert.equal((await s.access.bindReads({...group(GP1),...now})).reads,undefined);
  } finally {restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});}
});
