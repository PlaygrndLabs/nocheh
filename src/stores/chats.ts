import type pg from 'pg';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,chats,connectionIdFor,installChats,setChatLoader,topicKey,type ChatApp,type ChatDirectory,
  type ChatIdRow,type ChatLoader,type ChatRow,type ChatState} from '../chats.js';
import {isTelegramChat} from '../chats-telegram.js';
import {telegramUpdateFacts,type TelegramChatFacts,type TelegramPerson} from '../chats-telegram-updates.js';
import {HttpError} from '../http.js';
import type {CapturedSource} from './archive.js';

/**
 * Chat records that the directory itself does not decide on (ADR-0250), next to the contract's chat tables:
 * - chat_details: what the owner's directory shows of a chat and never decides access with. seen_at is the latest
 *   captured message in the chat (in a topic, in that topic), closed whether a topic's latest open or close message
 *   closed it, username the chat's public name, observed_title the last name an update showed (kept beside a topic
 *   name the owner gave, which it never replaces), and refreshed_* the owner's last explicit refresh from the app
 *   (refreshed_to: the id Telegram moved a group to). seq is the update that last set the title, closed or username,
 *   so an older update, or the capture replay, never undoes a newer one.
 * - chat_seed_state: how far the seeder (chat-seed.ts) and the membership backfill have read the archive.
 * Both are created only if missing, and nothing here rewrites a row.
 */
export const chatRecordSchema=`
CREATE TABLE IF NOT EXISTS chat_details (
 chat_id text PRIMARY KEY REFERENCES chats(id),
 username text CHECK(username IS NULL OR length(username)<=64),
 observed_title text CHECK(observed_title IS NULL OR length(observed_title)<=256),
 seen_at timestamptz,
 closed boolean,
 seq numeric CHECK(seq IS NULL OR seq>=0),
 refreshed_state text CHECK(refreshed_state IS NULL OR refreshed_state IN ('available','migrated','not_member','not_found')),
 refreshed_to text CHECK(refreshed_to IS NULL OR refreshed_to ~ '^[A-Za-z0-9._:-]{1,128}$'),
 refreshed_at timestamptz
);
CREATE TABLE IF NOT EXISTS chat_seed_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 archive_sequence bigint NOT NULL DEFAULT 0 CHECK(archive_sequence>=0),
 members_sequence bigint NOT NULL DEFAULT 0 CHECK(members_sequence>=0),
 seeded_at timestamptz
);
INSERT INTO chat_seed_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
`;

type Db=Pick<pg.PoolClient,'query'>;
const appId=/^[A-Za-z0-9._:-]{1,128}$/;
/** The Telegram originals that name a chat: updates (messages, member changes, reactions) and Nocheh's own replies. */
const recordedKinds=new Set(['telegram_update','telegram_delivered_message']);

/** Adds a chat or chat id: the directory snapshot is stale until reloaded. */
export const bumpChatRevision=(db:Db)=>db.query('UPDATE chat_directory_state SET revision=revision+1 WHERE singleton');

