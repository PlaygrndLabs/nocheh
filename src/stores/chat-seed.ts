import type pg from 'pg';
import type {AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor,chatIdFor,type ChatState} from '../chats.js';
import {legacyChat,legacyChatValue} from '../chats-telegram.js';
import {bumpChatRevision,ensureConnection,namePrivateChats,startChatDirectory,type ChatRepository} from './chats.js';

/*
 * The chat seeder (ADR-0252). Every chat value Nocheh stored before step 2b stays, unchanged, as that chat's Nocheh id:
 * the seeder gives each one a chats row (and a chat_ids row for its Telegram id), and only inserts. The one value it
 * fills in on a row already there is a private chat's person where the row names none (a chat a reset restored or an
 * owner record brought; namePrivateChats). It never changes a value already set and never deletes a row anywhere, so
 * running it again changes nothing, and the archive is only read. legacyChat() (the Telegram adapter) is the only
 * reader of the old format (a Telegram chat id, optionally with one of its topics).
 *
 * It reads every place a chat value is stored: the columns below, the archive's events.scope and the topics its
 * observations name, TELEGRAM_OWNER_ID and TELEGRAM_GROUP_IDS, and the two Telegram tables step 2b-1 keeps read-only
 * (telegram_chat_observations, telegram_topic_registrations). Values that name no chat ('owner', '*', 'system',
 * 'desktop:*', import scopes, digests) get no row. A group Telegram upgraded before step 2b stays two chats, the old
 * one removed, as it was. Chats first seen later get their rows, with chatIdFor ids, when they are captured; after the
 * first seeding, a chat the seeder finds only in TELEGRAM_GROUP_IDS, TELEGRAM_OWNER_ID or the archive gets one too,
 * while a stored value keeps naming its chat by itself.
 */

/** A stored column that holds chat values, and how its values are read. */
export interface SeedColumn {
  store:'control'|'derived';table:string;column:string;
  /** text: the value itself; text_array: a text[]; jsonb_array: a JSON array of strings; task_change: a task history
   * entry's group change, a value or {from,to}. */
  shape:'text'|'text_array'|'jsonb_array'|'task_change';where?:string;
}
const column=(store:SeedColumn['store'],table:string,name:string,shape:SeedColumn['shape']='text',where?:string):SeedColumn=>
  ({store,table,column:name,shape,...(where?{where}:{})});
/** Every column that stores a chat or space value. test/store-chat-seed.test.ts introspects the schema and fails when
 * a chat-like column is in neither this list nor its list of columns that are not chats. */
