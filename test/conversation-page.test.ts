import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOX_RECORD_TEXT,cursor,pageDate,pageEntry,pageItem,PAGE_TEXT} from '../src/conversation-page.js';

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
  const exportedInput={id,kind:'telegram_desktop_message',at,text:'Done',payload:{topic_id:7,message:{id:13,from:'Sam',from_id:'user5',reply_to_message_id:12,
    photo:'photos/a.jpg',reactions:[{type:'emoji',emoji:'✅',count:2,recent:[{from:'Ana'},{from:'Sam'}]},{type:'custom_emoji',count:1}]}},
    files:[{kind:'extracted_text',text:'x'.repeat(1200)}]},exported=pageItem(exportedInput);
  assert.deepEqual(exported.reactions,[{reaction:'✅',count:2,by:['Ana','Sam']},{reaction:'custom',count:1}]);
  assert.deepEqual(pageItem(exportedInput,true).reactions,exported.reactions,'a sealed box copy keeps the reactions an export carries');
  assert.deepEqual([exported.message_id,exported.reply_to,exported.topic,exported.from,exported.content],['13','12','7','Sam',['photo']]);
  assert.equal(exported.files![0]!.text.length,1000);assert.equal(exported.files![0]!.truncated,true);
  const reaction=pageItem({id,kind:'telegram_update',at,text:'',payload:{message_reaction:{chat,message_id:12,user:{id:6,first_name:'Ana'},
    old_reaction:[],new_reaction:[{type:'emoji',emoji:'✅'}]}}});
  assert.deepEqual(reaction.reaction,{change:'Added ✅',by:'Ana',message_id:'12'});assert.equal(reaction.from,undefined);
  const reply=pageItem({id,kind:'telegram_delivered_message',at,text:'y'.repeat(PAGE_TEXT+1),payload:{message:{message_id:14,chat,from:{id:9,is_bot:true}}}});
  assert.equal(reply.type,'assistant');assert.equal(reply.from,undefined);assert.equal(reply.text!.length,PAGE_TEXT);assert.equal(reply.truncated,true);
  // A sealed job box's copy keeps every text whole.
  const whole=pageItem({id,kind:'telegram_update',at,text:'Alice: '+'z'.repeat(5000),payload:{message:{message_id:15,chat,from:{id:5,first_name:'Alice'}}},
    files:[{kind:'extracted_text',text:'x'.repeat(1200)}]},true);
  assert.equal(whole.text!.length,5007);assert.equal(whole.truncated,undefined);assert.equal(whole.files![0]!.text.length,1200);assert.equal(whole.files![0]!.truncated,undefined);
});

test('a sealed box record keeps every file and cuts its texts only past one budget, with a note, so its page stays far within 8 MiB',()=>{
  const id='c'.repeat(64),payload={message:{message_id:16,chat,from:{id:5,first_name:'Sam'}}},chars=(item:any)=>[item.text??'',...(item.files??[]).map((file:any)=>file.text)].join('').length;
  const note=/\n\[… ([\d,]+) more characters cut from this copy\]$/;
  // Eight files of 100,000 characters after a text of as many: every file is there, the first that passes the budget ends with the note, later ones are empty.
  const files=Array.from({length:8},(_,i)=>({kind:'extracted_text',text:String(i).repeat(100000)}));
  const many=pageItem({id,kind:'telegram_update',at,text:'t'.repeat(100000),payload,files},true);
  assert.equal(many.files!.length,8);assert.equal(many.text,'t'.repeat(100000));assert.equal(many.truncated,undefined);
  assert.deepEqual(many.files!.slice(0,4).map(file=>[file.text.length,file.truncated]),[[100000,undefined],[100000,undefined],[100000,undefined],[100000,undefined]]);
  const cutFile=many.files![4]!,match=cutFile.text.match(note)!;
  assert.equal(cutFile.truncated,true);assert.equal(Number(match[1]!.replaceAll(',','')),900000-500000-match.index!);
  assert.deepEqual(many.files!.slice(5).map(file=>[file.text,file.truncated]),[['',true],['',true],['',true]]);
  assert.equal(chars(many),BOX_RECORD_TEXT,'the note counts toward the budget');
  // A text that JSON writes six times as long: the record stays within 600,000 characters and its JSON far within 8 MiB.
  const escaped=pageItem({id,kind:'telegram_update',at,text:'\u0001'.repeat(5000000),payload,files:[{kind:'transcript',text:'v'.repeat(10)}]},true);
  assert.ok(chars(escaped)<=BOX_RECORD_TEXT&&escaped.text!.match(note));assert.deepEqual(escaped.files,[{kind:'transcript',text:'',truncated:true}]);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped))<4*1024*1024);
  // A cut never splits a character that takes two.
  const wide=pageItem({id,kind:'telegram_update',at,text:'😀'.repeat(400000),payload},true);
  assert.ok(chars(wide)<=BOX_RECORD_TEXT);assert.doesNotMatch(wide.text!,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // Within the budget nothing is cut, and an ordinary page still keeps five files.
  assert.equal(chars(pageItem({id,kind:'telegram_update',at,text:'w'.repeat(BOX_RECORD_TEXT-10),payload,files:[{kind:'transcript',text:'v'.repeat(10)}]},true)),BOX_RECORD_TEXT);
  assert.equal(pageItem({id,kind:'telegram_update',at,text:'x',payload,files}).files!.length,5);
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