/** The app's one connection, made the first time it is needed. Its bot account may change; the connection stays. */
export async function ensureConnection(db:Db,app:ChatApp='telegram',account:string|null=null):Promise<string> {
  await db.query(`INSERT INTO chat_connections(id,app,account,bot_user_id,secret_ref) VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING`,
    [connectionIdFor(app),app,account,app==='telegram'?'env:TELEGRAM_BOT_TOKEN':null]);
  const id=String((await db.query('SELECT id FROM chat_connections WHERE app=$1',[app])).rows[0].id);
  if(account)await db.query('UPDATE chat_connections SET account=$2,bot_user_id=$2,updated_at=now() WHERE id=$1 AND account IS DISTINCT FROM $2',[id,account]);
  return id;
}
/** The chat an app id names, current or old, with its row's kind and state. */
export async function chatOfApp(db:Db,connection:string,external:string):Promise<{id:string;kind:ChatRow['kind'];state:ChatState;current:boolean}|null> {
  const row=(await db.query(`SELECT c.id,c.kind,c.state,i.state='current' AS current FROM chat_ids i JOIN chats c ON c.id=i.chat_id
    WHERE i.connection_id=$1 AND i.external_id=$2`,[connection,external])).rows[0];
  return row?{id:row.id,kind:row.kind,state:row.state,current:row.current}:null;
}
/** A person or bot in the app. Names are presentation only and follow the latest update that carries them. */
export async function ensureAccount(db:Db,connection:string,person:Pick<TelegramPerson,'external'>&Partial<TelegramPerson>,app:ChatApp='telegram'):Promise<string> {
  const id=accountIdFor(app,person.external);
  await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id,kind,display_name,username) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [id,connection,person.external,person.bot?'bot':'human',person.display_name??null,person.username??null]);
  if(person.display_name||person.username)await db.query(`UPDATE chat_accounts SET display_name=coalesce($2,display_name),username=coalesce($3,username),checked_at=now()
    WHERE id=$1 AND (coalesce($2,display_name) IS DISTINCT FROM display_name OR coalesce($3,username) IS DISTINCT FROM username)`,
    [id,person.display_name??null,person.username??null]);
  return id;
}
/** The 2b-1 bridge (ADR-0250): a group is served when any of its Telegram ids, current or old, is in TELEGRAM_GROUP_IDS,
 * and the owner's private chat is served. Step 2b-2 moves this decision onto chats.state itself. */
const servedState=(policy:Pick<AssistantPolicy,'group_ids'|'owner_id'>,kind:'private'|'group',externals:readonly string[]):ChatState=>
  kind==='group'?externals.some(id=>policy.group_ids.includes(id))?'active':'off':externals.includes(policy.owner_id??'')?'active':'off';

/** Writes the presentation an update carries, unless a later update already did. */
async function present(db:Db,chat:string,seq:number|null,values:{title?:string|null;app_type?:string|null;is_forum?:boolean|null;username?:string|null;closed?:boolean|null;seen_at?:Date|null}) {
  if(values.seen_at)await db.query(`INSERT INTO chat_details(chat_id,seen_at) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE
    SET seen_at=greatest(chat_details.seen_at,excluded.seen_at) WHERE chat_details.seen_at IS NULL OR chat_details.seen_at<excluded.seen_at`,[chat,values.seen_at]);
  if(seq===null)return;
  const newer=(await db.query(`INSERT INTO chat_details(chat_id,seq) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET seq=excluded.seq
    WHERE chat_details.seq IS NULL OR chat_details.seq<excluded.seq RETURNING chat_id`,[chat,seq])).rowCount;
  if(!newer)return;
  // An owner's own topic name is never replaced by one Telegram shows; that one is kept, for when the owner removes theirs.
  if(values.title) {
    await db.query('UPDATE chat_details SET observed_title=$2 WHERE chat_id=$1 AND observed_title IS DISTINCT FROM $2',[chat,values.title]);
    await db.query(`UPDATE chats SET title=$2,title_source='observed',updated_at=now() WHERE id=$1 AND title IS DISTINCT FROM $2
      AND title_source IS DISTINCT FROM 'owner'`,[chat,values.title]);
  }
  if(values.app_type||typeof values.is_forum==='boolean')await db.query(`UPDATE chats SET app_type=coalesce($2,app_type),is_forum=coalesce($3,is_forum),updated_at=now()
    WHERE id=$1 AND (app_type IS DISTINCT FROM coalesce($2,app_type) OR is_forum IS DISTINCT FROM coalesce($3,is_forum))`,[chat,values.app_type??null,values.is_forum??null]);
  if(values.username!==undefined&&values.username!==null||typeof values.closed==='boolean')await db.query(`UPDATE chat_details SET username=coalesce($2,username),closed=coalesce($3,closed)
    WHERE chat_id=$1`,[chat,values.username??null,values.closed??null]);
}

/**
 * Nocheh's chat records (ADR-0250): the chats, chat ids, people and memberships a Telegram update shows, recorded as
 * each update is taken in. It calls nothing and decides nothing: a new chat is served only as the 2b-1 bridge says,
 * and the directory snapshot (chats()) reads these rows.
 */
export class ChatRepository {
  constructor(readonly stores:{archive:pg.Pool;control:pg.Pool},readonly policy:()=>AssistantPolicy){}

