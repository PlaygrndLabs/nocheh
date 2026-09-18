import {canonical} from '../archive.js';
import {HttpError} from '../http.js';
import type {HonchoCall} from '../honcho.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import type {StorePools} from './connections.js';

const nativeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{21}$/.test(value);
export class HonchoProvenanceRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly guards:GuardRepository,readonly call:HonchoCall){}

  async current(workspace:string,audience:string,binding:GuardBinding):Promise<void> {
    await this.guards.assertCurrent(binding);
    const found=(await this.stores.control.query(`SELECT 1 FROM memory_generations g CROSS JOIN memory_engine_connection c
      WHERE g.id=$1 AND g.audience=$2 AND g.installation_generation=$3 AND g.guard_epoch=$4 AND g.state<>'retired'
      AND c.singleton AND c.attached AND c.verified`,[workspace,audience,binding.generation,binding.epoch])).rowCount;
    if(!found)throw new HttpError(409,'memory_context_retired');
  }
  async read(workspace:string,audience:string,conclusionIds:string[],binding:GuardBinding) {
    if(!/^[a-f0-9]{64}$/.test(workspace)||!Array.isArray(conclusionIds)||conclusionIds.length<1||conclusionIds.length>32||conclusionIds.some(id=>!nativeId(id)))
      throw new HttpError(400,'invalid_provenance_request');
    await this.current(workspace,audience,binding);
    const result=await this.call('/v3/workspaces/'+workspace+'/nocheh/provenance',{conclusion_ids:conclusionIds});
    if(!result||!Array.isArray(result.nodes)||result.nodes.length>128||!Array.isArray(result.messages)||result.messages.length>256||
      !Array.isArray(result.limitations)||result.limitations.length>20||result.limitations.some((v:unknown)=>typeof v!=='string'||v.length>100)||
      canonical(result.roots)!==canonical(conclusionIds)||result.nodes.some((v:any)=>!nativeId(v.id)||!Array.isArray(v.parents)||v.parents.length>128||v.parents.some((p:unknown)=>!nativeId(p))))
      throw new HttpError(502,'invalid_honcho_provenance');
    const limitations=new Set<string>(result.limitations);limitations.add('ancestry_is_not_an_exact_citation');
    const evidence=new Map<string,SourceReference>();
    for(const message of result.messages) {
      if(!nativeId(message.message_id)||typeof message.receipt_id!=='string'||!/^[a-f0-9]{64}$/.test(message.receipt_id))throw new HttpError(502,'invalid_honcho_provenance');
      const row=(await this.stores.control.query(`SELECT source_reference,source_references FROM memory_ingestion_receipts
        WHERE id=$1 AND generation=$2 AND remote_id=$3 AND state='done'`,[message.receipt_id,workspace,message.message_id])).rows[0];
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
    return {conclusions:result.nodes.map((n:any)=>({id:n.id,parents:n.parents,deleted:n.deleted===true})),evidence:[...evidence.values()],
      limitations:[...limitations].sort(),exact_citations:false as const};
  }
}
