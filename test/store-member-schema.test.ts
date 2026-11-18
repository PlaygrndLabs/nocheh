import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {chatIdFor,connectionIdFor,installChatsForTest} from '../src/chats.js';
import {memberDirectory,type MemberAccountRow,type MemberChatRow,type MemberPresenceRow,type MemberRow} from '../src/members.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {bumpMemberRevision} from '../src/stores/member-schema.js';
import {OwnerCommands} from '../src/stores/owner-commands.js';
import {BOB_ACCOUNT,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,NG1,NG1_TOPIC,NG2,NG_GROUP_IDS,
  OWNER_ACCOUNT,UNSERVED,fixtureChats,fixtureDirectory,fixtureMemberDirectory,seedChats,seedMembers} from './fixture-groups.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
const owner:Reader={admin:true,scope:null};
async function open() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  return {config,passwords,stores:connectStores(config,passwords)};
}
/** The schema and every member and chat-account row, as digests, to show a second bootstrap changes nothing. */
async function fingerprint(db:pg.Pool) {
  const schema=(await db.query(`SELECT md5(string_agg(x,'|' ORDER BY x)) AS sum FROM (
    SELECT table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') AS x FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT tablename||':'||indexname||':'||indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT event_object_table||':'||trigger_name||':'||action_timing||':'||event_manipulation FROM information_schema.triggers WHERE trigger_schema='public') s`)).rows[0].sum;
  const rows:Record<string,string>={};
  for(const name of ['members','member_chats','member_directory_state','member_turns','chat_accounts','chat_memberships'])
    rows[name]=(await db.query(`SELECT count(*)::text||':'||coalesce(md5(string_agg(t::text,'|' ORDER BY t::text)),'') AS sum FROM ${pg.escapeIdentifier(name)} t`)).rows[0].sum;
  return {schema,rows};
}
/** The member directory as the loader (src/stores/members.ts) reads it: members, linked accounts, switches, the newest
 * Telegram row of each member account in each group, and the daily cap. */
async function load(db:pg.Pool) {
  const members=(await db.query<MemberRow>('SELECT id,state,group_talk,group_jobs,group_post_other,group_tools,tasks FROM members')).rows;
  const accounts=(await db.query<MemberAccountRow>('SELECT id AS account_id,member_id FROM chat_accounts WHERE member_id IS NOT NULL')).rows;
  const chats=(await db.query<MemberChatRow>('SELECT member_id,chat_id,enabled FROM member_chats')).rows;
  const presence=(await db.query<MemberPresenceRow>(`SELECT m.account_id,m.chat_id,m.state FROM chat_memberships m JOIN chat_accounts a ON a.id=m.account_id
    JOIN chats c ON c.id=m.chat_id WHERE a.member_id IS NOT NULL AND c.kind='group'`)).rows;
  const state=(await db.query('SELECT revision,daily_messages FROM member_directory_state WHERE singleton')).rows[0];
  return memberDirectory({members,accounts,chats,presence,owner_account:OWNER_ACCOUNT,revision:Number(state.revision),daily_messages:state.daily_messages});
}
const answers=(directory:ReturnType<typeof memberDirectory>,chats:ReturnType<typeof fixtureDirectory>)=>
  [MEMBER_GP_ACCOUNT,MEMBER_NG_ACCOUNT,OWNER_ACCOUNT,BOB_ACCOUNT].flatMap(account=>[GP1,GP1_TOPIC,GP2,GP3,GP4,UNSERVED,NG1,NG1_TOPIC,NG2,BOB_CHAT].map(chat=>
    [account,chat,directory.talks(account,chat,chats),directory.may(account,chat,'post',chats),directory.reaches(account,chat,null,chats),directory.tasks(account)]));

