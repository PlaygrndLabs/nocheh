import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type Server} from 'node:http';
import pg from 'pg';
import {defaultBrain,reader,scopeToken,turnToken,type Reader} from '../src/access.js';
import {ingest} from '../src/archive.js';
import {initialize} from '../src/database.js';
import {HttpError,readJson} from '../src/http.js';
import {brokerServer,jobErrors as relayedJobErrors} from '../src/security/broker.js';
import {loopback,protocolVersions,serveMcp,toolSurface,turnDeadline} from '../src/mcp/server.js';
import {inParts,jobErrors,mcpTools,memoryRoutes,timeoutFor,type ToolContext} from '../src/mcp/tools.js';

const ID='a'.repeat(64);
type Call={method:string;path:string;body:unknown;timeout:number};
/** A route's refusal in a fake loop-back; any other value is a 200 answer, and a thrown error is a broken connection. */
class Status {constructor(readonly status:number,readonly body:unknown=null){}}
function fake(answer:(call:Call)=>unknown,principal:Reader={scope:'-1001',admin:false},extra:Partial<ToolContext>={}) {
  const calls:Call[]=[];
  const context:ToolContext={principal,isolated:true,pause:async()=>{},...extra,call:async(method,path,body,timeout)=>{
    const call={method,path,body,timeout};calls.push(call);
    const value=await answer(call);
    return value instanceof Status?{status:value.status,body:value.body}:{status:200,body:value};
  }};
  return {calls,context};
}
const tool=(name:string)=>{const found=mcpTools.find(item=>item.name===name);if(!found)throw Error('no tool '+name);return found;};
const run=async(name:string,args:Record<string,unknown>,context:ToolContext)=>JSON.parse(await tool(name).run(args,context));
const timeout=()=>new DOMException('slow secret check','TimeoutError');
const listen=async(server:Server)=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error();return 'http://127.0.0.1:'+address.port;};
const close=async(server:Server)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};

test('the data tools keep their names, closed schemas and engine-neutral words',()=>{
  // The brain sees each one as mcp__nocheh__<name>, one for one with the plugin tool nocheh_<name> it replaces (ADR-0233).
  assert.deepEqual(mcpTools.map(item=>item.name),['archive_search','archive_read','archive_page','memory_search','memory_recall','action_request','background_job',
    'telegram_destinations','shell','browser','mcp','owner_read','tasks','notion','action_status','knowledge_inspect','knowledge_propose','knowledge_status']);
  for(const item of mcpTools) {
    assert.equal(item.inputSchema.type,'object',item.name);assert.equal(item.inputSchema.additionalProperties,false,item.name);
    // No memory engine's name and no old plugin tool name reaches the brain.
    assert.doesNotMatch(item.description+JSON.stringify(item.inputSchema),/honcho|\bnocheh_[a-z]/i,item.name);
  }
  for(const name of ['shell','browser','mcp','notion'])assert.equal((tool(name).inputSchema.properties as any).summary.maxLength,300);
  const job=tool('background_job').inputSchema as any;
  assert.deepEqual(job.properties.action.enum,['start','status','stop']);assert.deepEqual(job.required,['action']);
  assert.equal(job.properties.repo.maxLength,140);assert.ok(job.properties.repo.description.startsWith('With start and box=true'));
  assert.ok(job.properties.box.description.startsWith('With start:'));assert.match(tool('background_job').description,/GitHub copies/);
  const proposal=tool('knowledge_propose').inputSchema as any;
  assert.deepEqual(proposal.required,['operation_id','proposal']);
  assert.deepEqual(new Set(proposal.properties.proposal.oneOf.map((branch:any)=>branch.properties.kind.const)),
    new Set(['organization','project_save','project_assignment','entity_rename','entity_correct','entity_merge','entity_unmerge','sharing_rule','fact_grant','fact_revoke']));
  for(const branch of proposal.properties.proposal.oneOf){assert.equal(branch.additionalProperties,false);assert.equal('approved' in branch.properties,false);assert.equal('delegation_id' in branch.properties,false);}
  assert.match(tool('memory_recall').description,/mcp__nocheh__archive_read/);
  assert.match(toolSurface(),/^[a-f0-9]{64}$/);
  // The broker relays exactly the job codes the job tool may name.
  assert.equal(relayedJobErrors,jobErrors);assert.ok(jobErrors.has('job_repo_not_allowed'));
});

test('a turn pass names its brain, and only a turn pass may',()=>{
  const secret='synthetic-service-token-only-for-tests',request=(token:string)=>({headers:{authorization:'Bearer '+token}}) as unknown as IncomingMessage;
  const pass=turnToken(secret,'-1001',Date.now()+60000,ID,{space:'-1001',revision:1});
  assert.equal(defaultBrain,'hermes');assert.equal(reader(request(pass),secret).brain,'hermes');
  assert.equal(reader(request(turnToken(secret,null,Date.now()+60000,ID,{space:'1',revision:1,brain:'other-brain'})),secret).brain,'other-brain');
  assert.equal(reader(request(scopeToken(secret,'-1001',Date.now()+60000)),secret).brain,undefined);
  for(const brain of ['Hermes','','1brain','a'.repeat(33),'two words'])
    assert.throws(()=>reader(request(turnToken(secret,null,Date.now()+60000,ID,{space:'1',revision:1,brain})),secret),{code:'invalid_scope_token'});
});

