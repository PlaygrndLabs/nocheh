import type pg from 'pg';
import {digest} from '../archive.js';
import {guardChecks} from '../config.js';
import {HttpError} from '../http.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import {AttachmentRepository} from './attachments.js';
import {GuardRepository} from './guards.js';
import {ReprocessingRepository,type DerivationEngine} from './reprocessing.js';
import {SelectionRepository} from './selections.js';
import type {SourceReference} from './archive.js';

/** One shared check takes up to this many other messages of an import, and about this much of their text. */
const COMPANIONS=200,COMPANION_BYTES=120000;

export class PreparationRepository {
  constructor(readonly attachments:AttachmentRepository,readonly reprocessing:ReprocessingRepository,
    readonly guards:GuardRepository,readonly selections:SelectionRepository,readonly transcription:DerivationEngine,readonly extraction:DerivationEngine,
    readonly slots=guardChecks()){}
  private get stores(){return this.attachments.stores;}

  async status(eventId:string):Promise<Observation> {
    const source=await this.attachments.archive.captured(eventId);
    // A file too large to download is settled as a reference only; it has no bytes, text or guard source to wait for.
    const tooLarge=await this.attachments.tooLarge(eventId);
    const manifests=(await this.stores.archive.query('SELECT id,kind,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[eventId])).rows
      .filter(m=>m.file_hash||!tooLarge.has(m.id));
    const missing=manifests.filter(m=>!m.file_hash);
    if(missing.length) {
      const jobs=(await this.stores.control.query('SELECT * FROM attachment_retrievals WHERE artifact_id=ANY($1::text[])',[missing.map(m=>m.id)])).rows;
      const failed=jobs.some(j=>j.state==='failed'),attempts=Math.max(0,...jobs.map(j=>j.attempts));
      return observation(failed?'retryable_failed':'waiting','attachments',attempts,
        Math.min(Date.now()+30000,...jobs.filter(j=>j.error_code!=='import_bytes_pending').map(j=>j.next_attempt.getTime())),failed?'provider_unavailable':'prerequisite');
    }
    const selected=(await this.stores.derived.query(`SELECT s.artifact_id,r.derived_id FROM derivative_selections s
      JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
      WHERE s.event_id=$1 AND s.kind IN ('transcript','extracted_text','extraction_status')`,[eventId])).rows;
    const pending=manifests.filter(m=>!selected.some(s=>s.artifact_id===m.id));
    for(const manifest of pending) {
      const engine=['voice','audio','video_note'].includes(manifest.kind)?this.transcription:this.extraction;
      const id=digest('reprocess:initial:'+manifest.id+':'+digest(engine.name+':'+engine.version));
      const job=(await this.stores.control.query('SELECT attempts,error_code FROM reprocess_jobs WHERE id=$1',[id])).rows[0];
      if(job?.error_code==='invalid_transcription_response')return observation('failed','transcription',job.attempts);
    }
    if(pending.length)return observation('waiting','transcription',0,Date.now(),'prerequisite');
    const ids=['events:'+source.reference.id,...manifests.map(m=>'artifacts:'+m.id),...selected.map(s=>'derived_artifacts:'+s.derived_id)];
    const binding=await this.guards.state();
    const sources=(await this.stores.derived.query('SELECT id,state FROM guard_sources WHERE id=ANY($1::text[])',[ids])).rows;
    if(ids.some(id=>!sources.some(s=>s.id===id&&(binding.mode==='off'||s.state==='ready'))))
      return observation('waiting','preparation',0,Date.now(),'guard_pending');
    return observation('completed','preparation');
  }

  /** One existing workflow step; no timer or competing retry owner is added. */
  async run(eventId:string,fetchFile:(ref:string)=>Promise<Buffer>,detectorVersion:string,detect:(text:string,background?:boolean)=>Promise<unknown>,authority:ExecutionAuthority):Promise<Observation> {
    const client=await this.stores.control.connect();let fenced=false,locked=false,slot=-1;
    try {
      fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);
      if(!fenced)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      // Each event prepares once at a time, and up to `slots` events prepare side
      // by side (Settings: guard checks at once). The bound leaves connections for
      // cross-store publications and family cutover; contenders release promptly.
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,803357)) AS locked',[eventId])).rows[0].locked;
      if(!locked)return observation('waiting','preparation',0,Date.now()+2000,'receipt_pending');
      for(let candidate=0;candidate<this.slots&&slot<0;candidate++)
        if((await client.query('SELECT pg_try_advisory_lock(803357,$1) AS locked',[candidate])).rows[0].locked)slot=candidate;
      if(slot<0)return observation('waiting','preparation',0,Date.now()+2000,'receipt_pending');
      const source=(await this.attachments.archive.captured(eventId)).reference;
      const before=await this.status(eventId);if(before.state==='failed')return before;
      // An import is old history: its checks wait behind checks for replies.
      const job=(await client.query('SELECT job_id FROM import_sources WHERE event_id=$1 LIMIT 1',[eventId])).rows[0]?.job_id as string|undefined;
      const check=job?(text:string)=>detect(text,true):(text:string)=>detect(text);
      await this.guards.register(source);
      await this.attachments.fetch(eventId,fetchFile,authority);
      const manifests=(await this.stores.archive.query('SELECT id,kind,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[eventId])).rows;
      for(const manifest of manifests.filter(m=>m.file_hash)) {
        const file=await this.attachments.file(manifest.id);
        await this.guards.register(file);
        const selected=(await this.stores.derived.query(`SELECT s.kind,r.derived_id FROM derivative_selections s
          JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
          WHERE s.artifact_id=$1 AND s.kind IN ('transcript','extracted_text','extraction_status') LIMIT 1`,[file.id])).rows[0];
        if(!selected) {
          const engine=['voice','audio','video_note'].includes(manifest.kind)?this.transcription:this.extraction;
          const request=await this.reprocessing.request(file,engine.name,engine.version,{},'initial:'+file.id+':'+digest(engine.name+':'+engine.version));
          const output=await this.reprocessing.run(request,detectorVersion,check,authority);
          if(output)try {await this.selections.activate(output,null,digest('initial-selection:'+output.id),'automatic');}
          catch(error){if(!(error instanceof HttpError)||error.code!=='derivative_selection_conflict')throw error;}
        }
        if((await this.guards.state()).mode==='on')await this.guards.prepare(file,detectorVersion,check);
      }
      if((await this.guards.state()).mode==='on')await this.prepareSource(client,source,job,detectorVersion,check);
      return this.status(eventId);
    } finally {await releaseOperation(client,async()=>{
      if(slot>=0)await client.query('SELECT pg_advisory_unlock(803357,$1)',[slot]);
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803357))',[eventId]);
      if(fenced)await leaveFamily(client,'preparation');});}
  }

  /** An imported message is checked together with up to a page of the same import's unchecked
   *  messages. Each companion stays locked meanwhile, so its own preparation waits and then
   *  finds its text already checked. Files are still checked by each message's own preparation. */
  private async prepareSource(client:pg.PoolClient,source:SourceReference,job:string|undefined,version:string,detect:(text:string)=>Promise<unknown>) {
    if(!job)return this.guards.prepare(source,version,detect);
    // A message already checked has a guard publication, even while its own preparation still waits to finish.
    const candidates=(await client.query(`SELECT s.event_id,s.source_reference FROM import_sources s WHERE s.job_id=$1 AND s.event_id<>$2
      AND NOT EXISTS(SELECT 1 FROM guard_publications p WHERE p.source_id='events:'||s.event_id AND p.operation_kind='guard')
      AND NOT EXISTS(SELECT 1 FROM workflow_registry w WHERE w.family='preparation' AND w.job_id=s.event_id
        AND w.state IN ('completed','failed','skipped','cancelled','denied'))
      ORDER BY s.event_id LIMIT $3`,[job,source.id,COMPANIONS*2])).rows as {event_id:string;source_reference:SourceReference}[];
    const checked=new Set((await this.stores.derived.query(`SELECT source_id FROM guard_sources
      WHERE kind='events' AND source_id=ANY($1::text[]) AND active_revision IS NOT NULL`,[candidates.map(c=>c.event_id)])).rows.map(r=>r.source_id));
    const sizes=new Map((await this.stores.archive.query(`SELECT id,coalesce(octet_length(original_text),0)+octet_length(payload) AS size
      FROM events WHERE id=ANY($1::text[])`,[candidates.map(c=>c.event_id)])).rows.map(r=>[r.id,Number(r.size)]));
    const held:SourceReference[]=[];let budget=COMPANION_BYTES;
    try {
      for(const candidate of candidates) {
        if(held.length>=COMPANIONS||budget<=0)break;
        if(checked.has(candidate.event_id)||!sizes.has(candidate.event_id))continue;
        if(!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,803357)) AS locked',[candidate.event_id])).rows[0].locked)continue;
        held.push(candidate.source_reference);budget-=sizes.get(candidate.event_id)!;
      }
      if(held.length)try {return await this.guards.prepareMany(source,held,version,detect);}
      catch(error) {
        // A text the checker can't take must not hold back the page: each message is then checked alone.
        if(!(error instanceof HttpError)||error.code!=='detector_contract_rejected')throw error;
      }
      return await this.guards.prepare(source,version,detect);
    } finally {for(const companion of held)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803357))',[companion.id]);}
  }
}
