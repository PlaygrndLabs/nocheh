import type pg from 'pg';
import { canonical, digest } from './archive.js';
import { HttpError, object, string } from './http.js';

export type GuardMode='off'|'on';
export const DETECTOR_VERSION='gpt-literals-v1+patterns-v1';
export const POLICY_VERSION='exact-spans-v1';
export const DEFAULT_TRUSTED=['https://chatgpt.com/backend-api/codex'];
export interface Span {start:number;end:number}
export interface GuardPolicy {mode:GuardMode;trusted:readonly string[];detectorVersion:string}

export function trustedDestination(destination:string,trusted:readonly string[]):boolean {
  const target=new URL(destination);
  if (target.username || target.password) throw new HttpError(400,'invalid_destination');
  return trusted.some(entry=>{
    const base=new URL(entry),path=base.pathname.replace(/\/$/,'');
    return target.origin===base.origin && (target.pathname===path || target.pathname.startsWith(path+'/'));
  });
}
export function requiresGuard(policy:GuardPolicy,destination:string):boolean {
  if (!['off','on'].includes(policy.mode)) throw new HttpError(400,'invalid_guard_mode');
  return policy.mode==='on';
}
export function literalSpans(text:string,literals:unknown):Span[] {
  if (!Array.isArray(literals) || literals.length>1000) throw new HttpError(503,'detector_contract_rejected');
  const spans:Span[]=[];
  for (const literal of literals) {
    if (typeof literal!=='string' || !literal || !text.includes(literal)) throw new HttpError(503,'detector_contract_rejected');
    let from=0;
    while (from<=text.length-literal.length) {
      const start=text.indexOf(literal,from);if (start<0) break;
      spans.push({start,end:start+literal.length});from=start+1;
      if (spans.length>10000) throw new HttpError(413,'too_many_secret_spans');
    }
  }
  return spans;
}
export function patternSpans(text:string):Span[] {
  const patterns=[
    /\b(?:password|passwd|pass|api[_ -]?key|access[_ -]?(?:token|code)|secret|token)\s*[:=]\s*["']?(?<secret>[^\s"'<>;,]{4,256})/giu,
    /\b(?<secret>sk-(?:proj-)?[A-Za-z0-9_-]{20,256})\b/g,
    /\b(?<secret>AKIA[A-Z0-9]{16})\b/g,
    /(?<secret>-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{1,16000}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/]+:(?<secret>[^\s@/]+)@/gi,
  ];
  const spans:Span[]=[];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value=match.groups?.secret;
    if (value) {const start=match.index+match[0].lastIndexOf(value);spans.push({start,end:start+value.length});}
  }
  return spans;
}
export function mergeSpans(text:string,spans:readonly Span[]):Span[] {
  const result:Span[]=[];
  for (const span of [...spans].sort((a,b)=>a.start-b.start || a.end-b.end)) {
    const splitsPair=(i:number)=>i>0 && i<text.length && /[\uD800-\uDBFF]/.test(text[i-1]!) && /[\uDC00-\uDFFF]/.test(text[i]!);
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start<0 || span.end>text.length || span.start>=span.end || splitsPair(span.start) || splitsPair(span.end)) throw new HttpError(503,'invalid_secret_span');
    const previous=result.at(-1);
    if (previous && span.start<=previous.end) previous.end=Math.max(previous.end,span.end);
    else result.push({...span});
  }
  return result;
}
export function mask(text:string,spans:readonly Span[]):{text:string;spans:Span[]} {
  const merged=mergeSpans(text,spans);let offset=0,output='';
  for (const span of merged) {output+=text.slice(offset,span.start)+'***';offset=span.end;}
  return {text:output+text.slice(offset),spans:merged};
}

