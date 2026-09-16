import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;};
const close=(server:Server)=>new Promise<void>(r=>server.close(()=>r()));
test('independent dashboard, legacy aliases and native HTTP/WebSocket boundary',{timeout:30000},async()=>{
  const state=await mkdtemp(join(tmpdir(),'nocheh-dashboard-boundary-')),secret='private-backend-token-'.repeat(3),monitorSecret='provider-monitor-admin-'.repeat(3);
  const native=createServer((req,res)=>{
    assert.equal(req.headers['x-hermes-session-token'],secret);
    assert.equal(req.headers['x-forwarded-prefix'],'/hermes');assert.equal(req.headers.cookie,undefined);
    if(req.url==='/nocheh'){
      res.writeHead(200,{'content-type':'text/html'});res.end(`<html><head><script>window.__HERMES_SESSION_TOKEN__="${secret}";</script></head><body>Native navigation</body></html>`);
    }else{res.writeHead(200,{'content-type':'application/json'});res.end('{"native":true}');}
  });
  let upgrades=0;
  native.on('upgrade',(req,socket)=>{
    assert.equal(new URL(req.url!,'http://local').searchParams.get('token'),secret);upgrades++;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data',data=>socket.write(data));socket.on('error',()=>{});
    socket.on('end',()=>socket.destroy());
  });
  const monitorRequests:string[]=[];
  const monitor=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+monitorSecret);assert.equal(req.headers.cookie,undefined);
    assert.equal(req.headers['x-nocheh-csrf'],undefined);monitorRequests.push(req.method+' '+req.url);
    if(req.url==='/management.html'){
      res.writeHead(200,{'content-type':'text/html'});res.end('<html><head></head><body>Provider monitoring</body></html>');
    }else{res.writeHead(200,{'content-type':'application/json'});res.end('{"monitor":true}');}
  });
  const nativePort=await listen(native),monitorPort=await listen(monitor),probe=createServer(),port=await listen(probe);await close(probe);
  await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),secret);
  await mkdir(join(state,'provider/keys'),{recursive:true});await writeFile(join(state,'provider/keys/monitor-admin.key'),monitorSecret);
  await writeFile(join(state,'.env'),`NOCHEH_CONFIG_VERSION=1\nSERVICE_TOKEN=${secret}\n`);
  const child=spawn(process.execPath,[resolve('dist/src/management.js')],{stdio:'ignore',env:{...process.env,NOCHEH_STATE_DIR:state,NOCHEH_DASHBOARD_PORT:String(port),NOCHEH_DASHBOARD_NATIVE_PORT:String(nativePort),NOCHEH_NATIVE_ADMIN_PORT:String(nativePort),NOCHEH_PROVIDER_MONITOR_PORT:String(monitorPort)}});
  const base=`http://127.0.0.1:${port}`;
  try{
    for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
    const page=await fetch(base),html=await page.text(),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
    const csrf=JSON.parse(html.match(/window\.__NOCHEH_CSRF__=("[^"]+")/)![1]!);
    assert.match(html,/Nocheh/);assert.ok(!html.includes(secret));assert.ok(!html.includes('__HERMES_PLUGIN_SDK__'));
    assert.equal((await fetch(base+'/assets/app.js')).status,200);
    const chunks=await readdir(resolve('web/dist/chunks'));
    assert.ok(chunks.some(name=>name.endsWith('.js')));
    for(const name of chunks.filter(name=>name.endsWith('.js')))assert.equal((await fetch(base+'/assets/chunks/'+name)).status,200);
    assert.equal((await fetch(base+'/assets/chunks/package.json')).status,404);
    assert.equal((await fetch(base+'/assets/chunks/%252e%252e/management.js')).status,404);
    const alias=await fetch(base+'/nocheh',{redirect:'manual'});assert.equal(alias.status,308);assert.equal(alias.headers.get('location'),'/');
    assert.equal((await fetch(base+'/api/nocheh/jobs',{method:'POST',headers:{cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/nocheh/health',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/plugins/nocheh/health',{headers:{'X-Hermes-Session-Token':secret}})).status,200);
    assert.equal((await fetch(base+'/providers/status')).status,401);
    const monitorHtml=await(await fetch(base+'/providers/management.html',{headers:{cookie}})).text();
    assert.match(monitorHtml,/Provider monitoring/);assert.ok(monitorHtml.includes(csrf));assert.ok(!monitorHtml.includes(monitorSecret));
    assert.deepEqual(await(await fetch(base+'/providers/status',{headers:{cookie}})).json(),{monitor:true});
    assert.equal((await fetch(base+'/providers/status',{method:'POST',headers:{cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/providers/status',{method:'POST',headers:{cookie,'X-Nocheh-CSRF':csrf,Origin:base},body:'{}'})).status,200);
    assert.deepEqual(monitorRequests,['GET /management.html','GET /status','POST /status']);
    assert.equal((await fetch(base+'/hermes/api/config')).status,401);
    const nativeHtml=await(await fetch(base+'/hermes/nocheh',{headers:{cookie}})).text();
    assert.match(nativeHtml,/Native navigation/);assert.ok(!nativeHtml.includes(secret));assert.ok(nativeHtml.includes(csrf));assert.match(nativeHtml,/__HERMES_AUTH_REQUIRED__=true/);
    assert.equal((await fetch(base+'/hermes/api/config',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/hermes/api/config',{method:'PUT',headers:{cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/hermes/api/config',{method:'PUT',headers:{cookie,'X-Hermes-Session-Token':csrf},body:'{}'})).status,200);
    const ticket=await(await fetch(base+'/hermes/api/auth/ws-ticket',{method:'POST',headers:{cookie,Origin:base}})).json() as {ticket:string};
    const socketRequest=async(value:string,origin=base)=>new Promise<number>((done,reject)=>{
      const request=httpRequest(base+'/hermes/api/pty?ticket='+value,{headers:{cookie,Origin:origin,Connection:'Upgrade',Upgrade:'websocket'}});
      request.on('upgrade',(response,socket)=>{socket.destroy();done(response.statusCode!);});request.on('response',response=>{response.resume();done(response.statusCode!);});request.on('error',reject);request.end();
    });
    assert.equal(await socketRequest(ticket.ticket,'https://untrusted.example'),403);assert.equal(upgrades,0);
    assert.equal(await socketRequest(ticket.ticket),101);assert.equal(upgrades,1);
    assert.equal(await socketRequest(ticket.ticket),403);assert.equal(upgrades,1);
    await close(native);
    await close(monitor);
    assert.equal((await fetch(base)).status,200,'Nocheh remains available without Hermes');
    assert.equal((await fetch(base+'/hermes/nocheh',{headers:{cookie}})).status,503);
    assert.equal((await fetch(base+'/providers/management.html',{headers:{cookie}})).status,503);
  }finally{
    const done=once(child,'exit');child.kill('SIGTERM');await done;
    if(monitor.listening)await close(monitor);
    if(native.listening)await close(native);await rm(state,{recursive:true,force:true});
  }
});
