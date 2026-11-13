import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type pg from 'pg';
import {turnToken,type Reader} from '../src/access.js';
import {telegramDeliveryAllowed} from '../src/assistant-policy.js';
import {HttpError} from '../src/http.js';
import {brokerServer,type TurnBinding} from '../src/security/broker.js';
import {serveMcp} from '../src/mcp/server.js';
import {mcpTools} from '../src/mcp/tools.js';
import {assertPrivateAnswerRoute,privateAnswerRoute,privateAnswerTools} from '../src/stores/private-answers.js';
import {storageServer} from '../src/stores/server.js';
import {readSet,readSetGroups} from '../src/spaces.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,OWNER,P1,groupsPolicy} from './fixture-groups.js';

const secret='synthetic-service-token-only-for-tests',start='e'.repeat(64),answer='a'.repeat(32),hex='b'.repeat(64);
const reads=readSet({home:GP1_TOPIC,whole:[GP1,GP2,GP3],project:P1});
/** The pass of a private answer: the asker's private chat as scope and space, and the record it answers. */
const answerPass=()=>turnToken(secret,OWNER,Date.now()+60000,start,{space:OWNER,revision:1,guard_epoch:1,answer});
const listen=async(server:Server)=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error();return 'http://127.0.0.1:'+address.port;};
const close=async(server:Server)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};

/** Every read route an answer reader may call, and a sample of what it may not: writes, posts, owner views and recall. */
const allowed:[string,string][]=[['GET','/v1/search'],['GET','/v1/archive/page'],['GET','/v1/imports/pending'],['GET','/v1/events/'+hex],['GET','/v1/artifacts/'+hex+'/bytes'],
  ['GET','/v1/memory/check'],['GET','/v1/memory/context'],['GET','/v1/memory/shared/'+hex],['GET','/v1/memory/filtered/'+hex],['GET','/v1/owner/tasks'],['GET','/v1/owner/tasks/'+hex],
  ['GET','/v1/security/binding'],['GET','/v1/turn-files/'+hex],['POST','/mcp'],['POST','/v1/context/prepare'],['POST','/v1/memory/longterm/search'],
  ['POST','/v1/memory/longterm/context'],['POST','/v1/guard'],['POST','/v1/chat/completions'],['POST','/anthropic/v1/messages']];
const refused:[string,string][]=[['POST','/v1/action-requests'],['GET','/v1/telegram/destinations'],['POST','/v1/tools/propose'],['POST','/v1/jobs/start'],['POST','/v1/jobs/status'],
  ['POST','/v1/jobs/stop'],['POST','/v1/machines/exec'],['POST','/v1/owner/tasks'],['POST','/v1/owner/tasks/'+hex],['POST','/v1/owner/tasks/'+hex+'/comments'],
  ['GET','/v1/tools/actions'],['GET','/v1/tools/actions/'+hex],['POST','/v1/memory/longterm/recall'],['POST','/v1/memory/recall'],['GET','/v1/knowledge/context'],
  ['POST','/v1/knowledge/proposals'],['GET','/v1/owner/conversations'],['GET','/v1/owner/projects'],['GET','/v1/owner/telegram-identities'],['GET','/v1/entities'],
  ['GET','/v1/telegram/identities'],['GET','/v1/box/chat'],['GET','/v1/runtime'],['GET','/v1/private-answers'],['GET','/v1/graph'],['GET','/v1/data'],['POST','/v1/ingest'],
  ['GET','/mcp'],['POST','/v1/search'],['GET','/v1/events/'+hex+'/x'],['GET','/v1/search/'],['GET','//v1/search'],['DELETE','/v1/events/'+hex]];

