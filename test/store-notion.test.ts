import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {notionReads} from '../src/stores/notion.js';

test('Notion runs only from the owner\'s private chat while on, and the owner\'s setting decides which calls ask first',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-notion-')),key='notion:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},honcho:async()=>{throw Error('no memory provider');}});
  let serial=0;
  const capture=async(scope:string,from:number,text:string)=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const ask=async(text:string,args:Record<string,unknown>,scope:string|null=null)=>s.controlledActions.propose(
    await actor((await capture(scope??'123',123,text)).id,scope,scope??'123'),{kind:'mcp',arguments:{connection:'notion',...args}});
  const search={tool:'notion-search',input:{query:'reading list'}},create={tool:'notion-create-pages',input:{pages:[{properties:{title:'Plan'}}]}};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    assert.ok(notionReads('notion-search')&&notionReads('notion-fetch')&&notionReads('notion-get-users')&&notionReads('notion-query-data-sources'));
    assert.ok(!notionReads('notion-create-pages')&&!notionReads('notion-update-page')&&!notionReads('notion-move-pages')&&!notionReads('notion-getx'));
    const initial=await s.notion.get(owner);
    assert.deepEqual([initial.enabled,initial.approval],[false,'changes'],'Notion is off until the owner turns it on');
    await assert.rejects(s.notion.get({admin:false,scope:null}),{status:403});
    await assert.rejects(ask('Search Notion',search),{code:'notion_not_enabled'});
    await assert.rejects(s.controlledActions.propose(await actor((await capture('123',123,'Mixed')).id,null,'123'),
      {kind:'mcp',arguments:{connection:'notion',url:'https://example.com/mcp',...search}}),{code:'invalid_mcp_action'},'the address is never the model\'s choice');

    const on=await s.notion.save(owner,{enabled:true,expected_revision:initial.revision});
    await assert.rejects(s.notion.save(owner,{enabled:false,expected_revision:initial.revision}),{code:'notion_settings_changed'});
    await assert.rejects(s.notion.save(owner,{approval:'sometimes',expected_revision:on.revision}),{code:'invalid_notion_settings'});
    assert.equal((await ask('Search Notion',search)).state,'approved','a read runs right away by default');
    assert.equal((await ask('List Notion tools',{operation:'list'})).state,'approved');
    const change=await ask('Add a page',create);
    assert.equal(change.state,'proposed','a change waits for the owner');
    const rule=(await stores.control.query("SELECT rule,origin FROM security_events WHERE state='allowed' AND rule LIKE 'notion_setting:%' LIMIT 1")).rows[0];
    assert.deepEqual(rule,{rule:'notion_setting:'+on.revision,origin:'grant'},'the decision names the setting revision that allowed it');
    await assert.rejects(ask('Search from a group',search,group),{code:'notion_owner_private_only'},'groups never reach Notion');
    assert.equal((await stores.control.query("SELECT count(*)::int FROM controlled_actions WHERE kind='mcp' AND space_id=$1",[group])).rows[0].count,0);

    // Everything asks: even the owner freedom setting does not let a Notion read run.
    const freedom=await s.ownerAutonomy.get(owner);
    await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:freedom.revision,operation_id:key+':free'});
    const strict=await s.notion.save(owner,{approval:'everything',expected_revision:on.revision});
    assert.equal((await ask('Search again',{...search,input:{query:'books'}})).state,'proposed');
    const open=await s.notion.save(owner,{approval:'nothing',expected_revision:strict.revision});
    assert.equal((await ask('Add another page',{...create,input:{pages:[{properties:{title:'Other'}}]}})).state,'approved','nothing asks: changes run too');

    await s.notion.save(owner,{enabled:false,expected_revision:open.revision});
    await assert.rejects(ask('Search when off',{...search,input:{query:'off'}}),{code:'notion_not_enabled'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
