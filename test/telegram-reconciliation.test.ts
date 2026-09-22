import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interruptedJournalDisposition} from '../src/stores/telegram-dispatch.js';

const event=(sequence:number,state:string,stage:string)=>({sequence,state,stage,at:1700000000000+sequence});

test('complete assistant-only journal proves an interrupted Telegram turn is safe to retry',()=>{
  assert.equal(interruptedJournalDisposition({events:[
    event(1,'queued','admission'),event(2,'running','assistant'),event(3,'ambiguous','assistant'),
  ]}),'pre_delivery');
});

test('delivery progress, incomplete history, and malformed journals never authorize retry',()=>{
  assert.equal(interruptedJournalDisposition({events:[
    event(1,'queued','admission'),event(2,'running','assistant'),event(3,'running','delivery'),event(4,'ambiguous','assistant'),
  ]}),'uncertain');
  assert.equal(interruptedJournalDisposition({events:[event(2,'running','assistant'),event(3,'ambiguous','assistant')]}),'invalid');
  assert.equal(interruptedJournalDisposition({events:[
    event(1,'queued','admission'),event(2,'running','assistant'),{...event(3,'ambiguous','assistant'),at:'bad'},
  ]}),'invalid');
});
