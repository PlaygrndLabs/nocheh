import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveredKinds,sendClassOf,sendClasses,unlearnedSendClasses} from '../src/send-classes.js';

// The Telegram adapter stamps the same classes (services/telegram/sends.py); the check that both lists match arrives
// with the adapter's list.
test('Nocheh\'s sends carry one of eleven neutral classes, and only cards, card updates, refusals, notices and reminders are not learned',()=>{
  assert.deepEqual([...sendClasses],['reply','follow_up','private_answer','job_report','scheduled_run','approved_post',
    'card','card_update','refusal','notice','reminder']);
  assert.deepEqual([...unlearnedSendClasses].sort(),['card','card_update','notice','refusal','reminder']);
  assert.ok([...unlearnedSendClasses].every(name=>sendClasses.includes(name)));
  for(const name of sendClasses)assert.equal(sendClassOf(name),name);
  for(const value of ['other','Reply',' reply','',null,undefined,1,{},['reply'],'constructor','__proto__'])assert.equal(sendClassOf(value),null,String(value));
  assert.deepEqual([...deliveredKinds].sort(),['browser_delivered_message','telegram_delivered_message']);
});
