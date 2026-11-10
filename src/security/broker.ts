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
import {anthropicPayload,providerPayload} from './provider-request.js';
import type {SourceReference} from '../stores/archive.js';
import type {OperationReference} from '../stores/operations.js';
import {JobBoxRepository,boxTokenSet,boxTokenValid} from '../stores/job-box.js';
import {RuntimeTurnRepository} from '../stores/turns.js';
import {afterPending,jobRun} from '../stores/guards.js';
import {elapsed,timedBody,type ModelTimings} from './timing.js';

export interface TurnBinding {
  event_id:string;scope:string;profile:string;logical_profile:string;owner:boolean;
  guard_epoch:number;revision?:number|undefined;generation?:string;job?:string;reference?:SourceReference|OperationReference;
}
export interface BrokerStorage {
  binding(principal:Reader):Promise<TurnBinding>;
  assertAudience(principal:Reader):Promise<unknown>;
  turnFile(principal:Reader,hash:string):Promise<string>;
}
export interface BrokerOptions {pool:pg.Pool; token:string; archive:string; prepare:(principal:Reader,input:unknown)=>Promise<any>; hermes:string; model:string; fetch?:typeof fetch;storage?:BrokerStorage;assertActive?:()=>void;assertReady?:()=>Promise<void>;health?:()=>Promise<unknown>;}
/** A fixed label for preparation-only guard requests; nothing is sent there. */
const PREPARATION_DESTINATION='https://preparation.nocheh.invalid';
const relayRoutes:[string,RegExp][]=[
  ['GET',/^\/v1\/(search|archive\/page|imports\/pending|events\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64}\/bytes|memory\/check|memory\/context|memory\/(shared|filtered)\/[a-f0-9]{64}|knowledge\/(context|proposals\/[a-f0-9]{64})|owner\/(conversations|conversation-context|projects|project-assignments|people|telegram-identities|memory-map|tasks(?:\/[a-f0-9]{64})?)|tools\/actions\/[a-f0-9]{64}|telegram\/destinations)$/],
  ['POST',/^\/v1\/(context\/prepare|memory\/(recall|longterm\/(recall|context|search))|jobs\/(start|status|stop)|tools\/propose|knowledge\/proposals|action-requests|owner\/tasks(?:\/[a-f0-9]{64}(?:\/comments)?)?)$/],
];
export function scopedRoute(method:string,path:string):boolean {return relayRoutes.some(([m,re])=>method===m&&re.test(path));}
/** The installation rehearsal's fixture provider; accepted only when the fixture flag is set. */
export const FIXTURE_PROVIDER_URL='http://model-fixture:8317/v1';
/** The reply provider chosen in Settings › Models. Only HTTPS, except the rehearsal fixture. */
export function configuredReplyUrl(value=process.env.NOCHEH_REPLY_ROUTE_URL,fixture=process.env.NOCHEH_INSTALLATION_FIXTURE==='1'):string|undefined {
  if(!value)return undefined;
  if(fixture&&value.replace(/\/+$/,'')===FIXTURE_PROVIDER_URL)return FIXTURE_PROVIDER_URL;
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return undefined;}catch{return undefined;}
  return value.replace(/\/+$/,'');
}
/** Anthropic in Settings › Models. Its OpenAI-compatible API has no prompt caching, so
 * Hermes reaches its Messages API through this route instead. */
