import {canonical} from '../archive.js';
import {HttpError,string} from '../http.js';
import {longFetch} from '../long-fetch.js';
import {engineId,engineInvalid,engineRejected,engineUnavailable,type EngineCoverage,type EngineFact,type EngineFactPage,type EngineTrace,
  type EngineWrite,type EngineWriteInput,type ForgetStep,type MemoryEngine,type ParticipantRole} from './engine.js';

/** GET without a body, POST with one. DELETE treats an already absent resource as deleted. */
export type HonchoCall=(path:string,body?:unknown,method?:'DELETE')=>Promise<any>;
/** Honcho's HTTP API. Failures use the memory socket's codes, so Nocheh can act on them without knowing the engine. */
export function honchoClient(base:string):HonchoCall {
 const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('invalid_honcho_url');
 return async(path,body,method)=>{
  // Recall includes guarded query preparation, embeddings and subscription reasoning, so a chat may take longer
  // than Node's own fetch waits; longFetch ends a call only at this deadline.
  let response:Response;try{response=await longFetch(url.origin+path,{method:method??(body===undefined?'GET':'POST'),signal:AbortSignal.timeout(path.endsWith('/chat')?480000:120000),
   headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw engineUnavailable();}
  if(method==='DELETE'&&response.status===404)return {deleted:false};
  if(!response.ok) {
   // Name the rejection without content: a validation error echoes its input, so only its field and type are kept.
   const detail=await response.json().then((value:any)=>Array.isArray(value?.detail)?value.detail.slice(0,5).map((item:any)=>({field:Array.isArray(item?.loc)?item.loc.join('.'):undefined,type:item?.type})):undefined,()=>undefined);
   console.warn(JSON.stringify({event:'honcho_upstream_rejected',status:response.status,route:path.replace(/\/[^/?]{16,}/g,'/:id').split('?')[0],detail}));
   throw engineRejected();
  }
  const text=await response.text();if(text.length>2*1024*1024)throw new HttpError(503,'honcho_response_limit');
  if(method==='DELETE')return {deleted:true};
  return JSON.parse(text);
 };
}

/** Honcho's peer chat takes a query of up to 200,000 characters and keeps each reasoning round's messages within
 * 61,440 tokens (tools/operations/memory/honcho_setup.py sets both; a test keeps them equal). Honcho never shortens
 * the query, so Nocheh gives it about half of those tokens and leaves the rest for what Honcho gathers: 92,160 UTF-8
 * bytes, half the tokens at 3 bytes a token. Learning queries measure about 2.4 (id-heavy JSON) to 6.4 (Persian text)
 * bytes a token, so an id-heavy query can take up to about 61% of the tokens; the request stays far below the guard. */
export const honchoQueryCharacters=200000,honchoInputTokens=61440,honchoQueryBytes=honchoInputTokens/2*3;
/** Honcho's own ids for messages and conclusions. */
const nativeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{21}$/.test(value);
const receiptId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const writes=(items:unknown):EngineWrite[]=>{
  if(!Array.isArray(items))throw engineInvalid();
  return items.map((item:any)=>({id:item?.id,content:item?.content,receipt:item?.metadata?.nocheh_receipt}));
};
/** Honcho names at most this many cited messages per fact here; more would be a broken answer, not a fact. */
const factWrites=256;
/** Nocheh's Honcho plugin brings this many messages of an uncited fact's learning batch (services/honcho/provenance.py). */
export const factBatchWrites=8;
/** Conclusion ids per plugin call in facts mode, and per id-filtered list page. */
const batchRoots=128,listIds=100;
/** Honcho's `created_at` as a key that sorts in time order to the microsecond, whatever fraction it prints. */
const instant=(value:unknown)=>{
  const match=typeof value==='string'?/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value):null;
  const seconds=match?Date.parse(match[1]!+match[3]!):NaN;
  return Number.isFinite(seconds)?String(seconds/1000).padStart(12,'0')+(match![2]??'').padEnd(6,'0'):null;
};
type Listed={fact:EngineFact;key:string;uncited:boolean};
/** One conclusion from Honcho's stock list, checked against what was asked: a fact about someone else, from a session
 * the read was not limited to, or of a derived level is a broken answer, never something to show. */
function listed(item:any,participant:string,sessions:Set<string>|null):Listed {
  const cited=item?.source_message_ids,key=instant(item?.created_at);
  if(!nativeId(item?.id)||typeof item.content!=='string'||item.content.length>65535||item.observer_id!==participant||item.observed_id!==participant||
    item.level!=='explicit'||!(item.session_id===null||engineId(item.session_id))||(sessions&&!sessions.has(item.session_id))||
    !Number.isSafeInteger(item.times_derived)||item.times_derived<1||key===null||
    !(cited===null||cited===undefined||Array.isArray(cited)&&cited.every(nativeId)))throw engineInvalid();
  const writes=[...new Set<string>(cited??[])];
  return {key,uncited:!writes.length,fact:{id:item.id,content:item.content,session:item.session_id,writes:writes.slice(0,factWrites),
    exact:writes.length?true:null,complete:writes.length<=factWrites,derived:item.times_derived,createdAt:item.created_at}};
}

/** Honcho peers observe per session: a writer's own words are learned, a subject is learned about, the assistant never. */
const observation:Record<ParticipantRole,{observe_me:boolean;observe_others:boolean}>={
  writer:{observe_me:true,observe_others:false},subject:{observe_me:false,observe_others:true},silent:{observe_me:false,observe_others:false}};

/** Honcho behind the memory socket. Nocheh's own routes under `/nocheh/*` come from the pinned Honcho
 * service's plugin (services/honcho/provenance.py). Peer cards are never read (ADR-0225). */
export class HonchoEngine implements MemoryEngine {
  readonly id='honcho';
  readonly name='Honcho';
  readonly protocol='honcho-entity-v1';
  readonly questionLimits={characters:honchoQueryCharacters,bytes:honchoQueryBytes};
  /** The dashboard's browser reads Honcho through its own command-line tool. */
  readonly inspectable=true;
  constructor(readonly call:HonchoCall){}
  private base(space:string){return '/v3/workspaces/'+space;}

  async openSpace(space:string){await this.call('/v3/workspaces',{id:space});}
  async addParticipant(space:string,participant:string,role:ParticipantRole) {
    await this.call(this.base(space)+'/peers',role==='silent'?{id:participant,configuration:{observe_me:false}}:{id:participant});
  }
  async openSession(space:string,session:string,participants:Record<string,ParticipantRole>) {
    await this.call(this.base(space)+'/sessions',{id:session,peers:Object.fromEntries(Object.entries(participants).map(([peer,role])=>[peer,observation[role]]))});
  }
  async findWrites(space:string,session:string,receipt:string) {
    return writes((await this.call(this.base(space)+'/sessions/'+session+'/messages/list',{filters:{metadata:{nocheh_receipt:receipt}}}))?.items);
  }
  async write(space:string,session:string,input:EngineWriteInput) {
    return writes(await this.call(this.base(space)+'/sessions/'+session+'/messages',{messages:[{peer_id:input.author,content:input.content,created_at:input.occurredAt,
      metadata:{nocheh_receipt:input.receipt,source_revision:input.sourceRevision,guarded_revision:input.guardedRevision}}]}));
  }
  async busy(space:string,session?:string) {
    const queue=await this.call(this.base(space)+'/queue/status'+(session===undefined?'':'?session_id='+session));
    return queue?.pending_work_units!==0||queue?.in_progress_work_units!==0;
  }
  async failing(space:string,since?:Date|null) {
    const health=await this.call(this.base(space)+'/nocheh/queue-health'+(since?'?since='+encodeURIComponent(since.toISOString()):''));
    if(typeof health?.failed_items!=='boolean')throw new HttpError(502,'honcho_queue_health_invalid');
    return health.failed_items as boolean;
  }
  async failedLearning(space:string) {
    const found=await this.call(this.base(space)+'/nocheh/failed-learning');
    if(!Number.isSafeInteger(found?.failed)||found.failed<0)throw engineInvalid();
    return found.failed as number;
  }
  async retryFailedLearning(space:string) {
    const result=await this.call(this.base(space)+'/nocheh/failed-learning/retry',{});
    if(!Number.isSafeInteger(result?.retried)||result.retried<0)throw new HttpError(502,'invalid_honcho_retry');
    return result.retried as number;
  }
  async context(space:string,session:string,options:{subject:string|null;limitToSession:boolean;tokens:number}) {
    const query=new URLSearchParams({tokens:String(options.tokens),summary:'true'});
    if(options.subject)query.set('peer_target',options.subject);
    if(options.limitToSession)query.set('limit_to_session','true');
    const result=await this.call(this.base(space)+'/sessions/'+session+'/context?'+query);
    return {summary:typeof result?.summary?.content==='string'?result.summary.content as string:'',
      subject:typeof result?.peer_representation==='string'?result.peer_representation as string:'',
      summaryMessage:typeof result?.summary?.content==='string'&&nativeId(result.summary.message_id)?result.summary.message_id as string:null};
  }
  async profile(space:string,participant:string) {
    return string((await this.call(this.base(space)+'/peers/'+participant+'/representation',{include_most_frequent:true,max_conclusions:50}))?.representation,2*1024*1024);
  }
  async ask(space:string,participant:string,question:string,options:{sessions:string[]|null;evidence:boolean;format?:Record<string,unknown>}) {
    const response=await this.call(this.base(space)+'/peers/'+participant+'/chat',{query:question,reasoning_level:'low',stream:false,
      ...(options.evidence?{include_evidence:true}:{}),...(options.format?{response_format:options.format}:{}),
      ...(options.sessions?{filters:{session_id:options.sessions}}:{})});
    if(typeof response?.content!=='string')throw engineInvalid();
    const evidence=Array.isArray(response?.evidence?.conclusions)?response.evidence.conclusions.map((item:any)=>item?.id).filter(nativeId):[];
    return {text:response.content as string,evidence:[...new Set<string>(evidence)]};
  }
  async search(space:string,query:string,options:{limit:number;sessions:string[]|null}) {
    const found=await this.call(this.base(space)+'/search',{query,limit:options.limit,...(options.sessions?{filters:{session_id:{in:options.sessions}}}:{})});
    if(!Array.isArray(found))throw new HttpError(502,'invalid_honcho_search');
    return found.slice(0,50).filter((message:any)=>nativeId(message?.id)&&receiptId(message?.metadata?.nocheh_receipt))
      .map((message:any)=>({id:message.id as string,receipt:message.metadata.nocheh_receipt as string}));
  }
  /** Honcho keeps conclusions other sessions derived from a session, so they go first, a page at a time. */
  async forgetSession(space:string,session:string):Promise<ForgetStep> {
    const found=await this.call(this.base(space)+'/nocheh/session-descendants',{session_id:session,limit:100});
    if(!found||!Array.isArray(found.ids)||found.ids.length>100||found.ids.some((value:unknown)=>!nativeId(value)))throw new HttpError(502,'invalid_honcho_descendants');
    if(!found.ids.length){await this.call(this.base(space)+'/sessions/'+session,undefined,'DELETE');return {done:true,removed:0};}
    for(const conclusion of found.ids)await this.call(this.base(space)+'/conclusions/'+conclusion,undefined,'DELETE');
    return {done:false,removed:found.ids.length};
  }
  /** Honcho deletes a workspace only once its sessions are gone. */
  async forgetSpace(space:string):Promise<ForgetStep> {
    const found=await this.call(this.base(space)+'/sessions/list?page=1&size=100',{});
    const sessions:string[]=Array.isArray(found?.items)?found.items.map((item:any)=>String(item?.id??'')):[];
    if(sessions.some(session=>!/^[A-Za-z0-9_-]{1,100}$/.test(session)))throw new HttpError(502,'invalid_honcho_sessions');
    if(!sessions.length){await this.call(this.base(space),undefined,'DELETE');return {done:true,removed:0};}
    for(const session of sessions)await this.call(this.base(space)+'/sessions/'+session,undefined,'DELETE');
    return {done:false,removed:sessions.length};
  }
  async trace(space:string,facts:string[]):Promise<EngineTrace> {
    // Honcho names a conclusion with a 21-character id; anything else is the asker's mistake, not Honcho's.
    if(facts.some(fact=>!nativeId(fact)))throw new HttpError(400,'invalid_provenance_request');
    const result=await this.call(this.base(space)+'/nocheh/provenance',{conclusion_ids:facts});
    if(!result||!Array.isArray(result.nodes)||result.nodes.length>128||!Array.isArray(result.messages)||result.messages.length>256||
      !Array.isArray(result.limitations)||result.limitations.length>20||result.limitations.some((v:unknown)=>typeof v!=='string'||v.length>100)||
      canonical(result.roots)!==canonical(facts)||result.nodes.some((v:any)=>!nativeId(v?.id)||!Array.isArray(v.parents)||v.parents.length>128||v.parents.some((p:unknown)=>!nativeId(p))||
        ![true,false,null].includes(v.exact_citations))||
      result.messages.some((message:any)=>!nativeId(message?.message_id)||!receiptId(message?.receipt_id)))
      throw new HttpError(502,'invalid_honcho_provenance');
    return {facts:result.nodes.map((n:any)=>({id:n.id,parents:n.parents,deleted:n.deleted===true,exactCitations:n.exact_citations as boolean|null})),
      writes:result.messages.map((m:any)=>({id:m.message_id,receipt:m.receipt_id})),limitations:result.limitations};
  }

  /** Honcho's stock conclusion list for what a peer learned about itself, a cursor page at a time (no count query). */
  private async list(space:string,participant:string,sessions:string[]|null,size:number,cursor:string,extra:Record<string,unknown>={}) {
    if(!engineId(participant)||sessions?.some(session=>!engineId(session)))throw new HttpError(400,'invalid_fact_request');
    const page=await this.call(this.base(space)+'/conclusions/list?'+new URLSearchParams({size:String(size),cursor}),
      {filters:{observer_id:participant,observed_id:participant,level:'explicit',...(sessions?{session_id:{in:sessions}}:{}),...extra}});
    // A server without cursor pages answers a plain page, which would end a walk early without saying so.
    if(!page||!Array.isArray(page.items)||page.items.length>size||
      !(page.next_page===null||typeof page.next_page==='string'&&page.next_page.length>0&&page.next_page.length<=2048))throw engineInvalid();
    const allowed=sessions&&new Set(sessions);
    return {items:page.items.map((item:any)=>listed(item,participant,allowed)) as Listed[],next:page.next_page as string|null};
  }
  /** Honcho's list names the messages a fact cites. For a fact without citations, Nocheh's plugin names a few messages
   * of the batch it was learned from, which is never exact. Facts it cannot answer for keep no writes, and say why. */
  private async batches(space:string,items:Listed[]) {
    const limitations=new Set<string>(),uncited=items.filter(item=>item.uncited).map(item=>item.fact);
    for(let start=0;start<uncited.length;start+=batchRoots) {
      const chunk=uncited.slice(start,start+batchRoots),ids=chunk.map(fact=>fact.id);
      let result:any;
      try{result=await this.call(this.base(space)+'/nocheh/provenance',{conclusion_ids:ids,depth:0,per_node:true});}
      catch{limitations.add('fact_batches_unavailable');for(const fact of chunk)fact.complete=false;continue;}
      // An older plugin answers the flat trace without per-fact messages: it cannot say which batch is whose.
      if(Array.isArray(result?.nodes)&&result.nodes.some((node:any)=>node&&!('messages' in node))) {
        limitations.add('fact_batches_unsupported');for(const fact of chunk)fact.complete=false;continue;
      }
      if(!result||canonical(result.roots)!==canonical(ids)||!Array.isArray(result.nodes)||result.nodes.length>ids.length||
        !Array.isArray(result.limitations)||result.limitations.length>20||result.limitations.some((v:unknown)=>typeof v!=='string'||!/^[a-z_]{1,100}$/.test(v))||
        result.nodes.some((node:any)=>!ids.includes(node?.id)||![true,false,null].includes(node.exact_citations)||typeof node.messages_truncated!=='boolean'||
          !Array.isArray(node.messages)||node.messages.length>factBatchWrites||node.messages.some((m:any)=>!nativeId(m?.message_id)||!receiptId(m?.receipt_id))||
          (node.exact_citations===null)!==(node.messages.length===0))) {
        limitations.add('fact_batches_invalid');for(const fact of chunk)fact.complete=false;continue;
      }
      for(const value of result.limitations)limitations.add(value);
      const nodes=new Map<string,any>(result.nodes.map((node:any)=>[node.id,node]));
      for(const fact of chunk) {
        const node=nodes.get(fact.id);
        if(!node){fact.complete=false;continue;}
        // Complete only for a whole citation list: a batch holds only the observed peer's messages, never the others' the
        // fact may rest on (H:src/deriver/deriver.py), and a fact with no message named says nothing of where it came from.
        fact.writes=[...new Set<string>(node.messages.map((m:any)=>m.message_id))];fact.exact=node.exact_citations;
        fact.complete=node.exact_citations===true&&!node.messages_truncated&&node.messages.length>0;
      }
    }
    return [...limitations].sort();
  }
  async factBatches(space:string,facts:EngineFact[]):Promise<string[]> {
    return this.batches(space,facts.map(fact=>({fact,key:'',uncited:fact.exact===null&&!fact.writes.length})));
  }
  async facts(space:string,participant:string,options:{sessions:string[]|null;size:number;cursor:string|null;batches?:boolean}):Promise<EngineFactPage> {
    if(!Number.isSafeInteger(options.size)||options.size<1||options.size>100||
      options.cursor!==null&&(typeof options.cursor!=='string'||!options.cursor||options.cursor.length>2048))throw new HttpError(400,'invalid_fact_request');
    if(options.sessions&&!options.sessions.length)return {facts:[],next:null,limitations:[]};
    const page=await this.list(space,participant,options.sessions,options.size,options.cursor??'');
    return {facts:page.items.map(item=>item.fact),next:page.next,limitations:options.batches===false?[]:await this.batches(space,page.items)};
  }
  async factsById(space:string,participant:string,ids:string[],options:{sessions:string[]|null}) {
    if(!Array.isArray(ids)||ids.length>256||ids.some(id=>!nativeId(id)))throw new HttpError(400,'invalid_fact_request');
    const wanted=[...new Set(ids)],found=new Map<string,Listed>();
    if(!(options.sessions&&!options.sessions.length))for(let start=0;start<wanted.length;start+=listIds) {
      const chunk=wanted.slice(start,start+listIds),page=await this.list(space,participant,options.sessions,listIds,'',{id:{in:chunk}});
      if(page.next!==null||page.items.some(item=>!chunk.includes(item.fact.id)))throw engineInvalid();
      for(const item of page.items)found.set(item.fact.id,item);
    }
    const items=wanted.flatMap(id=>found.get(id)??[]);
    return {facts:items.map(item=>item.fact),limitations:await this.batches(space,items)};
  }
  async factExists(space:string,participant:string,id:string) {
    if(!nativeId(id))throw new HttpError(400,'invalid_fact_request');
    const page=await this.list(space,participant,null,1,'',{id:{in:[id]}});
    return page.items.some(item=>item.fact.id===id);
  }
  /** Honcho's profile takes its most-derived half by `times_derived desc, created_at desc, id`
   * (H:src/crud/representation.py), so the same order is rebuilt here from three pages of the stock list. */
  async mostDerived(space:string,participant:string,options:{sessions:string[]|null;batches?:boolean}) {
    if(options.sessions&&!options.sessions.length)return {facts:[],complete:true,limitations:[]};
    const items:Listed[]=[];let cursor='',pages=0;
    do{const page=await this.list(space,participant,options.sessions,100,cursor,{times_derived:{gte:2}});items.push(...page.items);cursor=page.next??'';pages++;}
    while(cursor&&pages<3);
    items.sort((a,b)=>b.fact.derived-a.fact.derived||(a.key<b.key?1:a.key>b.key?-1:0)||(a.fact.id<b.fact.id?-1:a.fact.id>b.fact.id?1:0));
    return {facts:items.map(item=>item.fact),complete:!cursor,limitations:options.batches===false?[]:await this.batches(space,items)};
  }
  async citationCoverage(space:string):Promise<EngineCoverage> {
    const found=await this.call(this.base(space)+'/nocheh/citation-coverage');
    const counts=[found?.explicit,found?.cited,found?.batch_only,found?.none];
    if(counts.some(v=>!Number.isSafeInteger(v)||v<0)||found.explicit!==found.cited+found.batch_only+found.none)throw engineInvalid();
    return {explicit:found.explicit,cited:found.cited,batchOnly:found.batch_only,none:found.none};
  }
}
export const honchoEngine=(call:HonchoCall)=>new HonchoEngine(call);
