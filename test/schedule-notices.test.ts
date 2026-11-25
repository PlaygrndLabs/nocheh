import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/archive.js';
import {installChatsForTest} from '../src/chats.js';
import {HttpError} from '../src/http.js';
import {promptKeys,promptProblem,scheduleNoticeLines,scheduleNoticeTexts} from '../src/prompts.js';
import {ScheduleNotices,ownerTime,scheduleButton} from '../src/stores/schedule-notices.js';
import {silentResult} from '../src/stores/telegram-actions.js';
import {fixtureAgent,type FakeCall} from './fixture-agent.js';
import {seededDirectory} from './fixture-seeded-chats.js';

const OWNER='42',STORE='1'.repeat(24),PROFILE='nocheh-'+STORE,JOB='a1b2c3d4e5f6';
const policy=()=>({owner_id:OWNER,owner_chat:OWNER,group_ids:['-10042']});
/** The control store as a press's grant uses it: what was granted, and the row read back (none for a refused one). */
function grants(granted:unknown[][]=[],refuse=false) {
  return {query:async(sql:string,values:unknown[]=[])=>{
    if(sql.startsWith('INSERT INTO schedule_grants')){granted.push(values);return {rows:[]};}
    if(sql.startsWith('SELECT operation,person FROM schedule_grants')){const row=granted.find(item=>item[0]===values[0]);
      return {rows:row&&!refuse?[{operation:row[3],person:row[5]}]:[]};}
    return {rows:[]};
  }} as any;
}
const control=grants();
const schedule={scope:OWNER,profile:PROFILE,job_id:JOB,name:'Morning brief',schedule:'0 8 * * 1-5',timezone:'Asia/Tokyo',next_run_at:'2026-11-23T23:00:00+00:00'};

