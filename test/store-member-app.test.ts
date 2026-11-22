import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {MemberDetail,MemberTask} from '../src/member-app-wire.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MEMBER_RECHECK_HOURS,joinedGroups} from '../src/stores/member-reads.js';
import {memberTaskViews} from '../src/stores/member-task-views.js';
import {TaskRepository,type MemberAppPrincipal} from '../src/stores/tasks.js';
import {fixtureServices} from './fixture-agent.js';
import {ALI,CANARY_LABEL,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,GUS,MEMBER_GP,MEMBER_APP_REACH,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_CHAT,MEMBER_NG_ID,
  NG1,NG2,NG_GROUP_IDS,OWNER,P1,P2,fixtureChats,fixtureDirectory,memberAppMembers,seedAssignee,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// The members' app's task methods (step 5, ADR-0265 D5-D8), called as the member listener calls them, with the member
// it checked: Mira (MEMBER_GP) with GP3 switched on is the "Bob" case, in GP1 and GP3 and gone from GP2, all three in P1;
// Nils (MEMBER_NG) reads the other fixture family. What the owner keeps to themselves is planted with marks, and no
// answer to the member may hold one.

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
const owner:Reader={admin:true,scope:null};
const MARKS=['GP2MARK','PERSONALMARK','OWNERCOLMARK','OWNERNAMEMARK','PREJOINMARK','OTHERGROUPMARK'];
const later=(hours:number)=>new Date(Date.now()+hours*3600000);
/** An ISO time with an offset, as the page sends it from the phone's own zone. */
const atOffset=(date:Date)=>{const shifted=new Date(date.getTime()+3.5*3600000);shifted.setUTCSeconds(0,0);return shifted.toISOString().slice(0,16)+'+03:30';};
const minuteOf=(text:string)=>Math.floor(Date.parse(text)/60000);

async function open() {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-app-'));
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served};
  const restore=installChatsForTest(fixtureDirectory(served));
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest('member-app-tasks'),policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  // Mira with GP3 on; NG1 and NG2 both in P2, Nils switched off in NG2.
  await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control,memberAppMembers());await seedGroups(stores.control);
  await stores.control.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
  await stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) SELECT space,$1,'assigned',1 FROM unnest($2::text[]) space
    ON CONFLICT(space_id) DO NOTHING`,[P2,[NG1,NG2]]);
  await stores.control.query(`INSERT INTO member_chats(member_id,chat_id,enabled) VALUES($1,$2,false) ON CONFLICT(member_id,chat_id) DO UPDATE SET enabled=false`,[MEMBER_NG_ID,NG2]);
  await stores.control.query('UPDATE chat_memberships SET checked_at=now()');
  return {stores,s,close:async()=>{restore();await stores.close();await rm(root,{recursive:true,force:true});}};
}
/** The member as the member listener builds them: their joined groups confirmed within MEMBER_RECHECK_HOURS, one board
 * per active project. */
async function principal(db:pg.Pool,member:string,account:string,chat:string,changes:Partial<MemberAppPrincipal>={}):Promise<MemberAppPrincipal> {
  const groups=(await joinedGroups(db,member,{owner:OWNER,freshHours:MEMBER_RECHECK_HOURS})).filter(group=>group.fresh).map(group=>group.chat);
  return {member,account,accounts:[account],name:'Mira',mode:'write',reminders:{available:true},views:await memberTaskViews(db,groups,'group'),chat,...changes};
}
const leaks=(value:unknown,why:string)=>{
  const text=JSON.stringify(value);
  for(const mark of MARKS)assert.ok(!text.includes(mark),`${why} shows ${mark}`);
  for(const word of ['time_zone','"revision"','"people"','CANARY-LABEL Gus','CANARY-LABEL Lone','"origin"','"external"','"source_event"','"position"','created_by_account','Asia/Kolkata',GP2])
    assert.ok(!text.includes(word),`${why} shows ${word}`);
};

test('the members\' app reads only the member\'s boards, from when each task joined, with no owner\'s names, private columns or time zone',fixture,async()=>{
  const {stores,s,close}=await open(),db=stores.control;
  try {
    const settings=await s.tasks.settings(owner);
    await s.tasks.saveSettings(owner,{revision:settings.revision,time_zone:'Asia/Kolkata',properties:[{id:'effort',name:'Effort',type:'number',shared:true},
      {id:'secret',name:'Secret',type:'text'},{id:'lead',name:'Lead',type:'person',shared:true}]});
    const person=digest('member-app:person');
    await db.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','OWNERNAMEMARK','active')",[person]);
    const add=(name:string,body:Record<string,unknown>)=>s.tasks.create(owner,{operation_id:'member-app:'+name,...body});
    // A personal task with a comment, then put on GP1's board: the comment stays the owner's.
    const personal=await add('joined',{title:'Book the hall'});
    await s.tasks.comment(owner,personal.id,{operation_id:'member-app:prejoin',text:'PREJOINMARK'});
    const joined=await s.tasks.update(owner,personal.id,{operation_id:'member-app:join',expected_revision:personal.revision,scope:P1,group:GP1,
      assignees:[person],people:[person],properties:{Effort:3,Secret:'OWNERCOLMARK',Lead:[person]},reminders:[later(48).toISOString()]});
    const inGp3=await add('gp3',{title:'Print the flyers',scope:P1,group:GP3,tags:['Print']});
    const onP1=await add('p1',{title:'Plan the party',scope:P1,group:null,tags:['Plan']});
    const inGp2=await add('gp2',{title:'GP2MARK hire the band',scope:P1,group:GP2,tags:['OTHERGROUPMARK']});
    const mine=await add('personal',{title:'PERSONALMARK renew the passport'});
    // A subtask of the project's own task written before subtasks followed their parent's group: GP2's, so not counted.
    const hidden=await add('hidden-sub',{title:'GP2MARK hidden subtask',parent:onP1.id});
    await db.query('UPDATE owner_tasks SET group_id=$2 WHERE id=$1',[hidden.id,GP2]);
    const seenSub=await add('seen-sub',{title:'Buy candles',parent:onP1.id});
    const inGp4=await add('gp4',{title:'No board for this',scope:P2,group:GP4});

    const mira=await principal(db,MEMBER_GP_ID,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT);
    assert.deepEqual(mira.views.map(view=>[view.project,view.name]),[[P1,'P1']],'one board: P1; GP4 has none');
    const page=await s.tasks.memberList(mira,{project:P1});
    assert.deepEqual(page.tasks.map(task=>task.id).sort(),[joined.id,inGp3.id,onP1.id].sort(),'GP1, GP3 and P1\'s own; never GP2, a personal task or a subtask');
    assert.deepEqual(page.tags,['Plan','Print'],'only the tags of tasks she sees');
    assert.equal(page.next,null);
    assert.deepEqual(Object.keys(page).sort(),['columns','next','statuses','tags','tasks']);
    assert.deepEqual(page.columns,[{id:'effort',name:'Effort',type:'number'}],'only shared columns, never a private or person one');
    assert.ok(page.statuses.length>0&&page.statuses.every(item=>typeof item.id==='string'&&typeof item.name==='string'&&['open','done','dropped'].includes(item.state)));
    assert.deepEqual(page.statuses.map(item=>item.id),settings.statuses.map(item=>item.id),'every status, in the owner\'s order');
    leaks(page,'the list');
    await assert.rejects(s.tasks.memberList(mira,{project:P2}),{status:403,code:'task_scope_denied'});
    await assert.rejects(s.tasks.memberList(mira,{project:P1,person} as any),{status:400,code:'task_filter_not_allowed'});
    for(const id of [inGp2.id,mine.id,inGp4.id,hidden.id,digest('no such task')])await assert.rejects(s.tasks.memberGet(mira,id),{status:404,code:'task_not_found'},id);
    assert.deepEqual((await s.tasks.memberList(mira,{project:P1,group:GP3})).tasks.map(task=>task.id),[inGp3.id]);
    assert.deepEqual((await s.tasks.memberList(mira,{project:P1,group:GP2})).tasks,[],'a group she left finds nothing');
    assert.deepEqual((await s.tasks.memberList(mira,{project:P1,tag:'print'})).tasks.map(task=>task.id),[inGp3.id]);

    // The joined task: no people, assignees or person column, only shared columns, no comment or history from before.
    const row=page.tasks.find(task=>task.id===joined.id)!,detail=await s.tasks.memberGet(mira,joined.id);
    leaks(detail,'the drawer');
    assert.deepEqual(row.properties,{effort:3});
    assert.deepEqual([row.assignees,row.assignees_other],[[],1],'an assignee bound to no Telegram account is only counted');
    assert.equal(row.comments,0,'the earlier comment is not counted');
    assert.deepEqual(detail.comment_list,[]);
    assert.deepEqual(detail.activity.map(item=>item.changes),[{project_id:{to:P1},group_id:{to:GP1},properties:true,reminders:true,assignees:true}],
      'history starts when it joined, shows only where it went, that assignees changed but never who, and never that people were named');
    assert.match(row.version,/^[a-f0-9]{32}$/);
    assert.deepEqual([row.created_at,row.created_by,row.on_board_since!==null],[undefined,undefined,true],'made elsewhere: when it joined, not when or by whom it was made');
    assert.ok(Date.parse(row.updated_at)>=Date.parse(row.on_board_since!));
    assert.deepEqual(row.reminders,{mine:[],others:1},'the owner\'s reminder counts, never whose');
    // Made on the board: when and by whom.
    const party=page.tasks.find(task=>task.id===onP1.id)!;
    assert.deepEqual([typeof party.created_at,party.created_by],['string',{kind:'owner'}]);
    assert.deepEqual(party.subtasks,{open:1,total:1},'only the subtasks she sees');
    assert.deepEqual((await s.tasks.memberGet(mira,onP1.id)).children.map(item=>item.id),[seenSub.id]);
    // Exactly the fields the contract names.
    const fields=['id','version','project','group','parent_id','title','status','state','priority','start_on','start_time','due_on','due_time','tags','properties','subtasks',
      'assignees','assignees_other','comments','archived','trashed','mine','on_board_since','created_at','updated_at','done_at','created_by','finished_by','reminders'];
    for(const task of page.tasks)assert.deepEqual(Object.keys(task).filter(key=>!fields.includes(key)),[],task.title);
    assert.deepEqual(Object.keys(detail).filter(key=>![...fields,'notes','repeat','blocked_by','related','duplicate_of','children','attachments','comment_list','activity'].includes(key)),[]);

    // A group not confirmed within MEMBER_RECHECK_HOURS drops out of the board.
    await db.query(`UPDATE chat_memberships SET checked_at=now()-interval '7 hours' WHERE chat_id=$1 AND account_id=$2`,[GP3,MEMBER_GP_ACCOUNT]);
    const stale=await principal(db,MEMBER_GP_ID,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT);
    assert.deepEqual((await s.tasks.memberList(stale,{project:P1})).tasks.map(task=>task.id).sort(),[joined.id,onP1.id].sort());
    await assert.rejects(s.tasks.memberGet(stale,inGp3.id),{status:404});
    await db.query(`UPDATE chat_memberships SET checked_at=now() WHERE chat_id=$1 AND account_id=$2`,[GP3,MEMBER_GP_ACCOUNT]);
    // No board at all: every project is refused.
    await assert.rejects(s.tasks.memberList({...mira,views:[]},{project:P1}),{status:403,code:'task_scope_denied'});
    assert.deepEqual(await s.tasks.memberReminders({...mira,views:[]}),[]);

    // A task in one of GP1's topics shows under GP1, which her groups name.
    const inTopic=await add('topic',{title:'Topic task',scope:P1,group:GP1_TOPIC});
    assert.equal((await s.tasks.memberGet(mira,inTopic.id)).group,GP1);
    assert.ok((await s.tasks.memberList(mira,{project:P1,group:GP1})).tasks.some(task=>task.id===inTopic.id));

    // The other family: Nils reads NG1's tasks on P2, never NG2's, where he is switched off.
    const inNg1=await add('ng1',{title:'Fix the gate',scope:P2,group:NG1}),inNg2=await add('ng2',{title:'OTHERGROUPMARK paint the wall',scope:P2,group:NG2});
    const nils=await principal(db,MEMBER_NG_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_CHAT,{name:'Nils'});
    assert.deepEqual(nils.views.map(view=>view.project),[P2]);
    const ng=await s.tasks.memberList(nils,{project:P2});
    assert.deepEqual(ng.tasks.map(task=>task.id),[inNg1.id]);leaks(ng,'the other family');
    await assert.rejects(s.tasks.memberGet(nils,inNg2.id),{status:404});
    await assert.rejects(s.tasks.memberGet(nils,inGp4.id),{status:404},'GP4 is in P2 but not one of his groups');
  } finally {await close();}
});

test('the members\' app writes as the member: read refuses every write, write changes any task they see, refused fields, conflicts, replays, trash and reminders',fixture,async()=>{
  const {stores,s,close}=await open(),db=stores.control;
  try {
    const settings=await s.tasks.settings(owner);
    await s.tasks.saveSettings(owner,{revision:settings.revision,properties:[{id:'effort',name:'Effort',type:'number',shared:true},{id:'lead',name:'Lead',type:'person',shared:true},
      {id:'client',name:'Client',type:'person'},{id:'secret',name:'Secret',type:'text'}]});
    const add=(name:string,body:Record<string,unknown>)=>s.tasks.create(owner,{operation_id:'member-app-writes:'+name,...body});
    const theirs=await add('theirs',{title:'Paint the door',scope:P1,group:GP3});
    const inGp2=await add('gp2',{title:'GP2MARK hire the band',scope:P1,group:GP2});
    const mira=await principal(db,MEMBER_GP_ID,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT);
    const reader={...mira,mode:'read' as const,reminders:{available:false as const,reason:'read_only' as const}};
    const op=(name:string)=>'op-'+name+'-0000';
    const version=async(id:string)=>(await s.tasks.memberGet(mira,id)).version;

    // Read only: every write is refused and nothing changes.
    const before=await s.tasks.get(owner,theirs.id);
    await assert.rejects(s.tasks.memberCreate(reader,{operation_id:op('read-add'),project:P1,title:'Nope'}),{status:403,code:'task_read_only'});
    await assert.rejects(s.tasks.memberUpdate(reader,theirs.id,{operation_id:op('read-edit'),expected_version:await version(theirs.id),patch:{state:'done'}}),{status:403,code:'task_read_only'});
    await assert.rejects(s.tasks.memberUpdate(reader,theirs.id,{operation_id:op('read-trash'),expected_version:await version(theirs.id),patch:{trashed:true}}),{status:403,code:'task_read_only'});
    await assert.rejects(s.tasks.memberComment(reader,theirs.id,{operation_id:op('read-comment'),text:'Hi'}),{status:403,code:'task_read_only'});
    assert.deepEqual(await s.tasks.get(owner,theirs.id),before);
    assert.equal((await s.tasks.memberGet(reader,theirs.id)).title,'Paint the door','read still reads');

    // Add: by default in her first group on the board, made by her, in the app.
    const made=await s.tasks.memberCreate(mira,{operation_id:op('add'),project:P1,title:'Bring chairs',tags:['Setup'],properties:{Effort:2}});
    assert.deepEqual([made.group,made.created_by,made.mine,made.properties,made.reminders],[GP1,{kind:'member',name:'Mira'},true,{effort:2},{mine:[],others:0}]);
    const stored=(await db.query('SELECT origin,created_by_account,group_id FROM owner_tasks WHERE id=$1',[made.id])).rows[0];
    assert.deepEqual(stored,{origin:'app',created_by_account:MEMBER_GP_ACCOUNT,group_id:GP1});
    assert.deepEqual((await db.query('SELECT field,by,account_id,chat_id,group_id,via FROM owner_task_writers WHERE task_id=$1',[made.id])).rows,
      [{field:'title',by:'person',account_id:MEMBER_GP_ACCOUNT,chat_id:null,group_id:null,via:'app'}],'her private chat is never stored as a place');
    assert.equal((await s.tasks.memberCreate(mira,{operation_id:op('add'),project:P1,title:'Bring chairs',tags:['Setup'],properties:{Effort:2}})).id,made.id,'the same operation again');
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('add'),project:P1,title:'Bring tables'}),{status:409,code:'task_operation_conflict'});
    const whole=await s.tasks.memberCreate(mira,{operation_id:op('whole'),project:P1,title:'Tell everyone',group:null});
    assert.equal(whole.group,null,'the whole project when she asks');
    const sweep=await s.tasks.memberCreate(mira,{operation_id:op('gp3'),project:P1,title:'Sweep',group:GP3});
    assert.equal(sweep.group,GP3);
    assert.equal((await s.tasks.memberCreate(mira,{operation_id:op('sub'),project:P1,title:'Count chairs',parent:theirs.id})).group,GP3,'a subtask takes its parent\'s group');
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('gp2'),project:P1,title:'Sneak',group:GP2}),{status:403,code:'task_group_denied'});
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('p2'),project:P2,title:'Sneak'}),{status:403,code:'task_scope_denied'});
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('parent'),project:P1,title:'Sneak',parent:inGp2.id}),{status:404});
    for(const [field,value] of [['people',[]],['assignees',[]],['external',{notion:'x'}],['scope',P1],['position',1],['expected_revision',1],
      ['attachments',[{kind:'message',id:digest('m')}]]] as const)
      await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('field'),project:P1,title:'Sneak',[field]:value}),{status:403,code:'task_field_not_allowed'},field);
    // A column the page does not show answers as a name no column has: a person column, shared or private, a private
    // column, or none at all, so guessing tells no column's name.
    for(const properties of [{Lead:[]},{lead:[]},{Client:'x'},{client:'x'},{Secret:'x'},{Nobody:'x'}])
      await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('column'),project:P1,title:'Sneak',properties}),{status:400,code:'unknown_task_property'},JSON.stringify(properties));
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:op('unknown'),project:P1,title:'Sneak',origin:'dashboard'}),{status:400,code:'unknown_task_field'});
    await assert.rejects(s.tasks.memberCreate(mira,{operation_id:'x',project:P1,title:'Sneak'}),{status:400,code:'invalid_operation_id'});

    // Edit someone else's task; a stale version is a conflict; the same write again replays.
    const v1=await version(theirs.id);
    const renamed=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('rename'),expected_version:v1,patch:{title:'Paint the front door'}});
    assert.equal(renamed.title,'Paint the front door');assert.notEqual(renamed.version,v1);
    assert.equal((await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('rename'),expected_version:v1,patch:{title:'Paint the front door'}})).version,renamed.version,
      'a retry whose answer was lost replays');
    await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('stale'),expected_version:v1,patch:{title:'Paint it red'}}),{status:409,code:'conflict'});
    await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('forged'),expected_version:'1',patch:{title:'Paint it red'}}),{status:409,code:'conflict'});
    for(const patch of [{people:[]},{scope:P1},{expected_revision:1}])
      await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('refused'),expected_version:renamed.version,patch}),{status:403,code:'task_field_not_allowed'});
    for(const properties of [{Lead:[]},{Client:'x'},{Nobody:'x'}])
      await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('refused'),expected_version:renamed.version,patch:{properties}}),{status:400,code:'unknown_task_property'});
    await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('move'),expected_version:renamed.version,patch:{group:GP2}}),{status:403,code:'task_group_denied'});
    await assert.rejects(s.tasks.memberUpdate(mira,inGp2.id,{operation_id:op('gp2'),expected_version:renamed.version,patch:{title:'Mine now'}}),{status:404});
    // Finish, reopen, trash someone else's task and restore it; archive.
    const done=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('finish'),expected_version:renamed.version,patch:{state:'done'}});
    assert.deepEqual([done.state,done.finished_by],['done',{kind:'member',name:'Mira'}]);
    const reopened=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('reopen'),expected_version:done.version,patch:{state:'open'}});
    const trashed=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('trash'),expected_version:reopened.version,patch:{trashed:true}});
    assert.equal(trashed.trashed,true);
    assert.ok((await s.tasks.memberList(mira,{project:P1,trash:true})).tasks.some(task=>task.id===theirs.id));
    assert.ok(!(await s.tasks.memberList(mira,{project:P1})).tasks.some(task=>task.id===theirs.id));
    await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('in-trash'),expected_version:trashed.version,patch:{title:'x'}}),{status:409,code:'task_in_trash'});
    const restored=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('restore'),expected_version:trashed.version,patch:{trashed:false}});
    assert.equal(restored.trashed,false);
    // A subtask trashed on its own, under a task that is not in the trash, is found in the trash and restored there.
    const step=await s.tasks.memberCreate(mira,{operation_id:op('step'),project:P1,title:'Sand the door',parent:theirs.id});
    const binned=await s.tasks.memberUpdate(mira,step.id,{operation_id:op('step-trash'),expected_version:step.version,patch:{trashed:true}});
    assert.ok((await s.tasks.memberList(mira,{project:P1,trash:true})).tasks.some(task=>task.id===step.id),'listed in the trash');
    assert.ok(!(await s.tasks.memberGet(mira,theirs.id)).children.some(item=>item.id===step.id));
    assert.equal((await s.tasks.memberUpdate(mira,step.id,{operation_id:op('step-restore'),expected_version:binned.version,patch:{trashed:false}})).trashed,false);
    assert.ok((await s.tasks.memberGet(mira,theirs.id)).children.some(item=>item.id===step.id));
    // A subtask trashed with its parent stays under it: only the parent is at the trash's top.
    const both=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('both-trash'),expected_version:(await s.tasks.memberGet(mira,theirs.id)).version,patch:{trashed:true}});
    const binList=(await s.tasks.memberList(mira,{project:P1,trash:true})).tasks.map(task=>task.id);
    assert.ok(binList.includes(theirs.id)&&!binList.includes(step.id));
    await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('both-restore'),expected_version:both.version,patch:{trashed:false}});
    const archived=await s.tasks.memberUpdate(mira,whole.id,{operation_id:op('archive'),expected_version:whole.version,patch:{archived:true}});
    assert.equal(archived.archived,true);
    assert.deepEqual((await db.query('SELECT DISTINCT origin FROM owner_task_activity WHERE task_id=$1 AND origin<>$2',[theirs.id,'dashboard'])).rows,[{origin:'app'}]);
    assert.equal((await s.tasks.memberList(mira,{project:P1,state:'done'})).tasks.length,0);

    // Comments: added as her; never removed; not on a task she does not see.
    const talked=await s.tasks.memberComment(mira,theirs.id,{operation_id:op('comment'),text:'Bought the paint'});
    assert.deepEqual(talked.comment_list.map(item=>[item.body,item.author]),[['Bought the paint',{kind:'member',name:'Mira'}]]);
    assert.equal((await db.query('SELECT origin FROM owner_task_comments WHERE task_id=$1',[theirs.id])).rows[0].origin,'app');
    await assert.rejects(s.tasks.memberComment(mira,theirs.id,{operation_id:op('remove'),remove:talked.comment_list[0]!.id}),{status:403,code:'task_field_not_allowed'});
    await assert.rejects(s.tasks.memberComment(mira,inGp2.id,{operation_id:op('gp2-comment'),text:'Hi'}),{status:404});
    assert.equal((await s.tasks.get(owner,theirs.id)).comments.length,1);

    // Reminders: her own only, with an offset; the owner's and another member's stay and show as a count.
    await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id)
      VALUES($1,$2,now()+interval '3 days','person',$3,'Nils',$4,$4)`,[digest('other reminder'),theirs.id,MEMBER_NG_ACCOUNT,GP3]);
    const owned=await s.tasks.get(owner,theirs.id);
    await s.tasks.update(owner,theirs.id,{operation_id:'member-app-writes:owner-reminder',expected_revision:owned.revision,reminders:[...owned.reminders.map((item:any)=>item.at),later(80).toISOString()]});
    let current=await s.tasks.memberGet(mira,theirs.id);
    assert.deepEqual(current.reminders,{mine:[],others:2});
    const first=atOffset(later(24)),second=atOffset(later(30));
    await assert.rejects(s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('no-offset'),expected_version:current.version,patch:{reminders:[first.slice(0,16)]}}),
      {status:400,code:'invalid_task_reminder'},'never read in the owner\'s time zone');
    current=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('remind'),expected_version:current.version,patch:{reminders:[first,second]}});
    assert.deepEqual([current.reminders.mine.map(item=>minuteOf(item.at)),current.reminders.others,current.mine],[[minuteOf(first),minuteOf(second)],2,true]);
    assert.deepEqual((await db.query(`SELECT DISTINCT set_via,set_in_chat_id,set_in_group_id,set_by_account_id FROM owner_task_reminders WHERE task_id=$1 AND set_by_name='Mira'`,[theirs.id])).rows,
      [{set_via:'app',set_in_chat_id:null,set_in_group_id:null,set_by_account_id:MEMBER_GP_ACCOUNT}]);
    // Another's reminder at her minute never stands in for hers: Nils's, at a time she cannot see.
    const nilsAt=(await db.query('SELECT remind_at FROM owner_task_reminders WHERE id=$1',[digest('other reminder')])).rows[0].remind_at as Date;
    current=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('same-minute'),expected_version:current.version,patch:{reminders:[first,second,atOffset(nilsAt)]}});
    assert.deepEqual([current.reminders.mine.length,current.reminders.others],[3,2],'hers at Nils\'s minute is set, and his still counts');
    current=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('same-minute-off'),expected_version:current.version,patch:{reminders:[first,second]}});
    assert.equal((await db.query(`SELECT state FROM owner_task_reminders WHERE id=$1`,[digest('other reminder')])).rows[0].state,'pending','removing hers leaves his');
    const listed=await s.tasks.memberReminders(mira);
    assert.deepEqual(listed.map(item=>[item.task.id,item.task.title,item.task.project,minuteOf(item.at)]),
      [[theirs.id,'Paint the front door',P1,minuteOf(first)],[theirs.id,'Paint the front door',P1,minuteOf(second)]]);
    // One she set on GP2's task before she left is not hers to see any more.
    await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id)
      VALUES($1,$2,now()+interval '1 day','person',$3,'Mira',$4,$4)`,[digest('gp2 reminder'),inGp2.id,MEMBER_GP_ACCOUNT,GP2]);
    assert.equal((await s.tasks.memberReminders(mira)).length,2);
    // "Mine": made by her, or with her reminder.
    assert.deepEqual((await s.tasks.memberList(mira,{project:P1,mine:true})).tasks.map(task=>task.id).sort(),[made.id,sweep.id,theirs.id].sort(),
      'made by her, or with her reminder');
    // Removing one leaves the others' reminders.
    current=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('unremind'),expected_version:current.version,patch:{reminders:[second]}});
    assert.deepEqual([current.reminders.mine.length,current.reminders.others],[1,2]);
    // One she set from another of her Telegram accounts is hers too: listed as hers, and she removes or changes it.
    const otherAccount=digest('mira second account'),both2={...mira,accounts:[MEMBER_GP_ACCOUNT,otherAccount]};
    await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id)
      VALUES($1,$2,now()+interval '4 days','person',$3,'Mira',$4,$4)`,[digest('second account reminder'),theirs.id,otherAccount,GP3]);
    current=await s.tasks.memberGet(both2,theirs.id);
    assert.deepEqual([current.reminders.mine.length,current.reminders.others],[2,2]);
    assert.equal((await s.tasks.memberReminders(both2)).length,2);
    current=await s.tasks.memberUpdate(both2,theirs.id,{operation_id:op('other-account'),expected_version:current.version,patch:{reminders:[second]}});
    assert.deepEqual([current.reminders.mine.length,current.reminders.others],[1,2],'removed, though set from her other account');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM owner_task_reminders WHERE id=$1',[digest('second account reminder')])).rows[0].n,0);
    // A task in the trash: its reminders leave her list, and come back when it is restored.
    const trashedAgain=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('trash-reminders'),expected_version:current.version,patch:{trashed:true}});
    assert.deepEqual((await s.tasks.memberReminders(mira)).map(item=>item.task.id).filter(id=>id===theirs.id),[]);
    current=await s.tasks.memberUpdate(mira,theirs.id,{operation_id:op('restore-reminders'),expected_version:trashedAgain.version,patch:{trashed:false}});
    assert.equal((await s.tasks.memberReminders(mira)).filter(item=>item.task.id===theirs.id).length,1);
    // Reminders that cannot reach her: removing still works, adding does not.
    const away={...mira,chat:null,reminders:{available:false as const,reason:'private_chat_off' as const}};
    await assert.rejects(s.tasks.memberUpdate(away,theirs.id,{operation_id:op('away-add'),expected_version:current.version,patch:{reminders:[second,first]}}),
      {status:409,code:'member_reminders_unavailable'});
    const off={...mira,reminders:{available:false as const,reason:'reminders_off' as const}};
    await assert.rejects(s.tasks.memberUpdate(off,theirs.id,{operation_id:op('off-add'),expected_version:current.version,patch:{reminders:[second,first]}}),
      {status:403,code:'task_reminders_off'});
    current=await s.tasks.memberUpdate(off,theirs.id,{operation_id:op('off-remove'),expected_version:current.version,patch:{reminders:[]}});
    assert.deepEqual(current.reminders,{mine:[],others:2},'removing her own still works');

    // A repeating task keeps her app reminder, still set in the app, on its next one.
    const weekly=await s.tasks.memberCreate(mira,{operation_id:op('weekly'),project:P1,title:'Water the plants',due_on:later(48).toISOString().slice(0,10),
      repeat:{every:1,unit:'week'}});
    const reminded=await s.tasks.memberUpdate(mira,weekly.id,{operation_id:op('weekly-remind'),expected_version:weekly.version,patch:{reminders:[atOffset(later(40))]}});
    await s.tasks.memberUpdate(mira,weekly.id,{operation_id:op('weekly-done'),expected_version:reminded.version,patch:{state:'done'}});
    const next=(await db.query('SELECT repeated_to FROM owner_tasks WHERE id=$1',[weekly.id])).rows[0].repeated_to;
    assert.deepEqual((await db.query('SELECT set_via,set_in_chat_id FROM owner_task_reminders WHERE task_id=$1',[next])).rows,[{set_via:'app',set_in_chat_id:null}]);
    assert.deepEqual((await db.query('SELECT DISTINCT via FROM owner_task_writers WHERE task_id=$1',[next])).rows,[{via:'app'}]);
  } finally {await close();}
});

