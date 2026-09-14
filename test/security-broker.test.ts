import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {turnToken} from '../src/access.js';
import {brokerServer,providerTarget,scopedRoute} from '../src/security/broker.js';

test('broker supports only explicit scoped routes and fixed subscription destinations',()=>{
  for(const route of ['/v1/export','/v1/tools/claim','/internal/security/transport','/v1/memory/shares','//example.com'])assert.equal(scopedRoute('POST',route),false);
  assert.equal(scopedRoute('POST','/v1/context/prepare'),true);
  assert.equal(scopedRoute('GET','/v1/search'),true);
  assert.throws(()=>providerTarget({base_url:'https://attacker.example',api_mode:'codex_responses'},'/codex/responses'));
  assert.throws(()=>providerTarget({base_url:'https://chatgpt.com/backend-api/codex',api_mode:'codex_responses'},'/codex/models'));
});
test('PostgreSQL broker: scoped credential, exact preparation, route denial and every-attempt epoch checks',{skip:!process.env.PGHOST},async t=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace='security_broker_'+Date.now();await admin.query('CREATE SCHEMA '+namespace);
  const pool=new pg.Pool({...connection,options:'-c search_path='+namespace});
  const token='synthetic-service-token-only-for-tests',calls:{url:string;body:unknown;auth:string}[]=[];
  const secret='synthetic-provider-credential-never-returned';
  let guardDown=false,streamRevocation=false,slowMemory=false;
  const mock:typeof fetch=async(url,init)=>{
    const body=init?.body?JSON.parse(String(init.body)):null;
    calls.push({url:String(url),body,auth:new Headers(init?.headers).get('authorization')??''});
    if(slowMemory&&String(url).includes('/memory/')) {
      init?.signal?.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(resolve,40);
        init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal?.reason);},{once:true});
      });
      return Response.json({sources:[]});
    }
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://chatgpt.com/backend-api/codex',api_mode:'codex_responses',api_key:secret});
    if(String(url).endsWith('/v1/guard'))return guardDown?new Response('unavailable',{status:503}):Response.json({guarded:true,payload:body.payload});
    if(streamRevocation)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      setTimeout(()=>{void pool.query('UPDATE guard_state SET epoch=epoch+1').then(()=>{controller.enqueue(new TextEncoder().encode('data: stale\n\n'));controller.close();});},30);
    }}),{headers:{'content-type':'text/event-stream'}});
    return Response.json({ok:true});
  };
  const server=brokerServer({pool,token,archive:'http://archive',guard:'http://guard',hermes:'http://hermes',model:'same-model',fetch:mock});
  try {
    await initialize(pool);
    const event=await ingest(pool,{version:1,key:'security-turn',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'1',revision:'0',occurred_at:null,text:'exact source',payload:{profile:'owner'}},false);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();const base='http://127.0.0.1:'+address.port;
    const credential=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:1});
    const request=(path:string,body:unknown,key=credential)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});
    const payload={model:'same-model',input:[{role:'user',content:'Exact owner edit 🧠\r\n two  spaces'}],reasoning:{effort:'high'}};
    const response=await request('/codex/responses',payload);
    assert.equal(response.status,200);assert.equal((await response.text()).includes(secret),false);
    const provider=calls.at(-1)!;assert.deepEqual(provider.body,payload);assert.equal(provider.auth,'Bearer '+secret);
    assert.equal(calls.find(x=>x.url==='http://guard/v1/guard')!.auth,'Bearer '+credential);
    const before=calls.length;
    for(const path of ['/internal/security/transport','/v1/tools/claim','/codex/responses?url=https://evil.example'])assert.equal((await request(path,payload)).status,403);
    assert.equal((await request('/codex/responses',{...payload,model:'changed-model'})).status,403);
    assert.equal((await request('/codex/responses',{...payload,tools:[{type:'web_search'}]})).status,403);
    assert.equal((await pool.query("SELECT rule FROM security_events WHERE state='blocked' ORDER BY id DESC LIMIT 1")).rows[0].rule,'hosted_provider_tools_denied');
    assert.equal((await request('/codex/responses',payload,token)).status,403);
    assert.equal(calls.length,before,'denied calls never reach upstreams');
    // Compress only broker deadlines so this covers a slow recall without a
    // multi-minute test. The normal memory route still times out and cancels.
    const setTimer=globalThis.setTimeout;
    const clock=t.mock.method(globalThis,'setTimeout',((fn:any,ms?:number,...args:any[])=>
      setTimer(fn,ms===600000?1000:ms===120000?5:ms,...args)) as typeof setTimeout);
    slowMemory=true;
    try {
      assert.equal((await request('/v1/memory/honcho/recall',{query:'Synthetic recall'})).status,200);
      assert.equal((await request('/v1/memory/recall',{query:'Synthetic recall'})).status,503);
    }finally{slowMemory=false;clock.mock.restore();}
    guardDown=true;
    assert.equal((await request('/codex/responses',payload)).status,503);
    assert.equal(calls.filter(x=>x.url==='https://chatgpt.com/backend-api/codex/responses').length,1,'guard outage never falls back to a direct provider call');
    const afterOutage=calls.length;
    await pool.query('UPDATE guard_state SET epoch=epoch+1');
    assert.equal((await request('/codex/responses',payload)).status,409);
    assert.equal(calls.length,afterOutage,'stale capabilities fail before any provider lookup');
    guardDown=false;streamRevocation=true;
    const fresh=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:2});
    const streaming=await request('/codex/responses',payload,fresh);
    await assert.rejects(streaming.text(),'revocation cuts off in-flight output');
    let states:string[]=[];
    for(let i=0;i<20;i++){
      states=(await pool.query("SELECT state FROM security_events WHERE kind='model.request' ORDER BY id DESC LIMIT 1")).rows.map(row=>row.state);
      if(states[0]==='ambiguous')break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(states[0],'ambiguous','started stream without an observed finish is never logged as completed');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query('DROP SCHEMA '+namespace+' CASCADE');await admin.end();}
});
