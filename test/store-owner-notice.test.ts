import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeToken} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {storageServer} from '../src/stores/server.js';
import type {StorageServices} from '../src/stores/services.js';
import {ActionCommandRepository} from '../src/stores/action-commands.js';

test('a problem notice goes to the owner’s private chat in the owner’s wording, and only the owner’s services may send one',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nocheh-owner-notice-'));
  const token='fixture-owner-token',calls:any[]=[];
  let owner:string|null='42',texts:Record<string,string>={};
  const services={access:{policy:()=>({owner_id:owner})},stores:{control:{query:async()=>({rows:[{texts}]})}}} as unknown as StorageServices;
  const server=storageServer(services,{token,dataDir} as Settings,async(operation,input)=>{calls.push([operation,input]);return {state:'done'};});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const send=(body:unknown,bearer=token)=>fetch(`http://127.0.0.1:${address.port}/v1/runtime/owner-notice`,
      {method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body)});
    const id='a'.repeat(64),problems=['Memory notes: 2 tasks failed (13 so far).','Secret check (synthetic-model): 1 model call failed today: 1 refused by the model.'];
    const sent=await send({id,problems});
    assert.equal(sent.status,200);assert.deepEqual(await sent.json(),{state:'done'});
    assert.deepEqual(calls[0],['telegram.notice',{id,chat_id:'42',text:'⚠️ Nocheh found a problem:\n• '+problems[0]+'\n• '+problems[1]+'\n\nSee System › Health in the dashboard.'}]);
    texts={'system.problems':'Problems:\n{problems}'};
    await send({id,problems:[problems[0]]});
    assert.equal(calls[1][1].text,'Problems:\n• '+problems[0],'the owner’s own wording from Settings');
    await send({id,problems,open:{kind:'web_app',url:'https://mini.example.test/?page=problems'},retry:true});
    assert.deepEqual(calls[2][1].buttons,[{text:'🔎 Open',web_app:'https://mini.example.test/?page=problems'},{text:'🔁 Retry failed',callback:'nr'}],
      'Open goes to the mini app and Retry failed is a press storage handles');
    texts={'system.problem_buttons':'open: Look'};
    await send({id,problems,open:{kind:'url',url:'http://127.0.0.1:8783/#system'}});
    assert.deepEqual(calls[3][1].buttons,[{text:'Look',url:'http://127.0.0.1:8783/#system'}],'the owner’s own button wording');
    for(const body of [{id:'not-hex',problems},{id,problems:[]},{id,problems:['x'.repeat(501)]},{id,problems:Array(21).fill('x')},
      {id,problems,open:{kind:'web_app',url:'http://mini.example.test'}},{id,problems,open:{kind:'url',url:'javascript:alert(1)'}},{id,problems,open:{kind:'callback',url:'https://x.test'}}])
      assert.equal((await send(body)).status,400);
    assert.equal((await send({id,problems},scopeToken(token,'owner',Date.now()+60_000))).status,403,'a chat turn cannot send one');
    owner=null;
    assert.deepEqual(await (await send({id,problems})).json(),{state:'not_started',error_code:'owner_not_set'});
    assert.equal(calls.length,4);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('Retry failed under a problem notice retries only on the owner’s press in their private chat',async()=>{
  const answers:any[]=[],queries:string[]=[];let press:any={id:'q1',data:'nr',from:{id:42},message:{chat:{id:42}}};
  const access={policy:()=>({owner_id:'42'}),archive:{verify:async()=>({kind:'telegram_update',origin:'live'})},
    stores:{archive:{query:async()=>({rows:[{payload:Buffer.from(JSON.stringify({callback_query:press}))}]})},
      control:{query:async(sql:string)=>{queries.push(sql);return sql.includes('owner_prompts')?{rows:[{texts:{}}]}:{rows:[]};}}}};
  const actions=new ActionCommandRepository(access as any,{} as any,{} as any,async(operation,input)=>{answers.push([operation,input]);return {state:'done'};});
  const source={store:'archive',kind:'event',id:'e'.repeat(64),revision:'1',input_hash:'f'.repeat(64)} as any;
  assert.equal(await actions.callback(source),true);
  assert.deepEqual(answers[0],['telegram.approval',{kind:'answer',chat_id:'42',callback_query_id:'q1',text:'Nothing failed can be retried right now.'}]);
  assert.ok(queries.some(sql=>sql.includes('workflow_observations')),'the owner’s press looks for failed work to retry');
  press={...press,id:'q2',from:{id:7}};queries.length=0;
  assert.equal(await actions.callback(source),true);
  assert.equal(answers[1][1].text,'Only the owner can do this.');
  assert.ok(!queries.some(sql=>sql.includes('workflow_observations')),'anyone else’s press retries nothing');
});
