import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {brokerServer} from '../src/security/broker.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {storageServer} from '../src/stores/server.js';
import {fixtureServices} from './fixture-brain.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {grantMembers} from './fixture-member-grants.js';

// A project's GitHub repositories (ADR-0269): linked by name; the owner's own box job asked in that project's group reads
// only that project's copies, a member's never; unlinking withdraws what has not started and takes a running job's box.
test('a project\'s repositories are read only by the owner\'s box jobs in its groups, and unlinking takes them back',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:600000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-repo-project-')),key='job-repo-project:'+Date.now();
  const inP='-'+Date.now(),alone=String(Number(inP)-1),inQ=String(Number(inP)-2),P='c4'.repeat(32),Q='d5'.repeat(32);
  const token=digest(key),boxToken='synthetic-box-token-'+'p'.repeat(24),owner:Reader={admin:true,scope:null};
  const previousBox=process.env.NOCHEH_BOX_TOKEN;process.env.NOCHEH_BOX_TOKEN=boxToken;
  const policy={enabled:true,owner_id:'123',group_ids:[inP,alone,inQ],topic_memory:'group' as const};
  const people=grantMembers({[inP]:{granted:['9']}},{owner:'123',groups:[alone,inQ]});
  const cards:Record<string,any>[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.approval'){cards.push(input);return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};}
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const mock:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000});
    return fetch(url,init);
  };
  const archive=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy} as unknown as Settings,async()=>({}));
  await new Promise<void>(resolve=>archive.listen(0,'127.0.0.1',resolve));
  const archiveBase='http://127.0.0.1:'+(archive.address() as {port:number}).port;
  const broker=brokerServer({pool:stores.control,storage:s.turns,token,archive:archiveBase,hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(s),fetch:mock});
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  const brokerBase='http://127.0.0.1:'+(broker.address() as {port:number}).port;
  const get=async(path:string,headers:Record<string,string>={})=>{const response=await fetch(brokerBase+path,{headers});return {status:response.status,body:await response.json() as any};};
  let sent=100;
  const message=async(chat:string,from:number,text:string)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',
      occurred_at:null,text,payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}}};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(chat:string,text:string,from=123):Promise<Reader>=>{
    const source=await message(chat,from,text),binding=await s.guards.state();
    return {admin:false,scope:chat==='123'?null:chat,space:chat,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const latest=async(id:string)=>(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[id])).rows[0].event_id as string;
  const widgets='example-org/widgets',gadgets='example-org/gadgets';
  const set=async(repo:string,n:number)=>s.jobs.changeCopies(owner,{set:{repo,branch:'main',commit:digest('commit '+n).slice(0,40),digest:digest('bundle '+n),bytes:18000000,
    need:60000000,files:1204,copy_id:null,removal:(await s.jobs.copies(owner)).removal,not_after:Math.floor(Date.now()/1000)+10}});
  const ask=async(chat:string,title:string,repo:string|null=widgets,from=123)=>s.jobs.start(await actor(chat,'Compare our tasks with the code: '+title,from),
    {title,instruction:'Compare the made-up tasks with the made-up code.',box:true,...(repo===null?{}:{repo})});
  const approve=async(proposed:{id:string;fingerprint:string})=>s.jobs.decide('123',{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message('123',123,'Approve'));
  const begin=async(proposed:{id:string;fingerprint:string})=>{
    await approve(proposed);await tick(proposed.id);
    const step=await latest(proposed.id);await s.jobs.runs.run(step,await authority());
    const context:any=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    const claimed:any=await s.jobs.runs.claim({...context,actor:context.actor});
    return {context,credential:String(claimed.archive_credential)};
  };
  const live=async()=>(await get('/v1/box/live',{authorization:'Bearer '+boxToken})).body.boxes.map((box:any)=>box.job) as string[];
  const bindingBox=async(credential:string)=>(await get('/v1/security/binding',{authorization:'Bearer '+credential})).body.box;
  const repos=async(principal:Reader)=>{const listed:any=await s.jobs.list(principal);return 'repos' in listed?listed.repos.map((row:any)=>[row.name,row.project]):undefined;};
  const link=(repo:string,project:string|null)=>s.jobs.setRepoProject(owner,{repo,project});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy,'on');
    await s.jobs.saveSettings(owner,{...await s.jobs.settings(),box_tools:true});
    for(const [id,name] of [[P,'Synthetic project P'],[Q,'Synthetic project Q']])
      await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1) ON CONFLICT(id) DO NOTHING",[id,name]);
    for(const [space,project] of [[inP,P],[inQ,Q]])
      await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode='assigned'",[space,project]);
    await message(inP,9,'A made-up task in P');await message(inQ,9,'A made-up task in Q');
    await set(widgets,1);await set(gadgets,2);

    // Links: only the owner, strict bodies, an active project; by name, in any case, copied or not.
    await assert.rejects(s.jobs.setRepoProject({admin:false,scope:null},{repo:widgets,project:P}),{code:'owner_required'});
    for(const body of [{repo:widgets},{repo:'widgets',project:P},{repo:widgets,project:'P'},{repo:widgets,project:P,extra:1}])
      await assert.rejects(s.jobs.setRepoProject(owner,body),{status:400,code:'invalid_github_repo'},JSON.stringify(body));
    await assert.rejects(link(widgets,'e6'.repeat(32)),{status:404,code:'project_not_found'});
    assert.deepEqual(await link('Example-Org/Widgets',P),{repos:[{repo:widgets,project_id:P}]});
    await link('example-org/not-copied',Q);
    assert.deepEqual((await s.jobs.repoProjects(owner)).repos.map((row:any)=>row.repo),['example-org/not-copied',widgets]);

    // What a job may read: everything and whose in the owner's private chat; only the project's for the owner in its group.
    assert.deepEqual(await repos(await actor('123','What can a job read?')),[[gadgets,null],[widgets,'Synthetic project P']]);
    assert.deepEqual(await repos(await actor(inP,'What can a job read here?')),[[widgets,undefined]]);
    assert.deepEqual(await repos(await actor(inQ,'And here?')),[],'Q has no copy yet');
    assert.equal(await repos(await actor(alone,'And here?')),undefined,'a group in no project');
    assert.equal(await repos(await actor(inP,'Jobs here?',9)),undefined,'not for a member');

    // start: the owner's box job in P's group reads P's copy only, never with no copy, a member's never, nowhere else.
    const proposed=await ask(inP,'P code check');
    assert.equal((await job(proposed.id)).repo.name,widgets);
    await assert.rejects(ask(inP,'Your own copy',gadgets),{status:409,code:'job_repo_not_allowed'},'the owner\'s own copy stays in the private chat');
    await assert.rejects(ask(inP,'No copy',null),{status:409,code:'job_box_not_allowed'},'a group gets the box only to read its project\'s copy');
    await assert.rejects(ask(inQ,'Another project\'s copy'),{status:409,code:'job_repo_not_allowed'});
    await assert.rejects(ask(alone,'A group in no project'),{status:409,code:'job_box_not_allowed'});
    await assert.rejects(ask(inP,'A member asks',widgets,9),{status:409,code:'job_box_not_allowed'});
    assert.ok(await ask('123','The private chat reads any copy',gadgets));

    // It runs in its box; unlinking withdraws what has not started and takes the running job's box.
    const running=await begin(proposed);
    assert.equal(running.context.background.box,true);
    assert.deepEqual(await live(),[proposed.id]);
    assert.equal((await bindingBox(running.credential)).repo.name,widgets);
    const waiting=await ask(inP,'Waiting P code check'),mine=await ask('123','My own check of P\'s code');
    await link(widgets,null);
    assert.deepEqual([(await job(waiting.id)).state,(await job(waiting.id)).error_code],['stopped','job_repo_removed']);
    assert.equal((await job(mine.id)).state,'proposed','a job asked in the private chat keeps its copy');
    assert.equal((await job(proposed.id)).state,'running');
    assert.deepEqual(await live(),[]);assert.equal(await bindingBox(running.credential),null);
    // Linked again, then the group leaves the project: no box either.
    await link(widgets,P);assert.deepEqual(await live(),[proposed.id]);
    await stores.control.query("UPDATE project_assignments SET mode='none',project_id=NULL WHERE space_id=$1",[inP]);
    assert.deepEqual(await live(),[]);assert.equal(await bindingBox(running.credential),null);
  }finally{
    if(previousBox===undefined)delete process.env.NOCHEH_BOX_TOKEN;else process.env.NOCHEH_BOX_TOKEN=previousBox;
    people();
    broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    archive.closeAllConnections();await new Promise<void>(resolve=>archive.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
