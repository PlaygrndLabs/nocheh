import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';
import type {SourceReference} from './archive.js';
import type {StorePools} from './connections.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {EntityRepository} from './entities.js';
import type {GuardBinding,GuardRepository} from './guards.js';
import {OwnerCommands} from './owner-commands.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {ProjectRepository} from './projects.js';
import {defaultLogicalProfile} from './runtime-profile.js';
import type {SourceAccessRepository} from './access.js';
import type {TelegramActionRepository} from './telegram-actions.js';

const protocol='nocheh-memory-access-v1';
const ID=/^[a-f0-9]{64}$/;
const identity=(value:unknown)=>{const id=string(value,64);if(!ID.test(id))throw new HttpError(400,'invalid_memory_access_identity');return id;};
const exact=(value:unknown,keys:string[])=>{const row=object(value);if(Object.keys(row).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_memory_access_field');return row;};
const revision=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<1)throw new HttpError(400,'invalid_revision');return Number(value);};
const STOP_WORDS=new Set(['about','after','before','could','does','from','have','into','only','should','that','their','there','these','they','this','what','when','where','which','with','would']);
const tokens=(value:string)=>new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu)??[]).filter(word=>!STOP_WORDS.has(word)));
const relevant=(query:string,text:string)=>{const wanted=tokens(query),available=tokens(text);if(wanted.size<2)return false;let hits=0;for(const word of wanted)if(available.has(word))hits++;
  return hits>=Math.max(2,Math.ceil(Math.min(wanted.size,6)/2));};

type Settings={suggestions:'related'|'off';notify_owner:boolean;auto_followup:boolean;request_ttl_seconds:number;default_grant_mode:'one_time'|'persistent'};
type Fact={id:string;subject_entity_id:string;predicate:string;object_entity_id:string|null;active_revision:number;revision:number;content:string;
  relationship_kind:string|null;attribution:string;uncertainty:string;retired:boolean;evidence:SourceReference[];input_binding:GuardBinding};

