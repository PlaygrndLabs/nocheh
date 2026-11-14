import {createHash} from 'node:crypto';
import {HttpError} from './http.js';
import {legacyChatSource} from './chats-telegram.js';
import {chatApps,chatIdStates,chatKinds,chatStates,type AppBinding,type ChatApp,type ChatAppLabel,type ChatIdState,type ChatKind,
  type ChatState,type ConversationChatFields,type ServedChats} from './chat-wire.js';

export {chatApps,chatIdStates,chatKinds,chatStates};
export type {AppBinding,ChatApp,ChatAppLabel,ChatIdState,ChatKind,ChatState,ConversationChatFields,ServedChats};

/*
 * Nocheh's own chat ids (ADR-0250).
 *
 * Every chat Nocheh knows is a chats row whose id never changes. A chat value stored before step 2b stays, unchanged,
 * as that chat's id (the Telegram adapter's legacyChat reads it once, when the seeder makes its row). A chat first seen
 * later gets chatIdFor(app, external[, topic]), a digest with no bot in it. chat_ids maps each app id a chat has had
 * (current and old) to the chat. Code asks the directory below what a chat is; nothing outside the Telegram adapter
 * decides private, group or topic, parent or topic from an id's shape, and an id with no row counts as private and
 * reads nothing (ADR-0242, fail closed).
 */

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
/** canonical() of a list of strings, byte for byte as src/archive.ts writes it, so a chat id is
 * digest(canonical([...])) without this module importing the archive. */
const canonicalList=(values:readonly string[])=>`[${values.map(value=>JSON.stringify(value)).join(',')}]`;
const externalPattern=/^[A-Za-z0-9._:-]{1,128}$/,topicPattern=/^[A-Za-z0-9._-]{1,64}$/,digestPattern=/^[a-f0-9]{64}$/;
const isApp=(value:unknown):value is ChatApp=>typeof value==='string'&&(chatApps as readonly string[]).includes(value);

/** A topic's key in its app: a Telegram thread id as text ('7'), a Slack thread ts. A number must be a positive integer. */
export function topicKey(value:unknown):string {
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
  if(typeof value==='string'&&topicPattern.test(value))return value;
  throw new HttpError(400,'invalid_topic_key');
}
/**
 * The id of a chat first seen after step 2b: digest(canonical(['chat', app, ...external, 'topic', key])). It holds no
 * bot, so replacing the bot keeps every chat. Telegram names a chat by one id; Slack by [team, channel]. A chat keeps
 * the id made from the first app id it was seen under; a later id (a Telegram upgrade) is another chat_ids row.
 */
export function chatIdFor(app:ChatApp,external:string|readonly string[],topic?:string|number|null):string {
  const parts=typeof external==='string'?[external]:[...external];
  if(!isApp(app)||parts.length!==(app==='slack'?2:1)||parts.some(part=>typeof part!=='string'||!externalPattern.test(part)))
    throw new HttpError(400,'invalid_chat_reference');
  return sha256(canonicalList(['chat',app,...parts,...(topic===undefined||topic===null?[]:['topic',topicKey(topic)])]));
}
/** The id of an app's one connection (UNIQUE(app)); it holds no bot either, so a new bot keeps the connection. */
export const connectionIdFor=(app:ChatApp):string=>{if(!isApp(app))throw new HttpError(400,'invalid_chat_app');return sha256(canonicalList(['connection',app]));};
/** The id of a person or bot account in an app: the Telegram user id, or a Slack user in its team. */
export function accountIdFor(app:ChatApp,external:string,team=''):string {
  if(!isApp(app)||typeof external!=='string'||!externalPattern.test(external)||typeof team!=='string'||team&&!externalPattern.test(team))
    throw new HttpError(400,'invalid_account_reference');
  return sha256(canonicalList(['account',app,team,external]));
}

