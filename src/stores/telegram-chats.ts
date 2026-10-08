import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError} from '../http.js';
import type {RuntimeCall} from '../runtime.js';

export const telegramChatSchema=`
CREATE TABLE IF NOT EXISTS telegram_chat_observations (
 chat_id text PRIMARY KEY CHECK(chat_id ~ '^-?[1-9][0-9]{0,18}$'),
 state text NOT NULL CHECK(state IN ('available','migrated','not_member','not_found')),
 chat_type text,title text,username text,is_forum boolean,migrate_to_chat_id text,
 observed_at timestamptz NOT NULL DEFAULT now()
);
`;
export type ChatObservation={chat_id:string;state:string;chat_type:string|null;title:string|null;username:string|null;
  is_forum:boolean|null;migrate_to_chat_id:string|null;observed_at:string};

const text=(value:unknown,length=200)=>typeof value==='string'&&value.trim()?value.replace(/\s+/g,' ').trim().slice(0,length):null;

/**
 * Current chat presentation read from Telegram only on an explicit owner
 * refresh. Directory reads use these saved observations and never call
 * Telegram. A chat ID stays the authority; a name never grants access.
 */
export class TelegramChatRepository {
  constructor(readonly control:pg.Pool,readonly call:RuntimeCall,readonly groups:()=>string[]){}
  async observations():Promise<Map<string,ChatObservation>> {
    const rows=(await this.control.query(`SELECT chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at
      FROM telegram_chat_observations ORDER BY chat_id LIMIT 1000`)).rows;
    return new Map(rows.map(row=>[row.chat_id,{...row,observed_at:row.observed_at.toISOString()}]));
  }
  async refresh(principal:Reader) {
    admin(principal);
    const ids=[...new Set(this.groups())].filter(id=>/^-[1-9][0-9]{0,18}$/.test(id)).slice(0,50);
    if(!ids.length)return {chats:[]};
    const chats:ChatObservation[]=[];
    for(const id of ids) {
      let result:Record<string,unknown>;
      try{result=await this.call('telegram.chat',{chat_id:id},20000);}catch{throw new HttpError(503,'telegram_refresh_unavailable');}
      const state=['available','migrated','not_member','not_found'].includes(String(result.state))?String(result.state):'not_found';
      const migrated=state==='migrated'&&typeof result.migrate_to_chat_id==='string'&&/^-[1-9][0-9]{0,18}$/.test(result.migrate_to_chat_id)?result.migrate_to_chat_id:null;
      const row=(await this.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(chat_id) DO UPDATE SET state=$2,chat_type=$3,title=$4,username=$5,is_forum=$6,migrate_to_chat_id=$7,observed_at=now()
        RETURNING chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at`,
        [id,state,state==='available'?text(result.type,32):null,state==='available'?text(result.title):null,
          state==='available'?text(result.username,64):null,state==='available'?result.is_forum===true:null,migrated])).rows[0];
      chats.push({...row,observed_at:row.observed_at.toISOString()});
    }
    return {chats};
  }
}
