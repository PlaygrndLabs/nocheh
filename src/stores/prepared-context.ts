import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {segments} from '../prepared-context.js';
import {literalSpans} from '../guard.js';
import {replaceValues,textValues} from '../guarded.js';
import type {SourceReference} from './archive.js';
import type {OperationReference} from './operations.js';
import {DerivedRepository,type DerivativeReference} from './derived.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {AudienceRepository} from './audience.js';
import {namedProfile} from './runtime-profile.js';

export const runtimeContextSchema=`
CREATE TABLE IF NOT EXISTS runtime_prepared_values (
 id text PRIMARY KEY,audience text NOT NULL,generation uuid NOT NULL,epoch bigint NOT NULL,content bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_values_audience ON runtime_prepared_values(audience,generation,epoch);
CREATE TABLE IF NOT EXISTS runtime_prepared_inputs (
 id text PRIMARY KEY,audience text NOT NULL,generation uuid NOT NULL,epoch bigint NOT NULL,
 source_id text NOT NULL REFERENCES guard_sources(id)
);
ALTER TABLE runtime_prepared_inputs ADD COLUMN IF NOT EXISTS text_key text;
CREATE INDEX IF NOT EXISTS runtime_inputs_text ON runtime_prepared_inputs(text_key,epoch);
`;
export const preparedAudience=(principal:Reader)=>canonical([principal.scope===null?'owner':principal.space??principal.scope,principal.purpose??'assistant',...(namedProfile(principal)?[namedProfile(principal)]:[])]);
const leaves=(value:unknown):string[]=>typeof value==='string'?(value?[value]:[]):Array.isArray(value)?value.flatMap(leaves):
  value&&typeof value==='object'?Object.values(value).flatMap(leaves):[];

type Deferred={promise:Promise<string>;resolve:(text:string)=>void;reject:(error:unknown)=>void};
const deferred=():Deferred=>{
  let resolve!:(text:string)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<string>((ok,fail)=>{resolve=ok;reject=fail;});
  promise.catch(()=>{}); // Waiters observe the failure; an unwaited one is not an unhandled rejection.
  return {promise,resolve,reject};
};

export class PreparedContextRepository {
  readonly audience:AudienceRepository;
  /** Fresh texts being guarded right now, by audience, binding and text. A second
   * request for the same text waits for that result instead of detecting it again. */
  private readonly inflight=new Map<string,Promise<string>>();
  /** Durable guarded publications at once across every preparation, below the pool size. */
  private publishing=0;private readonly publishers:(()=>void)[]=[];
  constructor(readonly derived:DerivedRepository,readonly guards:GuardRepository,
    readonly root:(principal:Reader,binding:GuardBinding)=>Promise<SourceReference|OperationReference>,readonly detectorVersion:string) {
    this.audience=new AudienceRepository(guards);
  }
  /** Trusted service callers only: call after checking and preparing the returned data. */
  async allow(principal:Reader,value:unknown):Promise<void> {
    if(principal.admin)return;
    const binding=await this.audience.assert(principal);if(binding.mode==='off')return;
    const scope=preparedAudience(principal),values=[...new Set(leaves(value).flatMap(text=>[text,JSON.stringify(text).slice(1,-1)]))];
    for(let offset=0;offset<values.length;offset+=500) {
      const batch=values.slice(offset,offset+500);
      await this.derived.pool.query(`INSERT INTO runtime_prepared_values(id,audience,generation,epoch,content)
        SELECT id,$2,$3,$4,content FROM unnest($1::text[],$5::bytea[]) AS prepared(id,content) ON CONFLICT DO NOTHING`,
        [batch.map(text=>digest(canonical([scope,binding,text]))),scope,binding.generation,binding.epoch,batch.map(text=>Buffer.from(text))]);
    }
    await this.audience.assert(principal);
  }

