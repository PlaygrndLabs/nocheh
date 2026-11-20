import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {generateKeyPairSync,sign} from 'node:crypto';
import type {Server} from 'node:http';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {inReadSet,readSetGroups} from '../src/spaces.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {memberAppServer,type MemberAppServices} from '../src/stores/member-app.js';
import {MEMBER_RECHECK_HOURS,forgetMemberAppRechecks} from '../src/stores/member-reads.js';
import {Members} from '../src/stores/members.js';
import {TaskRepository,type MemberAppPrincipal} from '../src/stores/tasks.js';
import type {RuntimeCall} from '../src/runtime.js';
import {MEMBER_APP_WRITES_PER_10_MIN,MEMBER_APP_WRITES_PER_DAY} from '../src/member-app-wire.js';
import {BOB,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_APP_HIDDEN,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_OFF,
  MEMBER_NG,MEMBER_NG_ACCOUNT,MEMBER_NG_CHAT,MEMBER_NG_ID,NG1,NG1_TG,NG2,NG2_TG,NG_GROUP_IDS,OWNER,P1,UNSERVED,fixtureChats,fixtureDirectory,
  memberAppMembers,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// The members' app's listener against the control store (step 5, ADR-0265 D2-D4, D13): who is a member now on every
// call, their groups confirmed lately (Bob's case: GP1 and GP3, never GP2), when a launch is too old, sign-out,
// the write limit, and the principal the task repository gets. The task methods themselves are part B's; here a
// recording repository stands in, and the real one's stubs pass through.

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served,topic_memory:'group' as const};
const admin:Reader={admin:true,scope:null};
const botId='5550001',{publicKey,privateKey}=generateKeyPairSync('ed25519');
const seconds=()=>Math.floor(Date.now()/1000);
/** Telegram-signed launch data for `id`, `age` seconds old, with a synthetic key. */
function launch(id:string,age=30,name='Mira') {
  const fields={auth_date:String(seconds()-age),query_id:'q-'+id+'-'+age,user:JSON.stringify({id:Number(id),first_name:name})};
  const data=botId+':WebAppData\n'+Object.entries(fields).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  return new URLSearchParams({...fields,hash:'0'.repeat(64),signature:sign(null,Buffer.from(data),privateKey).toString('base64url')}).toString();
}
async function open() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords);
  // Bob's case: Mira with GP3 switched on, in GP1 and GP3, left GP2; and seen in GP4 (no project) too.
  await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control,memberAppMembers());await seedGroups(stores.control);
  await stores.control.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
  await stores.control.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source) VALUES($1,$2,'in','message') ON CONFLICT DO NOTHING`,[GP4,MEMBER_GP_ACCOUNT]);
  // Never confirmed by asking Telegram yet.
  await stores.control.query('UPDATE chat_memberships SET checked_at=NULL');
  // Members added a day ago.
  await stores.control.query(`UPDATE members SET app_since=now()-interval '1 day'`);
  return stores;
}

test('the members\' app listener: who is a member now, their groups confirmed lately, old launches, sign-out and the write limit',fixture,async()=>{
  const stores=await open(),db=stores.control,restore=installChatsForTest(fixtureDirectory(served));
  // Telegram, as the fake bot answers telegram.member_status: 'in' unless a test says otherwise.
  const asked:{chat_id:string;user_id:string}[]=[];let status:(chat:string)=>Record<string,unknown>=()=>({state:'done',status:'in'});
  const call:RuntimeCall=async(operation,input)=>{
    if(operation!=='telegram.member_status')throw Error('unexpected '+operation);
    asked.push(input as {chat_id:string;user_id:string});return status(String(input.chat_id));
  };
  const principals:{name:string;principal:MemberAppPrincipal;args:unknown[]}[]=[];
  const tasks=Object.fromEntries(['memberList','memberGet','memberCreate','memberUpdate','memberComment','memberReminders'].map(name=>
    [name,async(principal:MemberAppPrincipal,...args:unknown[])=>{principals.push({name,principal,args});return {done:name};}])) as unknown as MemberAppServices['tasks'];
  const servers:Server[]=[];
  const serve=async(repository:MemberAppServices['tasks']=tasks)=>{
    const server=memberAppServer({control:db,tasks:repository,policy:()=>policy,call},{botId,key:publicKey});servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    return 'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/member-app';
  };
  const base=await serve();
  const ask=async(path:string,init:string,body?:unknown)=>{
    const answer=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'x-telegram-init-data':init},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(answer.headers.get('cache-control'),'no-store',path);
    return {status:answer.status,body:await answer.json() as any};
  };
  const refused=async(path:string,init:string,status_:number,error:string,body?:unknown)=>{
    const before=principals.length,answer=await ask(path,init,body);
    assert.deepEqual([answer.status,answer.body],[status_,{error}],path);assert.equal(principals.length,before,'no task read for '+error);
  };
  const confirmed=(chat:string,hours:number|null,account=MEMBER_GP_ACCOUNT)=>db.query(`UPDATE chat_memberships SET checked_at=CASE WHEN $3::double precision IS NULL THEN NULL
    ELSE now()-make_interval(secs=>$3::double precision*3600) END WHERE chat_id=$1 AND account_id=$2`,[chat,account,hours]);
  const members=new Members(db,()=>policy);
  try {
    const mira=launch(MEMBER_GP);
    // GET me: Telegram is asked about every joined group never confirmed (GP1, GP3, GP4, never GP2 she left or
    // UNSERVED), then her groups and her one board.
    forgetMemberAppRechecks();
    const me=await ask('/me',mira);
    assert.equal(me.status,200);
    assert.deepEqual(asked.map(item=>item.chat_id).sort(),[GP1,GP3,GP4].sort(),'by their Telegram ids');
    assert.ok(asked.every(item=>item.user_id===MEMBER_GP));
    assert.deepEqual(me.body,{name:'Mira',mode:'write',reminders:{available:true},projects:[{id:P1,name:'P1'}],
      groups:[{id:GP1,title:'GP1',board:'open',project:P1,open_count:0},{id:GP3,title:'GP3',board:'open',project:P1,open_count:0},
        {id:GP4,title:'GP4',board:'none',project:null}]});
    assert.ok(!JSON.stringify(me.body).includes(GP2)&&!JSON.stringify(me.body).includes(UNSERVED),'never GP2 or a group Nocheh does not serve');
    // Open counts: a group's own open tasks and its topics', never trashed, archived, done, another group's or the project's own.
    const task=(name:string,group:string|null,extra='')=>db.query(`INSERT INTO owner_tasks(id,title,status_id,origin,project_id,group_id${extra?','+extra.split('=')[0]:''})
      VALUES($1,$2,'todo','dashboard',$3,$4${extra?','+extra.split('=')[1]:''})`,[digest('app-server:'+name),name,P1,group]);
    await task('one',GP1);await task('topic',GP1_TOPIC);await task('gp2',GP2);await task('project',null);await task('trashed',GP1,'deleted_at=now()');
    await task('archived',GP1,'archived_at=now()');await task('done',GP3,"state='done'");
    const counted=(await ask('/me',mira)).body.groups.map((group:{id:string;open_count?:number})=>[group.id,group.open_count]);
    assert.deepEqual(counted,[[GP1,2],[GP3,0],[GP4,undefined]]);
    assert.equal(asked.length,3,'asked again at most once every ten minutes');

    // The principal a list gets: P1 reaching GP1 (with its topic) and GP3, never GP2; Mira's account and private chat.
    assert.equal((await ask('/tasks?project='+P1,mira)).status,200);
    const {principal,args}=principals.at(-1)!;
    assert.deepEqual([principal.member,principal.account,principal.accounts,principal.name,principal.mode,principal.chat,principal.reminders],
      [MEMBER_GP_ID,MEMBER_GP_ACCOUNT,[MEMBER_GP_ACCOUNT],'Mira','write',MEMBER_GP_CHAT,{available:true}]);
    assert.deepEqual(principal.views.map(view=>[view.project,view.name]),[[P1,'P1']]);
    assert.deepEqual(readSetGroups(principal.views[0]!.reach).sort(),[GP1,GP3].sort());
    assert.ok(inReadSet(principal.views[0]!.reach,GP1_TOPIC)&&!inReadSet(principal.views[0]!.reach,MEMBER_APP_HIDDEN));
    assert.deepEqual(args,[{project:P1}]);
    // The real repository behind the real listener: P1's own task and GP1's (with its topic's), open ones only; never
    // GP2's, the trashed or the archived; a GP2 task is not found.
    const real=await serve(new TaskRepository(db,async()=>{throw Error('no turn here');}));
    const listed=await fetch(real+'/tasks?project='+P1,{headers:{'x-telegram-init-data':mira}});
    const page=await listed.json() as {tasks:{title:string}[]};
    assert.equal(listed.status,200);
    assert.deepEqual(page.tasks.map(item=>item.title).sort(),['one','project','topic']);
    const hidden=await fetch(real+'/tasks/'+digest('app-server:gp2'),{headers:{'x-telegram-init-data':mira}});
    assert.deepEqual([hidden.status,await hidden.json()],[404,{error:'task_not_found'}]);

    // A group Telegram last confirmed longer ago than MEMBER_RECHECK_HOURS and cannot confirm again drops out; one it says
    // she left drops out too. Neither is ever read meanwhile.
    await confirmed(GP1,MEMBER_RECHECK_HOURS+1);
    assert.deepEqual(readSetGroups((await (async()=>{await ask('/tasks?project='+P1,mira);return principals.at(-1)!.principal;})()).views[0]!.reach),[GP3],
      'past six hours, GP1 is left out until confirmed');
    forgetMemberAppRechecks();asked.length=0;
    status=chat=>chat===GP1?{state:'failed'}:{state:'done',status:'in'};
    const quiet=await ask('/me',mira);
    assert.deepEqual(asked.map(item=>item.chat_id),[GP1],'only the group past six hours');
    assert.deepEqual(quiet.body.groups.map((group:{id:string})=>group.id),[GP3,GP4],'a failed check closes GP1');
    assert.deepEqual(quiet.body.projects,[{id:P1,name:'P1'}]);
    forgetMemberAppRechecks();status=()=>({state:'done',status:'in'});
    assert.deepEqual((await ask('/me',mira)).body.groups.map((group:{id:string})=>group.id),[GP1,GP3,GP4],'confirmed again, it is back');
    await confirmed(GP3,MEMBER_RECHECK_HOURS+1);forgetMemberAppRechecks();status=chat=>({state:'done',status:chat===GP3?'left':'in'});
    assert.deepEqual((await ask('/tasks/'+digest('app-server:one'),mira,{operation_id:'o1',expected_version:'v',patch:{title:'x'}})).status,200);
    assert.deepEqual(readSetGroups(principals.at(-1)!.principal.views[0]!.reach),[GP1],'a write asks first: she left GP3');
    assert.equal((await db.query(`SELECT state FROM chat_memberships WHERE chat_id=$1 AND account_id=$2`,[GP3,MEMBER_GP_ACCOUNT])).rows[0].state,'left');
    await db.query(`UPDATE chat_memberships SET state='in',checked_at=now() WHERE chat_id=$1 AND account_id=$2`,[GP3,MEMBER_GP_ACCOUNT]);
    status=()=>({state:'done',status:'in'});

    // Anyone who is not an active member now: one answer, before any task is read.
    await refused('/me',launch(BOB),403,'member_app_closed');
    await refused('/tasks?project='+P1,launch(BOB),403,'member_app_closed');
    await refused('/me',launch(OWNER),403,'member_required');
    await refused('/me',launch('999001'),403,'member_app_closed');
    // Paused in the middle of a sequence: the next call is refused; un-paused, a launch from before is too old.
    const before=launch(MEMBER_GP,120);
    assert.equal((await ask('/reminders',before)).status,200);
    await members.change(admin,MEMBER_GP_ID,{operation_id:'pause',changes:{state:'paused'}});
    await refused('/reminders',before,403,'member_app_closed');
    await refused('/tasks',before,403,'member_app_closed',{operation_id:'o2',project:P1,title:'x'});
    const since=(await db.query('SELECT app_since FROM members WHERE id=$1',[MEMBER_GP_ID])).rows[0].app_since as Date;
    await members.change(admin,MEMBER_GP_ID,{operation_id:'other change while paused',changes:{tools:false}});
    assert.equal((await db.query('SELECT app_since FROM members WHERE id=$1',[MEMBER_GP_ID])).rows[0].app_since.getTime(),since.getTime(),'only an un-pause moves it');
    await members.change(admin,MEMBER_GP_ID,{operation_id:'resume',changes:{state:'active'}});
    assert.ok((await db.query('SELECT app_since FROM members WHERE id=$1',[MEMBER_GP_ID])).rows[0].app_since>since);
    await refused('/reminders',before,401,'member_app_launch_old');
    assert.equal((await ask('/reminders',launch(MEMBER_GP,30))).status,200,'within the minute of slack');
    assert.equal((await ask('/reminders',launch(MEMBER_GP,5))).status,200,'a new launch works');

    // Sign-out ends every launch opened before it, on every phone: one opened earlier, and one another phone opened after
    // the signing launch (D13). A launch opened after the sign-out signs in again.
    await db.query(`UPDATE members SET app_since=now()-interval '1 day' WHERE id=$1`,[MEMBER_GP_ID]);
    const signing=launch(MEMBER_GP,1200),older=launch(MEMBER_GP,1500),otherPhone=launch(MEMBER_GP,600);
    assert.equal((await ask('/reminders',otherPhone)).status,200);
    assert.deepEqual(await ask('/sign-out',signing,{}),{status:200,body:{}});
    await refused('/me',signing,401,'member_app_signed_out');
    await refused('/reminders',older,401,'member_app_signed_out');
    await refused('/reminders',otherPhone,401,'member_app_signed_out');
    assert.deepEqual(await ask('/sign-out',launch(MEMBER_GP,1800),{}),{status:401,body:{error:'member_app_signed_out'}},'an older launch cannot sign out again');
    const signedOut=(await db.query('SELECT signed_out_auth_date FROM member_app_prefs WHERE member_id=$1',[MEMBER_GP_ID])).rows[0].signed_out_auth_date as Date;
    assert.ok(Math.abs(signedOut.getTime()/1000-(seconds()-60))<=5,'stored as now less the minute of slack');
    const fresh=launch(MEMBER_GP,0);
    assert.equal((await ask('/reminders',fresh)).status,200);

    // English only (Q2): there is no language choice, so no prefs route.
    assert.equal((await ask('/prefs',fresh,{language:'en'})).status,404);
    assert.ok(!('prefs' in (await ask('/me',fresh)).body));

    // Reminders follow the Tasks permission, Reminders to themselves and her open private chat; the app stays open (Q3).
    const reasons=async()=>(await ask('/me',fresh)).body.reminders;
    await members.change(admin,MEMBER_GP_ID,{operation_id:'reminders off',changes:{reminders:false}});
    assert.deepEqual(await reasons(),{available:false,reason:'reminders_off'});
    await members.change(admin,MEMBER_GP_ID,{operation_id:'private off',changes:{reminders:true,private_chat:false}});
    assert.deepEqual(await reasons(),{available:false,reason:'private_chat_off'});
    assert.equal((await ask('/tasks?project='+P1,fresh)).status,200);assert.equal(principals.at(-1)!.principal.chat,null);
    await members.change(admin,MEMBER_GP_ID,{operation_id:'read only',changes:{private_chat:true,tasks:'read'}});
    assert.deepEqual(await reasons(),{available:false,reason:'read_only'});
    await refused('/tasks',fresh,403,'task_read_only',{operation_id:'o3',project:P1,title:'x'});
    await refused('/tasks/'+digest('app-server:one')+'/comments',fresh,403,'task_read_only',{operation_id:'o4',text:'hi'});
    assert.equal((await ask('/tasks/'+digest('app-server:one'),fresh)).status,200,'reading still works');
    await members.change(admin,MEMBER_GP_ID,{operation_id:'write again',changes:{tasks:'write'}});

    // The write limit: at most 60 in ten minutes and 500 in a UTC day, counted before the repository is called.
    await db.query(`DELETE FROM member_app_limits`);
    const write=()=>ask('/tasks/'+digest('app-server:one')+'/comments',fresh,{operation_id:'o5',text:'hi'});
    assert.equal((await write()).status,200);
    assert.deepEqual((await db.query('SELECT window_writes,day_writes FROM member_app_limits WHERE member_id=$1',[MEMBER_GP_ID])).rows[0],{window_writes:1,day_writes:1});
    await db.query('UPDATE member_app_limits SET window_writes=$2 WHERE member_id=$1',[MEMBER_GP_ID,MEMBER_APP_WRITES_PER_10_MIN]);
    await refused('/tasks/'+digest('app-server:one')+'/comments',fresh,429,'member_app_busy',{operation_id:'o6',text:'hi'});
    await db.query(`UPDATE member_app_limits SET window_start=now()-interval '11 minutes' WHERE member_id=$1`,[MEMBER_GP_ID]);
    assert.equal((await write()).status,200,'a new window');
    await db.query('UPDATE member_app_limits SET day_writes=$2 WHERE member_id=$1',[MEMBER_GP_ID,MEMBER_APP_WRITES_PER_DAY]);
    await refused('/tasks',fresh,429,'member_app_busy',{operation_id:'o7',project:P1,title:'x'});
    await db.query(`UPDATE member_app_limits SET day=day-1 WHERE member_id=$1`,[MEMBER_GP_ID]);
    assert.equal((await write()).status,200,'a new day');

    // Removed: the next call is refused, and re-adding her kills every launch from before.
    await members.remove(admin,MEMBER_GP_ID,{operation_id:'remove'});
    await refused('/me',fresh,403,'member_app_closed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM member_app_prefs WHERE member_id=$1',[MEMBER_GP_ID])).rows[0].n,0,'her sign-out went with her');
    await members.add(admin,{operation_id:'re-add',account_id:null,telegram_id:MEMBER_GP,groups:{[GP1]:true}});
    const old=launch(MEMBER_GP,90);
    await refused('/me',old,401,'member_app_launch_old');
    assert.equal((await ask('/me',launch(MEMBER_GP,0))).status,200);

    // The other family: Nils, in NG1 and NG2, both in no project; his private chat has a digest id.
    await db.query(`UPDATE chat_memberships SET checked_at=NULL WHERE account_id=$1`,[MEMBER_NG_ACCOUNT]);forgetMemberAppRechecks();asked.length=0;
    const nils=await ask('/me',launch(MEMBER_NG,0,'Nils'));
    assert.deepEqual(asked.map(item=>item.chat_id).sort(),[NG1_TG,NG2_TG].sort(),'each by its current Telegram id');
    assert.deepEqual(nils.body.groups.map((group:{id:string;board:string;project:string|null})=>[group.id,group.board,group.project]).sort(),[[NG1,'none',null],[NG2,'none',null]].sort());
    assert.deepEqual([nils.body.projects,nils.body.name,nils.body.reminders],[[],'Nils',{available:true}]);
    assert.equal((await ask('/tasks?project='+P1,launch(MEMBER_NG,0,'Nils'))).status,200);
    assert.deepEqual([principals.at(-1)!.principal.member,principals.at(-1)!.principal.chat,principals.at(-1)!.principal.views],[MEMBER_NG_ID,MEMBER_NG_CHAT,[]]);
    // A member with private chat off and never in a group: the app opens, empty, with reminders unavailable.
    const gita=await ask('/me',launch(MEMBER_GP_OFF,0,'Gita'));
    assert.deepEqual(gita.body,{name:'Gita',mode:'write',reminders:{available:false,reason:'private_chat_off'},projects:[],groups:[]});
    // An account that is linked to nobody, and an owner's private chat that is unknown: closed.
    await db.query('UPDATE chat_accounts SET member_id=NULL WHERE id=$1',[MEMBER_NG_ACCOUNT]);
    await refused('/me',launch(MEMBER_NG,0,'Nils'),403,'member_app_closed');
    policy.owner_chat='-1009999999999';
    await refused('/me',launch(MEMBER_GP_OFF,0,'Gita'),403,'member_app_closed');
    policy.owner_chat=OWNER;
  } finally {
    restore();for(const server of servers)server.close();
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);
  }
});
