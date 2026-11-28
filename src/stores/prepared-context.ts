import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {segments} from '../prepared-context.js';
import {literalSpans,mask,mergeSpans,patternSpans} from '../guard.js';
import {replaceValues,requestFields,structureOnly,textValues,type Structure} from '../guarded.js';
import type {SourceReference} from './archive.js';
import type {OperationReference} from './operations.js';
import {DerivedRepository,type DerivativeReference} from './derived.js';
import {GuardRepository,afterEpoch,jobRun,type GuardBinding} from './guards.js';
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
/** Single-text checks one detector batch may make to confirm its findings before they are shared (ADR-0251). */
const CONFIRMATIONS=3;
/** The shared result of a text with a finding that no check of that text alone has confirmed: no audience reuses it, so
 *  each checks the text itself until a check of the text alone confirms a finding, kept under its own key (ADR-0251). */
const UNCONFIRMED=canonical({unconfirmed:true});
/** Whether each span `batch` marks in `text` lies inside a span of `found` or of a fixed secret pattern. */
const covers=(text:string,found:readonly string[],batch:readonly string[])=>{
  try {
    const spans=mergeSpans(text,[...literalSpans(text,found),...patternSpans(text)]);
    return literalSpans(text,batch).every(span=>spans.some(cover=>cover.start<=span.start&&span.end<=cover.end));
  } catch {return false;}
};
/** Keys other than `id`, `*_id` and `*_ids` under which Nocheh's own answers name its own records (ADR-0314). */
const ID_KEYS:ReadonlySet<string>=new Set(['parent','scope','project','group','task','event','source','source_event','repeated_to','repeated_from']);
/** Fields whose keys and values someone else chose, such as a task's owner-named properties or an outside app's ids: never Nocheh's ids. */
const NOT_IDS:ReadonlySet<string>=new Set(['properties','external']);
const OWN_ID=/^[a-f0-9]{64}$/;
/** Nocheh's own record ids in an answer of one of its routes: each whole 64-hex value under an id key (ADR-0314). A value
 *  in free text, such as a task's title or notes, is not one, so the secret check still reads it. */
export function ownIds(value:unknown,key='',found=new Set<string>(),depth=0):Set<string> {
  if(depth>60||NOT_IDS.has(key))return found;
  if(typeof value==='string'){if(OWN_ID.test(value)&&(key==='id'||/_ids?$/.test(key)||ID_KEYS.has(key)))found.add(value);}
  else if(Array.isArray(value))for(const item of value)ownIds(item,key,found,depth+1);
  else if(value&&typeof value==='object')for(const [name,item] of Object.entries(value))ownIds(item,name,found,depth+1);
  return found;
}
export interface PrepareOptions {
  /** The value is a model request: its role, type, name and model fields and its tool ids are structure (ADR-0251). */
  request?:boolean;
}

