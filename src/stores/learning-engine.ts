import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError,string} from '../http.js';
import {learningInstruction,ownerPrompts} from '../prompts.js';
import type {HonchoCall} from '../honcho.js';
import {learningResult,parseInterpretations,triggeredInterpretations,type LearningRejection} from '../interpretations.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceReference} from './archive.js';
import {DerivedRepository,type DerivativeReference} from './derived.js';
import {GuardRepository} from './guards.js';
import {HonchoProvenanceRepository} from './honcho-provenance.js';
import {LearnedMemoryRepository,type LearnedPublication} from './learned.js';
import {LearningContextRepository,type PreparedLearningContext} from './learning-context.js';
import {evidencePeerId,honchoPeerId} from './entities.js';

const protocol='honcho-contextual-learning-v1';
/** A saved reasoning result is never rerun, so a result that fails these checks fails identically on every retry. */
export const terminalLearningCodes=new Set(['invalid_interpretation_result','learning_query_limit']);
/** A saved result that was unusable stays closed; a query that was too large is prepared again, as trimming can change. */
const terminalRenewalCodes=new Set(['invalid_interpretation_result']);
/** Honcho rejects a longer reasoning query before any model call. */
const honchoQueryLimit=10000;
/** The learning query within Honcho's limit. Other evidence keeps only its text first, then rules
 * are left out from the end, then the trigger keeps only its text, then other evidence is left out from
 * the end; anything longer cannot be asked. The instruction lists the evidence the query still shows. */
export function learningQuery(instruction:string|((citable:string[])=>string),context:Pick<PreparedLearningContext,'source'|'space'|'projects'|'organization_context'|'entities'|'observations'|'rules'|'limitations'>):string {
  const textOnly=(item:PreparedLearningContext['observations'][number])=>({...item,value:{text:(item.value as {text?:unknown})?.text??null}});
  let observations=context.observations,rules=context.rules;const limitations=[...context.limitations];
  const query=()=>(typeof instruction==='string'?instruction:instruction(observations.map(item=>item.source.id)))+
    `\n${canonical({space:context.space,projects:context.projects,organization_context:context.organization_context,entities:context.entities,observations,rules,limitations})}`;
  const fits=()=>Array.from(query()).length<=honchoQueryLimit;
  if(fits())return query();
  observations=observations.map(item=>item.source.id===context.source.id?item:textOnly(item));limitations.push('other_evidence_text_only');
  if(!fits()&&rules.length){limitations.push('rules_omitted');while(rules.length&&!fits())rules=rules.slice(0,-1);}
  if(!fits()){observations=observations.map(item=>item.source.id===context.source.id?textOnly(item):item);limitations.push('trigger_text_only');}
  if(!fits()&&observations.length>1) {
    limitations.push('other_evidence_omitted');
    const others=observations.filter(item=>item.source.id!==context.source.id);
    while(!fits()&&others.length){const dropped=others.pop();observations=observations.filter(item=>item!==dropped);}
  }
  if(!fits())throw new HttpError(413,'learning_query_limit');
  return query();
}
export class ContextualLearningRepository {
  constructor(readonly contexts:LearningContextRepository,readonly derived:DerivedRepository,readonly guards:GuardRepository,
    readonly learned:LearnedMemoryRepository,readonly provenance:HonchoProvenanceRepository,readonly call:HonchoCall){}