  async prepare(principal:Reader,value:unknown,detect:(text:string,background?:boolean)=>Promise<unknown>):Promise<unknown> {
    if(principal.admin||!principal.turnEvent)throw new HttpError(403,'bound_guard_context_required');
    const binding=await this.audience.assert(principal),root=await this.root(principal,binding);
    if(binding.mode==='off'){await this.audience.assert(principal);return value;}
    const scope=preparedAudience(principal);
    // Requests of one audience run side by side: Honcho asks for embeddings and
    // reasoning for every connected peer at once, all as one owner audience.
    // Only identical fresh text waits, so it is detected and published once.
    // Cross-process races still converge on immutable operation IDs.
    await this.audience.assert(principal);
    const known=(await this.derived.pool.query('SELECT content FROM runtime_prepared_values WHERE audience=$1 AND generation=$2 AND epoch=$3',
      [scope,binding.generation,binding.epoch])).rows.map(row=>row.content.toString() as string),knownSet=new Set(known);
    const replacements=new Map<string,string>(),plans=new Map<string,{text:string;prepared:boolean}[]>(),fresh=new Map<string,string>(),outputs=new Map<string,string>();
    for(const original of new Set(textValues(value))) {
      if(!original||knownSet.has(original)){replacements.set(original,original);continue;}
      const parts=segments(original,known).flatMap(part=>{
        if(part.prepared||part.text.length<=24000)return [part];
        const chunks=[];let offset=0;
        while(offset<part.text.length){let end=Math.min(offset+24000,part.text.length);if(end<part.text.length&&/[\uD800-\uDBFF]/.test(part.text[end-1]!))end--;
          chunks.push({text:part.text.slice(offset,end),prepared:false});offset=end;}return chunks;
      });
      plans.set(original,parts);
      // The detector is part of the key: a secret-check model chosen mid-epoch starts fresh copies instead of conflicting with earlier ones.
      for(const part of parts)if(!part.prepared&&part.text.trim())fresh.set(part.text,digest(canonical([scope,binding,this.detectorVersion,part.text])));
    }
    let remaining=[...fresh.entries()];
    while(remaining.length) {
      // Claim before any await, so a concurrent request sees the claim.
      const owned=new Map<string,{key:string;result:Deferred}>(),waiting:[string,string,Promise<string>][]=[];
      for(const [text,key] of remaining) {
        const other=this.inflight.get(key);
        if(other){waiting.push([text,key,other]);continue;}
        const result=deferred();this.inflight.set(key,result.promise);owned.set(text,{key,result});
      }
      try {
        await this.guard(principal,binding,root,scope,owned,outputs,detect);
        for(const [text,{result}] of owned)result.resolve(outputs.get(text)!);
      } catch(error) {
        for(const {result} of owned.values())result.reject(error);throw error;
      } finally {
        for(const {key,result} of owned.values())if(this.inflight.get(key)===result.promise)this.inflight.delete(key);
      }
      // A failed request elsewhere does not fail this one: its texts are guarded here next.
      remaining=[];
      for(const [index,settled] of (await Promise.allSettled(waiting.map(([,,promise])=>promise))).entries()) {
        const [text,key]=waiting[index]!;
        if(settled.status==='fulfilled')outputs.set(text,settled.value);else remaining.push([text,key]);
      }
    }
    for(const [original,parts] of plans)replacements.set(original,parts.map(part=>part.prepared||!part.text.trim()?part.text:outputs.get(part.text)!).join(''));
    const result=replaceValues(value,replacements);await this.audience.assert(principal);await this.allow(principal,result);return result;
  }