export const chatSeedColumns:readonly SeedColumn[]=[
  column('control','action_permissions','scope'),column('control','action_permissions','space_id'),
  column('control','background_jobs','scope'),column('control','background_jobs','space_id'),column('control','background_jobs','target'),
  column('control','chat_tool_settings','space_id'),
  column('control','content_operations','scope'),
  column('control','controlled_actions','scope'),column('control','controlled_actions','space_id'),
  column('control','interpretation_jobs','audience'),
  column('control','knowledge_proposals','source_scope'),
  column('control','managed_runs','scope'),column('control','managed_runs','space_id'),
  column('control','memory_access_requests','destination'),column('control','memory_access_requests','source_scope'),
  column('control','memory_access_settings','destination'),
  column('control','memory_fact_grants','destination'),
  column('control','memory_generations','audience'),column('control','memory_generations','root_space'),
  column('control','memory_ingestion_receipts','audience'),
  column('control','memory_sessions','audience'),
  column('control','organization_delegations','scopes','jsonb_array'),
  column('control','owner_task_activity','changes','task_change'),
  column('control','owner_task_reminder_batches','group_id'),
  column('control','owner_task_reminders','set_in_chat_id'),column('control','owner_task_reminders','set_in_group_id'),
  column('control','owner_task_requests','group_id'),column('control','owner_task_requests','chats','text_array'),
  column('control','owner_task_writers','chat_id'),column('control','owner_task_writers','group_id'),
  column('control','owner_tasks','group_id'),
  column('control','private_answers','from_chat_id'),column('control','private_answers','reply_chat_id'),column('control','private_answers','read_chats','text_array'),
  column('control','project_assignments','space_id'),
  column('control','runtime_turns','space_id'),
  column('control','security_events','scope'),
  column('control','sharing_rules','destination'),column('control','sharing_rules','sources','jsonb_array'),
  column('control','telegram_action_requests','scope'),column('control','telegram_action_requests','space_id'),column('control','telegram_action_requests','destination'),
  column('control','telegram_action_requests','card_space'),
  column('control','workflow_imports','scopes','text_array'),
  column('control','workflow_schedules','scope'),
  column('derived','learned_entries','scope_id','text',`scope_kind='conversation'`),
  column('derived','runtime_prepared_inputs','audience'),column('derived','runtime_prepared_values','audience'),
];
const ident=(name:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(name))throw Error('invalid_seed_column');return '"'+name+'"';};
function distinct(source:SeedColumn):string {
  const table=ident(source.table),name=ident(source.column),where=source.where?` AND (${source.where})`:'';
  if(source.shape==='text_array')return `SELECT DISTINCT unnest(${name}) AS value FROM ${table} WHERE ${name} IS NOT NULL${where}`;
  if(source.shape==='jsonb_array')return `SELECT DISTINCT jsonb_array_elements_text(${name}) AS value FROM ${table} WHERE jsonb_typeof(${name})='array'${where}`;
  if(source.shape==='task_change')return `SELECT DISTINCT v AS value FROM ${table} t CROSS JOIN LATERAL (VALUES (t.${name}->>'group_id'),
    (t.${name}#>>'{group_id,from}'),(t.${name}#>>'{group_id,to}')) x(v) WHERE jsonb_typeof(t.${name})='object' AND v IS NOT NULL${where}`;
  return `SELECT DISTINCT ${name} AS value FROM ${table} WHERE ${name} IS NOT NULL${where}`;
}

/** The chat values one stored row of `table` holds, read as the seeder reads that table's columns (for imported rows). */
export function chatValuesOf(table:string,row:Record<string,unknown>):string[] {
  const values:unknown[]=[];
  for(const source of chatSeedColumns.filter(item=>item.store==='control'&&item.table===table)) {
    const value=row[source.column];
    if(source.shape==='text')values.push(value);
    else if(source.shape==='task_change') {
      const change=value&&typeof value==='object'?(value as Record<string,any>).group_id:undefined;
      values.push(change&&typeof change==='object'?change.from:change,change&&typeof change==='object'?change.to:undefined);
    } else if(Array.isArray(value))values.push(...value);
  }
  return values.filter((value):value is string=>typeof value==='string');
}

/** What the seeder knows of one chat before it inserts it. */
interface Planned {
  id:string;kind:'private'|'group'|'topic';external:string;parent:string|null;key:string|null;
  title:string|null;title_source:'observed'|'refreshed'|'owner'|null;app_type:string|null;is_forum:boolean;
  /** The last name Telegram showed, kept beside an owner's topic name. */
  observed:string|null;username:string|null;seen_at:Date|null;closed:boolean|null;migrated:boolean;
  /** The owner's last Telegram refresh of the chat, as the directory showed it, with the name and username it answered. */
  refreshed?:{state:string;to:string|null;at:Date;title:string|null;username:string|null}|null;
}
interface Presentation {chat:{value:Record<string,any>;seq:number;titled:boolean}|null;seen_at:Date|null;name:{value:string;seq:number}|null;closed:{value:boolean;seq:number}|null}
const clean=(value:unknown,length=256):string|null=>typeof value==='string'&&value.trim()?value.replace(/\s+/g,' ').trim().slice(0,length):null;
const appTypes=new Set(['private','group','supergroup','channel']);
/** How many archive events one read covers, so no statement runs long on a large archive. */
const WINDOW=20000;

export class ChatSeeder {
  readonly plan=new Map<string,Planned>();
  constructor(readonly stores:{archive:pg.Pool;derived:pg.Pool;control:pg.Pool},readonly policy:Pick<AssistantPolicy,'owner_id'|'group_ids'>){}

