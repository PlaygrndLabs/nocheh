import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {reader,assertAudience,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {HttpError,json,readJson,object} from '../http.js';
import {manifest,fingerprint,type Effect,type Decision} from './contract.js';
import {evaluate,recordEffect} from './store.js';
import {ownerSecurityRoute} from './owner-api.js';
import {providerPayload} from './provider-request.js';

export interface BrokerOptions {pool:pg.Pool; token:string; archive:string; prepare:(principal:Reader,input:unknown)=>Promise<any>; hermes:string; model:string; fetch?:typeof fetch;}
const relayRoutes:[string,RegExp][]=[
  ['GET',/^\/v1\/(search|events\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64}\/bytes|memory\/check|memory\/context|memory\/(shared|filtered)\/[a-f0-9]{64}|tools\/actions\/[a-f0-9]{64})$/],
  ['POST',/^\/v1\/(context\/prepare|memory\/(recall|honcho\/(recall|context))|tools\/propose|action-requests)$/],
];
export function scopedRoute(method:string,path:string):boolean {return relayRoutes.some(([m,re])=>method===m&&re.test(path));}
export function providerTarget(transport:Record<string,unknown>,path:string):string {
  if(transport.base_url==='https://chatgpt.com/backend-api/codex'&&transport.api_mode==='codex_responses'&&path==='/codex/responses')return transport.base_url+'/responses';
  if(transport.base_url==='http://cliproxy:8317/v1'&&transport.api_mode==='chat_completions'&&path==='/v1/chat/completions')return transport.base_url+'/chat/completions';
  throw new HttpError(403,'provider_route_denied');
}
export async function turnBinding(pool:pg.Pool,principal:Reader) {
  if(principal.admin||!principal.turnEvent||!principal.space||principal.guard_epoch===undefined)throw new HttpError(403,'scoped_turn_required');
  await assertAudience(pool,principal);
  const event=(await pool.query<{scope:string;payload:Buffer;channel:string;managed:boolean}>('SELECT scope,payload,channel,EXISTS(SELECT 1 FROM managed_runs WHERE event_id=events.id) AS managed FROM events WHERE id=$1',[principal.turnEvent])).rows[0];
  if(!event||(principal.scope!==null&&principal.scope!==event.scope))throw new HttpError(403,'turn_source_denied');
  const profile='nocheh-'+digest(principal.space+':policy:'+(principal.scope===null?0:principal.revision)+':guard:'+principal.guard_epoch).slice(0,24);
  const payload=object(JSON.parse(event.payload.toString()));
  const logicalProfile=event.managed&&typeof payload.profile==='string'?payload.profile:
    'nocheh-'+digest(principal.scope===null?event.scope:principal.space+':policy:'+principal.revision).slice(0,24);
  return {event_id:principal.turnEvent,scope:event.scope,profile,logical_profile:logicalProfile,owner:principal.scope===null,
    guard_epoch:principal.guard_epoch,revision:principal.revision,
    ...(event.managed&&event.channel==='scheduler'&&typeof payload.job_id==='string'?{job:payload.job_id}:{})};
}
async function boundedJson(response:Response,max=2*1024*1024):Promise<unknown> {
  if(!response.ok){await response.body?.cancel();throw new HttpError(response.status>=400&&response.status<500?response.status:503,'security_upstream_unavailable');}
  const chunks=[];let size=0;
  if(response.body)for await(const part of response.body){size+=part.length;if(size>max)throw new HttpError(413,'security_response_limit');chunks.push(Buffer.from(part));}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new HttpError(503,'invalid_security_upstream');}
}
export function brokerServer(options:BrokerOptions) {
  const call=options.fetch??fetch;
  return createServer((req,res)=>{void handle(req,res).catch(error=>{
    if(res.headersSent){res.destroy();return;}
    json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'security_service_unavailable'});
  });});
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const url=new URL(req.url??'/','http://security'),path=url.pathname;
    if(req.method==='GET'&&path==='/health'){await options.pool.query('SELECT 1');return json(res,200,{ok:true,service:'security',plugin:manifest.id,api_version:1});}
    const principal=reader(req,options.token);
    if(principal.admin&&path==='/v1/guard'&&req.method==='POST')return json(res,200,await options.prepare(principal,await readJson(req,1024*1024)));
    if(path!=='/v1/security/binding'&&await ownerSecurityRoute(options.pool,principal,req,res,url))return;
    const binding=await turnBinding(options.pool,principal);
    const credential=req.headers.authorization!;
    // A cold Honcho recall includes multiple guarded provider calls. Keep other
    // broker operations on their shorter deadline; cancellation still aborts both.
    const timeout=req.method==='POST'&&path==='/v1/memory/honcho/recall'?600000:120000;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    const closed=()=>{if(!res.writableEnded)controller.abort();};res.on('close',closed);
    let trace:{effect:Effect;decision:Decision;started:boolean;closed:boolean}|undefined;
    const authorizeEffect=async(kind:Effect['kind'],value:unknown)=>{
      const effect:Effect={id:randomUUID(),kind,scope:binding.scope,profile:binding.logical_profile,fingerprint:fingerprint(value),...(binding.job?{job:binding.job}:{})};
      const decision=await evaluate(options.pool,effect);
      trace={effect,decision,started:false,closed:false};
      await recordEffect(options.pool,effect,'proposed',decision,binding.event_id);
      await recordEffect(options.pool,effect,decision.outcome==='allow'?'allowed':'blocked',decision,binding.event_id);
      if(decision.outcome!=='allow'){trace.closed=true;throw new HttpError(403,'security_policy_denied');}
      return trace;
    };
    try {
      const rpc=async(base:string,route:string,body:unknown,authorization=credential)=>boundedJson(await call(base+route,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal}));
      if(path==='/v1/security/binding'&&req.method==='GET') {
        const transport=object(await rpc(options.hermes,'/internal/security/transport',{metadata:true},'Bearer '+options.token));
        if(!Number.isSafeInteger(transport.model_context_length)||Number(transport.model_context_length)<1)throw new HttpError(503,'model_context_metadata_required');
        return json(res,200,{...binding,model:options.model,model_context_length:transport.model_context_length,plugin:manifest});
      }
      if(path==='/v1/guard'&&req.method==='POST') {
        const body=object(await readJson(req,1024*1024));
        // Preparation is separate from permission to transmit. Destination is not forwarded.
        return json(res,200,await options.prepare(principal,{destination:'https://chatgpt.com/backend-api/codex',payload:body.payload}));
      }
      let relay=path;
      const file=path.match(/^\/v1\/turn-files\/([a-f0-9]{64})$/);
      if(file&&req.method==='GET') {
        const artifact=(await options.pool.query<{id:string}>('SELECT id FROM artifacts WHERE event_id=$1 AND file_hash=$2 AND state=\'ready\' LIMIT 1',[principal.turnEvent,file[1]])).rows[0];
        if(!artifact)throw new HttpError(404,'turn_file_not_found');
        relay='/v1/artifacts/'+artifact.id+'/bytes';
      }
      if(scopedRoute(req.method??'',relay)) {
        const body=req.method==='POST'?JSON.stringify(await readJson(req,1024*1024)):undefined;
        // Context preparation and proposals have their own enforcement. Read policies
        // apply to retrieval; native memory remains writable within the owned profile.
        if(relay!=='/v1/context/prepare'&&!['/v1/tools/propose','/v1/action-requests'].includes(relay))await authorizeEffect(relay.includes('/memory/')?'memory.read':'archive.read',{relay,query:url.search});
        const response=await call(options.archive+relay+url.search,{method:req.method!,headers:{authorization:credential,'content-type':'application/json'},...(body===undefined?{}:{body}),redirect:'error',signal:controller.signal});
        if(!response.ok){await response.body?.cancel();throw new HttpError(response.status,'scoped_archive_unavailable');}
        await stream(response,principal,res,file?26*1024*1024:8*1024*1024);
        if(trace){await recordEffect(options.pool,trace.effect,'completed',trace.decision,binding.event_id);trace.closed=true;}return;
      }
      if(req.method!=='POST'||!['/codex/responses','/v1/chat/completions'].includes(path)||url.search)throw new HttpError(403,'security_route_denied');
      const input=await readJson(req,1024*1024);let payload:Record<string,unknown>;
      try {
        payload=providerPayload(input);
        if(payload.model!==options.model)throw new HttpError(403,'model_configuration_mismatch');
      }catch(error){
        if(error instanceof HttpError){
          const effect:Effect={id:randomUUID(),kind:'model.request',scope:binding.scope,profile:binding.logical_profile,fingerprint:fingerprint(input),...(binding.job?{job:binding.job}:{})};
          const current=await evaluate(options.pool,effect);
          const decision:Decision={outcome:'deny',origin:'mandatory',revision:current.revision,rule:error.code};
          await recordEffect(options.pool,effect,'proposed',decision,binding.event_id);
          await recordEffect(options.pool,effect,'blocked',decision,binding.event_id);
        }
        throw error;
      }
      const attempt=await authorizeEffect('model.request',payload);
      const transport=object(await rpc(options.hermes,'/internal/security/transport',{},'Bearer '+options.token));
      const destination=providerTarget(transport,path);
      const prepared=object(await options.prepare(principal,{destination,payload}));
      if(prepared.guarded!==true||!prepared.payload)throw new HttpError(503,'required_guard_unavailable');
      // Every attempt, including SDK retries, repeats current audience enforcement.
      await assertAudience(options.pool,principal);
      const current=await evaluate(options.pool,attempt.effect);
      if(current.outcome!=='allow'||current.revision!==attempt.decision.revision)throw new HttpError(409,'security_policy_changed');
      const headers:Record<string,string>={'content-type':'application/json',authorization:'Bearer '+String(transport.api_key)};
      for(const [key,value] of Object.entries(object(transport.headers??{})))if(['user-agent','originator','chatgpt-account-id'].includes(key.toLowerCase())&&typeof value==='string')headers[key]=value;
      await recordEffect(options.pool,attempt.effect,'started',attempt.decision,binding.event_id);attempt.started=true;
      const response=await call(destination,{method:'POST',headers,body:JSON.stringify(prepared.payload),redirect:'error',signal:controller.signal});
      if(!response.ok){await response.body?.cancel();await recordEffect(options.pool,attempt.effect,'failed',attempt.decision,binding.event_id);attempt.closed=true;throw new HttpError([401,403,429].includes(response.status)?response.status:503,'provider_request_failed');}
      await stream(response,principal,res,8*1024*1024);
      await recordEffect(options.pool,attempt.effect,'completed',attempt.decision,binding.event_id);attempt.closed=true;
    }catch(error){if(trace&&!trace.closed)await recordEffect(options.pool,trace.effect,trace.started?'ambiguous':'failed',trace.decision,binding.event_id);throw error;}
    finally{clearTimeout(timer);res.off('close',closed);controller.abort();}
  }
  async function stream(response:Response,principal:Reader,res:ServerResponse,max:number) {
    await assertAudience(options.pool,principal);
    res.writeHead(200,{'content-type':response.headers.get('content-type')??'application/octet-stream','cache-control':'no-store'});
    let size=0;
    if(response.body)for await(const part of response.body) {
      size+=part.length;if(size>max)throw new HttpError(413,'security_response_limit');
      await assertAudience(options.pool,principal);
      if(!res.write(part))await Promise.race([once(res,'drain'),once(res,'close').then(()=>{throw new Error('closed');})]);
    }
    res.end();
  }
}
