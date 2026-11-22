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
import {gmailRunRefusal} from '../src/stores/gmail-lookups.js';
import {honchoEngine} from '../src/memory/honcho.js';

// The owner's own Gmail (ADR-0272): looked up only in the owner's private chat, with no card; never in a group, even a
// project's, a member's private chat or a job; checked again before it runs.
test('the owner\'s Gmail is looked up only in the owner\'s private chat, without a card',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-gmail-lookups-')),key='gmail-lookups:'+Date.now();
  const inP='-'+Date.now(),alone=String(Number(inP)-1),P='c3'.repeat(32);
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[inP,alone]}),
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
    return {reader,result:await s.controlledActions.propose(reader,{kind:'mcp',arguments:{connection:'gmail',...args}})};
  };
  const look={tool:'search_mail',input:{query:'from:someone@example.com'}};
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1) ON CONFLICT(id) DO NOTHING",[P,'Synthetic project P']);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode='assigned'",[inP,P]);

    // Only the three fixed reads, with checked inputs.
    for(const args of [{tool:'send_mail',input:{query:'x'}},{tool:'read_message',input:{id:'../x'}},{tool:'search_mail',input:{}},
      {tool:'search_mail',input:{query:'x',max:'5'}},{...look,project:P}])
      await assert.rejects(ask('123','Look it up',args),{code:'invalid_mcp_action'},JSON.stringify(args));

    // The owner's private chat reads with no card.
    const own=await ask('123','What did someone send me?',look);
    assert.equal(own.result.state,'approved');
    assert.equal((await stores.control.query("SELECT 1 FROM security_events WHERE rule='gmail_read:own' AND state='allowed'")).rowCount,1);

    // Never in a group, even the owner's own message in a project's group.
    await assert.rejects(ask(inP,'Search my mail',look),{code:'gmail_not_here'});
    await assert.rejects(ask(alone,'Search my mail',look,9),{code:'gmail_not_here'});

    // Right before it runs: never a job, and still from the owner's private chat.
    const asked=await row(own.result.id);
    assert.equal(gmailRunRefusal(asked,'123'),null);
    assert.equal(gmailRunRefusal({...asked,job_id:'made-up-job'},'123'),'gmail_not_here');
    assert.equal(gmailRunRefusal({...asked,scope:inP,space_id:inP},'123'),'gmail_not_here');
    assert.equal(gmailRunRefusal(asked,null),'gmail_not_here');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