  /**
   * One stored value: its chat (and a topic's parent) is planned; a value that names no chat is ignored. A stored
   * value is its chat's id. A `fresh` one (a Telegram id found after the first seeding) is not stored anywhere, so its
   * chat gets a chatIdFor id, as a capture gives it. The plan is keyed by the old-format value either way.
   */
  value(value:unknown,fresh=false):void {
    const chat=legacyChat(value);if(!chat)return;
    this.base(chat.external,chat.chat_kind,fresh);
    if(chat.kind==='topic'&&!this.plan.has(chat.id))this.plan.set(chat.id,{id:fresh?chatIdFor('telegram',chat.external,chat.topic_key):chat.id,kind:'topic',
      external:chat.external,parent:chat.external,key:chat.topic_key,
      title:null,title_source:null,app_type:null,is_forum:false,observed:null,username:null,seen_at:null,closed:null,migrated:false});
  }
  private base(external:string,kind:'private'|'group',fresh=false):Planned {
    let planned=this.plan.get(external);
    if(!planned)this.plan.set(external,planned={id:fresh?chatIdFor('telegram',external):external,kind,external,parent:null,key:null,title:null,title_source:null,
      app_type:null,is_forum:false,observed:null,username:null,seen_at:null,closed:null,migrated:false});
    return planned;
  }

  /** Reads every source, then inserts what is missing in one control transaction. Returns how many rows it added. */
  async seed():Promise<{chats:number;topics:number}> {
    const state=(await this.stores.control.query('SELECT archive_sequence,seeded_at FROM chat_seed_state WHERE singleton')).rows[0];
    const after=Number(state?.archive_sequence??0),fresh=!!state?.seeded_at;
    // Stored values first: a chat a stored value names keeps that value as its id.
    await this.columns();
    await this.frozen();
    if(this.policy.owner_id)this.value(this.policy.owner_id,fresh);
    for(const id of this.policy.group_ids)this.value(id,fresh);
    const upTo=await this.archive(after,fresh);
    return this.insert(upTo);
  }

  private async columns() {
    for(const store of ['control','derived'] as const) {
      const present=new Set((await this.stores[store].query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()`)).rows.map(row=>row.table_name));
      for(const source of chatSeedColumns.filter(item=>item.store===store&&present.has(item.table)))
        for(const row of (await this.stores[store].query(distinct(source))).rows)this.value(row.value);
    }
  }

  /** The owner's last Telegram refresh and the topics the owner added, from the tables step 2b-1 only reads. */
  private async frozen() {
    const tables=new Set((await this.stores.control.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
      AND table_name IN ('telegram_chat_observations','telegram_topic_registrations')`)).rows.map(row=>row.table_name));
    if(tables.has('telegram_chat_observations'))for(const row of (await this.stores.control.query(`SELECT chat_id,state,chat_type,title,username,is_forum,
      migrate_to_chat_id,observed_at FROM telegram_chat_observations ORDER BY chat_id`)).rows) {
      const chat=legacyChat(row.chat_id);if(!chat||chat.kind==='topic')continue;
      this.value(row.chat_id);const planned=this.plan.get(chat.external)!;
      const to=typeof row.migrate_to_chat_id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(row.migrate_to_chat_id)?row.migrate_to_chat_id:null;
      const available=row.state==='available';
      planned.refreshed={state:row.state,to,at:row.observed_at,title:available?clean(row.title):null,
        username:available?clean(row.username,64)?.replace(/^@+/,'')||null:null};
      if(row.state==='migrated')planned.migrated=true;
      if(row.state!=='available')continue;
      if(!planned.title&&clean(row.title)){planned.title=clean(row.title);planned.title_source='refreshed';}
      if(appTypes.has(row.chat_type))planned.app_type=row.chat_type;
      if(typeof row.is_forum==='boolean')planned.is_forum=row.is_forum;
      planned.username??=clean(row.username,64)?.replace(/^@+/,'')||null;
    }
    if(tables.has('telegram_topic_registrations'))for(const row of (await this.stores.control.query(`SELECT chat_id,topic_id,name FROM telegram_topic_registrations
      ORDER BY chat_id,topic_id`)).rows) {
      let id:string;try{id=legacyChatValue(row.chat_id,Number(row.topic_id));}catch{continue;}
      this.value(id);const planned=this.plan.get(id);
      if(planned?.kind==='topic'){planned.title=clean(row.name,128);planned.title_source='owner';}
    }
  }

