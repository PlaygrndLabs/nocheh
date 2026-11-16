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
import {savePolicy} from '../src/security/store.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {chatDirectory,installChatsForTest} from '../src/chats.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP2,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_OLD_TG,NG2_TG,OWNER,UNSERVED,fixtureChats,fixtureDirectory} from './fixture-groups.js';
import {TelegramActionRepository} from '../src/stores/telegram-actions.js';

test('Telegram proposals and results stay derived, exact owner approval stays control, and uncertain delivery never resends',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-action-')),key='telegram-action:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},calls:Record<string,unknown>[]=[],native=new Map<string,string>();let loseReply=false,loseCompletion=false,refuseOnce=false;
  const connect=stores.control.connect.bind(stores.control);
  const wrapped=new Proxy(stores.control,{get(target,name){
    if(name==='connect')return async()=>{
      const db=await connect(),query=db.query.bind(db);
      return new Proxy(db,{get(client,field){
        if(field==='query')return (sql:any,...args:any[])=>{
          if(loseCompletion&&String(sql).includes('result_reference=$3')&&args[0]?.[1]==='done'){loseCompletion=false;return Promise.reject(Error('lost control completion'));}
          return (query as any)(sql,...args);
        };const value=Reflect.get(client,field);return typeof value==='function'?value.bind(client):value;
      }});
    };const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
  }});
  const services=fixtureServices({...stores,control:wrapped},{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:String(input.text).includes('fixture-secret')?['fixture-secret']:[]};
      assert.equal(operation,'action.execute');calls.push(input);
      const id=String(input.id);if(input.observe_only)return {state:native.get(id)??'not_found'};
      if(refuseOnce){refuseOnce=false;return {state:'not_started',error_code:'telegram_not_connected'};}
      assert.equal(native.has(id),false,'same action must never execute twice');
      assert.deepEqual(await actions.authorizeDelivery(input),{valid:true});
      await assert.rejects(actions.authorizeDelivery({...input,text:'changed after approval'}),{code:'action_delivery_denied'});
      native.set(id,'done');
      if(loseReply){loseReply=false;throw Error('accepted send with lost acknowledgment');}return {state:'done',ignored_payload:'never store arbitrary receipt content'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const actions=services.telegramActions,authority={owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='actions'")).rows[0].epoch)};
  const original=(label:string,text:string,scope=group,from=9):Envelope=>({version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
    payload:{message:{message_id:Date.now(),date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from},text}}});
  const capture=async(label:string,text:string,scope=group,from=9)=>{
    const source=(await services.capture.capture(original(label,text,scope,from))).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  const actor=async(source:string,scope:string|null=group,space=group):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const approve=async(id:string)=>{const action=await actions.inspect(owner,id);return actions.decide(owner,{id,fingerprint:action.fingerprint,decision:'approve'});};
  const due=(id:string)=>stores.control.query('UPDATE telegram_action_requests SET next_attempt=now() WHERE id=$1',[id]);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const source=await capture('source','Please prepare an outgoing message'),principal=await actor(source.id);
    const before=Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count);
    const proposal=await actions.request(principal,{destination:'current',text:'Keep this exact spacing.  \nfixture-secret'});
    assert.equal((await actions.request(principal,{destination:'current',text:'Keep this exact spacing.  \nfixture-secret'})).id,proposal.id);
    const view=await actions.inspect(owner,proposal.id);assert.ok(!view.arguments.text.includes('fixture-secret'));assert.ok(view.arguments.text.startsWith('Keep this exact spacing.  \n'));
    assert.equal((await actions.run(proposal.id,authority)).waiting_reason,'approval_required');assert.equal(calls.length,0);
    await assert.rejects(actions.decide(principal,{id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve'}),{status:403});
    await assert.rejects(actions.decide(owner,{id:proposal.id,fingerprint:digest('other'),decision:'approve'}),{code:'action_changed'});
    await assert.rejects(actions.request({...principal,purpose:'memory-review'},{destination:'current',text:'Not permitted'}),{code:'external_effect_scope_denied'});
    const approveResult=await approve(proposal.id);assert.equal(approveResult.state,'approved');assert.deepEqual(await approve(proposal.id),approveResult);
    loseReply=true;assert.equal((await actions.run(proposal.id,authority)).state,'waiting');assert.equal(calls.length,1);
    await due(proposal.id);assert.equal((await actions.run(proposal.id,authority)).state,'completed');assert.equal(calls.length,2);assert.equal(calls[1]!.observe_only,true);
    assert.equal((await actions.run(proposal.id,authority)).state,'completed');assert.equal(calls.length,2);
    assert.equal(Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count),before,'proposals, approval and runtime receipts create no originals');
    const topicEvent=original('topic-source','Please follow up in this topic');
    Object.assign((topicEvent.payload as any).message,{message_thread_id:17,is_topic_message:true});
    (topicEvent.payload as any).message.chat.is_forum=true;
    const topicSource=(await services.capture.capture(topicEvent)).source.reference;
    await services.guards.prepare(topicSource,'fixture',services.detect);
    const topicPrincipal=await actor(topicSource.id,group,group+'/topic/17');
    const topicAction=await actions.request(topicPrincipal,{destination:'current',text:'Approved topic follow-up'});
    assert.equal((await actions.inspect(owner,topicAction.id)).arguments.destination,group+'/topic/17','current preserves the exact source topic');
    await approve(topicAction.id);await actions.run(topicAction.id,authority);
    assert.equal(calls.at(-1)!.destination,group+'/topic/17');
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='telegram_action_requests'")).rows.map(row=>row.column_name);
    assert.ok(!columns.some(name=>['text','content','original_text','arguments','payload'].includes(name)));
    const second=await actions.request(principal,{destination:'123',text:'Second exact message'});await approve(second.id);loseCompletion=true;
    await assert.rejects(actions.run(second.id,authority),/lost control completion/);const called=calls.length;
    assert.equal((await actions.run(second.id,authority)).state,'completed');assert.equal(calls.length,called,'durable completion repairs control without another runtime call');
    const refused=await actions.request(principal,{destination:'123',text:'Refused while disconnected'});await approve(refused.id);refuseOnce=true;
    const refusal=await actions.run(refused.id,authority);assert.equal(refusal.state,'waiting');assert.equal(refusal.waiting_reason,'runtime_unavailable');
    assert.equal((await actions.inspect(owner,refused.id)).state,'approved','an explicit pre-intent refusal returns to the approved queue');
    assert.equal(native.has(refused.id),false);await due(refused.id);
    assert.equal((await actions.run(refused.id,authority)).state,'completed');assert.equal(native.get(refused.id),'done');
    const uncertain=await actions.request(principal,{destination:'123',text:'Uncertain preexisting execution'});await approve(uncertain.id);
    await stores.control.query("UPDATE telegram_action_requests SET state='running' WHERE id=$1",[uncertain.id]);
    assert.equal((await actions.run(uncertain.id,authority)).state,'waiting');assert.equal(calls.at(-1)!.observe_only,true);
    await due(uncertain.id);assert.equal((await actions.run(uncertain.id,authority)).state,'waiting');assert.equal(native.has(uncertain.id),false,'absence is not permission to resend');
    // A check that finds the same unclear outcome keeps its revision, so the owner's open review stays usable (ADR-0218).
    const unclear=await actions.inspect(owner,uncertain.id);assert.equal(unclear.state,'ambiguous');assert.equal(unclear.resolution,null);
    await due(uncertain.id);await actions.run(uncertain.id,authority);assert.equal((await actions.inspect(owner,uncertain.id)).revision,unclear.revision);
    const waiting=async()=>(await services.supervision.decisions(owner)).items.some(item=>item.id===uncertain.id);
    assert.equal(await waiting(),true,'an unclear send waits for the owner');
    await assert.rejects(actions.resolve(principal,{id:uncertain.id,fingerprint:unclear.fingerprint,outcome:'not_run'}),{status:403});
    await assert.rejects(actions.resolve(owner,{id:uncertain.id,fingerprint:unclear.fingerprint,outcome:'resend'}),{code:'invalid_decision'});
    await assert.rejects(actions.resolve(owner,{id:uncertain.id,fingerprint:digest('other'),outcome:'not_run'}),{code:'action_changed'});
    await assert.rejects(actions.resolve(owner,{id:uncertain.id,fingerprint:unclear.fingerprint,outcome:'not_run',expected_revision:unclear.revision-1}),{code:'action_changed'});
    const word={id:uncertain.id,fingerprint:unclear.fingerprint,outcome:'not_run',expected_revision:unclear.revision,operation_id:key+':not-sent'};
    const closed=await actions.resolve(owner,word);assert.deepEqual(closed,{id:uncertain.id,state:'ambiguous',resolution:'not_run',revision:unclear.revision+1});
    assert.deepEqual(await actions.resolve(owner,word),closed,'a repeated press answers the same');
    await assert.rejects(actions.resolve(owner,{...word,outcome:'ran'}),{code:'action_decision_conflict'});
    await assert.rejects(actions.resolve(owner,{id:uncertain.id,fingerprint:unclear.fingerprint,outcome:'ran'}),{code:'action_already_started_or_closed'});
    assert.equal((await actions.inspect(owner,uncertain.id)).resolution,'not_run');assert.equal(await waiting(),false,'a closed send no longer waits');
    const checks=calls.length;await due(uncertain.id);assert.equal((await actions.run(uncertain.id,authority)).state,'skipped');
    assert.equal(calls.length,checks,'a closed send is neither checked nor sent again');assert.equal(native.has(uncertain.id),false);
    // A delivery receipt saved just before the owner's word still settles the send: the word never hides it.
    const late=await actions.request(principal,{destination:'123',text:'Late confirmed delivery'});await approve(late.id);
    await stores.control.query("UPDATE telegram_action_requests SET state='running' WHERE id=$1",[late.id]);
    await actions.run(late.id,authority);assert.equal((await actions.inspect(owner,late.id)).state,'ambiguous');
    native.set(late.id,'done');loseCompletion=true;await due(late.id);
    await assert.rejects(actions.run(late.id,authority),/lost control completion/);
    const lateView=await actions.inspect(owner,late.id);assert.equal(lateView.state,'ambiguous');
    await actions.resolve(owner,{id:late.id,fingerprint:lateView.fingerprint,outcome:'not_run'});
    const lateChecks=calls.length;assert.equal((await actions.run(late.id,authority)).state,'completed');assert.equal(calls.length,lateChecks,'the saved receipt needs no new check');
    const settled=await actions.inspect(owner,late.id);assert.equal(settled.state,'done');assert.equal(settled.resolution,null);
    await assert.rejects(actions.resolve(owner,{id:approveResult.id,fingerprint:proposal.fingerprint,outcome:'ran'}),{code:'action_already_started_or_closed'},'only an unclear send is closed by the owner');
    const denied=await actions.request(principal,{destination:'123',text:'Deny under current security policy'});await approve(denied.id);
    const security=(await stores.control.query('SELECT revision FROM security_policy WHERE singleton')).rows[0].revision;
    await savePolicy(stores.control,owner,{expected_revision:Number(security),policy:{version:1,rules:[{id:key,kind:'telegram.send',outcome:'deny',fingerprint:denied.fingerprint}]}});
    const previous=calls.length;assert.equal((await actions.run(denied.id,authority)).state,'denied');assert.equal(calls.length,previous);
    const commandAction=await actions.request(principal,{destination:'123',text:'Approved by owner DM'});
    const groupCommand=await capture('group-command','/approve '+commandAction.id,group,123);
    assert.match((await services.actionCommands.controlReply(groupCommand))!,/Only the owner/);assert.equal((await actions.inspect(owner,commandAction.id)).state,'proposed');
    // A forwarded command, or one sent through an inline bot, is never run, even the owner's own; it still gets a fixed answer (ADR-0250).
    for(const [label,fields] of <[string,Record<string,unknown>][]>[['forwarded-command',{forward_origin:{type:'user',sender_user:{id:9},date:1699999999}}],
      ['own-forwarded-command',{forward_origin:{type:'user',sender_user:{id:123},date:1699999999}}],['hidden-forwarded-command',{forward_sender_name:'Made-up name',forward_date:1699999999}],
      ['bot-command',{via_bot:{id:77,is_bot:true,first_name:'Bot',username:'made_up_bot'}}]]) {
      const envelope=original(label,'/approve '+commandAction.id,'123',123);Object.assign((envelope.payload as any).message,fields);
      const forwarded=(await services.capture.capture(envelope)).source.reference;await services.guards.prepare(forwarded,'fixture',services.detect);
      assert.equal(await services.actionCommands.controlReply(forwarded),'Forwarded commands are ignored. Type it or use the card.',label);
    }
    assert.equal((await actions.inspect(owner,commandAction.id)).state,'proposed');
    const ownerCommand=await capture('owner-command','/approve '+commandAction.id,'123',123);
    assert.match((await services.actionCommands.controlReply(ownerCommand))!,/approved/);assert.match((await services.actionCommands.controlReply(ownerCommand))!,/approved/);
    assert.equal((await actions.inspect(owner,commandAction.id)).state,'approved');
    const stale=await actions.request(principal,{destination:'123',text:'Approval cannot survive revocation'});await approve(stale.id);
    await services.guards.setMode('off');const sentBefore=calls.length;
    assert.equal((await actions.run(stale.id,authority)).state,'cancelled');assert.equal(calls.length,sentBefore);
    await assert.rejects(actions.inspect(principal,stale.id),{code:'audience_context_changed'});
    const off=await actions.request(await actor(source.id),{destination:'123',text:'Guard off fixture-secret'});assert.equal((await actions.inspect(owner,off.id)).arguments.text,'Guard off fixture-secret');
    await assert.rejects(services.archive.capture({...original('generated-imposter','No'),kind:'action_result'}),{code:'original_source_required'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a send names its destination by chat id: unknown and unserved ids fail closed, and an approved send goes where the chat is in Telegram now',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  // The strict fixture directory (ADR-0252): GP1 stored before step 2b, NG1 first seen after it, NG2 upgraded since. An id
  // it does not hold is not made up on the spot, as the seeded fixture would.
  const restore=installChatsForTest(fixtureDirectory([GP1,NG1_TG,NG2_TG]));
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-destination-')),key='telegram-destination:'+Date.now();
  const owner:Reader={admin:true,scope:null},calls:Record<string,unknown>[]=[];
  // Who the owner allows in which group, by Telegram id; a test changes it as the owner would. A change due as the bot
  // asks its last check, just before it sends.
  let access:Record<string,{granted:string[];denied:string[]}>={},atDelivery:(()=>void)|null=null;
  const policy=()=>({enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[GP1,NG1_TG,NG2_TG],group_access:access});
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'action.execute');calls.push(input);
      if(atDelivery) {
        const change=atDelivery;atDelivery=null;change();
        await assert.rejects(actions.authorizeDelivery(input),{code:'action_delivery_denied'},'the bot\'s last check finds the chat no longer served');
        return {state:'denied'};
      }
      assert.deepEqual(await actions.authorizeDelivery(input),{valid:true});
      // The bot's check holds the send to where its destination is now: its old Telegram id is not it.
      await assert.rejects(actions.authorizeDelivery({...input,chat_id:NG2_OLD_TG}),{code:'action_delivery_denied'});
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const actions=services.telegramActions,authority={owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='actions'")).rows[0].epoch)};
  const original:Envelope={version:1,key:key+':source',origin:'live',kind:'telegram_update',bot_id:key,scope:GP1,source_id:'source',revision:'1',occurred_at:null,
    text:'Please tell the other groups',payload:{message:{message_id:Date.now(),date:1700000000,chat:{id:Number(GP1),type:'supergroup',is_forum:false},from:{id:Number(OWNER)},text:'Please tell the other groups'}}};
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const source=(await services.capture.capture(original)).source.reference;await services.guards.prepare(source,'fixture',services.detect);
    const binding=await services.guards.state();
    const principal:Reader={admin:false,scope:GP1,space:GP1,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    // An id the directory does not hold, as a chat id, a Telegram id or a link, is refused before anything is proposed, as
    // a chat Nocheh does not serve is (ADR-0254): the answer is the same, so asking learns nothing.
    for(const destination of ['-1009999999999','-1009999999999/topic/3','https://t.me/c/9999999999/3',NG1+'/topic/7','b'.repeat(64)])
      await assert.rejects(actions.request(principal,{destination,text:'Never proposed'}),{status:403,code:'destination_not_served'},destination);
    // A stranger's private chat, a group the owner did not select, and one turned off are not served; nor are they for a
    // trusted send. An empty text is still a bad request.
    for(const destination of [BOB_CHAT,UNSERVED,GP2])
      await assert.rejects(actions.request(principal,{destination,text:'Never proposed'}),{status:403,code:'destination_not_served'},destination);
    await assert.rejects(actions.request(principal,{destination:GP1,text:'   '}),{status:400,code:'invalid_action'});
    await assert.rejects(actions.prepareSystem({...principal,logical_profile:'fixture-profile'},source,binding,BOB_CHAT,'Never prepared','fixture-key'),
      {status:403,code:'destination_not_served'});
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM telegram_action_requests WHERE destination=ANY($1)',[[BOB_CHAT,UNSERVED,GP2]])).rows[0].n,0);
    // A Telegram id or link is read once, into the chat it names: NG2 by its old Telegram id, NG1's topic by its link.
    const upgraded=await actions.request(principal,{destination:NG2_OLD_TG,text:'To the upgraded group'});
    const topic=await actions.request(principal,{destination:'https://t.me/c/'+NG1_TG.slice(4)+'/7',text:'To the new topic'});
    const byId=await actions.request(principal,{destination:NG2,text:'To the upgraded group by its chat id'});
    assert.deepEqual([(await actions.inspect(owner,upgraded.id)).arguments.destination,(await actions.inspect(owner,topic.id)).arguments.destination,
      (await actions.inspect(owner,byId.id)).arguments.destination],[NG2,NG1_TOPIC,NG2]);
    assert.deepEqual((await stores.control.query('SELECT DISTINCT scope FROM telegram_action_requests WHERE id=ANY($1)',[[upgraded.id,topic.id,byId.id]])).rows,
      [{scope:GP1}],'each request names its own chat by its chat id');
    for(const proposal of [upgraded,topic,byId]){
      const view=await actions.inspect(owner,proposal.id);await actions.decide(owner,{id:proposal.id,fingerprint:view.fingerprint,decision:'approve'});
      assert.equal((await actions.run(proposal.id,authority)).state,'completed');
    }
    // Each goes where its chat is in Telegram now: NG2 at its current id, never its old one; NG1's topic as its thread.
    assert.deepEqual(calls.map(call=>[call.destination,call.chat_id,call.topic??null]),[[NG2,NG2_TG,null],[NG1_TOPIC,NG1_TG,7],[NG2,NG2_TG,null]]);

    // Bob is allowed in GP1, a selected group: his private chat is served, and a send there always waits for the owner's card.
    const approve=async(id:string)=>{const view=await actions.inspect(owner,id);return actions.decide(owner,{id,fingerprint:view.fingerprint,decision:'approve'});};
    const closed=async(id:string)=>{const view=await actions.inspect(owner,id);return [view.state,view.error_code];};
    const allowBob=()=>{access={[GP1]:{granted:[BOB],denied:[]}};};
    allowBob();
    const toBob=await actions.request(principal,{destination:BOB_CHAT,text:'To Bob privately'});
    assert.equal(toBob.state,'proposed','a person\'s private chat waits for the owner');
    assert.equal((await approve(toBob.id)).state,'approved');
    assert.equal((await actions.run(toBob.id,authority)).state,'completed');
    assert.deepEqual([calls.at(-1)!.destination,calls.at(-1)!.chat_id],[BOB_CHAT,BOB]);
    // Denied under any of the group's Telegram ids wins: Bob granted under NG2's new id but denied under its old one.
    access={[NG2_TG]:{granted:[BOB],denied:[]},[NG2_OLD_TG]:{granted:[],denied:[BOB]}};
    await assert.rejects(actions.request(principal,{destination:BOB_CHAT,text:'Never proposed'}),{code:'destination_not_served'});
    // Bob removed after the approval: the send is closed with its reason, and nothing is sent.
    allowBob();
    const removed=await actions.request(principal,{destination:BOB_CHAT,text:'Before Bob was removed'});await approve(removed.id);
    access={};let sent=calls.length;
    assert.equal((await actions.run(removed.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
    assert.deepEqual(await closed(removed.id),['cancelled','destination_not_served']);
    // Removed while the card waited: the approval answers with the closed send, by its id, so the card can settle.
    allowBob();
    const waiting=await actions.request(principal,{destination:BOB_CHAT,text:'Waiting for the owner'});
    access={};const card=await actions.inspect(owner,waiting.id);
    const decision={id:waiting.id,fingerprint:card.fingerprint,decision:'approve',operation_id:key+':removed-while-waiting'};
    const notServed={id:waiting.id,state:'cancelled',revision:card.revision+1,error_code:'destination_not_served'};
    assert.deepEqual(await actions.decide(owner,decision),notServed);
    assert.deepEqual(await actions.decide(owner,decision),notServed,'a repeated press answers the same');
    assert.deepEqual(await closed(waiting.id),['cancelled','destination_not_served']);
    assert.equal((await actions.run(waiting.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
    // Removed between the start and the bot's own check: the bot refuses, and the send keeps the reason.
    allowBob();
    const raced=await actions.request(principal,{destination:BOB_CHAT,text:'Removed while sending'});await approve(raced.id);
    atDelivery=()=>{access={};};
    assert.equal((await actions.run(raced.id,authority)).state,'denied');assert.equal(calls.length,sent+1);
    assert.deepEqual(await closed(raced.id),['rejected','destination_not_served']);
    // A rule that refuses the send at its start says so, unlike the owner's own Reject.
    const ruled=await actions.request(principal,{destination:NG2,text:'Refused by a rule'});await approve(ruled.id);
    const security=(await stores.control.query('SELECT revision FROM security_policy WHERE singleton')).rows[0].revision;
    await savePolicy(stores.control,owner,{expected_revision:Number(security),policy:{version:1,rules:[{id:key,kind:'telegram.send',outcome:'deny',fingerprint:ruled.fingerprint}]}});
    sent=calls.length;
    assert.equal((await actions.run(ruled.id,authority)).state,'denied');assert.equal(calls.length,sent);
    assert.deepEqual(await closed(ruled.id),['rejected','security_start_denied']);
    // A chat the directory lost after the approval is closed at once, not tried again forever.
    const lost=await actions.request(principal,{destination:NG2,text:'To a chat the directory loses'});await approve(lost.id);
    const full=fixtureChats([GP1,NG1_TG,NG2_TG]);
    const back=installChatsForTest(chatDirectory({...full,chats:full.chats.filter(chat=>chat.id!==NG2),ids:full.ids.filter(row=>row.chat_id!==NG2)}));
    try {
      assert.equal((await actions.run(lost.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
      assert.deepEqual(await closed(lost.id),['cancelled','destination_not_served']);
      assert.equal((await actions.run(lost.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
    }finally{back();}
    // A settings change while cards waited: the restart that applies it moves the epoch, so neither send can go out as
    // asked. Approving closes each with its reason, instead of leaving live buttons that fail on every press (ADR-0254).
    const configure=()=>services.configuration.configure(policy(),'on');
    const asked=async()=>{const now=await services.guards.state();return {...principal,generation:now.generation,guard_epoch:now.epoch,revision:now.epoch};};
    allowBob();await configure();
    const toGroup=await actions.request(await asked(),{destination:NG2,text:'Asked before a settings change'});
    const toPerson=await actions.request(await asked(),{destination:BOB_CHAT,text:'Asked before Bob was removed'});
    assert.deepEqual([toGroup.state,toPerson.state],['proposed','proposed']);
    // A change that keeps both chats served, Bob allowed in NG2 too: the context changed, and the card says so.
    access={[GP1]:{granted:[BOB],denied:[]},[NG2_TG]:{granted:[BOB],denied:[]}};await configure();
    const stale=await actions.inspect(owner,toGroup.id);sent=calls.length;
    assert.deepEqual(await actions.decide(owner,{id:toGroup.id,fingerprint:stale.fingerprint,decision:'approve'}),
      {id:toGroup.id,state:'cancelled',revision:stale.revision+1,error_code:'action_context_changed'});
    assert.deepEqual(await closed(toGroup.id),['cancelled','action_context_changed']);
    assert.equal((await actions.run(toGroup.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
    // Bob removed by the next change: that is said first, though the epoch moved too; /approve answers as a press does.
    access={};await configure();
    const command=`/approve ${toPerson.id}`,typed:Envelope={...original,key:key+':approve-removed',scope:OWNER,source_id:'approve-removed',text:command,
      payload:{message:{message_id:Date.now(),date:1700000000,chat:{id:Number(OWNER),type:'private'},from:{id:Number(OWNER)},text:command}}};
    const typedSource=(await services.capture.capture(typed)).source.reference;await services.guards.prepare(typedSource,'fixture',services.detect);
    assert.match((await services.actionCommands.controlReply(typedSource))!,/Approved, but not sent: Nocheh does not serve that chat now\.$/);
    assert.deepEqual(await closed(toPerson.id),['cancelled','destination_not_served']);
    assert.equal((await actions.run(toPerson.id,authority)).state,'cancelled');assert.equal(calls.length,sent);
  }finally{restore();await stores.close();await rm(root,{recursive:true,force:true});}
});

test('an owner notice names the chat in the owner\'s fixed words, quotes only names, and never stops its caller (ADR-0254)',async()=>{
  const restore=installChatsForTest(fixtureDirectory([GP1]));
  const sent:Record<string,unknown>[]=[];let down=false;
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[GP1],group_access:{}};
  // Only what a notice reads: the owner's texts (none saved, so the defaults), the policy, the chat directory and the bot.
  const actions=new TelegramActionRepository({control:{query:async()=>({rows:[]})}} as any,{policy:()=>policy} as any,null as any,null as any,null as any,null as any,
    async(operation,input)=>{if(down)throw Error('bot unreachable');assert.equal(operation,'telegram.notice');sent.push(input);return {state:'done'};},async()=>[]);
  try {
    await actions.ownerNotice('a'.repeat(64),'schedule_not_sent',{chat:UNSERVED,reason:'reason_not_served'});
    await actions.ownerNotice('b'.repeat(64),'job_report_not_sent',{chat:GP1_TOPIC,reason:'reason_not_served',title:'Plan {chat} \u201cx\u201d'});
    await actions.ownerNotice('c'.repeat(64),'schedule_not_sent',{chat:OWNER,reason:'reason_settings_changed'});
    down=true;await actions.ownerNotice('d'.repeat(64),'schedule_not_run',{chat:GP2,reason:'reason_not_served'});
    assert.deepEqual(sent.map(notice=>[notice.id,notice.chat_id]),[['a'.repeat(64),OWNER],['b'.repeat(64),OWNER],['c'.repeat(64),OWNER]]);
    assert.equal(sent[0]!.text,'\u26a0\ufe0f A scheduled task in group \u2068\u201cUnserved\u201d\u2069 (not served now) finished, but its result was not sent: Nocheh does not serve that chat now.');
    // A name's own braces and quotes show plain, so it can neither be filled in nor close the quotes code adds.
    assert.equal(sent[1]!.text,'\u26a0\ufe0f The job \u2068\u201cPlan [chat] \'x\'\u201d\u2069 finished, but its report was not sent to group \u2068\u201cGP1\u201d\u2069 \u203a a topic: Nocheh does not serve that chat now.');
    assert.equal(sent[2]!.text,'\u26a0\ufe0f A scheduled task in your private chat finished, but its result was not sent: your settings changed while it ran. It runs again at its next time.');
  }finally{restore();}
});

test('\'current\' in a turn with no live Telegram message stays a bad request, never a claim that its chat is not served (ADR-0254)',async()=>{
  const restore=installChatsForTest(fixtureDirectory([GP1]));
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[GP1],group_access:{}},binding={generation:'g',epoch:1,mode:'on' as const};
  // A job's or a schedule's turn roots in a control operation, the web chat's in a browser message; neither has a Telegram
  // chat for 'current' to name. Nothing past the refusal is reached, so nothing else is wired.
  let root:Record<string,string>={store:'control',kind:'operation',id:'c'.repeat(64),input_hash:'d'.repeat(64)};
  const actions=new TelegramActionRepository({control:{query:async()=>({rows:[]})}} as any,
    {policy:()=>policy,archive:{verify:async()=>({origin:'live',channel:'browser'})}} as any,null as any,{state:async()=>binding} as any,
    {root:async()=>root} as any,{binding:async()=>({scope:GP1,logical_profile:'fixture',owner:false,job:'job-fixture'})} as any,
    async()=>{throw Error('nothing is sent');},async()=>[]);
  const principal:Reader={admin:false,scope:GP1,space:GP1,turnEvent:'e'.repeat(64),generation:'g',guard_epoch:1,revision:1};
  try {
    for(const turn of ['a job or a schedule','the web chat']) {
      await assert.rejects(actions.request(principal,{destination:'current',text:'Post the summary here'}),{status:400,code:'invalid_action'},turn);
      // A chat named outright that Nocheh does not serve is still refused as such.
      await assert.rejects(actions.request(principal,{destination:UNSERVED,text:'Post the summary there'}),{status:403,code:'destination_not_served'},turn);
      root={store:'archive',id:'f'.repeat(64),input_hash:'a'.repeat(64)};
    }
  }finally{restore();}
});
