import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {parentSpace} from '../spaces.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardBinding} from './guards.js';
import type {LearnedMemoryRepository,PreparedDependency} from './learned.js';
import type {OperationReference} from './operations.js';
import {OwnerCommands} from './owner-commands.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {SharingPolicyRepository,SharingRule} from './projects.js';
import {selectionId,type SelectionRepository} from './selections.js';

const identity=(v:unknown)=>{const id=string(v,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_sharing_identity');return id;};
const exact=(v:unknown,keys:string[])=>{const b=object(v);if(Object.keys(b).some(k=>!keys.includes(k)))throw new HttpError(400,'unknown_sharing_field');return b;};
type Preview={id:string;request_hash:string;operation_reference:OperationReference;rule_id:string;rule_revision:number;
  generation:string;guard_epoch:string;guard_mode:GuardBinding['mode'];input_reference:DerivativeReference;output_reference:DerivativeReference|null;state:'pending'|'ready'};
type Inputs={rule:SharingRule;binding:GuardBinding;sources:SourceReference[];dependencies:PreparedDependency[];
  candidates:{id:string;text:string}[];query:string;content:string|null};
type Shared={id:string;source:string;kind:'owner_approved'|'privacy_filtered_inference';text:string;limitations:string[]};

/** Sharing publishes a distinct, revocable representation; it never grants source access. */
export class SharingContentRepository {
  constructor(readonly access:SourceAccessRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly selections:SelectionRepository,readonly learned:LearnedMemoryRepository,readonly policies:SharingPolicyRepository,
    readonly call:RuntimeCall,readonly detect:(text:string)=>Promise<unknown>,readonly serviceToken:string){}
  private get stores(){return this.access.stores;}
  private get guards(){return this.access.guards;}
  private async rule(id:string):Promise<SharingRule> {
    const row=(await this.stores.control.query('SELECT * FROM sharing_rules WHERE id=$1',[identity(id)])).rows[0];
    if(!row)throw new HttpError(404,'sharing_rule_not_found');return row;
  }
  private async previewRow(id:string):Promise<Preview> {
    const row=(await this.stores.control.query('SELECT * FROM sharing_previews WHERE id=$1',[identity(id)])).rows[0];
    if(!row)throw new HttpError(404,'sharing_preview_not_found');return row;
  }
  private async artifact(reference:DerivativeReference) {
    const row=(await this.stores.derived.query('SELECT content,content_hash,provenance,producer,producer_version,configuration_hash,input_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash)throw new HttpError(409,'derivative_reference_conflict');return row;
  }
  private async inputs(row:Preview):Promise<Inputs> {return JSON.parse((await this.artifact(row.input_reference)).content.toString());}
  private async validate(input:Inputs,binding:GuardBinding,enabled=false):Promise<SharingRule> {
    const rule=await this.rule(input.rule.id);
    if(rule.revision!==input.rule.revision||enabled&&!rule.enabled)throw new HttpError(409,'sharing_policy_changed');
    if(binding.generation!==input.binding.generation||binding.mode!==input.binding.mode)throw new HttpError(409,'sharing_context_changed');
    for(const source of input.sources) {
      const space=await this.access.space(source);
      if(!space||!rule.sources.includes(space))throw new HttpError(403,'sharing_source_not_selected');
    }
    await this.learned.validateDependencies(input.dependencies,binding);return rule;
  }
  private async snapshot(rule:SharingRule,ids:string[],binding:GuardBinding):Promise<Pick<Inputs,'sources'|'dependencies'|'candidates'>> {
    const sources:SourceReference[]=[],dependencies:PreparedDependency[]=[],candidates:Inputs['candidates']=[];
    for(const id of ids) {
      const source=(await this.access.archive.captured(id)).reference,space=await this.access.space(source);
      if(!space||!rule.sources.includes(space))throw new HttpError(403,'sharing_source_not_selected');
      const guarded=await this.guards.read('events:'+id,binding),text=[String((guarded.value as any).text??'')];
      sources.push(source);dependencies.push({source_id:'events:'+id,revision:guarded.revision,value_hash:digest(canonical(guarded.value))});
      const selected=(await this.stores.derived.query(`SELECT artifact_id,kind FROM derivative_selections WHERE event_id=$1
        AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY id LIMIT 9`,[id])).rows;
      if(selected.length>8)throw new HttpError(409,'sharing_derivative_limit');
      for(const selection of selected) {
        const current=await this.selections.current(id,selection.artifact_id,selection.kind,binding);
        dependencies.push({source_id:'derived_artifacts:'+current.id,revision:current.guard_revision,value_hash:digest(canonical(current.value)),
          selection:{id:selectionId(id,selection.artifact_id,selection.kind),revision:current.revision}});
        text.push(String((current.value as any).text??''));
      }
      candidates.push({id,text:text.join('\n').slice(0,4000)});
    }
    await this.guards.assertCurrent(binding);return {sources,dependencies,candidates};
  }
  async preview(principal:Reader,value:unknown) {
    admin(principal);const body=exact(value,['rule_id','expected_revision','source_ids','query','content','operation_id']);
    const rule=await this.rule(identity(body.rule_id));
    if(rule.revision!==body.expected_revision)throw new HttpError(409,'sharing_revision_conflict');
    if(!Array.isArray(body.source_ids)||!body.source_ids.length||body.source_ids.length>10)throw new HttpError(400,'invalid_sharing_sources');
    const ids=[...new Set(body.source_ids.map(identity))].sort(),query=string(body.query??'',2000),operation=string(body.operation_id,200);
    const content=rule.mode==='approved'?string(body.content,12000):null;
    if(!operation.trim()||content!==null&&!content.trim()||rule.mode==='filtered'&&body.content!==undefined)throw new HttpError(400,'invalid_sharing_preview');
    const result=await this.prepare(rule,ids,query,content,operation);await this.finish(result.id);return this.inspect(principal,result.id);
  }
  private async prepare(rule:SharingRule,ids:string[],query:string,content:string|null,operation:string):Promise<Preview> {
    const binding=await this.guards.state(),request={rule_id:rule.id,revision:rule.revision,ids,query,content},requestHash=digest(canonical(request));
    const id=digest(canonical(['sharing-preview',binding.generation,operation]));
    const old=(await this.stores.control.query('SELECT * FROM sharing_previews WHERE id=$1',[id])).rows[0];
    if(old) {if(old.request_hash!==requestHash)throw new HttpError(409,'sharing_operation_conflict');return old;}
    const root=await this.derived.operations!.record({key:'sharing-preview:'+operation,kind:'sharing_request',scope:rule.destination,input_hash:requestHash});
    const artifactId='sharing-input:'+id,stored=await this.derived.checkpoint(artifactId);
    let reference:DerivativeReference;
    if(stored)reference={store:'derived',kind:'artifact',id:stored.id,input_hash:stored.content_hash};
    else {
      const input:Inputs={rule,binding,...await this.snapshot(rule,ids,binding),query,content};
      reference=await this.derived.record({operation_id:artifactId,source:root,kind:'runtime_context',content:Buffer.from(canonical(input)),
        producer:'nocheh',producer_version:'sharing-v1',configuration:{mode:rule.mode,rule_revision:rule.revision},provenance:{purpose:'sharing-preview'}});
    }
    const input:Inputs=JSON.parse((await this.artifact(reference)).content.toString());
    await this.validate(input,binding);
    // A crash after saving the input reuses the exact durable snapshot.
    await this.stores.control.query(`INSERT INTO sharing_previews(id,request_hash,operation_reference,rule_id,rule_revision,generation,guard_epoch,guard_mode,input_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [id,requestHash,root,rule.id,rule.revision,input.binding.generation,input.binding.epoch,input.binding.mode,reference]);
    const row=await this.previewRow(id);if(row.request_hash!==requestHash)throw new HttpError(409,'sharing_operation_conflict');return row;
  }
  private filteredItems(raw:unknown,input:Inputs):{text:string}[] {
    const result=exact(raw,['items','producer']);
    if(!Array.isArray(result.items)||result.items.length>5)throw new HttpError(503,'privacy_contract_rejected');
    const allowed=new Set(input.sources.map(s=>s.id));
    return result.items.map(item=>{
      const value=exact(item,['text','source_ids']),text=string(value.text,2000);
      if(!text.trim()||!Array.isArray(value.source_ids)||!value.source_ids.length||value.source_ids.length>10||value.source_ids.some(id=>!allowed.has(id)))
        throw new HttpError(503,'privacy_contract_rejected');
      this.noPrivateCitation(text,input);return {text};
    });
  }
  private noPrivateCitation(text:string,input:Inputs) {
    if(/nocheh:(?:event|artifact|derivative):|\/v1\/(?:sources|derivatives|artifacts)\//.test(text)||input.sources.some(s=>text.includes(s.id)))
      throw new HttpError(503,'privacy_citation_rejected');
  }
  /** Durable model output is checkpointed before guarding and the completion receipt. */
  async finish(id:string):Promise<void> {
    const lock=await this.stores.control.connect();let held=false;
    try {
      held=(await lock.query('SELECT pg_try_advisory_lock(803360) AS held')).rows[0].held;
      if(!held)throw new HttpError(409,'sharing_preparation_busy');
      const row=await this.previewRow(id);if(row.state==='ready')return;
      const input=await this.inputs(row),binding=await this.guards.state();await this.validate(input,binding);
      let output=await this.derived.checkpoint('sharing-output:'+id);
      if(!output) {
        let items:{text:string}[],parents=[row.input_reference];
        if(input.rule.mode==='approved') {this.noPrivateCitation(input.content!,input);items=[{text:input.content!}];}
        else {
          let result=await this.derived.checkpoint('sharing-filter:'+id);
          if(!result) {
            if(this.serviceToken.length<24)throw new HttpError(503,'runtime_signing_unavailable');
            const space=await this.access.space(input.sources[0]!);
            const actor:Reader={admin:false,scope:null,space:space!,turnEvent:input.sources[0]!.id,purpose:'filter',generation:binding.generation,guard_epoch:binding.epoch};
            await this.prepared.allow(actor,input.candidates);
            const payload=await this.prepared.prepare(actor,{query:input.query,instructions:input.rule.instructions,candidates:input.candidates},this.detect) as Record<string,unknown>;
            const credential=await this.prepared.audience.turn(this.serviceToken,actor,actor.turnEvent!,Date.now()+180000);
            await this.validate(input,binding);
            const response=await this.call('memory.filter',{...payload,archive_credential:credential},120000);
            const producer=object(response.producer);
            for(const key of ['name','version','model','provider','api_mode'])if(!string(producer[key],200).trim())throw new HttpError(503,'filter_provenance_required');
            if(Object.keys(producer).some(key=>!['name','version','model','provider','api_mode'].includes(key)))throw new HttpError(503,'filter_provenance_rejected');
            const reference=await this.derived.record({operation_id:'sharing-filter:'+id,source:row.operation_reference,kind:'runtime_result',content:Buffer.from(canonical(response)),
              producer:String(producer.name),producer_version:String(producer.version),configuration:{producer,rule:input.rule.id,revision:input.rule.revision,instructions:input.rule.instructions},parents:[row.input_reference]});
            result={id:reference.id,content_hash:reference.input_hash,content:Buffer.from(canonical(response))};
          }
          items=this.filteredItems(JSON.parse(result.content.toString()),input);
          parents.push({store:'derived',kind:'artifact',id:result.id,input_hash:result.content_hash});
        }
        const reference=await this.derived.record({operation_id:'sharing-output:'+id,source:row.operation_reference,kind:'shared_knowledge',
          content:Buffer.from(canonical({items})),producer:input.rule.mode==='approved'?'owner':'hermes',producer_version:'sharing-v1',
          configuration:{rule:input.rule.id,revision:input.rule.revision,mode:input.rule.mode},parents,
          provenance:{sources:input.sources,dependencies:input.dependencies,destination:input.rule.destination}});
        output={id:reference.id,content_hash:reference.input_hash};
      }
      const reference:DerivativeReference={store:'derived',kind:'artifact',id:output.id,input_hash:output.content_hash};
      await this.guards.prepare(reference,'sharing-v1',this.detect);
      await this.validate(input,await this.guards.state());
      await this.stores.control.query("UPDATE sharing_previews SET state='ready',output_reference=$2 WHERE id=$1",[id,reference]);
    } finally {if(held)await lock.query('SELECT pg_advisory_unlock(803360)');lock.release();}
  }
  private async representation(row:Preview,binding:GuardBinding) {
    if(row.state!=='ready'||!row.output_reference)throw new HttpError(409,'sharing_preparation_pending');
    const current=await this.guards.read('derived_artifacts:'+row.output_reference.id,binding),value=object(current.value);
    let content:Record<string,unknown>;try {content=exact(JSON.parse(string(value.text,50000)),['items']);}catch{throw new HttpError(409,'sharing_representation_invalid');}
    if(!Array.isArray(content.items)||content.items.length>5)throw new HttpError(409,'sharing_representation_invalid');
    const texts=content.items.map(item=>{const value=exact(item,['text']);return string(value.text,12000);});
    const text=texts.join('\n\n'),input=await this.inputs(row);this.noPrivateCitation(text,input);
    return {text,revision:current.revision,hash:digest(text)};
  }
  async inspect(principal:Reader,id:string) {
    admin(principal);const row=await this.previewRow(id),input=await this.inputs(row),binding=await this.guards.state();
    const representation=row.state==='ready'?await this.representation(row,binding):null;
    const output=row.output_reference?await this.artifact(row.output_reference):null;
    let current=true;try{await this.validate(input,binding);}catch(error){if(!(error instanceof HttpError))throw error;current=false;}
    return {...row,input,...(representation?{text:representation.text,guard_revision:representation.revision,text_hash:representation.hash}:{}),
      output_provenance:output?{...output,content:undefined}:null,current};
  }
  async previews(principal:Reader,after='') {
    admin(principal);if(after)identity(after);
    const rows=(await this.stores.control.query('SELECT * FROM sharing_previews WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    return {previews:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  }
  /** The control lock closes policy/revocation races after the cross-store checks. */
  private async fence(db:pg.PoolClient,input:Inputs,binding:GuardBinding) {
    const state=(await db.query('SELECT g.epoch,g.mode,i.generation FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton FOR UPDATE OF g')).rows[0];
    if(canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode})!==canonical(binding)||
      (await db.query("SELECT 1 FROM guard_publications WHERE state='pending' LIMIT 1")).rowCount)throw new HttpError(409,'sharing_context_changed');
    const rule=(await db.query('SELECT revision,enabled FROM sharing_rules WHERE id=$1',[input.rule.id])).rows[0];
    if(!rule?.enabled||rule.revision!==input.rule.revision)throw new HttpError(409,'sharing_policy_changed');
  }
  async approve(principal:Reader,id:string,value:unknown) {
    admin(principal);const body=exact(value,['expected_revision','guard_revision','text_hash','operation_id']),operation=string(body.operation_id,200);
    const row=await this.previewRow(id),input=await this.inputs(row);
    if(input.rule.mode!=='approved'||body.expected_revision!==input.rule.revision)throw new HttpError(409,'sharing_revision_conflict');
    const request={kind:'sharing_approval',id,...body},hash=digest(canonical(request));
    // An already committed approval is an idempotent receipt, even after revocation.
    const prior=(await this.stores.control.query('SELECT request_hash,result FROM owner_commands WHERE id=$1',[operation])).rows[0];
    if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'owner_command_conflict');return prior.result;}
    const binding=await this.guards.state();await this.validate(input,binding,true);
    const representation=await this.representation(row,binding);
    if(body.guard_revision!==representation.revision||body.text_hash!==representation.hash||!representation.text.trim())throw new HttpError(409,'sharing_preview_changed');
    return new OwnerCommands(this.stores.control).run(principal,operation,request,async db=>{
      await this.fence(db,input,binding);
      const release=digest(canonical(['sharing-release',binding.generation,operation]));
      await this.insertRelease(db,release,row,representation,binding,null);return {id:release,revision:1};
    });
  }
  private async insertRelease(db:pg.PoolClient,id:string,row:Preview,representation:{revision:number|null;hash:string},binding:GuardBinding,expires:Date|null) {
    await db.query(`INSERT INTO sharing_releases(id,preview_id,rule_id,rule_revision,generation,guard_mode,guard_revision,text_hash,mode,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [id,row.id,row.rule_id,row.rule_revision,binding.generation,binding.mode,representation.revision,representation.hash,expires?'filtered':'approved',expires]);
  }
  async revoke(principal:Reader,id:string,value:unknown) {
    admin(principal);identity(id);const body=exact(value,['expected_revision','operation_id']);
    if(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<1)throw new HttpError(400,'invalid_revision');
    return new OwnerCommands(this.stores.control).run(principal,string(body.operation_id,200),{kind:'sharing_revocation',id,...body},async db=>{
      const row=(await db.query("UPDATE sharing_releases SET state='revoked',revision=revision+1,revoked_at=now() WHERE id=$1 AND revision=$2 AND state='active' RETURNING revision",
        [id,body.expected_revision])).rows[0];
      if(!row)throw new HttpError(409,'sharing_revision_conflict');return {id,revision:row.revision,state:'revoked'};
    });
  }
  async list(principal:Reader,after='') {
    admin(principal);if(after)identity(after);
    const rows=(await this.stores.control.query('SELECT * FROM sharing_releases WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    return {releases:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  }
  async read(principal:Reader,id:string):Promise<Shared> {
    if(principal.admin||principal.scope===null||!principal.space||(parentSpace(principal.space)??principal.space)!==principal.scope)
      throw new HttpError(403,'space_context_required');
    const binding=await this.prepared.audience.assert(principal);
    const row=(await this.stores.control.query(`SELECT r.* FROM sharing_releases r JOIN sharing_rules s ON s.id=r.rule_id
      WHERE r.id=$1 AND r.state='active' AND s.enabled AND s.revision=r.rule_revision AND s.destination=$2
      AND r.generation=$3 AND r.guard_mode=$4 AND (r.expires_at IS NULL OR r.expires_at>now())`,[identity(id),principal.space,binding.generation,binding.mode])).rows[0];
    if(!row)throw new HttpError(404,'shared_source_not_found');
    const preview=await this.previewRow(row.preview_id),input=await this.inputs(preview);await this.validate(input,binding,true);
    const representation=await this.representation(preview,binding);
    if(representation.revision!==row.guard_revision||representation.hash!==row.text_hash)throw new HttpError(409,'sharing_preview_changed');
    const result:Shared={id,source:'nocheh:'+(row.mode==='approved'?'shared:':'filtered:')+id,
      kind:row.mode==='approved'?'owner_approved':'privacy_filtered_inference',text:representation.text,
      limitations:['Shared representation. Private source provenance is available to the owner only.']};
    await this.prepared.allow(principal,result);await this.prepared.audience.assert(principal);return result;
  }
  private async filtered(rule:SharingRule,query:string,binding:GuardBinding):Promise<string|null> {
    const originals=binding.mode==='on'?this.stores.derived.query(`SELECT event_id AS id FROM guard_sources s JOIN guard_revisions r
      ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.kind='events' AND s.state='ready'
      AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1) ORDER BY s.id LIMIT 200`,[query]):
      this.stores.archive.query("SELECT id FROM events WHERE to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1) ORDER BY id LIMIT 200",[query]);
    const selected=binding.mode==='on'?this.stores.derived.query(`SELECT DISTINCT s.event_id AS id FROM derivative_selections s
      JOIN derivative_selection_revisions v ON v.selection_id=s.id AND v.revision=s.active_revision
      JOIN guard_sources g ON g.kind='derived_artifacts' AND g.source_id=v.derived_id AND g.state='ready'
      JOIN guard_revisions r ON r.source_id=g.id AND r.revision=g.active_revision
      WHERE s.kind IN ('transcript','extracted_text') AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1) ORDER BY id LIMIT 200`,[query]):
      this.stores.derived.query(`SELECT DISTINCT s.event_id AS id FROM derivative_selections s
      JOIN derivative_selection_revisions v ON v.selection_id=s.id AND v.revision=s.active_revision JOIN derived_artifacts d ON d.id=v.derived_id
      WHERE s.kind IN ('transcript','extracted_text') AND to_tsvector('simple',d.search_text) @@ plainto_tsquery('simple',$1) ORDER BY id LIMIT 200`,[query]);
    const pages=await Promise.all([originals,selected]),candidates=[...new Set(pages.flatMap(p=>p.rows.map(r=>r.id as string)))];
    const ids:string[]=[];
    for(const id of candidates) {
      const source=(await this.access.archive.captured(id)).reference,space=await this.access.space(source);
      if(space&&rule.sources.includes(space))ids.push(id);if(ids.length===10)break;
    }
    if(!ids.length)return null;
    const operation='automatic-filter:'+digest(canonical([binding,rule.id,rule.revision,query,ids,Math.floor(Date.now()/600000)]));
    const preview=await this.prepare(rule,ids,query,null,operation);await this.finish(preview.id);
    const row=await this.previewRow(preview.id),input=await this.inputs(row);await this.validate(input,binding,true);
    const representation=await this.representation(row,binding);if(!representation.text.trim())return null;
    const id=digest('filtered-release:'+row.id),db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');await this.fence(db,input,binding);await this.insertRelease(db,id,row,representation,binding,new Date(Date.now()+600000));
      await db.query('COMMIT');return id;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async context(principal:Reader,query:string) {
    if(principal.admin||principal.scope===null||!principal.space)throw new HttpError(403,'space_context_required');
    string(query,2000);const binding=await this.prepared.audience.assert(principal),rules=await this.policies.forDestination(principal.space),sources:Shared[]=[];
    const rows=(await this.stores.control.query(`SELECT r.id FROM sharing_releases r JOIN sharing_rules s ON s.id=r.rule_id
      WHERE s.destination=$1 AND s.enabled AND r.mode='approved' AND r.state='active' ORDER BY r.id LIMIT 100`,[principal.space])).rows;
    for(const row of rows) {
      try {const source=await this.read(principal,row.id);if(query.toLowerCase().split(/\s+/).every(word=>source.text.toLowerCase().includes(word)))sources.push(source);}
      catch(error){if(!(error instanceof HttpError))throw error;await this.prepared.audience.assert(principal);}
      if(sources.length>=10)break;
    }
    let filter_status='disabled';
    const filters=rules.filter(r=>r.mode==='filtered');if(filters.length>10)throw new HttpError(409,'sharing_rule_limit');
    for(const rule of filters)try {
      const id=await this.filtered(rule,query,binding);if(id)sources.push(await this.read(principal,id));
      if(filter_status!=='unavailable')filter_status=id?'passed':filter_status==='passed'?'passed':'no_matches';
    }catch {await this.prepared.audience.assert(principal);filter_status='unavailable';}
    await this.prepared.audience.assert(principal);return {sources,filter_status};
  }
}
