import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object,string} from '../http.js';

export const telegramTopicSchema=`
CREATE TABLE IF NOT EXISTS telegram_topic_registrations (
 chat_id text NOT NULL CHECK(chat_id ~ '^-100[1-9][0-9]{0,15}$'),
 topic_id integer NOT NULL CHECK(topic_id>1),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chat_id,topic_id)
);
`;
export type TopicRegistration={chat_id:string;topic_id:number;name:string;updated_at:string};

/**
 * The Bot API cannot list a forum's topics. A topic that has neither a message
 * nor a captured creation or edit is unknown to Nocheh until the owner adds it
 * by its link or ID. A registration names a topic; it grants no access.
 */
export function topicReference(input:Record<string,unknown>):{chat_id:string;topic_id:number} {
  if(typeof input.link==='string'&&input.link.trim()) {
    // A private-group link is t.me/c/<internal id>/<topic id>[/<message id>].
    const match=input.link.trim().match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/([1-9][0-9]{0,15})\/([1-9][0-9]{0,9})(?:\/[1-9][0-9]{0,9})?\/?$/);
    if(!match)throw new HttpError(400,'invalid_topic_link');
    return {chat_id:'-100'+match[1],topic_id:Number(match[2])};
  }
  const chat=String(input.chat_id??''),topic=Number(input.topic_id);
  if(!/^-100[1-9][0-9]{0,15}$/.test(chat)||!Number.isSafeInteger(topic)||topic<2||topic>2147483647)throw new HttpError(400,'invalid_topic_reference');
  return {chat_id:chat,topic_id:topic};
}

export class TelegramTopicRepository {
  constructor(readonly control:pg.Pool){}
  async registrations():Promise<TopicRegistration[]> {
    return (await this.control.query('SELECT chat_id,topic_id,name,updated_at FROM telegram_topic_registrations ORDER BY chat_id,topic_id LIMIT 1000')).rows
      .map(row=>({...row,updated_at:row.updated_at.toISOString()}));
  }
  async list(principal:Reader) {admin(principal);return {topics:await this.registrations()};}
  async change(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['action','link','chat_id','topic_id','name'].includes(key))||!['add','remove'].includes(String(body.action)))
      throw new HttpError(400,'invalid_topic_change');
    const {chat_id,topic_id}=topicReference(body);
    if(body.action==='remove') {
      await this.control.query('DELETE FROM telegram_topic_registrations WHERE chat_id=$1 AND topic_id=$2',[chat_id,topic_id]);
      return {chat_id,topic_id,removed:true};
    }
    const name=string(body.name,128).replace(/\s+/g,' ').trim();if(!name)throw new HttpError(400,'topic_name_required');
    await this.control.query(`INSERT INTO telegram_topic_registrations(chat_id,topic_id,name) VALUES($1,$2,$3)
      ON CONFLICT(chat_id,topic_id) DO UPDATE SET name=$3,updated_at=now()`,[chat_id,topic_id,name]);
    return {chat_id,topic_id,name};
  }
}
