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

/** The same explicit repository composition is used by HTTP, workers and fixtures. */
export function storageServices(stores:StorePools,options:{dataDir:string;detectorVersion:string;policy:()=>AssistantPolicy;
  runtime:RuntimeCall;honcho:HonchoCall;transcription?:DerivationEngine}) {
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
  return {stores,archive,operations,derived,guards,selections,attachments,reprocessing,preparation,prepared,turns:new RuntimeTurnRepository(access,prepared),access,sources,projects,sharing,learned,contexts,provenance,
    capture:new CaptureCoordinator(archive,stores.control,new GeneratedCaptureRepository(operations,derived)),
    learning:new ContextualLearningRepository(contexts,derived,guards,learned,provenance,options.honcho),
    detectorVersion:options.detectorVersion,detect:async(text:string)=>(await options.runtime('guard.detect',{text})).literals};
}
export type StorageServices=ReturnType<typeof storageServices>;