test('the MCP endpoint speaks JSON-only Streamable HTTP without sessions',async()=>{
  let principal:Reader={scope:'-1001',admin:false};const seen:Call[]=[];
  const server=createServer((req,res)=>{void serveMcp(req,res,{principal,isolated:false,call:async(method,path,body,ms)=>{seen.push({method,path,body,timeout:ms});
    if(path.startsWith('/v1/imports'))return {status:200,body:{imports:[]}};if(path.startsWith('/v1/search'))return {status:200,body:[]};throw Error('down');}})
    .catch(error=>{res.writeHead(error instanceof HttpError?error.status:500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code}));});});
  const base=await listen(server);
  const post=(message:unknown,headers:Record<string,string>={})=>fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:typeof message==='string'?message:JSON.stringify(message)});
  const rpc=async(message:unknown,headers?:Record<string,string>)=>{const response=await post(message,headers);return {status:response.status,body:response.status===202?null:await response.json() as any};};
  try {
    const started=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1'}}});
    assert.equal(started.status,200);
    assert.deepEqual(started.body,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'nocheh',title:'Nocheh',version:'1'}}});
    // An older client gets its own revision; an unknown one gets the newest.
    assert.equal((await rpc({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-03-26'}})).body.result.protocolVersion,'2025-03-26');
    assert.equal((await rpc({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2099-01-01'}})).body.result.protocolVersion,protocolVersions[0]);
    // No session id is ever given, so the client opens no event stream and sends no DELETE.
    assert.equal((await post({jsonrpc:'2.0',id:4,method:'ping'})).headers.get('mcp-session-id'),null);
    assert.deepEqual((await rpc({jsonrpc:'2.0',method:'notifications/initialized'})),{status:202,body:null});
    assert.deepEqual((await rpc({jsonrpc:'2.0',id:5,method:'ping'},{'mcp-protocol-version':'2025-11-25'})).body,{jsonrpc:'2.0',id:5,result:{}});
    const listed=(await rpc({jsonrpc:'2.0',id:'list',method:'tools/list'})).body.result.tools;
    assert.equal(listed.length,18);assert.deepEqual(Object.keys(listed[0]),['name','description','inputSchema']);
    const called=await rpc({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'archive_search',arguments:{query:'Friday',scope:'private'}}});
    assert.deepEqual(called.body,{jsonrpc:'2.0',id:6,result:{content:[{type:'text',text:JSON.stringify({sources:[],filter_status:null})}],isError:false}});
    assert.deepEqual(seen.map(call=>call.path),['/v1/imports/pending','/v1/search?q=Friday&limit=5'],'the model never chooses the scope');
    // A tool's own failure is a normal answer whose text says so, so the client's failure breaker never trips on it.
    const failed=await rpc({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'telegram_destinations'}});
    assert.equal(failed.body.result.isError,false);assert.equal(JSON.parse(failed.body.result.content[0].text).error,'destinations_unavailable');
    assert.deepEqual((await rpc({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'nocheh_archive_search',arguments:{}}})).body.error,{code:-32602,message:'Unknown tool'});
    assert.deepEqual((await rpc({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'archive_search',arguments:[1]}})).body.error,{code:-32602,message:'Invalid arguments'});
    assert.deepEqual((await rpc({jsonrpc:'2.0',id:10,method:'resources/list'})).body.error,{code:-32601,message:'Method not found'});
    assert.equal((await rpc('{"jsonrpc":')).body.error.code,-32700);
    assert.equal((await rpc([{jsonrpc:'2.0',id:11,method:'ping'}])).body.error.code,-32600,'a batch is not part of these revisions');
    assert.equal((await rpc({jsonrpc:'1.0',id:12,method:'ping'})).status,400);
    assert.equal((await rpc({jsonrpc:'2.0',id:{},method:'ping'})).status,400);
    assert.equal((await rpc({jsonrpc:'2.0',id:13,method:'ping'},{'mcp-protocol-version':'2024-11-05'})).status,400);
    assert.equal((await fetch(base+'/mcp')).status,405,'no server-sent event stream');
    assert.equal((await fetch(base+'/mcp',{method:'DELETE'})).status,405);
    // A browser never reaches it, and only a turn's own pass uses it.
    assert.equal((await post({jsonrpc:'2.0',id:14,method:'ping'},{origin:'https://example.com'})).status,403);
    principal={scope:null,admin:true};
    assert.deepEqual(await (await post({jsonrpc:'2.0',id:15,method:'ping'})).json(),{error:'turn_credential_required'});
  }finally{await close(server);}
});

test('a long tool call keeps a client that takes an event stream reading until its answer',async()=>{
  const principal:Reader={scope:'-1001',admin:false};let wait=0;
  const server=createServer((req,res)=>{void serveMcp(req,res,{principal,isolated:false,keepalive:40,call:async(_method,path)=>{
    if(path.startsWith('/v1/search'))await new Promise(resolve=>setTimeout(resolve,wait));
    return {status:200,body:path.startsWith('/v1/imports')?{imports:[]}:[]};}});});
  const base=await listen(server);
  const call=(accept:string)=>fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept},
    body:JSON.stringify({jsonrpc:'2.0',id:'slow',method:'tools/call',params:{name:'archive_search',arguments:{query:'Synthetic'}}})});
  const answer={jsonrpc:'2.0',id:'slow',result:{content:[{type:'text',text:JSON.stringify({sources:[],filter_status:null})}],isError:false}};
  try {
    // A quick call is plain JSON.
    const quick=await call('application/json, text/event-stream');
    assert.match(quick.headers.get('content-type')!,/^application\/json/);assert.deepEqual(await quick.json(),answer);
    // A long one turns into an event stream: comment lines while it runs, then the answer as one message.
    wait=200;
    const long=await call('application/json, text/event-stream'),body=await long.text();
    assert.equal(long.headers.get('content-type'),'text/event-stream');
    assert.match(body,/^(: running\n\n)+event: message\ndata: /);
    assert.deepEqual(JSON.parse(body.split('\ndata: ')[1]!.trimEnd()),answer);
    // A client that takes only JSON waits for plain JSON.
    const plain=await call('application/json');
    assert.match(plain.headers.get('content-type')!,/^application\/json/);assert.deepEqual(await plain.json(),answer);
  }finally{await close(server);}
});

test('a loop-back sends the turn pass and reads a bounded answer',async()=>{
  const seen:{method:string;url:string;auth:string;body:string}[]=[];let big=false;
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
    seen.push({method:req.method!,url:req.url!,auth:req.headers.authorization??'',body});
    if(req.url==='/redirect'){res.writeHead(302,{location:'/elsewhere'});res.end();return;}
    if(req.url==='/refused'){res.writeHead(403,{'content-type':'application/json'});res.end('{"error":"tool_disabled_by_owner"}');return;}
    if(req.url==='/broken'){res.writeHead(200);res.end('{"half');return;}
    if(req.url==='/slow'){setTimeout(()=>{res.writeHead(200);res.end('{}');},200);return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(big?JSON.stringify({text:'x'.repeat(2*1024*1024)}):'{"ok":true}');
  });});
  const base=await listen(server),call=loopback(base,'Bearer turn.synthetic');
  try {
    assert.deepEqual(await call('POST','/v1/tools/propose',{kind:'browser'},5000),{status:200,body:{ok:true}});
    assert.deepEqual(seen[0],{method:'POST',url:'/v1/tools/propose',auth:'Bearer turn.synthetic',body:'{"kind":"browser"}'});
    assert.deepEqual(await call('GET','/refused',undefined,5000),{status:403,body:{error:'tool_disabled_by_owner'}});
    await assert.rejects(call('GET','/broken',undefined,5000),/invalid_archive_response/);
    await assert.rejects(call('GET','/redirect',undefined,5000),/archive_redirect_refused/);
    await assert.rejects(call('GET','/slow',undefined,20),{name:'TimeoutError'});
    big=true;await assert.rejects(call('GET','/v1/events/'+ID,undefined,5000),/archive_response_too_large/);
  }finally{await close(server);}
});

