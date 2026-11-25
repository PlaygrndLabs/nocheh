import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {IncomingMessage} from 'node:http';
import type pg from 'pg';
import {reader,type Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {HttpError} from '../src/http.js';
import {mcpTools} from '../src/mcp/tools.js';
import {brokerServer,type TurnBinding} from '../src/security/broker.js';
import {machineRunRoute,machineRunTools} from '../src/stores/machine-reads.js';
import {OWNER,fixtureDirectory} from './fixture-groups.js';
import {keyPass} from './one-time-key-pass.js';
import {notionMachineRead,notionPageKey} from '../src/stores/notion.js';
import {notionPages} from '../src/stores/background-jobs.js';

const page='0123456789abcdef0123456789abcdef',other='fedcba9876543210fedcba9876543210';

test('a machine job\'s card names Notion pages by id or notion.so address, and its run fetches only those', ()=>{
  assert.equal(notionPageKey(page),page);
  assert.equal(notionPageKey('01234567-89ab-cdef-0123-456789abcdef'),page);
  assert.equal(notionPageKey('https://www.notion.so/Made-up-setup-'+page),page);
  assert.equal(notionPageKey('https://www.notion.so/cafe-'+page),page,'hex letters in the title before the id stay out');
  assert.equal(notionPageKey('https://www.notion.so/Made-up-'+page+'?p='+other),page,'a peek in the query names another page, never this one');
  assert.equal(notionPageKey('collection://'+page),page);
  assert.equal(notionPageKey('no id here'),null);
  const pages=['https://www.notion.so/Made-up-setup-'+page];
  assert.ok(notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page}},pages),'by its raw id');
  assert.ok(notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:'https://notion.so/'+page}},pages));
  assert.ok(notionMachineRead({operation:'list'},pages),'the list of tools reads no page');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:other}},pages),'a page the card did not name');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:'https://www.notion.so/Made-up-'+other+'?p='+page}},pages));
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-search',input:{query:'setup'}},pages),'no search');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page,url:'https://evil.example/'}},pages),'nothing rides along');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page}},[]));
  // What a card may name: 1 to 5 of the owner's own pages, each as a job's fetch takes it.
  assert.deepEqual(notionPages([page,' '+page+' ','https://www.notion.so/Made-up-'+other]),[page,'https://www.notion.so/Made-up-'+other]);
  for(const value of [[],Array(6).fill(page),['https://made-up.notion.site/'+page],['user://'+page],[''],[7],page])
    assert.throws(()=>notionPages(value),{code:'invalid_job_request'},JSON.stringify(value));
});

test('a machine job\'s run reaches only the routes that read its card\'s chat, its commands and its own cards', ()=>{
  for(const [method,path] of <[string,string][]>[['GET','/v1/search'],['GET','/v1/archive/page'],['GET','/v1/events/'+'a'.repeat(64)],['GET','/v1/artifacts/'+'a'.repeat(64)+'/bytes'],
    ['GET','/v1/imports/pending'],['GET','/v1/memory/context'],['GET','/v1/tools/actions'],['GET','/v1/notion/connections'],['POST','/v1/context/prepare'],
    ['POST','/v1/memory/longterm/search'],['POST','/v1/memory/longterm/context'],['POST','/v1/machines/exec'],['POST','/v1/tools/propose'],['POST','/v1/action-requests']])
    assert.ok(machineRunRoute(method,path),method+' '+path);
  for(const [method,path] of <[string,string][]>[['POST','/v1/memory/recall'],['GET','/v1/owner/people'],['GET','/v1/owner/tasks'],['POST','/v1/owner/tasks'],['GET','/v1/telegram/destinations'],
    ['GET','/v1/memory/notes/'+'a'.repeat(12)],['GET','/v1/memory/grants/'+'a'.repeat(64)],['GET','/v1/memory/facts/'+'a'.repeat(64)],['GET','/v1/knowledge/context'],
    ['POST','/v1/member-asks'],['POST','/v1/jobs/start'],['POST','/v1/schedules/turn'],['GET','/v1/github/repos'],['GET','/v1/search/../owner/people'],['DELETE','/v1/search']])
    assert.ok(!machineRunRoute(method,path),method+' '+path);
});

