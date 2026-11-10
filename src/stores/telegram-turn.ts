import type pg from 'pg';
import type {Reader} from '../access.js';
import {canonical} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import {blockingPublications} from './publications.js';
import type {ArchiveRepository} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {RuntimeTurnRepository} from './turns.js';

/** What a message turn and an operation's follow-up turn share: the gateway receipt states and codes, the routed payload and the checks before a start. */
export const closedTurnStates=new Set(['done','failed','ambiguous','suppressed','cancelled']);
/** `failed` is retried, so only these end a turn for good. */
export const terminalTurnStates=new Set(['done','ambiguous','suppressed','cancelled']);
export const turnResultCodes=new Set(['model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message',
  'delivery_unconfirmed','dispatch_interrupted','space_policy_changed','guard_context_changed','runtime_execution_interrupted','intentional_silence','telegram_rejected','not_addressed','too_old','provider_not_configured',
  'unexpected_profile_tool','required_guard_unavailable','profile_scope_denied','invalid_process_scope_binding','unsupported_memory_compaction_revision']);
export type TurnInput={binding:GuardBinding;principal:Reader;body:Record<string,unknown>};

/** Keep routing identifiers independent of editable guarded representations. */
export function dispatchPayload(original:any,representation:any,text:string|null) {
  const message=original.message,selected=representation?.message??{},chat=message.chat,sender=message.from;
  const routed:any={message_id:message.message_id,date:message.date,
    chat:{id:chat.id,type:chat.type,...(typeof chat.is_forum==='boolean'?{is_forum:chat.is_forum}:{})},
    from:{id:sender.id,is_bot:sender.is_bot===true,first_name:typeof selected.from?.first_name==='string'?selected.from.first_name:'Participant'},
    // All attachment text is already in the prepared input. A plain message
    // invokes the committed handler without native downloads or media helpers.
    text:text||'[An attachment or non-text message was archived.]'};
  if(Number.isSafeInteger(message.message_thread_id))routed.message_thread_id=message.message_thread_id;
  if(typeof message.is_topic_message==='boolean')routed.is_topic_message=message.is_topic_message;
  return {update_id:original.update_id,message:routed};
}

/** The turn's binding is current, its source is not retired and its chat is still served. */
export async function currentTurn(deps:{archive:ArchiveRepository;access:SourceAccessRepository;guards:GuardRepository;turns:RuntimeTurnRepository},input:TurnInput):Promise<void> {
  await deps.guards.assertCurrent(input.binding);await deps.turns.binding(input.principal);
  const source=(await deps.archive.captured(input.principal.turnEvent!)).reference;
  if(await deps.access.retirements?.isRetired(source))throw new HttpError(403,'source_retired');
  const original=(await deps.archive.pool.query('SELECT payload,scope FROM events WHERE id=$1',[input.principal.turnEvent])).rows[0];
  if(!original||!conversationScope(deps.access.policy(),JSON.parse(original.payload.toString()),original.scope))throw new HttpError(403,'conversation_not_selected');
  await deps.guards.assertCurrent(input.binding);
}

/** Inside the transaction that marks a turn running: the binding still holds and no guard publication is pending. */
export async function turnFence(db:pg.PoolClient,binding:GuardBinding):Promise<void> {
  const row=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
  if(!row||canonical({generation:row.generation,epoch:Number(row.epoch),mode:row.mode})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
  if((await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
}
