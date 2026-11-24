import {randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {admin,boundReader,sharedReads,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {inspectRequest} from '../guard.js';
import {engineErrors,engineId,engineSummary,type EngineWrite,type MemoryEngine} from '../memory/engine.js';
import {archiveScopes,groupWithTopics,parentSpace,readSetIds,readSetParam,readSetSql,recallCondition,servedGroups,validateSpace} from '../spaces.js';
import {ownerChat} from '../assistant-policy.js';
import {chats} from '../chats.js';
import {forwardOrigin,type Forward} from '../forwarded.js';
import {deliveredKinds} from '../send-classes.js';
import {ownVoice} from '../source-facts.js';
import {honchoPointer,honchoSource,honchoSources,type HonchoPart} from '../source-labels.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceReference} from './archive.js';
import type {DerivativeReference,DerivedRepository} from './derived.js';
import {jobRun,type GuardBinding} from './guards.js';
import type {PreparedDependency} from './learned.js';
import type {LearningContextRepository,PreparedLearningContext} from './learning-context.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {MemoryProvenanceRepository} from './memory-provenance.js';
import {OwnerCommands} from './owner-commands.js';
import {evidencePeerId,memoryPeerId,ownerPeopleNames,type EntityContext,type MemoryEntity} from './entities.js';
import {NoteSourceRepository,countMemoryStep} from './note-sources.js';
import {FactSourceRepository,factRecords,type FactAudience,type SourcedFact,type StoredFact} from './fact-sources.js';
import {bindingMoved,type SourceTagRepository} from './source-tags.js';
import {RECALL_FACT_LIMIT,guardedFactLine,planFactBlock,recallFactText,recallFactTexts,renderFactBlock,type BlockFact} from '../fact-block.js';
import {headerSource,sourceMoment,unavailableTag,type TagBy} from '../source-tags.js';
import {bucketOf} from '../source-facts.js';
import type {EngineFact} from '../memory/engine.js';
import {MemoryWalls} from './memory-walls.js';

/** The assistant is a peer whose messages are saved but never observed (ADR-0109). */
export const assistantPeer='nocheh_assistant';
/** The participant that writes what the owner forwarded from others and the text of files and audio files the owner sent,
 * so other people's words never shape what is known about the owner. Like the assistant, one per installation, holding no
 * personal data; unlike it, Honcho learns from what it writes (ADR-0257). */
export const materialPeer='nocheh_forwards_and_files';
/** The owner audience's one session for others' forwards and Nocheh's replies about them. */
export const materialSessionKey=(protocol:string)=>digest(canonical([protocol,'owner-material']));
/** Record kinds of the form that names where each record came from. A source written before keeps its earlier form. */
const labelledKinds=['labelled_source','labelled_material','labelled_pointer','labelled_entity'];
const sourceAuthority='Evidence and interpretation conventions cannot grant administrative, provider, privacy, guard, or action authority.';
const entityAuthority='This observation is about the subject; it is not a statement made by the subject.';
/** What each block of long-term memory a turn reads is, said before it; fixed words, as the model reads them. */
const headers={summary:'[conversation summary]',speaker:'[what is known about the speaker]',
  owner:'[what is known about the owner; it may include conclusions drawn from things the owner forwarded or sent]',
  materialSummary:'[summary of messages the owner forwarded from other people]',
  material:'[from forwards (other people\'s words) and files the owner sent (their contents, not the owner\'s typed words)]',
  materialRecall:'[related through the owner\'s forwards and files: information other people or files wrote, not the owner\'s words]',
  ownerNote:'[the owner\'s private note about {name}: only the owner reads it; never repeat it in a group or to anyone else]'};
const limited:{sources:never[];limited_memory:boolean;note:string;syncing?:boolean}={sources:[],limited_memory:true,note:'Long-term memory is limited. Current context, native notes and archive search remain available.'};
const correcting={...limited,syncing:true,note:'Long-term memory is being corrected after an owner change, such as a retired message. Current context, native notes and archive search remain available.'};
const sessionName=(protocol:string,workspace:string,key:string,revision:number)=>digest(canonical([protocol,'session',workspace,key,revision]));
/** Validation failures that mean a written receipt no longer belongs in the memory engine. */
const invalidCodes=new Set(['learning_consent_required','memory_refresh_required','learned_memory_not_found']);
const contextTokens=4000,contextCharacters=20000,materialTokens=2000;
type SessionKind='conversation'|'entity_evidence'|'projection'|'material';
/** One record of a source in the form that names its source (ADR-0257): its text, which names it in `source`, who writes
 *  it (the message's own writer, the forwards-and-files participant or the assistant), the session it goes to, its record
 *  kind, and whether the people and projects the message names get evidence of it. */
type Part={text:string;writer:'speaker'|'material'|'assistant';session:'conversation'|'material';
  record:'labelled_source'|'labelled_material'|'labelled_pointer';subjects:boolean};
/** One record as written: its session key and kind, the entity it is about, its participants and writer. */
type Planned={text:string;key:string;kind:SessionKind;subject:string|null;peers:string[];writer:string;record:string};
const unique=<T>(value:T,index:number,all:T[])=>all.indexOf(value)===index;
const messageOf=(payload:any)=>payload?.message??payload?.edited_message??payload?.channel_post??payload?.edited_channel_post??null;
/** The name of the file a message carries, from its guarded copy, whose names the secret check has read. */
function fileName(payload:any):string|null {
  const message=messageOf(payload),files=Array.isArray(payload?.attachments)?payload.attachments:[];
  const name=message?.document?.file_name??message?.audio?.file_name??files.find((file:any)=>['file','image'].includes(file?.kind))?.name;
  return typeof name==='string'?name:null;
}
/** A prepared observation without the quote its reply carries, nor the quote inside a message it pinned. Only
 *  LearningContextRepository.prepare's observations come here, which hold no message a reply answers already. A quote
 *  inside a message it embeds is never left here: Telegram leaves the reply out of an embedded message but keeps its
 *  quote, which makes the message holding it someone else's words (SourceFacts.held), written whole as such, never the
 *  sender's own. */
function unquoted(value:unknown):unknown {
  const copy=structuredClone(value) as any;
  for(const kind of ['message','edited_message','channel_post','edited_channel_post'])if(copy?.payload?.[kind]) {
    delete copy.payload[kind].quote;
    const pinned=copy.payload[kind].pinned_message;
    if(pinned&&typeof pinned==='object')delete pinned.quote;
  }
  return copy;
}
/** The message whose words a message carries: the one it pinned, when it is a pin. */
const carried=(message:any)=>message?.pinned_message&&typeof message.pinned_message==='object'?message.pinned_message:message;
/** At most `size` UTF-16 units of `text`, never cutting a character in half. */
function fitted(text:string,size:number):string {
  if(text.length<=size)return text;
  const end=size>0&&/[\uD800-\uDBFF]/.test(text[size-1]!)?size-1:size;
  return text.slice(0,Math.max(0,end));
}
/** The installation's memory space; only a fresh start, an installation reset or another engine changes it. */
const workspaceId=(protocol:string,generation:string,revision:number)=>digest(canonical(revision===1?[protocol,generation]:[protocol,generation,revision]));
type Current=Awaited<ReturnType<NativeMemoryRepository['current']>>;
/** One block of long-term context a turn reads: its text, the session it came from, whether learning is still running, and
 *  for a block of facts its record, whether every fact shown is exact, and what it could not say. */
type ContextBlock={text:string;session:string|null;syncing:boolean;record?:string;exact?:boolean;limitations?:string[]};
/** Facts a block shows, as the engine's own context holds them (Honcho's WORKING_REPRESENTATION_MAX_OBSERVATIONS); a
 *  profile's, of which its most-derived half first, as Honcho's profile picks them. */
const factCount=100,profileFactCount=50,profileDerived=25;
/** Whose facts a block reads, within which sessions (null: the whole space), and whether as the engine's profile. */
type FactRead={subject:string;sessions:string[]|null;profile:boolean};
type FactList={facts:EngineFact[];limitations:string[]};
/** How many of a recall's facts its result lists (B3.6), how long each text is there, and how many of each one's sources
 *  it names; every fact stays in the facts record and opens by its number. */
const recallFactsListed=12,recallFactChars=240,recallFactSources=2;
/** What archive_read shows of an opened fact (B5.2): its sources named, and the facts a record lists without a number. */
const openedSources=10,openedListed=20,openedText=2000;
/** One fact as a recall result lists it (B3.6). */
type RecallFact={n:number;text?:string;exact:boolean;by:TagBy;sources:{source:string;tag:string;by:string}[];more:number};
const cutText=(text:string,size:number)=>{const chars=Array.from(text);return chars.length<=size?text:chars.slice(0,size-1).join('').trimEnd()+'…';};
const factUnavailable=()=>new HttpError(404,'memory_fact_unavailable');
/** One tagged source of a fact as a result lists it: for a fact whose line names only where and when (factPlaceOnly), its
 *  place words and no sender or `by` of its own, so the observed peer is never shown as saying what it may rest on. */
const sourceOf=(tag:{source:string;tag:string;by:string;place?:string},place:boolean|undefined)=>
  place&&tag.place!==undefined?{source:tag.source,tag:tag.place,by:'unknown'}:{source:tag.source,tag:tag.tag,by:tag.by};
/** A fact's readable sources with the one its source line names first (headerSource), the rest in their order. */
const shownFirst=(item:Pick<SourcedFact,'header'|'readable'>):SourceReference[]=>
  item.header?[item.header,...item.readable.filter(reference=>reference.id!==item.header!.id)]:[...item.readable];

/** How many messages of each learned batch a memory search hit names by source (ADR-0261): the first 3 references of each
 *  receipt; later ones keep today's fields alone. */
export const SEARCH_TAGGED_PER_BATCH=3;
/** The ids of a memory search to name by source: those among the first SEARCH_TAGGED_PER_BATCH of their batch. */
export const searchTagged=(found:{ids:readonly string[];from?:readonly {position:number}[]}):Set<string>=>
  new Set(found.ids.filter((_id,index)=>(found.from?.[index]?.position??SEARCH_TAGGED_PER_BATCH)<SEARCH_TAGGED_PER_BATCH));
/** The most sources an owner correction in recall names, tagged (B3.6). */
const CORRECTION_EVIDENCE=3;
/** Long-term memory behind the memory socket (ADR-0232). The engine, Honcho today, stores and learns; Nocheh owns guarded
 * inputs, immutable results, recoverable receipts, sharing rules, corrections and deletions.
 * One memory space serves the installation; sessions bound conversations; guard epochs never rebuild it. */
export class NativeMemoryRepository {
  constructor(readonly contexts:LearningContextRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly provenance:MemoryProvenanceRepository,readonly engine:MemoryEngine,readonly detect:(text:string,background?:boolean)=>Promise<unknown>,
    readonly sources=new NoteSourceRepository(contexts.access.stores,()=>contexts.access.policy(),contexts.access),
    readonly tags:SourceTagRepository|null=null){}
  /** The walls group reads go through (ADR-0286). */
  private wallStore:MemoryWalls|null=null;
  get walls(){return this.wallStore??=new MemoryWalls(this.control,this.engine);}
  /** Where recalled facts came from (ADR-0261). */
  get factSources(){return new FactSourceRepository(this.control,this.contexts.access,this.sources);}
  private get protocol(){return this.engine.protocol;}
  private get control(){return this.contexts.access.stores.control;}
  private get guards(){return this.contexts.guards;}
  /** The owner's private chat (ADR-0252), whose memory is the owner audience. */
  private get owner(){return ownerChat(this.contexts.access.policy());}
  private audienceOf(space:string){return space===this.owner?'owner':space;}
  private principalAudience(principal:Reader){return principal.scope===null?'owner':principal.space??principal.scope;}
  /** The group whose every conversation a scoped principal recalls when its topics share memory. */
  /** The ids of the reader's group and its topics when its topics share memory (groupWithTopics); null otherwise. */
  /** The conversations beside its own that a scoped reader's memory reads: every conversation of its project's groups
   * while that project shares its group chats (ADR-0267), else its group's when the group's topics share memory. */
  private recallGroup(principal:Reader){
    if(principal.admin)return null;
    const shared=sharedReads(principal);
    return shared?readSetIds(shared):groupWithTopics(this.contexts.access.recall(principal)?.group??null);
  }

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
      sessions,receipts,deletions,workspace_deletions:retired,guard:binding,engine:engineSummary(this.engine),native_notes:['MEMORY.md','USER.md'],syncing:workspace?.state==='building',
      limited_memory:!connection.attached||!workspace||!workspace.last_ready_at&&workspace.state!=='ready'};
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
      await db.query(`UPDATE memory_engine_connection SET attached=$1,include_history=$2,revision=revision+1,
        attached_at=CASE WHEN $1 AND NOT attached AND NOT $3 THEN now() ELSE coalesce(attached_at,now()) END WHERE singleton`,
        [body.attached,body.include_history,body.catch_up]);
      return {revision:row.revision+1};
    });return this.status();
  }
  /** Honcho memory is on by default: an installation with Honcho enabled attaches it once,
   * unless the owner has already attached or detached it. Earlier history is not ingested. */
  async attachByDefault() {
    const row=(await this.control.query('SELECT attached,revision FROM memory_engine_connection WHERE singleton')).rows[0];
    if(row.attached||row.revision!==0)return this.status();
    try {
      await new OwnerCommands(this.control).run({admin:true,scope:null},'memory-default-attach:'+randomUUID(),{attached:true},async db=>{
        const current=(await db.query('SELECT attached,revision FROM memory_engine_connection WHERE singleton FOR UPDATE')).rows[0];
        // Another writer got there first; roll back so nothing else changes.
        if(current.attached||current.revision!==0)throw new HttpError(409,'memory_connection_conflict');
        await db.query(`UPDATE memory_engine_connection SET attached=true,include_history=false,revision=revision+1,
          attached_at=coalesce(attached_at,now()) WHERE singleton`);
        return {revision:1};
      });
    } catch(error) {if(!(error instanceof HttpError&&error.code==='memory_connection_conflict'))throw error;}
    return this.status();
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
      AND representation_version=$2 AND state<>'retired'`,[binding.generation,this.protocol])).rows[0] as any;
  }
  /** The memory space Nocheh reads now and the binding it was read under, for the owner's dashboard; null when there
   *  is none, or only one a fresh start left behind (current() refuses it). */
  async dashboardSpace():Promise<{id:string;binding:GuardBinding}|null> {
    const row=await this.workspace(await this.guards.state());
    if(!row)return null;
    try{const current=await this.current(row.id);return {id:current.row.id,binding:current.binding};}
    catch(error){if(error instanceof HttpError&&error.code==='memory_context_retired')return null;throw error;}
  }
  /** The installation workspace stays current across guard epochs; only an installation reset replaces it. */
  async current(id:string) {
    const binding=await this.guards.state(),row=(await this.control.query('SELECT * FROM memory_generations WHERE id=$1',[id])).rows[0];
    const revision=(await this.control.query('SELECT workspace_revision FROM memory_engine_connection WHERE singleton')).rows[0].workspace_revision;
    // A fresh start opens the next workspace revision; nothing writes to or reads from an earlier one again.
    if(!row?.root_reference||row.audience!=='installation'||row.representation_version!==this.protocol||id!==workspaceId(this.protocol,binding.generation,revision))
      throw new HttpError(409,'memory_context_retired');
    await this.provenance.current(id,'owner',binding);
    return {row,binding,principal:this.principal('owner',row.root_reference.id,binding)};
  }
  private async ensureWorkspace(source:SourceReference,binding:GuardBinding) {
    const revision=(await this.control.query('SELECT workspace_revision FROM memory_engine_connection WHERE singleton')).rows[0].workspace_revision;
    const id=workspaceId(this.protocol,binding.generation,revision);
    // Per-audience, per-epoch workspaces of earlier mappings, or of another engine, are superseded and never written again.
    await this.control.query(`UPDATE memory_generations SET state='retired' WHERE installation_generation=$1
      AND representation_version<>$2 AND state<>'retired'`,[binding.generation,this.protocol]);
    await this.control.query(`INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience,root_reference,root_space,representation_version)
      VALUES($1,$2,$3,'installation',$4,$5,$6) ON CONFLICT DO NOTHING`,[id,binding.generation,binding.epoch,source,this.owner,this.protocol]);
    await this.current(id);return id;
  }
  private async session(workspace:string,key:string,audience:string,kind:SessionKind) {
    await this.control.query(`INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [workspace,key,audience,kind,sessionName(this.protocol,workspace,key,1)]);
    const row=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2',[workspace,key])).rows[0];
    // Owner-private evidence never enters a session another audience may read.
    if(row.audience!==audience||row.kind!==kind)throw new HttpError(409,'memory_session_conflict');
    return row as {session_id:string;revision:number;audience:string};
  }
  private async queueDocument(source:SourceReference,evidence:SourceReference[],space:string,text:string,dependencies:PreparedDependency[],binding:GuardBinding,
    entities:EntityContext,options:{projection?:{id:string;revision:number};assistant?:boolean;supersedes?:string[];parts?:Part[]}={}):Promise<{audience:string;workspace:string;receipts:string[]}[]> {
    if(evidence.length<1||evidence.length>30||[text,...(options.parts??[]).map(part=>part.text)].some(value=>value.length>600000))throw new HttpError(413,'memory_input_limit');
    const {projection,assistant=false,supersedes=[],parts}=options,audience=this.audienceOf(space);
    const workspace=await this.ensureWorkspace(source,binding),generation=await this.current(workspace);
    // Engine egress is prepared as the space owner; reply context is prepared for the audience.
    const writers=[this.principal(audience,source.id,binding),...(audience==='owner'?[]:[generation.principal])];
    const speaker=assistant?null:entities.speaker;
    const peer=assistant?assistantPeer:!projection&&speaker?memoryPeerId(speaker):evidencePeerId(source);
    const subjects=[entities.project,...entities.mentioned_projects,...entities.mentioned_people].filter((value,index,all)=>
      !!value&&value.id!==speaker?.id&&all.findIndex(other=>other?.id===value.id)===index);
    const allPeers=[peer,...subjects.map(value=>memoryPeerId(value!))].filter((value,index,all)=>all.indexOf(value)===index);
    const conversation=entities.session_id;
    const protocol=this.protocol;
    // In the earlier form, and for interpretations, one writer writes every record of the source.
    const records:Planned[]=parts?this.labelledRecords(parts,{reference:source,peer,speaker,subjects:subjects as MemoryEntity[],conversation,audience}):[{text,key:projection?digest(canonical([protocol,'projection',conversation,projection.id])):conversation,
      kind:(projection?'projection':'conversation') as SessionKind,subject:projection?null:speaker?.id??null,peers:allPeers,writer:peer,
      record:projection?'learned_interpretation':'source_evidence'},
      ...subjects.map(subject=>({text:canonical({kind:'entity_evidence',subject:{id:subject!.id,kind:subject!.kind,name:subject!.name},
        original_speaker:speaker?{id:speaker.id,name:speaker.name}:null,source,attribution:projection||!speaker?'inferred':'reported',observation:JSON.parse(text),
        authority:entityAuthority}),
        // An interpretation's subject evidence has its own session, so correcting it never rebuilds source evidence.
        key:digest(canonical([protocol,'entity-evidence',conversation,subject!.id,...(projection?[projection.id]:[])])),kind:'entity_evidence' as SessionKind,subject:subject!.id as string|null,
        peers:[peer,memoryPeerId(subject!)],writer:peer,record:'entity_evidence'}))];
    // Logical identities do not depend on a session's revision, so a rebuild can carry valid writes forward.
    const planned=records.flatMap(record=>{
      const chars=Array.from(record.text),chunks=[];
      for(let offset=0;offset<chars.length;offset+=12000) {
        const content=`[nocheh:event:${source.id}]\n`+chars.slice(offset,offset+12000).join(''),hash=digest(content);
        chunks.push({record,offset,content,logical:digest(canonical([workspace,record.key,record.writer,record.subject,evidence,dependencies,projection??null,binding.mode,offset,hash]))});
      }
      return chunks;
    });
    const logical=new Set(planned.map(item=>item.logical));
    const stale=(await this.control.query(`SELECT id,session_key,logical_id FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL
      AND source_reference->>'id'=ANY($2::text[]) AND CASE WHEN $3::text IS NULL THEN projection_reference IS NULL ELSE projection_reference->>'id'=$3 END`,
      [workspace,[source.id,...supersedes],projection?.id??null])).rows.filter(row=>!logical.has(row.logical_id));
    // Changed evidence, or an earlier revision of an edited message, replaces only the sessions that held it.
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
            item.record.writer,JSON.stringify(item.record.peers),session.session_id,item.record.subject,speaker?.id??null,item.record.record]);
        if(added.rowCount)await this.changed(db,workspace,item.record.key);
        await requestWorkflow(db,'honcho','receipt:'+id);
        await db.query('COMMIT');
      } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      receipts.push(id);
    }
    await this.guards.assertCurrent(binding);
    // One entry for the audience with every part's writes, so learning waits for all of them.
    return [{audience,workspace,receipts}];
  }
  /**
   * The records of a source in the form that names its source: each part with its own writer and session, and evidence
   * of it for the people and projects the message names. Evidence of what is kept apart (the forwards-and-files
   * participant's, or the owner's forwards session) has sessions of its own, so it never sits beside the owner's own words
   * about the same person or project, and it names no speaker: it is reported, not said. Its observation names its source.
   */
  private labelledRecords(parts:Part[],plan:{reference:SourceReference;peer:string;speaker:MemoryEntity|null;subjects:MemoryEntity[];conversation:string;audience:string}):Planned[] {
    const protocol=this.protocol,forwards=materialSessionKey(protocol);
    return parts.flatMap(part=>{
      const writer=part.writer==='material'?materialPeer:part.writer==='assistant'?assistantPeer:plan.peer,material=part.writer==='material';
      // Only the owner audience has a session of forwards; in a group, what is kept apart stays in the group's own session.
      const kept=part.session==='material'&&plan.audience==='owner',key=kept?forwards:plan.conversation,apart=material||kept;
      const main:Planned={text:part.text,key,kind:kept?'material':'conversation',subject:part.writer==='speaker'?plan.speaker?.id??null:null,
        peers:[writer,...(part.subjects?plan.subjects.map(memoryPeerId):[])].filter(unique),writer,record:part.record};
      if(!part.subjects)return [main];
      return [main,...plan.subjects.map(subject=>({text:canonical({kind:'entity_evidence',subject:{id:subject.id,kind:subject.kind,name:subject.name},
        original_speaker:material||!plan.speaker?null:{id:plan.speaker.id,name:plan.speaker.name},source:plan.reference,
        attribution:material||plan.speaker?'reported':'inferred',observation:JSON.parse(part.text),authority:entityAuthority}),
        key:digest(canonical(apart?[protocol,'entity-evidence-material',key,subject.id]:[protocol,'entity-evidence',plan.conversation,subject.id])),
        kind:'entity_evidence' as SessionKind,subject:subject.id as string|null,peers:[writer,memoryPeerId(subject)],writer,record:'labelled_entity'}))];
    });
  }
  /** New work in a session marks the space as building until the engine finishes it. */
  private async changed(db:pg.PoolClient,workspace:string,key:string) {
    await db.query('UPDATE memory_sessions SET work_revision=work_revision+1,updated_at=now() WHERE workspace=$1 AND key=$2',[workspace,key]);
    await this.building(db,workspace);
  }
  private async building(db:pg.PoolClient,workspace:string) {
    const changed=(await db.query("UPDATE memory_generations SET state='building',work_revision=work_revision+1 WHERE id=$1 AND state<>'retired' RETURNING work_revision",[workspace])).rows[0];
    if(!changed)throw new HttpError(409,'memory_context_retired');
    await requestWorkflow(db,'honcho','generation:'+workspace,changed.work_revision);
  }
  async queueSource(source:SourceReference) {
    const connection=(await this.control.query('SELECT * FROM memory_engine_connection WHERE singleton')).rows[0];
    if(!connection.attached)return [];
    const binding=await this.guards.state();
    const row=(await this.contexts.access.stores.archive.query('SELECT received_at,kind,payload FROM events WHERE id=$1',[source.id])).rows[0];
    if(!row)throw new HttpError(404,'source_not_found');
    // An engine write cannot change, so an edit replaces the earlier revision's writes and only the latest text is written.
    const revisions=await this.revisions(source.id);
    if(revisions.length&&revisions.at(-1)!==source.id)return [];
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
    const text=canonical({kind:'source_evidence',space:context.space,observations,authority:sourceAuthority});
    const options={assistant:deliveredKinds.has(row.kind),supersedes:revisions.filter(id=>id!==source.id)};
    // A source Honcho already holds in the earlier form is written exactly as then, so its writes keep their identities and
    // no session is rebuilt, whether a job ran across the change or a correction asked for it again. Only a source learned
    // from now on, an edit included, names where each part came from.
    if(await this.earlierForm(source.id))return this.queueDocument(source,[source],context.space,text,dependencies,binding,context.entities,options);
    return this.queueDocument(source,[source],context.space,text,dependencies,binding,context.entities,
      {...options,parts:await this.parts(source,row,context.space,observations)});
  }
  /** Whether this workspace ever wrote a source, a write a rebuild retired included, and none of it in the form that names
   *  its source. A fresh start's new workspace has none, so it applies today's form. */
  private async earlierForm(id:string):Promise<boolean> {
    const found=(await this.control.query(`SELECT count(*)::int AS count,count(*) FILTER (WHERE r.record_kind=ANY($3::text[]))::int AS labelled
      FROM memory_ingestion_receipts r JOIN memory_generations g ON g.id=r.generation WHERE r.source_reference->>'id'=$1
      AND r.projection_reference IS NULL AND g.state<>'retired' AND g.representation_version=$2`,[id,this.protocol,labelledKinds])).rows[0];
    return found.count>0&&found.labelled===0;
  }
  /** The kind of artifact each derivative was read from, by derivative id. One not found is not the sender's own voice. */
  private async artifactKinds(ids:string[]):Promise<Map<string,string>> {
    if(!ids.length)return new Map();
    const derived=(await this.contexts.access.stores.derived.query('SELECT id,artifact_id FROM derived_artifacts WHERE id=ANY($1::text[])',[ids])).rows;
    const artifacts=[...new Set(derived.map(row=>row.artifact_id).filter((id):id is string=>typeof id==='string'))];
    const kinds=new Map<string,string>(artifacts.length?(await this.contexts.access.stores.archive.query('SELECT id,kind FROM artifacts WHERE id=ANY($1::text[])',
      [artifacts])).rows.map(row=>[String(row.id),String(row.kind)]):[]);
    return new Map(derived.map(row=>[String(row.id),kinds.get(row.artifact_id)??'']));
  }
  /**
   * How a source is written when each record names its source, from what code reads of the original, never what it says
   * (ADR-0257). Someone else's forward the owner sent, an inline bot's message included, is kept whole on the
   * forwards-and-files participant: in the owner's private chat in the session of forwards, with a note left in the chat
   * that something was forwarded, and in a group in that group's session. The owner's own message keeps the owner's typed
   * words and voice on the owner's participant; the text of a file or audio file, and someone else's quote, go beside it
   * in the same session on the forwards-and-files participant, so a caption still links to its file. Someone else's
   * message the owner pinned is kept as such a forward is, and so is the owner's message holding words that may be someone
   * else's (a checklist or poll others may have added to, a message Telegram shows inside it, or one quoting a message),
   * whose words say it is not a pin, and the owner's pin of such a message of their own, whose words say no one else wrote
   * it. A quote of Nocheh's own message, by anyone, is the sender's
   * words without it, and is written nowhere else: a learned one is already learned as Nocheh's, and a card, notice or
   * reminder is not learned at all. A pin of Nocheh's own message, by anyone, an anonymous admin included, leaves only a
   * note in that chat that it was pinned, for the same reason. So does a quote or pin of Nocheh's own account's message the
   * archive does not hold as Nocheh's (not archived yet, or a forward of one), told by the bot the message came to
   * (NoteSourceRepository.carried). Another bot's message, and one sent through an inline bot, is someone else's: the
   * owner's pin of it is kept as a forward is, and a quote of it as anyone else's quote. Everyone else's message stays on
   * its writer, and Nocheh's on the assistant, each naming what it is; Nocheh's reply about someone else's forward goes
   * with that forward.
   */
  private async parts(source:SourceReference,row:{payload:Buffer},space:string,observations:PreparedLearningContext['observations']):Promise<Part[]> {
    const found=(await this.sources.classesFor([source.id])).get(source.id);
    if(!found)throw new HttpError(404,'source_not_found');
    // Someone the owner named in People is called by that name in every record of theirs (ADR-0274); the message's own
    // Telegram name stays in its payload.
    const {facts}=found,called=facts.author==='person'?(await ownerPeopleNames(this.contexts.access.stores,[source.id])).get(source.id):undefined;
    const audience=this.audienceOf(space),document=(items:typeof observations,named:string)=>
      canonical({kind:'source_evidence',space,source:named,...(called?{sender_name:called}:{}),observations:items,authority:sourceAuthority});
    if(facts.author==='nocheh') {
      const about=found.class==='nocheh_about_forward';
      return [{text:document(observations,honchoSource({part:'nocheh',send_class:facts.send_class,about_forward:about})),writer:'assistant',
        session:about?'material':'conversation',record:'labelled_source',subjects:true}];
    }
    const guarded=(observations[0]?.value as any)?.payload;
    // Checked before any class, so an anonymous admin's pin, a post in the chat's name, is read the same way.
    const cut=facts.pinned!==null||facts.quote!==null?(await this.sources.carried([source.id])).get(source.id):undefined;
    const by=facts.author==='owner'?'':'_other' as const;
    if(found.class==='pinned_nocheh'||facts.pinned!==null&&cut?.pinned)
      return [{text:canonical(honchoPointer(`pinned_nocheh${by}`)),writer:'assistant',session:'conversation',record:'labelled_pointer',subjects:false}];
    if(facts.forward!==null&&facts.forward!=='own'||facts.pinned==='other') {
      let original:unknown=null;try{original=JSON.parse(row.payload.toString());}catch{}
      // The kind comes from the original and the name from the guarded copy, which the secret check has read; a pin's
      // forward is read from the message it pinned.
      const from=facts.forward!==null&&facts.forward!=='own'?facts.forward:null,pin=facts.pinned!==null?carried:(message:any)=>message;
      const shown=from?forwardOrigin(pin(messageOf(original)),pin(messageOf(guarded))):null,forward:Forward|null=from?shown?.from===from?shown:{from,name:null}:null;
      // A message that holds someone else's words itself (SourceFacts.held: a checklist or poll others may have added to,
      // a message Telegram shows inside it) is not a pin, and its fixed words say so; a pin of the sender's own such
      // message (pinned_held) never says someone else wrote it.
      const kind=facts.held?'held' as const:facts.pinned_held?'pinned_held' as const:'pinned' as const;
      const text=document(observations,honchoSource(forward?{part:'forward',forward}:{part:kind}));
      if(facts.author!=='owner')return [{text,writer:'speaker',session:'conversation',record:'labelled_source',subjects:true}];
      return [{text,writer:'material',session:'material',record:'labelled_material',subjects:true},
        ...(audience==='owner'?[{text:canonical(honchoPointer(from??kind)),writer:'assistant' as const,session:'conversation' as const,record:'labelled_pointer' as const,subjects:false}]:[])];
    }
    const kinds=await this.artifactKinds(observations.flatMap(item=>item.derivatives.map(derivative=>derivative.id)));
    const voice=(derivative:{kind:string;id:string})=>derivative.kind==='transcript'&&ownVoice.has(kinds.get(derivative.id)??'');
    const derivatives=observations.flatMap(item=>item.derivatives),recorded=derivatives.some(voice);
    const said=observations.some(item=>String((item.value as any)?.text??'').trim());
    // A quote of Nocheh's own words, learned or not, is left out of the sender's words, and written nowhere else; so is one
    // inside a message the sender pinned.
    const nocheh=found.class==='quote_nocheh'||facts.quote==='other'&&!!(cut?.quote||cut?.pinned_quote);
    const others=facts.quote==='other'&&!nocheh;
    const kept:HonchoPart[]=[...(derivatives.some(item=>item.kind==='extracted_text')?[{part:'file' as const,name:fileName(guarded)}]:[]),
      ...(derivatives.some(item=>item.kind==='transcript'&&!voice(item))?[{part:'audio' as const}]:[]),...(others?[{part:'quote' as const}]:[])];
    const own:HonchoPart[]=[...(said||!recorded&&!kept.length?[{part:'own' as const}]:[]),...(recorded?[{part:'recording' as const}]:[])];
    if(facts.author!=='owner'||!kept.length)return [{text:document(nocheh?observations.map(item=>({...item,value:unquoted(item.value)})):observations,
      honchoSources([...own,...kept])),writer:'speaker',session:'conversation',record:'labelled_source',subjects:true}];
    // A file sent without a caption leaves nothing of the owner's own to write.
    return [...(own.length?[{text:document(observations.map(item=>({...item,value:facts.quote==='other'?unquoted(item.value):item.value,derivatives:item.derivatives.filter(voice)})),
      honchoSources(own)),writer:'speaker' as const,session:'conversation' as const,record:'labelled_source' as const,subjects:true}]:[]),
      {text:document(observations.map(item=>({...item,derivatives:item.derivatives.filter(derivative=>!voice(derivative))})),honchoSources(kept)),
        writer:'material',session:'conversation',record:'labelled_material',subjects:true}];
  }
  private async revisions(eventId:string):Promise<string[]> {
    return await this.contexts.access.retirements?.revisions(eventId)??[];
  }
  async queueProjection(id:string) {
    const binding=await this.guards.state(),row=(await this.contexts.access.stores.derived.query(`SELECT v.evidence,v.dependencies,v.retired FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision WHERE e.id=$1`,[id])).rows[0];
    if(!row||row.retired) {
      // A retracted interpretation leaves the engine together with the sessions that held it.
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
      AND g.representation_version=$2 LIMIT 1`,[sourceId,this.protocol])).rowCount;
  }
  /** A source's writes are complete and the engine has no unfinished work for their sessions. */
  async settled(receipts:string[]):Promise<boolean> {
    const rows=(await this.control.query('SELECT generation,session_id,state,retired_at FROM memory_ingestion_receipts WHERE id=ANY($1::text[])',[receipts])).rows;
    if(rows.length!==receipts.length||rows.some(row=>row.retired_at||row.state!=='done'))return false;
    for(const key of new Set(rows.map(row=>row.generation+'/'+row.session_id))) {
      const [workspace,session]=key.split('/');await this.current(workspace!);
      if(await this.engine.busy(workspace!,session))return false;
    }
    return true;
  }
  private async receipt(id:string) {
    const row=(await this.control.query('SELECT * FROM memory_ingestion_receipts WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'memory_receipt_missing');
    const output=(await this.derived.pool.query("SELECT content,content_hash FROM derived_artifacts WHERE id=$1 AND kind='memory_input'",[row.prepared_id])).rows[0];
    if(!output||output.content_hash!==row.content_hash||digest(output.content)!==row.content_hash)throw new HttpError(409,'memory_input_conflict');
    return {...row,content:output.content.toString() as string};
  }
  /** Throws when a written receipt no longer belongs in the memory engine. A later reaction change adds evidence; it does not retract earlier evidence. */
  private async validate(row:any,binding:GuardBinding):Promise<void> {
    if(row.guard_mode&&row.guard_mode!==binding.mode)throw new HttpError(409,'memory_refresh_required');
    const principal=this.principal(row.audience,row.source_reference.id,binding),historical={historical:true};
    for(const reference of row.source_references.length?row.source_references:[row.source_reference])
      if(!await this.contexts.access.canLearn(reference,binding,historical)||
        !await this.contexts.access.canRead(principal,reference,binding,historical))throw new HttpError(403,'learning_consent_required');
    const space=await this.contexts.access.space(row.source_reference);
    if(!space||this.audienceOf(space)!==row.audience)throw new HttpError(409,'memory_refresh_required');
    if(!row.projection_reference) {
      const revisions=await this.revisions(row.source_reference.id);
      if(revisions.length&&revisions.at(-1)!==row.source_reference.id)throw new HttpError(409,'memory_refresh_required');
    }
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
  /** When a record's words were written. An engine otherwise dates a write by when it was made, so a retried, imported
   * or re-learned record would read as new, and the engine would resolve "Thursday" or "today" in it against that day
   * (ADR-0280). A message is dated by its event. An interpretation is dated by the message that set off its learning,
   * else by its latest evidence; an owner's correction by when the owner wrote it. */
  private async occurredAt(row:{source_reference:SourceReference;source_references?:SourceReference[]|null;
    projection_reference:{id:string;revision:number}|null}):Promise<string|undefined> {
    if(!row.projection_reference)return this.latestEvent([row.source_reference.id]);
    const version=(await this.contexts.access.stores.derived.query(`SELECT v.author,v.created_at,r.event_id AS trigger FROM learned_versions v
      JOIN derived_artifacts d ON d.id=v.derived_id LEFT JOIN derived_artifacts r ON r.id=d.provenance->'native'->>'result_id'
      WHERE v.entry_id=$1 AND v.revision=$2`,[row.projection_reference.id,row.projection_reference.revision])).rows[0];
    if(version?.author==='owner'&&version.created_at instanceof Date)return version.created_at.toISOString();
    if(typeof version?.trigger==='string') {
      const trigger=await this.latestEvent([version.trigger]);if(trigger)return trigger;
    }
    const evidence=Array.isArray(row.source_references)&&row.source_references.length?row.source_references:[row.source_reference];
    return this.latestEvent(evidence.map(source=>source.id));
  }
  /** The latest of these events' times, each as the archive orders it (sourceMoment): Telegram's own time, else when
   * Nocheh saved it. */
  private async latestEvent(ids:string[]):Promise<string|undefined> {
    const rows=(await this.contexts.access.stores.archive.query('SELECT kind,occurred_at,received_at FROM events WHERE id=ANY($1::text[])',[ids])).rows;
    const times=rows.map(row=>sourceMoment(row).at).filter((at):at is string=>at!==null).map(at=>Date.parse(at)).filter(Number.isFinite);
    return times.length?new Date(Math.max(...times)).toISOString():undefined;
  }
  private observed(row:any,found:EngineWrite[]):string|null {
    if(found.length>1)throw new HttpError(409,'memory_receipt_conflict');
    if(!found.length)return null;
    if(!engineId(found[0]!.id)||found[0]!.content!==row.content||found[0]!.receipt!==row.id)
      throw new HttpError(409,'memory_receipt_conflict');
    return found[0]!.id;
  }
  async reconcileReceipt(id:string):Promise<boolean> {
    const connection=(await this.control.query('SELECT attached FROM memory_engine_connection WHERE singleton')).rows[0];
    if(!connection.attached)return false;
    const row=await this.receipt(id);if(row.state==='done')return true;if(row.state!=='uncertain')return false;
    // Reconciliation reads only its exact receipt and never writes, even for a replaced session.
    let found:EngineWrite[];
    try{found=await this.engine.findWrites(row.generation,row.session_id??id,id);}
    catch(error) {
      // A retired write's session can already be deleted, and the write with it.
      if(row.retired_at&&error instanceof HttpError&&error.code===engineErrors.rejected) {
        await this.control.query("UPDATE memory_ingestion_receipts SET state='failed',error_code='memory_session_deleted' WHERE id=$1 AND state='uncertain'",[id]);return false;
      }
      throw error;
    }
    const remote=this.observed(row,found);
    if(!remote) {
      // Long after the write ended it is still absent, so it never landed. The next attempt lists before
      // writing again, so a late landing cannot be written twice.
      await this.control.query("UPDATE memory_ingestion_receipts SET uncertain_at=now() WHERE id=$1 AND uncertain_at IS NULL",[id]);
      await this.control.query(`UPDATE memory_ingestion_receipts SET state='pending',error_code='memory_write_absent',next_attempt=now()
        WHERE id=$1 AND state='uncertain' AND retired_at IS NULL AND uncertain_at<now()-interval '10 minutes'`,[id]);
      return false;
    }
    await this.control.query("UPDATE memory_ingestion_receipts SET state='done',remote_id=$2,error_code=NULL WHERE id=$1 AND state='uncertain'",[id,remote]);return true;
  }
  async syncReceipt(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'memory_sync_busy');
      const row=await this.receipt(id);if(row.state==='done')return true;
      if(row.state==='uncertain')return await this.reconcileReceipt(id);
      let rejected=false;
      try {
        const space=row.generation as string,session=(row.session_id??id) as string;
        await this.authorizedReceipt(row);await this.engine.openSpace(space);
        const peers=(Array.isArray(row.peer_ids)&&row.peer_ids.length?row.peer_ids:[row.peer_id]).filter((value:unknown)=>typeof value==='string') as string[];
        const role=(peer:string)=>peer===assistantPeer?'silent' as const:peer===row.peer_id?'writer' as const:'subject' as const;
        for(const peer of peers){await this.authorizedReceipt(row);await this.engine.addParticipant(space,peer,role(peer));}
        // A session joins the walls of its chat before its first write, so what it learns reaches them as it is learned (ADR-0286).
        const walls=await this.walls.of(space,row.audience);
        await this.authorizedReceipt(row);await this.engine.openSession(space,session,Object.fromEntries(peers.map(peer=>[peer,role(peer)])),walls);
        let remote=this.observed(row,await this.engine.findWrites(space,session,id));
        if(!remote) {
          const createdAt=await this.occurredAt(row);
          await this.authorizedReceipt(row);
          await db.query("UPDATE memory_ingestion_receipts SET state='uncertain',uncertain_at=now(),attempts=attempts+1 WHERE id=$1",[id]);
          let found:EngineWrite[];
          try {
            found=await this.engine.write(space,session,{author:row.peer_id,content:row.content,occurredAt:createdAt,receipt:id,
              sourceRevision:row.source_reference.revision,guardedRevision:row.guarded_revision});
          } catch(error) {
            // The engine answered with an error, so nothing was written; the next attempt lists before writing.
            if(error instanceof HttpError&&error.code===engineErrors.rejected)rejected=true;
            throw error;
          }
          remote=this.observed(row,found);if(!remote)throw new HttpError(409,'memory_write_unresolved');
        }
        await db.query("UPDATE memory_ingestion_receipts SET state='done',remote_id=$2,error_code=NULL WHERE id=$1",[id,remote]);return true;
      } catch(error) {
        await db.query(`UPDATE memory_ingestion_receipts SET error_code=$2,next_attempt=now()+interval '60 seconds',
          state=CASE WHEN $3::boolean AND state='uncertain' THEN 'pending' ELSE state END WHERE id=$1`,
          [id,error instanceof HttpError?error.code:engineErrors.unavailable,rejected]);throw error;
      }
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** Replace one session: retire its writes, carry the valid ones into a new revision,
   * delete the old engine session with the facts derived from it, and re-ingest changed sources. */
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
      const revision=locked.revision+1,next=sessionName(this.protocol,workspace,key,revision);
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
   * Fresh start: the installation moves to a new, empty memory space that learns from messages received from now on,
   * or, from the archive, from every saved message again. Every earlier Nocheh space in the engine is deleted with its
   * Nocheh records. Original messages stay in the archive.
   */
  async freshStart(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(k=>!['expected_revision','operation_id','from_archive'].includes(k))||!Number.isSafeInteger(body.expected_revision)||
      body.from_archive!==undefined&&typeof body.from_archive!=='boolean')
      throw new HttpError(400,'invalid_memory_fresh_start');
    // From the archive, the new workspace learns every saved message the owner allows again: the refresh this command
    // requests pages the archive, and a retired or withdrawn message is refused as it is for any new write.
    const history=body.from_archive===true;
    // Only spaces Nocheh recorded as its own memory generations are deleted; anything else in the engine is left alone.
    await new OwnerCommands(this.control).run(principal,string(body.operation_id,200),body,async db=>{
      const row=(await db.query('SELECT * FROM memory_engine_connection WHERE singleton FOR UPDATE')).rows[0];
      if(row.revision!==body.expected_revision)throw new HttpError(409,'memory_connection_conflict');
      await db.query(`UPDATE memory_engine_connection SET workspace_revision=workspace_revision+1,attached_at=now(),include_history=$1,
        revision=revision+1 WHERE singleton`,[history]);
      await db.query("UPDATE memory_generations SET state='retired' WHERE state<>'retired'");
      for(const {id} of (await db.query('SELECT id FROM memory_generations')).rows) {
        await db.query('INSERT INTO memory_workspace_deletions(workspace) VALUES($1) ON CONFLICT DO NOTHING',[id]);
        await requestWorkflow(db,'honcho','retire:'+id);
      }
      return {revision:row.revision+1};
    });
    return this.status();
  }
  private async attachedWorkspace() {
    const connection=(await this.control.query('SELECT attached FROM memory_engine_connection WHERE singleton')).rows[0];
    if(!connection.attached)throw new HttpError(409,'memory_detached');
    const workspace=await this.workspace(await this.guards.state());if(!workspace)throw new HttpError(409,'memory_workspace_missing');
    await this.current(workspace.id);return workspace.id as string;
  }
  /** Chosen chats as memory audiences: the owner's private chat is the owner audience, and a chat includes the topics
   * it has rows for (ADR-0252). */
  private chosen(spaces:unknown):string[]|null {
    if(spaces===null||spaces===undefined)return null;
    if(!Array.isArray(spaces)||spaces.length<1||spaces.length>100)throw new HttpError(400,'invalid_memory_scope');
    const owner=this.owner;
    return [...new Set(spaces.flatMap(space=>{const value=validateSpace(space);return value===owner?['owner']:[value,...chats().expand([value])];}))];
  }
  private async scope(workspace:string,audiences:string[]|null) {
    return (await this.control.query(`SELECT count(DISTINCT s.session_id) FILTER (WHERE s.kind='conversation')::int AS conversations,
      count(DISTINCT s.session_id)::int AS sessions,count(DISTINCT r.source_reference->>'id') FILTER (WHERE r.projection_reference IS NULL)::int AS messages,
      count(DISTINCT r.projection_reference->>'id')::int AS interpretations,coalesce(array_agg(DISTINCT s.session_id),'{}') AS ids
      FROM memory_sessions s LEFT JOIN memory_ingestion_receipts r ON r.session_id=s.session_id AND r.retired_at IS NULL
      WHERE s.workspace=$1 AND ($2::text[] IS NULL OR s.audience=ANY($2::text[]))`,
      [workspace,audiences])).rows[0] as {conversations:number;sessions:number;messages:number;interpretations:number;ids:string[]};
  }
  /** What each way of re-running long-term memory would do, so the owner can weigh its cost first. */
  async rebuildEstimate(principal:Reader,spaces:string[]) {
    admin(principal);
    const audiences=this.chosen(spaces.length?spaces:null),workspace=await this.workspace(await this.guards.state());
    // The served chats' originals, under every id each has had (ADR-0252): the owner's private chat and the served groups.
    const owner=this.owner,scopes=archiveScopes([...(owner?[owner]:[]),...servedGroups()]);
    const saved=(await this.contexts.access.stores.archive.query(`SELECT count(*)::int AS count FROM events WHERE origin='live' AND scope=ANY($1::text[])
      AND kind=ANY('{telegram_update,telegram_delivered_message,browser_input,browser_delivered_message}'::text[])`,[scopes])).rows[0].count as number;
    let failed:number|null=null;
    if(workspace&&this.engine.failedLearning)try{failed=await this.engine.failedLearning(workspace.id);}catch{}
    const {ids:_ids,...relearn}=workspace?await this.scope(workspace.id,audiences):{ids:[],conversations:0,sessions:0,messages:0,interpretations:0};
    return {workspace:workspace?.id??null,failed_learning:failed,relearn,replace:{saved_messages:saved}};
  }
  /** Ask the engine to run again the learning that ended in a terminal error, such as a provider outage.
   * Its saved messages are learned from where they are; nothing is resent. */
  async retryFailedLearning(principal:Reader) {
    admin(principal);const workspace=await this.attachedWorkspace();
    if(!this.engine.retryFailedLearning)throw new HttpError(409,engineErrors.unsupported);
    const retried=await this.engine.retryFailedLearning(workspace);
    if(retried) {
      const db=await this.control.connect();
      // A retried task keeps its old queue time, so readiness rechecks every failure again rather than only newer work.
      try{await db.query('BEGIN');await db.query('UPDATE memory_generations SET derivation_checked_at=NULL WHERE id=$1',[workspace]);
        await this.building(db,workspace);await db.query('COMMIT');}
      catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    }
    return {retried,status:await this.status()};
  }
  /** Re-learn chosen chats, or every chat: each of their engine sessions is replaced by a new one holding the
   * still-valid saved messages, and the old session leaves the engine with every fact derived from it. */
  async relearn(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(k=>!['spaces','operation_id'].includes(k)))throw new HttpError(400,'invalid_memory_scope');
    const audiences=this.chosen(body.spaces),workspace=await this.attachedWorkspace(),{ids,...scope}=await this.scope(workspace,audiences);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      // A rebuilt session gets a new id, so asking twice before it runs re-learns it once.
      for(const session of ids)await requestWorkflow(db,'honcho','relearn:'+session);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return scope;
  }
  async relearnSession(sessionId:string):Promise<boolean> {
    const session=(await this.control.query('SELECT workspace,key FROM memory_sessions WHERE session_id=$1',[sessionId])).rows[0];
    if(!session)return false;
    await this.current(session.workspace);await this.rebuild(session.workspace,session.key);return true;
  }
  /** Remove one earlier space from the engine: the engine deletes it a step at a time, then Nocheh's records of it go. */
  async retireWorkspace(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'memory_sync_busy');
      const row=(await db.query('SELECT * FROM memory_workspace_deletions WHERE workspace=$1',[id])).rows[0];
      if(!row)throw new HttpError(404,'memory_deletion_missing');if(row.state==='done')return true;
      if((await db.query("SELECT 1 FROM memory_generations WHERE id=$1 AND state<>'retired'",[id])).rowCount)throw new HttpError(409,'memory_workspace_current');
      for(let page=0;page<10;page++) {
        const step=await this.engine.forgetSpace(id);
        if(step.done) {
          await db.query('BEGIN');
          try {
            for(const table of ['memory_session_deletions','memory_walls','memory_sessions'])await db.query(`DELETE FROM ${table} WHERE workspace=$1`,[id]);
            await db.query('DELETE FROM memory_ingestion_receipts WHERE generation=$1',[id]);
            await db.query('DELETE FROM memory_generations WHERE id=$1',[id]);
            await db.query("UPDATE memory_workspace_deletions SET state='done',completed_at=now() WHERE workspace=$1",[id]);
            await db.query('COMMIT');
          } catch(error){await db.query('ROLLBACK');throw error;}
          return true;
        }
        await db.query('UPDATE memory_workspace_deletions SET deleted_sessions=deleted_sessions+$2 WHERE workspace=$1',[id,step.removed]);
      }
      return false;
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** Remove a replaced session from the engine, first deleting the facts other sessions derived from it. */
  async deleteSession(id:string,authority:ExecutionAuthority):Promise<boolean> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'honcho',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803358) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'memory_sync_busy');
      const row=(await db.query('SELECT * FROM memory_session_deletions WHERE session_id=$1',[id])).rows[0];
      if(!row)throw new HttpError(404,'memory_deletion_missing');if(row.state==='done')return true;
      for(let page=0;page<10;page++) {
        await this.current(row.workspace);
        const step=await this.engine.forgetSession(row.workspace,id);
        if(step.done) {
          await db.query("UPDATE memory_session_deletions SET state='done',completed_at=now() WHERE session_id=$1",[id]);return true;
        }
        await db.query('UPDATE memory_session_deletions SET deleted_conclusions=deleted_conclusions+$2 WHERE session_id=$1',[id,step.removed]);
      }
      return false;
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803358)');if(fenced)await leaveFamily(db,'honcho');});}
  }
  /** One bounded page of the correction sweep after a guard epoch: only sessions holding invalid writes are rebuilt. */
  async sweep(after:string,binding:GuardBinding,limit=100):Promise<{after:string;done:boolean;rebuilt:number}> {
    const rows=(await this.control.query(`SELECT r.* FROM memory_ingestion_receipts r JOIN memory_generations g ON g.id=r.generation
      WHERE g.installation_generation=$1 AND g.representation_version=$2 AND g.state<>'retired' AND r.retired_at IS NULL AND r.id>$3
      ORDER BY r.id LIMIT $4`,[binding.generation,this.protocol,after,limit])).rows;
    const invalid=new Map<string,{workspace:string;key:string}>();
    for(const row of rows)if(!invalid.has(row.session_id)&&!await this.valid(row,binding))invalid.set(row.session_id,{workspace:row.generation,key:row.session_key});
    for(const item of invalid.values())await this.rebuild(item.workspace,item.key);
    await this.guards.assertCurrent(binding);
    return {after:rows.at(-1)?.id??after,done:rows.length<limit,rebuilt:invalid.size};
  }
  async observe(id:string):Promise<boolean> {
    const current=await this.current(id);
    const pending=(await this.control.query("SELECT 1 FROM memory_ingestion_receipts WHERE generation=$1 AND state<>'done' AND retired_at IS NULL LIMIT 1",[id])).rowCount;
    const checked=new Date(),drained=!await this.engine.busy(id);
    // An engine can keep a failed learning task for a while (Honcho: 30 days). A failure is reported once; after the queue has
    // drained, only work queued since then can hold the space unready again.
    const failing=await this.engine.failing(id,current.row.derivation_checked_at??null);await this.current(id);
    const ready=!pending&&drained&&!failing;
    const changed=await this.control.query(`UPDATE memory_generations SET state=$2,
      error_code=CASE WHEN $4::boolean THEN 'memory_learning_failed' ELSE NULL END,
      derivation_checked_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE derivation_checked_at END,
      last_ready_at=CASE WHEN $2='ready' THEN now() ELSE last_ready_at END
      WHERE id=$1 AND state<>'retired' AND work_revision=$3`,[id,ready?'ready':'building',current.row.work_revision,failing,drained,checked]);
    if(failing)console.warn(JSON.stringify({event:'memory_learning_failed',engine:this.engine.id,workspace:id}));
    return ready&&changed.rowCount===1;
  }
  /** When the engine finishes new work, prepare the next reply context of each changed conversation. No timer renews it. */
  async requestPrefetch(id:string):Promise<number> {
    await this.current(id);
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const sessions=(await db.query(`SELECT session_id,work_revision FROM memory_sessions WHERE workspace=$1 AND kind IN ('conversation','material')
        AND prefetched_revision<work_revision ORDER BY updated_at DESC LIMIT 100`,[id])).rows;
      for(const session of sessions)await requestWorkflow(db,'honcho','context:'+session.session_id,session.work_revision);
      await db.query('COMMIT');return sessions.length;
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** Prefetch one conversation's guarded context for its latest speaker, so the next turn reads it without new detection.
   * The owner's forwards and files are read with the owner's private chat, and on their own when their session changed. */
  async prefetch(sessionId:string):Promise<boolean> {
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE session_id=$1',[sessionId])).rows[0];
    if(!session||!['conversation','material'].includes(session.kind))return false;
    const current=await this.current(session.workspace);
    const latest=(await this.control.query(`SELECT source_reference FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL
      AND state='done' AND projection_reference IS NULL ORDER BY peer_id=$2,created_at DESC,id LIMIT 1`,[sessionId,assistantPeer])).rows[0];
    if(!latest)return false;
    if(session.kind==='material')await this.materialContext(current,latest.source_reference);
    else await this.sessionContext(current,session.audience,latest.source_reference,session.audience==='owner');
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
    if(body.background!==undefined&&typeof body.background!=='boolean')throw new HttpError(400,'invalid_memory_priority');
    // Priority follows the Honcho process, not the memory-review principal: the deriver
    // learns in the background, while the API answers recall during a reply.
    const detect=(text:string)=>this.detect(text,body.background===true);
    // A model or embeddings request: its roles, names, model and tool ids stay as they are (ADR-0251).
    const prepared=await this.prepared.prepare(current.principal,payload,detect,{request:true});await this.current(current.row.id);return {payload:prepared};
  }
  /** The engine's learning requests quote messages Nocheh already guarded. Mark those exact
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
  private async connectedPeers(current:Current,audience:string,principal:Reader,query='',turnSource?:string,group:readonly string[]|null=null) {
    let connected=query.trim()?await this.contexts.entities.connected(principal,query,12):{entities:[],partial:false,ambiguities:[]};
    const clarification=principal.scope===null&&connected.ambiguities.length?
      `Please clarify which ${connected.ambiguities.map(item=>item.name).join(', ')} identity you mean.`:undefined;
    if(clarification)return {items:[],people:[],partial:connected.partial,clarification};
    if(!connected.entities.length) {
      let source=current.row.root_reference as SourceReference;
      if(principal.turnEvent)try{source=(await this.contexts.access.archive.captured(principal.turnEvent)).reference;}catch{}
      const local=await this.contexts.entities.context(source,[]),seeds=[local.speaker?.id,local.project?.id].filter((value):value is string=>!!value);
      connected={...await this.contexts.entities.connectedFrom(principal,seeds,12),ambiguities:[]};
    }
    const candidates=connected.entities.map(item=>({peer:memoryPeerId(item.entity),path:item.path.join(' → ')}));
    // The people a recall is about, whether or not memory learned anything about them: the owner's private notes about
    // them join the owner's own recall (ADR-0274).
    const people=connected.entities.filter(item=>item.entity.kind==='person').slice(0,4).map(item=>({id:item.entity.id,name:item.entity.name}));
    if(!candidates.length)return {items:[],people,partial:connected.partial,clarification:undefined};
    const available=new Set((await this.control.query(`SELECT DISTINCT peer.value AS peer_id FROM memory_ingestion_receipts r
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_array_length(r.peer_ids)>0 THEN r.peer_ids ELSE jsonb_build_array(r.peer_id) END) peer(value)
      WHERE r.generation=$1 AND r.state='done' AND r.retired_at IS NULL AND peer.value=ANY($2::text[])
      AND ($4::text='owner' OR ${recallCondition('r.audience','$4','$5')})
      AND ($3::text IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_array_length(r.source_references)>0 THEN r.source_references
          ELSE jsonb_build_array(r.source_reference) END) evidence(value)
        WHERE evidence.value->>'id'<>$3
      ))`,[current.row.id,candidates.map(item=>item.peer),turnSource??null,audience,group===null?null:[...group]])).rows.map(row=>String(row.peer_id)));
    return {items:candidates.filter(item=>available.has(item.peer)),people,partial:connected.partial,clarification:undefined};
  }
  /** The owner's private notes about these people (ADR-0274), each under its own header, together at most 4,000 characters. */
  private async ownerNotes(principal:Reader,people:readonly {id:string;name:string}[]):Promise<string[]> {
    if(!people.length)return [];
    // A note that can't be read leaves the recall as it was, without notes.
    const found=await this.contexts.entities.ownerNotes(principal,people.map(person=>person.id)).catch(()=>new Map<string,{note:string}>()),blocks:string[]=[];let used=0;
    for(const person of people) {
      const note=found.get(person.id)?.note.trim();if(!note)continue;
      const block=fitted(`${headers.ownerNote.replace('{name}',()=>person.name)}\n${note}`,Math.max(0,4000-used));
      if(!block)break;blocks.push(block);used+=block.length+2;
    }
    return blocks;
  }
  /** Read the engine's context for the current conversation and its speaker, guarded once per distinct result.
   * Owner reads span the workspace; any other audience reads only its own session. With `material`, the owner's
   * forwards and files are read beside it as their own block; `material` is null when only that read failed. */
  private async sessionContext(current:Current,audience:string,source:SourceReference,material=false) {
    const own=this.conversationContext(current,audience,source);
    if(!material)return {...await own,material:undefined};
    const [read,forwards]=await Promise.all([own,this.materialContext(current,source).catch(()=>null)]);
    return {...read,material:forwards};
  }
  private async conversationContext(current:Current,audience:string,source:SourceReference):Promise<ContextBlock> {
    const entities=await this.contexts.entities.context(source,[]),workspace=current.row.id;
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2 AND audience=$3',[workspace,entities.session_id,audience])).rows[0];
    const written=session?(await this.control.query(`SELECT count(*) FILTER (WHERE state='done')::int AS done,count(*) FILTER (WHERE state<>'done')::int AS pending
      FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL`,[session.session_id])).rows[0]:{done:0,pending:0};
    const speaker=entities.speaker?memoryPeerId(entities.speaker):null;
    const known=!!speaker&&!!(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL AND state='done'
      AND peer_ids ? $2 AND ($3::text IS NULL OR session_id=$3) LIMIT 1`,[workspace,speaker,audience==='owner'?null:session?.session_id??''])).rowCount;
    const empty={text:'',session:session?.session_id??null,syncing:written.pending>0};
    // A summary of a person across every session, such as a Honcho peer card, is never read, for any audience (ADR-0225).
    // The owner's block says what it is, since it may still hold what the owner forwarded before forwards were kept apart.
    const owner=audience==='owner',block=owner?{block:'owner'}:{},title=owner?headers.owner:headers.speaker;
    if(session&&written.done) {
      const options={subject:known?speaker:null,limitToSession:known&&audience!=='owner',tokens:contextTokens};
      const configuration={engine:this.engine.id,workspace,audience,session:session.session_id,subject:options.subject,limit_to_session:options.limitToSession,tokens:options.tokens,...block};
      const facts=options.subject?{subject:options.subject,sessions:options.limitToSession?[session.session_id]:null,profile:false}:null;
      // The fact list is read beside the context, so the turn waits for the slower of the two.
      const listed=this.listFacts(workspace,facts),read=await this.engine.context(workspace,session.session_id,options);
      // Only the owner's block may fall back to the engine's prose. A chat's own prose can hold a conclusion an old-fact
      // clean-up drew across every chat of its speaker and filed under this chat (ADR-0298); its listed facts never do.
      return this.contextBlock(current,audience,source,configuration,empty,{title,summaryTitle:headers.summary,summary:read.summary,
        summaryMessage:read.summaryMessage,representation:owner?read.subject:'',facts,listed});
    }
    if(owner&&known)return this.contextBlock(current,audience,source,{engine:this.engine.id,workspace,audience,peer:speaker,profile:true,...block},empty,
      {title,summaryTitle:headers.summary,summary:'',summaryMessage:null,representation:'',facts:{subject:speaker!,sessions:null,profile:true}});
    return empty;
  }
  /** What the owner forwarded from others and the files the owner sent, as the forwards-and-files participant holds them
   * across the whole space, with the summary of the session of forwards: the owner audience only. */
  private async materialContext(current:Current,source:SourceReference):Promise<ContextBlock> {
    const workspace=current.row.id;
    const session=(await this.control.query('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2 AND audience=$3',
      [workspace,materialSessionKey(this.protocol),'owner'])).rows[0];
    const written=session?(await this.control.query(`SELECT count(*) FILTER (WHERE state='done')::int AS done,count(*) FILTER (WHERE state<>'done')::int AS pending
      FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL`,[session.session_id])).rows[0]:{done:0,pending:0};
    // The participant only ever writes its own records, so it is their writer (memory_receipts_live_writer).
    const known=!!(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts WHERE generation=$1 AND retired_at IS NULL AND state='done'
      AND peer_id=$2 LIMIT 1`,[workspace,materialPeer])).rowCount;
    const empty={text:'',session:session?.session_id??null,syncing:written.pending>0},labels={title:headers.material,summaryTitle:headers.materialSummary};
    if(session&&written.done) {
      const options={subject:known?materialPeer:null,limitToSession:false,tokens:materialTokens};
      const configuration={engine:this.engine.id,workspace,audience:'owner',block:'material',session:session.session_id,subject:options.subject,limit_to_session:false,tokens:options.tokens};
      // As many facts as the engine's own context gives (WORKING_REPRESENTATION_MAX_OBSERVATIONS, 100).
      const facts=known?{subject:materialPeer,sessions:null,profile:false}:null;
      const listed=this.listFacts(workspace,facts),read=await this.engine.context(workspace,session.session_id,options);
      return this.contextBlock(current,'owner',source,configuration,empty,{...labels,summary:read.summary,summaryMessage:read.summaryMessage,
        representation:read.subject,facts,listed});
    }
    if(known)return this.contextBlock(current,'owner',source,{engine:this.engine.id,workspace,audience:'owner',block:'material',peer:materialPeer,profile:true},empty,
      {...labels,summary:'',summaryMessage:null,representation:'',facts:{subject:materialPeer,sessions:null,profile:true}});
    return empty;
  }
  /**
   * One block of long-term context. An engine that lists facts gives each its source line (ADR-0261, B3.1): the facts the
   * engine's own context would hold (the newest, within its session for a group), or for a profile the ones the engine's
   * profile picks. An engine that cannot list them keeps its prose; so does a block whose facts or source lines could not
   * be read, or whose fact lines the guard changed, which says so (`source_tags_unavailable`) and is counted.
   */
  private async contextBlock(current:Current,audience:string,source:SourceReference,configuration:Record<string,unknown>,empty:ContextBlock,
    input:{title:string;summaryTitle:string;summary:string;summaryMessage:string|null;representation:string;facts:FactRead|null;listed?:Promise<FactList>|null}):Promise<ContextBlock> {
    const prose=async():Promise<ContextBlock>=>{
      const representation=input.facts?.profile?await this.engine.profile(current.row.id,input.facts.subject):input.representation;
      const text=string([input.summary.trim()?input.summaryTitle+'\n'+input.summary:'',representation.trim()?input.title+'\n'+representation:'']
        .filter(Boolean).join('\n\n'),2*1024*1024);
      if(!text)return empty;
      return {...empty,text:(await this.guardedContext(current,audience,source,configuration,text)).text};
    };
    if(!this.sourcesFacts(input.facts))return prose();
    try{return {...empty,...await this.factContext(current,audience,source,configuration,{...input,facts:input.facts})};}
    catch(error) {
      if(bindingMoved(error)||error instanceof HttpError&&error.code==='memory_context_retired')throw error;
      // Why, by code only: the facts could not be read, or the guard changed their lines (source_lines_changed).
      const code=error instanceof HttpError?error.code:'memory_source_lines_error';
      console.warn(JSON.stringify({event:'memory_source_lines_failed',engine:this.engine.id,code}));
      // A tag request that failed counted itself already.
      if(code!=='source_tags_unavailable')await countMemoryStep(this.control,'source_tags',false);
    }
    const fallback=await prose();
    return fallback.text?{...fallback,limitations:['representation_has_no_exact_citations','source_tags_unavailable']}:fallback;
  }
  /** Whether a block's facts are read with their sources: an engine that lists facts (and, for a profile, its most
   *  derived), with tags to name them. */
  private sourcesFacts(read:FactRead|null):read is FactRead {
    return !!read&&!!this.engine.facts&&!!this.tags&&!(read.profile&&!this.engine.mostDerived);
  }
  /** The block's facts, started early; a failure is the block's to handle, when it reads them. */
  private listFacts(workspace:string,read:FactRead|null):Promise<FactList>|null {
    if(!this.sourcesFacts(read))return null;
    const listed=read.profile?this.profileFacts(workspace,read.subject):this.engine.facts!(workspace,read.subject,{sessions:read.sessions,size:factCount,cursor:null});
    listed.catch(()=>{});return listed;
  }
  /** What the engine's profile of a participant holds (B3.2), rebuilt from its fact list: its 25 most-derived facts, in
   *  its order, then the newest, up to 50. Exact unless more than 300 facts were learned more than once. */
  private async profileFacts(workspace:string,subject:string):Promise<FactList> {
    // Listed without their batches, which are asked for only once the 50 are chosen.
    const later=!!this.engine.factBatches,options={sessions:null,...later?{batches:false}:{}};
    const [top,recent]=await Promise.all([this.engine.mostDerived!(workspace,subject,options),this.engine.facts!(workspace,subject,{...options,size:100,cursor:null})]);
    const chosen=top.facts.slice(0,profileDerived),ids=new Set(chosen.map(fact=>fact.id));
    const facts=[...chosen,...recent.facts.filter(fact=>!ids.has(fact.id)).slice(0,profileFactCount-chosen.length)];
    const batches=later?await this.engine.factBatches!(workspace,facts):[];
    return {facts,limitations:[...new Set([...top.limitations,...recent.limitations,...batches,...top.complete?[]:['profile_most_derived_incomplete']])].sort()};
  }
  /** A fact list whose batches the engine's plugin could not give (fact_batches_*) is counted as a `source_tags` problem,
   *  so an old or failed plugin shows on System › Health, not only in the block's limitations. */
  private async factBatchesFailed(limitations:readonly string[]) {
    const failed=limitations.filter(code=>code.startsWith('fact_batches_'));
    if(!failed.length)return;
    console.warn(JSON.stringify({event:'memory_fact_batches_failed',engine:this.engine.id,code:failed.join(',')}));
    await countMemoryStep(this.control,'source_tags',false);
  }
  /**
   * B3.1: the summary and each fact on a numbered line with its source message's time, under source lines code builds
   * (B2): the engine's facts map to receipts of this reader's audience, are ordered, given `by` and a header source, and
   * the header sources are tagged at day precision for this reader, in one request. Only the summary and fact lines are
   * guarded. The bounded record keeps every fact's every source and its exactness, so a fact can be opened by its number
   * and a retired source found; their digest is part of the record's configuration, so a changed source is a new record.
   * Throws when its facts or tags cannot be read, or the guard changed the fact lines (the caller falls back to prose).
   */
  private async factContext(current:Current,audience:string,source:SourceReference,configuration:Record<string,unknown>,
    input:{title:string;summaryTitle:string;summary:string;summaryMessage:string|null;facts:FactRead;listed?:Promise<FactList>|null}) {
    const workspace=current.row.id,binding=current.binding,principal=this.principal(audience,source.id,binding);
    const scope={audience,group:audience==='owner'?null:this.recallGroup(principal)},read=input.facts;
    const page=await (input.listed??this.listFacts(workspace,read)!);
    await this.factBatchesFailed(page.limitations);
    const sourced=await this.factSources.sourced(principal,binding,workspace,read.subject,page.facts,scope);
    const summaryReference=input.summary.trim()&&input.summaryMessage?
      (await this.factSources.receipts(workspace,[input.summaryMessage],scope)).get(input.summaryMessage)?.primary??null:null;
    const references=[...sourced.flatMap(item=>item.header?[item.header]:[]),...summaryReference?[summaryReference]:[]];
    const tags=references.length?await this.tags!.tags(principal,binding,references,{precision:'day',historical:true,compact:true,
      place:sourced.some(item=>item.place)}):new Map();
    // A tag request that failed gives the block in prose, as before (it counted itself).
    if([...tags.values()].some(tag=>tag!==null&&tag.tag===unavailableTag('now').tag))throw new HttpError(503,'source_tags_unavailable');
    const facts:BlockFact[]=sourced.map(item=>{
      const tag=item.header?tags.get(item.header.id)??null:null;
      return {conclusion:item.fact.id,content:item.fact.content,by:item.by,exact:item.exact,batch:item.fact.exact===false,cited:item.fact.writes.length>0,
        tag:tag?(item.place?tag.place??null:tag.tag):null,time:tag?.time??null,order:Date.parse(tag?.at??'')||Date.parse(item.fact.createdAt)||0,more:item.more};
    });
    const plan=planFactBlock({title:input.title,summaryTitle:input.summaryTitle,summary:input.summary,
      through:summaryReference?tags.get(summaryReference.id)?.day??null:null,facts});
    const behind=new Map(sourced.map(item=>[item.fact.id,item]));
    // Honcho's summary cites nothing, so a block that shows one is not exact either.
    const summarized=!!plan.summary.trim(),batch=plan.facts.some(fact=>!fact.exact);
    const exact=plan.facts.length>0&&!batch&&!summarized;
    const limitations=[...new Set([...batch?['some_facts_cite_only_their_batch']:[],...summarized?['summary_has_no_exact_citations']:[],
      ...page.limitations,...plan.left?['older_facts_left_out']:[]])].sort();
    // Every source of every fact shown, in order, readable or not: what opening a fact and retiring a source read.
    const provenance={facts:plan.facts.map(fact=>{const item=behind.get(fact.conclusion)!;
      return {n:fact.n,conclusion:fact.conclusion,exact:fact.exact,by:fact.by,time:fact.time,sources:item.sources,more:fact.more,complete:item.complete,
        session:item.fact.session,...item.place?{place:true}:{}};}),
      subject:read.subject,summary_through:plan.through,limitations};
    const guarded=await this.guardedContext(current,audience,source,{...configuration,facts_digest:digest(canonical(provenance))},plan.text,provenance);
    const text=renderFactBlock(plan,guarded.text,'nocheh:memory:'+guarded.record);
    if(text===null)throw new HttpError(409,'source_lines_changed');
    return {text,record:guarded.record,exact,limitations};
  }
  /** One block of context, guarded once per distinct result and bounded on its own. A block of facts keeps their sources
   *  in the provenance of the engine's raw output, which the guard never reads (factRecords): only the bounded record's
   *  text and a few ids are checked for secrets on the turn path, never every source id. */
  private async guardedContext(current:Current,audience:string,source:SourceReference,configuration:Record<string,unknown>,text:string,
    facts?:{limitations:string[]}&Record<string,unknown>):Promise<{text:string;record:string}> {
    const workspace=current.row.id,limitations=facts?facts.limitations:['representation_has_no_exact_citations'];
    // Identical engine output reuses its guarded copy, so a prefetched context needs no new detection on arrival.
    const key='native-context:'+digest(canonical([configuration,digest(text)]));
    const raw=await this.derived.record({operation_id:key,source:current.row.root_reference,kind:'memory_result',content:Buffer.from(text),
      producer:this.engine.id,producer_version:this.protocol,configuration,provenance:facts??{limitations}});
    const output=await this.derived.record({operation_id:key+':bounded',source:current.row.root_reference,parents:[raw],kind:'memory_context',
      content:Buffer.from(Array.from(text).slice(0,contextCharacters).join('')),producer:'nocheh',producer_version:this.protocol,
      configuration:{max_characters:contextCharacters,workspace,audience,...facts?{facts_digest:configuration.facts_digest}:{}},provenance:{limitations}});
    await this.guards.prepareContext(output,this.protocol,this.principal(audience,source.id,current.binding),this.prepared,this.detect);
    const value=(await this.guards.read('derived_artifacts:'+output.id,current.binding)).value as {text:string};
    return {text:String(value.text??''),record:output.id};
  }
  /** An owner decision, such as retiring a message, can make engine writes invalid. The engine keeps them until a
   * correction sweep at that decision's epoch or later rebuilds their sessions and the engine deletes the old ones with
   * the facts learned from them. Summaries, representations and recall answers cite nothing, so none is read until then.
   * Other epoch changes, such as learning publications, do not hold memory, and neither do owner decisions that
   * cannot make a write invalid, such as answering a suggestion card (ADR-0223). */
  private async correcting(current:Current):Promise<boolean> {
    const {generation,epoch}=current.binding;
    const uncorrected=await this.control.query(`SELECT 1 FROM owner_commands c WHERE c.holds_memory AND c.epoch<=$2 AND c.epoch>coalesce((SELECT max(guard_epoch)
      FROM learning_refresh_sweeps WHERE installation_generation=$1 AND family='honcho' AND stage='done'),0) LIMIT 1`,[generation,epoch]);
    if(uncorrected.rowCount)return true;
    return !!(await this.control.query(`SELECT 1 FROM memory_session_deletions WHERE workspace=$1 AND state<>'done' LIMIT 1`,[current.row.id])).rowCount;
  }
  /** Freshness is checked when a message arrives: the turn reads the engine's current context for its own conversation.
   * An owner turn also reads the owner's forwards and files, side by side, as a block of its own; when only that read
   * fails, the rest is kept and says so (forwards_unavailable), so the turn's parent counts it. */
  async context(principal:Reader) {
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding);
    // A bound reader reads long-term memory by plain search only: no summary or representation (ADR-0249, step 4); so does
    // a machine job's run, whose search reads back only what its card showed (machine jobs' reads).
    if(!workspace||!principal.turnEvent||boundReader(principal)!==null||principal.machineReads)return limited;
    try {
      const current=await this.current(workspace.id),audience=this.principalAudience(principal);
      if(await this.correcting(current))return correcting;
      const source=(await this.contexts.access.archive.captured(principal.turnEvent)).reference;
      // A job's run reads what it read before; the forwards-and-files block is for the owner's own turns.
      const material=audience==='owner'&&!jobRun(principal),read=await this.sessionContext(current,audience,source,material);
      await this.current(workspace.id);await this.prepared.audience.assert(principal);
      const syncing=read.syncing||!!read.material?.syncing||current.row.state==='building';
      const failed=material&&read.material===null?['forwards_unavailable']:[],about=(name:string)=>material?{about:name}:{};
      // A block of facts is named by its record, which keeps every fact's sources (ADR-0261); prose by its session.
      const entry=(block:ContextBlock,fallback:string,more:string[],name:string)=>({source:'nocheh:memory:'+(block.record??block.session??fallback),kind:'memory_inference',
        text:block.text,exact_citations:block.exact??false,limitations:[...block.limitations??['representation_has_no_exact_citations'],...more],...about(name)});
      const sources=[...(read.text?[entry(read,workspace.id,failed,'owner')]:[]),...(read.material?.text?[entry(read.material,materialPeer,[],'forwards_and_files')]:[])];
      if(!sources.length)return {sources:[],limited_memory:false,syncing,...(failed.length?{limitations:failed}:{})};
      for(const item of sources)await this.prepared.allow(principal,{text:item.text});
      return {sources,limited_memory:false,syncing};
    } catch(error) {
      // A failed read says so, so the turn's parent counts it for the owner's notice (ADR-0257); the turn still runs.
      await this.prepared.audience.assert(principal);return {...limited,error:'memory_context_failed'};
    }
  }
  private async relevantOwnerCorrections(principal:Reader,query:string,binding:GuardBinding) {
    const space=principal.space??principal.scope;
    if(!space)return [];
    const rows=(await this.contexts.access.stores.derived.query(`SELECT e.id,e.subject,e.scope_id,v.created_at FROM learned_entries e
      JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
      WHERE e.scope_kind='conversation' AND ${recallCondition('e.scope_id','$1','$2')} AND v.author='owner' AND NOT v.retired
      ORDER BY e.id LIMIT 101`,[space,this.recallGroup(principal)])).rows;
    if(rows.length>100)throw new HttpError(409,'owner_correction_limit');
    const normalized=(text:string)=>text.toLocaleLowerCase().replace(/\s+/g,' ').trim();
    const question=normalized(query),found=[];
    for(const row of rows) {
      const subject=normalized(row.subject);
      if(!subject||!question.includes(subject))continue;
      try {
        const version=await this.contexts.learned.read(principal,row.id,binding,async reference=>
          this.contexts.access.canRead(principal,reference,binding),this.contexts.access.recall(principal));
        const text=`Active owner correction for ${version.subject} in ${row.scope_id===space?'this conversation':'another topic of this group'} (revision ${version.revision}): ${version.text}`;
        await this.prepared.allow(principal,text);
        found.push({row,version,text});
      } catch(error) {
        if(error instanceof HttpError&&error.code==='learned_memory_not_found')continue;
        throw error;
      }
    }
    // Each names where and when the owner made it, and its first sources tagged (B3.6), all in one batch each; read()
    // already checked every source with canRead.
    const evidence=found.map(({version})=>((version.evidence??[]) as SourceReference[]).slice(0,CORRECTION_EVIDENCE));
    const [tags,named]=this.tags&&found.length?await Promise.all([this.tags.tags(principal,binding,evidence.flat()),
      this.tags.corrections(principal,found.map(({row})=>({chat:row.scope_id as string,made:row.created_at instanceof Date?row.created_at:null})))]):[null,null];
    const sources=found.map(({row,version,text},index)=>({source:`nocheh:learned:${row.id}:${version.revision}`,kind:'owner_corrected_interpretation',text,exact_citations:false,
      ...named?{tag:named[index]!,evidence:evidence[index]!.map(reference=>{const tag=tags!.get(reference.id)??{...unavailableTag('here')};
        return {source:'nocheh:event:'+reference.id,tag:tag.tag,by:tag.by};})}:{}}));
    await this.guards.assertCurrent(binding);
    return sources;
  }
  /** The engine lists the facts it read while answering. The archived messages they cite, listed first, let the
   * agent check a claim against the original; a fact without citations brings its whole learning batch and
   * says so in the limitations. A fact that was read is not proof the answer relied on it. The messages are those this
   * reader may read: within the sessions its recall asked (its group's, when the group's topics share memory), never a
   * retired write; for a turn, only each message this reader can read (a group's own, and for the owner none retired). */
  private async evidence(workspace:string,audience:string,responses:{evidence:string[]}[],binding:GuardBinding,principal:Reader,group:readonly string[]|null):
    Promise<{references:SourceReference[];limitations:string[]}> {
    if(!this.engine.trace)return {references:[],limitations:['evidence_unsupported']};
    const ids=[...new Set(responses.flatMap(response=>response.evidence))].filter(engineId);
    if(!ids.length)return {references:[],limitations:['no_conclusion_evidence']};
    const limitations=ids.length>32?['evidence_conclusion_limit']:[];
    try {
      // Learned evidence is read as it was when it was learned: a later reaction change does not take it back.
      // One batched check (readable, which is canRead) for every message: a group's own, and for the owner's turns none
      // retired. The owner's dashboard reads every one.
      const read=await this.provenance.read(workspace,audience,ids.slice(0,32),binding,{group,
        ...principal.admin?{}:{readable:(references:SourceReference[])=>this.contexts.access.readable(principal,references,binding,{historical:true})}});
      return {references:read.evidence,limitations:['evidence_lists_conclusions_read_not_relied_on',...read.limitations,...limitations]};
    } catch {return {references:[],limitations:['evidence_unavailable',...limitations]};}
  }
  async recall(principal:Reader,query:string) {
    string(query,2000);
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding);
    // Plain search only for a bound reader: the engine's answers cite no exact messages (ADR-0249, step 4). The same for a
    // machine job's run, which reads only what its card showed (machine jobs' reads).
    if(!workspace||boundReader(principal)!==null||principal.machineReads)return limited;
    let corrections:Awaited<ReturnType<NativeMemoryRepository['relevantOwnerCorrections']>>=[];
    try {
      const current=await this.current(workspace.id),id=current.row.id,actor=principal.admin?current.principal:principal;
      const audience=principal.admin?'owner':this.principalAudience(principal),group=this.recallGroup(principal);
      corrections=await this.relevantOwnerCorrections(principal,query,current.binding);
      if(await this.correcting(current))return {...correcting,sources:corrections};
      const question=await this.prepared.prepare(actor,query,this.detect),requestId=randomUUID();
      const root=await this.prepared.root(actor,current.binding);
      const input=await this.derived.record({operation_id:'native-recall-input:'+requestId,source:root,kind:'runtime_context',content:Buffer.from(String(question)),
        producer:'nocheh',producer_version:this.protocol,configuration:{workspace:id,audience,reasoning_level:'low'},provenance:{binding:current.binding}});
      // The active question alone is not prior memory. Background context
      // still includes it, and receipts with independent supporting evidence qualify.
      const connected=await this.connectedPeers(current,audience,actor,String(question),principal.turnEvent,group),answers=[];
      const syncing=current.row.state==='building';
      if(connected.clarification)return {sources:corrections,limited_memory:false,syncing,clarification_required:true,note:connected.clarification};
      // Group and topic recall reads only that audience's own sessions, or every session of its group when
      // the group's topics share memory, or of its project's groups while the project shares them; owner recall spans
      // the space. The engine keeps a group's reads inside the wall of exactly those chats (ADR-0286).
      const walled=audience==='owner'?null:await this.walls.open(id,group?[...group,audience]:[audience]);
      const sessions=audience==='owner'?null:walled?walled.sessions:await this.provenance.sessions(id,audience,1000,group),wall=walled?.wall;
      // Each peer is asked side by side, so recall waits for the slowest engine answer rather than their sum. The owner's
      // forwards and files are asked too, beyond the four, when they hold something learned before this question: in a
      // group only within its own sessions, and headed as other people's words.
      const asked=sessions?.length===0?[]:[...connected.items.slice(0,4).map(item=>({peer:item.peer,head:`[related through ${item.path}]`})),
        ...(await this.materialLearned(id,sessions,principal.turnEvent)?[{peer:materialPeer,head:headers.materialRecall}]:[])];
      if(asked.length)await this.current(id);
      // The forwards-and-files ask fails on its own: the people and projects asked keep their answers, the result says
      // what is missing, and the stores count it for the owner's notice. Any other failed ask fails the recall, as before.
      const responses=await Promise.all(asked.map(item=>{
        const ask=this.engine.ask(id,item.peer,String(question),{sessions,...wall?{wall}:{},evidence:true});
        return item.peer===materialPeer?ask.then(response=>typeof response.text==='string'?response:null,()=>null):ask;
      }));
      const read=asked.flatMap((item,index)=>responses[index]?[{item,response:responses[index]!}]:[]);
      const forwards=asked.some(item=>item.peer===materialPeer)?read.some(({item})=>item.peer===materialPeer):null;
      if(forwards!==null)await countMemoryStep(this.control,'memory_read',forwards);
      const missing=forwards===false?['forwards_unavailable']:[];
      // Whole answers, each under its header, up to 20,000 characters: the last ones that do not fit are left out, and a
      // first one alone too long is cut, so no answer is ever without its header.
      for(const {item,response} of read) {
        const answer=`${item.head}\n${string(response.text,Number.MAX_SAFE_INTEGER)}`,used=answers.reduce((total,text)=>total+text.length+2,0);
        if(answers.length&&used+answer.length>20000)break;
        answers.push(answers.length?answer:fitted(answer,20000));
      }
      const cut=answers.length<read.length||read.some(({item,response},index)=>index===0&&`${item.head}\n${response.text}`.length>20000);
      // The owner's private notes about the people asked about, only in the owner's own recall (ADR-0274): never in a
      // group's, a member's or the memory engine's.
      const notes=audience==='owner'?await this.ownerNotes(principal,connected.people??[]):[];
      if(!answers.length&&!notes.length)return corrections.length?{sources:corrections,limited_memory:false,syncing,...missing.length?{limitations:missing}:{}}:
        missing.length?{...limited,limitations:missing}:{...limited,note:'No authorized person or project memory matched this request.'};
      const included=read.slice(0,answers.length);
      const evidence=await this.evidence(id,audience,included.map(({response})=>response),current.binding,principal,group);
      const limitations=['reasoning_response_has_no_exact_conclusion_citations',...evidence.limitations,...missing,...cut?['recall_answer_cut']:[]];
      const output=await this.derived.record({operation_id:'native-recall-output:'+requestId,source:root,parents:[input],kind:'memory_result',content:Buffer.from([...answers,...notes].join('\n\n')),
        producer:this.engine.id,producer_version:this.protocol,configuration:{workspace:id,audience,reasoning_level:'low',peers:connected.items.slice(0,4),
          ...(included.some(({item})=>item.peer===materialPeer)?{forwards_and_files:true}:{})},
        provenance:{partial:connected.partial,evidence:evidence.references,limitations}});
      await this.current(id);await this.guards.prepareContext(output,this.protocol,actor,this.prepared,this.detect);
      const value=(await this.guards.read('derived_artifacts:'+output.id,current.binding)).value as {text:string};
      // The facts the answers read, each with its sources (B3.6): listed, and every one stored in a record of its own.
      const facts=await this.recallFacts(current,principal,actor,{audience,group},sessions,wall,
        included.map(({item,response})=>({peer:item.peer,evidence:response.evidence})),root,output,requestId);
      await this.current(id);await this.prepared.audience.assert(principal);await this.prepared.allow(principal,value);
      // The answer is named by its record and the facts by theirs, so a stored tool row cites both and a retired source
      // withholds it (B6.2). An engine that cannot list facts, or a failed read of them, lists the archived messages instead.
      // Both record ids come first, before the long answer, so even a cut copy of the row names them.
      const listed=facts&&!facts.failed,record=listed&&facts.record?{facts_source:'nocheh:memory:'+facts.record}:{};
      const named=listed?{facts:facts.listed,evidence_count:facts.count}:{evidence_sources:evidence.references.map(reference=>'nocheh:event:'+reference.id)};
      return {sources:[...corrections,{source:'nocheh:memory:'+output.id,...record,kind:'memory_inference',text:value.text,exact_citations:false,
        ...named,limitations:[...limitations,...facts?.limitations??[]]}],partial:connected.partial,
        limited_memory:!current.row.last_ready_at&&current.row.state!=='ready',syncing};
    } catch(error){await this.prepared.audience.assert(principal);return corrections.length?{...limited,sources:corrections}:limited;}
  }
  /**
   * B3.6: the facts a recall's answers read, as the engine holds them now (within the sessions the recall asked), each with
   * every archived message of this reader's audience it came from (B2). Every fact, up to RECALL_FACT_LIMIT, is stored in a
   * record of its own, its text one numbered line each, guarded and read back as the answer is; `fact=n` opens any of them
   * and a retired source of any of them is found. The first 12 are listed, cited ones first and then in the engine's
   * order, each with its first two readable sources tagged. A guard that changed the lines drops the texts
   * (fact_text_unavailable, counted), never the record.
   * Null for an engine that cannot list facts; a failed read says so (recall_facts_unavailable, counted). Either way the
   * caller lists the archived messages instead, as before.
   */
  private async recallFacts(current:Current,principal:Reader,actor:Reader,scope:FactAudience,sessions:string[]|null,wall:string|undefined,
    asked:readonly {peer:string;evidence:readonly string[]}[],root:Awaited<ReturnType<PreparedContextRepository['root']>>,answer:DerivativeReference,requestId:string):
    Promise<{record:string|null;listed:RecallFact[];count:number;limitations:string[];failed?:true}|null> {
    if(!this.engine.factsById||!this.tags)return null;
    const id=current.row.id,binding=current.binding;
    try {
      let left=RECALL_FACT_LIMIT;
      const wanted=asked.map(({peer,evidence})=>{const ids=[...new Set(evidence)].filter(engineId).slice(0,left);left-=ids.length;return {peer,ids};})
        .filter(item=>item.ids.length);
      const over=asked.reduce((total,item)=>total+new Set(item.evidence.filter(engineId)).size,0)>RECALL_FACT_LIMIT?['recall_fact_limit']:[];
      if(!wanted.length)return {record:null,listed:[],count:0,limitations:over};
      // A wall's answer names the wall's own copies of facts (ADR-0286).
      const read=await Promise.all(wanted.map(item=>this.engine.factsById!(id,item.peer,item.ids,{sessions,...wall?{wall}:{}})));
      await this.factBatchesFailed(read.flatMap(page=>page.limitations));
      const sourced=await Promise.all(wanted.map((item,index)=>this.factSources.sourced(principal,binding,id,item.peer,read[index]!.facts,scope)));
      const all=sourced.flatMap((list,index)=>list.map(item=>({peer:wanted[index]!.peer,item})));
      // Facts that cite their messages first, then the engine's order; numbered as stored.
      const ordered=[...all.filter(({item})=>item.fact.exact===true),...all.filter(({item})=>item.fact.exact!==true)].map((entry,index)=>({...entry,n:index+1}));
      const limitations=[...new Set([...read.flatMap(page=>page.limitations),...over,
        ...ordered.some(({item})=>!item.exact)?['some_facts_cite_only_their_batch']:[]])].sort();
      if(!ordered.length)return {record:null,listed:[],count:0,limitations};
      const stored:StoredFact[]=ordered.map(({n,peer,item})=>({n,conclusion:item.fact.id,peer,exact:item.exact,by:item.by,sources:item.sources,more:item.more,
        complete:item.complete,session:item.fact.session,...item.place?{place:true}:{},...wall?{wall}:{}}));
      // The facts with every source go on a record the guard never reads; only the text lines are guarded (factRecords).
      const text=Buffer.from(recallFactText(ordered.map(({n,item})=>({n,content:item.fact.content}))));
      const sources=await this.derived.record({operation_id:'native-recall-facts:'+requestId,source:root,parents:[answer],kind:'memory_result',
        content:text,producer:this.engine.id,producer_version:this.protocol,configuration:{workspace:id,audience:scope.audience,facts:'sources'},
        provenance:{facts:stored,limitations}});
      const record=await this.derived.record({operation_id:'native-recall-facts:'+requestId+':text',source:root,parents:[sources],kind:'memory_result',
        content:text,producer:'nocheh',producer_version:this.protocol,configuration:{workspace:id,audience:scope.audience,facts:'recall'},provenance:{limitations}});
      await this.current(id);await this.guards.prepareContext(record,this.protocol,actor,this.prepared,this.detect);
      const value=(await this.guards.read('derived_artifacts:'+record.id,binding)).value as {text:string};
      const texts=recallFactTexts(String(value.text??''),ordered.length);
      if(!texts)await countMemoryStep(this.control,'source_tags',false);
      const listed=ordered.slice(0,recallFactsListed),named=listed.map(({item})=>shownFirst(item).slice(0,recallFactSources));
      const tags=await this.tags.tags(principal,binding,named.flat(),{historical:true,place:listed.some(({item})=>item.place)});
      const facts:RecallFact[]=listed.map(({n,item},index)=>({n,...texts?{text:cutText(texts[n-1]!,recallFactChars)}:{},exact:item.exact,by:item.by,
        sources:named[index]!.flatMap(reference=>{const tag=tags.get(reference.id);return tag?[sourceOf(tag,item.place)]:[];}),
        more:Math.max(0,item.readable.length-named[index]!.length)}));
      if(texts)await this.prepared.allow(principal,facts.map(fact=>fact.text??''));
      return {record:record.id,listed:facts,count:ordered.length,limitations:texts?limitations:[...limitations,'fact_text_unavailable'].sort()};
    } catch(error) {
      if(bindingMoved(error))throw error;
      console.warn(JSON.stringify({event:'memory_recall_facts_failed',engine:this.engine.id,code:error instanceof HttpError?error.code:'memory_recall_facts_error'}));
      await countMemoryStep(this.control,'source_tags',false);
      return {record:null,listed:[],count:0,limitations:['recall_facts_unavailable'],failed:true};
    }
  }
  /**
   * archive_read nocheh:memory:<record> (B5.2): fact `n` of a record of facts a turn or a recall read, or without `n` the
   * first 20 facts' numbers and source tags. It opens only a per-turn block or a recall's facts record (never another
   * record), of this reader's audience (the owner reads any) and of the current memory space, and never for a private
   * answer. A fact opens only while nothing corrects memory, while the engine still holds it (a correction deletes the
   * facts it replaces), and while none of its stored sources is retired, nor, for a fact that names only some of its
   * messages, any message of its session (B6.3). The text is the fact's line of the record's guarded copy, read with
   * the current binding, never the engine's raw fact; its sources are those this reader may read, the one its source
   * line names first, tagged. Every result repeats the record's id as `source`, so a stored row cites it on its own.
   */
  async openFact(principal:Reader,recordId:string,n:number|null) {
    if(!/^[a-f0-9]{64}$/.test(recordId)||n!==null&&!(Number.isSafeInteger(n)&&n>=1&&n<=RECALL_FACT_LIMIT))throw factUnavailable();
    // Never for a bound reader: a private answer, a member's private chat or the owner's ask about a member (ADR-0262).
    if(boundReader(principal)!==null)throw factUnavailable();
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding),retirements=this.contexts.access.retirements;
    if(!workspace||!this.tags||!this.engine.factExists||!this.engine.factsById||!retirements)throw factUnavailable();
    const current=await this.current(workspace.id),audience=principal.admin?'owner':this.principalAudience(principal);
    const row=(await factRecords(this.derived.pool,[recordId])).get(recordId),configuration=row?.configuration??{},facts=row?.facts??[];
    if(!row||configuration.workspace!==current.row.id||audience!=='owner'&&configuration.audience!==audience)throw factUnavailable();
    // Whose fact it is: a recall's record names each one's participant, a per-turn block its one subject.
    const peerOf=(fact:StoredFact)=>typeof fact.peer==='string'?fact.peer:row.subject;
    const wallOf=(fact:StoredFact)=>typeof fact.wall==='string'?fact.wall:undefined;
    const valid=(fact:StoredFact)=>Number.isSafeInteger(fact?.n)&&engineId(fact.conclusion)&&Array.isArray(fact.sources)&&
      (fact.wall===undefined||typeof fact.wall==='string'&&/^wall-[a-f0-9]{40}$/.test(fact.wall))&&
      fact.sources.every(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id))&&engineId(peerOf(fact));
    const chosen=n===null?facts.slice(0,openedListed):facts.filter(fact=>fact?.n===n);
    if(!chosen.length||!chosen.every(valid))throw factUnavailable();
    if(await this.correcting(current))throw factUnavailable();
    // Forgotten as the retired route forgets it (B6.2): a record any of whose facts rests on a retired message opens no
    // fact at all, so a stored row that cites it is withheld whenever one that opened it would be.
    const forgotten=(await retirements.retiredRecords([recordId])).has(recordId);
    const actor=principal.admin?current.principal:principal,space=current.row.id;
    // The sources this reader may read, as learned (historical), the one each fact's source line names first.
    const captured=await this.contexts.access.archive.capturedMany(chosen.flatMap(fact=>fact.sources));
    const references=[...captured.values()].map(source=>source.reference);
    const open=references.length?await this.contexts.access.readable(principal,references,current.binding,{historical:true}):new Map<string,boolean>();
    const readableIds=[...new Set(chosen.flatMap(fact=>fact.sources))].filter(id=>open.get(id)===true);
    const classes=readableIds.length?await this.sources.classesFor(readableIds):new Map();
    const shown=(fact:StoredFact)=>{
      const ordered=fact.sources.filter(id=>open.get(id)===true).map(id=>({id,bucket:bucketOf(classes.get(id)?.class??'unknown')}));
      const header=headerSource(ordered);
      return (header?[header,...ordered.filter(item=>item.id!==header.id)]:ordered).map(item=>captured.get(item.id)!.reference);
    };
    if(n===null) {
      // The first facts and the source each one's line names; one still held by the engine and with no retired source.
      // Asked of whoever holds them: the participant, or the wall a group's recall read them in (ADR-0286).
      const holderOf=(fact:StoredFact)=>canonical([peerOf(fact),wallOf(fact)??null]);
      const holders=[...new Map(chosen.map(fact=>[holderOf(fact),{peer:peerOf(fact)!,wall:wallOf(fact)}])).entries()];
      const held=forgotten?new Set<string>():new Set((await Promise.all(holders.map(([key,{peer,wall}])=>this.engine.factsById!(space,peer,
        chosen.filter(fact=>holderOf(fact)===key).map(fact=>fact.conclusion),{sessions:null,...wall?{wall}:{}}))))
        .flatMap(page=>page.facts.map(fact=>fact.id)));
      const heads=chosen.map(fact=>forgotten||!held.has(fact.conclusion)?null:shown(fact)[0]??null);
      const tags=await this.tags.tags(principal,current.binding,heads.filter((head):head is SourceReference=>head!==null),
        {historical:true,place:chosen.some(fact=>fact.place===true)});
      await this.current(space);await this.prepared.audience.assert(principal);
      return {source:'nocheh:memory:'+recordId,count:facts.length,facts:chosen.map((fact,index)=>{
        const tag=heads[index]?tags.get(heads[index]!.id):null;
        return heads[index]===null&&(forgotten||!held.has(fact.conclusion))?{n:fact.n,unavailable:true}:
          {n:fact.n,by:fact.by,tag:tag?sourceOf(tag,fact.place).tag:null};
      })};
    }
    const fact=chosen[0]!;
    if(forgotten||!await this.engine.factExists(space,peerOf(fact)!,fact.conclusion,wallOf(fact)))throw factUnavailable();
    // The record's guarded copy, prepared and read under the current binding, as recall reads its answer.
    await this.guards.prepareContext({store:'derived',kind:'artifact',id:row.id,input_hash:row.content_hash},this.protocol,actor,this.prepared,this.detect);
    const value=(await this.guards.read('derived_artifacts:'+row.id,current.binding)).value as {text?:unknown};
    const line=guardedFactLine(String(value.text??''),facts.length,fact.n,row.kind==='memory_context'?fact.time??null:undefined);
    if(line===null)await countMemoryStep(this.control,'source_tags',false);
    const named=shown(fact),listed=named.slice(0,openedSources);
    const tags=await this.tags.tags(principal,current.binding,listed,{historical:true,place:fact.place===true});
    const sources=listed.flatMap(reference=>{const tag=tags.get(reference.id);return tag?[sourceOf(tag,fact.place)]:[];});
    const text=line===null?null:cutText(line,openedText);
    if(text!==null)await this.prepared.allow(principal,text);
    await this.current(space);await this.prepared.audience.assert(principal);
    return {source:'nocheh:memory:'+recordId,fact:fact.n,...text!==null?{text}:{},exact:fact.exact===true,by:fact.by,
      at:listed.length?tags.get(listed[0]!.id)?.at??null:null,sources,more:Math.max(0,named.length-sources.length),
      ...text===null?{limitations:['fact_text_unavailable']}:{}};
  }
  /** Whether the forwards-and-files participant wrote something done in these sessions (null: the whole space) that rests
   * on a message other than this turn's own, so a question is never answered from itself alone. */
  private async materialLearned(workspace:string,sessions:string[]|null,turnSource?:string):Promise<boolean> {
    return !!(await this.control.query(`SELECT 1 FROM memory_ingestion_receipts r WHERE r.generation=$1 AND r.state='done' AND r.retired_at IS NULL
      AND r.peer_id=$2 AND ($3::text[] IS NULL OR r.session_id=ANY($3::text[])) AND ($4::text IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_array_length(r.source_references)>0 THEN r.source_references
          ELSE jsonb_build_array(r.source_reference) END) evidence(value) WHERE evidence.value->>'id'<>$4)) LIMIT 1`,
      [workspace,materialPeer,sessions,turnSource??null])).rowCount;
  }
  /** Archived messages the engine finds by meaning among what was learned for this audience, best first.
   * Only their ids leave here: the reader gets the messages back through the archive's own access check. */
  /** Archived messages by meaning, in the engine's order. `from` says, for each id, the receipt it came from and its
   *  position among that receipt's references, so the first few of each can be named (ADR-0261). */
  async search(principal:Reader,query:string,count:number):Promise<{ids:string[];learned:boolean;syncing?:boolean;from?:{receipt:string;position:number}[]}> {
    string(query,2000);if(!query.trim())throw new HttpError(400,'empty_query');
    const binding=await this.prepared.audience.assert(principal),workspace=await this.workspace(binding);
    if(!workspace)return {ids:[],learned:false};
    const current=await this.current(workspace.id),id=current.row.id,actor=principal.admin?current.principal:principal;
    const audience=principal.admin?'owner':this.principalAudience(principal),group=this.recallGroup(principal);
    // A bound reader searches the sessions of every group of its bound reads, and no other (ADR-0249): a member's own
    // private chat and an asked member's chat are never learned, so they have none (step 4).
    const set=!principal.admin&&boundReader(principal)!==null?this.contexts.access.reads(principal)!:null,reads=set?readSetParam(set):null;
    // A group searches inside the wall of the chats its recall reads, and a bound reader (a member's private chat and its
    // schedules, a private answer) inside the wall of its read set's groups (ADR-0286). The owner searches everything.
    const chats=set?readSetIds(set):audience==='owner'?[]:group?[...group,audience]:[audience];
    const walled=chats.length?await this.walls.open(id,chats):null;
    const sessions=set?await this.provenance.readSetSessions(id,set,1000):audience==='owner'?null:walled?walled.sessions:await this.provenance.sessions(id,audience,1000,group);
    if(sessions?.length===0)return {ids:[],learned:false};
    // The question is checked for secrets before it reaches the engine, as a recall question is.
    const question=await this.prepared.prepare(actor,query,this.detect);
    const found=await this.engine.search(id,String(question),{limit:Math.min(50,count*3),sessions,...walled?{wall:walled.wall}:{}});
    const ids:string[]=[],from:{receipt:string;position:number}[]=[];
    for(const message of found.slice(0,50)) {
      if(!engineId(message.id)||!/^[a-f0-9]{64}$/.test(message.receipt))continue;
      const row=(await this.control.query(`SELECT source_reference,source_references FROM memory_ingestion_receipts
        WHERE id=$1 AND generation=$2 AND remote_id=$3 AND state='done' AND retired_at IS NULL
        AND (CASE WHEN $6::text[] IS NOT NULL THEN ${readSetSql('audience',6)} ELSE ($4::text='owner' OR ${recallCondition('audience','$4','$5')}) END)`,
        [message.receipt,id,message.id,audience,group,reads])).rows[0];
      if(!row)continue;
      for(const [position,reference] of (row.source_references?.length?row.source_references:[row.source_reference]).slice(0,30).entries())
        if(typeof reference?.id==='string'&&/^[a-f0-9]{64}$/.test(reference.id)&&!ids.includes(reference.id)){ids.push(reference.id);from.push({receipt:message.receipt,position});}
    }
    await this.current(id);await this.prepared.audience.assert(principal);
    return {ids,learned:true,...(current.row.state==='building'?{syncing:true}:{}),from};
  }
}