  /**
   * Records what a captured Telegram original says, in the capture's own control transaction (next to the reaction
   * state). A failure here never fails the capture: it is rolled back alone, and the seeder finds the chat later.
   * Returns whether a chat or chat id was added, so the caller can reload the directory once the capture commits.
   */
  async capture(db:pg.PoolClient,source:CapturedSource):Promise<boolean> {
    if(source.channel!=='telegram'||!recordedKinds.has(source.kind)||!isTelegramChat(source.scope))return false;
    await db.query('SAVEPOINT chat_records');
    try {
      const changed=await this.record(db,source);
      await db.query('RELEASE SAVEPOINT chat_records');
      return changed;
    } catch(error) {
      await db.query('ROLLBACK TO SAVEPOINT chat_records');
      console.warn(JSON.stringify({event:'chat_record_failed',code:(error as {code?:string})?.code??'unknown'}));
      return false;
    }
  }

  private async record(db:Db,source:CapturedSource):Promise<boolean> {
    const event=(await this.stores.archive.query(`SELECT e.payload,e.received_at,e.bot_id,(SELECT o.metadata->'audience'->>'topic_id' FROM source_observations o
      WHERE o.event_id=e.id AND o.metadata->'audience'->>'topic_state'='known' AND o.metadata->'audience'->>'chat_id'=e.scope LIMIT 1) AS topic
      FROM events e WHERE e.id=$1`,[source.reference.id])).rows[0];
    if(!event)return false;
    let payload:unknown={};try{payload=JSON.parse(Buffer.from(event.payload).toString('utf8'));}catch{}
    const facts=telegramUpdateFacts(payload,source.scope),live=source.origin==='live'&&source.kind==='telegram_update';
    const seq=live?facts.update_id:null,policy=this.policy();
    const connection=await ensureConnection(db,'telegram',live&&typeof event.bot_id==='string'&&appId.test(event.bot_id)?event.bot_id:null);
    let changed=false;
    // An upgrade first, so the new id's own messages continue the same chat.
    if(live&&facts.migration)changed=await this.migrate(db,connection,facts.migration.from,facts.migration.to,policy)||changed;
    for(const person of facts.people)await ensureAccount(db,connection,person);
    let chat=await chatOfApp(db,connection,source.scope);
    if(!chat&&facts.chat){chat=await this.create(db,connection,facts.chat,policy);changed=true;}
    if(!chat){if(changed)await bumpChatRevision(db);return changed;}
    const seen=facts.message?event.received_at as Date:null;
    if(facts.chat&&chat.current)await present(db,chat.id,seq,{title:facts.chat.title,app_type:facts.chat.app_type,is_forum:facts.chat.is_forum,username:facts.chat.username,seen_at:seen});
    else if(seen)await present(db,chat.id,null,{seen_at:seen});
    // A forum topic: the archive's own reading of the message first, as every reader of it does.
    const key=typeof event.topic==='string'&&event.topic?event.topic:facts.topic?.key;
    if(key&&chat.kind!=='topic') {
      let topic:string;try{topic=topicKey(key);}catch{topic='';}
      if(topic) {
        let id=(await db.query('SELECT id FROM chats WHERE parent_id=$1 AND topic_key=$2',[chat.id,topic])).rows[0]?.id as string|undefined;
        if(!id){id=await this.createTopic(db,connection,chat,source.scope,topic,facts.topic?.key===topic?facts.topic.name:null,'observed');changed=true;}
        await present(db,id,seq,{title:facts.topic?.key===topic?facts.topic.name:null,closed:facts.topic?.key===topic?facts.topic.closed:null,seen_at:seen});
      }
    }
    // Who is in a group: only from live updates, each applied once and in update order.
    if(seq!==null&&chat.kind==='group')for(const membership of facts.memberships) {
      const account=await ensureAccount(db,connection,membership.person);
      await membershipFrom(db,chat.id,account,membership.state,membership.source,event.received_at as Date,seq);
    }
    if(changed)await bumpChatRevision(db);
    return changed;
  }

