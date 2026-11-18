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
import {startMembers,type MemberDirectoryLoader} from '../src/stores/members.js';
import {fixtureServices} from './fixture-brain.js';
import {GP1,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ID,NG1,NG1_TG,NG_GROUP_IDS,OWNER,P2,fixtureChats,fixtureDirectory,seedChats,
  seedGroups,seedMembers} from './fixture-groups.js';

// A member's task calls are checked again against the member directory as of each call (step 3), in both fixture
// families: the GP member in GP1 (old-shaped ids) and the NG member in NG1 (digest ids).
test('a member paused or switched off mid-turn writes no task; a read-only member lists and reads but changes nothing',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-tasks-')),key='member-tasks:'+Date.now();
  const served=[...GP_GROUP_IDS,...NG_GROUP_IDS],policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served};
  const owner:Reader={admin:true,scope:null};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0,loader:MemberDirectoryLoader|null=null;
  const capture=async(chat:string,from:string,text:string)=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(chat),type:'supergroup',is_forum:false},from:{id:Number(from),first_name:'Member'},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,chat:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:chat,space:chat,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  try {
    await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control);await seedGroups(stores.control);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO NOTHING",[NG1,P2]);
    loader=await startMembers(stores.control,()=>policy);
    await s.guards.reconcile();await s.guards.setMode('on');
    for(const [raw,chat,person,id] of [[GP1,GP1,MEMBER_GP,MEMBER_GP_ID],[NG1_TG,NG1,MEMBER_NG,MEMBER_NG_ID]] as const) {
      const turn=async(text:string)=>actor((await capture(raw,person,text)).id,chat);
      const change=(name:string,changes:Record<string,unknown>)=>s.members.change(owner,id,{operation_id:key+':'+name+':'+person,changes});
      const unchanged=async(task:{id:string;revision:number})=>{
        const now=await s.tasks.get(owner,task.id);assert.deepEqual([now.state,now.revision,now.comments.length,now.reminders.length],['open',task.revision,0,0]);
      };
      // Active, tasks read and write: the turn adds a task to its group's list, by the member's account.
      const hall=await s.tasks.chatCreate(await turn('Add a task to book the hall'),{title:'Book the hall'});
      assert.equal(hall.group_id,chat);assert.deepEqual(hall.created_by,{kind:'member',name:'Member'});

      // Paused by the owner while a turn is in flight: its next task call is refused and writes nothing.
      const paused=await turn('Mark the hall done');
      await change('pause',{state:'paused'});
      await assert.rejects(s.tasks.chatUpdate(paused,hall.id,{expected_revision:hall.revision,state:'done'}),{status:403,code:'member_access_changed'});
      await assert.rejects(s.tasks.chatCreate(paused,{title:'Hire the band'}),{status:403,code:'member_access_changed'});
      await assert.rejects(s.tasks.chatList(paused),{status:403,code:'member_access_changed'});
      await unchanged(hall);
      await change('resume',{state:'active'});

      // Switched off in this group mid-turn, or talk switched off: the same.
      const off=await turn('Comment on the hall');
      await change('off',{groups:{[chat]:false}});
      await assert.rejects(s.tasks.chatComment(off,hall.id,{text:'Booked'}),{status:403,code:'member_access_changed'});
      await change('on',{groups:{[chat]:true}});
      const silent=await turn('Comment on the hall again');
      await change('talk-off',{talk:false});
      await assert.rejects(s.tasks.chatComment(silent,hall.id,{text:'Booked'}),{status:403,code:'member_access_changed'});
      await change('talk-on',{talk:true});
      await unchanged(hall);

      // Tasks read only: the turn lists and reads; it adds, changes, comments on and sets reminders on nothing.
      await change('read',{tasks:'read'});
      const reader=await turn('What is left?');
      assert.deepEqual((await s.tasks.chatList(reader)).tasks.map((task:any)=>task.id),[hall.id]);
      assert.equal((await s.tasks.chatGet(reader,hall.id)).title,'Book the hall');
      await assert.rejects(s.tasks.chatCreate(reader,{title:'Hire the band'}),{status:403,code:'task_read_only'});
      await assert.rejects(s.tasks.chatUpdate(reader,hall.id,{expected_revision:hall.revision,state:'done'}),{status:403,code:'task_read_only'});
      await assert.rejects(s.tasks.chatUpdate(reader,hall.id,{expected_revision:hall.revision,reminders:[new Date(Date.now()+3600000).toISOString()]}),
        {status:403,code:'task_read_only'});
      await assert.rejects(s.tasks.chatComment(reader,hall.id,{text:'Booked'}),{status:403,code:'task_read_only'});
      await unchanged(hall);

      // Read and write again: the same turn writes at once, with no reload of its own.
      await change('write',{tasks:'write'});
      assert.equal((await s.tasks.chatUpdate(reader,hall.id,{expected_revision:hall.revision,state:'done'})).state,'done');
    }
  } finally {loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});}
});
