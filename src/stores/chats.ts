import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {ownerChat,type AssistantPolicy} from '../assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,chats,connectionIdFor,installChats,isChatId,setChatLoader,topicKey,type ChatApp,type ChatDirectory,
  type ChatIdRow,type ChatLoader,type ChatRow,type ChatState} from '../chats.js';
import {isTelegramChat,legacyChat,legacyChatValue} from '../chats-telegram.js';
import {telegramUpdateFacts,type TelegramBotStatus,type TelegramChatFacts,type TelegramPerson} from '../chats-telegram-updates.js';
import {HttpError,object,string} from '../http.js';
import {freshMembers} from '../members.js';
import type {CapturedSource} from './archive.js';
import {bumpMemberRevision} from './member-schema.js';
import {OwnerCommands} from './owner-commands.js';
import {writeAssignment,writeProject} from './projects.js';

/**
 * Chat records that the directory itself does not decide on (ADR-0252), next to the contract's chat tables:
 * - chat_details: what the owner's directory shows of a chat and never decides access with. seen_at is the latest
 *   captured message in the chat (in a topic, in that topic), closed whether a topic's latest open or close message
 *   closed it, username the chat's public name, observed_title the last name an update showed (kept beside a topic
 *   name the owner gave, which it never replaces), and refreshed_* the owner's last explicit refresh from the app
 *   (refreshed_to: the id Telegram moved a group to; refreshed_title and refreshed_username: the name and public
 *   username it answered with, which name runtime profiles and send destinations as before step 2b, whatever later
 *   updates show). seq, seq_bot and seq_at are the update that last set the title,
 *   closed or username (its update_id, the bot that took it in and when it was taken in), so an older update, or the
 *   capture replay, never undoes a newer one (see newerUpdate).
 * - chat_seed_state: how far the seeder (chat-seed.ts) and the membership backfill have read the archive, and where
 *   adoption began (adopt_after, see startAdoption).
 * - chat_recorded_events: the archive originals whose chat records are written (see ChatRepository.capture).
 * Each is created only if missing, and nothing here rewrites a row.
 */
export const chatRecordSchema=`
CREATE TABLE IF NOT EXISTS chat_details (
 chat_id text PRIMARY KEY REFERENCES chats(id),
 username text CHECK(username IS NULL OR length(username)<=64),
 observed_title text CHECK(observed_title IS NULL OR length(observed_title)<=256),
 seen_at timestamptz,
 closed boolean,
 seq numeric CHECK(seq IS NULL OR seq>=0),
 seq_bot text CHECK(seq_bot IS NULL OR seq_bot ~ '^[A-Za-z0-9._:-]{1,128}$'),
 seq_at timestamptz,
 refreshed_state text CHECK(refreshed_state IS NULL OR refreshed_state IN ('available','migrated','not_member','not_found')),
 refreshed_to text CHECK(refreshed_to IS NULL OR refreshed_to ~ '^[A-Za-z0-9._:-]{1,128}$'),
 refreshed_title text CHECK(refreshed_title IS NULL OR length(refreshed_title)<=256),
 refreshed_username text CHECK(refreshed_username IS NULL OR length(refreshed_username)<=64),
 refreshed_at timestamptz
);
CREATE TABLE IF NOT EXISTS chat_seed_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 archive_sequence bigint NOT NULL DEFAULT 0 CHECK(archive_sequence>=0),
 members_sequence bigint NOT NULL DEFAULT 0 CHECK(members_sequence>=0),
 seeded_at timestamptz
);
ALTER TABLE chat_seed_state ADD COLUMN IF NOT EXISTS adopt_after bigint CHECK(adopt_after IS NULL OR adopt_after>=0);
INSERT INTO chat_seed_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS chat_recorded_events (
 event_id text PRIMARY KEY,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
`;

type Db=Pick<pg.PoolClient,'query'>;
const appId=/^[A-Za-z0-9._:-]{1,128}$/;
/** The Telegram originals that name a chat: updates (messages, member changes, reactions) and Nocheh's own replies. */
const recordedKinds=new Set(['telegram_update','telegram_delivered_message']);

/** Adds a chat or chat id, or changes a chat's state: the directory snapshot is stale until reloaded. */
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
/**
 * A person or bot in the app. Names are presentation only and follow the latest update that carries them, by when
 * Nocheh took it in (`at`, now when not given): checked_at is when the update that last named the account was taken
 * in, so an update recorded late (a failed record the capture reconciliation records later, or imported history)
 * never writes its older names over newer ones.
 */
export async function ensureAccount(db:Db,connection:string,person:Pick<TelegramPerson,'external'>&Partial<TelegramPerson>,app:ChatApp='telegram',at:Date|null=null):Promise<string> {
  const id=accountIdFor(app,person.external),names=!!(person.display_name||person.username);
  await db.query(`INSERT INTO chat_accounts(id,connection_id,external_id,kind,display_name,username,checked_at)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN coalesce($8::timestamptz,now()) END) ON CONFLICT DO NOTHING`,
    [id,connection,person.external,person.bot?'bot':'human',person.display_name??null,person.username??null,names,at]);
  // The same update again changes nothing and locks nothing.
  if(names)await db.query(`UPDATE chat_accounts SET display_name=coalesce($2,display_name),username=coalesce($3,username),checked_at=coalesce($4::timestamptz,now())
    WHERE id=$1 AND (checked_at IS NULL OR checked_at<coalesce($4::timestamptz,now()) OR checked_at=coalesce($4::timestamptz,now())
      AND (coalesce($2,display_name) IS DISTINCT FROM display_name OR coalesce($3,username) IS DISTINCT FROM username))`,
    [id,person.display_name??null,person.username??null,at]);
  return id;
}
/**
 * Names the person of each Telegram private chat whose row names none: a chat a reset restored or an owner record
 * brought, which carry no account (ADR-0252). A Telegram private chat's id is its person's user id, so its current id
 * names the person, as when Nocheh first records the chat. `chat` limits this to one chat. A person another private
 * chat already names keeps that one. Returns how many chats it named.
 */
export async function namePrivateChats(db:Db,chat?:string):Promise<number> {
  const rows=(await db.query(`SELECT c.id,i.connection_id,i.external_id FROM chats c JOIN chat_connections n ON n.id=c.connection_id AND n.app='telegram'
    JOIN chat_ids i ON i.chat_id=c.id AND i.state='current' WHERE c.kind='private' AND c.account_id IS NULL AND ($1::text IS NULL OR c.id=$1)
    ORDER BY c.id`,[chat??null])).rows;
  let named=0;
  for(const row of rows) {
    const account=await ensureAccount(db,row.connection_id,{external:row.external_id});
    named+=(await db.query(`UPDATE chats SET account_id=$2,updated_at=now() WHERE id=$1 AND account_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM chats o WHERE o.kind='private' AND o.account_id=$2)`,[row.id,account])).rowCount??0;
  }
  return named;
}
/**
 * SQL: whether a bot-status update in `next` (state_seq, state_bot, state_at) is newer than the last change of
 * `old`'s state (ADR-0253). A chat no change ordered yet takes any update; after an owner or system change (no seq)
 * only an update taken in later does, so an older update recorded late never undoes it.
 */