test('the member tables bootstrap with the control store, hold both fixture families, and a second bootstrap changes nothing',fixture,async()=>{
  const {config,passwords,stores}=await open(),db=stores.control;
  try {
    await seedChats(db,fixtureChats(served));
    assert.deepEqual((await db.query('SELECT revision,carried_at,daily_messages FROM member_directory_state')).rows,[{revision:'0',carried_at:null,daily_messages:200}]);
    await seedMembers(db);await seedMembers(db);
    // The fixture rows, read back as the loader reads them, answer as the fixture directory does.
    const chats=fixtureDirectory(served);
    assert.deepEqual(answers(await load(db),chats),answers(fixtureMemberDirectory(),chats));
    assert.deepEqual([...(await load(db)).accounts(chats)].sort(),[...fixtureMemberDirectory().accounts(chats)].sort());

    const before=await fingerprint(db);
    await initializeStoreDatabases(config,passwords);
    assert.deepEqual(await fingerprint(db),before,'the second bootstrap leaves the schema and every member row as they were');
    const foreign=(await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='chat_accounts'::regclass AND conname='chat_accounts_member_id_fkey'`)).rows;
    assert.deepEqual(foreign,[{def:'FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL'}]);
    assert.equal((await db.query(`SELECT count(*) FROM pg_indexes WHERE tablename='chat_accounts' AND indexname='chat_accounts_member'`)).rows[0].count,'1');

    await bumpMemberRevision(db);
    assert.equal((await load(db)).revision,1,'the revision the loader compares');
    // A process that reads the rows with the chat directory installed answers the same without the argument.
    const restore=installChatsForTest(chats);
    try{assert.equal((await load(db)).reaches(MEMBER_NG_ACCOUNT,NG2),true);}finally{restore();}
  } finally{await stores.close();}
});

test('the member tables keep their own rules: ids, states, group-only switches, the cap\'s bounds, cascades and unlinking',fixture,async()=>{
  const {stores}=await open(),db=stores.control;
  try {
    await seedChats(db,fixtureChats(served));await seedMembers(db);
    const member=(id:string,extra='')=>db.query(`INSERT INTO members(id${extra?',state':''}) VALUES($1${extra?',$2':''})`,extra?[id,extra]:[id]);
    await assert.rejects(member('not-a-digest'),{code:'23514'});
    await assert.rejects(member(digest('fixture:member:x'),'removed'),{code:'23514'},'active or paused only');
    await assert.rejects(db.query(`INSERT INTO members(id,tasks) VALUES($1,'none')`,[digest('fixture:member:y')]),{code:'23514'},'write or read only');
    const defaults=(await db.query('SELECT state,group_talk,group_jobs,group_post_other,group_tools,tasks,revision FROM members WHERE id=$1',[MEMBER_GP_ID])).rows[0];
    assert.deepEqual(defaults,{state:'active',group_talk:true,group_jobs:true,group_post_other:true,group_tools:true,tasks:'write',revision:1});
    // A member's switch is for a group: never a topic, a private chat or a chat with no row.
    for(const chat of [GP1_TOPIC,NG1_TOPIC,BOB_CHAT])
      await assert.rejects(db.query('INSERT INTO member_chats(member_id,chat_id) VALUES($1,$2)',[MEMBER_NG_ID,chat]),{code:'23514'},chat);
    await assert.rejects(db.query('INSERT INTO member_chats(member_id,chat_id) VALUES($1,$2)',[MEMBER_NG_ID,chatIdFor('telegram','-1002000000099')]),{code:'23514'});
    await assert.rejects(db.query('UPDATE member_chats SET chat_id=$2 WHERE member_id=$1 AND chat_id=$3',[MEMBER_GP_ID,GP1_TOPIC,GP1]),{code:'23514'},'nor moved to one');
    await assert.rejects(db.query('INSERT INTO member_chats(member_id,chat_id) VALUES($1,$2)',[digest('fixture:member:z'),GP4]),{code:'23503'},'a known member');
    await assert.rejects(db.query('UPDATE chat_accounts SET member_id=$2 WHERE id=$1',[BOB_ACCOUNT,digest('fixture:member:z')]),{code:'23503'},'an account links to a member');
    await assert.rejects(db.query('UPDATE member_directory_state SET daily_messages=0'),{code:'23514'});
    await assert.rejects(db.query('UPDATE member_directory_state SET daily_messages=10001'),{code:'23514'});
    await db.query('UPDATE member_directory_state SET daily_messages=10000');
    await assert.rejects(db.query(`INSERT INTO member_directory_state(singleton) VALUES(false)`),{code:'23514'},'one row');
    await assert.rejects(db.query(`INSERT INTO member_turns(member_id,event_id,day) VALUES($1,'not-an-event',current_date)`,[MEMBER_GP_ID]),{code:'23514'});
    const event=digest('fixture:event:1');
    await db.query(`INSERT INTO member_turns(member_id,event_id,day) VALUES($1,$2,current_date)`,[MEMBER_GP_ID,event]);
    await assert.rejects(db.query(`INSERT INTO member_turns(member_id,event_id,day) VALUES($1,$2,current_date)`,[MEMBER_GP_ID,event]),{code:'23505'},
      'one row per member and event, so a retry counts once');
    // The new asker and authority columns.
    for(const table of ['telegram_action_requests','controlled_actions'])
      assert.deepEqual((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name IN ('asker_account','authority') ORDER BY 1`,[table])).rows
        .map(row=>row.column_name),['asker_account','authority'],table);
    const checks=(await db.query(`SELECT conrelid::regclass::text AS t,pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('telegram_action_requests'::regclass,'controlled_actions'::regclass) AND pg_get_constraintdef(oid) ~ '(asker_account|authority = ANY|authority =)'`)).rows
      .map(row=>row.t+': '+row.def).sort();
    assert.ok(checks.some(check=>check.startsWith('controlled_actions:')&&check.includes('group_tools')),checks.join('\n'));
    assert.equal(checks.filter(check=>check.includes('asker_account')).length,2,checks.join('\n'));

    // A topic row of a removed chat goes with it; a member removed takes its switches and turns, and unlinks its accounts.
    const extra=chatIdFor('telegram','-1002000000088');
    await db.query(`INSERT INTO chats(id,connection_id,kind,state) VALUES($1,$2,'group','active')`,[extra,connectionIdFor('telegram')]);
    await db.query('INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,false)',[MEMBER_NG_ID,extra]);
    await db.query('DELETE FROM chats WHERE id=$1',[extra]);
    assert.equal((await db.query('SELECT count(*) FROM member_chats WHERE chat_id=$1',[extra])).rows[0].count,'0','a chat removed takes its switches with it');
    await db.query('DELETE FROM members WHERE id=$1',[MEMBER_GP_ID]);
    assert.deepEqual((await db.query('SELECT member_id FROM chat_accounts WHERE id=$1',[MEMBER_GP_ACCOUNT])).rows,[{member_id:null}],'the account stays, unlinked');
    assert.equal((await db.query('SELECT count(*) FROM member_chats WHERE member_id=$1',[MEMBER_GP_ID])).rows[0].count,'0');
    assert.equal((await db.query('SELECT count(*) FROM member_turns WHERE member_id=$1',[MEMBER_GP_ID])).rows[0].count,'0');
    assert.equal((await db.query('SELECT count(*) FROM chat_memberships WHERE account_id=$1',[MEMBER_GP_ACCOUNT])).rows[0].count,'4','Telegram\'s rows stay');
    const left=await load(db),chats=fixtureDirectory(served);
    assert.equal(left.memberOf(MEMBER_GP_ACCOUNT),null);assert.equal(left.talks(MEMBER_GP_ACCOUNT,GP1,chats),false);
    assert.equal(left.talks(MEMBER_NG_ACCOUNT,NG1,chats),true);
  } finally{await stores.close();}
});

