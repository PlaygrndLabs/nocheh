import type pg from 'pg';
import {readFile,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {graphGroupLabel} from '../graph-labels.js';
import {HttpError} from '../http.js';
import {syncDirectory} from '../storage.js';

/** One row per physical request a front door sent to a chat app, or refused itself. Content-free: codes and ids only. */
export const chatSendSchema=`
CREATE TABLE IF NOT EXISTS chat_sends(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_key text NOT NULL UNIQUE,
  channel text NOT NULL,
  account text,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  method text NOT NULL,
  chat text,
  topic bigint,
  message_id bigint,
  detail text,
  state text NOT NULL CHECK (state IN ('sent','failed','uncertain','not_sent')),
  status integer NOT NULL DEFAULT 0,
  error_code text,
  reference text,
  ms integer,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_sends_at ON chat_sends(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS chat_sends_problems ON chat_sends(at DESC, id DESC) WHERE state IN ('failed','uncertain');
`;

export const sendKinds=['reply','approved_send','approval_card','card_update','button_answer','refusal','notice','notice_update','reaction','typing','setup','other'] as const;
export const sendStates=['sent','failed','uncertain','not_sent'] as const;
/** Expected no-ops, and a chat's own choice not to take reactions: listed, never counted as problems. */
export const harmlessSendCodes=['message_not_modified','button_answer_expired','reaction_not_allowed'] as const;
export type ChatSend={version:1;key:string;channel:string;account:string|null;at:string;kind:typeof sendKinds[number];method:string;
  chat:string|null;topic:number|null;message_id:number|null;detail:string|null;state:typeof sendStates[number];status:number;
  error_code:string|null;reference:string|null;ms:number|null};

const FILE=/^[a-f0-9]{64}\.json$/,MAX_BYTES=16*1024,WINDOW_HOURS=24;
const KEY=/^send:([a-z][a-z0-9_]{0,31}):([A-Za-z0-9_.-]{0,64}):[a-f0-9]{32}$/;
const AT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const required=['version','key','channel','at','kind','method','state','status'],nullable=['account','chat','topic','message_id','detail','error_code','reference','ms'];
/** Within this time a retry of the same send that went through recovers the attempt before it. */
const RETRY_MINUTES=15;
/** An attempt a later one of the same send delivered: a plain-text resend, a short rate-limit wait, a fresh retry. */
const recovered=(s:string)=>`(${s}.state IN ('failed','uncertain') AND ${s}.reference IS NOT NULL AND EXISTS (SELECT 1 FROM chat_sends r
  WHERE r.state='sent' AND r.at>=${s}.at AND r.at<${s}.at+interval '${RETRY_MINUTES} minutes' AND r.id<>${s}.id AND r.channel=${s}.channel
  AND r.chat IS NOT DISTINCT FROM ${s}.chat AND r.method=${s}.method
  AND regexp_replace(r.reference,':retry:[0-9]+$','')=regexp_replace(${s}.reference,':retry:[0-9]+$','')))`;
const problem=(s:string)=>`(${s}.state IN ('failed','uncertain') AND coalesce(${s}.error_code,'') NOT IN (${harmlessSendCodes.map(code=>`'${code}'`).join(',')})
  AND NOT ${recovered(s)})`;
const text=(value:unknown,pattern:RegExp)=>typeof value==='string'&&pattern.test(value);
const integer=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;

/** Accept only the closed record shape; anything else is rejected whole. An absent nullable field reads as null. */
export function chatSend(value:unknown):ChatSend|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!required.includes(key)&&!nullable.includes(key))||required.some(key=>!(key in input)))return null;
  const r={...Object.fromEntries(nullable.map(key=>[key,null])),...input} as Record<string,any>;
  const key=typeof r.key==='string'&&r.key.length<=200?KEY.exec(r.key):null;
  if(r.version!==1||!key||!text(r.channel,/^[a-z][a-z0-9_]{0,31}$/)||key[1]!==r.channel)return null;
  if(r.account!==null&&(!text(r.account,/^[A-Za-z0-9_.-]{1,64}$/)||key[2]!==r.account))return null;
  if(!text(r.at,AT)||Number.isNaN(Date.parse(r.at))||new Date(r.at).toISOString()!==r.at)return null;
  if(!sendKinds.includes(r.kind)||!text(r.method,/^[A-Za-z][A-Za-z0-9_.]{0,63}$/)||!sendStates.includes(r.state))return null;
  if(r.chat!==null&&!text(r.chat,r.channel==='telegram'?/^-?\d{1,20}$/:/^[A-Za-z0-9_-]{1,64}$/))return null;
  for(const field of ['topic','message_id'])if(r[field]!==null&&!integer(r[field],-(2**53-1),2**53-1))return null;
  // A reaction names its emoji (no letters or digits) or "clear"; every other kind carries no detail.
  if(r.detail!==null&&(r.kind!=='reaction'||!text(r.detail,/^(?:clear|[^\p{L}\p{N}\s]{1,16})$/u)))return null;
  if(!integer(r.status,0,999)||(r.state==='sent'?r.error_code!==null:r.error_code!==null&&!text(r.error_code,/^[a-z0-9_]{1,64}$/)))return null;
  if(r.reference!==null&&!text(r.reference,/^[A-Za-z0-9_.:@=+/-]{1,300}$/)||r.ms!==null&&!integer(r.ms,0,2147483647))return null;
  return {version:1,key:r.key,channel:r.channel,account:r.account,at:r.at,kind:r.kind,method:r.method,chat:r.chat,topic:r.topic,
    message_id:r.message_id,detail:r.detail,state:r.state,status:r.status,error_code:r.error_code,reference:r.reference,ms:r.ms};
}