const newerState=(old:string,next:string)=>`(${old}.state_at IS NULL OR ${old}.state_seq IS NULL AND ${next}.state_at>${old}.state_at
  OR ${old}.state_seq IS NOT NULL AND ${newerUpdate(old,next,['state_seq','state_bot','state_at'])})`;
/**
 * Whether the archive original at `sequence` (its capture_sequence) came after adoption began (startAdoption). With no
 * boundary (no app start has set one), every original is after it.
 */
async function adopting(db:Db,sequence:string):Promise<boolean> {
  const row=(await db.query('SELECT adopt_after IS NULL OR adopt_after<$1::bigint AS after FROM chat_seed_state WHERE singleton',[sequence])).rows[0];
  return row?.after!==false;
}
/** A state set by the owner or by Nocheh itself, never by an update: ordered by when it happened. */
const systemChange=`state_seq=NULL,state_bot=NULL,state_at=now(),state_changed_at=now(),updated_at=now()`;
/**
 * SQL: whether chat `c` was first recorded within ten minutes before `at` (or after it), with no add and no state change
 * on record: a group whose own add has not been recorded yet, so nothing says Nocheh is in it. A group long known off,
 * one carried off from step 2b-1, and one the owner turned off are not fresh.
 */
const fresh=(c:string,at:string)=>`(${c}.state_at IS NULL AND ${c}.add_event IS NULL AND ${c}.created_at>${at}-interval '10 minutes')`;

/**
 * One update's place in a chat's history: Telegram's update_id, the bot that took it in, and when Nocheh took it in.
 * Update ids only count up within one bot, and Telegram picks the next one at random after a week without updates.
 */
export interface UpdateOrder {seq:number;bot:string|null;at:Date}
/**
 * SQL: whether the update in `next` (an INSERT's excluded row) is newer than the one `old` was last set by. Within one
 * bot the update_id decides, unless the two were taken in more than a week apart (Telegram may have restarted its
 * count), when the later one is newer; an update from another bot (the owner replaced the bot, or an imported archive)
 * is newer only if it was taken in later. A row no update set yet takes any update; the same update again changes
 * nothing.
 */
export const newerUpdate=(old:string,next:string,[seq,bot,at]:readonly [string,string,string])=>`(${old}.${seq} IS NULL OR ${old}.${at} IS NULL OR
  CASE WHEN ${old}.${bot} IS DISTINCT FROM ${next}.${bot} THEN ${next}.${at}>${old}.${at}
    ELSE ${next}.${at}>${old}.${at}+interval '7 days' OR ${next}.${at}>=${old}.${at}-interval '7 days' AND ${old}.${seq}<${next}.${seq} END)`;

/**
 * Writes the presentation an update carries, unless a later update already did. Returns whether the chat row the
 * directory loads changed (its name, its app's word for it or whether it has topics), so the directory reloads.
 */
async function present(db:Db,chat:string,order:UpdateOrder|null,values:{title?:string|null;app_type?:string|null;is_forum?:boolean|null;username?:string|null;closed?:boolean|null;seen_at?:Date|null}):Promise<boolean> {
  if(values.seen_at)await db.query(`INSERT INTO chat_details(chat_id,seen_at) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE
    SET seen_at=greatest(chat_details.seen_at,excluded.seen_at) WHERE chat_details.seen_at IS NULL OR chat_details.seen_at<excluded.seen_at`,[chat,values.seen_at]);
  if(order===null)return false;
  const newer=(await db.query(`INSERT INTO chat_details(chat_id,seq,seq_bot,seq_at) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE
    SET seq=excluded.seq,seq_bot=excluded.seq_bot,seq_at=excluded.seq_at WHERE ${newerUpdate('chat_details','excluded',['seq','seq_bot','seq_at'])} RETURNING chat_id`,
    [chat,order.seq,order.bot,order.at])).rowCount;
  if(!newer)return false;
  let changed=0;
  // An owner's own topic name is never replaced by one Telegram shows; that one is kept, for when the owner removes theirs.
  if(values.title) {
    await db.query('UPDATE chat_details SET observed_title=$2 WHERE chat_id=$1 AND observed_title IS DISTINCT FROM $2',[chat,values.title]);
    changed+=(await db.query(`UPDATE chats SET title=$2,title_source='observed',updated_at=now() WHERE id=$1 AND title IS DISTINCT FROM $2
      AND title_source IS DISTINCT FROM 'owner'`,[chat,values.title])).rowCount??0;
  }
  if(values.app_type||typeof values.is_forum==='boolean')changed+=(await db.query(`UPDATE chats SET app_type=coalesce($2,app_type),is_forum=coalesce($3,is_forum),updated_at=now()
    WHERE id=$1 AND (app_type IS DISTINCT FROM coalesce($2,app_type) OR is_forum IS DISTINCT FROM coalesce($3,is_forum))`,[chat,values.app_type??null,values.is_forum??null])).rowCount??0;
  if(values.username!==undefined&&values.username!==null||typeof values.closed==='boolean')await db.query(`UPDATE chat_details SET username=coalesce($2,username),closed=coalesce($3,closed)
    WHERE chat_id=$1`,[chat,values.username??null,values.closed??null]);
  return changed>0;
}

/**
 * Nocheh's chat records (ADR-0252): the chats, chat ids, people and memberships a Telegram update shows, recorded as
 * each update is taken in, and whether Nocheh serves each chat (ADR-0253): a group is served only once the owner adds
 * Nocheh or turns it on; a group someone else adds it to waits for the stage to leave it. It calls nothing; the
 * directory snapshot (chats()) reads these rows.
 */
