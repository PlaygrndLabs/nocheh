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
import {OwnerStorageApi} from '../src/stores/owner-api.js';
import {chatToolAllowed,chatToolSettings,toolSpace} from '../src/stores/chat-tools.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {honchoEngine} from '../src/memory/honcho.js';

/** Rows as the control table holds them, read the way the resolver reads them. */
const table=(rows:{space_id:string;shell?:boolean|null;browser?:boolean|null;mcp?:boolean|null;revision?:number}[])=>({
  query:async(_sql:string,[spaces]:[string[]])=>({rows:rows.filter(row=>spaces.includes(row.space_id))
    .map(row=>({shell:null,browser:null,mcp:null,revision:1,...row}))})}) as any;

test('each switch resolves on its own: the topic, then its chat, then every chat, then on',async()=>{
  const none=await chatToolSettings(table([]),'-10042/topic/7');
  assert.deepEqual(none,{space:'-10042/topic/7',revision:0,own:{shell:null,browser:null,mcp:null},values:{shell:true,browser:true,mcp:true},
    origins:{shell:'default',browser:'default',mcp:'default'}},'with nothing saved every tool is on');
  const rows=table([{space_id:'*',shell:false,mcp:false,revision:3},{space_id:'-10042',browser:false,mcp:true,revision:2},{space_id:'-10042/topic/7',shell:true,revision:5}]);
  assert.deepEqual(await chatToolSettings(rows,'-10042/topic/7'),{space:'-10042/topic/7',revision:5,own:{shell:true,browser:null,mcp:null},
    values:{shell:true,browser:false,mcp:true},origins:{shell:'topic',browser:'chat',mcp:'chat'}});
  assert.deepEqual((await chatToolSettings(rows,'-10042/topic/8')).origins,{shell:'every_chat',browser:'chat',mcp:'chat'},'a topic without a row follows its group');
  assert.deepEqual(await chatToolSettings(rows,'-10042'),{space:'-10042',revision:2,own:{shell:null,browser:false,mcp:true},
    values:{shell:false,browser:false,mcp:true},origins:{shell:'every_chat',browser:'chat',mcp:'chat'}});
  assert.deepEqual(await chatToolSettings(rows,'*'),{space:'*',revision:3,own:{shell:false,browser:null,mcp:false},
    values:{shell:false,browser:true,mcp:false},origins:{shell:'every_chat',browser:'default',mcp:'every_chat'}},'every chat falls back to built-in on only');
  // The owner's private chat and its topics are one chat: a topic there never has switches of its own.
  assert.equal(toolSpace('42/topic/5','42'),'42');assert.equal(toolSpace('42','42'),'42');
  assert.equal(toolSpace('-10042/topic/7','42'),'-10042/topic/7');assert.equal(toolSpace('42/topic/5',null),'42/topic/5');
  const owner=table([{space_id:'42',shell:false},{space_id:'42/topic/5',shell:true}]);
  assert.equal(await chatToolAllowed(owner,'shell','42/topic/5','42'),false,'an owner topic follows the owner chat, not a row of its own');
  assert.equal(await chatToolAllowed(owner,'browser','42/topic/5','42'),true);
  // A Notion call is kind mcp; any other kind is refused.
  assert.equal(await chatToolAllowed(rows,'mcp','-10042/topic/9','42'),true);
  assert.equal(await chatToolAllowed(rows,'mcp','-10099','42'),false);
  assert.equal(await chatToolAllowed(rows,'telegram','-10042','42'),false);
});

