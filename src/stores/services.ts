import type {AssistantPolicy} from '../assistant-policy.js';
import type {RuntimeCall} from '../runtime.js';
import type {HonchoCall} from '../honcho.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository} from './archive.js';
import {OperationRepository} from './operations.js';
import {DerivedRepository} from './derived.js';
import {GeneratedCaptureRepository} from './generated-capture.js';
import {CaptureCoordinator} from './capture.js';
import {GuardRepository} from './guards.js';
import {AttachmentRepository} from './attachments.js';
import {SelectionRepository} from './selections.js';
import {ReprocessingRepository,subscriptionTranscription,utf8Extraction,type DerivationEngine} from './reprocessing.js';
import {PreparationRepository} from './preparation.js';
import {SourceAccessRepository} from './access.js';
import {SourceRepository} from './retrieval.js';
import {ProjectRepository,SharingPolicyRepository} from './projects.js';
import {LearnedMemoryRepository} from './learned.js';
import {LearningContextRepository} from './learning-context.js';
import {ContextualLearningRepository} from './learning-engine.js';
import {HonchoProvenanceRepository} from './honcho-provenance.js';
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
import {RuntimeConfigurationRepository} from './runtime-configuration.js';
import {TelegramActionRepository} from './telegram-actions.js';
import {TelegramDispatchRepository} from './telegram-dispatch.js';
import {ControlledActionRepository} from './controlled-actions.js';
import {ControlledExecutionRepository} from './controlled-execution.js';
import {ActionCommandRepository} from './action-commands.js';
import {BrowserCaptureRepository} from './browser-capture.js';
import {BrowserRunRepository} from './browser-runs.js';
import {BrowserDeliveryRepository} from './browser-delivery.js';
import {ScheduledRunRepository} from './scheduled-runs.js';
import {ScheduleRepository} from './schedules.js';
import {RuntimeProfileRepository} from './runtime-profiles.js';

/** The same explicit repository composition is used by HTTP, workers and fixtures. */
export function storageServices(stores:StorePools,options:{dataDir:string;detectorVersion:string;policy:()=>AssistantPolicy;
  runtime:RuntimeCall;honcho:HonchoCall;transcription?:DerivationEngine;serviceToken?:string}) {
  const archive=new ArchiveRepository(stores.archive),operations=new OperationRepository(stores.control),derived=new DerivedRepository(stores.derived,archive,operations);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),attachments=new AttachmentRepository(stores,archive,options.dataDir);
  const transcription=options.transcription??subscriptionTranscription(options.runtime),extraction=utf8Extraction();
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,options.dataDir,[transcription,extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction);
  const access=new SourceAccessRepository(stores,archive,guards,options.policy);
  const prepared=new PreparedContextRepository(derived,guards,async(principal,binding)=>{
    try {
      const source=(await archive.captured(principal.turnEvent!)).reference;
      if(!await access.canRead(principal,source,binding))throw new HttpError(403,'turn_source_denied');return source;
    } catch(error) {if(!(error instanceof HttpError)||error.code!=='source_not_found')throw error;}
    const operation=(await stores.control.query("SELECT * FROM content_operations WHERE id=$1 AND kind='scheduled_trigger'",[principal.turnEvent])).rows[0];
    if(!operation||operation.scope!==principal.space)throw new HttpError(403,'turn_source_denied');
    const reference={store:'control' as const,kind:'operation' as const,id:operation.id,generation:operation.generation,input_hash:operation.input_hash};
    await operations.verify(reference);return reference;
  },options.detectorVersion);
  const sources=new SourceRepository(access,attachments,selections,(principal,value)=>prepared.allow(principal,value));
  const projects=new ProjectRepository(stores.control),sharing=new SharingPolicyRepository(stores.control),learned=new LearnedMemoryRepository(stores,archive,derived,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects),provenance=new HonchoProvenanceRepository(stores,archive,guards,options.honcho);
  const detect=async(text:string)=>(await options.runtime('guard.detect',{text})).literals;
  const turns=new RuntimeTurnRepository(access,prepared);
  const capture=new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(operations,derived));
  const telegramActions=new TelegramActionRepository(stores,access,derived,guards,prepared,turns,options.runtime,detect);
  const controlledActions=new ControlledActionRepository(access,derived,guards,prepared,turns,detect);
  const actionCommands=new ActionCommandRepository(access,telegramActions,controlledActions);
  const schedules=new ScheduleRepository(access,derived,options.detectorVersion,detect);
  const sourcePortability=new SourcePortabilityRepository(capture,attachments),derivativePortability=new DerivativePortabilityRepository(stores,archive);
  const browserDelivery=new BrowserDeliveryRepository(options.dataDir,options.serviceToken??'');
  return {stores,archive,operations,derived,guards,selections,attachments,reprocessing,preparation,prepared,turns,access,sources,projects,sharing,learned,contexts,provenance,
    configuration:new RuntimeConfigurationRepository(stores.control),
    browserCapture:new BrowserCaptureRepository(options.dataDir,options.policy),
    browserDelivery,
    schedules,scheduled:new ScheduledRunRepository(access,derived,turns,options.serviceToken??'',options.runtime,schedules,telegramActions),
    runtimeProfiles:new RuntimeProfileRepository(access),
    browser:new BrowserRunRepository(access,sources,derived,preparation,turns,options.serviceToken??'',options.runtime,browserDelivery),
    controlledActions,controlledExecution:new ControlledExecutionRepository(controlledActions),
    telegramActions,actionCommands,telegram:new TelegramDispatchRepository(archive,access,sources,derived,guards,preparation,prepared,turns,actionCommands,options.runtime,options.serviceToken??'',detect),
    capture,sourcePortability,imports:new ImportRepository(sourcePortability,access),derivativePortability,legacyImports:new LegacyImportRepository(sourcePortability,derivativePortability),
    learning:new ContextualLearningRepository(contexts,derived,guards,learned,provenance,options.honcho),
    memory:new NativeMemoryRepository(contexts,derived,prepared,provenance,options.honcho,detect),
    reviews:new NativeReviewRepository(contexts,derived,prepared,turns,options.runtime,options.serviceToken??''),
    shared:new SharingContentRepository(access,derived,prepared,selections,learned,sharing,options.runtime,detect,options.serviceToken??''),
    detectorVersion:options.detectorVersion,detect};
}
export type StorageServices=ReturnType<typeof storageServices>;
