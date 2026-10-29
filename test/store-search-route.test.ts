import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {storageServer} from '../src/stores/server.js';

test('archive search routes bounded reaction discovery separately from lexical search',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nocheh-search-route-')),token='synthetic-search-route-token',calls:unknown[][]=[];
  const s={stores:{control:{}},sources:{currentReactions:async(...args:unknown[])=>{calls.push(['reactions',...args]);return {sources:[],complete:false};},
    search:async(...args:unknown[])=>{calls.push(['text',...args]);return [];}}};
  const server=storageServer(s as unknown as Parameters<typeof storageServer>[0],
    {token,dataDir:root} as Parameters<typeof storageServer>[1],async()=>({}));
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    const request=(query:string)=>fetch(`http://127.0.0.1:${address.port}/v1/search?${query}`,{headers:{authorization:'Bearer '+token}});
    const response=await request('mode=current_reactions');assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{sources:[],complete:false});assert.equal(calls[0]![2],5);
    assert.equal((await request('mode=current_reactions&limit=11')).status,400);
    assert.equal((await request('mode=unknown')).status,400);assert.equal(calls.length,1);
    assert.equal((await request('q=packet&scope=synthetic')).status,200);
    assert.deepEqual(calls[1],['text',{admin:true,scope:null},'packet',20,{kind:'',scope:'synthetic',reply:''}]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('the conversation page route passes the chat, dates and page boundary and bounds the page size',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nocheh-page-route-')),token='synthetic-page-route-token',calls:unknown[][]=[];
  const s={stores:{control:{}},sources:{page:async(...args:unknown[])=>{calls.push(args);return {items:[],next:null};}}};
  const server=storageServer(s as unknown as Parameters<typeof storageServer>[0],
    {token,dataDir:root} as Parameters<typeof storageServer>[1],async()=>({}));
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    const request=(query:string)=>fetch(`http://127.0.0.1:${address.port}/v1/archive/page?${query}`,{headers:{authorization:'Bearer '+token}});
    assert.equal((await request('chat=-100&from=2026-10-01&to=2026-10-07&after=x')).status,200);
    assert.deepEqual(calls[0],[{admin:true,scope:null},{chat:'-100',from:'2026-10-01',to:'2026-10-07',after:'x',count:30}]);
    assert.equal((await request('limit=51')).status,400);assert.equal(calls.length,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
