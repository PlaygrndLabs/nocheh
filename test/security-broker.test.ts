import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {turnToken} from '../src/access.js';
import {ANTHROPIC_MESSAGES,ANTHROPIC_URL,anthropicCredential,anthropicHeaders,brokerServer,configuredReplyUrl,FIXTURE_PROVIDER_URL,jobErrors,machineErrors,providerTarget,scopedRoute} from '../src/security/broker.js';
import type {IncomingMessage} from 'node:http';
import {effectLog} from '../src/security/store.js';

// Hermes's machine backend has words for every code a machine command may come back with; a cleanup's own code never reaches it.
test('the machine backend words every code a machine command is refused or fails with',()=>{
  const places=[new URL('../../services/hermes/machine_box.py',import.meta.url).pathname,join(process.env.PYTHONPATH??'/nonexistent','services/hermes/machine_box.py')];
  const source=readFileSync(places.find(place=>existsSync(place))!,'utf8'),block=source.match(/^REFUSALS=\{\n([^}]*)\n\}$/m);
  assert.ok(block,'REFUSALS is one dict');
  assert.deepEqual([...block[1]!.matchAll(/^\s*'([a-z_]+)':/gm)].map(match=>match[1]!).sort(),[...machineErrors].filter(code=>code!=='machine_cleanup_failed').sort());
});

