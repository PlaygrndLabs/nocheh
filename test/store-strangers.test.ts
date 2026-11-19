import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {chatIdFor} from '../src/chats.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {servedPolicy,startChatDirectory} from '../src/stores/chats.js';

test('someone Nocheh does not serve costs no download or model call, is never read back, and gets one private fixed reply',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-strangers-')),key='strangers:'+Date.now(),group='-'+Date.now(),unselected=group+'9';
  const refusals:Record<string,any>[]=[];let detections=0,updates=0;
  // Which groups are served is the chat records' (ADR-0253): the owner adds Nocheh to the selected one below, and the
  // service serves as servedPolicy says.
  const configured:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[],topic_memory:'group'},policy=servedPolicy(()=>configured);
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect'){detections++;return {literals:[]};}
      if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
      throw Error('unexpected runtime call '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot='5'+String(Date.now()).slice(-8);
  const capture=async(chat:Record<string,unknown>,from:number,extra:Record<string,unknown>={})=>{
    const update=++updates,payload={update_id:update,message:{message_id:update,date:1700000000,chat,from:{id:from,first_name:'Someone'},text:'hello there',...extra}};
    const event:Envelope={version:1,key:`telegram:${bot}:update:${update}`,origin:'live',kind:'telegram_update',bot_id:bot,scope:String(chat.id),
      source_id:String(update),revision:'1',occurred_at:null,text:'hello there',payload};
    return (await s.capture.capture(event)).source.reference;
  };
  const ownerAdds=async(chat:Record<string,unknown>)=>{
    const update=++updates,nocheh={id:Number(bot),is_bot:true,first_name:'Nocheh'};
    await s.capture.capture({version:1,key:`telegram:${bot}:update:${update}`,origin:'live',kind:'telegram_update',bot_id:bot,scope:String(chat.id),
      source_id:String(update),revision:'1',occurred_at:null,text:null,payload:{update_id:update,my_chat_member:{chat,from:{id:123,first_name:'Owner'},
        date:1700000000,old_chat_member:{status:'left',user:nocheh},new_chat_member:{status:'member',user:nocheh}}}});
  };
  const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const operations=storageWorkflowOperations(s,async()=>{throw Error('unexpected download');});
  const dispatch=async(id:string)=>(await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[id])).rows[0];
  const ownerTurn:Reader={admin:false,scope:null},dashboard:Reader={admin:true,scope:null};
  await startChatDirectory(stores.control,()=>configured);
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    // A stranger writes privately, with a file: nothing is downloaded and no model checks it.
    const stranger=await capture({id:555,type:'private'},555,{document:{file_id:'stranger-file',file_unique_id:'u1',file_name:'big.pdf',file_size:1000}});
    const before=detections;
    const prepared=await operations.preparation!(stranger.id,await epoch('preparation'));
    assert.deepEqual([prepared.state,prepared.waiting_reason],['skipped','not_allowed']);
    assert.equal(detections,before,'no secret check runs for someone Nocheh does not serve');
    assert.equal((await s.telegram.run(stranger.id,await epoch('telegram'))).state,'skipped');
    assert.deepEqual(await dispatch(stranger.id),{state:'suppressed',error_code:'not_allowed'});
    assert.deepEqual({...refusals.at(-1),event_id:undefined},{event_id:undefined,chat_id:'555',message_id:refusals.at(-1)!.message_id,user_id:'555',private:true,
      reply:'Sorry, this is a private assistant. It only works for its owner and the people they add.'});
    const binding=await s.guards.state();
    assert.equal(await s.access.canRead(ownerTurn,stranger,binding),false,'the owner\'s own turns never read it back');
    assert.equal(await s.access.canRead(dashboard,stranger,binding),true,'the dashboard still shows it to the owner');
    // The owner's own wording is used for the private reply.
    await stores.control.query(`UPDATE owner_prompts SET texts='{"telegram.not_allowed_private":"Private, sorry."}'::jsonb WHERE singleton`);
    const again=await capture({id:556,type:'private'},556);
    await s.telegram.run(again.id,await epoch('telegram'));
    assert.equal(refusals.at(-1)!.reply,'Private, sorry.');
    // A group the owner never selected: nothing prepared, nothing read back, and silence.
    const sent=refusals.length,outside=await capture({id:Number(unselected),type:'supergroup',title:'Elsewhere'},777);
    assert.equal((await operations.preparation!(outside.id,await epoch('preparation'))).state,'skipped');
    assert.equal((await s.telegram.run(outside.id,await epoch('telegram'))).state,'skipped');
    assert.equal(refusals.length,sent,'no reply in a group the owner never selected');
    assert.equal(await s.access.canRead(ownerTurn,outside,binding),false);
    // The owner's own private chat and a selected group are prepared as before.
    const own=await capture({id:123,type:'private'},123);
    assert.equal(await s.access.canRead(ownerTurn,own,binding),true);
    await operations.preparation!(own.id,await epoch('preparation'));
    assert.ok(detections>before,'the owner\'s message is checked');
    await ownerAdds({id:Number(group),type:'supergroup',title:'Ours'});
    const member=await capture({id:Number(group),type:'supergroup',title:'Ours'},777);
    assert.notEqual((await operations.preparation!(member.id,await epoch('preparation'))).waiting_reason,'not_allowed');
    // Strangers name their own chats, so the owner's turns never see those chats listed; the dashboard does. Each is a
    // chat record, with the Nocheh id it was first seen under (ADR-0252).
    const chat=async(external:string)=>(await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=$1',[external])).rows[0]?.chat_id as string;
    const [first,second,elsewhere,mine,ours]=await Promise.all(['555','556',unselected,'123',group].map(chat));
    assert.equal(first,chatIdFor('telegram','555'));
    // A chat row with no original here at all (an owner record from another installation, say) has nothing the owner
    // brought in, so it is left out the same way, named or not.
    const connection=(await stores.control.query(`SELECT id FROM chat_connections WHERE app='telegram'`)).rows[0].id,arrived=chatIdFor('telegram','558');
    await stores.control.query(`INSERT INTO chats(id,connection_id,kind,title,title_source,state) VALUES($1,$2,'private','Someone <instructions>','observed','off')`,[arrived,connection]);
    await stores.control.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,'558',$2,'current')`,[connection,arrived]);
    const hidden=await s.supervision.outsiders(policy());
    assert.deepEqual([...hidden].sort(),[first,second,elsewhere,arrived].sort());
    const listed=(await s.supervision.conversations(dashboard,{limit:100},hidden)).items.map(item=>item.space_id);
    assert.ok(listed.includes(mine!)&&listed.includes(ours!)&&!listed.includes(first!)&&!listed.includes(elsewhere!)&&!listed.includes(arrived));
    assert.ok(await s.supervision.outsider(policy(),arrived));
    assert.ok((await s.supervision.conversations(dashboard,{limit:100})).items.some(item=>item.space_id===first));
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
