import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DashboardClient,miniAppRoute,miniAppServer,verifyLaunch,ed25519,TELEGRAM_KEYS} from '../src/mini-app.js';
import {OwnerLock,FREE_TRIES,SESSION_IDLE} from '../src/owner-lock.js';
import {OwnerSessions,csrfFor} from '../src/dashboard-auth.js';

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

test('the mini app reaches only home, Inbox decisions, tasks with their chats and people, and problems',()=>{
  const id='a'.repeat(64);
  for(const [method,route] of [['GET','/status'],['GET','/tasks'],['POST','/tasks'],['POST','/tasks/'+id],['GET','/entities'],['GET','/decisions'],['GET','/decisions/telegram_action/'+id],
    ['POST','/tools/telegram-decision'],['POST','/memory-access/requests/'+id+'/decide'],['POST','/knowledge/proposals/'+id+'/undo'],
    ['GET','/monitoring'],['POST','/workflows/retry-failed']])
    assert.equal(miniAppRoute(method!,route!),true,method+' '+route);
  for(const [method,route] of [['POST','/settings'],['POST','/settings/apply'],['GET','/database-browser'],['POST','/shutdown'],['POST','/tools/revoke'],
    ['GET','/storage'],['POST','/memory/honcho/fresh-start'],['GET','/tasks/'+id+'/../../settings'],['POST','/ws-ticket'],['POST','/entities/'+id+'/merge'],
    ['POST','/workflows/'+id+'/cancel'],['GET','/workflows'],['POST','/monitoring']])
    assert.equal(miniAppRoute(method!,route!),false,method+' '+route);
});