test('broker supports only explicit scoped routes and the configured reply provider',()=>{
  for(const route of ['/v1/export','/v1/tools/claim','/internal/security/transport','/v1/memory/shares','//example.com'])assert.equal(scopedRoute('POST',route),false);
  assert.equal(scopedRoute('POST','/v1/context/prepare'),true);
  assert.equal(scopedRoute('GET','/v1/search'),true);
  // The agent's reading tools reach storage, which checks who may read what.
  for(const route of ['/v1/archive/page','/v1/imports/pending'])assert.equal(scopedRoute('GET',route),true);
  assert.equal(scopedRoute('POST','/v1/memory/honcho/search'),true);
  for(const action of ['start','status','stop'])assert.equal(scopedRoute('POST','/v1/jobs/'+action),true);
  for(const action of ['size','propose'])assert.equal(scopedRoute('POST','/v1/jobs/'+action),false);
  assert.equal(scopedRoute('POST','/v1/jobs/approve'),false,'only a person approves a job, on its card');
  // A job's run sends its commands for its machine; the owner's machine routes stay with the dashboard.
  assert.equal(scopedRoute('POST','/v1/machines/exec'),true);
  for(const [method,route] of [['GET','/v1/machines/exec'],['GET','/v1/machines'],['POST','/v1/machines'],['POST','/v1/machines/settings'],['GET','/v1/machines/commands'],
    ['POST','/v1/machines/'+'a'.repeat(32)],['POST','/v1/machines/'+'a'.repeat(32)+'/test'],['POST','/v1/machines/'+'a'.repeat(32)+'/remove'],['POST','/v1/machines/exec/x']])
    assert.equal(scopedRoute(method!,route!),false,method+' '+route);
  for(const code of ['job_machine_not_allowed','job_machine_not_found','job_card_too_long'])assert.ok(jobErrors.has(code),code);
  assert.deepEqual([...machineErrors].sort(),['invalid_machine_request','machine_auth_failed','machine_changed','machine_cleanup_failed','machine_host_key_changed',
    'machine_host_key_unknown','machine_key_missing','machine_not_allowed','machine_off','machine_script_too_long','machine_time_up','machine_timeout','machine_unavailable',
    'machine_unreachable']);
  // Settings › Models may name one HTTPS reply provider; any other address stays denied.
  const gateway='https://gateway.example.test/v1';
  assert.throws(()=>providerTarget({base_url:'https://attacker.example',api_mode:'codex_responses'},'/v1/chat/completions',gateway),{code:'provider_route_denied'});
  assert.throws(()=>providerTarget({base_url:gateway,api_mode:'codex_responses'},'/v1/chat/completions',gateway),{code:'provider_route_denied'});
  assert.equal(providerTarget({base_url:gateway,api_mode:'chat_completions'},'/v1/chat/completions',configuredReplyUrl(gateway+'/')),gateway+'/chat/completions');
  assert.throws(()=>providerTarget({base_url:'https://attacker.example/v1',api_mode:'chat_completions'},'/v1/chat/completions',configuredReplyUrl(gateway)));
  // Without a provider from Settings › Models there is nowhere to send the call.
  assert.throws(()=>providerTarget({base_url:gateway,api_mode:'chat_completions'},'/v1/chat/completions',undefined),{status:503,code:'provider_not_configured'});
  assert.throws(()=>providerTarget({base_url:gateway,api_mode:'chat_completions'},'/v1/chat/completions',configuredReplyUrl('')),{code:'provider_not_configured'});
  assert.equal(configuredReplyUrl('http://gateway.example.test/v1'),undefined);
  assert.equal(configuredReplyUrl('https://user:pass@gateway.example.test/v1'),undefined);
  // The rehearsal fixture is the only plain-HTTP provider, and only with its flag.
  assert.equal(configuredReplyUrl(FIXTURE_PROVIDER_URL,false),undefined);
  assert.equal(configuredReplyUrl(FIXTURE_PROVIDER_URL+'/',true),FIXTURE_PROVIDER_URL);
  assert.equal(configuredReplyUrl('http://model-fixture:8318/v1',true),undefined);
  assert.equal(configuredReplyUrl('http://other-fixture:8317/v1',true),undefined);
});
test("Anthropic's Messages API is reachable only when Anthropic is the configured reply provider",()=>{
  // Its OpenAI-compatible API has no prompt caching, so Hermes uses the Messages API through the broker.
  const anthropic={base_url:ANTHROPIC_URL,api_mode:'chat_completions'};
  assert.equal(providerTarget(anthropic,ANTHROPIC_MESSAGES,configuredReplyUrl(ANTHROPIC_URL+'/')),ANTHROPIC_URL+'/messages');
  assert.equal(providerTarget(anthropic,'/v1/chat/completions',ANTHROPIC_URL),ANTHROPIC_URL+'/chat/completions');
  const gateway='https://gateway.example.test/v1';
  assert.throws(()=>providerTarget({base_url:gateway,api_mode:'chat_completions'},ANTHROPIC_MESSAGES,gateway),{code:'provider_route_denied'});
  assert.throws(()=>providerTarget({base_url:gateway,api_mode:'chat_completions'},ANTHROPIC_MESSAGES,ANTHROPIC_URL),{code:'provider_route_denied'});
  for(const path of ['/anthropic/v1/messages/batches','/anthropic/v1/files','/v1/messages'])assert.throws(()=>providerTarget(anthropic,path,ANTHROPIC_URL),{code:'provider_route_denied'});
  // Hermes sends the turn's scoped credential in Anthropic's key header; only this route reads it there.
  const request=(headers:Record<string,string>)=>({headers:{...headers}}) as unknown as IncomingMessage;
  const mapped=request({'x-api-key':'turn.synthetic'});anthropicCredential(mapped,ANTHROPIC_MESSAGES);
  assert.deepEqual(mapped.headers,{authorization:'Bearer turn.synthetic'});
  const elsewhere=request({'x-api-key':'turn.synthetic'});anthropicCredential(elsewhere,'/v1/chat/completions');
  assert.deepEqual(elsewhere.headers,{'x-api-key':'turn.synthetic'});
  const bearer=request({authorization:'Bearer turn.synthetic'});anthropicCredential(bearer,ANTHROPIC_MESSAGES);
  assert.deepEqual(bearer.headers,{authorization:'Bearer turn.synthetic'});
  assert.throws(()=>anthropicCredential(request({'x-api-key':'turn.a',authorization:'Bearer turn.b'}),ANTHROPIC_MESSAGES),{status:401});
  // Anthropic gets the provider key in its own header, never the scoped credential, and only Hermes's beta features.
  assert.deepEqual(anthropicHeaders('provider-key','interleaved-thinking-2025-05-14, files-api-2025-04-14,fine-grained-tool-streaming-2025-05-14'),
    {'content-type':'application/json','x-api-key':'provider-key','anthropic-version':'2023-06-01','user-agent':'Nocheh',
      'anthropic-beta':'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'});
  assert.equal('anthropic-beta' in anthropicHeaders('provider-key','mcp-client-2025-04-04'),false);
  assert.equal('authorization' in anthropicHeaders('provider-key',undefined),false);
});
test('PostgreSQL broker: scoped credential, exact preparation, route denial and every-attempt epoch checks',{skip:!process.env.PGHOST},async t=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace='security_broker_'+Date.now();await admin.query('CREATE SCHEMA '+namespace);
  const pool=new pg.Pool({...connection,options:'-c search_path='+namespace});
  const token='synthetic-service-token-only-for-tests',calls:{url:string;body:unknown;auth:string;agent:string}[]=[];
  const secret='synthetic-provider-credential-never-returned',gateway='https://gateway.example.test/v1';
  const previousRoute=process.env.NOCHEH_REPLY_ROUTE_URL;process.env.NOCHEH_REPLY_ROUTE_URL=gateway;
  let guardDown=false,streamRevocation=false,slowMemory=false,providerStatus=0;const preparedPrincipals:any[]=[];
  const mock:typeof fetch=async(url,init)=>{
    const body=init?.body?JSON.parse(String(init.body)):null;
    calls.push({url:String(url),body,auth:new Headers(init?.headers).get('authorization')??'',agent:new Headers(init?.headers).get('user-agent')??''});
    if(slowMemory&&String(url).includes('/memory/')) {
      init?.signal?.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(resolve,40);
        init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal?.reason);},{once:true});
      });
      return Response.json({sources:[]});
    }
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:gateway,api_mode:'chat_completions',api_key:secret});
    if(String(url).endsWith('/v1/guard'))return guardDown?new Response('unavailable',{status:503}):Response.json({guarded:true,payload:body.payload});
    if(providerStatus)return Response.json({type:'error',error:{type:'overloaded_error',message:'private provider words'}},{status:providerStatus});
    if(streamRevocation)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      setTimeout(()=>{void pool.query('UPDATE guard_state SET epoch=epoch+1').then(()=>{controller.enqueue(new TextEncoder().encode('data: stale\n\n'));controller.close();});},30);
    }}),{headers:{'content-type':'text/event-stream'}});
    return Response.json({ok:true});
  };
  const server=brokerServer({pool,token,archive:'http://archive',prepare:async(principal,input)=>{preparedPrincipals.push(principal);if(guardDown)throw Error('detector unavailable');return {guarded:true,payload:(input as any).payload};},hermes:'http://hermes',model:'same-model',fetch:mock});
  try {
    await initialize(pool);
    const event=await ingest(pool,{version:1,key:'security-turn',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'1',revision:'0',occurred_at:null,text:'exact source',payload:{profile:'owner'}},false);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();const base='http://127.0.0.1:'+address.port;
    const credential=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:1});
    const request=(path:string,body:unknown,key=credential)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});
    const payload={model:'same-model',input:[{role:'user',content:'Exact owner edit 🧠\r\n two  spaces'}],reasoning:{effort:'high'}};
    const response=await request('/v1/chat/completions',payload);
    assert.equal(response.status,200);assert.equal((await response.text()).includes(secret),false);
    let measurements:any[]=[];
    for(let i=0;i<30;i++){
      measurements=(await effectLog(pool,{admin:true,scope:null},'0',undefined,event.id)).events.filter(row=>row.state==='completed');
      if(measurements.length)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(measurements.length,1);
    assert.ok(Number.isSafeInteger(measurements[0].timings.provider_headers_ms));
    assert.ok(Number.isSafeInteger(measurements[0].timings.provider_read_ms));
    assert.ok(measurements[0].timings.provider_chunks>0);
    assert.equal(JSON.stringify(measurements).includes(secret),false);
    assert.equal((await effectLog(pool,{admin:true,scope:null},'0',undefined,'f'.repeat(64))).events.length,0);
    await assert.rejects(effectLog(pool,{admin:false,scope:null},'0',undefined,event.id),{code:'owner_required'});
    await assert.rejects(effectLog(pool,{admin:true,scope:null},'0',undefined,'bad'),{code:'invalid_event_filter'});
    const provider=calls.at(-1)!;assert.deepEqual(provider.body,payload);assert.equal(provider.auth,'Bearer '+secret);
    assert.equal(provider.agent,'Nocheh','a reply names its client, so a gateway bot check does not refuse it');
    assert.equal(preparedPrincipals[0].turnEvent,event.id);assert.equal(preparedPrincipals[0].admin,false);
    const before=calls.length;
    for(const path of ['/internal/security/transport','/v1/tools/claim','/v1/chat/completions?url=https://evil.example'])assert.equal((await request(path,payload)).status,403);
    assert.equal((await request('/v1/chat/completions',{...payload,model:'changed-model'})).status,403);
    assert.equal((await request('/v1/chat/completions',{...payload,tools:[{type:'web_search'}]})).status,403);
    assert.equal((await pool.query("SELECT rule FROM security_events WHERE state='blocked' ORDER BY id DESC LIMIT 1")).rows[0].rule,'hosted_provider_tools_denied');
    assert.equal((await request('/v1/chat/completions',payload,token)).status,403);
    assert.equal(calls.length,before,'denied calls never reach upstreams');
    assert.equal((await request('/v1/memory/honcho/context',{})).status,200);
    // Compress only broker deadlines so this covers a slow recall without a
    // multi-minute test. The normal memory route still times out and cancels.
    const setTimer=globalThis.setTimeout;
    const clock=t.mock.method(globalThis,'setTimeout',((fn:any,ms?:number,...args:any[])=>
      setTimer(fn,ms===600000?1000:ms===120000?5:ms,...args)) as typeof setTimeout);
    slowMemory=true;
    try {
      assert.equal((await request('/v1/memory/honcho/recall',{query:'Synthetic recall'})).status,200);
      assert.equal((await request('/v1/memory/honcho/context',{})).status,503,'automatic context keeps the ordinary short deadline');
      assert.equal((await request('/v1/memory/recall',{query:'Synthetic recall'})).status,503);
    }finally{slowMemory=false;clock.mock.restore();}
    // A provider's refusal passes on only its HTTP status, never its message, so the owner's notice can name it.
    providerStatus=529;
    const busy=await request('/v1/chat/completions',payload);
    assert.equal(busy.status,503);assert.deepEqual(await busy.json(),{error:'provider_request_failed',provider_status:529});
    providerStatus=429;
    const limited=await request('/v1/chat/completions',payload);
    assert.equal(limited.status,429);assert.deepEqual(await limited.json(),{error:'provider_request_failed',provider_status:429});
    providerStatus=0;
    const provided=calls.filter(x=>x.url===gateway+'/chat/completions').length;
    guardDown=true;
    assert.equal((await request('/v1/chat/completions',payload)).status,503);
    assert.equal(calls.filter(x=>x.url===gateway+'/chat/completions').length,provided,'guard outage never falls back to a direct provider call');
    const afterOutage=calls.length;
    await pool.query('UPDATE guard_state SET epoch=epoch+1');
    assert.equal((await request('/v1/chat/completions',payload)).status,409);
    assert.equal(calls.length,afterOutage,'stale capabilities fail before any provider lookup');
    guardDown=false;streamRevocation=true;
    const fresh=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:2});
    const streaming=await request('/v1/chat/completions',payload,fresh);
    await assert.rejects(streaming.text(),'revocation cuts off in-flight output');
    let states:string[]=[];
    for(let i=0;i<20;i++){
      states=(await pool.query("SELECT state FROM security_events WHERE kind='model.request' ORDER BY id DESC LIMIT 1")).rows.map(row=>row.state);
      if(states[0]==='ambiguous')break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(states[0],'ambiguous','started stream without an observed finish is never logged as completed');
    streamRevocation=false;delete process.env.NOCHEH_REPLY_ROUTE_URL;const unconfigured=calls.length;
    // Revocation advanced the epoch, so the last check uses a capability for the current one.
    const epoch=Number((await pool.query('SELECT epoch FROM guard_state')).rows[0].epoch);
    const current=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:epoch});
    const missing=await request('/v1/chat/completions',payload,current);
    assert.equal(missing.status,503);assert.deepEqual(await missing.json(),{error:'provider_not_configured'});
    assert.equal(calls.length,unconfigured,'an unconfigured provider is reported before any upstream call');
  }finally{if(previousRoute===undefined)delete process.env.NOCHEH_REPLY_ROUTE_URL;else process.env.NOCHEH_REPLY_ROUTE_URL=previousRoute;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query('DROP SCHEMA '+namespace+' CASCADE');await admin.end();}
});
test("PostgreSQL broker: Anthropic's Messages API gets the provider key in its own header and the same boundary",{skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace='security_anthropic_'+Date.now();await admin.query('CREATE SCHEMA '+namespace);
  const pool=new pg.Pool({...connection,options:'-c search_path='+namespace});
  const token='synthetic-service-token-only-for-tests',secret='synthetic-provider-credential-never-returned';
  const calls:{url:string;body:unknown;headers:Headers}[]=[];
  const previousRoute=process.env.NOCHEH_REPLY_ROUTE_URL;process.env.NOCHEH_REPLY_ROUTE_URL=ANTHROPIC_URL;
  const mock:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null,headers:new Headers(init?.headers)});
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:ANTHROPIC_URL,api_mode:'chat_completions',api_key:secret});
    return new Response('event: message_start\ndata: {"type":"message_start"}\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const server=brokerServer({pool,token,archive:'http://archive',prepare:async(_principal,input)=>({guarded:true,payload:(input as any).payload}),hermes:'http://hermes',model:'same-model',fetch:mock});
  try {
    await initialize(pool);
    const event=await ingest(pool,{version:1,key:'security-anthropic-turn',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'1',revision:'0',occurred_at:null,text:'exact source',payload:{profile:'owner'}},false);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();const base='http://127.0.0.1:'+address.port;
    const credential=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:1});
    // Hermes's Anthropic client sends the scoped credential as x-api-key, with its version and beta headers.
    const request=(body:unknown,headers:Record<string,string>={'x-api-key':credential})=>fetch(base+ANTHROPIC_MESSAGES,{method:'POST',
      headers:{'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'interleaved-thinking-2025-05-14,files-api-2025-04-14',...headers},body:JSON.stringify(body)});
    const payload={model:'same-model',max_tokens:100,stream:true,system:[{type:'text',text:'system',cache_control:{type:'ephemeral'}}],
      messages:[{role:'user',content:[{type:'text',text:'Exact owner edit',cache_control:{type:'ephemeral'}}]}]};
    const response=await request(payload);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream');
    assert.ok((await response.text()).includes('message_start'));
    const provider=calls.at(-1)!;
    assert.equal(provider.url,ANTHROPIC_URL+'/messages');assert.deepEqual(provider.body,payload);
    assert.equal(provider.headers.get('x-api-key'),secret);assert.equal(provider.headers.get('authorization'),null);
    assert.equal(provider.headers.get('anthropic-version'),'2023-06-01');
    assert.equal(provider.headers.get('anthropic-beta'),'interleaved-thinking-2025-05-14');
    assert.equal(JSON.stringify([...provider.headers]).includes(credential),false,'the scoped credential never reaches the provider');
    const before=calls.length;
    assert.equal((await request(payload,{'x-api-key':credential,authorization:'Bearer '+credential})).status,401);
    assert.ok([401,403].includes((await request(payload,{'x-api-key':token})).status),'the service token is not a turn credential');
    assert.equal((await request({...payload,tools:[{type:'web_search_20260209',name:'web_search'}]})).status,403);
    assert.equal((await pool.query("SELECT rule FROM security_events WHERE state='blocked' ORDER BY id DESC LIMIT 1")).rows[0].rule,'hosted_provider_tools_denied');
    assert.equal((await request({...payload,mcp_servers:[]})).status,403);
    assert.equal((await request({...payload,model:'changed-model'})).status,403);
    // Other Anthropic paths do not even read the key header.
    assert.equal((await fetch(base+'/anthropic/v1/messages/batches',{method:'POST',headers:{'x-api-key':credential},body:'{}'})).status,401);
    assert.equal((await fetch(base+'/anthropic/v1/messages/batches',{method:'POST',headers:{authorization:'Bearer '+credential},body:'{}'})).status,403);
    assert.equal(calls.length,before,'denied calls never reach the provider');
    process.env.NOCHEH_REPLY_ROUTE_URL='https://gateway.example.test/v1';
    assert.equal((await request(payload)).status,403,'only Anthropic itself has this route');
  }finally{if(previousRoute===undefined)delete process.env.NOCHEH_REPLY_ROUTE_URL;else process.env.NOCHEH_REPLY_ROUTE_URL=previousRoute;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query('DROP SCHEMA '+namespace+' CASCADE');await admin.end();}
});
