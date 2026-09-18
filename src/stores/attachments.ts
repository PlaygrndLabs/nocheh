import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from '../archive.js';
import {HttpError} from '../http.js';
import {storeBytes} from '../storage.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from '../workflows/store.js';
import {ArchiveRepository,type FileReference} from './archive.js';
import type {StorePools} from './connections.js';

export class AttachmentRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly root:string){}
  async file(id:string):Promise<FileReference> {
    const row=(await this.stores.archive.query('SELECT event_id,file_hash,byte_size FROM artifacts WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'source_not_found');
    if(!row.file_hash)throw new HttpError(409,'artifact_unavailable');
    return {store:'archive',kind:'file',id,event:(await this.archive.captured(row.event_id)).reference,input_hash:row.file_hash,byte_size:Number(row.byte_size)};
  }
  async bytes(file:FileReference):Promise<Buffer> {
    const current=await this.file(file.id);
    if(current.input_hash!==file.input_hash||current.byte_size!==file.byte_size||current.event.id!==file.event.id)
      throw new HttpError(409,'file_reference_conflict');
    await this.archive.verify(file.event);
    const bytes=await readFile(join(this.root,'files',current.input_hash));
    if(digest(bytes)!==file.input_hash||bytes.length!==file.byte_size)throw new HttpError(409,'original_file_integrity_failed');
    return bytes;
  }
  /** Original bytes and manifest commit before the recoverable control receipt. */
  async commit(id:string,bytes:Buffer):Promise<FileReference> {
    if(!bytes.length||bytes.length>50*1024*1024)throw new HttpError(413,'attachment_size_limit');
    const row=(await this.stores.archive.query('SELECT event_id,file_hash FROM artifacts WHERE id=$1',[id])).rows[0];
    if(!row)throw new HttpError(404,'source_not_found');
    if(row.file_hash&&row.file_hash!==digest(bytes))throw new HttpError(409,'file_manifest_conflict');
    const hash=await storeBytes(this.root,bytes),file=await this.archive.attach(id,hash,bytes.length);
    await this.stores.control.query(`INSERT INTO attachment_retrievals(artifact_id,event_id,state) VALUES($1,$2,'done')
      ON CONFLICT(artifact_id) DO UPDATE SET state='done',error_code=NULL`,[id,row.event_id]);
    return file;
  }
  /** Safe read-only provider retry. A persisted manifest is checked before download. */
  async fetch(eventId:string,fetchFile:(ref:string)=>Promise<Buffer>,authority:ExecutionAuthority):Promise<void> {
    await this.archive.captured(eventId);
    const client=await this.stores.control.connect();let fenced=false,locked=false;
    try {
      fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);if(!fenced)return;
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,803356)) AS locked',[eventId])).rows[0].locked;if(!locked)return;
      const manifests=(await this.stores.archive.query(`SELECT a.*,e.channel,e.origin FROM artifacts a JOIN events e ON e.id=a.event_id
        WHERE event_id=$1 ORDER BY id`,[eventId])).rows;
      let downloaded=0;
      for(const manifest of manifests) {
        await client.query('INSERT INTO attachment_retrievals(artifact_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[manifest.id,eventId]);
        if(manifest.file_hash) {
          const file=await this.file(manifest.id);await this.bytes(file);
          await client.query("UPDATE attachment_retrievals SET state='done',error_code=NULL WHERE artifact_id=$1",[manifest.id]);continue;
        }
        const job=(await client.query('SELECT * FROM attachment_retrievals WHERE artifact_id=$1',[manifest.id])).rows[0];
        if(manifest.origin==='import'||manifest.channel!=='telegram'||manifest.source_ref.startsWith('desktop:')) {
          await client.query("UPDATE attachment_retrievals SET state='pending',error_code='import_bytes_pending' WHERE artifact_id=$1",[manifest.id]);continue;
        }
        if(downloaded>=10||job.next_attempt>new Date())continue;downloaded++;
        await client.query("UPDATE attachment_retrievals SET state='running',attempts=attempts+1,error_code=NULL WHERE artifact_id=$1",[manifest.id]);
        try {await this.commit(manifest.id,await fetchFile(manifest.source_ref));}
        catch(error) {
          await client.query(`UPDATE attachment_retrievals SET state='failed',error_code=$2,
            next_attempt=now()+least(3600,power(2,least(attempts,11)))*interval '1 second' WHERE artifact_id=$1`,
            [manifest.id,error instanceof HttpError?error.code:'attachment_unavailable']);
        }
      }
    } finally {await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803356))',[eventId]);if(fenced)await leaveFamily(client,'preparation');});}
  }
}
