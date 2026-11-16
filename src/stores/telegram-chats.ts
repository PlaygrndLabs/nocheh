import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {chatIdSql} from '../chats.js';
import {isTelegramChat} from '../chats-telegram.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';
import {bumpChatRevision,chatOfApp,ensureConnection,reloadChats,type ChatRepository} from './chats.js';

/**
 * Before step 2b a refresh was saved here, keyed by the group's Telegram id. Step 2b-1 keeps the table read-only, so a
 * rollback finds it as it was (the seeder copied it into chats and chat_details); step 2b-2 drops it.
 */
export const telegramChatSchema=`
CREATE TABLE IF NOT EXISTS telegram_chat_observations (
 chat_id text PRIMARY KEY CHECK(${chatIdSql('chat_id')}),
 state text NOT NULL CHECK(state IN ('available','migrated','not_member','not_found')),
 chat_type text,title text,username text,is_forum boolean,migrate_to_chat_id text,
 observed_at timestamptz NOT NULL DEFAULT now()
);
`;
/** One refreshed chat as the owner's directory shows it. chat_id is the Nocheh chat; external the Telegram id asked. */
export type ChatObservation={chat_id:string;external:string;state:string;chat_type:string|null;title:string|null;username:string|null;
  is_forum:boolean|null;migrate_to_chat_id:string|null;observed_at:string};

const text=(value:unknown,length=200)=>typeof value==='string'&&value.trim()?value.replace(/\s+/g,' ').trim().slice(0,length):null;
const states=['available','migrated','not_member','not_found'];
const appTypes=new Set(['private','group','supergroup','channel']);

/**
 * Current chat presentation read from Telegram only on an explicit owner refresh (ADR-0252): the served groups' names
 * (unless a captured update already named them), Telegram's own word for each and whether it has topics, written to
 * their chats rows. Directory reads use what is saved and never call Telegram. A chat id stays the authority; a name
 * never grants access, and a refresh never changes whether a chat is served. A group Telegram moved to a new id (an
 * upgrade to a supergroup) gets that id as its current one at once, keeping the old one, and is asked again under it.
 */
export class TelegramChatRepository {
  constructor(readonly control:pg.Pool,readonly call:RuntimeCall,readonly chats:Pick<ChatRepository,'listing'|'migrate'|'policy'>){}

  async refresh(principal:Reader) {
    admin(principal);
    const {directory}=await this.chats.listing();
    const groups=directory.all().filter(chat=>chat.app==='telegram'&&chat.kind==='group'&&directory.served(chat.id)).slice(0,50);
    const chats:ChatObservation[]=[];let linked=false;
    for(const group of groups) {
      let external=directory.appIds(group.id)?.chat??null;
      // An upgraded group is asked once more under its new id.
      for(let attempt=0;external&&attempt<2;attempt++) {
        let result:Record<string,unknown>;
        try{result=await this.call('telegram.chat',{chat_id:external},20000);}catch{throw new HttpError(503,'telegram_refresh_unavailable');}
        const state=states.includes(String(result.state))?String(result.state):'not_found';
        const moved=state==='migrated'&&isTelegramChat(result.migrate_to_chat_id)&&result.migrate_to_chat_id!==external?result.migrate_to_chat_id as string:null;
        const {row,follow}=await this.record(group.id,external,state,moved,result);
        chats.push(row);
        // Asked again only under an id this chat now has: an id that names another chat keeps the 'migrated' answer.
        if(!moved||!follow)break;
        linked=true;external=moved;
      }
    }
    // This process's directory shows the names and ids just saved (a name decides nothing, but cards and lists show it).
    if(linked||chats.length)await reloadChats();
    return {chats};
  }

  /**
   * Writes one answer from Telegram: presentation on the chat row, the refresh outcome in chat_details. `follow` says
   * whether the id Telegram moved the chat to is now this chat's (linked here, or already), so it may be asked next.
   */
  private async record(chat:string,external:string,state:string,moved:string|null,result:Record<string,unknown>):Promise<{row:ChatObservation;follow:boolean}> {
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const available=state==='available',type=available?text(result.type,32):null,title=available?text(result.title,256):null;
      const username=available?text(result.username,64)?.replace(/^@+/,'')||null:null,isForum=available?result.is_forum===true:null;
      let follow=false;
      if(moved) {
        const connection=await ensureConnection(db);
        // Only the id this chat was asked under moves; an id that already names another chat stays apart.
        const asked=await chatOfApp(db,connection,external);
        if(asked?.id===chat&&await this.chats.migrate(db,connection,external,moved))await bumpChatRevision(db);
        follow=(await chatOfApp(db,connection,moved))?.id===chat;
      }
      if(available) {
        // A name a captured update showed stays preferred; the refresh names a chat Telegram never named in one.
        await db.query(`UPDATE chats SET title=CASE WHEN title_source='observed' AND title IS NOT NULL OR $2::text IS NULL THEN title ELSE $2 END,
          title_source=CASE WHEN title_source='observed' AND title IS NOT NULL OR $2::text IS NULL THEN title_source ELSE 'refreshed' END,
          app_type=coalesce($3,app_type),is_forum=$4,updated_at=now() WHERE id=$1`,[chat,title,type&&appTypes.has(type)?type:null,isForum]);
      }
      // The name and username Telegram answered are kept apart from the ones later updates show: they name runtime
      // profiles and send destinations until the owner refreshes again, as before step 2b.
      const saved=(await db.query(`INSERT INTO chat_details(chat_id,username,refreshed_state,refreshed_to,refreshed_title,refreshed_username,refreshed_at)
        VALUES($1,$2,$3,$4,$5,$2,now())
        ON CONFLICT(chat_id) DO UPDATE SET username=CASE WHEN $3='available' THEN excluded.username ELSE chat_details.username END,
          refreshed_state=$3,refreshed_to=$4,refreshed_title=$5,refreshed_username=$2,refreshed_at=now() RETURNING refreshed_at`,
        [chat,username,state,moved,title])).rows[0];
      await db.query('COMMIT');
      return {row:{chat_id:chat,external,state,chat_type:type,title,username,is_forum:isForum,migrate_to_chat_id:moved,observed_at:saved.refreshed_at.toISOString()},follow};
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  }
}
