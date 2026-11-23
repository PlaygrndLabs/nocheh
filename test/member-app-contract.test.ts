import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DashboardClient,miniAppServer} from '../src/mini-app.js';
import {FIXTURE_BOT_ID,FIXTURE_KEY_REFUSED,MEMBER_LAUNCH_MAX_AGE,OWNER_LAUNCH_MAX_AGE,TELEGRAM_KEYS,launchKey,verifyLaunch,verifyLaunchUser} from '../src/telegram-launch.js';
import {MEMBER_APP_ERROR_STATUS,MEMBER_APP_ROUTES,memberAppErrors,memberAppRoute,memberTaskQuery} from '../src/member-app-wire.js';
import {memberAppTextKeys} from '../src/member-wire.js';
import {fillTemplate,memberReminder,memberReminderLines,memberReminderTexts,promptKeys,promptPlaceholders,promptProblem,reminderLines} from '../src/prompts.js';
import {noticeAuthorizeRequest,noticeDigest} from '../src/notice-authorize.js';

// The members' app contract (step 5, ADR-0265): launch data for any Telegram user, the fixture key seam, the route list,
// list filters, the new editable texts, and the reminder notice check's request.

const botId='5550001',ownerId='4242';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
/** Launch data signed the way Telegram signs it, with a synthetic key. */
function launch(fields:Record<string,string>,key=privateKey,bot=botId) {
  const data=bot+':WebAppData\n'+Object.entries(fields).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  return new URLSearchParams({...fields,hash:'0'.repeat(64),signature:sign(null,Buffer.from(data),key).toString('base64url')}).toString();
}
const now=1_800_000_000_000,at=(secondsAgo:number)=>String(now/1000-secondsAgo);
const user=(id:string|number,extra:Record<string,unknown>={})=>JSON.stringify({id,first_name:'Mira',...extra});
const member={botId,key:publicKey,now,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE};

test('a member\'s launch is any Telegram user\'s, for an hour, from the menu or their own chat only',()=>{
  assert.equal(MEMBER_LAUNCH_MAX_AGE,3600);assert.equal(OWNER_LAUNCH_MAX_AGE,86400);
  assert.deepEqual(verifyLaunchUser(launch({auth_date:at(60),query_id:'q1',user:user(701,{language_code:'FA'})}),member),
    {user_id:'701',auth_date:now/1000-60,language_code:'fa'});
  assert.deepEqual(verifyLaunchUser(launch({auth_date:at(60),chat_type:'sender',chat_instance:'5',user:user(701)}),member),
    {user_id:'701',auth_date:now/1000-60,chat_type:'sender'});
  assert.equal(verifyLaunchUser(launch({auth_date:at(60),user:user(701,{language_code:'<b>'})}),member).language_code,undefined,'a strange language is dropped');
  assert.equal(verifyLaunchUser(launch({auth_date:at(3599),user:user(701)}),member).user_id,'701');
  assert.throws(()=>verifyLaunchUser(launch({auth_date:at(3601),user:user(701)}),member),{status:401,code:'telegram_launch_expired'},'over an hour');
  assert.throws(()=>verifyLaunchUser(launch({auth_date:at(-61),user:user(701)}),member),{code:'telegram_launch_expired'},'from the future');
  for(const chatType of ['group','supergroup','channel','private',''])
    assert.throws(()=>verifyLaunchUser(launch({auth_date:at(60),chat_type:chatType,user:user(701)}),member),{status:401,code:'telegram_launch_invalid'},chatType);
  assert.throws(()=>verifyLaunchUser(launch({auth_date:at(60),user:user(701)},generateKeyPairSync('ed25519').privateKey),member),{code:'telegram_launch_invalid'},'not Telegram\'s');
  assert.throws(()=>verifyLaunchUser(launch({auth_date:at(60),user:user(701)},privateKey,'5550002'),member),{code:'telegram_launch_invalid'},'another bot');
  const tampered=new URLSearchParams(launch({auth_date:at(60),user:user(701)}));tampered.set('user',user(702));
  assert.throws(()=>verifyLaunchUser(tampered.toString(),member),{code:'telegram_launch_invalid'},'a changed user');
  assert.throws(()=>verifyLaunchUser(launch({auth_date:at(60),user:user(701)})+'&chat_type=group',member),{code:'telegram_launch_invalid'},'a repeated or added field');
  for(const id of [0,-5,'abc','1'.repeat(20)])
    assert.throws(()=>verifyLaunchUser(launch({auth_date:at(60),user:user(id)}),member),{status:401,code:'telegram_launch_invalid'},String(id));
  assert.throws(()=>verifyLaunchUser('',member),{status:401,code:'telegram_launch_required'});
  assert.throws(()=>verifyLaunchUser('a'.repeat(8193),member),{status:401,code:'telegram_launch_required'});
});

