import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telegramUpdateFacts} from '../src/chats-telegram-updates.js';

/*
 * What a my_chat_member update says about Nocheh itself in a group (ADR-0253): whether it was in the chat before and
 * after, and who changed that. The chat records store decides what it means (src/stores/chats.ts adopt).
 */
const GROUP='-1001234567890',BOT='5000000001',OWNER='111',ALICE='222';
const update=(from:Record<string,unknown>|undefined,before:Record<string,unknown>,after:Record<string,unknown>,extra:Record<string,unknown>={})=>({update_id:7,
  my_chat_member:{chat:{id:Number(GROUP),type:'supergroup',title:'Bakery'},...from?{from}:{},date:1,
    old_chat_member:{user:{id:Number(BOT),is_bot:true,first_name:'Nocheh'},...before},new_chat_member:{user:{id:Number(BOT),is_bot:true,first_name:'Nocheh'},...after},...extra}});
const left={status:'left'},member={status:'member'};

test('an add names who added Nocheh, and that person is an account the update names',()=>{
  const facts=telegramUpdateFacts(update({id:Number(OWNER),first_name:'Owner'},left,member),GROUP,BOT);
  assert.deepEqual(facts.bot_status,{was_in:false,now_in:true,by:{external:OWNER,bot:false,display_name:'Owner',username:null},anonymous:false,self:false});
  assert.deepEqual(facts.people.map(person=>person.external),[OWNER]);
  assert.deepEqual(facts.memberships,[],'Nocheh itself is never a member');
  const other=telegramUpdateFacts(update({id:Number(ALICE),first_name:'Alice',username:'@alice'},{status:'kicked'},{status:'administrator'}),GROUP,BOT);
  assert.deepEqual([other.bot_status?.was_in,other.bot_status?.now_in,other.bot_status?.by?.external,other.bot_status?.by?.username],[false,true,ALICE,'alice']);
});

test('an anonymous admin, a channel or no sender hides who added Nocheh',()=>{
  for(const from of [{id:1087968824,is_bot:true,first_name:'Group'},{id:136817688,is_bot:true,first_name:'Channel'},undefined]) {
    const facts=telegramUpdateFacts(update(from,left,member),GROUP,BOT);
    assert.deepEqual(facts.bot_status,{was_in:false,now_in:true,by:null,anonymous:true,self:false},JSON.stringify(from));
    assert.deepEqual(facts.people,[],'nobody is named');
  }
});

test('Nocheh leaving on its own is self; anyone else removing it is not',()=>{
  assert.deepEqual(telegramUpdateFacts(update({id:Number(BOT),is_bot:true,first_name:'Nocheh'},member,left),GROUP,BOT).bot_status,
    {was_in:true,now_in:false,by:{external:BOT,bot:true,display_name:'Nocheh',username:null},anonymous:false,self:true});
  const kicked=telegramUpdateFacts(update({id:Number(ALICE),first_name:'Alice'},{status:'administrator'},{status:'kicked'}),GROUP,BOT).bot_status;
  assert.deepEqual([kicked?.was_in,kicked?.now_in,kicked?.self,kicked?.by?.external],[true,false,false,ALICE]);
  // Without the receiving bot's id nothing is self.
  assert.equal(telegramUpdateFacts(update({id:Number(BOT),is_bot:true},member,left),GROUP).bot_status?.self,false);
});

test('a restricted Nocheh is in only while Telegram says it is a member; promotions keep it in',()=>{
  const status=(before:Record<string,unknown>,after:Record<string,unknown>)=>{const value=telegramUpdateFacts(update({id:Number(OWNER)},before,after),GROUP,BOT).bot_status;return value&&[value.was_in,value.now_in];};
  assert.deepEqual(status(member,{status:'restricted',is_member:true}),[true,true]);
  assert.deepEqual(status(member,{status:'restricted',is_member:false}),[true,false]);
  assert.deepEqual(status(member,{status:'administrator'}),[true,true]);
  assert.deepEqual(status({status:'creator'},member),[true,true]);
});

test('no bot status for another bot, an unknown status, another chat or a message',()=>{
  const other={user:{id:5000000002,is_bot:true}};
  assert.equal(telegramUpdateFacts(update({id:Number(OWNER)},{...left,...other},{...member,...other}),GROUP,BOT).bot_status,null,'a my_chat_member about another bot');
  assert.equal(telegramUpdateFacts(update({id:Number(OWNER)},{status:'unknown'},member),GROUP,BOT).bot_status,null);
  assert.equal(telegramUpdateFacts(update({id:Number(OWNER)},left,member),'-1001234567891',BOT).bot_status,null,'an update about another chat');
  const message={update_id:8,message:{message_id:1,date:1,chat:{id:Number(GROUP),type:'supergroup',title:'Bakery'},from:{id:Number(OWNER)},
    new_chat_members:[{id:Number(BOT),is_bot:true}]}};
  assert.equal(telegramUpdateFacts(message,GROUP,BOT).bot_status,null,'a service message is not a bot status');
  // A private chat's block and unblock carry one too; the chat records ignore them.
  const blocked=telegramUpdateFacts({update_id:9,my_chat_member:{chat:{id:Number(ALICE),type:'private',first_name:'Alice'},from:{id:Number(ALICE)},date:1,
    old_chat_member:{status:'member',user:{id:Number(BOT),is_bot:true}},new_chat_member:{status:'kicked',user:{id:Number(BOT),is_bot:true}}}},ALICE,BOT);
  assert.equal(blocked.chat?.kind,'private');assert.deepEqual([blocked.bot_status?.was_in,blocked.bot_status?.now_in],[true,false]);
});
