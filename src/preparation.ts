import type pg from 'pg';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from './archive.js';
import {prepareTranscripts} from './assistant.js';
import type {RuntimeCall} from './runtime.js';
import {enterFamily,leaveFamily,releaseOperation,legacyAuthority,type ExecutionAuthority} from './workflows/store.js';

// Imports and live capture share the same preparation path. Unsupported bytes
// remain in the original file store; a binary is never labelled guarded text.
export async function prepareArchiveFiles(pool:pg.Pool,root:string,call:RuntimeCall,eventId:string|null=null,authority:ExecutionAuthority=legacyAuthority) {
  const client=await pool.connect();let locked=false,fenced=false;
  try {
    fenced=await enterFamily(client,'preparation',authority.owner,authority.epoch);if(!fenced)return;
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema(),803310)) AS locked')).rows[0].locked;if(!locked)return;
    const {rows}=await client.query(`SELECT a.* FROM artifacts a LEFT JOIN transcription_jobs t ON t.artifact_id=a.id WHERE a.state='ready'
      AND NOT EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.artifact_id=a.id AND d.kind IN ('transcript','extracted_text','extraction_status'))
      AND (t.artifact_id IS NULL OR t.next_attempt<=now()) AND ($1::text IS NULL OR a.event_id=$1) ORDER BY a.id LIMIT 10`,[eventId]);
    for(const row of rows) {
      if(['voice','audio','video_note'].includes(row.kind)){await prepareTranscripts(client,root,row.event_id,call,authority);continue;}
      if(!/^[a-f0-9]{64}$/.test(row.file_hash))continue;
      const bytes=await readFile(join(root,'files',row.file_hash));if(digest(bytes)!==row.file_hash)continue;
      let text:string|null=null;
      if(!['photo','image','video','sticker','animation'].includes(row.kind)&&bytes.length<=200000&&!bytes.includes(0)) {
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* original binary remains retrievable by the owner */}
      }
      const kind=text===null?'extraction_status':'extracted_text',id=digest(row.id+(text===null?':unsupported:utf8-v1':':text:utf8-v1'));
      await client.query(`INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,search_text,provenance) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [id,row.event_id,row.id,kind,Buffer.from(text??'Text extraction is unavailable for this original file.'),(text??'').replaceAll('\0',''),JSON.stringify({extractor:'utf8-v1',input_sha256:row.file_hash,supported:text!==null})]);
    }
  }finally{await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803310))');if(fenced)await leaveFamily(client,'preparation');});}
}