  /** A chat first seen now: its id is chatIdFor, with no bot in it. A private chat names its person. */
  private async create(db:Db,connection:string,facts:TelegramChatFacts,policy:AssistantPolicy) {
    const id=chatIdFor('telegram',facts.external),state=servedState(policy,facts.kind,[facts.external]);
    const account=facts.kind==='private'?await ensureAccount(db,connection,{external:facts.external,display_name:facts.title}):null;
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,account_id,title,title_source,is_forum,state,state_changed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING`,
      [id,connection,facts.kind,facts.app_type,account,facts.title,facts.title?'observed':null,facts.is_forum===true,state]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current') ON CONFLICT DO NOTHING`,[connection,facts.external,id]);
    return (await chatOfApp(db,connection,facts.external))!;
  }

  /** A topic first seen now, of `parent` (whose app id is `external`). It follows its parent's state. */
  private async createTopic(db:Db,connection:string,parent:{id:string;state:ChatState},external:string,key:string,title:string|null,source:'observed'|'owner') {
    const id=chatIdFor('telegram',external,key);
    await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,title,title_source,state) VALUES($1,$2,'topic',$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`,[id,connection,parent.id,key,title,title?source:source==='owner'?'owner':null,parent.state]);
    return (await db.query('SELECT id FROM chats WHERE parent_id=$1 AND topic_key=$2',[parent.id,key])).rows[0].id as string;
  }

  /**
   * Telegram upgraded a basic group to a supergroup, with a new id: the new id becomes the chat's current one and the
   * old one stays, so the chat keeps its history, project, tasks and switches. When both ids already name chats of
   * their own (the new one's messages came first), they stay two chats, as a group upgraded before step 2b does.
   */
  async migrate(db:Db,connection:string,from:string,to:string,policy:AssistantPolicy=this.policy()):Promise<boolean> {
    if(!isTelegramChat(from)||!isTelegramChat(to)||from===to)return false;
    const old=await chatOfApp(db,connection,from),next=await chatOfApp(db,connection,to);
    if(old&&next)return false;
    if(old) {
      if(old.current)await db.query(`UPDATE chat_ids SET state='old',reason='migrated',changed_at=now() WHERE connection_id=$1 AND external_id=$2 AND state='current'`,[connection,from]);
      await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [connection,to,old.id,old.current?'current':'old',old.current?null:'migrated']);
      await db.query(`UPDATE chats SET app_type='supergroup',updated_at=now() WHERE id=$1 AND app_type IS DISTINCT FROM 'supergroup'`,[old.id]);
      if(old.state==='off'&&servedState(policy,'group',[to])==='active')await db.query(`UPDATE chats SET state='active',state_changed_at=now(),updated_at=now() WHERE id=$1`,[old.id]);
      return true;
    }
    if(next) {
      await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,'old','migrated') ON CONFLICT DO NOTHING`,[connection,from,next.id]);
      if(next.state==='off'&&servedState(policy,'group',[from])==='active')await db.query(`UPDATE chats SET state='active',state_changed_at=now(),updated_at=now() WHERE id=$1`,[next.id]);
      return true;
    }
    // Neither id is known: the chat is named after the first id it had.
    const id=chatIdFor('telegram',from);
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,state,state_changed_at) VALUES($1,$2,'group','supergroup',$3,now()) ON CONFLICT DO NOTHING`,
      [id,connection,servedState(policy,'group',[from,to])]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,'old','migrated') ON CONFLICT DO NOTHING`,[connection,from,id]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current') ON CONFLICT DO NOTHING`,[connection,to,id]);
    return true;
  }

  /**
   * The 2b-1 bridge, run at app start: chats.state follows TELEGRAM_GROUP_IDS. A group with any of its Telegram ids in
   * the list is active, and so is the owner's private chat; an active chat that is neither turns off. Nothing else
   * changes (a group upgraded before step 2b stays removed unless it is still listed). Returns how many chats changed.
   */
  async serve(policy:Pick<AssistantPolicy,'group_ids'|'owner_id'>=this.policy()):Promise<number> {
    const db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const connection=await ensureConnection(db);
      const owner=policy.owner_id?(await chatOfApp(db,connection,policy.owner_id)):null,ownerId=owner?.kind==='private'?owner.id:null;
      // Never NULL: with no owner chat yet, NOT listed must still turn an unlisted group off.
      const listed=`(c.kind='group' AND EXISTS(SELECT 1 FROM chat_ids i WHERE i.chat_id=c.id AND i.connection_id=$1 AND i.external_id=ANY($2::text[]))
        OR c.id IS NOT DISTINCT FROM $3::text)`;
      const on=(await db.query(`UPDATE chats c SET state='active',state_changed_at=now(),updated_at=now() WHERE c.kind<>'topic' AND c.state<>'active' AND ${listed}`,
        [connection,policy.group_ids,ownerId])).rowCount??0;
      const off=(await db.query(`UPDATE chats c SET state='off',state_changed_at=now(),updated_at=now() WHERE c.kind<>'topic' AND c.state='active' AND NOT ${listed}`,
        [connection,policy.group_ids,ownerId])).rowCount??0;
      if(on+off)await bumpChatRevision(db);
      await db.query('COMMIT');return on+off;
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }

  /**
   * Memberships from the archive, for updates taken in before chats recorded them: one batch of live Telegram
   * updates at a time, in capture order, resumable from chat_seed_state. Each is applied by its update_id, so its
   * order does not matter and a replay changes nothing. Returns how many updates it read; 0 when it has caught up
   * with the seeder.
   */
  async backfill(limit=500):Promise<number> {
    const db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const state=(await db.query('SELECT archive_sequence,members_sequence FROM chat_seed_state WHERE singleton FOR UPDATE')).rows[0];
      if(!state||Number(state.members_sequence)>=Number(state.archive_sequence)){await db.query('COMMIT');return 0;}
      const rows=(await this.stores.archive.query(`SELECT capture_sequence,scope,payload,received_at FROM events
        WHERE capture_sequence>$1 AND capture_sequence<=$2 AND channel='telegram' AND origin='live' AND kind='telegram_update'
        ORDER BY capture_sequence LIMIT $3`,[state.members_sequence,state.archive_sequence,limit])).rows;
      const connection=await ensureConnection(db);
      for(const row of rows) {
        if(!isTelegramChat(row.scope))continue;
        let payload:unknown={};try{payload=JSON.parse(Buffer.from(row.payload).toString('utf8'));}catch{}
        const facts=telegramUpdateFacts(payload,row.scope);
        if(facts.update_id===null||!facts.memberships.length)continue;
        const chat=await chatOfApp(db,connection,row.scope);if(chat?.kind!=='group')continue;
        for(const membership of facts.memberships)
          await membershipFrom(db,chat.id,await ensureAccount(db,connection,membership.person),membership.state,membership.source,row.received_at,facts.update_id);
      }
      const next=rows.length===limit?rows.at(-1)!.capture_sequence:state.archive_sequence;
      await db.query('UPDATE chat_seed_state SET members_sequence=$1 WHERE singleton',[next]);
      await db.query('COMMIT');return rows.length;
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }

  /** Chat names for presentation, by Nocheh chat id; nothing is decided on them. */
  async titles(ids:readonly string[]):Promise<Map<string,string>> {
    if(!ids.length)return new Map();
    return new Map((await this.stores.control.query('SELECT id,title FROM chats WHERE id=ANY($1::text[]) AND title IS NOT NULL',[[...new Set(ids)]])).rows
      .map(row=>[row.id as string,row.title as string]));
  }
  /** Each chat's name as the owner's directory shows it (chatLabel), by Nocheh chat id; chats with none are left out. */
  async labels(ids:readonly string[]):Promise<Map<string,string>> {
    if(!ids.length)return new Map();
    const rows=(await this.stores.control.query(`SELECT c.id,c.kind,c.title,c.app_type,d.username,i.external_id FROM chats c
      LEFT JOIN chat_details d ON d.chat_id=c.id LEFT JOIN chat_ids i ON i.chat_id=c.id AND i.state='current' WHERE c.id=ANY($1::text[])`,[[...new Set(ids)]])).rows;
    return new Map(rows.map(row=>[row.id as string,chatLabel(row,row.username,row.external_id)]).filter((entry):entry is [string,string]=>entry[1]!==null));
  }

  /** Every chat record as stored now, for the owner's directory: a fresh snapshot, and each chat's details. */
  async listing():Promise<{directory:ChatDirectory;rows:Map<string,ChatListing>}> {
    const [snapshot,details]=await Promise.all([loadChatSnapshot(this.stores.control,this.policy()),this.stores.control.query(`SELECT c.id,c.title_source,
      d.username,d.seen_at,d.closed,d.refreshed_state,d.refreshed_to,d.refreshed_at FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id`)]);
    return {directory:chatDirectory(snapshot),rows:new Map(details.rows.map(row=>[row.id as string,{title_source:row.title_source,username:row.username,
      seen_at:row.seen_at,closed:row.closed,refreshed:row.refreshed_at?{state:row.refreshed_state,to:row.refreshed_to,at:row.refreshed_at}:null}]))};
  }
}
/**
 * A chat's name for the owner: a group's title or public @name, a topic's name, and for a private chat "Private chat ·"
 * with the person's @name, name or Telegram id once Nocheh has seen it. Presentation only; a name decides nothing.
 */
