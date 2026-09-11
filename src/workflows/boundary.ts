import {Middleware,NonRetriableError,RetryAfterError} from 'inngest';
import {families} from './store.js';

const states=new Set(['queued','waiting','running','retryable_failed','completed','failed','skipped','cancelled','ambiguous','denied','done','ready']);
const stages=new Set(['admission','attachments','transcription','preparation','assistant','delivery','import','review','sync','reconcile','browser','schedule','action']);
const reasons=new Set(['owner_paused','prerequisite','guard_pending','consent_required','approval_required','receipt_pending','runtime_unavailable','provider_unavailable','publication_unavailable','workflow_execution_failed']);
/** Deliberately shallow and closed. Protected domain values cannot be serialized. */
export function safeMetadata(value:unknown):void {
  if(value===null||value===undefined)return;
  if(typeof value!=='object'||Array.isArray(value))throw new NonRetriableError('workflow_data_boundary');
  for(const [key,item] of Object.entries(value)) {
    let valid=false;
    if(['id','workflow_id','receipt_id'].includes(key))valid=typeof item==='string'&&/^[a-f0-9]{64}$/.test(item);
    if(['version','generation','dispatch','count','attempts','at','next_attempt'].includes(key))valid=typeof item==='number'&&Number.isSafeInteger(item)&&item>=0;
    if(key==='state')valid=typeof item==='string'&&states.has(item);
    if(key==='stage')valid=typeof item==='string'&&stages.has(item);
    if(key==='family')valid=typeof item==='string'&&(families as readonly string[]).includes(item);
    if(key==='waiting_reason')valid=item===null||(typeof item==='string'&&reasons.has(item));
    if(!valid)throw new NonRetriableError('workflow_data_boundary');
  }
}
function sanitized(error:unknown):Error {
  const output=error instanceof NonRetriableError?new NonRetriableError('workflow_execution_stopped'):
    error instanceof RetryAfterError?new RetryAfterError('workflow_execution_failed',error.retryAfter):new Error('workflow_execution_failed');
  // Neither the originating stack nor cause reaches durable history.
  output.stack=output.name+': '+output.message;return output;
}
export class WorkflowBoundary extends Middleware.BaseMiddleware {
  readonly id='nocheh-workflow-boundary-v1';
  override transformSendEvent(arg:Middleware.TransformSendEventArgs) {
    for(const event of arg.events) {
      if(event.name!=='nocheh/workflow.requested'&&!(process.env.NOCHEH_WORKFLOW_FIXTURE==='1'&&/^nocheh\/fixture\.(host|pipeline)$/.test(event.name)))throw new NonRetriableError('workflow_event_denied');
      if(Object.keys(event).some(key=>!['name','id','data','ts'].includes(key))||typeof event.id!=='string'||!/^[a-f0-9]{64}$/.test(event.id))throw new NonRetriableError('workflow_event_denied');
      safeMetadata(event.data);
    }
    return arg;
  }
  override transformStepInput(arg:Middleware.TransformStepInputArgs) {
    // Step arguments become history. Resolve all protected inputs in closures.
    if(arg.input.length)throw new NonRetriableError('workflow_step_arguments_denied');
    return arg;
  }
  override async wrapStepHandler({next}:Middleware.WrapStepHandlerArgs) {
    try {const output=await next();safeMetadata(output);return output;}catch(error){throw sanitized(error);}
  }
  override async wrapFunctionHandler({next}:Middleware.WrapFunctionHandlerArgs) {
    try {const output=await next();safeMetadata(output);return output;}catch(error){throw sanitized(error);}
  }
}
