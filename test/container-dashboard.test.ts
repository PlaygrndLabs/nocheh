import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

// Run in a disposable container with the three Compose names mapped to loopback.
test('container dashboard reaches internal services and survives application outage',
  {skip:process.env.NOCHEH_CONTAINER_TEST!=='1',timeout:30000},async()=>{
  const state=await mkdtemp(join(tmpdir(),'nocheh-container-dashboard-'));
  const token='synthetic-owner-token-'.repeat(3),monitorKey='synthetic-monitor-key-'.repeat(3);
  const app=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);
    res.setHeader('content-type','application/json');res.end('{"service":"fixture-app"}');
  });
  const native=createServer((req,res)=>{
    assert.equal(req.headers['x-hermes-session-token'],token);
    assert.equal(req.headers.host,'127.0.0.1:8785');
    res.setHeader('content-type','application/json');res.end('{"service":"fixture-hermes"}');
  });
  const monitor=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+monitorKey);
    assert.equal(req.headers.cookie,undefined);
    res.setHeader('content-type','application/json');res.end('{"service":"fixture-monitor"}');
  });
  const close=(server:Server)=>new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const [server,port] of [[app,8780],[native,8785],[monitor,18317]] as const){server.listen(port,'0.0.0.0');await once(server,'listening');}
  await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),token);
  await mkdir(join(state,'provider/keys'),{recursive:true});await writeFile(join(state,'provider/keys/monitor-admin.key'),monitorKey);
  await writeFile(join(state,'.env'),`NOCHEH_CONFIG_VERSION=1\nNOCHEH_PORT=19980\nSERVICE_TOKEN=${token}\n`);
  const child=spawn(process.execPath,[resolve('dist/src/management.js')],{stdio:'ignore',env:{...process.env,NOCHEH_CONTAINER:'1',NOCHEH_STATE_DIR:state,NOCHEH_DASHBOARD_PORT:'19883'}});
  const base='http://127.0.0.1:19883';
  try{
    for(let i=0;i<150;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const page=await fetch(base);assert.equal(page.status,200);
    const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
    const read=(path:string)=>fetch(base+path,{headers:{cookie}});
    assert.equal((await(await read('/api/nocheh/status')).json() as any).service,'fixture-app');
    assert.equal((await(await read('/hermes/api/config')).json() as any).service,'fixture-hermes');
    assert.equal((await(await read('/providers/status')).json() as any).service,'fixture-monitor');
    assert.equal((await fetch(base+'/api/nocheh/status')).status,401);
    const denied=await new Promise<number|undefined>((resolve,reject)=>{
      const req=httpRequest(base,{headers:{host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);req.end();
    });
    assert.equal(denied,403);
    await close(app);
    assert.equal((await read('/api/nocheh/status')).status,400);
    assert.equal((await fetch(base)).status,200);
    assert.equal((await read('/api/nocheh/health')).status,200);
  }finally{
    child.kill('SIGTERM');await once(child,'exit');
    await Promise.all([close(app),close(native),close(monitor)]);await rm(state,{recursive:true,force:true});
  }
});
