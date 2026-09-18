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
`;
export const preparedAudience=(principal:Reader)=>canonical([principal.scope===null?'owner':principal.space??principal.scope,principal.purpose??'assistant',...(namedProfile(principal)?[namedProfile(principal)]:[])]);
const leaves=(value:unknown):string[]=>typeof value==='string'?(value?[value]:[]):Array.isArray(value)?value.flatMap(leaves):
  value&&typeof value==='object'?Object.values(value).flatMap(leaves):[];

export class PreparedContextRepository {
  readonly audience:AudienceRepository;
  private readonly preparing=new Map<string,Promise<void>>();
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

  async prepare(principal:Reader,value:unknown,detect:(text:string)=>Promise<unknown>):Promise<unknown> {
    if(principal.admin||!principal.turnEvent)throw new HttpError(403,'bound_guard_context_required');
    const binding=await this.audience.assert(principal),root=await this.root(principal,binding);
    if(binding.mode==='off'){await this.audience.assert(principal);return value;}
    const scope=preparedAudience(principal),lock=canonical([scope,binding]);
    // Do not hold a pooled SQL connection while another preparation waits or a
    // detector runs. Cross-process races still converge on immutable operation IDs.
    const preceding=this.preparing.get(lock)??Promise.resolve();let release!:()=>void;
    const current=new Promise<void>(resolve=>{release=resolve;}),queued=preceding.then(()=>current);
    this.preparing.set(lock,queued);await preceding;
    try {
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
        for(const part of parts)if(!part.prepared&&part.text.trim())fresh.set(part.text,digest(canonical([scope,binding,part.text])));
      }
      const candidates=[...fresh.entries()];
      for(let offset=0;offset<candidates.length;offset+=500) {
        const cache=(await this.derived.pool.query('SELECT id,source_id FROM runtime_prepared_inputs WHERE id=ANY($1::text[])',
          [candidates.slice(offset,offset+500).map(([,key])=>key)])).rows;
        for(const [text,key] of candidates.slice(offset,offset+500)) {
          const cached=cache.find(row=>row.id===key);if(!cached)continue;
          const saved=await this.guards.read(cached.source_id,binding);outputs.set(text,(saved.value as {text:string}).text);fresh.delete(text);
        }
      }
      const pending=[...fresh.entries()];
      while(pending.length) {
        const batch:[string,string][]=[];let length=0;
        while(pending.length&&length+pending[0]![0].length+32<=50000){const item=pending.shift()!;batch.push(item);length+=item[0].length+32;}
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
          const joined=missing.map(input=>input.text).join('\n<NOCHEH_FRAGMENT>\n');
          await this.audience.assert(principal);const literals=await detect(joined);literalSpans(joined,literals);
          if(!(literals as string[]).every(literal=>missing.some(input=>input.text.includes(literal))))throw new HttpError(422,'guard_candidate_rejected');
          for(const input of missing)input.literals=(literals as string[]).filter(literal=>input.text.includes(literal));
          // One derived transaction checkpoints the entire completed detector batch.
          await this.derived.recordMany(missing.map(input=>({operation_id:'context-detection:'+input.key,source:root,parents:[input.output],kind:'guard_result',
            content:Buffer.from(canonical(input.literals)),producer:'nocheh-context-detector',producer_version:this.detectorVersion,
            configuration:{audience:scope,binding},provenance:{purpose:principal.purpose??'assistant'}})));
        }
        for(const {text,key,output,literals} of inputs) {
          literalSpans(text,literals);
          await this.guards.prepare(output,this.detectorVersion,async fragment=>literals!.filter(literal=>fragment.includes(literal)));
          const sourceId='derived_artifacts:'+output.id,prepared=await this.guards.read(sourceId,binding);
          await this.derived.pool.query(`INSERT INTO runtime_prepared_inputs(id,audience,generation,epoch,source_id)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[key,scope,binding.generation,binding.epoch,sourceId]);
          outputs.set(text,(prepared.value as {text:string}).text);
        }
      }
      for(const [original,parts] of plans)replacements.set(original,parts.map(part=>part.prepared||!part.text.trim()?part.text:outputs.get(part.text)!).join(''));
      const result=replaceValues(value,replacements);await this.audience.assert(principal);await this.allow(principal,result);return result;
    } finally {release();if(this.preparing.get(lock)===queued)this.preparing.delete(lock);}
  }
}
