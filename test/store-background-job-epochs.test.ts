import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {carriesForward} from '../src/stores/guards.js';
import {storageServices} from '../src/stores/services.js';

test('a job report survives a reaction in another group, any other change after the last step ends the job without a report, and Stop sends no further part',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-epochs-')),key='job-epochs:'+Date.now(),group='-100555',other='-100777';
  const cards:Record<string,any>[]=[];
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {costs:[0.5]};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      assert.equal(operation,'telegram.approval');cards.push(input);return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },honcho:async()=>{throw Error('no memory provider');}});
  let updates=0,sent=100,reactions=0;
  const capture=async(chat:string,payload:Record<string,any>)=>{
    const update=++updates,event:Envelope={version:1,key:key+':'+update,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,
      source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(update),occurred_at:null,text:payload.message?.text??null,payload:{update_id:update,...payload}};
    return (await s.capture.capture(event)).source.reference;
  };
  const message=async(chat:string,text:string)=>{
    const source=await capture(chat,{message:{message_id:++sent,date:1700000000+sent,chat:{id:Number(chat),type:'supergroup'},from:{id:9,first_name:'Member'},text}});
    await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  let noted=0;
  /** A reaction in the other group only starts a quiet epoch. */
  const react=async()=>{
    const before=(await s.guards.state()).epoch,emoji=++reactions%2?'👍':'❤️';
    await capture(other,{message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:noted,date:1700000500+reactions,user:{id:7},
      old_reaction:reactions===1?[]:[{type:'emoji',emoji:emoji==='👍'?'❤️':'👍'}],new_reaction:[{type:'emoji',emoji}]}});
    assert.equal((await s.guards.state()).epoch,before+1,'the reaction moves the epoch');
  };
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:group,space:group,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const reports=async(id:string)=>(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1',[id])).rows;
  const requests=async()=>Number((await stores.control.query('SELECT count(*) FROM telegram_action_requests')).rows[0].count);
  const approved=async(title:string)=>{
    const proposed=await s.jobs.start(await actor((await message(group,'Please check the made-up task list')).id),{title,instruction:'Compare the made-up task list with this chat.'});
    await s.jobs.decide('9',{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message(group,'Approve it'));
    return proposed.id;
  };
  /** What Hermes does with a job's latest step: read its context, claim it, then report what it left. */
  const runStep=async(id:string,text:string,continues=false)=>{
    const current=(await stores.control.query('SELECT event_id FROM background_steps WHERE job_id=$1 ORDER BY step DESC,attempt DESC LIMIT 1',[id])).rows[0];
    await s.jobs.steps.run(current.event_id,await authority());
    const context=await s.jobs.steps.context({event_id:current.event_id,owner_epoch:(await authority()).epoch});
    await s.jobs.steps.claim({...context,actor:context.actor});await s.jobs.steps.prepare({...context,actor:context.actor});
    await s.jobs.steps.finish({event_id:current.event_id,actor:context.actor,state:'done',session:context.conversation,error_code:null,text,continue:continues,todo:[],cost_usd:0.1});
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await s.jobs.saveSettings({admin:true,scope:null},{cost_limit_usd:5,minutes_limit:60,member_daily_jobs:10,revision:(await s.jobs.settings()).revision});
    const note=await message(other,'A made-up note in the other group');noted=sent;
    // A reaction while the job waits to start, and another after its last step, before the report.
    const kept=await approved('Task check');
    const asked=Number((await job(kept)).binding.epoch);
    await react();
    assert.equal((await tick(kept)).state,'waiting');
    await runStep(kept,'Report: made-up task 12 is still open.');
    await react();
    assert.equal((await tick(kept)).stage,'delivery');
    const [report]=await reports(kept);
    assert.deepEqual([report?.destination,report?.state],[group,'approved'],'the report goes to the chat where the job was asked');
    assert.equal((await s.guards.state()).epoch,asked+2);
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[report.id]);
    assert.equal((await tick(kept)).state,'completed');assert.equal((await job(kept)).state,'done');

    // A guarded-copy edit is not quiet: the report may hold what it withdrew, so none is sent.
    const outdated=await approved('Second task check');
    await tick(outdated);
    await runStep(outdated,'Report: made-up task 14 is done.');
    const plain=await s.guards.read('events:'+note.id,await s.guards.state());
    await s.guards.edit('events:'+note.id,plain.revision,{...plain.value as any,text:'An edited made-up note'},key+':edit');
    const before=await requests();
    assert.equal((await tick(outdated)).state,'failed');
    const failed=await job(outdated);
    assert.deepEqual([failed.state,failed.error_code],['failed','job_report_outdated']);
    assert.deepEqual(await reports(outdated),[]);assert.equal(await requests(),before,'nothing is sent');
    assert.match(cards.filter(card=>card.kind==='settle').at(-1)!.text,/It stopped because of a problem/,'the card shows the job failed');
    // A later reaction does not bring the report back.
    await react();assert.equal((await tick(outdated)).state,'failed');assert.equal(await requests(),before);

    // An edit before the last step is not a change after it: the report is sent from the last step's
    // epoch, and a reaction between its two parts still lets the second part go.
    const long=await approved('Long task check');
    await tick(long);
    await runStep(long,'Made-up notes so far.',true);
    const copy=await s.guards.read('events:'+note.id,await s.guards.state());
    await s.guards.edit('events:'+note.id,copy.revision,{...copy.value as any,text:'A made-up note, edited again'},key+':edit-again');
    assert.equal((await tick(long)).state,'waiting','the job goes on to its last step');
    await runStep(long,'Part one: made-up task 12 is open. '+'x'.repeat(7000)+'\n\nPart two: made-up task 14 is done. '+'y'.repeat(7000));
    await react();
    assert.equal(await carriesForward(stores.control,(await job(long)).binding,await s.guards.state()),false,'the edit came after the job was asked');
    assert.equal((await tick(long)).stage,'delivery');
    const [first]=await reports(long);
    assert.deepEqual([first?.destination,first?.state],[group,'approved'],'the first part is sent');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[first.id]);
    await react();
    assert.equal((await tick(long)).stage,'delivery');
    const second=(await reports(long)).find(row=>row.id!==first.id);
    assert.deepEqual([second?.destination,second?.state],[group,'approved'],'the second part follows after a reaction');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[second.id]);
    assert.equal((await tick(long)).state,'completed');assert.equal((await job(long)).state,'done');

    // Stop while a report is being sent: the part already on its way may arrive, but no further part is sent.
    const halted=await approved('Stopped task check');
    await tick(halted);
    await runStep(halted,'Part one: made-up task 16 is open. '+'x'.repeat(7000)+'\n\nPart two: made-up task 18 is late. '+'y'.repeat(7000));
    assert.equal((await tick(halted)).stage,'delivery');
    const [staged]=await reports(halted);
    assert.equal((await s.jobs.stop(await actor((await message(group,'Stop the made-up job')).id),{id:halted})).state,'stopping');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[staged.id]);
    const count=await requests();
    assert.equal((await tick(halted)).state,'cancelled');assert.equal((await job(halted)).state,'stopped');
    assert.equal((await reports(halted)).length,1);assert.equal(await requests(),count,'no further part is sent');
    assert.match(cards.filter(card=>card.kind==='settle').at(-1)!.text,/🚫 Stopped\./,'the card shows the job stopped');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