/** Relationships find candidates; grants alone authorize a guarded wording. */
export class MemoryAccessRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly stores:StorePools,readonly access:SourceAccessRepository,readonly derived:DerivedRepository,
    readonly guards:GuardRepository,readonly prepared:PreparedContextRepository,readonly entities:EntityRepository,
    readonly projects:ProjectRepository,readonly actions:TelegramActionRepository,readonly detect:(text:string)=>Promise<unknown>) {
    this.commands=new OwnerCommands(stores.control);
  }
  private async fact(id:string):Promise<Fact> {
    const row=(await this.stores.derived.query(`SELECT e.*,v.revision,v.content,v.relationship_kind,v.attribution,v.uncertainty,v.retired,v.evidence,v.input_binding
      FROM entity_claims e JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[identity(id)])).rows[0];
    if(!row||row.retired)throw new HttpError(404,'memory_fact_not_found');return row;
  }
  private async artifacts(rows:any[],field:'proposal_reference'|'representation_reference') {
    const ids=[...new Set(rows.map(row=>row[field]?.id).filter(Boolean))];if(!ids.length)return new Map<string,any>();
    const artifacts=(await this.stores.derived.query('SELECT id,content,provenance FROM derived_artifacts WHERE id=ANY($1::text[])',[ids])).rows;
    return new Map(artifacts.map(row=>[row.id,row]));
  }
  private async effective(destination:string):Promise<{global:Settings;override:Partial<Settings>|null;effective:Settings;revision:number}> {
    validateSpace(destination);const rows=(await this.stores.control.query("SELECT * FROM memory_access_settings WHERE destination IN ('*',$1)",[destination])).rows;
    const global=rows.find(row=>row.destination==='*');if(!global)throw new HttpError(503,'memory_access_settings_missing');
    const override=rows.find(row=>row.destination===destination)??null;
    const keys:Array<keyof Settings>=['suggestions','notify_owner','auto_followup','request_ttl_seconds','default_grant_mode'];
    const base=Object.fromEntries(keys.map(key=>[key,global[key]])) as unknown as Settings;
    const patch=override?Object.fromEntries(keys.filter(key=>override[key]!==null).map(key=>[key,override[key]])) as Partial<Settings>:null;
    return {global:base,override:patch,effective:{...base,...patch},revision:Number(override?.revision??global.revision)};
  }
  settings(principal:Reader,destination:string):Promise<{destination:string;global:Settings;override:Partial<Settings>|null;effective:Settings;revision:number}>;
  settings(principal:Reader):Promise<{settings:any[];partial:boolean}>;
  async settings(principal:Reader,destination?:string) {admin(principal);if(destination)return {destination,...await this.effective(destination)};
    const rows=(await this.stores.control.query("SELECT * FROM memory_access_settings ORDER BY CASE destination WHEN '*' THEN 0 ELSE 1 END,destination LIMIT 1001")).rows;
    return {settings:rows.slice(0,1000),partial:rows.length>1000};}
  async saveSettings(principal:Reader,input:unknown) {
    const body=exact(input,['destination','suggestions','notify_owner','auto_followup','request_ttl_seconds','default_grant_mode','expected_revision','operation_id']);
    const destination=body.destination==='*'?'*':validateSpace(body.destination),expected=revision(body.expected_revision),operation=string(body.operation_id,200);
    const values:Record<string,unknown>={};
    if(body.suggestions!==undefined){if(!['related','off'].includes(String(body.suggestions)))throw new HttpError(400,'invalid_suggestion_setting');values.suggestions=body.suggestions;}
    for(const key of ['notify_owner','auto_followup'] as const)if(body[key]!==undefined){if(typeof body[key]!=='boolean')throw new HttpError(400,'invalid_memory_access_setting');values[key]=body[key];}
    if(body.request_ttl_seconds!==undefined){if(!Number.isSafeInteger(body.request_ttl_seconds)||Number(body.request_ttl_seconds)<60||Number(body.request_ttl_seconds)>2592000)throw new HttpError(400,'invalid_request_lifetime');values.request_ttl_seconds=body.request_ttl_seconds;}
    if(body.default_grant_mode!==undefined){if(!['one_time','persistent'].includes(String(body.default_grant_mode)))throw new HttpError(400,'invalid_grant_mode');values.default_grant_mode=body.default_grant_mode;}
    if(destination==='*'&&Object.keys(values).length!==5)throw new HttpError(400,'global_memory_access_defaults_required');
    return this.commands.run(principal,operation,{kind:'memory_access_settings',destination,values,expected},async db=>{
      const current=(await db.query('SELECT * FROM memory_access_settings WHERE destination=$1 FOR UPDATE',[destination])).rows[0];
      if(current&&Number(current.revision)!==expected||!current&&expected!==1)throw new HttpError(409,'memory_access_settings_conflict');
      const next=current?expected+1:1;
      await db.query(`INSERT INTO memory_access_settings(destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(destination) DO UPDATE SET suggestions=$2,notify_owner=$3,auto_followup=$4,request_ttl_seconds=$5,default_grant_mode=$6,revision=$7,updated_at=now()`,
        [destination,values.suggestions??null,values.notify_owner??null,values.auto_followup??null,values.request_ttl_seconds??null,values.default_grant_mode??null,next]);
      return {destination,revision:next};
    });
  }
  private async fence(db:pg.PoolClient,binding:GuardBinding,fact:Fact) {
    const state=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(canonical(binding)!==canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode}))throw new HttpError(409,'memory_access_context_changed');
    const current=(await this.stores.derived.query('SELECT active_revision FROM entity_claims WHERE id=$1',[fact.id])).rows[0];
    if(Number(current?.active_revision)!==fact.revision)throw new HttpError(409,'memory_fact_changed');
  }
  private async representation(fact:Fact,wording:string,binding:GuardBinding,operation:string):Promise<{reference:DerivativeReference;guard_revision:number|null;text:string;hash:string}> {
    const source=fact.evidence[0];if(!source)throw new HttpError(409,'memory_fact_evidence_missing');await this.access.archive.verify(source);
    const reference=await this.derived.record({operation_id:'memory-access-wording:'+digest(canonical([operation,fact.id,fact.revision,wording,binding])),source,
      kind:'shared_knowledge',content:Buffer.from(wording),producer:'owner',producer_version:protocol,configuration:{fact_id:fact.id,fact_revision:fact.revision},
      provenance:{fact_id:fact.id,fact_revision:fact.revision,evidence:fact.evidence,destination_authority:'fact_grant'}});
    await this.guards.prepare(reference,protocol,this.detect);const guarded=await this.guards.read('derived_artifacts:'+reference.id,binding);
    const text=string((guarded.value as any).text,12000).trim();if(!text)throw new HttpError(422,'empty_safe_wording');
    return {reference,guard_revision:guarded.revision,text,hash:digest(text)};
  }
  private principal(row:any):Reader {return {admin:false,scope:row.source_scope,space:row.destination,turnEvent:row.source_reference.id,
    logical_profile:row.logical_profile,generation:row.binding.generation,guard_epoch:Number(row.binding.epoch)};}
  async suggest(principal:Reader,query:string):Promise<{id:string}|null> {
    if(principal.admin||principal.scope===null||!principal.space||!principal.turnEvent)return null;
    const setting=(await this.effective(principal.space)).effective;if(setting.suggestions==='off')return null;
    const scoped=await this.entities.connected(principal,query,8),seedIds=scoped.entities.slice(0,3).map(item=>item.entity.id);
    if(!seedIds.length){const effective=await this.projects.effective(principal.space);if(effective.project){const row=(await this.stores.control.query('SELECT id FROM memory_entities WHERE project_id=$1 AND state=\'active\'',[effective.project.id])).rows[0];if(row)seedIds.push(row.id);}}
    if(!seedIds.length)return null;
    const connected=await this.entities.connectedFrom({admin:true,scope:null},seedIds,24),pathByEntity=new Map(connected.entities.map(item=>[item.entity.id,item.path]));
    const candidates=(await this.stores.derived.query(`SELECT e.*,v.revision,v.content,v.relationship_kind,v.attribution,v.uncertainty,v.retired,v.evidence,v.input_binding
      FROM entity_claims e JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision
      WHERE NOT v.retired AND (e.subject_entity_id=ANY($1::text[]) OR e.object_entity_id=ANY($1::text[])) ORDER BY
      CASE v.uncertainty WHEN 'explicit' THEN 0 WHEN 'supported' THEN 1 ELSE 2 END,e.id LIMIT 101`,[[...pathByEntity.keys()]])).rows as Fact[];
    const binding=await this.guards.state();let selected:Fact|undefined,path:string[]=[];
    for(const fact of candidates.slice(0,100)) {
      if(!relevant(query,fact.content))continue;
      if((await this.stores.control.query("SELECT 1 FROM memory_fact_grants WHERE destination=$1 AND fact_id=$2 AND state='active' AND (expires_at IS NULL OR expires_at>now()) LIMIT 1",[principal.space,fact.id])).rowCount)continue;
      const readable=(await Promise.all(fact.evidence.map(ref=>this.access.canRead(principal,ref,binding)))).every(Boolean);if(readable)continue;
      selected=fact;path=pathByEntity.get(fact.subject_entity_id)??pathByEntity.get(fact.object_entity_id??'')??[];break;
    }
    if(!selected)return null;
    const source=(await this.access.archive.captured(principal.turnEvent)).reference,requestHash=digest(canonical([protocol,'suggestion',source,principal.space,selected.id,selected.revision]));
    const id=digest('memory-access-request:'+requestHash),proposal=await this.derived.record({operation_id:'memory-access-proposal:'+id,source,kind:'sharing_request',
      content:Buffer.from(selected.content),producer:'nocheh',producer_version:protocol,configuration:{destination:principal.space},
      provenance:{fact_id:selected.id,fact_revision:selected.revision,evidence:selected.evidence,relationship_path:path}});
    const logical=principal.logical_profile??defaultLogicalProfile(principal),expires=new Date(Date.now()+setting.request_ttl_seconds*1000);
    await this.stores.control.query(`INSERT INTO memory_access_requests(id,request_hash,source_reference,destination,source_scope,logical_profile,query_hash,fact_id,fact_revision,
      proposal_reference,binding,relationship_path,evidence,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(request_hash) DO NOTHING`,
      [id,requestHash,source,principal.space,principal.scope,logical,digest(query),selected.id,selected.revision,proposal,binding,JSON.stringify(path),JSON.stringify(selected.evidence),expires]);
    const row=(await this.stores.control.query('SELECT * FROM memory_access_requests WHERE id=$1',[id])).rows[0];
    if(setting.notify_owner&&!row.notification_action_id) {
      const owner=this.access.policy().owner_id;if(owner)try {const action=await this.actions.approvedSystem({...principal,logical_profile:logical},source,binding,owner,
        `A memory access suggestion needs review: ${this.dashboardLink(id)}`,'memory-access-notification:'+id);
        await this.stores.control.query('UPDATE memory_access_requests SET notification_action_id=$2,updated_at=now() WHERE id=$1 AND notification_action_id IS NULL',[id,action.id]);} catch {/* The request remains durable and visible in the dashboard. */}
    }
    return {id};
  }
  private dashboardLink(requestId:string) {
    const configured=process.env.NOCHEH_DASHBOARD_URL?.trim();let base='http://localhost:'+(process.env.NOCHEH_DASHBOARD_PORT??'8783');
    if(configured)try {if(['http:','https:'].includes(new URL(configured).protocol))base=configured;}catch{/* Keep the safe local dashboard route. */}
    return base.replace(/\/$/,'')+'/#memoryMap?request='+encodeURIComponent(requestId);
  }
  async list(principal:Reader,after='') {admin(principal);if(after)identity(after);await this.reconcile();const rows=(await this.stores.control.query('SELECT * FROM memory_access_requests WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    const page=rows.slice(0,100),artifacts=await this.artifacts(page,'proposal_reference'),requests=page.map(row=>{const artifact=artifacts.get(row.proposal_reference.id);return {...row,wording:artifact?.content.toString()??null,provenance:artifact?.provenance??null};});
    return {requests,next:rows.length>100?rows[99].id:null};}
  async grants(principal:Reader,after='') {admin(principal);if(after)identity(after);await this.reconcile();const rows=(await this.stores.control.query('SELECT * FROM memory_fact_grants WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    const page=rows.slice(0,100),artifacts=await this.artifacts(page,'representation_reference'),grants=page.map(row=>{const artifact=artifacts.get(row.representation_reference.id);return {...row,wording:artifact?.content.toString()??null,provenance:artifact?.provenance??null};});
    return {grants,next:rows.length>100?rows[99].id:null};}
  async decide(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['decision','wording','expected_revision','operation_id']),decision=String(body.decision);
    if(!['one_time','persistent','reject'].includes(decision))throw new HttpError(400,'invalid_memory_access_decision');
    const expected=revision(body.expected_revision),operation=string(body.operation_id,200),requestId=identity(id);
    const request=(await this.stores.control.query('SELECT * FROM memory_access_requests WHERE id=$1',[requestId])).rows[0];if(!request)throw new HttpError(404,'memory_access_request_not_found');
    const command={kind:'memory_access_decision',requestId,decision,wording:body.wording??null,expected},hash=digest(canonical(command));
    const prior=(await this.stores.control.query('SELECT request_hash,grant_id,decision,revision FROM memory_access_decisions WHERE operation_id=$1',[operation])).rows[0];
    if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'memory_access_decision_conflict');return {id:requestId,state:prior.decision==='reject'?'rejected':'approved',grant_id:prior.grant_id,revision:prior.revision};}
    if(request.revision!==expected||request.state!=='pending')throw new HttpError(409,'memory_access_request_changed');
    if(request.expires_at<=new Date()){await this.stores.control.query("UPDATE memory_access_requests SET state='expired',revision=revision+1,updated_at=now() WHERE id=$1 AND state='pending'",[requestId]);throw new HttpError(409,'memory_access_request_expired');}
    if(decision==='reject') {const db=await this.stores.control.connect();try{await db.query('BEGIN');const current=(await db.query('SELECT * FROM memory_access_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      if(current.revision!==expected||current.state!=='pending')throw new HttpError(409,'memory_access_request_changed');
      await db.query("UPDATE memory_access_requests SET state='rejected',decision='reject',revision=revision+1,updated_at=now() WHERE id=$1",[requestId]);
      await db.query("INSERT INTO memory_access_decisions(operation_id,request_hash,request_id,decision,revision) VALUES($1,$2,$3,'reject',$4)",[operation,hash,requestId,expected+1]);
      await db.query('COMMIT');return {id:requestId,state:'rejected',revision:expected+1};}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
    const fact=await this.fact(request.fact_id).catch(async()=>{await this.suspendRequest(requestId,expected);throw new HttpError(409,'memory_fact_changed');});
    if(fact.revision!==request.fact_revision){await this.suspendRequest(requestId,expected);throw new HttpError(409,'memory_fact_changed');}
    const binding=await this.guards.state();if(canonical(binding)!==canonical(request.binding)){await this.suspendRequest(requestId,expected);throw new HttpError(409,'memory_access_context_changed');}
    const wording=body.wording===undefined?fact.content:string(body.wording,12000),representation=await this.representation(fact,wording,binding,operation);
    const grantId=digest(canonical([protocol,'grant',operation,requestId,decision,representation.hash])),db=await this.stores.control.connect();
    try {await db.query('BEGIN');await this.fence(db,binding,fact);const current=(await db.query('SELECT * FROM memory_access_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      if(current.revision!==expected||current.state!=='pending')throw new HttpError(409,'memory_access_request_changed');
      await db.query(`INSERT INTO memory_fact_grants(id,request_id,destination,fact_id,fact_revision,representation_reference,binding,guard_revision,text_hash,mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[grantId,requestId,request.destination,fact.id,fact.revision,representation.reference,binding,representation.guard_revision,representation.hash,decision]);
      await db.query("UPDATE memory_access_requests SET state='approved',decision=$2,grant_id=$3,revision=revision+1,updated_at=now() WHERE id=$1",[requestId,decision,grantId]);
      await db.query('INSERT INTO memory_access_decisions(operation_id,request_hash,request_id,grant_id,decision,revision) VALUES($1,$2,$3,$4,$5,$6)',[operation,hash,requestId,grantId,decision,expected+1]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    const setting=(await this.effective(request.destination)).effective;
    if(setting.auto_followup)try {const action=await this.actions.approvedSystem(this.principal(request),request.source_reference,binding,request.destination,representation.text,'memory-access-followup:'+grantId);
      await this.stores.control.query('UPDATE memory_fact_grants SET delivery_action_id=$2,updated_at=now() WHERE id=$1',[grantId,action.id]);
      await this.stores.control.query('UPDATE memory_access_requests SET followup_action_id=$2,updated_at=now() WHERE id=$1',[requestId,action.id]);}catch{/* Approval remains active; the owner can retry delivery. */}
    return {id:requestId,state:'approved',grant_id:grantId,revision:expected+1};
  }
  async grant(principal:Reader,input:unknown) {
    admin(principal);const body=exact(input,['fact_id','fact_revision','destination','wording','expires_at','operation_id']),fact=await this.fact(identity(body.fact_id));
    if(fact.revision!==revision(body.fact_revision))throw new HttpError(409,'memory_fact_changed');const destination=validateSpace(body.destination),operation=string(body.operation_id,200);
    const binding=await this.guards.state(),wording=body.wording===undefined?fact.content:string(body.wording,12000),representation=await this.representation(fact,wording,binding,operation);
    const expires=body.expires_at===undefined?null:new Date(string(body.expires_at,100));if(expires&&(!Number.isFinite(expires.getTime())||expires<=new Date()))throw new HttpError(400,'invalid_grant_expiration');
    const id=digest(canonical([protocol,'manual-grant',operation,destination,fact.id,fact.revision,representation.hash])),hash=digest(canonical({kind:'manual_memory_grant',id,destination,fact:fact.id,revision:fact.revision}));
    const prior=(await this.stores.control.query('SELECT request_hash,grant_id,revision FROM memory_access_decisions WHERE operation_id=$1',[operation])).rows[0];if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'memory_access_decision_conflict');return {id:prior.grant_id,state:'active',revision:prior.revision};}
    const db=await this.stores.control.connect();try{await db.query('BEGIN');await this.fence(db,binding,fact);
      await db.query(`INSERT INTO memory_fact_grants(id,destination,fact_id,fact_revision,representation_reference,binding,guard_revision,text_hash,mode,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'persistent',$9)`,[id,destination,fact.id,fact.revision,representation.reference,binding,representation.guard_revision,representation.hash,expires]);
      await db.query("INSERT INTO memory_access_decisions(operation_id,request_hash,grant_id,decision,revision) VALUES($1,$2,$3,'persistent',1)",[operation,hash,id]);await db.query('COMMIT');
      return {id,state:'active',revision:1};}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async revoke(principal:Reader,id:string,input:unknown) {const body=exact(input,['expected_revision','operation_id']),expected=revision(body.expected_revision),grant=identity(id);
    return this.commands.run(principal,string(body.operation_id,200),{kind:'memory_fact_grant_revoke',grant,expected},async db=>{const row=(await db.query(`UPDATE memory_fact_grants SET state='revoked',revision=revision+1,revoked_at=now(),updated_at=now()
      WHERE id=$1 AND revision=$2 AND state IN ('active','suspended') RETURNING revision`,[grant,expected])).rows[0];if(!row)throw new HttpError(409,'memory_fact_grant_changed');return {id:grant,state:'revoked',revision:row.revision};});}
  async reconcile() {
    await this.stores.control.query("UPDATE memory_access_requests SET state='expired',revision=revision+1,updated_at=now() WHERE state='pending' AND expires_at<=now()");
    await this.stores.control.query("UPDATE memory_fact_grants SET state='expired',revision=revision+1,updated_at=now() WHERE state='active' AND expires_at IS NOT NULL AND expires_at<=now()");
    await this.stores.control.query(`UPDATE memory_access_requests r SET state='delivered',revision=r.revision+1,updated_at=now() FROM telegram_action_requests a
      WHERE r.followup_action_id=a.id AND r.state='approved' AND a.state='done'`);
    await this.stores.control.query(`UPDATE memory_fact_grants g SET state='consumed',consumed_at=now(),revision=g.revision+1,updated_at=now() FROM telegram_action_requests a
      WHERE g.delivery_action_id=a.id AND g.mode='one_time' AND g.state='active' AND a.state='done'`);
  }
  private async validateGrant(row:any,binding:GuardBinding):Promise<string|null> {
    if(canonical(row.binding)!==canonical(binding)){await this.suspend(row.id,'authorization_generation_changed');return null;}
    const fact=await this.fact(row.fact_id).catch(()=>null);if(!fact||fact.revision!==row.fact_revision){await this.suspend(row.id,'fact_revision_changed');return null;}
    try {const guarded=await this.guards.read('derived_artifacts:'+row.representation_reference.id,binding),text=string((guarded.value as any).text,12000);
      if(guarded.revision!==row.guard_revision||digest(text)!==row.text_hash){await this.suspend(row.id,'guarded_representation_changed');return null;}return text;
    }catch(error){if(!(error instanceof HttpError))throw error;await this.suspend(row.id,'guarded_representation_changed');return null;}
  }
  private async suspend(id:string,reason:string){await this.stores.control.query("UPDATE memory_fact_grants SET state='suspended',suspended_reason=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='active'",[id,reason]);}
  private async suspendRequest(id:string,expected:number){await this.stores.control.query("UPDATE memory_access_requests SET state='suspended',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND state='pending'",[id,expected]);}
  async context(principal:Reader,query:string) {
    if(principal.admin||principal.scope===null||!principal.space)throw new HttpError(403,'space_context_required');string(query,2000);await this.reconcile();
    const binding=await this.prepared.audience.assert(principal),rows=(await this.stores.control.query(`SELECT * FROM memory_fact_grants
      WHERE destination=$1 AND mode='persistent' AND state='active' AND (expires_at IS NULL OR expires_at>now()) ORDER BY id LIMIT 100`,[principal.space])).rows,sources=[];
    for(const row of rows){const text=await this.validateGrant(row,binding);if(text&&(!query.trim()||relevant(query,text)))sources.push({id:row.id,source:'nocheh:grant:'+row.id,kind:'owner_approved' as const,text,limitations:[]});if(sources.length>=10)break;}
    await this.prepared.audience.assert(principal);return {sources};
  }
}
