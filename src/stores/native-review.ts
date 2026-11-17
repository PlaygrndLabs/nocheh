import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object} from '../http.js';
import type pg from 'pg';
import {brainOperation,type Brain} from '../brain/brain.js';
import {enterFamily,leaveFamily,releaseOperation,requestWorkflow,type ExecutionAuthority} from '../workflows/store.js';
import type {SourceReference} from './archive.js';
import type {DerivedRepository} from './derived.js';
import type {GuardBinding} from './guards.js';
import type {LearningContextOptions,LearningContextRepository,PreparedLearningContext} from './learning-context.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import {notesSender,ownerChat} from '../assistant-policy.js';
import {servedGroup,sourceChat} from '../spaces.js';
import {applicableInterpretations,type InterpretationVersion} from '../interpretations.js';
import {bucketOf,ownerTyped} from '../source-facts.js';
import {REVIEW_BODY_SLICE,REVIEW_FRAGMENT_LIMIT,reviewBody,reviewFragment,ruleBuckets,type ReviewProvenance,type RuleBucket} from '../source-labels.js';
import {NoteSourceRepository} from './note-sources.js';

export const nativeReviewSchema=`
CREATE TABLE IF NOT EXISTS native_review_jobs (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,input_reference jsonb NOT NULL,binding jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','paused','ambiguous')),
 attempts integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1,next_attempt timestamptz NOT NULL DEFAULT now(),
 result_id text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE native_review_jobs ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE native_review_jobs ADD COLUMN IF NOT EXISTS reconciliations integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS native_review_jobs_source ON native_review_jobs((source_reference->>'id'));
ALTER TABLE native_review_jobs ADD COLUMN IF NOT EXISTS provenance jsonb;
CREATE TABLE IF NOT EXISTS native_review_skips (
 event_id text NOT NULL,generation text NOT NULL,reason text NOT NULL CHECK(reason IN ('sender_not_allowed','target_not_allowed')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(event_id,generation)
);
`;
/** Why a source stays out of the owner's notes (ADR-0257): someone not allowed there sent it, or it is a reaction to a
 * message that was left out for that reason. */
export type NotesSkip='sender_not_allowed'|'target_not_allowed';
/** A source's notes reviews, and why it stays out of the owner's notes when queue decided that in the same call: someone
 * not allowed there (recorded), or a pin that carried only Nocheh's own card, notice or reminder (`nocheh_message`, not
 * recorded: nothing in it is anyone's). */
export interface QueuedReviews {ids:string[];left_out:NotesSkip|'nocheh_message'|null}
const record=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const protocol='hermes-native-review-v3';
/** An uncertain review is observed at most this many times, with growing gaps, then left closed as uncertain. */
export const nativeReconcileLimit=8;
/** A review that failed without changing any notes runs again up to this many attempts in all. */
export const nativeAttemptLimit=4;

/** Sources whose native review is still waiting to run (never started, or failed without changing notes), or whose newest
 * learning stopped, under an earlier epoch are renewed by their per-source step. That step runs after each epoch; work
 * stranded before a restart asks for it once more here, at most once per source since `since`. */