/** The owner's "Keep delivery logs" days, as the front doors read them: empty or 0 keeps every record. */
export function journalRetentionDays(value=process.env.NOCHEH_HERMES_JOURNAL_RETENTION_DAYS??''):number {
  const days=value.trim()||'0';
  if(!/^\d{1,4}$/.test(days)||Number(days)>3650)throw Error('invalid_journal_retention');
  return Number(days);
}

const cursors=new Map<string,string>();
/**
 * Send records from the front doors' spool. Records are a log for the owner and are never consulted to decide a
 * send. A record that can never become valid is removed; a database outage leaves the valid ones for the next pass.
 */
export class ChatSendRepository {
  constructor(readonly control:pg.Pool,readonly archive?:pg.Pool){}

  async drain(root:string,limit=500):Promise<{recorded:number;rejected:number}> {
    const directory=join(root,'spool','sends');let names:string[];
    try{names=(await readdir(directory)).filter(name=>FILE.test(name)).sort();}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {recorded:0,rejected:0};throw error;}
    // A file left unreadable must not starve later records.
    const start=Math.max(0,names.findIndex(name=>name>(cursors.get(root)??'')));
    const records:ChatSend[]=[],accepted:string[]=[],rejected:string[]=[];
    for(const name of [...names.slice(start),...names.slice(0,start)].slice(0,limit)) {
      cursors.set(root,name);let record:ChatSend|null;
      try {
        const path=join(directory,name);
        record=(await stat(path)).size>MAX_BYTES?null:chatSend(JSON.parse((await readFile(path)).toString('utf8')));
      } catch(error) {if(!(error instanceof SyntaxError))continue;record=null;}
      if(record&&`${digest(record.key)}.json`===name){records.push(record);accepted.push(name);}else rejected.push(name);
    }
    let failure:unknown,recorded=0;
    if(records.length)try {
      const column=<K extends keyof ChatSend>(key:K)=>records.map(record=>record[key]);
      recorded=(await this.control.query(`INSERT INTO chat_sends(record_key,channel,account,at,kind,method,chat,topic,message_id,detail,state,status,error_code,reference,ms)
        SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::timestamptz[],$5::text[],$6::text[],$7::text[],$8::bigint[],$9::bigint[],$10::text[],
          $11::text[],$12::int[],$13::text[],$14::text[],$15::int[]) ON CONFLICT(record_key) DO NOTHING`,
        [column('key'),column('channel'),column('account'),column('at'),column('kind'),column('method'),column('chat'),column('topic'),column('message_id'),
          column('detail'),column('state'),column('status'),column('error_code'),column('reference'),column('ms')])).rowCount??0;
    } catch(error){failure=error;}
    const removed=failure?rejected:[...accepted,...rejected];
    for(const name of removed)await unlink(join(directory,name)).catch(error=>{if(error?.code!=='ENOENT')throw error;});
    if(removed.length)await syncDirectory(directory);
    if(failure)throw failure;
    return {recorded,rejected:rejected.length};
  }

  /** Chat names are presentation only, from what Nocheh already saved; a failed lookup leaves them out. */
  private async titles(rows:{channel:string;chat:string|null}[]):Promise<Map<string,string>> {
    const chats=[...new Set(rows.filter(row=>row.channel==='telegram'&&row.chat).map(row=>row.chat!))],titles=new Map<string,string>();
    if(!chats.length)return titles;
    try {
      for(const row of (await this.control.query(`SELECT chat_id,title FROM telegram_chat_observations WHERE state='available' AND title IS NOT NULL
        AND chat_id=ANY($1::text[])`,[chats])).rows)titles.set(row.chat_id,row.title);
    } catch {}
    // A captured message names its chat as the directory does; it wins over an older refresh.
    if(this.archive)try {
      for(const row of (await this.archive.query(`SELECT c.scope,e.payload FROM unnest($1::text[]) AS c(scope) CROSS JOIN LATERAL (
        SELECT payload FROM events WHERE scope=c.scope AND channel='telegram' AND origin='live' AND kind='telegram_update'
          AND convert_from(payload,'UTF8')::jsonb ?| ARRAY['message','edited_message','channel_post','edited_channel_post']
        ORDER BY received_at DESC,id DESC LIMIT 1) e`,[chats])).rows) {
        const label=graphGroupLabel(row.payload,row.scope);if(label)titles.set(row.scope,label);
      }
    } catch {}
    return titles;
  }

  private async rows(rows:any[]) {
    const titles=await this.titles(rows);
    return rows.map(row=>({id:String(row.id),at:row.at.toISOString(),channel:row.channel,kind:row.kind,method:row.method,chat:row.chat,
      chat_title:row.channel==='telegram'&&row.chat?titles.get(row.chat)??null:null,topic:row.topic===null?null:Number(row.topic),
      message_id:row.message_id===null?null:Number(row.message_id),detail:row.detail,state:row.state,status:row.status,
      error_code:row.error_code,reference:row.reference,ms:row.ms,problem:row.problem===true,recovered:row.recovered===true}));
  }

  /** The last day's outcomes for Health; problems leave out harmless codes and recovered attempts, the newest problem is any age. */
  async summary(now=new Date()) {
    const since=new Date(now.getTime()-WINDOW_HOURS*3600000);
    const [states,kinds,last,latest]=await Promise.all([
      this.control.query('SELECT state,count(*)::int AS count FROM chat_sends WHERE at>$1 GROUP BY state',[since]),
      this.control.query(`SELECT kind,count(*)::int AS count FROM chat_sends s WHERE at>$1 AND ${problem('s')} GROUP BY kind ORDER BY kind`,[since]),
      this.control.query(`SELECT at FROM chat_sends s WHERE ${problem('s')} ORDER BY at DESC,id DESC LIMIT 1`),
      this.control.query(`SELECT s.*,true AS problem,false AS recovered FROM chat_sends s WHERE at>$1 AND ${problem('s')}
        ORDER BY at DESC,id DESC LIMIT 10`,[since])]);
    const counts:Record<string,number>=Object.fromEntries(sendStates.map(state=>[state,0]));
    for(const row of states.rows)counts[row.state]=row.count;
    const problemKinds:Record<string,number>=Object.fromEntries(kinds.rows.map(row=>[row.kind,row.count]));
    return {window_hours:WINDOW_HOURS,sent:counts.sent!,failed:counts.failed!,uncertain:counts.uncertain!,not_sent:counts.not_sent!,
      problems:Object.values(problemKinds).reduce((a,b)=>a+b,0),problem_kinds:problemKinds,
      last_problem_at:last.rows[0]?.at.toISOString()??null,latest_problems:await this.rows(latest.rows)};
  }

  /** Newest first; `before` is the id of the last row of the previous page. */
  async list(principal:Reader,query:{filter?:string;kind?:string;before?:string;limit?:number}={}) {
    admin(principal);
    const filter=query.filter||'all',kind=query.kind??'',before=query.before??'',count=query.limit??50;
    if(!['all','problems'].includes(filter)||kind&&!(sendKinds as readonly string[]).includes(kind)||before&&!/^[1-9][0-9]{0,17}$/.test(before)||
      !Number.isSafeInteger(count)||count<1||count>100)throw new HttpError(400,'invalid_chat_send_query');
    const rows=(await this.control.query(`SELECT s.*,${problem('s')} AS problem,${recovered('s')} AS recovered FROM chat_sends s
      WHERE ($1::bigint IS NULL OR (at,id)<(SELECT at,id FROM chat_sends WHERE id=$1))
      AND ($2='' OR kind=$2)${filter==='problems'?' AND '+problem('s'):''} ORDER BY at DESC,id DESC LIMIT $3`,[before||null,kind,count+1])).rows;
    return {records:await this.rows(rows.slice(0,count)),next:rows.length>count?String(rows[count-1].id):null};
  }

  /** Remove one bounded batch of records sent before the cutoff. */
  async prune(cutoff:Date,batch=5000):Promise<number> {
    if(!Number.isSafeInteger(batch)||batch<1)throw new HttpError(400,'invalid_retention_batch');
    return (await this.control.query('DELETE FROM chat_sends WHERE ctid IN (SELECT ctid FROM chat_sends WHERE at<$1 LIMIT $2)',[cutoff,batch])).rowCount??0;
  }

  /** Records follow the owner's delivery log setting; zero keeps every row. */
  async expire(now=Date.now(),days=journalRetentionDays()):Promise<number> {
    if(!days)return 0;
    let total=0;
    for(let batch=0;batch<20;batch++){const removed=await this.prune(new Date(now-days*86400000));total+=removed;if(removed<5000)break;}
    return total;
  }
}
