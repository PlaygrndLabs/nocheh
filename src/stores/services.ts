import {boundReader,type Reader} from '../access.js';
import {OwnerAutonomyRepository} from './owner-autonomy.js';
import {NotionRepository} from './notion.js';
import {ChatToolSettingsRepository} from './chat-tools.js';
import {TaskRepository,type TaskActor,type TaskView} from './tasks.js';
import {readSet,readSetGroups,readSetOf,recallScope,servedGroups} from '../spaces.js';
import {PromptRepository} from '../prompts.js';
import {TelegramChatRepository} from './telegram-chats.js';
import {TelegramTopicRepository} from './telegram-topics.js';
import {ownerChat,settleTelegramChat,type AssistantPolicy} from '../assistant-policy.js';
import type {RuntimeCall} from '../runtime.js';
import {groupReplies,type GroupReplies} from '../telegram-addressing.js';
import type {Brain} from '../brain/brain.js';
import type {MemoryEngine} from '../memory/engine.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository} from './archive.js';
import {OperationRepository} from './operations.js';
import {DerivedRepository} from './derived.js';
import {GeneratedCaptureRepository} from './generated-capture.js';
import {CaptureCoordinator} from './capture.js';
import {GuardRepository} from './guards.js';
import {AttachmentRepository} from './attachments.js';
import {SelectionRepository} from './selections.js';
import {ReprocessingRepository,archivedVoice,documentExtraction,voiceTranscription,type DerivationEngine} from './reprocessing.js';
import {PreparationRepository} from './preparation.js';
import {SourceAccessRepository} from './access.js';
import {SourceRepository} from './retrieval.js';
import {ProjectRepository,SharingPolicyRepository} from './projects.js';
import {LearnedMemoryRepository} from './learned.js';
import {LearningContextRepository} from './learning-context.js';
import {ContextualLearningRepository} from './learning-engine.js';
import {MemoryProvenanceRepository} from './memory-provenance.js';
import {PreparedContextRepository} from './prepared-context.js';
import {HttpError} from '../http.js';
import {RuntimeTurnRepository} from './turns.js';
import {NativeMemoryRepository} from './native-memory.js';
import {OwnerOriginals} from './owner-originals.js';
import {MemoryDashboard} from './memory-dashboard.js';
import {NativeReviewRepository} from './native-review.js';
import {SharingContentRepository} from './sharing.js';
import {ImportRepository} from './imports.js';
import {LegacyImportRepository} from './legacy-import.js';
import {SourcePortabilityRepository} from './source-portability.js';
import {DerivativePortabilityRepository} from './derivative-portability.js';
import {OwnerPortabilityRepository} from './owner-portability.js';
import {RuntimeConfigurationRepository} from './runtime-configuration.js';
import {TelegramActionRepository} from './telegram-actions.js';
import {TelegramDispatchRepository} from './telegram-dispatch.js';
import {ActionContinuationRepository} from './action-continuations.js';
import {ControlledActionRepository} from './controlled-actions.js';
import {ControlledExecutionRepository} from './controlled-execution.js';
import {ActionCommandRepository} from './action-commands.js';
import {BrowserCaptureRepository} from './browser-capture.js';
import {BrowserRunRepository} from './browser-runs.js';
import {BrowserDeliveryRepository} from './browser-delivery.js';
import {ScheduledRunRepository} from './scheduled-runs.js';
import {ScheduleRepository} from './schedules.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';
import {EntityRepository} from './entities.js';
import {MemoryAccessRepository} from './memory-access.js';
import {MemoryMapRepository} from './memory-map.js';
import {SourceRetirementRepository} from './source-retirement.js';
import {ReactionStateRepository} from './reaction-state.js';
import {KnowledgeManagementRepository} from './knowledge-management.js';
import {OwnerSupervisionRepository} from './owner-supervision.js';
import {NoteSourceRepository} from './note-sources.js';
import {SourceTagRepository} from './source-tags.js';
import {BackgroundJobRepository} from './background-jobs.js';
import {MachineRepository} from './machines.js';
import {ChatSendRepository} from './chat-sends.js';
import {PrivateAnswerRepository} from './private-answers.js';
import {OwnerMemberAskRepository} from './owner-member-asks.js';
import {OwnerMemberAskTurns} from './owner-member-ask-turns.js';
import {ChatRepository} from './chats.js';
import {ChatAdds} from './chat-adds.js';
import {accountIdFor,chats as chatDirectory} from '../chats.js';
import {freshMembers} from '../members.js';
import type {MemberRepository} from './member-api.js';
import {Members} from './members.js';

