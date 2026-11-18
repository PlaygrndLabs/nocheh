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
import {HttpError} from '../src/http.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {workflowView} from '../src/workflows/owner.js';
import {askSendKey} from '../src/stores/owner-member-ask-turns.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {reloadMembers,startMembers,type MemberDirectoryLoader} from '../src/stores/members.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {fixtureServices,fixtureTelegram} from './fixture-brain.js';
import {BOB_ACCOUNT,GP1,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_GP_OFF_ACCOUNT,MEMBER_GP_OFF_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,MEMBER_NG_OFF_ID,NG_GROUP_IDS,
  OWNER,fixtureChats,fixtureDirectory,seedChats,seedMembers} from './fixture-groups.js';

// Step 4b (ADR-0262): the owner asks, in their own private chat, what a member said in their own private chat with Nocheh.
test('an ask about a member is recorded only from the owner\'s own words, once, and is answered once, apart, only while the member\'s chat is open',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-asks-')),key='member-asks:'+Date.now();
  const served=[...GP_GROUP_IDS,...NG_GROUP_IDS],policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  const notices:any[]=[],starts:any[]=[],replies:any[]=[],frontDoor=fixtureTelegram((operation,input)=>{if(operation==='telegram.reply'&&!input.cancel&&!input.observe_only)replies.push(input);});
  // How the fake brain's ask turns go (`running` keeps them running), and whether the fake bot refuses every reply as the
  // real one refuses a malformed request (400). As the real bot (services/telegram/gateway.py reply()), it sends a reply
  // only under its asking message's source key with a continuation, and only when that key's digest is the turn's event.
  let turns:'done'|'running'='done',refuseAll=false,refused=0;
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='run.start'){starts.push(input);return turns==='done'?{state:'done',reply:{text:'She said the trip is on Friday.',session_id:'ask-session'}}:{state:'running'};}
      if(operation==='run.resume')return {state:turns==='running'?'running':'not_found'};
      if(operation==='run.cancel')return {state:'cancelled'};
      if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
      throw Error('runtime_not_expected '+operation);
    },
    telegram:async(operation,input,timeout)=>{
      if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
      if(operation==='telegram.reply'&&!input.cancel&&!input.observe_only) {
        const shape=/^(.+):continuation:[a-f0-9]{64}$/.exec(String(input.dispatch_key));
        if(refuseAll||!shape||digest(shape[1]!)!==input.event_id){refused++;throw new HttpError(400,'telegram_rejected_request');}
      }
      return frontDoor(operation,input,timeout);
    },
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
    // A member whose private chat closed after the ask was recorded is not read: no turn starts, nothing is read, and the
    // owner hears once that it was not answered.
    await stores.control.query('UPDATE members SET private_chat=false WHERE id=$1',[MEMBER_GP_ID]);
    const closed=await run(queued.id);
    assert.equal(closed.state,'failed');
    const row=(await s.memberAsks.row(queued.id))!;
    assert.deepEqual([row.state,row.error_code],['failed','member_chat_closed']);
    assert.equal(starts.length,0,'no turn ran');
    assert.equal(notices.length,1);
    assert.match(notices[0].text,/Mira Test/);assert.match(notices[0].text,/can’t read/);
    assert.equal((await run(queued.id)).state,'failed','a closed ask stays closed');
    assert.equal(notices.length,1,'the owner hears it once');
    await stores.control.query('UPDATE members SET private_chat=true WHERE id=$1',[MEMBER_GP_ID]);

    // An open chat is read: one read-only turn under a pass that names the ask and no lane, reading as the owner's chat
    // and never as the owner; its answer goes to the owner's chat once, as a separate member_read message that names its
    // source first.
    const again=await owner({text:'What did Mira Test say about the bus?'});
    const open=await s.memberAsks.ask(again.principal,{member:'Mira Test',question:'What did she say about the bus?'});
    await stores.control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,'done',1)
      ON CONFLICT(event_id) DO UPDATE SET state=excluded.state`,[again.source.id,again.source]);
    assert.equal((await run(open.id)).state,'completed');
    const answered=(await s.memberAsks.row(open.id))!;
    const sourceKey=(await stores.archive.query('SELECT source_key FROM events WHERE id=$1',[again.source.id])).rows[0].source_key;
    assert.deepEqual([answered.state,answered.send_key],['answered',askSendKey(sourceKey,open.id)],'the row keeps the key it was sent under');
    assert.equal(refused,0,'the bot took the key');
    assert.equal(starts.length,1,'one turn');
    const started=starts[0],claims=JSON.parse(Buffer.from(String(started.archive_credential).split('.')[1]!,'base64url').toString());
    assert.deepEqual([claims.member_read,claims.scope,claims.space,claims.lane,claims.member,claims.answer],[open.id,OWNER,OWNER,undefined,undefined,undefined]);
    assert.deepEqual([started.member_read.ask,started.chat],[open.id,OWNER]);
    assert.equal(replies.length,1);
    assert.equal(replies[0]!.dispatch_key,answered.send_key);
    assert.equal(replies[0]!.send_class,'member_read');
    assert.match(replies[0]!.text,/^🔒 From \u2068“Mira Test”\u2069’s private chat with Nocheh:\n\nShe said the trip is on Friday\.$/);
    assert.equal(notices.length,1,'no notice for an answered ask');
    assert.equal((await run(open.id)).state,'completed','an answered ask is not answered again');
    assert.equal(replies.length,1);

    // An ask past its time expires unanswered, and the owner hears it.
    const late=await owner({text:'What did Mira Test say?'});
    const expired=await s.memberAsks.ask(late.principal,{member:'Mira Test',question:'What was said?'});
    await stores.control.query("UPDATE owner_member_asks SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
    assert.equal((await run(expired.id)).state,'skipped');
    assert.equal((await s.memberAsks.row(expired.id))!.state,'expired');
    assert.equal(notices.length,2);assert.match(notices[1].text,/could not be answered/);

    // The Workflows page offers no Cancel or Retry for an ask: neither would reach its record.
    const control=(await stores.control.query("SELECT * FROM workflow_observations WHERE family='telegram' AND job_id=$1",['ask:'+expired.id])).rows[0];
    assert.deepEqual([control.domain_controllable,control.retry_supported],[false,false]);
    assert.deepEqual([workflowView(control).can_cancel,workflowView(control).can_retry],[false,false]);

    // A new ask and its asking turn, done unless `asking` says how it ended.
    const askNow=async(about:string,asking:{state:string;error_code?:string}={state:'done'})=>{
      const turn=await owner({text:'What did Mira Test say about '+about+'?'});
      const queued=await s.memberAsks.ask(turn.principal,{member:'Mira Test',question:'What did she say about '+about+'?'});
      await stores.control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts,error_code) VALUES($1,$2,$3,1,$4)`,
        [turn.source.id,turn.source,asking.state,asking.error_code??null]);
      return queued.id;
    };
    // The owner did ask: an asking turn that chose silence, or whose reply Telegram did not confirm, still gets the answer.
    for(const asking of [{state:'suppressed',error_code:'intentional_silence'},{state:'ambiguous',error_code:'delivery_unconfirmed'}]) {
      const before:number=replies.length,id=await askNow('lunch '+asking.state,asking);
      assert.equal((await run(id)).state,'completed',asking.state);
      assert.equal(replies.length,before+1);assert.equal((await s.memberAsks.row(id))!.state,'answered');
    }
    // An asking turn that ended any other way leaves the owner told once that the ask was not answered; a withdrawn one
    // asked nothing the owner saw.
    for(const [asking,told] of [[{state:'suppressed',error_code:'approval_button'},1],[{state:'cancelled',error_code:'owner_cancelled'},0]] as const) {
      const before:number=notices.length,turnsBefore:number=starts.length,id=await askNow('the car '+asking.state,asking);
      assert.equal((await run(id)).state,'failed');
      assert.equal((await s.memberAsks.row(id))!.error_code,'asking_turn_not_done');
      assert.equal(notices.length,before+told,asking.state);if(told)assert.match(notices.at(-1).text,/could not be answered/);
      assert.equal(starts.length,turnsBefore,'no turn ran');
    }
    // A reply the bot refuses as it is fails the ask at once, the owner hears it once, and it is not sent again.
    {
      refuseAll=true;const before:number=notices.length,id=await askNow('the bus');
      assert.equal((await run(id)).state,'failed');
      assert.deepEqual([(await s.memberAsks.row(id))!.state,(await s.memberAsks.row(id))!.error_code],['failed','reply_refused']);
      assert.equal((await run(id)).state,'failed');
      assert.equal(refused,1,'asked once');assert.equal(notices.length,before+1);assert.match(notices.at(-1).text,/could not be answered/);
      refuseAll=false;refused=0;
    }
    // An ask whose time runs out while its turn runs expires, and the owner hears it was not answered, not that the
    // member's chat closed.
    {
      turns='running';const before:number=notices.length,id=await askNow('the plan');
      assert.equal((await run(id)).state,'running');
      await stores.control.query("UPDATE owner_member_asks SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
      assert.equal((await run(id)).state,'skipped');
      assert.equal((await s.memberAsks.row(id))!.state,'expired');
      assert.equal(notices.length,before+1);assert.match(notices.at(-1).text,/could not be answered/);assert.doesNotMatch(notices.at(-1).text,/can’t read/);
      turns='done';
    }
    // A member who wrote to Nocheh from two accounts is not asked about, and the owner's turn is told why.
    {
      await stores.control.query("UPDATE chat_accounts SET display_name='Nils Test' WHERE id=$1",[MEMBER_NG_ACCOUNT]);
      await stores.control.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1',[BOB_ACCOUNT,MEMBER_NG_ID]);await reloadMembers();
      const turn=await owner({text:'What did Nils Test say?'});
      await assert.rejects(s.memberAsks.ask(turn.principal,{member:'Nils Test',question:'What was said?'}),{status:409,code:'member_chat_several'});
      assert.deepEqual(await asks(turn.source.id),[]);
      await stores.control.query('UPDATE chat_accounts SET member_id=NULL WHERE id=$1',[BOB_ACCOUNT]);await reloadMembers();
    }
    // A member removed while an ask about them runs: the run does not fail, the owner hears once that the chat can't be
    // read, under the name the ask had, and then the ask goes, as the member's closed asks went with them.
    {
      turns='running';const before:number=notices.length,id=await askNow('the move');
      assert.equal((await run(id)).state,'running');
      await s.members.remove({admin:true,scope:null},MEMBER_GP_ID,{operation_id:'remove-mira-'+serial});
      assert.equal(await s.memberAsks.row(open.id),null,'a closed ask goes with its member');
      assert.equal((await s.memberAsks.row(id))!.member_id,null,'an open one stays until it is closed');
      assert.equal((await run(id)).state,'failed');
      assert.equal(notices.length,before+1);assert.match(notices.at(-1).text,/Mira Test/);assert.match(notices.at(-1).text,/can’t read/);
      assert.equal(await s.memberAsks.row(id),null,'then it goes too');
      assert.equal((await run(id)).state,'skipped');assert.equal(notices.length,before+1,'once');
      turns='done';
    }
    // An id that is no ask runs nothing.
    assert.equal((await run('f'.repeat(32))).state,'skipped');
    assert.equal((await run('not-an-ask')).state,'failed');
  } finally {
    loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});
  }
});
