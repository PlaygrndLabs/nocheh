import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {chatIdFor} from '../src/chats.js';
import {telegramDirectory} from '../src/stores/telegram-directory.js';

test('owner Telegram directory gives recorded names, ids and membership, and who the group\'s own messages show, without message content',async()=>{
  // An old-shaped group keeps its Telegram id as its Nocheh id; a newer one has a digest id, and Telegram upgraded it.
  const old='-1001000000001',newerTg='-1002000000001',newerOld='-4000000000001',newer=chatIdFor('telegram',newerOld);
  const sql:string[]=[],read:string[]=[];
  const control={query:async(text:string,params:unknown[]=[])=>{
    sql.push(text);
    if(sql.length===1)return {rows:[{id:old,title:'Aurora planning',username:null,external_id:old},{id:newer,title:null,username:'p2group',external_id:newerTg}]};
    assert.deepEqual(params,[[old,newer]]);
    if(sql.length===2)return {rows:[{chat_id:old,state:'in',external_id:'73',display_name:'Mira Chen',username:'mira'},
      {chat_id:old,state:'left',external_id:'91',display_name:'Nia',username:null},
      {chat_id:old,state:'left',external_id:'95',display_name:'Lee',username:null},
      {chat_id:old,state:'in',external_id:'77',display_name:'Kai',username:null,member:true},
      // A member carried from the lists before step 3 whom Telegram never showed: listed so their name can be asked for.
      {chat_id:old,state:null,external_id:'701',display_name:null,username:null,member:true},
      {chat_id:old,state:'in',external_id:'88',display_name:'Ari',username:null},
      {chat_id:old,state:'in',external_id:'123',display_name:'Owner',username:null},
      {chat_id:newer,state:'in',external_id:'456',display_name:null,username:'bob'}]};
    // Current first, then older ones, as the query orders them.
    assert.match(text,/ORDER BY i\.chat_id,i\.state='current' DESC/);
    return {rows:[{chat_id:old,external_id:old},{chat_id:newer,external_id:newerTg},{chat_id:newer,external_id:newerOld}]};
  }} as unknown as pg.Pool;
  // The archive by every Telegram id the groups have had: Mira, Nia and the owner wrote in the old group, Bob in the newer
  // one before Telegram upgraded it, and a join message names Ari (and a bot). Lee only left and Kai is only in a member update.
  const archive={query:async(text:string,params:unknown[]=[])=>{
    read.push(text);
    assert.deepEqual([...params[0] as string[]].sort(),[old,newerTg,newerOld].sort());
    if(read.length===1)return {rows:[{scope:old,external_id:'73'},{scope:old,external_id:'91'},{scope:old,external_id:'123'},{scope:newerOld,external_id:'456'}]};
    return {rows:[{scope:old,members:[{id:88,is_bot:false,first_name:'Ari'},{id:99,is_bot:true,first_name:'Bot'}]}]};
  }} as unknown as pg.Pool;
  const result=await telegramDirectory(control,{admin:true,scope:null},archive);
  assert.equal(sql.length,3);assert.equal(read.length,2);
  assert.match(sql[1]!,/a\.kind='human'/,'bots, anonymous admins and chats posting as themselves are never people');
  assert.match(sql[1]!,/FROM member_chats s JOIN chat_accounts a ON a\.member_id=s\.member_id/,'every member with a switch there is listed');
  assert.ok(sql.every(text=>!/events|payload|text/.test(text.replace(/chat_|::text/g,''))),'the chat records hold no message text');
  // Of a message, only which kind of update it is, and the people a join message names, are read.
  const parts=/convert_from\(e\.payload,'UTF8'\)::jsonb (?:\?\| ARRAY\['message','edited_message','channel_post','edited_channel_post'\]|#> '\{message,new_chat_members\}')/g;
  assert.match(read[0]!,/r\.kind='authored_by'/);
  for(const text of read)assert.equal([...text.matchAll(/payload/g)].length,[...text.matchAll(parts)].length,text);
  assert.deepEqual(result,{groups:[
    {id:old,external:old,telegram_ids:[old],name:'Aurora planning',users:[
      {id:'701',name:null,username:null,state:null,seen:false,member:true},
      {id:'88',name:'Ari',username:null,state:'in',seen:true,member:false},
      {id:'77',name:'Kai',username:null,state:'in',seen:false,member:true},
      {id:'95',name:'Lee',username:null,state:'left',seen:false,member:false},
      {id:'73',name:'Mira Chen',username:'@mira',state:'in',seen:true,member:false},
      {id:'91',name:'Nia',username:null,state:'left',seen:true,member:false},
      {id:'123',name:'Owner',username:null,state:'in',seen:true,member:false}]},
    // Named by its Nocheh id, with every Telegram id it has had, for asking Telegram about it (ADR-0252).
    {id:newer,external:newerTg,telegram_ids:[newerTg,newerOld],name:'@p2group',users:[{id:'456',name:null,username:'@bob',state:'in',seen:true,member:false}]},
  ],truncated:false});
  // Without the archive, everyone Telegram has a row for counts as seen, and the groups keep their Telegram ids.
  sql.length=0;
  const bare=await telegramDirectory(control,{admin:true,scope:null});
  assert.ok(bare.groups.every(group=>group.users.every(user=>user.seen===(user.state!==null))));
  assert.deepEqual(bare.groups.map(group=>group.telegram_ids),[[old],[newerTg,newerOld]]);
  assert.equal(sql.length,3);
});

test('scoped readers cannot list Telegram identities',async()=>{
  let queried=false;
  const control={query:async()=>{queried=true;return {rows:[]};}} as unknown as pg.Pool;
  await assert.rejects(telegramDirectory(control,{admin:false,scope:'-10042'}),{status:403,code:'owner_required'});
  assert.equal(queried,false);
});
