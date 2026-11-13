import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {reader as parseReader,type Reader} from '../src/access.js';
import {readSet} from '../src/spaces.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {AudienceRepository} from '../src/stores/audience.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {runtimeProfile} from '../src/stores/runtime-profile.js';
import {PrivateAnswerRepository,privateAnswerId,privateAnswerStates,privateAnswerTimes,
  type PrivateAnswer,type PrivateAnswerOffer,type PrivateAnswerOutcome,type PrivateAnswerStart,type PrivateAnswerTap} from '../src/stores/private-answers.js';
import {fixtureServices} from './fixture-brain.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,OWNER,P1,P1_GROUPS,P2,UNSERVED,groupsPolicy,seedGroups} from './fixture-groups.js';

const secret='synthetic-service-token-only-for-tests',owner:Reader={admin:true,scope:null};
const question=(n:number)=>digest('fixture:question:'+n);
const fixtureDatabase=async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  return {config,passwords,stores:connectStores(config,passwords)};
};

test('an answer id is fixed by its question and the service token',()=>{
  const id=privateAnswerId(secret,question(1));
  assert.match(id,/^[a-f0-9]{32}$/);assert.equal(privateAnswerId(secret,question(1)),id);
  assert.notEqual(privateAnswerId(secret,question(2)),id);assert.notEqual(privateAnswerId(secret+'-other',question(1)),id);
  for(const event of ['','e'.repeat(63),'E'.repeat(64)])assert.throws(()=>privateAnswerId(secret,event),{code:'invalid_private_answer'});
  assert.throws(()=>privateAnswerId('',question(1)),{code:'invalid_private_answer'});
  assert.deepEqual(privateAnswerStates,['offered','pressed','answered','needs_private_chat','refused','expired']);
  assert.deepEqual(privateAnswerTimes,{offerHours:24,startMinutes:10,answerMinutes:60});
});