test('an answer reader reaches read routes only, at storage and at the broker alike',()=>{
  for(const [method,path] of allowed)assert.equal(privateAnswerRoute(method,path),true,method+' '+path);
  for(const [method,path] of refused)assert.equal(privateAnswerRoute(method,path),false,method+' '+path);
  const reader:Reader={admin:false,scope:OWNER,space:OWNER,turnEvent:start,answer,reads};
  assert.throws(()=>assertPrivateAnswerRoute(reader,'POST','/v1/action-requests'),{status:403,code:'private_answer_read_only'});
  assert.throws(()=>assertPrivateAnswerRoute(reader,undefined,'/v1/search'),{code:'private_answer_read_only'});
  assertPrivateAnswerRoute(reader,'GET','/v1/search');
  // Anyone without an answer is not limited here; their own routes decide.
  for(const other of [{admin:true,scope:null},{admin:false,scope:GP1,space:GP1},{admin:false,scope:null,space:OWNER}] as Reader[])
    assertPrivateAnswerRoute(other,'POST','/v1/action-requests');
  assert.deepEqual([...privateAnswerTools].sort(),['archive_page','archive_read','archive_search','memory_search','tasks']);
  for(const name of privateAnswerTools)assert.ok(mcpTools.some(tool=>tool.name===name),name);
  assert.deepEqual(readSetGroups(reads),[GP1,GP2,GP3]);
  assert.deepEqual(readSetGroups(readSet({home:GP4,exact:[GP2+'/topic/7',GP4],whole:[GP3]})),[GP2,GP3,GP4]);
});

test('storage binds an answer pass to its record on every request and refuses every write and post route',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nocheh-answer-routes-')),calls:unknown[][]=[];let open=true;
  const bound=(principal:Reader)=>{calls.push(['bind',principal.answer,principal.turnEvent,'reads' in principal]);
    if(!open)throw new HttpError(409,'private_answer_closed');return {...principal,reads};};
  const s={stores:{control:{query:async(sql:string,values:unknown[])=>{calls.push(['imports',values[0]]);return {rows:[]};}},archive:{query:async()=>({rows:[]})}},
    access:{bindReads:async(principal:Reader)=>bound(principal),reads:(principal:Reader)=>principal.reads,policy:()=>groupsPolicy()},
    turns:{assertAudience:async()=>{}},guards:{state:async()=>({mode:'on'})},configuration:{assert:async()=>{}},prepared:{allow:async()=>{}},
    sources:{search:async(principal:Reader,query:string)=>{calls.push(['search',principal.reads,query]);return [];}},
    telegramActions:{request:async()=>{calls.push(['request']);return {};}},actionCommands:{offer:async()=>({})}};
  const server=storageServer(s as unknown as Parameters<typeof storageServer>[0],{token:secret,dataDir:root,guardMode:'on'} as Parameters<typeof storageServer>[1],async()=>({}));
  const base=await listen(server);
  const call=(method:string,path:string,key=answerPass())=>fetch(base+path,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  try {
    const found=await call('GET','/v1/search?q=invoice');
    assert.equal(found.status,200);assert.deepEqual(await found.json(),[]);
    assert.deepEqual(calls.splice(0),[['bind',answer,start,false],['search',reads,'invoice']],'the read set comes from the record, never from the pass');
    // Import status names only the groups of the record, never a label.
    assert.equal((await call('GET','/v1/imports/pending')).status,200);
    assert.deepEqual(calls.splice(0),[['bind',answer,start,false],['imports',[GP1,GP2,GP3]]]);
    for(const [method,path] of refused.filter(([method])=>method==='GET'||method==='POST')) {
      const response=await call(method,path);
      assert.equal(response.status,403,method+' '+path);assert.deepEqual(await response.json(),{error:'private_answer_read_only'},method+' '+path);
    }
    assert.ok(calls.every(entry=>entry[0]==='bind'),'no refused route reached a repository');calls.length=0;
    // A closed record refuses even the read routes.
    open=false;
    const closed=await call('GET','/v1/search?q=invoice');
    assert.equal(closed.status,409);assert.deepEqual(await closed.json(),{error:'private_answer_closed'});
    assert.deepEqual(calls.splice(0),[['bind',answer,start,false]]);
    // A pass without an answer is never bound here.
    open=true;
    const group=turnToken(secret,GP1,Date.now()+60000,start,{space:GP1,revision:1,guard_epoch:1});
    assert.equal((await call('GET','/v1/search?q=invoice',group)).status,200);
    assert.deepEqual(calls.splice(0),[['search',undefined,'invoice']]);
  }finally{await close(server);await rm(root,{recursive:true,force:true});}
});