export class ChatRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly stores:{archive:pg.Pool;control:pg.Pool},readonly policy:()=>AssistantPolicy){this.commands=new OwnerCommands(stores.control);}

  /**
   * Records what a captured Telegram original says, in the capture's own control transaction (next to the reaction
   * state), once, Nocheh being added or removed included (see adopt): the capture reconciliation hands every original off again on each sweep, and a replay that wrote the
   * rows again would lock them for the sweep's whole batch, clashing with live captures and the membership backfill,
   * and write an older update's names over newer ones. A failure here never fails the capture: it is rolled back alone,
   * with its mark, so a later sweep records it, and the seeder finds the chat meanwhile. Returns whether a chat or chat
   * id was added, a chat's state, name or kind of app chat changed, or a member's membership row was made or switched
   * (step 3), so the caller can reload the directories once the capture commits (reloadChats).
   */
  async capture(db:pg.PoolClient,source:CapturedSource,transport:'capture'|'import'='capture'):Promise<boolean> {
    if(source.channel!=='telegram'||!recordedKinds.has(source.kind)||!isTelegramChat(source.scope))return false;
    await db.query('SAVEPOINT chat_records');
    try {
      const first=(await db.query('INSERT INTO chat_recorded_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',[source.reference.id])).rowCount;
      const changed=first?await this.record(db,source,transport):{chats:false,members:false};
      await db.query('RELEASE SAVEPOINT chat_records');
      return changed.chats||changed.members;
    } catch(error) {
      await db.query('ROLLBACK TO SAVEPOINT chat_records');
      console.warn(JSON.stringify({event:'chat_record_failed',code:(error as {code?:string})?.code??'unknown'}));
      return false;
    }
  }

  /**
   * `transport` is how the original came in: taken in live ('capture'), or brought in by the owner from another
   * installation ('import', with the origin it had there). Only a live capture names this installation's bot. An
   * imported chat Nocheh has no row for is the owner's own history from before: it gets the id its old stored value
   * had, as the seeder gives one, so the derivatives and owner records imported with it name it (ADR-0252).
   */
  private async record(db:Db,source:CapturedSource,transport:'capture'|'import'):Promise<{chats:boolean;members:boolean}> {
    const event=(await this.stores.archive.query(`SELECT e.payload,e.received_at,e.bot_id,e.capture_sequence,(SELECT o.metadata->'audience'->>'topic_id' FROM source_observations o
      WHERE o.event_id=e.id AND o.metadata->'audience'->>'topic_state'='known' AND o.metadata->'audience'->>'chat_id'=e.scope LIMIT 1) AS topic
      FROM events e WHERE e.id=$1`,[source.reference.id])).rows[0];
    if(!event)return {chats:false,members:false};
    let payload:unknown={};try{payload=JSON.parse(Buffer.from(event.payload).toString('utf8'));}catch{}
    const bot=typeof event.bot_id==='string'&&appId.test(event.bot_id)?event.bot_id:null,imported=transport==='import';
    const facts=telegramUpdateFacts(payload,source.scope,bot),live=source.origin==='live'&&source.kind==='telegram_update';
    const order:UpdateOrder|null=live&&facts.update_id!==null?{seq:facts.update_id,bot,at:event.received_at as Date}:null,policy=this.policy();
    const connection=await ensureConnection(db,'telegram',live&&!imported?bot:null);
    // Whether Nocheh acts on this update (adopts an add or removal, folds an upgrade): a live one taken in after adoption
    // began. One an older build took in but never recorded (startAdoption) is history: recorded, never acted on.
    const acts=live&&!imported&&(!!facts.migration||!!facts.bot_status)&&await adopting(db,String(event.capture_sequence));
    let changed=false,members=false;
    const at=event.received_at as Date;
    // An upgrade first, so the new id's own messages continue the same chat.
    if(live&&facts.migration)changed=await this.migrate(db,connection,facts.migration.from,facts.migration.to,acts,at)||changed;
    for(const person of facts.people)await ensureAccount(db,connection,person,'telegram',at);
    let chat=await chatOfApp(db,connection,source.scope);
    if(!chat&&facts.chat){chat=await this.create(db,connection,facts.chat,policy,at,imported);changed=true;}
    if(!chat){if(changed)await bumpChatRevision(db);return {chats:changed,members};}
    // A private chat a reset restored or an owner record brought names no person until this installation's bot hears from it.
    if(live&&!imported&&chat.kind==='private'&&chat.current)changed=await namePrivateChats(db,chat.id)>0||changed;
    const seen=facts.message?at:null;
    if(facts.chat&&chat.current)changed=await present(db,chat.id,order,{title:facts.chat.title,app_type:facts.chat.app_type,is_forum:facts.chat.is_forum,username:facts.chat.username,seen_at:seen})||changed;
    else if(seen)await present(db,chat.id,null,{seen_at:seen});
    // Nocheh added or removed: only a live update about the group's current id, never an import, history or a private chat.
    if(order!==null&&acts&&facts.bot_status&&chat.kind==='group'&&chat.current)
      changed=await this.adopt(db,chat.id,source.scope,source.reference.id,facts.bot_status,order,policy)||changed;
    // A forum topic: the archive's own reading of the message first, as every reader of it does.
    const key=typeof event.topic==='string'&&event.topic?event.topic:facts.topic?.key;
    if(key&&chat.kind!=='topic') {
      let topic:string;try{topic=topicKey(key);}catch{topic='';}
      if(topic) {
        let id=(await db.query('SELECT id FROM chats WHERE parent_id=$1 AND topic_key=$2',[chat.id,topic])).rows[0]?.id as string|undefined;
        if(!id){id=await this.createTopic(db,connection,chat,source.scope,topic,facts.topic?.key===topic?facts.topic.name:null,'observed',imported);changed=true;}
        changed=await present(db,id,order,{title:facts.topic?.key===topic?facts.topic.name:null,closed:facts.topic?.key===topic?facts.topic.closed:null,seen_at:seen})||changed;
      }
    }
    // Who is in a group: only from live updates, each applied once and in update order.
    if(order!==null&&chat.kind==='group')for(const membership of facts.memberships) {
      const account=await ensureAccount(db,connection,membership.person,'telegram',at);
      members=await membershipFrom(db,chat.id,account,membership.state,membership.source,order)||members;
    }
    if(changed)await bumpChatRevision(db);
    return {chats:changed,members};
  }

  /**
   * A chat first seen now: its id is chatIdFor, with no bot in it; an imported one keeps its old stored value as its id
   * (see record). A private chat names its person. A group starts off: one seen with no add (after a long downtime)
   * stays silent and is never left on its own; an add in the same update then applies. Of private chats only the
   * owner's is served. No update ordered this state (state_at stays null), so the next bot-status update applies.
   */
  private async create(db:Db,connection:string,facts:TelegramChatFacts,policy:AssistantPolicy,at:Date,imported=false) {
    const id=imported?legacyChat(facts.external)?.id??chatIdFor('telegram',facts.external):chatIdFor('telegram',facts.external);
    const state:ChatState=facts.kind==='private'&&!!policy.owner_id&&facts.external===policy.owner_id?'active':'off';
    const account=facts.kind==='private'?await ensureAccount(db,connection,{external:facts.external,display_name:facts.title},'telegram',at):null;
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,account_id,title,title_source,is_forum,state,state_changed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING`,
      [id,connection,facts.kind,facts.app_type,account,facts.title,facts.title?'observed':null,facts.is_forum===true,state]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current') ON CONFLICT DO NOTHING`,[connection,facts.external,id]);
    return (await chatOfApp(db,connection,facts.external))!;
  }

  /**
   * A topic first seen now, of `parent` (whose app id is `external`). It follows its parent's state. An imported topic
   * of a chat that keeps its old stored value as its id keeps its old value too (see record).
   */
  private async createTopic(db:Db,connection:string,parent:{id:string;state:ChatState},external:string,key:string,title:string|null,source:'observed'|'owner',imported=false) {
    const id=imported&&parent.id===external?legacyChatValue(external,Number(key)):chatIdFor('telegram',external,key);
    await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,title,title_source,state) VALUES($1,$2,'topic',$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`,[id,connection,parent.id,key,title,title?source:source==='owner'?'owner':null,parent.state]);
    return (await db.query('SELECT id FROM chats WHERE parent_id=$1 AND topic_key=$2',[parent.id,key])).rows[0].id as string;
  }

  /**
   * A my_chat_member update about this bot in a group (ADR-0253), applied only when newer than the group's last state
   * change (newerState). An add by the owner turns the group on and leaves a card for the stage; an add by anyone
   * else (or an anonymous admin or a channel, which hide who) makes it pending, and the stage leaves it. An add to a
   * group already on changes nothing (a restore, an echo, an upgrade), and neither does any add, the owner's too, to a
   * group that is off, pending or could not be left and was upgraded in the last ten minutes: Nocheh is still in it,
   * and Telegram tells Nocheh it joined the new supergroup, from whoever upgraded it, which is the same group. So an
   * upgrade never undoes the owner's Off, and a pending group's own leave goes ahead (an add that came before the
   * upgrade folds instead, see fold). One off group is not known to have Nocheh in it: one first recorded in those ten
   * minutes, with no add and no state change on record (fresh), whose own add is recorded late, after the upgrade
   * message; there the owner's add is an add. Nocheh leaving on its own makes it left; anyone removing it makes it
   * removed. Promotions, demotions and restrictions change nothing. Each add or removal writes one content-free
   * chat_state_events row; `member` says the adder is a member (their account is linked to one, step 3). Never the guard
   * epoch: the directory revision tells every process.
   */
  private async adopt(db:Db,chat:string,external:string,event:string,status:TelegramBotStatus,order:UpdateOrder,policy:AssistantPolicy):Promise<boolean> {
    if(status.was_in===status.now_in)return false;
    const row=(await db.query(`SELECT c.state,${newerState('c','u')} AS newer,EXISTS(SELECT 1 FROM chat_ids i WHERE i.chat_id=c.id AND i.state='old'
        AND i.reason='migrated' AND i.changed_at>u.state_at-interval '10 minutes') AS upgraded,${fresh('c','u.state_at')} AS fresh
      FROM chats c,(SELECT $2::numeric AS state_seq,$3::text AS state_bot,$4::timestamptz AS state_at) u WHERE c.id=$1 FOR UPDATE OF c`,[chat,order.seq,order.bot,order.at])).rows[0];
    if(!row?.newer)return false;
    const previous=row.state as ChatState,owner=policy.owner_id,by=status.by;
    const role=status.anonymous?'anonymous':owner&&by?.external===owner?'owner':'other',account=by?accountIdFor('telegram',by.external):null;
    let state:ChatState=previous,kind:'added'|'removed'|null=null,action:'card'|'leave'|'tell'|'none'='none';
    if(status.now_in) {
      const echo=previous==='active'||row.upgraded&&['off','pending','could_not_leave'].includes(previous)&&!(previous==='off'&&row.fresh&&role==='owner');
      if(!echo){kind='added';state=role==='owner'?'active':'pending';action=role==='owner'?'card':'leave';}
    } else if(status.self) {
      if(['pending','could_not_leave','off','active'].includes(previous))state='left';
    } else {kind='removed';state='removed';action=previous==='active'?'tell':'none';}
    await db.query(`UPDATE chats SET state_seq=$2,state_bot=$3,state_at=$4,state=$5,state_changed_at=CASE WHEN state=$5 THEN state_changed_at ELSE now() END,
      updated_at=now() WHERE id=$1`,[chat,order.seq,order.bot,order.at,state]);
    if(kind==='added')await db.query(`UPDATE chats SET added_by_account_id=$2,added_by_role=$3,added_at=$4,add_event=$5 WHERE id=$1`,[chat,account,role,order.at,event]);
    if(kind) {
      const member=role==='other'&&!!account&&!!(await db.query('SELECT 1 FROM chat_accounts WHERE id=$1 AND member_id IS NOT NULL',[account])).rowCount;
      // A leave or card waits 30 s, so an upgrade's two halves can fold into one chat first (migrate).
      await db.query(`INSERT INTO chat_state_events(event_id,chat_id,external_id,kind,role,account_id,member,action,state,due_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+CASE WHEN $8 IN ('card','leave') THEN interval '30 seconds' ELSE interval '0 seconds' END) ON CONFLICT DO NOTHING`,
        [event,chat,external,kind,role,account,member,action,action==='none'?'done':'waiting']);
    }
    return state!==previous;
  }

  /**
   * Telegram upgraded a basic group to a supergroup, with a new id: the new id becomes the chat's current one and the
   * old one stays, so the chat keeps its history, project, tasks, switches and state. When both ids already name chats
   * of their own, they stay two chats, as a group upgraded before step 2b does, except in a live capture Nocheh acts on
   * (`live`; never history, see startAdoption): there the new one's updates came just before its upgrade message, and it
   * folds into the old one if only its own add ever served it (fold); if it may not, the two stay apart, and the new one
   * still takes the upgrade's echo (apart). `at` is when Nocheh took the upgrade message in.
   */
  async migrate(db:Db,connection:string,from:string,to:string,live=false,at:Date=new Date()):Promise<boolean> {
    if(!isTelegramChat(from)||!isTelegramChat(to)||from===to)return false;
    const old=await chatOfApp(db,connection,from),next=await chatOfApp(db,connection,to);
    if(old&&next) {
      if(!live||old.id===next.id||old.kind!=='group'||next.kind!=='group'||!old.current||!next.current)return false;
      return await this.fold(db,connection,old.id,next.id)||await this.apart(db,old.id,next.id,at);
    }
    if(old) {
      if(old.current)await db.query(`UPDATE chat_ids SET state='old',reason='migrated',changed_at=now() WHERE connection_id=$1 AND external_id=$2 AND state='current'`,[connection,from]);
      await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [connection,to,old.id,old.current?'current':'old',old.current?null:'migrated']);
      await db.query(`UPDATE chats SET app_type='supergroup',updated_at=now() WHERE id=$1 AND app_type IS DISTINCT FROM 'supergroup'`,[old.id]);
      return true;
    }
    if(next) {
      await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,'old','migrated') ON CONFLICT DO NOTHING`,[connection,from,next.id]);
      return true;
    }
    // Neither id is known: the chat is named after the first id it had, and starts off like any new group.
    const id=chatIdFor('telegram',from);
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,state,state_changed_at) VALUES($1,$2,'group','supergroup','off',now()) ON CONFLICT DO NOTHING`,
      [id,connection]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,$2,$3,'old','migrated') ON CONFLICT DO NOTHING`,[connection,from,id]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current') ON CONFLICT DO NOTHING`,[connection,to,id]);
    return true;
  }

  /**
   * Both ids of an upgraded group name a chat: the new supergroup's update (often Nocheh's own my_chat_member) came
   * before its migrate_from message. The new chat folds into the old one when nothing but its own add ever served it:
   * it is not on, or it is on only from an owner add whose card still waits, and it has no project (the card made one
   * already, or the owner gave it one). Its ids, memberships, topics (but one whose key the old chat has) and state
   * events move to the old chat, which keeps its state and its add, unless an owner add folds into an old chat Nocheh
   * was not in (left, removed or archived), or not known to be in (off and fresh: first recorded within ten minutes of
   * the add, with no add on record, see adopt): the owner added it, so it is on, and the moved card goes. Into an old
   * chat that is off, pending or could not be left, where Nocheh still is, the add is the upgrade's echo: the stage
   * finds the moved card or leave superseded, and the old chat's own leave goes ahead. Members' switches for the new chat
   * move to the old one, where a switch already there and off stays off (step 3), before the new chat goes, so a delete
   * never has to cascade. Returns whether it folded.
   */
  private async fold(db:Db,connection:string,old:string,next:string):Promise<boolean> {
    const row=(await db.query(`SELECT n.state<>'active' OR n.added_by_role='owner' AND n.state_seq IS NOT NULL
        AND EXISTS(SELECT 1 FROM chat_state_events e WHERE e.event_id=n.add_event AND e.chat_id=n.id AND e.action='card' AND e.state='waiting') AS folds,
      n.state='active' AS owner_add,o.state AS old_state,${fresh('o','n.added_at')} AS old_fresh FROM chats n,chats o WHERE n.id=$1 AND o.id=$2 FOR UPDATE OF n,o`,[next,old])).rows[0];
    if(!row?.folds)return false;
    // A project of the new chat's own (its card made one, or the owner gave it one) would be left naming no chat: the two
    // stay apart. Asked after the lock, in a statement of its own, so it sees a card's project committed meanwhile.
    if((await db.query('SELECT 1 FROM project_assignments WHERE space_id=$1',[next])).rowCount)return false;
    await db.query(`UPDATE chat_ids SET state='old',reason='migrated',changed_at=now() WHERE connection_id=$1 AND chat_id=$2 AND state='current'`,[connection,old]);
    await db.query(`UPDATE chat_ids SET chat_id=$2,changed_at=now() WHERE chat_id=$1`,[next,old]);
    await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source,since,checked_at,seen_seq,seen_bot)
      SELECT $2,account_id,state,source,since,checked_at,seen_seq,seen_bot FROM chat_memberships WHERE chat_id=$1
      ON CONFLICT(chat_id,account_id) DO UPDATE SET state=excluded.state,source=excluded.source,since=excluded.since,checked_at=excluded.checked_at,
        seen_seq=excluded.seen_seq,seen_bot=excluded.seen_bot WHERE ${newerUpdate('chat_memberships','excluded',['seen_seq','seen_bot','checked_at'])}`,[next,old]);
    await db.query('DELETE FROM chat_memberships WHERE chat_id=$1',[next]);
    const twins=`SELECT t.id FROM chats t WHERE t.parent_id=$1 AND EXISTS(SELECT 1 FROM chats k WHERE k.parent_id=$2 AND k.topic_key=t.topic_key)`;
    await db.query(`DELETE FROM chat_details WHERE chat_id IN (${twins})`,[next,old]);
    await db.query(`DELETE FROM chats WHERE id IN (${twins})`,[next,old]);
    await db.query('UPDATE chats SET parent_id=$2,updated_at=now() WHERE parent_id=$1',[next,old]);
    await db.query('UPDATE chat_state_events SET chat_id=$2,updated_at=now() WHERE chat_id=$1',[next,old]);
    await copySwitches(db,next,old);
    await db.query('DELETE FROM member_chats WHERE chat_id=$1',[next]);
    // The members' switches and memberships moved: the member directory reloads.
    await bumpMemberRevision(db);
    if(row.owner_add&&(['left','removed','archived'].includes(row.old_state)||row.old_state==='off'&&row.old_fresh))await db.query(`UPDATE chats o SET state='active',state_changed_at=now(),updated_at=now(),
      added_by_account_id=n.added_by_account_id,added_by_role=n.added_by_role,added_at=n.added_at,add_event=n.add_event,
      state_seq=n.state_seq,state_bot=n.state_bot,state_at=n.state_at FROM chats n WHERE o.id=$1 AND n.id=$2`,[old,next]);
    await db.query(`UPDATE chats SET app_type='supergroup',updated_at=now() WHERE id=$1 AND app_type IS DISTINCT FROM 'supergroup'`,[old]);
    await db.query('DELETE FROM chat_details WHERE chat_id=$1',[next]);
    await db.query('DELETE FROM chats WHERE id=$1',[next]);
    return true;
  }

  /**
   * Both ids of an upgraded group name a chat and the new one may not fold (its card made its project, or went): the two
   * stay apart, and an upgrade still never undoes the owner's Off or a pending group's leave. A new chat on only from its
   * own owner add within ten minutes of the upgrade message (`at`), whose old chat is off, pending or could not be left
   * and not fresh (see adopt), took the upgrade's echo. Its card ends unsent if it still waits, and its project stays
   * with it, so the project still names a chat. The new chat takes the old one's state and who added Nocheh, so the
   * dashboard says the same of both. Pending: the old chat's leave moves to the new chat, whose id is the only one
   * Telegram still knows, and the old chat is left. Not once the card told the owner Nocheh is on in the new chat, as it
   * usually has by then: Nocheh would leave it with no word. The new chat stays on, and the old chat's leave stays at
   * the id Telegram no longer knows, so it never leaves the group. System changes, so an older update recorded late
   * never undoes them. Members' switches for the old chat are copied to the new one, where a switch already there and off
   * stays off (step 3). Returns whether it changed anything.
   */
  private async apart(db:Db,old:string,next:string,at:Date):Promise<boolean> {
    const row=(await db.query(`SELECT o.state AS old_state,o.add_event AS old_add,n.add_event AS next_add FROM chats o,chats n
      WHERE o.id=$1 AND n.id=$2 AND n.state='active' AND n.added_by_role='owner' AND n.state_seq IS NOT NULL
        AND n.added_at>$3::timestamptz-interval '10 minutes' AND n.added_at<$3::timestamptz+interval '10 minutes'
        AND o.state IN ('off','pending','could_not_leave') AND NOT ${fresh('o','n.added_at')}
        AND NOT (o.state='pending' AND EXISTS(SELECT 1 FROM chat_state_events e WHERE e.event_id=n.add_event AND e.chat_id=n.id AND e.notice='sent'))
      FOR UPDATE OF o,n`,[old,next,at])).rows[0];
    if(!row)return false;
    await db.query(`UPDATE chat_state_events SET state='done',outcome=coalesce(outcome,'superseded'),updated_at=now()
      WHERE event_id=$1 AND chat_id=$2 AND state='waiting'`,[row.next_add,next]);
    await db.query(`UPDATE chats n SET state=o.state,added_by_account_id=o.added_by_account_id,added_by_role=o.added_by_role,added_at=o.added_at,
      add_event=o.add_event,${systemChange} FROM chats o WHERE n.id=$1 AND o.id=$2`,[next,old]);
    await copySwitches(db,old,next);
    await bumpMemberRevision(db);
    if(row.old_state!=='pending')return true;
    await db.query(`UPDATE chat_state_events SET chat_id=$1,due_at=least(due_at,now()+interval '30 seconds'),updated_at=now()
      WHERE event_id=$2 AND chat_id=$3 AND action='leave' AND state='waiting'`,[next,row.old_add,old]);
    await db.query(`UPDATE chats SET state='left',${systemChange} WHERE id=$1`,[old]);
    return true;
  }

  /**
   * Run at app start, before anything captures (ADR-0253): the first start sets where adoption begins, once: the
   * archive's last capture sequence then. An original at or before it was taken in by an older build, and the capture
   * reconciliation may record it only now (one no build marked recorded): its chats, names and memberships are recorded,
   * but an add, removal or upgrade in it is history, never acted on, so an old add is never left or carded again.
   * Returns the boundary.
   */
  async startAdoption():Promise<number> {
    const last=String((await this.stores.archive.query('SELECT coalesce(max(capture_sequence),0) AS last FROM events')).rows[0].last);
    return Number((await this.stores.control.query('UPDATE chat_seed_state SET adopt_after=coalesce(adopt_after,$1::bigint) WHERE singleton RETURNING adopt_after',
      [last])).rows[0]?.adopt_after??last);
  }

  /**
   * Run at app start (ADR-0253): the owner's private chat (TELEGRAM_OWNER_ID's) is the one private chat Nocheh serves;
   * any other one that is on turns off. Groups keep their state: the owner adds Nocheh or turns it on. A system change,
   * so an older update recorded late never undoes it. Returns how many chats changed.
   */
  async startOwnerChat(policy:Pick<AssistantPolicy,'owner_id'>=this.policy()):Promise<number> {
    const db=await this.stores.control.connect();
    try {
      await db.query('BEGIN');
      const connection=await ensureConnection(db);
      const owner=policy.owner_id?(await chatOfApp(db,connection,policy.owner_id)):null,ownerId=owner?.kind==='private'?owner.id:null;
      const changed=(await db.query(`UPDATE chats SET state=CASE WHEN id=$1::text THEN 'active' ELSE 'off' END,${systemChange}
        WHERE kind='private' AND (id IS NOT DISTINCT FROM $1::text AND state<>'active' OR id IS DISTINCT FROM $1::text AND state='active')`,[ownerId])).rowCount??0;
      if(changed)await bumpChatRevision(db);
      await db.query('COMMIT');return changed;
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }

  /**
   * The owner's switch for a group (ADR-0253): on or off, as one owner command (receipt, new guard epoch, Honcho and
   * memory review refresh), with its project in the same command when given: a new project named after the group, an
   * existing one, or none. Only a group Nocheh is in: one it left, was removed from, or knows only from imported
   * history is refused. The same state again changes nothing but still writes the receipt. A pending group turned on
   * or off is no longer left by the stage. An owner change leaves state_seq and state_bot null and state_at now, so an
   * older bot-status update recorded late never undoes it.
   */
  async setState(principal:Reader,input:unknown):Promise<ChatStateResult> {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['chat_id','state','operation_id','project'].includes(key)))throw new HttpError(400,'unknown_chat_state_field');
    const chat=body.chat_id,state=body.state as ChatStateResult['state'],operationId=string(body.operation_id,200),project=body.project===undefined?null:chatProject(body.project);
    if(!isChatId(chat)||state!=='active'&&state!=='off'||project&&state!=='active')throw new HttpError(400,'invalid_chat_state');
    // A project assignment checks the group against this process's directory: a group recorded a moment ago is in it.
    await currentChats();
    const result=await this.commands.run(principal,operationId,{kind:'chat_state',chat_id:chat,state,project},async db=>{
      const row=(await db.query('SELECT kind,state,title FROM chats WHERE id=$1 FOR UPDATE',[chat])).rows[0];
      if(!row)throw new HttpError(404,'chat_not_found');
      if(row.kind!=='group')throw new HttpError(400,'chat_not_group');
      if(['left','removed','archived'].includes(row.state))throw new HttpError(409,'chat_not_joined');
      if(row.state!==state){await db.query(`UPDATE chats SET state=$2,${systemChange} WHERE id=$1`,[chat,state]);await bumpChatRevision(db);}
      const own=(await db.query('SELECT revision,mode,project_id FROM project_assignments WHERE space_id=$1',[chat])).rows[0];
      const expected=Number(own?.revision??0);
      let projectId:string|null=own?.mode==='assigned'?own.project_id:null;
      if(project?.mode==='new') {
        projectId=digest('project:'+operationId);
        const name=typeof row.title==='string'&&row.title.replace(/\s+/g,' ').trim().slice(0,200).trim()||'Group';
        await writeProject(db,{id:projectId,name,description:'',state:'active',expected_revision:0});
      } else if(project)projectId=project.mode==='assigned'?project.project_id:null;
      if(project)await writeAssignment(db,{space_id:chat,project_id:projectId,mode:project.mode==='none'?'none':'assigned',expected_revision:expected});
      return {chat_id:chat,state,project_id:projectId};
    });
    await reloadChats();
    return result;
  }

  /**
   * The stage's end of a leave (ChatAdds, ADR-0253): a group still pending from `event`'s add becomes left, or
   * could_not_leave when Telegram refused. A system change, so an older update recorded late never undoes it; a group the
   * owner turned on or off meanwhile, or added again, keeps its state. Returns whether it changed.
   */
  async leaveSettled(chat:string,event:string,state:'left'|'could_not_leave'):Promise<boolean> {
    const db=await this.stores.control.connect();let changed=false;
    try {
      await db.query('BEGIN');
      changed=!!(await db.query(`UPDATE chats SET state=$3,${systemChange} WHERE id=$1 AND state='pending' AND add_event=$2`,[chat,event,state])).rowCount;
      if(changed)await bumpChatRevision(db);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
    if(changed)await reloadChats();
    return changed;
  }

  /**
   * Memberships from the archive, for updates taken in before chats recorded them: one batch of live Telegram
   * updates at a time, in capture order, resumable from chat_seed_state. An update capture already recorded is skipped,
   * so the batch after an app start, which holds the updates taken in since the last one, writes nothing they wrote.
   * Each is applied in its own place in the chat's history (newerUpdate), so the order they are read in does not matter
   * and a replay changes nothing. Returns how many updates it read; 0 when it has caught up with the seeder.
   */
  async backfill(limit=500):Promise<number> {
    const db=await this.stores.control.connect();let members=false,read=0;
    try {
      await db.query('BEGIN');
      const state=(await db.query('SELECT archive_sequence,members_sequence FROM chat_seed_state WHERE singleton FOR UPDATE')).rows[0];
      if(!state||Number(state.members_sequence)>=Number(state.archive_sequence)){await db.query('COMMIT');return 0;}
      const rows=(await this.stores.archive.query(`SELECT id,capture_sequence,scope,payload,received_at,bot_id FROM events
        WHERE capture_sequence>$1 AND capture_sequence<=$2 AND channel='telegram' AND origin='live' AND kind='telegram_update'
        ORDER BY capture_sequence LIMIT $3`,[state.members_sequence,state.archive_sequence,limit])).rows;
      const recorded=new Set((await db.query('SELECT event_id FROM chat_recorded_events WHERE event_id=ANY($1::text[])',[rows.map(row=>row.id)])).rows
        .map(row=>row.event_id as string));
      const connection=await ensureConnection(db);
      for(const row of rows) {
        if(recorded.has(row.id)||!isTelegramChat(row.scope))continue;
        let payload:unknown={};try{payload=JSON.parse(Buffer.from(row.payload).toString('utf8'));}catch{}
        const facts=telegramUpdateFacts(payload,row.scope);
        if(facts.update_id===null||!facts.memberships.length)continue;
        const chat=await chatOfApp(db,connection,row.scope);if(chat?.kind!=='group')continue;
        const order={seq:facts.update_id,bot:typeof row.bot_id==='string'&&appId.test(row.bot_id)?row.bot_id:null,at:row.received_at as Date};
        for(const membership of facts.memberships)
          members=await membershipFrom(db,chat.id,await ensureAccount(db,connection,membership.person,'telegram',order.at),membership.state,membership.source,order)||members;
      }
      const next=rows.length===limit?rows.at(-1)!.capture_sequence:state.archive_sequence;
      await db.query('UPDATE chat_seed_state SET members_sequence=$1 WHERE singleton',[next]);
      await db.query('COMMIT');read=rows.length;
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
    // A member's membership row made or switched: the member directory reloads now, not at its next look.
    if(members)await freshMembers().catch(()=>{});
    return read;
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

  /** Every chat record as stored now, for the owner's directory: a fresh snapshot, and each chat's details, who last added
   * Nocheh and whether Telegram ever said Nocheh was removed (ADR-0253). */
  async listing():Promise<{directory:ChatDirectory;rows:Map<string,ChatListing>}> {
    const [snapshot,details]=await Promise.all([loadChatSnapshot(this.stores.control,this.policy()),this.stores.control.query(`SELECT c.id,c.title_source,
      c.added_by_role,c.added_at,EXISTS(SELECT 1 FROM chat_state_events e WHERE e.chat_id=c.id AND e.kind='removed') AS removed_event,
      d.username,d.seen_at,d.closed,d.refreshed_state,d.refreshed_to,d.refreshed_at FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id`)]);
    return {directory:chatDirectory(snapshot),rows:new Map(details.rows.map(row=>[row.id as string,{title_source:row.title_source,username:row.username,
      seen_at:row.seen_at,closed:row.closed,refreshed:row.refreshed_at?{state:row.refreshed_state,to:row.refreshed_to,at:row.refreshed_at}:null,
      added_by:row.added_by_role??null,added_at:row.added_at??null,removed_event:row.removed_event===true}]))};
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
export interface ChatStateResult {chat_id:string;state:'active'|'off';project_id:string|null}
type ChatProject={mode:'new'}|{mode:'assigned';project_id:string}|{mode:'none'};
/** The project a group joins as the owner turns it on: a new one, an existing one, or none. */
function chatProject(value:unknown):ChatProject {
  const body=object(value),mode=body.mode,keys=Object.keys(body);
  if(mode==='new'||mode==='none'){if(keys.length===1)return {mode};}
  else if(mode==='assigned'&&keys.length===2&&typeof body.project_id==='string'&&/^[a-f0-9]{64}$/.test(body.project_id))return {mode,project_id:body.project_id};
  throw new HttpError(400,'invalid_chat_project');
}
export interface ChatListing {title_source:string|null;username:string|null;seen_at:Date|null;closed:boolean|null;
  refreshed:{state:string;to:string|null;at:Date}|null;added_by:'owner'|'other'|'anonymous'|'unknown'|'seeded'|null;added_at:Date|null;removed_event:boolean}

/**
 * Who is in a group, as one update says, unless a newer update already said otherwise (newerUpdate). When the row of a
 * member's account is made, or switches between 'in' and 'left', the member revision moves in the same transaction
 * (step 3): the member directory reads these rows for every decision made without a live message there (reaches).
 * Returns whether it moved; a member's ordinary message, which only confirms 'in', moves nothing.
 */
async function membershipFrom(db:Db,chat:string,account:string,state:'in'|'left',source:'message'|'event',order:UpdateOrder):Promise<boolean> {
  const written=(await db.query(`WITH prior AS (SELECT state FROM chat_memberships WHERE chat_id=$1 AND account_id=$2)
    INSERT INTO chat_memberships(chat_id,account_id,state,source,since,checked_at,seen_seq,seen_bot) VALUES($1,$2,$3,$4,$5,$5,$6,$7)
    ON CONFLICT(chat_id,account_id) DO UPDATE SET state=excluded.state,source=excluded.source,checked_at=excluded.checked_at,seen_seq=excluded.seen_seq,
      seen_bot=excluded.seen_bot,since=CASE WHEN chat_memberships.state=excluded.state THEN chat_memberships.since ELSE excluded.since END
    WHERE ${newerUpdate('chat_memberships','excluded',['seen_seq','seen_bot','checked_at'])} RETURNING (SELECT state FROM prior) AS prior`,
    [chat,account,state,source,order.at,order.seq,order.bot])).rows[0];
  if(!written||written.prior===state)return false;
  if(!(await db.query('SELECT 1 FROM chat_accounts WHERE id=$1 AND member_id IS NOT NULL',[account])).rowCount)return false;
  await bumpMemberRevision(db);
  return true;
}
/** Copies members' switches for group `from` to group `to`; where `to` already has a switch, off wins. */
async function copySwitches(db:Db,from:string,to:string):Promise<void> {
  await db.query(`INSERT INTO member_chats(member_id,chat_id,enabled) SELECT member_id,$2,enabled FROM member_chats WHERE chat_id=$1
    ON CONFLICT(member_id,chat_id) DO UPDATE SET enabled=false,updated_at=now() WHERE member_chats.enabled AND NOT excluded.enabled`,[from,to]);
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
    const {chats:chatRows,ids}=await readChatRows(db);
    const revision=Number((await db.query('SELECT revision FROM chat_directory_state WHERE singleton')).rows[0]?.revision??0);
    const epoch=Number((await db.query('SELECT epoch FROM guard_state WHERE singleton')).rows[0]?.epoch??0);
    await db.query('COMMIT');
    const named=policy.owner_id?ids.find(row=>row.app==='telegram'&&row.external_id===policy.owner_id)?.chat_id:undefined;
    return {chats:chatRows,ids,owner_chat:named??ownerChat(policy),epoch,revision};
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
}

/** Every chats and chat_ids row as `db` sees them, with each connection's app. */
async function readChatRows(db:Db):Promise<{chats:ChatRow[];ids:ChatIdRow[]}> {
  return {chats:(await db.query<ChatRow>(`SELECT c.id,n.app,c.kind,c.parent_id,c.topic_key,c.state,c.title,c.is_forum,c.account_id,c.app_type
      FROM chats c JOIN chat_connections n ON n.id=c.connection_id`)).rows,
    ids:(await db.query<ChatIdRow>(`SELECT n.app,i.external_id,i.chat_id,i.state FROM chat_ids i JOIN chat_connections n ON n.id=i.connection_id`)).rows};
}
/**
 * Throws unless the rows `db` sees (its own uncommitted writes included) still make a valid directory: for a writer of
 * rows that did not come from this installation (an owner record), so one bad row can never stop every later load.
 */
export async function assertChatDirectory(db:Db):Promise<void> {
  try{chatDirectory({...await readChatRows(db),owner_chat:null});}
  catch(error){if(error instanceof Error&&error.message.startsWith('invalid_chat_directory:'))throw new HttpError(400,'invalid_chat_directory');throw error;}
}

/**
 * Keeps this process's chat directory (chats()) current (ADR-0252). It loads every chats and chat_ids row at start; a
 * guard epoch newer than the snapshot's reloads it, and a lookup that finds no row reloads it when the directory
 * revision has moved, checked at most once every `interval` ms. Once started, it also checks every `interval` ms
 * (watch), because Nocheh being added or removed changes a chat's state with no new epoch (ADR-0253). A load that
 * fails, or rows that break the schema's rules, leave the previous directory in place.
 */
export class ChatDirectoryLoader implements ChatLoader {
  private running:Promise<ChatDirectory>|null=null;private again=false;private checked=0;
  private timer:ReturnType<typeof setInterval>|null=null;private failing=false;
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
  /** Reloads within `interval` ms of any change; never keeps the process alive, and stops with its pool. */
  watch():void {
    if(this.timer)return;
    this.timer=setInterval(()=>{
      if(this.control.ended){this.stop();return;}
      if(this.running)return;
      // One warning while the store is down, not one every tick.
      void this.stale().then(stale=>stale?this.load():undefined).then(()=>{this.failing=false;},error=>{if(!this.failing)failed(error);this.failing=true;});
    },this.interval);
    this.timer.unref();
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
const failed=(error:unknown)=>console.warn(JSON.stringify({event:'chat_directory_load_failed',code:(error as {code?:string})?.code??'unknown'}));

let active:ChatDirectoryLoader|null=null;
/** Installs the loader for this process, loads the first snapshot and starts watching for changes. */
export async function startChatDirectory(control:pg.Pool,policy:()=>Pick<AssistantPolicy,'owner_id'|'owner_chat'>):Promise<ChatDirectoryLoader> {
  active?.stop();
  const loader=new ChatDirectoryLoader(control,policy);active=loader;setChatLoader(loader);
  await loader.load().catch(failed);
  loader.watch();
  return loader;
}
/** After a commit that added chats, or moved a member's membership or switches (step 3): this process sees them at
 * once, the member directory too when the member revision moved. Without a loader (tests) nothing happens. */
export async function reloadChats():Promise<void> {
  await active?.load().catch(failed);
  await freshMembers().catch(()=>{});
}
/** The directory as of now, for a reader outside this process (GET /internal/chats). */
export async function currentChats():Promise<ChatDirectory> {return active?active.current():chats();}

/**
 * The assistant policy as this process serves it (ADR-0252, ADR-0253): the configured policy, with the owner's private
 * chat as the directory names it, and group_ids holding every Telegram id (current and old) of the groups that are on
 * (chats.state active), and nothing else, so comparisons with archive originals still find a group Telegram upgraded.
 * Recomputed only when the directory or the configured policy changes.
 */
export function servedPolicy(base:()=>AssistantPolicy):()=>AssistantPolicy {
  let cached:{directory:ChatDirectory;base:AssistantPolicy;policy:AssistantPolicy}|null=null;
  return ()=>{
    const directory=chats(),value=base();
    if(cached?.directory===directory&&cached.base===value)return cached.policy;
    const served=directory.all().filter(chat=>chat.kind==='group'&&chat.state==='active').map(chat=>chat.id);
    const policy={...value,owner_chat:directory.ownerChat()??ownerChat(value),group_ids:directory.rawScopes(served,'telegram')};
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