test('a member command moves no guard epoch, requests no refresh, holds no memory, and stays idempotent with its conflict',fixture,async()=>{
  const {stores}=await open(),db=stores.control,commands=new OwnerCommands(db);
  try {
    await seedChats(db,fixtureChats(served));await seedMembers(db);
    const state=async()=>({epoch:Number((await db.query('SELECT epoch FROM guard_state WHERE singleton')).rows[0].epoch),
      refreshes:Number((await db.query(`SELECT count(*) FROM workflow_registry WHERE family IN ('honcho','memory_review')`)).rows[0].count)});
    const revision=async()=>Number((await db.query('SELECT revision FROM member_directory_state')).rows[0].revision);
    const before=await state(),first=await revision();let runs=0;
    const pause=(client:pg.PoolClient)=>{runs++;return client.query(`UPDATE members SET state='paused',revision=revision+1,updated_at=now() WHERE id=$1`,[MEMBER_NG_ID])
      .then(()=>bumpMemberRevision(client)).then(()=>({id:MEMBER_NG_ID,state:'paused'}));};
    const request={kind:'member_change',id:MEMBER_NG_ID,changes:{state:'paused'}};
    assert.deepEqual(await commands.run(owner,'member-op-1',request,pause,{epoch:false}),{id:MEMBER_NG_ID,state:'paused'});
    assert.deepEqual(await state(),before,'the same guard epoch, and no Honcho or memory review refresh');
    assert.deepEqual((await db.query('SELECT epoch::int AS epoch,holds_memory,result FROM owner_commands WHERE id=$1',[`member-op-1`])).rows,
      [{epoch:before.epoch,holds_memory:false,result:{id:MEMBER_NG_ID,state:'paused'}}],'the receipt keeps the current epoch');
    assert.equal(await revision(),first+1,'the command moved the member revision');
    // The same command again returns its receipt and changes nothing; another request under its id is a conflict.
    assert.deepEqual(await commands.run(owner,'member-op-1',request,pause,{epoch:false}),{id:MEMBER_NG_ID,state:'paused'});
    assert.equal(runs,1);assert.equal(await revision(),first+1);
    await assert.rejects(commands.run(owner,'member-op-1',{...request,changes:{state:'active'}},pause,{epoch:false}),{code:'owner_command_conflict'});
    await assert.rejects(commands.run({admin:false,scope:null},'member-op-2',request,pause,{epoch:false}),{code:'owner_required'});
    await assert.rejects(commands.run(owner,' ',request,pause,{epoch:false}),{code:'operation_id_required'});
    // A change that throws leaves nothing behind.
    await assert.rejects(commands.run(owner,'member-op-3',{kind:'x'},async client=>{await bumpMemberRevision(client);throw Error('refused');},{epoch:false}),{message:'refused'});
    assert.equal(await revision(),first+1);
    assert.equal((await db.query(`SELECT count(*) FROM owner_commands WHERE id='member-op-3'`)).rows[0].count,'0');
    assert.equal(runs,1);
    // Every other owner command still moves the epoch and requests the refreshes.
    await commands.run(owner,'policy-op-1',{kind:'policy'},async()=>({}));
    const after=await state();
    assert.equal(after.epoch,before.epoch+1);assert.ok(after.refreshes>before.refreshes);
    assert.deepEqual((await db.query(`SELECT holds_memory FROM owner_commands WHERE id='policy-op-1'`)).rows,[{holds_memory:true}]);
  } finally{await stores.close();}
});
