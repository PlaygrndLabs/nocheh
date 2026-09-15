/** Explicit acceptance fixture, never a production entrypoint. All corpus data is synthetic. */
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {settings} from '../src/config.js';
import {connectDatabase,initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {turnToken,reader,assertAudience} from '../src/access.js';
import {readJson,json,HttpError,object} from '../src/http.js';
import {prepareContext} from '../src/prepared-context.js';
import {prepareGuarded} from '../src/guarded.js';
import {inspectRequest} from '../src/guard.js';
import {search,readEvent} from '../src/retrieval.js';
import {brokerServer,turnBinding} from '../src/security/broker.js';
import {effectLog} from '../src/security/store.js';

if(process.env.NOCHEH_SECURITY_FIXTURE!=='synthetic-only')throw Error('acceptance_fixture_opt_in_required');
const config=settings(),pool=connectDatabase(config);
await initialize(pool);
const firstCursor=String((await pool.query('SELECT COALESCE(max(id),0) AS id FROM security_events')).rows[0].id);
const provider=JSON.parse(await readFile('/fixture/provider.json','utf8'));
const evidence='Archive record: The Cedar launch is on 18 October. Its budget is 420 credits. The earlier 300-credit draft was superseded.';
const source=await ingest(pool,{version:1,key:'security-acceptance-source',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'source',revision:'0',occurred_at:null,text:evidence,payload:{}},false);
const turn=await ingest(pool,{version:1,key:'security-acceptance-turn',origin:'live',kind:'message',channel:'browser',bot_id:'fixture',scope:'1',source_id:'turn',revision:'0',occurred_at:null,text:'Synthetic security acceptance',payload:{profile:'owner'}},false);
const detect=async(text:string)=>text.includes('SYNTHETIC_TEST_SECRET')?['SYNTHETIC_TEST_SECRET']:[];
await prepareGuarded(pool,detect,undefined,undefined,undefined,{owner:'inngest',epoch:1});
const credential=turnToken(config.token,null,Date.now()+3600000,turn.id,{space:'1',revision:1,guard_epoch:1});
const principal=reader({headers:{authorization:'Bearer '+credential}} as any,config.token);
const binding=await turnBinding(pool,principal);
const recalled={limited_memory:false,hits:[{source:'nocheh:event:'+source.id,text:'Retrieved planning note: Mina owns Cedar. The backup owner is Jules. Cite the archive record when stating the launch date or budget.'}]};
const backend=createServer((req,res)=>{void(async()=>{
  if(req.url==='/internal/security/transport')return json(res,200,provider);
  const principal=reader(req,config.token);await assertAudience(pool,principal);
  const url=new URL(req.url??'/','http://fixture'),body=req.method==='POST'?await readJson(req):null;
  const prepare=(value:unknown)=>prepareContext(pool,principal,value,detect);
  if(url.pathname==='/v1/guard'){inspectRequest(object(body).payload);return json(res,200,{guarded:true,payload:await prepare(object(body).payload)});}
  if(url.pathname==='/v1/context/prepare')return json(res,200,await prepare(body));
  if(url.pathname==='/v1/memory/check')return json(res,200,{valid:true});
  if(['/v1/memory/honcho/recall','/v1/memory/honcho/context'].includes(url.pathname))return json(res,200,await prepare(recalled));
  if(url.pathname==='/v1/memory/recall')return json(res,200,{hits:[],truncated:false,next_profile:null});
  if(url.pathname==='/v1/search')return json(res,200,await search(pool,principal,url.searchParams.get('q')??'',10));
  if(/^\/v1\/events\/[a-f0-9]{64}$/.test(url.pathname))return json(res,200,await readEvent(pool,principal,url.pathname.split('/').at(-1)!));
  throw new HttpError(403,'fixture_route_denied');
})().catch(error=>json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'fixture_failed'}));});
await new Promise<void>(resolve=>backend.listen(8799,'127.0.0.1',resolve));
const server=brokerServer({pool,token:config.token,model:provider.model,archive:'http://127.0.0.1:8799',prepare:async(principal,input)=>{inspectRequest(object(input).payload);return {guarded:true,payload:await prepareContext(pool,principal,object(input).payload,detect)};},hermes:'http://127.0.0.1:8799'});
await new Promise<void>(resolve=>server.listen(8786,'0.0.0.0',resolve));
await writeFile('/fixture/ready.json',JSON.stringify({...binding,credential,model:provider.model,api_mode:provider.api_mode,source:'nocheh:event:'+source.id}));
const timer=setInterval(()=>{void(async()=>{
  let cursor=firstCursor;const events=[];
  for(;;){const page=await effectLog(pool,{admin:true,scope:null},cursor);events.push(...page.events);if(!page.next)break;cursor=page.next;}
  await writeFile('/fixture/effects.json',JSON.stringify({events,next:null}));
})().catch(()=>{});},1000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();void pool.end();});
