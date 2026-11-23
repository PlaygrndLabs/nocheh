import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer,type IncomingHttpHeaders,type Server} from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppClient,DashboardClient,appTarget,miniAppServer} from '../src/mini-app.js';
import {MEMBER_APP_BODY_MAX,MEMBER_APP_ROUTES,MEMBER_APP_WRITES_PER_10_MIN} from '../src/member-app-wire.js';
import {FIXTURE_KEY_REFUSED,MEMBER_LAUNCH_MAX_AGE,OWNER_LAUNCH_MAX_AGE,verifyLaunch,verifyLaunchUser} from '../src/telegram-launch.js';
import {memberAppServer,remindersState,type MemberAppServices} from '../src/stores/member-app.js';
import {forgetMemberAppRechecks} from '../src/stores/member-reads.js';
import {storageServer} from '../src/stores/server.js';
import {memberChangeRequest} from '../src/stores/member-api.js';
import {accountIdFor} from '../src/chats.js';

// The members' app's server side (step 5, ADR-0265 D1-D4, D11, D13): the edge's member branch in nocheh-miniapp, and
// nocheh-app's two listeners. The store-backed checks (who is a member now, groups, sign-out, limits) are in
// test/store-member-app-server.test.ts.

const botId='5550001',ownerId='4242',member='701';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
/** Launch data signed the way Telegram signs it, with a synthetic key (as test/mini-app.test.ts does). */
function launch(fields:Record<string,string>,key=privateKey,bot=botId) {
  const data=bot+':WebAppData\n'+Object.entries(fields).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  return new URLSearchParams({...fields,hash:'0'.repeat(64),signature:sign(null,Buffer.from(data),key).toString('base64url')}).toString();
}
const user=(id:string|number,name='Mira')=>JSON.stringify({id,first_name:name,language_code:'fa'});
const seconds=()=>Math.floor(Date.now()/1000);
const memberLaunch=(extra:Record<string,string>={},id:string=member)=>launch({auth_date:String(seconds()-30),query_id:'q1',user:user(id),...extra});
const listen=async(server:Server)=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+(server.address() as {port:number}).port;};
/** Everything written to the console while `run` runs. */
async function console_(run:()=>Promise<void>):Promise<string> {
  const lines:string[]=[],saved={log:console.log,warn:console.warn,error:console.error,info:console.info};
  for(const key of Object.keys(saved) as (keyof typeof saved)[])console[key]=(...args:unknown[])=>{lines.push(args.map(String).join(' '));};
  try{await run();}finally{Object.assign(console,saved);}
  return lines.join('\n');
}

test('a member launch lasts an hour and the owner\'s a day; a launch from a group is never a member\'s',()=>{
  const key=publicKey,now=Date.now(),old=String(Math.floor(now/1000)-2*3600);
  assert.equal(MEMBER_LAUNCH_MAX_AGE,3600);assert.equal(OWNER_LAUNCH_MAX_AGE,86400);
  assert.equal(verifyLaunchUser(memberLaunch(),{botId,key,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE}).user_id,member,'any Telegram user');
  assert.throws(()=>verifyLaunchUser(launch({auth_date:old,user:user(member)}),{botId,key,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE,now}),{status:401});
  assert.equal(verifyLaunch(launch({auth_date:old,user:user(ownerId)}),{botId,ownerId,key,now}).user_id,ownerId,'two hours is fine for the owner');
  for(const chat of ['group','supergroup','channel','private'])
    assert.throws(()=>verifyLaunchUser(memberLaunch({chat_type:chat}),{botId,key,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE}),{status:401},chat);
});

test('nocheh-app and nocheh-miniapp refuse to start with a fixture launch key outside the installation fixture',()=>{
  const run=(file:string,env:Record<string,string>)=>spawnSync(process.execPath,[file],{env:{PATH:process.env.PATH??'',...env},encoding:'utf8',timeout:60000});
  const key='a'.repeat(64);
  for(const env of [{TELEGRAM_LAUNCH_PUBLIC_KEY:key,TELEGRAM_BOT_ID:'123456'},{TELEGRAM_LAUNCH_PUBLIC_KEY:key,TELEGRAM_BOT_ID:botId,NOCHEH_INSTALLATION_FIXTURE:'1'}]) {
    const app=run('dist/src/stores/main.js',env);
    assert.notEqual(app.status,0);assert.match(app.stderr,new RegExp(FIXTURE_KEY_REFUSED),'nocheh-app');
    const mini=run('dist/src/mini-app.js',{...env,TELEGRAM_OWNER_ID:ownerId});
    assert.notEqual(mini.status,0);assert.match(mini.stderr,new RegExp(FIXTURE_KEY_REFUSED),'nocheh-miniapp');
  }
});

