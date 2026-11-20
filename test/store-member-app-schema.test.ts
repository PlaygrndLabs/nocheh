import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {installChatsForTest} from '../src/chats.js';
import {inReadSet,readSetGroups} from '../src/spaces.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MEMBER_READ_STALE_DAYS,MEMBER_RECHECK_HOURS,joinedGroups,memberReads} from '../src/stores/member-reads.js';
import {memberTaskViews} from '../src/stores/member-task-views.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_APP_HIDDEN,MEMBER_APP_REACH,MEMBER_APP_SWITCHES,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,
  MEMBER_GP_OFF_ID,MEMBER_NG_ID,NG1,NG2,NG_GROUP_IDS,OWNER,P1,UNSERVED,fixtureChats,fixtureDirectory,memberAppMembers,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// The members' app schema and shared reads (step 5, ADR-0265): what P0 adds to the control store, bootstrapped twice
// and over a store from before it, and joinedGroups and memberTaskViews, which the members' app and the member's
// private chat both read through.

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
async function open() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords);
  // The default members: Mira's GP3 is switched on in the test that needs it, and off again after, since the store is
  // shared with the other store tests.
  await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control);await seedGroups(stores.control);
  return {config,passwords,stores};
}
const origins=async(db:pg.Pool,table:string)=>(await db.query(`SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid=$1::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%origin%'`,[table])).rows as {conname:string;def:string}[];
const task=(name:string)=>digest('member-app-schema:'+name);