test('the owner sets tool switches per chat and topic; Nocheh refuses and stops what they turn off',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-chat-tools-')),key='chat-tools:'+Date.now(),group='-10042',topic=group+'/topic/7';
  const owner:Reader={admin:true,scope:null};let detected=0;
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'42',group_ids:[group]}),
    runtime:async operation=>{if(operation==='guard.detect'){detected++;return {literals:[]};}throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const api=new OwnerStorageApi(s),a=s.controlledActions,x=s.controlledExecution;
  let serial=0;
  const capture=async(scope:string,from:number,text:string,thread?:number)=>{
    const label=String(++serial),forum=scope.startsWith('-')&&thread!==undefined;
    const value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope.startsWith('-')?'supergroup':'private',is_forum:forum},from:{id:from},text,
        ...(thread===undefined?{}:{message_thread_id:thread,is_topic_message:true})}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(scope:string|null,space:string,text:string,thread?:number):Promise<Reader>=>{
    const source=await capture(scope??'42',scope===null?42:9,text,thread),binding=await s.guards.state();
    return {admin:false,scope,space,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const host=async(id:string)=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});assert.equal(lease.claimed,true);
    return {id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
  };
  const set=async(space:string,changes:Record<string,boolean|null>)=>s.chatTools.save(owner,{space,changes,expected_revision:(await s.chatTools.get(owner,space)).revision});
  const recorded=async()=>({actions:Number((await stores.control.query('SELECT count(*) FROM controlled_actions')).rows[0].count),
    proposals:Number((await stores.derived.query("SELECT count(*) FROM derived_artifacts WHERE kind='controlled_action_request'")).rows[0].count),detected});
  const shell={kind:'shell',arguments:{command:'printf fixture'}},browser={kind:'browser',arguments:{url:'https://example.com/'}};
  const outside={kind:'mcp',arguments:{url:'https://example.com/mcp',operation:'list'}},notion={kind:'mcp',arguments:{connection:'notion',tool:'notion-search',input:{query:'made-up list'}}};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');

    // Only the owner reads or writes them, here and through the owner route.
    for(const principal of [{admin:false,scope:null},{admin:false,scope:group,space:group}] as Reader[]) {
      await assert.rejects(s.chatTools.get(principal,group),{code:'owner_required'});
      await assert.rejects(s.chatTools.save(principal,{space:group,changes:{shell:false},expected_revision:0}),{code:'owner_required'});
      await assert.rejects(api.request(principal,'GET',new URL('http://fixture/v1/chat-tools')),{code:'owner_required'});
    }
    const initial=await api.request(owner,'GET',new URL('http://fixture/v1/chat-tools')) as any;
    assert.deepEqual(initial,{space:'*',revision:0,own:{shell:null,browser:null,mcp:null},values:{shell:true,browser:true,mcp:true},
      origins:{shell:'default',browser:'default',mcp:'default'}},'no space is every chat, and nothing saved is on');
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM chat_tool_settings')).rows[0].n,0,'the built-in defaults are no row');

    // A save names its revision: a stale one is refused, and every change is exact.
    const every=await api.request(owner,'POST',new URL('http://fixture/v1/chat-tools'),{space:'*',changes:{mcp:false},expected_revision:0}) as any;
    assert.deepEqual([every.revision,every.own.mcp,every.values.mcp,every.origins.mcp],[1,false,false,'every_chat']);
    await assert.rejects(s.chatTools.save(owner,{space:'*',changes:{mcp:true},expected_revision:0}),{status:409,code:'chat_tools_changed'});
    await assert.rejects(s.chatTools.save(owner,{space:group,changes:{shell:false},expected_revision:1}),{status:409,code:'chat_tools_changed'},
      'a chat without a row is at revision 0');
    for(const body of [{space:group,changes:{},expected_revision:0},{space:group,changes:{telegram:false},expected_revision:0},
      {space:group,changes:{shell:'off'},expected_revision:0},{space:group,changes:{shell:false}},{space:group,changes:{shell:false},expected_revision:0,operation:'x'}])
      await assert.rejects(s.chatTools.save(owner,body),{status:400,code:'invalid_chat_tools'},JSON.stringify(body));
    for(const space of ['every','-10042/topic/0','0','-10042/topic/7/x','browser:42'])
      await assert.rejects(s.chatTools.get(owner,space),{status:400,code:'invalid_space'},space);

    // Topic, then chat, then every chat, then on; null hands a switch back.
    await set(group,{shell:false,browser:false});await set(topic,{shell:true,mcp:true});
    const own=await s.chatTools.get(owner,topic);
    assert.deepEqual([own.values,own.origins],[{shell:true,browser:false,mcp:true},{shell:'topic',browser:'chat',mcp:'topic'}]);
    const handed=await set(topic,{mcp:null});
    assert.deepEqual([handed.revision,handed.own,handed.values.mcp,handed.origins.mcp],[2,{shell:true,browser:null,mcp:null},false,'every_chat']);
    assert.deepEqual((await s.chatTools.get(owner,group+'/topic/8')).origins,{shell:'chat',browser:'chat',mcp:'every_chat'});
    // The owner's private chat and its topics are one chat.
    const ownerTopic=await s.chatTools.save(owner,{space:'42/topic/5',changes:{browser:false},expected_revision:0});
    assert.equal(ownerTopic.space,'42');assert.deepEqual((await s.chatTools.get(owner,'42')).own,{shell:null,browser:false,mcp:null});
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM chat_tool_settings WHERE space_id LIKE '42/%'")).rows[0].n,0);
    await set('42',{browser:null});

    // Turned off: refused before the secret check, and nothing is recorded, for each kind and for Notion.
    const member=await actor(group,group,'Please run something'),before=await recorded();
    for(const body of [shell,browser])await assert.rejects(a.propose(member,body),{status:403,code:'tool_disabled_by_owner'},body.kind);
    await assert.rejects(a.propose(member,outside),{status:403,code:'tool_disabled_by_owner'},'mcp follows every chat here');
    assert.deepEqual(await recorded(),before,'no action, no proposal and no secret check');
    const inTopic=await actor(group,topic,'Please run it here',7);
    assert.equal((await a.propose(inTopic,shell)).state,'proposed','the topic turned commands back on for itself');
    await assert.rejects(a.propose(inTopic,browser),{code:'tool_disabled_by_owner'},'and keeps its group\'s page switch');
    await s.notion.save(owner,{enabled:true,expected_revision:(await s.notion.get(owner)).revision});
    const mine=await actor(null,'42','Search my Notion'),quiet=await recorded();
    await assert.rejects(a.propose(mine,notion),{status:403,code:'tool_disabled_by_owner'},'a Notion call is an outside tool call');
    assert.deepEqual(await recorded(),quiet);
    await set('42',{mcp:true});
    assert.equal((await a.propose(mine,notion)).state,'approved','with outside tools on for the owner chat, a Notion read runs');
    const ownTopic=await actor(null,'42/topic/5','Run it in my topic',5);
    assert.equal((await a.propose(ownTopic,shell)).state,'proposed');
    await set('42',{shell:false});
    await assert.rejects(a.propose(ownTopic,{kind:'shell',arguments:{command:'printf other'}}),{code:'tool_disabled_by_owner'},'an owner topic follows the owner chat');

    // Turned off after approval: the claim before it runs rejects it, and nothing runs.
    const asked=await a.propose(inTopic,{kind:'shell',arguments:{command:'printf approved'}});
    await a.decide(owner,{id:asked.id,fingerprint:asked.fingerprint,decision:'approve'});
    const search=await a.propose(mine,{...notion,arguments:{...notion.arguments,input:{query:'another made-up list'}}});assert.equal(search.state,'approved');
    await set(topic,{shell:null});await set('42',{mcp:false});
    assert.deepEqual(await x.claim(await host(asked.id)),{claimed:false,blocked:asked.id,reason:'tool_disabled_by_owner'});
    assert.deepEqual(await x.claim(await host(search.id)),{claimed:false,blocked:search.id,reason:'tool_disabled_by_owner'});
    for(const id of [asked.id,search.id]) {
      const row=await a.row(id);assert.deepEqual([row.state,row.error_code,row.started_at],['rejected','tool_disabled_by_owner',null]);
    }
    // Turned on again, an approved action is claimed as before; the claim no longer names a settings profile.
    const later=await a.propose(member,browser).catch(error=>error);assert.equal(later.code,'tool_disabled_by_owner');
    await set(group,{browser:null});
    const read=await a.propose(member,browser);await a.decide(owner,{id:read.id,fingerprint:read.fingerprint,decision:'approve'});
    const claimed=await x.claim(await host(read.id)) as any;
    assert.equal(claimed.claimed,true);assert.equal('preference' in claimed,false);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
