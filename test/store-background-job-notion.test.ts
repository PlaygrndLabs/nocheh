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
      if(operation==='usage.price')return {costs:[0.5]};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      assert.equal(operation,'telegram.approval');cards.push(input);return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },honcho:async()=>{throw Error('no memory provider');}});
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
  /** A job asked for in `chat` and approved by `by`, with its first step claimed and still running; returns the step's own reader. */
  const running=async(chat:string,from:number,by:string,title:string)=>{
    const scope=chat==='123'?null:chat,proposed=await s.jobs.propose(await actor((await message(chat,from,'Check the made-up task table')).id,scope,chat),
      {title,instruction:'Compare the made-up Notion task table with the group chat.',chat:group});
    await s.jobs.decide(by,{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message(chat,Number(by),'Approve'));
    await tick(proposed.id);
    const step=(await stores.control.query('SELECT event_id FROM background_steps WHERE job_id=$1 ORDER BY step DESC,attempt DESC LIMIT 1',[proposed.id])).rows[0].event_id;
    await s.jobs.steps.run(step,await authority());
    const context=await s.jobs.steps.context({event_id:step,owner_epoch:(await authority()).epoch});
    await s.jobs.steps.claim({...context,actor:context.actor});
    const binding=await s.guards.state(),reader:Reader={admin:false,scope,space:chat,turnEvent:step,logical_profile:'job-'+proposed.id.slice(0,24),
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    return {id:proposed.id,reader};
  };
  const notion=(reader:Reader,tool:string,input:Record<string,unknown>)=>s.controlledActions.propose(reader,{kind:'mcp',arguments:{connection:'notion',tool,input}});
  const search={query:'made-up tasks'},create={pages:[{properties:{title:'وظیفه ۱۲'}}]};
  const saveNotion=async(change:Record<string,unknown>)=>s.notion.save(owner,{...change,expected_revision:(await s.notion.get(owner)).revision});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await message(group,9,'A made-up task: send the invoice');

    // The card says what the job may do in Notion; only the owner's private job gets the line.
    const card=async(id:string)=>(await s.jobs.card(id)).text;
    const offered=await s.jobs.propose(await actor((await message('123',123,'Check my made-up table')).id,null,'123'),{title:'Card check',instruction:'Read it.',chat:group});
    assert.doesNotMatch(await card(offered.id),/📒/,'no line while Notion is off');
    await saveNotion({enabled:true});
    assert.match(await card(offered.id),/🛑 Stops at \$5\.0 or 60 min\n📒 It can read your Notion without asking\. Changes still ask you\./);
    const member=await s.jobs.propose(await actor((await message(group,9,'Check it here')).id,group,group),{title:'Group card',instruction:'Read it.'});
    assert.doesNotMatch(await card(member.id),/📒/,'a group job never reaches Notion, so its card says nothing about it');
    await saveNotion({approval:'everything'});
    assert.doesNotMatch(await card(offered.id),/📒/,'when everything asks, the job reads nothing without asking');
    await saveNotion({approval:'changes'});

    // A step of the owner's approved private job: reads run under the setting, changes always ask.
    const mine=await running('123',123,'123','Task table check');
    const read=await notion(mine.reader,'notion-search',search);
    assert.equal(read.state,'approved');assert.match(read.message,/Notion setting/);
    const row=(await stores.control.query('SELECT job_id,decision_reference,source_reference FROM controlled_actions WHERE id=$1',[read.id])).rows[0];
    assert.equal(row.job_id,mine.id);assert.deepEqual(row.decision_reference,row.source_reference,'the step\'s own operation is the decision');
    assert.ok((await stores.control.query("SELECT 1 FROM security_events WHERE rule=$1 AND state='allowed'",['notion_setting:'+(await s.notion.get(owner)).revision])).rowCount);
    assert.equal((await notion(mine.reader,'notion-create-pages',create)).state,'proposed','a change asks the owner');
    await saveNotion({approval:'nothing'});
    assert.equal((await notion(mine.reader,'notion-create-pages',{pages:[{properties:{title:'وظیفه ۱۴'}}]})).state,'proposed',
      'even when nothing asks, a job\'s change asks: the job reads group text anyone there can write');
    assert.equal((await notion(mine.reader,'notion-fetch',{id:'0123456789abcdef0123456789abcdef'})).state,'approved');
    assert.equal((await notion(mine.reader,'notion-fetch',{id:'https://made-up.notion.site/Page'})).state,'proposed','a job fetches only by id or notion.so address without asking');
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

    // Stop: a read the setting let run but that has not run yet does not run, and no new read is let through.
    const pending=await notion(mine.reader,'notion-fetch',{id:'https://www.notion.so/Made-up-0123456789abcdef0123456789abcde2'});assert.equal(pending.state,'approved');
    assert.equal((await s.jobs.stop(await actor((await message('123',123,'Stop it')).id,null,'123'),{id:mine.id})).state,'stopping');
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:mine.reader.turnEvent!},stepTurn),false,'a stopping job uses the setting no more');
    await notion(mine.reader,'notion-search',{query:'after stop'}).then(
      after=>assert.notEqual(after.state,'approved','a stopped job reads nothing without asking'),
      error=>assert.ok(['runtime_turn_changed','job_not_running'].includes(error.code),String(error.code)));
    const workflow=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[pending.id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:workflow.id,dispatch:workflow.dispatch,family:'tools',run_id:'fixture-'+workflow.id});
    const claimed=await s.controlledExecution.claim({id:pending.id,actor:'wf-'+workflow.id,workflow_id:workflow.id,workflow_token:lease.token});
    assert.deepEqual(claimed,{claimed:false,blocked:pending.id,reason:'job_stopped'});
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