test('the members\' app columns and tables bootstrap, cascade with their member, and old origin checks gain \'app\'',fixture,async()=>{
  const {config,passwords,stores}=await open(),db=stores.control;
  try {
    const member=(await db.query('SELECT reminders,app_since FROM members WHERE id=$1',[MEMBER_GP_ID])).rows[0];
    assert.equal(member.reminders,true,'Reminders to themselves is on by default');assert.ok(member.app_since instanceof Date);
    assert.equal((await db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='members' AND column_name='app_since'`)).rows[0].is_nullable,'NO');
    // A store from before step 5: each origin check without 'app', under the name Postgres gave it.
    // Startup runs the control schema as the store's owner role, and so does this change back.
    const older=new pg.Client({...config,database:'nocheh_control'});await older.connect();
    try {
      await older.query('BEGIN');await older.query('SET LOCAL ROLE nocheh_control_owner');
      for(const [table,values] of [['owner_tasks',"'dashboard','chat','repeat'"],['owner_task_comments',"'dashboard','chat'"],['owner_task_activity',"'dashboard','chat','repeat','reminder'"]] as const) {
        for(const row of await origins(db,table))await older.query(`ALTER TABLE ${table} DROP CONSTRAINT ${pg.escapeIdentifier(row.conname)}`);
        await older.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_origin_check CHECK(origin IN (${values}))`);
      }
      await older.query('COMMIT');
    } finally{await older.query('ROLLBACK').catch(()=>{});await older.end();}
    await assert.rejects(db.query(`INSERT INTO owner_tasks(id,title,status_id,origin) VALUES($1,'Old store','todo','app')`,[task('old')]),{code:'23514'});
    await initializeStoreDatabases(config,passwords);await initializeStoreDatabases(config,passwords);
    for(const table of ['owner_tasks','owner_task_comments','owner_task_activity']) {
      const checks=await origins(db,table);
      assert.equal(checks.length,1,table+': one origin check');assert.match(checks[0]!.def,/'app'/,table);
    }
    // Origin 'app' on a task, a comment and a history entry; a made-up origin still fails.
    const id=task('app');
    await db.query(`INSERT INTO owner_tasks(id,title,status_id,origin,project_id,created_by_account) VALUES($1,'From the app','todo','app',$2,$3)`,[id,P1,MEMBER_GP_ACCOUNT]);
    await db.query(`INSERT INTO owner_task_comments(id,task_id,body,author,origin) VALUES($1,$2,'Hi','{"kind":"member","name":"Mira"}','app')`,[task('comment'),id]);
    await db.query(`INSERT INTO owner_task_activity(task_id,actor,origin,changes) VALUES($1,'{"kind":"member"}','app','{}')`,[id]);
    await assert.rejects(db.query(`INSERT INTO owner_tasks(id,title,status_id,origin) VALUES($1,'Bad','todo','phone')`,[task('bad')]),{code:'23514'});
    await assert.rejects(db.query(`UPDATE owner_tasks SET created_by_account='Mira' WHERE id=$1`,[id]),{code:'23514'},'an account id, never a name');

    // A reminder set in the app names its setter's account and no chat or group; one set in a chat still needs its chat.
    const reminder=(name:string,columns:Record<string,unknown>)=>{
      const keys=Object.keys(columns),values=Object.values(columns);
      return db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,${keys.join(',')}) VALUES($1,$2,now()+interval '1 day',${keys.map((_,i)=>'$'+(i+3)).join(',')})`,
        [task('reminder:'+name),id,...values]);
    };
    const person={set_by:'person',set_by_account_id:MEMBER_GP_ACCOUNT,set_by_name:'Mira'};
    await reminder('app',{...person,set_via:'app'});
    await reminder('chat',{...person,set_in_chat_id:GP1,set_in_group_id:GP1});
    assert.equal((await db.query('SELECT set_via FROM owner_task_reminders WHERE id=$1',[task('reminder:chat')])).rows[0].set_via,'chat','chat by default');
    await reminder('owner',{set_by:'owner'});
    for(const [name,columns] of [['app with a chat',{...person,set_via:'app',set_in_chat_id:GP1,set_in_group_id:GP1}],['app with no account',{set_by:'person',set_by_name:'Mira',set_via:'app'}],
      ['app by the owner',{set_by:'owner',set_via:'app'}],['chat without a chat',{...person}],['another place',{...person,set_via:'phone'}],
      ['a delivery chat that is not a chat',{...person,set_via:'app',deliver_chat:'not a chat'}],['a digest that is not one',{...person,set_via:'app',notice_digest:'abc'}]] as const)
      await assert.rejects(reminder(name,columns),{code:'23514'},name);
    await db.query('UPDATE owner_task_reminders SET deliver_chat=$2,notice_digest=$3 WHERE id=$1',[task('reminder:app'),MEMBER_GP_CHAT,digest('text')]);
    // A writer in the app: no chat or group; in a chat: both.
    await db.query(`INSERT INTO owner_task_writers(task_id,field,by,account_id,name,via) VALUES($1,'title','person',$2,'Mira','app')`,[id,MEMBER_GP_ACCOUNT]);
    await db.query(`INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id) VALUES($1,'notes','person',$2,'Mira',$3,$3)`,[id,MEMBER_GP_ACCOUNT,GP1]);
    for(const [field,sql,values] of [['due',`INSERT INTO owner_task_writers(task_id,field,by,account_id,via,chat_id,group_id) VALUES($1,'due','person',$2,'app',$3,$3)`,[id,MEMBER_GP_ACCOUNT,GP1]],
      ['due',`INSERT INTO owner_task_writers(task_id,field,by,via) VALUES($1,'due','owner','app')`,[id]],
      ['due',`INSERT INTO owner_task_writers(task_id,field,by,account_id) VALUES($1,'due','person',$2)`,[id,MEMBER_GP_ACCOUNT]]] as const)
      await assert.rejects(db.query(sql,[...values]),{code:'23514'},field+' '+sql);

    // Prefs and limits: one row per member, no language (English only, Q2), gone with their member.
    await db.query(`INSERT INTO member_app_prefs(member_id,signed_out_auth_date) VALUES($1,now())`,[MEMBER_GP_OFF_ID]);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='member_app_prefs' AND column_name='language'`)).rows[0].n,0);
    await db.query(`INSERT INTO member_app_limits(member_id,window_writes,day_writes) VALUES($1,1,1)`,[MEMBER_GP_OFF_ID]);
    await assert.rejects(db.query(`INSERT INTO member_app_limits(member_id,day_writes) VALUES($1,-1)`,[MEMBER_NG_ID]),{code:'23514'});
    await assert.rejects(db.query(`INSERT INTO member_app_prefs(member_id) VALUES($1)`,[digest('nobody')]),{code:'23503'});
    await db.query('UPDATE chat_accounts SET member_id=NULL WHERE member_id=$1',[MEMBER_GP_OFF_ID]);
    await db.query('DELETE FROM members WHERE id=$1',[MEMBER_GP_OFF_ID]);
    for(const table of ['member_app_prefs','member_app_limits'])
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE member_id=$1`,[MEMBER_GP_OFF_ID])).rows[0].n,0,table);
  } finally {
    await stores.control.query(`DELETE FROM owner_tasks WHERE id=$1`,[task('app')]).catch(()=>{});
    await seedMembers(stores.control);
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);
  }
});

test('joinedGroups reads the groups a member is in now, fresh within the hours asked; memberReads reads the same and memberTaskViews one board each',fixture,async()=>{
  const {stores}=await open(),db=stores.control,restore=installChatsForTest(fixtureDirectory(served));
  const confirmed=(chat:string,hours:number)=>db.query(`UPDATE chat_memberships SET checked_at=now()-make_interval(secs=>$3::double precision*3600) WHERE chat_id=$1 AND account_id=$2`,
    [chat,MEMBER_GP_ACCOUNT,hours]);
  const chatsOf=(groups:readonly {chat:string}[])=>groups.map(group=>group.chat);
  try {
    // Mira with GP3 on (MEMBER_APP_SWITCHES): in GP1 and GP3, left GP2, in UNSERVED (not served), never seen in GP4.
    assert.deepEqual(memberAppMembers().chats.filter(row=>row.member_id===MEMBER_GP_ID).map(row=>[row.chat_id,row.enabled]),[[GP1,true],[GP2,true],[GP3,true]]);
    await db.query('UPDATE member_chats SET enabled=$3 WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3,MEMBER_APP_SWITCHES[MEMBER_GP_ID]![GP3]]);
    for(const chat of [GP1,GP2,GP3,UNSERVED])await confirmed(chat,1);
    assert.deepEqual(chatsOf(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})),[...MEMBER_APP_REACH].sort());
    assert.ok(!chatsOf(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})).includes(MEMBER_APP_HIDDEN));
    assert.deepEqual((await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER,freshHours:MEMBER_RECHECK_HOURS})).map(group=>group.fresh),[true,true]);
    // GP1 confirmed 7 hours ago: still joined, no longer fresh for the app; with no confirmation at all, never fresh.
    await confirmed(GP1,MEMBER_RECHECK_HOURS+1);
    assert.deepEqual((await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER,freshHours:MEMBER_RECHECK_HOURS})).map(group=>[group.chat,group.fresh]),[[GP1,false],[GP3,true]].sort());
    assert.deepEqual((await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})).map(group=>group.fresh),[true,true],'within 30 days for the private chat');
    await db.query('UPDATE chat_memberships SET checked_at=NULL WHERE chat_id=$1 AND account_id=$2',[GP1,MEMBER_GP_ACCOUNT]);
    const never=(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})).find(group=>group.chat===GP1)!;
    assert.deepEqual([never.fresh,never.checked_at.getTime()],[false,0]);
    // memberReads splits the same groups by MEMBER_READ_STALE_DAYS, as before.
    await confirmed(GP1,MEMBER_READ_STALE_DAYS*24+1);
    const reads=await memberReads(db,MEMBER_GP_CHAT,OWNER);
    assert.deepEqual([chatsOf(reads!.groups),chatsOf(reads!.stale)],[[GP3],[GP1]]);
    await confirmed(GP1,1);
    // Fail closed: no owner's chat, a paused member, a malformed or unknown member, a switch turned off, a group no longer served.
    assert.deepEqual(await joinedGroups(db,MEMBER_GP_ID,{owner:null}),[]);
    for(const member of ['',MEMBER_GP_CHAT,digest('nobody')])assert.deepEqual(await joinedGroups(db,member,{owner:OWNER}),[],member);
    assert.deepEqual(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER,freshHours:-1}),[]);
    await db.query(`UPDATE members SET state='paused' WHERE id=$1`,[MEMBER_GP_ID]);
    assert.deepEqual(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER}),[]);
    await db.query(`UPDATE members SET state='active' WHERE id=$1`,[MEMBER_GP_ID]);
    await db.query('UPDATE member_chats SET enabled=false WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
    assert.deepEqual(chatsOf(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})),[GP1]);
    await db.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
    await db.query(`UPDATE chats SET state='off' WHERE id=$1`,[GP3]);
    assert.deepEqual(chatsOf(await joinedGroups(db,MEMBER_GP_ID,{owner:OWNER})),[GP1]);
    await db.query(`UPDATE chats SET state='active' WHERE id=$1`,[GP3]);
    // The other family: NG1 on and NG2 with no switch row, both in no project.
    await db.query(`UPDATE chat_memberships SET checked_at=now() WHERE chat_id=ANY($1::text[])`,[[NG1,NG2]]);
    assert.deepEqual(chatsOf(await joinedGroups(db,MEMBER_NG_ID,{owner:OWNER})),[NG1,NG2].sort());

    // memberTaskViews: P1 reaching GP1 and GP3, with GP1's topic when topics share their group's memory; none for groups in
    // no project or a project that is not active.
    const [view,...more]=await memberTaskViews(db,MEMBER_APP_REACH,'group');
    assert.equal(more.length,0);assert.deepEqual([view!.project,view!.name],[P1,'P1']);
    assert.deepEqual(readSetGroups(view!.reach).sort(),[...MEMBER_APP_REACH].sort());
    assert.ok(inReadSet(view!.reach,GP1_TOPIC),'topics share their group\'s tasks');assert.ok(!inReadSet(view!.reach,GP2),'never GP2');
    const [exact]=await memberTaskViews(db,MEMBER_APP_REACH,'topic');
    assert.ok(inReadSet(exact!.reach,GP1)&&!inReadSet(exact!.reach,GP1_TOPIC));
    assert.deepEqual(await memberTaskViews(db,[],'group'),[]);
    assert.deepEqual(await memberTaskViews(db,[GP4,NG1,NG2],'group'),[]);
    await db.query(`UPDATE projects SET state='archived' WHERE id=$1`,[P1]);
    assert.deepEqual(await memberTaskViews(db,MEMBER_APP_REACH,'group'),[]);
    await db.query(`UPDATE projects SET state='active' WHERE id=$1`,[P1]);
  } finally {
    restore();
    await db.query(`UPDATE members SET state='active' WHERE id=$1`,[MEMBER_GP_ID]);
    await db.query('UPDATE member_chats SET enabled=false WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
    await db.query(`UPDATE chats SET state='active' WHERE id=$1`,[GP3]);
    await db.query(`UPDATE projects SET state='active' WHERE id=$1`,[P1]);
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);
  }
});
