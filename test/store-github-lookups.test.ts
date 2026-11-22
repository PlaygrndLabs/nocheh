import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {githubReposHere,githubRunRefusal} from '../src/stores/github-lookups.js';
import {honchoEngine} from '../src/memory/honcho.js';

// Live GitHub lookups (ADR-0270): a project's repository in its groups and the owner's private chat; the owner's own only
// in the owner's private chat; never another project's group, a group in no project or a job; checked again before it runs.
test('a repository is looked up only where it may be, and every lookup reads without a card',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-github-lookups-')),key='github-lookups:'+Date.now();
  const inP='-'+Date.now(),alone=String(Number(inP)-1),inQ=String(Number(inP)-2),P='a1'.repeat(32),Q='b2'.repeat(32);
  const owner:Reader={admin:true,scope:null};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[inP,alone,inQ]}),
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0;
  const capture=async(scope:string,from:number,text:string)=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(scope:string,text:string,from=123):Promise<Reader>=>{
    const source=await capture(scope,from,text),binding=await s.guards.state();
    return {admin:false,scope:scope==='123'?null:scope,space:scope,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const ask=async(scope:string,text:string,args:Record<string,unknown>,from=123)=>{
    const reader=await actor(scope,text,from);
    return {reader,result:await s.controlledActions.propose(reader,{kind:'mcp',arguments:{connection:'github',...args}})};
  };
  const look=(repo:string)=>({tool:'search_code',input:{repo,query:'made up'}});
  const widgets='example-org/widgets',gadgets='example-org/gadgets',mine='example-org/mine';
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    for(const [id,name] of [[P,'Synthetic project P'],[Q,'Synthetic project Q']])
      await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1) ON CONFLICT(id) DO NOTHING",[id,name]);
    for(const [space,project] of [[inP,P],[inQ,Q]])
      await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode='assigned'",[space,project]);
    await s.jobs.setRepoProject(owner,{repo:widgets,project:P});await s.jobs.setRepoProject(owner,{repo:gadgets,project:Q});

    // Only the fixed reads, with checked inputs.
    for(const args of [{tool:'delete_repo',input:{repo:widgets}},{tool:'read_file',input:{repo:widgets,path:'../x'}},{tool:'search_code',input:{repo:widgets}},
      {tool:'search_code',input:{repo:widgets,query:'x',extra:'y'}},{...look(widgets),project:P}])
      await assert.rejects(ask(inP,'Look it up',args,9),{code:'invalid_mcp_action'},JSON.stringify(args));

    // In P's group anyone who may talk there looks up P's repository, with no card; never Q's or the owner's own.
    const {reader:groupReader,result:read}=await ask(inP,'Search our code',look(widgets),9);
    assert.equal(read.state,'approved');
    assert.equal((await stores.control.query("SELECT 1 FROM security_events WHERE rule=$1 AND state='allowed'",['github_read:'+P])).rowCount,1);
    await assert.rejects(ask(inP,'Search Q',look(gadgets),9),{code:'github_not_here'});
    await assert.rejects(ask(inP,'Search mine',look(mine),9),{code:'github_not_here'});
    await assert.rejects(ask(inQ,'Search P',look(widgets),9),{code:'github_not_here'});
    await assert.rejects(ask(alone,'Search here',look(widgets),9),{code:'github_not_here'});
    assert.deepEqual(await githubReposHere(stores.control,groupReader,await s.turns.binding(groupReader)),{repos:[{repo:widgets}]});

    // The owner's private chat looks up the owner's own and every active project's.
    const own=await ask('123','Search my code',look(mine));assert.equal(own.result.state,'approved');
    const theirs=await ask('123','Search P\'s code',look(widgets));assert.equal(theirs.result.state,'approved');
    assert.equal((await githubReposHere(stores.control,own.reader,await s.turns.binding(own.reader))).repos.length,2);

    // Right before it runs: never a job, and still from where the repository may be looked up.
    const asked=await row(read.id);
    assert.equal(await githubRunRefusal(stores.control,asked,'123',{input:{repo:widgets}}),null);
    assert.equal(await githubRunRefusal(stores.control,{...asked,job_id:'made-up-job'},'123',{input:{repo:widgets}}),'github_not_here');
    assert.equal(await githubRunRefusal(stores.control,await row(own.result.id),'123',{input:{repo:mine}}),null);
    await s.jobs.setRepoProject(owner,{repo:widgets,project:Q});
    assert.equal(await githubRunRefusal(stores.control,asked,'123',{input:{repo:widgets}}),'github_not_here','moved to another project');
    await s.jobs.setRepoProject(owner,{repo:widgets,project:P});
    await stores.control.query("UPDATE projects SET state='archived' WHERE id=$1",[P]);
    assert.equal(await githubRunRefusal(stores.control,await row(theirs.result.id),'123',{input:{repo:widgets}}),'github_not_here','an archived project\'s');
    await assert.rejects(ask('123','Search archived',look(widgets)),{code:'github_not_here'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
