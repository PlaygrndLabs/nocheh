import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveredKinds,sendClassOf,sendClasses,unconsentableSendClasses,unlearnedSendClasses} from '../src/send-classes.js';
import {servicesFile} from './services-file.js';

test('Nocheh\'s sends carry one of twelve neutral classes, and only cards, card updates, refusals, notices, reminders and member reads are not learned',()=>{
  assert.deepEqual([...sendClasses],['reply','follow_up','private_answer','job_report','scheduled_run','approved_post',
    'card','card_update','refusal','notice','reminder','member_read']);
  assert.deepEqual([...unlearnedSendClasses].sort(),['card','card_update','member_read','notice','refusal','reminder']);
  assert.ok([...unlearnedSendClasses].every(name=>sendClasses.includes(name)));
  // An answer about a member's private chat (step 4b) is never learned, and no consent makes it learnable.
  assert.deepEqual([...unconsentableSendClasses],['member_read']);
  assert.ok([...unconsentableSendClasses].every(name=>unlearnedSendClasses.has(name)));
  for(const name of sendClasses)assert.equal(sendClassOf(name),name);
  for(const value of ['other','Reply',' reply','',null,undefined,1,{},['reply'],'constructor','__proto__'])assert.equal(sendClassOf(value),null,String(value));
  assert.deepEqual([...deliveredKinds].sort(),['browser_delivered_message','telegram_delivered_message']);
});

test('the Telegram adapter stamps the same classes, and every route default is one of them',()=>{
  // The stores image has no services folder; its runner mounts one under PYTHONPATH instead.
  const sends=readFileSync(servicesFile('services/telegram/sends.py'),'utf8');
  const quoted=(text:string)=>[...text.matchAll(/'([a-z_:-]+)'/g)].map(match=>match[1]!);
  assert.deepEqual(quoted(sends.match(/^SEND_CLASSES = \(([^)]*)\)/m)?.[1]??''),[...sendClasses]);
  const defaults=quoted(sends.match(/^DEFAULT_CLASSES = \(([\s\S]*?)\)\n/m)?.[1]??'').filter(item=>!item.endsWith(':'));
  assert.ok(defaults.length>=9&&defaults.every(item=>sendClasses.includes(item as never)),defaults.join());
});
