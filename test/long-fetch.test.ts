import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {longFetch} from '../src/long-fetch.js';

/** A local server that answers as slowly as each test needs; its waits end when it closes. */
async function slowServer(handle:(req:IncomingMessage,res:ServerResponse,wait:(ms:number)=>Promise<void>)=>Promise<void>|void) {
  const stop=new AbortController(),wait=(ms:number)=>sleep(ms,undefined,{signal:stop.signal});
  const server:Server=createServer((req,res)=>{void Promise.resolve().then(()=>handle(req,res,wait)).catch(()=>res.destroy());});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return {base:'http://127.0.0.1:'+address.port,async close(){stop.abort();server.closeAllConnections();server.close();await once(server,'close');}};
}
const body=async(req:IncomingMessage)=>{let text='';for await(const part of req)text+=part;return text;};

test('a slow server is waited for, without going through Node fetch',async t=>{
  // Node's fetch is what gives up after five minutes, so this transport never uses it.
  const fetches=t.mock.method(globalThis,'fetch',async()=>{throw Error('fetch_used');});
  const seen:{method?:string;length?:string;text?:string}={};
  const server=await slowServer(async(req,res,wait)=>{
    Object.assign(seen,{method:req.method,length:req.headers['content-length'],text:await body(req)});
    await wait(600);res.writeHead(200,{'content-type':'application/json','set-cookie':['a=1','b=2']});
    res.write('{"answer":');await wait(400);res.end('"Synthetic memory"}');
  });
  try {
    const response=await longFetch(server.base+'/v3/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{"query":"fünf"}',signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/json');
    assert.deepEqual(response.headers.getSetCookie(),['a=1','b=2']);
    assert.deepEqual(await response.json(),{answer:'Synthetic memory'});
    assert.deepEqual(seen,{method:'POST',length:String(Buffer.byteLength('{"query":"fünf"}')),text:'{"query":"fünf"}'});
    assert.equal(fetches.mock.callCount(),0);
  }finally{await server.close();}
});

test("the caller's deadline or cancellation ends a call, before or during the answer",async()=>{
  const closed:string[]=[];
  const server=await slowServer(async(req,res,wait)=>{
    res.on('close',()=>{if(!res.writableFinished)closed.push(req.url!);});
    if(req.url==='/headers-late'){await wait(5000);res.end('late');return;}
    res.writeHead(200);res.write('first');await wait(5000);res.end('late');
  });
  try {
    await assert.rejects(longFetch(server.base+'/headers-late',{signal:AbortSignal.timeout(150)}),{name:'TimeoutError'});
    const controller=new AbortController(),response=await longFetch(server.base+'/body-late',{signal:controller.signal});
    const reader=response.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(),'first');
    controller.abort();await assert.rejects(reader.read());
    await assert.rejects(longFetch(server.base+'/never',{signal:controller.signal}),{name:'AbortError'});
    for(let i=0;i<50&&closed.length<2;i++)await sleep(20);
    assert.deepEqual(closed.sort(),['/body-late','/headers-late'],'the server sees each abandoned call close');
  }finally{await server.close();}
});

test('a redirect is refused and an empty answer has no body',async()=>{
  const server=await slowServer((req,res)=>{
    if(req.url==='/moved'){res.writeHead(307,{location:'http://example.invalid/'});res.end('moved');return;}
    res.writeHead(204);res.end();
  });
  try {
    await assert.rejects(longFetch(server.base+'/moved'),{name:'TypeError',message:'long_fetch_redirect'});
    const empty=await longFetch(server.base+'/empty',{method:'DELETE'});
    assert.equal(empty.status,204);assert.equal(empty.body,null);
    await assert.rejects(longFetch('ftp://127.0.0.1/'),{message:'long_fetch_protocol'});
  }finally{await server.close();}
});

// Takes five minutes and ten seconds, so it runs only on request: NOCHEH_LONG_WAIT_TEST=1.
test('a call outlives the five minutes Node fetch waits for an answer',{skip:!process.env.NOCHEH_LONG_WAIT_TEST},async()=>{
  const server=await slowServer(async(_req,res,wait)=>{await wait(310000);res.end('{"content":"Synthetic memory"}');});
  try {
    const options={method:'POST',body:'{}',signal:AbortSignal.timeout(480000)};
    const [viaFetch,viaLong]=await Promise.allSettled([fetch(server.base+'/fetch',options),longFetch(server.base+'/long',options)]);
    assert.equal(viaFetch.status,'rejected','Node fetch no longer gives up at five minutes; longFetch may be unnecessary');
    assert.equal((viaFetch.reason as {cause?:{code?:string}}).cause?.code,'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(viaLong.status,'fulfilled');
    assert.deepEqual(await viaLong.value.json(),{content:'Synthetic memory'});
  }finally{await server.close();}
});
