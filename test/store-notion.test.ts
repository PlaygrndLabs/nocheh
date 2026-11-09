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
import {notionAddress,notionJobFetch,notionOwnInput,notionReads,notionRunRefusal} from '../src/stores/notion.js';

test('a Notion read stays in the owner\'s Notion only when every address in its input is the owner\'s',()=>{
  const id='0123456789abcdef0123456789abcdef',uuid='01234567-89ab-cdef-0123-456789abcdef';
  for(const input of [{query:'made-up tasks'},{query:'alex@example.com',query_type:'user'},{user_id:'self'},
    {data:{data_source_urls:['collection://'+uuid],query:'SELECT * FROM "collection://'+uuid+'" WHERE "Name" = ?',params:['a:b']}},
    {data:{mode:'view',view_url:'https://www.notion.so/'+id+'?v='+id}},{page_id:uuid,discussion_id:'discussion://'+id+'/'+id+'/'+id},
    {data:{filter:{property:'Owner',people:{contains:'user://'+uuid}}}},{id:'https://www.notion.so/Page-'+id+'?source=copy_link'},
    {id:'https://notion.so/'+id+'?v=1'},{id:'view://'+uuid},{query:'(see https://www.notion.so/'+id+')'},{query:'see\nhttps://www.notion.so/'+id}])
    assert.equal(notionOwnInput(input),true,JSON.stringify(input));
  for(const input of [{id:'https://made-up.notion.site/Page'},{query:'x',page_url:'https://made-up.notion.site/Page'},{page_url:'made-up.notion.site/Page'},
    {page_id:'https://made-up.notion.site/x'},{data:{mode:'view',view_url:'https://made-up.notion.site/x?v='+id}},{query:'see https://example.test'},
    {id:'https://notion.so/'+id+'?next=https://example.test'},{id:'https://notion.so/'+id+'?next=x'},{id:'HTTPS://made-up.notion.site/x'},
    {id:'https://notion.so./'+id},{'https://example.test/?q=1':true,id},{id:'memory'},{id:'notion://docs/made-up'},
    // Host spellings that parsers read differently: a backslash, a percent escape, a user name, a written port, a tab.
    {id:'https://www.notion.so\\@made-up.notion.site/x'},{query:'see https://www.notion.so\\@made-up.notion.site/x'},{id:'https://www.notion%2Eso/'+id},
    {id:'https://www.notion.so@made-up.notion.site/'+id},{id:'https://notion.so:443/'+id},{id:'https://www.notion\t.so/'+id},
    // In free text too: a user part after a stop, a tab or newline inside the address, and https: however its slashes are written.
    {query:"see https://www.notion.so'@made-up.notion.site/x"},{query:'https://www.notion.so{@made-up.notion.site/x'},{query:'https://www.notion.so(@made-up.notion.site/x'},
    {query:'https:/\t/made-up.notion.site/x'},{query:'https:/\n/made-up.notion.site/x'},{query:'https:made-up.notion.site/x'},{query:'https:/\\made-up.notion.site/x'},
    {query:'HTTPS:/made-up.notion.site/x'},
    {data:{query:'SELECT * FROM "collection://made-up"'}},{discussion_id:'discussion://'+id+'/'+id+'/'+id+'/'+id}])
    assert.equal(notionOwnInput(input),false,JSON.stringify(input));
  assert.ok(notionAddress(id)&&notionAddress('collection://'+uuid)&&!notionAddress('bot://'+uuid)&&!notionAddress('http://www.notion.so/'+id));
  // A job's fetch keeps its own narrower rule on top: one page, data source or view, and nothing beside it but switches.
  assert.ok(notionJobFetch({id,full:true})&&!notionJobFetch({id,skill:'made-up text'})&&!notionJobFetch({id:'user://'+uuid})&&!notionJobFetch({}));
  // Every address is found in one pass, so an input at the 32,000-character cap is checked in a few milliseconds.
  for(const [query,own] of [['https:/'.repeat(4570),false],[':/'.repeat(16000),true],['a'.repeat(31990)+'://x',false],
    [('https://www.notion.so/'+id+' ').repeat(560),true],[('a://'+'b'.repeat(40)+' ').repeat(700),false]] as [string,boolean][]) {
    const started=performance.now(),found=notionOwnInput({query});
    assert.ok(performance.now()-started<100,'took '+(performance.now()-started)+' ms');
    assert.equal(found,own);
  }
});

