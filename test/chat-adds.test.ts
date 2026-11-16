import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chatShortId} from '../src/chats.js';
import {approvalLines,chatAddLines,chatAddTexts,promptKeys,promptProblem} from '../src/prompts.js';
import {cardRows,chatAddButton,chatAddData,groupName,noteLine,retryMinutes} from '../src/stores/chat-adds.js';

const EVENT='ab'.repeat(32);

test('the add card\'s buttons carry the choice and the add\'s first 32 hex, and only those match',()=>{
  for(const choice of ['0','1','2','x','o'] as const) {
    const data=chatAddData(choice,EVENT);
    assert.equal(data,'ng'+choice+EVENT.slice(0,32));assert.ok(new TextEncoder().encode(data).length<=64,'Telegram allows 64 bytes');
    assert.deepEqual(chatAddButton.exec(data)?.slice(1),[choice,EVENT.slice(0,32)]);
  }
  for(const data of ['ng3'+EVENT.slice(0,32),'ngx'+EVENT.slice(0,31),'ngx'+EVENT.slice(0,33),'ngX'+EVENT.slice(0,32),'nr','np'+EVENT.slice(0,32),'ngx'+'G'.repeat(32)])
    assert.equal(chatAddButton.test(data),false,data);
});

test('a leave or a notice that did not go is tried again after 1, 2, 4… minutes, at most an hour',()=>{
  assert.deepEqual([0,1,2,3,4,5,6,7,20].map(retryMinutes),[1,2,4,8,16,32,60,60,60]);
});

test('only a person the owner allowed somewhere, or a hidden adder, is told of an add Nocheh left',()=>{
  assert.equal(noteLine({role:'other',member:true},'left'),'left_member');
  assert.equal(noteLine({role:'anonymous',member:false},'left'),'left_anonymous');
  assert.equal(noteLine({role:'other',member:true},'could_not_leave'),'could_not_leave');
  assert.equal(noteLine({role:'anonymous',member:false},'could_not_leave'),'could_not_leave');
  assert.equal(noteLine({role:'other',member:false},'left'),null,'a stranger gets the content-free record alone');
  assert.equal(noteLine({role:'other',member:false},'could_not_leave'),null);
  assert.equal(noteLine({role:'other',member:true},'superseded'),null,'nothing was left');
});

test('the card offers a row of moves, then No project and Turn off, each label within Telegram\'s 40 characters',()=>{
  const lines=chatAddLines(undefined);
  assert.deepEqual(cardRows(lines,EVENT,[{index:0,name:'Shop'},{index:2,name:null}]),[
    [{text:'Move to Shop',callback:'ng0'+EVENT.slice(0,32)},{text:'Move to a project',callback:'ng2'+EVENT.slice(0,32)}],
    [{text:'No project',callback:'ngx'+EVENT.slice(0,32)},{text:'Turn off',callback:'ngo'+EVENT.slice(0,32)}]],'an offered project gone since keeps the others\' places');
  assert.deepEqual(cardRows(lines,EVENT,[]),[[{text:'No project',callback:'ngx'+EVENT.slice(0,32)},{text:'Turn off',callback:'ngo'+EVENT.slice(0,32)}]]);
  const long=cardRows(chatAddLines('move: Move this group over to {project}\nturn_off: '+'🔕'.repeat(50)),EVENT,[{index:1,name:'A very long project name indeed'}]);
  assert.ok(long.flat().every(button=>Array.from(button.text).length<=40));
  assert.equal(Array.from(long[1]![1]!.text).length,40,'cut by characters, never inside one');
});

test('a group on a notice is its title quoted, with its short id; the texts are the owner\'s to edit',()=>{
  const words=approvalLines(undefined),chat='c'.repeat(64);
  assert.equal(groupName(words,chat,'Bakery'),`\u2068“Bakery”\u2069 (…${chatShortId(chat)})`);
  assert.equal(groupName(words,chat,'Fake” (…0000) and “Other'),`\u2068“Fake' [...0000] and 'Other”\u2069 (…${chatShortId(chat)})`,
    'a name cannot close the quotes code adds, nor draw a short id');
  assert.equal(groupName(words,chat,null),`a Telegram group (…${chatShortId(chat)})`);
  assert.equal(groupName({name_id:'{name} [{id}]',unnamed_group:'a group'},chat,'\u200b'),`a group [${chatShortId(chat)}]`);
  assert.ok((promptKeys as readonly string[]).includes('telegram.chat_adds'));
  assert.equal(promptProblem('telegram.chat_adds',chatAddTexts),null);
  const lines=chatAddLines('removed: Gone from {group}.');
  assert.equal(lines.removed,'Gone from {group}.');assert.equal(lines.card,chatAddLines(undefined).card,'a line the owner did not write keeps its default');
  assert.equal(chatAddLines(undefined).only_owner,'Only the owner can do this.');
});