test('a route that refuses a large body early leaves no stalled connection for the next call',async()=>{
  // As the task routes do: read up to a limit, then refuse with the rest unread.
  const server=createServer((req,res)=>{void readJson(req,64*1024).then(value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:Boolean(value)}));},
    error=>{res.writeHead(error instanceof HttpError?error.status:500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code}));});});
  const base=await listen(server),call=loopback(base,'Bearer turn.synthetic');
  try {
    assert.equal((await call('POST','/v1/owner/tasks',{notes:'x'.repeat(600*1024)},5000)).status,413);
    for(let n=0;n<3;n++)assert.deepEqual(await call('POST','/v1/owner/tasks',{title:'Synthetic'},2000),{status:200,body:{ok:true}});
  }finally{await close(server);}
});

test('a long memory recall fits the turn, and the secret-checked routes get a minute',()=>{
  const now=Date.now();
  assert.ok(timeoutFor(memoryRoutes.recall)>600000);
  for(const path of ['/v1/context/prepare',memoryRoutes.search,'/v1/tools/propose','/v1/tools/actions/'+ID,'/v1/jobs/start'])assert.equal(timeoutFor(path),60000,path);
  for(const path of ['/v1/tools/actions','/v1/search?q=synthetic','/v1/owner/tasks'])assert.equal(timeoutFor(path),15000,path);
  // Time is left for the brain to reason and check delivery policy.
  const left=timeoutFor(memoryRoutes.recall,now/1000+100,now);assert.ok(left>50000&&left<56000,String(left));
  assert.throws(()=>timeoutFor(memoryRoutes.recall,now/1000+44,now),{name:'TimeoutError'});
  // The turn process names its deadline; a value it could not have set is ignored.
  const header=(value:string)=>({headers:{'x-nocheh-turn-deadline':value}}) as unknown as IncomingMessage;
  assert.equal(turnDeadline(header(String((now+100000)/1000)),now),(now+100000)/1000);
  for(const value of [String((now+3700000)/1000),'soon','1e10',''])assert.equal(turnDeadline(header(value),now),undefined,value);
  // A deadline already past leaves no time for a recall, rather than the whole budget.
  const past=turnDeadline(header(String(now/1000-1)),now);assert.equal(past,now/1000-1);
  assert.throws(()=>timeoutFor(memoryRoutes.recall,past,now),/memory_recall_turn_budget_exhausted/);
  assert.equal(turnDeadline({headers:{}} as unknown as IncomingMessage,now),undefined);
});

test('memory recall skips a call the turn has no time for, and the owner also gets the brain\'s own notes',async()=>{
  const short=fake(()=>({sources:[]}),{scope:null,admin:false},{deadline:Date.now()/1000+44});
  assert.deepEqual(await run('memory_recall',{query:'Synthetic recall'},short.context),{error:'owner_memory_unavailable'});
  assert.equal(short.calls.length,0);
  const owner=fake(call=>call.path===memoryRoutes.recall?{sources:[{kind:'memory_inference'}]}:{notes:[]},{scope:null,admin:false});
  assert.deepEqual(await run('memory_recall',{query:'Synthetic recall',limit:5},owner.context),{sources:[{kind:'memory_inference'}],native:{notes:[]}});
  assert.deepEqual(owner.calls.map(call=>[call.path,call.body]),[[memoryRoutes.recall,{query:'Synthetic recall'}],[memoryRoutes.notes,{query:'Synthetic recall',limit:5}]]);
  const group=fake(()=>({sources:[]}));
  assert.deepEqual(await run('memory_recall',{query:'Synthetic recall'},group.context),{sources:[]});
  assert.equal(group.calls.length,1,'a group reads only long-term memory for its audience');
});

test('current reaction discovery uses the bound scope without text or memory search',async()=>{
  const result={sources:[{source:'nocheh:event:'+ID,kind:'captured_reaction',target_sources:['nocheh:event:'+'b'.repeat(64)]}],complete:false};
  const found=fake(()=>result);
  assert.deepEqual(await run('archive_search',{mode:'current_reactions',scope:'private',query:'ignored',limit:99},found.context),result);
  assert.deepEqual(found.calls.map(call=>call.path),['/v1/search?mode=current_reactions&limit=10']);
  assert.deepEqual(await run('archive_search',{mode:'current_reactions'},fake(()=>new Status(409)).context),{error:'archive_search_unavailable'});
  const idle=fake(()=>({}));
  for(const args of [{mode:'unknown'},{mode:'text'},{query:'   '},{query:'x'.repeat(2001)}])assert.deepEqual(await run('archive_search',args,idle.context),{error:'archive_search_unavailable'});
  assert.equal(idle.calls.length,0);
});

test('search says when history is still importing, and adds shared facts only for a chat',async()=>{
  let pending:unknown[]=[{messages:40000,ready_percent:42}];
  const answer=(call:Call)=>call.path==='/v1/imports/pending'?{imports:pending}:call.path.startsWith('/v1/memory/context')?{sources:[{id:'nocheh:shared:'+ID}],filter_status:'ready'}:[{id:'nocheh:source:'+ID}];
  const group=fake(answer,{scope:'-1001',admin:false,space:'-1001/topic/3'});
  const result=await run('archive_search',{query:'Friday'},group.context);
  assert.equal(result.import_status,'Still importing: 42% of 40000 messages ready, so older history may be missing');
  assert.deepEqual(result.sources,[{id:'nocheh:source:'+ID},{id:'nocheh:shared:'+ID}]);assert.equal(result.filter_status,'ready');
  assert.deepEqual(group.calls.map(call=>call.path),['/v1/imports/pending','/v1/search?q=Friday&limit=5','/v1/memory/context?q=Friday']);
  pending=[{label:'the old export',messages:10,ready_percent:50.9}];
  assert.equal((await run('archive_search',{query:'Friday'},fake(answer).context)).import_status,'Still importing the old export: 50% of 10 messages ready, so older history may be missing');
  pending=[];
  const owner=fake(answer,{scope:null,admin:false,space:'1'});
  assert.deepEqual(await run('archive_search',{query:'Friday'},owner.context),{sources:[{id:'nocheh:source:'+ID}],filter_status:null});
  assert.equal(owner.calls.length,2,'the owner reads the whole archive, without shared facts');
  // A failed status check never blocks the search itself.
  assert.deepEqual((await run('archive_search',{query:'Friday'},fake(call=>call.path.includes('pending')?new Status(503):[]).context)).sources,[]);
});