test('right before a Notion call runs, it must come from the owner\'s private chat or a job the owner approved there',async()=>{
  const asked={store:'archive',id:'made-up-event'},pressed={store:'archive',id:'made-up-press'};
  const job={scope:'123',requester:null,decided_by:'123',logical_profile:'job-made-up',notion_reads:true};
  const db=(row:any)=>({query:async()=>({rows:row?[row]:[]})}) as any;
  const call=(change:Record<string,unknown>={})=>({scope:'123',space_id:'123',job_id:null,logical_profile:'job-made-up',state:'approved',
    source_reference:asked,decision_reference:asked,...change});
  assert.equal(await notionRunRefusal(db(null),call(),'123'),null,'a live private turn');
  assert.equal(await notionRunRefusal(db(null),call(),null),'notion_owner_private_only','no owner, no Notion');
  assert.equal(await notionRunRefusal(db(null),call({space_id:'-100555'}),'123'),'notion_owner_private_only');
  assert.equal(await notionRunRefusal(db(null),call({scope:'-100555'}),'123'),'notion_owner_private_only');
  assert.equal(await notionRunRefusal(db(job),call({job_id:'made-up-job'}),'123'),null,'the owner\'s approved job, its read let through');
  assert.equal(await notionRunRefusal(db({...job,notion_reads:false}),call({job_id:'made-up-job'}),'123'),'notion_job_not_approved');
  assert.equal(await notionRunRefusal(db({...job,notion_reads:false}),call({job_id:'made-up-job',decision_reference:pressed}),'123'),null,
    'a call the owner approved on its own card');
  for(const change of [{requester:'9'},{decided_by:'9'},{scope:'-100555'},{logical_profile:'job-other'}])
    assert.equal(await notionRunRefusal(db({...job,...change}),call({job_id:'made-up-job',decision_reference:pressed}),'123'),'notion_job_not_approved',JSON.stringify(change));
  // A scheduled task's call has no background job: only its own card or an exact permission lets it run, never the setting.
  assert.equal(await notionRunRefusal(db(null),call({job_id:'made-up-schedule',decision_reference:pressed}),'123'),null);
  assert.equal(await notionRunRefusal(db(null),call({job_id:'made-up-schedule',state:'proposed',decision_reference:null}),'123'),null);
  assert.equal(await notionRunRefusal(db(null),call({job_id:'made-up-schedule'}),'123'),'notion_job_not_approved');
});

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
    // Outside addresses ask first: a read of a page that is not the owner's Notion waits like a change.
    const page='0123456789abcdef0123456789abcdef',collection='collection://01234567-89ab-cdef-0123-456789abcdef';
    assert.equal((await ask('Read a public page',{tool:'notion-fetch',input:{id:'https://made-up.notion.site/Page'}})).state,'proposed');
    assert.equal((await ask('Read my page',{tool:'notion-fetch',input:{id:'https://www.notion.so/Made-up-'+page}})).state,'approved');
    assert.equal((await ask('Search a public page',{tool:'notion-search',input:{query:'x',page_url:'https://made-up.notion.site/Page'}})).state,'proposed');
    assert.equal((await ask('Query my table',{tool:'notion-query-data-sources',input:{data:{data_source_urls:[collection],query:'SELECT * FROM "'+collection+'"'}}})).state,'approved');
    assert.equal((await ask('Comments of a public page',{tool:'notion-get-comments',input:{page_id:'https://made-up.notion.site/x'}})).state,'proposed');
    assert.equal((await ask('Search with an address',{tool:'notion-search',input:{query:'see https://example.test/made-up'}})).state,'proposed');
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
    assert.equal((await ask('Read another public page',{tool:'notion-fetch',input:{id:'https://made-up.notion.site/Other'}})).state,'approved',
      'nothing asks: a read of an outside address is a change, so it runs too');

    await s.notion.save(owner,{enabled:false,expected_revision:open.revision});
    await assert.rejects(ask('Search when off',{...search,input:{query:'off'}}),{code:'notion_not_enabled'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