  /**
   * The archive after `after` (capture order), in windows: every scope, every topic an observation names, and the
   * presentation the directory showed (a chat's latest title, a topic's latest name and whether it is closed, and when
   * each was last seen). Only names leave the archive, never message text. Returns the last capture sequence read.
   */
  private async archive(after:number,fresh:boolean):Promise<number> {
    const archive=await this.stores.archive.connect();
    try {
      const last=Number((await archive.query('SELECT coalesce(max(capture_sequence),0) AS last FROM events')).rows[0].last);
      const shown=new Map<string,Presentation>(),at=(key:string)=>{let value=shown.get(key);if(!value)shown.set(key,value={chat:null,seen_at:null,name:null,closed:null});return value;};
      for(let from=after;from<last;from+=WINDOW) {
        const to=Math.min(last,from+WINDOW);
        for(const row of (await archive.query('SELECT DISTINCT scope FROM events WHERE capture_sequence>$1 AND capture_sequence<=$2',[from,to])).rows)this.value(row.scope,fresh);
        for(const row of (await archive.query(`SELECT DISTINCT e.scope,o.metadata->'audience'->>'topic_id' AS topic FROM events e
          JOIN source_observations o ON o.event_id=e.id WHERE e.capture_sequence>$1 AND e.capture_sequence<=$2
          AND o.metadata->'audience'->>'topic_state'='known' AND o.metadata->'audience'->>'chat_id'=e.scope`,[from,to])).rows) {
          try{this.value(legacyChatValue(row.scope,Number(row.topic)),fresh);}catch{}
        }
        const rows=(await archive.query(`SELECT e.capture_sequence AS seq,e.scope,e.received_at,x.message->'chat' AS chat,
            (SELECT o.metadata->'audience'->>'topic_id' FROM source_observations o WHERE o.event_id=e.id AND o.metadata->'audience'->>'topic_state'='known'
              AND o.metadata->'audience'->>'chat_id'=e.scope LIMIT 1) AS topic,
            coalesce(x.message#>>'{forum_topic_edited,name}',x.message#>>'{forum_topic_created,name}',
              CASE WHEN x.message#>>'{reply_to_message,message_id}'=x.message#>>'{message_thread_id}'
                THEN coalesce(x.message#>>'{reply_to_message,forum_topic_edited,name}',x.message#>>'{reply_to_message,forum_topic_created,name}') END) AS topic_name,
            CASE WHEN x.message ? 'forum_topic_closed' THEN true WHEN x.message ? 'forum_topic_reopened' THEN false END AS closed
          FROM events e CROSS JOIN LATERAL (SELECT coalesce(b->'message',b->'edited_message',b->'channel_post',b->'edited_channel_post',b) AS message
            FROM (SELECT CASE WHEN pg_input_is_valid(convert_from(e.payload,'UTF8'),'jsonb') THEN convert_from(e.payload,'UTF8')::jsonb ELSE '{}'::jsonb END AS b) p) x
          WHERE e.capture_sequence>$1 AND e.capture_sequence<=$2 AND e.channel='telegram' AND e.kind IN ('telegram_update','telegram_delivered_message')`,[from,to])).rows;
        for(const row of rows) {
          const seq=Number(row.seq),chat=at(row.scope);
          if(!chat.seen_at||row.received_at>chat.seen_at)chat.seen_at=row.received_at;
          // A later update with no chat object (a reaction, a member change) keeps the title an earlier one showed.
          if(row.chat&&typeof row.chat==='object'&&String(row.chat.id)===row.scope) {
            const titled=typeof row.chat.title==='string';
            if(!chat.chat||titled&&!chat.chat.titled||titled===chat.chat.titled&&seq>chat.chat.seq)chat.chat={value:row.chat,seq,titled};
          }
          if(typeof row.topic!=='string'||!row.topic)continue;
          let id:string;try{id=legacyChatValue(row.scope,Number(row.topic));}catch{continue;}
          const topic=at(id);
          if(!topic.seen_at||row.received_at>topic.seen_at)topic.seen_at=row.received_at;
          if(clean(row.topic_name,128)&&(!topic.name||seq>topic.name.seq))topic.name={value:clean(row.topic_name,128)!,seq};
          if(typeof row.closed==='boolean'&&(!topic.closed||seq>topic.closed.seq))topic.closed={value:row.closed,seq};
        }
      }
      for(const [id,value] of shown) {
        const planned=this.plan.get(id);if(!planned)continue;
        planned.seen_at=value.seen_at;
        if(planned.kind==='topic') {
          // As capture does: the owner's own name stays, and Telegram's is kept beside it.
          if(value.name)planned.observed=value.name.value;
          if(value.name&&planned.title_source!=='owner')planned.title=value.name.value,planned.title_source='observed';
          planned.closed=value.closed?.value??null;continue;
        }
        const chat=value.chat?.value;if(!chat)continue;
        const type=clean(chat.type,32);if(type&&appTypes.has(type))planned.app_type=type;
        if(typeof chat.is_forum==='boolean')planned.is_forum=chat.is_forum;
        const title=type==='private'?[clean(chat.first_name),clean(chat.last_name)].filter(Boolean).join(' ')||null:clean(chat.title);
        if(title){planned.title=title;planned.title_source='observed';planned.observed=title;}
        planned.username=clean(chat.username,64)?.replace(/^@+/,'')||planned.username;
      }
      return Math.max(after,last);
    } finally{archive.release();}
  }

