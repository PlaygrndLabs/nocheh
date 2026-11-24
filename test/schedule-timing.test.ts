import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cronMatches,knownZone,parseCron} from '../src/schedule-timing.js';
import {fireTiming} from '../src/stores/schedules.js';

const at=(iso:string)=>Date.parse(iso);

test('the cron matcher reads the 5-field forms Hermes writes, on the wall clock of the schedule\'s zone',()=>{
  // "every weekday at 8am" in a zone an hour ahead of UTC in winter.
  const weekday='0 8 * * 1-5';
  assert.equal(cronMatches(weekday,at('2026-11-25T07:00:00Z'),'Europe/Berlin'),true,'Wednesday 08:00 local');
  assert.equal(cronMatches(weekday,at('2026-11-25T08:00:00Z'),'Europe/Berlin'),false,'09:00 local');
  assert.equal(cronMatches(weekday,at('2026-11-25T08:00:00Z'),'UTC'),true);
  assert.equal(cronMatches(weekday,at('2026-11-29T07:00:00Z'),'Europe/Berlin'),false,'Sunday');
  // A zone behind UTC moves the local day too: Monday 23:00 UTC is Monday 18:00 in New York, Tuesday 00:00 in Berlin.
  assert.equal(cronMatches('0 0 * * 2',at('2026-11-23T23:00:00Z'),'Europe/Berlin'),true);
  assert.equal(cronMatches('0 0 * * 2',at('2026-11-23T23:00:00Z'),'America/New_York'),false);
  assert.equal(cronMatches('0 18 * * mon',at('2026-11-23T23:00:00Z'),'America/New_York'),true);
  // A zone with a half-hour offset.
  assert.equal(cronMatches('30 13 * * *',at('2026-11-24T08:00:00Z'),'Asia/Kolkata'),true);
  // Names, case-insensitive, as values and range ends.
  assert.equal(cronMatches('0 9 * jan-mar MON-FRI',at('2026-02-03T09:00:00Z'),'UTC'),true);
  assert.equal(cronMatches('0 9 * jan-mar MON-FRI',at('2026-04-07T09:00:00Z'),'UTC'),false);
  assert.equal(cronMatches('0 9 * * Sun',at('2026-11-29T09:00:00Z'),'UTC'),true);
  // 0 and 7 are both Sunday; 1-7 is Monday to Sunday.
  assert.equal(cronMatches('0 9 * * 7',at('2026-11-29T09:00:00Z'),'UTC'),true);
  assert.equal(cronMatches('0 9 * * 1-7',at('2026-11-29T09:00:00Z'),'UTC'),true);
  assert.equal(cronMatches('0 9 * * 1-7',at('2026-11-28T09:00:00Z'),'UTC'),true);
  // Steps, lists and ranges with steps.
  assert.equal(cronMatches('*/15 * * * *',at('2026-11-24T10:45:00Z'),'UTC'),true);
  assert.equal(cronMatches('*/15 * * * *',at('2026-11-24T10:50:00Z'),'UTC'),false);
  assert.equal(cronMatches('5/20 * * * *',at('2026-11-24T10:45:00Z'),'UTC'),true);
  assert.equal(cronMatches('5/20 * * * *',at('2026-11-24T10:40:00Z'),'UTC'),false);
  assert.equal(cronMatches('0 8-18/2 * * *',at('2026-11-24T16:00:00Z'),'UTC'),true);
  assert.equal(cronMatches('0 8-18/2 * * *',at('2026-11-24T17:00:00Z'),'UTC'),false);
  assert.equal(cronMatches('0,30 9,21 1,15 * *',at('2026-11-15T21:30:00Z'),'UTC'),true);
  assert.equal(cronMatches('0,30 9,21 1,15 * *',at('2026-11-16T21:30:00Z'),'UTC'),false);
  // `?` alone means `*` in a day field only.
  assert.equal(cronMatches('0 9 ? * 2',at('2026-11-24T09:00:00Z'),'UTC'),true);
  assert.equal(cronMatches('0 9 1 * ?',at('2026-12-01T09:00:00Z'),'UTC'),true);
  assert.equal(parseCron('? 9 * * *'),null);
  // A null zone is read as UTC by the caller; an unknown zone matches nothing.
  assert.equal(cronMatches('0 9 * * *',at('2026-11-24T09:00:00Z'),'Nowhere/Synthetic'),false);
  assert.equal(knownZone('Europe/Berlin'),true);assert.equal(knownZone('Nowhere/Synthetic'),false);
});