test('the owner\'s check is unchanged: a day, the owner only, and the chat type is not read',()=>{
  const owner={botId,ownerId,key:publicKey,now};
  assert.deepEqual(verifyLaunch(launch({auth_date:at(86000),user:user(4242)}),owner),{user_id:ownerId,auth_date:now/1000-86000});
  assert.deepEqual(verifyLaunch(launch({auth_date:at(60),chat_type:'group',user:user(4242)}),owner),{user_id:ownerId,auth_date:now/1000-60});
  assert.throws(()=>verifyLaunch(launch({auth_date:at(60),user:user(701)}),owner),{status:403,code:'owner_required'});
  assert.throws(()=>verifyLaunch(launch({auth_date:at(60),user:user('x')}),owner),{status:403,code:'owner_required'});
  assert.throws(()=>verifyLaunch(launch({auth_date:at(86401),user:user(4242)}),owner),{code:'telegram_launch_expired'});
});

test('the fixture launch key is honoured only in the installation fixture with the fake bot, and stops the process anywhere else',()=>{
  const pair=generateKeyPairSync('ed25519'),hex=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  const fixtureLaunch=(bot:string)=>launch({auth_date:at(60),user:user(701)},pair.privateKey,bot);
  const key=launchKey({TELEGRAM_LAUNCH_PUBLIC_KEY:hex,NOCHEH_INSTALLATION_FIXTURE:'1'},FIXTURE_BOT_ID);
  assert.equal(verifyLaunchUser(fixtureLaunch(FIXTURE_BOT_ID),{botId:FIXTURE_BOT_ID,key,now,maxAgeSeconds:3600}).user_id,'701');
  assert.throws(()=>launchKey({TELEGRAM_LAUNCH_PUBLIC_KEY:hex},FIXTURE_BOT_ID),{message:FIXTURE_KEY_REFUSED},'without the fixture flag');
  assert.throws(()=>launchKey({TELEGRAM_LAUNCH_PUBLIC_KEY:hex,NOCHEH_INSTALLATION_FIXTURE:'true'},FIXTURE_BOT_ID),{message:FIXTURE_KEY_REFUSED},'a flag that is not 1');
  assert.throws(()=>launchKey({TELEGRAM_LAUNCH_PUBLIC_KEY:hex,NOCHEH_INSTALLATION_FIXTURE:'1'},botId),{message:FIXTURE_KEY_REFUSED},'another bot');
  assert.throws(()=>launchKey({TELEGRAM_LAUNCH_PUBLIC_KEY:'zz',NOCHEH_INSTALLATION_FIXTURE:'1'},FIXTURE_BOT_ID),{message:FIXTURE_KEY_REFUSED},'not a key');
  // Without the variable, Telegram's own keys, whatever the flag says; a fixture-signed launch fails there.
  const telegram=launchKey({NOCHEH_INSTALLATION_FIXTURE:'1'},FIXTURE_BOT_ID);
  assert.deepEqual(telegram.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),TELEGRAM_KEYS.production);
  assert.equal(launchKey({TELEGRAM_TEST_ENVIRONMENT:'true',TELEGRAM_LAUNCH_PUBLIC_KEY:''},botId).export({format:'der',type:'spki'}).subarray(-32).toString('hex'),TELEGRAM_KEYS.test);
  assert.throws(()=>verifyLaunchUser(fixtureLaunch(FIXTURE_BOT_ID),{botId:FIXTURE_BOT_ID,key:telegram,now,maxAgeSeconds:3600}),{code:'telegram_launch_invalid'});
});

test('the members\' app answers only its own routes, and lists take only its own filters',()=>{
  const id='a'.repeat(64);
  assert.equal(MEMBER_APP_ROUTES.length,11);
  // The member's own time zone for new schedules (members' time zones).
  assert.deepEqual(memberAppRoute('POST','/time-zone'),{name:'time_zone'});assert.equal(memberAppRoute('GET','/time-zone'),null);
  // A member's own schedules (members' schedules): the list, and one schedule by its id.
  assert.deepEqual(memberAppRoute('GET','/schedules'),{name:'schedules'});
  assert.deepEqual(memberAppRoute('POST','/schedules/a1b2c3d4e5f6'),{name:'schedule',schedule:'a1b2c3d4e5f6'});
  for(const path of ['/schedules/','/schedules/a b','/schedules/'+'a'.repeat(129),'/schedules/x/run'])assert.equal(memberAppRoute('POST',path),null,path);
  assert.equal(memberAppRoute('GET','/schedules/a1b2c3d4e5f6'),null);
  for(const [method,path,name,task] of [['GET','/me','me'],['GET','/tasks','tasks'],['GET','/tasks/'+id,'task',id],['POST','/tasks','create'],['POST','/tasks/'+id,'update',id],
    ['POST','/tasks/'+id+'/comments','comment',id],['GET','/reminders','reminders'],['POST','/sign-out','sign_out']] as const)
    assert.deepEqual(memberAppRoute(method,path),task?{name,task}:{name},method+' '+path);
  for(const [method,path] of [['POST','/prefs'],['POST','/me'],['GET','/sign-out'],['GET','/tasks/settings'],['POST','/tasks/'+id+'/delete'],['GET','/tasks/'+id+'/audience'],['POST','/tasks/archive-finished'],
    ['GET','/status'],['GET','/decisions'],['GET','/me/'],['GET','me'],['GET','/tasks/'+id.toUpperCase()],['DELETE','/tasks/'+id],['GET','/../me']] as const)
    assert.equal(memberAppRoute(method,path),null,method+' '+path);
  const project='b'.repeat(64);
  assert.deepEqual(memberTaskQuery(new URLSearchParams({project})),{project});
  assert.deepEqual(memberTaskQuery(new URLSearchParams({project,group:'-1001000000001',mine:'1',state:'done',trash:'1',tag:'Money',cursor:'50'})),
    {project,group:'-1001000000001',mine:true,state:'done',trash:true,tag:'Money',cursor:'50'});
  for(const query of ['',`project=${project}&person=${id}`,`project=${project}&project=${project}`,'project=P1',`project=${project}&state=dropped`,`project=${project}&mine=true`,
    `project=${project}&q=x`,`project=${project}&cursor=-1`,`project=${project}&group=`])
    assert.throws(()=>memberTaskQuery(new URLSearchParams(query)),{status:400,code:'task_filter_not_allowed'},query);
  assert.deepEqual(Object.keys(MEMBER_APP_ERROR_STATUS).sort(),Object.values(memberAppErrors).sort(),'every error has its status');
  assert.deepEqual(Object.values(memberAppErrors).sort(),['conflict','member_app_busy','member_app_closed','member_app_launch_invalid','member_app_launch_old',
    'member_app_no_bearer','member_app_signed_out','member_reminders_unavailable','member_required','member_schedule_not_found','member_schedules_off',
    'task_field_not_allowed','task_filter_not_allowed','task_read_only','task_reminders_off']);
});

