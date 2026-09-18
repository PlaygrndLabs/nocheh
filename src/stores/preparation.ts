import {digest} from '../archive.js';
import {HttpError} from '../http.js';
import {observation,type Observation} from '../workflows/pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import {AttachmentRepository} from './attachments.js';
import {GuardRepository} from './guards.js';
import {ReprocessingRepository,type DerivationEngine} from './reprocessing.js';
import {SelectionRepository} from './selections.js';

export class PreparationRepository {
  constructor(readonly attachments:AttachmentRepository,readonly reprocessing:ReprocessingRepository,
    readonly guards:GuardRepository,readonly selections:SelectionRepository,readonly transcription:DerivationEngine,readonly extraction:DerivationEngine){}
  private get stores(){return this.attachments.stores;}

  async status(eventId:string):Promise<Observation> {
    const source=await this.attachments.archive.captured(eventId);
    const manifests=(await this.stores.archive.query('SELECT id,file_hash FROM artifacts WHERE event_id=$1 ORDER BY id',[eventId])).rows;
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
    if(manifests.some(m=>!selected.some(s=>s.artifact_id===m.id)))return observation('waiting','transcription',0,Date.now(),'prerequisite');
    const ids=['events:'+source.reference.id,...manifests.map(m=>'artifacts:'+m.id),...selected.map(s=>'derived_artifacts:'+s.derived_id)];
    const binding=await this.guards.state();
    const sources=(await this.stores.derived.query('SELECT id,state FROM guard_sources WHERE id=ANY($1::text[])',[ids])).rows;
    if(ids.some(id=>!sources.some(s=>s.id===id&&(binding.mode==='off'||s.state==='ready'))))
      return observation('waiting','preparation',0,Date.now(),'guard_pending');
    return observation('completed','preparation');
  }

  /** One existing workflow step; no timer or competing retry owner is added. */
  async run(eventId:string,fetchFile:(ref:string)=>Promise<Buffer>,detectorVersion:string,detect:(text:string)=>Promise<unknown>,authority:ExecutionAuthority):Promise<Observation> {
    const client=await this.stores.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);
      if(!fenced)return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
      // One bounded preparation batch leaves connections available for its
      // cross-store publications and family cutover; contenders release promptly.
      locked=(await client.query('SELECT pg_try_advisory_lock(803357) AS locked')).rows[0].locked;
      if(!locked)return observation('waiting','preparation',0,Date.now()+2000,'receipt_pending');
      const source=(await this.attachments.archive.captured(eventId)).reference;
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
          const job=await this.reprocessing.request(file,engine.name,engine.version,{},'initial:'+file.id+':'+digest(engine.name+':'+engine.version));
          const output=await this.reprocessing.run(job,detectorVersion,detect,authority);
          if(output)try {await this.selections.activate(output,null,digest('initial-selection:'+output.id),'automatic');}
          catch(error){if(!(error instanceof HttpError)||error.code!=='derivative_selection_conflict')throw error;}
        }
        if((await this.guards.state()).mode==='on')await this.guards.prepare(file,detectorVersion,detect);
      }
      if((await this.guards.state()).mode==='on')await this.guards.prepare(source,detectorVersion,detect);
      return this.status(eventId);
    } finally {await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(803357)');if(fenced)await leaveFamily(client,'preparation');});}
  }
}
