import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {privateAnswerLines} from '../src/prompts.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {privateAnswerId,type PrivateAnswer} from '../src/stores/private-answers.js';
import {fixtureServices,fixtureTelegram,type FakeCall} from './fixture-brain.js';
import {GP1,GP2,GP3,GP4,OWNER,P1,P2,groupsPolicy,seedGroups} from './fixture-groups.js';

// The Answer privately button end to end in storage (ADR-0249): offered under the owner's own answer in a group whose
// project serves another group, tapped by the owner only, then answered in the owner's private chat after /start.
test('Answer privately is offered under the owner’s group answer, tapped only by the owner and answered once after /start',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-private-button-')),base=Date.now(),token=digest('private-button:'+base);
  const policy=groupsPolicy({group_access:{[GP1]:{granted:['9'],denied:[]}}});
  const started:any[]=[],replies:any[]=[],answers:any[]=[],refusals:any[]=[],notices:any[]=[];let serial=base,link=true;
  // What the next brain turn returns, when not an ordinary done reply; a running turn is observed done later.
  let next:Record<string,unknown>|null=null;
  const runtime:FakeCall=async(operation,input)=>{
    // A group's name can hold a secret; the guarded copy hides it.
    if(operation==='guard.detect')return {literals:String(input.text).includes('fixture-secret')?['fixture-secret']:[]};
    if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
    if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
    if(operation==='run.resume')return {state:'done'};
    if(operation==='telegram.approval'){
      // Without the bot's own name there is no link, and the gateway refuses the answer.
      if(input.start!==undefined&&!link)throw Error('approval_link_unavailable');
      answers.push(input);return {state:'done',answered:true};
    }
    assert.equal(operation,'run.start');started.push(input);
    const receipt=next??{state:'done',stage:'assistant'};next=null;return receipt;
  };
  // Nocheh's bot, which sends nothing for a reply that renders to silence.
  const bot=fixtureTelegram((operation,input)=>{if(operation==='telegram.reply'&&!input.cancel&&!input.observe_only)replies.push(input);});
  const telegram:FakeCall=async(operation,input,timeout)=>operation==='telegram.reply'&&input.text==='Silent fixture'?
    (replies.push(input),{state:'suppressed',error_code:'intentional_silence'}):bot(operation,input,timeout);
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),groupReplies:{mode:'addressed',names:['Nocheh']},
    telegram});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const titles:Record<string,string>={[GP1]:'GP1 team',[GP2]:'GP2 team',[GP3]:'GP3 fixture-secret',[GP4]:'GP4 team'};
  const envelope=(chat:string,payload:Record<string,unknown>):Envelope=>{
    const update=Number(payload.update_id);
    return {version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:chat,source_id:String(update),revision:'1',
      occurred_at:null,text:String((payload.message as any)?.text??''),payload};
  };
  const message=(chat:string,text:string,from:number)=>{
    const update=++serial;
    return {update_id:update,message:{message_id:update,date:1700000000+update-base,from:{id:from,is_bot:false,first_name:from===123?'Bob':'Alice'},text,
      chat:chat===OWNER||!chat.startsWith('-')?{id:Number(chat),type:'private'}:{id:Number(chat),type:'supergroup',title:titles[chat]}}};
  };
  const say=async(chat:string,text:string,from=123)=>{
    const id=(await services.capture.capture(envelope(chat,message(chat,text,from)))).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    await services.telegram.run(id,await authority('telegram'));return id;
  };
  const press=async(data:string,from:number,chat=GP1)=>{
    const update=++serial,payload={update_id:update,callback_query:{id:'query-'+update,from:{id:from},chat_instance:'1',data,
      message:{message_id:5,date:1700000000,chat:{id:Number(chat),type:'supergroup'},reply_markup:{inline_keyboard:[[{text:'🔒 Answer privately',callback_data:data}]]}}}};
    const source=(await services.capture.capture(envelope(chat,payload))).source.reference;await services.guards.prepare(source,'fixture',services.detect);
    assert.equal(await services.actionCommands.callback(source),true);return answers.at(-1);
  };
  const row=async(id:string)=>(await stores.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE id=$1',[id])).rows[0]!;
  const replyTo=(event:string)=>replies.filter(reply=>reply.event_id===event).at(-1);
  const texts=privateAnswerLines(undefined);
  try {
    await seedGroups(stores.control);
    await services.guards.reconcile();await services.guards.setMode('on');
    // GP2 and GP3 have spoken before, so the answer can name them from their guarded copies; GP3's name holds a secret.
    for(const [chat,text] of [[GP2,'GP2 kickoff notes'],[GP3,'GP3 hello']] as const)
      await services.guards.prepare((await services.capture.capture(envelope(chat,message(chat,text,9)))).source.reference,'fixture',services.detect);

    // Alice says something unaddressed; the owner then asks in GP1, a group of P1 with two other served groups.
    await say(GP1,'Lunch is at noon',9);
    const asked=await say(GP1,'Nocheh, what did P1 decide?');
    const id=privateAnswerId(token,asked);
    assert.deepEqual(replyTo(asked).button,{text:'🔒 Answer privately',data:'np'+id},'the button sits under the owner’s own answer');
    assert.equal(Buffer.byteLength(replyTo(asked).button.data),34,'within Telegram’s 64 bytes of callback data');
    assert.deepEqual((({from_chat_id,project_id,asker_account_id,state,read_chats})=>({from_chat_id,project_id,asker_account_id,state,read_chats}))(await row(id)),
      {from_chat_id:GP1,project_id:P1,asker_account_id:OWNER,state:'offered',read_chats:null});
    assert.equal((await services.privateAnswers.offer({id,question_event:asked,from_chat_id:GP1,project_id:P1,asker_account_id:OWNER})).id,id,
      'a retried reply offers the same button');

    // No button for a member's answer, a group in no project, a project with only this group, an archived project, or the private chat.
    const none=async(chat:string,text:string,from=123)=>{const event=await say(chat,text,from);assert.ok(replyTo(event),chat+' '+text);assert.equal(replyTo(event).button,undefined,text);};
    await none(GP1,'Nocheh, what is next?',9);
    await none(GP4,'Nocheh, anything new?');
    await stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO UPDATE SET project_id=$2`,[GP4,P2]);
    await none(GP4,'Nocheh, and in P2?');
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=$1',[GP4]);
    await stores.control.query(`UPDATE projects SET state='archived' WHERE id=$1`,[P1]);
    await none(GP1,'Nocheh, with P1 archived?');
    await stores.control.query(`UPDATE projects SET state='active' WHERE id=$1`,[P1]);
    await none(OWNER,'Hello in private');

    // Alice's tap gets the only-asker popup, with no link, and changes nothing.
    assert.deepEqual(await press('np'+id,9),{kind:'answer',chat_id:GP1,callback_query_id:'query-'+serial,text:texts.only_asker});
    assert.equal((await row(id)).state,'offered');
    // The owner's tap freezes P1's served groups and opens the private chat with the record as /start.
    assert.deepEqual(await press('np'+id,123),{kind:'answer',chat_id:GP1,callback_query_id:'query-'+serial,text:texts.open,start:id});
    const pressed=await row(id);
    assert.equal(pressed.state,'pressed');assert.deepEqual(pressed.read_chats,[GP1,GP2,GP3]);
    // Tapping again before /start opens the same link and freezes nothing again.
    assert.equal((await press('np'+id,123)).start,id);
    assert.deepEqual((await row(id)).pressed_at,pressed.pressed_at);

    // /start <id> in the owner's private chat runs one turn under the answer's own pass.
    const before=started.length,start=await say(OWNER,'/start '+id);
    assert.equal(started.length,before+1);
    const turn=started.at(-1),pass=reader({headers:{authorization:'Bearer '+turn.archive_credential}} as any,token);
    assert.deepEqual({scope:pass.scope,space:pass.space,answer:pass.answer},{scope:OWNER,space:OWNER,answer:id},'never as the owner');
    assert.equal(turn.text,'Nocheh, what did P1 decide?','the question’s own text');
    assert.match(turn.speaker,/^\[Group message from Bob, sent [^\]]+\] \[the owner\]$/);
    assert.deepEqual(turn.recent_group.map((item:any)=>item.text),['Lunch is at noon'],'with what the asking group said just before it');
    assert.equal(turn.private_answer.question_event,asked);
    assert.match(turn.private_answer.frame,/^\[Private answer\] .*asked in “GP1 team”.*: “GP1 team”, “GP2 team”, “GP3 [^”]+”\./s);
    assert.equal(turn.private_answer.group,'“GP1 team”','where it was asked, as the first line names it, for the owner’s notes');
    assert.ok(!JSON.stringify(turn).includes(GP2)&&!JSON.stringify(turn).includes(GP3),'no group ID reaches the turn');
    assert.ok(!JSON.stringify(turn).includes('fixture-secret'),'a name comes from its guarded copy, never the original');
    assert.equal(replyTo(start).chat_id,OWNER);assert.equal(replyTo(start).button,undefined,'a private answer carries no button');
    const answered=await row(id);
    assert.equal(answered.state,'answered');assert.equal(answered.start_event,start);assert.equal(answered.reply_chat_id,OWNER);

    // Every other /start gets its fixed reply and runs nothing.
    const fixed=async(text:string,expected:string)=>{const count=started.length,event=await say(OWNER,text);
      assert.equal(started.length,count,text);assert.equal(replyTo(event).text,expected,text);assert.equal(replyTo(event).button,undefined);};
    await fixed('/start '+id,texts.used);
    const untapped=privateAnswerId(token,await say(GP1,'Nocheh, a second question?'));
    await fixed('/start '+untapped,texts.expired);
    await fixed('/start '+'f'.repeat(32),texts.expired);
    const moved=privateAnswerId(token,await say(GP1,'Nocheh, a third question?'));
    assert.equal((await press('np'+moved,123)).start,moved);
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=ANY($1::text[])',[[GP2,GP3]]);
    await fixed('/start '+moved,texts.changed);
    assert.deepEqual((({state,refusal_code})=>({state,refusal_code}))(await row(moved)),{state:'refused',refusal_code:'changed'});
    await seedGroups(stores.control);

    // The project changes while the answer runs: the reply is withdrawn, the private chat gets the changed notice once,
    // and the record closes, so a later /start or tap is told it changed, never that it was already answered.
    const busy=privateAnswerId(token,await say(GP1,'Nocheh, a fifth question?'));
    assert.equal((await press('np'+busy,123)).start,busy);
    next={state:'running'};const running=await say(OWNER,'/start '+busy);
    assert.equal((await row(busy)).start_event,running);assert.equal(replyTo(running),undefined);
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=ANY($1::text[])',[[GP2,GP3]]);
    const observe=async()=>{await stores.control.query('UPDATE dispatches SET next_attempt=now() WHERE event_id=$1',[running]);
      return services.telegram.run(running,await authority('telegram'));};
    await observe();
    assert.equal(replyTo(running),undefined,'the answer is withdrawn');
    assert.equal((await stores.control.query('SELECT state FROM dispatches WHERE event_id=$1',[running])).rows[0].state,'cancelled');
    assert.deepEqual(notices.map(({chat_id,text})=>({chat_id,text})),[{chat_id:OWNER,text:texts.changed}]);
    assert.deepEqual((({state,refusal_code})=>({state,refusal_code}))(await row(busy)),{state:'refused',refusal_code:'changed'});
    await seedGroups(stores.control);
    await fixed('/start '+busy,texts.changed);
    assert.equal((await press('np'+busy,123)).text,texts.changed);
    assert.equal(notices.length,1,'one notice');

    // An answer that ends in silence closes too, without a notice: a later /start is told it expired, never that it was used.
    const quiet=privateAnswerId(token,await say(GP1,'Nocheh, a sixth question?'));
    assert.equal((await press('np'+quiet,123)).start,quiet);
    next={state:'suppressed',error_code:'intentional_silence'};await say(OWNER,'/start '+quiet);
    assert.deepEqual((({state,refusal_code})=>({state,refusal_code}))(await row(quiet)),{state:'refused',refusal_code:'not_delivered'});
    await fixed('/start '+quiet,texts.expired);
    assert.equal(notices.length,1);

    // No button is recorded under a reply that renders to nothing or that the bot did not send.
    next={state:'done',reply:{text:'【nocheh:event:'+'a'.repeat(64)+'】',session_id:'fixture-session'}};
    const cited=await say(GP1,'Nocheh, only a citation?');
    assert.equal((await row(privateAnswerId(token,cited))),undefined,'only a citation: nothing to carry the button');
    next={state:'done',reply:{text:'Silent fixture',session_id:'fixture-session'}};
    const unsent=await say(GP1,'Nocheh, a reply the bot holds back?');
    assert.equal(replyTo(unsent).button.data,'np'+privateAnswerId(token,unsent));
    assert.deepEqual((({state,refusal_code})=>({state,refusal_code}))(await row(privateAnswerId(token,unsent))),{state:'refused',refusal_code:'not_delivered'});

    // A tap the bot cannot turn into a link is told to tap again, never that something changed, and tapping again opens
    // the private chat.
    link=false;const late=privateAnswerId(token,await say(GP1,'Nocheh, a fourth question?'));
    assert.equal((await press('np'+late,123)).text,texts.retry);link=true;
    assert.deepEqual(await press('np'+late,123),{kind:'answer',chat_id:GP1,callback_query_id:'query-'+serial,text:texts.open,start:late});

    // Anyone else's /start is today's private-chat refusal; a /start that names no record is an ordinary owner turn.
    const count=started.length;await say('9','/start '+id,9);
    assert.equal(started.length,count);assert.equal(refusals.length,1);
    await say(OWNER,'/start hello');assert.equal(started.length,count+1);
    assert.equal(reader({headers:{authorization:'Bearer '+started.at(-1).archive_credential}} as any,token).answer,undefined);

    // The owner reads the record per project.
    const listed=(await services.privateAnswers.list({admin:true,scope:null},{project:P1})).answers.map(answer=>answer.id);
    for(const each of [id,untapped,moved,late,busy,quiet])assert.ok(listed.includes(each));
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
