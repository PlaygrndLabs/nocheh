import type pg from 'pg';
import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import type {ArchiveRepository,SourceReference} from './archive.js';
import type {SourceRepository} from './retrieval.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {PreparationRepository} from './preparation.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {TelegramActionRepository} from './telegram-actions.js';

export const telegramDispatchSchema=`
CREATE TABLE IF NOT EXISTS dispatches (
 event_id text PRIMARY KEY,source_reference jsonb NOT NULL,input_reference jsonb,result_reference jsonb,binding jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','ambiguous','suppressed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1,
 runtime_stage text NOT NULL DEFAULT 'admission',error_code text,next_attempt timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
`;
const protocol='telegram-dispatch-v2';
const closed=new Set(['done','failed','ambiguous','suppressed','cancelled']);
const codes=new Set(['model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message',
  'delivery_unconfirmed','dispatch_interrupted','space_policy_changed','runtime_execution_interrupted','intentional_silence']);
type Input={binding:GuardBinding;principal:Reader;body:Record<string,unknown>};

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

export class TelegramDispatchRepository {
  constructor(readonly archive:ArchiveRepository,readonly access:SourceAccessRepository,readonly sources:SourceRepository,
    readonly derived:DerivedRepository,readonly guards:GuardRepository,readonly preparation:PreparationRepository,
    readonly prepared:PreparedContextRepository,readonly turns:RuntimeTurnRepository,readonly actions:TelegramActionRepository,
    readonly call:RuntimeCall,readonly token:string,readonly detect:(text:string)=>Promise<unknown>){}
  private get control(){return this.access.stores.control;}
  private observation(row:any):Observation {
    const states:Record<string,Observation['state']>={pending:'waiting',running:'running',done:'completed',failed:'failed',ambiguous:'ambiguous',suppressed:'skipped',cancelled:'cancelled'};
    return observation(states[row.state]!,row.runtime_stage,row.attempts,row.next_attempt.getTime(),row.state==='running'?'receipt_pending':row.state==='pending'?'prerequisite':null);
  }
  private async row(id:string) {return (await this.control.query('SELECT * FROM dispatches WHERE event_id=$1',[id])).rows[0];}
  private async storeResult(row:any,response:Record<string,unknown>) {
    const state=String(response.state);
    if(!closed.has(state))throw new HttpError(409,'invalid_dispatch_receipt');
    const result={state,...(codes.has(String(response.error_code))?{error_code:String(response.error_code)}:{})};
    const output=await this.derived.record({operation_id:`telegram-dispatch-result:${row.event_id}:${row.attempts}`,
      source:row.source_reference,parents:[row.input_reference],kind:'runtime_result',content:Buffer.from(canonical(result)),
      producer:'hermes',producer_version:protocol,configuration:{attempt:row.attempts},provenance:{binding:row.binding}});
    return this.finish(row,result,output);
  }
  private async finish(row:any,result:{state:string;error_code?:string},reference:DerivativeReference) {
    await this.control.query(`UPDATE dispatches SET state=$2,result_reference=$3,error_code=$4,runtime_stage=$5,
      revision=revision+1,updated_at=now() WHERE event_id=$1`,[row.event_id,result.state,reference,result.error_code??null,result.state==='done'?'delivery':'assistant']);
    return this.observation(await this.row(row.event_id));
  }
  private async receive(row:any,result:Record<string,unknown>) {
    if(closed.has(String(result.state)))return this.storeResult(row,result);
    await this.control.query(`UPDATE dispatches SET state='running',runtime_stage=$2,error_code='awaiting_dispatch_receipt',
      next_attempt=now()+interval '5 seconds',revision=revision+1,updated_at=now() WHERE event_id=$1`,
      [row.event_id,['admission','assistant','delivery'].includes(String(result.stage))?result.stage:row.runtime_stage]);
    return this.observation(await this.row(row.event_id));
  }
  private async input(reference:DerivativeReference):Promise<Input> {
    const row=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0];
    if(!row||row.content_hash!==reference.input_hash||digest(row.content)!==row.content_hash)throw new HttpError(409,'dispatch_input_conflict');
    return JSON.parse(row.content.toString());
  }
  private async current(input:Input) {
    await this.guards.assertCurrent(input.binding);await this.turns.binding(input.principal);
    const original=(await this.archive.pool.query('SELECT payload,scope FROM events WHERE id=$1',[input.principal.turnEvent])).rows[0];
    if(!original||!conversationScope(this.access.policy(),JSON.parse(original.payload.toString()),original.scope))throw new HttpError(403,'conversation_not_selected');
    await this.guards.assertCurrent(input.binding);
  }
  private async fence(db:pg.PoolClient,binding:GuardBinding) {
    const row=(await db.query('SELECT i.generation,g.epoch,g.mode FROM installation i CROSS JOIN guard_state g WHERE i.singleton AND g.singleton FOR SHARE OF i,g')).rows[0];
    if(!row||canonical({generation:row.generation,epoch:Number(row.epoch),mode:row.mode})!==canonical(binding))throw new HttpError(409,'guard_context_changed');
    if((await db.query("SELECT 1 FROM guard_publications WHERE state='pending' LIMIT 1")).rowCount)throw new HttpError(409,'guard_transition_pending');
  }
  private async build(source:SourceReference):Promise<{reference:DerivativeReference;input:Input}|Observation> {
    const original=(await this.archive.pool.query('SELECT source_key,payload,scope FROM events WHERE id=$1',[source.id])).rows[0];
    const payload=JSON.parse(original.payload.toString()),scope=conversationScope(this.access.policy(),payload,original.scope);
    if(!scope)return observation('skipped','admission');
    const space=await this.access.space(source);if(!space)return observation('waiting','admission',0,Date.now()+30000,'prerequisite');
    const ready=await this.preparation.status(source.id);if(ready.state!=='completed')return ready.state==='retryable_failed'?ready:
      observation('waiting',ready.stage,0,ready.next_attempt,ready.waiting_reason);
    const binding=await this.guards.state(),principal:Reader={admin:false,scope:scope.owner?null:scope.chat_id,space,turnEvent:source.id,
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    await this.turns.binding(principal);
    const selected=await this.sources.read(principal,source.id),transcripts:string[]=[],files:any[]=[],parents:DerivativeReference[]=[];
    for(const result of selected.derived) {
      const row=(await this.derived.pool.query('SELECT content_hash FROM derived_artifacts WHERE id=$1',[result.id])).rows[0];
      parents.push({store:'derived',kind:'artifact',id:result.id,input_hash:row.content_hash});
      if(result.kind==='transcript')transcripts.push(Buffer.from(result.content_base64,'base64').toString());
    }
    const manifests=(await this.archive.pool.query('SELECT id,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[source.id])).rows;
    for(const file of selected.artifacts) {
      const hash=manifests.find(m=>m.id===file.id)?.file_hash;if(!hash)throw new HttpError(409,'source_file_pending');
      const extracted=selected.derived.find(d=>d.artifact_id===file.id&&d.kind==='extracted_text');
      files.push({id:file.id,name:typeof file.metadata?.file_name==='string'?file.metadata.file_name:'Attachment',sha256:hash,
        kind:binding.mode==='off'&&file.kind==='photo'?'image':'file',text:extracted?Buffer.from(extracted.content_base64,'base64').toString():null});
    }
    // Command authority comes from the original owner DM, never a guarded edit.
    const reply=await this.actions.controlReply(source),control=reply===null?null:await this.prepared.prepare(principal,reply,this.detect);
    const text=selected.event.text??null,body={channel:'telegram',event_id:source.id,source_key:original.source_key,scope:original.scope,
      payload:dispatchPayload(payload,selected.event.payload,text),text,transcripts,files,attempt:1,control_reply:control,guard_mode:binding.mode};
    const input={binding,principal,body};await this.prepared.allow(principal,{text,transcripts,files,control_reply:control});await this.current(input);
    const reference=await this.derived.record({operation_id:'telegram-dispatch-input:'+digest(canonical(input)),source,
      ...(parents.length?{parents}:{}),kind:'runtime_context',content:Buffer.from(canonical(input)),producer:'nocheh',producer_version:protocol,
      configuration:{binding},provenance:{purpose:'assistant',guard_revision:selected.guarded_revision}});
    return {reference,input};
  }
  async run(id:string,authority:ExecutionAuthority):Promise<Observation> {
    if(!/^[a-f0-9]{64}$/.test(id))return observation('failed','admission');
    const db=await this.control.connect();let held=false,locked=false;
    try {
      held=await enterFamily(db,'telegram',authority.owner,authority.epoch);if(!held)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803364)) AS held',[id])).rows[0].held;
      if(!locked)return observation('waiting','assistant',0,Date.now()+2000,'receipt_pending');
      const captured=await this.archive.captured(id),intake=(await db.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[id])).rows[0];
      if(captured.origin!=='live'||captured.channel!=='telegram'||captured.kind!=='telegram_update'||intake?.transport!=='capture'||intake?.state!=='ready')
        return observation('skipped','admission');
      await db.query('INSERT INTO dispatches(event_id,source_reference) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,captured.reference]);
      let row=await this.row(id);if(closed.has(row.state))return this.observation(row);
      if(row.attempts) {
        const saved=(await this.derived.pool.query('SELECT id,content,content_hash FROM derived_artifacts WHERE operation_id=$1',[`telegram-dispatch-result:${id}:${row.attempts}`])).rows[0];
        if(saved) {
          const value=JSON.parse(saved.content.toString());if(digest(saved.content)!==saved.content_hash||!closed.has(value.state))throw new HttpError(409,'dispatch_result_conflict');
          return await this.finish(row,value,{store:'derived',kind:'artifact',id:saved.id,input_hash:saved.content_hash});
        }
      }
      if(row.next_attempt>new Date())return this.observation(row);
      let input:Input;
      if(row.state==='running') {
        let observed:Record<string,unknown>;
        try{observed=await this.call('run.resume',{channel:'telegram',event_id:id,attempt:row.attempts,observe_only:true},10000);}
        catch{return await this.receive(row,{state:'running'});}
        if(closed.has(String(observed.state)))return await this.receive(row,observed);
        input=await this.input(row.input_reference);
        try{await this.current(input);}catch(error){
          if(!(error instanceof HttpError)||!['guard_context_changed','audience_context_changed','conversation_not_selected','guard_transition_pending'].includes(error.code))throw error;
          if(observed.state==='not_found')return await this.storeResult(row,{state:'cancelled'});
          try{return await this.receive(row,await this.call('run.cancel',{channel:'telegram',event_id:id,attempt:row.attempts},10000));}
          catch{return await this.receive(row,{state:'running'});}
        }
        if(!['not_found','queued'].includes(String(observed.state)))return await this.receive(row,observed);
        // Only explicit absence or a never-started native request may launch the
        // same identity, after current binding checks. Running work is observed.
      } else {
        if(!this.access.policy().enabled)return observation('waiting','admission',0,Date.now()+60000,'owner_paused');
        const built=await this.build(captured.reference);
        if('state' in built) {
          if(built.state==='skipped')await db.query("UPDATE dispatches SET state='suppressed',error_code='conversation_not_selected',updated_at=now() WHERE event_id=$1",[id]);
          return built;
        }
        input=built.input;
        await db.query('BEGIN');
        try {
          await this.fence(db,input.binding);
          await db.query(`UPDATE dispatches SET state='running',attempts=1,input_reference=$2,binding=$3,error_code=NULL,
            revision=revision+1,updated_at=now() WHERE event_id=$1 AND state='pending'`,[id,built.reference,input.binding]);
          await db.query('COMMIT');row=await this.row(id);
        }catch(error){await db.query('ROLLBACK');throw error;}
      }
      if(this.token.length<24)throw new HttpError(503,'service_credential_required');
      const credential=await this.prepared.audience.turn(this.token,input.principal,id,Date.now()+600000);await this.current(input);
      let result:Record<string,unknown>;
      try{result=await this.call('run.start',{...input.body,asynchronous:true,archive_credential:credential},10000);}
      catch{result={state:'running'};}
      return await this.receive(row,result);
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803364))',[id]);if(held)await leaveFamily(db,'telegram');});}
  }
}
