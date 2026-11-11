import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';

/** The owner's tool switches per chat: one row for every chat ('*'), a chat, or a topic. NULL inherits. */
export const chatToolSchema=`
CREATE TABLE IF NOT EXISTS chat_tool_settings (
 space_id text PRIMARY KEY CHECK(space_id='*' OR space_id ~ '^-?[1-9][0-9]{0,18}(/topic/[1-9][0-9]{0,15})?$'),
 shell boolean,browser boolean,mcp boolean,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now()
);
`;
/** Commands, page reads and outside tool calls; a Notion call is an outside tool call. */
export type ChatTool='shell'|'browser'|'mcp';
export const chatTools:readonly ChatTool[]=['shell','browser','mcp'];
/** Where an effective value comes from: built in, the row for every chat, the chat's own row, or the topic's. */
export type ToolOrigin='default'|'every_chat'|'chat'|'topic';
export type ChatToolSettings={space:string;revision:number;own:Record<ChatTool,boolean|null>;values:Record<ChatTool,boolean>;origins:Record<ChatTool,ToolOrigin>};
const SPACE=/^-?[1-9][0-9]{0,18}(?:\/topic\/[1-9][0-9]{0,15})?$/;

/** The space whose switches apply: the owner's private chat and its topics are all the owner's chat. */
export function toolSpace(space:string,owner:string|null):string {
  return owner&&(parentSpace(space)??space)===owner?owner:space;
}
function settingSpace(value:unknown,owner:string|null):string {
  if(value==='*')return '*';
  const space=validateSpace(value);if(!SPACE.test(space))throw new HttpError(400,'invalid_space');
  return toolSpace(space,owner);
}

/**
 * The switches of one space, each resolved on its own: the topic's row, then its chat's, then the row for every chat,
 * then on. `lock` holds the rows read until the transaction ends, so a save waits for it. Reads `space` as given; callers
 * pass it through `toolSpace` first.
 */
export async function chatToolSettings(db:Pick<pg.PoolClient,'query'>,space:string,lock=false):Promise<ChatToolSettings> {
  const parent=space==='*'?null:parentSpace(space),chain=[space,...(parent?[parent]:[]),...(space==='*'?[]:['*'])];
  const rows=(await db.query(`SELECT space_id,shell,browser,mcp,revision FROM chat_tool_settings WHERE space_id=ANY($1::text[])${lock?' FOR SHARE':''}`,[chain])).rows;
  const ordered=chain.map(id=>rows.find(row=>row.space_id===id)).filter(Boolean),own=rows.find(row=>row.space_id===space);
  const result:ChatToolSettings={space,revision:Number(own?.revision??0),own:{} as any,values:{} as any,origins:{} as any};
  for(const tool of chatTools) {
    const found=ordered.find(row=>row[tool]!==null);
    result.own[tool]=own?.[tool]??null;result.values[tool]=found?found[tool]:true;
    result.origins[tool]=!found?'default':found.space_id==='*'?'every_chat':found.space_id.includes('/topic/')?'topic':'chat';
  }
  return result;
}

/** Whether an operation of this kind may be asked for or run in this space now. A Notion call is kind mcp. */
export async function chatToolAllowed(db:Pick<pg.PoolClient,'query'>,kind:string,space:string,owner:string|null,lock=false):Promise<boolean> {
  if(!chatTools.includes(kind as ChatTool))return false;
  return (await chatToolSettings(db,toolSpace(space,owner),lock)).values[kind as ChatTool];
}

/** The owner edits the switches for every chat, one chat, or one topic; each row has its own revision. */
export class ChatToolSettingsRepository {
  constructor(readonly control:pg.Pool,readonly owner:()=>string|null){}
  async get(principal:Reader,space:unknown='*') {
    admin(principal);return chatToolSettings(this.control,settingSpace(space,this.owner()));
  }
  async save(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['space','changes','expected_revision'].includes(key)))throw new HttpError(400,'invalid_chat_tools');
    const space=settingSpace(body.space,this.owner()),changes=object(body.changes),expected=body.expected_revision;
    if(!Object.keys(changes).length||Object.entries(changes).some(([key,value])=>!chatTools.includes(key as ChatTool)||value!==null&&typeof value!=='boolean')||
      !Number.isSafeInteger(expected)||Number(expected)<0)throw new HttpError(400,'invalid_chat_tools');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const current=(await db.query('SELECT shell,browser,mcp,revision FROM chat_tool_settings WHERE space_id=$1 FOR UPDATE',[space])).rows[0];
      if(Number(current?.revision??0)!==expected)throw new HttpError(409,'chat_tools_changed');
      const next=Object.fromEntries(chatTools.map(tool=>[tool,tool in changes?changes[tool]:current?.[tool]??null]));
      // A row stays once written, even with every switch inheriting, so its revision only ever grows.
      const saved=current?await db.query('UPDATE chat_tool_settings SET shell=$2,browser=$3,mcp=$4,revision=revision+1,updated_at=now() WHERE space_id=$1',
        [space,next.shell,next.browser,next.mcp]):await db.query('INSERT INTO chat_tool_settings(space_id,shell,browser,mcp,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING',
        [space,next.shell,next.browser,next.mcp]);
      if(!saved.rowCount)throw new HttpError(409,'chat_tools_changed');
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return this.get(principal,space);
  }
}
