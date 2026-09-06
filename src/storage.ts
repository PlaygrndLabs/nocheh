import { mkdir, open, link, unlink, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { digest, envelope, ingest } from './archive.js';
import { HttpError } from './http.js';

export async function syncDirectory(path:string):Promise<void> {
  const dir=await open(path,'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function immutableFile(directory:string, name:string, bytes:Buffer):Promise<void> {
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,name), temporary=join(directory,`.${randomUUID()}.tmp`);
  const file=await open(temporary,'wx',0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try { await link(temporary,path); }
  catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readFile(path)).equals(bytes)) throw new HttpError(409,'immutable_file_conflict');
  } finally { await unlink(temporary); }
  await syncDirectory(directory);
}
export async function storeBytes(root:string,bytes:Buffer):Promise<string> {
  const hash=digest(bytes); await immutableFile(join(root,'files'),hash,bytes); return hash;
}
const spoolCursors = new Map<string,string>();
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
}

export async function fetchAttachments(pool:pg.Pool, root:string, fetchFile:(ref:string)=>Promise<Buffer>):Promise<void> {
  const client=await pool.connect();
  // One short batch per worker. An advisory lock prevents duplicate downloads by extra workers.
  let locked=false;
  try {
    locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(803301) AS locked')).rows[0]?.locked ?? false;
    if (!locked) return;
    const rows=await client.query<{id:string;source_ref:string}> (`SELECT id,source_ref FROM artifacts WHERE state<>'ready'
      AND source_ref NOT LIKE 'desktop:%' AND error_code IS DISTINCT FROM 'import_bytes_pending'
      AND next_attempt<=now() ORDER BY next_attempt LIMIT 10`);
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
  } finally { if (locked) await client.query('SELECT pg_advisory_unlock(803301)').catch(()=>{}); client.release(); }
}