test('what a machine job\'s run reads comes from storage, never from its pass', ()=>{
  const secret='s'.repeat(32),now=Date.now();
  const pass=(claims:Record<string,unknown>)=>{
    // A one-time key's claims (ADR-0305), so the refusal below is for the machine claim.
    const body=Buffer.from(JSON.stringify({scope:null,expires:now+60000,event_id:'e'.repeat(64),audience:'nocheh-assistant',agent:'hermes',person:'owner',
      jti:'f'.repeat(32),key_kind:'background',logical_profile:'job-synthetic',generation:'00000000-0000-4000-8000-000000000001',...claims})).toString('base64url');
    return {headers:{authorization:'Bearer turn.'+body+'.'+createHmac('sha256',secret).update(body).digest('base64url')}} as unknown as IncomingMessage;
  };
  assert.equal(reader(pass({}),secret,now).machineReads,undefined);
  for(const claim of ['machine_reads','machineReads'])
    assert.throws(()=>reader(pass({[claim]:{job:'j',chat:'123',from:null,to:null,until:'999999',notion:[]}}),secret,now),{code:'invalid_scope_token'},claim);
});

test('the broker offers a machine job\'s run only its card\'s tools and relays only its card\'s routes (ADR-0306)',async()=>{
  installChatsForTest(fixtureDirectory());
  const secret='synthetic-service-token-only-for-tests',event='c'.repeat(64),relayed:string[]=[],logged:unknown[][]=[];
  const pool={query:async(sql:string,params:unknown[])=>{if(sql.includes('INSERT INTO security_events'))logged.push(params);
    return {rows:sql.includes('SELECT p.revision')?[{revision:1,document:{version:1,rules:[]}}]:[],rowCount:1};}} as unknown as pg.Pool;
  const binding=async(principal:Reader):Promise<TurnBinding>=>({event_id:principal.turnEvent!,scope:OWNER,profile:'synthetic',logical_profile:'job-synthetic',owner:true,guard_epoch:1,job:'j'});
  const storage={binding,assertAudience:async()=>{},assertKey:async()=>{},turnFile:async()=>{throw new HttpError(404,'turn_file_not_found');},
    bindMachine:async(principal:Reader)=>({...principal,machineReads:{job:'j',chat:OWNER,from:null,to:null,until:'9',notion:[]}})};
  const fetcher=(async(url:string|URL)=>{relayed.push(new URL(String(url)).pathname);return Response.json([]);}) as typeof fetch;
  const server=brokerServer({agentKey:'synthetic-agent-login-only-for-tests-0001',pool,token:secret,archive:'http://archive',hermes:'http://hermes',model:'synthetic',
    prepare:async()=>({}),storage,fetch:fetcher});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as AddressInfo,base='http://127.0.0.1:'+address.port;
  const pass=keyPass(secret,null,Date.now()+60000,event,{space:OWNER,revision:1,guard_epoch:1,logical_profile:'job-synthetic',generation:'00000000-0000-4000-8000-000000000001',kind:'background'});
  const headers={authorization:'Bearer '+pass,'content-type':'application/json',accept:'application/json, text/event-stream'};
  const rpc=async(message:unknown)=>(await (await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify(message)})).json()) as any;
  try {
    const listed=(await rpc({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.map((tool:{name:string})=>tool.name);
    assert.deepEqual(listed,mcpTools.map(tool=>tool.name).filter(name=>machineRunTools.has(name)));
    for(const name of ['owner_read','memory_recall','shell','browser','tasks','background_job'])
      assert.deepEqual((await rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:{}}})).error,{code:-32602,message:'Unknown tool'},name);
    for(const path of ['/v1/owner/people','/v1/telegram/destinations']) {
      const response=await fetch(base+path,{headers});
      assert.equal(response.status,403,path);assert.deepEqual(await response.json(),{error:'machine_job_reads_card_only'},path);
    }
    assert.deepEqual([relayed,logged],[[],[]],'a route the card does not allow is neither relayed nor logged');
    assert.equal((await fetch(base+'/v1/search?q=invoice',{headers})).status,200);
    assert.deepEqual(relayed,['/v1/search']);
    // Its log rows name the key's person and id, never the pass (ADR-0306).
    const claims=JSON.parse(Buffer.from(pass.split('.')[1]!,'base64url').toString());
    assert.ok(logged.length>=2&&logged.every(params=>params.at(-2)==='owner'&&params.at(-1)===claims.jti&&!params.some(value=>String(value).includes(pass))));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