test('the private answers record bootstraps on a fresh and an existing database, keeps only group places and lists for the owner',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {config,passwords,stores}=await fixtureDatabase(),answers=new PrivateAnswerRepository(stores.control,()=>groupsPolicy());
  const insert=(fields:Record<string,unknown>)=>{
    const row={id:privateAnswerId(secret,question(1)),question_event:question(1),from_chat_id:GP1_TOPIC,project_id:P1,asker_account_id:OWNER,...fields};
    const keys=Object.keys(row);
    return stores.control.query(`INSERT INTO private_answers(${keys.join(',')},expires_at) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')},now()+interval '24 hours')`,Object.values(row));
  };
  try {
    const columns=(await stores.control.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='private_answers' ORDER BY ordinal_position`)).rows;
    assert.deepEqual(columns.map(c=>c.column_name),['id','question_event','from_chat_id','project_id','member_id','asker_account_id','read_chats','reply_chat_id',
      'state','refusal_code','press_event','start_event','offered_at','pressed_at','answered_at','expires_at','send_key','revision']);
    assert.equal(columns.find(c=>c.column_name==='read_chats').data_type,'ARRAY');
    assert.deepEqual(columns.filter(c=>c.is_nullable==='NO').map(c=>c.column_name),['id','question_event','from_chat_id','project_id','asker_account_id','state','offered_at','expires_at','revision']);
    assert.deepEqual((await stores.control.query(`SELECT indexname FROM pg_indexes WHERE tablename='private_answers' ORDER BY indexname`)).rows.map(r=>r.indexname),
      ['private_answers_asker','private_answers_due','private_answers_pkey','private_answers_question_event_key','private_answers_start_event_key']);

    // An offered row of the owner's question in a topic of GP1; each column refuses what it can never hold.
    await insert({});
    const saved=(await stores.control.query('SELECT * FROM private_answers')).rows[0];
    assert.equal(saved.state,'offered');assert.equal(saved.read_chats,null);assert.equal(saved.member_id,null);assert.equal(saved.revision,1);
    for(const [why,fields] of Object.entries({
      'a 64-hex id':{id:'a'.repeat(64)},'an upper-case id':{id:'A'.repeat(32)},
      'the owner\'s private chat as the place':{from_chat_id:OWNER},'a private chat\'s topic':{from_chat_id:OWNER+'/topic/5'},
      'a desktop import':{from_chat_id:'desktop:private_supergroup:1234567890'},'system':{from_chat_id:'system'},
      'a project name':{project_id:'P1'},'a group as the asker':{asker_account_id:GP1},
      'a topic in the frozen groups':{read_chats:[GP1,GP1_TOPIC]},'a private chat in the frozen groups':{read_chats:[GP1,OWNER]},
      'a desktop import in the frozen groups':{read_chats:[GP1,'desktop:personal_chat:9']},'no frozen groups':{read_chats:[]},
      'an unknown frozen group':{read_chats:[GP1,null]},'a group as the reply chat':{reply_chat_id:GP1},
      'an unknown state':{state:'done'},'a pressed row without its groups':{state:'pressed'},'an answered row without its groups':{state:'answered'},
      'a refusal in words':{refusal_code:'The project changed'},'a short press event':{press_event:'e'.repeat(63)},
    }))await assert.rejects(insert({id:privateAnswerId(secret,question(2)),question_event:question(2),...fields}),{code:'23514'},why);
    await assert.rejects(insert({id:privateAnswerId(secret,question(2))}),{code:'23505'},'one row per question');
    await insert({id:privateAnswerId(secret,question(3)),question_event:question(3),from_chat_id:GP2,project_id:P2,state:'pressed',read_chats:[GP2,GP3],
      press_event:question(30),start_event:question(31),reply_chat_id:OWNER});
    await assert.rejects(insert({id:privateAnswerId(secret,question(4)),question_event:question(4),start_event:question(31)}),{code:'23505'},'one row per /start');

    // The owner's list: newest first, by project, page by page; nobody else reads it.
    await stores.control.query("UPDATE private_answers SET offered_at=now()-interval '1 hour' WHERE id=$1",[privateAnswerId(secret,question(1))]);
    const all=await answers.list(owner);
    assert.deepEqual(all.answers.map(a=>a.id),[privateAnswerId(secret,question(3)),privateAnswerId(secret,question(1))]);assert.equal(all.next,null);
    assert.deepEqual(all.answers[0]!.read_chats,[GP2,GP3]);assert.ok(all.answers[0]!.offered_at instanceof Date);
    assert.deepEqual((await answers.list(owner,{project:P1})).answers.map(a=>a.question_event),[question(1)]);
    assert.deepEqual((await answers.list(owner,{after:privateAnswerId(secret,question(3))})).answers.map(a=>a.question_event),[question(1)]);
    assert.deepEqual((await answers.list(owner,{project:P1,after:privateAnswerId(secret,question(1))})).answers,[]);
    await assert.rejects(answers.list({admin:false,scope:GP1}),{code:'owner_required'});
    await assert.rejects(answers.list({admin:false,scope:OWNER,space:OWNER,answer:'a'.repeat(32)}),{code:'owner_required'});
    await assert.rejects(answers.list(owner,{project:'P1'}),{code:'invalid_project_id'});
    await assert.rejects(answers.list(owner,{after:'x'}),{code:'invalid_cursor'});

    // A reader without an answer is bound to nothing; an answer reads only the row its own /start claimed.
    const group:Reader={admin:false,scope:GP4,space:GP4};
    assert.equal(await answers.bind(group),group,'a reader without an answer is returned as it is');
    const claimed:Reader={admin:false,scope:OWNER,space:OWNER,answer:privateAnswerId(secret,question(3)),turnEvent:question(31)};
    await assert.rejects(answers.bind(claimed),{code:'private_answer_closed'},'a record whose project is gone reads nothing');
    await seedGroups(stores.control);
    await stores.control.query('UPDATE project_assignments SET project_id=$1 WHERE space_id=ANY($2::text[])',[P2,[GP2,GP3]]);
    try {
      assert.deepEqual((await answers.bind(claimed)).reads,readSet({home:GP2,whole:[GP2,GP3],project:P2}));
      await assert.rejects(answers.bind({...claimed,turnEvent:question(30)}),{code:'private_answer_closed'},'the tap is not the /start');
      await assert.rejects(answers.bind({...claimed,answer:'not-an-id'}),{code:'private_answer_closed'});
    } finally {
      // The next test seeds the layout itself.
      await stores.control.query('DELETE FROM project_assignments WHERE space_id=ANY($1::text[])',[[GP1,GP2,GP3,UNSERVED]]);
      await stores.control.query('DELETE FROM projects WHERE id=ANY($1::text[])',[[P1,P2]]);
    }

    // An install made before the record existed gets it at the next bootstrap, writable by the control service;
    // bootstrapping again keeps every row.
    const superuser=new pg.Client({...config,database:'nocheh_control'});await superuser.connect();
    try {await superuser.query('DROP TABLE private_answers');}finally{await superuser.end();}
    assert.equal((await stores.control.query("SELECT to_regclass('private_answers') AS name")).rows[0].name,null);
    await initializeStoreDatabases(config,passwords);
    await insert({});
    await stores.control.query("UPDATE private_answers SET state='expired',revision=revision+1 WHERE id=$1",[privateAnswerId(secret,question(1))]);
    await initializeStoreDatabases(config,passwords);
    assert.deepEqual((await stores.control.query('SELECT question_event,state,revision FROM private_answers')).rows,[{question_event:question(1),state:'expired',revision:2}]);
    await stores.control.query('DELETE FROM private_answers');
  } finally {await stores.close();}
});

test('a private answer is offered, tapped, started, bound, answered and expired by its record',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {stores}=await fixtureDatabase();
  let policy=groupsPolicy();
  const answers=new PrivateAnswerRepository(stores.control,()=>policy);
  const asked=(n:number)=>question(100+n),id=(n:number)=>privateAnswerId(secret,asked(n)),startOf=(n:number)=>digest('fixture:start:'+n);
  const offer=(n:number,fields:Partial<PrivateAnswerOffer>={})=>answers.offer({id:id(n),question_event:asked(n),from_chat_id:GP1,project_id:P1,asker_account_id:OWNER,...fields});
  const tap=(n:number,fields:Partial<PrivateAnswerTap>={})=>answers.press(id(n),{account_id:OWNER,press_event:digest('fixture:press:'+n),space:GP1,...fields});
  const start=(n:number,fields:Partial<PrivateAnswerStart>={})=>answers.claim(id(n),{account_id:OWNER,start_event:startOf(n),reply_chat_id:OWNER,...fields});
  const pass=(n:number,fields:Partial<Reader>={}):Reader=>({admin:false,scope:OWNER,space:OWNER,answer:id(n),turnEvent:startOf(n),...fields});
  const row=async(n:number)=>(await stores.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE id=$1',[id(n)])).rows[0]!;
  const left=async(n:number)=>Number((await stores.control.query('SELECT extract(epoch FROM expires_at-now()) AS seconds FROM private_answers WHERE id=$1',[id(n)])).rows[0].seconds);
  const lasts=async(n:number,seconds:number,why:string)=>{const remaining=await left(n);assert.ok(remaining>seconds-60&&remaining<=seconds,why+': '+remaining);};
  const assign=(group:string,project:string)=>stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)
    ON CONFLICT(space_id) DO UPDATE SET project_id=EXCLUDED.project_id,mode='assigned'`,[group,project]);
  const unassign=(group:string)=>stores.control.query('DELETE FROM project_assignments WHERE space_id=$1',[group]);
  const projectState=(state:'active'|'archived')=>stores.control.query('UPDATE projects SET state=$2 WHERE id=$1',[P1,state]);
  const stale=(n:number)=>stores.control.query("UPDATE private_answers SET expires_at=now()-interval '1 second' WHERE id=$1",[id(n)]);
  const minutes=(count:number)=>new Date(Date.now()+count*60000);
  const code=(result:PrivateAnswerOutcome)=>result.ok?'ok':result.code;
  try {
    // No button before the groups are in a project, and none where the asking group has no other served group with it.
    assert.equal(await answers.offerable(GP1),null);
    await assert.rejects(offer(1),{code:'private_answer_unavailable'});
    await seedGroups(stores.control);
    for(const space of [GP1,GP1_TOPIC,GP2,GP3])assert.deepEqual(await answers.offerable(space),{project_id:P1,groups:[...P1_GROUPS]},space);
    for(const space of [GP4,UNSERVED,OWNER,OWNER+'/topic/5','desktop:private_supergroup:1234567890'])assert.equal(await answers.offerable(space),null,space);
    await assign(GP4,P2);assert.equal(await answers.offerable(GP4),null,'alone in its project');await unassign(GP4);
    policy=groupsPolicy({group_ids:[GP1,GP4]});assert.equal(await answers.offerable(GP1),null,'the only served group of its project');
    policy=groupsPolicy({enabled:false});assert.equal(await answers.offerable(GP1),null,'Nocheh off');
    policy=groupsPolicy();

    // The button is recorded once per question, for the owner only, and lasts a day.
    const offered=await offer(1);
    assert.equal(offered.state,'offered');assert.equal(offered.read_chats,null);assert.equal(offered.member_id,null);assert.equal(offered.project_id,P1);
    await lasts(1,24*3600,'a day to tap');
    assert.deepEqual(await offer(1),offered,'a retried reply offers the same button');
    for(const fields of [{from_chat_id:GP3},{asker_account_id:'456'},{id:id(2)}])
      await assert.rejects(offer(1,fields),{code:'private_answer_conflict'},JSON.stringify(fields));
    await assert.rejects(offer(2,{project_id:P2}),{code:'private_answer_unavailable'},'not the project of the place');
    await assert.rejects(offer(2,{from_chat_id:GP4}),{code:'private_answer_unavailable'},'a group in no project');
    await assert.rejects(offer(2,{asker_account_id:'456'}),{code:'private_answer_unavailable'},'a member\'s question gets no button in step 2');
    assert.equal((await stores.control.query('SELECT 1 FROM private_answers WHERE id=$1',[id(2)])).rowCount,0);
    for(const fields of [{member_id:'m1'},{from_chat_id:OWNER},{asker_account_id:GP1},{id:'x'},{project_id:'P1'},{question_event:'q'}])
      await assert.rejects(offer(2,fields),{code:'invalid_private_answer'},JSON.stringify(fields));

    // Only the asker's tap, under the answer it was offered for, does anything.
    await assert.rejects(tap(1,{account_id:'x'}),{code:'invalid_private_answer'});
    await assert.rejects(tap(1,{space:OWNER}),{code:'invalid_private_answer'});
    assert.deepEqual(await answers.press(privateAnswerId(secret,question(99)),{account_id:OWNER,press_event:digest('fixture:press:99'),space:GP1}),{ok:false,code:'expired',answer:null});
    assert.deepEqual(await tap(1,{account_id:'456'}),{ok:false,code:'only_asker',answer:offered});
    assert.deepEqual(await tap(1,{space:GP2}),{ok:false,code:'changed',answer:offered},'a tap from another group');
    assert.deepEqual(await start(1),{ok:false,code:'expired',answer:offered},'a button never tapped has no /start');
    const pressed=await tap(1);
    assert.equal(pressed.ok,true);assert.equal(pressed.answer!.state,'pressed');
    assert.deepEqual(pressed.answer!.read_chats,[GP1,GP2,GP3],'every served group of P1: never GP4, an unserved group or a private chat');
    assert.equal(pressed.answer!.press_event,digest('fixture:press:1'));assert.ok(pressed.answer!.pressed_at instanceof Date);
    await lasts(1,10*60,'ten minutes to send /start');
    // Tapping again before /start returns the same row and freezes nothing again.
    await assign(GP3,P2);
    try {assert.deepEqual(await tap(1,{press_event:digest('fixture:press:1b')}),pressed);}finally{await assign(GP3,P1);}

    // /start: only from the asker, only in the asker's own private chat, and once.
    await assert.rejects(start(1,{reply_chat_id:GP1}),{code:'invalid_private_answer'});
    assert.equal(code(await start(1,{account_id:'456',reply_chat_id:'456'})),'not_yours');
    assert.deepEqual(await start(1,{reply_chat_id:'456'}),{ok:false,code:'not_yours',answer:pressed.answer});
    const claimed=await start(1);
    assert.equal(claimed.ok,true);assert.equal(claimed.answer!.start_event,startOf(1));assert.equal(claimed.answer!.reply_chat_id,OWNER);
    assert.deepEqual(claimed.answer!.read_chats,[GP1,GP2,GP3]);
    await lasts(1,60*60,'an hour to answer');
    assert.deepEqual(await start(1),claimed,'the same /start claims the same row again');
    assert.deepEqual(await start(1,{start_event:startOf(91)}),{ok:false,code:'used',answer:claimed.answer});
    assert.equal(code(await tap(1)),'used');

    // The read set comes from the record, for this very turn only, and never from the caller.
    const reads=readSet({home:GP1,whole:[GP1,GP2,GP3],project:P1});
    assert.deepEqual((await answers.bind(pass(1))).reads,reads);
    assert.deepEqual((await answers.bind(pass(1,{reads:readSet({home:GP1,whole:[GP1,GP2,GP3,GP4],project:P1})}))).reads,reads,'what a caller passes is replaced');
    const {turnEvent:_turn,...unturned}=pass(1);
    for(const [why,principal] of Object.entries<Reader>({
      'another turn':pass(1,{turnEvent:startOf(91)}),'no turn':unturned,'another private chat':pass(1,{scope:'456',space:'456'}),
      'a group':pass(1,{scope:GP1,space:GP1}),'a topic as the space':pass(1,{space:OWNER+'/topic/5'}),'an owner pass':pass(1,{scope:null}),
      'the administration':pass(1,{admin:true}),'no record':pass(2),'a malformed id':pass(1,{answer:'A'.repeat(32)}),
    }))await assert.rejects(answers.bind(principal),{code:'private_answer_closed'},why);
    policy=groupsPolicy({group_ids:[GP1,GP3,GP4]});
    assert.deepEqual((await answers.bind(pass(1))).reads,readSet({home:GP1,whole:[GP1,GP3],project:P1}),'a group Nocheh stops serving drops out');
    policy=groupsPolicy({group_ids:[GP2,GP3]});
    await assert.rejects(answers.bind(pass(1)),{code:'private_answer_closed'},'the asking group is no longer served');
    policy=groupsPolicy({enabled:false});
    await assert.rejects(answers.bind(pass(1)),{code:'private_answer_closed'},'Nocheh off');
    policy=groupsPolicy();

    // Delivery is recorded once; a retried delivery reads the same groups while the hour lasts.
    await assert.rejects(answers.answered(id(1),''),{code:'invalid_private_answer'});
    await answers.answered(id(1),'telegram:fixture:1');
    const delivered=await row(1);
    assert.equal(delivered.state,'answered');assert.equal(delivered.send_key,'telegram:fixture:1');assert.ok(delivered.answered_at instanceof Date);
    await answers.answered(id(1),'telegram:fixture:1');
    assert.equal((await row(1)).revision,delivered.revision,'the same send changes nothing');
    await assert.rejects(answers.answered(id(1),'telegram:fixture:2'),{code:'private_answer_closed'});
    assert.deepEqual((await answers.bind(pass(1))).reads,reads);
    assert.equal((await start(1)).ok,true);assert.equal(code(await start(1,{start_event:startOf(91)})),'used');
    assert.equal(code(await tap(1)),'used');

    // Whatever changed in the project between the button and the tap refuses it, for good.
    const refusedBy=async(n:number,change:()=>Promise<unknown>,undo:()=>Promise<unknown>,why:string)=>{
      await offer(n);await change();
      try {assert.deepEqual(await tap(n),{ok:false,code:'changed',answer:await row(n)},why);}finally{await undo();}
      const refused=await row(n);
      assert.deepEqual([refused.state,refused.refusal_code,refused.read_chats],['refused','changed',null],why);
      assert.equal(code(await tap(n)),'changed',why+': for good');assert.equal(code(await start(n)),'changed',why+': no /start');
      await assert.rejects(answers.answered(id(n),'telegram:fixture:'+n),{code:'private_answer_closed'},why);
    };
    await refusedBy(2,()=>projectState('archived'),()=>projectState('active'),'an archived project');
    await refusedBy(3,()=>unassign(GP1),()=>assign(GP1,P1),'the asking group left the project');
    await refusedBy(4,async()=>{await assign(GP2,P2);await assign(GP3,P2);},async()=>{await assign(GP2,P1);await assign(GP3,P1);},'no other group left with it');
    await refusedBy(5,async()=>{await assign(GP4,P2);await assign(GP1,P2);},async()=>{await assign(GP1,P1);await unassign(GP4);},'the asking group moved to another project');

    // A change before the tap narrows what the tap freezes; a change after it never widens it.
    await offer(6);await assign(GP2,P2);
    try {assert.deepEqual((await tap(6)).answer!.read_chats,[GP1,GP3]);}finally{await assign(GP2,P1);}
    assert.equal((await start(6)).ok,true);
    assert.deepEqual((await answers.bind(pass(6))).reads,readSet({home:GP1,whole:[GP1,GP3],project:P1}));
    // ...and a project that changed between the tap and /start refuses the /start.
    await offer(7);assert.equal((await tap(7)).ok,true);await projectState('archived');
    try {assert.equal(code(await start(7)),'changed');}finally{await projectState('active');}
    assert.equal((await row(7)).state,'refused');
    await assert.rejects(answers.bind(pass(7)),{code:'private_answer_closed'});

    // A topic's question answers from the topic, reading the whole project like its group.
    await offer(8,{from_chat_id:GP1_TOPIC});
    assert.equal(code(await tap(8,{space:GP2})),'changed');
    assert.deepEqual((await tap(8,{space:GP1_TOPIC})).answer!.read_chats,[GP1,GP2,GP3]);
    assert.equal((await start(8)).ok,true);
    assert.deepEqual((await answers.bind(pass(8))).reads,readSet({home:GP1_TOPIC,whole:[GP1,GP2,GP3],project:P1}));

    // Two taps or two /starts at once: one freeze, one claim.
    await offer(9);
    const taps=await Promise.all([tap(9),tap(9,{press_event:digest('fixture:press:9b')})]);
    assert.ok(taps.every(result=>result.ok));assert.deepEqual(taps[0].answer!.read_chats,taps[1].answer!.read_chats);
    assert.equal((await row(9)).revision,2,'frozen once');
    assert.deepEqual((await Promise.all([start(9),start(9,{start_event:startOf(99)})])).map(result=>result.ok?'ok':result.code).sort(),['ok','used']);

    // A member's record reads nothing until membership checks come (step 4).
    await stores.control.query(`INSERT INTO private_answers(id,question_event,from_chat_id,project_id,member_id,asker_account_id,read_chats,reply_chat_id,
      state,press_event,start_event,pressed_at,expires_at) VALUES($1,$2,$3,$4,'m1','456',$5,'456','pressed',$6,$7,now(),now()+interval '1 hour')`,
      [id(10),asked(10),GP1,P1,[GP1,GP2,GP3],digest('fixture:press:10'),startOf(10)]);
    await assert.rejects(answers.bind(pass(10,{scope:'456',space:'456'})),{code:'private_answer_closed'});

    // Stale rows expire on the database's clock, tap or /start or not: an unused button after a day, a tap without /start
    // after ten minutes, an unanswered claim after an hour. Answered and refused rows stay as they are; no row is deleted.
    await offer(11);await offer(12);await tap(12);await offer(13);await tap(13);await start(13);
    const count=async()=>Number((await stores.control.query('SELECT count(*) FROM private_answers')).rows[0].count);
    const rows=await count();
    assert.equal(await answers.expire(minutes(5)),0);
    assert.equal(await answers.expire(minutes(11)),1,'the tap without /start');assert.equal((await row(12)).state,'expired');
    assert.equal(await answers.expire(minutes(61)),5,'every claim that was not answered, the member\'s included');
    assert.deepEqual([(await row(13)).state,(await row(6)).state,(await row(1)).state,(await row(2)).state],['expired','expired','answered','refused']);
    assert.equal(await answers.expire(minutes(23*60)),0);
    assert.equal(await answers.expire(minutes(25*60)),1,'the button nobody tapped');assert.equal((await row(11)).state,'expired');
    assert.equal(await count(),rows);
    assert.equal(code(await tap(12)),'expired');assert.equal(code(await start(12)),'expired');
    assert.equal(code(await tap(11)),'expired');assert.equal(code(await start(13)),'expired');
    await assert.rejects(answers.bind(pass(13)),{code:'private_answer_closed'});
    // Before the worker runs, the step itself sees the time is up.
    await offer(14);await stale(14);
    assert.equal(code(await tap(14)),'expired');assert.equal((await row(14)).state,'expired');
    await offer(15);await tap(15);await stale(15);
    assert.equal(code(await start(15)),'expired');assert.equal((await row(15)).state,'expired');
    await offer(16);await tap(16);await start(16);await stale(16);
    await assert.rejects(answers.bind(pass(16)),{code:'private_answer_closed'},'an answer past its hour reads nothing');
    assert.equal(code(await start(16)),'expired');assert.equal((await row(16)).state,'expired');
    await assert.rejects(answers.answered(id(16),'telegram:fixture:16'),{code:'private_answer_closed'});

    // /start narrows the frozen groups to the groups still in the project and never widens them; every request checks the
    // project again, so a group that leaves it narrows an answer already started, and an archived project or an asking
    // group that left closes it.
    await offer(17);assert.deepEqual((await tap(17)).answer!.read_chats,[GP1,GP2,GP3]);
    await assign(GP2,P2);await assign(GP4,P1);
    try {
      const narrowed=await start(17);
      assert.equal(narrowed.ok,true);assert.deepEqual(narrowed.answer!.read_chats,[GP1,GP3],'GP2 left between the tap and /start; GP4 joined after the tap');
      assert.deepEqual((await row(17)).read_chats,[GP1,GP3]);
    } finally {await assign(GP2,P1);await unassign(GP4);}
    const p17=(whole:string[])=>readSet({home:GP1,whole,project:P1});
    assert.deepEqual((await answers.bind(pass(17))).reads,p17([GP1,GP3]),'GP2 coming back does not widen it');
    assert.deepEqual(await start(17),{ok:true,answer:await row(17)},'a retried /start keeps the narrowed groups');
    await assign(GP3,P2);
    try {assert.deepEqual((await answers.bind(pass(17))).reads,p17([GP1]),'a group that leaves after /start drops out');}finally{await assign(GP3,P1);}
    assert.deepEqual((await answers.bind(pass(17))).reads,p17([GP1,GP3]));
    await projectState('archived');
    try {await assert.rejects(answers.bind(pass(17)),{code:'private_answer_closed'},'an archived project closes the answer');}finally{await projectState('active');}
    await unassign(GP1);
    try {await assert.rejects(answers.bind(pass(17)),{code:'private_answer_closed'},'the asking group left the project');}finally{await assign(GP1,P1);}
    await assign(GP1,P2);
    try {await assert.rejects(answers.bind(pass(17)),{code:'private_answer_closed'},'the asking group moved to another project');}finally{await assign(GP1,P1);}
    assert.deepEqual((await answers.bind(pass(17))).reads,p17([GP1,GP3]));
    // With no other frozen group left beside the asking group, /start is refused, even when another group joined since the tap.
    await offer(18);assert.equal((await tap(18)).ok,true);
    await assign(GP2,P2);await assign(GP3,P2);await assign(GP4,P1);
    try {
      const refused=await start(18);
      assert.equal(code(refused),'changed');assert.equal(refused.answer!.state,'refused');assert.equal(refused.answer!.start_event,null);
    } finally {await assign(GP2,P1);await assign(GP3,P1);await unassign(GP4);}
    await assert.rejects(answers.bind(pass(18)),{code:'private_answer_closed'});
    assert.equal(code(await start(18)),'changed','for good');

    // A claimed answer that will not arrive closes for its own /start only and says why from then on: changed when its
    // record closed, expired when it never went out or its hour passed. No later tap or /start is told it was used.
    await offer(19);await tap(19);
    await assert.rejects(answers.undelivered(id(19),'x','changed'),{code:'invalid_private_answer'});
    assert.equal(await answers.undelivered(id(19),startOf(19),'changed'),null,'no /start claimed it yet');
    assert.equal((await row(19)).state,'pressed');
    await start(19);
    assert.equal(await answers.undelivered(id(19),startOf(91),'changed'),null,'another /start closes nothing');
    const closed=await answers.undelivered(id(19),startOf(19),'changed');
    assert.deepEqual([closed!.state,closed!.refusal_code,closed!.start_event],['refused','changed',startOf(19)]);
    assert.deepEqual(await answers.undelivered(id(19),startOf(19),'not_delivered'),await row(19),'repeating it changes nothing');
    assert.equal(code(await start(19,{start_event:startOf(91)})),'changed');
    assert.equal(code(await start(19)),'changed');assert.equal(code(await tap(19)),'changed');
    await assert.rejects(answers.answered(id(19),'telegram:fixture:19'),{code:'private_answer_closed'});
    await offer(20);await tap(20);await start(20);
    assert.equal((await answers.undelivered(id(20),startOf(20),'not_delivered'))!.refusal_code,'not_delivered');
    assert.equal(code(await start(20,{start_event:startOf(91)})),'expired');assert.equal(code(await tap(20)),'expired');
    await offer(21);await tap(21);await start(21);await stale(21);
    const late=await answers.undelivered(id(21),startOf(21),'changed');
    assert.deepEqual([late!.state,late!.refusal_code],['expired',null],'past its hour');
    // While the claiming /start's answer is on its way, another /start is used.
    await offer(23);await tap(23);await start(23);
    assert.equal(code(await start(23,{start_event:startOf(91)})),'used');
    // A button whose group reply never went out is not listed as waiting for a tap; a row already tapped stays as it is.
    await offer(22);await answers.unshown(asked(22));
    assert.deepEqual([(await row(22)).state,(await row(22)).refusal_code],['refused','not_delivered']);
    assert.equal(code(await tap(22)),'expired');
    await answers.unshown(asked(23));assert.equal((await row(23)).state,'pressed');
    await assert.rejects(answers.unshown('q'),{code:'invalid_private_answer'});
  } finally {await stores.control.query('DELETE FROM private_answers');await stores.close();}
});

