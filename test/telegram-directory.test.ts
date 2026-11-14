import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {chatIdFor} from '../src/chats.js';
import {telegramDirectory} from '../src/stores/telegram-directory.js';

test('owner Telegram directory gives recorded names, ids and membership without message content',async()=>{
  // An old-shaped group keeps its Telegram id as its Nocheh id; a newer one has a digest id.
  const old='-1001000000001',newer=chatIdFor('telegram','-1002000000001');
  const sql:string[]=[];
  const control={query:async(text:string,params:unknown[]=[])=>{
    sql.push(text);
    if(sql.length===1)return {rows:[{id:old,title:'Aurora planning',username:null,external_id:old},{id:newer,title:null,username:'p2group',external_id:'-1002000000001'}]};
    assert.deepEqual(params,[[old,newer]]);
    return {rows:[{chat_id:old,state:'in',external_id:'73',display_name:'Mira Chen',username:'mira'},
      {chat_id:old,state:'left',external_id:'91',display_name:'Nia',username:null},
      {chat_id:old,state:'in',external_id:'123',display_name:'Owner',username:null},
      {chat_id:newer,state:'in',external_id:'456',display_name:null,username:'bob'}]};
  }} as unknown as pg.Pool;
  const result=await telegramDirectory(control,{admin:true,scope:null});
  assert.equal(sql.length,2);
  assert.match(sql[1]!,/a\.kind='human'/,'bots, anonymous admins and chats posting as themselves are never people');
  assert.ok(sql.every(text=>!/events|payload|text/.test(text.replace(/chat_|::text/g,''))),'no archive or message text is read');
  assert.deepEqual(result,{groups:[
    {id:old,external:old,name:'Aurora planning',users:[
      {id:'73',name:'Mira Chen',username:'@mira',state:'in'},
      {id:'91',name:'Nia',username:null,state:'left'},
      {id:'123',name:'Owner',username:null,state:'in'}]},
    {id:newer,external:'-1002000000001',name:'@p2group',users:[{id:'456',name:null,username:'@bob',state:'in'}]},
  ],truncated:false});
});

test('scoped readers cannot list Telegram identities',async()=>{
  let queried=false;
  const control={query:async()=>{queried=true;return {rows:[]};}} as unknown as pg.Pool;
  await assert.rejects(telegramDirectory(control,{admin:false,scope:'-10042'}),{status:403,code:'owner_required'});
  assert.equal(queried,false);
});