  /** Inserts every planned chat that has no row, parents first; nothing already there is touched. */
  private async insert(upTo:number|null):Promise<{chats:number;topics:number}> {
    const db=await this.stores.control.connect();let chats=0,topics=0;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(803381)');
      const connection=await ensureConnection(db);
      const known=new Map((await db.query('SELECT external_id,chat_id FROM chat_ids WHERE connection_id=$1',[connection])).rows.map(row=>[row.external_id as string,row.chat_id as string]));
      const rows=new Map((await db.query('SELECT id,kind,state FROM chats')).rows.map(row=>[row.id as string,{kind:row.kind as string,state:row.state as ChatState}]));
      const topicKeys=new Set((await db.query(`SELECT parent_id,topic_key FROM chats WHERE kind='topic'`)).rows.map(row=>row.parent_id+'\n'+row.topic_key));
      const planned=[...this.plan.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      for(const chat of planned.filter(item=>item.kind!=='topic')) {
        if(known.has(chat.external)||rows.has(chat.id))continue;
        const state:ChatState=chat.kind==='private'?chat.external===this.policy.owner_id?'active':'off':
          this.policy.group_ids.includes(chat.external)?'active':chat.migrated?'removed':'off';
        let account:string|null=null;
        if(chat.kind==='private') {
          account=accountIdFor('telegram',chat.external);
          await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id,display_name,username) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [account,connection,chat.external,chat.app_type==='private'?chat.title:null,chat.username]);
          if((await db.query(`SELECT 1 FROM chats WHERE account_id=$1 AND kind='private'`,[account])).rowCount)account=null;
        }
        await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,account_id,title,title_source,is_forum,state,added_by_role,state_changed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'seeded',now()) ON CONFLICT DO NOTHING`,
          [chat.id,connection,chat.kind,chat.app_type,account,chat.title,chat.title?chat.title_source:null,chat.is_forum,state]);
        await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current') ON CONFLICT DO NOTHING`,[connection,chat.external,chat.id]);
        await details(db,chat);
        known.set(chat.external,chat.id);rows.set(chat.id,{kind:chat.kind,state});chats++;
      }
      for(const chat of planned.filter(item=>item.kind==='topic')) {
        const parent=known.get(chat.parent!)??(rows.has(chat.parent!)?chat.parent!:null),base=parent?rows.get(parent):undefined;
        if(!parent||!base||base.kind==='topic'||rows.has(chat.id)||topicKeys.has(parent+'\n'+chat.key))continue;
        await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,title,title_source,state,added_by_role)
          VALUES($1,$2,'topic',$3,$4,$5,$6,$7,'seeded') ON CONFLICT DO NOTHING`,
          [chat.id,connection,parent,chat.key,chat.title,chat.title_source==='owner'?'owner':chat.title?chat.title_source:null,base.state]);
        await details(db,chat);
        rows.set(chat.id,{kind:'topic',state:base.state});topicKeys.add(parent+'\n'+chat.key);topics++;
      }
      // A private chat a reset restored or an owner record brought names no person yet: its Telegram id does.
      const named=await namePrivateChats(db);
      if(chats+topics+named)await bumpChatRevision(db);
      if(upTo!==null)await db.query(`UPDATE chat_seed_state SET archive_sequence=greatest(archive_sequence,$1),seeded_at=coalesce(seeded_at,now()) WHERE singleton`,[upTo]);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
    return {chats,topics};
  }

  /**
   * Values that came from elsewhere (an owner record or a reset snapshot written before step 2b), seeded the same way,
   * without reading the archive. The chats they name are off unless the 2b-1 bridge serves them.
   */
  async values(values:Iterable<unknown>,titles:ReadonlyMap<string,{title:string;source:'owner'}>=new Map()):Promise<{chats:number;topics:number}> {
    for(const value of values)this.value(value);
    for(const [id,title] of titles){const planned=this.plan.get(id);if(planned){planned.title=title.title;planned.title_source=title.source;}}
    return this.insert(null);
  }
}

async function details(db:Pick<pg.PoolClient,'query'>,chat:Planned) {
  if(!chat.seen_at&&!chat.username&&chat.closed===null&&!chat.observed&&!chat.refreshed)return;
  await db.query(`INSERT INTO chat_details(chat_id,username,observed_title,seen_at,closed,refreshed_state,refreshed_to,refreshed_title,refreshed_username,refreshed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [chat.id,chat.username,chat.observed,chat.seen_at,chat.kind==='topic'?chat.closed:null,chat.refreshed?.state??null,chat.refreshed?.to??null,
      chat.refreshed?.title??null,chat.refreshed?.username??null,chat.refreshed?.at??null]);
}