test('the broker binds an answer pass through storage, refuses it without storage and lets only read routes through',async()=>{
  const relayed:string[]=[],bound:string[]=[];let open=true;
  const pool={query:async(sql:string)=>({rows:sql.includes('SELECT p.revision')?[{revision:1,document:{version:1,rules:[]}}]:[],rowCount:1})} as unknown as pg.Pool;
  const binding=async(principal:Reader):Promise<TurnBinding>=>({event_id:principal.turnEvent!,scope:OWNER,profile:'synthetic',logical_profile:'synthetic',owner:principal.scope===null,guard_epoch:1});
  const storage={binding,assertAudience:async()=>{},turnFile:async()=>{throw new HttpError(404,'turn_file_not_found');},
    bindReads:async(principal:Reader)=>{bound.push(principal.answer??'none');if(!open)throw new HttpError(409,'private_answer_closed');return {...principal,reads};}};
  const fetcher=(async(url:string|URL)=>{relayed.push(new URL(String(url)).pathname);return Response.json([]);}) as typeof fetch;
  const server=brokerServer({pool,token:secret,archive:'http://archive',hermes:'http://hermes',model:'synthetic',prepare:async()=>({}),storage,fetch:fetcher});
  const bare=brokerServer({pool,token:secret,archive:'http://archive',hermes:'http://hermes',model:'synthetic',prepare:async()=>({}),fetch:fetcher});
  const base=await listen(server),bareBase=await listen(bare);
  const call=(method:string,path:string,at=base)=>fetch(at+path,{method,headers:{authorization:'Bearer '+answerPass(),'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  try {
    assert.equal((await call('GET','/v1/search?q=invoice')).status,200);
    assert.equal((await call('POST','/v1/memory/longterm/search')).status,200);
    assert.deepEqual(relayed.splice(0),['/v1/search','/v1/memory/longterm/search']);
    for(const [method,path] of [['POST','/v1/action-requests'],['POST','/v1/tools/propose'],['POST','/v1/jobs/start'],['POST','/v1/owner/tasks'],['GET','/v1/tools/actions'],
      ['GET','/v1/telegram/destinations'],['POST','/v1/memory/longterm/recall'],['POST','/v1/knowledge/proposals'],['GET','/v1/box/chat'],['POST','/v1/machines/exec']] as const) {
      const response=await call(method,path);
      assert.equal(response.status,403,method+' '+path);assert.deepEqual(await response.json(),{error:'private_answer_read_only'},method+' '+path);
    }
    assert.deepEqual(relayed,[],'a refused route never reaches storage');
    assert.ok(bound.length>=12&&bound.every(id=>id===answer),'every call is bound to the record first');
    open=false;assert.equal((await call('GET','/v1/search?q=invoice')).status,409);
    // A broker that cannot reach the record refuses an answer pass outright.
    const refusedHere=await call('GET','/v1/search?q=invoice',bareBase);
    assert.equal(refusedHere.status,409);assert.deepEqual(await refusedHere.json(),{error:'private_answer_closed'});
    assert.deepEqual(relayed,[]);
  }finally{await close(server);await close(bare);}
});

test('an answer reader is offered and runs only the read tools, and tasks only to list and read',async()=>{
  const seen:string[]=[];let principal:Reader={admin:false,scope:OWNER,space:OWNER,turnEvent:start,answer,reads};
  const server=createServer((req,res)=>{void serveMcp(req,res,{principal,isolated:true,call:async(method,path)=>{seen.push(method+' '+path);
    return {status:200,body:path.startsWith('/v1/imports')?{imports:[]}:path.startsWith('/v1/memory/context')?{sources:[]}:[]};}})
    .catch(error=>{res.writeHead(error instanceof HttpError?error.status:500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code}));});});
  const base=await listen(server);
  const rpc=async(message:unknown)=>(await (await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)})).json()) as any;
  try {
    const listed=(await rpc({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.map((tool:{name:string})=>tool.name);
    assert.deepEqual(listed,['archive_search','archive_read','archive_page','memory_search','tasks']);
    for(const name of ['memory_recall','action_request','background_job','telegram_destinations','shell','browser','mcp','owner_read','notion','action_status',
      'knowledge_inspect','knowledge_propose','knowledge_status'])
      assert.deepEqual((await rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:{}}})).error,{code:-32602,message:'Unknown tool'},name);
    for(const action of ['add','update','comment','delete',undefined]) {
      const result=(await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'tasks',arguments:{action,id:hex,title:'x'}}})).result;
      assert.deepEqual(JSON.parse(result.content[0].text),{error:'tool_unavailable'},String(action));
    }
    assert.deepEqual(seen,[],'a refused tool never calls a route');
    await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'tasks',arguments:{action:'list'}}});
    await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'archive_search',arguments:{query:'invoice'}}});
    assert.deepEqual(seen,['GET /v1/owner/tasks','GET /v1/imports/pending','GET /v1/search?q=invoice&limit=5','GET /v1/memory/context?q=invoice'],
      'the asking group\'s shared and granted context comes with a search');
    principal={admin:false,scope:GP1,space:GP1,turnEvent:start};
    assert.equal((await rpc({jsonrpc:'2.0',id:6,method:'tools/list'})).result.tools.length,mcpTools.length,'other turns keep every tool');
  }finally{await close(server);}
});

