import {HttpError} from '../http.js';
import {recallCondition} from '../spaces.js';
import {engineId,engineUnsupported,type MemoryEngine} from '../memory/engine.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import type {StorePools} from './connections.js';

/** Which sessions a long-term memory read may use, and which archived messages an engine's facts came from. */
export class MemoryProvenanceRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly guards:GuardRepository,readonly engine:MemoryEngine){}

  /** One memory space serves the installation; guard epochs never retire it.
   * The audience only limits which sessions a read may use. */
  async current(workspace:string,audience:string,binding:GuardBinding):Promise<void> {
    await this.guards.assertCurrent(binding);
    if(typeof audience!=='string'||!audience||audience.length>256)throw new HttpError(400,'invalid_memory_audience');
    const found=(await this.stores.control.query(`SELECT 1 FROM memory_generations g CROSS JOIN memory_engine_connection c
      WHERE g.id=$1 AND g.installation_generation=$2 AND g.state<>'retired'
      AND c.singleton AND c.attached`,[workspace,binding.generation])).rowCount;
    if(!found)throw new HttpError(409,'memory_context_retired');
  }
  /** Sessions an audience may read: its own sessions with completed writes, newest first.
   * With `group`, the sessions of that group's base conversation and every one of its topics. */
  async sessions(workspace:string,audience:string,limit=1000,group:string|null=null):Promise<string[]> {
    return (await this.stores.control.query(`SELECT s.session_id FROM memory_sessions s WHERE s.workspace=$1 AND ${recallCondition('s.audience','$2','$4')}
      AND EXISTS(SELECT 1 FROM memory_ingestion_receipts r WHERE r.session_id=s.session_id AND r.retired_at IS NULL AND r.state='done')
      ORDER BY s.updated_at DESC,s.session_id LIMIT $3`,[workspace,audience,limit,group])).rows.map(row=>String(row.session_id));
  }
  /** Owner reads span the space (null). Any other audience reads only its own sessions and fails closed. */
  async chatScope(workspace:string,audience:string):Promise<string[]|null> {
    if(audience==='owner')return null;
    const sessions=await this.sessions(workspace,audience);
    if(!sessions.length)throw new HttpError(409,'learning_context_pending');
    return sessions;
  }
  async read(workspace:string,audience:string,factIds:string[],binding:GuardBinding) {
    if(!/^[a-f0-9]{64}$/.test(workspace)||!Array.isArray(factIds)||factIds.length<1||factIds.length>32||factIds.some(id=>!engineId(id)))
      throw new HttpError(400,'invalid_provenance_request');
    await this.current(workspace,audience,binding);
    if(!this.engine.trace)throw engineUnsupported();
    const result=await this.engine.trace(workspace,factIds);
    // Each fact brings the writes it cites (true), its whole learning batch when it has no citations (false),
    // or none (null). The chain is exact only when every fact that brought writes cites them.
    const facts=result.facts.map(fact=>({id:fact.id,parents:fact.parents,deleted:fact.deleted,exact_citations:fact.exactCitations}));
    const exact=facts.some(fact=>fact.exact_citations===true)&&facts.every(fact=>fact.exact_citations!==false);
    const limitations=new Set<string>(result.limitations);if(facts.some(fact=>fact.exact_citations===false))limitations.add('ancestry_is_not_an_exact_citation');
    const evidence=new Map<string,SourceReference>();
    for(const write of result.writes) {
      const row=(await this.stores.control.query(`SELECT source_reference,source_references FROM memory_ingestion_receipts
        WHERE id=$1 AND generation=$2 AND remote_id=$3 AND state='done' AND ($4::text='owner' OR audience=$4)`,[write.receipt,workspace,write.id,audience])).rows[0];
      if(!row){limitations.add('ingestion_reference_unavailable');continue;}
      const references=row.source_references?.length?row.source_references:[row.source_reference];
      if(references.length>30)throw new HttpError(502,'invalid_ingestion_provenance');
      for(const item of references) {
        if(evidence.has(item.id))continue;
        if(evidence.size>=256){limitations.add('source_reference_limit');continue;}
        const reference=(await this.archive.verify(item)).reference;evidence.set(reference.id,reference);
      }
    }
    await this.current(workspace,audience,binding);
    return {conclusions:facts,evidence:[...evidence.values()],limitations:[...limitations].sort(),exact_citations:exact};
  }
}
