import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeToken} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {storageServer} from '../src/stores/server.js';
import type {StorageServices} from '../src/stores/services.js';

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
    const id='a'.repeat(64),problems=['Memory notes: 2 tasks failed (13 so far).','Secret check (synthetic-model): 1 model call failed today, 1 refused by the model.'];
    const sent=await send({id,problems});
    assert.equal(sent.status,200);assert.deepEqual(await sent.json(),{state:'done'});
    assert.deepEqual(calls[0],['telegram.notice',{id,chat_id:'42',text:'⚠️ Nocheh found a problem:\n• '+problems[0]+'\n• '+problems[1]+'\n\nSee System › Health in the dashboard.'}]);
    texts={'system.problems':'Problems:\n{problems}'};
    await send({id,problems:[problems[0]]});
    assert.equal(calls[1][1].text,'Problems:\n• '+problems[0],'the owner’s own wording from Settings');
    for(const body of [{id:'not-hex',problems},{id,problems:[]},{id,problems:['x'.repeat(501)]},{id,problems:Array(21).fill('x')}])
      assert.equal((await send(body)).status,400);
    assert.equal((await send({id,problems},scopeToken(token,'owner',Date.now()+60_000))).status,403,'a chat turn cannot send one');
    owner=null;
    assert.deepEqual(await (await send({id,problems})).json(),{state:'not_started',error_code:'owner_not_set'});
    assert.equal(calls.length,2);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dataDir,{recursive:true,force:true});
  }
});