test('nocheh-miniapp serves the member page with Trusted Types and forwards only the members\' routes, with no session, to nocheh-app',async()=>{
  const forwarded:{method:string;url:string;headers:IncomingHttpHeaders;body:string}[]=[];let dashboardCalls=0;
  const app=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    forwarded.push({method:req.method!,url:req.url!,headers:req.headers,body});
    res.writeHead(200,{'content-type':'text/plain','set-cookie':'session=leak','cache-control':'max-age=600'});res.end('{"ok":true}');
  });
  const dashboard=createServer((req,res)=>{dashboardCalls++;res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"mini_app_sign_in_required"}');});
  const appBase=await listen(app),dashboardBase=await listen(dashboard);
  const assets=await mkdtemp(join(tmpdir(),'nocheh-member-'));
  await writeFile(join(assets,'mini.html'),'<!doctype html><title>Owner</title>');await writeFile(join(assets,'member.html'),'<!doctype html><title>Members</title>');
  await writeFile(join(assets,'member.js'),'void 0;');
  const server=miniAppServer({check:{botId,ownerId,key:publicKey},assets,dashboard:new DashboardClient({host:'127.0.0.1',port:Number(new URL(dashboardBase).port)}),
    app:new AppClient(appTarget(appBase)!)});
  const base=await listen(server);
  const init=memberLaunch(),call=(path:string,init_:RequestInit={})=>fetch(base+path,init_);
  try {
    const logged=await console_(async()=>{
      // The page: /m/ and its script carry Trusted Types; the owner's page keeps its own policy.
      for(const path of ['/m/','/m/index.html','/assets/member.js']) {
        const page=await call(path);assert.equal(page.status,200,path);
        assert.match(page.headers.get('content-security-policy')??'',/require-trusted-types-for 'script'/,path);
        assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'self' https:\/\/web\.telegram\.org/,path);
      }
      assert.match(await (await call('/m/')).text(),/Members/);
      assert.doesNotMatch((await call('/')).headers.get('content-security-policy')??'',/trusted-types/);
      assert.equal((await call('/m')).status,404);assert.equal((await call('/m/member.html')).status,404);

      // A member call goes to nocheh-app's member listener with the launch data alone: the page's phone session, cookie
      // and any bearer it sent stay behind, and the answer comes back as JSON that is never stored.
      const task='b'.repeat(64);
      const me=await call('/api/member/me',{headers:{'x-telegram-init-data':init,'x-nocheh-mini-session':'phone-token','cookie':'a=b','authorization':'Bearer x'}});
      assert.equal(me.status,200);assert.deepEqual(await me.json(),{ok:true});
      assert.equal(me.headers.get('cache-control'),'no-store');assert.match(me.headers.get('content-type')??'',/application\/json/);
      assert.equal(me.headers.get('set-cookie'),null,'no header of nocheh-app\'s comes through');
      await call('/api/member/tasks?project='+'c'.repeat(64)+'&state=open',{headers:{'x-telegram-init-data':init}});
      await call('/api/member/tasks/'+task,{method:'POST',headers:{'x-telegram-init-data':init,'content-type':'application/json'},body:'{"operation_id":"o1"}'});
      await call('/api/member/sign-out',{method:'POST',headers:{'x-telegram-init-data':init}});
      assert.deepEqual(forwarded.map(item=>[item.method,item.url,item.body]),[['GET','/v1/member-app/me',''],
        ['GET','/v1/member-app/tasks?project='+'c'.repeat(64)+'&state=open',''],['POST','/v1/member-app/tasks/'+task,'{"operation_id":"o1"}'],['POST','/v1/member-app/sign-out','']]);
      for(const item of forwarded) {
        assert.equal(item.headers['x-telegram-init-data'],init);
        for(const header of ['x-nocheh-mini-session','cookie','authorization'])assert.equal(item.headers[header],undefined,header);
      }
      assert.equal(dashboardCalls,0,'never the dashboard');
      const before=forwarded.length;

      // Refused before anything is forwarded.
      const refused=async(path:string,init_:RequestInit,status:number,error?:string)=>{
        const answer=await call(path,init_);assert.equal(answer.status,status,path);
        if(error)assert.deepEqual(await answer.json(),{error},path);
      };
      for(const path of ['/api/member/settings','/api/member/decisions','/api/member/tasks/'+task+'/audience','/api/member/tasks/'+task+'/delete','/api/member/me?x=1',
        '/api/member/tasks?'+'x'.repeat(600),'/api/member/','/api/member/me/'])
        await refused(path,{headers:{'x-telegram-init-data':init}},404);
      await refused('/api/member/me',{method:'POST',headers:{'x-telegram-init-data':init}},404);
      await refused('/api/member/me',{},401,'member_app_launch_invalid');
      await refused('/api/member/me',{headers:{'x-telegram-init-data':launch({auth_date:String(seconds()-MEMBER_LAUNCH_MAX_AGE-120),user:user(member)})}},401,'member_app_launch_invalid');
      await refused('/api/member/me',{headers:{'x-telegram-init-data':memberLaunch({chat_type:'group'})}},401,'member_app_launch_invalid');
      await refused('/api/member/me',{headers:{'x-telegram-init-data':launch({auth_date:String(seconds()),user:user(member)},generateKeyPairSync('ed25519').privateKey)}},401,'member_app_launch_invalid');
      // The owner has their own page; their launch opens nothing here.
      await refused('/api/member/me',{headers:{'x-telegram-init-data':memberLaunch({},ownerId)}},403,'member_required');
      await refused('/api/member/me',{headers:{'x-telegram-init-data':init,origin:'https://elsewhere.example','sec-fetch-site':'cross-site'}},403,'cross_site_denied');
      await refused('/api/member/tasks',{method:'POST',headers:{'x-telegram-init-data':init,'content-type':'application/json'},body:'x'.repeat(MEMBER_APP_BODY_MAX+1)},413);
      assert.equal(forwarded.length,before,'nothing refused reaches nocheh-app');
      // A member stays refused on every owner route, as before (test/mini-app.test.ts).
      await refused('/api/nocheh/tasks',{headers:{'x-telegram-init-data':init,'x-nocheh-mini-session':'phone-token'}},403,'owner_required');
      await refused('/api/mini/session',{headers:{'x-telegram-init-data':init}},403,'owner_required');
      assert.equal(dashboardCalls,0);
    });
    assert.ok(!logged.includes(init)&&!logged.includes('signature'),'the launch data is never logged');

    // Without the members' listener's address the member routes answer 503 and nothing else changes.
    const alone=miniAppServer({check:{botId,ownerId,key:publicKey},assets,dashboard:new DashboardClient({host:'127.0.0.1',port:1})});
    const aloneBase=await listen(alone);
    try{assert.equal((await fetch(aloneBase+'/api/member/me',{headers:{'x-telegram-init-data':init}})).status,503);}finally{alone.close();}
    assert.deepEqual([appTarget('http://nocheh-app:8790'),appTarget('https://nocheh-app:8790'),appTarget('http://u:p@nocheh-app:8790'),appTarget('http://nocheh-app:8790/x'),appTarget('')],
      [{host:'nocheh-app',port:8790},null,null,null,null]);
  } finally {server.close();app.close();dashboard.close();await rm(assets,{recursive:true,force:true});}
});