/** A Nocheh chat id: a digest, or a value stored before step 2b in its frozen shape. The one shared check. */
const chatIdSource=`[a-f0-9]{64}|${legacyChatSource}`;
export const chatIdPattern=new RegExp(`^(?:${chatIdSource})$`);
export const isChatId=(value:unknown):value is string=>typeof value==='string'&&chatIdPattern.test(value);
const sqlColumn=(column:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column))throw Error('invalid_sql_column');return column;};
/** SQL CHECK that `column` holds a Nocheh chat id, exactly as isChatId decides it. */
export const chatIdSql=(column:string)=>`${sqlColumn(column)} ~ '^(?:${chatIdSource})$'`;
/** SQL CHECK that a text[] `column` holds only Nocheh chat ids (and at least one). Ids hold no comma. */
export const chatIdListSql=(column:string)=>`array_to_string(${sqlColumn(column)},',') ~ '^(?:${chatIdSource})(?:,(?:${chatIdSource}))*$'`;

/** One chat as the directory holds it. */
export interface Chat {
  readonly id:string;readonly app:ChatApp;readonly kind:ChatKind;
  /** A topic's chat; null for a private chat or a group. */
  readonly parent_id:string|null;
  /** A topic's key in its app; null for a private chat or a group. */
  readonly topic_key:string|null;
  /** A topic's own state is not read: served() follows its parent. */
  readonly state:ChatState;readonly title:string|null;readonly is_forum:boolean;
  /** A private chat's person (a chat_accounts id). */
  readonly account_id:string|null;
  /** The app's own word for the chat (Telegram private, group, supergroup or channel). Shown, never decided on. */
  readonly app_type:string|null;
  /** The owner's private chat, or one of its topics. */
  readonly owner:boolean;
  /** The chat's app ids, current first, then old ones. A topic has none of its own: see appIds(). */
  readonly app_ids:readonly ChatAppLabel[];
}
/** Where a chat lives in its app: the current app id of the chat (a topic's parent's), the topic key, and older ids. */
export interface ChatAddress extends AppBinding {readonly old:readonly string[]}

/** A chats row as the loader reads it, its connection resolved to its app. */
export interface ChatRow {
  id:string;app:ChatApp;kind:ChatKind;parent_id:string|null;topic_key:string|null;state:ChatState;
  title?:string|null;is_forum?:boolean|null;account_id?:string|null;app_type?:string|null;
}
/** A chat_ids row, its connection resolved to its app. Groups and private chats have them; topics do not. */
export interface ChatIdRow {app:ChatApp;external_id:string;chat_id:string;state:ChatIdState}
/** Everything a directory is built from. owner_chat is policy.owner_chat; epoch and revision are what it was loaded at
 * (the guard epoch and chat_directory_state.revision), 0 for fixtures. */
export interface ChatSnapshot {chats:readonly ChatRow[];ids:readonly ChatIdRow[];owner_chat:string|null;epoch?:number;revision?:number}

/**
 * What every caller asks instead of reading an id's shape. Synchronous: a snapshot of the chats and chat_ids rows,
 * reloaded by its loader (Part A) when a newer guard epoch is seen and, at most every few seconds, after a miss.
 * Every answer about an id with no row fails closed: it is no group, private, unserved, and expands to nothing.
 */
export interface ChatDirectory {
  readonly epoch:number;readonly revision:number;
  /** Every chat, sorted by id: the dashboard's directory items. */
  all():readonly Chat[];
  get(id:string|null|undefined):Chat|null;
  /** null when no row names the id. */
  kind(id:string|null|undefined):ChatKind|null;
  /** A group, or a topic of a group; the only chats that may share or be shared with. Unknown: false. */
  isGroup(id:string|null|undefined):id is string;
  /** Everything that is not isGroup: a private chat, its topics, and any id with no row. */
  isPrivate(id:string|null|undefined):boolean;
  /** A topic's chat (a group or a private chat); null for anything else. Replaces reading the parent out of an id. */
  parentOf(id:string|null|undefined):string|null;
  /** The group of a group or of one of its topics; null for private chats, their topics and unknown ids. */
  groupOf(id:string|null|undefined):string|null;
  /** A chat's topics, sorted. */
  topicsOf(id:string|null|undefined):readonly string[];
  /** The topic of `parent` with this key, or null: a missing topic row reads nothing. */
  topicOf(parent:string|null|undefined,key:string|number|null|undefined):string|null;
  /** The owner's private chat (policy.owner_chat) when its row is there and private, else null. */
  ownerChat():string|null;
  /** The owner's private chat or one of its topics. */
  isOwner(id:string|null|undefined):boolean;
  /** The chat, or a topic's parent, is active. */
  served(id:string|null|undefined):boolean;
  /** Where to send to a chat in its app, for sends and the turn pass's app binding; null for an unknown id or a chat
   * with no current app id. */
  appIds(id:string|null|undefined):ChatAddress|null;
  /** The chat an app names (by its current or an old id), or that chat's topic; null when no row names it. */
  resolve(app:ChatApp,external:string,topic?:string|number|null):string|null;
  /** The known chats among `ids`, each with its topics: an SQL id list for `column = ANY($n::text[])`. Unknown ids
   * are left out. */
  expand(ids:Iterable<string>):string[];
  /** Every app id (current and old) of the known chats among `ids`, a topic counting as its parent: the archive's
   * events.scope values to read them with. Optionally one app's only. */
  rawScopes(ids:Iterable<string>,app?:ChatApp):string[];
}

