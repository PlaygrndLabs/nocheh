import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;};
const close=(server:Server)=>new Promise<void>(r=>server.close(()=>r()));
test('independent dashboard, legacy aliases and native HTTP/WebSocket boundary',{timeout:30000},async()=>{
  const state=await mkdtemp(join(tmpdir(),'nocheh-dashboard-boundary-')),secret='private-backend-token-'.repeat(3),asked:string[]=[];
  // Hermes's dashboard takes its own session token (ADR-0295): never the agent login or the master key.
  const master='private-master-token-'.repeat(3),agentKey='private-agent-login-'.repeat(3),sent:string[]=[];
  const native=createServer((req,res)=>{
    asked.push(req.url!);sent.push(JSON.stringify(req.headers)+req.url);
    assert.equal(req.headers['x-hermes-session-token'],secret);
    assert.equal(req.headers['x-forwarded-prefix'],'/hermes');assert.equal(req.headers.cookie,undefined);
    if(req.url==='/nocheh'){
      res.writeHead(200,{'content-type':'text/html'});res.end(`<html><head><script>window.__HERMES_SESSION_TOKEN__="${secret}";</script></head><body>Native navigation</body></html>`);
    }else if(req.url==='/sessions'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end(`<html><head><SCRIPT type="module" crossorigin src="/hermes/assets/index-a1.js"></SCRIPT><script>window.__HERMES_SESSION_TOKEN__="${secret}";window.__HERMES_BASE_PATH__="/hermes";</script></head><body><div id="root"></div></body></html>`);
    }else if(req.url==='/api/preview'){
      // HTML from anywhere but Hermes's own pages, such as a file shown inline.
      res.writeHead(200,{'content-type':'text/html'});res.end(`<html><head><script>window.__HERMES_SESSION_TOKEN__="${secret}";</script></head><body>Shown file</body></html>`);
    }else{res.writeHead(200,{'content-type':'application/json'});res.end('{"native":true}');}
  });
  let upgrades=0;
  native.on('upgrade',(_req,socket)=>{upgrades++;socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.destroy();});
  const nativePort=await listen(native),probe=createServer(),port=await listen(probe);await close(probe);
  await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),secret);
  await writeFile(join(state,'.env'),`NOCHEH_CONFIG_VERSION=1\nSERVICE_TOKEN=${master}\nAGENT_KEY=${agentKey}\nNOCHEH_HERMES_SESSION_TOKEN=${secret}\n`);
  const child=spawn(process.execPath,[resolve('dist/src/management.js')],{stdio:'ignore',env:{...process.env,NOCHEH_STATE_DIR:state,NOCHEH_DASHBOARD_PORT:String(port),NOCHEH_DASHBOARD_NATIVE_PORT:String(nativePort),NOCHEH_NATIVE_ADMIN_PORT:String(nativePort)}});
  const base=`http://127.0.0.1:${port}`;
  try{
    for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
    assert.equal((await fetch(base+'/hermes/nocheh',{redirect:'manual'})).status,303,'signed out, native pages send the browser to sign in');
    const created=await fetch(base+'/api/nocheh/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"river-lamp-42"}'});
    const cookie=created.headers.get('set-cookie')!.split(';')[0]!;
    const page=await fetch(base,{headers:{cookie}}),html=await page.text();
    const csrf=JSON.parse(html.match(/window\.__NOCHEH_CSRF__=("[^"]+")/)![1]!);
    assert.match(html,/Nocheh/);assert.ok(!html.includes(secret));assert.ok(!html.includes('__HERMES_PLUGIN_SDK__'));
    assert.equal((await fetch(base+'/assets/app.js')).status,200);
    const chunks=await readdir(resolve('dashboard/dist/chunks'));
    assert.ok(chunks.some(name=>name.endsWith('.js')));
    for(const name of chunks.filter(name=>name.endsWith('.js')))assert.equal((await fetch(base+'/assets/chunks/'+name)).status,200);
    assert.equal((await fetch(base+'/assets/chunks/package.json')).status,404);
    assert.equal((await fetch(base+'/assets/chunks/%252e%252e/management.js')).status,404);
    const alias=await fetch(base+'/nocheh',{redirect:'manual'});assert.equal(alias.status,308);assert.equal(alias.headers.get('location'),'/');
    assert.equal((await fetch(base+'/api/nocheh/jobs',{method:'POST',headers:{cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/nocheh/health',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/plugins/nocheh/health',{headers:{'X-Hermes-Session-Token':secret}})).status,200);
    // No provider admin panel is served or proxied.
    for(const path of ['/providers','/providers/management.html','/providers/status'])assert.equal((await fetch(base+path,{headers:{cookie},redirect:'manual'})).status,404);
    assert.equal((await fetch(base+'/hermes/api/config')).status,401);
    const nativeHtml=await(await fetch(base+'/hermes/nocheh',{headers:{cookie}})).text();
    assert.match(nativeHtml,/Native navigation/);assert.ok(!nativeHtml.includes(secret));assert.ok(nativeHtml.includes(csrf));assert.match(nativeHtml,/__HERMES_AUTH_REQUIRED__=true/);
    assert.equal((await fetch(base+'/hermes/api/config',{headers:{cookie}})).status,200);
    // The dashboard chat page is off until Nocheh has its own chat page; Telegram only. Signed in or not, the dashboard
    // answers with its own page, which runs no script and links back, and Hermes is never asked.
    for(const [path,headers] of [['/hermes/chat',{cookie}],['/hermes/chat/',{cookie}],['/hermes/chat/s1?resume=1',{cookie}],['/hermes/chat',{}]] as const) {
      const off=await fetch(base+path,{headers,redirect:'manual'}),body=await off.text();
      assert.equal(off.status,404,path);assert.equal(off.headers.get('content-type'),'text/html; charset=utf-8');
      assert.match(off.headers.get('content-security-policy')??'',/^default-src 'none';/);
      assert.match(body,/Talk to Nocheh in Telegram/);assert.ok(body.includes('<a href="/">')&&!/<script/i.test(body)&&!body.includes(csrf),body);
    }
    assert.ok(!asked.some(url=>url.startsWith('/chat')),asked.join());
    // Hermes's own pages carry the reported script rules with a new nonce each time, on every script (ADR-0251).
    const nonces:string[]=[];
    for(let open=0;open<2;open++){
      const sessions=await fetch(base+'/hermes/sessions',{headers:{cookie}}),body=await sessions.text();
      const policy=sessions.headers.get('content-security-policy-report-only')??'';
      const nonce=/^script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri \/api\/nocheh\/csp-report$/.exec(policy)?.[1];
      assert.ok(nonce,policy);nonces.push(nonce);
      assert.equal(sessions.headers.get('content-security-policy'),null,'only reported for now');
      assert.equal(body.match(/<script\b/gi)?.length,3);assert.equal(body.split(`<script nonce="${nonce}"`).length+body.split(`<SCRIPT nonce="${nonce}"`).length-2,3,body);
      assert.ok(body.includes(`window.__HERMES_SESSION_TOKEN__=${JSON.stringify(csrf)};`)&&!body.includes(secret));
      assert.match(body,new RegExp(`<script nonce="${nonce.replace(/[+/]/g,'\\$&')}">window.__HERMES_AUTH_REQUIRED__=true;</script></head>`));
    }
    assert.notEqual(nonces[0],nonces[1]);
    // Any other HTML from Hermes runs no script, and gets neither Hermes's token nor the dashboard's value.
    const other=await fetch(base+'/hermes/api/preview',{headers:{cookie}}),otherBody=await other.text();
    assert.equal(other.headers.get('content-security-policy'),"script-src 'none'; sandbox");
    assert.equal(other.headers.get('content-security-policy-report-only'),null);
    assert.ok(!otherBody.includes(secret)&&!otherBody.includes(csrf)&&!otherBody.includes('nonce=')&&!otherBody.includes('__HERMES_AUTH_REQUIRED__'),otherBody);
    assert.match(otherBody,/window\.__HERMES_SESSION_TOKEN__="";/);
    // The browser's reports come without a session and are only counted: rule, blocked site and page path, no page text.
    const report=(body:string,headers:Record<string,string>={})=>fetch(base+'/api/nocheh/csp-report',{method:'POST',headers:{'Content-Type':'application/csp-report',...headers},body});
    const sample={'csp-report':{'document-uri':base+'/hermes/sessions?ticket=private-ticket','effective-directive':'script-src-elem','blocked-uri':'inline','script-sample':'window.privateText=1'}};
    assert.equal((await report(JSON.stringify(sample))).status,204);
    assert.equal((await report(JSON.stringify(sample),{Origin:'null','Sec-Fetch-Site':'same-origin'})).status,204,'a no-referrer page may send Origin null');
    assert.equal((await report(JSON.stringify({...sample,padding:'x'.repeat(9*1024)}))).status,413);
    assert.equal((await report(JSON.stringify(sample),{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await report(JSON.stringify(sample),{Origin:'null','Sec-Fetch-Site':'cross-site'})).status,403,'never from another site');
    assert.equal((await fetch(base+'/api/nocheh/jobs',{method:'POST',headers:{cookie,Origin:'null'},body:'{}'})).status,403,'Origin null is only for reports');
    const saved=join(state,'admin/dashboard/csp-reports.json');
    let counted='';for(let i=0;i<100&&!counted;i++){counted=await readFile(saved,'utf8').catch(()=>'');if(!counted)await new Promise(r=>setTimeout(r,50));}
    const reports=JSON.parse(counted);
    assert.equal(reports.total,2);
    assert.deepEqual(reports.kinds.map(({directive,blocked,page,count}:any)=>({directive,blocked,page,count})),[{directive:'script-src-elem',blocked:'inline',page:'/hermes/sessions',count:2}]);
    assert.ok(!counted.includes('privateText')&&!counted.includes('private-ticket'));
    assert.equal((await fetch(base+'/hermes/api/config',{method:'PUT',headers:{cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/hermes/api/config',{method:'PUT',headers:{cookie,'X-Hermes-Session-Token':csrf},body:'{}'})).status,200);
    // With the chat page off, the dashboard hands out no socket ticket and takes no live connection to Hermes.
    assert.equal((await fetch(base+'/api/nocheh/ws-ticket',{method:'POST',headers:{cookie,'X-Nocheh-CSRF':csrf}})).status,404);
    const ticket=await fetch(base+'/hermes/api/auth/ws-ticket',{method:'POST',headers:{cookie,Origin:base,'X-Hermes-Session-Token':csrf}});
    assert.ok(!('ticket' in (await ticket.json() as object)),'only Hermes answers it now');
    const socketRequest=async(path:string)=>new Promise<number>((done,reject)=>{
      const request=httpRequest(base+path,{headers:{cookie,Origin:base,Connection:'Upgrade',Upgrade:'websocket'}});
      request.on('upgrade',(response,socket)=>{socket.destroy();done(response.statusCode!);});request.on('response',response=>{response.resume();done(response.statusCode!);});request.on('error',reject);request.end();
    });
    for(const path of ['/hermes/api/pty?ticket=x','/hermes/api/ws','/hermes/api/events','/hermes/api/pub','/'])assert.equal(await socketRequest(path),403,path);
    assert.equal(upgrades,0);
    assert.ok(sent.length&&!sent.some(line=>line.includes(master)||line.includes(agentKey)),'Hermes gets the session token only');
    await close(native);
    assert.equal((await fetch(base)).status,200,'Nocheh remains available without Hermes');
    assert.equal((await fetch(base+'/hermes/nocheh',{headers:{cookie}})).status,503);
  }finally{
    const done=once(child,'exit');child.kill('SIGTERM');await done;
    if(native.listening)await close(native);await rm(state,{recursive:true,force:true});
  }
});