export const ANTHROPIC_URL='https://api.anthropic.com/v1';
export const ANTHROPIC_MESSAGES='/anthropic/v1/messages';
const ANTHROPIC_VERSION='2023-06-01';
/** Hermes's beta headers. Others are dropped; the payload policy refuses what they would enable. */
const ANTHROPIC_BETAS=new Set(['interleaved-thinking-2025-05-14','fine-grained-tool-streaming-2025-05-14']);
export function providerTarget(transport:Record<string,unknown>,path:string,configured=configuredReplyUrl()):string {
  if(!configured)throw new HttpError(503,'provider_not_configured');
  // Only the one provider the owner configured for replies, never an address Hermes invents.
  if(transport.base_url===configured&&transport.api_mode==='chat_completions'&&path==='/v1/chat/completions')return configured+'/chat/completions';
  if(transport.base_url===configured&&configured===ANTHROPIC_URL&&path===ANTHROPIC_MESSAGES)return configured+'/messages';
  throw new HttpError(403,'provider_route_denied');
}
/** Hermes sends Anthropic's key header; on this route it carries the turn's scoped credential. */
export function anthropicCredential(req:IncomingMessage,path:string):void {
  const key=req.headers['x-api-key'];
  if(path!==ANTHROPIC_MESSAGES||key===undefined)return;
  if(typeof key!=='string'||req.headers.authorization!==undefined)throw new HttpError(401,'unauthorized');
  req.headers.authorization='Bearer '+key;delete req.headers['x-api-key'];
}
export function anthropicHeaders(key:string,betas:string|string[]|undefined):Record<string,string> {
  const kept=String(betas??'').split(',').map(beta=>beta.trim()).filter(beta=>ANTHROPIC_BETAS.has(beta));
  return {'content-type':'application/json','x-api-key':key,'anthropic-version':ANTHROPIC_VERSION,'user-agent':'Nocheh',
    ...(kept.length?{'anthropic-beta':[...new Set(kept)].join(',')}:{})};
}
export async function turnBinding(pool:pg.Pool,principal:Reader):Promise<TurnBinding> {
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
/** A provider refused a model call. The broker answers with its own status, and passes on only the provider's HTTP status,
 * never its message, so the owner's notice can say what went wrong, such as overloaded (529). */
export class ProviderFailure extends HttpError {
  constructor(readonly providerStatus:number){super([401,403,429].includes(providerStatus)?providerStatus:503,'provider_request_failed');}
}
/** What a job request may be told to correct, as services/hermes/archive_tools.py JOB_ERRORS names it; any other refusal stays opaque. */
export const jobErrors=new Set(['invalid_job_request','job_not_permitted','job_not_found','job_limit_reached','job_not_running','job_in_a_job','job_box_not_allowed','job_changed','job_too_long','job_repo_not_allowed']);
/** The error code in a refused archive answer, read within a small bound; null when there is none. */
async function refusalCode(response:Response,max=4096):Promise<string|null> {
  const chunks=[];let size=0;
  try {
    if(response.body)for await(const part of response.body){size+=part.length;if(size>max)return null;chunks.push(Buffer.from(part));}
    const code=object(JSON.parse(Buffer.concat(chunks).toString())).error;return typeof code==='string'?code:null;
  }catch{return null;}
}
async function boundedJson(response:Response,max=2*1024*1024):Promise<unknown> {
  if(!response.ok){await response.body?.cancel();throw new HttpError(response.status>=400&&response.status<500?response.status:503,'security_upstream_unavailable');}
  const chunks=[];let size=0;
  if(response.body)for await(const part of response.body){size+=part.length;if(size>max)throw new HttpError(413,'security_response_limit');chunks.push(Buffer.from(part));}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new HttpError(503,'invalid_security_upstream');}
}
export function brokerServer(options:BrokerOptions) {
  const call=options.fetch??fetch;
  // Sealed job boxes follow Nocheh's own rows, so without storage no turn gets one.
  const box=options.storage instanceof RuntimeTurnRepository?new JobBoxRepository(options.storage.access):null;
  // A job's run goes on across reaction and learning epochs; each of its checks waits out a publication still pending (ADR-0208).
  const assertCurrent=(principal:Reader)=>afterPending(jobRun(principal),async()=>options.storage?options.storage.assertAudience(principal):assertAudience(options.pool,principal));
  return createServer((req,res)=>{void handle(req,res).catch(error=>{
    if(res.headersSent){res.destroy();return;}
    json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'security_service_unavailable',
      ...(error instanceof ProviderFailure&&Number.isInteger(error.providerStatus)&&error.providerStatus>=100&&error.providerStatus<=599?{provider_status:error.providerStatus}:{})});
  });});
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const url=new URL(req.url??'/','http://security'),path=url.pathname;
    if(req.method==='GET'&&path==='/health'){if(options.health)await options.health();else await options.pool.query('SELECT 1');return json(res,200,{ok:true,service:'security',plugin:manifest.id,api_version:1});}
    options.assertActive?.();
    anthropicCredential(req,path);
    // The launcher's sweep: the boxes that may exist now. Only the box token reaches it.
    if(req.method==='GET'&&path==='/v1/box/live') {
      const authorization=req.headers.authorization??'';
      if(!box||!authorization.startsWith('Bearer ')||!boxTokenValid(authorization.slice(7)))throw new HttpError(403,'box_token_required');
      await options.assertReady?.();return json(res,200,await box.live());
    }
    const principal=reader(req,options.token),job=jobRun(principal);
    await afterPending(job,async()=>options.assertReady?.());
    // The box's chat copy also needs the launcher's box token, and is never read with an owner credential.
    const copy=path==='/v1/box/chat'&&req.method==='GET';
    if(copy&&(principal.admin||!box||!boxTokenValid(req.headers['x-nocheh-box-token'])))throw new HttpError(403,'job_box_not_allowed');
    // Only the job's own chat and period, from its row: the page cursor is the one key it takes.
    if(copy&&[...url.searchParams.keys()].some(key=>key!=='cursor'))throw new HttpError(400,'invalid_box_request');
    if(principal.admin&&path==='/v1/guard'&&req.method==='POST')return json(res,200,await options.prepare(principal,await readJson(req,1024*1024)));
    if(path!=='/v1/security/binding'&&await ownerSecurityRoute(options.pool,principal,req,res,url,{separated:!!options.storage}))return;
    const binding=await afterPending(job,()=>options.storage?options.storage.binding(principal):turnBinding(options.pool,principal));
    const credential=req.headers.authorization!;
    // A cold Honcho recall includes multiple guarded provider calls. Keep other
    // broker operations on their shorter deadline; cancellation still aborts both.
    const timeout=req.method==='POST'&&path==='/v1/memory/longterm/recall'?600000:120000;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    const closed=()=>{if(!res.writableEnded)controller.abort();};res.on('close',closed);
    let trace:{effect:Effect;decision:Decision;started:boolean;closed:boolean}|undefined;
    const timings:ModelTimings={};
    const authorizeEffect=async(kind:Effect['kind'],value:unknown)=>{
      const effect:Effect={id:randomUUID(),kind,scope:binding.scope,profile:binding.logical_profile,fingerprint:fingerprint(value),...(binding.job?{job:binding.job}:{})};
      const decision=await evaluate(options.pool,effect);
      trace={effect,decision,started:false,closed:false};
      await recordEffect(options.pool,effect,'proposed',decision,binding.reference??binding.event_id);
      await recordEffect(options.pool,effect,decision.outcome==='allow'?'allowed':'blocked',decision,binding.reference??binding.event_id);
      if(decision.outcome!=='allow'){trace.closed=true;throw new HttpError(403,'security_policy_denied');}
      return trace;
    };
    try {
      const rpc=async(base:string,route:string,body:unknown,authorization=credential)=>boundedJson(await call(base+route,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal}));
      if(path==='/v1/security/binding'&&req.method==='GET') {
        const transport=object(await rpc(options.hermes,'/internal/security/transport',{metadata:true},'Bearer '+options.token));
        if(!Number.isSafeInteger(transport.model_context_length)||Number(transport.model_context_length)<1)throw new HttpError(503,'model_context_metadata_required');
        // Without the box token the launcher can fill no box, so no step gets one.
        return json(res,200,{...binding,box:box&&boxTokenSet()?await box.binding(binding):null,model:options.model,model_context_length:transport.model_context_length,plugin:manifest});
      }
      if(path==='/v1/guard'&&req.method==='POST') {
        const body=object(await readJson(req,1024*1024));
        // Preparation is separate from permission to transmit. Destination is not forwarded.
        return json(res,200,await afterPending(job,()=>options.prepare(principal,{destination:PREPARATION_DESTINATION,payload:body.payload})));
      }
      let relay=path;
      const file=path.match(/^\/v1\/turn-files\/([a-f0-9]{64})$/);
      if(file&&req.method==='GET') {
        const artifact=options.storage?await options.storage.turnFile(principal,file[1]!):
          (await options.pool.query<{id:string}>('SELECT id FROM artifacts WHERE event_id=$1 AND file_hash=$2 AND state=\'ready\' LIMIT 1',[principal.turnEvent,file[1]])).rows[0]?.id;
        if(!artifact)throw new HttpError(404,'turn_file_not_found');
        relay='/v1/artifacts/'+artifact+'/bytes';
      }
      if(copy&&!await box!.binding(binding))throw new HttpError(403,'job_box_not_allowed');
      if(copy||scopedRoute(req.method??'',relay)) {
        // Only the box route reads whole texts; no other read can ask for them.
        if(!copy&&url.searchParams.has('full'))url.searchParams.delete('full');
        const knowledge=relay.startsWith('/v1/knowledge/')||relay.startsWith('/v1/owner/');
        // Fixed scoped routes keep runtime tools away from owner credentials.
        // Storage independently verifies a current live owner-private turn.
        if(knowledge&&(!binding.owner||binding.job||principal.scope!==null||(principal.purpose??'assistant')!=='assistant'))throw new HttpError(403,'owner_private_turn_required');
        const input=req.method==='POST'?await readJson(req,1024*1024):undefined,body=input===undefined?undefined:JSON.stringify(input);
        // A job asks for the box only where one can be filled: refused now, not failed at every step.
        if(relay==='/v1/jobs/start'&&(input as {box?:unknown}|null)?.box===true&&!boxTokenSet())throw new HttpError(409,'job_box_not_allowed');
        // Context preparation and proposals have their own enforcement. Read policies
        // apply to retrieval; native memory remains writable within the owned profile.
        if(relay!=='/v1/context/prepare'&&!['/v1/tools/propose','/v1/action-requests','/v1/knowledge/proposals','/v1/jobs/start','/v1/jobs/stop'].includes(relay))await authorizeEffect(req.method==='POST'&&relay.startsWith('/v1/owner/tasks')?'memory.write':relay.includes('/memory/')||knowledge?'memory.read':'archive.read',{relay,query:url.search});
        const response=await call(options.archive+relay+url.search,{method:req.method!,headers:{authorization:credential,'content-type':'application/json'},...(body===undefined?{}:{body}),redirect:'error',signal:controller.signal});
        if(!response.ok) {
          // A job request is told what to correct, such as a member's daily limit or a box it may not have.
          const code=relay.startsWith('/v1/jobs/')&&response.status>=400&&response.status<500?await refusalCode(response):(await response.body?.cancel(),null);
          throw new HttpError(response.status,code&&jobErrors.has(code)?code:'scoped_archive_unavailable');
        }
        // A box page holds at most 600,000 characters of message texts, which stays well within 8 MiB.
        await stream(response,principal,res,file?26*1024*1024:8*1024*1024);
        if(trace){await recordEffect(options.pool,trace.effect,'completed',trace.decision,binding.reference??binding.event_id);trace.closed=true;}return;
      }
      const anthropic=path===ANTHROPIC_MESSAGES;
      if(req.method!=='POST'||(path!=='/v1/chat/completions'&&!anthropic)||url.search)throw new HttpError(403,'security_route_denied');
      // Nothing is guarded or recorded for a model call that has no provider to go to.
      if(!configuredReplyUrl())throw new HttpError(503,'provider_not_configured');
      const input=await readJson(req,1024*1024);let payload:Record<string,unknown>;
      try {
        payload=anthropic?anthropicPayload(input):providerPayload(input);
        if(payload.model!==options.model)throw new HttpError(403,'model_configuration_mismatch');
      }catch(error){
        if(error instanceof HttpError){
          const effect:Effect={id:randomUUID(),kind:'model.request',scope:binding.scope,profile:binding.logical_profile,fingerprint:fingerprint(input),...(binding.job?{job:binding.job}:{})};
          const current=await evaluate(options.pool,effect);
          const decision:Decision={outcome:'deny',origin:'mandatory',revision:current.revision,rule:error.code};
          await recordEffect(options.pool,effect,'proposed',decision,binding.reference??binding.event_id);
          await recordEffect(options.pool,effect,'blocked',decision,binding.reference??binding.event_id);
        }
        throw error;
      }
      const attempt=await authorizeEffect('model.request',payload);
      const prepareStarted=performance.now();
      const transport=object(await rpc(options.hermes,'/internal/security/transport',{},'Bearer '+options.token));
      const destination=providerTarget(transport,path);
      const prepared=object(await afterPending(job,()=>options.prepare(principal,{destination,payload})));
      if(prepared.guarded!==true||!prepared.payload)throw new HttpError(503,'required_guard_unavailable');
      // Every attempt, including SDK retries, repeats current audience enforcement.
      await assertCurrent(principal);
      const current=await evaluate(options.pool,attempt.effect);
      if(current.outcome!=='allow'||current.revision!==attempt.decision.revision)throw new HttpError(409,'security_policy_changed');
      // A background job's requests count against its byte backstop, which holds without the step's own report: the
      // bytes add up in one statement, and once they pass the budget no further call goes out (ADR-0206). The refusal is
      // a 409, which Hermes takes as final and never as a rejected key or a limit to retry or rotate past.
      const sent=JSON.stringify(prepared.payload);
      if(options.storage&&binding.job) {
        const job=(await options.pool.query<{model_bytes:string;byte_budget:string|null}>('UPDATE background_jobs SET model_bytes=model_bytes+$2 WHERE id=$1 RETURNING model_bytes,byte_budget',
          [binding.job,Buffer.byteLength(sent)])).rows[0];
        if(job&&job.byte_budget!==null&&Number(job.model_bytes)>Number(job.byte_budget))throw new HttpError(409,'job_cost_limit');
      }
      timings.broker_prepare_ms=elapsed(prepareStarted);
      // A gateway's bot check can refuse a client without a name, as it refused Honcho's model calls.
      const headers:Record<string,string>=anthropic?anthropicHeaders(String(transport.api_key),req.headers['anthropic-beta']):
        {'content-type':'application/json',authorization:'Bearer '+String(transport.api_key),'user-agent':'Nocheh'};
      for(const [key,value] of Object.entries(object(transport.headers??{})))if(key.toLowerCase()==='user-agent'&&typeof value==='string')headers['user-agent']=value;
      await recordEffect(options.pool,attempt.effect,'started',attempt.decision,binding.reference??binding.event_id);attempt.started=true;
      const providerStarted=performance.now();let response:Response;
      try{response=await call(destination,{method:'POST',headers,body:sent,redirect:'error',signal:controller.signal});}
      finally{timings.provider_headers_ms=elapsed(providerStarted);}
      if(!response.ok){await response.body?.cancel();await recordEffect(options.pool,attempt.effect,'failed',attempt.decision,binding.reference??binding.event_id,undefined,timings);attempt.closed=true;throw new ProviderFailure(response.status);}
      await stream(response,principal,res,8*1024*1024,timings);
      await recordEffect(options.pool,attempt.effect,'completed',attempt.decision,binding.reference??binding.event_id,undefined,timings);attempt.closed=true;
    }catch(error){if(trace&&!trace.closed)await recordEffect(options.pool,trace.effect,trace.started?'ambiguous':'failed',trace.decision,binding.reference??binding.event_id,undefined,timings);throw error;}
    finally{clearTimeout(timer);res.off('close',closed);controller.abort();}
  }
  async function stream(response:Response,principal:Reader,res:ServerResponse,max:number,timings?:ModelTimings) {
    await assertCurrent(principal);
    res.writeHead(200,{'content-type':response.headers.get('content-type')??'application/octet-stream','cache-control':'no-store'});
    let size=0;
    if(timings)timings.downstream_ms=0;
    if(response.body)for await(const part of timings?timedBody(response.body,timings):response.body) {
      const localStarted=performance.now();
      try {
        size+=part.length;if(size>max)throw new HttpError(413,'security_response_limit');
        await assertCurrent(principal);
        if(!res.write(part))await Promise.race([once(res,'drain'),once(res,'close').then(()=>{throw new Error('closed');})]);
      }finally{if(timings)timings.downstream_ms!+=elapsed(localStarted);}
    }
    res.end();
  }
}
