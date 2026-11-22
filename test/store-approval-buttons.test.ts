import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {chatRowForTest} from './fixture-seeded-chats.js';
import {accountIdFor,chatShortId,installChatsForTest} from '../src/chats.js';
import {BOB,BOB_CHAT,GP1,GP3,OWNER,P1,P2,fixtureChats,fixtureDirectory,seedChats,seedGroups} from './fixture-groups.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {setOwnerGroupToolsForTest} from '../src/stores/controlled-actions.js';
import {grantMembers,type GroupGrants} from './fixture-member-grants.js';

test('allowed members post freely in their own group; everything else waits for the owner\'s button in their private chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-approval-buttons-')),key='approval-buttons:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[],refusals:Record<string,any>[]=[],executed:Record<string,any>[]=[];let updates=0;
  const other=group+'1',closed=group+'2',forum='-100'+Date.now();
  let topicMemory:'group'|'topic'='group';
  // When set, the next card edit waits for it, after calling reached.
  let hold:Promise<void>|null=null,reached=()=>{};
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other,closed,forum],topic_memory:topicMemory});
  // The owner's members (step 3): 9 talks in the group and the other group, and is switched off in the closed one.
  const people=grantMembers({[group]:{granted:['9']},[other]:{granted:['9']},[closed]:{granted:[],denied:['9']}},{owner:'123',groups:[forum]});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='action.execute'){executed.push(input);return {state:'done'};}
      if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
      assert.equal(operation,'telegram.approval');
      if(input.kind==='settle'&&hold){const wait=hold;hold=null;reached();await wait;}
      cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
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
    assert.deepEqual([last('card').chat_id,last('card').topic],[group,17],'by the person who asked, under their request');
    topicMemory='group';
    const across=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:other+'/topic/4',text:'For the other group'}));
    assert.equal(across.state,'proposed','a message built from one group\'s memory for another group waits for a review');
    // The person who asked, allowed in both groups, reviews it under their request in their own group and topic.
    const reviewCard=last('card');
    // A group with no name is told apart by its short id, the one the dashboard's chat list shows (ADR-0254).
    assert.deepEqual([reviewCard.chat_id,reviewCard.topic,reviewCard.text,reviewCard.links],[group,17,'📨 Send to a Telegram group (…'+chatShortId(other)+') › a topic\n\nFor the other group',[]],
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
    // The owner refreshed the other group's name (ADR-0252: on its chats row).
    await chatRowForTest(stores.control,other,{title:'Design team',is_forum:true});
    assert.deepEqual((await s.telegramActions.destinations(await actor(topic.id,group+'/topic/17'))).groups,
      [{destination:group,name:null,current:true},{destination:other,name:'Design team',current:false}],'only the groups where the person asking is allowed');
    // A later update renaming the group does not rename it here until the owner refreshes again, as before step 2b.
    await stores.control.query(`UPDATE chats SET title='Design',title_source='observed' WHERE id=$1`,[other]);
    assert.equal((await s.telegramActions.destinations(await actor(topic.id,group+'/topic/17'))).groups[1]!.name,'Design team');
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
    // The kind of chat is in fixed words; only the names are quoted, inside isolates (ADR-0254).
    const plans='\u2068“Plans team”\u2069',launch='\u2068“Launch”\u2069';
    assert.deepEqual([last('card').chat_id,last('card').reply_to,last('card').text,last('card').links],['123','12',`📨 Send to group ${plans} › topic ${launch}\n\nHello forum`,
      [{offset:17,length:14,url:`https://t.me/c/${internal}/30`},{offset:40,length:10,url:`https://t.me/c/${internal}/7`}]]);
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
    assert.equal(last('card').text,`📨 Send to group ${plans} › General\n\nHello General`,'a message to a forum without a topic goes to General');
    await stores.control.query("UPDATE owner_prompts SET texts='{\"telegram.approval_texts\":\"topic: in {topic}\"}'::jsonb WHERE singleton");
    await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(ask.id,'123'),scope:null},{destination:forum+'/topic/9',text:'Hello unknown'}));
    assert.deepEqual([last('card').text,last('card').links.at(-1)],[`📨 Send to group ${plans} in a topic\n\nHello unknown`,{offset:35,length:7,url:`https://t.me/c/${internal}/9`}],
      'the owner\'s wording; a topic with no known name is still linked');
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    // Under the freedom setting the owner's private request for a group or topic still shows its card first, as the
    // reply, naming the group and topic with the exact text; only the owner's own chat goes without one (ADR-0244).
    const freedom=await s.ownerAutonomy.get(owner);
    const freed=await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:freedom.revision,operation_id:key+':freedom'});
    const freeAsk=await capture('owner-free',{message:{message_id:14,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'Post the plan in Launch'}},'123');
    const shown=()=>cards.filter(card=>card.kind==='card').length,shownBefore=shown();
    const free=await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(freeAsk.id,'123'),scope:null},{destination:forum+'/topic/7',text:'Free plan'}));
    assert.equal(free.state,'proposed','freedom never posts to a group without its card');assert.equal(shown(),shownBefore+1,'one card');
    assert.deepEqual([last('card').id,last('card').chat_id,last('card').reply_to,last('card').text],[free.id,'123','14',`📨 Send to group ${plans} › topic ${launch}\n\nFree plan`]);
    assert.match(free.message,/return \[NO_REPLY\]/);
    const freeGeneral=await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(freeAsk.id,'123'),scope:null},{destination:forum,text:'Free general'}));
    assert.equal(freeGeneral.state,'proposed');assert.equal(shown(),shownBefore+2);
    const ownerPress=(label:string,data:string)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:123},chat_instance:'1',data,
      message:{message_id:40,date:1700000000,chat:{id:123,type:'private'},reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}},'123');
    assert.equal(await s.actionCommands.callback(await ownerPress('free-reject','nd'+freeGeneral.id.slice(0,40)+freeGeneral.fingerprint.slice(0,16))),true);
    assert.equal((await s.telegramActions.inspect(owner,freeGeneral.id)).state,'rejected','Reject sends nothing');
    assert.equal(executed.filter(item=>item.id===free.id||item.id===freeGeneral.id).length,0,'nothing reaches the group before Approve');
    assert.equal(await s.actionCommands.callback(await ownerPress('free-approve','na'+free.id.slice(0,40)+free.fingerprint.slice(0,16))),true);
    assert.equal((await s.telegramActions.inspect(owner,free.id)).state,'approved');
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(free.id,await epoch('actions'))).state,'completed');
    assert.deepEqual(executed.filter(item=>item.id===free.id).map(item=>[item.destination,item.text]),[[forum+'/topic/7','Free plan']],'Approve sends it once');
    const toSelf=await s.actionCommands.offer('telegram',await s.telegramActions.request({...await actor(freeAsk.id,'123'),scope:null},{destination:'123',text:'Free note'}));
    assert.equal(toSelf.state,'approved','a message to the owner\'s own chat needs no card');assert.equal(shown(),shownBefore+2);
    await s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:freed.revision,operation_id:key+':freedom-off'});
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
    // A card that offers a chat rule names the topic too, and says above its buttons that the rule covers everyone there.
    const note='\n\n👥 “Where asked” covers you and every member who can talk in that chat or topic, not only the person who asked.';
    // A web read's rule also says what it lets Nocheh open without asking (ADR-0263).
    const site='\n\n🔓 “Always allow this site” lets Nocheh open any page there without asking, including addresses that carry short pieces of your data.';
    assert.equal(last('card').chat_id,'123');assert.equal(last('card').text,'⚙️ Run a command\n💬 Asked in a Telegram group › General\n\nprintf ok'+note);
    assert.deepEqual(last('card').links,[{type:'bold',offset:3,length:13},{type:'pre',offset:last('card').text.indexOf('printf ok'),length:9}],'the name is bold, the command is code');assert.match(tool.message,/asked the owner/);
    assert.match(tool.message,/the answer will follow here/,'an operation answers later in the chat that asked');
    // A member's web page read runs under the group's tools permission, with no card (step 3).
    const toolCards=cards.length,memberRead=await s.controlledActions.propose(await actor(plain.id,group),{kind:'browser',arguments:{url:'https://example.test/member'}});
    assert.equal(memberRead.state,'approved');assert.equal(cards.length,toolCards,'no card');
    // The asker's summary leads the card and the exact fields fold under it; a command stays open in code (ADR-0224). The
    // owner's own page read gets its card while the switch for those is off.
    const ownerTools=setOwnerGroupToolsForTest(false);
    try{await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(ownerTurn.id,group),{kind:'browser',arguments:{url:'https://example.test/made-up'},summary:'Read the made-up page.'}));}
    finally{ownerTools();}
    // A web address is all a page read sends, so it shows open under the summary, which says it is the AI's (ADR-0250).
    const opened=last('card');
    assert.equal(opened.text,'⚙️ Open a web page · example.test\n📝 AI says: Read the made-up page.\n💬 Asked in a Telegram group › General\n\nhttps://example.test/made-up'+site+note);
    assert.deepEqual(opened.links,[{type:'bold',offset:3,length:30}]);
    await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(plain.id,group),{kind:'shell',arguments:{command:'printf said'},summary:'Print a word.'}));
    assert.equal(last('card').text,'⚙️ Run a command\n📝 AI says: Print a word.\n💬 Asked in a Telegram group › General\n\nprintf said'+note);
    // When the owner asks in the group, the reply tells them their card is in their private chat.
    const own=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(ownerTurn.id,group),{kind:'shell',arguments:{command:'printf mine'}}));
    assert.equal(last('card').chat_id,'123');assert.match(own.message,/The person who asked is the owner, so the decision is theirs:.*answer them as "you", briefly: their card is waiting in their private chat, and the answer will follow here\. Do not say it waits for the owner or anyone else/);
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
    // Hidden characters written out can make a short command too long for a card: it waits in the Inbox, and the model is told.
    const shownCards=cards.length,hiding=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(plain.id,group),{kind:'shell',arguments:{command:'printf '+'\u00a0'.repeat(1000)}}));
    assert.equal(cards.length,shownCards,'no card');assert.match(hiding.message,/too long for a Telegram card[^]*dashboard Inbox/);
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
    // Someone not allowed in the group gets the owner's fixed reply, with no turn, at most once a day there (`once`).
    const stranger=await message('stranger-ask',{text:'Nocheh, what is the plan?',message_thread_id:17,is_topic_message:true},8,++updates);
    await s.preparation.run(stranger.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    assert.equal((await s.telegram.run(stranger.id,await epoch('telegram'))).state,'skipped');
    // Nocheh decided the message addressed the bot, so the bot gets only what it sends.
    assert.deepEqual({...refusals.at(-1),event_id:undefined},{event_id:undefined,chat_id:group,message_id:refusals.at(-1)!.message_id,topic:'17',user_id:'8',
      once:'not_allowed',reply:'Sorry, in this group I only work with the owner and the owner\'s members.'});
    await stores.control.query(`UPDATE owner_prompts SET texts='{"telegram.not_allowed":"Only members, please."}'::jsonb WHERE singleton`);
    const edited=await message('stranger-again',{text:'Nocheh?'},8,++updates);
    await s.preparation.run(edited.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    await s.telegram.run(edited.id,await epoch('telegram'));
    assert.equal(refusals.at(-1)!.reply,'Only members, please.','the owner\'s own wording is used');
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
    const sent=cards.length,quiet=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
      runtime:async(operation)=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime unavailable');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
    const waiting=await quiet.actionCommands.offer('telegram',await quiet.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Waits for the Inbox'}));
    assert.equal(waiting.state,'proposed');assert.match(waiting.message,/^Owner approval is required/);assert.equal(cards.length,sent);

    // Once an approved operation ends, its card says how, with a reason only from fixed codes in the owner's wording.
    await stores.control.query(`UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton`,[JSON.stringify({'telegram.approval_texts':'reason_sign_in: Sign in to Notion again in the dashboard.'})]);
    const approvedTool=async(label:string,request:Record<string,unknown>={kind:'shell',arguments:{command:'printf '+label}},from=9)=>{
      const asked=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor((await message(label,{},from)).id,group),request));
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
    // The owner's word on it edits the card; a page read that started and got no answer closes itself (ADR-0218).
    await s.controlledActions.resolve(owner,{id:unsure.id,fingerprint:unsure.fingerprint,outcome:'ran'});await s.actionCommands.settle('controlled',unsure.id);
    assert.equal(await ending(unsure.id,'You marked that it ran.'),unsure.card+'\n\n✅ Approved. You marked that it ran.');
    // A page read with a card: the owner's own, while the switch for those is off (a member's runs with no card, step 3).
    const ownerReads=setOwnerGroupToolsForTest(false);
    const read=await approvedTool('made-up-read',{kind:'browser',arguments:{url:'https://example.com/made-up-read'}},123);
    await ran(read.id,'ambiguous',{error:'execution_outcome_unconfirmed'});
    const readLine='⚠️ Approved, but the page did not answer. A read changes nothing, so you can ask again.';
    assert.equal(await ending(read.id,readLine),read.card+'\n\n'+readLine);
    const unstarted=await approvedTool('made-up-unstarted-read',{kind:'browser',arguments:{url:'https://example.com/made-up-unstarted'}},123);ownerReads();
    await ran(unstarted.id,'ambiguous',{error:'execution_outcome_unconfirmed'},false);
    assert.equal(await ending(unstarted.id,'🚫 It did not run: see the dashboard Inbox.'),unstarted.card+'\n\n🚫 It did not run: see the dashboard Inbox.',
      'a read that never started did not run, so it is not called unanswered');
    const unclearSend=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor((await message('made-up-unclear-send')).id,group),{destination:'123',text:'Unclear send'}));
    await stores.control.query("UPDATE telegram_action_requests SET state='ambiguous',error_code='delivery_unconfirmed' WHERE id=$1",[unclearSend.id]);
    await s.telegramActions.resolve(owner,{id:unclearSend.id,fingerprint:unclearSend.fingerprint,outcome:'ran'});await s.actionCommands.settle('telegram',unclearSend.id);
    assert.equal(last('settle').id,unclearSend.id);assert.match(last('settle').text,/\n\n✅ Approved\. You marked that it was sent\.$/,'a message card says sent, not ran');
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
    // Its rule would cover the chat it runs for, so the card names that chat.
    assert.match(last('card').text,/^⚙️ Run a command\n💬 Asked in a scheduled task in a Telegram group › General\n\n\S/);assert.ok(last('card').text.endsWith(note));
    assert.match(fromSchedule.message,/Do not wait for it/);
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
  }finally{people();await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a send to a person\'s private chat names it in fixed words and quotes only names; a chat Nocheh stopped serving gets nothing and its card says why',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-send-cards-')),key='send-cards:'+Date.now();
  // The fixture's chats, GP1 and GP3 served (ADR-0252), installed before the services so they keep them; Bob's private chat
  // is known, and served only while the owner allows him in a served group (ADR-0254).
  const restore=installChatsForTest(fixtureDirectory([GP1,GP3]));
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[],executed:Record<string,any>[]=[];let updates=0,sent=100;
  // The owner's members (step 3): Bob reaches GP1; a test changes them as the owner would.
  let people=grantMembers({[GP1]:{granted:[BOB]}},{owner:OWNER,groups:[GP3]});
  const members=(grants:GroupGrants)=>{people();people=grantMembers(grants,{owner:OWNER,groups:[GP1,GP3]});};
  const policy=()=>({enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[GP1,GP3],topic_memory:'group' as const});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='action.execute'){executed.push(input);return {state:'done'};}
      if(operation==='telegram.notice')return {state:'done'};
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-9);
  const capture=async(label:string,payload:Record<string,unknown>,scope:string)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:'',payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const said=(text:string,from=Number(OWNER),chat:Record<string,unknown>={id:Number(OWNER),type:'private'})=>({message:{message_id:++sent,date:1700000000,chat,from:{id:from,first_name:'Made-up'},text}});
  // The owner asks in their private chat for a message to `destination`; its card comes to them there.
  const send=async(label:string,destination:string,text:string)=>s.actionCommands.offer('telegram',
    await s.telegramActions.request(await actor((await capture(label,said('Please send it'),OWNER)).id,null,OWNER),{destination,text}));
  const ownerPress=(label:string,data:string)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:Number(OWNER)},chat_instance:'1',data,
    message:{message_id:40,date:1700000000,chat:{id:Number(OWNER),type:'private'},reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}},OWNER);
  const button=(choice:'a'|'d',action:{id:string;fingerprint:string})=>'n'+choice+action.id.slice(0,40)+action.fingerprint.slice(0,16);
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const bob='⁨“Bob”⁩',gp1='⁨“GP1”⁩',notServed='🚫 Approved, but not sent: Nocheh does not serve that chat now.';
  try {
    await seedChats(stores.control,fixtureChats([GP1,GP3]));await seedGroups(stores.control);
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    await s.guards.reconcile();await s.guards.setMode('on');
    // A person the owner allowed in a served group: the card names the kind of chat and the group in fixed words, and quotes
    // only the names, bold where Telegram has no link to them.
    const hello=await send('hello',BOB_CHAT,'Hello Bob');
    assert.equal(hello.state,'proposed','a person\'s private chat always waits for the owner\'s card');
    const helloCard=last('card');
    assert.deepEqual([helloCard.id,helloCard.chat_id,helloCard.text],[hello.id,OWNER,`📨 Send to private chat with ${bob} (a member in group ${gp1})\n\nHello Bob`]);
    assert.deepEqual(helloCard.links.map((link:any)=>link.type),['bold','bold']);
    assert.equal(await s.actionCommands.callback(await ownerPress('hello-approve',button('a',hello))),true);
    assert.equal(last('answer').text,'✅ Approved.');
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(hello.id,await epoch('actions'))).state,'completed');
    assert.deepEqual([executed.at(-1)!.chat_id,executed.at(-1)!.destination,executed.at(-1)!.text],[BOB,BOB_CHAT,'Hello Bob'],'sent to Bob\'s private chat in Telegram');
    assert.equal(last('settle').text,helloCard.text+'\n\n✅ Approved and sent.');
    // Allowed in two served groups: the first is named, with how many more.
    members({[GP1]:{granted:[BOB]},[GP3]:{granted:[BOB]}});
    await send('twice',BOB_CHAT,'Hello again');
    assert.equal(last('card').text,`📨 Send to private chat with ${bob} (a member in group ${gp1} and 1 more)\n\nHello again`);
    // A served group renamed to read like Bob: his name gets his chat's short id, and the group's gets its project on the
    // owner's card, but only its short id on a card in a group.
    await stores.control.query("UPDATE chats SET title='Bob' WHERE id=$1",[GP3]);
    await send('twin',BOB_CHAT,'Hello twin');
    assert.equal(last('card').text,`📨 Send to private chat with ${bob} (…${chatShortId(BOB_CHAT)}) (a member in group ${gp1} and 1 more)\n\nHello twin`);
    const twinGroup=await send('twin-group',GP3,'For the twin group');
    assert.equal(last('card').text,`📨 Send to group ${bob} of project ⁨“P1”⁩\n\nFor the twin group`);
    const asked=await capture('bob-asks',said('Post it in the other group',Number(BOB),{id:Number(GP1),type:'supergroup'}),GP1);
    const across=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(asked.id,GP1,GP1),{destination:GP3,text:'From GP1'}));
    assert.equal(across.state,'proposed');
    assert.deepEqual([last('card').chat_id,last('card').text],[GP1,`📨 Send to group ${bob} (…${chatShortId(GP3)})\n\nFrom GP1`],'a card in a group names no project');
    // Two served groups of one project that read alike: the project tells neither apart, so the owner's card gives each its
    // short id; a project of another name tells them apart, and one whose name reads alike does not.
    await stores.control.query("UPDATE chats SET title='GP1' WHERE id=$1",[GP3]);
    await send('alike-gp3',GP3,'To the look-alike');
    assert.equal(last('card').text,`📨 Send to group ${gp1} (…${chatShortId(GP3)})\n\nTo the look-alike`);
    await send('alike-gp1',GP1,'To the first');
    assert.equal(last('card').text,`📨 Send to group ${gp1} (…${chatShortId(GP1)}) › General\n\nTo the first`);
    await stores.control.query('UPDATE project_assignments SET project_id=$2 WHERE space_id=$1',[GP1,P2]);
    await send('apart',GP3,'In another project');
    assert.equal(last('card').text,`📨 Send to group ${gp1} of project \u2068“P1”\u2069\n\nIn another project`);
    await stores.control.query("UPDATE projects SET name='p1' WHERE id=$1",[P2]);
    await send('alike-project',GP3,'In a project named alike');
    assert.equal(last('card').text,`📨 Send to group ${gp1} (…${chatShortId(GP3)})\n\nIn a project named alike`);
    await stores.control.query("UPDATE projects SET name='P2' WHERE id=$1",[P2]);
    await stores.control.query('UPDATE project_assignments SET project_id=$2 WHERE space_id=$1',[GP1,P1]);
    await stores.control.query("UPDATE chats SET title='GP3' WHERE id=$1",[GP3]);
    // With no title on his chat: the name Telegram gave him, its quotes and brackets made plain; a blank name gives way to
    // his @username, linked to him; with neither, his chat's short id.
    const untitled=fixtureChats([GP1,GP3]),account=accountIdFor('telegram',BOB);
    installChatsForTest({...untitled,chats:untitled.chats.map(chat=>chat.id===BOB_CHAT?{...chat,title:null}:chat)});
    await stores.control.query('UPDATE chat_accounts SET display_name=$2,username=NULL WHERE id=$1',[account,'Sara" (x']);
    await send('display-name',BOB_CHAT,'Hello Sara');
    assert.equal(last('card').text,`📨 Send to private chat with ⁨“Sara' [x”⁩ (a member in group ${gp1} and 1 more)\n\nHello Sara`);
    await stores.control.query('UPDATE chat_accounts SET display_name=$2,username=$3 WHERE id=$1',[account,'ㅤ','sara_example']);
    await send('username',BOB_CHAT,'Hello username');
    const linkedCard=last('card');
    assert.equal(linkedCard.text,`📨 Send to private chat with ⁨“@sara_example”⁩ (a member in group ${gp1} and 1 more)\n\nHello username`);
    assert.deepEqual(linkedCard.links[0],{offset:linkedCard.text.indexOf('⁨“@'),length:17,url:'https://t.me/sara_example'});
    await stores.control.query('UPDATE chat_accounts SET display_name=NULL,username=NULL WHERE id=$1',[account]);
    await send('nameless',BOB_CHAT,'Hello nobody');
    assert.equal(last('card').text,`📨 Send to private chat with a person …${chatShortId(BOB_CHAT)} (a member in group ${gp1} and 1 more)\n\nHello nobody`);
    installChatsForTest(fixtureDirectory([GP1,GP3]));
    // The message shows what a reader would not see, written out.
    await send('hidden',BOB_CHAT,'Hi \u{e0041}');
    assert.ok(last('card').text.endsWith('\n\nHi [U+E0041]'),last('card').text);
    // A card too long with the owner's long person line names Bob alone; one too long even so waits in the Inbox.
    members({[GP1]:{granted:[BOB]}});
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',
      [JSON.stringify({'telegram.approval_texts':'person_chat: private chat with {name}, a member in {group}'+', who may read this'.repeat(20)})]);
    const long='x'.repeat(3500),compact=await send('compact',BOB_CHAT,long);
    assert.deepEqual([last('card').id,last('card').text],[compact.id,`📨 Send to private chat with ${bob}\n\n${long}`]);
    // A name that reads like another's keeps its short id there: the compact line drops only the groups.
    await stores.control.query("UPDATE chats SET title='Bob' WHERE id=$1",[GP3]);
    await send('compact-twin',BOB_CHAT,long);
    assert.equal(last('card').text,`📨 Send to private chat with ${bob} (…${chatShortId(BOB_CHAT)})\n\n${long}`);
    await stores.control.query("UPDATE chats SET title='GP3' WHERE id=$1",[GP3]);
    const shown=cards.length,hidden=await send('too-long',BOB_CHAT,'x'.repeat(3000)+'​'.repeat(100));
    assert.equal(cards.length,shown,'no card');assert.match(hidden.message,/too long for a Telegram card[^]*dashboard Inbox/);
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    // Approved, then the owner stopped allowing Bob before it went out: nothing is sent, and the card says why.
    const late=await send('late',BOB_CHAT,'Bye Bob');
    assert.equal(await s.actionCommands.callback(await ownerPress('late-approve',button('a',late))),true);
    members({});const sends=executed.length;
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(late.id,await epoch('actions'))).state,'cancelled');
    assert.equal(executed.length,sends,'nothing reaches a chat Nocheh stopped serving');
    assert.deepEqual([last('settle').id,last('settle').text],[late.id,`📨 Send to private chat with ${bob}\n\nBye Bob\n\n${notServed}`]);
    // Approved after a settings change that still serves his chat: the press, /approve and the card say something it used
    // changed, the send is closed with its approval kept, and nothing goes out.
    members({[GP1]:{granted:[BOB]}});
    const moved=await send('moved',BOB_CHAT,'Before a change'),movedTyped=await send('moved-typed',BOB_CHAT,'Typed before a change');
    members({[GP1]:{granted:[BOB]},[GP3]:{granted:[BOB]}});
    const before=(await s.guards.state()).epoch;await s.configuration.configure(policy(),'on');
    assert.ok((await s.guards.state()).epoch>before,'the settings change moved the epoch');
    const changedSend='🚫 Approved, but not sent: something it used changed after it was asked. Ask again if you still want it.',movedSends=executed.length;
    assert.equal(await s.actionCommands.callback(await ownerPress('moved-approve',button('a',moved))),true);
    assert.equal(last('answer').text,changedSend);
    assert.deepEqual([(await s.telegramActions.inspect(owner,moved.id)).state,(await s.telegramActions.inspect(owner,moved.id)).error_code],['cancelled','action_context_changed']);
    assert.deepEqual([last('settle').id,last('settle').text],
      [moved.id,`📨 Send to private chat with ${bob} (a member in group ${gp1} and 1 more)\n\nBefore a change\n\n${changedSend}`]);
    assert.equal(await s.actionCommands.controlReply(await capture('moved-command',said('/approve '+movedTyped.id),OWNER)),changedSend);
    assert.equal((await s.telegramActions.inspect(owner,movedTyped.id)).state,'cancelled');
    assert.equal(executed.length,movedSends,'nothing is sent after the change');
    // Approved after he was no longer allowed: the press and /approve both say it was not sent, and why.
    members({[GP1]:{granted:[BOB]}});
    const gone=await send('gone',BOB_CHAT,'Too late'),typed=await send('typed',BOB_CHAT,'By command');
    members({});
    assert.equal(await s.actionCommands.callback(await ownerPress('gone-approve',button('a',gone))),true);
    assert.equal(last('answer').text,notServed);
    assert.deepEqual([(await s.telegramActions.inspect(owner,gone.id)).state,(await s.telegramActions.inspect(owner,gone.id)).error_code],['cancelled','destination_not_served']);
    assert.deepEqual([last('settle').id,last('settle').text],[gone.id,`📨 Send to private chat with ${bob}\n\nToo late\n\n${notServed}`]);
    assert.equal(await s.actionCommands.controlReply(await capture('approve-command',said('/approve '+typed.id),OWNER)),notServed);
    // A group switched off says so wherever it is named: as where a card was asked, and as where it would have gone.
    const ownerInGp3=await capture('owner-in-gp3',said('Post this in GP1',Number(OWNER),{id:Number(GP3),type:'supergroup'}),GP3);
    const fromGp3=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(ownerInGp3.id,GP3,GP3),{destination:GP1,text:'From GP3'}));
    assert.deepEqual([fromGp3.state,last('card').text],['proposed',`📨 Send to group ${gp1} › General\n💬 Asked in “GP3”\n\nFrom GP3`]);
    installChatsForTest(fixtureDirectory([GP1]));
    assert.equal(await s.actionCommands.callback(await ownerPress('gp3-reject',button('d',fromGp3))),true);
    assert.equal(last('settle').text,`📨 Send to group ${gp1} › General\n💬 Asked in “GP3” (not served now)\n\nFrom GP3\n\n❌ Rejected. Nothing was sent.`,'the owner\'s own Reject reads as before');
    assert.equal(await s.actionCommands.callback(await ownerPress('twin-reject',button('d',twinGroup))),true);
    assert.equal(last('settle').text,'📨 Send to group ⁨“GP3”⁩ (not served now)\n\nFor the twin group\n\n❌ Rejected. Nothing was sent.');
    // A card Bob reviews in GP1 settles there, where it was posted, also once its destination is no longer served or he
    // may no longer post there; only his press needs him to be allowed now (ADR-0254).
    installChatsForTest(fixtureDirectory([GP1,GP3]));members({[GP1]:{granted:[BOB]},[GP3]:{granted:[BOB]}});
    const bobAsks=async(label:string,text:string)=>s.actionCommands.offer('telegram',await s.telegramActions.request(
      await actor((await capture(label,said('Post it in GP3',Number(BOB),{id:Number(GP1),type:'supergroup'}),GP1)).id,GP1,GP1),{destination:GP3,text}));
    const groupPress=(label:string,data:string,from:string)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:Number(from)},chat_instance:'1',data,
      message:{message_id:5,date:1700000000,chat:{id:Number(GP1),type:'supergroup'},reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}},GP1);
    const gp3='\u2068“GP3”\u2069',reviewed=await bobAsks('reviewed','Reviewed in GP1');
    assert.deepEqual([last('card').id,last('card').chat_id,last('card').text],[reviewed.id,GP1,`📨 Send to group ${gp3}\n\nReviewed in GP1`]);
    assert.equal(await s.actionCommands.callback(await groupPress('reviewed-approve',button('a',reviewed),BOB)),true);
    assert.equal((await s.telegramActions.inspect(owner,reviewed.id)).state,'approved','Bob approves his own card in GP1');
    installChatsForTest(fixtureDirectory([GP1]));const reviewedSends=executed.length;
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(reviewed.id,await epoch('actions'))).state,'cancelled');
    assert.equal(executed.length,reviewedSends,'nothing reaches a group Nocheh stopped serving');
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').text],[reviewed.id,GP1,`📨 Send to group ${gp3} (not served now)\n\nReviewed in GP1\n\n${notServed}`],
      'settled in GP1, with no "Asked in" line and no project, as it was posted');
    installChatsForTest(fixtureDirectory([GP1,GP3]));
    const waiting=await bobAsks('waiting','Waits in GP1');assert.equal(last('card').chat_id,GP1);
    members({[GP1]:{granted:[BOB]}});
    assert.equal(await s.actionCommands.callback(await groupPress('waiting-bob',button('a',waiting),BOB)),true);
    assert.equal(last('answer').text,'Only the owner can approve or reject this.');
    assert.equal((await s.telegramActions.inspect(owner,waiting.id)).state,'proposed','his press decides nothing once he may not post there');
    assert.equal(await s.actionCommands.controlReply(await capture('deny-command',said('/deny '+waiting.id),OWNER)),`Action ${waiting.id} rejected.`);
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').text],[waiting.id,GP1,`📨 Send to group ${gp3}\n\nWaits in GP1\n\n❌ Rejected. Nothing was sent.`],
      'the owner\'s Reject settles the card in GP1');
    // His press on a card posted in the owner's private chat never decides it from GP1, even once he may review it.
    members({[GP1]:{granted:[BOB]}});
    const ownerCard=await bobAsks('owner-card','Asked while not allowed in GP3');assert.equal(last('card').chat_id,OWNER);
    members({[GP1]:{granted:[BOB]},[GP3]:{granted:[BOB]}});
    assert.equal(await s.actionCommands.callback(await groupPress('owner-card-bob',button('a',ownerCard),BOB)),true);
    assert.equal((await s.telegramActions.inspect(owner,ownerCard.id)).state,'proposed');
  }finally{people();restore();await stores.close();await rm(root,{recursive:true,force:true});}
});
