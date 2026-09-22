import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceNodeLabel,graphGroupLabel,graphUserLabel} from '../src/graph-labels.js';

test('textless evidence labels expose kind and a stable identity',()=>{
  const first='2a36c7ad35b8cffcc4225dcdb1ffd50011d978478e0037da147a14f35e3f5c3f';
  const second='57d1ffd76c4626ba1a278fedfbe58069fc077f4ea011cce2dd63e725481fdef3';
  assert.equal(evidenceNodeLabel(null,'outbound_result',first),'Outbound result · 2a36c7ad');
  assert.equal(evidenceNodeLabel('', 'outbound_result',second),'Outbound result · 57d1ffd7');
  assert.notEqual(evidenceNodeLabel(null,'outbound_result',first),evidenceNodeLabel(null,'outbound_result',second));
  assert.equal(evidenceNodeLabel('Original text','telegram_update',first),'Original text');
});

test('Telegram graph labels prefer recorded usernames and chat names without changing identity',()=>{
  const update={message:{chat:{id:-10042,type:'supergroup',title:'Observatory team'},from:{id:123,username:'mira_sky',first_name:'Mira'},text:'Hello'}};
  assert.equal(graphUserLabel(update,'123'),'@mira_sky');
  assert.equal(graphGroupLabel(update,'-10042'),'Observatory team');
  assert.equal(graphUserLabel(update,'999'),undefined,'a name from another identity is never borrowed');
  assert.equal(graphGroupLabel(update,'-10043'),undefined,'a title from another conversation is never borrowed');
  assert.equal(graphUserLabel({message:{from:{id:123,first_name:'Mira',last_name:'Chen'}}},'123'),'Mira Chen');
  assert.equal(graphGroupLabel({message:{chat:{id:123,type:'private',username:'mira'}}},'123'),'Private chat · @mira');
  assert.equal(graphUserLabel(Buffer.from('{not json'),'123'),undefined);
});
