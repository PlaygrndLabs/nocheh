import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import {engineId,type EngineFact,type ParticipantFact} from '../memory/engine.js';
import {parentSpace} from '../spaces.js';
import type {TagBy} from '../source-tags.js';
import {memoryPeerId} from './entities.js';
import type {GuardBinding} from './guards.js';
import type {NativeMemoryRepository} from './native-memory.js';
import {bindingMoved,countMemoryStep} from './note-sources.js';
import type {Original,OwnerOriginals} from './owner-originals.js';

/**
 * One fact long-term memory learned, as the owner's dashboard lists it (ADR-0261 step 4): the engine's own text and when
 * it learned it; `exact` when it cites every message it came from and each is known (FactSourceRepository); `batch` when
 * the engine knows only the batch it learned it from; `by` whose words it rests on; the original its source line names
 * first (`label` and `at`, null when none can be linked) and its originals in that order, OWNER_FACT_ORIGINALS at most,
 * with `more` counting the rest. A retired original reads only `retired`.
 */
export type DashboardFact={id:string;text:string;learned_at:string;exact:boolean;batch:boolean;by:TagBy;label:string|null;at:string|null;
  originals:Original[];more:number};
/** Why a list is empty without a failure: no memory space to read, an engine that can't list facts, or a message never
 *  learned. `unavailable` is a failure, counted as a `source_tags` problem. */
export type FactsReason='no_memory'|'not_supported'|'not_learned'|'unavailable';

/** Facts per dashboard page, and originals named per fact (the rest counted): within OwnerOriginals' limit together. */
const OWNER_FACT_PAGE=25,OWNER_FACT_ORIGINALS=5;
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/**
 * Long-term memory's facts on the owner's dashboard (ADR-0261 step 4), read with the engine's own calls (no Honcho change,
 * nothing learned again) and named through Nocheh's receipts (FactSourceRepository) in the owner's words (OwnerOriginals).
 * The owner reads every audience. A read the engine fails is counted as a `source_tags` problem and answers an empty list
 * with its reason, never an error page.
 */
export class MemoryDashboard {
  constructor(readonly stores:{archive:Pick<pg.Pool,'query'>;control:Pick<pg.Pool,'query'>},readonly memory:NativeMemoryRepository,
    readonly originals:OwnerOriginals,readonly policy:()=>AssistantPolicy){}
  private get engine(){return this.memory.engine;}

  /** A read that failed: logged by its code alone, counted, and given back as `unavailable`. */
  private async failed(event:string,error:unknown):Promise<FactsReason> {
    if(bindingMoved(error))throw error;
    console.warn(JSON.stringify({event,engine:this.engine.id,code:error instanceof HttpError?error.code:'memory_dashboard_error'}));
    await countMemoryStep(this.stores.control,'source_tags',false);
    return 'unavailable';
  }
  /** Engine facts with their originals: grouped by whose facts they are (which orders their sources), in the order given. */
  private async shaped(principal:Reader,space:{id:string;binding:GuardBinding},facts:readonly ParticipantFact[],limitations:readonly string[]):Promise<DashboardFact[]> {
    // A batch the engine's plugin could not give is a source_tags problem, as on the turn path.
    if(limitations.some(code=>code.startsWith('fact_batches_')))await countMemoryStep(this.stores.control,'source_tags',false);
    const sources=this.memory.factSources,byId=new Map<string,Awaited<ReturnType<typeof sources.sourced>>[number]>();
    for(const participant of [...new Set(facts.map(fact=>fact.participant))]) {
      const own=facts.filter(fact=>fact.participant===participant);
      const found=await sources.sourced(principal,space.binding,space.id,participant,own,{audience:'owner',group:null});
      for(const item of found)byId.set(item.fact.id,item);
    }
    // The original each fact's source line names first, then the rest in the fact's order.
    const ordered=facts.map(fact=>{
      const item=byId.get(fact.id)!,first=item.header?.id??null;
      return {item,ids:first?[first,...item.sources.filter(id=>id!==first)]:item.sources};
    });
    const named=await this.originals.originals(ordered.flatMap(({ids})=>ids.slice(0,OWNER_FACT_ORIGINALS)));
    return ordered.map(({item,ids})=>{
      const shown=ids.slice(0,OWNER_FACT_ORIGINALS).flatMap(id=>named.get(id)??[]),head=shown[0];
      const linked=head&&'id' in head&&ids[0]===item.header?.id?head:null;
      return {id:item.fact.id,text:item.fact.content,learned_at:item.fact.createdAt,exact:item.exact,batch:item.fact.exact===false,by:item.by,
        label:linked?.label??null,at:linked?.at??null,originals:shown,more:Math.max(0,ids.length-shown.length)};
    });
  }

