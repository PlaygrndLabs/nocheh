import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {telegramDirectory} from '../src/stores/telegram-directory.js';

const payload=(value:unknown)=>Buffer.from(JSON.stringify(value));

test('owner Telegram directory gives observed names and IDs without message content',async()=>{
  const group='-10042',title='Aurora planning',owner='42',member='73',arrival='91';
  const original={message:{chat:{id:-10042,type:'supergroup',title},from:{id:73,first_name:'Mira',last_name:'Chen',username:'mira'},text:'PRIVATE_MESSAGE_MUST_NOT_LEAK'}};
  let queries=0;
  const archive={query:async()=>{
    queries++;
    if(queries===1)return {rows:[{scope:group,payload:payload(original)}]};
    if(queries===2)return {rows:[{scope:group,user_id:member,payload:payload(original)},
      {scope:group,user_id:owner,payload:payload({message:{from:{id:42,first_name:'Owner'}}})},
      {scope:group,user_id:'99',payload:payload({message:{from:{id:98,first_name:'Wrong'}}})}]};
    return {rows:[{scope:group,payload:payload({message:{new_chat_members:[{id:91,first_name:'Nia'},{id:92,is_bot:true,first_name:'Bot'}]}})}]};
  }} as unknown as pg.Pool;
  const result=await telegramDirectory(archive,{admin:true,scope:null});
  assert.equal(queries,3);
  assert.deepEqual(result,{groups:[{id:group,name:title,users:[
    {id:member,name:'Mira Chen',username:'@mira'},
    {id:arrival,name:'Nia',username:null},
    {id:owner,name:'Owner',username:null},
  ]}],truncated:false});
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MESSAGE_MUST_NOT_LEAK'));
});

test('scoped readers cannot list Telegram identities',async()=>{
  let queried=false;
  const archive={query:async()=>{queried=true;return {rows:[]};}} as unknown as pg.Pool;
  await assert.rejects(telegramDirectory(archive,{admin:false,scope:'-10042'}),{status:403,code:'owner_required'});
  assert.equal(queried,false);
});
