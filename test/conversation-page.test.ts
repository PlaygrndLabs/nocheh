import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cursor,pageDate,pageEntry,pageItem,PAGE_TEXT} from '../src/conversation-page.js';

const chat={id:-100,type:'supergroup'},at=new Date('2026-10-01T09:00:00Z');

test('a conversation page keeps messages, edits, reactions and replies, and leaves out button presses and member changes',()=>{
  assert.equal(pageEntry('telegram_update',{message:{message_id:1}}),'message');
  assert.equal(pageEntry('telegram_update',{edited_message:{message_id:1}}),'edit');
  assert.equal(pageEntry('telegram_update',{message_reaction:{message_id:1}}),'reaction');
  assert.equal(pageEntry('telegram_update',{callback_query:{id:'1'}}),null);
  assert.equal(pageEntry('telegram_update',{my_chat_member:{}}),null);
  assert.equal(pageEntry('telegram_delivered_message',{message:{message_id:2}}),'assistant');
  assert.equal(pageEntry('telegram_desktop_message',{message:{id:3}}),'message');
  assert.equal(pageEntry('telegram_desktop_service',{message:{id:4,action:'pin_message'}}),'service');
  assert.equal(pageEntry('import_manifest',{}),null);
});

test('a page item names the sender, the replied message, the topic and the reactions an export carries',()=>{
  const id='a'.repeat(64);
  const live=pageItem({id,kind:'telegram_update',at,text:'Water the plants',payload:{message:{message_id:12,chat,is_topic_message:true,message_thread_id:7,
    from:{id:5,first_name:'Sam',last_name:'Lee'},reply_to_message:{message_id:10,chat,text:'never shown'}}}});
  assert.deepEqual(live,{source:'nocheh:event:'+id,at:at.toISOString(),type:'message',message_id:'12',reply_to:'10',topic:'7',from:'Sam Lee',text:'Water the plants'});
  const exported=pageItem({id,kind:'telegram_desktop_message',at,text:'Done',payload:{topic_id:7,message:{id:13,from:'Sam',from_id:'user5',reply_to_message_id:12,
    photo:'photos/a.jpg',reactions:[{type:'emoji',emoji:'✅',count:2,recent:[{from:'Ana'},{from:'Sam'}]},{type:'custom_emoji',count:1}]}},
    files:[{kind:'extracted_text',text:'x'.repeat(1200)}]});
  assert.deepEqual(exported.reactions,[{reaction:'✅',count:2,by:['Ana','Sam']},{reaction:'custom',count:1}]);
  assert.deepEqual([exported.message_id,exported.reply_to,exported.topic,exported.from,exported.content],['13','12','7','Sam',['photo']]);
  assert.equal(exported.files![0]!.text.length,1000);assert.equal(exported.files![0]!.truncated,true);
  const reaction=pageItem({id,kind:'telegram_update',at,text:'',payload:{message_reaction:{chat,message_id:12,user:{id:6,first_name:'Ana'},
    old_reaction:[],new_reaction:[{type:'emoji',emoji:'✅'}]}}});
  assert.deepEqual(reaction.reaction,{change:'Added ✅',by:'Ana',message_id:'12'});assert.equal(reaction.from,undefined);
  const reply=pageItem({id,kind:'telegram_delivered_message',at,text:'y'.repeat(PAGE_TEXT+1),payload:{message:{message_id:14,chat,from:{id:9,is_bot:true}}}});
  assert.equal(reply.type,'assistant');assert.equal(reply.from,undefined);assert.equal(reply.text!.length,PAGE_TEXT);assert.equal(reply.truncated,true);
});

test('a page boundary and a date range are checked before any read',()=>{
  assert.equal(cursor(''),null);
  assert.deepEqual(cursor('1696150800000000-'+'b'.repeat(64)),{micros:'1696150800000000',id:'b'.repeat(64)});
  for(const bad of ['1-xyz','abc-'+'b'.repeat(64),'1'.repeat(19)+'-'+'b'.repeat(64)])assert.throws(()=>cursor(bad),{code:'invalid_cursor'});
  assert.equal(pageDate('2026-10-01')!.toISOString(),'2026-10-01T00:00:00.000Z');
  assert.equal(pageDate('2026-10-01',true)!.toISOString(),'2026-10-02T00:00:00.000Z','a day as the end includes that day');
  assert.equal(pageDate('2026-10-01T10:30:00+03:30')!.toISOString(),'2026-10-01T07:00:00.000Z');
  for(const bad of ['yesterday','2026-13-01','2026-10-01T10:30'])assert.throws(()=>pageDate(bad),{code:'invalid_date'});
});