  /**
   * The Learned into memory section of a message: the facts that cite it, found by Honcho's stock list filtered on the
   * messages its receipts wrote (done and live receipts that wrote it or carry it), each with its exact badge and
   * originals. Every audience's, since the owner reads them all.
   */
  async learned(principal:Reader,id:string):Promise<{facts:DashboardFact[];reason?:FactsReason;more?:true}> {
    admin(principal);
    if(!fullId(id)||!(await this.stores.archive.query('SELECT 1 FROM events WHERE id=$1',[id])).rowCount)throw new HttpError(404,'source_not_found');
    const space=await this.memory.dashboardSpace();
    if(!space)return {facts:[],reason:'no_memory'};
    if(!this.engine.everyFact)return {facts:[],reason:'not_supported'};
    const writes=(await this.stores.control.query(`SELECT DISTINCT remote_id FROM memory_ingestion_receipts WHERE generation=$1 AND state='done'
      AND retired_at IS NULL AND remote_id IS NOT NULL AND (source_reference->>'id'=$2 OR source_references @> jsonb_build_array(jsonb_build_object('id',$2::text)))
      ORDER BY remote_id LIMIT 100`,[space.id,id])).rows.map(row=>row.remote_id).filter(engineId);
    if(!writes.length)return {facts:[],reason:'not_learned'};
    try {
      const page=await this.engine.everyFact(space.id,{sessions:null,citing:writes,size:OWNER_FACT_PAGE,cursor:null});
      return {facts:await this.shaped(principal,space,page.facts,page.limitations),...page.next?{more:true as const}:{}};
    }catch(error){return {facts:[],reason:await this.failed('memory_dashboard_learned_failed',error)};}
  }

  /**
   * Memory › Long-term's Facts list: newest first, OWNER_FACT_PAGE a page (`after` is the page's `next`), within one
   * chat's memory (its sessions and its topics') or about one person (People's card: that participant's facts about
   * itself), or both.
   */
  async facts(principal:Reader,query:{chat:string;person:string;after:string}):Promise<{facts:DashboardFact[];next:string|null;reason?:FactsReason}> {
    admin(principal);
    const {chat,person,after}=query;
    if(chat.length>200||person&&!fullId(person)||after.length>2048)throw new HttpError(400,'invalid_fact_request');
    const space=await this.memory.dashboardSpace();
    if(!space)return {facts:[],next:null,reason:'no_memory'};
    let participant:string|null=null;
    if(person) {
      const row=(await this.stores.control.query('SELECT id,kind FROM memory_entities WHERE id=$1',[person])).rows[0];
      if(!row)throw new HttpError(404,'person_not_found');
      participant=memoryPeerId(row);
    }
    let sessions:string[]|null=null;
    if(chat) {
      // The owner's private chat is the owner audience; any other chat is its own, and its topics' too.
      const audience=chat===ownerChat(this.policy())?'owner':chat;
      sessions=(await this.stores.control.query('SELECT session_id,audience FROM memory_sessions WHERE workspace=$1',[space.id])).rows
        .filter(row=>row.audience===audience||parentSpace(row.audience)===chat).map(row=>String(row.session_id));
    }
    if(participant?!this.engine.facts:!this.engine.everyFact)return {facts:[],next:null,reason:'not_supported'};
    try {
      const options={sessions,size:OWNER_FACT_PAGE,cursor:after||null};
      const page=participant?await this.engine.facts!(space.id,participant,options).then(found=>({...found,
        facts:found.facts.map((fact:EngineFact)=>({...fact,participant:participant!}))})):await this.engine.everyFact!(space.id,options);
      return {facts:await this.shaped(principal,space,page.facts,page.limitations),next:page.next};
    }catch(error){return {facts:[],next:null,reason:await this.failed('memory_dashboard_facts_failed',error)};}
  }

  /** The coverage line: how many live facts cite their messages, know only their learning batch, or neither. */
  async coverage(principal:Reader):Promise<{coverage:{total:number;exact:number;with_others:number;none:number}|null;reason?:FactsReason}> {
    admin(principal);
    const space=await this.memory.dashboardSpace();
    if(!space)return {coverage:null,reason:'no_memory'};
    if(!this.engine.citationCoverage)return {coverage:null,reason:'not_supported'};
    try {
      const found=await this.engine.citationCoverage(space.id);
      return {coverage:{total:found.explicit,exact:found.cited,with_others:found.batchOnly,none:found.none}};
    }catch(error){return {coverage:null,reason:await this.failed('memory_dashboard_coverage_failed',error)};}
  }
}