  private async guard(principal:Reader,binding:GuardBinding,root:SourceReference|OperationReference,scope:string,
    owned:Map<string,{key:string}>,outputs:Map<string,string>,detect:(text:string,background?:boolean)=>Promise<unknown>) {
    const candidates=[...owned.entries()].map(([text,{key}])=>[text,key] as [string,string]),pending:[string,string][]=[];
    // The guarded copy depends only on the text, the detector and its shared result, so the epoch is not part of this key.
    const textKey=(text:string)=>digest(canonical([scope,binding.generation,binding.mode,this.detectorVersion,text]));
    for(let offset=0;offset<candidates.length;offset+=500) {
      const slice=candidates.slice(offset,offset+500);
      const cache=(await this.derived.pool.query('SELECT id,source_id FROM runtime_prepared_inputs WHERE id=ANY($1::text[])',[slice.map(([,key])=>key)])).rows;
      const earlier=new Map((await this.derived.pool.query(`SELECT DISTINCT ON (text_key) text_key,source_id FROM runtime_prepared_inputs
        WHERE text_key=ANY($1::text[]) ORDER BY text_key,epoch DESC`,[slice.map(([text])=>textKey(text))])).rows.map(row=>[row.text_key as string,row.source_id as string]));
      for(const [text,key] of slice) {
        const cached=cache.find(row=>row.id===key);
        if(cached){const saved=await this.guards.read(cached.source_id,binding);outputs.set(text,(saved.value as {text:string}).text);continue;}
        // Unchanged text this audience prepared in an earlier epoch reuses that guarded copy; this epoch saves only a pointer to it.
        const reused=earlier.get(textKey(text));
        if(reused)try {
          const saved=await this.guards.read(reused,binding);
          await this.derived.pool.query(`INSERT INTO runtime_prepared_inputs(id,audience,generation,epoch,source_id,text_key)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[key,scope,binding.generation,binding.epoch,reused,textKey(text)]);
          outputs.set(text,(saved.value as {text:string}).text);continue;
        }catch(error){if(!(error instanceof HttpError&&error.code==='guard_preparation_pending'))throw error;}
        pending.push([text,key]);
      }
    }
    while(pending.length) {
      const batch:[string,string][]=[];let length=0;
      while(pending.length&&batch.length<500&&length+pending[0]![0].length+32<=50000){const item=pending.shift()!;batch.push(item);length+=item[0].length+32;}
      const inputs:{text:string;key:string;output:DerivativeReference;literals?:string[]}[]=[];
      for(const [text,key] of batch) {
        const saved=await this.derived.checkpoint('guard-context:'+key);
        if(saved&&(saved.content.toString()!==text||saved.producer_version!==this.detectorVersion||saved.configuration_hash!==digest(canonical({audience:scope,binding}))))
          throw new HttpError(409,'runtime_context_conflict');
        const output:DerivativeReference=saved?{store:'derived',kind:'artifact',id:saved.id,input_hash:saved.content_hash}:
          await this.derived.record({operation_id:'guard-context:'+key,source:root,kind:'runtime_context',content:Buffer.from(text),
            producer:'nocheh-context',producer_version:this.detectorVersion,configuration:{audience:scope,binding},provenance:{purpose:principal.purpose??'assistant'}});
        const detection=await this.derived.checkpoint('context-detection:'+key);
        if(detection&&detection.input_hash!==output.input_hash)throw new HttpError(409,'runtime_context_conflict');
        inputs.push({text,key,output,...(detection?{literals:JSON.parse(detection.content.toString()) as string[]}:{})});
      }
      const missing=inputs.filter(input=>input.literals===undefined);
      if(missing.length) {
        // Detector output depends only on the text and detector, so identical text
        // already checked for another audience or an earlier guard epoch of this
        // installation and mode reuses that result. Prepared values and guarded
        // copies stay per audience and epoch.
        const detector={generation:binding.generation,mode:binding.mode};
        const shared=new Map(missing.map(input=>[input,'context-detection-text:'+digest(canonical([detector,this.detectorVersion,input.output.input_hash]))]));
        const known=(await this.derived.pool.query(`SELECT operation_id,content,content_hash,input_hash,producer_version,imported
          FROM derived_artifacts WHERE operation_id=ANY($1::text[]) AND kind='guard_result'`,[[...shared.values()]])).rows;
        for(const input of missing) {
          const row=known.find(candidate=>candidate.operation_id===shared.get(input));
          if(row&&!row.imported&&digest(row.content)===row.content_hash&&row.input_hash===input.output.input_hash&&row.producer_version===this.detectorVersion)
            input.literals=JSON.parse(row.content.toString()) as string[];
        }
        const unknown=missing.filter(input=>input.literals===undefined);
        if(unknown.length) {
          const joined=unknown.map(input=>input.text).join('\n<NOCHEH_FRAGMENT>\n');
          await this.audience.assert(principal);const literals=await detect(joined,principal.purpose==='memory-review');literalSpans(joined,literals);
          if(!(literals as string[]).every(literal=>unknown.some(input=>input.text.includes(literal))))throw new HttpError(422,'guard_candidate_rejected');
          for(const input of unknown)input.literals=(literals as string[]).filter(literal=>input.text.includes(literal));
        }
        // One derived transaction checkpoints the entire completed detector batch.
        await this.derived.recordMany(missing.map(input=>({operation_id:'context-detection:'+input.key,source:root,parents:[input.output],kind:'guard_result',
          content:Buffer.from(canonical(input.literals)),producer:'nocheh-context-detector',producer_version:this.detectorVersion,
          configuration:{audience:scope,binding},provenance:{purpose:principal.purpose??'assistant'}})));
        // The first result saved for a text is the one every audience reuses.
        for(const input of unknown)
          await this.derived.record({operation_id:shared.get(input)!,source:root,parents:[input.output],kind:'guard_result',
            content:Buffer.from(canonical(input.literals)),producer:'nocheh-context-detector',producer_version:this.detectorVersion,
            configuration:{detector},provenance:{purpose:'shared-detection'}})
            .catch(error=>{if(!(error instanceof HttpError&&error.code==='derivative_identity_conflict'))throw error;});
      }
      // Independent guarded copies keep their exact publication/checkpoint
      // identities. Bound SQL work below the pool size across every request
      // instead of serializing hundreds of durable commits before the first
      // model request. After a failure nothing new starts, and all started
      // work drains before the failure is reported.
      let failed=false;
      const completed=await Promise.allSettled(inputs.map(({text,key,output,literals})=>this.publish(async()=>{
        if(failed)return;
        try {
          literalSpans(text,literals);
          await this.guards.prepare(output,this.detectorVersion,async fragment=>literals!.filter(literal=>fragment.includes(literal)));
          const sourceId='derived_artifacts:'+output.id,prepared=await this.guards.read(sourceId,binding);
          await this.derived.pool.query(`INSERT INTO runtime_prepared_inputs(id,audience,generation,epoch,source_id,text_key)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[key,scope,binding.generation,binding.epoch,sourceId,textKey(text)]);
          outputs.set(text,(prepared.value as {text:string}).text);
        } catch(error){failed=true;throw error;}
      })));
      for(const result of completed)if(result.status==='rejected')throw result.reason;
    }
  }

  private async publish(work:()=>Promise<void>) {
    if(this.publishing>=4)await new Promise<void>(resolve=>this.publishers.push(resolve));else this.publishing++;
    try{await work();}finally{const next=this.publishers.shift();if(next)next();else this.publishing--;}
  }
}