test('a chat is read page by page and found by meaning through the bound scope',async()=>{
  const page={chat:'-1001',items:[],next:null,position:{through:0,total:0},complete:true};
  const paged=fake(call=>call.path==='/v1/imports/pending'?{imports:[{messages:10,ready_percent:50}]}:page);
  const result=await run('archive_page',{chat:'-1002',from:'2026-10-01',after:'1-'+ID,limit:99,scope:'ignored'},paged.context);
  assert.equal(paged.calls.at(-1)!.path,'/v1/archive/page?chat=-1002&from=2026-10-01&after=1-'+ID+'&limit=50');
  assert.equal(result.import_status,'Still importing: 50% of 10 messages ready, so older history may be missing');
  assert.deepEqual(await run('archive_page',{chat:'-1002'},fake(call=>call.path.includes('pending')?{imports:[]}:new Status(403)).context),{error:'conversation_not_permitted'});
  const invalid=await run('archive_page',{from:'last week'},fake(call=>call.path.includes('pending')?{imports:[]}:new Status(400)).context);
  assert.equal(invalid.error,'invalid_page_request');assert.match(invalid.note,/YYYY-MM-DD/);
  assert.deepEqual(await run('archive_page',{},fake(()=>{throw Error('archive_scope_not_bound');}).context),{error:'archive_page_unavailable'});
  const meaning=fake(()=>({sources:[],learned:false}));
  assert.deepEqual(await run('memory_search',{query:'who sends the invoice',limit:50},meaning.context),{sources:[],learned:false});
  assert.deepEqual(meaning.calls.map(call=>[call.method,call.path,call.body]),[['POST',memoryRoutes.search,{query:'who sends the invoice',limit:10}]]);
  const idle=fake(()=>({}));
  assert.deepEqual(await run('memory_search',{query:' '},idle.context),{error:'memory_search_unavailable'});assert.equal(idle.calls.length,0);
});

test('an archived source keeps reaction removal and bounded current source links',async()=>{
  const record:any={source:'nocheh:event:'+ID,event:{scope:'-1',origin:'live',kind:'telegram_update',text:'',
    payload:{message_reaction:{date:1,user:{id:7},old_reaction:[{type:'emoji',emoji:'✅'}],new_reaction:[],chat:{title:'omitted metadata'},unrelated:'not evidence'}}},
    artifacts:[],derived:[],current_reactions:{sources:['nocheh:event:'+'b'.repeat(64)],complete:false}};
  const read=fake(()=>record);
  const result=await run('archive_read',{id:ID},read.context);
  assert.equal(result.reaction_observation.mode,'individual');assert.deepEqual(result.reaction_observation.new_reaction,[]);
  assert.deepEqual(result.reaction_observation.old_reaction,[{type:'emoji',emoji:'✅'}]);assert.deepEqual(result.current_reactions,record.current_reactions);
  assert.doesNotMatch(JSON.stringify(result),/omitted metadata|not evidence/);
  record.event.payload={message_reaction_count:{date:2,reactions:[{type:{type:'emoji',emoji:'👍'},total_count:2}]}};
  const aggregate=(await run('archive_read',{id:'nocheh:event:'+ID},read.context)).reaction_observation;
  assert.equal(aggregate.mode,'aggregate');assert.equal(aggregate.reactions[0].total_count,2);assert.equal('user' in aggregate,false);
  record.event.payload.message_reaction_count.reactions=['x'.repeat(7000)];
  assert.deepEqual((await run('archive_read',{id:ID},read.context)).reaction_observation,{mode:'aggregate',unavailable:'observation_size_limit'});
  // Text, artifacts and generated content are bounded and labelled apart from the original.
  delete record.current_reactions;record.event.text='y'.repeat(12001);
  record.artifacts=Array.from({length:60},(_,n)=>({id:String(n),kind:'voice',state:'ready',bytes:'omitted'}));
  record.derived=Array.from({length:6},(_,n)=>({id:String(n),kind:'transcript',content_base64:Buffer.from('z'.repeat(2500)).toString('base64'),provenance:{model:'synthetic',n}}));
  const bounded=await run('archive_read',{id:ID},read.context);
  assert.equal(bounded.text.length,12000);assert.equal(bounded.truncated,true);assert.deepEqual(bounded.current_reactions,{sources:[],complete:false});
  assert.equal(bounded.artifacts.length,50);assert.deepEqual(bounded.artifacts[0],{id:'0',kind:'voice',state:'ready'});
  assert.equal(bounded.derived.length,5);assert.equal(bounded.derived[0].text.length,2000);assert.equal(bounded.derived[0].provenance,'{"model":"synthetic","n":0}');
  assert.equal(read.calls.at(-1)!.path,'/v1/events/'+ID);
  const shared=fake(()=>({fact:'synthetic'}));
  assert.deepEqual(await run('archive_read',{id:'nocheh:filtered:'+ID},shared.context),{fact:'synthetic'});assert.equal(shared.calls[0]!.path,'/v1/memory/filtered/'+ID);
  const idle=fake(()=>record);
  for(const id of ['../secrets',7,'nocheh:shared:'+'A'.repeat(64)])assert.deepEqual(await run('archive_read',{id},idle.context),{error:'archive_source_unavailable'});
  assert.equal(idle.calls.length,0);
  assert.deepEqual(await run('archive_read',{id:ID},fake(()=>new Status(404)).context),{error:'archive_source_unavailable'});
});

