import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveredKinds,sendClassOf,sendClasses,unlearnedSendClasses} from '../src/send-classes.js';

test('Nocheh\'s sends carry one of eleven neutral classes, and only cards, card updates, refusals, notices and reminders are not learned',()=>{
  assert.deepEqual([...sendClasses],['reply','follow_up','private_answer','job_report','scheduled_run','approved_post',
    'card','card_update','refusal','notice','reminder']);
  assert.deepEqual([...unlearnedSendClasses].sort(),['card','card_update','notice','refusal','reminder']);
  assert.ok([...unlearnedSendClasses].every(name=>sendClasses.includes(name)));
  for(const name of sendClasses)assert.equal(sendClassOf(name),name);
  for(const value of ['other','Reply',' reply','',null,undefined,1,{},['reply'],'constructor','__proto__'])assert.equal(sendClassOf(value),null,String(value));
  assert.deepEqual([...deliveredKinds].sort(),['browser_delivered_message','telegram_delivered_message']);
});

test('the Telegram adapter stamps the same classes, and every route default is one of them',()=>{
  const sends=readFileSync(new URL('../../services/telegram/sends.py',import.meta.url),'utf8');
  const quoted=(text:string)=>[...text.matchAll(/'([a-z_:-]+)'/g)].map(match=>match[1]!);
  assert.deepEqual(quoted(sends.match(/^SEND_CLASSES = \(([^)]*)\)/m)?.[1]??''),[...sendClasses]);
  const defaults=quoted(sends.match(/^DEFAULT_CLASSES = \(([\s\S]*?)\)\n/m)?.[1]??'').filter(item=>!item.endsWith(':'));
  assert.ok(defaults.length>=9&&defaults.every(item=>sendClasses.includes(item as never)),defaults.join());
});
