import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DashboardClient,miniAppRoute,miniAppServer,verifyLaunch,ed25519,TELEGRAM_KEYS} from '../src/mini-app.js';

const botId='5550001',ownerId='4242';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
/** Launch data signed the way Telegram signs it, with a synthetic key. */
function launch(fields:Record<string,string>,key=privateKey,bot=botId) {
  const data=bot+':WebAppData\n'+Object.entries(fields).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  return new URLSearchParams({...fields,hash:'0'.repeat(64),signature:sign(null,Buffer.from(data),key).toString('base64url')}).toString();
}
const now=1_800_000_000_000,fresh=String(now/1000-60),user=(id:string|number)=>JSON.stringify({id,first_name:'Owner'});
const check={botId,ownerId,key:publicKey,now};

test('only the owner\'s fresh, Telegram-signed launch data opens the mini app',()=>{
  assert.deepEqual(verifyLaunch(launch({auth_date:fresh,query_id:'q1',user:user(4242)}),check),{user_id:ownerId,auth_date:Number(fresh)});
  assert.throws(()=>verifyLaunch(launch({auth_date:fresh,user:user(777)}),check),{status:403,code:'owner_required'},'another Telegram account');
  assert.throws(()=>verifyLaunch(launch({auth_date:String(now/1000-2*86400),user:user(4242)}),check),{code:'telegram_launch_expired'});
  assert.throws(()=>verifyLaunch(launch({auth_date:fresh,user:user(4242)},generateKeyPairSync('ed25519').privateKey),check),{code:'telegram_launch_invalid'},'not signed by Telegram');
  assert.throws(()=>verifyLaunch(launch({auth_date:fresh,user:user(4242)},privateKey,'5550002'),check),{code:'telegram_launch_invalid'},'signed for another bot');
  const tampered=new URLSearchParams(launch({auth_date:fresh,user:user(777)}));tampered.set('user',user(4242));
  assert.throws(()=>verifyLaunch(tampered.toString(),check),{code:'telegram_launch_invalid'},'a changed user');
  assert.throws(()=>verifyLaunch(launch({auth_date:fresh,user:user(4242)})+'&user=1',check),{code:'telegram_launch_invalid'},'a repeated field');
  assert.throws(()=>verifyLaunch('',check),{status:401});
  assert.equal(ed25519(TELEGRAM_KEYS.production).asymmetricKeyType,'ed25519');
});

test('the mini app reaches only home, Inbox decisions and tasks with their chats and people',()=>{
  const id='a'.repeat(64);
  for(const [method,route] of [['GET','/status'],['GET','/tasks'],['POST','/tasks'],['POST','/tasks/'+id],['GET','/entities'],['GET','/decisions'],['GET','/decisions/telegram_action/'+id],
    ['POST','/tools/telegram-decision'],['POST','/memory-access/requests/'+id+'/decide'],['POST','/knowledge/proposals/'+id+'/undo']])
    assert.equal(miniAppRoute(method!,route!),true,method+' '+route);
  for(const [method,route] of [['POST','/settings'],['POST','/settings/apply'],['GET','/database-browser'],['POST','/shutdown'],['POST','/tools/revoke'],
    ['GET','/storage'],['POST','/memory/honcho/fresh-start'],['GET','/tasks/'+id+'/../../settings'],['POST','/ws-ticket'],['POST','/entities/'+id+'/merge']])
    assert.equal(miniAppRoute(method!,route!),false,method+' '+route);
});

test('the mini app server forwards checked owner calls to the local dashboard with its own session',async()=>{
  const calls:{path:string;host:string;cookie:string;csrf:string;body:string}[]=[];let sessions=0;
  const dashboard=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.url==='/'){sessions++;res.writeHead(200,{'set-cookie':'nocheh_session=s'+sessions+'; HttpOnly'});res.end('<script>window.__NOCHEH_CSRF__="c'+sessions+'";</script>');return;}
    if(req.url==='/api/nocheh/settings'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({fields:[{key:'TELEGRAM_OWNER_ID',value:'4242'},{key:'NOCHEH_REPLY_ROUTE_URL',value:'https://provider.example'}]}));return;}
    calls.push({path:req.url!,host:req.headers.host!,cookie:String(req.headers.cookie),csrf:String(req.headers['x-nocheh-csrf']),body});
    // The first call finds the session gone, as after a dashboard restart.
    if(calls.length===1){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"owner_session_required"}');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end('{"tasks":[]}');
  });
  await new Promise<void>(resolve=>dashboard.listen(0,'127.0.0.1',resolve));
  const assets=await mkdtemp(join(tmpdir(),'nocheh-mini-'));await writeFile(join(assets,'mini.html'),'<!doctype html><title>Nocheh</title>');
  const port=(dashboard.address() as {port:number}).port;
  const server=miniAppServer({check:{botId,ownerId,key:publicKey},now:()=>now,assets,dashboard:new DashboardClient({host:'127.0.0.1',port})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port,owner=launch({auth_date:fresh,user:user(4242)});
  try {
    const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'self' https:\/\/web\.telegram\.org/);
    const listed=await fetch(base+'/api/nocheh/tasks?state=open',{headers:{'x-telegram-init-data':owner}});
    assert.equal(listed.status,200);assert.deepEqual(await listed.json(),{tasks:[]});
    const added=await fetch(base+'/api/nocheh/tasks',{method:'POST',headers:{'x-telegram-init-data':owner,'content-type':'application/json'},body:'{"title":"Call the bank"}'});
    assert.equal(added.status,200);
    assert.deepEqual(calls.map(call=>[call.path,call.host,call.cookie,call.csrf]),[
      ['/api/nocheh/tasks?state=open','127.0.0.1:'+port,'nocheh_session=s1','c1'],
      ['/api/nocheh/tasks?state=open','127.0.0.1:'+port,'nocheh_session=s2','c2'],
      ['/api/nocheh/tasks','127.0.0.1:'+port,'nocheh_session=s2','c2']]);
    assert.equal(calls[2]!.body,'{"title":"Call the bank"}');
    // Of the settings, only the owner's own Telegram ID reaches the phone.
    assert.deepEqual(await (await fetch(base+'/api/nocheh/settings',{headers:{'x-telegram-init-data':owner}})).json(),{fields:[{key:'TELEGRAM_OWNER_ID',value:'4242'}]});
    const before=calls.length;
    assert.equal((await fetch(base+'/api/nocheh/tasks')).status,401,'no launch data');
    assert.equal((await fetch(base+'/api/nocheh/tasks',{headers:{'x-telegram-init-data':launch({auth_date:fresh,user:user(777)})}})).status,403);
    assert.equal((await fetch(base+'/api/nocheh/settings',{method:'POST',headers:{'x-telegram-init-data':owner},body:'{}'})).status,404);
    assert.equal((await fetch(base+'/api/nocheh/shutdown',{method:'POST',headers:{'x-telegram-init-data':owner}})).status,404);
    assert.equal((await fetch(base+'/hermes/')).status,404,'nothing else of the dashboard is served');
    assert.equal(calls.length,before,'refused calls never reach the dashboard');
  } finally {server.close();dashboard.close();await rm(assets,{recursive:true,force:true});}
});