test('a day matches on day-of-month OR day-of-week when both are restricted, as croniter does',()=>{
  // The 1st of the month or any Monday.
  assert.equal(cronMatches('0 9 1 * 1',at('2026-12-01T09:00:00Z'),'UTC'),true,'Tuesday the 1st');
  assert.equal(cronMatches('0 9 1 * 1',at('2026-11-30T09:00:00Z'),'UTC'),true,'Monday the 30th');
  assert.equal(cronMatches('0 9 1 * 1',at('2026-11-24T09:00:00Z'),'UTC'),false,'Tuesday the 24th');
  // Every day of the month written out still counts as restricted when the weekday field has no `*`, so it is every day.
  assert.equal(cronMatches('0 9 1-31 * 1',at('2026-11-24T09:00:00Z'),'UTC'),true);
  // With a `*` in the weekday field it counts as `*`, so only the weekdays named match.
  assert.equal(cronMatches('0 9 1-31 * */2',at('2026-11-24T09:00:00Z'),'UTC'),true,'Tuesday');
  assert.equal(cronMatches('0 9 1-31 * */2',at('2026-11-25T09:00:00Z'),'UTC'),false,'Wednesday');
  // A `*` day-of-month: only the weekday decides.
  assert.equal(cronMatches('0 9 * * 1',at('2026-12-01T09:00:00Z'),'UTC'),false);
  // A stepped day-of-month is restricted: the 1st, 3rd, ... or Sunday.
  assert.equal(cronMatches('0 9 */2 * 0',at('2026-11-22T09:00:00Z'),'UTC'),true,'Sunday the 22nd');
  assert.equal(cronMatches('0 9 */2 * 0',at('2026-11-24T09:00:00Z'),'UTC'),false,'Tuesday the 24th');
});

test('daylight saving: a fall-back hour matches twice, a spring-forward gap does not match',()=>{
  // Europe/Berlin leaves summer time on 2026-10-25: 02:30 local is 00:30 UTC and again 01:30 UTC.
  assert.equal(cronMatches('30 2 * * *',at('2026-10-25T00:30:00Z'),'Europe/Berlin'),true);
  assert.equal(cronMatches('30 2 * * *',at('2026-10-25T01:30:00Z'),'Europe/Berlin'),true);
  // It enters summer time on 2026-03-29: 02:30 local does not exist, and 01:30 UTC reads 03:30.
  assert.equal(cronMatches('30 2 * * *',at('2026-03-29T01:30:00Z'),'Europe/Berlin'),false);
  assert.equal(cronMatches('30 3 * * *',at('2026-03-29T01:30:00Z'),'Europe/Berlin'),true);
  // 8am stays 8am local across the change.
  assert.equal(cronMatches('0 8 * * *',at('2026-03-28T07:00:00Z'),'Europe/Berlin'),true);
  assert.equal(cronMatches('0 8 * * *',at('2026-03-30T06:00:00Z'),'Europe/Berlin'),true);
  assert.equal(cronMatches('0 0 * * *',at('2026-03-29T23:00:00Z'),'UTC'),false);
  assert.equal(cronMatches('0 0 * * *',at('2026-03-30T00:00:00Z'),'UTC'),true,'midnight reads 0, not 24');
});

