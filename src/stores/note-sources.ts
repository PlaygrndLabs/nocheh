import type pg from 'pg';
import type {AssistantPolicy} from '../assistant-policy.js';
import {eventClass,sourceFacts,type EventClass,type SourceFacts} from '../source-facts.js';

type Pools={archive:Pick<pg.Pool,'query'>;derived:Pick<pg.Pool,'query'>};
const fullId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/**
 * Where learned notes came from (risk 5): the facts code reads about archived messages, from their originals, their
 * selected transcripts and extracted texts, and the archive's own authors, never from what they say. Event ids only go
 * in; a message that is gone or cannot be read is simply not in the result, which callers treat as unknown.
 */
export class NoteSourceRepository {
  constructor(readonly stores:Pools,readonly policy:()=>Pick<AssistantPolicy,'owner_id'>){}

  /** The facts of each of these events, by id, in three batched reads. */
  async factsFor(ids:readonly string[]):Promise<Map<string,SourceFacts>> {
    const wanted=[...new Set(ids.filter(fullId))],found=new Map<string,SourceFacts>();
    if(!wanted.length)return found;
    // The authors the archive proved for an event (authored_by): only a Telegram Desktop export reads them.
    const events=(await this.stores.archive.query(`SELECT e.id,e.kind,e.channel,e.payload,a.authors FROM events e
      LEFT JOIN LATERAL (SELECT coalesce(json_agg(json_build_object('namespace',o.namespace,'kind',o.kind,'external_id',o.external_id) ORDER BY o.id),'[]') AS authors
        FROM source_relations r JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=e.id AND r.kind='authored_by') a ON true
      WHERE e.id=ANY($1::text[])`,[wanted])).rows;
    const selected=(await this.stores.derived.query(`SELECT event_id,artifact_id,kind FROM derivative_selections WHERE event_id=ANY($1::text[])
      AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY event_id,id`,[wanted])).rows;
    const artifacts=new Map<string,{kind:string;file_name:string|null}>();
    const files=[...new Set(selected.map(item=>item.artifact_id).filter((id):id is string=>typeof id==='string'))];
    if(files.length)for(const item of (await this.stores.archive.query(`SELECT id,kind,metadata->>'file_name' AS file_name FROM artifacts WHERE id=ANY($1::text[])`,[files])).rows)
      artifacts.set(item.id,{kind:item.kind,file_name:item.file_name??null});
    const owner=this.policy().owner_id;
    for(const event of events) {
      let payload:unknown=null;
      try{payload=JSON.parse((event.payload as Buffer).toString());}catch{}
      // A derivative whose artifact is not found reads as an audio file's transcript or a file's text: never the sender's own voice.
      const derivatives=selected.filter(item=>item.event_id===event.id).map(item=>({kind:item.kind as string,artifact:artifacts.get(item.artifact_id)?.kind??'',
        file_name:artifacts.get(item.artifact_id)?.file_name??null}));
      found.set(event.id,sourceFacts({channel:event.channel,kind:event.kind,payload,derivatives,authors:Array.isArray(event.authors)?event.authors:[]},owner));
    }
    return found;
  }

  /** The facts and class of each of these events. A reply of Nocheh's is read with the message it answered, so a reply
   *  about someone else's forward is classed as being about that forward. */
  async classesFor(ids:readonly string[]):Promise<Map<string,{facts:SourceFacts;class:EventClass}>> {
    const facts=await this.factsFor(ids);
    const answered=[...facts.values()].map(item=>item.answers).filter((id):id is string=>!!id&&!facts.has(id));
    const targets=answered.length?await this.factsFor(answered):new Map<string,SourceFacts>();
    const of=(id:string|null)=>id===null?null:facts.get(id)??targets.get(id)??null;
    return new Map([...facts].map(([id,item])=>[id,{facts:item,class:eventClass(item,of(item.answers))}]));
  }
}