test('nocheh-app\'s main listener refuses the members\' routes whatever the caller holds',async()=>{
  const token='t'.repeat(32),server=storageServer({} as never,{service:'nocheh-app',token,dataDir:join(tmpdir(),'nocheh-none')} as never,(async()=>({})) as never);
  const base=await listen(server);
  try {
    for(const path of ['/v1/member-app/me','/v1/member-app','/v1/member-app/tasks?project=x'])
      for(const headers of [{},{authorization:'Bearer '+token}]) {
        const answer=await fetch(base+path,{headers});assert.equal(answer.status,404,path);assert.deepEqual(await answer.json(),{error:'not_found'});
      }
  } finally {server.close();}
});

/** A control store that answers the member listener's queries from `rows` and remembers what it was asked. */
function fakeControl(identity:Record<string,unknown>|null,options:{limit?:boolean}={}) {
  const asked:string[]=[];
  const query=async(sql:string)=>{
    asked.push(sql);
    if(/FROM chat_accounts a JOIN chat_connections/.test(sql))return {rows:identity?[identity]:[],rowCount:identity?1:0};
    if(/INSERT INTO member_app_limits/.test(sql))return {rows:options.limit===false?[]:[{member_id:'m'}],rowCount:options.limit===false?0:1};
    return {rows:[],rowCount:0};
  };
  return {asked,control:{query} as unknown as MemberAppServices['control']};
}
const memberId='d'.repeat(64),account=accountIdFor('telegram',member);
const identityRow=(changes:Record<string,unknown>={})=>({member:memberId,account,tasks:'write',reminders:true,app_since:new Date(Date.now()-3600_000),display_name:'Mira T',
  language:null,signed_out_auth_date:null,accounts:[account],chat:member,...changes});

