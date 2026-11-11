import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ownerApprovedJob} from '../src/stores/background-jobs.js';
import {storageServices} from '../src/stores/services.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('a job the owner approved in their private chat reads Notion under the owner\'s setting, its changes always ask, and Stop stops what has not run',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-notion-')),key='job-notion:'+Date.now(),group='-100555';
  const cards:Record<string,any>[]=[],owner:Reader={admin:true,scope:null};
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      assert.equal(operation,'telegram.approval');cards.push(input);return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let sent=100;
  const message=async(chat:string,from:number,text:string)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',occurred_at:null,text,
      payload:{message:{message_id:id,date:1700000000+id,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}}};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  /** A job asked for in `chat` and approved by `by`, with its first step claimed and still running; returns the step's own reader.
   *  `between` runs after it is asked and before it is approved. */
  const running=async(chat:string,from:number,by:string,title:string,between?:()=>Promise<unknown>)=>{
    const scope=chat==='123'?null:chat,proposed=await s.jobs.start(await actor((await message(chat,from,'Check the made-up task table')).id,scope,chat),
      {title,instruction:'Compare the made-up Notion task table with the group chat.',chat:group});
    await between?.();
    await s.jobs.decide(by,{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message(chat,Number(by),'Approve'));
    await tick(proposed.id);
    const step=(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[proposed.id])).rows[0].event_id;
    await s.jobs.runs.run(step,await authority());
    const context=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});
    const binding=await s.guards.state(),reader:Reader={admin:false,scope,space:chat,turnEvent:step,logical_profile:'job-'+proposed.id.slice(0,24),
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    return {id:proposed.id,reader};
  };
  const notion=(reader:Reader,tool:string,input:Record<string,unknown>)=>s.controlledActions.propose(reader,{kind:'mcp',arguments:{connection:'notion',tool,input}});
  /** The executor's claim of an operation, as the tools workflow makes it. */
  const claim=async(id:string)=>{
    const workflow=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:workflow.id,dispatch:workflow.dispatch,family:'tools',run_id:'fixture-'+workflow.id});
    return s.controlledExecution.claim({id,actor:'wf-'+workflow.id,workflow_id:workflow.id,workflow_token:lease.token});
  };
  const search={query:'made-up tasks'},create={pages:[{properties:{title:'وظیفه ۱۲'}}]};
  const saveNotion=async(change:Record<string,unknown>)=>s.notion.save(owner,{...change,expected_revision:(await s.notion.get(owner)).revision});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await message(group,9,'A made-up task: send the invoice');

    // The card says what the job may do in Notion; only the owner's private job gets the line.
    const card=async(id:string)=>(await s.jobs.card(id)).text;
    const offered=await s.jobs.start(await actor((await message('123',123,'Check my made-up table')).id,null,'123'),{title:'Card check',instruction:'Read it.',chat:group});
    assert.doesNotMatch(await card(offered.id),/📒/,'no line while Notion is off');
    await saveNotion({enabled:true});
    assert.doesNotMatch(await card(offered.id),/📒/,'the card keeps what the job was asked with');
    const later=await s.jobs.start(await actor((await message('123',123,'Check my made-up table later')).id,null,'123'),{title:'Later card check',instruction:'Read it.',chat:group});
    assert.match(await card(later.id),/🛑 Stops at \$5\.0 or 45 min, not counting the secret check\n🔎 Starting it already used one secret check\.\n📒 It can read your Notion without asking\. Changes still ask you\./);
    const member=await s.jobs.start(await actor((await message(group,9,'Check it here')).id,group,group),{title:'Group card',instruction:'Read it.'});
    assert.doesNotMatch(await card(member.id),/📒/,'a group job never reaches Notion, so its card says nothing about it');
    // Approved after everything asks, the job keeps no Notion reads: approval only narrows what the card offered.
    await saveNotion({approval:'everything'});
    await s.jobs.decide('123',{id:later.id,fingerprint:later.fingerprint,decision:'approve'},await message('123',123,'Approve'));
    assert.equal((await stores.control.query('SELECT notion_reads FROM background_jobs WHERE id=$1',[later.id])).rows[0].notion_reads,false);
    assert.doesNotMatch(await card(later.id),/📒/,'its settled card says so');
    // A job asked while everything asks, and approved after reads are let run, gets none: Approve never records more than its
    // card showed, and the setting never widens a job.
    const off=await running('123',123,'123','Asked without reads',()=>saveNotion({approval:'changes'}));
    assert.equal((await stores.control.query('SELECT notion_reads FROM background_jobs WHERE id=$1',[off.id])).rows[0].notion_reads,false);
    assert.doesNotMatch(await card(off.id),/📒/);
    assert.equal((await notion(off.reader,'notion-search',{query:'made-up'})).state,'proposed');
    // Reject keeps what the card offered, so the settled card still shows it.
    const declined=await s.jobs.start(await actor((await message('123',123,'Check my made-up table once more')).id,null,'123'),{title:'Declined card check',instruction:'Read it.',chat:group});
    assert.match(await card(declined.id),/📒/);
    await s.jobs.decide('123',{id:declined.id,fingerprint:declined.fingerprint,decision:'reject'},await message('123',123,'Reject'));
    const settled=(await stores.control.query('SELECT state,notion_reads FROM background_jobs WHERE id=$1',[declined.id])).rows[0];
    assert.deepEqual([settled.state,settled.notion_reads],['rejected',true]);
    assert.match(await card(declined.id),/📒/,'its settled card still shows what it was asked with');
    assert.equal((await s.jobs.stop(await actor((await message('123',123,'Stop that one')).id,null,'123'),{id:off.id})).state,'stopping');
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[off.id]);
    assert.equal((await tick(off.id)).state,'cancelled');

    // A step of the owner's approved private job: reads run under the setting, changes always ask.
    const mine=await running('123',123,'123','Task table check');
    const read=await notion(mine.reader,'notion-search',search);
    assert.equal(read.state,'approved');assert.match(read.message,/Notion setting/);
    const row=(await stores.control.query('SELECT job_id,decision_reference,source_reference FROM controlled_actions WHERE id=$1',[read.id])).rows[0];
    assert.equal(row.job_id,mine.id);assert.deepEqual(row.decision_reference,row.source_reference,'the step\'s own operation is the decision');
    assert.ok((await stores.control.query("SELECT 1 FROM security_events WHERE rule=$1 AND state='allowed'",['notion_setting:'+(await s.notion.get(owner)).revision])).rowCount);
    assert.equal((await notion(mine.reader,'notion-create-pages',create)).state,'proposed','a change asks the owner');
    const table='collection://01234567-89ab-cdef-0123-456789abcdef';
    assert.equal((await notion(mine.reader,'notion-query-data-sources',{data:{data_source_urls:[table],query:'SELECT * FROM "'+table+'"'}})).state,'approved',
      'a query of the owner\'s own table is a read');
    await saveNotion({approval:'nothing'});
    assert.equal((await notion(mine.reader,'notion-create-pages',{pages:[{properties:{title:'وظیفه ۱۴'}}]})).state,'proposed',
      'even when nothing asks, a job\'s change asks: the job reads group text anyone there can write');
    assert.equal((await notion(mine.reader,'notion-fetch',{id:'0123456789abcdef0123456789abcdef'})).state,'approved');
    assert.equal((await notion(mine.reader,'notion-fetch',{id:'https://made-up.notion.site/Page'})).state,'proposed','a job fetches only by id or notion.so address without asking');
    assert.equal((await notion(mine.reader,'notion-search',{query:'made-up tasks',page_url:'https://made-up.notion.site/Page'})).state,'proposed',
      'outside addresses ask first, in any read');
    assert.equal((await notion(mine.reader,'notion-query-data-sources',{data:{mode:'view',view_url:'https://made-up.notion.site/x?v=1'}})).state,'proposed');
    await saveNotion({approval:'everything'});
    assert.equal((await notion(mine.reader,'notion-search',{query:'other made-up tasks'})).state,'proposed');
    await saveNotion({approval:'changes'});
    // The owner freedom setting never applies to a job.
    const freedom=await s.ownerAutonomy.get(owner);
    await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:freedom.revision,operation_id:key+':free'});
    assert.equal((await s.controlledActions.propose(mine.reader,{kind:'shell',arguments:{command:'printf made-up'}})).state,'proposed');

    // Only the step's own operation, of a job still running, uses the setting: a scheduled run's operation is no step.
    const stepTurn={owner:true,job:mine.id,logical_profile:mine.reader.logical_profile!};
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn),true);
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:digest('a scheduled run')},stepTurn),false);
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},{...stepTurn,logical_profile:'job-other'}),false);
    // Card-free reads need the Notion reads the job was approved with, as well as the current setting.
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn,true),true);
    await stores.control.query('UPDATE background_jobs SET notion_reads=false WHERE id=$1',[mine.id]);
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn,true),false);
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn),true,'the job itself is still approved');
    assert.equal((await notion(mine.reader,'notion-search',{query:'made-up without reads'})).state,'proposed');
    await stores.control.query('UPDATE background_jobs SET notion_reads=true WHERE id=$1',[mine.id]);
    // Right before a read the setting let through runs, its job must still be the owner's, approved with Notion reads.
    for(const [change,undo] of [['notion_reads=false','notion_reads=true'],["decided_by='9'","decided_by='123'"]] as [string,string][]) {
      const waiting=await notion(mine.reader,'notion-search',{query:'made-up check '+change});assert.equal(waiting.state,'approved');
      await stores.control.query(`UPDATE background_jobs SET ${change} WHERE id=$1`,[mine.id]);
      assert.deepEqual(await claim(waiting.id),{claimed:false,blocked:waiting.id,reason:'notion_job_not_approved'},change);
      await stores.control.query(`UPDATE background_jobs SET ${undo} WHERE id=$1`,[mine.id]);
    }

    // Stop: a read the setting let run but that has not run yet does not run, and no new read is let through.
    const pending=await notion(mine.reader,'notion-fetch',{id:'https://www.notion.so/Made-up-0123456789abcdef0123456789abcde2'});assert.equal(pending.state,'approved');
    assert.equal((await s.jobs.stop(await actor((await message('123',123,'Stop it')).id,null,'123'),{id:mine.id})).state,'stopping');
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn),false,'a stopping job uses the setting no more');
    await notion(mine.reader,'notion-search',{query:'after stop'}).then(
      after=>assert.notEqual(after.state,'approved','a stopped job reads nothing without asking'),
      error=>assert.ok(['runtime_turn_changed','job_not_running'].includes(error.code),String(error.code)));
    assert.deepEqual(await claim(pending.id),{claimed:false,blocked:pending.id,reason:'job_stopped'});
    const stopped=(await stores.control.query('SELECT state,error_code FROM controlled_actions WHERE id=$1',[pending.id])).rows[0];
    assert.deepEqual([stopped.state,stopped.error_code],['rejected','job_stopped']);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[mine.id]);
    assert.equal((await tick(mine.id)).state,'cancelled','the job ends stopped and frees its slot');

    // A group job, even one the owner approved, never reaches Notion, not even as a card.
    const theirs=await running(group,9,'123','Group task check');
    await assert.rejects(notion(theirs.reader,'notion-search',search),{code:'notion_owner_private_only'});
    const asked=await running(group,9,'9','Member task check');
    await assert.rejects(notion(asked.reader,'notion-search',search),{code:'notion_owner_private_only'});
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM controlled_actions WHERE kind='mcp' AND space_id=$1",[group])).rows[0].n,0);

  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
