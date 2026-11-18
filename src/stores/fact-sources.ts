import type pg from 'pg';
import type {Reader} from '../access.js';
import type {EngineFact} from '../memory/engine.js';
import {bucketOf} from '../source-facts.js';
import {factBy,factOrder,headerSource,type FactCited,type TagBy} from '../source-tags.js';
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
 * `exact` only when the engine cited its messages and every one maps to a receipt the reader may read.
 */
export interface SourcedFact {fact:EngineFact;sources:string[];readable:SourceReference[];header:SourceReference|null;by:TagBy;exact:boolean;more:number;complete:boolean}

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
      const ordered=factOrder(cited),exact=fact.exact===true&&!unmapped&&cited.length>0&&cited.every(item=>item.bucket!==null);
      const header=headerSource(ordered),shown=ordered.filter(item=>item.bucket!==null);
      return {fact,sources:ordered.flatMap(item=>item.id===null?[]:[item.id]),readable:shown.map(item=>item.reference!),header:header?.reference??null,
        by:factBy(ordered,exact),exact,more:Math.max(0,shown.length-(header?1:0)),complete:fact.complete&&!unmapped};
    });
  }
}