function contentStrings(value:unknown,strings:Set<string>,depth=0):void {
  if (depth>60) throw new HttpError(413,'request_too_deep');
  if (typeof value==='string') {if(value)strings.add(value);return;}
  if (Array.isArray(value)) {for (const item of value)contentStrings(item,strings,depth+1);return;}
  if (value!==null && typeof value==='object') {
    const record=value as Record<string,unknown>;
    // An opaque server reference or attachment cannot be inspected as literal text.
    for (const key of ['previous_response_id','encrypted_content','image_url','input_audio','audio_url','file_data','file_id','image','audio','document']) {
      if (record[key]!==undefined && record[key]!==null) throw new HttpError(422,'uninspectable_model_context');
    }
    if (typeof record.type==='string' && ['input_image','input_audio','input_file','image','audio'].includes(record.type)) throw new HttpError(422,'uninspectable_model_context');
    for (const [key,item] of Object.entries(record)) {strings.add(key);contentStrings(item,strings,depth+1);}
  }
}
export function inspectRequest(value:unknown):void {
  if(Buffer.byteLength(canonical(value))>512*1024)throw new HttpError(413,'guard_request_too_large');
  contentStrings(value,new Set<string>());
}
function replaceStrings(value:unknown,replacements:Map<string,string>):unknown {
  if (typeof value==='string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v=>replaceStrings(v,replacements));
  if (value!==null && typeof value==='object') {
    const result:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
    for (const [key,item] of Object.entries(value)) {
      const guardedKey=replacements.get(key) ?? key;
      if (Object.hasOwn(result,guardedKey)) throw new HttpError(422,'guarded_key_collision');
      result[guardedKey]=replaceStrings(item,replacements);
    }
    return result;
  }
  return value;
}

export async function guardPayload(value:unknown,policy:GuardPolicy,destination:string,
  detect:(text:string)=>Promise<unknown>,pool?:pg.Pool):Promise<{payload:unknown;guarded:boolean;masked_spans:number;cache_hit:boolean}> {
  string(destination,2048);
  if (!requiresGuard(policy,destination)) return {payload:value,guarded:false,masked_spans:0,cache_hit:false};
  const serialized=canonical(value);
  if (Buffer.byteLength(serialized)>512*1024) throw new HttpError(413,'guard_request_too_large');
  const key=digest(canonical({input:serialized,policy,version:POLICY_VERSION,destination}));
  if (pool) {
    const cached=await pool.query<{payload:Buffer;spans:number}>('SELECT payload,spans FROM guarded_cache WHERE cache_key=$1',[key]);
    if (cached.rows[0]) return {payload:JSON.parse(cached.rows[0].payload.toString()),guarded:true,masked_spans:cached.rows[0].spans,cache_hit:true};
  }
  const strings=new Set<string>();contentStrings(value,strings);
  const replacements=new Map<string,string>();let maskedSpans=0;
  // One detector call sees all strings together, so labels and values can be in
  // separate fields. Candidates must also match an actual field verbatim.
  const input=[...strings].join('\n⟪NOCHEH_FIELD_BOUNDARY⟫\n');
  if (input.length>100000) throw new HttpError(413,'detector_input_too_large');
  const candidates=await detect(input);
  if (!Array.isArray(candidates) || candidates.length>1000 || candidates.some(v=>typeof v!=='string' || !v || ![...strings].some(s=>s.includes(v)))) throw new HttpError(503,'detector_contract_rejected');
  for (const text of strings) {
    const found=mask(text,[...patternSpans(text),...literalSpans(text,candidates.filter(v=>text.includes(v as string)))]);
    replacements.set(text,found.text);maskedSpans+=found.spans.length;
  }
  const payload=replaceStrings(value,replacements);
  if (pool) await pool.query('INSERT INTO guarded_cache(cache_key,payload,spans) VALUES($1,$2,$3) ON CONFLICT(cache_key) DO NOTHING',[key,Buffer.from(canonical(payload)),maskedSpans]);
  return {payload,guarded:true,masked_spans:maskedSpans,cache_hit:false};
}