const invalid=(reason:string)=>Error('invalid_chat_directory:'+reason);
const key=(...parts:string[])=>parts.join('\n');

class SnapshotDirectory implements ChatDirectory {
  readonly epoch:number;readonly revision:number;
  private readonly chats=new Map<string,Chat>();private readonly topics=new Map<string,string[]>();
  private readonly byTopic=new Map<string,string>();private readonly byApp=new Map<string,string>();
  private readonly sorted:readonly Chat[];private readonly owner:string|null;
  constructor(snapshot:ChatSnapshot,private readonly onMiss?:(id:string)=>void) {
    this.epoch=snapshot.epoch??0;this.revision=snapshot.revision??0;
    if(!Number.isSafeInteger(this.epoch)||this.epoch<0||!Number.isSafeInteger(this.revision)||this.revision<0)throw invalid('version');
    const rows=new Map<string,ChatRow>();
    for(const row of snapshot.chats) {
      if(!isChatId(row.id)||rows.has(row.id))throw invalid('chat_id');
      if(!isApp(row.app)||!(chatKinds as readonly string[]).includes(row.kind)||!(chatStates as readonly string[]).includes(row.state))throw invalid('chat_row');
      if((row.kind==='topic')!==(row.parent_id!==null)||(row.kind==='topic')!==(row.topic_key!==null)||
        row.topic_key!==null&&!topicPattern.test(row.topic_key))throw invalid('topic_row');
      rows.set(row.id,row);
    }
    const labels=new Map<string,ChatAppLabel[]>();
    for(const row of snapshot.ids) {
      const chat=rows.get(row.chat_id);
      if(!chat||chat.kind==='topic'||chat.app!==row.app||!externalPattern.test(row.external_id)||!(chatIdStates as readonly string[]).includes(row.state))throw invalid('chat_ids_row');
      const at=key(row.app,row.external_id);if(this.byApp.has(at))throw invalid('chat_ids_duplicate');
      this.byApp.set(at,row.chat_id);
      const list=labels.get(row.chat_id)??[];
      if(row.state==='current'&&list.some(label=>label.state==='current'))throw invalid('chat_ids_current');
      list.push({app:row.app,external:row.external_id,state:row.state});labels.set(row.chat_id,list);
    }
    const ownerRow=snapshot.owner_chat===null?undefined:rows.get(snapshot.owner_chat);
    this.owner=ownerRow?.kind==='private'?ownerRow.id:null;
    for(const row of rows.values()) {
      if(row.kind!=='topic')continue;
      const parent=rows.get(row.parent_id!);
      if(!parent||parent.kind==='topic'||parent.app!==row.app)throw invalid('topic_parent');
      const at=key(parent.id,row.topic_key!);if(this.byTopic.has(at))throw invalid('topic_duplicate');
      this.byTopic.set(at,row.id);this.topics.set(parent.id,[...this.topics.get(parent.id)??[],row.id]);
    }
    for(const list of this.topics.values())list.sort();
    for(const row of rows.values()) {
      const own=labels.get(row.id)??[];
      const app_ids=Object.freeze([...own.filter(label=>label.state==='current'),...own.filter(label=>label.state==='old').sort((a,b)=>a.external<b.external?-1:1)]
        .map(label=>Object.freeze(label)));
      this.chats.set(row.id,Object.freeze({id:row.id,app:row.app,kind:row.kind,parent_id:row.parent_id,topic_key:row.topic_key,state:row.state,
        title:row.title??null,is_forum:row.is_forum===true,account_id:row.account_id??null,app_type:row.app_type??null,
        owner:this.owner!==null&&(row.id===this.owner||row.parent_id===this.owner),app_ids}));
    }
    this.sorted=Object.freeze([...this.chats.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  }
  private miss(id:unknown){if(this.onMiss&&isChatId(id))this.onMiss(id);}
  all(){return this.sorted;}
  get(id:string|null|undefined):Chat|null {
    if(typeof id!=='string')return null;
    const chat=this.chats.get(id);if(!chat)this.miss(id);
    return chat??null;
  }
  kind(id:string|null|undefined){return this.get(id)?.kind??null;}
  isGroup(id:string|null|undefined):id is string {
    const chat=this.get(id);if(!chat)return false;
    return chat.kind==='group'||chat.kind==='topic'&&this.chats.get(chat.parent_id!)?.kind==='group';
  }
  isPrivate(id:string|null|undefined){return !this.isGroup(id);}
  parentOf(id:string|null|undefined){const chat=this.get(id);return chat?.kind==='topic'?chat.parent_id:null;}
  groupOf(id:string|null|undefined){
    const chat=this.get(id);if(!chat)return null;
    const base=chat.kind==='topic'?this.chats.get(chat.parent_id!)!:chat;
    return base.kind==='group'?base.id:null;
  }
  topicsOf(id:string|null|undefined):readonly string[]{return typeof id==='string'?this.topics.get(id)??[]:[];}
  topicOf(parent:string|null|undefined,value:string|number|null|undefined){
    if(typeof parent!=='string'||value===null||value===undefined)return null;
    let topic:string;try{topic=topicKey(value);}catch{return null;}
    const id=this.byTopic.get(key(parent,topic));if(!id)this.miss(parent);
    return id??null;
  }
  ownerChat(){return this.owner;}
  isOwner(id:string|null|undefined){return this.get(id)?.owner===true;}
  served(id:string|null|undefined){
    const chat=this.get(id);if(!chat)return false;
    return (chat.kind==='topic'?this.chats.get(chat.parent_id!)!:chat).state==='active';
  }
  appIds(id:string|null|undefined):ChatAddress|null {
    const chat=this.get(id);if(!chat)return null;
    const base=chat.kind==='topic'?this.chats.get(chat.parent_id!)!:chat,current=base.app_ids.find(label=>label.state==='current');
    if(!current)return null;
    return Object.freeze({app:base.app,chat:current.external,topic:chat.kind==='topic'?chat.topic_key:null,
      old:Object.freeze(base.app_ids.filter(label=>label.state==='old').map(label=>label.external))});
  }
  resolve(app:ChatApp,external:string,topic?:string|number|null){
    if(!isApp(app)||typeof external!=='string')return null;
    const chat=this.byApp.get(key(app,external));
    if(!chat){if(externalPattern.test(external))this.onMiss?.(external);return null;}
    return topic===undefined||topic===null?chat:this.topicOf(chat,topic);
  }
  expand(ids:Iterable<string>){
    const out=new Set<string>();
    for(const id of ids){const chat=this.get(id);if(!chat)continue;out.add(chat.id);if(chat.kind!=='topic')for(const topic of this.topicsOf(chat.id))out.add(topic);}
    return [...out].sort();
  }
  rawScopes(ids:Iterable<string>,app?:ChatApp){
    const out=new Set<string>();
    for(const id of ids){
      const chat=this.get(id);if(!chat)continue;
      const base=chat.kind==='topic'?this.chats.get(chat.parent_id!)!:chat;
      for(const label of base.app_ids)if(app===undefined||label.app===app)out.add(label.external);
    }
    return [...out].sort();
  }
}

/** A directory over one snapshot of rows: Part A's loader installs one per load; tests build them from fixtures.
 * Throws when the rows break the schema's rules, so a bad snapshot is never installed. */
export function chatDirectory(snapshot:ChatSnapshot,options:{onMiss?:(id:string)=>void}={}):ChatDirectory {
  return new SnapshotDirectory(snapshot,options.onMiss);
}

/** What the store's loader does when told to: reload after a newer guard epoch, or after a miss when the directory's
 * revision has moved (at most every few seconds). Installed by Part A in the app and the security service. `current`
 * resolves once the loader has looked again, reloading first when rows were added or the guard epoch moved: a caller
 * that can wait (a pass whose topic was recorded a moment ago by another process) asks it before refusing. */
export interface ChatLoader {epoch(epoch:number):void;miss():void;current?():Promise<unknown>}
let installed:ChatDirectory=chatDirectory({chats:[],ids:[],owner_chat:null});
let loader:ChatLoader|null=null;
/** The process's chat directory. Before anything is installed it knows no chat, so everything fails closed. */
export const chats=():ChatDirectory=>installed;
const isDirectory=(value:ChatDirectory|ChatSnapshot):value is ChatDirectory=>typeof (value as ChatDirectory).get==='function';
/** Installs a new snapshot for the whole process; a snapshot's misses ask the loader to look again. */
export function installChats(source:ChatDirectory|ChatSnapshot):ChatDirectory {
  installed=isDirectory(source)?source:chatDirectory(source,{onMiss:refreshChatsOnMiss});return installed;
}
export function setChatLoader(next:ChatLoader|null):void {loader=next;}
/** Called wherever a guard epoch is read: a newer one than the snapshot's makes the loader reload. */
export function refreshChatsOnEpoch(epoch:number):void {if(Number.isSafeInteger(epoch)&&epoch>installed.epoch)loader?.epoch(epoch);}
/** Called on a lookup miss: the loader reloads if the directory revision moved. */
export function refreshChatsOnMiss():void {loader?.miss();}
/** After a lookup miss a caller can wait for: resolves once the loader has looked again, true when it installed another
 * directory (so the lookup is worth trying once more). Without a loader, or one that cannot be waited for, false. */
export async function chatsAfterMiss():Promise<boolean> {
  const before=installed;
  if(!loader?.current)return false;
  await loader.current();return installed!==before;
}
/** Tests only: installs `source` with no loader and returns the function that puts the previous directory back. */
export function installChatsForTest(source:ChatDirectory|ChatSnapshot):()=>void {
  const previous=installed,previousLoader=loader;
  loader=null;installed=isDirectory(source)?source:chatDirectory(source);
  return ()=>{installed=previous;loader=previousLoader;};
}

/** A directory's answer for one /v1/conversations item (Part A fills the item, the dashboard reads it). */
export function conversationFields(directory:ChatDirectory,id:string):ConversationChatFields {
  const chat=directory.get(id);
  if(!chat)return {kind:'unknown',parent_space:null,topic_key:null,app_ids:[],is_forum:null,state:null,owner:false};
  const base=chat.kind==='topic'?directory.get(chat.parent_id)!:chat;
  return {kind:chat.kind,parent_space:chat.parent_id,topic_key:chat.topic_key,app_ids:base.app_ids.map(label=>({...label})),
    is_forum:base.is_forum,state:base.state,owner:chat.owner};
}
/** GET /internal/chats from a directory: every served chat with its topics, and the owner's private chat. */
export function servedChats(directory:ChatDirectory,ownerAccount:{app:ChatApp;external:string}|null):ServedChats {
  const owner=directory.ownerChat();
  return {epoch:directory.epoch,owner_chat:owner,owner_account:ownerAccount?{app:ownerAccount.app,external:ownerAccount.external}:null,
    chats:directory.all().filter(chat=>directory.served(chat.id)||chat.id===owner||chat.parent_id!==null&&chat.parent_id===owner)
      .map(chat=>({id:chat.id,app:chat.app,kind:chat.kind,parent_id:chat.parent_id,topic_key:chat.topic_key,state:chat.state,
        app_ids:chat.app_ids.map(label=>({external:label.external,state:label.state}))}))};
}
