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
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {fixtureServices,fixtureTelegram} from './fixture-brain.js';
import {GP1,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_GP_OFF_ACCOUNT,MEMBER_GP_OFF_ID,MEMBER_NG_ID,MEMBER_NG_OFF_ID,NG_GROUP_IDS,
  OWNER,fixtureChats,fixtureDirectory,seedChats,seedMembers} from './fixture-groups.js';

// Step 4b (ADR-0262): the owner asks, in their own private chat, what a member said in their own private chat with Nocheh.
test('an ask about a member is recorded only from the owner\'s own words, once, and is answered only while the member\'s chat is bound',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-asks-')),key='member-asks:'+Date.now();
  const served=[...GP_GROUP_IDS,...NG_GROUP_IDS],policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  const notices:any[]=[],starts:any[]=[],frontDoor=fixtureTelegram();
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='run.start'||operation==='run.resume'){starts.push(operation);return {state:'running'};}
      if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
      throw Error('runtime_not_expected '+operation);
    },
    telegram:async(operation,input,timeout)=>operation==='telegram.notice'?(notices.push(input),{state:'done'}):frontDoor(operation,input,timeout),
    memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0,loader:MemberDirectoryLoader|null=null;
  const capture=async(chat:string,from:string,message:Record<string,unknown>,type='private')=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:label,revision:'1',
      occurred_at:null,text:String(message.text??''),payload:{update_id:serial,message:{message_id:serial,date:1700000000,chat:{id:Number(chat),type},
        from:{id:Number(from),first_name:from===MEMBER_GP?'Mira Test':'Owner'},...message}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const reader=async(event:string,scope:string|null=null,space=OWNER):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:event,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const owner=async(message:Record<string,unknown>)=>{const source=await capture(OWNER,OWNER,message);return {source,principal:await reader(source.id)};};
  const asks=async(event:string)=>(await stores.control.query('SELECT * FROM owner_member_asks WHERE owner_event=$1 ORDER BY created_at',[event])).rows;
  const jobs=async(id:string)=>Number((await stores.control.query("SELECT count(*) FROM workflow_registry WHERE family='telegram' AND job_id=$1",['ask:'+id])).rows[0].count);
  try {
    await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control);
    // The names Telegram shows for the members now: Mira (private chat on), Gita (private chat off).
    await stores.control.query("UPDATE chat_accounts SET display_name='Mira Test',username='miratest' WHERE id=$1",[MEMBER_GP_ACCOUNT]);
    await stores.control.query("UPDATE chat_accounts SET display_name='Gita Test' WHERE id=$1",[MEMBER_GP_OFF_ACCOUNT]);
    loader=await startMembers(stores.control,()=>policy);
    await s.guards.reconcile();await s.guards.setMode('on');

    // The owner's own words name Mira: one row, its workflow job requested in the same commit, the same row when asked again.
    const asked=await owner({text:'What did Mira Test tell you about the trip?'});
    const queued=await s.memberAsks.ask(asked.principal,{member:'Mira Test',question:'What did she say about the trip?'});
    assert.deepEqual([queued.state,queued.member],['queued','Mira Test']);
    assert.match(queued.id,/^[a-f0-9]{32}$/);
    assert.deepEqual((await asks(asked.source.id)).map(row=>[row.id,row.member_id,row.question,row.state]),[[queued.id,MEMBER_GP_ID,'What did she say about the trip?','queued']]);
    assert.equal(await jobs(queued.id),1);
    assert.equal((await s.memberAsks.ask(asked.principal,{member:'@miratest',question:'Again?'})).id,queued.id,'the same message about the same member is one ask');
    assert.equal((await asks(asked.source.id)).length,1);

    // Words that are not the owner's own, or do not name the member, record nothing.
    for(const [message,member,code] of [
      [{text:'What did Mira Test say?',forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}},'Mira Test','member_ask_forwarded'],
      [{text:'What did she say about the trip?'},'Mira Test','member_ask_not_named'],
      [{text:'And this?',reply_to_message:{message_id:1,date:1,chat:{id:Number(OWNER),type:'private'},text:'Mira Test wrote this'}},'Mira Test','member_ask_not_named'],
      [{text:'What did Alex say?'},'Alex','member_not_found'],
    ] as const) {
      const turn=await owner(message);
      await assert.rejects(s.memberAsks.ask(turn.principal,{member,question:'What was said?'}),{code},code);
      assert.deepEqual(await asks(turn.source.id),[],code);
    }
    // A member whose private chat with Nocheh is off is never asked about.
    const off=await owner({text:'What did Gita Test say?'});
    await assert.rejects(s.memberAsks.ask(off.principal,{member:'Gita Test',question:'What was said?'}),{status:409,code:'member_chat_closed'});
    assert.deepEqual(await asks(off.source.id),[]);
    // Only the owner's private turn asks: never a group's turn, a dashboard reader or the owner's pass for another event.
    const group=await capture(GP1,MEMBER_GP,{text:'What did Mira Test say?'},'supergroup');
    await assert.rejects(s.memberAsks.ask(await reader(group.id,GP1,GP1),{member:'Mira Test',question:'What was said?'}),{status:403,code:'owner_private_turn_required'});
    await assert.rejects(s.memberAsks.ask({admin:true,scope:null},{member:'Mira Test',question:'What was said?'}),{status:403,code:'owner_private_turn_required'});
    // A malformed ask records nothing.
    const bad=await owner({text:'What did Mira Test say?'});
    for(const input of [{member:'Mira Test'},{member:'',question:'x'},{member:'Mira Test',question:'x',reads:[GP1]},{member:'Mira Test',question:'x'.repeat(4001)}])
      await assert.rejects(s.memberAsks.ask(bad.principal,input),{status:400},JSON.stringify(input).slice(0,60));
    // One message asks about three members at most.
    const many=await owner({text:'What did Mira Test say?'});
    for(const member of [MEMBER_NG_ID,MEMBER_GP_OFF_ID,MEMBER_NG_OFF_ID])
      await stores.control.query(`INSERT INTO owner_member_asks(id,owner_event,member_id,question,expires_at) VALUES($1,$2,$3,'x',now()+interval '1 hour')`,
        [digest(many.source.id+member).slice(0,32),many.source.id,member]);
    await assert.rejects(s.memberAsks.ask(many.principal,{member:'Mira Test',question:'What was said?'}),{status:409,code:'member_ask_limit'});
    assert.equal((await asks(many.source.id)).length,3);

    // The worker waits for the asking turn's own reply first.
    const epoch={owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='telegram'")).rows[0].epoch)};
    const operations=storageWorkflowOperations(s,async()=>({}));
    const run=(id:string)=>operations.telegram!('ask:'+id,epoch);
    assert.equal((await run(queued.id)).state,'waiting');
    assert.equal((await s.memberAsks.row(queued.id))!.state,'queued');
    await stores.control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,'done',1)
      ON CONFLICT(event_id) DO UPDATE SET state=excluded.state`,[asked.source.id,asked.source]);
    // Storage binds an ask's reader to the member's chat only where that binding is wired; without it the ask fails closed:
    // no turn starts, nothing is read, and the owner hears once that it was not answered.
    const closed=await run(queued.id);
    assert.equal(closed.state,'failed');
    const row=(await s.memberAsks.row(queued.id))!;
    assert.deepEqual([row.state,row.error_code],['failed','member_chat_closed']);
    assert.deepEqual(starts,[],'no turn ran');
    assert.equal(notices.length,1);
    assert.match(notices[0].text,/Mira Test/);assert.match(notices[0].text,/can’t read/);
    assert.equal((await run(queued.id)).state,'failed','a closed ask stays closed');
    assert.equal(notices.length,1,'the owner hears it once');

    // An ask past its time expires unanswered, and the owner hears it.
    const late=await owner({text:'What did Mira Test say?'});
    const expired=await s.memberAsks.ask(late.principal,{member:'Mira Test',question:'What was said?'});
    await stores.control.query("UPDATE owner_member_asks SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
    assert.equal((await run(expired.id)).state,'skipped');
    assert.equal((await s.memberAsks.row(expired.id))!.state,'expired');
    assert.equal(notices.length,2);assert.match(notices[1].text,/could not be answered/);
    // An id that is no ask runs nothing.
    assert.equal((await run('f'.repeat(32))).state,'skipped');
    assert.equal((await run('not-an-ask')).state,'failed');
  } finally {
    loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});
  }
});
