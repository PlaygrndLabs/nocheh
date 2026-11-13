import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {PrivateAnswerRepository,privateAnswerId,privateAnswerStates,privateAnswerTimes} from '../src/stores/private-answers.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,OWNER,P1,P2,groupsPolicy} from './fixture-groups.js';

const secret='synthetic-service-token-only-for-tests',owner:Reader={admin:true,scope:null};
const question=(n:number)=>digest('fixture:question:'+n);

test('an answer id is fixed by its question and the service token',()=>{
  const id=privateAnswerId(secret,question(1));
  assert.match(id,/^[a-f0-9]{32}$/);assert.equal(privateAnswerId(secret,question(1)),id);
  assert.notEqual(privateAnswerId(secret,question(2)),id);assert.notEqual(privateAnswerId(secret+'-other',question(1)),id);
  for(const event of ['','e'.repeat(63),'E'.repeat(64)])assert.throws(()=>privateAnswerId(secret,event),{code:'invalid_private_answer'});
  assert.throws(()=>privateAnswerId('',question(1)),{code:'invalid_private_answer'});
  assert.deepEqual(privateAnswerStates,['offered','pressed','answered','needs_private_chat','refused','expired']);
  assert.deepEqual(privateAnswerTimes,{offerHours:24,startMinutes:10});
});

test('the private answers record bootstraps on a fresh and an existing database, keeps only group places and lists for the owner',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),answers=new PrivateAnswerRepository(stores.control,()=>groupsPolicy());
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

    // Until the read-set work lands, every step but the list refuses, and an answer reader is never bound to anything.
    const group:Reader={admin:false,scope:GP4,space:GP4};
    assert.equal(await answers.bind(group),group,'a reader without an answer is returned as it is');
    await assert.rejects(answers.bind({admin:false,scope:OWNER,space:OWNER,answer:privateAnswerId(secret,question(3))}),{code:'not_implemented'});
    await assert.rejects(answers.bind({admin:false,scope:OWNER,space:OWNER,answer:'not-an-id'}),{code:'private_answer_closed'});
    const id=privateAnswerId(secret,question(5));
    await assert.rejects(answers.offer({id,question_event:question(5),from_chat_id:GP1,project_id:P1,asker_account_id:OWNER}),{code:'not_implemented'});
    await assert.rejects(answers.press(id,{account_id:OWNER,press_event:question(50),space:GP1}),{code:'not_implemented'});
    await assert.rejects(answers.claim(id,{account_id:OWNER,start_event:question(51),reply_chat_id:OWNER}),{code:'not_implemented'});
    await assert.rejects(answers.answered(id,'telegram:fixture'),{code:'not_implemented'});
    await assert.rejects(answers.expire(),{code:'not_implemented'});

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
