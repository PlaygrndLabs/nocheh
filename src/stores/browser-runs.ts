import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow} from '../workflows/store.js';
import type {SourceAccessRepository} from './access.js';
import type {SourceRepository} from './retrieval.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {PreparationRepository} from './preparation.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {GuardBinding} from './guards.js';
import type {BrowserDeliveryRepository} from './browser-delivery.js';
import {ManagedExecutionRepository,managedIdentity as identity,managedEventId as eventId,type ManagedInput as Input} from './managed-execution.js';
export {managedStorageSchema} from './managed-execution.js';

const protocol='managed-browser-v2';
export class BrowserRunRepository extends ManagedExecutionRepository {
  protected readonly channel='browser' as const;
  protected readonly family='browser' as const;
  protected override readonly rebindBeforeLaunch=true;
  constructor(access:SourceAccessRepository,readonly sources:SourceRepository,derived:DerivedRepository,
    readonly preparation:PreparationRepository,turns:RuntimeTurnRepository,token:string,call:RuntimeCall,
    readonly delivery:BrowserDeliveryRepository){super(access,derived,turns,token,call);}
  override async observe(input:unknown){
    const status=await super.observe(input);
    if(status.state!=='done'||!status.visible||!status.text)return {...status,delivery:null};
    const row=await this.scoped(input);await this.current(row);
    const original=(await this.access.stores.archive.query('SELECT source_id FROM events WHERE id=$1',[row.event_id])).rows[0];
    const delivery=await this.delivery.offer(row,status.text,original.source_id);
    await this.current(row);return {...status,delivery};
  }
  protected readiness(row:any){return this.preparation.status(row.event_id);}
  protected async sourceAllowed(row:any,binding:GuardBinding){
    if(!await this.access.canRead(this.principal(row),row.source_reference,binding)||await this.access.space(row.source_reference)!==row.space_id)
      throw new HttpError(403,'turn_source_denied');
  }
  async admit(principal:Reader,input:unknown){
    admin(principal);const body=object(input),id=eventId(body.event_id),scope=this.scope(body.scope),profile=identity(body.profile);
    const source=(await this.access.archive.captured(id)).reference,original=(await this.access.stores.archive.query('SELECT channel,kind,origin,scope,payload FROM events WHERE id=$1',[id])).rows[0];
    if(original.channel!=='browser'||original.kind!=='browser_input'||original.origin!=='live'||original.scope!==scope)throw new HttpError(403,'browser_original_required');
    const payload=JSON.parse(original.payload.toString()),space=await this.access.space(source);
    if(payload.profile!==profile||body.conversation!==undefined&&body.conversation!==payload.conversation_id)throw new HttpError(403,'run_profile_mismatch');
    if(!space||payload.space!==space)throw new HttpError(403,'run_scope_denied');
    const intake=(await this.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[id])).rows[0];
    if(!intake||intake.state!=='ready')throw new HttpError(409,'capture_handoff_pending');
    if(intake.transport!=='capture')throw new HttpError(403,'browser_original_required');
    const db=await this.control.connect();let held=false;
    try {
      const owner=(await db.query("SELECT * FROM workflow_owners WHERE family='browser'")).rows[0];
      held=await enterFamily(db,'browser',owner.owner,owner.epoch);if(!held)throw new HttpError(409,'workflow_owner_changed');
      await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,803366))",[canonical([scope,profile,payload.conversation_id])]);
      const binding=await this.guards.state();await this.fence(db,binding);
      await this.profile(scope,space,profile,binding);
      const saved=(await db.query('SELECT * FROM managed_runs WHERE event_id=$1 FOR UPDATE',[id])).rows[0];
      if(saved){await db.query('COMMIT');return {owned:true,event_id:id,state:saved.state};}
      if(scope!==this.access.policy().owner_id&&payload.revision!==binding.epoch)throw new HttpError(409,'browser_audience_changed');
      if((await db.query("SELECT 1 FROM managed_runs WHERE scope=$1 AND logical_profile=$2 AND conversation_id=$3 AND state IN ('captured','running')",[scope,profile,payload.conversation_id])).rowCount)
        throw new HttpError(409,'session_busy');
      await db.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,owner_epoch)
        VALUES($1,'browser',$2,$3,$4,$5,$6,$7,$8)`,[id,source,scope,space,profile,payload.conversation_id,binding,owner.epoch]);
      await requestWorkflow(db,'browser',id);await db.query('COMMIT');return {owned:true,event_id:id,state:'captured'};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{await releaseOperation(db,async()=>{if(held)await leaveFamily(db,'browser');});}
  }
  protected async build(row:any):Promise<{reference:DerivativeReference;input:Input}>{
    const principal=this.principal(row);await this.current(row);
    if((await this.preparation.status(row.event_id)).state!=='completed')throw new HttpError(409,'run_preparation_pending');
    await this.turns.register(principal,{logical_profile:row.logical_profile});
    const selected=await this.sources.read(principal,row.event_id),transcripts:string[]=[],files:Record<string,unknown>[]=[],parents:DerivativeReference[]=[];
    for(const result of selected.derived){const hash=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[result.id])).rows[0].content_hash;
      parents.push({store:'derived',kind:'artifact',id:result.id,input_hash:hash});if(result.kind==='transcript')transcripts.push(Buffer.from(result.content_base64,'base64').toString());}
    const manifests=(await this.access.stores.archive.query('SELECT id,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[row.event_id])).rows;
    for(const file of selected.artifacts){const hash=manifests.find(m=>m.id===file.id)?.file_hash;if(!hash)throw new HttpError(409,'source_file_pending');
      const extracted=selected.derived.find(d=>d.artifact_id===file.id&&d.kind==='extracted_text');
      files.push({id:file.id,sha256:hash,name:typeof file.metadata.file_name==='string'?file.metadata.file_name:'Attachment',
        kind:row.binding.mode==='off'&&file.kind==='image'?'image':'file',text:extracted?Buffer.from(extracted.content_base64,'base64').toString():null});}
    const input:Input={principal,text:selected.event.text??'',transcripts,files,source_key:'nocheh:event:'+row.event_id};
    const reference=await this.derived.record({operation_id:'browser-input:'+row.event_id,source:row.source_reference,kind:'runtime_context',
      content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,configuration:{binding:row.binding,profile:row.logical_profile},
      ...(parents.length?{parents}:{}),provenance:{binding:row.binding}});
    await this.current(row);return {reference,input};
  }
}
