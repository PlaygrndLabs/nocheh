import type pg from 'pg';
import {digest,envelope} from '../archive.js';
import {captureEvidence} from './generated-capture.js';
import {sourceContentTypes} from '../source-content.js';

type RecordRow={id:string;kind:string;scope:string};
export type ReplyPreview={id:string;text:string|null;received_at:string;content_types:string[]};

async function sourcePrefixes(archive:pg.Pool,records:RecordRow[]){
  const incoming=records.filter(row=>row.kind==='telegram_update');
  if(!incoming.length)return new Map<string,string>();
  const sources=(await archive.query('SELECT id,source_key,bot_id FROM events WHERE id=ANY($1::text[])',[incoming.map(row=>row.id)])).rows;
  const prefixes=new Map<string,string>();
  for(const source of sources)if(/^telegram:[A-Za-z0-9]+:update:[0-9]+$/.test(source.source_key)&&/^[A-Za-z0-9]+$/.test(source.bot_id))
    prefixes.set(`outbound:${source.bot_id}:${source.source_key}:`,source.id);
  return prefixes;
}

async function previewRows(archive:pg.Pool,records:RecordRow[],candidate:Map<string,Set<string>>):Promise<Map<string,ReplyPreview[]>> {
  const ids=[...new Set([...candidate.values()].flatMap(values=>[...values]))];
  if(!ids.length)return new Map();
  const replies=(await archive.query(`SELECT id,scope,kind,original_text,received_at,payload,
    (SELECT array_agg(a.kind ORDER BY a.id) FROM artifacts a WHERE a.event_id=events.id) AS artifact_kinds FROM events
    WHERE id=ANY($1::text[]) AND kind='telegram_delivered_message'`,[ids])).rows;
  const byId=new Map(replies.map(row=>[row.id,row]));
  const scopeById=new Map(records.map(row=>[row.id,row.scope]));
  const linked=new Map<string,ReplyPreview[]>();
  for(const [parent,children] of candidate) {
    const previews=[...children].map(id=>byId.get(id)).filter(row=>row&&row.kind==='telegram_delivered_message'&&row.scope===scopeById.get(parent))
      .sort((a,b)=>b.received_at.getTime()-a.received_at.getTime()||b.id.localeCompare(a.id)).slice(0,3)
      .map(row=>({id:row.id,text:row.original_text?.toString().slice(0,500)??null,received_at:row.received_at.toISOString(),
        content_types:sourceContentTypes(row.kind,row.payload?JSON.parse(row.payload.toString()):{},row.artifact_kinds??[])}));
    if(previews.length)linked.set(parent,previews);
  }
  return linked;
}

/** A confirmed delivery receipt is the causal link when Telegram did not send a native reply_to_message. */
export async function archiveReplyPreviews(archive:pg.Pool,control:pg.Pool,records:RecordRow[]):Promise<Map<string,ReplyPreview[]>> {
  const prefixes=await sourcePrefixes(archive,records);
  if(!prefixes.size)return new Map();
  const receipts=(await control.query(`SELECT o.operation_key,r.sources FROM content_operations o
    JOIN capture_effect_receipts r ON r.operation_id=o.id
    WHERE o.kind='outbound_result' AND r.state='delivered' AND o.operation_key LIKE ANY($1::text[])
    ORDER BY o.created_at DESC LIMIT 500`,[[...prefixes.keys()].map(prefix=>prefix+'%')])).rows;
  const candidate=new Map<string,Set<string>>();
  for(const receipt of receipts) {
    const parent=[...prefixes].find(([prefix])=>receipt.operation_key.startsWith(prefix))?.[1];
    if(!parent||!Array.isArray(receipt.sources))continue;
    const ids=candidate.get(parent)??new Set<string>();
    for(const reference of receipt.sources)if(typeof reference?.id==='string'&&/^[a-f0-9]{64}$/.test(reference.id))ids.add(reference.id);
    candidate.set(parent,ids);
  }
  return previewRows(archive,records,candidate);
}

/** Legacy receipts live in the archive itself; derive exactly the same observed delivery IDs as spool reconciliation. */
export async function legacyArchiveReplyPreviews(pool:pg.Pool,records:RecordRow[]):Promise<Map<string,ReplyPreview[]>> {
  const prefixes=await sourcePrefixes(pool,records);
  if(!prefixes.size)return new Map();
  const receipts=(await pool.query(`SELECT source_key,channel,bot_id,scope,source_id,revision,occurred_at,original_text,payload
    FROM events WHERE origin='generated' AND kind='outbound_result' AND source_key LIKE ANY($1::text[])
    ORDER BY received_at DESC LIMIT 500`,[[...prefixes.keys()].map(prefix=>prefix+'%')])).rows;
  const candidate=new Map<string,Set<string>>();
  for(const receipt of receipts) {
    const parent=[...prefixes].find(([prefix])=>receipt.source_key.startsWith(prefix))?.[1];
    if(!parent)continue;
    const value=envelope({version:1,key:receipt.source_key,channel:receipt.channel,origin:'generated',bot_id:receipt.bot_id,
      kind:'outbound_result',scope:receipt.scope,source_id:receipt.source_id,revision:receipt.revision,
      occurred_at:receipt.occurred_at,text:receipt.original_text?.toString()??null,payload:JSON.parse(receipt.payload.toString())});
    const ids=candidate.get(parent)??new Set<string>();
    for(const original of captureEvidence(value).originals)ids.add(digest(original.key));
    candidate.set(parent,ids);
  }
  return previewRows(pool,records,candidate);
}