test('an answer reader reads the groups frozen at its tap, by search and by page, gets the asking group\'s grants and nothing else',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {stores}=await fixtureDatabase(),root=await mkdtemp(join(tmpdir(),'nocheh-private-answers-'));
  const key='private-answers:'+Date.now(),policy=groupsPolicy();
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:secret,policy:()=>policy,
    runtime:async operation=>operation==='guard.detect'?{literals:[]}:{state:'done'},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  let index=0;
  const captured=async(space:string,text:string,extra:Record<string,unknown>={})=>{
    const [chat,topic]=space.split('/topic/') as [string,string|undefined],n=++index;
    const message={message_id:n,date:Math.floor(Date.now()/1000),chat:{id:Number(chat),type:chat.startsWith('-')?'supergroup':'private',...(topic?{is_forum:true}:{})},
      from:{id:Number(OWNER),first_name:'Owner'},text,...(topic?{message_thread_id:Number(topic),is_topic_message:true}:{}),...extra};
    const event:Envelope={version:1,key:key+':'+n,origin:'live',kind:'telegram_update',bot_id:'fixture',scope:chat,source_id:String(n),revision:'1',occurred_at:null,text,payload:{message}};
    return (await s.capture.capture(event)).source;
  };
  const capture=async(space:string,text:string)=>{const source=(await captured(space,text)).reference;await s.guards.prepare(source,'fixture',s.detect);return source;};
  const api=new OwnerStorageApi(s),request=(path:string,body?:unknown,principal:Reader=owner)=>api.request(principal,body===undefined?'GET':'POST',new URL(path,'http://fixture'),body) as Promise<any>;
  try {
    await s.guards.reconcile();await s.selections.reconcile();await s.guards.setMode('on');
    await seedGroups(stores.control);
    const asked=await capture(GP1,'Where does kestrelpine stand?'),inTopic=await capture(GP1_TOPIC,'kestrelpine notes from a topic of GP1');
    const inGP2=await capture(GP2,'kestrelpine budget from GP2'),inGP3=await capture(GP3,'kestrelpine launch from GP3');
    const inGP4=await capture(GP4,'kestrelpine rumour from GP4'),inPrivate=await capture(OWNER,'kestrelpine private note');

    // The owner's sharing rules release one text from GP4 into the asking group and another into GP3. A rule change starts a
    // new authorization epoch, which suspends grants made before it, so the rules come first.
    const release=async(destination:string,content:string)=>{
      const rule=await request('/v1/sharing/rules',{name:key+':'+destination,sources:[GP4],destination,enabled:true,mode:'approved',instructions:'Only this text',
        expected_revision:0,operation_id:key+':rule:'+destination});
      const preview=await request('/v1/sharing/preview',{rule_id:rule.id,expected_revision:rule.revision,source_ids:[inGP4.id],content,operation_id:key+':preview:'+destination});
      return request('/v1/sharing/previews/'+preview.id+'/approve',{expected_revision:1,guard_revision:preview.guard_revision,text_hash:preview.text_hash,
        operation_id:key+':approve:'+destination}) as Promise<{id:string}>;
    };
    const sharedGP1=await release(GP1,'kestrelpine shared into GP1'),sharedGP3=await release(GP3,'kestrelpine shared into GP3');

    // The owner grants one fact into the asking group and another into GP3.
    const person=digest(key+':person');
    await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Bob','active')",[person]);
    const fact=async(n:number,content:string)=>s.entities.publishClaim({subject_id:person,predicate:'kestrelpine_'+n,content,attribution:'reported',
      uncertainty:'supported',evidence:[inGP4]},await s.guards.state(),key+':fact:'+n);
    const intoGP1=await fact(1,'Bob owns the kestrelpine budget.'),intoGP3=await fact(3,'Bob signs the kestrelpine launch.');
    await s.memoryAccess.grant(owner,{fact_id:intoGP1.id,fact_revision:intoGP1.revision,destination:GP1,wording:'Bob owns the budget.',operation_id:key+':grant:1'});
    await s.memoryAccess.grant(owner,{fact_id:intoGP3.id,fact_revision:intoGP3.revision,destination:GP3,wording:'Bob signs the launch.',operation_id:key+':grant:3'});

    // GP2 leaves P1 before the tap, so the answer reads GP1 and GP3; GP2 coming back afterwards does not widen it.
    const id=privateAnswerId(secret,asked.id);
    await s.privateAnswers.offer({id,question_event:asked.id,from_chat_id:GP1,project_id:P1,asker_account_id:OWNER});
    await stores.control.query('UPDATE project_assignments SET project_id=$2 WHERE space_id=$1',[GP2,P2]);
    assert.deepEqual((await s.privateAnswers.press(id,{account_id:OWNER,press_event:digest(key+':press'),space:GP1})).answer?.read_chats,[GP1,GP3]);
    await stores.control.query('UPDATE project_assignments SET project_id=$2 WHERE space_id=$1',[GP2,P1]);
    const started=await capture(OWNER,'/start');
    assert.equal((await s.privateAnswers.claim(id,{account_id:OWNER,start_event:started.id,reply_chat_id:OWNER})).ok,true);

    const binding=await s.guards.state();
    const pass:Reader={admin:false,scope:OWNER,space:OWNER,answer:id,turnEvent:started.id,generation:binding.generation,guard_epoch:binding.epoch};
    const answer=await s.access.bindReads(pass);
    assert.deepEqual(answer.reads,readSet({home:GP1,whole:[GP1,GP3],project:P1}));
    for(const [reference,allowed,why] of [[asked,true,'the asking group'],[inTopic,true,'a topic of the asking group'],[inGP3,true,'another group of the project'],
      [inGP2,false,'a group that left the project before the tap'],[inGP4,false,'a group in no project'],[inPrivate,false,'the owner\'s private chat'],
      [started,true,'its own /start, and nothing else of that chat']] as const)
      assert.equal(await s.access.canRead(answer,reference,binding),allowed,why);
    for(const reference of [asked,inGP3,started])assert.equal(await s.access.canRead(pass,reference,binding),false,'a pass without its bound record reads nothing');
    const group:Reader={admin:false,scope:GP1,space:GP1,generation:binding.generation,guard_epoch:binding.epoch};
    assert.equal(await s.access.canRead(group,asked,binding),true);assert.equal(await s.access.canRead(group,inGP3,binding),false,'a group turn still reads only its own group');

    // Its tasks, through the read set the record binds: the frozen groups' own tasks and the ones set on their project,
    // never a group that left before the tap or another project's list, and only to read (ADR-0247).
    const task=async(title:string,scope:string,group:string|null)=>s.tasks.create(owner,{operation_id:key+':task:'+title,title,scope,group});
    const tasks=[await task('GP1 task',P1,GP1),await task('GP3 task',P1,GP3),await task('P1 task',P1,null),await task('GP2 task',P1,GP2),await task('P2 task',P2,null)];
    const reader={...answer,revision:binding.epoch};
    assert.deepEqual((await s.tasks.chatList(reader)).tasks.map((item:any)=>item.id).sort(),tasks.slice(0,3).map(item=>item.id).sort());
    await assert.rejects(s.tasks.chatGet(reader,tasks[3]!.id),{status:404});
    await assert.rejects(s.tasks.chatCreate(reader,{title:'Sneak'}),{code:'task_read_only'});
    await assert.rejects(s.tasks.chatList({...pass,revision:binding.epoch}),{status:403},'a pass without its bound record reaches no task');

    // Search and pages read the frozen groups only; the asking group is the default page.
    const ids=(hits:{id:string}[])=>hits.map(hit=>hit.id).sort();
    assert.deepEqual(ids(await s.sources.search(answer,'kestrelpine')),[asked.id,inTopic.id,inGP3.id].sort());
    assert.deepEqual(await s.sources.search(pass,'kestrelpine'),[]);
    assert.deepEqual(ids(await s.sources.search(group,'kestrelpine')),[asked.id,inTopic.id].sort());
    const page=async(chat:string)=>(await s.sources.page(answer,{chat,from:'',to:'',after:'',count:30})).items.map(item=>String(item.source)).sort();
    assert.deepEqual(await page(''),['nocheh:event:'+asked.id,'nocheh:event:'+inTopic.id].sort());
    assert.deepEqual(await page(GP3),['nocheh:event:'+inGP3.id]);
    for(const chat of [GP2,GP4,OWNER,GP1_TOPIC])await assert.rejects(page(chat),{code:'conversation_not_permitted'},chat);
    await assert.rejects(s.sources.page(pass,{chat:GP1,from:'',to:'',after:'',count:30}),{code:'private_answer_closed'});

    // Granted context comes from the asking group only: never GP3's grants, nor anything granted into the private chat.
    assert.deepEqual((await s.memoryAccess.context(answer,'')).sources.map(source=>source.text),['Bob owns the budget.']);
    assert.deepEqual((await s.memoryAccess.context({...group,scope:GP3,space:GP3},'')).sources.map(source=>source.text),['Bob signs the launch.']);
    // Shared context likewise: what the owner's rules release into the asking group, never into GP3.
    assert.deepEqual((await s.shared.context(answer,'kestrelpine')).sources.map(source=>[source.id,source.text]),[[sharedGP1.id,'kestrelpine shared into GP1']]);
    assert.equal((await s.shared.read(answer,sharedGP1.id)).text,'kestrelpine shared into GP1');
    await assert.rejects(s.shared.read(answer,sharedGP3.id),{code:'shared_source_not_found'});
    assert.deepEqual((await s.shared.context({...group,scope:GP3,space:GP3},'kestrelpine')).sources.map(source=>source.text),['kestrelpine shared into GP3']);
    await assert.rejects(s.memoryAccess.context(pass,''),{code:'private_answer_closed'});
    await assert.rejects(s.shared.context(pass,'kestrelpine'),{code:'private_answer_closed'});

    // The owner's record lists the answer; nobody else reads it.
    assert.deepEqual((await request('/v1/private-answers?project='+P1)).answers.map((row:PrivateAnswer)=>[row.id,row.state,row.read_chats]),[[id,'pressed',[GP1,GP3]]]);
    await assert.rejects(request('/v1/private-answers',undefined,answer),{code:'owner_required'});

    // The turn runs as the asker's private chat, never as the owner, with the record's project.
    const turn=await s.turns.binding(answer);
    assert.equal(turn.owner,false);assert.equal(turn.event_id,started.id);assert.equal(turn.scope,OWNER);
    assert.equal(turn.profile,runtimeProfile({admin:false,scope:OWNER,space:OWNER,answer:id},binding));
    assert.notEqual(turn.profile,runtimeProfile({admin:false,scope:null,space:OWNER},binding),'not the owner\'s profile');
    assert.notEqual(turn.profile,runtimeProfile({admin:false,scope:OWNER,space:OWNER},binding),'its own profile, named after its record');
    await assert.rejects(s.turns.binding(pass),{code:'turn_source_denied'});
    const audience=new AudienceRepository(s.guards),token=await audience.turn(secret,answer,started.id,Date.now()+60000);
    const claims=JSON.parse(Buffer.from(token.split('.')[1]!,'base64url').toString());
    assert.deepEqual([claims.scope,claims.space,claims.answer,claims.project,claims.reads],[OWNER,OWNER,id,P1,undefined]);
    const parsed=parseReader({headers:{authorization:'Bearer '+token}} as IncomingMessage,secret);
    assert.deepEqual([parsed.scope,parsed.space,parsed.answer,parsed.turnEvent,parsed.reads],[OWNER,OWNER,id,started.id,undefined]);
    await assert.rejects(audience.turn(secret,pass,started.id,Date.now()+60000),{code:'private_answer_closed'});
    await stores.control.query("UPDATE projects SET state='archived' WHERE id=$1",[P1]);
    try {assert.equal(JSON.parse(Buffer.from((await audience.turn(secret,answer,started.id,Date.now()+60000)).split('.')[1]!,'base64url').toString()).project,undefined,
      'an archived project gives no role');}
    finally{await stores.control.query("UPDATE projects SET state='active' WHERE id=$1",[P1]);}

    // A private answer opens no group's original file, the asking group's included, even with the guard off: the only files
    // its turn opens are its own /start's. A group still opens its own.
    const fileIn=async(space:string,name:string)=>{
      const source=await captured(space,'launch sheet',{text:undefined,caption:'launch sheet',document:{file_id:key+':'+name,file_unique_id:key+':'+name,file_name:name+'.txt'}});
      const artifact=source.artifact_ids[0]!;await s.attachments.commit(artifact,Buffer.from('sheet '+name));
      await s.guards.prepare(source.reference,'fixture',s.detect);return artifact;
    };
    const files=[[GP1,await fileIn(GP1,'gp1')],[GP3,await fileIn(GP3,'gp3')]] as const;
    await s.guards.setMode('off');
    try {
      const off=await s.guards.state(),offAnswer=await s.access.bindReads({...pass,generation:off.generation,guard_epoch:off.epoch});
      for(const [space,artifact] of files) {
        assert.equal((await s.sources.bytes({admin:false,scope:space,space,generation:off.generation,guard_epoch:off.epoch},artifact)).toString(),
          'sheet '+(space===GP1?'gp1':'gp3'),space);
        await assert.rejects(s.sources.bytes(offAnswer,artifact),{code:'original_file_requires_owner'},space);
      }
    } finally {await s.guards.setMode('on');}

    // Once its time is up the record binds nothing more.
    await stores.control.query("UPDATE private_answers SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
    await assert.rejects(s.access.bindReads(pass),{code:'private_answer_closed'});
    assert.equal(await s.privateAnswers.expire(),1);
  } finally {await stores.control.query('DELETE FROM private_answers');await stores.close();await rm(root,{recursive:true,force:true});}
});