test('a private answer is delivered only into the owner\'s own private chat, from the owner\'s own update there',()=>{
  const policy=groupsPolicy();
  const update=(chat:{id:number;type:string},from:number)=>({origin:'live',channel:'telegram',kind:'telegram_update',scope:String(chat.id),
    payload:Buffer.from(JSON.stringify({update_id:1,message:{message_id:1,date:1,chat,from:{id:from,is_bot:false},text:'/start '+answer}}))});
  const ownerChat=update({id:Number(OWNER),type:'private'},Number(OWNER)),groupChat=update({id:Number(GP1),type:'supergroup'},Number(OWNER));
  const bound={scope:OWNER,answer,reads};
  assert.equal(telegramDeliveryAllowed(policy,bound,ownerChat),true);
  assert.equal(telegramDeliveryAllowed(policy,{scope:OWNER,answer},ownerChat),false,'never without its read set');
  assert.equal(telegramDeliveryAllowed(policy,{scope:GP1,answer,reads},groupChat),false,'never into a group');
  assert.equal(telegramDeliveryAllowed(policy,bound,groupChat),false);
  assert.equal(telegramDeliveryAllowed(policy,{scope:'456',answer,reads},update({id:456,type:'private'},456)),false,'never anyone else\'s private chat');
  assert.equal(telegramDeliveryAllowed(policy,bound,{...ownerChat,channel:'browser'}),false);
  assert.equal(telegramDeliveryAllowed(policy,bound,null),false);
  // Everyone else delivers as before: the owner's pass in the private chat, a group's pass in its group.
  assert.equal(telegramDeliveryAllowed(policy,{scope:null},ownerChat),true);
  assert.equal(telegramDeliveryAllowed(policy,{scope:OWNER},ownerChat),false,'a scoped pass without an answer is never the owner');
  assert.equal(telegramDeliveryAllowed(policy,{scope:GP1},groupChat),true);
});
