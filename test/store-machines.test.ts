import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {brokerServer} from '../src/security/broker.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {machineJob,machineTokenSet} from '../src/stores/machines.js';
import {storageServer} from '../src/stores/server.js';
import {fixtureServices} from './fixture-brain.js';
import {honchoEngine} from '../src/memory/honcho.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const frame=(type:string,payload:Buffer)=>{const head=Buffer.alloc(5);head.write(type,0,'latin1');head.writeUInt32BE(payload.length,1);return Buffer.concat([head,payload]);};
const exitFrame=(code:number)=>{const value=Buffer.alloc(4);value.writeInt32BE(code);return frame('X',value);};
const frames=(bytes:Buffer)=>{const out:{type:string;data:Buffer}[]=[];
  for(let at=0;at+5<=bytes.length;){const size=bytes.readUInt32BE(at+1);out.push({type:String.fromCharCode(bytes[at]!),data:bytes.subarray(at+5,at+5+size)});at+=5+size;}return out;};
const until=async(check:()=>boolean|Promise<boolean>,what:string,ms=15000)=>{
  const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw Error('timed out waiting until '+what);await new Promise(resolve=>setTimeout(resolve,50));}
};

test('only the owner\'s own request in their private chat or an active project\'s group asks for a machine job, its card goes to the private chat, its run works on the pinned machine through storage, which logs each command, and Stop, the switches and changes end it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:600000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-machines-')),key='machines:'+Date.now(),project='-100777',other='-100778';
  const token=digest(key),projectId=digest(key+':project'),owner:Reader={admin:true,scope:null},machineToken='synthetic-machine-token-'+'m'.repeat(24);
  const hostKey='SHA256:'+'A'.repeat(43),otherKey='SHA256:'+'B'.repeat(43);
  const previous={token:process.env.NOCHEH_MACHINE_TOKEN,url:process.env.NOCHEH_MACHINES_URL};
  // A made-up nocheh-machines: it checks the machine token, makes no keys and reaches no machine; it answers as told.
  const calls:{path:string;body:any}[]=[],waiting:{aborted:boolean}[]=[],lastCall=()=>calls[calls.length-1]!,events:string[]=[];
  let testMode:'ok'|'other'|'refused'|'nokey'='ok',execMode:'echo'|'wait'|'refuse'|'nokey'|'odd'|'noexit'|'bad'|'flood'='echo',cleanupMode:'ok'|'fail'|'script'|'nokey'|'hold'='ok';
  let release=()=>{},flood:Buffer|null=null;
  // What nocheh-machines sends at its cap: 8 MiB of small frames, their headers counted, then its note and the exit code.
  const floodBytes=()=>{
    if(flood)return flood;
    const parts:Buffer[]=[];let size=0;
    for(let piece=Buffer.alloc(600,'y');size<8*1024*1024-5;size+=piece.length+5){piece=piece.subarray(0,Math.min(600,8*1024*1024-5-size));parts.push(frame('O',piece));}
    return flood=Buffer.concat([...parts,frame('O',Buffer.from('\n[machine: output capped at 8 MiB]\n')),exitFrame(0)]);
  };
  const fake=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!=='Bearer '+machineToken)return send(401,{error:'machine_not_allowed'});
    const path=req.url!,body=JSON.parse(Buffer.concat(chunks).toString()||'null');calls.push({path,body});events.push(path);
    if(path==='/keys')return send(200,{public_key:'ssh-ed25519 '+'A'.repeat(68)+' '+body.comment});
    if(path==='/test')return testMode==='refused'?send(200,{ok:false,error:'machine_auth_failed'}):testMode==='nokey'?send(200,{ok:false,error:'machine_key_missing',detail:'This machine has no key.'}):
      send(200,{ok:true,host_key:testMode==='ok'?hostKey:otherKey,system:'Made-up OS 1.0\n'});
    // The cleanup reached the machine, but its script ended non-zero there (no ps, say).
    if(path==='/cleanup'&&cleanupMode==='hold')return void new Promise<void>(resolve=>{release=resolve;}).then(()=>{events.push('cleanup answered');send(200,{ok:true});});
    if(path==='/cleanup')return cleanupMode==='ok'?send(200,{ok:true}):cleanupMode==='script'?send(200,{ok:false,error:'machine_cleanup_failed'}):
      cleanupMode==='nokey'?send(200,{ok:false,error:'machine_key_missing'}):send(502,{error:'machine_unreachable'});
    if(path==='/forget'||path==='/remove')return send(200,{ok:true});
    if(path!=='/exec')return send(404,{error:'not_found'});
    if(execMode==='refuse')return send(502,{error:'machine_unreachable'});
    if(execMode==='nokey')return send(502,{error:'machine_key_missing'});
    if(execMode==='odd')return send(502,{error:'made_up_failure'});
    res.writeHead(200,{'content-type':'application/octet-stream'});
    if(execMode==='echo')return res.end(Buffer.concat([frame('O',Buffer.from('hello\n')),exitFrame(0)]));
    if(execMode==='flood')return res.end(floodBytes());
    if(execMode==='noexit')return res.end(frame('O',Buffer.from('partial')));
    if(execMode==='bad')return res.end(Buffer.concat([frame('O',Buffer.from('ok')),frame('Z',Buffer.from('?'))]));
    // A long command: one line, then nothing until whoever asked goes away.
    const entry={aborted:false};waiting.push(entry);res.write(frame('O',Buffer.from('started\n')));
    res.on('close',()=>{entry.aborted=!res.writableEnded;events.push('exec ended');});
  });
  await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));
  process.env.NOCHEH_MACHINES_URL='http://127.0.0.1:'+(fake.address() as {port:number}).port;process.env.NOCHEH_MACHINE_TOKEN=machineToken;
  const policy={enabled:true,owner_id:'123',group_ids:[project,other],group_access:{[project]:{granted:['9'],denied:[]}},topic_memory:'group' as const};
  const approvals:any[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.approval')approvals.push(input);
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const mock:typeof fetch=async(url,init)=>String(url).endsWith('/internal/security/transport')?
    Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000}):fetch(url,init);
  const archive=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy} as unknown as Settings,async()=>({}));
  await new Promise<void>(resolve=>archive.listen(0,'127.0.0.1',resolve));
  const archiveBase='http://127.0.0.1:'+(archive.address() as {port:number}).port;
  const broker=brokerServer({pool:stores.control,storage:s.turns,token,archive:archiveBase,hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(s),fetch:mock});
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  const brokerBase='http://127.0.0.1:'+(broker.address() as {port:number}).port;
  /** The dashboard's owner routes, as management reaches them with the service token. */
  const route=async(method:'GET'|'POST',path:string,body?:unknown)=>{
    const response=await fetch(archiveBase+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body??{})}:{})});
    return {status:response.status,body:await response.json() as any};
  };
  const execBody=(extra:Record<string,unknown>={})=>({script:'printf hello',stdin:null,timeout:60,login:false,command:'printf hello',kind:'command',...extra});
  const exec=async(base:string,credential:string,body:unknown,signal?:AbortSignal)=>{
    const response=await fetch(base+'/v1/machines/exec',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(body),...(signal?{signal}:{})});
    const bytes=Buffer.from(await response.arrayBuffer()),type=response.headers.get('content-type')??'';
    return {status:response.status,type,bytes,body:type.includes('json')?JSON.parse(bytes.toString()):null};
  };
  let sent=100;
  const message=async(chat:string,from:number,text:string)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',
      occurred_at:null,text,payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}}};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  /** A person's live message in a chat, as the turn that answers it. */
  const said=async(chat:string,from:number,text:string)=>actor((await message(chat,from,text)).id,chat==='123'?null:chat,chat);
  const steps=['Install the made-up tool','Run its tests'];
  const request=(extra:Record<string,unknown>={})=>({title:'Set up the made-up project',instruction:'Set up the made-up project on the machine.',machine:'build-vm',steps,...extra});
  const ask=async(chat:string,from:number,extra:Record<string,unknown>={})=>s.jobs.start(await said(chat,from,'Set up the made-up project'),request(extra));
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const latest=async(id:string)=>(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[id])).rows[0].event_id as string;
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  /** Approve a job, start it, run its first run and claim it: its context, run text and credential. */
  const start=async(asked:{id:string;fingerprint:string})=>{
    await s.jobs.decide('123',{id:asked.id,fingerprint:asked.fingerprint,decision:'approve'},await message('123',123,'Approve'));
    await tick(asked.id);const step=await latest(asked.id);await s.jobs.runs.run(step,await authority());
    const context:any=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    const claimed:any=await s.jobs.runs.claim({...context,actor:context.actor});
    return {step,context,text:String(claimed.text),credential:String(claimed.archive_credential)};
  };
  /** End a stopped job's run as Hermes would, and let the job settle. */
  const finishStopped=async(id:string)=>{await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[id]);await tick(id);};
  const binding=async(credential:string)=>{
    const response=await fetch(brokerBase+'/v1/security/binding',{headers:{authorization:'Bearer '+credential}});assert.equal(response.status,200);return (await response.json() as any).machine;
  };
  const rows=async(where:string,params:unknown[]=[])=>(await stores.control.query('SELECT * FROM machine_commands WHERE '+where+' ORDER BY id',params)).rows;
  const settledWith=(id:string,line:string)=>until(()=>approvals.some(input=>input.kind==='settle'&&input.id===id&&String(input.text).endsWith('\n\n'+line)),'the card of '+id+' says '+line);
  const machineLine='🖥 It works on build-vm (nocheh@192.0.2.10) over SSH: one approval covers every command it runs there. Stop ends the programs it started there.';
  const planLine='📋 Plan:\n1. Install the made-up tool\n2. Run its tests',withdrawn='🚫 Withdrawn: its machine was turned off or changed. Nothing runs.';
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy,'on');
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'Made-up project','active',1)",[projectId]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[project,projectId]);

    // Settings › Machines: nothing yet, machine control on, and set up.
    assert.deepEqual(await route('GET','/v1/machines'),{status:200,body:{available:true,enabled:true,revision:0,machines:[]}});
    for(const body of [{name:'bad/name',address:'192.0.2.10',login:'nocheh'},{name:'build-vm',address:'-oProxyCommand=made-up',login:'nocheh'},{name:'build-vm',address:'192.0.2.10',port:0,login:'nocheh'},
      {name:'build-vm',address:'192.0.2.10',port:65536,login:'nocheh'},{name:'build-vm',address:'192.0.2.10',login:'Root'},{name:'build-vm',address:'192.0.2.10',login:'nocheh',key:'made-up'},
      {name:' ',address:'192.0.2.10',login:'nocheh'}])
      assert.deepEqual(await route('POST','/v1/machines',body),{status:400,body:{error:'invalid_machine'}},JSON.stringify(body));
    // Without the machine token nothing can make a key.
    delete process.env.NOCHEH_MACHINE_TOKEN;
    assert.equal((await route('GET','/v1/machines')).body.available,false);
    assert.deepEqual(await route('POST','/v1/machines',{name:'build-vm',address:'192.0.2.10',login:'nocheh'}),{status:502,body:{error:'machine_unavailable'}});
    process.env.NOCHEH_MACHINE_TOKEN='short-made-up-token';assert.equal(machineTokenSet(),false,'a short token is no token');
    process.env.NOCHEH_MACHINE_TOKEN=machineToken;assert.equal(calls.length,0);
    const created=await route('POST','/v1/machines',{name:' build-vm ',address:'192.0.2.10',login:'nocheh'});
    assert.equal(created.status,200);
    const build=created.body.id as string;assert.match(build,/^[a-f0-9]{32}$/);
    assert.deepEqual(calls,[{path:'/keys',body:{id:build,comment:'nocheh build-vm'}}],'nocheh-machines makes the key; storage never sees it');
    assert.deepEqual(Object.keys(created.body).sort(),['address','created_at','enabled','host_key','id','jobs','login','name','port','public_key','revision','test_error','tested_at']);
    assert.deepEqual([created.body.name,created.body.port,created.body.host_key,created.body.enabled,created.body.jobs],['build-vm',22,null,true,0]);
    assert.equal(created.body.public_key,'ssh-ed25519 '+'A'.repeat(68)+' nocheh build-vm');
    assert.equal((await stores.control.query('SELECT key_ref FROM machines WHERE id=$1',[build])).rows[0].key_ref,'machines/'+build+'/key','only where nocheh-machines keeps it');
    assert.deepEqual(await route('POST','/v1/machines',{name:'BUILD-VM',address:'192.0.2.11',login:'nocheh'}),{status:409,body:{error:'machine_name_taken'}});
    const spare=(await s.machines.create(owner,{name:'spare-vm',address:'host.docker.internal',port:2222,login:'nocheh'})).id;
    await assert.rejects(s.machines.create({admin:false,scope:null},{name:'other-vm',address:'192.0.2.12',login:'nocheh'}),{status:403});

    // Test connection: a refusal is saved as the machine's problem; the first success trusts its host key, which must stay.
    calls.length=0;testMode='refused';
    const refused=await route('POST','/v1/machines/'+build+'/test');
    assert.deepEqual([refused.status,refused.body.result,refused.body.machine.test_error,refused.body.machine.host_key],[200,{ok:false,error:'machine_auth_failed'},'machine_auth_failed',null]);
    testMode='ok';
    const tested=await route('POST','/v1/machines/'+build+'/test');
    assert.deepEqual(tested.body.result,{ok:true,host_key:hostKey,system:'Made-up OS 1.0'});
    assert.deepEqual([tested.body.machine.host_key,tested.body.machine.test_error],[hostKey,null]);assert.ok(tested.body.machine.tested_at);
    assert.deepEqual(calls.map(call=>call.body),[{id:build,address:'192.0.2.10',port:22,login:'nocheh',host_key:null},{id:build,address:'192.0.2.10',port:22,login:'nocheh',host_key:null}]);
    testMode='other';
    const changed=await s.machines.test(owner,build);
    assert.deepEqual([changed.result,changed.machine.host_key,changed.machine.test_error],[{ok:false,error:'machine_host_key_changed'},hostKey,'machine_host_key_changed']);
    testMode='ok';assert.deepEqual((await s.machines.test(owner,build)).result,{ok:true,host_key:hostKey,system:'Made-up OS 1.0'});
    assert.equal(lastCall().body.host_key,hostKey,'the trusted key goes with each later test');
    assert.deepEqual((await rows('machine_id=$1',[build])).map(row=>[row.kind,row.command,row.state,row.error_code]),
      [['test','ssh test','failed','machine_auth_failed'],['test','ssh test','done',null],['test','ssh test','failed','machine_host_key_changed'],['test','ssh test','done',null]]);
    assert.deepEqual(await route('POST','/v1/machines/'+'f'.repeat(32)+'/test'),{status:404,body:{error:'machine_not_found'}});
    assert.ok(!JSON.stringify((await route('GET','/v1/machines')).body).includes('/key'),'no key or key path in any answer');

    // Only the owner's own live message asks for a machine: in their private chat, or in an active project's group.
    const memberTurn=await said(project,9,'Set it up');
    await assert.rejects(s.jobs.start(memberTurn,request()),{code:'job_machine_not_allowed'},'a member never asks for a machine');
    await assert.rejects(ask(other,123),{code:'job_machine_not_allowed'},'nor does the owner in a group of no active project');
    await assert.rejects(ask('123',123,{box:true}),{code:'job_machine_not_allowed'},'a box job never works on a machine');
    await assert.rejects(ask('123',123,{machine:'spare-vm'}),{code:'job_machine_not_found'},'a machine never tested');
    await assert.rejects(ask('123',123,{machine:'made-up-vm'}),{code:'job_machine_not_found'});
    for(const extra of [{steps:undefined},{machine:undefined},{steps:[]},{steps:Array(13).fill('A step')},{steps:['x'.repeat(201)]},{steps:[' \n ']},{steps:['A step',3]},
      {machine:''},{machine:'m'.repeat(41)},{machine:7}])
      await assert.rejects(ask('123',123,extra),{code:'invalid_job_request'},JSON.stringify(extra));
    delete process.env.NOCHEH_MACHINE_TOKEN;
    await assert.rejects(ask('123',123),{code:'job_machine_not_allowed'},'without the token no job may ask for a machine');
    process.env.NOCHEH_MACHINE_TOKEN=machineToken;
    // A follow-up turn is started by Nocheh after a result, not asked by anyone.
    const followed=await said('123',123,'Set it up once the check is done');
    const checked=await s.controlledActions.propose(followed,{kind:'shell',arguments:{command:'printf made-up'}});
    await stores.control.query("UPDATE controlled_actions SET state='rejected' WHERE id=$1",[checked.id]);
    await stores.control.query("UPDATE action_continuations SET state='running' WHERE action_id=$1",[checked.id]);
    await assert.rejects(s.jobs.start(followed,request()),{code:'job_machine_not_allowed'},'a follow-up never starts a machine job');
    await stores.control.query("UPDATE action_continuations SET state='cancelled' WHERE action_id=$1",[checked.id]);
    // Every job's card must fit Telegram with its outcome line, or it could never be approved.
    await assert.rejects(ask('123',123,{steps:Array(12).fill('s'.repeat(200)),instruction:'i'.repeat(1500)}),{code:'job_card_too_long'});
    await assert.rejects(s.jobs.start(await said('123',123,'A long one'),{title:'Long made-up job',instruction:'i'.repeat(3900)}),{code:'job_card_too_long'},'also a job without a machine');
    assert.equal((await s.jobs.start(await said('123',123,'A shorter one'),{title:'Shorter made-up job',instruction:'i'.repeat(3000)})).state,'proposed');

    // Asked in the private chat: its card answers the request there, with the machine and the plan.
    const privateTurn=await message('123',123,'Set up the made-up project'),privateMessage=String(sent);
    const asked=await s.jobs.start(await actor(privateTurn.id,null,'123'),request({machine:'BUILD-VM'}));
    assert.deepEqual([asked.state,asked.approver,asked.machine,asked.steps,asked.box],['proposed','owner',{name:'build-vm'},steps,false]);
    approvals.length=0;
    const offered=await s.actionCommands.offer('background',asked);
    assert.equal(approvals.length,1);assert.deepEqual([approvals[0].kind,approvals[0].chat_id,approvals[0].reply_to],['card','123',privateMessage]);
    assert.ok(approvals[0].text.endsWith('\n'+machineLine+'\n'+planLine+'\n\nSet up the made-up project on the machine.'),approvals[0].text);
    assert.match(String(offered.message),/^A card with Approve and Reject buttons for this job was posted here as the reply to the request/);
    // A saved card without the machine or plan line still shows them, at its end.
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'background.card':'Made-up card: {title}\n\n{instruction}'})]);
    assert.equal((await s.jobs.card(asked.id)).text,'Made-up card: Set up the made-up project\n\nSet up the made-up project on the machine.\n\n'+machineLine+'\n'+planLine);
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    // The machine and the plan are what the owner approves; the same request with another plan is another job.
    const again=await said('123',123,'Set it up again');
    const first=await s.jobs.start(again,request());
    await assert.rejects(s.jobs.start(again,request({steps:['Install the made-up tool']})),{code:'job_changed'});
    await assert.rejects(stores.control.query('UPDATE background_jobs SET box=true WHERE id=$1',[first.id]),{code:'23514'},'the store never holds a box job with a machine');
    await s.jobs.stop(owner,{id:first.id});
    // Asked by the owner in the project's group: the card goes to the private chat, and the group is told where it is.
    const grouped=await ask(project,123);
    assert.deepEqual([grouped.approver,grouped.machine,grouped.steps],['owner',undefined,undefined],'the group sees no machine or plan');
    approvals.length=0;
    const groupOffer=await s.actionCommands.offer('background',grouped);
    assert.deepEqual([approvals[0].chat_id,approvals[0].reply_to],['123',undefined]);
    assert.match(String(groupOffer.message),/was sent to them in their private chat with you\. In this chat answer them as "you"[^]*the report goes there too/);
    assert.equal((await job(grouped.id)).space_id,project,'it was asked in the group');

    // The live turn of the owner's own message in their private chat sees the machines a job may work on; no group turn does.
    const listed=await s.jobs.list(await said('123',123,'What can you work on?'));
    assert.deepEqual(listed.machines,[{name:'build-vm',ready:true},{name:'spare-vm',ready:false}]);
    const mine=listed.jobs.find((row:any)=>row.id===asked.id)!;assert.deepEqual([mine.machine,mine.steps],[{name:'build-vm'},steps]);
    assert.equal((await s.jobs.list(await said(project,123,'And here?'))).machines,undefined,'not even the owner\'s own message in a group');
    assert.equal((await s.jobs.list(await said(project,9,'And for me?'))).machines,undefined);
    assert.equal((await s.jobs.list(await said(other,123,'And there?'))).machines,undefined);

    // Its run: its context, run text and binding carry the machine; a plain job's do not.
    const plainJob=await s.jobs.start(await said('123',123,'Count them'),{title:'Plain made-up check',instruction:'Count the made-up tasks.'});
    const a=await start(asked),p=await start(plainJob);
    // Its card, in the chat where it was asked, says the report comes there.
    await s.actionCommands.settle('background',asked.id);await settledWith(asked.id,'⏳ Approved. It runs now and reports here when done.');
    assert.equal(a.context.background.machine,true);assert.equal(p.context.background.machine,false);
    assert.match(a.text,/\n\n\[Machine\]\nThis job works on the owner's machine "build-vm" over SSH as nocheh@192\.0\.2\.10\. Your terminal and file tools run there, not here;[^]*\nThe owner approved this plan:\n1\. Install the made-up tool\n2\. Run its tests\nDo only this plan\./);
    assert.doesNotMatch(p.text,/\[Machine\]/);
    assert.deepEqual(await binding(a.credential),{job:asked.id,machine:'build-vm'});assert.equal(await binding(p.credential),null);
    assert.equal((await s.machines.list(owner)).machines.find(row=>row.id===build)!.jobs,1,'its running job is counted');
    // machineJob: the run of a running job the owner asked for and approved, while the switch, the machine and its pin hold.
    const reference={store:'control',id:a.step},profile='job-'+asked.id.slice(0,24),turn={job:asked.id,logical_profile:profile};
    assert.equal((await machineJob(stores.control,'123',reference,turn))?.id,asked.id);
    assert.equal(await machineJob(stores.control,'456',reference,turn),null);
    assert.equal(await machineJob(stores.control,'123',reference,{job:asked.id,logical_profile:'job-made-up'}),null);
    assert.equal(await machineJob(stores.control,'123',reference,{job:asked.id}),null,'a turn of no profile');
    assert.equal(await machineJob(stores.control,'123',{store:'archive',id:a.step},turn),null);
    assert.equal(await machineJob(stores.control,'123',{store:'control',id:p.step},turn),null,'another job\'s run');
    for(const [change,undo,id] of <[string,string,string][]>[['UPDATE machine_settings SET enabled=NOT enabled WHERE $1::text IS NOT NULL','UPDATE machine_settings SET enabled=NOT enabled WHERE $1::text IS NOT NULL',build],
      ['UPDATE machines SET enabled=false WHERE id=$1','UPDATE machines SET enabled=true WHERE id=$1',build],['UPDATE machines SET port=2200 WHERE id=$1','UPDATE machines SET port=22 WHERE id=$1',build],
      [`UPDATE machines SET host_key='${otherKey}' WHERE id=$1`,`UPDATE machines SET host_key='${hostKey}' WHERE id=$1`,build],
      ["UPDATE background_jobs SET started_at=now()-interval '2 hours' WHERE id=$1",'UPDATE background_jobs SET started_at=now() WHERE id=$1',asked.id],
      ['UPDATE background_jobs SET cancel_requested=true WHERE id=$1','UPDATE background_jobs SET cancel_requested=false WHERE id=$1',asked.id]]) {
      await stores.control.query(change,[id]);
      assert.equal(await machineJob(stores.control,'123',reference,turn),null,change);
      await stores.control.query(undo,[id]);
    }
    assert.equal((await machineJob(stores.control,'123',reference,turn))?.id,asked.id);
    // A failed test after a passing one, here because nocheh-machines has no key for the machine (after a restore, say): its
    // problem is saved, and no new job may ask for the machine until a test passes again. A job already approved keeps its pin.
    testMode='nokey';
    const lost=await route('POST','/v1/machines/'+build+'/test');
    assert.deepEqual([lost.body.result,lost.body.machine.test_error,lost.body.machine.host_key],[{ok:false,error:'machine_key_missing'},'machine_key_missing',hostKey]);
    assert.deepEqual((await rows("machine_id=$1 AND kind='test'",[build])).at(-1).error_code,'machine_key_missing');
    await assert.rejects(ask('123',123),{code:'job_machine_not_found'},'a machine whose last test failed is not ready');
    assert.deepEqual((await s.jobs.list(await said('123',123,'Is it ready?'))).machines,[{name:'build-vm',ready:false},{name:'spare-vm',ready:false}]);
    assert.equal((await machineJob(stores.control,'123',reference,turn))?.id,asked.id,'a running job keeps its pin\'s rules');
    testMode='ok';assert.equal((await s.machines.test(owner,build)).machine.test_error,null);
    assert.deepEqual((await s.jobs.list(await said('123',123,'And now?'))).machines,[{name:'build-vm',ready:true},{name:'spare-vm',ready:false}]);

    // Each command runs through the broker and storage, from the pin, and is logged with what ran and what it printed.
    calls.length=0;
    const ran=await exec(brokerBase,a.credential,execBody());
    assert.deepEqual([ran.status,ran.type],[200,'application/octet-stream']);
    assert.deepEqual(frames(ran.bytes).map(item=>[item.type,item.type==='O'?item.data.toString():item.data.readInt32BE(0)]),[['O','hello\n'],['X',0]]);
    assert.deepEqual(calls,[{path:'/exec',body:{id:build,address:'192.0.2.10',port:22,login:'nocheh',host_key:hostKey,job:asked.id,script:'printf hello',stdin:null,timeout:60,login_shell:false}}]);
    const logged=(await rows('job_id=$1',[asked.id])).at(-1);
    assert.deepEqual([logged.machine_id,logged.machine_name,logged.run_event_id,logged.kind,logged.command,logged.state,logged.exit_code,logged.output_sha256,Number(logged.output_bytes),logged.script_sha256,logged.error_code],
      [build,'build-vm',a.step,'command','printf hello','done',0,sha('hello\n'),6,sha('printf hello'),null]);
    assert.ok(logged.finished_at);
    await exec(brokerBase,a.credential,execBody({timeout:3600}));
    assert.equal(lastCall().body.timeout,870,'a command ends on the machine before the broker\'s 15 minutes do');
    await exec(brokerBase,a.credential,execBody({kind:'file',stdin:'made-up file',login:true,command:'write_file notes.txt',script:'cat > notes.txt'}));
    assert.deepEqual([lastCall().body.stdin,lastCall().body.login_shell],['made-up file',true]);
    await exec(brokerBase,a.credential,execBody({kind:'internal',command:'pwd',script:'pwd'}));
    await exec(brokerBase,a.credential,execBody({command:'c'.repeat(5000)}));
    assert.deepEqual((await rows('job_id=$1',[asked.id])).slice(-3).map(row=>[row.kind,row.command]),[['file','write_file notes.txt'],['internal','pwd'],['command','c'.repeat(3999)+'…']]);
    // A request to correct, or a machine-side failure: its code passes through, and nothing else.
    const counted=(await rows('true')).length;
    for(const body of [{...execBody(),extra:1},execBody({timeout:0}),execBody({timeout:3601}),execBody({kind:'cleanup'}),execBody({login:'yes'}),execBody({stdin:'s'.repeat(4*1024*1024+1)}),
      execBody({script:'a\0b'}),{script:'printf hello'}])
      assert.deepEqual((await exec(brokerBase,a.credential,body)).body,{error:'invalid_machine_request'},JSON.stringify(body).slice(0,80));
    assert.deepEqual(await exec(brokerBase,a.credential,execBody({script:'s'.repeat(96*1024+1)})).then(answer=>[answer.status,answer.body]),[409,{error:'machine_script_too_long'}]);
    delete process.env.NOCHEH_MACHINE_TOKEN;
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[502,{error:'machine_unavailable'}]);
    process.env.NOCHEH_MACHINE_TOKEN=machineToken;
    assert.equal((await rows('true')).length,counted,'a refused request runs nothing and logs nothing');
    execMode='refuse';
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[502,{error:'machine_unreachable'}]);
    execMode='nokey';
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[502,{error:'machine_key_missing'}],'nocheh-machines has no key for it');
    assert.equal((await route('GET','/v1/machines')).body.machines.find((row:any)=>row.id===build).test_error,'machine_key_missing','not ready until a test passes again, and its page says why');
    assert.equal((await s.machines.test(owner,build)).machine.test_error,null);
    execMode='odd';
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[502,{error:'machine_unavailable'}],'a code off the list');
    execMode='noexit';
    const cut=await exec(brokerBase,a.credential,execBody());assert.deepEqual(frames(cut.bytes).map(item=>item.type),['O']);
    execMode='bad';
    const odd=await exec(brokerBase,a.credential,execBody());assert.deepEqual(frames(odd.bytes).map(item=>item.data.toString()),['ok'],'an odd frame is not passed on');
    assert.deepEqual((await rows('job_id=$1',[asked.id])).slice(-5).map(row=>[row.state,row.exit_code,row.error_code,Number(row.output_bytes)]),
      [['failed',null,'machine_unreachable',0],['failed',null,'machine_key_missing',0],['failed',null,'machine_unavailable',0],['ambiguous',null,'machine_unavailable',7],
        ['ambiguous',null,'machine_unavailable',2]]);
    // At its cap the broker passes the whole stream, however small its frames.
    execMode='flood';
    const flooded=await exec(brokerBase,a.credential,execBody());
    assert.deepEqual([flooded.status,flooded.bytes.equals(floodBytes()),frames(flooded.bytes).at(-1)!.data.readInt32BE(0)],[200,true,0]);
    assert.deepEqual((await rows('job_id=$1',[asked.id])).slice(-1).map(row=>[row.state,row.exit_code]),[['done',0]]);
    execMode='echo';
    // A command's time stops 30 seconds before the job's hard deadline; past that nothing more runs.
    const deadline=(seconds:number)=>stores.control.query(`UPDATE background_jobs SET started_at=now()-(minutes_limit*60+180-$2::integer)*interval '1 second' WHERE id=$1`,[asked.id,seconds]);
    await deadline(100);await exec(brokerBase,a.credential,execBody({timeout:3600}));
    const clamped=lastCall().body.timeout as number;assert.ok(clamped>=65&&clamped<=70,String(clamped));
    await deadline(20);
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[409,{error:'machine_time_up'}]);
    await deadline(-5);
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[409,{error:'machine_time_up'}]);
    assert.equal(await binding(a.credential),null,'past its hard deadline a run has no machine');
    await stores.control.query('UPDATE background_jobs SET started_at=now() WHERE id=$1',[asked.id]);
    // Only the machine job's own run, never another run or an owner credential.
    assert.deepEqual(await exec(brokerBase,p.credential,execBody()).then(answer=>[answer.status,answer.body]),[409,{error:'machine_not_allowed'}]);
    assert.deepEqual(await exec(archiveBase,token,execBody()).then(answer=>[answer.status,answer.body]),[403,{error:'machine_not_allowed'}]);
    await stores.control.query('UPDATE machines SET port=2200 WHERE id=$1',[build]);
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[409,{error:'machine_changed'}],'a machine moved under the job');
    await stores.control.query('UPDATE machines SET port=22,enabled=false WHERE id=$1',[build]);
    assert.deepEqual(await exec(brokerBase,a.credential,execBody()).then(answer=>[answer.status,answer.body]),[409,{error:'machine_off'}]);
    await stores.control.query('UPDATE machines SET enabled=true WHERE id=$1',[build]);

    // The caller goes away: the command ends with it.
    execMode='wait';
    const controller=new AbortController(),gone=exec(brokerBase,a.credential,execBody({command:'sleep 600'}),controller.signal).catch(error=>error);
    await until(()=>waiting.length===1,'the command starts');
    controller.abort();await gone;
    await until(()=>waiting[0]!.aborted,'nocheh-machines sees the caller leave');
    await until(async()=>(await rows("job_id=$1 AND command='sleep 600'",[asked.id]))[0]?.state==='cancelled','the command is logged as cancelled');
    // Stop: the next check ends the command, the stream says so, and the login's programs on the machine are ended.
    const halted=exec(archiveBase,a.credential,execBody({command:'sleep 601'}));
    await until(()=>waiting.length===2,'the second command starts');
    await s.jobs.stop(owner,{id:asked.id});
    const stopped=await halted;
    assert.deepEqual(frames(stopped.bytes).map(item=>[item.type,item.type==='O'?item.data.toString():item.data.readInt32BE(0)]),
      [['O','started\n'],['O','\n[nocheh: the job was stopped]\n'],['X',137]]);
    await until(()=>waiting[1]!.aborted,'nocheh-machines ends the command');
    const ended=(await rows("job_id=$1 AND command='sleep 601'",[asked.id]))[0];
    assert.deepEqual([ended.state,ended.exit_code,ended.error_code,Number(ended.output_bytes),ended.output_sha256],['cancelled',137,'job_stopped',8,sha('started\n')]);
    assert.deepEqual([(await job(asked.id)).cancel_requested,(await job(asked.id)).machine_cleanup],[true,'pending']);
    calls.length=0;await s.machines.cleanupTick();
    assert.deepEqual(calls,[{path:'/cleanup',body:{id:build,address:'192.0.2.10',port:22,login:'nocheh',host_key:hostKey,job:asked.id}}]);
    assert.equal((await job(asked.id)).machine_cleanup,'done');
    assert.deepEqual((await rows("job_id=$1 AND kind='cleanup'",[asked.id])).map(row=>[row.command,row.state]),[['end the programs this job started as nocheh','done']]);
    await finishStopped(asked.id);
    assert.deepEqual([(await job(asked.id)).state,(await job(asked.id)).machine_cleanup],['stopped','done'],'cleaned once');
    await s.jobs.stop(owner,{id:plainJob.id});await finishStopped(plainJob.id);
    assert.equal((await job(plainJob.id)).machine_cleanup,null,'a job without a machine has nothing to end');
    const jobRows=(await route('GET','/v1/background-jobs')).body.jobs;
    assert.deepEqual([asked.id,plainJob.id].map(id=>jobRows.find((row:any)=>row.id===id).machine_cleanup),['done',null],'Background work shows the cleanup');
    execMode='echo';

    // The project group's run works on the machine too, though it is no owner turn.
    const g=await start(grouped);
    // Its card is in the private chat, where its report goes too.
    await s.actionCommands.settle('background',grouped.id);await settledWith(grouped.id,'⏳ Approved. It runs now and reports here when done.');
    assert.equal(g.context.background.machine,true);assert.deepEqual(await binding(g.credential),{job:grouped.id,machine:'build-vm'});
    assert.equal((await exec(brokerBase,g.credential,execBody())).status,200);

    // The switch off: a proposal is withdrawn, a running job stops and its programs are ended; the cards say so.
    const proposal=await ask('123',123);await s.actionCommands.offer('background',proposal);
    // A job already reporting is done with its machine: its report still goes out and what it left running stays.
    const reporting=await ask('123',123);await start(reporting);
    await stores.control.query("UPDATE managed_runs SET state='done' WHERE job_id=$1",[reporting.id]);
    await stores.control.query("UPDATE background_jobs SET state='reporting' WHERE id=$1",[reporting.id]);
    const settings=await s.machines.list(owner);
    await assert.rejects(s.machines.saveSettings(owner,{enabled:false}),{code:'invalid_settings'});
    await assert.rejects(s.machines.saveSettings(owner,{enabled:'no',revision:settings.revision}),{code:'invalid_settings'});
    await assert.rejects(s.machines.saveSettings(owner,{enabled:false,revision:settings.revision+1}),{code:'configuration_conflict'});
    const off=await route('POST','/v1/machines/settings',{enabled:false,revision:settings.revision});
    assert.deepEqual([off.status,off.body.enabled,off.body.revision],[200,false,settings.revision+1]);
    assert.deepEqual([(await job(proposal.id)).state,(await job(proposal.id)).error_code],['stopped','job_machine_off']);
    const halting=await job(grouped.id);
    assert.deepEqual([halting.state,halting.cancel_requested,halting.machine_cleanup],['running',true,'pending']);
    assert.deepEqual([(await job(reporting.id)).cancel_requested,(await job(reporting.id)).machine_cleanup],[false,null]);
    await stores.control.query("UPDATE background_jobs SET state='done',finished_at=now() WHERE id=$1",[reporting.id]);
    assert.equal((await stores.control.query('SELECT ended FROM background_runs WHERE event_id=$1',[g.step])).rows[0].ended,'stopped');
    await settledWith(proposal.id,withdrawn);await settledWith(grouped.id,'⏳ Stopping. Nothing more runs.');
    assert.equal(await machineJob(stores.control,'123',{store:'control',id:g.step},{job:grouped.id,logical_profile:'job-'+grouped.id.slice(0,24)}),null);
    await assert.rejects(ask('123',123),{code:'job_machine_not_allowed'});
    assert.equal((await s.jobs.list(await said('123',123,'What now?'))).machines,undefined);
    // Its cleanup is tried 3 times. A cleanup that reached the machine but could not end its programs says so in the log.
    cleanupMode='script';await s.machines.cleanupTick();
    // nocheh-machines has no key for it: the machine is not ready until a test passes again.
    cleanupMode='nokey';await s.machines.cleanupTick();
    assert.equal((await s.machines.list(owner)).machines.find(row=>row.id===build)!.test_error,'machine_key_missing');
    cleanupMode='fail';await s.machines.cleanupTick();
    assert.deepEqual([(await job(grouped.id)).machine_cleanup,(await job(grouped.id)).machine_cleanup_attempts],['failed',3]);
    assert.deepEqual((await rows("job_id=$1 AND kind='cleanup'",[grouped.id])).map(row=>[row.state,row.error_code]),
      [['failed','machine_cleanup_failed'],['failed','machine_key_missing'],['failed','machine_unreachable']]);
    await s.machines.cleanupTick();assert.equal((await rows("job_id=$1 AND kind='cleanup'",[grouped.id])).length,3,'then no more');
    cleanupMode='ok';await finishStopped(grouped.id);
    assert.equal((await s.machines.saveSettings(owner,{enabled:true,revision:settings.revision+1})).enabled,true);
    assert.equal((await s.machines.test(owner,build)).machine.test_error,null);

    // A change to the machine: over the revision it was read at; a move forgets its host key and withdraws its jobs.
    const moving=await ask('123',123);
    let machine=(await s.machines.list(owner)).machines.find(row=>row.id===build)!;
    await assert.rejects(s.machines.update(owner,build,{name:'build-vm',revision:machine.revision-1}),{code:'configuration_conflict'});
    await assert.rejects(s.machines.update(owner,build,{port:'22',revision:machine.revision}),{code:'invalid_machine'});
    await assert.rejects(s.machines.update(owner,build,{key:'made-up',revision:machine.revision}),{code:'invalid_machine'});
    await assert.rejects(s.machines.update(owner,build,{name:'Spare-VM',revision:machine.revision}),{code:'machine_name_taken'});
    assert.deepEqual(await route('POST','/v1/machines/'+'f'.repeat(32),{enabled:false,revision:1}),{status:404,body:{error:'machine_not_found'}});
    machine=await s.machines.update(owner,build,{name:'Build-VM',revision:machine.revision});
    assert.deepEqual([machine.name,machine.host_key,(await job(moving.id)).state],['Build-VM',hostKey,'proposed'],'a new name is the same machine');
    // A job runs a command meanwhile: it ends first, then the job's programs are ended at the old address, then its host key goes.
    const busy=await ask('123',123),b=await start(busy);execMode='wait';
    const inFlight=exec(archiveBase,b.credential,execBody({command:'sleep 603'}));
    await until(()=>waiting.length===3,'the third command starts');
    calls.length=0;events.length=0;
    const moved=await route('POST','/v1/machines/'+build,{address:'192.0.2.11',revision:machine.revision});
    assert.deepEqual([moved.body.address,moved.body.host_key,moved.body.tested_at],['192.0.2.11',null,null]);
    assert.deepEqual(frames((await inFlight).bytes).map(item=>item.type==='O'?item.data.toString():item.data.readInt32BE(0)),['started\n','\n[nocheh: the job was stopped]\n',137]);
    assert.deepEqual(events,['exec ended','/cleanup','/forget']);
    assert.deepEqual(calls,[{path:'/cleanup',body:{id:build,address:'192.0.2.10',port:22,login:'nocheh',host_key:hostKey,job:busy.id}},{path:'/forget',body:{id:build}}]);
    assert.deepEqual([(await job(busy.id)).cancel_requested,(await job(busy.id)).machine_cleanup],[true,'done']);
    execMode='echo';await finishStopped(busy.id);
    assert.deepEqual([(await job(moving.id)).state,(await job(moving.id)).error_code],['stopped','job_machine_off']);await settledWith(moving.id,withdrawn);
    await assert.rejects(ask('123',123),{code:'job_machine_not_found'},'tested again first');
    await s.machines.test(owner,build);
    // Turned off: its proposals are withdrawn, and no job may ask for it.
    const disabled=await ask('123',123);
    machine=(await s.machines.list(owner)).machines.find(row=>row.id===build)!;
    machine=await s.machines.update(owner,build,{enabled:false,revision:machine.revision});
    assert.deepEqual([machine.enabled,(await job(disabled.id)).error_code],[false,'job_machine_off']);
    await assert.rejects(ask('123',123),{code:'job_machine_not_found'});
    assert.deepEqual((await s.jobs.list(await said('123',123,'Which ones?'))).machines,[{name:'Build-VM',ready:false},{name:'spare-vm',ready:false}]);
    machine=await s.machines.update(owner,build,{enabled:true,revision:machine.revision});
    // Trust a new host key: the key is forgotten, here and in nocheh-machines.
    const forgetting=await ask('123',123);
    // A job whose run failed, and whose cleanup waits for its next try, has its programs ended before the key goes.
    const leftover=await ask('123',123);await start(leftover);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[leftover.id]);
    await stores.control.query("UPDATE background_jobs SET state='failed',finished_at=now(),machine_cleanup='pending',machine_cleanup_attempts=1 WHERE id=$1",[leftover.id]);
    // The test that found the new key failed; its problem goes with the old key.
    testMode='other';assert.equal((await s.machines.test(owner,build)).machine.test_error,'machine_host_key_changed');testMode='ok';
    calls.length=0;
    const forgot=await route('POST','/v1/machines/'+build+'/forget-host-key');
    assert.deepEqual([forgot.status,forgot.body.host_key,forgot.body.tested_at,forgot.body.test_error],[200,null,null,null]);
    assert.deepEqual(calls,[{path:'/cleanup',body:{id:build,address:'192.0.2.11',port:22,login:'nocheh',host_key:hostKey,job:leftover.id}},{path:'/forget',body:{id:build}}]);
    assert.deepEqual([(await job(leftover.id)).machine_cleanup,(await job(leftover.id)).machine_cleanup_attempts],['done',1]);
    assert.equal((await job(forgetting.id)).error_code,'job_machine_off','a job pinned to the old key is withdrawn');
    await s.machines.test(owner,build);
    // Remove: its jobs are withdrawn, nocheh-machines deletes its key, and its log stays.
    await s.machines.test(owner,spare);
    const removing=await ask('123',123,{machine:'spare-vm'});
    // A stopped job of it whose cleanup the loop runs as Remove comes: Remove waits for that cleanup before the key goes.
    const lingering=await ask('123',123,{machine:'spare-vm'});await start(lingering);
    await s.jobs.stop(owner,{id:lingering.id});await finishStopped(lingering.id);
    cleanupMode='hold';calls.length=0;events.length=0;
    const looping=s.machines.cleanupTick();
    await until(()=>events.includes('/cleanup'),'the loop\'s cleanup reaches nocheh-machines');
    const removed=route('POST','/v1/machines/'+spare+'/remove');
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(events,['/cleanup'],'Remove waits for the cleanup that runs');
    release();await looping;
    assert.deepEqual(await removed,{status:200,body:{id:spare,removed:true}});cleanupMode='ok';
    assert.deepEqual(events,['/cleanup','cleanup answered','/remove']);
    assert.deepEqual(calls,[{path:'/cleanup',body:{id:spare,address:'host.docker.internal',port:2222,login:'nocheh',host_key:hostKey,job:lingering.id}},{path:'/remove',body:{id:spare}}]);
    assert.equal((await job(lingering.id)).machine_cleanup,'done');
    assert.equal((await job(removing.id)).error_code,'job_machine_off');
    assert.deepEqual((await s.machines.list(owner)).machines.map(row=>row.name),['Build-VM']);
    assert.deepEqual((await rows('machine_id=$1',[spare])).map(row=>row.kind),['test','cleanup'],'its test and cleanup stay in the log');
    assert.deepEqual(await route('POST','/v1/machines/'+spare+'/remove'),{status:404,body:{error:'machine_not_found'}});

    // A machine job whose run failed, or that ended at a limit, has its programs ended too. A run that could not set up its
    // machine fails saying so, not as a managed execution failure.
    const failing=await ask('123',123),f=await start(failing);
    await stores.control.query("UPDATE background_jobs SET started_at=now()-(minutes_limit-2)*interval '1 minute' WHERE id=$1",[failing.id]);
    await s.jobs.runs.finish({event_id:f.step,actor:f.context.actor,state:'failed',session:f.context.conversation,error_code:'job_machine_unavailable',text:'',todo:[],tokens:null});
    assert.equal((await stores.control.query('SELECT error_code FROM managed_runs WHERE event_id=$1',[f.step])).rows[0].error_code,'job_machine_unavailable');
    await tick(failing.id);
    assert.deepEqual([(await job(failing.id)).state,(await job(failing.id)).error_code,(await job(failing.id)).machine_cleanup],['failed','job_machine_unavailable','pending']);
    const limited=await ask('123',123);await start(limited);
    await stores.control.query("UPDATE background_runs SET ended='cost' WHERE job_id=$1",[limited.id]);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[limited.id]);
    await tick(limited.id);
    assert.deepEqual([(await job(limited.id)).ended,(await job(limited.id)).machine_cleanup],['cost','pending']);
    calls.length=0;await s.machines.cleanupTick();
    assert.deepEqual(calls.map(call=>call.path),['/cleanup','/cleanup']);
    assert.deepEqual([(await job(failing.id)).machine_cleanup,(await job(limited.id)).machine_cleanup],['done','done']);
    await stores.control.query("UPDATE background_jobs SET state='done',finished_at=now() WHERE id=$1",[limited.id]);
    // A run that ended well leaves its programs running, also when its report then fails.
    const unreported=await ask('123',123);await start(unreported);
    await stores.control.query("UPDATE managed_runs SET state='done' WHERE job_id=$1",[unreported.id]);
    await stores.control.query("UPDATE background_jobs SET state='reporting' WHERE id=$1",[unreported.id]);
    await tick(unreported.id);
    assert.deepEqual([(await job(unreported.id)).state,(await job(unreported.id)).error_code,(await job(unreported.id)).machine_cleanup],['failed','job_report_missing',null]);

    // Log rows a stopped process left running are closed: once their job no longer runs, or after 70 minutes.
    const stale=async(kind:string,jobId:string|null,minutes:number)=>String((await stores.control.query(`INSERT INTO machine_commands(machine_id,machine_name,job_id,kind,command,started_at)
      VALUES($1,'build-vm',$2,$3,'made-up stale',now()-$4::integer*interval '1 minute') RETURNING id`,[build,jobId,kind,minutes])).rows[0].id);
    const ids=[await stale('command',asked.id,1),await stale('test',null,71),await stale('test',null,1)];
    await s.machines.cleanupTick();
    assert.deepEqual((await rows('id=ANY($1::bigint[])',[ids])).map(row=>row.state),['ambiguous','ambiguous','running']);
    await stores.control.query("UPDATE machine_commands SET state='done' WHERE id=$1",[ids[2]]);

    // System › Machine log: newest first, Hermes's own commands only when asked for, one machine's or one job's, a page at a time.
    const all=(await s.machines.commands(owner,{kind:'all',limit:100})).commands;
    const shown=(await s.machines.commands(owner,{limit:100})).commands;
    assert.ok(all.some(row=>row.kind==='internal'));assert.ok(!shown.some(row=>row.kind==='internal'));
    assert.deepEqual(shown.map(row=>row.id),all.filter(row=>row.kind!=='internal').map(row=>row.id));
    assert.deepEqual(all.map(row=>row.id),[...all.map(row=>row.id)].sort((x,y)=>y-x));
    const ofJob=(await s.machines.commands(owner,{job:asked.id,kind:'all',limit:100})).commands;
    assert.ok(ofJob.length>10&&ofJob.every(row=>row.job_id===asked.id&&row.job_title==='Set up the made-up project'));
    assert.deepEqual((await s.machines.commands(owner,{machine:spare})).commands.map(row=>[row.machine_name,row.kind,row.job_id,row.job_title]),
      [['spare-vm','cleanup',lingering.id,'Set up the made-up project'],['spare-vm','test',null,null]]);
    // Each command shows the fingerprint of what ran; a cleanup's is not the owner's to compare.
    assert.deepEqual([ofJob.find(row=>row.command==='printf hello')!.script_sha256,ofJob.find(row=>row.kind==='cleanup')!.script_sha256],[sha('printf hello'),null]);
    const page=await s.machines.commands(owner,{limit:2});
    assert.deepEqual([page.commands.length,page.next],[2,page.commands[1]!.id]);
    const next=await s.machines.commands(owner,{limit:2,before:String(page.next)});
    assert.deepEqual(next.commands.map(row=>row.id),shown.slice(2,4).map(row=>row.id));
    const viaRoute=await route('GET','/v1/machines/commands?limit=2&kind=command');
    assert.deepEqual(viaRoute.body.commands.map((row:any)=>row.id),page.commands.map(row=>row.id));
    assert.deepEqual(Object.keys(viaRoute.body.commands[0]).sort(),['command','error_code','exit_code','finished_at','id','job_id','job_title','kind','machine_id','machine_name',
      'output_bytes','output_sha256','script_sha256','started_at','state']);
    for(const query of ['kind=other','limit=101','limit=0','machine=zz','job=made-up','before=x'])
      assert.equal((await route('GET','/v1/machines/commands?'+query)).status,400,query);
    await assert.rejects(s.machines.commands({admin:false,scope:null},{}),{status:403});
  } finally {
    for(const [name,value] of [['NOCHEH_MACHINE_TOKEN',previous.token],['NOCHEH_MACHINES_URL',previous.url]] as const)if(value===undefined)delete process.env[name];else process.env[name]=value;
    broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    archive.closeAllConnections();await new Promise<void>(resolve=>archive.close(()=>resolve()));
    fake.closeAllConnections();await new Promise<void>(resolve=>fake.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
