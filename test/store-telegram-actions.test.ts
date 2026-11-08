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
import {savePolicy} from '../src/security/store.js';

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
  const services=storageServices({...stores,control:wrapped},{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
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
    },honcho:async()=>{throw Error('no memory provider');}});
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
