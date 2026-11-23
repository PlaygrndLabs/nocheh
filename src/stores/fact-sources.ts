import type pg from 'pg';
import type {Reader} from '../access.js';
import type {EngineFact} from '../memory/engine.js';
import {bucketOf} from '../source-facts.js';
import {factBy,factOrder,factPlaceOnly,headerSource,type FactCited,type TagBy} from '../source-tags.js';
import {readSetParam,readSetSql,recallCondition,type ReadSet} from '../spaces.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {GuardBinding} from './guards.js';
import type {NoteSourceRepository} from './note-sources.js';

/** Whose receipts a reader's facts map through: the reader's audience, with its group when the group's topics share
 *  memory (recallCondition, as recall and search read them), or the read set of a private answer (readSetSql). */
export interface FactAudience {audience:string;group:readonly string[]|null;reads?:ReadSet|null}
/**
 * A recalled fact with the archived messages it came from (ADR-0261, B2): `sources` are all of them this reader's audience
 * holds, readable or not, in factOrder, so a later retirement of any of them is found (`complete` says whether the engine
 * named every message; an uncited fact names at most a few of its batch). `readable` are those the reader may read, in
 * the same order; `header` the one its source line names (headerSource); `more` how many other readable ones it has.
 * `exact` only when the engine cited every one of its messages and each maps to a receipt the reader may read. `complete`
 * only for such a cited, uncut list: a fact learned with its batch rests on messages of other people that Honcho never
 * names (it keeps only the observed peer's). `place` when its source line names only where and when (factPlaceOnly).
 */
export interface SourcedFact {fact:EngineFact;sources:string[];readable:SourceReference[];header:SourceReference|null;by:TagBy;exact:boolean;more:number;
  complete:boolean;place:boolean}

type Receipt={peer:string;primary:SourceReference|null;references:SourceReference[];valid:boolean};
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const referenceOf=(value:any):SourceReference|null=>value&&value.store==='archive'&&value.kind==='event'&&fullId(value.id)?value as SourceReference:null;

/**
 * Where each recalled fact came from (B2.1, B2.2): its engine messages map to receipts through memory_receipts_remote in
 * one query, limited to receipts that are done, not retired and in the reader's audience; every message of a receipt is a
 * source. Messages are checked for the reader in one batch (readable, which is canRead, read as they were learned:
 * historical), and classed once (classesFor). A message that maps to nothing or that the reader cannot read counts as
 * someone else's words, makes the fact not exact, and is never shown or counted.
 */
export class FactSourceRepository {
  constructor(readonly control:Pick<pg.Pool,'query'>,readonly access:Pick<SourceAccessRepository,'readable'>,readonly notes:Pick<NoteSourceRepository,'classesFor'>){}

  /** The archived messages behind engine messages, as the receipt that wrote each holds them, for this audience: the
   *  message it was written for (`primary`) and every message it carries. */
  async receipts(generation:string,writes:readonly string[],scope:FactAudience):Promise<Map<string,Receipt>> {
    const found=new Map<string,Receipt>();
    if(!writes.length)return found;
    const reads=scope.reads?readSetParam(scope.reads):null;
    const rows=(await this.control.query(`SELECT remote_id,peer_id,source_reference,source_references FROM memory_ingestion_receipts
      WHERE generation=$1 AND remote_id=ANY($2::text[]) AND state='done' AND retired_at IS NULL
      AND (CASE WHEN $5::text[] IS NOT NULL THEN ${readSetSql('audience',5)} ELSE ($3::text='owner' OR ${recallCondition('audience','$3','$4')}) END)
      ORDER BY id`,[generation,[...new Set(writes)],scope.audience,scope.group===null?null:[...scope.group],reads])).rows;
    for(const row of rows) {
      if(found.has(row.remote_id))continue;
      const listed=Array.isArray(row.source_references)&&row.source_references.length?row.source_references:[row.source_reference];
      const references=listed.map(referenceOf).filter((reference:SourceReference|null):reference is SourceReference=>reference!==null);
      found.set(String(row.remote_id),{peer:String(row.peer_id),primary:referenceOf(row.source_reference),references,valid:references.length===listed.length&&listed.length<=30});
    }
    return found;
  }

