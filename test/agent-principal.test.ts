import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {turnToken} from '../src/access.js';
import {storageServer} from '../src/stores/server.js';
import {agentRoute,agentRoutes,serveAgent} from '../src/stores/agent-routes.js';
import type {StorageServices} from '../src/stores/services.js';
import type {Settings} from '../src/config.js';

// What Hermes calls on nocheh-app with the agent login (ADR-0295, and the notes carry of ADR-0292), and nothing more.
const expected=[
  'GET /internal/chats','POST /internal/notes/sources','POST /internal/sources/retired','POST /internal/notes/carry',
  'GET /v1/runtime/profiles','POST /v1/runtime/profiles/resolve',
  ...['definition','input','workflow-context','claim','prepare','heartbeat','observe','cancel','finish','recover','runs'].map(step=>'POST /v1/scheduler/'+step),
  ...['workflow-context','claim','prepare','heartbeat','observe','finish'].map(step=>'POST /v1/background/'+step)];
const url=(path:string)=>new URL(path,'http://local');

test('the agent login reaches exactly the routes Hermes calls',()=>{
  assert.deepEqual(agentRoutes.map(([method,path])=>method+' '+path),expected);assert.equal(agentRoutes.length,23);
  for(const row of expected){const [method,path]=row.split(' ');assert.ok(agentRoute(method,url(path!)),row);}
  for(const [method,path] of [
    // Profile save while Hermes's Profiles page only reads; background cancel and memory spaces have no Hermes caller.
    ['POST','/v1/runtime/profiles'],['POST','/v1/background/cancel'],['GET','/v1/memory/spaces'],['POST','/v1/memory/spaces'],
    // Owner, tool, data and Telegram routes.
    ['POST','/mcp'],['GET','/mcp'],['GET','/v1/status'],['GET','/v1/runtime'],['POST','/v1/agent/manage'],['POST','/v1/ingest'],
    ['POST','/internal/chats/leave'],['POST','/internal/actions/authorize'],['POST','/internal/notices/authorize'],['POST','/internal/memory/prepare'],
    ['POST','/v1/schedules/turn'],['POST','/v1/schedules/turn/definition'],['POST','/v1/scheduler/ownership'],['POST','/v1/scheduler/announce'],
    ['POST','/v1/scheduler/delivery'],['POST','/v1/browser/input'],['GET','/v1/search'],['POST','/v1/import'],['GET','/v1/workflows'],
    // Another method, a query, a trailing slash or a different spelling of a listed route.
    ['HEAD','/internal/chats'],['OPTIONS','/internal/chats'],['POST','/internal/chats'],['GET','/v1/runtime/profiles/resolve'],
    ['GET','/v1/scheduler/runs'],['PUT','/v1/scheduler/claim'],[undefined,'/internal/chats'],['GET','/internal/chats/'],['POST','/v1/scheduler/claim/'],
    ['POST','/V1/scheduler/claim'],['POST','/v1/scheduler//claim'],['POST','/v1/scheduler/../agent/manage'],
  ] as const)assert.equal(agentRoute(method,url(path)),false,method+' '+path);
  assert.equal(agentRoute('GET',url('/internal/chats?x=1')),false);assert.equal(agentRoute('POST',url('/v1/scheduler/claim?admin=true')),false);
});

test('the agent login is refused before anything is read on any other route',async()=>{
  // No storage at all: a refused route must never reach it.
  const s={} as StorageServices,config={} as Settings,login={kind:'agent',agent:'hermes'} as const,res={} as ServerResponse;
  for(const [method,path] of [['POST','/v1/runtime/profiles'],['POST','/mcp'],['GET','/v1/status'],['POST','/v1/agent/manage'],
    ['POST','/v1/background/cancel'],['GET','/internal/chats?all=1'],['HEAD','/internal/chats']] as const)
    await assert.rejects(serveAgent(s,config,login,{method} as IncomingMessage,res,url(path)),{status:403,code:'agent_route_not_allowed'},method+' '+path);
});

test('nocheh-app takes the agent login before any other route or reader, and the master key is still the admin bearer',async()=>{
  // No stores: every answer below comes before storage is asked anything.
  const token='m'.repeat(32),agentKey='a'.repeat(40);
  const server=storageServer({} as never,{service:'nocheh-app',token,agentKey,dataDir:join(tmpdir(),'nocheh-none')} as never,(async()=>({})) as never);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=async(method:string,path:string,key:string)=>{
    const answer=await fetch(base+path,{method,headers:{authorization:'Bearer '+key},...(method==='GET'||method==='HEAD'?{}:{body:'{}'})});
    return {status:answer.status,body:method==='HEAD'?null:await answer.json() as any};
  };
  try {
    for(const [method,path] of [['POST','/mcp'],['GET','/v1/status'],['GET','/v1/runtime'],['POST','/v1/agent/manage'],['POST','/v1/runtime/profiles'],
      ['POST','/v1/background/cancel'],['GET','/v1/memory/spaces'],['POST','/internal/actions/authorize'],['POST','/internal/notices/authorize'],
      ['POST','/internal/chats/leave'],['POST','/internal/memory/prepare'],['POST','/v1/ingest'],['POST','/v1/scheduler/delivery'],['GET','/v1/search?q=x'],
      ['GET','/v1/security/policy'],['POST','/v1/schedules/turn'],['GET','/internal/chats?x=1'],['HEAD','/internal/chats']] as const)
      assert.deepEqual(await call(method,path,agentKey),method==='HEAD'?{status:403,body:null}:{status:403,body:{error:'agent_route_not_allowed'}},method+' '+path);
    // The browser routes still answer first, whatever the caller holds.
    assert.deepEqual(await call('POST','/v1/browser/input',agentKey),{status:404,body:{error:'browser_chat_off'}});
    // A pass signed with the agent login is no pass, and the agent login is no admin bearer for the bot's routes.
    const forged=turnToken(agentKey,null,Date.now()+60000,'e'.repeat(64),{space:'123',revision:1});
    assert.equal((await call('GET','/v1/status',forged)).body.error,'invalid_scope_token');
    assert.equal((await call('POST','/internal/actions/authorize',forged)).body.error,'unauthorized');
  } finally {server.closeAllConnections();server.close();}
});
