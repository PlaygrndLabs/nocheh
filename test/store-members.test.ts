import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {accountIdFor,connectionIdFor,installChatsForTest} from '../src/chats.js';
import {installMembersForTest,memberIdFor,members} from '../src/members.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {ChatRepository} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {Members,startMembers,type MemberDirectoryLoader} from '../src/stores/members.js';
import {BOB,BOB_ACCOUNT,BOB_CHAT,GP1,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,NG1,NG1_TG,NG2,
  NG_GROUP_IDS,OWNER,OWNER_ACCOUNT,UNSERVED,fixtureChats,fixtureDirectory,seedChats,seedMembers} from './fixture-groups.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served};
const owner:Reader={admin:true,scope:null};
async function open() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  return connectStores(config,passwords);
}
/** Both fixture families with their chats; the member directory loads from the store, as nocheh-app's does. */
async function setup(db:pg.Pool) {
  const chats=installChatsForTest(fixtureDirectory(served)),back=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  await seedChats(db,fixtureChats(served));
  let loader:MemberDirectoryLoader|null=null;
  return {start:async()=>{loader=await startMembers(db,()=>policy);},restore:()=>{loader?.stop();back();chats();}};
}
/** A Telegram account (human unless `kind` says bot) and Telegram's newest rows for it in some groups. */
async function person(db:pg.Pool,external:string,name:string|null,rows:readonly (readonly [string,'in'|'left'])[],kind:'human'|'bot'='human') {
  const account=accountIdFor('telegram',external);
  await db.query('INSERT INTO chat_accounts(id,connection_id,external_id,kind,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [account,connectionIdFor('telegram'),external,kind,name]);
  for(const [chat,state] of rows)await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source) VALUES($1,$2,$3,'message')`,[chat,account,state]);
  return account;
}
const ref=(chat_id:string,title:string,state='active')=>({chat_id,title,state});
const group=(chat_id:string,title:string,on:boolean,telegram:'in'|'left'|null,isNew=false,state='active')=>({...ref(chat_id,title,state),on,telegram,new:isNew});
const allOn={talk:true,jobs:true,post:true,tools:true,tasks:'write',private_chat:true,reminders:true,assistant:false};

test('the owner adds, changes and removes members and sets the daily cap: idempotent, no guard epoch, and the directory follows at once',fixture,async()=>{
  const stores=await open(),db=stores.control,{start,restore}=await setup(db);
  try {
    // Sam was seen in GP1 and has left GP2; Nia is in NG1. A bot, a proxy account and the owner are in GP1 too.
    const sam=await person(db,'801','Sam',[[GP1,'in'],[GP2,'left']]),nia=await person(db,'802','Nia',[[NG1,'in']]);
    const bot=await person(db,'803','Helper',[[GP1,'in']],'bot'),proxy=await person(db,'777000','Telegram',[[GP1,'in']],'bot');
    await person(db,OWNER,null,[[GP1,'in']]);
    await start();
    const repo=new Members(db,()=>policy);
    const state=async()=>({epoch:Number((await db.query('SELECT epoch FROM guard_state WHERE singleton')).rows[0].epoch),
      refreshes:Number((await db.query(`SELECT count(*) FROM workflow_registry WHERE family IN ('honcho','memory_review')`)).rows[0].count),
      revision:Number((await db.query('SELECT revision FROM member_directory_state WHERE singleton')).rows[0].revision)});
    const before=await state();

    // The list: every group Nocheh is in, no member yet, and the people seen there who are not the owner, a bot or a proxy.
    const empty=await repo.list(owner);
    assert.deepEqual(empty.groups,[ref(GP1,'GP1'),ref(GP2,'GP2'),ref(GP3,'GP3'),ref(GP4,'GP4'),ref(NG1,'NG1'),ref(NG2,'NG2'),ref(UNSERVED,'Unserved','off')]);
    assert.deepEqual([empty.members,empty.revision,empty.daily_messages],[[],before.revision,200]);
    assert.deepEqual(empty.people,[{account_id:nia,name:'Nia',username:null,telegram_id:'802',groups:[ref(NG1,'NG1')]},
      {account_id:sam,name:'Sam',username:null,telegram_id:'801',groups:[ref(GP1,'GP1')]}],'a group they left is not listed');
    await assert.rejects(repo.list({admin:false,scope:null}),{status:403});

    // Add a person seen in GP1, switched off in GP2: they talk in GP1 at once, not in GP2, and in GP3 (no row counts as on).
    const add={operation_id:'add-sam',account_id:sam,telegram_id:null,groups:{[GP1]:true,[GP2]:false}};
    const added=await repo.add(owner,add);
    assert.equal(added.revision,before.revision+1);
    const {added_at,...shown}=added.member;assert.ok(!Number.isNaN(Date.parse(added_at)));
    assert.deepEqual(shown,{id:memberIdFor(sam),account_id:sam,state:'active',name:'Sam',username:null,telegram_id:'801',owner_linked:false,permissions:allOn,
      groups:[group(GP1,'GP1',true,'in'),group(GP2,'GP2',false,'left')]});
    assert.deepEqual([GP1,GP2,GP3].map(chat=>members().talks(sam,chat)),[true,false,true],'the member talks at once, in this process');
    assert.deepEqual([GP1,GP3].map(chat=>members().reaches(sam,chat)),[true,false],'reaching a group still needs Telegram\'s row');
    assert.equal(members().revision,added.revision);
    // Idempotent by operation id; the same id with another request conflicts. No guard epoch, no Honcho or memory review.
    assert.deepEqual(await repo.add(owner,add),added);
    await assert.rejects(repo.add(owner,{...add,groups:{[GP1]:true}}),{status:409,code:'owner_command_conflict'});
    assert.deepEqual(await state(),{...before,revision:before.revision+1});
    assert.deepEqual((await db.query(`SELECT epoch::int AS epoch,holds_memory FROM owner_commands WHERE id='add-sam'`)).rows,[{epoch:before.epoch,holds_memory:false}]);
    await assert.rejects(repo.add({admin:false,scope:null},{...add,operation_id:'add-stranger'}),{status:403});

    // Rule 1: a person seen in groups can be switched on only where Telegram's newest row says 'in'.
    const by=(operation_id:string,account_id:string|null,telegram_id:string|null,groups:Record<string,boolean>)=>({operation_id,account_id,telegram_id,groups});
    await assert.rejects(repo.add(owner,by('add-nia-ng2',nia,null,{[NG1]:true,[NG2]:true})),{status:409,code:'member_group_not_seen'});
    await assert.rejects(repo.add(owner,by('add-sam-again',sam,null,{[GP1]:true})),{status:409,code:'member_exists'});
    await assert.rejects(repo.add(owner,by('add-nobody',digest('nobody'),null,{[GP1]:true})),{status:404,code:'member_account_not_found'});
    // The owner, a bot and a proxy account are never members, by account or by Telegram user id.
    for(const [name,account,external] of [['owner',OWNER_ACCOUNT,OWNER],['bot',bot,'803'],['proxy',proxy,'777000']] as const) {
      await assert.rejects(repo.add(owner,by('add-'+name,account,null,{[GP1]:true})),{status:400,code:'member_account_invalid'},name);
      await assert.rejects(repo.add(owner,by('add-id-'+name,null,external,{[GP1]:true})),{status:400,code:'member_account_invalid'},name);
    }
    await assert.rejects(repo.add(owner,by('add-proxy-new',null,'1087968824',{[GP1]:true})),{status:400,code:'member_account_invalid'});
    // Only groups Nocheh is in: a private chat or an unknown chat is refused.
    await assert.rejects(repo.add(owner,by('add-nia-private',nia,null,{[NG1]:true,[BOB_CHAT]:false})),{status:400,code:'member_group_invalid'});
    await assert.rejects(repo.add(owner,by('add-nia-unknown',nia,null,{[NG1]:true,[digest('no chat')]:false})),{status:400,code:'member_group_invalid'});
    assert.equal(Number((await db.query('SELECT count(*) FROM members')).rows[0].count),1,'a refused add writes nothing');
    assert.equal((await db.query(`SELECT 1 FROM chat_accounts WHERE external_id='1087968824'`)).rowCount,0);

    const ngAdded=await repo.add(owner,by('add-nia',nia,null,{[NG1]:true,[NG2]:false}));
    assert.deepEqual(ngAdded.member.groups,[group(NG1,'NG1',true,'in'),group(NG2,'NG2',false,null)]);
    assert.deepEqual([members().talks(nia,NG1),members().talks(nia,NG2)],[true,false]);

    // Add by Telegram user ID: the account is made, and any group Nocheh is in may be switched on.
    const fresh=accountIdFor('telegram','804');
    const freshAdded=await repo.add(owner,by('add-fresh',null,'804',{[GP3]:true,[NG2]:true}));
    assert.deepEqual([freshAdded.member.id,freshAdded.member.account_id,freshAdded.member.name,freshAdded.member.telegram_id],[memberIdFor(fresh),fresh,null,'804']);
    assert.deepEqual(freshAdded.member.groups,[group(GP3,'GP3',true,null),group(NG2,'NG2',true,null)]);
    assert.deepEqual((await db.query('SELECT kind,member_id FROM chat_accounts WHERE id=$1',[fresh])).rows,[{kind:'human',member_id:memberIdFor(fresh)}]);
    assert.deepEqual([members().talks(fresh,GP3),members().reaches(fresh,GP3)],[true,false]);
    await assert.rejects(repo.add(owner,by('add-fresh-again',null,'804',{[GP3]:true})),{status:409,code:'member_exists'});

    // Changes: an existing row switches either way, also where Telegram says they left; a new row switched on needs 'in'.
    const samId=memberIdFor(sam),change=(operation_id:string,id:string,changes:Record<string,unknown>)=>repo.change(owner,id,{operation_id,changes});
    const gp2=await change('sam-gp2-on',samId,{groups:{[GP2]:true}});
    assert.deepEqual(gp2.member.groups.find(item=>item.chat_id===GP2),group(GP2,'GP2',true,'left'));
    assert.deepEqual([members().talks(sam,GP2),members().reaches(sam,GP2)],[true,false]);
    await assert.rejects(change('sam-gp3-on',samId,{groups:{[GP3]:true}}),{status:409,code:'member_group_not_seen'});
    await assert.rejects(change('fresh-ng1-on',memberIdFor(fresh),{groups:{[NG1]:true}}),{status:409,code:'member_group_not_seen'});
    await change('sam-gp4-off',samId,{groups:{[GP4]:false}});
    assert.equal(members().talks(sam,GP4),false,'a new row switched off needs no Telegram row');
    await assert.rejects(change('sam-private',samId,{groups:{[BOB_CHAT]:false}}),{status:400,code:'member_group_invalid'});
    await assert.rejects(change('nobody',digest('nobody'),{state:'paused'}),{status:404,code:'member_not_found'});
    const paused=await change('sam-pause',samId,{state:'paused',tasks:'read',jobs:false});
    assert.deepEqual([paused.member.state,paused.member.permissions],['paused',{...allOn,jobs:false,tasks:'read'}]);
    assert.deepEqual([members().talks(sam,GP1),members().tasks(sam)],[false,'read'],'paused at once');
    assert.deepEqual(await change('sam-pause',samId,{state:'paused',tasks:'read',jobs:false}),paused);
    await assert.rejects(change('sam-pause',samId,{state:'active'}),{status:409,code:'owner_command_conflict'});
    await change('sam-resume',samId,{state:'active'});
    assert.equal(members().talks(sam,GP1),true);

    // The daily cap.
    const cap=await repo.settings(owner,{operation_id:'cap-50',daily_messages:50});
    assert.deepEqual([cap.daily_messages,members().dailyMessages,(await repo.list(owner)).daily_messages],[50,50,50]);
    assert.deepEqual(await repo.settings(owner,{operation_id:'cap-50',daily_messages:50}),cap);
    // Schedules per member (members' schedules): 5 by default, set alone, the daily cap kept.
    assert.equal(cap.member_schedules,5);
    const schedules=await repo.settings(owner,{operation_id:'schedules-3',member_schedules:3});
    assert.deepEqual([schedules.daily_messages,schedules.member_schedules,(await repo.list(owner)).member_schedules],[50,3,3]);
    // Personal assistant: off by default; on only with private chat on, as the directory reads it.
    const helped=await change('sam-assistant',samId,{assistant:true});
    assert.equal(helped.member.permissions.assistant,true);
    assert.equal(members().assistant(sam),true);
    await change('sam-assistant-private-off',samId,{private_chat:false});
    assert.equal(members().assistant(sam),false,'no assistant without private chat');
    await change('sam-assistant-back',samId,{private_chat:true,assistant:false});
    assert.equal(members().assistant(sam),false);

    // Remove: the member and its switches go, its account stays and is unlinked, and it talks nowhere at once.
    const removed=await repo.remove(owner,memberIdFor(fresh),{operation_id:'remove-fresh'});
    assert.equal(removed.removed,memberIdFor(fresh));assert.equal(removed.revision,(await state()).revision);
    assert.deepEqual([members().memberOf(fresh),members().talks(fresh,GP3)],[null,false]);
    assert.deepEqual((await db.query('SELECT member_id FROM chat_accounts WHERE id=$1',[fresh])).rows,[{member_id:null}]);
    assert.equal((await db.query('SELECT 1 FROM member_chats WHERE member_id=$1',[memberIdFor(fresh)])).rowCount,0);
    assert.deepEqual(await repo.remove(owner,memberIdFor(fresh),{operation_id:'remove-fresh'}),removed);
    await assert.rejects(repo.remove(owner,memberIdFor(fresh),{operation_id:'remove-fresh-again'}),{status:404,code:'member_not_found'});

    // Every command kept the guard epoch and asked for no refresh.
    const after=await state();assert.deepEqual([after.epoch,after.refreshes],[before.epoch,before.refreshes]);
    const listed=await repo.list(owner);
    assert.deepEqual(listed.members.map(item=>item.id),[samId,memberIdFor(nia)]);
    assert.deepEqual(listed.people,[],'members are not listed as people');
  } finally{restore();await stores.close();}
});

test('the list shows each member\'s groups with New here, and a member account\'s membership moves the revision while a stranger\'s does not',fixture,async()=>{
  const stores=await open(),db=stores.control,{start,restore}=await setup(db);
  try {
    await seedMembers(db);await start();
    const repo=new Members(db,()=>policy),list=await repo.list(owner);
    // The fixture's two members (the store is shared with the test before, whose members stay).
    const shown=list.members.filter(item=>[MEMBER_GP_ID,MEMBER_NG_ID].includes(item.id)).map(({added_at:_,...item})=>item)
      .sort((a,b)=>a.telegram_id!.localeCompare(b.telegram_id!));
    assert.deepEqual(shown,[
      {id:MEMBER_GP_ID,account_id:MEMBER_GP_ACCOUNT,state:'active',name:null,username:null,telegram_id:MEMBER_GP,owner_linked:false,permissions:allOn,
        groups:[group(GP1,'GP1',true,'in'),group(GP2,'GP2',true,'left'),group(GP3,'GP3',false,'in'),group(UNSERVED,'Unserved',true,'in',true,'off')]},
      {id:MEMBER_NG_ID,account_id:MEMBER_NG_ACCOUNT,state:'active',name:null,username:null,telegram_id:MEMBER_NG,owner_linked:false,permissions:allOn,
        groups:[group(NG1,'NG1',true,'in'),group(NG2,'NG2',true,'in',true)]},
    ],'a group Telegram says they are in with no row is New here, and counts as on');

    // Captured updates: Telegram's rows for a member account move the member revision and reload this process's directory.
    const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),db,undefined,new ChatRepository(stores,()=>policy));
    const base=Date.now();let n=0;
    const capture=async(chat:string,from:string,extra:Record<string,unknown>={})=>{n++;
      await coordinator.capture({version:1,key:'members:'+base+':'+n,origin:'live',kind:'telegram_update',bot_id:'777',scope:chat,source_id:String(n),revision:'1',
        occurred_at:null,text:null,payload:{update_id:base*100+n,message:{message_id:n,date:n,chat:{id:Number(chat),type:'supergroup'},from:{id:Number(from),first_name:'P'+from},
          ...extra}}} as Envelope);
    };
    const revision=async()=>Number((await db.query('SELECT revision FROM member_directory_state WHERE singleton')).rows[0].revision);
    const r0=await revision();
    await capture(GP1,BOB);
    assert.equal(await revision(),r0,'a stranger seen in a group moves no member revision');
    assert.deepEqual((await repo.list(owner)).people.map(item=>[item.account_id,item.groups.map(g=>g.chat_id)]),[[BOB_ACCOUNT,[GP1]]]);
    await capture(GP1,BOB,{left_chat_member:{id:Number(BOB),first_name:'P'+BOB}});
    assert.equal(await revision(),r0);
    assert.deepEqual((await repo.list(owner)).people,[]);

    await capture(GP1,MEMBER_GP,{left_chat_member:{id:Number(MEMBER_GP),first_name:'P'+MEMBER_GP}});
    assert.equal(await revision(),r0+1,'a member account leaving moves the revision');
    assert.equal(members().revision,r0+1,'and this process reloaded');
    assert.deepEqual([members().talks(MEMBER_GP_ACCOUNT,GP1),members().reaches(MEMBER_GP_ACCOUNT,GP1)],[true,false],'it still talks there, but reaches it no more');
    await capture(GP1,MEMBER_GP);
    assert.deepEqual([await revision(),members().reaches(MEMBER_GP_ACCOUNT,GP1)],[r0+2,true],'writing there again is in again');
    await capture(GP1,MEMBER_GP);
    assert.equal(await revision(),r0+2,'a row that stays the same moves nothing');

    await capture(NG1_TG,MEMBER_NG,{left_chat_member:{id:Number(MEMBER_NG),first_name:'P'+MEMBER_NG}});
    assert.deepEqual([await revision(),members().reaches(MEMBER_NG_ACCOUNT,NG1),members().reaches(MEMBER_NG_ACCOUNT,NG2)],[r0+3,false,true]);
    assert.deepEqual((await repo.list(owner)).members.find(item=>item.id===MEMBER_NG_ID)!.groups.find(g=>g.chat_id===NG1)!.telegram,'left');
  } finally{restore();await stores.close();}
});
