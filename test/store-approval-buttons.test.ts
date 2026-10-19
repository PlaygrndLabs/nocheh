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

test('Approve and Reject buttons decide only for the owner, in the request\'s group or the owner\'s private chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-approval-buttons-')),key='approval-buttons:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[];let updates=0;
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },honcho:async()=>{throw Error('no memory provider');}});
  const bot=String(Date.now()).slice(-9);
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:'',payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const message=(label:string,extra:Record<string,unknown>={})=>capture(label,{message:{message_id:Date.now(),date:1700000000,
    chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:9},text:'Please prepare a message',...extra}});
  const press=(label:string,data:string,from=123)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},message_thread_id:17,is_topic_message:true}}});
  const actor=async(source:string,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:group,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const topic=await message('topic',{message_thread_id:17,is_topic_message:true});
    const here=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(topic.id,group+'/topic/17'),{destination:'current',text:'Exact group message'}));
    const card=last('card');
    assert.deepEqual([card.chat_id,card.topic,card.id],[group,'17',here.id],'an action that stays in the group gets its card in the same topic');
    assert.equal(card.text,'Send this message to this chat?\n\nExact group message');
    assert.deepEqual(card.buttons,[['Approve','na'+here.id.slice(0,40)+here.fingerprint.slice(0,16)],['Reject','nd'+here.id.slice(0,40)+here.fingerprint.slice(0,16)]]);
    assert.ok(card.buttons.every((pair:string[])=>Buffer.byteLength(pair[1]!)<=64));
    assert.match(here.message,/posted in this chat; only the owner can press them/);
    const plain=await message('plain');
    const elsewhere=await s.actionCommands.offer('telegram',await s.telegramActions.request(await actor(plain.id,group),{destination:'123',text:'Exact private message'}));
    assert.deepEqual([last('card').chat_id,last('card').topic],['123',undefined],'an action for another chat gets its card in the owner\'s private chat');
    assert.match(elsewhere.message,/sent to the owner's private chat/);
    const approve='na'+here.id.slice(0,40)+here.fingerprint.slice(0,16);
    assert.equal(await s.actionCommands.callback(await press('stranger',approve,9)),true);
    assert.equal(last('answer').text,'Only the owner can approve or reject this.');
    assert.equal((await s.telegramActions.inspect(owner,here.id)).state,'proposed','a member\'s press decides nothing');
    assert.equal(await s.actionCommands.callback(await press('changed','na'+here.id.slice(0,40)+'0'.repeat(16))),true);
    assert.match(last('answer').text,/changed or no longer exists/);
    assert.equal((await s.telegramActions.inspect(owner,here.id)).state,'proposed','a card for other content decides nothing');
    assert.equal(await s.actionCommands.callback(await press('unrelated','some-other-button')),false,'another button is not an approval');
    const pressed=await press('owner',approve);
    assert.equal(await s.actionCommands.callback(pressed),true);
    assert.equal((await s.telegramActions.inspect(owner,here.id)).state,'approved');
    assert.equal(last('answer').text,'Approved.');
    assert.deepEqual([last('settle').id,last('settle').chat_id,last('settle').text],[here.id,group,card.text+'\n\nApproved. Sending now.']);
    assert.equal(await s.actionCommands.callback(pressed),true);assert.equal(last('answer').text,'Approved.','a repeated delivery of one press is one decision');
    // A press reaching the reply workflow is handled there and never becomes a turn.
    const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
    await s.preparation.run(pressed.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    assert.equal((await s.telegram.run(pressed.id,await epoch('telegram'))).state,'skipped');
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[pressed.id])).rows[0],{state:'suppressed',error_code:'approval_button'});
    assert.equal(await s.actionCommands.callback(await press('reject-late','nd'+here.id.slice(0,40)+here.fingerprint.slice(0,16))),true);
    assert.match(last('answer').text,/already decided/);assert.equal((await s.telegramActions.inspect(owner,here.id)).state,'approved');
    assert.equal(await s.actionCommands.callback(await press('reject','nd'+elsewhere.id.slice(0,40)+elsewhere.fingerprint.slice(0,16))),true);
    assert.equal((await s.telegramActions.inspect(owner,elsewhere.id)).state,'rejected');
    assert.equal(last('settle').text,'Send this message to your private chat?\n\nExact private message\n\nRejected. Nothing was sent.');
    // A controlled action from a group turn shows its exact arguments in that group.
    const tool=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(plain.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(last('card').chat_id,group);assert.match(last('card').text,/^Allow this shell\?\n\n\{/);assert.match(tool.message,/only the owner can press them/);
    assert.equal(await s.actionCommands.callback(await press('tool','na'+tool.id.slice(0,40)+tool.fingerprint.slice(0,16))),true);
    assert.equal((await s.controlledActions.inspect(owner,tool.id)).state,'approved');assert.match(last('settle').text,/\n\nApproved\.$/);
    // A standing permission runs the same operation without a decision, so no buttons are offered.
    await s.controlledActions.grant(owner,{action_id:tool.id,fingerprint:tool.fingerprint,uses:1,minutes:5});
    const again=await message('again'),offered=cards.length;
    const permitted=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(again.id,group),{kind:'shell',arguments:{command:'printf ok'}}));
    assert.equal(permitted.fingerprint,tool.fingerprint);assert.equal(cards.length,offered);assert.doesNotMatch(permitted.message,/buttons/);
    // Without a reachable runtime the request still waits for the Inbox.
    const sent=cards.length,quiet=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
      runtime:async(operation)=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime unavailable');},honcho:async()=>{throw Error('no memory provider');}});
    const waiting=await quiet.actionCommands.offer('telegram',await quiet.telegramActions.request(await actor(plain.id,group),{destination:'current',text:'Waits for the Inbox'}));
    assert.equal(waiting.state,'proposed');assert.match(waiting.message,/^Owner approval is required/);assert.equal(cards.length,sent);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
