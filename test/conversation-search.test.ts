import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationMatches,OwnerSupervisionRepository,type ConversationDirectoryItem,type OwnerSupervisionDependencies} from '../src/stores/owner-supervision.js';
import {chatIdFor,chatShortId} from '../src/chats.js';

/*
 * The owner's chat search (GET /v1/conversations?q=, ADR-0252) finds a chat by its name or by any Telegram ID it has
 * had. A chat seen before step 2b keeps its stored value as its id, so its id holds its Telegram ID; one first seen
 * later has a digest id, which never does, so the search reads its app ids too. The dashboard's chat pickers, its list
 * past 100 chats and its name lookups all ask this search.
 */
const NG1=chatIdFor('telegram','-1002000000001'),NG1_TOPIC=chatIdFor('telegram','-1002000000001','5'),UPGRADED=chatIdFor('telegram','-4005');
const tg=(external:string,state:'current'|'old'='current')=>({app:'telegram' as const,external,state});
const item=(value:Partial<ConversationDirectoryItem>&{space_id:string}):ConversationDirectoryItem=>({name:null,kind:'group',parent_space:null,parent_name:null,
  observed_at:null,configured:false,topic_key:null,app_ids:[],is_forum:null,state:'active',owner:false,short_id:chatShortId(value.space_id),
  added_by:null,added_at:null,removed_event:false,...value});
const items=[
  item({space_id:'-1001000000001',name:'Aurora planning',app_ids:[tg('-1001000000001')]}),
  item({space_id:NG1,name:'Night sky club',app_ids:[tg('-1002000000001')]}),
  item({space_id:NG1_TOPIC,name:'Meteor watch',kind:'topic',parent_space:NG1,parent_name:'Night sky club',topic_key:'5',app_ids:[tg('-1002000000001')]}),
  item({space_id:UPGRADED,name:null,app_ids:[tg('-1003000000001'),tg('-4005','old')]}),
];
const owner={admin:true,scope:null};

test('a chat is found by its name, its group\'s name or any Telegram ID it has had',()=>{
  const found=(q:string)=>items.filter(row=>conversationMatches(row,q)).map(row=>row.space_id);
  assert.deepEqual(found(''),items.map(row=>row.space_id));
  assert.deepEqual(found('aurora'),['-1001000000001']);
  assert.deepEqual(found('-1002000000001'),[NG1,NG1_TOPIC],'a digest group by its Telegram ID, with its topic');
  assert.deepEqual(found('-1003000000001'),[UPGRADED],'an upgraded group by its new Telegram ID');
  assert.deepEqual(found('-4005'),[UPGRADED],'and by its earlier one');
  assert.deepEqual(found('night SKY'),[NG1,NG1_TOPIC]);
  assert.deepEqual(found(NG1),[NG1],'the Nocheh id still matches, as before');
  assert.deepEqual(found('-1009'),[]);
});

test('the conversations page searches the directory by Telegram ID',async()=>{
  const repository=new OwnerSupervisionRepository({} as OwnerSupervisionDependencies);
  // The directory itself is the chat records' (Part A); only the search over it is under test here.
  (repository as unknown as {directory:()=>Promise<ConversationDirectoryItem[]>}).directory=async()=>items;
  const page=await repository.conversations(owner,{q:'-1002000000001',limit:100});
  assert.deepEqual(page.items.map(row=>row.space_id),[NG1,NG1_TOPIC]);
  assert.equal(page.total,2);
  const hidden=await repository.conversations(owner,{q:'-1002000000001',limit:100},new Set([NG1]));
  assert.deepEqual(hidden.items,[],'a hidden chat stays hidden, its topics too');
  assert.deepEqual((await repository.conversations(owner,{q:'-1003000000001'})).items.map(row=>row.space_id),[UPGRADED]);
});
