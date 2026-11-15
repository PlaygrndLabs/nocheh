// The chat directory a store test gets when it installs none (ADR-0251). Synthetic values only.
import type pg from 'pg';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {chatDirectory,chats,installChatsForTest,type Chat,type ChatAddress,type ChatApp,type ChatDirectory,type ChatKind} from '../src/chats.js';
import {legacyChat} from '../src/chats-telegram.js';
import {ensureConnection} from '../src/stores/chats.js';
import {legacyChats} from './fixture-groups.js';

type Policy=Pick<AssistantPolicy,'owner_id'|'owner_chat'|'group_ids'>;
const seededDirectories=new WeakSet<ChatDirectory>();

/**
 * Tests only: a chat directory as Part A's seeder leaves it for values stored before step 2b. Every old-shaped value
 * the directory is asked about becomes its chat the first time it is seen (a topic adds its parent), as the seeder
 * seeds every stored value and the intake every chat and topic it sees. Served as the policy serves now: its groups
 * (TELEGRAM_GROUP_IDS, the 2b-1 bridge) and its owner's private chat. Anything else (digests, 'owner', 'system')
 * stays unknown and fails closed. A test that needs the strict fixture families installs fixtureDirectory or
 * groupsPolicy instead; a test of an unknown old-shaped id installs a directory that does not hold it.
 */
export function seededDirectory(policy:()=>Policy):ChatDirectory {
  const seen=new Set<string>();let cached:{key:string;directory:ChatDirectory}|null=null;
  const inner=()=>{
    const current=policy(),owner=current.owner_chat===undefined?current.owner_id:current.owner_chat,groups=current.group_ids??[];
    const key=JSON.stringify([owner,groups,[...seen].sort()]);
    if(cached?.key!==key)cached={key,directory:chatDirectory(legacyChats([...groups,...seen],{owner,served:groups}))};
    return cached.directory;
  };
  const see=(...values:unknown[])=>{for(const value of values)if(typeof value==='string'&&legacyChat(value))seen.add(value);};
  const topicValue=(external:string,topic:string|number|null|undefined)=>topic===null||topic===undefined||topic===''?external:external+'/topic/'+topic;
  const directory:ChatDirectory={
    get epoch(){return 0;},get revision(){return 0;},
    all:():readonly Chat[]=>inner().all(),
    get:id=>{see(id);return inner().get(id);},
    kind:(id):ChatKind|null=>{see(id);return inner().kind(id);},
    isGroup:(id):id is string=>{see(id);return inner().isGroup(id);},
    isPrivate:id=>{see(id);return inner().isPrivate(id);},
    parentOf:id=>{see(id);return inner().parentOf(id);},
    groupOf:id=>{see(id);return inner().groupOf(id);},
    topicsOf:id=>{see(id);return inner().topicsOf(id);},
    topicOf:(parent,key)=>{see(parent);if(typeof parent==='string'&&key!==null&&key!==undefined)see(parent+'/topic/'+key);return inner().topicOf(parent,key);},
    ownerChat:()=>inner().ownerChat(),
    isOwner:id=>{see(id);return inner().isOwner(id);},
    served:id=>{see(id);return inner().served(id);},
    appIds:(id):ChatAddress|null=>{see(id);return inner().appIds(id);},
    resolve:(app:ChatApp,external:string,topic?:string|number|null)=>{if(app==='telegram')see(external,topicValue(external,topic));return inner().resolve(app,external,topic);},
    expand:ids=>{const list=[...ids];see(...list);return inner().expand(list);},
    rawScopes:(ids,app)=>{const list=[...ids];see(...list);return inner().rawScopes(list,app);},
  };
  seededDirectories.add(directory);
  return directory;
}

/** Tests only: installs a seeded directory for `policy` unless the test installed a directory of its own. A seeded one
 * left by an earlier test is replaced, so each set of services reads its own policy. */
export function seedChatsForTest(policy:()=>Policy):void {
  const installed=chats();
  if(installed.all().length&&!seededDirectories.has(installed))return;
  installChatsForTest(seededDirectory(policy));
}

type Names={title?:string|null;title_source?:'observed'|'refreshed'|'owner';is_forum?:boolean;username?:string|null;refreshed?:boolean};
/**
 * Tests only: the chats row a store test's directory names `id` by, with the name, public username and forum flag that
 * capture, an owner's refresh or the owner would have recorded there (ADR-0251). Readers of chat names (approval cards,
 * runtime profile labels, send destinations) read these rows, not the old Telegram tables. A topic value also gets its
 * group's row. `refreshed` marks the owner's refresh as answered, as Telegram's refresh does. Names decide nothing.
 */
export async function chatRowForTest(control:Pick<pg.Pool,'connect'>,id:string,names:Names={}):Promise<void> {
  const value=legacyChat(id);if(!value)throw Error('chatRowForTest takes an old-shaped chat value');
  const db=await control.connect();
  try {
    const connection=await ensureConnection(db);
    if(value.parent_id!==null)await db.query(`INSERT INTO chats(id,connection_id,kind,state) VALUES($1,$2,'group','off') ON CONFLICT DO NOTHING`,[value.parent_id,connection]);
    await db.query(`INSERT INTO chats(id,connection_id,kind,parent_id,topic_key,state) VALUES($1,$2,$3,$4,$5,'off') ON CONFLICT DO NOTHING`,
      [id,connection,value.kind,value.parent_id,value.topic_key]);
    await db.query(`UPDATE chats SET title=$2,title_source=CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,is_forum=$4,updated_at=now() WHERE id=$1`,
      [id,names.title??null,names.title_source??'refreshed',names.is_forum===true]);
    // A refresh keeps the name and username it answered apart from the ones later updates show.
    const refreshed=names.refreshed!==false;
    await db.query(`INSERT INTO chat_details(chat_id,username,refreshed_state,refreshed_title,refreshed_username,refreshed_at)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
      ON CONFLICT(chat_id) DO UPDATE SET username=excluded.username,refreshed_state=excluded.refreshed_state,refreshed_title=excluded.refreshed_title,
        refreshed_username=excluded.refreshed_username,refreshed_at=excluded.refreshed_at`,
      [id,names.username??null,refreshed?'available':null,refreshed?names.title??null:null,refreshed?names.username??null:null]);
  } finally{db.release();}
}
