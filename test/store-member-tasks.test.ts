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
import {fixtureServices} from './fixture-agent.js';
import {ALI,CANARY_LABEL,GP1,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,NG1,NG1_TG,NG_GROUP_IDS,OWNER,P2,fixtureChats,
  fixtureDirectory,seedAssignee,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// A member's task calls are checked again against the member directory as of each call (step 3), in both fixture
// families: the GP member in GP1 (old-shaped ids) and the NG member in NG1 (digest ids). A task a member adds keeps their
// account (step 5: the members' app's "Mine"), and a group never reads the owner's names for people (ADR-0265 D6): an
// assignee only by their Telegram name while in that group.
test('a member paused or switched off mid-turn writes no task; a read-only member lists and reads but changes nothing; a group reads no names',
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
    const named=digest(key+':named');
    await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Owner name for them','active')",[named]);
    // Ali, bound to his Telegram account and in GP1: GP1 reads him by his Telegram name, NG1 only counts him.
    const ali=await seedAssignee(stores.control,CANARY_LABEL,ALI,'Ali T',[GP1]);
    const settings=await s.tasks.settings(owner);
    await s.tasks.saveSettings(owner,{revision:settings.revision,properties:[{id:'lead',name:'Lead',type:'person',shared:true},{id:'size',name:'Size',type:'number',shared:true}]});
    for(const [raw,chat,person,id,account] of [[GP1,GP1,MEMBER_GP,MEMBER_GP_ID,MEMBER_GP_ACCOUNT],[NG1_TG,NG1,MEMBER_NG,MEMBER_NG_ID,MEMBER_NG_ACCOUNT]] as const) {
      const turn=async(text:string)=>actor((await capture(raw,person,text)).id,chat);
      const change=(name:string,changes:Record<string,unknown>)=>s.members.change(owner,id,{operation_id:key+':'+name+':'+person,changes});
      const unchanged=async(task:{id:string;revision:number})=>{
        const now=await s.tasks.get(owner,task.id);assert.deepEqual([now.state,now.revision,now.comments.length,now.reminders.length],['open',task.revision,0,0]);
      };
      // Active, tasks read and write: the turn adds a task to its group's list, by the member's account.
      const hall=await s.tasks.chatCreate(await turn('Add a task to book the hall'),{title:'Book the hall'});
      assert.equal(hall.group_id,chat);assert.deepEqual(hall.created_by,{kind:'member',name:'Member'});
      assert.equal((await stores.control.query('SELECT created_by_account FROM owner_tasks WHERE id=$1',[hall.id])).rows[0].created_by_account,account);

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
      const closed=await s.tasks.chatUpdate(reader,hall.id,{expected_revision:hall.revision,state:'done'});
      assert.equal(closed.state,'done');

      // The owner names people on it: the group reads neither them, nor the owner's names for them, nor the person column,
      // only the other shared column; an assignee in this group by the People name the owner set (ADR-0274), every other
      // counted.
      await s.tasks.update(owner,hall.id,{operation_id:key+':names:'+person,expected_revision:closed.revision,people:[named],assignees:[named,ali],properties:{Lead:[named],Size:4}});
      const assignees=chat===GP1?[[{name:CANARY_LABEL}],1]:[[],2];
      const listed=(await s.tasks.chatList(await turn('Who does the hall?'),{state:'all'})).tasks.find((task:any)=>task.id===hall.id);
      const seen=await s.tasks.chatGet(await turn('Who does the hall?'),hall.id);
      for(const value of [listed,seen]){
        assert.deepEqual([value.people,value.properties,value.created_by_account],[undefined,{size:4},undefined]);
        assert.deepEqual([value.assignees,value.assignees_other],assignees,chat);
        for(const word of ['Owner name for them',named,ali,...chat===GP1?[]:['CANARY-LABEL']])assert.ok(!JSON.stringify(value).includes(word),word);
      }
      assert.deepEqual((await s.tasks.chatList(await turn('Which columns?'))).settings.properties.map((item:any)=>item.id),['size']);
      assert.deepEqual((await s.tasks.get(owner,hall.id)).assignees.map((item:any)=>item.id).sort(),[named,ali].sort(),'the owner still reads them');
    }
  } finally {loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});}
});