test('the member listener checks every call in order and answers only with fixed codes, never stored',async()=>{
  const calls:{name:string;principal:any;args:unknown[]}[]=[];
  const tasks=Object.fromEntries(['memberList','memberGet','memberCreate','memberUpdate','memberComment','memberReminders'].map(name=>
    [name,async(principal:unknown,...args:unknown[])=>{calls.push({name,principal,args});return {done:name};}])) as unknown as MemberAppServices['tasks'];
  const runtime:string[]=[];
  const make=(identity:Record<string,unknown>|null,options:{limit?:boolean}={})=>{
    const fake=fakeControl(identity,options);
    const server=memberAppServer({control:fake.control,tasks,policy:()=>({owner_id:ownerId,owner_chat:ownerId}),
      call:async(operation)=>{runtime.push(operation);return {};}},{botId,key:publicKey});
    return {fake,server};
  };
  const {fake,server}=make(identityRow());
  const base=await listen(server),init=memberLaunch();
  const ask=(path:string,init_:RequestInit={})=>fetch(base+'/v1/member-app'+path,{...init_,headers:{'x-telegram-init-data':init,...init_.headers as Record<string,string>}});
  try {
    const logged=await console_(async()=>{
      const refused=async(answer:Response,status:number,error:string)=>{
        assert.equal(answer.status,status,error);assert.deepEqual(await answer.json(),{error});assert.equal(answer.headers.get('cache-control'),'no-store');
      };
      // 1-5 before the store is read at all.
      await refused(await ask('/me',{headers:{authorization:'Bearer '+'s'.repeat(32)}}),400,'member_app_no_bearer');
      for(const path of ['/health','/v1/owner/tasks','/v1/member-app/settings','/v1/member-app/tasks/'+'b'.repeat(64)+'/audience','/v1/member-app/me?x=1'])
        assert.equal((await fetch(base+path,{headers:{'x-telegram-init-data':init}})).status,404,path);
      await refused(await fetch(base+'/v1/member-app/me'),401,'member_app_launch_invalid');
      await refused(await ask('/me',{headers:{'x-telegram-init-data':memberLaunch({chat_type:'supergroup'})}}),401,'member_app_launch_invalid');
      await refused(await ask('/me',{headers:{'x-telegram-init-data':launch({auth_date:String(seconds()-MEMBER_LAUNCH_MAX_AGE-60),user:user(member)})}}),401,'member_app_launch_invalid');
      await refused(await ask('/me',{headers:{'x-telegram-init-data':memberLaunch({},ownerId)}}),403,'member_required');
      await refused(await ask('/tasks',{method:'POST',body:'x'.repeat(MEMBER_APP_BODY_MAX+1)}),413,'body_too_large');
      assert.deepEqual(fake.asked,[],'nothing is read before the launch is a member\'s');
      // A list: the principal the repository gets, built from this call.
      const listed=await ask('/tasks?project='+'c'.repeat(64)+'&state=open');
      assert.equal(listed.status,200);assert.deepEqual(await listed.json(),{done:'memberList'});assert.equal(listed.headers.get('cache-control'),'no-store');
      const first=calls.at(-1)!;
      assert.deepEqual({...first.principal},{member:memberId,account,accounts:[account],name:'Mira',mode:'write',reminders:{available:true},views:[],chat:member});
      assert.deepEqual(first.args,[{project:'c'.repeat(64),state:'open'}]);
      assert.deepEqual(runtime,[],'a list asks Telegram nothing');
      // Filters the app does not take, before the repository is called.
      await refused(await ask('/tasks?project='+'c'.repeat(64)+'&person='+'e'.repeat(64)),400,'task_filter_not_allowed');
      // A write asks Telegram about the groups first (none here), counts against the limit, then reaches the repository.
      const task='b'.repeat(64);forgetMemberAppRechecks();
      assert.equal((await ask('/tasks/'+task,{method:'POST',body:'{"operation_id":"o1","expected_version":"v","patch":{"title":"x"}}'})).status,200);
      assert.deepEqual([calls.at(-1)!.name,calls.at(-1)!.args],['memberUpdate',[task,{operation_id:'o1',expected_version:'v',patch:{title:'x'}}]]);
      assert.ok(fake.asked.some(sql=>/INSERT INTO member_app_limits/.test(sql)));
      await refused(await ask('/tasks',{method:'POST',body:'not json'}),400,'invalid_json');
      for(const route of ['/me','/reminders','/tasks/'+task])assert.equal((await ask(route)).status,200,route);
      assert.deepEqual(calls.map(call=>call.name).slice(-2),['memberReminders','memberGet']);
    });
    assert.ok(!logged.includes(init),'the launch data is never logged');
  } finally {server.close();}

  // 6: anyone who is not an active member now gets one answer, and no task is read.
  const before=calls.length;
  for(const [identity,status,error] of [[null,403,'member_app_closed'],[identityRow({app_since:new Date(Date.now()+10*60000)}),401,'member_app_launch_old'],
    [identityRow({signed_out_auth_date:new Date(Date.now())}),401,'member_app_signed_out']] as const) {
    const other=make(identity),otherBase=await listen(other.server);
    try {
      for(const path of ['/me','/tasks?project='+'c'.repeat(64),'/reminders']) {
        const answer=await fetch(otherBase+'/v1/member-app'+path,{headers:{'x-telegram-init-data':init}});
        assert.equal(answer.status,status,path);assert.deepEqual(await answer.json(),{error},path);
      }
      assert.ok(!other.fake.asked.some(sql=>/owner_tasks|member_app_limits/.test(sql)),error);
    } finally {other.server.close();}
  }
  assert.equal(calls.length,before,'the repository is never called for them');

  // 9: read only refuses every write before it is counted; over the limit is 429 and the repository is not called.
  for(const [identity,limit,status,error] of [[identityRow({tasks:'read'}),true,403,'task_read_only'],[identityRow(),false,429,'member_app_busy']] as const) {
    const other=make(identity,{limit}),otherBase=await listen(other.server);
    try {
      for(const [path,body] of [['/tasks','{"operation_id":"o","project":"p","title":"t"}'],['/tasks/'+'b'.repeat(64),'{}'],['/tasks/'+'b'.repeat(64)+'/comments','{"operation_id":"o","text":"hi"}']] as const) {
        const answer=await fetch(otherBase+'/v1/member-app'+path,{method:'POST',headers:{'x-telegram-init-data':init},body});
        assert.equal(answer.status,status,path);assert.deepEqual(await answer.json(),{error},path);
      }
      if(error==='task_read_only')assert.ok(!other.fake.asked.some(sql=>/member_app_limits/.test(sql)),'a refused write is not counted');
      // There is no prefs route (English only, Q2).
      assert.equal((await fetch(otherBase+'/v1/member-app/prefs',{method:'POST',headers:{'x-telegram-init-data':init},body:'{"language":"fa"}'})).status,404);
    } finally {other.server.close();}
  }
  assert.equal(calls.length,before);
  assert.equal(MEMBER_APP_WRITES_PER_10_MIN,60);assert.ok(MEMBER_APP_ROUTES.length===11);
});

test('"Remind me" needs write access, Reminders to themselves, and the member\'s open private chat; the owner can switch reminders',()=>{
  assert.deepEqual(remindersState({mode:'write',reminders:true,chat:'701'}),{available:true});
  assert.deepEqual(remindersState({mode:'read',reminders:true,chat:'701'}),{available:false,reason:'read_only'});
  assert.deepEqual(remindersState({mode:'write',reminders:false,chat:'701'}),{available:false,reason:'reminders_off'});
  assert.deepEqual(remindersState({mode:'write',reminders:true,chat:null}),{available:false,reason:'private_chat_off'});
  assert.deepEqual(memberChangeRequest({operation_id:'o',changes:{reminders:false}}).changes,{reminders:false});
  assert.throws(()=>memberChangeRequest({operation_id:'o',changes:{reminders:'off'}}),{status:400});
  assert.throws(()=>memberChangeRequest({operation_id:'o',changes:{app_since:'2020-01-01'}}),{status:400,code:'unknown_member_field'},'app_since is never set by hand');
});