  async sourced(principal:Reader,binding:GuardBinding,generation:string,observed:string,facts:readonly EngineFact[],scope:FactAudience):Promise<SourcedFact[]> {
    const receipts=await this.receipts(generation,facts.flatMap(fact=>fact.writes),scope);
    const all=new Map<string,SourceReference>();
    for(const receipt of receipts.values())for(const reference of receipt.references)if(!all.has(reference.id))all.set(reference.id,reference);
    // Learned evidence is read as it was learned: a reaction changed later keeps its source (B2.3).
    const open=all.size?await this.access.readable(principal,[...all.values()],binding,{historical:true}):new Map<string,boolean>();
    const readable=[...all.keys()].filter(id=>open.get(id)===true);
    const classes=readable.length?await this.notes.classesFor(readable):new Map();
    return facts.map(fact=>{
      const cited:(FactCited&{reference:SourceReference|null})[]=[],seen=new Set<string>();let unmapped=false;
      for(const write of fact.writes) {
        const receipt=receipts.get(write);
        if(!receipt||!receipt.valid)unmapped=true;
        if(!receipt){cited.push({id:null,own:false,bucket:null,reference:null});continue;}
        for(const reference of receipt.references) {
          if(seen.has(reference.id))continue;seen.add(reference.id);
          const bucket=open.get(reference.id)===true?bucketOf(classes.get(reference.id)?.class??'unknown'):null;
          cited.push({id:reference.id,own:receipt.peer===observed,bucket,reference});
        }
      }
      // A cut citation list leaves messages out (a ninth may be anyone's), so only a whole one is exact.
      const complete=fact.exact===true&&fact.complete&&!unmapped&&cited.length>0;
      const ordered=factOrder(cited),exact=complete&&cited.every(item=>item.bucket!==null);
      const header=headerSource(ordered),shown=ordered.filter(item=>item.bucket!==null);
      return {fact,sources:ordered.flatMap(item=>item.id===null?[]:[item.id]),readable:shown.map(item=>item.reference!),header:header?.reference??null,
        by:factBy(ordered,exact),exact,more:Math.max(0,shown.length-(header?1:0)),complete,place:factPlaceOnly(ordered,exact)};
    });
  }
}

/** A fact as a record of facts stores it (B3.1, B3.6): every source, in order, so it opens by its number and a retired
 *  source is found. `peer` names whose fact it is in a recall's record; a per-turn block names its one `subject`. `place`
 *  when its source line names only where and when (factPlaceOnly). */
export type StoredFact={n:number;conclusion:string;peer?:string;exact:boolean;by:TagBy;time?:string|null;sources:string[];more:number;complete:boolean;
  session:string|null;place?:boolean;
  /** The wall a group's recall read the fact in: the fact is the wall's own copy (ADR-0286). */
  wall?:string};
/** A record of facts a turn read, by the id the model sees: its own row (configuration, kind, the guarded text) and the
 *  facts its unguarded parent keeps. */
export type FactRecord={id:string;kind:string;content_hash:string;configuration:Record<string,unknown>;facts:StoredFact[];subject:string|null};
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Whether a row is a record of facts the model reads: a per-turn block's bounded record, or a recall's guarded facts. */
const factRecordKind=(kind:string,configuration:any)=>kind==='memory_context'&&typeof configuration?.facts_digest==='string'||
  kind==='memory_result'&&configuration?.facts==='recall';
/**
 * The records of facts among these ids (B3.1, B3.6), in two queries. A record's facts live in the provenance of its one
 * parent, the engine's raw output, which the guard never reads, so a turn checks only the text it shows for secrets,
 * never every source id (the parent's workspace and audience must match). Any other id is left out.
 */
export async function factRecords(derived:Pick<pg.Pool,'query'>,ids:readonly string[]):Promise<Map<string,FactRecord>> {
  const found=new Map<string,FactRecord>(),wanted=[...new Set(ids)].filter(hex);
  if(!wanted.length)return found;
  const rows=(await derived.query(`SELECT id,kind,content_hash,provenance FROM derived_artifacts WHERE id=ANY($1::text[])
    AND kind IN ('memory_context','memory_result')`,[wanted])).rows.filter(row=>factRecordKind(row.kind,row.provenance?.configuration));
  const parentOf=(row:any)=>{const parents=row.provenance?.parents;return Array.isArray(parents)&&parents.length===1&&hex(parents[0]?.id)?parents[0].id as string:null;};
  const parentIds=rows.map(parentOf).filter((id):id is string=>id!==null);
  const parents=new Map(parentIds.length?(await derived.query(`SELECT id,provenance FROM derived_artifacts WHERE id=ANY($1::text[]) AND kind='memory_result'`,
    [parentIds])).rows.map(row=>[row.id as string,row.provenance??{}]):[]);
  for(const row of rows) {
    const configuration=row.provenance.configuration,parent=parents.get(parentOf(row)??''),stored=parent?.configuration;
    if(!parent||!Array.isArray(parent.facts)||!parent.facts.length||stored?.workspace!==configuration.workspace||stored?.audience!==configuration.audience)continue;
    found.set(row.id,{id:row.id,kind:row.kind,content_hash:row.content_hash,configuration,facts:parent.facts,
      subject:typeof parent.subject==='string'?parent.subject:null});
  }
  return found;
}
