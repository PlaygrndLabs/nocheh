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
import {notionConnectionsHere,notionRunRefusal} from '../src/stores/notion.js';
import {honchoEngine} from '../src/memory/honcho.js';

// A project's own Notion (ADR-0268): used in that project's groups and in the owner's private chat, never in another
// project's group, a group in no project or a job; its own switch and approval; Nothing asks me is the owner's own only.
test('a project\'s Notion is used only in its groups and the owner\'s private chat, with its own switch and approval',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-notion-project-')),key='notion-project:'+Date.now();
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
    return {reader,result:await s.controlledActions.propose(reader,{kind:'mcp',arguments:{connection:'notion',...args}})};
  };
  const search={tool:'notion-search',input:{query:'reading list'}},create={tool:'notion-create-pages',input:{pages:[{properties:{title:'Plan'}}]}};
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    for(const [id,name] of [[P,'Synthetic project P'],[Q,'Synthetic project Q']])
      await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1) ON CONFLICT(id) DO NOTHING",[id,name]);
    for(const [space,project] of [[inP,P],[inQ,Q]])
      await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode='assigned'",[space,project]);

    // Off until the owner turns it on; the owner's own and each project's are apart.
    const initial=await s.notion.get(owner,P);
    assert.deepEqual([initial.project,initial.enabled,initial.approval,initial.revision],[P,false,'changes',0]);
    await assert.rejects(s.notion.get(owner,'c3'.repeat(32)),{code:'project_not_found'});
    await assert.rejects(ask(inP,'Search our Notion',search),{code:'notion_not_enabled'});
    await assert.rejects(s.notion.save(owner,{project:P,enabled:true,approval:'nothing',expected_revision:0}),{code:'invalid_notion_settings'},
      'anyone in the groups can ask, so Nothing asks me is the owner\'s own only');
    const on=await s.notion.save(owner,{project:P,enabled:true,expected_revision:0});
    assert.deepEqual([on.enabled,on.revision],[true,1]);
    assert.equal((await s.notion.get(owner)).enabled,false,'the owner\'s own stays off');

    // In P's group a read runs under P's setting and a change waits; the call names P whichever way it was asked.
    const {reader:groupReader,result:read}=await ask(inP,'Search our Notion',search,9);
    assert.equal(read.state,'approved');
    assert.equal((await stores.control.query("SELECT 1 FROM security_events WHERE rule=$1 AND state='allowed'",['notion_setting:'+P+':'+on.revision])).rowCount,1);
    const named=await ask(inP,'Search our Notion again',{...search,input:{query:'books'},project:P},9);
    assert.equal(named.result.state,'approved');
    const change=await ask(inP,'Add a page',create,9);
    assert.equal(change.result.state,'proposed','a change waits for the owner');
    const turn=await s.turns.binding(groupReader);
    assert.deepEqual(await notionConnectionsHere(stores.control,groupReader,turn),[{connection:P,name:'Notion of the project Synthetic project P'}]);

    // Never from a group in no project, another project's group, or naming another project.
    await assert.rejects(ask(alone,'Search Notion',search,9),{code:'notion_owner_private_only'});
    await assert.rejects(ask(alone,'Search P',{...search,project:P},9),{code:'notion_not_here'});
    await assert.rejects(ask(inQ,'Search P',{...search,project:P},9),{code:'notion_not_here'});
    await assert.rejects(ask(inQ,'Search Notion',search,9),{code:'notion_not_enabled'},'Q\'s own Notion is off');

    // The owner's private chat names P to use it; left out, it is the owner's own, which is off.
    const mine=await ask('123','Search P\'s Notion',{...search,project:P});
    assert.equal(mine.result.state,'approved');
    await assert.rejects(ask('123','Search my Notion',search),{code:'notion_not_enabled'});
    assert.deepEqual(await notionConnectionsHere(stores.control,mine.reader,await s.turns.binding(mine.reader)),
      [{connection:P,name:'Notion of the project Synthetic project P'}]);

    // Right before it runs: still from P's group or the owner's chat, never a job, and only while P's Notion is on.
    const asked=await row(change.result.id);
    assert.equal(await notionRunRefusal(stores.control,asked,'123',{project:P}),null);
    assert.equal(await notionRunRefusal(stores.control,{...asked,job_id:'made-up-job'},'123',{project:P}),'notion_not_here');
    assert.equal(await notionRunRefusal(stores.control,await row(mine.result.id),'123',{project:P}),null);
    await stores.control.query("UPDATE project_assignments SET mode='none',project_id=NULL WHERE space_id=$1",[inP]);
    assert.equal(await notionRunRefusal(stores.control,asked,'123',{project:P}),'notion_not_here','a group that left the project');
    await stores.control.query("UPDATE project_assignments SET mode='assigned',project_id=$2 WHERE space_id=$1",[inP,P]);
    await s.notion.save(owner,{project:P,enabled:false,expected_revision:on.revision});
    assert.equal(await notionRunRefusal(stores.control,asked,'123',{project:P}),'notion_not_enabled');
    await assert.rejects(ask(inP,'Search when off',search,9),{code:'notion_not_enabled'});
    // An archived project's Notion is used nowhere.
    await s.notion.save(owner,{project:P,enabled:true,expected_revision:on.revision+1});
    await stores.control.query("UPDATE projects SET state='archived' WHERE id=$1",[P]);
    await assert.rejects(ask(inP,'Search archived',search,9),{code:'notion_owner_private_only'});
    await assert.rejects(ask('123','Search archived',{...search,project:P}),{code:'notion_not_here'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
