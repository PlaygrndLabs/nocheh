import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';

test('allowed members post freely in their own group; everything else waits for the owner\'s button in their private chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-approval-buttons-')),key='approval-buttons:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[],refusals:Record<string,any>[]=[];let updates=0;
  const other=group+'1',closed=group+'2',forum='-100'+Date.now();
  let topicMemory:'group'|'topic'='group';
  // When set, the next card edit waits for it, after calling reached.
  let hold:Promise<void>|null=null,reached=()=>{};
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other,closed,forum],
    group_access:{[group]:{granted:['9'],denied:[]},[other]:{granted:['9'],denied:[]},[closed]:{granted:[],denied:['9']}},topic_memory:topicMemory});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='action.execute')return {state:'done'};
      if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
      assert.equal(operation,'telegram.approval');
      if(input.kind==='settle'&&hold){const wait=hold;hold=null;reached();await wait;}
      cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },honcho:async()=>{throw Error('no memory provider');}});
  const bot=String(Date.now()).slice(-9);
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:'',payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const message=(label:string,extra:Record<string,unknown>={},from=9,update?:number)=>capture(label,{...(update?{update_id:update}:{}),message:{message_id:Date.now(),date:1700000000,
    chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:from,first_name:'Member'},text:'Please prepare a message',...extra}});
  const press=(label:string,data:string,from=123)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},message_thread_id:17,is_topic_message:true,
      reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}});
  const actor=async(source:string,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:group,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
    // An allowed member's request for a post in the same group is approved by the request, in any topic of the group.
    const topic=await message('topic',{message_thread_id:17,is_topic_message:true});
    const here=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:'current',text:'Exact group message'}));
    assert.equal(here.state,'approved');assert.match(here.message,/\[NO_REPLY\]/);assert.equal(cards.length,0,'no card for a post in the same group');
    const general=await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:group,text:'Exact General message'});
    assert.equal(general.state,'approved','the whole group is one audience by default');assert.match(general.message,/Confirm in one short sentence/);
    topicMemory='topic';
    const shut=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:group,text:'Another topic'}));
    assert.equal(shut.state,'proposed','with separate topic memory another topic is reviewed like another group');
    assert.deepEqual([last('card').chat_id,last('card').topic],[group,'17'],'by the person who asked, under their request');
    topicMemory='group';
    const across=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:other+'/topic/4',text:'For the other group'}));
    assert.equal(across.state,'proposed','a message built from one group\'s memory for another group waits for a review');
    // The person who asked, allowed in both groups, reviews it under their request in their own group and topic.
    const reviewCard=last('card');
    assert.deepEqual([reviewCard.chat_id,reviewCard.topic,reviewCard.text,reviewCard.links],[group,'17','📨 Send to a Telegram group › a topic\n\nFor the other group',[]],
      'no "Asked in" line on a card in the chat where it was asked');
    // The card is the answer: it replies to the request, and Nocheh adds nothing of its own.
    assert.equal(reviewCard.reply_to,String((await stores.archive.query('SELECT payload FROM events WHERE id=$1',[topic.id])).rows[0].payload.toString().match(/"message_id":(\d+)/)[1]));
    assert.match(across.message,/posted here as the reply to it[^]*return \[NO_REPLY\]/);
    const reviewApprove='na'+across.id.slice(0,40)+across.fingerprint.slice(0,16);
    assert.equal(await s.actionCommands.callback(await press('other-member',reviewApprove,8)),true);
    assert.equal(last('answer').text,'Only the person who asked or the owner can approve or reject this.');
    assert.equal((await s.telegramActions.inspect(owner,across.id)).state,'proposed','another member\'s press decides nothing');
    assert.equal(await s.actionCommands.callback(await press('requester',reviewApprove,9)),true);
    assert.equal((await s.telegramActions.inspect(owner,across.id)).state,'approved','the person who asked approves their own cross-group message');
    assert.deepEqual([last('settle').chat_id,last('settle').text],[group,reviewCard.text+'\n\n⏳ Approved. Sending now.']);
    const ownerAcross=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor((await message('owner-across',{},123)).id,group),{destination:other,text:'Owner to the other group'}));
    const ownerSelf=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor((await message('owner-self',{},123)).id,group),{destination:'123',text:'Note to myself'}));
    assert.equal(ownerSelf.state,'approved','the owner\'s own request from a group for their private chat needs no approval');assert.match(ownerSelf.message,/owner's own private chat/);
    assert.equal(ownerAcross.state,'proposed');assert.deepEqual([last('card').chat_id,last('card').topic],['123',undefined],'the owner\'s own cross-group request comes to their private chat');
    const shutAcross=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:closed,text:'Not allowed there'}));
    assert.equal(shutAcross.state,'proposed');assert.equal(last('card').chat_id,'123','a group where the person asking is not allowed goes to the owner');
    await stores.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at)
      VALUES($1,'available','supergroup','Design team',NULL,true,NULL,now()) ON CONFLICT DO NOTHING`,[other]);
    assert.deepEqual((await s.telegramActions.destinations(await actor(topic.id,group+'/topic/17'))).groups,
      [{destination:group,name:null,current:true},{destination:other,name:'Design team',current:false}],'only the groups where the person asking is allowed');
    await assert.rejects(s.telegramActions.destinations(owner),{status:403});
    const ownerTurn=await message('owner-in-group',{},123);
    assert.equal((await s.telegramActions.destinations(await actor(ownerTurn.id,group))).groups.length,4,'the owner is allowed in every group');
    // A message for another chat waits for the owner, with the card in the owner's private chat only.
    const plain=await message('plain');
    const elsewhere=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Exact private message'}));
    const card=last('card');
    assert.deepEqual([card.chat_id,card.topic,card.id],['123',undefined,elsewhere.id]);
    assert.equal(card.text,'📨 Send to your private chat\n💬 Asked in a Telegram group\n\nExact private message');
    assert.deepEqual(card.buttons,[['✅ Approve','na'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16)],['❌ Reject','nd'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16)]]);
    assert.ok(card.buttons.every((pair:string[])=>Buffer.byteLength(pair[1]!)<=64));
    assert.match(elsewhere.message,/say only, briefly, that you asked the owner; do not show the draft/);
    assert.doesNotMatch(elsewhere.message,/answer will follow/,'a message has no follow-up turn');
    assert.equal(card.reply_to,undefined,'a card in another chat replies to nothing');
    // The owner's own request in the private chat: one card, the reply to it, naming the group and topic with their Telegram links.
    await capture('forum-topic',{message:{message_id:7,message_thread_id:7,date:1700000000,chat:{id:Number(forum),type:'supergroup',title:'Plans team',is_forum:true},
      from:{id:123},forum_topic_created:{name:'Launch',icon_color:1}}},forum);
    await capture('forum-latest',{message:{message_id:30,date:1700000000,chat:{id:Number(forum),type:'supergroup',title:'Plans team',is_forum:true},from:{id:123},text:'Hi'}},forum);
    const ask=await capture('owner-private',{message:{message_id:12,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'Post in Launch'}},'123');
    const toTopic=await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(ask.id,'123'),scope:null},{destination:forum+'/topic/7',text:'Hello forum'}));
    const internal=forum.slice(4);
    assert.deepEqual([last('card').chat_id,last('card').reply_to,last('card').text,last('card').links],['123','12','📨 Send to “Plans team” › Launch\n\nHello forum',
      [{offset:11,length:12,url:`https://t.me/c/${internal}/30`},{offset:26,length:6,url:`https://t.me/c/${internal}/7`}]]);
    assert.match(toTopic.message,/return \[NO_REPLY\]/);
    // A later turn in the same chat can follow the request without its ID; another chat cannot read it.
    const later={...await actor((await capture('owner-later',{message:{message_id:13,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'Did it go out?'}},'123')).id,'123'),scope:null};
    const recent=await s.telegramActions.recent(later);
    assert.deepEqual([recent[0]!.id,recent[0]!.state,recent[0]!.destination],[toTopic.id,'proposed',forum+'/topic/7']);
    assert.ok(recent.every(item=>!('arguments' in item)),'the list has no message text; a request is read by its ID');
    assert.equal((await s.telegramActions.inspect(later,toTopic.id)).state,'proposed');
    await assert.rejects(s.telegramActions.inspect(await actor(plain.id,group),toTopic.id),{status:404});
    assert.ok((await s.telegramActions.recent(await actor(plain.id,group))).every(item=>item.id!==toTopic.id));
    await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(ask.id,'123'),scope:null},{destination:forum,text:'Hello General'}));
    assert.equal(last('card').text,'📨 Send to “Plans team” › General\n\nHello General','a message to a forum without a topic goes to General');
    await stores.control.query("UPDATE owner_prompts SET texts='{\"telegram.approval_texts\":\"topic: in {topic}\"}'::jsonb WHERE singleton");
    await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(ask.id,'123'),scope:null},{destination:forum+'/topic/9',text:'Hello unknown'}));
    assert.deepEqual([last('card').text,last('card').links.at(-1)],['📨 Send to “Plans team” in a topic\n\nHello unknown',{offset:27,length:7,url:`https://t.me/c/${internal}/9`}],
      'the owner\'s wording; a topic with no known name is still linked');
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    const approve='na'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16);
    assert.equal(await s.actionCommands.callback(await press('stranger',approve,9)),true);
    assert.equal(last('answer').text,'Only the owner can approve or reject this.');
    assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'proposed','anyone else\'s press decides nothing');
    assert.equal(await s.actionCommands.callback(await press('changed','na'+elsewhere.id.slice(0,40)+'0'.repeat(16))),true);
    assert.match(last('answer').text,/changed or no longer exists/);
    assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'proposed','a card for other content decides nothing');
    assert.equal(await s.actionCommands.callback(await press('unrelated','some-other-button')),false,'another button is not an approval');
    const pressed=await press('owner',approve);
    assert.equal(await s.actionCommands.callback(pressed),true);
    assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'approved');
    assert.equal(last('answer').text,'✅ Approved.');
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').text],[elsewhere.id,'123',card.text+'\n\n⏳ Approved. Sending now.']);
    assert.equal(last('settle').message_id,undefined,'a press in another chat names no message of this card');
    assert.equal(await s.actionCommands.callback(pressed),true);assert.equal(last('answer').text,'✅ Approved.','a repeated delivery of one press is one decision');
    // A press reaching the reply workflow is handled there and never becomes a turn.
    await s.preparation.run(pressed.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    assert.equal((await s.telegram.run(pressed.id,await epoch('telegram'))).state,'skipped');
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[pressed.id])).rows[0],{state:'suppressed',error_code:'approval_button'});
    // Once the approved message is sent, the card says so.
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(elsewhere.id,await epoch('actions'))).state,'completed');
    assert.equal(last('settle').text,card.text+'\n\n✅ Approved and sent.');
    assert.equal(await s.actionCommands.callback(await press('reject-late','nd'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16))),true);
    assert.match(last('answer').text,/already decided/);assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'done');
    assert.equal(await s.actionCommands.callback(await press('reject','nd'+shut.id.slice(0,40)+shut.fingerprint.slice(0,16))),true);
    assert.equal((await s.telegramActions.inspect(owner,shut.id)).state,'rejected');
    assert.match(last('settle').text,/\n\n❌ Rejected\. Nothing was sent\.$/);
    // A controlled operation from a group is never approved by the request; its card also goes to the owner.
    const tool=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(plain.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(last('card').chat_id,'123');assert.match(last('card').text,/^⚙️ Run shell\n💬 Asked in a Telegram group\n\n\{/);assert.match(tool.message,/asked the owner/);
    assert.match(tool.message,/the answer will follow here/,'an operation answers later in the chat that asked');
    // When the owner asks in the group, the reply tells them their card is in their private chat.
    const own=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(ownerTurn.id,group),{kind:'shell',arguments:{command:'printf mine'}}));
    assert.equal(last('card').chat_id,'123');assert.match(own.message,/The person who asked is the owner\..*tell them directly, briefly, that the card is waiting in their private chat and that the answer will follow here/);
    assert.doesNotMatch(own.message,/you asked the owner/);
    // The press names the card's message, so a card whose send lost its answer still loses its buttons: here the card
    // reviewed in its own group. A press in another chat names none.
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').message_id],[shut.id,group,'5']);
    const toolData='na'+tool.id.slice(0,40)+tool.fingerprint.slice(0,16),privatePress=(label:string,message:number,data:string)=>
      capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:123},chat_instance:'1',data:toolData,
        message:{message_id:message,date:1700000000,chat:{id:123,type:'private'},reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}},'123');
    // Sent on another message, one without this button, the same data names no message.
    assert.equal(await s.actionCommands.callback(await privatePress('tool-elsewhere',58,'na'+'0'.repeat(56))),true);
    assert.equal((await s.controlledActions.inspect(owner,tool.id)).state,'approved');assert.match(last('settle').text,/\n\n✅ Approved\.$/);
    assert.deepEqual([last('settle').chat_id,last('settle').message_id],['123',undefined]);
    assert.equal(await s.actionCommands.callback(await privatePress('tool',57,toolData)),true);
    assert.deepEqual([last('settle').chat_id,last('settle').message_id],['123','57']);
    // A standing permission runs the same operation without a decision, so no buttons are offered.
    await s.controlledActions.grant(owner,{action_id:tool.id,fingerprint:tool.fingerprint,uses:1,minutes:5});
    const again=await message('again'),offered=cards.length;
    const permitted=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(again.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(permitted.fingerprint,tool.fingerprint);assert.equal(cards.length,offered);assert.doesNotMatch(permitted.message,/buttons/);
    // A reaction in another group leaves a waiting operation's Approve button working.
    const operation=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor((await message('before-reaction')).id,group),{kind:'shell',arguments:{command:'printf after-reaction'}}));
    const before=(await s.guards.state()).epoch;
    await capture('reaction',{update_id:++updates,message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:1,date:1700000100,user:{id:9},
      old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}},other);
    assert.equal((await s.guards.state()).epoch,before+1);
    assert.equal(await s.actionCommands.callback(await press('after-reaction','na'+operation.id.slice(0,40)+operation.fingerprint.slice(0,16))),true);
    assert.equal((await s.controlledActions.inspect(owner,operation.id)).state,'approved');assert.match(last('settle').text,/\n\n✅ Approved\.$/);
    // Someone not allowed in the group gets the owner's fixed reply, with no turn.
    const stranger=await message('stranger-ask',{text:'Nocheh, what is the plan?',message_thread_id:17,is_topic_message:true},8,++updates);
    await s.preparation.run(stranger.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    assert.equal((await s.telegram.run(stranger.id,await epoch('telegram'))).state,'skipped');
    assert.deepEqual({...refusals.at(-1),event_id:undefined},{event_id:undefined,chat_id:group,message_id:refusals.at(-1)!.message_id,topic:'17',user_id:'8',
      group_addressing:{direct:false,handles:[]},text:'Nocheh, what is the plan?',reply:'Sorry, I only work with people the owner has allowed in this group.'});
    await stores.control.query(`UPDATE owner_prompts SET texts='{"telegram.not_allowed":"Only allowed people, please."}'::jsonb WHERE singleton`);
    const edited=await message('stranger-again',{text:'Nocheh?'},8,++updates);
    await s.preparation.run(edited.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    await s.telegram.run(edited.id,await epoch('telegram'));
    assert.equal(refusals.at(-1)!.reply,'Only allowed people, please.','the owner\'s own wording is used');
    const allowed=refusals.length,member=await message('member-chat',{text:'Hello all'},9,++updates);
    await s.preparation.run(member.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    await s.telegram.run(member.id,await epoch('telegram')).catch(()=>{});
    assert.equal(refusals.length,allowed,'an allowed member is never refused');
    // The owner's card template and texts from Settings are used; a line they left out keeps its default.
    await stores.control.query(`UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton`,[JSON.stringify({
      'telegram.approval_card':'To {destination} (from {origin}):\n{text}','telegram.approval_texts':'approve: Yes, send\nsent: Sent!'})]);
    const styled=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor((await message('styled')).id,group),{destination:'123',text:'Styled'}));
    assert.equal(last('card').text,'To your private chat (from a Telegram group):\nStyled');
    assert.deepEqual(last('card').buttons.map((pair:string[])=>pair[0]),['Yes, send','❌ Reject']);
    assert.equal(await s.actionCommands.callback(await press('styled-yes','na'+styled.id.slice(0,40)+styled.fingerprint.slice(0,16))),true);
    await storageWorkflowOperations(s,async()=>({})).actions!(styled.id,await epoch('actions'));
    assert.equal(last('settle').text,'To your private chat (from a Telegram group):\nStyled\n\nSent!');
    // Without a reachable runtime the request still waits for the Inbox.
    const sent=cards.length,quiet=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
      runtime:async(operation)=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime unavailable');},honcho:async()=>{throw Error('no memory provider');}});
    const waiting=await quiet.actionCommands.offer('telegram',await quiet.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Waits for the Inbox'}));
    assert.equal(waiting.state,'proposed');assert.match(waiting.message,/^Owner approval is required/);assert.equal(cards.length,sent);

    // Once an approved operation ends, its card says how, with a reason only from fixed codes in the owner's wording.
    await stores.control.query(`UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton`,[JSON.stringify({'telegram.approval_texts':'reason_sign_in: Sign in to Notion again in the dashboard.'})]);
    const approvedTool=async(label:string)=>{
      const asked=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor((await message(label)).id,group),{kind:'shell',arguments:{command:'printf '+label}}));
      assert.equal(await s.actionCommands.callback(await press(label+'-approve','na'+asked.id.slice(0,40)+asked.fingerprint.slice(0,16))),true);
      return {...asked,card:cards.find(card=>card.kind==='card'&&card.id===asked.id)!.text as string};
    };
    /** Without start, the receipt is one the host writes when its start was refused. */
    const ran=async(id:string,state:string,result:Record<string,unknown>,start=true)=>{
      const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
      const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});
      const b={id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
      assert.equal((await s.controlledExecution.claim(b)).claimed,true);if(start)assert.deepEqual(await s.controlledExecution.start(b),{started:true});
      await s.controlledExecution.finish({...b,state,result});
    };
    /** The card edit runs after the receipt commits, without holding it up. */
    const ending=async(id:string,line:string)=>{
      for(let tries=0;tries<100&&!cards.some(card=>card.kind==='settle'&&card.id===id&&card.text.endsWith(line));tries++)await new Promise(resolve=>setTimeout(resolve,50));
      return cards.filter(card=>card.kind==='settle'&&card.id===id).at(-1)!.text as string;
    };
    const finished=await approvedTool('made-up-done');await ran(finished.id,'done',{stdout:'made-up output',exit_code:0});
    assert.equal(await ending(finished.id,'✅ Approved and done.'),finished.card+'\n\n✅ Approved and done.');
    const signIn=await approvedTool('made-up-sign-in');await ran(signIn.id,'failed',{exit_code:1,error:'notion_reconnect_needed',text:'SECRET-RESULT'});
    const unsentCard=await ending(signIn.id,'Sign in to Notion again in the dashboard.');
    assert.equal(unsentCard,signIn.card+'\n\n🚫 It did not run: Sign in to Notion again in the dashboard.','nothing is sent without a sign-in');
    assert.doesNotMatch(unsentCard,/SECRET-RESULT/);
    const refused=await approvedTool('made-up-refused');await ran(refused.id,'failed',{exit_code:1,error:'tool_reported_error',response:{isError:true}});
    assert.equal(await ending(refused.id,'Ask Nocheh what went wrong.'),refused.card+'\n\n⚠️ Approved, but it failed: the service answered with an error. Ask Nocheh what went wrong.');
    const unknown=await approvedTool('made-up-unknown');await ran(unknown.id,'failed',{exit_code:1,error:'made_up_remote_text'});
    assert.equal(await ending(unknown.id,'see the dashboard Inbox.'),unknown.card+'\n\n⚠️ Approved, but it failed: see the dashboard Inbox.','an unknown code shows no text of its own');
    const noSandbox=await approvedTool('made-up-no-sandbox');await ran(noSandbox.id,'failed',{exit_code:1,error:'tool_sandbox_missing'});
    const sandboxLine='🚫 It did not run: the tool sandbox is not installed on this computer. Run ./bin/nocheh up, or start make dev again, to install it.';
    assert.equal(await ending(noSandbox.id,sandboxLine),noSandbox.card+'\n\n'+sandboxLine,'without the sandbox image nothing was sent');
    const unsure=await approvedTool('made-up-unsure');await ran(unsure.id,'ambiguous',{error:'execution_outcome_unconfirmed'});
    const unsureLine='⚠️ Approved, but Nocheh could not confirm that it finished. Check before you ask again.';
    assert.equal(await ending(unsure.id,unsureLine),unsure.card+'\n\n'+unsureLine);
    const refusedStart=await approvedTool('made-up-start-refused');await ran(refusedStart.id,'failed',{exit_code:1,error:'security_start_denied'},false);
    const changedLine='🚫 It did not run: something it used changed after it was asked. Ask again if you still want it.';
    assert.equal(await ending(refusedStart.id,changedLine),refusedStart.card+'\n\n'+changedLine,'an operation never started did not run');
    // Edits of one card run in order: an edit that read an earlier state never lands last.
    const raced=await approvedTool('made-up-race');let release=()=>{};
    const paused=new Promise<void>(resolve=>{reached=resolve;});hold=new Promise<void>(resolve=>{release=resolve;});
    const first=s.actionCommands.settle('controlled',raced.id);await paused;
    await ran(raced.id,'done',{exit_code:0});
    // Unordered, the edit after the end would land in this pause, before the held one.
    for(let tries=0;tries<20&&!cards.some(card=>card.kind==='settle'&&card.id===raced.id&&card.text.endsWith('done.'));tries++)await new Promise(resolve=>setTimeout(resolve,50));
    release();await first;
    assert.equal(await ending(raced.id,'✅ Approved and done.'),raced.card+'\n\n✅ Approved and done.');
    // A card for an operation that a scheduled task asked for says so, and its agent does not wait for it.
    const trigger=await s.operations.record({key:key+':schedule',kind:'scheduled_trigger',scope:group,input_hash:digest('made-up schedule')});
    const current=await s.guards.state(),scheduled:Reader={admin:false,scope:group,space:group,turnEvent:trigger.id,generation:current.generation,
      guard_epoch:current.epoch,revision:current.epoch,logical_profile:'fixture-schedule'};
    await s.turns.register(scheduled,{logical_profile:'fixture-schedule'});
    const fromSchedule=await s.actionCommands.offer('controlled',await s.controlledActions.propose(scheduled,{kind:'shell',arguments:{command:'printf made-up-schedule'}}));
    assert.equal(fromSchedule.state,'proposed');assert.deepEqual([last('card').id,last('card').chat_id],[fromSchedule.id,'123']);
    assert.match(last('card').text,/^⚙️ Run shell\n💬 Asked in a scheduled task\n\n\{/);assert.match(fromSchedule.message,/Do not wait for it/);
    // A waiting card whose guarded copy changes before it is approved did not run, and says why.
    const outdated=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor((await message('made-up-outdated')).id,group),{kind:'shell',arguments:{command:'printf outdated'}}));
    const stored=await s.controlledActions.row(outdated.id),copy=await s.guards.read('derived_artifacts:'+stored.proposal_reference.id,await s.guards.state());
    await s.guards.edit('derived_artifacts:'+stored.proposal_reference.id,copy.revision,{...copy.value as any,text:JSON.stringify({command:'printf edited'})},key+':outdated');
    const notRun='🚫 It did not run: something it used changed after it was asked. Ask again if you still want it.';
    assert.equal(await s.actionCommands.callback(await press('outdated-approve','na'+outdated.id.slice(0,40)+outdated.fingerprint.slice(0,16))),true);
    assert.equal(last('answer').text,notRun,'the press says it cannot run');
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[outdated.id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});
    assert.equal((await s.controlledExecution.claim({id:outdated.id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token})).claimed,false);
    assert.equal(await ending(outdated.id,notRun),cards.find(card=>card.kind==='card'&&card.id===outdated.id)!.text+'\n\n'+notRun);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
