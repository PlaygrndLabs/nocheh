import {OwnerAutonomyRepository} from './owner-autonomy.js';
import {NotionRepository} from './notion.js';
import {ChatToolSettingsRepository} from './chat-tools.js';
import {TaskRepository,type TaskActor} from './tasks.js';
import {readSetOf,recallScope} from '../spaces.js';
import {PromptRepository} from '../prompts.js';
import {TelegramChatRepository} from './telegram-chats.js';
import {TelegramTopicRepository} from './telegram-topics.js';
import type {AssistantPolicy} from '../assistant-policy.js';
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
import {BackgroundJobRepository} from './background-jobs.js';
import {MachineRepository} from './machines.js';
import {ChatSendRepository} from './chat-sends.js';
import {PrivateAnswerRepository} from './private-answers.js';

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
      const source=(await archive.captured(principal.turnEvent!)).reference;
      if(!await access.canRead(principal,source,binding))throw new HttpError(403,'turn_source_denied');return source;
    } catch(error) {if(!(error instanceof HttpError)||error.code!=='source_not_found')throw error;}
    const operation=(await stores.control.query("SELECT * FROM content_operations WHERE id=$1 AND kind IN ('scheduled_trigger','background_run')",[principal.turnEvent])).rows[0];
    if(!operation||operation.scope!==principal.space)throw new HttpError(403,'turn_source_denied');
    const reference={store:'control' as const,kind:'operation' as const,id:operation.id,generation:operation.generation,input_hash:operation.input_hash};
    await operations.verify(reference);return reference;
  },options.detectorVersion);
  const sources=new SourceRepository(access,attachments,selections,(principal,value)=>prepared.allow(principal,value));
  const projects=new ProjectRepository(stores.control),entities=new EntityRepository(stores,access,projects),sharing=new SharingPolicyRepository(stores.control),learned=new LearnedMemoryRepository(stores,archive,derived,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects,entities),provenance=new MemoryProvenanceRepository(stores,archive,guards,options.memoryEngine);
  // Background learning marks its checks so reply checks get detector slots first.
  const detect=async(text:string,background=false)=>(await options.runtime('guard.detect',background?{text,priority:'background'}:{text})).literals;
  const turns=new RuntimeTurnRepository(access,prepared);
  const capture=new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(operations,derived));
  const telegramActions=new TelegramActionRepository(stores,access,derived,guards,prepared,turns,options.runtime,detect);
  const memoryAccess=new MemoryAccessRepository(stores,access,derived,guards,prepared,entities,projects,telegramActions,detect);
  const memoryMap=new MemoryMapRepository(stores,memoryAccess);
  const ownerAutonomy=new OwnerAutonomyRepository(stores.control),notion=new NotionRepository(stores.control),prompts=new PromptRepository(stores.control,options.brain);
  const chatTools=new ChatToolSettingsRepository(stores.control,()=>options.policy().owner_id);
  const telegramTopics=new TelegramTopicRepository(stores.control);
  const telegramChats=new TelegramChatRepository(stores.control,options.runtime,()=>options.policy().group_ids??[]);
  // Answer privately records: who asked, where, and the groups frozen at the tap (ADR-0248).
  const privateAnswers=new PrivateAnswerRepository(stores.control,options.policy);
  const controlledActions=new ControlledActionRepository(access,derived,guards,prepared,turns,detect);

  const schedules=new ScheduleRepository(access,derived,options.detectorVersion,detect);
  const sourcePortability=new SourcePortabilityRepository(capture,attachments),derivativePortability=new DerivativePortabilityRepository(stores,archive);
  const browserDelivery=new BrowserDeliveryRepository(options.dataDir,options.serviceToken??'');
  const memory=new NativeMemoryRepository(contexts,derived,prepared,provenance,options.memoryEngine,detect);
  const shared=new SharingContentRepository(access,derived,prepared,selections,learned,sharing,options.runtime,detect,options.serviceToken??'');
  const knowledge=new KnowledgeManagementRepository({stores,access,derived,guards,prepared,turns,learned,projects,entities,sharing,shared,memoryAccess,selections,detect});
  // The owner's private chat reaches every list; a project's chat only that project's own list.
  // Who wrote the message a group turn answers: the owner, or a person allowed there, by their Telegram name.
  const sender=async(event:string):Promise<TaskActor>=>{
    const row=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[event])).rows[0];
    let from:any=null;try{const payload=JSON.parse(row.payload.toString());from=(payload.message??payload.edited_message)?.from;}catch{}
    if(from&&String(from.id)===options.policy().owner_id)return {kind:'owner'};
    const name=[from?.first_name,from?.last_name].filter(part=>typeof part==='string').join(' ').replace(/\s+/g,' ').trim().slice(0,100);
    return name?{kind:'member',name}:{kind:'member'};
  };
  // A group or topic reaches its own group's tasks, with its topics' when they share what they know, and the tasks set
  // on its project itself; a task added there belongs to that group or topic (ADR-0247).
  const topicMemory=()=>options.policy().topic_memory??'group';
  const tasks=new TaskRepository(stores.control,async principal=>{
    if(principal.scope===null)return {...await knowledge.ownerTurn(principal),project:null,group:null,actor:{kind:'owner'}};
    const {source}=await knowledge.liveGroupTurn(principal);
    // An "Answer privately" answer reads only the tasks of the groups frozen in its record and of their project
    // itself, as the server bound them for this request, and changes nothing (ADR-0247, ADR-0248).
    if(principal.answer!==undefined){
      const reads=principal.reads,project=reads?.project?(await stores.control.query('SELECT state FROM projects WHERE id=$1',[reads.project])).rows[0]:null;
      if(!reads?.project||project?.state!=='active')throw new HttpError(403,'task_project_required');
      return {source,project:reads.project,group:null,reach:reads,readOnly:true,actor:await sender(source.reference.id)};
    }
    const space=principal.space!,project=(await projects.effective(space)).project;
    if(!project||project.state!=='active')throw new HttpError(403,'task_project_required');
    return {source,project:project.id,group:space,reach:principal.reads??readSetOf(recallScope(space,topicMemory()),project.id),actor:await sender(source.reference.id)};
  },{call:options.runtime,owner:()=>options.policy().owner_id},topicMemory);
  const jobs=new BackgroundJobRepository(access,derived,prepared,turns,sources,telegramActions,options.runtime,options.brain,detect,options.serviceToken??'');
  const actionCommands=new ActionCommandRepository(access,telegramActions,controlledActions,options.runtime,jobs,tasks),machines=new MachineRepository(access,jobs);
  const controlledExecution=new ControlledExecutionRepository(controlledActions);
  // A card edit is best effort: a job or an operation never fails because its card could not be updated.
  jobs.settled=id=>actionCommands.settle('background',id).then(()=>{},()=>{});
  jobs.stopped=async id=>{await controlledActions.stopJob(id);};
  controlledExecution.settled=id=>actionCommands.settle('controlled',id).then(()=>{},()=>{});
  const supervision=new OwnerSupervisionRepository({stores,projects,controlledActions,telegramActions,memory,knowledge,shared,telegramChats,telegramTopics,memoryAccess});
  // Voice notes saved before a transcription provider was chosen are transcribed once one is.
  const voices={transcribe:()=>preparation.transcribeArchived(async()=>(await options.runtime('voice.transcribe',{check:true},10000)).configured===true)};
  return {brain:options.brain,jobs,machines,ownerAutonomy,notion,chatTools,tasks,prompts,telegramChats,telegramTopics,stores,archive,operations,derived,guards,selections,attachments,reprocessing,preparation,voices,prepared,turns,access,retirements,reactions,sources,projects,entities,sharing,learned,contexts,provenance,
    configuration:new RuntimeConfigurationRepository(stores.control),
    browserCapture:new BrowserCaptureRepository(options.dataDir,options.policy),
    browserDelivery,
    schedules,scheduled:new ScheduledRunRepository(access,derived,turns,options.serviceToken??'',options.brain,schedules,telegramActions),
    runtimeProfiles:new RuntimeProfileRepository(access),
    browser:new BrowserRunRepository(access,sources,derived,preparation,turns,options.serviceToken??'',options.brain,browserDelivery),
    controlledActions,controlledExecution,memoryAccess,memoryMap,
    chatSends:new ChatSendRepository(stores.control,stores.archive),
    privateAnswers,
    telegramActions,actionCommands,telegram:new TelegramDispatchRepository(archive,access,sources,derived,guards,preparation,prepared,turns,actionCommands,memoryAccess,options.runtime,options.brain,options.serviceToken??'',detect,options.groupReplies??groupReplies(process.env)),
    continuations:new ActionContinuationRepository(archive,access,derived,guards,prepared,turns,options.brain,options.serviceToken??'',options.runtime),
    capture,sourcePortability,imports:new ImportRepository(sourcePortability,access,{call:options.runtime,owner:()=>options.policy().owner_id}),derivativePortability,ownerPortability:new OwnerPortabilityRepository(stores),legacyImports:new LegacyImportRepository(sourcePortability,derivativePortability),
    learning:new ContextualLearningRepository(contexts,derived,guards,learned,provenance,options.memoryEngine),
    memory,knowledge,supervision,
    reviews:new NativeReviewRepository(contexts,derived,prepared,turns,options.brain,options.serviceToken??''),
    shared,
    detectorVersion:options.detectorVersion,detect};
}
export type StorageServices=ReturnType<typeof storageServices>;
