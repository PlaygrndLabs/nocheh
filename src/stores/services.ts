import {OwnerAutonomyRepository} from './owner-autonomy.js';
import {NotionRepository} from './notion.js';
import {ChatToolSettingsRepository} from './chat-tools.js';
import {TaskRepository,type TaskActor} from './tasks.js';
import {readSetOf,recallScope,servedGroups} from '../spaces.js';
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
import {BackgroundJobRepository} from './background-jobs.js';
import {MachineRepository} from './machines.js';
import {ChatSendRepository} from './chat-sends.js';
import {PrivateAnswerRepository} from './private-answers.js';
import {ChatRepository} from './chats.js';
import {accountIdFor} from '../chats.js';

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
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction,options.policy);
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
  const sources=new SourceRepository(access,attachments,selections,(principal,value)=>prepared.allow(principal,value));
  // One reader of where messages and notes came from, for reviews, Hermes's lookups, the Notes page, recall and Honcho.
  const noteSources=new NoteSourceRepository(stores,options.policy,access);
  const projects=new ProjectRepository(stores.control,servedGroups),entities=new EntityRepository(stores,access,projects,noteSources),sharing=new SharingPolicyRepository(stores.control),learned=new LearnedMemoryRepository(stores,archive,derived,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects,entities),provenance=new MemoryProvenanceRepository(stores,archive,guards,options.memoryEngine);
  // Background learning marks its checks so reply checks get detector slots first.
  const detect=async(text:string,background=false)=>(await options.runtime('guard.detect',background?{text,priority:'background'}:{text})).literals;
  const turns=new RuntimeTurnRepository(access,prepared);
  // Nocheh's chat records (ADR-0252): what each captured Telegram original says of its chat, its topic and its people.
  const chats=new ChatRepository(stores,options.policy);
  const capture=new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(operations,derived),chats);
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
  const memory=new NativeMemoryRepository(contexts,derived,prepared,provenance,options.memoryEngine,detect,noteSources);
  const shared=new SharingContentRepository(access,derived,prepared,selections,learned,sharing,options.runtime,detect,options.serviceToken??'');
  const knowledge=new KnowledgeManagementRepository({stores,access,derived,guards,prepared,turns,learned,projects,entities,sharing,shared,memoryAccess,selections,detect});
  // The owner's private chat reaches every list; a group or topic in a project only its own group's tasks and the project's.
  // Who wrote the message a group turn answers: the owner, or a person allowed there, by their Telegram name, with their
  // account (a chat_accounts id; null for the owner, or when it cannot be told), which a reminder they set keeps (ADR-0255).
  const sender=async(event:string):Promise<{actor:TaskActor;account:string|null}>=>{
    const row=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    let from:any=null;try{const payload=JSON.parse(row.payload.toString());from=(payload.message??payload.edited_message)?.from;}catch{}
    if(from&&String(from.id)===options.policy().owner_id)return {actor:{kind:'owner'},account:null};
    const name=[from?.first_name,from?.last_name].filter(part=>typeof part==='string').join(' ').replace(/\s+/g,' ').trim().slice(0,100);
    let account:string|null=null;try{account=from?.id===undefined||from?.id===null?null:accountIdFor('telegram',String(from.id));}catch{}
    return {actor:name?{kind:'member',name}:{kind:'member'},account};
  };
  // A group or topic reaches its own group's tasks, with its topics' when they share what they know, and the tasks set
  // on its project itself; a task added there belongs to that group or topic (ADR-0248).
  const topicMemory=()=>options.policy().topic_memory??'group';
  // Send records for Health; a reminder Telegram refused or never confirmed is recorded here too (ADR-0255).
  const chatSends=new ChatSendRepository(stores.control,chats);
  const tasks=new TaskRepository(stores.control,async principal=>{
    if(principal.scope===null)return {...await knowledge.ownerTurn(principal),project:null,group:null,actor:{kind:'owner'}};
    const {source}=await knowledge.liveGroupTurn(principal);
    // An "Answer privately" answer reads only the tasks of the groups frozen in its record and of their project
    // itself, as the server bound them for this request, and changes nothing (ADR-0248, ADR-0249).
    if(principal.answer!==undefined){
      const reads=principal.reads,project=reads?.project?(await stores.control.query('SELECT state FROM projects WHERE id=$1',[reads.project])).rows[0]:null;
      if(!reads?.project||project?.state!=='active')throw new HttpError(403,'task_project_required');
      return {source,project:reads.project,group:null,reach:reads,readOnly:true,...await sender(source.reference.id)};
    }
    const space=principal.space!,project=(await projects.effective(space)).project;
    if(!project||project.state!=='active')throw new HttpError(403,'task_project_required');
    return {source,project:project.id,group:space,reach:principal.reads??readSetOf(recallScope(space,topicMemory()),project.id),...await sender(source.reference.id)};
  },{call:options.runtime,owner:()=>ownerChat(options.policy()),policy:options.policy,record:send=>chatSends.recordLocal(send)},topicMemory);
  const jobs=new BackgroundJobRepository(access,derived,prepared,turns,sources,telegramActions,options.runtime,options.brain,detect,options.serviceToken??'');
  const actionCommands=new ActionCommandRepository(access,telegramActions,controlledActions,options.runtime,jobs,tasks,privateAnswers),machines=new MachineRepository(access,jobs);
  const controlledExecution=new ControlledExecutionRepository(controlledActions);
  // A card edit is best effort: a job or an operation never fails because its card could not be updated.
  jobs.settled=id=>actionCommands.settle('background',id).then(()=>{},()=>{});
  jobs.stopped=async id=>{await controlledActions.stopJob(id);};
  controlledExecution.settled=id=>actionCommands.settle('controlled',id).then(()=>{},()=>{});
  const supervision=new OwnerSupervisionRepository({stores,projects,controlledActions,telegramActions,memory,knowledge,shared,chats,memoryAccess});
  // Voice notes saved before a transcription provider was chosen are transcribed once one is.
  const voices={transcribe:()=>preparation.transcribeArchived(async()=>(await options.runtime('voice.transcribe',{check:true},10000)).configured===true)};
  return {brain:options.brain,chats,jobs,machines,ownerAutonomy,notion,chatTools,tasks,prompts,telegramChats,telegramTopics,stores,archive,operations,derived,guards,selections,attachments,reprocessing,preparation,voices,prepared,turns,access,retirements,reactions,sources,projects,entities,sharing,learned,contexts,provenance,
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
    capture,sourcePortability,imports:new ImportRepository(sourcePortability,access,{call:options.runtime,owner:()=>ownerChat(options.policy())}),derivativePortability,ownerPortability:new OwnerPortabilityRepository(stores),legacyImports:new LegacyImportRepository(sourcePortability,derivativePortability),
    learning:new ContextualLearningRepository(contexts,derived,guards,learned,provenance,options.memoryEngine),
    memory,knowledge,supervision,
    reviews:new NativeReviewRepository(contexts,derived,prepared,turns,options.brain,options.serviceToken??'',noteSources),noteSources,
    shared,
    detectorVersion:options.detectorVersion,detect};
}
export type StorageServices=ReturnType<typeof storageServices>;
