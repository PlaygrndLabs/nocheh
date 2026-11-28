import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {ownIds} from '../src/stores/prepared-context.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {storageServer} from '../src/stores/server.js';
import type {Settings} from '../src/config.js';
import {keyPass,openKey} from './one-time-key-pass.js';

const taskId=digest('fixture-task'),parentId=digest('fixture-parent'),projectId=digest('fixture-project');
const hexNote=digest('fixture-hex-secret-in-notes'),hexProperty=digest('fixture-hex-secret-in-a-property');

test('only 64-hex values under id keys of Nocheh\'s own answers count as its ids',()=>{
  const answer={task:{id:taskId,parent_id:parentId,scope:projectId,title:taskId,notes:hexNote,version:'a'.repeat(32),
    blocked_by:[{id:parentId,title:'Blocker'}],properties:{owner_named_id:hexProperty},external:{notion_id:hexProperty}},event_ids:[taskId,'not-an-id']};
  assert.deepEqual([...ownIds(answer)].sort(),[taskId,parentId,projectId].sort());
  assert.deepEqual([...ownIds(JSON.stringify(answer))],[],'text is never read for ids');
  assert.deepEqual([...ownIds({id:taskId.toUpperCase()})],[],'only Nocheh\'s lowercase digests');
});

test('a task id the secret check would hide passes once Nocheh answered with it; secrets beside it are still hidden',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-own-ids-')),key='own-ids:'+Date.now();
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key,revision:'1',occurred_at:null,
    text:'List my tasks.',payload:{message:{chat:{id:123,type:'private'},text:'List my tasks.'}}};
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',async()=>[]);
    const binding=await services.guards.state();
    const reader:Reader={admin:false,scope:null,space:'123',turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch};
    // Like the secret-check model in a live chat: every 64-hex string looks like a key to it.
    const detect=async(text:string)=>[...new Set(text.match(/saffronpass|[a-f0-9]{64}/g)??[])];
    const answer={task:{id:taskId,parent_id:parentId,title:'Call the bank, the door code is saffronpass',notes:hexNote,
      properties:{owner_named_id:hexProperty}}};
    const hidden=String(await services.prepared.prepare(reader,'Before: '+JSON.stringify(answer),detect));
    assert.ok(!hidden.includes(taskId),'without Nocheh\'s answer the id is hidden as before');

    await services.prepared.allowIds(reader,answer);
    // The agent hands the tool's answer to the model as text.
    const result=String(await services.prepared.prepare(reader,JSON.stringify(answer),detect));
    assert.ok(result.includes(taskId)&&result.includes(parentId),'Nocheh\'s own ids pass');
    assert.ok(!result.includes('saffronpass'),'a secret in the title is still hidden');
    assert.ok(!result.includes(hexNote)&&!result.includes(hexProperty),'a 64-hex value in free text or a property is still hidden');
    // The model's next call names the id; its request keeps it.
    const request={messages:[{role:'assistant',content:[{type:'tool_use',id:'toolu_fixture1',name:'mcp__nocheh__tasks',input:{action:'update',task:taskId,state:'done'}}]}]};
    assert.equal(JSON.stringify(await services.prepared.prepare(reader,request,detect,{request:true})),JSON.stringify(request));
    // Another audience never inherits them.
    const other=String(await services.prepared.prepare({...reader,purpose:'filter'},JSON.stringify(answer),detect));
    assert.ok(!other.includes(taskId));
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('the tasks tool\'s ids stay whole in the owner\'s chat, from add to update',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-task-ids-')),key='task-ids:'+Date.now(),token='synthetic-service-token-only-for-tests';
  const policy={enabled:true,owner_id:'123',group_ids:['-321']};
  // The secret check flags every 64-hex string, as the live model did.
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[...new Set(String(input.text).match(/saffronpass|[a-f0-9]{64}/g)??[])]};
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const server=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy} as unknown as Settings,async()=>({}));
  try {
    await s.guards.reconcile();await s.configuration.configure({...policy,topic_memory:'group'} as any,'on');
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    let sent=0;
    const turn=async(text:string)=>{
      const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:'123',source_id:String(id),revision:'1',occurred_at:null,text,
        payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:{id:123,type:'private'},from:{id:123,first_name:'Owner'},text}}};
      const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);
      const binding=await s.guards.state();
      const pass=await openKey(stores.control,keyPass(token,null,Date.now()+600000,source.id,{space:'123',revision:binding.epoch,guard_epoch:binding.epoch,generation:binding.generation}));
      return async(method:string,path:string,body?:unknown)=>{
        const answer=await fetch(base+path,{method,headers:{authorization:'Bearer '+pass,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
        return {status:answer.status,body:await answer.json() as any};
      };
    };
    // The agent hands each tool answer to the model through /v1/context/prepare, as Hermes does.
    const shown=async(call:Awaited<ReturnType<typeof turn>>,answer:unknown)=>{
      const prepared=await call('POST','/v1/context/prepare',JSON.stringify(answer));assert.equal(prepared.status,200,JSON.stringify(prepared.body));return String(prepared.body);
    };
    const first=await turn('Add a task to call the bank');
    const added=await first('POST','/v1/owner/tasks',{title:'Call the bank, door code saffronpass'});
    assert.equal(added.status,200,JSON.stringify(added.body));
    const task=added.body.task??added.body,id=String(task.id);assert.match(id,/^[a-f0-9]{64}$/);
    const addText=await shown(first,added.body);
    assert.ok(addText.includes(id),'the new task\'s id reaches the model');assert.ok(!addText.includes('saffronpass'),'the secret in its title does not');

    const second=await turn('Mark it done');
    const listText=await shown(second,(await second('GET','/v1/owner/tasks')).body);
    assert.ok(listText.includes(id),'a list shows the id whole');
    const updated=await second('POST','/v1/owner/tasks/'+id,{expected_revision:task.revision,state:'done'});
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    assert.ok((await shown(second,updated.body)).includes(id));
  } finally {server.close();await stores.close();await rm(root,{recursive:true,force:true});}
});
