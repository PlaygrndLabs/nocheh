import {randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {inspectRequest} from '../guard.js';
import type {HonchoCall} from '../honcho.js';
import {parentSpace} from '../spaces.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository} from './derived.js';
import type {GuardBinding} from './guards.js';
import type {PreparedDependency} from './learned.js';
import type {LearningContextRepository} from './learning-context.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {HonchoProvenanceRepository} from './honcho-provenance.js';
import {OwnerCommands} from './owner-commands.js';
import {evidencePeerId,honchoPeerId,type EntityContext} from './entities.js';

const protocol='honcho-entity-v1';
/** The assistant is a peer whose messages are saved but never observed (ADR-0109). */
export const assistantPeer='nocheh_assistant';
const assistantKinds=new Set(['telegram_delivered_message','browser_delivered_message']);
const limited={sources:[],limited_memory:true,note:'Long-term memory is limited. Current context, native notes and archive search remain available.'};
const nativeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{21}$/.test(value);
const sessionName=(workspace:string,key:string,revision:number)=>digest(canonical([protocol,'session',workspace,key,revision]));
/** Validation failures that mean a written receipt no longer belongs in Honcho. */
const invalidCodes=new Set(['learning_consent_required','memory_refresh_required','learned_memory_not_found']);
const contextTokens=4000,contextCharacters=20000;
type SessionKind='conversation'|'entity_evidence'|'projection';
/** The installation's Honcho workspace; only a fresh start or an installation reset changes it. */
const workspaceId=(generation:string,revision:number)=>digest(canonical(revision===1?[protocol,generation]:[protocol,generation,revision]));
type Current=Awaited<ReturnType<NativeMemoryRepository['current']>>;

/** Honcho owns native memory. Nocheh owns guarded inputs, immutable results and recoverable receipts.
 * One Honcho workspace serves the installation; sessions bound conversations; guard epochs never rebuild it. */
export class NativeMemoryRepository {
  constructor(readonly contexts:LearningContextRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly provenance:HonchoProvenanceRepository,readonly call:HonchoCall,readonly detect:(text:string)=>Promise<unknown>){}
  private get control(){return this.contexts.access.stores.control;}
  private get guards(){return this.contexts.guards;}
  private get owner(){return this.contexts.access.policy().owner_id;}
  private audienceOf(space:string){return space===this.owner?'owner':space;}
  private principalAudience(principal:Reader){return principal.scope===null?'owner':principal.space??principal.scope;}

  async status() {
    const binding=await this.guards.state(),connection=(await this.control.query('SELECT * FROM memory_engine_connection WHERE singleton')).rows[0];
    const workspace=await this.workspace(binding);
    const sessions=workspace?(await this.control.query(`SELECT s.audience,count(DISTINCT s.session_id)::int AS sessions,
      count(r.id) FILTER (WHERE r.state<>'done')::int AS pending FROM memory_sessions s
      LEFT JOIN memory_ingestion_receipts r ON r.session_id=s.session_id AND r.retired_at IS NULL
      WHERE s.workspace=$1 GROUP BY s.audience ORDER BY s.audience`,[workspace.id])).rows:[];
    const receipts=(await this.control.query('SELECT state,count(*)::int AS count FROM memory_ingestion_receipts WHERE retired_at IS NULL GROUP BY state')).rows;
    const deletions=(await this.control.query('SELECT state,count(*)::int AS count FROM memory_session_deletions GROUP BY state')).rows;
    const retired=(await this.control.query(`SELECT state,count(*)::int AS workspaces,sum(deleted_sessions)::int AS sessions
      FROM memory_workspace_deletions GROUP BY state ORDER BY state`)).rows;
    return {connection,workspace:workspace?{id:workspace.id,state:workspace.state,last_ready_at:workspace.last_ready_at,error_code:workspace.error_code}:null,
      sessions,receipts,deletions,workspace_deletions:retired,guard:binding,primary:'honcho',native_notes:['MEMORY.md','USER.md'],syncing:workspace?.state==='building',
      limited_memory:!connection.attached||!connection.verified||!workspace||!workspace.last_ready_at&&workspace.state!=='ready'};
  }
  /** A short-lived synthetic workspace for live provider acceptance before memory attachment. */
  async issueAcceptance(principal:Reader) {
    admin(principal);
    const binding=await this.guards.state();
    const id=randomBytes(32).toString('hex');
    const row=(await this.control.query(`UPDATE memory_engine_connection SET acceptance=jsonb_build_object('preflight',
      jsonb_build_object('id',$1::text,'generation',$2::text,'epoch',$3::bigint,
        'expires_at',now()+interval '30 minutes','closed_at',NULL))
      WHERE singleton AND NOT attached AND NOT verified
      AND (acceptance #>> '{preflight,id}' IS NULL
        OR (acceptance #>> '{preflight,expires_at}')::timestamptz<=now()
        OR acceptance #> '{preflight,closed_at}'<>'null'::jsonb)
      RETURNING acceptance #>> '{preflight,expires_at}' AS expires_at`,
      [id,binding.generation,binding.epoch])).rows[0];
    if(!row)throw new HttpError(409,'honcho_acceptance_requires_detached_memory');
    return {workspace:id,expires_at:row.expires_at};
  }
  async closeAcceptance(principal:Reader,id:string) {
    admin(principal);
    if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_acceptance_workspace');
    const closed=await this.control.query(`UPDATE memory_engine_connection
      SET acceptance=jsonb_set(acceptance,'{preflight,closed_at}',to_jsonb(now()))
      WHERE singleton AND acceptance #>> '{preflight,id}'=$1 AND acceptance #> '{preflight,closed_at}'='null'::jsonb`,[id]);
    if(!closed.rowCount)throw new HttpError(404,'acceptance_workspace_missing');
    return {workspace:id,closed:true};
  }
  async acceptanceRequest(input:unknown):Promise<boolean> {
    const body=object(input),id=body.workspace;
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return false;
    const binding=await this.guards.state();
    const found=await this.control.query(`SELECT 1 FROM memory_engine_connection WHERE singleton AND NOT attached
      AND acceptance #>> '{preflight,id}'=$1 AND acceptance #>> '{preflight,generation}'=$2
      AND (acceptance #>> '{preflight,epoch}')::bigint=$3 AND acceptance #> '{preflight,closed_at}'='null'::jsonb
      AND (acceptance #>> '{preflight,expires_at}')::timestamptz>now()`,[id,binding.generation,binding.epoch]);
    if(!found.rowCount)return false;
    if(!['/v1/chat/completions','/v1/embeddings'].includes(String(body.route)))throw new HttpError(400,'memory_route_denied');
    object(body.payload);
    return true;
  }
  async connection(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(k=>!['attached','include_history','catch_up','expected_revision','operation_id'].includes(k))||
      typeof body.attached!=='boolean'||typeof body.include_history!=='boolean'||typeof body.catch_up!=='boolean'||!Number.isSafeInteger(body.expected_revision))
      throw new HttpError(400,'invalid_memory_connection');
    await new OwnerCommands(this.control).run(principal,string(body.operation_id,200),body,async db=>{
      const row=(await db.query('SELECT * FROM memory_engine_connection WHERE singleton FOR UPDATE')).rows[0];
      if(row.revision!==body.expected_revision)throw new HttpError(409,'memory_connection_conflict');
      if(body.attached&&!row.verified)throw new HttpError(409,'honcho_live_acceptance_pending');
      await db.query(`UPDATE memory_engine_connection SET attached=$1,include_history=$2,revision=revision+1,
        attached_at=CASE WHEN $1 AND NOT attached AND NOT $3 THEN now() ELSE coalesce(attached_at,now()) END WHERE singleton`,
        [body.attached,body.include_history,body.catch_up]);
      return {revision:row.revision+1};
    });return this.status();
  }
  async acceptVerification(principal:Reader,input:unknown) {
    admin(principal);const report=object(input),checks=object(report.checks),ledger=object(report.ledger);
    const required=['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'];
    if(report.format!=='nocheh-honcho-live-v1'||report.status!=='passed'||report.synthetic_only!==true||required.some(k=>checks[k]!=='passed')||
      typeof ledger.reserved_usd!=='number'||!Number.isFinite(ledger.reserved_usd)||ledger.reserved_usd<=0||ledger.reserved_usd>5||ledger.limit_usd!==5||
      typeof report.acceptance_workspace!=='string'||!/^[a-f0-9]{64}$/.test(report.acceptance_workspace))
      throw new HttpError(409,'honcho_live_acceptance_pending');
    const binding=await this.guards.state();
    const session=(await this.control.query(`SELECT 1 FROM memory_engine_connection WHERE singleton AND NOT attached
      AND acceptance #>> '{preflight,id}'=$1 AND acceptance #>> '{preflight,generation}'=$2
      AND (acceptance #>> '{preflight,epoch}')::bigint=$3
      AND (acceptance #>> '{preflight,closed_at}')::timestamptz<=(acceptance #>> '{preflight,expires_at}')::timestamptz`,
      [report.acceptance_workspace,binding.generation,binding.epoch])).rows[0];
    if(!session)throw new HttpError(409,'honcho_live_acceptance_pending');
    await this.control.query('UPDATE memory_engine_connection SET verified=true,acceptance=$1 WHERE singleton',
      [{checks:Object.fromEntries(required.map(name=>[name,'passed'])),recorded_at:new Date().toISOString(),format:report.format,
        acceptance_workspace:report.acceptance_workspace}]);return this.status();
  }
  /** The guarded identity Nocheh uses on an audience's behalf for memory work. */
  private principal(audience:string,turnEvent:string,binding:GuardBinding):Reader {
    const space=audience==='owner'?this.owner:audience;
    return {admin:false,scope:audience==='owner'?null:parentSpace(audience)??audience,...(space?{space}:{}),
      turnEvent,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch,purpose:'memory-review'};
  }
  private async workspace(binding:GuardBinding) {
    return (await this.control.query(`SELECT * FROM memory_generations WHERE installation_generation=$1 AND audience='installation'
      AND representation_version=$2 AND state<>'retired'`,[binding.generation,protocol])).rows[0] as any;
  }
  /** The installation workspace stays current across guard epochs; only an installation reset replaces it. */
  async current(id:string) {
    const binding=await this.guards.state(),row=(await this.control.query('SELECT * FROM memory_generations WHERE id=$1',[id])).rows[0];
    const revision=(await this.control.query('SELECT workspace_revision FROM memory_engine_connection WHERE singleton')).rows[0].workspace_revision;
    // A fresh start opens the next workspace revision; nothing writes to or reads from an earlier one again.
    if(!row?.root_reference||row.audience!=='installation'||row.representation_version!==protocol||id!==workspaceId(binding.generation,revision))
      throw new HttpError(409,'memory_context_retired');
    await this.provenance.current(id,'owner',binding);
    return {row,binding,principal:this.principal('owner',row.root_reference.id,binding)};
  }
  private async ensureWorkspace(source:SourceReference,binding:GuardBinding) {
    const revision=(await this.control.query('SELECT workspace_revision FROM memory_engine_connection WHERE singleton')).rows[0].workspace_revision;
    const id=workspaceId(binding.generation,revision);
    // Per-audience, per-epoch workspaces of earlier mappings are superseded and never written again.
    await this.control.query(`UPDATE memory_generations SET state='retired' WHERE installation_generation=$1
      AND representation_version<>$2 AND state<>'retired'`,[binding.generation,protocol]);
    await this.control.query(`INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience,root_reference,root_space,representation_version)
      VALUES($1,$2,$3,'installation',$4,$5,$6) ON CONFLICT DO NOTHING`,[id,binding.generation,binding.epoch,source,this.owner,protocol]);
    await this.current(id);return id;
  }
  private async session(workspace:string,key:string,audience:string,kind:SessionKind) {
    await this.control.query(`INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [workspace,key,audience,kind,sessionName(workspace,key,1)]);
    const row=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2',[workspace,key])).rows[0];
    // Owner-private evidence never enters a session another audience may read.
    if(row.audience!==audience||row.kind!==kind)throw new HttpError(409,'memory_session_conflict');
    return row as {session_id:string;revision:number;audience:string};
  }
  private async queueDocument(source:SourceReference,evidence:SourceReference[],space:string,text:string,dependencies:PreparedDependency[],binding:GuardBinding,
    entities:EntityContext,options:{projection?:{id:string;revision:number};assistant?:boolean}={}):Promise<{audience:string;workspace:string;receipts:string[]}[]> {
    if(evidence.length<1||evidence.length>30||text.length>600000)throw new HttpError(413,'memory_input_limit');
    const {projection,assistant=false}=options,audience=this.audienceOf(space);
    const workspace=await this.ensureWorkspace(source,binding),generation=await this.current(workspace);
    // Honcho egress is prepared as the workspace owner; reply context is prepared for the audience.
    const writers=[this.principal(audience,source.id,binding),...(audience==='owner'?[]:[generation.principal])];
    const speaker=assistant?null:entities.speaker;
    const peer=assistant?assistantPeer:!projection&&speaker?honchoPeerId(speaker):evidencePeerId(source);
    const subjects=[entities.project,...entities.mentioned_projects,...entities.mentioned_people].filter((value,index,all)=>
      !!value&&value.id!==speaker?.id&&all.findIndex(other=>other?.id===value.id)===index);
    const allPeers=[peer,...subjects.map(value=>honchoPeerId(value!))].filter((value,index,all)=>all.indexOf(value)===index);
    const conversation=entities.session_id;
    const records=[{text,key:projection?digest(canonical([protocol,'projection',conversation,projection.id])):conversation,
      kind:(projection?'projection':'conversation') as SessionKind,subject:projection?null:speaker?.id??null,peers:allPeers,
      record:projection?'learned_interpretation':'source_evidence'},
      ...subjects.map(subject=>({text:canonical({kind:'entity_evidence',subject:{id:subject!.id,kind:subject!.kind,name:subject!.name},
        original_speaker:speaker?{id:speaker.id,name:speaker.name}:null,source,attribution:projection||!speaker?'inferred':'reported',observation:JSON.parse(text),
        authority:'This observation is about the subject; it is not a statement made by the subject.'}),
        // An interpretation's subject evidence has its own session, so correcting it never rebuilds source evidence.
        key:digest(canonical([protocol,'entity-evidence',conversation,subject!.id,...(projection?[projection.id]:[])])),kind:'entity_evidence' as SessionKind,subject:subject!.id as string|null,
        peers:[peer,honchoPeerId(subject!)],record:'entity_evidence'}))];
    // Logical identities do not depend on a session's revision, so a rebuild can carry valid writes forward.
    const planned=records.flatMap(record=>{
      const chars=Array.from(record.text),chunks=[];
      for(let offset=0;offset<chars.length;offset+=12000) {
        const content=`[nocheh:event:${source.id}]\n`+chars.slice(offset,offset+12000).join(''),hash=digest(content);
        chunks.push({record,offset,content,logical:digest(canonical([workspace,record.key,peer,record.subject,evidence,dependencies,projection??null,binding.mode,offset,hash]))});
      }
      return chunks;
    });
    const logical=new Set(planned.map(item=>item.logical));
    const stale=(await this.control.query(`SELECT id,session_key,logical_id FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL
      AND source_reference->>'id'=$2 AND CASE WHEN $3::text IS NULL THEN projection_reference IS NULL ELSE projection_reference->>'id'=$3 END`,
      [workspace,source.id,projection?.id??null])).rows.filter(row=>!logical.has(row.logical_id));
    // Changed evidence replaces only the sessions that held its earlier version.
    for(const key of new Set(stale.map(row=>String(row.session_key))))await this.rebuild(workspace,key,new Set(stale.map(row=>String(row.id))));
    for(const record of records)for(const writer of writers)await this.prepared.allow(writer,JSON.parse(record.text));
    const receipts:string[]=[];
    for(const item of planned) {
      const session=await this.session(workspace,item.record.key,audience,item.record.kind),id=digest(canonical([session.session_id,item.logical]));
      const prepared=await this.derived.record({operation_id:'memory-input:'+item.logical,source,kind:'memory_input',content:Buffer.from(item.content),
        producer:'nocheh',producer_version:protocol,configuration:{workspace,session_key:item.record.key,audience,dependencies,projection:projection??null,offset:item.offset,record_kind:item.record.record},
        provenance:{evidence,guard_mode:binding.mode,representation:binding.mode==='on'?'guarded':'original',exact_citations:false}});
      for(const writer of writers)await this.prepared.allow(writer,{text:item.content});
      await this.current(workspace);
      const db=await this.control.connect();
      try {
        await db.query('BEGIN');
        const live=(await db.query('SELECT session_id FROM memory_sessions WHERE workspace=$1 AND key=$2 FOR SHARE',[workspace,item.record.key])).rows[0];
        if(live?.session_id!==session.session_id)throw new HttpError(409,'memory_session_rebuilt');
        const added=await db.query(`INSERT INTO memory_ingestion_receipts(id,generation,audience,session_key,logical_id,guard_mode,source_reference,source_references,
          guard_source_id,guarded_revision,prepared_id,content_hash,dependencies,projection_reference,peer_id,peer_ids,session_id,subject_entity_id,speaker_entity_id,record_kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING RETURNING id`,
          [id,workspace,audience,item.record.key,item.logical,binding.mode,source,JSON.stringify(evidence),'events:'+source.id,
            dependencies.find(d=>d.source_id==='events:'+source.id)?.revision??null,prepared.id,prepared.input_hash,JSON.stringify(dependencies),projection??null,
            peer,JSON.stringify(item.record.peers),session.session_id,item.record.subject,speaker?.id??null,item.record.record]);
        if(added.rowCount)await this.changed(db,workspace,item.record.key);
        await requestWorkflow(db,'honcho','receipt:'+id);
        await db.query('COMMIT');
      } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      receipts.push(id);
    }
    await this.guards.assertCurrent(binding);
    return [{audience,workspace,receipts}];
  }
  /** New work in a session marks the workspace as building until Honcho finishes it. */
  private async changed(db:pg.PoolClient,workspace:string,key:string) {
    await db.query('UPDATE memory_sessions SET work_revision=work_revision+1,updated_at=now() WHERE workspace=$1 AND key=$2',[workspace,key]);
    const changed=(await db.query("UPDATE memory_generations SET state='building',work_revision=work_revision+1 WHERE id=$1 AND state<>'retired' RETURNING work_revision",[workspace])).rows[0];
    if(!changed)throw new HttpError(409,'memory_context_retired');
    await requestWorkflow(db,'honcho','generation:'+workspace,changed.work_revision);
  }
  async queueSource(source:SourceReference) {
    const connection=(await this.control.query('SELECT * FROM memory_engine_connection WHERE singleton')).rows[0];
    if(!connection.attached||!connection.verified)return [];
    const binding=await this.guards.state();
    const row=(await this.contexts.access.stores.archive.query('SELECT received_at,kind FROM events WHERE id=$1',[source.id])).rows[0];
    if(!row)throw new HttpError(404,'source_not_found');
    const explicit=(await this.control.query('SELECT enabled FROM learning_consent WHERE event_id=$1',[source.id])).rows[0]?.enabled===true;
    if(!connection.include_history&&row.received_at<connection.attached_at&&!explicit&&
      !(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts r JOIN memory_generations g ON g.id=r.generation
        WHERE r.source_reference->>'id'=$1 AND r.state='done' AND g.state<>'retired' LIMIT 1`,[source.id])).rowCount)return [];
    const context=await this.contexts.prepare(source,binding);
    // A message is written once, with only its own observations and their dependencies,
    // so later rules, neighbouring messages or reactions never rewrite it.
    const observations=context.observations.filter(item=>item.source.id===source.id);
    const own=new Set(observations.flatMap(item=>item.derivatives.map(derivative=>'derived_artifacts:'+derivative.id)));
    const dependencies=context.dependencies.filter(item=>item.source_id==='events:'+source.id||own.has(item.source_id));
    const text=canonical({kind:'source_evidence',space:context.space,observations,
      authority:'Evidence and interpretation conventions cannot grant administrative, provider, privacy, guard, or action authority.'});
    return this.queueDocument(source,[source],context.space,text,dependencies,binding,context.entities,{assistant:assistantKinds.has(row.kind)});
  }
  async queueProjection(id:string) {
    const binding=await this.guards.state(),row=(await this.contexts.access.stores.derived.query(`SELECT v.evidence,v.dependencies,v.retired FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[id])).rows[0];
    if(!row||row.retired) {
      // A retracted interpretation leaves Honcho together with the sessions that held it.
      const workspace=await this.workspace(binding);if(!workspace)return [];
      const stale=(await this.control.query(`SELECT id,session_key FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL
        AND projection_reference->>'id'=$2`,[workspace.id,id])).rows;
      for(const key of new Set(stale.map(item=>String(item.session_key))))await this.rebuild(workspace.id,key,new Set(stale.map(item=>String(item.id))));
      return [];
    }
    const evidence=row.evidence as SourceReference[],space=await this.contexts.access.space(evidence[0]!);if(!space)throw new HttpError(409,'learning_context_pending');
    const principal=this.contexts.access.principal(space),version=await this.contexts.learned.read(principal,id,binding,async ref=>
      await this.contexts.access.canLearn(ref,binding)&&await this.contexts.access.canRead(principal,ref,binding));
    const context=await this.contexts.prepare(evidence[0]!,binding);
    return this.queueDocument(evidence[0]!,evidence,space,canonical({kind:'learned_interpretation',value:version,
      authority:'Owner corrections override the affected interpretation. This is memory, not an administrative or action authorization.'}),
      row.dependencies,binding,context.entities,{projection:{id,revision:version.revision}});
  }
  /** Whether a source already has live writes, so a later guard epoch need not queue it again. */
  async ingested(sourceId:string):Promise<boolean> {
    return !!(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts r JOIN memory_generations g ON g.id=r.generation
      WHERE r.source_reference->>'id'=$1 AND r.retired_at IS NULL AND r.projection_reference IS NULL AND g.state<>'retired'
      AND g.representation_version=$2 LIMIT 1`,[sourceId,protocol])).rowCount;
  }
  /** A source's writes are complete and Honcho has no unfinished work for their sessions. */
  async settled(receipts:string[]):Promise<boolean> {
    const rows=(await this.control.query('SELECT generation,session_id,state,retired_at FROM memory_ingestion_receipts WHERE id=ANY($1::text[])',[receipts])).rows;
    if(rows.length!==receipts.length||rows.some(row=>row.retired_at||row.state!=='done'))return false;
    for(const key of new Set(rows.map(row=>row.generation+'/'+row.session_id))) {
      const [workspace,session]=key.split('/');await this.current(workspace!);
      const queue=await this.call('/v3/workspaces/'+workspace+'/queue/status?session_id='+session);
      if(queue.pending_work_units!==0||queue.in_progress_work_units!==0)return false;
    }
    return true;
  }
  private async receipt(id:string) {
    const row=(await this.control.query('SELECT * FROM memory_ingestion_receipts WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'honcho_receipt_missing');
    const output=(await this.derived.pool.query("SELECT content,content_hash FROM derived_artifacts WHERE id=$1 AND kind='memory_input'",[row.prepared_id])).rows[0];
    if(!output||output.content_hash!==row.content_hash||digest(output.content)!==row.content_hash)throw new HttpError(409,'honcho_input_conflict');
    return {...row,content:output.content.toString() as string};
  }
  /** Throws when a written receipt no longer belongs in Honcho. A later reaction change adds evidence; it does not retract earlier evidence. */
  private async validate(row:any,binding:GuardBinding):Promise<void> {
    if(row.guard_mode&&row.guard_mode!==binding.mode)throw new HttpError(409,'memory_refresh_required');
    const principal=this.principal(row.audience,row.source_reference.id,binding),historical={historical:true};
    for(const reference of row.source_references.length?row.source_references:[row.source_reference])
      if(!await this.contexts.access.canLearn(reference,binding,historical)||
        !await this.contexts.access.canRead(principal,reference,binding,historical))throw new HttpError(403,'learning_consent_required');
    const space=await this.contexts.access.space(row.source_reference);
    if(!space||this.audienceOf(space)!==row.audience)throw new HttpError(409,'memory_refresh_required');
    if(row.projection_reference) {
      const version=await this.contexts.learned.read(principal,row.projection_reference.id,binding,async ref=>
        await this.contexts.access.canLearn(ref,binding,historical)&&await this.contexts.access.canRead(principal,ref,binding,historical));
      if(version.revision!==row.projection_reference.revision)throw new HttpError(409,'memory_refresh_required');
    } else await this.contexts.learned.validateDependencies(row.dependencies,binding);
    const entities=[...new Set([row.subject_entity_id,row.speaker_entity_id].filter((value):value is string=>!!value))];
    if(entities.length&&(await this.control.query("SELECT count(*)::int AS count FROM memory_entities WHERE id=ANY($1::text[]) AND state='active'",
      [entities])).rows[0].count!==entities.length)throw new HttpError(409,'memory_refresh_required');
  }
  private async valid(row:any,binding:GuardBinding):Promise<boolean> {
    try{await this.validate(row,binding);return true;}
    catch(error){if(error instanceof HttpError&&(invalidCodes.has(error.code)||error.status===404))return false;throw error;}
  }
  private async authorizedReceipt(row:any) {
    const current=await this.current(row.generation);
    const live=(await this.control.query('SELECT retired_at FROM memory_ingestion_receipts WHERE id=$1',[row.id])).rows[0];
    if(!live||live.retired_at)throw new HttpError(409,'memory_receipt_retired');
    await this.validate(row,current.binding);
    return current;
  }
  private observed(row:any,found:unknown):string|null {
    if(!Array.isArray(found)||found.length>1)throw new HttpError(409,'honcho_receipt_conflict');
    if(!found.length)return null;
    if(!nativeId(found[0]?.id)||found[0].content!==row.content||found[0].metadata?.nocheh_receipt!==row.id)
      throw new HttpError(409,'honcho_receipt_conflict');
    return found[0].id;
  }
  async reconcileReceipt(id:string):Promise<boolean> {
    const connection=(await this.control.query('SELECT attached,verified FROM memory_engine_connection WHERE singleton')).rows[0];
    if(!connection.attached||!connection.verified)return false;
    const row=await this.receipt(id);if(row.state==='done')return true;if(row.state!=='uncertain')return false;
    // Reconciliation reads only its exact receipt and never writes, even for a replaced session.
    const result=await this.call('/v3/workspaces/'+row.generation+'/sessions/'+(row.session_id??id)+'/messages/list',{filters:{metadata:{nocheh_receipt:id}}});
    const remote=this.observed(row,result.items);if(!remote)return false;
    await this.control.query("UPDATE memory_ingestion_receipts SET state='done',remote_id=$2,error_code=NULL WHERE id=$1 AND state='uncertain'",[id,remote]);return true;
  }
  async syncReceipt(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'honcho_sync_busy');
      const row=await this.receipt(id);if(row.state==='done')return true;
      if(row.state==='uncertain')return await this.reconcileReceipt(id);
      try {
        const workspace='/v3/workspaces/'+row.generation,sessionId=row.session_id??id,session=workspace+'/sessions/'+sessionId;
        await this.authorizedReceipt(row);await this.call('/v3/workspaces',{id:row.generation});
        const peers=(Array.isArray(row.peer_ids)&&row.peer_ids.length?row.peer_ids:[row.peer_id]).filter((value:unknown)=>typeof value==='string');
        for(const peer of peers){await this.authorizedReceipt(row);await this.call(workspace+'/peers',peer===assistantPeer?{id:peer,configuration:{observe_me:false}}:{id:peer});}
        await this.authorizedReceipt(row);await this.call(workspace+'/sessions',{id:sessionId,peers:Object.fromEntries(peers.map((peer:string)=>
          [peer,peer===assistantPeer?{observe_me:false,observe_others:false}:peer===row.peer_id?{observe_me:true,observe_others:false}:{observe_me:false,observe_others:true}]))});
        const previous=await this.call(session+'/messages/list',{filters:{metadata:{nocheh_receipt:id}}});
        let remote=this.observed(row,previous.items);
        if(!remote) {
          await this.authorizedReceipt(row);
          await db.query("UPDATE memory_ingestion_receipts SET state='uncertain',attempts=attempts+1 WHERE id=$1",[id]);
          const found=await this.call(session+'/messages',{messages:[{peer_id:row.peer_id,content:row.content,
            metadata:{nocheh_receipt:id,source_revision:row.source_reference.revision,guarded_revision:row.guarded_revision}}]});
          remote=this.observed(row,found);if(!remote)throw new HttpError(409,'honcho_write_unresolved');
        }
        await db.query("UPDATE memory_ingestion_receipts SET state='done',remote_id=$2,error_code=NULL WHERE id=$1",[id,remote]);return true;
      } catch(error) {
        await db.query(`UPDATE memory_ingestion_receipts SET error_code=$2,next_attempt=now()+interval '60 seconds' WHERE id=$1`,
          [id,error instanceof HttpError?error.code:'honcho_unavailable']);throw error;
      }
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** Replace one session: retire its writes, carry the valid ones into a new revision,
   * delete the old Honcho session with conclusions derived from it, and re-ingest changed sources. */
  async rebuild(workspace:string,key:string,drop:ReadonlySet<string>=new Set()):Promise<string|null> {
    const binding=await this.guards.state();
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2',[workspace,key])).rows[0];
    if(!session)return null;
    const rows=(await this.control.query('SELECT * FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL ORDER BY created_at,id',[session.session_id])).rows;
    const rejected=new Set(drop),requeue=new Set<string>();
    for(const row of rows)if(!drop.has(row.id)&&!await this.valid(row,binding)) {
      rejected.add(row.id);if(!row.projection_reference)requeue.add(row.source_reference.id);
    }
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const locked=(await db.query('SELECT revision,session_id FROM memory_sessions WHERE workspace=$1 AND key=$2 FOR UPDATE',[workspace,key])).rows[0];
      if(locked.session_id!==session.session_id){await db.query('ROLLBACK');return locked.session_id;}
      const revision=locked.revision+1,next=sessionName(workspace,key,revision);
      await db.query('UPDATE memory_sessions SET revision=$3,session_id=$4,updated_at=now() WHERE workspace=$1 AND key=$2',[workspace,key,revision,next]);
      const retired=(await db.query('UPDATE memory_ingestion_receipts SET retired_at=now() WHERE session_id=$1 AND retired_at IS NULL RETURNING id,logical_id',
        [session.session_id])).rows;
      let carried=0;
      for(const row of retired)if(!rejected.has(row.id)) {
        const id=digest(canonical([next,row.logical_id]));
        await db.query(`INSERT INTO memory_ingestion_receipts(id,generation,audience,session_key,logical_id,guard_mode,source_reference,source_references,
          guard_source_id,guarded_revision,prepared_id,content_hash,dependencies,projection_reference,peer_id,peer_ids,session_id,subject_entity_id,speaker_entity_id,record_kind)
          SELECT $1,generation,audience,session_key,logical_id,guard_mode,source_reference,source_references,guard_source_id,guarded_revision,prepared_id,
          content_hash,dependencies,projection_reference,peer_id,peer_ids,$2,subject_entity_id,speaker_entity_id,record_kind
          FROM memory_ingestion_receipts WHERE id=$3 ON CONFLICT DO NOTHING`,[id,next,row.id]);
        await requestWorkflow(db,'honcho','receipt:'+id);carried++;
      }
      if(carried)await this.changed(db,workspace,key);
      await db.query(`INSERT INTO memory_session_deletions(session_id,workspace,session_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[session.session_id,workspace,key]);
      await requestWorkflow(db,'honcho','delete:'+session.session_id);
      for(const source of requeue) {
        const generation=Number((await db.query("SELECT nextval('memory_ingest_requests') AS value")).rows[0].value);
        await requestWorkflow(db,'honcho','ingest:'+source,generation);
      }
      await db.query('COMMIT');return next;
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /**
   * Fresh start: the installation moves to a new, empty Honcho workspace that learns from messages received from now on,
   * and every earlier Nocheh workspace in Honcho is deleted with its Nocheh records. Original messages stay in the archive.
   */
  async freshStart(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(k=>!['expected_revision','operation_id'].includes(k))||!Number.isSafeInteger(body.expected_revision))
      throw new HttpError(400,'invalid_memory_fresh_start');
    // Only workspaces Nocheh recorded as its own memory generations are deleted; anything else in Honcho is left alone.
    await new OwnerCommands(this.control).run(principal,string(body.operation_id,200),body,async db=>{
      const row=(await db.query('SELECT * FROM memory_engine_connection WHERE singleton FOR UPDATE')).rows[0];
      if(row.revision!==body.expected_revision)throw new HttpError(409,'memory_connection_conflict');
      await db.query(`UPDATE memory_engine_connection SET workspace_revision=workspace_revision+1,attached_at=now(),include_history=false,
        revision=revision+1 WHERE singleton`);
      await db.query("UPDATE memory_generations SET state='retired' WHERE state<>'retired'");
      for(const {id} of (await db.query('SELECT id FROM memory_generations')).rows) {
        await db.query('INSERT INTO memory_workspace_deletions(workspace) VALUES($1) ON CONFLICT DO NOTHING',[id]);
        await requestWorkflow(db,'honcho','retire:'+id);
      }
      return {revision:row.revision+1};
    });
    return this.status();
  }
  /** Remove one earlier workspace from Honcho: its sessions first, as Honcho requires, then the workspace and Nocheh's records of it. */
  async retireWorkspace(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'honcho_sync_busy');
      const row=(await db.query('SELECT * FROM memory_workspace_deletions WHERE workspace=$1',[id])).rows[0];
      if(!row)throw new HttpError(404,'memory_deletion_missing');if(row.state==='done')return true;
      if((await db.query("SELECT 1 FROM memory_generations WHERE id=$1 AND state<>'retired'",[id])).rowCount)throw new HttpError(409,'memory_workspace_current');
      const base='/v3/workspaces/'+id;
      for(let page=0;page<10;page++) {
        const found=await this.call(base+'/sessions/list?page=1&size=100',{});
        const sessions:string[]=Array.isArray(found?.items)?found.items.map((item:any)=>String(item?.id??'')):[];
        if(sessions.some(session=>!/^[A-Za-z0-9_-]{1,100}$/.test(session)))throw new HttpError(502,'invalid_honcho_sessions');
        if(!sessions.length) {
          await this.call(base,undefined,'DELETE');
          await db.query('BEGIN');
          try {
            for(const table of ['memory_session_deletions','memory_sessions'])await db.query(`DELETE FROM ${table} WHERE workspace=$1`,[id]);
            await db.query('DELETE FROM memory_ingestion_receipts WHERE generation=$1',[id]);
            await db.query('DELETE FROM memory_generations WHERE id=$1',[id]);
            await db.query("UPDATE memory_workspace_deletions SET state='done',completed_at=now() WHERE workspace=$1",[id]);
            await db.query('COMMIT');
          } catch(error){await db.query('ROLLBACK');throw error;}
          return true;
        }
        for(const session of sessions)await this.call(base+'/sessions/'+session,undefined,'DELETE');
        await db.query('UPDATE memory_workspace_deletions SET deleted_sessions=deleted_sessions+$2 WHERE workspace=$1',[id,sessions.length]);
      }
      return false;
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** Remove a replaced session from Honcho, first deleting conclusions other sessions derived from it. */
  async deleteSession(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'honcho_sync_busy');
      const row=(await db.query('SELECT * FROM memory_session_deletions WHERE session_id=$1',[id])).rows[0];
      if(!row)throw new HttpError(404,'memory_deletion_missing');if(row.state==='done')return true;
      const base='/v3/workspaces/'+row.workspace;
      for(let page=0;page<10;page++) {
        await this.current(row.workspace);
        const found=await this.call(base+'/nocheh/session-descendants',{session_id:id,limit:100});
        if(!found||!Array.isArray(found.ids)||found.ids.length>100||found.ids.some((value:unknown)=>!nativeId(value)))throw new HttpError(502,'invalid_honcho_descendants');
        if(!found.ids.length) {
          await this.call(base+'/sessions/'+id,undefined,'DELETE');
          await db.query("UPDATE memory_session_deletions SET state='done',completed_at=now() WHERE session_id=$1",[id]);return true;
        }
        for(const conclusion of found.ids)await this.call(base+'/conclusions/'+conclusion,undefined,'DELETE');
        await db.query('UPDATE memory_session_deletions SET deleted_conclusions=deleted_conclusions+$2 WHERE session_id=$1',[id,found.ids.length]);
      }
      return false;
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** One bounded page of the correction sweep after a guard epoch: only sessions holding invalid writes are rebuilt. */
  async sweep(after:string,binding:GuardBinding,limit=100):Promise<{after:string;done:boolean;rebuilt:number}> {
    const rows=(await this.control.query(`SELECT r.* FROM memory_ingestion_receipts r JOIN memory_generations g ON g.id=r.generation
      WHERE g.installation_generation=$1 AND g.representation_version=$2 AND g.state<>'retired' AND r.retired_at IS NULL AND r.id>$3
      ORDER BY r.id LIMIT $4`,[binding.generation,protocol,after,limit])).rows;
    const invalid=new Map<string,{workspace:string;key:string}>();
    for(const row of rows)if(!invalid.has(row.session_id)&&!await this.valid(row,binding))invalid.set(row.session_id,{workspace:row.generation,key:row.session_key});
    for(const item of invalid.values())await this.rebuild(item.workspace,item.key);
    await this.guards.assertCurrent(binding);
    return {after:rows.at(-1)?.id??after,done:rows.length<limit,rebuilt:invalid.size};
  }
  async observe(id:string):Promise<boolean> {
    const current=await this.current(id);
    const pending=(await this.control.query("SELECT 1 FROM memory_ingestion_receipts WHERE generation=$1 AND state<>'done' AND retired_at IS NULL LIMIT 1",[id])).rowCount;
    const queue=await this.call('/v3/workspaces/'+id+'/queue/status');
    const health=await this.call('/v3/workspaces/'+id+'/nocheh/queue-health');await this.current(id);
    if(typeof health.failed_items!=='boolean')throw new HttpError(502,'honcho_queue_health_invalid');
    const ready=!pending&&queue.pending_work_units===0&&queue.in_progress_work_units===0&&!health.failed_items;
    const changed=await this.control.query(`UPDATE memory_generations SET state=$2,
      error_code=CASE WHEN $4::boolean THEN 'honcho_derivation_failed' ELSE NULL END,
      last_ready_at=CASE WHEN $2='ready' THEN now() ELSE last_ready_at END
      WHERE id=$1 AND state<>'retired' AND work_revision=$3`,[id,ready?'ready':'building',current.row.work_revision,health.failed_items]);return ready&&changed.rowCount===1;
  }
  /** When Honcho finishes new work, prepare the next reply context of each changed conversation. No timer renews it. */
  async requestPrefetch(id:string):Promise<number> {
    await this.current(id);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const sessions=(await db.query(`SELECT session_id,work_revision FROM memory_sessions WHERE workspace=$1 AND kind='conversation'
        AND prefetched_revision<work_revision ORDER BY updated_at DESC LIMIT 100`,[id])).rows;
      for(const session of sessions)await requestWorkflow(db,'honcho','context:'+session.session_id,session.work_revision);
      await db.query('COMMIT');return sessions.length;
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Prefetch one conversation's guarded context for its latest speaker, so the next turn reads it without new detection. */
  async prefetch(sessionId:string):Promise<boolean> {
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE session_id=$1',[sessionId])).rows[0];
    if(!session||session.kind!=='conversation')return false;
    const current=await this.current(session.workspace);
    const latest=(await this.control.query(`SELECT source_reference FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL
      AND state='done' AND projection_reference IS NULL ORDER BY peer_id=$2,created_at DESC,id LIMIT 1`,[sessionId,assistantPeer])).rows[0];
    if(!latest)return false;
    await this.sessionContext(current,session.audience,latest.source_reference);
    await this.control.query('UPDATE memory_sessions SET prefetched_revision=GREATEST(prefetched_revision,$2) WHERE session_id=$1',[sessionId,session.work_revision]);
    return true;
  }
  async prepareRequest(input:unknown) {
    const body=object(input),current=await this.current(string(body.workspace,64)),payload=object(body.payload);
    if(!['/v1/chat/completions','/v1/embeddings'].includes(String(body.route)))throw new HttpError(400,'memory_route_denied');
    if(current.binding.mode==='on') {
      inspectRequest(payload);
      if(body.route==='/v1/embeddings'&&!(typeof payload.input==='string'||Array.isArray(payload.input)&&payload.input.every(v=>typeof v==='string')))
        throw new HttpError(409,'opaque_embedding_input');
      await this.allowWritten(current,payload);
    }
    const prepared=await this.prepared.prepare(current.principal,payload,this.detect);await this.current(current.row.id);return {payload:prepared};
  }
  /** Honcho's derivation requests quote messages Nocheh already guarded. Mark those exact
   * writes as prepared in the current epoch so an unrelated epoch does not re-detect them. */
  private async allowWritten(current:Current,payload:Record<string,unknown>) {
    const sources=new Set<string>();
    for(const match of JSON.stringify(payload).matchAll(/\[nocheh:event:([a-f0-9]{64})\]/g)){sources.add(match[1]!);if(sources.size>=64)break;}
    if(!sources.size)return;
    const rows=(await this.control.query(`SELECT prepared_id,content_hash FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL
      AND guard_mode=$2 AND source_reference->>'id'=ANY($3::text[]) LIMIT 256`,[current.row.id,current.binding.mode,[...sources]])).rows;
    const outputs=rows.length?(await this.derived.pool.query("SELECT id,content,content_hash FROM derived_artifacts WHERE id=ANY($1::text[]) AND kind='memory_input'",
      [[...new Set(rows.map(row=>row.prepared_id))]])).rows:[];
    const texts=outputs.filter(output=>digest(output.content)===output.content_hash&&rows.some(row=>row.prepared_id===output.id&&row.content_hash===output.content_hash))
      .map(output=>output.content.toString() as string);
    if(texts.length)await this.prepared.allow(current.principal,texts);
  }
  private async connectedPeers(current:Current,audience:string,principal:Reader,query='',turnSource?:string) {
    let connected=query.trim()?await this.contexts.entities.connected(principal,query,12):{entities:[],partial:false,ambiguities:[]};
    const clarification=principal.scope===null&&connected.ambiguities.length?
      `Please clarify which ${connected.ambiguities.map(item=>item.name).join(', ')} identity you mean.`:undefined;
    if(clarification)return {items:[],partial:connected.partial,clarification};
    if(!connected.entities.length) {
      let source=current.row.root_reference as SourceReference;
      if(principal.turnEvent)try{source=(await this.contexts.access.archive.captured(principal.turnEvent)).reference;}catch{}
      const local=await this.contexts.entities.context(source,[]),seeds=[local.speaker?.id,local.project?.id].filter((value):value is string=>!!value);
      connected={...await this.contexts.entities.connectedFrom(principal,seeds,12),ambiguities:[]};
    }
    const candidates=connected.entities.map(item=>({peer:honchoPeerId(item.entity),path:item.path.join(' → ')}));
    if(!candidates.length)return {items:[],partial:connected.partial,clarification:undefined};
    const available=new Set((await this.control.query(`SELECT DISTINCT peer.value AS peer_id FROM memory_ingestion_receipts r
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_array_length(r.peer_ids)>0 THEN r.peer_ids ELSE jsonb_build_array(r.peer_id) END) peer(value)
      WHERE r.generation=$1 AND r.state='done' AND r.retired_at IS NULL AND peer.value=ANY($2::text[])
      AND ($4::text='owner' OR r.audience=$4)
      AND ($3::text IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_array_length(r.source_references)>0 THEN r.source_references
          ELSE jsonb_build_array(r.source_reference) END) evidence(value)
        WHERE evidence.value->>'id'<>$3
      ))`,[current.row.id,candidates.map(item=>item.peer),turnSource??null,audience])).rows.map(row=>String(row.peer_id)));
    return {items:candidates.filter(item=>available.has(item.peer)),partial:connected.partial,clarification:undefined};
  }
  /** Read Honcho's context for the current conversation and its speaker, guarded once per distinct result.
   * Owner reads span the workspace; any other audience reads only its own session. */
  private async sessionContext(current:Current,audience:string,source:SourceReference) {
    const entities=await this.contexts.entities.context(source,[]),workspace=current.row.id;
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2 AND audience=$3',[workspace,entities.session_id,audience])).rows[0];
    const written=session?(await this.control.query(`SELECT count(*) FILTER (WHERE state='done')::int AS done,count(*) FILTER (WHERE state<>'done')::int AS pending
      FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL`,[session.session_id])).rows[0]:{done:0,pending:0};
    const speaker=entities.speaker?honchoPeerId(entities.speaker):null;
    const known=!!speaker&&!!(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL AND state='done'
      AND peer_ids ? $2 AND ($3::text IS NULL OR session_id=$3) LIMIT 1`,[workspace,speaker,audience==='owner'?null:session?.session_id??''])).rowCount;
    const base='/v3/workspaces/'+workspace,empty={text:'',session:session?.session_id??null,syncing:written.pending>0};
    let configuration:Record<string,unknown>,summary='',representation='',card:string[]=[];
    if(session&&written.done) {
      const query=new URLSearchParams({tokens:String(contextTokens),summary:'true'});
      if(known){query.set('peer_target',speaker!);if(audience!=='owner')query.set('limit_to_session','true');}
      configuration={workspace,audience,session:session.session_id,query:query.toString()};
      const result=await this.call(base+'/sessions/'+session.session_id+'/context?'+query);
      summary=typeof result?.summary?.content==='string'?result.summary.content:'';
      representation=typeof result?.peer_representation==='string'?result.peer_representation:'';
      card=Array.isArray(result?.peer_card)?result.peer_card.filter((line:unknown):line is string=>typeof line==='string'):[];
    } else if(audience==='owner'&&known) {
      configuration={workspace,audience,peer:speaker,include_most_frequent:true,max_conclusions:50};
      representation=string((await this.call(base+'/peers/'+speaker+'/representation',{include_most_frequent:true,max_conclusions:50})).representation,2*1024*1024);
    } else return empty;
    const text=string([summary.trim()?'[conversation summary]\n'+summary:'',representation.trim()?'[what is known about the speaker]\n'+representation:'',
      card.length?'[speaker card]\n'+card.map(line=>'- '+line).join('\n'):''].filter(Boolean).join('\n\n'),2*1024*1024);
    if(!text)return empty;
    // Identical Honcho output reuses its guarded copy, so a prefetched context needs no new detection on arrival.
    const key='native-context:'+digest(canonical([configuration,digest(text)]));
    const raw=await this.derived.record({operation_id:key,source:current.row.root_reference,kind:'memory_result',content:Buffer.from(text),
      producer:'honcho',producer_version:protocol,configuration,provenance:{limitations:['representation_has_no_exact_citations']}});
    const output=await this.derived.record({operation_id:key+':bounded',source:current.row.root_reference,parents:[raw],kind:'memory_context',
      content:Buffer.from(Array.from(text).slice(0,contextCharacters).join('')),producer:'nocheh',producer_version:protocol,
      configuration:{max_characters:contextCharacters,workspace,audience},provenance:{limitations:['representation_has_no_exact_citations']}});
    await this.guards.prepareContext(output,protocol,this.principal(audience,source.id,current.binding),this.prepared,this.detect);
    const value=(await this.guards.read('derived_artifacts:'+output.id,current.binding)).value as {text:string};
    return {...empty,text:String(value.text??'')};
  }
  /** Freshness is checked when a message arrives: the turn reads Honcho's current context for its own conversation. */
  async context(principal:Reader) {
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding);
    if(!workspace||!principal.turnEvent)return limited;
    try {
      const current=await this.current(workspace.id),audience=this.principalAudience(principal);
      const source=(await this.contexts.access.archive.captured(principal.turnEvent)).reference;
      const read=await this.sessionContext(current,audience,source);
      await this.current(workspace.id);await this.prepared.audience.assert(principal);
      const syncing=read.syncing||current.row.state==='building';
      if(!read.text)return {sources:[],limited_memory:false,syncing};
      await this.prepared.allow(principal,{text:read.text});
      return {sources:[{source:'nocheh:honcho:'+(read.session??workspace.id),kind:'memory_inference',text:read.text,exact_citations:false,
        limitations:['representation_has_no_exact_citations']}],limited_memory:false,syncing};
    } catch(error){await this.prepared.audience.assert(principal);return limited;}
  }
  private async relevantOwnerCorrections(principal:Reader,query:string,binding:GuardBinding) {
    const space=principal.space??principal.scope;
    if(!space)return [];
    const rows=(await this.contexts.access.stores.derived.query(`SELECT e.id,e.subject FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
      WHERE e.scope_kind='conversation' AND e.scope_id=$1 AND v.author='owner' AND NOT v.retired
      ORDER BY e.id LIMIT 101`,[space])).rows;
    if(rows.length>100)throw new HttpError(409,'owner_correction_limit');
    const normalized=(text:string)=>text.toLocaleLowerCase().replace(/\s+/g,' ').trim();
    const question=normalized(query),sources=[];
    for(const row of rows) {
      const subject=normalized(row.subject);
      if(!subject||!question.includes(subject))continue;
      try {
        const version=await this.contexts.learned.read(principal,row.id,binding,async reference=>
          this.contexts.access.canRead(principal,reference,binding));
        const text=`Active owner correction for ${version.subject} in this conversation (revision ${version.revision}): ${version.text}`;
        await this.prepared.allow(principal,text);
        sources.push({source:`nocheh:learned:${row.id}:${version.revision}`,kind:'owner_corrected_interpretation',text,exact_citations:false});
      } catch(error) {
        if(error instanceof HttpError&&error.code==='learned_memory_not_found')continue;
        throw error;
      }
    }
    await this.guards.assertCurrent(binding);
    return sources;
  }
  async recall(principal:Reader,query:string) {
    string(query,2000);
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding);if(!workspace)return limited;
    let corrections:Awaited<ReturnType<NativeMemoryRepository['relevantOwnerCorrections']>>=[];
    try {
      const current=await this.current(workspace.id),id=current.row.id,actor=principal.admin?current.principal:principal;
      const audience=principal.admin?'owner':this.principalAudience(principal);
      corrections=await this.relevantOwnerCorrections(principal,query,current.binding);
      const question=await this.prepared.prepare(actor,query,this.detect),requestId=randomUUID();
      const root=await this.prepared.root(actor,current.binding);
      const input=await this.derived.record({operation_id:'native-recall-input:'+requestId,source:root,kind:'runtime_context',content:Buffer.from(String(question)),
        producer:'nocheh',producer_version:protocol,configuration:{workspace:id,audience,reasoning_level:'low'},provenance:{binding:current.binding}});
      // The active question alone is not prior memory. Background context
      // still includes it, and receipts with independent supporting evidence qualify.
      const connected=await this.connectedPeers(current,audience,actor,String(question),principal.turnEvent),answers=[];
      const syncing=current.row.state==='building';
      if(connected.clarification)return {sources:corrections,limited_memory:false,syncing,clarification_required:true,note:connected.clarification};
      // Group and topic recall reads only that audience's own sessions; owner recall spans the workspace.
      const sessions=audience==='owner'?null:await this.provenance.sessions(id,audience);
      for(const item of sessions?.length===0?[]:connected.items.slice(0,4)) {
        await this.current(id);
        const response=await this.call('/v3/workspaces/'+id+'/peers/'+item.peer+'/chat',{query:question,reasoning_level:'low',stream:false,
          ...(sessions?{filters:{session_id:sessions}}:{})});
        answers.push(`[related through ${item.path}]\n${string(response.content,20000)}`);
      }
      if(!answers.length)return corrections.length?{sources:corrections,limited_memory:false,syncing}:
        {...limited,note:'No authorized person or project memory matched this request.'};
      const output=await this.derived.record({operation_id:'native-recall-output:'+requestId,source:root,parents:[input],kind:'memory_result',content:Buffer.from(string(answers.join('\n\n'),20000)),
        producer:'honcho',producer_version:protocol,configuration:{workspace:id,audience,reasoning_level:'low',peers:connected.items.slice(0,4)},provenance:{partial:connected.partial,limitations:['reasoning_response_has_no_exact_conclusion_citations']}});
      await this.current(id);await this.guards.prepareContext(output,protocol,actor,this.prepared,this.detect);
      const value=(await this.guards.read('derived_artifacts:'+output.id,current.binding)).value as {text:string};
      await this.current(id);await this.prepared.audience.assert(principal);await this.prepared.allow(principal,value);
      return {sources:[...corrections,{source:'nocheh:honcho:'+id,kind:'memory_inference',text:value.text,exact_citations:false,
        limitations:['reasoning_response_has_no_exact_conclusion_citations']}],partial:connected.partial,
        limited_memory:!current.row.last_ready_at&&current.row.state!=='ready',syncing};
    } catch(error){await this.prepared.audience.assert(principal);return corrections.length?{...limited,sources:corrections}:limited;}
  }
}