/** The same explicit repository composition is used by HTTP, workers and fixtures. */
export function storageServices(stores:StorePools,options:{dataDir:string;detectorVersion:string;policy:()=>AssistantPolicy;
  runtime:RuntimeCall;brain:Brain;memoryEngine:MemoryEngine;transcription?:DerivationEngine;serviceToken?:string;
  /** When groups get replies; the owner's setting from the environment unless given. */
  groupReplies?:GroupReplies}) {
  const archive=new ArchiveRepository(stores.archive),operations=new OperationRepository(stores.control),derived=new DerivedRepository(stores.derived,archive,operations);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),attachments=new AttachmentRepository(stores,archive,options.dataDir);
  const transcription=options.transcription??voiceTranscription(options.runtime),extraction=documentExtraction(options.runtime);
  // Voice notes archived before transcription was set up keep their readings; an earlier request still completes.
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,options.dataDir,[transcription,extraction,...(options.transcription?[]:[archivedVoice()])]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction);
  const retirements=new SourceRetirementRepository(stores,archive);
  const reactions=new ReactionStateRepository(archive,stores.control);
  const access=new SourceAccessRepository(stores,archive,guards,options.policy,retirements,reactions);
  const prepared=new PreparedContextRepository(derived,guards,async(principal,binding)=>{
    try {
      const captured=await archive.captured(principal.turnEvent!),source=captured.reference;
      // The turn's chat as another process recorded it a moment ago (a served group's new Telegram id after an upgrade):
      // this process, the security service included, reads it once its chat directory has looked again (ADR-0252).
      await settleTelegramChat(captured);
      if(!await access.canRead(principal,source,binding))throw new HttpError(403,'turn_source_denied');return source;
    } catch(error) {if(!(error instanceof HttpError)||error.code!=='source_not_found')throw error;}
    const operation=(await stores.control.query("SELECT * FROM content_operations WHERE id=$1 AND kind IN ('scheduled_trigger','background_run')",[principal.turnEvent])).rows[0];
    if(!operation||operation.scope!==principal.space)throw new HttpError(403,'turn_source_denied');
    const reference={store:'control' as const,kind:'operation' as const,id:operation.id,generation:operation.generation,input_hash:operation.input_hash};
    await operations.verify(reference);return reference;
  },options.detectorVersion);
  // One reader of where messages and notes came from, for reviews, Hermes's lookups, the Notes page, recall and Honcho.
  const noteSources=new NoteSourceRepository(stores,options.policy,access);
  const projects=new ProjectRepository(stores.control,servedGroups),entities=new EntityRepository(stores,access,projects,noteSources),sharing=new SharingPolicyRepository(stores.control),learned=new LearnedMemoryRepository(stores,archive,derived,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects,entities),provenance=new MemoryProvenanceRepository(stores,archive,guards,options.memoryEngine);
  // Background learning marks its checks so reply checks get detector slots first.
  const detect=async(text:string,background=false)=>(await options.runtime('guard.detect',background?{text,priority:'background'}:{text})).literals;
  // Who · where · when for a search hit or an opened original, built by code and secret-checked together (ADR-0261).
  const tags=new SourceTagRepository(stores,access,noteSources,(principal,value,check)=>prepared.prepare(principal,value,check),detect,options.policy);
  const sources=new SourceRepository(access,attachments,selections,(principal,value)=>prepared.allow(principal,value),tags,learned);
  const turns=new RuntimeTurnRepository(access,prepared);
  // Nocheh's chat records (ADR-0252): what each captured Telegram original says of its chat, its topic and its people.
  const chats=new ChatRepository(stores,options.policy);
  const capture=new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(operations,derived),chats);
  // What is left to do once someone adds Nocheh to a group or removes it: leave, the card and the owner's notes (ADR-0253).
  const chatAdds=new ChatAdds(stores.control,options.policy,options.runtime,chats);
  const telegramActions=new TelegramActionRepository(stores,access,derived,guards,prepared,turns,options.runtime,detect);
  const memoryAccess=new MemoryAccessRepository(stores,access,derived,guards,prepared,entities,projects,telegramActions,detect);
  const memoryMap=new MemoryMapRepository(stores,memoryAccess);
  const ownerAutonomy=new OwnerAutonomyRepository(stores.control),notion=new NotionRepository(stores.control),prompts=new PromptRepository(stores.control,options.brain);
  const chatTools=new ChatToolSettingsRepository(stores.control,()=>ownerChat(options.policy()));
  const telegramTopics=new TelegramTopicRepository(stores.control);
  const telegramChats=new TelegramChatRepository(stores.control,options.runtime,chats);
  // Answer privately records: who asked, where, and the groups frozen at the tap (ADR-0249).
  const privateAnswers=new PrivateAnswerRepository(stores.control,options.policy);
  const controlledActions=new ControlledActionRepository(access,derived,guards,prepared,turns,detect);

  const schedules=new ScheduleRepository(access,derived,options.detectorVersion,detect);
  const sourcePortability=new SourcePortabilityRepository(capture,attachments),derivativePortability=new DerivativePortabilityRepository(stores,archive);
  const browserDelivery=new BrowserDeliveryRepository(options.dataDir,options.serviceToken??'');
  const memory=new NativeMemoryRepository(contexts,derived,prepared,provenance,options.memoryEngine,detect,noteSources,tags);
  // The owner's dashboard names original messages in the owner's words, a retired one only as retired (ADR-0261 step 4).
  const originals=new OwnerOriginals(stores.control,noteSources,retirements),memoryDashboard=new MemoryDashboard(stores,memory,originals,options.policy);
  const shared=new SharingContentRepository(access,derived,prepared,selections,learned,sharing,options.runtime,detect,options.serviceToken??'');
  const knowledge=new KnowledgeManagementRepository({stores,access,derived,guards,prepared,turns,learned,projects,entities,sharing,shared,memoryAccess,selections,detect});
  // The owner's asks about a member (step 4b): recorded only from a live owner-private turn, answered by their own worker.
  const memberAsks=new OwnerMemberAskRepository(stores.control,stores.archive,options.policy,principal=>knowledge.ownerTurn(principal));
  // The owner's private chat reaches every list; a group or topic in a project only its own group's tasks and the project's.
  // Who wrote the message a group turn answers: the owner, or a member, by their Telegram name, with their account (a
  // chat_accounts id; null for the owner), which a reminder they set keeps (ADR-0255). A member is checked again here, at
  // each task call, against the member directory as of now (step 3): one paused, removed or switched off in this group
  // since the turn began gets 403 member_access_changed, so their turn in flight writes no task or reminder; a member
  // whose tasks are read only gets a read-only turn, which lists and reads but adds, changes, comments on and sets
  // reminders on nothing. Who sees which tasks is unchanged (ADR-0248).
  const sender=async(event:string,chat:string):Promise<{actor:TaskActor;account:string|null;readOnly?:true}>=>{
    const row=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    let from:any=null;try{const payload=JSON.parse(row.payload.toString());from=(payload.message??payload.edited_message)?.from;}catch{}
    if(from&&String(from.id)===options.policy().owner_id)return {actor:{kind:'owner'},account:null};
    const name=[from?.first_name,from?.last_name].filter(part=>typeof part==='string').join(' ').replace(/\s+/g,' ').trim().slice(0,100);
    let account:string|null=null;try{account=from?.id===undefined||from?.id===null?null:accountIdFor('telegram',String(from.id));}catch{}
    const directory=await freshMembers();
    if(!account||!directory.talks(account,chat,chatDirectory()))throw new HttpError(403,'member_access_changed');
    return {actor:name?{kind:'member',name}:{kind:'member'},account,...(directory.tasks(account)==='read'?{readOnly:true as const}:{})};
  };
  // A group or topic reaches its own group's tasks, with its topics' when they share what they know, and the tasks set
  // on its project itself; a task added there belongs to that group or topic (ADR-0248).
  const topicMemory=()=>options.policy().topic_memory??'group';
  // A member's private chat (D14): one view per active project assigned one of the groups bindReads resolved for this
  // request, reaching those groups (with their topics when topics share what they know). Groups in no project have no
  // tasks; a reader without its binding has no view.
  const memberTaskViews=async(principal:Reader):Promise<TaskView[]>=>{
    if(!principal.reads||!principal.memberChat)throw new HttpError(409,'member_chat_closed');
    const groups=readSetGroups(principal.reads);if(!groups.length)return [];
    const rows=(await stores.control.query<{group:string;project:string;name:string}>(`SELECT a.space_id AS group,p.id AS project,p.name FROM project_assignments a
      JOIN projects p ON p.id=a.project_id AND p.state='active' WHERE a.space_id=ANY($1::text[]) AND a.mode='assigned' ORDER BY p.id,a.space_id`,[groups])).rows;
    const byProject=new Map<string,{name:string;groups:string[]}>();
    for(const row of rows){const found=byProject.get(row.project)??{name:row.name,groups:[]};found.groups.push(row.group);byProject.set(row.project,found);}
    return [...byProject].map(([project,found])=>({project,name:found.name,
      reach:readSet({home:found.groups[0]!,project,...(topicMemory()==='group'?{whole:found.groups}:{exact:found.groups})})}));
  };
  // Who wrote in a member's private chat: that member, by their Telegram name, with their account (read only anyway).
  const privateSender=async(event:string):Promise<{actor:TaskActor;account:string|null}>=>{
    const row=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    let from:any=null;try{const payload=JSON.parse(row.payload.toString());from=(payload.message??payload.edited_message)?.from;}catch{}
    const name=[from?.first_name,from?.last_name].filter(part=>typeof part==='string').join(' ').replace(/\s+/g,' ').trim().slice(0,100);
    let account:string|null=null;try{account=from?.id===undefined||from?.id===null?null:accountIdFor('telegram',String(from.id));}catch{}
    return {actor:name?{kind:'member',name}:{kind:'member'},account};
  };
  // Send records for Health; a reminder Telegram refused or never confirmed is recorded here too (ADR-0255).
  const chatSends=new ChatSendRepository(stores.control,chats);
  const tasks=new TaskRepository(stores.control,async principal=>{
    if(principal.scope===null)return {...await knowledge.ownerTurn(principal),project:null,group:null,actor:{kind:'owner'}};
    const kind=boundReader(principal);
    // The owner's ask about a member reads only that member's chat: no task list (step 4b).
    if(kind==='memberRead')throw new HttpError(403,'task_project_required');
    const {source}=await knowledge.liveGroupTurn(principal);
    // A member's private chat reads, and only reads, the tasks of each active project that holds one of their joined
    // groups, one view per project reaching only those groups; never every list (D14).
    if(kind==='member')return {source,project:null,group:null,views:await memberTaskViews(principal),...await privateSender(source.reference.id),readOnly:true};
    // An "Answer privately" answer reads only the tasks of the groups frozen in its record and of their project
    // itself, as the server bound them for this request, and changes nothing (ADR-0248, ADR-0249).
    if(kind==='answer'){
      const reads=principal.reads,project=reads?.project?(await stores.control.query('SELECT state FROM projects WHERE id=$1',[reads.project])).rows[0]:null;
      if(!reads?.project||project?.state!=='active')throw new HttpError(403,'task_project_required');
      return {source,project:reads.project,group:null,reach:reads,...await sender(source.reference.id,principal.space!),readOnly:true};
    }
    const space=principal.space!,project=(await projects.effective(space)).project;
    if(!project||project.state!=='active')throw new HttpError(403,'task_project_required');
    return {source,project:project.id,group:space,reach:principal.reads??readSetOf(recallScope(space,topicMemory()),project.id),...await sender(source.reference.id,space)};
  },{call:options.runtime,owner:()=>ownerChat(options.policy()),policy:options.policy,record:send=>chatSends.recordLocal(send)},topicMemory);
  const jobs=new BackgroundJobRepository(access,derived,prepared,turns,sources,telegramActions,options.runtime,options.brain,detect,options.serviceToken??'');
  const actionCommands=new ActionCommandRepository(access,telegramActions,controlledActions,options.runtime,jobs,tasks,privateAnswers,chatAdds),machines=new MachineRepository(access,jobs);
  const controlledExecution=new ControlledExecutionRepository(controlledActions);
  // A card edit is best effort: a job or an operation never fails because its card could not be updated.
  jobs.settled=id=>actionCommands.settle('background',id).then(()=>{},()=>{});
  jobs.stopped=async id=>{await controlledActions.stopJob(id);};
  controlledExecution.settled=id=>actionCommands.settle('controlled',id).then(()=>{},()=>{});
  const supervision=new OwnerSupervisionRepository({stores,projects,controlledActions,telegramActions,memory,knowledge,shared,chats,memoryAccess});
  // Voice notes saved before a transcription provider was chosen are transcribed once one is.
  const voices={transcribe:()=>preparation.transcribeArchived(async()=>(await options.runtime('voice.transcribe',{check:true},10000)).configured===true)};
  // The owner's Members routes (step 3, src/stores/member-api.ts).
  const members:MemberRepository=new Members(stores.control,options.policy);
  return {brain:options.brain,chats,chatAdds,members,jobs,machines,ownerAutonomy,notion,chatTools,tasks,prompts,telegramChats,telegramTopics,stores,archive,operations,derived,guards,selections,attachments,reprocessing,preparation,voices,prepared,turns,access,retirements,reactions,sources,projects,entities,sharing,learned,contexts,provenance,
    configuration:new RuntimeConfigurationRepository(stores.control),
    browserCapture:new BrowserCaptureRepository(options.dataDir,options.policy),
    browserDelivery,
    schedules,scheduled:new ScheduledRunRepository(access,derived,turns,options.serviceToken??'',options.brain,schedules,telegramActions),
    runtimeProfiles:new RuntimeProfileRepository(access),
    browser:new BrowserRunRepository(access,sources,derived,preparation,turns,options.serviceToken??'',options.brain,browserDelivery),
    controlledActions,controlledExecution,memoryAccess,memoryMap,
    chatSends,
    privateAnswers,
    telegramActions,actionCommands,telegram:new TelegramDispatchRepository(archive,access,sources,derived,guards,preparation,prepared,turns,actionCommands,memoryAccess,options.runtime,options.brain,options.serviceToken??'',detect,options.groupReplies??groupReplies(process.env),privateAnswers),
    continuations:new ActionContinuationRepository(archive,access,derived,guards,prepared,turns,options.brain,options.serviceToken??'',options.runtime),
    memberAsks,memberAskTurns:new OwnerMemberAskTurns(memberAsks,archive,access,derived,guards,prepared,turns,options.brain,options.serviceToken??'',options.runtime),
    capture,sourcePortability,imports:new ImportRepository(sourcePortability,access,{call:options.runtime,owner:()=>ownerChat(options.policy())}),derivativePortability,ownerPortability:new OwnerPortabilityRepository(stores),legacyImports:new LegacyImportRepository(sourcePortability,derivativePortability),
    learning:new ContextualLearningRepository(contexts,derived,guards,learned,provenance,options.memoryEngine),
    memory,knowledge,supervision,originals,memoryDashboard,
    reviews:new NativeReviewRepository(contexts,derived,prepared,turns,options.brain,options.serviceToken??'',noteSources),noteSources,tags,
    shared,
    detectorVersion:options.detectorVersion,detect};
}
export type StorageServices=ReturnType<typeof storageServices>;