  async request(source:SourceReference,workspace:string,audience:string):Promise<string> {
    const binding=await this.guards.state();await this.provenance.current(workspace,audience,binding);
    const context=await this.contexts.prepare(source,binding);
    const owner=this.contexts.access.policy().owner_id;
    if(audience!==(context.space===owner?'owner':context.space))throw new HttpError(403,'learning_workspace_scope_mismatch');
    const {binding:_,rules:_rules,rule_ids:_ruleIds,...inputs}=context,contextHash=digest(canonical([protocol,audience,inputs]));
    // Unrelated epochs and regenerated rule wording cannot cause a reasoning loop.
    // Every source, selected result and applicable convention is still revalidated above.
    const completed=(await this.contexts.access.stores.control.query("SELECT id FROM interpretation_jobs WHERE context_hash=$1 AND state='done' ORDER BY created_at DESC LIMIT 1",[contextHash])).rows[0];
    if(completed)return completed.id;
    const id=digest(canonical([protocol,workspace,context]));
    const input=await this.derived.record({operation_id:'learning-input:'+id,source,kind:'runtime_context',content:Buffer.from(canonical(context)),
      producer:'nocheh',producer_version:protocol,configuration:{},provenance:{purpose:'contextual_learning',binding}});
    const client=await this.contexts.access.stores.control.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO interpretation_jobs(id,source_reference,workspace,audience,input_reference,binding,context_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[id,JSON.stringify(source),workspace,audience,JSON.stringify(input),JSON.stringify(binding),contextHash]);
      await requestWorkflow(client,'memory_review','interpret:'+id);
      await client.query('COMMIT');return id;
    } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  /** A source's learning that an authorization epoch stopped before it finished is asked again under the current one.
   * Only the newest job of each memory audience counts; a finished one, an unusable saved result or current work is left alone. */
  async renew(source:SourceReference):Promise<string[]> {
    const binding=await this.guards.state();
    const stale=(await this.contexts.access.stores.control.query(`SELECT DISTINCT ON (j.workspace,j.audience) j.workspace,j.audience,j.state,j.error_code,j.binding=$2::jsonb AS current
      FROM interpretation_jobs j JOIN memory_generations g ON g.id=j.workspace AND g.installation_generation=$3 AND g.state<>'retired'
      WHERE j.source_reference->>'id'=$1 ORDER BY j.workspace,j.audience,j.created_at DESC,j.id DESC`,[source.id,JSON.stringify(binding),binding.generation])).rows
      .filter(job=>!job.current&&(job.state==='pending'||job.state==='failed'&&!terminalRenewalCodes.has(job.error_code)));
    const ids:string[]=[];
    for(const job of stale)try{ids.push(await this.request(source,job.workspace,job.audience));}
    catch(error){if(!(error instanceof HttpError&&['learning_consent_required','learning_workspace_scope_mismatch','memory_context_retired'].includes(error.code)))throw error;}
    // A never-started job of an earlier epoch can never run, so it is not kept as a second copy.
    await this.contexts.access.stores.control.query(`DELETE FROM interpretation_jobs WHERE source_reference->>'id'=$1 AND state='pending' AND attempts=0
      AND binding<>$2::jsonb AND NOT id=ANY($3::text[])`,[source.id,JSON.stringify(binding),ids]);
    return ids;
  }