type Input={text:string;key:string;output:DerivativeReference;literals?:string[]};
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
  /** Trusted service callers only: call after checking and preparing the returned data. Values in `except` are not marked prepared. */
  async allow(principal:Reader,value:unknown,except?:ReadonlySet<string>):Promise<void> {
    if(principal.admin)return;
    const binding=await this.audience.assert(principal);if(binding.mode==='off')return;
    const scope=preparedAudience(principal),values=[...new Set(leaves(value).filter(text=>!except?.has(text)).flatMap(text=>[text,JSON.stringify(text).slice(1,-1)]))];
    for(let offset=0;offset<values.length;offset+=500) {
      const batch=values.slice(offset,offset+500);
      await this.derived.pool.query(`INSERT INTO runtime_prepared_values(id,audience,generation,epoch,content)
        SELECT id,$2,$3,$4,content FROM unnest($1::text[],$5::bytea[]) AS prepared(id,content) ON CONFLICT DO NOTHING`,
        [batch.map(text=>digest(canonical([scope,binding,text]))),scope,binding.generation,binding.epoch,batch.map(text=>Buffer.from(text))]);
    }
    await this.audience.assert(principal);
  }

  /** Nocheh's own record ids in an answer a turn reads pass the secret check, here and when the agent hands that answer to
   *  the model: a 64-hex id looks like a key to the check, and a hidden id cannot be used again (ADR-0314). */
  async allowIds(principal:Reader,value:unknown):Promise<void> {
    const ids=ownIds(value);if(ids.size)await this.allow(principal,[...ids]);
  }

  /** A job run's preparation runs again when an epoch it carries across commits meanwhile (ADR-0208). */
  async prepare(principal:Reader,value:unknown,detect:(text:string,background?:boolean)=>Promise<unknown>,options:PrepareOptions={}):Promise<unknown> {
    return afterEpoch(jobRun(principal),()=>this.prepareOnce(principal,value,detect,options));
  }
  private async prepareOnce(principal:Reader,value:unknown,detect:(text:string,background?:boolean)=>Promise<unknown>,options:PrepareOptions):Promise<unknown> {
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
    // Fresh text this request carries only as structure, which a finding never masks here, spends no single-text check.
    const keep=structureOnly(value,options.request?requestFields:undefined);
    const carried=new Set([...plans].filter(([original])=>!keep.has(original)).flatMap(([,parts])=>parts.map(part=>part.text)));
    const structural=new Set([...fresh.keys()].filter(text=>!carried.has(text)));
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
        await this.guard(principal,binding,root,scope,owned,outputs,detect,structural);
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
    // Structure is never masked by a secret check's finding, only by the fixed secret patterns: a finding that is a field name
    // or a role would break the request (ADR-0251). Text left whole, such as an owner-approved passage, stays whole. A
    // structural value that differs from its guarded copy is not marked prepared, or the same word would pass unchecked
    // inside this audience's later text.
    const kept=new Map<string,string>(),exempt=new Set<string>();
    const structure:Structure={...(options.request?{fields:requestFields}:{}),text:original=>{
      let text=kept.get(original);
      if(text===undefined) {
        const guarded=replacements.get(original)??original;
        text=guarded===original?original:mask(original,patternSpans(original)).text;kept.set(original,text);
        if(text!==guarded)exempt.add(text);
      }
      return text;
    }};
    const result=replaceValues(value,replacements,structure);await this.audience.assert(principal);await this.allow(principal,result,exempt);return result;
  }

  private async guard(principal:Reader,binding:GuardBinding,root:SourceReference|OperationReference,scope:string,
    owned:Map<string,{key:string}>,outputs:Map<string,string>,detect:(text:string,background?:boolean)=>Promise<unknown>,structural:ReadonlySet<string>) {
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
      const inputs:Input[]=[];
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
        // Each text has two shared rows under one digest, and the first result saved in each is the one every audience reads:
        // the text's result, and the finding of a check of the text alone (ADR-0251). A reader masks what either one holds.
        const shared=new Map(missing.map(input=>[input,digest(canonical([detector,this.detectorVersion,input.output.input_hash]))]));
        const result=(input:Input)=>'context-detection-text:'+shared.get(input)!,confirmed=(input:Input)=>'context-detection-text-confirmed:'+shared.get(input)!;
        const known=(await this.derived.pool.query(`SELECT operation_id,content,content_hash,input_hash,producer_version,imported
          FROM derived_artifacts WHERE operation_id=ANY($1::text[]) AND kind='guard_result'`,[missing.flatMap(input=>[confirmed(input),result(input)])])).rows;
        const saved=(input:Input,operation:string)=>{
          const row=known.find(candidate=>candidate.operation_id===operation);
          return row&&!row.imported&&digest(row.content)===row.content_hash&&row.input_hash===input.output.input_hash&&row.producer_version===this.detectorVersion?
            JSON.parse(row.content.toString()) as unknown:undefined;
        };
        // Texts held back: some check found something in them that no check of the text alone has confirmed yet.
        const held=new Set<Input>();
        for(const input of missing) {
          const found=[saved(input,confirmed(input)),saved(input,result(input))];
          if(found.some(Array.isArray))input.literals=[...new Set(found.filter(Array.isArray).flat() as string[])];
          else if(found[1]!==undefined)held.add(input);
        }
        const unknown=missing.filter(input=>input.literals===undefined),results=new Map<Input,string>(),confirmations=new Map<Input,string[]>();
        if(unknown.length) {
          const joined=unknown.map(input=>input.text).join('\n<NOCHEH_FRAGMENT>\n');
          // Memory reviews and background job runs let replies take detector slots first.
          const background=principal.purpose==='memory-review'||!!principal.logical_profile?.startsWith('job-');
          await this.audience.assert(principal);const literals=await detect(joined,background);literalSpans(joined,literals);
          if(!(literals as string[]).every(literal=>unknown.some(input=>input.text.includes(literal))))throw new HttpError(422,'guard_candidate_rejected');
          for(const input of unknown)input.literals=(literals as string[]).filter(literal=>input.text.includes(literal));
          // Another text in the batch can steer what the check finds in this one, so a finding reaches other audiences only
          // from a check of this text alone (ADR-0251); this audience keeps what it found. A text checked alone, or one with
          // nothing found beyond the fixed secret patterns, shares its result as before. Any other text with a finding is
          // held back before anything else runs, so a later empty result cannot take its place. Up to CONFIRMATIONS of these
          // and of the texts held back earlier are each checked once more alone, side by side, and a finding of that check
          // that covers the batch's finding is shared. A string this request carries only as structure is never masked by a
          // finding, so it spends no check.
          const alone=unknown.length===1,confirm:Input[]=[];
          for(const input of unknown) {
            const found=input.literals!;
            if(alone) {
              if(!held.has(input))results.set(input,canonical(found));
              if(found.length)confirmations.set(input,found);
            } else if(!held.has(input)&&covers(input.text,[],found))results.set(input,canonical([]));
            else {
              if(!held.has(input))results.set(input,UNCONFIRMED);
              if(!structural.has(input.text)&&confirm.length<CONFIRMATIONS)confirm.push(input);
            }
          }
          for(const [input,content] of results)await this.share(result(input),input.output,content,root,detector);
          const checked=await Promise.allSettled(confirm.map(async input=>{
            const found=await detect(input.text,background);literalSpans(input.text,found);return [...new Set(found as string[])];
          }));
          for(const [index,check] of checked.entries()) {
            const input=confirm[index]!;
            if(check.status==='rejected') {
              // The text stays held back for the next audience to check; this audience's own check stands, so the turn goes on.
              console.warn(JSON.stringify({event:'secret_check_confirmation_failed',code:check.reason instanceof HttpError?check.reason.code:'detector_unavailable'}));
              continue;
            }
            const batch=input.literals!;input.literals=[...new Set([...batch,...check.value])];
            if(check.value.length&&covers(input.text,check.value,batch))confirmations.set(input,check.value);
          }
        }
        // One derived transaction checkpoints the entire completed detector batch.
        await this.derived.recordMany(missing.map(input=>({operation_id:'context-detection:'+input.key,source:root,parents:[input.output],kind:'guard_result',
          content:Buffer.from(canonical(input.literals)),producer:'nocheh-context-detector',producer_version:this.detectorVersion,
          configuration:{audience:scope,binding},provenance:{purpose:principal.purpose??'assistant'}})));
        for(const [input,found] of confirmations)await this.share(confirmed(input),input.output,canonical(found),root,detector);
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

  /** Saves a text's shared result. The first one saved wins, and a later one is dropped. */
  private async share(operation:string,output:DerivativeReference,content:string,root:SourceReference|OperationReference,
    detector:{generation:string;mode:string}) {
    await this.derived.record({operation_id:operation,source:root,parents:[output],kind:'guard_result',
      content:Buffer.from(content),producer:'nocheh-context-detector',producer_version:this.detectorVersion,
      configuration:{detector},provenance:{purpose:'shared-detection'}})
      .catch(error=>{if(!(error instanceof HttpError&&error.code==='derivative_identity_conflict'))throw error;});
  }

  private async publish(work:()=>Promise<void>) {
    if(this.publishing>=4)await new Promise<void>(resolve=>this.publishers.push(resolve));else this.publishing++;
    try{await work();}finally{const next=this.publishers.shift();if(next)next();else this.publishing--;}
  }
}
