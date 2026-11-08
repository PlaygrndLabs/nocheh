import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('a job\'s changes wait for its end, then come on as few cards as fit, each approved or rejected as a whole; Stop ends them',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-changes-')),key='job-changes:'+Date.now(),group='-100555';
  const cards:Record<string,any>[]=[],notices:Record<string,any>[]=[],owner:Reader={admin:true,scope:null};
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
      assert.equal(operation,'telegram.approval');cards.push(input);return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },honcho:async()=>{throw Error('no memory provider');}});
  let sent=100,updates=0;
  const bot=String(Date.now()).slice(-9);
  const capture=async(chat:string,payload:Record<string,any>)=>{
    const update=payload.update_id,event:Envelope={version:1,key:update?`telegram:${bot}:update:${update}`:key+':'+(++sent),origin:'live',kind:'telegram_update',bot_id:update?bot:key,scope:chat,
      source_id:String(update??sent),revision:'1',occurred_at:null,text:payload.message?.text??null,payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const message=(chat:string,from:number,text:string)=>capture(chat,{message:{message_id:sent+1,date:1700000000+sent,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}});
  const press=(data:string,from:number)=>capture('123',{update_id:++updates,callback_query:{id:'query-'+updates,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:123,type:'private'}}}});
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const states=async(ids:string[])=>(await stores.control.query('SELECT id,state,error_code FROM controlled_actions WHERE id=ANY($1) ORDER BY id',[ids])).rows;
  /** The owner's job asked for in their private chat, approved, with its first step claimed; returns the step's own reader. */
  const running=async(title:string)=>{
    const proposed=await s.jobs.start(await actor((await message('123',123,'Update my made-up task table')).id,null,'123'),
      {title,instruction:'Update the made-up Notion task table from the group chat.',chat:group});
    await s.jobs.decide('123',{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message('123',123,'Approve'));
    await tick(proposed.id);
    const step=(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[proposed.id])).rows[0].event_id;
    await s.jobs.runs.run(step,await authority());
    const context=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});
    const binding=await s.guards.state(),reader:Reader={admin:false,scope:null,space:'123',turnEvent:step,logical_profile:'job-'+proposed.id.slice(0,24),
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    return {id:proposed.id,reader,step,context:context as any};
  };
  /** A Notion change from the step, offered as the server offers it. */
  const change=async(reader:Reader,title:string,notes='')=>s.actionCommands.offer('controlled',await s.controlledActions.propose(reader,
    {kind:'mcp',arguments:{connection:'notion',tool:'notion-update-page',input:{page:'made-up-page',properties:{title},...(notes?{notes}:{})}}}));
  /** The step ends with its report, and the report is delivered, so the job ends done. */
  const end=async(job:{id:string;step:string;context:any},text:string)=>{
    await s.jobs.runs.prepare({...job.context,actor:job.context.actor});
    await s.jobs.runs.finish({event_id:job.step,actor:job.context.actor,state:'done',session:job.context.conversation,error_code:null,text,todo:[],tokens:{input_tokens:50000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1}});
    assert.equal((await tick(job.id)).stage,'delivery');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[job.id]);
    return tick(job.id);
  };
  const frozenCards=async(id:string)=>(await stores.control.query('SELECT changes FROM background_jobs WHERE id=$1',[id])).rows[0].changes;
  const listCards=()=>cards.filter(card=>card.kind==='card'&&card.chat_id==='123'&&/^📋/.test(card.text));
  const last=(kind:string,id?:string)=>cards.filter(card=>card.kind===kind&&(!id||card.id===id)).at(-1)!;
  const button=(card:any,approve:boolean)=>card.buttons[approve?0:1][1];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await message(group,9,'A made-up task: send the invoice');
    await s.notion.save(owner,{enabled:true,expected_revision:(await s.notion.get(owner)).revision});

    // While the job runs, each change it asks for is kept, with no card of its own.
    const job=await running('Task table update'),before=cards.length,members:string[]=[];
    for(const title of ['وظیفه ۱۲','وظیفه ۱۴','Made-up task 16']) {
      const kept=await change(job.reader,title);
      assert.equal(kept.state,'proposed');assert.match(kept.message,/Kept with this job's other changes[^]*Do not wait for it/);members.push(kept.id);
    }
    for(const index of [1,2,3])members.push((await change(job.reader,'Made-up task '+(20+index),'n'.repeat(1500))).id);
    const unseen=(await change(job.reader,'Made-up task 30','x'.repeat(2500))).id;
    assert.equal(cards.length,before,'no card while the job runs');
    assert.deepEqual((await states([...members,unseen])).map(row=>row.state),Array(7).fill('proposed'));

    // The job ends: after its report, its changes come on cards that fit Telegram, in the owner's private chat.
    await s.jobs.runs.prepare({...job.context,actor:job.context.actor});
    await s.jobs.runs.finish({event_id:job.step,actor:job.context.actor,state:'done',session:job.context.conversation,error_code:null,text:'Report: 6 made-up changes proposed.',todo:[],tokens:{input_tokens:50000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1}});
    assert.equal((await tick(job.id)).stage,'delivery');
    assert.deepEqual(listCards(),[],'the cards come after the report');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[job.id]);
    assert.equal((await tick(job.id)).state,'completed');
    const [first,second,...more]=listCards();
    assert.ok(first&&second&&!more.length,'six changes fit on two cards');
    const frozen=(await stores.control.query('SELECT changes FROM background_jobs WHERE id=$1',[job.id])).rows[0].changes;
    const [onFirst,onSecond]=frozen.map((card:any)=>card.members.map(([id]:[string])=>id)) as [string[],string[]];
    assert.deepEqual([first!.id,second!.id],frozen.map((card:any)=>card.id));
    assert.deepEqual([...onFirst,...onSecond],members,'every change that fits is on a card, in the order asked');
    for(const card of [first!,second!]) {
      assert.ok(card.text.length<=4096-300,'room is left for the outcome line');
      assert.equal(card.chat_id,'123');
    }
    assert.ok(first!.text.startsWith(`📋 The job “Task table update” asks to make these changes (${onFirst.length}).\nCard 1 of 2.\nApprove or Reject covers exactly the changes on this card.\n\n1. ⚙️ mcp\n`));
    assert.ok(first!.text.includes(canonical((await s.controlledActions.inspect(owner,members[0]!)).arguments)),'each change is shown exactly');
    assert.match(second!.text,/Card 2 of 2\.[^]*\n\n1 more cannot be shown on a card\. Review them in the dashboard Inbox\.$/);
    assert.doesNotMatch(first!.text,/cannot be shown/);

    // Only the owner decides a list card, and the press decides exactly the changes on it.
    await s.actionCommands.callback(await press(button(first,true),9));
    assert.equal(last('answer').text,'Only the owner can approve or reject this.');
    assert.equal((await states(members)).filter(row=>row.state==='proposed').length,6);
    await s.actionCommands.callback(await press(button(first,true),123));
    assert.equal(last('answer').text,'✅ Approved.');
    assert.deepEqual((await states(onFirst)).map(row=>row.state),onFirst.map(()=>'approved'));
    assert.ok((await states([...onSecond,unseen])).every(row=>row.state==='proposed'),'the other card and the long change are untouched');
    assert.equal(last('settle',first!.id).text,first!.text+'\n\n✅ Approved.');
    // As each change ends, the card says how they ended.
    const failed=onFirst.at(-1)!;
    await stores.control.query("UPDATE controlled_actions SET state='done' WHERE id=ANY($1)",[onFirst.slice(0,-1)]);
    await stores.control.query("UPDATE controlled_actions SET state='failed',error_code='tool_reported_error' WHERE id=$1",[failed]);
    await s.actionCommands.settle('controlled',failed);
    assert.equal(last('settle',first!.id).text,first!.text+`\n\n⚠️ Approved: ${onFirst.length-1} of ${onFirst.length} changes were made. See the dashboard Inbox for the rest.`);
    await s.actionCommands.callback(await press(button(first,true),123));
    assert.match(last('answer').text,/already decided/,'a second press changes nothing');
    // Reject covers its own card only.
    await s.actionCommands.callback(await press(button(second,false),123));
    assert.deepEqual((await states(onSecond)).map(row=>[row.state,row.error_code]),onSecond.map(()=>['rejected',null]));
    assert.equal((await states([unseen]))[0].state,'proposed','a change that is not on a card waits in the Inbox');
    assert.equal(last('settle',second!.id).text,second!.text+'\n\n❌ Rejected. Nothing ran.');
    assert.equal(listCards().length,2,'a settle never sends the cards again');
    await s.actionCommands.settle('background',job.id);assert.equal(listCards().length,2);

    // A change the owner decided in the Inbox keeps that decision when the card is pressed.
    const inbox=await running('Inbox first'),[early,other]=[(await change(inbox.reader,'Made-up task 50')).id,(await change(inbox.reader,'Made-up task 52')).id];
    assert.equal((await end(inbox,'Report: two made-up changes.')).state,'completed');
    const [both]=(await frozenCards(inbox.id)),bothCard=listCards().at(-1)!;
    assert.deepEqual([bothCard.id,both.members.map(([id]:[string])=>id)],[both.id,[early,other]]);
    const view=await s.controlledActions.inspect(owner,early!);
    await s.controlledActions.decide(owner,{id:early,fingerprint:view.fingerprint,decision:'approve'});
    await s.actionCommands.callback(await press(button(bothCard,false),123));
    assert.equal(last('answer').text,'❌ Rejected 1 of 2. The rest were already decided; see the dashboard Inbox.');
    assert.deepEqual((await states([early!,other!])).map(row=>[row.id,row.state]).sort(),[[early,'approved'],[other,'rejected']].sort());
    await stores.control.query("UPDATE controlled_actions SET state='done' WHERE id=$1",[early]);
    await s.actionCommands.settle('controlled',early!);
    assert.equal(last('settle',bothCard.id).text,bothCard.text+'\n\n⚠️ Approved: 1 of 2 changes were made. See the dashboard Inbox for the rest.');

    // A change whose inputs changed before the owner decided did not run, and the card says why.
    const blocked=await running('Changed meanwhile'),gone=(await change(blocked.reader,'Made-up task 60')).id;
    assert.equal((await end(blocked,'Report: one made-up change.')).state,'completed');
    const goneCard=listCards().at(-1)!;assert.equal(goneCard.id,(await frozenCards(blocked.id))[0].id);
    await stores.control.query("UPDATE controlled_actions SET state='rejected',error_code='guard_context_changed' WHERE id=$1",[gone]);
    await s.actionCommands.settle('controlled',gone);
    assert.equal(last('settle',goneCard.id).text,goneCard.text+'\n\n🚫 It did not run: something it used changed after it was asked. Ask again if you still want it.');

    // Changes that fit no card are still named to the owner, once, without buttons.
    const lone=await running('Long only'),big=await change(lone.reader,'Made-up task 70','y'.repeat(2500));
    assert.match(big.message,/too long for a Telegram card[^]*dashboard Inbox/);
    const listed=listCards().length;
    assert.equal((await end(lone,'Report: one long made-up change.')).state,'completed');
    assert.equal(listCards().length,listed);assert.deepEqual(await frozenCards(lone.id),[]);
    assert.deepEqual(notices.map(notice=>[notice.chat_id,notice.text]),[['123','📋 The job “Long only” asks to make changes that cannot be shown on a card (1). Review them in the dashboard Inbox.']]);
    await s.actionCommands.settle('background',lone.id);assert.equal(notices.length,1);

    // Stop while the report is on its way: the job still ends done, but what it kept ends and comes on no card.
    const late=await running('Stopped while reporting'),kept=(await change(late.reader,'Made-up task 80')).id;
    await s.jobs.runs.prepare({...late.context,actor:late.context.actor});
    await s.jobs.runs.finish({event_id:late.step,actor:late.context.actor,state:'done',session:late.context.conversation,error_code:null,text:'Report: one made-up change.',todo:[],tokens:{input_tokens:50000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1}});
    assert.equal((await tick(late.id)).stage,'delivery');
    assert.equal((await s.jobs.stop(await actor((await message('123',123,'Stop it now')).id,null,'123'),{id:late.id})).state,'stopping');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[late.id]);
    const count=listCards().length;
    await tick(late.id);
    assert.deepEqual((await states([kept])).map(row=>[row.state,row.error_code]),[['rejected','job_stopped']]);
    assert.equal(listCards().length,count,'no card after Stop');
    await assert.rejects(s.jobs.stop(await actor((await message('123',123,'Stop it again')).id,null,'123'),{id:late.id}),{code:'job_not_running'});

    // Stop: the changes a stopped job kept never come on a card and never run.
    const stopped=await running('Stopped update'),held=(await change(stopped.reader,'Made-up task 40')).id,shownBefore=listCards().length;
    // Once a job is stopping, its step asks for nothing more, even before its run is cancelled.
    await stores.control.query('UPDATE background_jobs SET cancel_requested=true WHERE id=$1',[stopped.id]);
    await assert.rejects(change(stopped.reader,'Made-up task 42'),{code:'job_not_running'});
    await stores.control.query('UPDATE background_jobs SET cancel_requested=false WHERE id=$1',[stopped.id]);
    assert.equal((await s.jobs.stop(await actor((await message('123',123,'Stop it')).id,null,'123'),{id:stopped.id})).state,'stopping');
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[stopped.id]);
    assert.equal((await tick(stopped.id)).state,'cancelled');
    assert.deepEqual((await states([held])).map(row=>[row.state,row.error_code]),[['rejected','job_stopped']]);
    assert.equal(listCards().length,shownBefore,'no card for a stopped job');
    assert.match(last('settle',stopped.id).text,/🚫 Stopped\./);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