function notices(sent:Record<string,any>[],manage:FakeCall=async()=>({}),store=control) {
  const call=(async(operation:string,input:Record<string,unknown>)=>{sent.push({operation,...input});return {state:'done'};}) as any;
  return new ScheduleNotices(store,policy,call,fixtureAgent(async(operation,input)=>operation==='schedules.manage'?manage(operation,input):{}));
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

test('the message shows the saved instruction; one saved paused after outside content says why and offers Start (ADR-0294)',async()=>{
  const restore=installChatsForTest(seededDirectory(policy));
  try {
    const lines=scheduleNoticeLines(''),sent:Record<string,any>[]=[];
    await notices(sent).announce({...schedule,prompt:'Summarize my unread email\r\n\n\n\nand today\'s tasks.',enabled:true,reads:[]});
    assert.match(sent[0]!.text,/\n📝 Does: Summarize my unread email\n\nand today's tasks\.\n/);
    assert.doesNotMatch(sent[0]!.text,/Saved paused/);
    // A long instruction is cut; the Schedules page has all of it.
    const long:Record<string,any>[]=[];await notices(long).announce({...schedule,prompt:'x'.repeat(5000)});
    assert.match(long[0]!.text,/📝 Does: x{700}…\n/);
    // Saved paused by a reply that read a web page and a file: why, no next run, and Start instead of Pause.
    const held:Record<string,any>[]=[];
    await notices(held).announce({...schedule,prompt:'Post the prices',enabled:false,reads:['web','file','unchecked']});
    const text=held[0]!.text as string;
    assert.match(text,/^⏰ New schedule: Morning brief\n/);assert.doesNotMatch(text,/Next run/);
    assert.ok(text.includes('⏸ Saved paused, because the reply that set it read '+[lines.read_web,lines.read_file].join(', ')+' and '+lines.read_other+'.'),text);
    assert.deepEqual(held[0]!.buttons.flat().map((button:any)=>button.callback),['nks'+STORE+JOB,'nkd'+STORE+JOB]);
    // A search of past messages is named as such: it can find other people's messages.
    const searched:Record<string,any>[]=[];await notices(searched).announce({...schedule,prompt:'Post the prices',enabled:false,reads:['archive']});
    assert.ok(searched[0]!.text.includes('read '+lines.read_archive+'.'),searched[0]!.text);
    assert.ok(held[0]!.buttons.flat().every((button:any)=>scheduleButton.test(button.callback)));
    assert.equal(held[0]!.id,sent[0]!.id,'a new schedule keeps its one message');
    // One saved paused with no outside content just waits for Start.
    const waiting:Record<string,any>[]=[];await notices(waiting).announce({...schedule,prompt:'Check',enabled:false,reads:[]});
    assert.ok(waiting[0]!.text.includes(lines.waiting));assert.ok(!waiting[0]!.text.includes('because'));
    // A change saved paused is its own message, named as changed.
    const changed:Record<string,any>[]=[];
    await notices(changed).announce({...schedule,prompt:'Post the prices',enabled:false,reads:['tools'],changed:true,version:'v2'});
    assert.match(changed[0]!.text,/^⏰ Schedule changed: Morning brief\n/);assert.ok(changed[0]!.text.includes(lines.read_tools));
    assert.notEqual(changed[0]!.id,sent[0]!.id);
  } finally {restore();}
});

test('Start on a paused schedule\'s message resumes it as the owner\'s press and edits the latest message (ADR-0294)',async()=>{
  const restore=installChatsForTest(seededDirectory(policy));
  try {
    const asked:Record<string,unknown>[]=[],listed=[{id:JOB,profile:PROFILE,scope:OWNER,name:'Morning brief',schedule:'0 8 * * 1-5',timezone:'Asia/Tokyo',enabled:false,next_run_at:null}];
    const manage:FakeCall=async(_,input)=>{asked.push(input);return input.operation==='list'?{schedules:listed}:{schedule:{...listed[0],enabled:true,next_run_at:'2026-11-23T23:00:00+00:00'}};};
    const granted:unknown[][]=[],sent:Record<string,any>[]=[],store=grants(granted),latest='9'.repeat(64);
    const control={query:async(sql:string,values:unknown[]=[])=>sql.startsWith('SELECT notice_id')?{rows:[{notice_id:latest}]}:store.query(sql,values)} as any;
    const call=(async(operation:string,input:Record<string,unknown>)=>{sent.push({operation,...input});return {state:'done'};}) as any;
    const notices=new ScheduleNotices(control,policy,call,fixtureAgent(async(operation,input)=>operation==='schedules.manage'?manage(operation,input):{}),async()=>'Post the prices');
    const reply=await notices.press('s',STORE,JOB,'a'.repeat(64));
    assert.equal(reply,scheduleNoticeLines('').started);
    assert.deepEqual(asked.map(input=>input.operation),['list','resume']);
    assert.deepEqual(granted.map(values=>values.slice(2,6)),[['edit','resume','press-'+'a'.repeat(64),'owner']]);
    assert.equal(sent[0]!.id,latest);assert.equal(sent[0]!.edit,true);assert.equal(sent[0]!.buttons,undefined);
    assert.match(sent[0]!.text,/Next run: Tue 24 Nov, 08:00\n📝 Does: Post the prices\n/);assert.doesNotMatch(sent[0]!.text,/Saved paused/);
    assert.ok(sent[0]!.text.endsWith('\n\n'+reply));
  } finally {restore();}
});

test('a press pauses or deletes only a schedule of the owner\'s private chat, then the message says so with no buttons',async()=>{
  const restore=installChatsForTest(seededDirectory(policy));
  try {
    const asked:Record<string,unknown>[]=[],listed=[{id:JOB,profile:PROFILE,scope:OWNER,name:'Morning brief',schedule:'0 8 * * 1-5',timezone:'Asia/Tokyo',next_run_at:null}];
    const manage:FakeCall=async(_,input)=>{asked.push(input);return input.operation==='list'?{schedules:listed}:input.operation==='pause'?{schedule:{...listed[0],enabled:false}}:{ok:true};};
    // Nocheh grants the owner's press that one change first, by the press's request id (ADR-0290).
    const granted:unknown[][]=[],sent:Record<string,any>[]=[],paused=await notices(sent,manage,grants(granted)).press('p',STORE,JOB,'f'.repeat(64));
    assert.equal(paused,scheduleNoticeLines('').paused);
    assert.deepEqual(asked.map(input=>input.operation),['list','pause']);
    assert.deepEqual(asked[1],{operation:'pause',profile:PROFILE,job_id:JOB,request_id:'press-'+'f'.repeat(64)});
    assert.deepEqual(granted.map(values=>values.slice(2,6)),[['edit','pause','press-'+'f'.repeat(64),'owner']]);
    assert.equal(granted[0]![1],digest(canonical([PROFILE,JOB])));
    // A grant Nocheh cannot give (the same press asked for something else) changes nothing.
    asked.length=0;
    assert.equal(await notices([],manage,grants([],true)).press('d',STORE,JOB,'c'.repeat(64)),scheduleNoticeLines('').changed);
    assert.deepEqual(asked.map(input=>input.operation),['list']);
    // A chat that is no longer a member's own: no grant, nothing changed.
    asked.length=0;const memberListed=[{...listed[0],scope:'777'}],none:unknown[][]=[];
    const member:FakeCall=async(_,input)=>{asked.push(input);return input.operation==='list'?{schedules:memberListed}:{ok:true};};
    assert.equal(await notices([],member,grants(none)).press('d',STORE,JOB,'b'.repeat(64),'777'),scheduleNoticeLines('').changed);
    assert.deepEqual([asked.map(input=>input.operation),none.length],[['list'],0]);
    assert.equal(sent[0]!.edit,true);assert.equal(sent[0]!.buttons,undefined);assert.ok(sent[0]!.text.endsWith('\n\n'+paused));
    // The edit is a notice, the only kind a member's own chat takes an edit of.
    assert.equal(sent[0]!.send_class,'notice');
    // A schedule that is gone, or another chat's, is not touched.
    asked.length=0;
    assert.equal(await notices([],manage).press('d',STORE,'ffffffffffff','e'.repeat(64)),scheduleNoticeLines('').changed);
    assert.deepEqual(asked.map(input=>input.operation),['list']);
    // A member's own press in their own chat deletes it as theirs, and their chat's message is edited as a notice.
    {
      const memberSent:Record<string,any>[]=[],memberGranted:unknown[][]=[],theirs=grants(memberGranted);
      const store={query:async(sql:string,values:unknown[]=[])=>/AS member FROM chats/.test(sql)&&values[0]==='777'?{rows:[{chat:'777',member:'m1'}]}:theirs.query(sql,values)} as any;
      const deleted=await notices(memberSent,member,store).press('d',STORE,JOB,'9'.repeat(64),'777');
      assert.equal(deleted,scheduleNoticeLines('').deleted);
      assert.deepEqual(memberGranted.map(values=>values.slice(2,6)),[['edit','delete','press-'+'9'.repeat(64),'m1']]);
      assert.deepEqual(memberSent.map(input=>[input.chat_id,input.edit,input.send_class,input.buttons]),[['777',true,'notice',undefined]]);
    }
    // The agent refusing it reads as changed, never as a failure of the press.
    const refusing:FakeCall=async(_,input)=>{if(input.operation==='list')return {schedules:listed};throw new HttpError(400,'cron_change_refused');};
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
