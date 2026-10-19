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

test('allowed members post freely in their own group; everything else waits for the owner\'s button in their private chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-approval-buttons-')),key='approval-buttons:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[],refusals:Record<string,any>[]=[];let updates=0;
  const other=group+'1',closed=group+'2';
  let topicMemory:'group'|'topic'='group';
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other,closed],
    group_access:{[group]:{granted:['9'],denied:[]},[other]:{granted:['9'],denied:[]},[closed]:{granted:[],denied:['9']}},topic_memory:topicMemory});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='action.execute')return {state:'done'};
      if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
      assert.equal(operation,'telegram.approval');cards.push(input);
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
    message:{message_id:5,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},message_thread_id:17,is_topic_message:true}}});
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
    assert.deepEqual([reviewCard.chat_id,reviewCard.topic,reviewCard.text],[group,'17','Send this message to a Telegram group (a topic)?\n\nFor the other group']);
    assert.match(across.message,/posted here with Approve and Reject buttons for the person who asked/);
    const reviewApprove='na'+across.id.slice(0,40)+across.fingerprint.slice(0,16);
    assert.equal(await s.actionCommands.callback(await press('other-member',reviewApprove,8)),true);
    assert.equal(last('answer').text,'Only the person who asked or the owner can approve or reject this.');
    assert.equal((await s.telegramActions.inspect(owner,across.id)).state,'proposed','another member\'s press decides nothing');
    assert.equal(await s.actionCommands.callback(await press('requester',reviewApprove,9)),true);
    assert.equal((await s.telegramActions.inspect(owner,across.id)).state,'approved','the person who asked approves their own cross-group message');
    assert.deepEqual([last('settle').chat_id,last('settle').text],[group,reviewCard.text+'\n\nApproved. Sending now.']);
    const ownerAcross=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor((await message('owner-across',{},123)).id,group),{destination:other,text:'Owner to the other group'}));
    assert.equal(ownerAcross.state,'proposed');assert.deepEqual([last('card').chat_id,last('card').topic],['123',undefined],'the owner\'s own cross-group request comes to their private chat');
    const shutAcross=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:closed,text:'Not allowed there'}));
    assert.equal(shutAcross.state,'proposed');assert.equal(last('card').chat_id,'123','a group where the person asking is not allowed goes to the owner');
    await stores.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at)
      VALUES($1,'available','supergroup','Design team',NULL,true,NULL,now()) ON CONFLICT DO NOTHING`,[other]);
    assert.deepEqual((await s.telegramActions.destinations(await actor(topic.id,group+'/topic/17'))).groups,
      [{destination:group,name:null,current:true},{destination:other,name:'Design team',current:false}],'only the groups where the person asking is allowed');
    await assert.rejects(s.telegramActions.destinations(owner),{status:403});
    const ownerTurn=await message('owner-in-group',{},123);
    assert.equal((await s.telegramActions.destinations(await actor(ownerTurn.id,group))).groups.length,3,'the owner is allowed in every group');
    // A message for another chat waits for the owner, with the card in the owner's private chat only.
    const plain=await message('plain');
    const elsewhere=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Exact private message'}));
    const card=last('card');
    assert.deepEqual([card.chat_id,card.topic,card.id],['123',undefined,elsewhere.id]);
    assert.equal(card.text,'Asked in a Telegram group.\nSend this message to your private chat?\n\nExact private message');
    assert.deepEqual(card.buttons,[['Approve','na'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16)],['Reject','nd'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16)]]);
    assert.ok(card.buttons.every((pair:string[])=>Buffer.byteLength(pair[1]!)<=64));
    assert.match(elsewhere.message,/say only, briefly, that you asked the owner; do not show the draft/);
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
    assert.equal(last('answer').text,'Approved.');
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').text],[elsewhere.id,'123',card.text+'\n\nApproved. Sending now.']);
    assert.equal(await s.actionCommands.callback(pressed),true);assert.equal(last('answer').text,'Approved.','a repeated delivery of one press is one decision');
    // A press reaching the reply workflow is handled there and never becomes a turn.
    await s.preparation.run(pressed.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    assert.equal((await s.telegram.run(pressed.id,await epoch('telegram'))).state,'skipped');
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[pressed.id])).rows[0],{state:'suppressed',error_code:'approval_button'});
    // Once the approved message is sent, the card says so.
    assert.equal((await storageWorkflowOperations(s,async()=>({})).actions!(elsewhere.id,await epoch('actions'))).state,'completed');
    assert.equal(last('settle').text,card.text+'\n\nApproved and sent.');
    assert.equal(await s.actionCommands.callback(await press('reject-late','nd'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16))),true);
    assert.match(last('answer').text,/already decided/);assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'done');
    assert.equal(await s.actionCommands.callback(await press('reject','nd'+shut.id.slice(0,40)+shut.fingerprint.slice(0,16))),true);
    assert.equal((await s.telegramActions.inspect(owner,shut.id)).state,'rejected');
    assert.match(last('settle').text,/\n\nRejected\. Nothing was sent\.$/);
    // A controlled operation from a group is never approved by the request; its card also goes to the owner.
    const tool=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(plain.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(last('card').chat_id,'123');assert.match(last('card').text,/^Asked in a Telegram group\.\nAllow this shell\?\n\n\{/);assert.match(tool.message,/asked the owner/);
    assert.equal(await s.actionCommands.callback(await press('tool','na'+tool.id.slice(0,40)+tool.fingerprint.slice(0,16))),true);
    assert.equal((await s.controlledActions.inspect(owner,tool.id)).state,'approved');assert.match(last('settle').text,/\n\nApproved\.$/);
    // A standing permission runs the same operation without a decision, so no buttons are offered.
    await s.controlledActions.grant(owner,{action_id:tool.id,fingerprint:tool.fingerprint,uses:1,minutes:5});
    const again=await message('again'),offered=cards.length;
    const permitted=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(again.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(permitted.fingerprint,tool.fingerprint);assert.equal(cards.length,offered);assert.doesNotMatch(permitted.message,/buttons/);
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
    // Without a reachable runtime the request still waits for the Inbox.
    const sent=cards.length,quiet=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
      runtime:async(operation)=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime unavailable');},honcho:async()=>{throw Error('no memory provider');}});
    const waiting=await quiet.actionCommands.offer('telegram',await quiet.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Waits for the Inbox'}));
    assert.equal(waiting.state,'proposed');assert.match(waiting.message,/^Owner approval is required/);assert.equal(cards.length,sent);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
