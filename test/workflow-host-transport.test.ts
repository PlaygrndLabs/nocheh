import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {hostTransport} from '../src/workflows/host-transport.js';

test('host Connect HTTP transport authenticates every route and exposes no UI or event submission',async()=>{
  let requests=0;const upstream=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.end('fixture');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  let active=true;
  const key='a'.repeat(64),transport=hostTransport(key,'http://127.0.0.1:'+(upstream.address() as any).port,undefined,()=>active);
  const server=createServer((req,res)=>{if(!transport.handle(req,res)){res.writeHead(404);res.end();}});transport.attach(server);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
  const authorization='Bearer '+createHash('sha256').update(Buffer.from(key,'hex')).digest('hex');
  try{
    for(const path of ['/v0/connect/start','/v0/connect/flush','/v1/traces/userland']){
      assert.equal((await fetch(base+path,{method:'POST',body:'fixture'})).status,403);
      assert.equal((await fetch(base+path,{method:'POST',headers:{authorization,origin:'http://untrusted'},body:'fixture'})).status,403);
      assert.equal((await fetch(base+path,{method:'POST',headers:{authorization,cookie:'session=bad'},body:'fixture'})).status,403);
      assert.equal((await fetch(base+path,{method:'POST',headers:{authorization},body:'fixture'})).status,200);
    }
    for(const path of ['/','/gql','/v0/connect/start?extra=1','/e/'+key])assert.equal((await fetch(base+path,{method:'POST',headers:{authorization},body:'fixture'})).status,404);
    assert.equal(requests,3);
    active=false;
    assert.equal((await fetch(base+'/v0/connect/start',{method:'POST',headers:{authorization},body:'fixture'})).status,403);
    assert.equal(requests,3,'inactive installation cannot reach Connect');
  }finally{transport.close();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}
});