test('background jobs are started, listed and stopped through the bound scope',async()=>{
  const jobs=fake(()=>({id:ID,state:'proposed'}));
  assert.equal((await run('background_job',{action:'start',title:'Open tasks',instruction:'Find open tasks.',chat:'-1002',from:'2026-01-01',to:'2026-02-01',scope:'ignored',limit:5,box:false},jobs.context)).state,'proposed');
  await run('background_job',{action:'status',title:'ignored',box:true},jobs.context);
  await run('background_job',{action:'stop',id:'b'.repeat(64),box:true},jobs.context);
  await run('background_job',{action:'start',title:'t',instruction:'i',box:true,repo:'example-org/widgets'},jobs.context);
  for(const repo of ['',null,7,['example-org/widgets']])await run('background_job',{action:'start',title:'t',instruction:'i',box:true,repo},jobs.context);
  await run('background_job',{action:'status',repo:'example-org/widgets'},jobs.context);
  assert.deepEqual(jobs.calls.map(call=>[call.path,call.body]),[
    ['/v1/jobs/start',{title:'Open tasks',instruction:'Find open tasks.',chat:'-1002',from:'2026-01-01',to:'2026-02-01',box:false}],
    ['/v1/jobs/status',{title:'ignored'}],['/v1/jobs/stop',{id:'b'.repeat(64)}],
    ['/v1/jobs/start',{title:'t',instruction:'i',box:true,repo:'example-org/widgets'}],
    ...Array(4).fill(['/v1/jobs/start',{title:'t',instruction:'i',box:true}]),['/v1/jobs/status',{}]]);
  for(const code of ['job_limit_reached','job_too_long','job_not_found','job_not_permitted','job_in_a_job','job_repo_not_allowed'])
    assert.deepEqual(await run('background_job',{action:'start',title:'t',instruction:'i'},fake(()=>new Status(409,{error:code})).context),{error:code});
  assert.deepEqual(await run('background_job',{action:'status'},fake(()=>new Status(503,{error:'private storage detail'})).context),{error:'background_jobs_unavailable'});
  assert.deepEqual(await run('background_job',{action:'status'},fake(()=>new Status(403,{error:'private storage detail'})).context),{error:'job_not_permitted'});
  const idle=fake(()=>({}));
  for(const action of ['delete','size','propose'])assert.deepEqual(await run('background_job',{action,title:'t',instruction:'i'},idle.context),{error:'background_jobs_unavailable'});
  // Only the isolated runtime has sealed boxes.
  assert.deepEqual(await run('background_job',{action:'start',title:'t',instruction:'i',box:true},fake(()=>({}),undefined,{isolated:false}).context),{error:'job_box_not_allowed'});
  assert.equal(idle.calls.length,0);
});

