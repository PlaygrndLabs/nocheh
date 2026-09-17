import type pg from 'pg';
import {readFile,readdir,mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {digest,envelope} from '../archive.js';
import {syncDirectory} from '../storage.js';
import {HttpError} from '../http.js';
import {ArchiveRepository,type CapturedSource} from './archive.js';
import {requestWorkflow} from '../workflows/store.js';

export class CaptureCoordinator {
  constructor(readonly archive:ArchiveRepository,readonly control:pg.Pool){}

  private async request(client:pg.PoolClient,source:CapturedSource):Promise<void> {
    await client.query(`INSERT INTO capture_handoffs(event_id,source_revision,payload_hash) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING`,[source.reference.id,source.reference.revision,source.reference.input_hash]);
    const previous=(await client.query('SELECT source_revision,payload_hash FROM capture_handoffs WHERE event_id=$1',[source.reference.id])).rows[0];
    if(previous.source_revision!==source.reference.revision||previous.payload_hash!==source.reference.input_hash)
      throw new HttpError(409,'capture_handoff_conflict');
    await requestWorkflow(client,'preparation',source.reference.id);
    if(source.origin==='live'&&source.kind!=='telegram_wire') {
      await requestWorkflow(client,'memory_review','source:'+source.reference.id);
      if(source.channel==='telegram'&&source.kind==='telegram_update')await requestWorkflow(client,'telegram',source.reference.id);
    }
    for(const id of source.artifact_ids)await client.query(`INSERT INTO attachment_retrievals(artifact_id,event_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`,[id,source.reference.id]);
  }

  async handoff(source:CapturedSource):Promise<void> {
    const client=await this.control.connect();
    try {
      await client.query('BEGIN');
      await this.request(client,source);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }

  async capture(value:unknown):Promise<{source:CapturedSource;duplicate:boolean}> {
    const captured=await this.archive.capture(value);
    await this.handoff(captured.source);return captured;
  }

  /** Repeated full sweeps handle sequence allocation/commit reordering too. */
  async reconcile(limit=100):Promise<number> {
    const client=await this.control.connect();
    try {
      await client.query('BEGIN');
      const cursor=(await client.query('SELECT after_sequence FROM capture_reconciliation WHERE singleton FOR UPDATE')).rows[0];
      const sources=await this.archive.page(String(cursor.after_sequence),limit);
      for(const source of sources)await this.request(client,source);
      await client.query('UPDATE capture_reconciliation SET after_sequence=$1 WHERE singleton',[sources.at(-1)?.sequence??'0']);
      await client.query('COMMIT');return sources.length;
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
}

const cursors=new Map<string,string>();
/** Retire originals only after both commits; failed control writes do not stop capture. */
export async function drainSourceSpool(coordinator:CaptureCoordinator,root:string):Promise<void> {
  const directory=join(root,'spool','pending');await mkdir(directory,{recursive:true,mode:0o700});
  const names=(await readdir(directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();
  const start=Math.max(0,names.findIndex(n=>n>(cursors.get(root)??'')));
  const captured:{name:string;source:CapturedSource}[]=[];
  const failures:{name:string;code:string}[]=[];
  for(const name of [...names.slice(start),...names.slice(0,start)].slice(0,100)) {
    cursors.set(root,name);
    try {
      const bytes=await readFile(join(directory,name));
      if(bytes.length>16*1024*1024)throw new HttpError(413,'spool_too_large');
      const value=envelope(JSON.parse(bytes.toString()));
      if(`${digest(value.key)}.json`!==name)throw new HttpError(400,'spool_identity_mismatch');
      captured.push({name,source:(await coordinator.archive.capture(value)).source});
    } catch(error) {failures.push({name,code:error instanceof HttpError?error.code:'capture_commit_failed'});}
  }
  // Commit the entire bounded archive batch before touching control. A control
  // outage cannot delay later originals in this batch behind failed handoffs.
  for(const {name,source} of captured) {
    try {
      await coordinator.handoff(source);
      await unlink(join(directory,name));await syncDirectory(directory);
      await coordinator.control.query('DELETE FROM spool_failures WHERE file_name=$1',[name]);
    } catch(error) {
      failures.push({name,code:error instanceof HttpError?error.code:'capture_commit_failed'});
      // Availability failures affect the rest of this control batch equally;
      // retry them on the next drain instead of spending one timeout per item.
      if(!(error instanceof HttpError))break;
    }
  }
  for(const {name,code} of failures) {
    try {await coordinator.control.query(`INSERT INTO spool_failures(file_name,error_code) VALUES($1,$2)
      ON CONFLICT(file_name) DO UPDATE SET attempts=spool_failures.attempts+1,error_code=$2,seen_at=now()`,[name,code]);}
    catch {break;}
  }
}
