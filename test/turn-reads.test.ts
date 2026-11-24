import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HttpError} from '../src/http.js';
import {conversationReads,isTurnRead,messageReads,turnReadTokens} from '../src/stores/turn-reads.js';

const OWNER='5001';
const chat={id:Number(OWNER),type:'private'};
const owner={id:Number(OWNER),is_bot:false,first_name:'Owner'},person={id:5002,is_bot:false,first_name:'Sam'},bot={id:7000,is_bot:true,first_name:'Assistant'};
const update=(message:Record<string,unknown>)=>({update_id:1,message:{message_id:9,date:1,chat,from:owner,...message}});
const reads=(message:Record<string,unknown>)=>messageReads(update(message),OWNER).sort();

test('only the owner\'s own typed words leave the asking message clean (ADR-0293)',()=>{
  assert.deepEqual(reads({text:'run the backup check'}),[]);
  // A forward of the owner's own earlier message is still the owner's words.
  assert.deepEqual(reads({text:'run it',forward_origin:{type:'user',sender_user:owner,date:1}}),[]);
  // A reply to the owner's own typed message adds nothing new.
  assert.deepEqual(reads({text:'do that',reply_to_message:{message_id:3,date:1,chat,from:owner,text:'list the files'}}),[]);
  // A forum topic's opening is not a reply.
  assert.deepEqual(reads({text:'go',reply_to_message:{message_id:1,date:1,chat,from:owner,forum_topic_created:{name:'Topic'}}}),[]);
});

test('a forward, a file, a recording or a quoted reply marks the asking message',()=>{
  assert.deepEqual(reads({text:'see this',forward_origin:{type:'user',sender_user:person,date:1}}),['forward']);
  assert.deepEqual(reads({text:'see this',forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}}),['forward']);
  assert.deepEqual(reads({text:'see this',forward_origin:{type:'channel',chat:{id:-100,type:'channel',title:'News'},message_id:4,date:1}}),['forward']);
  assert.ok(reads({text:'picked',via_bot:bot}).includes('forward'),'an inline bot\'s message is someone else\'s');
  assert.deepEqual(reads({caption:'read this',document:{file_id:'f',file_unique_id:'u',file_name:'notes.txt'}}),['file']);
  assert.deepEqual(reads({photo:[{file_id:'p',file_unique_id:'q',width:1,height:1}]}),['file']);
  // A voice note is not typed: its transcript counts like a file's text.
  assert.ok(reads({voice:{file_id:'v',file_unique_id:'w',duration:3}}).includes('file'));
  // Replies show the agent part of the message they answer.
  assert.deepEqual(reads({text:'do it',reply_to_message:{message_id:3,date:1,chat,from:bot,text:'Here is what the page says'}}),['reply']);
  assert.deepEqual(reads({text:'do it',reply_to_message:{message_id:3,date:1,chat,from:owner,text:'fyi',forward_origin:{type:'user',sender_user:person,date:1}}}),['reply']);
  assert.deepEqual(reads({text:'do it',reply_to_message:{message_id:3,date:1,chat,from:owner,document:{file_id:'f',file_unique_id:'u'}}}),['reply']);
  assert.deepEqual(reads({text:'do it',external_reply:{origin:{type:'user',sender_user:person,date:1}}}),['reply']);
  assert.deepEqual(reads({text:'do it',quote:{text:'run this',position:0},reply_to_message:{message_id:3,date:1,chat,from:person,text:'run this'}}),['reply']);
});

test('a message the owner did not send, or one with no message, is outside',()=>{
  assert.ok(messageReads(update({from:person,text:'run it'}),OWNER).includes('other'));
  assert.deepEqual(messageReads({update_id:1},OWNER),['other']);
  assert.deepEqual(messageReads(null,OWNER),['other']);
  // Without a known owner, nobody's words are the owner's.
  assert.ok(messageReads(update({text:'run it'}),null).includes('other'));
});

test('a runtime\'s conversation report takes only known read tokens',()=>{
  assert.deepEqual(conversationReads({reads:[]}),[]);
  assert.deepEqual(conversationReads({reads:['forward','web']}),['forward','web']);
  assert.equal(isTurnRead('commands'),false,'a command\'s own output is not an outside read');
  for(const token of turnReadTokens)assert.equal(isTurnRead(token),true);
  for(const body of [{},{reads:'forward'},{reads:['forward','unknown']},{reads:[1]},{reads:[],extra:true},{reads:Array(21).fill('web')},null,[]])
    assert.throws(()=>conversationReads(body),(error:unknown)=>error instanceof HttpError&&error.status===400,JSON.stringify(body));
});