test('a machine and its plan are forwarded only with start and only from the isolated runtime',async()=>{
  const steps=['Install the build tools','Build the project','Report the test results'];
  const jobs=fake(()=>({id:ID,state:'proposed'}));
  await run('background_job',{action:'start',title:'t',instruction:'i',machine:'build-vm',steps},jobs.context);
  for(const [machine,plan] of [['',steps],[null,'Build it'],[7,null],[['build-vm'],{1:'Build'}]] as const)
    await run('background_job',{action:'start',title:'t',instruction:'i',machine,steps:plan},jobs.context);
  await run('background_job',{action:'status',machine:'build-vm',steps},jobs.context);
  await run('background_job',{action:'stop',id:'b'.repeat(64),machine:'build-vm',steps},jobs.context);
  assert.deepEqual(jobs.calls.map(call=>[call.path,call.body]),[
    ['/v1/jobs/start',{title:'t',instruction:'i',machine:'build-vm',steps}],['/v1/jobs/start',{title:'t',instruction:'i',steps}],
    ...Array(3).fill(['/v1/jobs/start',{title:'t',instruction:'i'}]),['/v1/jobs/status',{}],['/v1/jobs/stop',{id:'b'.repeat(64)}]]);
  // Its commands reach the machine only through the isolated runtime's broker.
  const plain=fake(()=>({}),undefined,{isolated:false});
  assert.deepEqual(await run('background_job',{action:'start',title:'t',instruction:'i',machine:'build-vm',steps},plain.context),{error:'isolated_runtime_required'});
  assert.equal(plain.calls.length,0);
  for(const code of ['job_machine_not_allowed','job_machine_not_found','job_card_too_long']) {
    const answer=await run('background_job',{action:'start',title:'t',instruction:'i',machine:'build-vm',steps},fake(()=>new Status(409,{error:code})).context);
    assert.equal(answer.error,code);delete answer.error;
    // A machine that is missing or not ready: the owner must add it and pass Test first.
    if(code==='job_machine_not_found') {
      for(const words of ['Settings › Machines','press Test','until the test passes','action=status'])assert.ok(answer.note.includes(words),words);
      delete answer.note;
    }
    assert.deepEqual(answer,{},code);
  }
  const schema=tool('background_job'),properties=(schema.inputSchema as any).properties;
  assert.deepEqual([properties.machine.type,properties.machine.maxLength],['string',40]);
  assert.ok(properties.machine.description.startsWith('For work on one of the owner\'s machines (see action=status machines): the machine\'s name and a short plan '+
    'of 1-12 steps the owner approves on one card. Only for the owner\'s own request in their private chat or a project group.'));
  assert.deepEqual([properties.steps.type,properties.steps.minItems,properties.steps.maxItems,properties.steps.items],['array',1,12,{type:'string',maxLength:200}]);
  assert.match(schema.description,/box or machine with steps/);assert.match(schema.description,/lists the owner's machines/);
  for(const name of ['machine','steps'])assert.ok(!(schema.inputSchema as any).required.includes(name));
});

const view=(text:string)=>({id:ID,kind:'mcp',state:'done',result:{content:text},error_code:null,fingerprint:'f'.repeat(64)});
test('a long action result comes in parts that join to the whole view',async()=>{
  // Synthetic Persian task text, so a part boundary can fall inside non-Latin text.
  const value=view('وظیفه ۱۲ انجام نشده است. '.repeat(2800)),status=fake(()=>value);
  const full=JSON.stringify({id:ID,kind:'mcp',state:'done',resolution:null,result:value.result,error_code:null});
  assert.ok(full.length>24000);
  const first=await run('action_status',{id:ID},status.context);
  const parts=[first];for(let n=2;n<=first.parts;n++)parts.push(await run('action_status',{id:ID,part:n},status.context));
  assert.equal(parts.map(part=>part.text).join(''),full);assert.equal(new Set(parts.map(part=>part.hash)).size,1);
  assert.ok(parts.every(part=>!JSON.stringify(part).includes('\\u06')));
  assert.deepEqual(new Set(status.calls.map(call=>call.path)),new Set(['/v1/tools/actions/'+ID]));
  assert.doesNotMatch(parts.map(part=>part.text).join(''),/fingerprint/);
  assert.deepEqual(await run('action_status',{id:ID,part:first.parts+1},status.context),{id:ID,error:'no_such_part',parts:first.parts});
  assert.equal(JSON.parse(inParts(view('Synthetic short page'))).result.content,'Synthetic short page');
  // Parts are counted in characters, so no boundary splits an emoji in two.
  const emoji=view('🙂'.repeat(30000)),whole=JSON.stringify({id:ID,kind:'mcp',state:'done',resolution:null,result:emoji.result,error_code:null});
  const pieces=[1,2].map(part=>JSON.parse(inParts(emoji,part)));
  assert.equal(pieces[0].parts,2);assert.equal(pieces.map(part=>part.text).join(''),whole);
  for(const piece of pieces)assert.doesNotMatch(piece.text,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  // A long mixed text cuts the same as counting characters one by one.
  const mixed=view(('a🙂ب'.repeat(5000)+'\uD800z').repeat(2)),joined=JSON.stringify({id:ID,kind:'mcp',state:'done',resolution:null,result:mixed.result,error_code:null});
  const count=JSON.parse(inParts(mixed,1)).parts,characters=Array.from(joined);
  assert.ok(count>1);for(let part=1;part<=count;part++)assert.equal(JSON.parse(inParts(mixed,part)).text,characters.slice((part-1)*20000,part*20000).join(''));
  const idle=fake(()=>value);
  for(const part of [0,'2',true,1.5])assert.deepEqual(await run('action_status',{id:ID,part},idle.context),{error:'invalid_part'});
  for(const id of ['../tools',7])assert.deepEqual(await run('action_status',{id},idle.context),{error:'controlled_action_unavailable'});
  assert.equal(idle.calls.length,0);
});

test('action status without an id lists operations without their content',async()=>{
  const listed={telegram:[{id:'b'.repeat(64),destination:'-100555',state:'proposed',error_code:null,created_at:'t',arguments:{text:'SECRET'}}],
    actions:[{id:ID,kind:'mcp',state:'ambiguous',error_code:null,resolution:'not_run',created_at:'t',result:'SECRET',arguments:{input:'SECRET'}}]};
  const status=fake(()=>listed),answer=await tool('action_status').run({},status.context);
  assert.deepEqual(status.calls.map(call=>[call.method,call.path,call.timeout]),[['GET','/v1/tools/actions',15000]]);
  assert.doesNotMatch(answer,/SECRET/);
  // How the owner closed an unclear one is listed too (ADR-0218).
  assert.deepEqual(JSON.parse(answer).operations,[{id:ID,kind:'mcp',state:'ambiguous',error_code:null,resolution:'not_run',created_at:'t'}]);
  assert.equal(JSON.parse(answer).requests[0].destination,'-100555');assert.equal(JSON.parse(answer).requests[0].resolution,null);
});

test('a summary travels beside the exact arguments',async()=>{
  // The asker's words go to the owner's card, never into what runs (ADR-0224).
  const waiting={id:ID,state:'proposed',message:'Review the exact operation.'},proposals=fake(()=>waiting);
  await run('browser',{url:'https://example.com/',summary:'Read the made-up page.'},proposals.context);
  await run('browser',{url:'https://example.com/',summary:'  '},proposals.context);
  await run('browser',{url:'https://example.com/',summary:5},proposals.context);
  await run('notion',{operation:'call',tool:'notion-create-pages',input:{pages:[]},summary:'Add a made-up page.'},proposals.context);
  assert.deepEqual(proposals.calls.map(call=>[call.path,call.body,call.timeout]),[
    ['/v1/tools/propose',{kind:'browser',arguments:{url:'https://example.com/'},summary:'Read the made-up page.'},60000],
    ['/v1/tools/propose',{kind:'browser',arguments:{url:'https://example.com/'}},60000],
    ['/v1/tools/propose',{kind:'browser',arguments:{url:'https://example.com/'}},60000],
    ['/v1/tools/propose',{kind:'mcp',arguments:{connection:'notion',tool:'notion-create-pages',input:{pages:[]}},summary:'Add a made-up page.'},60000]]);
});

test('an operation already allowed answers in this turn',async()=>{
  // A rule or the owner's freedom setting lets it run now: the tool waits and returns the result (ADR-0215).
  const value={...view('Synthetic forecast'),kind:'browser'},step=(answers:unknown[])=>fake(()=>{const answer=answers.shift();if(answer instanceof Error)throw answer;return answer;});
  const allowed={id:ID,state:'proposed',allowed:true,message:'Allowed by a rule'};
  const ran=step([allowed,{id:ID,state:'running'},value,{id:ID,state:'done'}]);
  assert.equal(await tool('browser').run({url:'https://example.com/'},ran.context),inParts(value));
  assert.deepEqual(ran.calls.map(call=>call.path),['/v1/tools/propose','/v1/tools/actions/'+ID,'/v1/tools/actions/'+ID,'/v1/tools/actions/'+ID+'?in_turn=done'],
    'only once it holds the result does the turn tell Nocheh which state it read');
  assert.ok(ran.calls[1]!.timeout>=15000&&ran.calls[1]!.timeout<=60000);assert.equal(ran.calls[3]!.timeout,15000);
  // A lost note still returns the result; the follow-up then repeats it rather than dropping it.
  assert.equal(await tool('browser').run({url:'https://example.com/'},step([allowed,value,timeout()]).context),inParts(value));
  // One that waits for the owner answers at once.
  const asked={id:ID,state:'proposed',message:'Approve and Reject buttons were sent'},card=fake(()=>asked);
  assert.deepEqual(await run('browser',{url:'https://example.com/'},card.context),asked);assert.equal(card.calls.length,1);
  // A failed read or a slow one returns the proposal, whose answer then follows in the chat.
  const runs={id:ID,state:'approved',allowed:true,message:'It runs now; its answer will follow here.'};
  for(const later of [new Status(404),timeout(),new Error('connection reset')])
    assert.equal((await run('browser',{url:'https://example.com/'},step([runs,later]).context)).message,runs.message);
});

test('a failed proposal says whether asking again can help, and a tool the owner turned off says so',async()=>{
  for(const [raised,error,note] of [[timeout(),'action_request_timed_out','Ask again in a moment'],[new Error('connection refused'),'controlled_action_unavailable','not a setting or a limit of this chat'],
    [new Status(503),'controlled_action_unavailable','not a setting or a limit of this chat'],[new Status(403),'not_allowed_here',null],[new Status(400),'invalid_action_request',null],
    [new Status(403,{error:'tool_disabled_by_owner'}),'tool_disabled_by_owner',null]] as const) {
    const answer=await run('browser',{url:'https://example.com/'},fake(()=>{if(raised instanceof Error)throw raised;return raised;}).context);
    assert.equal(answer.error,error);
    if(note)assert.ok(answer.note.includes(note));else assert.equal('note' in answer,false);
  }
  for(const name of ['shell','mcp'])assert.deepEqual(await run(name,{command:'true',url:'https://example.com/mcp'},fake(()=>new Status(403,{error:'tool_disabled_by_owner'})).context),{error:'tool_disabled_by_owner'});
  assert.deepEqual(await run('notion',{operation:'list'},fake(()=>new Status(403,{error:'tool_disabled_by_owner'})).context),{error:'tool_disabled_by_owner'});
  assert.deepEqual(await run('notion',{operation:'list'},fake(()=>new Status(403)).context),{error:'notion_only_in_owner_private_chat'});
  assert.deepEqual(await run('notion',{operation:'list'},fake(()=>new Status(409)).context),{error:'notion_is_off_or_changed'});
  assert.deepEqual(await run('notion',{operation:'list'},fake(()=>{throw timeout();}).context),{error:'notion_unavailable'});
});

test('a Notion answer matches the first part and keeps its id on a slow poll',async()=>{
  const value=view('Synthetic row. '.repeat(3000)),answers:unknown[]=[{id:ID,state:'approved'},value,{id:ID,state:'done'}];
  const called=fake(()=>answers.shift());
  assert.equal(await tool('notion').run({operation:'call',tool:'notion-fetch',input:{id:'synthetic'}},called.context),inParts(value));
  assert.deepEqual(called.calls[0]!.body,{kind:'mcp',arguments:{connection:'notion',tool:'notion-fetch',input:{id:'synthetic'}}});
  const slow:unknown[]=[{id:ID,state:'approved'},timeout()];
  const waited=fake(call=>{const answer=slow.shift();if(answer instanceof Error){assert.ok(call.timeout<=60000);throw answer;}return answer;});
  assert.deepEqual(await run('notion',{operation:'call',tool:'notion-fetch',input:{}},waited.context),{id:ID,state:'running',note:'Still running; read it later with mcp__nocheh__action_status.'});
  const listed=fake(()=>({id:ID,state:'proposed'}));await run('notion',{operation:'list',tool:'ignored'},listed.context);
  assert.deepEqual(listed.calls[0]!.body,{kind:'mcp',arguments:{connection:'notion',operation:'list'}});
});

test('the knowledge tools use exact routes and keep the proposal content',async()=>{
  const proposal={operation_id:'synthetic-proposal',proposal:{kind:'organization',reason:'Organize the selected project',
    creates:[{key:'project',name:'Example',evidence_ids:['b'.repeat(64)]}],assignments:[]}};
  const known=fake(()=>({id:ID,state:'review'}),{scope:null,admin:false});
  assert.equal((await run('knowledge_propose',proposal,known.context)).state,'review');
  assert.equal((await run('knowledge_status',{id:ID},known.context)).state,'review');
  await run('knowledge_inspect',{space:'-100/topic/8',q:'Two words',after:ID},known.context);
  await run('knowledge_inspect',{entity_id:ID,claims_after:'b'.repeat(64)},known.context);
  await run('knowledge_inspect',{},known.context);
  assert.deepEqual(known.calls.map(call=>[call.method,call.path,call.body]),[['POST','/v1/knowledge/proposals',proposal],['GET','/v1/knowledge/proposals/'+ID,undefined],
    ['GET','/v1/knowledge/context?space=-100%2Ftopic%2F8&q=Two+words&after='+ID,undefined],['GET','/v1/knowledge/context?entity_id='+ID+'&claims_after='+'b'.repeat(64),undefined],
    ['GET','/v1/knowledge/context',undefined]]);
  // No identity, credential or route chosen by the model is forwarded.
  const idle=fake(()=>({}));
  for(const args of [{id:'../delegations'},{id:ID,credential:'secret'},{id:ID,owner:true}])assert.ok((await run('knowledge_status',args,idle.context)).error);
  for(const args of [{scope:'owner'},{url:'/v1/projects'},{q:false},{after:'../x'}])assert.ok((await run('knowledge_inspect',args,idle.context)).error);
  for(const args of [{operation_id:'x',proposal:{},approved:true},{operation_id:'',proposal:{}},{proposal:{}},{operation_id:'x',proposal:[]}])
    assert.ok((await run('knowledge_propose',args,idle.context)).error);
  assert.equal(idle.calls.length,0);
  assert.deepEqual(await run('knowledge_status',{id:ID},fake(()=>new Status(409,{error:'knowledge_proposal_changed'})).context),{error:'knowledge_proposal_changed'});
  assert.deepEqual(await run('knowledge_inspect',{},fake(()=>new Status(503,{error:'private source words'})).context),{error:'knowledge_unavailable'});
  assert.deepEqual(await run('knowledge_inspect',{},fake(()=>({content:'x'.repeat(65000)})).context),{error:'knowledge_response_too_large',partial:true});
});

test('the task tool uses only the owner task routes and explains failures',async()=>{
  const tasks=fake(()=>({tasks:[]}),{scope:null,admin:false});
  await run('tasks',{action:'list',state:'done'},tasks.context);
  await run('tasks',{action:'add',title:'Call the bank',due_on:'2030-01-04',scope:'personal',tags:['Money'],people:[ID],group:'-100'},tasks.context);
  await run('tasks',{action:'list',scope:ID,tag:'Launch',person:ID},tasks.context);
  await run('tasks',{action:'update',id:ID,expected_revision:2,state:'done'},tasks.context);
  await run('tasks',{action:'list',when:'today',sort:'priority',priority:0},tasks.context);
  await run('tasks',{action:'get',id:ID},tasks.context);
  await run('tasks',{action:'comment',id:ID,text:'Waiting on a made-up reply'},tasks.context);
  await run('tasks',{action:'update',id:ID,expected_revision:3,status:'Waiting',priority:'High',reminders:['2030-01-04T09:00'],repeat:{every:1,unit:'week'},assignees:[ID],trashed:true,external:{notion:'x'}},tasks.context);
  assert.deepEqual(tasks.calls.map(call=>[call.method,call.path,call.body]),[
    ['GET','/v1/owner/tasks?state=done',undefined],
    ['POST','/v1/owner/tasks',{title:'Call the bank',scope:'personal',due_on:'2030-01-04',group:'-100',people:[ID],tags:['Money']}],
    ['GET','/v1/owner/tasks?scope='+ID+'&tag=Launch&person='+ID,undefined],
    ['POST','/v1/owner/tasks/'+ID,{expected_revision:2,state:'done'}],
    ['GET','/v1/owner/tasks?when=today&priority=0&sort=priority',undefined],
    ['GET','/v1/owner/tasks/'+ID,undefined],
    ['POST','/v1/owner/tasks/'+ID+'/comments',{text:'Waiting on a made-up reply'}],
    ['POST','/v1/owner/tasks/'+ID,{expected_revision:3,status:'Waiting',priority:'High',repeat:{every:1,unit:'week'},assignees:[ID],reminders:['2030-01-04T09:00'],trashed:true}]]);
  const idle=fake(()=>({}));
  assert.deepEqual(await run('tasks',{action:'update',id:'../tasks',state:'done'},idle.context),{error:'invalid_task_id'});
  assert.deepEqual(await run('tasks',{action:'delete'},idle.context),{error:'invalid_task_action'});
  assert.equal(idle.calls.length,0);
  for(const [status,code] of [[409,'task_changed_list_again'],[403,'not_available_in_this_chat'],[404,'task_not_found'],[400,'invalid_task_request'],[500,'tasks_unavailable']] as const)
    assert.equal((await run('tasks',{action:'list'},fake(()=>new Status(status,{})).context)).error,code);
  const long=await run('tasks',{action:'list'},fake(()=>({tasks:['x'.repeat(30000)]})).context);
  assert.equal(long.truncated,true);assert.equal(long.excerpt.length,22000);assert.match(long.note,/Narrow the list/);
  assert.deepEqual(await run('tasks',{action:'comment',id:ID,text:'t'},fake(()=>({comment:'x'.repeat(30000)})).context),{id:ID,commented:true});
});

test('owner directory, destinations and message requests keep their routes and plain failures',async()=>{
  const owner=fake(()=>({conversations:[]}),{scope:null,admin:false});
  await run('owner_read',{view:'conversation-context',space:'-1001',q:'',after:'x'},owner.context);
  await run('action_request',{destination:'current',text:'Synthetic note'},owner.context);
  await run('telegram_destinations',{},owner.context);
  assert.deepEqual(owner.calls.map(call=>[call.method,call.path,call.body]),[['GET','/v1/owner/conversation-context?space=-1001&after=x',undefined],
    ['POST','/v1/action-requests',{destination:'current',text:'Synthetic note'}],['GET','/v1/telegram/destinations',undefined]]);
  const long=await run('owner_read',{view:'people'},fake(()=>({people:['x'.repeat(30000)]})).context);
  assert.equal(long.view,'people');assert.equal(long.excerpt.length,22000);assert.equal(long.truncated,true);
  const idle=fake(()=>({}));
  assert.equal((await run('owner_read',{view:'secrets'},idle.context)).error,'owner_read_unavailable');
  assert.deepEqual(await run('action_request',{text:'no destination'},idle.context),{error:'action_request_unavailable'});
  assert.equal(idle.calls.length,0);
  assert.equal((await run('telegram_destinations',{},fake(()=>new Status(403)).context)).note,'Available only in a group conversation.');
});

test('PostgreSQL broker: the data tools reach each route through the broker\'s own checks',{skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace='mcp_broker_'+Date.now();await admin.query('CREATE SCHEMA '+namespace);
  const pool=new pg.Pool({...connection,options:'-c search_path='+namespace});
  const token='synthetic-service-token-only-for-tests',archived:{url:string;method:string;auth:string;body:unknown}[]=[];
  const mock:typeof fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname;
    archived.push({url:String(url),method:init?.method??'GET',auth:new Headers(init?.headers).get('authorization')??'',body:init?.body?JSON.parse(String(init.body)):null});
    if(path==='/v1/imports/pending')return Response.json({imports:[]});
    if(path==='/v1/search')return Response.json([{id:'nocheh:source:'+ID}]);
    if(path==='/v1/tools/propose')return Response.json({error:'tool_disabled_by_owner'},{status:403});
    if(path==='/v1/tools/actions')return Response.json({telegram:[],actions:[{id:ID,kind:'browser',state:'done',created_at:'t',result:'SECRET'}]});
    if(path==='/v1/jobs/start')return Response.json({error:'private storage detail'},{status:409});
    return Response.json({error:'not_found'},{status:404});
  };
  const server=brokerServer({pool,token,archive:'http://archive',prepare:async()=>({}),hermes:'http://hermes',model:'synthetic',fetch:mock});
  try {
    await initialize(pool);
    const event=await ingest(pool,{version:1,key:'mcp-turn',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'1',revision:'0',occurred_at:null,text:'exact source',payload:{profile:'owner'}},false);
    const base=await listen(server),credential=turnToken(token,null,Date.now()+600000,event.id,{space:'1',revision:1,guard_epoch:1});
    const call=async(name:string,args:Record<string,unknown>,key=credential)=>{
      const response=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      const body=await response.json() as any;return response.ok&&body.result?JSON.parse(body.result.content[0].text):{status:response.status,...body};
    };
    assert.deepEqual(await call('archive_search',{query:'Friday'}),{sources:[{id:'nocheh:source:'+ID}],filter_status:null});
    assert.deepEqual(archived.map(item=>[item.method,item.url,item.auth]),[['GET','http://archive/v1/imports/pending','Bearer '+credential],['GET','http://archive/v1/search?q=Friday&limit=5','Bearer '+credential]]);
    // Each read is an effect the broker checked, labelled with the turn's brain.
    const effects=(await pool.query("SELECT DISTINCT kind,brain FROM security_events WHERE state='completed'")).rows;
    assert.deepEqual(effects,[{kind:'archive.read',brain:'hermes'}]);
    // The owner's switch reaches the brain as itself; any other refusal stays opaque.
    assert.deepEqual(await call('browser',{url:'https://example.com/'}),{error:'tool_disabled_by_owner'});
    assert.deepEqual(await call('background_job',{action:'start',title:'t',instruction:'i'}),{error:'background_jobs_unavailable'});
    assert.deepEqual(await call('action_status',{}),{requests:[],operations:[{id:ID,kind:'browser',state:'done',error_code:null,resolution:null,created_at:'t'}]});
    assert.equal(archived.at(-1)!.url,'http://archive/v1/tools/actions');
    // Without a turn's own pass nothing runs.
    assert.equal((await call('archive_search',{query:'Friday'},token)).status,403);
    assert.equal((await call('archive_search',{query:'Friday'},'turn.forged.pass')).status,401);
  }finally{await close(server);await pool.end();await admin.query('DROP SCHEMA '+namespace+' CASCADE');await admin.end();}
});
