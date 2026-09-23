import { mkdir, open, link, unlink, readFile, readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { digest, envelope, ingest } from './archive.js';
import {captureEvidence} from './stores/generated-capture.js';
import { HttpError } from './http.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from './workflows/store.js';

export async function syncDirectory(path:string):Promise<void> {
  const dir=await open(path,'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function immutableFile(directory:string, name:string, bytes:Buffer):Promise<void> {
  const created=await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,name), temporary=join(directory,`.${randomUUID()}.tmp`);
  const file=await open(temporary,'wx',0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try { await link(temporary,path); }
  catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readFile(path)).equals(bytes)) throw new HttpError(409,'immutable_file_conflict');
  } finally { await unlink(temporary); }
  await syncDirectory(directory);
  // On a fresh installation, persist the newly created directory entries too.
  if(created)for(let parent=dirname(directory);;parent=dirname(parent)) {
    await syncDirectory(parent);if(parent===dirname(created))break;
  }
}
export async function storeBytes(root:string,bytes:Buffer):Promise<string> {
  const hash=digest(bytes); await immutableFile(join(root,'files'),hash,bytes); return hash;
}
const spoolCursors = new Map<string,string>();
const deliveryCursors = new Map<string,{after:string;complete:boolean}>();

/** Recover delivered source messages from receipts committed before legacy capture
 * learned to project them. A bounded pass runs alongside ordinary spool draining. */
export async function reconcileLegacyDeliveries(pool:pg.Pool,root:string):Promise<void> {
  const cursor=deliveryCursors.get(root)??{after:'',complete:false};
  if(cursor.complete)return;
  const rows=(await pool.query(`SELECT id,source_key,channel,bot_id,scope,source_id,revision,occurred_at,
    original_text,payload FROM events WHERE id>$1 AND origin='generated' AND kind='outbound_result'
    ORDER BY id LIMIT 100`,[cursor.after])).rows;
  for(const row of rows) {
    const value=envelope({version:1,key:row.source_key,channel:row.channel,origin:'generated',
      bot_id:row.bot_id,kind:'outbound_result',scope:row.scope,source_id:row.source_id,
      revision:row.revision,occurred_at:row.occurred_at,text:row.original_text?.toString()??null,
      payload:JSON.parse(row.payload.toString())});
    for(const original of captureEvidence(value).originals)await ingest(pool,original,false);
    cursor.after=row.id;
  }
  cursor.complete=rows.length<100;
  deliveryCursors.set(root,cursor);
}
export async function drainSpool(pool:pg.Pool,root:string):Promise<void> {
  const directory=join(root,'spool','pending'); await mkdir(directory,{recursive:true,mode:0o700});
  const names=(await readdir(directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();
  const start=Math.max(0,names.findIndex(n=>n>(spoolCursors.get(root) ?? '')));
  // A retained malformed entry must not starve later valid captures.
  for (const name of [...names.slice(start),...names.slice(0,start)].slice(0,100)) {
    spoolCursors.set(root,name);
    try {
      const bytes=await readFile(join(directory,name));
      if (bytes.length>16*1024*1024) throw new HttpError(413,'spool_too_large');
      const value=envelope(JSON.parse(bytes.toString('utf8')));
      if (`${digest(value.key)}.json` !== name) throw new HttpError(400,'spool_identity_mismatch');
      await ingest(pool,value);
      if(value.origin==='generated')for(const original of captureEvidence(value).originals)
        await ingest(pool,original,false);
      await unlink(join(directory,name)); await syncDirectory(directory);
      await pool.query('DELETE FROM spool_failures WHERE file_name=$1',[name]);
    } catch(error) {
      // An unavailable DB leaves the fsynced original in place; never drop a failed entry.
      try { await pool.query(`INSERT INTO spool_failures(file_name,error_code) VALUES($1,$2)
        ON CONFLICT(file_name) DO UPDATE SET attempts=spool_failures.attempts+1,error_code=$2,seen_at=now()`,
      [name,error instanceof HttpError ? error.code : 'capture_commit_failed']); }
      catch { return; }
    }
  }
  await reconcileLegacyDeliveries(pool,root);
}

export async function fetchAttachments(pool:pg.Pool, root:string, fetchFile:(ref:string)=>Promise<Buffer>,eventId:string|null=null,authority:ExecutionAuthority):Promise<void> {
  const client=await pool.connect();
  // One short batch per worker. An advisory lock prevents duplicate downloads by extra workers.
  let locked=false,fenced=false;
  try {
    fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);if(!fenced)return;
    locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(803301) AS locked')).rows[0]?.locked ?? false;
    if (!locked) return;
    const rows=await client.query<{id:string;source_ref:string}> (`SELECT a.id,a.source_ref FROM artifacts a JOIN events e ON e.id=a.event_id
      WHERE e.channel='telegram' AND a.state<>'ready' AND a.source_ref NOT LIKE 'desktop:%' AND a.error_code IS DISTINCT FROM 'import_bytes_pending'
      AND a.next_attempt<=now() AND ($1::text IS NULL OR a.event_id=$1) ORDER BY a.next_attempt LIMIT 10`,[eventId]);
    for (const artifact of rows.rows) {
      try {
        const bytes=await fetchFile(artifact.source_ref);
        if (!bytes.length || bytes.length>50*1024*1024) throw new HttpError(413,'attachment_size_limit');
        const hash=await storeBytes(root,bytes);
        await client.query(`UPDATE artifacts SET state='ready',file_hash=$2,byte_size=$3,attempts=attempts+1,error_code=NULL WHERE id=$1`,[artifact.id,hash,bytes.length]);
      } catch(error) {
        await client.query(`UPDATE artifacts SET state='failed',attempts=attempts+1,error_code=$2,next_attempt=now()+least(3600,power(2,least(attempts+1,11))) * interval '1 second' WHERE id=$1`,
          [artifact.id,error instanceof HttpError ? error.code : 'attachment_unavailable']);
      }
    }
  } finally {await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(803301)');if(fenced)await leaveFamily(client,'preparation');});}
}