export async function requestStrandedSources(pool:pg.Pool,since:Date,limit=100):Promise<number> {
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new HttpError(400,'invalid_workflow_limit');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const sources=(await db.query(`WITH current AS (SELECT jsonb_build_object('generation',i.generation::text,'epoch',g.epoch,'mode',g.mode) AS binding,i.generation
        FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton),
      learning AS (SELECT DISTINCT ON (j.workspace,j.audience,j.source_reference->>'id') j.source_reference->>'id' AS id,j.state,j.error_code,j.binding
        FROM interpretation_jobs j JOIN memory_generations m ON m.id=j.workspace AND m.state<>'retired' JOIN current c ON m.installation_generation=c.generation
        ORDER BY j.workspace,j.audience,j.source_reference->>'id',j.created_at DESC,j.id DESC),
      stranded AS (
        SELECT n.source_reference->>'id' AS id FROM native_review_jobs n,current c WHERE n.state='pending' AND NOT n.paused
          AND n.binding->>'generation'=c.generation::text AND n.binding<>c.binding
        UNION SELECT l.id FROM learning l,current c WHERE l.binding<>c.binding
          AND (l.state='pending' OR l.state='failed' AND l.error_code IS DISTINCT FROM 'invalid_interpretation_result'))
      SELECT s.id,coalesce(max(w.generation),0)+1 AS generation FROM stranded s
        LEFT JOIN workflow_registry w ON w.family='memory_review' AND w.job_id='source:'||s.id
      GROUP BY s.id HAVING NOT bool_or(coalesce(w.state IN ('queued','waiting','running','retryable_failed') OR w.created_at>=$2,false))
      ORDER BY s.id LIMIT $1`,[limit,since])).rows;
    for(const source of sources)await requestWorkflow(db,'memory_review','source:'+source.id,Number(source.generation));
    await db.query('COMMIT');return sources.length;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** The brain's own notes remain in the brain. Nocheh stores prepared inputs and execution receipts separately. */
export class NativeReviewRepository {
  constructor(readonly contexts:LearningContextRepository,readonly derived:DerivedRepository,readonly prepared:PreparedContextRepository,
    readonly turns:RuntimeTurnRepository,readonly brain:Brain,readonly token:string,
    readonly sources=new NoteSourceRepository(contexts.access.stores,()=>contexts.access.policy(),contexts.access)){}
  private get control(){return this.contexts.access.stores.control;}
  private actor(source:SourceReference,binding:GuardBinding):Reader {
    // The owner's private chat (ADR-0252), the space the owner's native notes are reviewed in.
    const policy=this.contexts.access.policy(),owner=policy.owner_id?ownerChat(policy):null;if(!owner)throw new HttpError(409,'owner_review_required');
    return {admin:false,scope:null,space:owner,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch,purpose:'memory-review'};
  }
  async queue(source:SourceReference):Promise<QueuedReviews> {
    // A brain that keeps no notes of its own has nothing to learn them from.
    if(!this.brain.reviewNotes)return {ids:[],left_out:null};
    const binding=await this.contexts.guards.state();
    // Each source is reviewed once per installation generation; repeating a started review repeats its model calls.
    // A waiting review (never started, or failed without changing notes) can't run under an older authorization epoch,
    // so it is renewed under the current one.
    const jobs=(await this.control.query(`SELECT id,input_reference,attempts,error_code,next_attempt,(state='pending' AND NOT paused) AS waiting,(state='pending' AND NOT paused AND binding<>$2::jsonb) AS stale
      FROM native_review_jobs WHERE source_reference->>'id'=$1 AND binding->>'generation'=$3 ORDER BY created_at,id`,[source.id,JSON.stringify(binding),binding.generation])).rows;
    const reviewed=jobs.filter(row=>!row.stale),stale=new Map<string,{id:string;input_reference:{id:string;input_hash:string};attempts:number;error_code:string|null;next_attempt:Date}>();
    for(const row of jobs)if(row.stale&&!stale.has(row.input_reference.input_hash))stale.set(row.input_reference.input_hash,row);
    // A review that failed and is replaced because its input changed hands its attempts, failure and gap on,
    // so changing input never adds to a source's four attempts.
    const spent=jobs.filter(row=>row.stale&&row.attempts>0).sort((a,b)=>b.attempts-a.attempts||b.next_attempt-a.next_attempt)[0];
    const ids:string[]=[];
    const retire=async()=>{await this.control.query(`DELETE FROM native_review_jobs WHERE source_reference->>'id'=$1 AND binding->>'generation'=$3
      AND state='pending' AND NOT paused AND binding<>$2::jsonb AND NOT (id=ANY($4::text[]))`,[source.id,JSON.stringify(binding),binding.generation,ids]);};
    // A long source is reviewed in fragments. Once one has started, finished or waits under the current binding, the
    // source gets no new fragment, but its other fragments still waiting under an earlier epoch keep their place while
    // their own text is unchanged, so its review is completed rather than cut short.
    const kept=reviewed.map(row=>String(row.id)),waiting=reviewed.filter(row=>row.waiting).map(row=>String(row.id));
    const settle=async():Promise<QueuedReviews>=>{await retire();await this.keepWaiting([...waiting,...ids]);return {ids:[...kept,...ids],left_out:null};};
    if(kept.length&&!stale.size)return await settle();
    // Someone not allowed there stays out of the owner's notes, while group memory still learns what they said. Decided
    // after the return above, so a source already reviewed in this generation keeps its review.
    const leave=async(reason:NotesSkip):Promise<QueuedReviews>=>{await this.skip(source,binding,reason);return {ids:kept.filter(id=>!waiting.includes(id)),left_out:reason};};
    const decision=await this.decide(source,binding);if(decision!=='review')return await leave(decision);
    // Related messages are asked the same question, each once; a pin's message by its own author, and a quote's by the
    // message it answers.
    const asked=new Map<string,Promise<boolean>>(),admit=(reference:SourceReference)=>{
      let allowed=asked.get(reference.id);if(!allowed)asked.set(reference.id,allowed=this.sender(reference.id).then(value=>value==='review'));return allowed;};
    const options:Required<LearningContextOptions>={admit,
      admitPinned:reference=>this.pinnedSender(reference.id).then(value=>value==='not_learned'?value:value==='review'),
      admitQuoted:reference=>this.quotedSender(reference.id,admit).then(value=>value==='review'),
      admitPinnedQuote:reference=>this.pinnedQuotedSender(reference.id,admit).then(value=>value==='review'),
      collect:{dropped:[],versions:[],refused:[],bare_reaction:false,empty_pin:false,inputs:new Map()}};
    let context;
    try{context=await this.contexts.prepare(source,binding,options);}
    catch(error) {
      if(!(error instanceof HttpError&&error.code==='learning_consent_required'))throw error;
      if(kept.length)return await settle();
      await retire();throw error;
    }
    // A reaction to a message left out has nothing left to review, so no model run is spent on it.
    if(options.collect.bare_reaction)return await leave('target_not_allowed');
    // Nor has a pin of Nocheh's own card, notice or reminder once the card is cut out. Nobody was left out, so nothing is
    // recorded: the source step only says why, and the pin's reviews still waiting are withdrawn.
    if(options.collect.empty_pin){await this.withdraw(source);return {ids:kept.filter(id=>!waiting.includes(id)),left_out:'nocheh_message'};}
    const actor=this.actor(source,binding);
    await this.turns.binding(actor);await this.prepared.allow(actor,{observations:context.observations,rules:context.rules});
    const {provenance,rules,limitations}=await this.batch(source,context,options.collect);
    const text=canonical({space:context.space,observations:context.observations,rules,limitations});
    if(text.length>200000){if(kept.length)return await settle();throw new HttpError(413,'native_review_input_limit');}
    // Every fragment carries the whole source's evidence, so a new reply or reaction in its thread changes every fragment's
    // input. A waiting fragment whose own text is unchanged is then replaced by one with the current input, keeping its
    // attempts, last failure and gap.
    const twins=new Map<string,typeof spent>();
    if(kept.length) {
      const rows=[...stale.values()],stored=(await this.derived.pool.query('SELECT id,content FROM derived_artifacts WHERE id=ANY($1::text[])',
        [rows.map(row=>row.input_reference.id)])).rows;
      for(const row of rows) {
        const content=stored.find(input=>input.id===row.input_reference.id)?.content;
        // Matched on its slice of the evidence alone, so a records line that changed (a new message in the batch, a
        // sender allowed or not) still finds it.
        if(content)twins.set(digest(reviewBody(String(JSON.parse(content.toString()).text))),row);
      }
    }
    // Line 1 is kept exactly as it was: the ADR-0244 counter reads it. Code's records line and a fixed marker line come
    // next, then a fixed-size slice of the evidence, so nothing a message says comes before the marker.
    const characters=Array.from(text),fragments:string[]=[];
    for(let offset=0;offset<characters.length;offset+=REVIEW_BODY_SLICE)
      fragments.push(reviewFragment(`Source nocheh:event:${source.id}; conversation ${context.space}; fragment ${offset/REVIEW_BODY_SLICE+1}. Speakers are not necessarily the owner.`,
        provenance,characters.slice(offset,offset+REVIEW_BODY_SLICE).join('')));
    if(fragments.some(content=>Array.from(content).length>REVIEW_FRAGMENT_LIMIT)){if(kept.length)return await settle();throw new HttpError(413,'native_review_input_limit');}
    for(const content of fragments) {
      const document={text:content,evidence:context.evidence.map(e=>e.reference),dependencies:context.dependencies};
      // The same prepared input keeps its identity, attempts and place in the queue; only changed input becomes a new review.
      const hash=digest(canonical(document)),same=stale.get(hash);
      if(same) {
        stale.delete(hash);
        await this.prepared.allow(actor,{text:content});await this.turns.binding(actor);
        await this.control.query(`UPDATE native_review_jobs SET binding=$2,revision=revision+1,updated_at=now()
          WHERE id=$1 AND state='pending' AND NOT paused`,[same.id,binding]);
        ids.push(same.id);continue;
      }
      const twin=twins.get(digest(reviewBody(content)));
      if(kept.length&&!(twin&&stale.get(twin.input_reference.input_hash)===twin))continue;
      if(twin)stale.delete(twin.input_reference.input_hash);
      const carried=twin??spent;
      const id=digest(canonical([protocol,binding,source,document]));
      const input=await this.derived.record({operation_id:'native-review-input:'+id,source,kind:'runtime_context',content:Buffer.from(canonical(document)),
        producer:'nocheh',producer_version:protocol,configuration:{binding,purpose:'memory-review'},provenance:{evidence:document.evidence}});
      await this.prepared.allow(actor,{text:content});await this.turns.binding(actor);
      const db=await this.control.connect();
      try {
        await db.query('BEGIN');
        await db.query(`INSERT INTO native_review_jobs(id,source_reference,input_reference,binding,attempts,error_code,next_attempt,provenance)
          VALUES($1,$2,$3,$4,$5,$6,greatest(now(),$7::timestamptz),$8) ON CONFLICT DO NOTHING`,
          [id,source,input,binding,carried?.attempts??0,carried?.error_code??null,carried?.next_attempt??null,provenance]);
        await requestWorkflow(db,'memory_review','native:'+id);await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
      ids.push(id);
    }
    return await settle();
  }
  /**
   * What code records about a review's batch (ADR-0257), from each message's own fields: its class, whether every
   * message was the owner's own typing, whose rules it reads and whose words they rest on, and how many messages and
   * rules were left out. A rule is the owner's only when the owner wrote it: one learned automatically, even from the
   * owner's own message alone, may restate a rule or a forward its interpretation read. Whose words a rule rests on is
   * judged by what code recorded it was learned from (its stored dependencies), never by what the model cited of them:
   * a transcript or a file's text is judged through the message it belongs to, which is recorded with it; any other
   * input is someone else's. In a batch of the owner's own typing only, every rule the owner did not write is left out of
   * that one review, so a note it writes can still read as the owner's. In a batch of the owner's own typing and
   * Nocheh's own learned messages, the rules resting on another person's message, a forward or a file are left out of it
   * the same way, so its notes stay Nocheh's; a rule learned from the owner's own typing stays there, since such a
   * review's notes are never the owner's. Turns and every other review still read them.
   */
  private async batch(source:SourceReference,context:PreparedLearningContext,collect:Required<LearningContextOptions>['collect']) {
    const versions=collect.versions,inputs=(version:InterpretationVersion)=>collect.inputs.get(version.id)??[];
    const learnedFrom=(version:InterpretationVersion)=>inputs(version).filter(id=>id.startsWith('events:')).map(id=>id.slice('events:'.length));
    const told=(version:InterpretationVersion)=>inputs(version).every(id=>id.startsWith('events:')||id.startsWith('derived_artifacts:'));
    const classes=await this.sources.classesFor([...context.observations.map(item=>item.source.id),...versions.flatMap(learnedFrom)]);
    const typed=(id:string)=>{const found=classes.get(id);return !!found&&ownerTyped(found.facts);};
    const ownRule=(version:InterpretationVersion)=>version.author==='owner';
    // Whose words a rule rests on, besides the owner's and Nocheh's learned messages, which name nobody: a message or an
    // input that can't be told is another person's.
    const others=(version:InterpretationVersion)=>{
      const found=new Set<string>();if(version.author==='owner')return found;
      if(!learnedFrom(version).length||!told(version))found.add('person');
      for(const id of learnedFrom(version)){const item=classes.get(id);found.add(item?bucketOf(item.class):'person');}
      return new Set([...found].filter(bucket=>(ruleBuckets as readonly string[]).includes(bucket)));
    };
    // Nocheh's own learned messages, and the owner's quote or pin of one, never its cards or notices, which are not learned.
    const nocheh=(id:string)=>{const found=classes.get(id);return !!found&&bucketOf(found.class)==='nocheh';};
    const ownerOnly=context.observations.every(item=>typed(item.source.id));
    const ownOrNocheh=!ownerOnly&&context.observations.every(item=>typed(item.source.id)||nocheh(item.source.id));
    const read=ownerOnly?versions.filter(ownRule):ownOrNocheh?versions.filter(version=>!others(version).size):versions,left=versions.length-read.length;
    const buckets=new Set(read.flatMap(version=>[...others(version)]));
    const provenance:ReviewProvenance={version:1,source:source.id,
      events:context.observations.map(item=>({id:item.source.id,class:classes.get(item.source.id)?.class??'unknown'})),owner_account_only:ownerOnly,
      rules:!read.length?'none':read.every(ownRule)?'owner':'others',rule_buckets:ruleBuckets.filter((bucket:RuleBucket)=>buckets.has(bucket)),
      left_out:{sender_not_allowed:collect.dropped.length,rule_sender_not_allowed:collect.refused.length,rules_left_out_for_owner_label:left}};
    return {provenance,rules:left?applicableInterpretations(read):context.rules,
      limitations:left?[...context.limitations,'rules_left_out_for_owner_label']:context.limitations};
  }
  /** Why a source's notes review should not run, or null: Nocheh's own card or notice (ADR-0256), or a source left out of
   * the owner's notes (ADR-0257), which is recorded so a later grant doesn't bring it back in this generation. */
  async unwanted(source:SourceReference):Promise<'nocheh_message'|NotesSkip|null> {
    const own=await this.contexts.access.notLearned(source);if(own)return own;
    const binding=await this.contexts.guards.state(),decision=await this.decide(source,binding);
    if(decision==='review')return null;
    await this.record(source,binding,decision);return decision;
  }
  /**
   * Whether a source goes into the owner's notes review: what the owner or someone allowed there sent, and Nocheh's own
   * messages and the owner's web chat (notesSender). The owner's yes on that message lets it in, but only in the owner's
   * own chat or a group Nocheh serves, never in someone else's private chat. A source left out once stays out for the
   * installation generation, so allowing the person later doesn't review their old messages one model run each.
   */
  private async decide(source:SourceReference,binding:GuardBinding):Promise<'review'|NotesSkip> {
    const row=(await this.control.query(`SELECT (SELECT enabled FROM learning_consent WHERE event_id=$1) AS consent,
      (SELECT reason FROM native_review_skips WHERE event_id=$1 AND generation=$2) AS skipped`,[source.id,binding.generation])).rows[0];
    if(row.consent===true) {
      const chat=sourceChat(await this.contexts.access.archive.verify(source));
      if(chat!==null&&(chat===ownerChat(this.contexts.access.policy())||servedGroup(chat)))return 'review';
    }
    if(row.skipped)return row.skipped as NotesSkip;
    return await this.sender(source.id);
  }
  /** An archived event as notesSender reads it, or null when it is missing or unreadable. */
  private async archived(id:string):Promise<{channel:string;kind:string;scope:string;payload:unknown}|null> {
    const event=(await this.contexts.access.stores.archive.query('SELECT channel,kind,scope,payload FROM events WHERE id=$1',[id])).rows[0];
    if(!event)return null;
    try{return {channel:event.channel,kind:event.kind,scope:event.scope,payload:JSON.parse((event.payload as Buffer).toString())};}catch{return null;}
  }
  /** notesSender over an archived event; one that is missing or unreadable is not let in. */
  private async sender(id:string):Promise<'review'|'sender_not_allowed'> {
    const event=await this.archived(id);
    return event?notesSender(this.contexts.access.policy(),event):'sender_not_allowed';
  }
  /** notesSender over the message an archived pin carries, by that message's own author in the pin's chat; a pin whose
   *  message can't be read is not let in. A message Telegram no longer shows (date 0) carries no words to leave out.
   *  Nocheh's own message (NoteSourceRepository.carried) is never someone not allowed: a learned one stays, and a card,
   *  notice or reminder is not learned, nor is Nocheh's own account's message the archive does not hold as Nocheh's (not
   *  archived yet, or a forward of one), which is cut as a card is. Anyone else's, another bot's included, is asked as
   *  its sender is. */
  private async pinnedSender(id:string):Promise<'review'|'sender_not_allowed'|'not_learned'> {
    const event=await this.archived(id),update=record(event?.payload),message=record(update?.message??update?.edited_message),pinned=record(message?.pinned_message);
    if(!event||!message||!pinned)return 'sender_not_allowed';
    if(pinned.date===0&&Object.keys(pinned).every(name=>['chat','message_id','date'].includes(name)))return 'review';
    const own=(await this.sources.carried([id])).get(id)?.pinned;
    if(own)return own==='learned'?'review':'not_learned';
    return notesSender(this.contexts.access.policy(),{...event,payload:{message:{...pinned,chat:message.chat}}});
  }
  /**
   * Whether the message an archived event quotes may go into the owner's notes, by that message's own author (ADR-0257):
   * the message it answers as the archive holds it, each revision asked as a related message is (`admit`). A quote of a
   * message in another chat or topic (external_reply) is judged by that message alone, and stays only when the archive
   * holds it and its sender is allowed where they wrote it. A quote of one in this chat the archive never got (another
   * bot's message, or one sent before Nocheh was there) is judged by its author as the reply shows it, in this chat, as
   * pinnedSender judges a pin's. A quote with nothing to judge it by is not let in.
   */
  private async quotedSender(id:string,admit:(reference:SourceReference)=>Promise<boolean>):Promise<'review'|'sender_not_allowed'> {
    const event=await this.archived(id),update=record(event?.payload);
    const message=record(update?.message??update?.edited_message??update?.channel_post??update?.edited_channel_post);
    if(!event||!message)return 'sender_not_allowed';
    const external=!!record(message.external_reply),relationships=this.contexts.access.relationships;
    // The archive's reply relation for one in another chat or topic is marked external (observedSource).
    const targets=(await this.contexts.access.stores.archive.query(`SELECT o.platform,o.namespace,o.kind,o.external_id FROM source_relations r
      JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=$1 AND r.kind='reply_to' AND coalesce(r.metadata->>'external','false')=$2`,[id,String(external)])).rows;
    const held=(await Promise.all(targets.map(target=>relationships.observations({platform:target.platform,namespace:target.namespace,kind:target.kind,
      external_id:target.external_id},'',30)))).flatMap(page=>page.references);
    if(held.length){for(const reference of held)if(!await admit(reference))return 'sender_not_allowed';return 'review';}
    const replied=record(message.reply_to_message);
    if(external||!replied)return 'sender_not_allowed';
    return notesSender(this.contexts.access.policy(),{...event,payload:{message:{...replied,chat:message.chat}}});
  }
  /**
   * Whether the quote inside the message an archived pin carries may go into the owner's notes, by the message that quote
   * repeats part of (ADR-0257): the pinned message as the archive holds it is asked as any quote is (quotedSender), each
   * revision, so its quote stays only when the message it answers is archived and admitted, or, when that one was never
   * archived, its author as the pinned message shows it is allowed in that chat. A pinned message the archive never got
   * is judged by the author of the message it answers, as the pin shows it, in the pin's chat; Telegram leaves that reply
   * out of a pinned message, so such a quote, with nothing to judge it by, is not let in.
   */
  private async pinnedQuotedSender(id:string,admit:(reference:SourceReference)=>Promise<boolean>):Promise<'review'|'sender_not_allowed'> {
    const held=(await this.sources.pinnedTo([id])).get(id)??[];
    if(held.length){for(const target of held)if(await this.quotedSender(target,admit)!=='review')return 'sender_not_allowed';return 'review';}
    const event=await this.archived(id),update=record(event?.payload),message=record(update?.message??update?.edited_message);
    const pinned=record(message?.pinned_message),replied=record(pinned?.reply_to_message);
    if(!event||!message||!replied||record(pinned?.external_reply))return 'sender_not_allowed';
    return notesSender(this.contexts.access.policy(),{...event,payload:{message:{...replied,chat:message.chat}}});
  }
  private async record(source:SourceReference,binding:GuardBinding,reason:NotesSkip) {
    await this.control.query('INSERT INTO native_review_skips(event_id,generation,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.id,binding.generation,reason]);
  }
  /** Leaves a source out of the owner's notes and withdraws its reviews still waiting; their workflows close as superseded. */
  private async skip(source:SourceReference,binding:GuardBinding,reason:NotesSkip) {
    await this.record(source,binding,reason);await this.withdraw(source);
  }
  /** Withdraws a source's reviews still waiting to run in this installation generation; their workflows close as
   * superseded, and a review that started keeps its row. */
  async withdraw(source:SourceReference):Promise<void> {
    const binding=await this.contexts.guards.state();
    await this.control.query(`DELETE FROM native_review_jobs WHERE source_reference->>'id'=$1 AND binding->>'generation'=$2 AND state='pending' AND NOT paused`,
      [source.id,binding.generation]);
  }
  /** A waiting review keeps an open workflow. One whose workflow closed before it ran (an epoch once closed a failed
   * review's retry that way) gets a new one, so it still runs in its turn. */
  private async keepWaiting(ids:string[]) {
    if(!ids.length)return;
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const closed=(await db.query(`SELECT j.id,greatest(coalesce(max(w.generation),0)+1,j.revision) AS generation FROM native_review_jobs j
        LEFT JOIN workflow_registry w ON w.family='memory_review' AND w.job_id='native:'||j.id
        WHERE j.id=ANY($1::text[]) AND j.state='pending' AND NOT j.paused GROUP BY j.id,j.revision
        HAVING NOT bool_or(coalesce(w.state IN ('queued','waiting','running','retryable_failed'),false))`,[ids])).rows;
      for(const row of closed)await requestWorkflow(db,'memory_review','native:'+row.id,Number(row.generation));
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async inspect(id:string) {
    const row=(await this.control.query('SELECT * FROM native_review_jobs WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'native_review_missing');return row;
  }
  async run(id:string,authority:ExecutionAuthority):Promise<string> {
    const db=await this.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(db,'memory_review',authority.owner,authority.epoch);if(!fenced)throw new HttpError(409,'workflow_owner_changed');
      locked=(await db.query('SELECT pg_try_advisory_lock(803359) AS locked')).rows[0].locked;if(!locked)throw new HttpError(409,'native_review_busy');
      const job=await this.inspect(id);if(job.paused)return 'paused';if(['done','paused'].includes(job.state))return job.state;
      if(job.state==='ambiguous'&&job.reconciliations>=nativeReconcileLimit)return 'ambiguous';
      const operationId='native-review-result:'+id;
      const complete=async(resultId:string)=>{
        await db.query("UPDATE native_review_jobs SET state='done',result_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[id,resultId]);return 'done';
      };
      const saved=await this.derived.checkpoint(operationId);
      if(saved)return await complete(saved.id);
      const input=(await this.derived.pool.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1',[job.input_reference.id])).rows[0];
      if(!input||input.content_hash!==job.input_reference.input_hash||digest(input.content)!==input.content_hash)throw new HttpError(409,'native_review_input_conflict');
      const document=JSON.parse(input.content.toString());
      if(!Array.isArray(document.evidence)||document.evidence.length>30)throw new HttpError(409,'native_review_input_conflict');
      const actor=this.actor(job.source_reference,job.binding);
      const uncertain=['running','ambiguous'].includes(job.state);
      // Already-started work can be observed after revocation; its old profile
      // remains inaccessible. New work must revalidate every prepared dependency.
      if(!uncertain) {
        await this.contexts.guards.assertCurrent(job.binding);await this.turns.binding(actor);
        await this.contexts.learned.validateDependencies(document.dependencies,job.binding);
        for(const evidence of document.evidence)if(!await this.contexts.access.canLearn(evidence,job.binding))throw new HttpError(403,'learning_consent_required');
        if(this.token.length<24)throw new HttpError(503,'service_credential_required');
        await this.prepared.allow(actor,{text:document.text});
      }
      const credential=uncertain?null:await this.prepared.audience.turn(this.token,{scope:null,space:actor.space!,purpose:'memory-review'},job.source_reference.id,Date.now()+600000);
      if(!uncertain){
        await this.turns.binding(actor);
        const claimed=await db.query("UPDATE native_review_jobs SET state='running',attempts=attempts+1,updated_at=now() WHERE id=$1 AND state='pending' AND NOT paused AND revision=$2 RETURNING id",[id,job.revision]);
        if(!claimed.rowCount)throw new HttpError(409,'native_review_changed');
      }
      // An observation that cannot confirm the review counts toward the bound and waits longer next time.
      const unconfirmed=async()=>{
        await db.query(`UPDATE native_review_jobs SET state='ambiguous',error_code='native_review_unconfirmed',reconciliations=reconciliations+$2,
          next_attempt=now()+interval '60 seconds'*power(2,least(greatest(reconciliations+$2-1,0),5)),updated_at=now() WHERE id=$1`,[id,uncertain?1:0]);return 'ambiguous';
      };
      let result:Record<string,unknown>;
      try {
        result=await brainOperation(this.brain,'reviewNotes')(uncertain?{id,scope:actor.space,observe_only:true}:{id,scope:actor.space,content:document.text,
          event_id:job.source_reference.id,guard_mode:job.binding.mode,archive_credential:credential});
      }catch {return await unconfirmed();}
      if(!uncertain&&result.state==='waiting'&&result.error_code==='profile_busy') {
        await db.query("UPDATE native_review_jobs SET state='pending',attempts=greatest(0,attempts-1),error_code='waiting_for_profile',next_attempt=now()+interval '5 seconds',updated_at=now() WHERE id=$1",[id]);return 'pending';
      }
      if(result.state==='done') {
        const output=await this.derived.record({operation_id:operationId,source:job.source_reference,parents:[job.input_reference],kind:'runtime_result',content:Buffer.from(canonical({state:'done'})),
          producer:this.brain.id,producer_version:protocol,configuration:{review_id:id},provenance:{binding:job.binding,native_receipt:id}});
        return await complete(output.id);
      }
      if(result.state==='failed') {
        // Hermes reports failed only when the review left the notes unchanged, so it may run again at growing gaps.
        const row=(await db.query(`UPDATE native_review_jobs SET state=CASE WHEN attempts<$2 THEN 'pending' ELSE 'ambiguous' END,
          reconciliations=CASE WHEN attempts<$2 THEN 0 ELSE $3 END,error_code='native_review_failed',
          next_attempt=now()+interval '60 seconds'*power(2,least(attempts,5)),updated_at=now() WHERE id=$1 RETURNING state`,
          [id,nativeAttemptLimit,nativeReconcileLimit])).rows[0];
        return row.state;
      }
      if(result.state!=='running')return await unconfirmed();
      // Most reviews finish within seconds: a running review is observed after 5 seconds, then at doubling gaps up to a minute.
      await db.query(`UPDATE native_review_jobs SET state='running',error_code=NULL,updated_at=now(),next_attempt=now()+CASE WHEN $2
        THEN least(interval '60 seconds',greatest(interval '5 seconds',(next_attempt-updated_at)*2)) ELSE interval '5 seconds' END WHERE id=$1`,[id,uncertain]);return 'running';
    } finally {await releaseOperation(db,async()=>{if(locked)await db.query('SELECT pg_advisory_unlock(803359)');if(fenced)await leaveFamily(db,'memory_review');});}
  }
  async list(principal:Reader,after='') {
    admin(principal);const rows=(await this.control.query('SELECT * FROM native_review_jobs WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
    // How many messages from people not allowed where they wrote stayed out of the owner's notes this generation.
    const generation=(await this.contexts.guards.state()).generation;
    const kept=(await this.control.query("SELECT count(*)::int AS n FROM native_review_skips WHERE generation=$1 AND reason='sender_not_allowed'",[generation])).rows[0];
    return {jobs:rows.slice(0,100),next:rows.length>100?rows[99].id:null,kept_out:Number(kept?.n??0)};
  }
  async controlJob(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=object(input);
    if(!['pause','resume'].includes(String(body.action))||!Number.isSafeInteger(body.expected_revision))throw new HttpError(400,'invalid_review_action');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const job=(await db.query('SELECT * FROM native_review_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!job||job.revision!==body.expected_revision||!['pending','paused','ambiguous'].includes(job.state))throw new HttpError(409,'review_not_controllable');
      const state=job.state==='ambiguous'?'ambiguous':body.action==='pause'?'paused':'pending';
      const row=(await db.query(`UPDATE native_review_jobs SET state=$2,paused=$3,revision=revision+1,next_attempt=now(),updated_at=now(),
        reconciliations=CASE WHEN $3 THEN reconciliations ELSE 0 END WHERE id=$1 RETURNING *`,[id,state,body.action==='pause'])).rows[0];
      // Resuming an uncertain review can only reconcile its existing identity, with a fresh observation bound.
      if(body.action==='resume')await requestWorkflow(db,'memory_review','native:'+id,row.revision);
      await db.query('COMMIT');return row;
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
