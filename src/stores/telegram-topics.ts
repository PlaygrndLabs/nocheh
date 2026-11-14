import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {chatIdFor,chatIdSql,isChatId,topicKey} from '../chats.js';
import {isTelegramChat,parseTelegramLink} from '../chats-telegram.js';
import {HttpError,object,string} from '../http.js';
import {bumpChatRevision,chatOfApp,ensureConnection,groupRow,reloadChats} from './chats.js';

/**
 * Before step 2b the topics the owner added were saved here. Step 2b-1 keeps the table read-only, so a rollback finds
 * it as it was (the seeder copied each into a topic row named by the owner); step 2b-2 drops it.
 */
export const telegramTopicSchema=`
CREATE TABLE IF NOT EXISTS telegram_topic_registrations (
 chat_id text NOT NULL CHECK(${chatIdSql('chat_id')}),
 topic_id integer NOT NULL CHECK(topic_id>1),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chat_id,topic_id)
);
`;
/** A topic the owner named: chat_id is its group (a Nocheh chat), space_id the topic itself. */
export type TopicRegistration={chat_id:string;topic_id:number;space_id:string;name:string;updated_at:string};

/**
 * Which topic the owner means: a t.me/c link (its group's Telegram id and the topic's thread id), or a Nocheh group
 * id (a group's Telegram id also names it) and the topic's thread id. The group is found later, by its chat ids.
 */
export function topicReference(input:Record<string,unknown>):{chat:string;topic_id:number;link:boolean} {
  if(typeof input.link==='string'&&input.link.trim()) {
    const link=parseTelegramLink(input.link),topic=Number(link?.parts[0]);
    if(!link||!Number.isSafeInteger(topic)||topic<2||topic>2147483647)throw new HttpError(400,'invalid_topic_link');
    return {chat:link.external,topic_id:topic,link:true};
  }
  const chat=typeof input.chat_id==='string'?input.chat_id:'',topic=Number(input.topic_id);
  if(!isChatId(chat)||!Number.isSafeInteger(topic)||topic<2||topic>2147483647)throw new HttpError(400,'invalid_topic_reference');
  return {chat,topic_id:topic,link:false};
}

/**
 * The Bot API cannot list a forum's topics. A topic that has neither a message nor a captured creation or edit is
 * unknown to Nocheh until the owner adds it by its link or id (ADR-0250): the owner's name goes on the topic's chats
 * row, which a name Telegram shows later never replaces. A topic grants no access, and the row stays when the owner
 * removes it from the list, so whatever names it keeps meaning the same topic.
 */
export class TelegramTopicRepository {
  constructor(readonly control:pg.Pool){}
  async registrations():Promise<TopicRegistration[]> {
    return (await this.control.query(`SELECT c.parent_id,c.topic_key,c.id,c.title,c.updated_at FROM chats c
      WHERE c.kind='topic' AND c.title_source='owner' AND c.title IS NOT NULL ORDER BY c.parent_id,length(c.topic_key),c.topic_key LIMIT 1000`)).rows
      .map(row=>({chat_id:row.parent_id,topic_id:Number(row.topic_key),space_id:row.id,name:row.title,updated_at:row.updated_at.toISOString()}));
  }
  async list(principal:Reader) {admin(principal);return {topics:await this.registrations()};}
  async change(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['action','link','chat_id','topic_id','name'].includes(key))||!['add','remove'].includes(String(body.action)))
      throw new HttpError(400,'invalid_topic_change');
    const reference=topicReference(body),name=body.action==='add'?string(body.name,128).replace(/\s+/g,' ').trim():'';
    if(body.action==='add'&&!name)throw new HttpError(400,'topic_name_required');
    const key=topicKey(reference.topic_id),db=await this.control.connect();let result:Record<string,unknown>,added=false;
    try {
      await db.query('BEGIN');
      const connection=await ensureConnection(db);
      // A group by its Nocheh id, or by a Telegram id it has (a link names one).
      const named=!reference.link&&(await db.query(`SELECT 1 FROM chats WHERE id=$1 AND kind='group'`,[reference.chat])).rowCount?reference.chat:
        isTelegramChat(reference.chat)?(await chatOfApp(db,connection,reference.chat))?.id:null;
      const group=await groupRow(db,named??'');
      const existing=(await db.query(`SELECT c.id,c.title_source,d.observed_title FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id
        WHERE c.parent_id=$1 AND c.topic_key=$2 FOR UPDATE OF c`,[group.id,key])).rows[0];
      if(body.action==='remove') {
        // Back to the name Telegram showed; a topic never seen leaves the list.
        const shown=existing?.observed_title??null;
        if(existing?.title_source==='owner')await db.query(`UPDATE chats SET title=$2,title_source=CASE WHEN $2::text IS NULL THEN NULL ELSE 'observed' END,
          updated_at=now() WHERE id=$1`,[existing.id,shown]);
        result={chat_id:group.id,topic_id:reference.topic_id,space_id:existing?.id??null,removed:true};
      } else if(existing) {
        await db.query(`UPDATE chats SET title=$2,title_source='owner',updated_at=now() WHERE id=$1`,[existing.id,name]);
        result={chat_id:group.id,topic_id:reference.topic_id,space_id:existing.id,name};
      } else {
        // A capture may record the same topic meanwhile: then the owner's name goes on that row.
        added=!!(await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,title,title_source,state,added_by_role,added_at)
          VALUES($1,$2,'topic',$3,$4,$5,'owner',$6,'owner',now()) ON CONFLICT DO NOTHING`,
          [chatIdFor('telegram',group.external,key),connection,group.id,key,name,group.state])).rowCount;
        const id=(await db.query(`UPDATE chats SET title=$3,title_source='owner',updated_at=now() WHERE parent_id=$1 AND topic_key=$2 RETURNING id`,
          [group.id,key,name])).rows[0]?.id;
        if(!id)throw new HttpError(409,'topic_conflict');
        if(added)await bumpChatRevision(db);
        result={chat_id:group.id,topic_id:reference.topic_id,space_id:id,name};
      }
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
    // This process's directory shows the owner's name at once (cards and lists show it; a name decides nothing).
    await reloadChats();
    return result;
  }
}