test('the owner password is kept hashed, pauses after wrong tries and signs every other session out when changed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nocheh-lock-'));let clock=now;
  const path=join(directory,'admin/owner-lock.json'),lock=new OwnerLock(path,()=>clock);
  try {
    assert.equal(await lock.check('x'.repeat(43),'phone'),'no_password','no password means locked, not open');
    await assert.rejects(lock.signIn('anything','browser'),{status:409,code:'owner_password_not_set'});
    await assert.rejects(lock.create('short'),{status:400,code:'password_too_short'});
    const browser=await lock.create('river-lamp-42');
    await assert.rejects(lock.create('taken-over-99'),{status:409,code:'owner_password_already_set'},'only the first visit creates it');
    assert.equal(await lock.check(browser.token,'browser'),'signed_in');
    assert.equal(await lock.check(browser.token,'phone'),'signed_out','a browser session is not a phone session');
    const phone=await lock.signIn('river-lamp-42','phone');
    assert.equal(await lock.check(phone.token,'phone'),'signed_in');
    assert.equal(await lock.check('y'.repeat(43),'phone'),'signed_out');
    for(let miss=1;miss<FREE_TRIES;miss++)await assert.rejects(lock.signIn('wrong','phone'),{status:401,code:'wrong_password',tries_left:FREE_TRIES-miss});
    await assert.rejects(lock.signIn('wrong','browser'),{status:429,code:'sign_in_paused',until:clock+15*60*1000},'one counter for browsers and phones');
    await assert.rejects(lock.signIn('river-lamp-42','browser'),{status:429},'the right password waits for the pause too');
    clock+=15*60*1000+1;
    await assert.rejects(lock.signIn('wrong','phone'),{status:429,until:clock+30*60*1000},'each further miss doubles the pause');
    clock+=30*60*1000+1;
    const second=await lock.signIn('river-lamp-42','phone');
    assert.deepEqual((await lock.status(browser.token)).sessions.map(s=>[s.kind,s.current]).sort(),[['browser',true],['phone',false],['phone',false]]);
    const saved=await readFile(path,'utf8');
    assert.ok(![ 'river-lamp-42',browser.token,phone.token,second.token].some(secret=>saved.includes(secret)),'only hashes are stored');
    assert.equal((await stat(path)).mode&0o777,0o600);
    clock+=SESSION_IDLE-1000;assert.equal(await lock.check(second.token,'phone'),'signed_in','used within 30 days');
    clock+=SESSION_IDLE-1000;assert.equal(await lock.check(second.token,'phone'),'signed_in','using it keeps it signed in');
    assert.equal(await lock.check(phone.token,'phone'),'signed_out','an unused phone is signed out after 30 days');
    await assert.rejects(lock.changePassword('wrong','harbor-kite-17'),{status:401,code:'wrong_password'},'a change needs the current password');
    const changed=await lock.changePassword('river-lamp-42','harbor-kite-17');
    assert.equal(await lock.check(second.token,'phone'),'signed_out','a new password signs every other session out');
    assert.equal(await lock.check(changed.token,'browser'),'signed_in','the browser that changed it stays signed in');
    const third=await lock.signIn('harbor-kite-17','phone');
    await lock.signOutOthers(changed.token);
    assert.equal(await lock.check(third.token,'phone'),'signed_out');
    assert.equal(await lock.check(changed.token,'browser'),'signed_in');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('a browser is signed in only by its own cookie, with a CSRF value derived from it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nocheh-lock-'));
  const lock=new OwnerLock(join(directory,'lock.json'),()=>now),sessions=new OwnerSessions(lock,()=>now);
  try {
    assert.equal(await sessions.state(undefined,'browser'),'no_password');
    const {token}=await lock.create('river-lamp-42'),cookie='nocheh_session='+token;
    const req={method:'POST',headers:{cookie,'x-nocheh-csrf':csrfFor(token)}};
    assert.equal((await sessions.authorize(req)).token,token);
    await assert.rejects(sessions.authorize({...req,headers:{cookie}}),{code:'csrf_required'});
    await assert.rejects(sessions.authorize({...req,headers:{...req.headers,cookie:cookie+'; '+cookie}}),{code:'owner_session_required'},'two session cookies are refused');
    await assert.rejects(sessions.authorize({...req,headers:{cookie:'nocheh_session='+'z'.repeat(43),'x-nocheh-csrf':csrfFor('z'.repeat(43))}}),{code:'owner_session_required'});
    const ticket=sessions.ticket(await sessions.authorize(req));
    await sessions.consume(req,ticket);
    await assert.rejects(sessions.consume(req,ticket),{code:'websocket_ticket_invalid'},'a ticket works once');
    // A restarted dashboard reads the same lock: the browser stays signed in.
    assert.equal((await new OwnerSessions(new OwnerLock(join(directory,'lock.json'),()=>now),()=>now).authorize(req)).token,token);
    await lock.signOut(token);sessions.forget();
    await assert.rejects(sessions.authorize(req),{code:'owner_session_required'},'signed out at once');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('the mini app server forwards checked owner calls to the local dashboard with the phone\'s session',async()=>{
  const calls:{path:string;host:string;session:string;cookie:string;body:string}[]=[],lockCalls:string[]=[];
  const directory=await mkdtemp(join(tmpdir(),'nocheh-lock-')),lock=new OwnerLock(join(directory,'lock.json'),()=>now);
  await lock.create('river-lamp-42');
  // Stands in for the dashboard's phone routes and its session check on forwarded calls.
  const dashboard=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    const phone=req.url?.match(/^\/api\/nocheh\/mini-app\/(sign-in|check|sign-out)$/)?.[1];
    if(phone){
      lockCalls.push(phone);const value=JSON.parse(body);
      if(phone==='check')return reply(200,{state:await lock.check(value.token,'phone')});
      if(phone==='sign-out'){await lock.signOut(value.token);return reply(200,{ok:true});}
      try{return reply(200,await lock.signIn(value.password,'phone'));}catch(error:any){return reply(error.status,{error:error.code,tries_left:error.tries_left});}
    }
    if(await lock.check(req.headers['x-nocheh-mini-session'],'phone')!=='signed_in')return reply(401,{error:'mini_app_sign_in_required'});
    if(req.url==='/api/nocheh/settings')return reply(200,{fields:[{key:'TELEGRAM_OWNER_ID',value:'4242'},{key:'NOCHEH_REPLY_ROUTE_URL',value:'https://provider.example'}]});
    calls.push({path:req.url!,host:req.headers.host!,session:String(req.headers['x-nocheh-mini-session']),cookie:String(req.headers.cookie),body});
    reply(200,{tasks:[]});
  });
  await new Promise<void>(resolve=>dashboard.listen(0,'127.0.0.1',resolve));
  const assets=await mkdtemp(join(tmpdir(),'nocheh-mini-'));await writeFile(join(assets,'mini.html'),'<!doctype html><title>Nocheh</title>');
  const port=(dashboard.address() as {port:number}).port;
  const server=miniAppServer({check:{botId,ownerId,key:publicKey},now:()=>now,assets,dashboard:new DashboardClient({host:'127.0.0.1',port})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port,owner=launch({auth_date:fresh,user:user(4242)});
  const signIn=(password:string,init=owner)=>fetch(base+'/api/mini/sign-in',{method:'POST',headers:{'x-telegram-init-data':init,'content-type':'application/json'},body:JSON.stringify({password})});
  try {
    const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'self' https:\/\/web\.telegram\.org/);
    // Without a password sign-in, launch data alone reaches nothing.
    const locked=await fetch(base+'/api/nocheh/tasks',{headers:{'x-telegram-init-data':owner}});
    assert.equal(locked.status,401);assert.deepEqual(await locked.json(),{error:'mini_app_sign_in_required'});
    assert.deepEqual(await (await fetch(base+'/api/mini/session',{headers:{'x-telegram-init-data':owner}})).json(),{state:'signed_out'});
    assert.equal((await signIn('river-lamp-42',launch({auth_date:fresh,user:user(777)}))).status,403,'another account never gets to try a password');
    const wrong=await signIn('guess');
    assert.equal(wrong.status,401);assert.deepEqual(await wrong.json(),{error:'wrong_password',tries_left:FREE_TRIES-1});
    assert.equal(lockCalls.filter(call=>call==='sign-in').length,1,'a wrong password is sent once, never retried');
    const signedIn=await signIn('river-lamp-42');assert.equal(signedIn.status,200);
    const {token}=await signedIn.json() as {token:string};
    const headers={'x-telegram-init-data':owner,'x-nocheh-mini-session':token};
    assert.deepEqual(await (await fetch(base+'/api/mini/session',{headers})).json(),{state:'signed_in'});
    assert.equal((await fetch(base+'/api/nocheh/tasks',{headers:{'x-nocheh-mini-session':token}})).status,401,'a session still needs the owner\'s launch data');
    const listed=await fetch(base+'/api/nocheh/tasks?state=open',{headers});
    assert.equal(listed.status,200);assert.deepEqual(await listed.json(),{tasks:[]});
    const added=await fetch(base+'/api/nocheh/tasks',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"title":"Call the bank"}'});
    assert.equal(added.status,200);
    assert.deepEqual(calls.map(call=>[call.path,call.host,call.session,call.cookie]),[
      ['/api/nocheh/tasks?state=open','127.0.0.1:'+port,token,'undefined'],
      ['/api/nocheh/tasks','127.0.0.1:'+port,token,'undefined']],'the phone\'s own session, and no dashboard cookie');
    assert.equal(calls[1]!.body,'{"title":"Call the bank"}');
    // Of the settings, only the owner's own Telegram ID reaches the phone.
    assert.deepEqual(await (await fetch(base+'/api/nocheh/settings',{headers})).json(),{fields:[{key:'TELEGRAM_OWNER_ID',value:'4242'}]});
    const before=calls.length;
    assert.equal((await fetch(base+'/api/nocheh/tasks')).status,401,'no launch data');
    assert.equal((await fetch(base+'/api/nocheh/tasks',{headers:{'x-telegram-init-data':launch({auth_date:fresh,user:user(777)})}})).status,403);
    assert.equal((await fetch(base+'/api/nocheh/settings',{method:'POST',headers:{'x-telegram-init-data':owner},body:'{}'})).status,404);
    assert.equal((await fetch(base+'/api/nocheh/shutdown',{method:'POST',headers:{'x-telegram-init-data':owner}})).status,404);
    assert.equal((await fetch(base+'/hermes/')).status,404,'nothing else of the dashboard is served');
    for(const route of ['/owner-lock','/owner-lock/password','/owner-lock/sign-out-others','/login','/mini-app/sign-in'])
      assert.equal((await fetch(base+'/api/nocheh'+route,route==='/owner-lock'?{headers}:{method:'POST',headers,body:'{"password":"taken-over-99"}'})).status,404,'the password is changed only from the dashboard');
    assert.equal(calls.length,before,'refused calls never reach the dashboard');
    assert.equal((await fetch(base+'/api/mini/sign-out',{method:'POST',headers})).status,200);
    assert.equal((await fetch(base+'/api/nocheh/tasks',{headers})).status,401,'signed out at once on this phone');
  } finally {server.close();dashboard.close();await rm(assets,{recursive:true,force:true});await rm(directory,{recursive:true,force:true});}
});
