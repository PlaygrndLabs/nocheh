import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {foregroundReplyActive} from '../src/stores/automatic-publication.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import type {SourceReference} from '../src/stores/archive.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {workflowDetail} from '../src/workflows/owner.js';

test('an approved operation\'s answer comes back to the chat that asked, after its first reply',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-continuations-')),key='continuations:'+Date.now(),group='-100'+Date.now(),token=digest(key);
  const owner:Reader={admin:true,scope:null},starts:any[]=[],resumes:any[]=[],cancels:any[]=[];
  // What the runtime answers to the next start and observation of a follow-up turn.
  let started:Record<string,unknown>={state:'done'},observed:Record<string,unknown>={state:'running'},denied:string[]=[];
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied}}});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='action.execute')return {state:'done'};
      if(operation==='telegram.approval')return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
      if(operation==='run.start'){starts.push(input);return started;}
      if(operation==='run.resume'){resumes.push(input);return observed;}
      assert.equal(operation,'run.cancel');cancels.push(input);return {state:'cancelled'};
    },honcho:async()=>{throw Error('no memory provider');}});
  const bot=String(Date.now()).slice(-8)+'7';let updates=0;
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:`telegram:${bot}:update:${payload.update_id}`,origin:'live',kind:'telegram_update',bot_id:bot,scope,source_id:String(payload.update_id),revision:'1',occurred_at:null,text:label,payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  // A member's request in topic 17 of a forum group, and the owner's in their private chat.
  const message=(label:string)=>capture(label,{update_id:++updates,message:{message_id:100+updates,date:1700000000,
    chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:9,first_name:'Member'},text:'Please run '+label,message_thread_id:17,is_topic_message:true}});
  const privately=(label:string)=>capture(label,{update_id:++updates,message:{message_id:100+updates,date:1700000000,chat:{id:123,type:'private'},from:{id:123,first_name:'Owner'},text:'Please run '+label}},'123');
  const press=(label:string,data:string)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:123},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:123,type:'private'}}}},'123');
  const actor=async(source:SourceReference,scope:string|null):Promise<Reader>=>{
    const binding=await s.guards.state(),space=(await s.access.space(source))!;
    return {admin:false,scope,space,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const operation=async(source:SourceReference,command:string,scope:string|null=group)=>
    s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(source,scope),{kind:'shell',arguments:{command}}));
  const decide=async(asked:{id:string;fingerprint:string},button:'na'|'nd')=>
    assert.equal(await s.actionCommands.callback(await press(button+'-'+asked.id.slice(0,12),button+asked.id.slice(0,40)+asked.fingerprint.slice(0,16))),true);
  const claimed=async(id:string)=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});
    const b={id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
    assert.equal((await s.controlledExecution.claim(b)).claimed,true);assert.deepEqual(await s.controlledExecution.start(b),{started:true});return b;
  };
  const ran=async(id:string,state='done',result:Record<string,unknown>={stdout:'made-up output',exit_code:0})=>
    s.controlledExecution.finish({...await claimed(id),state,result});
  const asking=(source:SourceReference,state:string)=>stores.control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,$3,1)
    ON CONFLICT(event_id) DO UPDATE SET state=excluded.state`,[source.id,source,state]);
  const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const operations=storageWorkflowOperations(s,async()=>({}));
  const follow=async(id:string)=>operations.telegram!('continue:'+id,await epoch('telegram'));
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM action_continuations WHERE action_id=$1',[id])).rows[0];
  const pick=(value:any,...keys:string[])=>Object.fromEntries(keys.map(name=>[name,value[name]]));
  const due=(id:string)=>stores.control.query('UPDATE action_continuations SET next_attempt=now() WHERE action_id=$1',[id]);
  const backdate=(id:string,minutes:number)=>stores.control.query(`UPDATE action_continuations SET created_at=now()-$2*interval '1 minute' WHERE action_id=$1`,[id,minutes]);
  const workflow=async(id:string)=>(await stores.control.query("SELECT * FROM workflow_registry WHERE family='telegram' AND job_id=$1",['continue:'+id])).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    // A member's operation in a group topic, approved by the owner's press, ends while the asking turn's reply is still running.
    const asked=await message('one'),one=await operation(asked,'printf made-up-one');
    assert.match(one.message,/the answer will follow here/);
    await decide(one,'na');await ran(one.id);
    assert.equal((await row(one.id)).state,'pending');
    await asking(asked,'running');
    const held=await follow(one.id);
    assert.deepEqual(pick(held,'state','waiting_reason'),{state:'waiting',waiting_reason:'prerequisite'});assert.equal(starts.length,0,'the reply that says "I asked the owner" goes first');
    assert.equal((await row(one.id)).state,'waiting');
    // Once that reply is done, one follow-up turn starts, bound to the asking message.
    await asking(asked,'done');started={state:'running'};
    assert.equal((await follow(one.id)).state,'running');assert.equal(starts.length,1);
    const body=starts[0],original=JSON.parse((await stores.archive.query('SELECT payload FROM events WHERE id=$1',[asked.id])).rows[0].payload.toString()).message;
    assert.deepEqual(pick(body.payload.message,'message_id','message_thread_id','is_topic_message'),{message_id:original.message_id,message_thread_id:17,is_topic_message:true},
      'it answers as a reply to the asking message, in its topic');
    assert.deepEqual([body.event_id,body.scope,body.payload.message.chat.id,body.payload.message.from.id],[asked.id,group,Number(group),9]);
    assert.equal(body.payload.message.text,body.text);assert.deepEqual([body.transcripts,body.files],[[],[]]);
    assert.ok(body.text.includes('- '+one.id+' (shell): done'));
    assert.doesNotMatch(body.text,/made-up output/,'the model reads the result itself, under its own audience check');
    assert.equal(body.attempt,'c1-'+one.id.slice(0,40));assert.equal(body.continuation,one.id);
    for(const field of ['control_reply','group_addressing','speaker','recent_group','album_events'])assert.equal(body[field],undefined,field+' is not sent');
    assert.equal(body.asynchronous,true);
    const credential=reader({headers:{authorization:'Bearer '+body.archive_credential}} as any,token);
    assert.deepEqual(pick(credential,'scope','space','turnEvent'),{scope:group,space:group+'/topic/17',turnEvent:asked.id},'the credential is the asking member\'s');
    // While it runs, reactions and learning wait, as for a reply.
    const running=await row(one.id);
    assert.deepEqual(pick(running,'state','attempts','run_id'),{state:'running',attempts:1,run_id:one.id});assert.ok(running.binding.generation);
    assert.equal(await foregroundReplyActive(stores.control,await s.guards.state(),true),true);
    await due(one.id);observed={state:'done'};
    assert.equal((await follow(one.id)).state,'completed');assert.equal(resumes.at(-1).attempt,'c1-'+one.id.slice(0,40));
    assert.equal((await row(one.id)).state,'done');
    assert.equal((await stores.derived.query('SELECT 1 FROM derived_artifacts WHERE operation_id=$1',['action-continuation-result:'+one.id+':1'])).rowCount,1);
    assert.equal(await foregroundReplyActive(stores.control,await s.guards.state(),true),false);
    const calls=starts.length+resumes.length;assert.equal((await follow(one.id)).state,'completed');assert.equal(starts.length+resumes.length,calls,'a finished follow-up calls nothing');
    // A failure before delivery is retried as a new attempt, three times in all; an uncertain delivery is never repeated.
    const failing=await message('two'),two=await operation(failing,'printf made-up-two');await asking(failing,'done');await decide(two,'na');await ran(two.id);
    started={state:'failed',error_code:'assistant_runtime_unavailable'};
    for(const attempt of [1,2,3]) {
      await due(two.id);const result=await follow(two.id);
      assert.equal(starts.at(-1).attempt,'c'+attempt+'-'+two.id.slice(0,40));assert.equal(result.state,attempt<3?'retryable_failed':'failed');
    }
    let before=starts.length;await due(two.id);assert.equal((await follow(two.id)).state,'failed');assert.equal(starts.length,before,'no fourth start');
    assert.equal((await workflowDetail(stores.control,(await workflow(two.id)).id)).can_retry,false,'three failed attempts are final');
    const unsure=await message('three'),three=await operation(unsure,'printf made-up-three');await asking(unsure,'done');await decide(three,'na');await ran(three.id);
    started={state:'ambiguous',error_code:'delivery_unconfirmed'};
    assert.equal((await follow(three.id)).state,'ambiguous');before=starts.length;
    await due(three.id);assert.equal((await follow(three.id)).state,'ambiguous');assert.equal(starts.length,before);
    // Operations of one message that end together are answered together; a request still waiting for the owner holds nothing.
    const together=await message('together');await asking(together,'done');
    const lead=await operation(together,'printf made-up-lead'),sibling=await operation(together,'printf made-up-sibling'),later=await operation(together,'printf made-up-later');
    await decide(lead,'na');await decide(sibling,'na');await ran(lead.id);
    const busy=await claimed(sibling.id);started={state:'done'};before=starts.length;
    assert.equal((await follow(lead.id)).state,'waiting');assert.equal(starts.length,before,'it waits while the sibling runs');
    await s.controlledExecution.finish({...busy,state:'done',result:{exit_code:0}});
    assert.equal((await follow(lead.id)).state,'completed');assert.equal(starts.length,before+1);
    assert.ok(starts.at(-1).text.includes(lead.id)&&starts.at(-1).text.includes(sibling.id),'one follow-up names both');
    assert.ok(!starts.at(-1).text.includes(later.id));
    assert.equal((await follow(sibling.id)).state,'skipped');assert.deepEqual(pick(await row(sibling.id),'state','error_code','run_id'),{state:'skipped',error_code:'merged',run_id:lead.id});
    assert.equal(starts.length,before+1);
    // One asking message gets at most three follow-ups.
    const chatty=await message('chatty');await asking(chatty,'done');const asks:{id:string;fingerprint:string}[]=[];
    for(const index of [1,2,3,4])asks.push(await operation(chatty,'printf made-up-cap-'+index));
    for(const request of asks.slice(0,3)){await decide(request,'na');await ran(request.id);assert.equal((await follow(request.id)).state,'completed');}
    before=starts.length;await decide(asks[3]!,'na');await ran(asks[3]!.id);
    assert.equal((await follow(asks[3]!.id)).state,'skipped');assert.equal((await row(asks[3]!.id)).error_code,'chain_limit');assert.equal(starts.length,before);
    const capped=(await operation(chatty,'printf made-up-cap-5')).message;
    assert.match(capped,/that you asked the owner;/);assert.doesNotMatch(capped,/will follow|follows here/,'past the cap no reply promises a follow-up');
    // The owner's own private request that they rejected needs no follow-up; a member hears that the owner said no.
    const mine=await privately('mine'),own=await operation(mine,'printf made-up-mine',null);await asking(mine,'done');await decide(own,'nd');
    before=starts.length;assert.equal((await follow(own.id)).state,'skipped');
    assert.deepEqual(pick(await row(own.id),'state','error_code'),{state:'skipped',error_code:'owner_rejected'});assert.equal(starts.length,before);
    const refusedAsk=await message('refused'),refused=await operation(refusedAsk,'printf made-up-refused');await asking(refusedAsk,'done');await decide(refused,'nd');
    started={state:'running'};assert.equal((await follow(refused.id)).state,'running');assert.match(starts.at(-1).text,/\(shell\): rejected/);
    // The waits are bounded: a reply that never ends holds it for ten minutes, a missing receipt for two.
    const slow=await message('slow'),late=await operation(slow,'printf made-up-late');await decide(late,'na');await ran(late.id);await asking(slow,'running');
    started={state:'done'};before=starts.length;
    assert.equal((await follow(late.id)).state,'waiting');await backdate(late.id,11);
    assert.equal((await follow(late.id)).state,'completed');assert.equal(starts.length,before+1);
    const lost=await message('lost'),missing=await operation(lost,'printf made-up-missing');await asking(lost,'done');await decide(missing,'na');
    const lease=await claimed(missing.id);
    await stores.control.query("UPDATE controlled_actions SET lease_until=now()-interval '1 second' WHERE id=$1",[missing.id]);
    assert.equal((await s.controlledExecution.claim(lease)).claimed,false);
    assert.deepEqual(pick(await s.controlledActions.row(missing.id),'state','error_code'),{state:'ambiguous',error_code:'executor_receipt_missing'});
    before=starts.length;assert.equal((await follow(missing.id)).state,'waiting');assert.equal(starts.length,before,'a late receipt may still come');
    await backdate(missing.id,3);assert.equal((await follow(missing.id)).state,'completed');assert.match(starts.at(-1).text,/\(shell\): ambiguous/);
    // A sibling whose receipt went missing may still report: the follow-up waits for it, then leaves it to its own wait.
    const pair=await message('pair'),first=await operation(pair,'printf made-up-first'),stalled=await operation(pair,'printf made-up-stalled');
    await asking(pair,'done');await decide(first,'na');await decide(stalled,'na');await ran(first.id);
    const stalling=await claimed(stalled.id);
    await stores.control.query("UPDATE controlled_actions SET lease_until=now()-interval '1 second' WHERE id=$1",[stalled.id]);
    assert.equal((await s.controlledExecution.claim(stalling)).claimed,false);
    before=starts.length;assert.equal((await follow(first.id)).state,'waiting');assert.equal(starts.length,before,'it waits for the sibling\'s late receipt');
    await backdate(first.id,3);assert.equal((await follow(first.id)).state,'completed');
    assert.ok(!starts.at(-1).text.includes(stalled.id),'the sibling is not answered as unconfirmed');
    assert.deepEqual(pick(await row(stalled.id),'state','run_id'),{state:'pending',run_id:null});
    await s.controlledExecution.finish({...stalling,state:'done',result:{stdout:'made-up late output',exit_code:0}});
    assert.equal((await follow(stalled.id)).state,'completed');assert.equal(starts.length,before+2);
    assert.ok(starts.at(-1).text.includes('- '+stalled.id+' (shell): done'),'its own follow-up answers it once the receipt came');
    // A follow-up that failed before delivery and has a retry left holds a later one of the same message, so they keep their order.
    const order=await message('order'),early=await operation(order,'printf made-up-early'),next=await operation(order,'printf made-up-next');
    await asking(order,'done');await decide(early,'na');await ran(early.id);
    started={state:'failed',error_code:'assistant_runtime_unavailable'};assert.equal((await follow(early.id)).state,'retryable_failed');
    await decide(next,'na');await ran(next.id);before=starts.length;
    assert.equal((await follow(next.id)).state,'waiting');assert.equal(starts.length,before,'the earlier follow-up retries first');
    started={state:'done'};await due(early.id);assert.equal((await follow(early.id)).state,'completed');assert.ok(!starts.at(-1).text.includes(next.id));
    assert.equal((await follow(next.id)).state,'completed');assert.ok(starts.at(-1).text.includes('- '+next.id+' (shell): done'));
    // The owner's Workflows page cancels a follow-up that has not started and retries a failed one as its next attempt.
    const stop=await message('stop'),stopped=await operation(stop,'printf made-up-stop');await decide(stopped,'na');await ran(stopped.id);
    const cancelling=await workflow(stopped.id),view=await workflowDetail(stores.control,cancelling.id);
    assert.equal(view.source_event_id,stop.id);assert.equal(view.can_cancel,true);
    await controlStorageWorkflow(stores.control,owner,cancelling.id,'cancel',{revision:cancelling.revision});
    assert.deepEqual(pick(await row(stopped.id),'state','error_code'),{state:'cancelled',error_code:'owner_cancelled'});
    const retry=await message('retry'),again=await operation(retry,'printf made-up-again');await asking(retry,'done');await decide(again,'na');await ran(again.id);
    started={state:'failed',error_code:'assistant_runtime_unavailable'};assert.equal((await follow(again.id)).state,'retryable_failed');
    const retrying=await workflow(again.id),failed=await workflowDetail(stores.control,retrying.id);
    assert.deepEqual(pick(failed,'state','attempts','can_retry'),{state:'retryable_failed',attempts:1,can_retry:true});
    await controlStorageWorkflow(stores.control,owner,retrying.id,'retry',{revision:retrying.revision});
    assert.equal((await row(again.id)).state,'pending');
    started={state:'done'};assert.equal((await follow(again.id)).state,'completed');assert.equal(starts.at(-1).attempt,'c2-'+again.id.slice(0,40));
    // Under the owner freedom setting the owner's own request runs at once, but what its follow-up asks for waits for the owner.
    const freedom=await s.ownerAutonomy.get(owner),enabled=await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:freedom.revision,operation_id:key+':free'});
    const free=await privately('free'),freed=await operation(free,'printf made-up-free',null);
    assert.equal(freed.state,'approved');assert.match(freed.message,/Its answer will follow here/);
    await ran(freed.id);await asking(free,'done');started={state:'running'};assert.equal((await follow(freed.id)).state,'running');
    const steered=await operation(free,'printf made-up-steered',null);
    assert.equal(steered.state,'proposed','no owner request started the follow-up');assert.match(steered.message,/Approve and Reject buttons/);
    const note=await s.telegramActions.request(await actor(free,null),{destination:group,text:'Made-up note from the owner\'s memory'});
    assert.equal(note.state,'proposed','a message for another chat waits too');
    // One that runs without a card is read whole by the asking turn's own wait, so no follow-up repeats it (ADR-0215).
    const read=await privately('read'),quick=await operation(read,'printf made-up-quick',null),reading=await actor(read,null);
    assert.equal(quick.allowed,true);
    await s.controlledActions.inspect(reading,quick.id,true);
    assert.equal((await s.controlledActions.row(quick.id)).observed_in_turn,null,'a state before the end is no answer');
    await ran(quick.id);
    await s.controlledActions.inspect(await actor(await privately('another turn'),null),quick.id,true);await s.controlledActions.inspect(reading,quick.id);
    assert.equal((await s.controlledActions.row(quick.id)).observed_in_turn,null,'only the asking turn\'s own wait counts');
    assert.equal((await s.controlledActions.inspect(reading,quick.id,true)).state,'done');
    assert.equal((await s.controlledActions.row(quick.id)).observed_in_turn,'done');
    await asking(read,'done');before=starts.length;
    assert.equal((await follow(quick.id)).state,'skipped');
    assert.deepEqual(pick(await row(quick.id),'state','error_code'),{state:'skipped',error_code:'answered_in_turn'});assert.equal(starts.length,before);
    // When the reply that held it may not have gone out, the follow-up answers.
    const dropped=await privately('dropped'),unsent=await operation(dropped,'printf made-up-unsent',null);
    await ran(unsent.id);await s.controlledActions.inspect(await actor(dropped,null),unsent.id,true);await asking(dropped,'ambiguous');
    assert.equal((await follow(unsent.id)).state,'running');assert.ok(starts.at(-1).text.includes('- '+unsent.id+' (shell): done'));
    await due(unsent.id);observed={state:'done'};assert.equal((await follow(unsent.id)).state,'completed');observed={state:'running'};
    await s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:enabled.revision,operation_id:key+':review'});
    await due(freed.id);observed={state:'done'};assert.equal((await follow(freed.id)).state,'completed');started={state:'done'};
    // The owner's own request in a group may send to their private chat without a card; its follow-up may not.
    const ownerAsk=await capture('owner in group',{update_id:++updates,message:{message_id:100+updates,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},
      from:{id:123,first_name:'Owner'},text:'Please run owner in group',message_thread_id:17,is_topic_message:true}});
    assert.equal((await s.telegramActions.request(await actor(ownerAsk,group),{destination:'123',text:'Made-up note the owner asked for'})).state,'approved');
    const ownerRun=await operation(ownerAsk,'printf made-up-owner-group');await asking(ownerAsk,'done');await decide(ownerRun,'na');await ran(ownerRun.id);
    started={state:'running'};observed={state:'running'};assert.equal((await follow(ownerRun.id)).state,'running');
    assert.equal((await s.telegramActions.request(await actor(ownerAsk,group),{destination:'123',text:'Made-up note a result asked for'})).state,'proposed');
    await due(ownerRun.id);observed={state:'done'};assert.equal((await follow(ownerRun.id)).state,'completed');started={state:'done'};
    // The owner's own wording starts the turn.
    await stores.control.query(`UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton`,[JSON.stringify({'telegram.action_continued':'Made-up follow-up:\n{actions}'})]);
    const worded=await message('worded'),wording=await operation(worded,'printf made-up-worded');await asking(worded,'done');await decide(wording,'na');await ran(wording.id);
    await follow(wording.id);assert.equal(starts.at(-1).text,'Made-up follow-up:\n- '+wording.id+' (shell): done');
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    // A member removed from the group, or a retired request, gets no follow-up; a running one is cancelled.
    const removedAsk=await message('removed'),removed=await operation(removedAsk,'printf made-up-removed');await asking(removedAsk,'done');await decide(removed,'na');await ran(removed.id);
    denied=['9'];before=starts.length;
    assert.equal((await follow(removed.id)).state,'skipped');
    assert.deepEqual(pick(await row(removed.id),'state','error_code'),{state:'suppressed',error_code:'conversation_not_selected'});assert.equal(starts.length,before);
    denied=[];
    const hiddenAsk=await message('hidden'),hidden=await operation(hiddenAsk,'printf made-up-hidden');await asking(hiddenAsk,'done');await decide(hidden,'na');await ran(hidden.id);
    await s.retirements.set(owner,hiddenAsk.id,{retired:true,expected_revision:0,operation_id:key+':hide'});
    assert.equal((await follow(hidden.id)).state,'cancelled');
    assert.deepEqual(pick(await row(hidden.id),'state','error_code'),{state:'cancelled',error_code:'source_retired'});assert.equal(starts.length,before);
    await s.continuations.cancelRetired([refusedAsk.id]);
    assert.deepEqual(cancels.at(-1),{channel:'telegram',event_id:refusedAsk.id,attempt:'c1-'+refused.id.slice(0,40)},'the attempt is the follow-up\'s own');
    await due(refused.id);observed={state:'cancelled'};assert.equal((await follow(refused.id)).state,'cancelled');
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM action_continuations WHERE event_id=ANY($1::text[]) AND state='running'",
      [[asked,failing,unsure,together,chatty,mine,refusedAsk,slow,lost,pair,order,stop,retry,free,worded,removedAsk,hiddenAsk].map(source=>source.id)])).rows[0].n,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
