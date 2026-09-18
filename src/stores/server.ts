import {createServer} from 'node:http';
import {join} from 'node:path';
import {admin,reader} from '../access.js';
import {canonical,digest,envelope} from '../archive.js';
import type {Settings} from '../config.js';
import {HttpError,authorize,json,object,readJson,string} from '../http.js';
import {limit} from '../retrieval.js';
import type {RuntimeCall} from '../runtime.js';
import {immutableFile} from '../storage.js';
import {ownerSecurityRoute} from '../security/owner-api.js';
import {captureEvidence} from './generated-capture.js';
import {OwnerStorageApi} from './owner-api.js';
import type {StorageServices} from './services.js';
import {assertStorageActive,assertGuardConfiguration,restoredInactive,storageHealth} from './lifecycle.js';

/** No legacy pool, schema initialization, cross-store SQL or fallback route. */
export function storageServer(s:StorageServices,config:Settings,call:RuntimeCall,status:()=>unknown=()=>({})) {
  const owner=new OwnerStorageApi(s);
  const server=createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url??'/','http://local'),path=url.pathname;
    if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,service:config.service,storage_layout:'original-only-v1',
      databases:await storageHealth(s.stores),inactive:restoredInactive(config.dataDir),workers:status()});
    assertStorageActive(config.dataDir);
    if(req.method==='POST'&&path==='/internal/honcho/prepare') {
      if(!config.memoryToken)throw new HttpError(503,'memory_gateway_unconfigured');authorize(req,config.memoryToken);
      await assertGuardConfiguration(s.guards,config.guardMode);
      await s.configuration.assert(config.assistant);
      return json(res,200,await s.memory.prepareRequest(await readJson(req,1024*1024)));
    }
    const principal=reader(req,config.token);
    // Durable admission depends only on the owned filesystem. Database and
    // workflow outages leave an acknowledged observation available for replay.
    if(req.method==='POST'&&path==='/v1/ingest') {
      admin(principal);const value=envelope(await readJson(req,16*1024*1024));captureEvidence(value);
      await immutableFile(join(config.dataDir,'spool','pending'),digest(value.key)+'.json',Buffer.from(canonical(value)));
      return json(res,202,{id:digest(value.key),state:'spooled'});
    }
    // Owners can inspect and repair incomplete guard changes; scoped callers
    // must observe the complete current authorization generation on every call.
    if(!principal.admin){await s.turns.assertAudience(principal);await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);}
    if(await owner.handle(principal,req,res,url))return;
    if(await ownerSecurityRoute(s.stores.control,principal,req,res,url,{separated:true}))return;
    const result=async(value:unknown,prepared=false)=>{
      if(!principal.admin){if(prepared)await s.prepared.allow(principal,value);else value=await s.prepared.prepare(principal,value,s.detect);await s.turns.assertAudience(principal);}
      return json(res,200,value);
    };
    if(path==='/v1/context/prepare'&&req.method==='POST') {
      if(principal.admin)throw new HttpError(403,'scoped_turn_required');await s.turns.binding(principal);
      return result(await readJson(req,1024*1024));
    }
    if(path==='/v1/memory/check'&&req.method==='GET')return json(res,200,{valid:true});
    if(path==='/v1/memory/honcho') {
      admin(principal);
      if(req.method==='GET')return json(res,200,await s.memory.status());
      if(req.method==='POST')return json(res,200,await s.memory.connection(principal,await readJson(req)));
    }
    if(path==='/v1/memory/honcho/verify'&&req.method==='POST'){admin(principal);return json(res,200,await s.memory.acceptVerification(principal,await readJson(req)));}
    if(req.method==='POST'&&['/v1/memory/honcho/context','/v1/memory/honcho/recall'].includes(path)) {
      if(principal.admin)throw new HttpError(403,'scoped_memory_context_required');await s.turns.binding(principal);
      const body=object(await readJson(req));return result(path.endsWith('/context')?await s.memory.context(principal):await s.memory.recall(principal,string(body.query??'',2000)),true);
    }
    if(path==='/v1/memory/context'&&req.method==='GET')return result(await s.shared.context(principal,url.searchParams.get('q')??''),true);
    const shared=path.match(/^\/v1\/memory\/(?:shared|filtered)\/([a-f0-9]{64})$/);
    if(shared&&req.method==='GET')return result(await s.shared.read(principal,shared[1]!),true);
    if(path==='/v1/memory/recall'&&req.method==='POST') {
      if(principal.scope!==null)throw new HttpError(403,'owner_memory_required');
      const input=object(await readJson(req)),binding=await s.guards.state();
      if(!principal.admin)await s.turns.binding(principal);
      return result(await call('memory.recall',{...input,guard_epoch:binding.epoch,generation:binding.generation}));
    }
    if(path==='/v1/memory/reviews'&&req.method==='GET'){admin(principal);return json(res,200,await s.reviews.list(principal,url.searchParams.get('after')??''));}
    if(path==='/v1/memory/reviews/control'&&req.method==='POST') {
      admin(principal);const body=object(await readJson(req));
      return json(res,200,await s.reviews.controlJob(principal,string(body.id,64),{action:body.action,expected_revision:body.expected_revision}));
    }
    if(req.method==='GET') {
      if(path==='/v1/search')return result(await s.sources.search(principal,url.searchParams.get('q')??'',limit(url.searchParams.get('limit'))),true);
      if(path==='/v1/graph')return json(res,200,await s.sources.graph(principal,url.searchParams.get('scope')??'*',url.searchParams.get('after')??'',limit(url.searchParams.get('limit')),url.searchParams.get('focus')??''));
      const event=path.match(/^\/v1\/events\/([a-f0-9]{64})$/);
      if(event)return result(await s.sources.read(principal,event[1]!),true);
      const file=path.match(/^\/v1\/artifacts\/([a-f0-9]{64})\/bytes$/);
      if(file){const bytes=await s.sources.bytes(principal,file[1]!);res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});return res.end(bytes);}
      admin(principal);
      if(path==='/v1/scopes') {
        const rows=(await s.stores.archive.query('SELECT scope,count(*)::integer AS events FROM events WHERE scope>$1 GROUP BY scope ORDER BY scope LIMIT 101',[url.searchParams.get('after')??''])).rows;
        return json(res,200,{scopes:rows.slice(0,100),next:rows.length>100?rows[99].scope:null});
      }
      if(path==='/v1/data') {
        const after=url.searchParams.get('after')??'';if(after&&!/^[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_cursor');
        const rows=(await s.stores.archive.query('SELECT id,channel,scope,source_id,revision,kind,origin,occurred_at,received_at,original_text FROM events WHERE id>$1 ORDER BY id LIMIT 51',[after])).rows;
        return json(res,200,{records:rows.slice(0,50).map(row=>({...row,original_text:undefined,text:row.original_text?.toString()??null})),next:rows.length>50?rows[49].id:null});
      }
      if(path==='/v1/status')return json(res,200,{service:config.service,storage_layout:'original-only-v1',guard:await s.guards.state(),
        services:(await s.stores.control.query('SELECT service,seen_at FROM service_heartbeats ORDER BY service')).rows,workers:status()});
    }
    throw new HttpError(404,'not_found');
  })().catch(error=>{
    if(res.headersSent){res.destroy();return;}
    json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'service_unavailable'});
  });});
  server.requestTimeout=30000;return server;
}
