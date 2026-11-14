// The chat directory a store test gets when it installs none (ADR-0250). Synthetic values only.
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {chatDirectory,chats,installChatsForTest,type Chat,type ChatAddress,type ChatApp,type ChatDirectory,type ChatKind} from '../src/chats.js';
import {legacyChat} from '../src/chats-telegram.js';
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
