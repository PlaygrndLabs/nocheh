import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {HttpError,object,string} from './http.js';
import {assertAudience,type Reader} from './access.js';
import {spacePolicy,parentSpace,validateSpace} from './spaces.js';
import {digest} from './archive.js';
import type {RuntimeCall} from './runtime.js';

export const sharingSchema=`CREATE TABLE IF NOT EXISTS memory_filtered (
 id text PRIMARY KEY,space_id text NOT NULL,policy_revision integer NOT NULL,content text NOT NULL,source_ids jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes');`;
export async function shareKnowledge(pool:pg.Pool,input:unknown) {
  const b=object(input),destination=validateSpace(b.destination),content=string(b.content,12000);
  if(!content.trim()||!Array.isArray(b.source_ids)||b.source_ids.length>50||b.source_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(400,'invalid_shared_knowledge');
  const client=await pool.connect();try{await client.query('BEGIN');
    const revision=(await client.query('SELECT revision FROM memory_policy_state WHERE singleton=true FOR UPDATE')).rows[0].revision;
    if(b.revision!==revision)throw new HttpError(409,'space_revision_conflict');
    const ids=[...new Set(b.source_ids as string[])];
    if((await client.query('SELECT id FROM events WHERE id=ANY($1::text[])',[ids])).rowCount!==ids.length)throw new HttpError(404,'share_source_missing');
    const id=digest(randomUUID());
    await client.query('INSERT INTO memory_shares(id,destination,content,source_ids) VALUES($1,$2,$3,$4)',[id,destination,content,JSON.stringify(ids)]);
    await client.query('UPDATE memory_policy_state SET revision=revision+1');await client.query('COMMIT');return {id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function revokeShare(pool:pg.Pool,id:string,revision:unknown) {
  const client=await pool.connect();try{await client.query('BEGIN');
    if((await client.query('SELECT revision FROM memory_policy_state WHERE singleton=true FOR UPDATE')).rows[0].revision!==revision)throw new HttpError(409,'space_revision_conflict');
    if(!(await client.query('UPDATE memory_shares SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[id])).rowCount)throw new HttpError(404,'share_not_found');
    await client.query('UPDATE memory_policy_state SET revision=revision+1');await client.query('COMMIT');return {revoked:id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function listShares(pool:pg.Pool,destination:string) {
  return (await pool.query('SELECT * FROM memory_shares WHERE destination=ANY($1::text[]) ORDER BY created_at DESC LIMIT 200',[[validateSpace(destination),parentSpace(destination)??destination]])).rows;
}
export async function sharedContext(pool:pg.Pool,principal:Reader,query:string,call:RuntimeCall) {
  if(!principal.space || principal.scope===null)throw new HttpError(403,'space_context_required');
  string(query,2000);await assertAudience(pool,principal);
  const policy=await spacePolicy(pool,principal.space),mode=policy.effective.mode;
  if(mode==='isolated')return {sources:[],filter_status:'disabled'};
  const {rows}=await pool.query(`SELECT id,content FROM memory_shares WHERE destination=ANY($1::text[]) AND revoked_at IS NULL
    AND ($2='' OR to_tsvector('simple',content) @@ plainto_tsquery('simple',$2)) ORDER BY created_at DESC LIMIT 10`,[[principal.space,parentSpace(principal.space)??principal.space],query]);
  const sources=rows.map(row=>({id:row.id,source:'nocheh:shared:'+row.id,kind:'owner_approved',text:row.content}));
  if(mode!=='filtered'||!policy.effective.sources.length){await assertAudience(pool,principal);return {sources,filter_status:'disabled'};}
  const candidates=(await pool.query(`SELECT e.id,left(e.search_text,4000) AS text FROM events e JOIN event_spaces s ON s.event_id=e.id
    WHERE s.space_id=ANY($1::text[]) AND e.origin<>'generated' AND to_tsvector('simple',e.search_text) @@ plainto_tsquery('simple',$2) ORDER BY e.received_at DESC LIMIT 10`,[policy.effective.sources,query])).rows;
  if(!candidates.length){await assertAudience(pool,principal);return {sources,filter_status:'no_matches'};}
  try{
    const result=await call('memory.filter',{query,instructions:policy.effective.privacy_instructions,candidates},120000);
    if(!Array.isArray(result.items)||result.items.length>5)throw new HttpError(503,'privacy_contract_rejected');
    const valid=new Set(candidates.map(c=>c.id));
    const items=result.items.map(raw=>{const v=object(raw),text=string(v.text,2000);
      if(!text.trim()||!Array.isArray(v.source_ids)||!v.source_ids.length||v.source_ids.some(id=>!valid.has(id)))throw new HttpError(503,'privacy_contract_rejected');
      if(/nocheh:event:/.test(text)||[...valid].some(id=>text.includes(id)))throw new HttpError(503,'privacy_citation_rejected');
      return {text,ids:v.source_ids};});
    await assertAudience(pool,principal);
    const filtered=[];
    for(const item of items){const id=digest(randomUUID());await pool.query('INSERT INTO memory_filtered(id,space_id,policy_revision,content,source_ids) VALUES($1,$2,$3,$4,$5)',[id,principal.space,principal.revision,item.text,JSON.stringify(item.ids)]);
      filtered.push({id,source:'nocheh:filtered:'+id,kind:'privacy_filtered_inference',text:item.text});}
    await assertAudience(pool,principal);return {sources:[...sources,...filtered],filter_status:'passed'};
  }catch(error){await assertAudience(pool,principal);return {sources,filter_status:'unavailable',note:'Wider knowledge was withheld.'};}
}
export async function readShared(pool:pg.Pool,principal:Reader,kind:string,id:string) {
  if(!principal.space || principal.scope===null)throw new HttpError(403,'space_context_required');
  await assertAudience(pool,principal);const policy=await spacePolicy(pool,principal.space);
  let rows:Record<string,unknown>[]=[];
  if(kind==='shared' && policy.effective.mode!=='isolated')rows=(await pool.query('SELECT content FROM memory_shares WHERE id=$1 AND destination=ANY($2::text[]) AND revoked_at IS NULL',[id,[principal.space,parentSpace(principal.space)??principal.space]])).rows;
  if(kind==='filtered' && policy.effective.mode==='filtered')rows=(await pool.query('SELECT content FROM memory_filtered WHERE id=$1 AND space_id=$2 AND policy_revision=$3 AND expires_at>now()',[id,principal.space,principal.revision])).rows;
  if(!rows.length)throw new HttpError(404,'shared_source_not_found');await assertAudience(pool,principal);
  return {source:`nocheh:${kind}:${id}`,text:rows[0]!.content,kind:kind==='shared'?'owner_approved':'privacy_filtered_inference'};
}