test('the member reminder texts are editable, English by default, and name no writer or place; the owner\'s lines gain the app\'s place',()=>{
  for(const key of Object.values(memberAppTextKeys))assert.ok((promptKeys as readonly string[]).includes(key),key);
  assert.deepEqual(promptPlaceholders['members.reminder'],['{title}']);
  assert.equal(promptProblem('members.reminder',memberReminder),null);assert.equal(promptProblem('members.reminder','⏰ Due'),'prompt_placeholder_missing');
  assert.equal(promptProblem('members.reminder_texts',memberReminderTexts),null);
  assert.equal(promptProblem('members.reminder_texts','note_line: >'),'prompt_placeholder_missing');
  const lines=memberReminderLines(undefined);
  assert.deepEqual(lines,{set_by:'👤 Set by you',note_line:'┆ {line}'});
  assert.equal(memberReminderLines('set_by: 👤 You set this').set_by,'👤 You set this');
  assert.equal(memberReminderLines('note_line: >').note_line,'┆ {line}','a line without its value reads as its default');
  assert.ok(!/\{(who|place|fields)\}/.test(memberReminder+memberReminderTexts));
  assert.equal(fillTemplate(memberReminder,{title:'Call the bank',due:null,list:'P1',notes:null}),'⏰ Call the bank\n📁 P1');
  assert.equal(reminderLines(undefined).place_app,'the members’ app');
});

test('the reminder notice check reads only its three fields and digests the exact text',()=>{
  const id='c'.repeat(64),digest=noticeDigest('⏰ Call the bank');
  assert.equal(digest,createHash('sha256').update(Buffer.from('⏰ Call the bank','utf8')).digest('hex'));
  assert.deepEqual(noticeAuthorizeRequest({id,chat:'701',text_digest:digest}),{id,chat:'701',text_digest:digest});
  assert.deepEqual(noticeAuthorizeRequest({id,chat:'-1001000000001',text_digest:digest}).chat,'-1001000000001');
  for(const body of [null,[],{id,chat:'701'},{id,chat:'7 01',text_digest:digest},{id,chat:'',text_digest:digest},{id,chat:'701',text_digest:digest,send_class:'reminder'},{id:'x',chat:'701',text_digest:digest},
    {id,chat:701,text_digest:digest},{id,chat:'701',text_digest:'A'.repeat(64)}])
    assert.throws(()=>noticeAuthorizeRequest(body),{status:400,code:'invalid_notice_authorize'},JSON.stringify(body));
});

test('the mini app serves the member page\'s script beside the owner\'s, and nothing else new',async()=>{
  const assets=await mkdtemp(join(tmpdir(),'nocheh-member-'));
  await writeFile(join(assets,'mini.html'),'<!doctype html><title>Nocheh</title>');await writeFile(join(assets,'member.js'),'export{};');
  const server=miniAppServer({check:{botId,ownerId,key:publicKey},now:()=>now,assets,dashboard:new DashboardClient({host:'127.0.0.1',port:9})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try {
    const script=await fetch(base+'/assets/member.js');
    assert.equal(script.status,200);assert.equal(script.headers.get('content-type'),'text/javascript');assert.equal(await script.text(),'export{};');
    for(const path of ['/assets/member.html','/assets/members.js','/assets/../member.js'])assert.equal((await fetch(base+path)).status,404,path);
  } finally {server.close();await rm(assets,{recursive:true,force:true});}
});