  /** Job completion and its follow-up request are one control-store commit. */
  private async complete(client:pg.PoolClient,id:string):Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query("UPDATE interpretation_jobs SET state='done',error_code=NULL WHERE id=$1",[id]);
      await requestWorkflow(client,'organization','learning:'+id);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
  }

  private async context(reference:DerivativeReference):Promise<PreparedLearningContext> {
    const row=(await this.derived.pool.query("SELECT content,content_hash FROM derived_artifacts WHERE id=$1 AND kind='runtime_context'",[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash)throw new HttpError(409,'learning_input_conflict');
    return JSON.parse(row.content.toString());
  }
  async run(id:string,detect:(text:string)=>Promise<unknown>,authority:ExecutionAuthority) {
    const control=this.contexts.access.stores.control,client=await control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(client,'memory_review',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,803355)) AS held',[id])).rows[0].held;
      if(!locked)throw new HttpError(409,'learning_job_busy');
      const job=(await client.query('SELECT * FROM interpretation_jobs WHERE id=$1',[id])).rows[0];
      if(!job)throw new HttpError(404,'learning_job_missing');
      if(job.state==='done')return job.result_ids as string[];
      if(job.state==='publishing') {
        for(const operation of job.publication_ids)await this.learned.finish(operation);
        await this.complete(client,id);
        return job.result_ids as string[];
      }
      // A revoked context never reaches the reasoning endpoint, even on retry.
      await this.provenance.current(job.workspace,job.audience,job.binding);
      const context=await this.context(job.input_reference);
      await this.learned.validateDependencies(context.dependencies,job.binding);
      for(const evidence of context.evidence)if(!await this.contexts.access.canLearn(evidence.reference,job.binding)||
        !await this.contexts.access.canRead(this.contexts.access.principal(context.space),evidence.reference,job.binding))throw new HttpError(403,'learning_consent_required');
      await client.query("UPDATE interpretation_jobs SET state='running',attempts=attempts+1,error_code=NULL WHERE id=$1",[id]);
      try {
        const operation='learning-result:'+id;
        let result=await this.derived.checkpoint(operation);
        if(!result) {
          const prompt=(await ownerPrompts(this.contexts.access.stores.control))['learning.interpret'];
          const query=learningQuery(citable=>learningInstruction(prompt,{trigger_id:context.source.id,citable_ids:canonical(citable)}),context);
          await this.provenance.current(job.workspace,job.audience,job.binding);
          const peer=context.entities.speaker?honchoPeerId(context.entities.speaker):evidencePeerId(context.source);
          // A group or topic interpretation reasons only over that audience's own sessions.
          const scope=await this.provenance.chatScope(job.workspace,job.audience);
          const response=await this.call('/v3/workspaces/'+job.workspace+'/peers/'+peer+'/chat',{query,reasoning_level:'low',stream:false,...scope});
          // Preserve the completed reasoning result before validation, publication or job completion.
          const output=await this.derived.record({operation_id:operation,source:job.source_reference,parents:[job.input_reference],kind:'learning_result',
            content:Buffer.from(string(response.content,200000)),producer:'honcho',producer_version:protocol,configuration:{reasoning_level:'low',peer},
            provenance:{workspace:job.workspace,input:job.input_reference,limitations:['reasoning_response_has_no_exact_conclusion_citations']}});
          result={id:output.id,content:Buffer.from(response.content)};
        }
        await this.provenance.current(job.workspace,job.audience,job.binding);
        const parsed=learningResult(result.content.toString());
        const parsedValues=parseInterpretations(triggeredInterpretations(parsed,job.source_reference.id,context.rule_ids),context.evidence,
          context.space,context.projects,context.entities.session_id),ids:string[]=[],versions:LearnedPublication[]=[];
        const rejected:LearningRejection[]=[...parsedValues.rejected,...(await this.contexts.entities.publishDiscoveries(context,parsed,id)).rejected];
        const values=parsedValues.values.filter(v=>{
          const code=!v.evidence.some(e=>e.id===job.source_reference.id)?'interpretation_trigger_required':
            v.conflicts.some(ref=>!context.rule_ids.includes(ref))?'unknown_interpretation_conflict':null;
          if(code)rejected.push({section:'interpretations',code});return !code;
        });
        await client.query('UPDATE interpretation_jobs SET rejected=$2 WHERE id=$1',[id,JSON.stringify(rejected)]);
        for(let index=0;index<values.length;index++) {
          const value=values[index]!,entryId=digest(canonical([value.scope,value.kind,value.subject,
            value.kind==='convention'||value.uncertainty==='explicit'?context.source_object:'inferred']));
          const prior=(await this.derived.pool.query('SELECT active_revision FROM learned_entries WHERE id=$1',[entryId])).rows[0];
          // Existing owner corrections remain authoritative, including after new evidence.
          if(prior&&(await this.derived.pool.query("SELECT 1 FROM learned_versions WHERE entry_id=$1 AND revision=$2 AND author='owner'",[entryId,prior.active_revision])).rowCount){ids.push(entryId);continue;}
          // An identical active interpretation cannot justify another global guard epoch and Honcho rebuild.
          if(prior&&await this.learned.matchesActiveAutomatic(entryId,value,context.dependencies,id+':'+index)){ids.push(entryId);continue;}
          const version=await this.learned.stageAutomatic(entryId,value,prior?.active_revision??null,id+':'+index,context.dependencies,
            job.binding,protocol,detect,{workspace:job.workspace,result_id:result.id,limitations:['reasoning_response_has_no_exact_conclusion_citations']});
          ids.push(version.entry_id);versions.push(version);
        }
        await this.learned.activateBatch(versions,job.binding,id,result.id,ids);
        for(const version of versions)await this.learned.finish(version.operation_id);
        await this.complete(client,id);
        return ids;
      } catch(error) {
        const code=error instanceof HttpError?error.code:'learning_unavailable';
        await client.query("UPDATE interpretation_jobs SET state=CASE WHEN state='publishing' THEN state WHEN $2='learning_publication_pending' THEN 'pending' ELSE 'failed' END,error_code=$2 WHERE id=$1",[id,code]);throw error;
      }
    } finally {await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803355))',[id]);if(fenced)await leaveFamily(client,'memory_review');});}
  }
}
