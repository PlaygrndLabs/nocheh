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
import {honchoEngine} from '../src/memory/honcho.js';

test('a job on the owner\'s machine asked in a group reports to the owner\'s private chat; the group gets one line and never sees the machine, the plan or the to-do list',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:600000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-machine-report-')),key='machine-report:'+Date.now();
  const project='-1001000000001',projectId=digest(key+':project'),owner:Reader={admin:true,scope:null},previous=process.env.NOCHEH_MACHINE_TOKEN;
  process.env.NOCHEH_MACHINE_TOKEN='synthetic-machine-token-'+'r'.repeat(24);
  const policy={enabled:true,owner_id:'123',group_ids:[project],group_access:{[project]:{granted:['9'],denied:[]}},topic_memory:'group' as const};
  const approvals:any[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.approval')approvals.push(input);
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let sent=100;
  const message=async(chat:string,from:number,text:string)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',
      occurred_at:null,text,payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}}};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  /** A person's live message in a chat, as the turn that answers it. */
  const said=async(chat:string,from:number,text:string):Promise<Reader>=>{
    const source=(await message(chat,from,text)).id,binding=await s.guards.state();
    return {admin:false,scope:chat==='123'?null:chat,space:chat,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const steps=['Install the made-up tool','Run its tests'];
  const request={title:'Set up the made-up project',instruction:'Set up the made-up project on the machine.',machine:'build-vm',steps};
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const reports=async(id:string)=>(await stores.control.query(`SELECT b.part,a.id,a.destination,a.text_hash,a.state FROM background_reports b
    JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1 ORDER BY b.part`,[id])).rows;
  const delivered=(id:string,state='done')=>stores.control.query('UPDATE telegram_action_requests SET state=$2 WHERE id=$1',[id,state]);
  /** Approve a job, start its run and claim it as Hermes does. */
  const run=async(asked:{id:string;fingerprint:string})=>{
    await s.jobs.decide('123',{id:asked.id,fingerprint:asked.fingerprint,decision:'approve'},await message('123',123,'Approve'));
    await tick(asked.id);
    const step=(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[asked.id])).rows[0].event_id as string;
    await s.jobs.runs.run(step,await authority());
    const context:any=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});await s.jobs.runs.prepare({...context,actor:context.actor});
    return {step,context};
  };
  const finish=(started:{step:string;context:any},text:string)=>s.jobs.runs.finish({event_id:started.step,actor:started.context.actor,state:'done',session:started.context.conversation,error_code:null,text});
  const beat=(started:{context:any},progress:unknown)=>s.jobs.runs.heartbeat({...started.context,actor:started.context.actor,progress});
  const tokens=(input_tokens:number)=>({input_tokens,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1});
  const secrets=['build-vm','192.0.2.10','nocheh@',steps[0]!,steps[1]!,'Report PRIVATEMARK7','Check the made-up log'];
  const clean=(value:unknown,what:string)=>{const text=JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),what+' shows '+secret+': '+text);};
  const groupLine='✅ Done: the job you asked for here finished. Its report is in your private chat.';
  const limitedLine='⏱ The job you asked for here stopped at its limit. A short note is in your private chat.';
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy,'on');
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'Made-up project','active',1)",[projectId]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[project,projectId]);
    await stores.control.query(`INSERT INTO machines(id,name,address,login,key_ref,public_key,host_key,tested_at) VALUES($1,'build-vm','192.0.2.10','nocheh',$2,$3,$4,now())`,
      ['a'.repeat(32),'machines/'+'a'.repeat(32)+'/key','ssh-ed25519 '+'A'.repeat(68)+' nocheh build-vm','SHA256:'+'A'.repeat(43)]);

    // Asked by the owner in the project's group: the start result there names no machine and no plan.
    const grouped=await s.jobs.start(await said(project,123,'Set up the made-up project'),request);
    assert.equal(grouped.approver,'owner');clean(grouped,'the start result in the group');
    approvals.length=0;
    const offered=await s.actionCommands.offer('background',grouped);
    assert.equal(approvals[0].chat_id,'123','its card is in the owner\'s private chat');
    assert.match(String(offered.message),/their card is waiting in their private chat; the report goes there too, and a short line follows here when it is done/);
    const started=await run(grouped);
    await s.actionCommands.settle('background',grouped.id);
    assert.ok(approvals.some(input=>input.kind==='settle'&&input.id===grouped.id&&String(input.text).endsWith('\n\n⏳ Approved. It runs now and reports here when done.')),
      'the card in the private chat says the report comes there');
    await beat(started,{tokens:tokens(1000),unknown_calls:0,todo:[{content:'Check the made-up log',status:'in_progress'}]});
    // In the group no turn, the owner's or a member's, sees the machines or the job's machine, plan or to-do list.
    for(const [from,who] of [[123,'the owner'],[9,'a member']] as const) {
      const listed=await s.jobs.list(await said(project,from,'How is it going?'));
      assert.equal(listed.machines,undefined,who+' sees no machines in a group');
      const row=listed.jobs.find((item:any)=>item.id===grouped.id)!;
      assert.deepEqual([row.title,row.state,row.machine,row.steps,row.todo],['Set up the made-up project','running',null,null,null],who);
      assert.match(String(row.private),/plan and report are in the owner's private chat/);clean(listed,'the group\'s status for '+who);
    }
    const mine=await s.jobs.list(await said('123',123,'How is it going?'));
    assert.deepEqual(mine.machines,[{name:'build-vm',ready:true}],'the private chat still lists the machines');
    const own=mine.jobs.find((item:any)=>item.id===grouped.id)!;
    assert.deepEqual([own.machine,own.steps,own.todo],[{name:'build-vm'},steps,[{content:'Check the made-up log',status:'in_progress'}]]);
    assert.equal((await s.jobs.list(owner)).jobs.find((item:any)=>item.id===grouped.id)!.machine?.name,'build-vm','the dashboard shows it');

    // The report goes to the owner's private chat; then the group gets the one fixed line, and the job is done.
    await finish(started,'Report PRIVATEMARK7: the made-up tool runs on build-vm at 192.0.2.10.');
    assert.equal((await tick(grouped.id)).stage,'delivery');
    let parts=await reports(grouped.id);
    assert.deepEqual(parts.map(row=>[row.part,row.destination]),[[1,'123']]);
    assert.equal(parts[0].text_hash,digest('Report PRIVATEMARK7: the made-up tool runs on build-vm at 192.0.2.10.'));
    await delivered(parts[0].id);await tick(grouped.id);
    parts=await reports(grouped.id);
    assert.deepEqual(parts.map(row=>[row.part,row.destination]),[[1,'123'],[2,project]]);
    assert.equal(parts[1].text_hash,digest(groupLine),'the group\'s line names no machine, plan or report');
    assert.equal((await job(grouped.id)).state,'reporting');
    await delivered(parts[1].id);
    assert.equal((await tick(grouped.id)).state,'completed');assert.equal((await job(grouped.id)).state,'done');
    // A group turn's own list of requests never holds the report.
    const recent=await s.telegramActions.recent(await said(project,123,'Did it go out?'));
    assert.ok(parts.every(part=>recent.every(item=>item.id!==part.id)),'the group cannot follow the report requests');
    await assert.rejects(s.telegramActions.inspect(await said(project,9,'Show me'),parts[0].id),{status:404});

    // A lost group line still ends the job done: the report reached the owner.
    const second=await s.jobs.start(await said(project,123,'Set it up again, once more'),{...request,title:'Set up the made-up project again'});
    const again=await run(second);await finish(again,'Report PRIVATEMARK7 again.');
    await tick(second.id);await delivered((await reports(second.id))[0].id);await tick(second.id);
    const lost=await reports(second.id);assert.deepEqual(lost.map(row=>row.destination),['123',project]);
    await delivered(lost[1].id,'rejected');
    assert.equal((await tick(second.id)).state,'completed');assert.deepEqual([(await job(second.id)).state,(await job(second.id)).error_code],['done',null]);

    // Once the report reached the owner, a later change does not hold back the group's line: it names nothing the run read.
    const edited=await s.jobs.start(await said(project,123,'Set it up, a third time'),{...request,title:'Set up the made-up project a third time'});
    const third=await run(edited);await finish(third,'Report PRIVATEMARK7, third.');
    await tick(edited.id);await delivered((await reports(edited.id))[0].id);
    const noted=await message(project,9,'A made-up note in the group');
    const copy=await s.guards.read('events:'+noted.id,await s.guards.state());
    await s.guards.edit('events:'+noted.id,copy.revision,{...copy.value as any,text:'An edited made-up note'},key+':edit');
    await tick(edited.id);
    const late=await reports(edited.id);assert.deepEqual(late.map(row=>row.destination),['123',project],'the line still goes to the group');
    assert.equal(late[1].text_hash,digest(groupLine));
    await delivered(late[1].id);
    assert.equal((await tick(edited.id)).state,'completed');assert.deepEqual([(await job(edited.id)).state,(await job(edited.id)).error_code],['done',null]);
    // A Stop pressed after the report reached the owner ends the job done, and the group gets no line.
    const halted=await s.jobs.start(await said(project,123,'Set it up, a fourth time'),{...request,title:'Set up the made-up project a fourth time'});
    const fourth=await run(halted);await finish(fourth,'Report PRIVATEMARK7, fourth.');
    await tick(halted.id);await delivered((await reports(halted.id))[0].id);
    await stores.control.query('UPDATE background_jobs SET cancel_requested=true WHERE id=$1',[halted.id]);
    assert.equal((await tick(halted.id)).state,'completed');assert.deepEqual([(await job(halted.id)).state,(await job(halted.id)).error_code],['done',null]);
    assert.deepEqual((await reports(halted.id)).map(row=>row.destination),['123']);

    // A report an older release had begun sending to the group keeps that part there; the owner then gets the whole report
    // and the group the line. One the group got whole before then is done.
    const long=['Report PRIVATEMARK7, first half. '+'a'.repeat(6000),'Second half. '+'b'.repeat(6000)];
    const older=await s.jobs.start(await said(project,123,'Set it up, a fifth time'),{...request,title:'Set up the made-up project a fifth time'});
    const fifth=await run(older);await finish(fifth,long.join('\n\n'));
    await tick(older.id);const begun=(await reports(older.id))[0];
    await stores.control.query('UPDATE telegram_action_requests SET destination=$2 WHERE id=$1',[begun.id,project]);await delivered(begun.id);
    for(let part=2;part<=4;part++){await tick(older.id);await delivered((await reports(older.id)).at(-1).id);}
    const resumed=await reports(older.id);
    assert.deepEqual(resumed.map(row=>[row.destination,row.text_hash]),[[project,digest(long[0]!)],['123',digest(long[0]!)],['123',digest(long[1]!)],[project,digest(groupLine)]]);
    assert.equal((await tick(older.id)).state,'completed');assert.equal((await job(older.id)).state,'done');
    const whole=await s.jobs.start(await said(project,123,'Set it up, a sixth time'),{...request,title:'Set up the made-up project a sixth time'});
    const sixth=await run(whole);await finish(sixth,'Report PRIVATEMARK7, sixth.');
    await tick(whole.id);const all=(await reports(whole.id))[0];
    await stores.control.query('UPDATE telegram_action_requests SET destination=$2 WHERE id=$1',[all.id,project]);await delivered(all.id);
    assert.equal((await tick(whole.id)).state,'completed');assert.deepEqual((await reports(whole.id)).map(row=>row.destination),[project]);

    // At a limit the note goes to the owner and the group gets the limit line.
    const capped=await s.jobs.start(await said(project,123,'A long setup'),{...request,title:'Long made-up setup'});
    const reading=await run(capped);
    await beat(reading,{tokens:tokens(1000000),unknown_calls:0,todo:[{content:'Check the made-up log',status:'completed'},{content:'Run its tests',status:'pending'}]});
    assert.equal((await beat(reading,{tokens:tokens(3000000),unknown_calls:0})).cancel_requested,true);
    await finish(reading,'A report too late.');
    assert.equal((await tick(capped.id)).stage,'delivery');
    const note=await reports(capped.id);assert.deepEqual(note.map(row=>row.destination),['123']);
    assert.equal(note[0].text_hash,digest('⏱ Long made-up setup: the job stopped at its cost limit before it wrote a report.\n✅ Done: Check the made-up log\n⏳ Left: Run its tests'));
    await delivered(note[0].id);await tick(capped.id);
    const limited=await reports(capped.id);assert.deepEqual(limited.map(row=>row.destination),['123',project]);
    assert.equal(limited[1].text_hash,digest(limitedLine));
    await delivered(limited[1].id);await tick(capped.id);
    assert.deepEqual([(await job(capped.id)).state,(await job(capped.id)).ended],['done','cost']);

    // Asked in the private chat: the report goes there and no group line follows.
    const privately=await s.jobs.start(await said('123',123,'Set it up from here'),{...request,title:'Set up the made-up project privately'});
    assert.deepEqual([privately.machine,privately.steps],[{name:'build-vm'},steps],'the private chat sees what it asked for');
    const here=await run(privately);await finish(here,'Report PRIVATEMARK7 from the private chat.');
    await tick(privately.id);const alone=await reports(privately.id);assert.deepEqual(alone.map(row=>row.destination),['123']);
    await delivered(alone[0].id);assert.equal((await tick(privately.id)).state,'completed');
    assert.equal((await reports(privately.id)).length,1,'no group line for a job asked in the private chat');

    // A job without a machine still reports to the group where it was asked: it read only that group.
    const plain=await s.jobs.start(await said(project,123,'Count the open tasks'),{title:'Plain made-up count',instruction:'Count the made-up tasks.'});
    const counted=await run(plain);await finish(counted,'3 made-up tasks are open.');
    await tick(plain.id);assert.deepEqual((await reports(plain.id)).map(row=>row.destination),[project]);
  }finally{
    if(previous===undefined)delete process.env.NOCHEH_MACHINE_TOKEN;else process.env.NOCHEH_MACHINE_TOKEN=previous;
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
