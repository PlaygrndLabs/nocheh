/** Runtime-independent security plugin protocol. Requests describe effects, never permissions. */
import {createHash} from 'node:crypto';
import {HttpError, object} from '../http.js';

export const manifest = Object.freeze({
  id:'nocheh.security', version:'1.0.0', api_version:1,
  capabilities:['policy.preview','policy.configure','effect.authorize','effect.receipt','provider.forward','context.preserve'],
  configuration_schema:'nocheh.security.policy.v1',
  enforcement:'external', storage:'nocheh-db',
});
export const effectKinds = ['archive.read','memory.read','memory.write','model.request','browser','shell','mcp','telegram.send'] as const;
export type EffectKind = typeof effectKinds[number];
export type Outcome = 'allow'|'deny'|'ask';
export interface Effect {
  readonly id:string; readonly kind:EffectKind; readonly scope:string;
  readonly profile:string; readonly job?:string; readonly fingerprint:string;
}
export interface Rule {
  id:string; kind:EffectKind; outcome:'deny'|'ask';
  scope?:string; profile?:string; job?:string; fingerprint?:string;
}
export interface Policy { version:1; rules:Rule[]; }
export interface Decision { outcome:Outcome; rule:string; revision:number; origin:'mandatory'|'policy'|'grant'|'default'; }
export const defaultPolicy:Policy = {version:1,rules:[]};
const identity=/^[\w.:-]{1,128}$/;
const hash=/^[a-f0-9]{64}$/;
const keys=(v:Record<string,unknown>,names:string[])=>{
  if(Object.keys(v).some(k=>!names.includes(k)))throw new HttpError(400,'unknown_security_setting');
};
export function validatePolicy(value:unknown):Policy {
  const input=object(value);keys(input,['version','rules']);
  if(input.version!==1 || !Array.isArray(input.rules) || input.rules.length>200)throw new HttpError(400,'invalid_security_policy');
  const ids=new Set<string>();
  const rules:Rule[]=input.rules.map(value=>{
    const rule=object(value);keys(rule,['id','kind','outcome','scope','profile','job','fingerprint']);
    if(typeof rule.id!=='string'||!identity.test(rule.id)||ids.has(rule.id)||!effectKinds.includes(rule.kind as EffectKind)||!['deny','ask'].includes(String(rule.outcome)))throw new HttpError(400,'invalid_security_rule');
    ids.add(rule.id);
    if(rule.kind==='memory.write')throw new HttpError(400,'native_memory_write_policy_unsupported');
    for(const field of ['scope','profile','job'] as const)if(rule[field]!==undefined&&(typeof rule[field]!=='string'||!(field==='scope'?/^[\w.:-]{1,256}$/:identity).test(rule[field] as string)))throw new HttpError(400,'invalid_security_selector');
    if(rule.fingerprint!==undefined&&(typeof rule.fingerprint!=='string'||!hash.test(rule.fingerprint)))throw new HttpError(400,'invalid_security_fingerprint');
    // Reading and remembering already-authorized context is not an approval boundary.
    if(rule.outcome==='ask'&&['archive.read','memory.read','memory.write','model.request'].includes(String(rule.kind)))throw new HttpError(400,'routine_context_requires_no_approval');
    return rule as unknown as Rule;
  });
  return {version:1,rules};
}
export function matches(rule:Pick<Rule,'kind'|'scope'|'profile'|'job'|'fingerprint'>,effect:Effect):boolean {
  return rule.kind===effect.kind&&(['scope','profile','job','fingerprint'] as const).every(key=>rule[key]===undefined||rule[key]===effect[key]);
}
export function decide(policy:Policy,revision:number,effect:Effect,options:{mandatoryDenial?:string;grant?:string}={}):Decision {
  if(options.mandatoryDenial)return {outcome:'deny',rule:options.mandatoryDenial,revision,origin:'mandatory'};
  const applicable=policy.rules.filter(rule=>matches(rule,effect));
  const denial=applicable.find(rule=>rule.outcome==='deny');
  if(denial)return {outcome:'deny',rule:denial.id,revision,origin:'policy'};
  if(options.grant)return {outcome:'allow',rule:options.grant,revision,origin:'grant'};
  const asking=applicable.find(rule=>rule.outcome==='ask');
  if(asking)return {outcome:'ask',rule:asking.id,revision,origin:'policy'};
  const routine=['archive.read','memory.read','memory.write','model.request'].includes(effect.kind);
  return {outcome:routine?'allow':'ask',rule:routine?'authorized_context':'bounded_authority_required',revision,origin:'default'};
}
/** Canonical identity used for comparison, never a credential or a claim of authorization. */
export function fingerprint(value:unknown):string {
  function canonical(v:unknown):unknown {
    if(Array.isArray(v))return v.map(canonical);
    if(v!==null&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