test('forms the matcher cannot read exactly are unsupported',()=>{
  for(const expr of ['0 8 * *','0 0 8 * * *','0 0 8 * * * 2026','@daily','@hourly','0 8 L * *','0 8 15W * *','0 8 * * 1#2','0 8 * * 5L','H 8 * * *',
    '60 8 * * *','0 24 * * *','0 8 0 * *','0 8 32 * *','0 8 * 0 *','0 8 * 13 *','0 8 * * 8','0 8 * * 5-1','0 8 * * 1-1','0 22-2 * * *',
    '*/0 * * * *','0 8 * mon *','0 8 * * jan','0 8 * * monday','1,,2 * * * *','0 8 * * 1-2-3','0 8 */x * *','','   ',42,null,'0 8 * * * '+'x'.repeat(300)] as unknown[])
    assert.equal(parseCron(expr),null,String(expr));
  for(const expr of ['0 8 * * 1-5',' 0  8 * * * ','*/5 * * * *','0 8 1 jan *','0 8 ? * sat','0 8 * * 0-7','15 6 1,15 * *'])
    assert.notEqual(parseCron(expr),null,expr);
  // A field's last value with a step: croniter 6.2.4 reads `23/2` as every other hour from 0, `sat/2` and `6/2` as
  // Sunday, Tuesday, Thursday and Saturday, `12/5` as months 1, 6 and 11. Refused, so no such schedule is set to never fire.
  for(const expr of ['0 23/2 * * *','0 8 * * sat/2','0 8 * * 6/2','0 8 * * 7/2','0 0 1 12/5 *','0 0 1 dec/5 *','59/5 * * * *','0 0 31/2 * *','0 8 1,31/2 * *'])
    assert.equal(parseCron(expr),null,expr);
  // A value below the last one with a step still runs to the field's end, as croniter reads it.
  assert.deepEqual([...parseCron('0 22/2 * * *')!.hour],[22]);
  assert.deepEqual([...parseCron('58/2 * * * *')!.minute],[58]);
  assert.deepEqual([...parseCron('0 8 * * 5/2')!.dow],[5]);
  assert.deepEqual([...parseCron('0 0 1 11/5 *')!.month],[11]);
});

test('a clock fire must land when the schedule says, once, and never early',()=>{
  const cron={schedule:{kind:'cron',expr:'0 8 * * 1-5'},timezone:'Europe/Berlin',repeat:null};
  const due=at('2026-11-25T07:00:00Z'),now=due+3000;
  assert.equal(fireTiming(cron,'scheduled',due,{now,last:null,fired:0}),true);
  assert.equal(fireTiming(cron,'scheduled',due,{now:due-6000,last:null,fired:0}),false,'more than 5 s early');
  assert.equal(fireTiming(cron,'scheduled',due,{now:due+601000,last:null,fired:0}),false,'over ten minutes late');
  assert.equal(fireTiming(cron,'missed',due,{now:due+3600000,last:null,fired:0}),true,'a missed fire may be late');
  assert.equal(fireTiming(cron,'scheduled',due,{now,last:due,fired:1}),false,'the same minute twice');
  assert.equal(fireTiming(cron,'scheduled',due+1000,{now,last:null,fired:0}),false,'not a whole minute');
  assert.equal(fireTiming(cron,'scheduled',due+60000,{now:due+61000,last:due,fired:1}),false,'not a minute the expression names');
  assert.equal(fireTiming({...cron,timezone:null},'scheduled',at('2026-11-25T08:00:00Z'),{now:at('2026-11-25T08:00:01Z'),last:null,fired:0}),true,'no zone reads UTC');
  assert.equal(fireTiming({...cron,schedule:{kind:'cron',expr:'0 8 L * *'}},'scheduled',due,{now,last:null,fired:0}),false,'unsupported forms never fire');
  const interval={schedule:{kind:'interval',minutes:30},repeat:null};
  assert.equal(fireTiming(interval,'scheduled',due,{now,last:null,fired:0}),true);
  assert.equal(fireTiming(interval,'scheduled',due,{now,last:due-1800000+500,fired:1}),true,'a second of slack');
  assert.equal(fireTiming(interval,'scheduled',due,{now,last:due-1700000,fired:1}),false,'too soon after the last');
  assert.equal(fireTiming({schedule:{kind:'interval',minutes:0}},'scheduled',due,{now,last:null,fired:0}),false);
  const once={schedule:{kind:'once',run_at:'2026-11-25T07:00:00Z'},repeat:1};
  assert.equal(fireTiming(once,'scheduled',due,{now,last:null,fired:0}),true);
  assert.equal(fireTiming(once,'scheduled',due+60000,{now:due+61000,last:due,fired:1}),false,'once per execution version');
  assert.equal(fireTiming({...interval,repeat:2},'scheduled',due,{now,last:due-3600000,fired:2}),false,'repeat reached');
  assert.equal(fireTiming({schedule:{kind:'other'}},'scheduled',due,{now,last:null,fired:0}),false);
});