export function chatLabel(chat:{kind:string;title?:string|null;app_type?:string|null},username:string|null|undefined,external:string|null|undefined):string|null {
  const handle=username?'@'+username:null;
  if(chat.kind==='topic')return chat.title??null;
  if(chat.kind==='private')return chat.app_type==='private'||chat.title||handle?'Private chat · '+(handle??chat.title??external??''):null;
  return chat.title??handle;
}
export interface ChatListing {title_source:string|null;username:string|null;seen_at:Date|null;closed:boolean|null;
  refreshed:{state:string;to:string|null;at:Date}|null}

async function membershipFrom(db:Db,chat:string,account:string,state:'in'|'left',source:'message'|'event',at:Date,seq:number) {
  await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source,since,checked_at,seen_seq) VALUES($1,$2,$3,$4,$5,$5,$6)
    ON CONFLICT(chat_id,account_id) DO UPDATE SET state=excluded.state,source=excluded.source,checked_at=excluded.checked_at,seen_seq=excluded.seen_seq,
      since=CASE WHEN chat_memberships.state=excluded.state THEN chat_memberships.since ELSE excluded.since END
    WHERE chat_memberships.seen_seq IS NULL OR chat_memberships.seen_seq<excluded.seen_seq`,[chat,account,state,source,at,seq]);
}

/**
 * The rows a directory is built from, read in one snapshot: chats and chat_ids with each connection's app, the
 * directory revision and the guard epoch. The owner's private chat is the chat the owner's account names in the app
 * (TELEGRAM_OWNER_ID's private chat), whatever its id; a policy without an owner has none.
 */
export async function loadChatSnapshot(control:pg.Pool,policy:Pick<AssistantPolicy,'owner_id'|'owner_chat'>) {
  const db=await control.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const chatRows=(await db.query<ChatRow>(`SELECT c.id,n.app,c.kind,c.parent_id,c.topic_key,c.state,c.title,c.is_forum,c.account_id,c.app_type
      FROM chats c JOIN chat_connections n ON n.id=c.connection_id`)).rows;
    const ids=(await db.query<ChatIdRow>(`SELECT n.app,i.external_id,i.chat_id,i.state FROM chat_ids i JOIN chat_connections n ON n.id=i.connection_id`)).rows;
    const revision=Number((await db.query('SELECT revision FROM chat_directory_state WHERE singleton')).rows[0]?.revision??0);
    const epoch=Number((await db.query('SELECT epoch FROM guard_state WHERE singleton')).rows[0]?.epoch??0);
    await db.query('COMMIT');
    const named=policy.owner_id?ids.find(row=>row.app==='telegram'&&row.external_id===policy.owner_id)?.chat_id:undefined;
    return {chats:chatRows,ids,owner_chat:named??ownerChat(policy),epoch,revision};
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
}

/**
 * Keeps this process's chat directory (chats()) current (ADR-0250). It loads every chats and chat_ids row at start; a
 * guard epoch newer than the snapshot's reloads it, and a lookup that finds no row reloads it when the directory
 * revision has moved, checked at most once every `interval` ms. A load that fails, or rows that break the schema's
 * rules, leave the previous directory in place.
 */
export class ChatDirectoryLoader implements ChatLoader {
  private running:Promise<ChatDirectory>|null=null;private again=false;private checked=0;
  constructor(readonly control:pg.Pool,readonly policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>,readonly interval=2000){}
  /** Loads and installs a new snapshot; a call while one runs loads once more after it. */
  load():Promise<ChatDirectory> {
    if(this.running){this.again=true;return this.running;}
    const run=async():Promise<ChatDirectory>=>{
      try {
        do{this.again=false;installChats(await loadChatSnapshot(this.control,this.policy()));}while(this.again);
        return chats();
      } finally{this.running=null;}
    };
    return this.running=run();
  }
  epoch(_epoch:number):void {void this.load().catch(failed);}
  miss():void {
    const now=Date.now();if(now-this.checked<this.interval)return;this.checked=now;
    void this.stale().then(stale=>stale?this.load():undefined).catch(failed);
  }
  /** Whether rows were added or the guard epoch moved since the installed snapshot. */
  async stale():Promise<boolean> {
    const row=(await this.control.query(`SELECT (SELECT revision FROM chat_directory_state WHERE singleton) AS revision,
      (SELECT epoch FROM guard_state WHERE singleton) AS epoch`)).rows[0];
    return Number(row?.revision??0)!==chats().revision||Number(row?.epoch??0)>chats().epoch;
  }
  /** The directory as of now: reloaded first when it is stale. */
  async current():Promise<ChatDirectory> {return await this.stale()?this.load():chats();}
}
const failed=(error:unknown)=>console.warn(JSON.stringify({event:'chat_directory_load_failed',code:(error as {code?:string})?.code??'unknown'}));

let active:ChatDirectoryLoader|null=null;
/** Installs the loader for this process and loads the first snapshot. */
export async function startChatDirectory(control:pg.Pool,policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>):Promise<ChatDirectoryLoader> {
  const loader=new ChatDirectoryLoader(control,policy);active=loader;setChatLoader(loader);
  await loader.load().catch(failed);
  return loader;
}
/** After a commit that added chats: this process sees them at once. Without a loader (tests) nothing happens. */
export async function reloadChats():Promise<void> {await active?.load().catch(failed);}
/** The directory as of now, for a reader outside this process (GET /internal/chats). */
export async function currentChats():Promise<ChatDirectory> {return active?active.current():chats();}

/**
 * The assistant policy as this process serves it (ADR-0250): the configured policy, with the owner's private chat as
 * the directory names it, and group_ids holding every Telegram id (current and old) of the served groups, so
 * comparisons with archive originals still find a group Telegram upgraded. Recomputed only when the directory or the
 * configured policy changes.
 */
export function servedPolicy(base:()=>AssistantPolicy):()=>AssistantPolicy {
  let cached:{directory:ChatDirectory;base:AssistantPolicy;policy:AssistantPolicy}|null=null;
  return ()=>{
    const directory=chats(),value=base();
    if(cached?.directory===directory&&cached.base===value)return cached.policy;
    const served=directory.all().filter(chat=>chat.kind==='group'&&chat.state==='active').map(chat=>chat.id);
    const policy={...value,owner_chat:directory.ownerChat()??ownerChat(value),group_ids:[...new Set([...value.group_ids,...directory.rawScopes(served,'telegram')])]};
    cached={directory,base:value,policy};return policy;
  };
}

/** Throws unless `id` is a group chat row: the only chats an owner adds topics to. */
export async function groupRow(db:Db,id:string):Promise<{id:string;state:ChatState;external:string}> {
  const row=(await db.query(`SELECT c.id,c.state,i.external_id FROM chats c JOIN chat_ids i ON i.chat_id=c.id AND i.state='current'
    WHERE c.id=$1 AND c.kind='group'`,[id])).rows[0];
  if(!row)throw new HttpError(404,'chat_not_found');
  return {id:row.id,state:row.state,external:row.external_id};
}