test('the members\' app names an assignee by their People name (ADR-0274) only when they are in a group she reaches; every other is counted, never named',fixture,async()=>{
  const {stores,s,close}=await open(),db=stores.control;
  try {
    // Ali in GP1 (hers), Gus only in GP2 (gone from her reach), one card bound to nobody, and Mira's own card.
    const ali=await seedAssignee(db,CANARY_LABEL,ALI,'Ali T',[GP1]),gus=await seedAssignee(db,'CANARY-LABEL Gus (vendor)',GUS,'Gus T',[GP2]);
    const lone=await seedAssignee(db,'CANARY-LABEL Lone (friend)',null),her=await seedAssignee(db,'CANARY-LABEL Mira (helper)',MEMBER_GP,'Mira T');
    const add=(name:string,body:Record<string,unknown>)=>s.tasks.create(owner,{operation_id:'member-app-assignees:'+name,...body});
    const lights=await add('lights',{title:'Hang the lights',scope:P1,group:GP1,assignees:[ali,gus]});
    const cake=await add('cake',{title:'Order the cake',scope:P1,group:null,assignees:[lone]});
    const caterer=await add('caterer',{title:'Call the caterer',scope:P1,group:GP3,assignees:[her]});
    const mira=await principal(db,MEMBER_GP_ID,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT);
    const page=await s.tasks.memberList(mira,{project:P1}),of=(id:string)=>page.tasks.find(task=>task.id===id)!;
    leaks(page,'the list');
    assert.deepEqual([of(lights.id).assignees,of(lights.id).assignees_other],[[{name:CANARY_LABEL}],1],'Ali by the name the owner set; Gus, only in GP2, counted');
    assert.deepEqual([of(cake.id).assignees,of(cake.id).assignees_other],[[],1],'a card bound to nobody is counted');
    assert.deepEqual([of(caterer.id).assignees,of(caterer.id).assignees_other,of(caterer.id).mine],[[{name:'CANARY-LABEL Mira (helper)'}],0,true],'assigned to her: hers');
    assert.deepEqual([of(lights.id).mine,of(cake.id).mine],[false,false]);
    const ours=[lights.id,cake.id,caterer.id];
    assert.deepEqual((await s.tasks.memberList(mira,{project:P1,mine:true})).tasks.map(task=>task.id).filter(id=>ours.includes(id)),[caterer.id],
      '"Mine" holds what is assigned to her');
    const detail=await s.tasks.memberGet(mira,lights.id);
    leaks(detail,'the drawer');
    assert.deepEqual([detail.assignees,detail.assignees_other],[[{name:CANARY_LABEL}],1]);
    // Ali leaves GP1: he is counted, never named.
    await db.query(`UPDATE chat_memberships SET state='left' WHERE chat_id=$1 AND account_id=$2`,[GP1,(await db.query('SELECT id FROM chat_accounts WHERE external_id=$1',[ALI])).rows[0].id]);
    const after=await s.tasks.memberGet(mira,lights.id);
    assert.deepEqual([after.assignees,after.assignees_other],[[],2]);
    // A version is keyed by the installation's stored key: another repository on the same database gives the same one.
    const again=new TaskRepository(db,async()=>{throw Error('no turn here');});
    assert.equal((await again.memberGet(mira,lights.id)).version,after.version);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM owner_task_version_key')).rows[0].n,1);
  } finally {await close();}
});

/** Only the shape: exported for the type checker. */
export type Shapes=[MemberTask,MemberDetail];
