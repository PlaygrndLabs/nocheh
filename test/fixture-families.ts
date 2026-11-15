// Both fixture families for store tests that make up their own chats (ADR-0251). Synthetic values only.
import {accountIdFor,chatDirectory,chatIdFor,type ChatDirectory,type ChatIdRow,type ChatRow} from '../src/chats.js';
import {legacyChat} from '../src/chats-telegram.js';
import {OWNER,legacyChats,type FixtureChats} from './fixture-groups.js';

/**
 * How a test's chats are named. A test writes each chat the way Telegram sends it, as an old-shaped value ('-1001…',
 * '-1001…/topic/7', '456'), and asks its family for the chat's Nocheh id:
 * - 'old-shaped ids': chats stored before step 2b, whose Nocheh id is that value (legacyChats);
 * - 'digest ids': chats first seen after step 2b, whose Nocheh id is chatIdFor (a group, a topic and a private chat
 *   each get a digest, and chat_ids maps the Telegram id to it).
 * The owner's private chat is old-shaped in both, as on an installation that existed before step 2b. Archive rows keep
 * Telegram's ids in both: only Nocheh-facing values change.
 */
export interface Family {
  readonly name:'old-shaped ids'|'digest ids';
  /** The Nocheh id of a chat given as an old-shaped value; OWNER and values that name no chat ('owner', a project id)
   * are kept. */
  id(value:string):string;
  /** The chats rows the seeder would make for these values: `owner` is the owner's private chat, a group is served when
   * its Telegram id is in `served`, as the 2b-1 bridge serves it. */
  chats(values:Iterable<string>,options?:{owner?:string|null;served?:readonly string[]}):FixtureChats;
  /** chats() as a directory, for installChatsForTest. */
  directory(values:Iterable<string>,options?:{owner?:string|null;served?:readonly string[]}):ChatDirectory;
}

const old:Family={
  name:'old-shaped ids',
  id:value=>value,
  chats:(values,options={})=>legacyChats(values,options),
  directory:(values,options={})=>chatDirectory(legacyChats(values,options)),
};

/** A digest for every chat except the owner's, which stays old-shaped. */
function digestChats(values:Iterable<string>,options:{owner?:string|null;served?:readonly string[]}={}):FixtureChats {
  const owner=options.owner??null,base=legacyChats([...values],options),id=(value:string)=>value===owner?value:newId(value);
  const chats:ChatRow[]=base.chats.map(row=>({...row,id:id(row.id),parent_id:row.parent_id===null?null:id(row.parent_id)}));
  const ids:ChatIdRow[]=base.ids.map(row=>({...row,chat_id:id(row.chat_id)}));
  return {chats,ids,owner_chat:base.owner_chat,accounts:base.accounts};
}
function newId(value:string):string {
  const chat=legacyChat(value);
  if(!chat||value===OWNER)return value;
  return chat.kind==='topic'?chatIdFor('telegram',chat.external,chat.topic_key):chatIdFor('telegram',chat.external);
}
const digests:Family={
  name:'digest ids',
  id:newId,
  chats:digestChats,
  directory:(values,options={})=>chatDirectory(digestChats(values,options)),
};

/** Run a store test once per family: a privacy rule must hold for chats stored before step 2b and for chats seen after. */
export const families:readonly Family[]=[old,digests];
/** The owner's account id for a Telegram user id, as private_answers and chat_accounts store it. */
export const accountOf=(external:string)=>accountIdFor('telegram',external);