/**
 * A wait that does not hold the process open, unless `hold`. The app's start awaits its retries at top level, and a pool
 * drops a client whose query failed, so between attempts the wait may be all that keeps Node running.
 */
const sleep=(ms:number,hold=false)=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);if(!hold)timer.unref();});
const failure=(event:string,error:unknown)=>console.warn(JSON.stringify({event,code:(error as {code?:string})?.code??'unknown'}));

/**
 * The app's start for chat records (ADR-0252), before anything captures or runs: every chat already stored gets its
 * row (the seeder), chats are served as TELEGRAM_GROUP_IDS says (the 2b-1 bridge), and this process loads its chat
 * directory. A store that is not up yet is tried again; after `attempts` the start fails, and the service restarts.
 * Then memberships are filled in from the archive in the background, in batches, until they reach the seeder's place.
 * Returns the function that stops that.
 */
export async function startChatRecords(stores:{archive:pg.Pool;derived:pg.Pool;control:pg.Pool},chats:ChatRepository,
  policy:()=>AssistantPolicy,options:{attempts?:number;wait?:number}={}):Promise<()=>void> {
  const attempts=options.attempts??30,wait=options.wait??2000;
  for(let attempt=1;;attempt++) {
    try {
      const configured=policy(),started=Date.now();
      const seeded=await new ChatSeeder(stores,configured).seed(),served=await chats.serve(configured);
      console.log(JSON.stringify({event:'chat_records_ready',chats:seeded.chats,topics:seeded.topics,served_changes:served,ms:Date.now()-started}));
      break;
    } catch(error) {
      failure('chat_records_start_failed',error);
      if(attempt>=attempts)throw error;
      await sleep(wait,true);
    }
  }
  await startChatDirectory(stores.control,policy);
  let stopped=false;
  void (async()=>{
    while(!stopped) {
      try{if(!await chats.backfill())return;}
      catch(error){failure('chat_membership_backfill_failed',error);await sleep(10*wait);}
    }
  })();
  return ()=>{stopped=true;};
}
