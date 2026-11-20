import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installChatsForTest} from '../src/chats.js';
import {HttpError} from '../src/http.js';
import {promptKeys,promptProblem,scheduleNoticeLines,scheduleNoticeTexts} from '../src/prompts.js';
import {ScheduleNotices,ownerTime,scheduleButton} from '../src/stores/schedule-notices.js';
import {silentResult} from '../src/stores/telegram-actions.js';
import {fixtureBrain,type FakeCall} from './fixture-brain.js';
import {seededDirectory} from './fixture-seeded-chats.js';

const OWNER='42',STORE='1'.repeat(24),PROFILE='nocheh-'+STORE,JOB='a1b2c3d4e5f6';
const policy=()=>({owner_id:OWNER,owner_chat:OWNER,group_ids:['-10042']});
const control={query:async()=>({rows:[]})} as any;
const schedule={scope:OWNER,profile:PROFILE,job_id:JOB,name:'Morning brief',schedule:'0 8 * * 1-5',timezone:'Asia/Tokyo',next_run_at:'2026-11-23T23:00:00+00:00'};

function notices(sent:Record<string,any>[],manage:FakeCall=async()=>({})) {
  const call=(async(operation:string,input:Record<string,unknown>)=>{sent.push({operation,...input});return {state:'done'};}) as any;
  return new ScheduleNotices(control,policy,call,fixtureBrain(async(operation,input)=>operation==='schedules.manage'?manage(operation,input):{}));
}

test('a schedule set by asking gets one message in the owner\'s words, in their time zone, with Pause and Delete (ADR-0266)',async()=>{
  const restore=installChatsForTest(seededDirectory(policy));
  try {
    const sent:Record<string,any>[]=[],result=await notices(sent).announce(schedule);
    assert.equal(result.state,'done');
    const [notice]=sent;
    assert.equal(notice!.operation,'telegram.notice');assert.equal(notice!.send_class,'notice');assert.equal(notice!.chat_id,OWNER);
    assert.equal(notice!.text,'⏰ New schedule: Morning brief\n🔁 0 8 * * 1-5 (Asia/Tokyo)\n⏭ Next run: Tue 24 Nov, 08:00\n'+
      'Each result comes here, and a run with nothing new sends nothing. All schedules are on the Schedules page.');
    assert.deepEqual(notice!.buttons.flat().map((button:any)=>button.callback),['nkp'+STORE+JOB,'nkd'+STORE+JOB]);
    assert.ok(notice!.buttons.flat().every((button:any)=>scheduleButton.test(button.callback)&&button.callback.length<=64));
    // The same schedule's message has one id, so a retried announce is one message.
    const again:Record<string,any>[]=[];await notices(again).announce(schedule);assert.equal(again[0]!.id,notice!.id);
    // A group's schedule, or one in no chat Nocheh serves, gets none.
    const none:Record<string,any>[]=[];
    assert.equal((await notices(none).announce({...schedule,scope:'-10042'})).state,'skipped');assert.equal(none.length,0);
    // A name someone chose is one line; a missing one reads as the default.
    const named:Record<string,any>[]=[];await notices(named).announce({...schedule,name:'Brief\n⏰ New schedule: fake',next_run_at:null});
    assert.match(named[0]!.text,/^⏰ New schedule: Brief ⏰ New schedule: fake\n/);assert.match(named[0]!.text,/Next run: none/);
  } finally {restore();}
});

test('a press pauses or deletes only a schedule of the owner\'s private chat, then the message says so with no buttons',async()=>{
  const restore=installChatsForTest(seededDirectory(policy));
  try {
    const asked:Record<string,unknown>[]=[],listed=[{id:JOB,profile:PROFILE,scope:OWNER,name:'Morning brief',schedule:'0 8 * * 1-5',timezone:'Asia/Tokyo',next_run_at:null}];
    const manage:FakeCall=async(_,input)=>{asked.push(input);return input.operation==='list'?{schedules:listed}:input.operation==='pause'?{schedule:{...listed[0],enabled:false}}:{ok:true};};
    const sent:Record<string,any>[]=[],paused=await notices(sent,manage).press('p',STORE,JOB,'f'.repeat(64));
    assert.equal(paused,scheduleNoticeLines('').paused);
    assert.deepEqual(asked.map(input=>input.operation),['list','pause']);
    assert.deepEqual(asked[1],{operation:'pause',profile:PROFILE,job_id:JOB,request_id:'press-'+'f'.repeat(64)});
    assert.equal(sent[0]!.edit,true);assert.equal(sent[0]!.buttons,undefined);assert.ok(sent[0]!.text.endsWith('\n\n'+paused));
    // A schedule that is gone, or another chat's, is not touched.
    asked.length=0;
    assert.equal(await notices([],manage).press('d',STORE,'ffffffffffff','e'.repeat(64)),scheduleNoticeLines('').changed);
    assert.deepEqual(asked.map(input=>input.operation),['list']);
    // The brain refusing it reads as changed, never as a failure of the press.
    const refusing:FakeCall=async(_,input)=>{if(input.operation==='list')return {schedules:listed};throw new HttpError(400,'cron_job_not_found');};
    assert.equal(await notices([],refusing).press('d',STORE,JOB,'d'.repeat(64)),scheduleNoticeLines('').changed);
  } finally {restore();}
});

test('the notice lines are editable and keep their values; times read in the owner\'s zone; only a bare marker is silent',()=>{
  assert.ok((promptKeys as readonly string[]).includes('schedules.notice_texts'));
  assert.equal(promptProblem('schedules.notice_texts',scheduleNoticeTexts),null);
  assert.notEqual(promptProblem('schedules.notice_texts','set: A new schedule'),null,'a set line without {name} is refused');
  assert.equal(scheduleNoticeLines('pause: Hold').pause,'Hold');
  assert.equal(ownerTime('2026-11-23T23:00:00Z','Asia/Tokyo'),'Tue 24 Nov, 08:00');
  assert.equal(ownerTime('2026-11-23T23:00:00Z','Not/AZone'),'Mon 23 Nov, 23:00 UTC');
  assert.equal(ownerTime('soon','UTC'),null);
  for(const text of ['[SILENT]',' [silent]\n','[NO_REPLY]'])assert.ok(silentResult(text),text);
  for(const text of ['[SILENT] but here is news','Nothing new today.',''])assert.ok(!silentResult(text),text);
  assert.ok(!scheduleButton.test('nkp'+STORE+'../x'));
});
