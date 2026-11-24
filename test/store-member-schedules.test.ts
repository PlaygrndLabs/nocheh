import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {HttpError} from '../src/http.js';
import {reader,type Reader} from '../src/access.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installMembersForTest} from '../src/members.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {RuntimeProfileRepository} from '../src/stores/runtime-profiles.js';
import {chatSchedules,issueClockGrant,recordScheduleDefinition,recordScheduleTurn,scheduleTurn,timeZoneTurn} from '../src/stores/schedules.js';
import {ownerTimeZone,setOwnerTimeZone} from '../src/stores/task-settings.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {fixtureServices,type FakeCall} from './fixture-agent.js';
import {GP1,GP2,GP3,GP_GROUP_IDS,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_NG_CHAT,NG_GROUP_IDS,OWNER,P1,fixtureMemberDirectory,fixtureChats,groupsPolicy,
  seedChats,seedGroups,seedMembers} from './fixture-groups.js';

/*
 * Members' schedules: a member with Personal assistant on keeps schedules in their own private chat. A run there reads as
 * that member (their chat and the groups they joined), never the owner's chat or another member's; its result goes back
 * to that chat with no card; and a reply there may set schedules only within the member's limit. With Personal assistant
 * off, nothing of theirs is captured or run.
 */
test('a member\'s own schedules: captured only with Personal assistant on, run as that member, sent to their chat with no card',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-schedules-')),base=Date.now(),token=digest('member-schedules-'+base);
  const policy=groupsPolicy({group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]});
  let restore=installMembersForTest(fixtureMemberDirectory({[MEMBER_GP_ID]:{assistant:true}}));
  const seen:{scope:string;member:unknown;memberChat:unknown;reads:unknown;tasks:boolean;owner:boolean;create:boolean;lookups:string[]}[]=[];
  const lookup=(args:Record<string,unknown>)=>({kind:'mcp',arguments:args});
  const github={connection:'github',tool:'search_code',input:{repo:'example-org/widgets',query:'made up'}};
  let serial=0;const native=new Map<string,Record<string,unknown>>();
  const runtime:FakeCall=async(op,body)=>{
    if(op==='guard.detect')return {literals:[]};
    if(op==='telegram.notice')return {state:'done'};
    if(op==='schedule.advance')return {state:'waiting',next_attempt:Date.now()+60000};
    if(op==='run.resume')return native.get(String(body.event_id))??{state:'not_found'};
    if(op==='run.cancel')return {state:'cancelled'};
    assert.equal(op,'run.start');const id=String(body.event_id);
    try{return await start(id,body);}catch(error){failures.push(error);throw error;}
  };
  const failures:unknown[]=[];
  const start=async(id:string,body:Record<string,any>)=>{
    const context:any=await s.scheduled.context(body);
    const claim=await s.scheduled.claim(context);assert.equal(claim.claimed,true);
    const principal:Reader=reader({headers:{authorization:'Bearer '+claim.archive_credential}} as any,token);
    const bound=await s.access.bindReads(principal);
    seen.push({scope:String(claim.scope),member:context.member,memberChat:bound.memberChat,reads:bound.reads,
      tasks:await s.tasks.chatList(bound,{}).then(()=>true,error=>error?.code==='task_project_required'),
      owner:await s.knowledge.ownerReader(bound).then(()=>true,()=>false),
      create:await s.tasks.chatCreate(bound,{title:'From a schedule'}).then(()=>true,()=>false),
      // P1 holds GP1 and does not share its chats: its GitHub and Notion read with no card, a change is refused (ADR-0278).
      lookups:await Promise.all([lookup(github),lookup({connection:'notion',project:P1,tool:'notion-search',input:{query:'brief'}}),
        lookup({connection:'notion',project:P1,tool:'notion-create-pages',input:{pages:[]}})].map(value=>
        s.controlledActions.propose(bound,value).then(result=>String(result.state),error=>String(error?.code))))});
    await s.scheduled.finish({event_id:id,actor:context.actor,state:'done',session:context.conversation,text:'Member brief'});
    native.set(id,{state:'done'});return {state:'done'};
  };
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no providers');})}),owner={admin:true,scope:null};
  const authority=async()=>({owner:'inngest' as const,epoch:(await s.schedules.ownership()).epoch});
  const capture=async(scope:string)=>{
    const profile='nocheh-'+digest(scope).slice(0,24),job='member-'+base+'-'+(++serial);
    const definition={profile,name:'Brief',prompt:'Summarize my groups',schedule:{kind:'interval',minutes:60},deliver:'telegram',repeat:null,enabled:true,removed:false,
      preferences:{},execution_version:'v1'};
    const saved=await recordScheduleDefinition(s.schedules,{scope,profile,job_id:job,definition,workflow_cursor:digest(job),workflow_sequence:1},
      {set_by:{via:'turn',person:MEMBER_GP_ID,turn:'fixture'},created_by:MEMBER_GP_ID});
    const epoch=(await authority()).epoch;await issueClockGrant(stores.control,saved.id,digest(job),epoch);
    return {...await s.schedules.capture(owner,{scope,space:scope,profile,job_id:job,id:'first',text:definition.prompt,files:[],definition,
      job_revision:digest(canonical(definition)),scheduled_for:new Date(Date.now()-1000).toISOString(),fire_reason:'scheduled',owner_epoch:epoch}),profile,job};
  };
  const refusedProfile=(error:any)=>['profile_not_found','profile_scope_denied'].includes(error?.code);
  const run=async(id:string)=>storageWorkflowOperations(s,runtime).schedules!('run:'+id,await authority());
  try {
    await seedChats(stores.control,fixtureChats([...GP_GROUP_IDS,...NG_GROUP_IDS]));await seedMembers(stores.control);
    await stores.control.query('UPDATE members SET assistant=true WHERE id=$1',[MEMBER_GP_ID]);await seedGroups(stores.control);
    // Telegram confirmed her in GP1 and GP3 lately; GP3 is switched off for her, and she left GP2.
    await stores.control.query('UPDATE chat_memberships SET checked_at=now() WHERE account_id=$1',[MEMBER_GP_ACCOUNT]);
    await s.guards.reconcile();await s.guards.setMode('on');
    await s.notion.save(owner,{project:P1,enabled:true,expected_revision:0});await s.jobs.setRepoProject(owner,{repo:'example-org/widgets',project:P1});

    // Her own chat is one of the agent's profiles; another member's (assistant off) is not.
    const profiles=(await new RuntimeProfileRepository(s.access).list(owner)).profiles as {scope:string;name:string}[];
    assert.ok(profiles.some(item=>item.scope===MEMBER_GP_CHAT&&item.name.startsWith('member-')),'her chat is a profile');
    assert.ok(!profiles.some(item=>item.scope===MEMBER_NG_CHAT),'not a member without Personal assistant');
    await assert.rejects(capture(MEMBER_NG_CHAT),refusedProfile);

    // A run in her chat reads as her: her chat and GP1 only, never the owner's chat, GP2 or GP3; tasks read only.
    const fired=await capture(MEMBER_GP_CHAT);assert.equal(fired.state,'captured');
    const ran=await run(fired.event_id);assert.deepEqual(failures,[]);assert.equal(ran.state,'completed');
    assert.equal(seen.length,1);
    const [first]=seen;
    assert.deepEqual([first!.scope,first!.member,first!.memberChat],[MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_CHAT]);
    const reads=JSON.stringify(first!.reads);
    assert.ok(reads.includes(GP1)&&!reads.includes(GP2)&&!reads.includes(GP3)&&!reads.includes('"'+OWNER+'"'),reads);
    assert.deepEqual([first!.tasks,first!.owner,first!.create],[true,false,false],'its tasks read only, never the owner\'s data');
    assert.deepEqual(first!.lookups,['approved','approved','member_private_read_only']);
    assert.equal(await chatSchedules(stores.control,MEMBER_GP_CHAT),1);

    // Its result goes to her chat with no card, as a trusted scheduled send.
    const sent=await s.scheduled.delivery(fired);assert.equal(sent.state,'approved');assert.ok('id' in sent);
    assert.deepEqual((await stores.control.query('SELECT state,send_class,destination FROM telegram_action_requests WHERE id=$1',[sent.id])).rows[0],
      {state:'approved',send_class:'scheduled_run',destination:MEMBER_GP_CHAT});
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM security_events WHERE state='allowed' AND rule='member_scheduled_chat'")).rows[0].n,1);

    // A reply in her chat may set schedules within her limit; a bound reader of another chat, or with assistant off, may not.
    const live={knowledge:{ownerTurn:async()=>{throw new HttpError(403,'owner_private_turn_required');},liveGroupTurn:async()=>({source:{channel:'telegram',kind:'telegram_update',origin:'live',reference:{id:'e1'}}})},
      stores:{control:stores.control,archive:{query:async()=>({rows:[{payload:Buffer.from(JSON.stringify({message:{message_id:1,text:'every morning'}}))}]})} as any}};
    const member:Reader={admin:false,scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,member:MEMBER_GP_ID,memberChat:MEMBER_GP_CHAT,reads:{home:MEMBER_GP_CHAT,whole:[GP1]}} as any;
    const allowed=await scheduleTurn(live,member);
    assert.deepEqual([allowed.allowed,allowed.limit,allowed.count],[true,5,1]);
    await stores.control.query('UPDATE member_directory_state SET member_schedules=2 WHERE singleton');
    assert.equal((await scheduleTurn(live,member)).limit,2);
    assert.equal((await scheduleTurn(live,{...member,scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT} as any)).allowed,false,'only her own chat');
    // Set by asking (ADR-0290): the allowed turn leaves a turn grant, and Hermes's post from inside it records the schedule
    // as hers, within her cap, with its message in her chat once. Without the grant, or past her cap, nothing is recorded.
    const profile='nocheh-'+digest(MEMBER_GP_CHAT).slice(0,24),announced:unknown[]=[];
    const turnServices={...live,turns:{binding:async()=>({logical_profile:profile})},access:{policy:()=>policy},schedules:s.schedules,
      scheduleNotices:{announce:async(input:unknown)=>{announced.push(input);return {state:'sent'};}}};
    const turn={...member,turnEvent:'member-turn-'+base} as Reader;
    const definition=(job:string,changes:Record<string,unknown>={})=>({scope:MEMBER_GP_CHAT,profile,job_id:job,workflow_cursor:digest(job),workflow_sequence:1,
      definition:{profile,name:'Asked',prompt:'Remind me',schedule:{kind:'cron',expr:'0 8 * * 1-5',display:'0 8 * * 1-5'},deliver:'telegram',repeat:null,
        enabled:true,removed:false,preferences:{},execution_version:'v1',timezone:'Europe/Berlin'},
      notice:{name:'Asked',schedule:'every weekday at 8am',timezone:'Europe/Berlin',next_run_at:'2026-11-25T08:00:00+01:00'},...changes});
    await assert.rejects(s.schedules.turnDefinition(turn,definition('asked-'+base),turnServices),{status:403,code:'schedule_turn_not_allowed'},'no turn grant yet');
    await assert.rejects(s.schedules.turnDefinition(owner,definition('asked-'+base),turnServices),{status:403,code:'schedule_turn_required'});
    await assert.rejects(s.schedules.turnDefinition({...member} as Reader,definition('asked-'+base),turnServices),{status:403,code:'schedule_turn_required'});
    const rules=await recordScheduleTurn(turnServices,turn,await scheduleTurn(turnServices,turn));
    assert.deepEqual([rules.allowed,rules.limit,rules.count,rules.profile,rules.scope],[true,2,1,profile,MEMBER_GP_CHAT]);
    assert.deepEqual((await stores.control.query('SELECT scope,profile,person FROM schedule_turn_grants WHERE turn_event=$1',[turn.turnEvent])).rows,
      [{scope:MEMBER_GP_CHAT,profile,person:MEMBER_GP_ID}]);
    assert.deepEqual(await recordScheduleTurn(turnServices,member,rules),
      {allowed:false,time_zone:'UTC',limit:null,count:null,profile:null,scope:null},'no turn, no grant');
    await assert.rejects(s.schedules.turnDefinition(turn,definition('other-'+base,{scope:OWNER}),turnServices),{status:403,code:'schedule_turn_not_allowed'},'another chat');
    await assert.rejects(s.schedules.turnDefinition(turn,definition('other-'+base,{profile:'nocheh-'+'0'.repeat(24)}),turnServices),{status:403,code:'schedule_turn_not_allowed'});
    const unsupported=definition('odd-'+base);Object.assign(unsupported.definition,{schedule:{kind:'cron',expr:'0 8 L * *'}});
    await assert.rejects(s.schedules.turnDefinition(turn,unsupported,turnServices),{status:400,code:'schedule_cron_unsupported'});
    const local=definition('odd-'+base);local.definition.deliver='local';
    await assert.rejects(s.schedules.turnDefinition(turn,local,turnServices),{status:400,code:'invalid_schedule_definition'});
    const zone=definition('odd-'+base);zone.definition.timezone='Mars/Olympus';
    await assert.rejects(s.schedules.turnDefinition(turn,zone,turnServices),{status:400,code:'invalid_schedule_definition'});
    const asked=await s.schedules.turnDefinition(turn,definition('asked-'+base),turnServices);
    assert.deepEqual([asked.duplicate,asked.created,asked.notice],[false,true,'sent']);
    assert.deepEqual(announced,[{name:'Asked',schedule:'every weekday at 8am',timezone:'Europe/Berlin',next_run_at:'2026-11-25T08:00:00+01:00',
      scope:MEMBER_GP_CHAT,profile,job_id:'asked-'+base}]);
    const recorded=(await stores.control.query(`SELECT s.created_by,s.created_turn,v.set_by,v.body_hash FROM workflow_schedules s JOIN schedule_versions v ON v.id=s.version_id
      WHERE s.id=$1`,[asked.id])).rows[0];
    assert.deepEqual([recorded.created_by,recorded.created_turn,recorded.set_by],[MEMBER_GP_ID,turn.turnEvent,{via:'turn',person:MEMBER_GP_ID,turn:turn.turnEvent}]);
    assert.match(recorded.body_hash,/^[a-f0-9]{64}$/);
    assert.equal((await s.schedules.turnDefinition(turn,definition('asked-'+base),turnServices)).duplicate,true);
    // Paused in the same turn: recorded, the creator kept, no second message.
    const paused=definition('asked-'+base,{workflow_sequence:2,workflow_cursor:digest('paused')});Object.assign(paused.definition,{enabled:false,execution_version:'v2'});
    assert.deepEqual([(await s.schedules.turnDefinition(turn,paused,turnServices)).notice,announced.length],[null,1]);
    assert.equal((await stores.control.query('SELECT created_turn FROM workflow_schedules WHERE id=$1',[asked.id])).rows[0].created_turn,turn.turnEvent);
    assert.equal(await chatSchedules(stores.control,MEMBER_GP_CHAT),2);
    await assert.rejects(s.schedules.turnDefinition(turn,definition('third-'+base),turnServices),{status:403,code:'schedule_limit_reached'},'her cap is 2');
    // Removed by asking frees a place.
    const removed=definition('asked-'+base,{workflow_sequence:3,workflow_cursor:digest('removed')});Object.assign(removed.definition,{enabled:false,removed:true,execution_version:'v3'});
    await s.schedules.turnDefinition(turn,removed,turnServices);
    assert.equal((await s.schedules.turnDefinition(turn,definition('third-'+base),turnServices)).created,true);
    // A grant past its time, or a turn no longer allowed, sets nothing.
    await stores.control.query("UPDATE schedule_turn_grants SET expires_at=now()-interval '1 second' WHERE turn_event=$1",[turn.turnEvent]);
    await assert.rejects(s.schedules.turnDefinition(turn,definition('late-'+base),turnServices),{status:403,code:'schedule_turn_not_allowed'});
    await stores.control.query("UPDATE schedule_turn_grants SET expires_at=now()+interval '1 minute' WHERE turn_event=$1",[turn.turnEvent]);
    const forwarded={...turnServices,stores:{...turnServices.stores,archive:{query:async()=>({rows:[{payload:Buffer.from(JSON.stringify({message:{message_id:1,forward_origin:{type:'hidden_user'},text:'x'}}))}]})} as any}};
    await assert.rejects(s.schedules.turnDefinition(turn,definition('late-'+base),forwarded),{status:403,code:'schedule_turn_not_allowed'});
    await assert.rejects(s.schedules.turnDefinition(turn,definition('late-'+base),{...turnServices,turns:{binding:async()=>({logical_profile:'nocheh-'+'1'.repeat(24)})}}),
      {status:403,code:'schedule_turn_not_allowed'},'the turn\'s profile moved');
    // Her own time zone (members' time zones): the owner's until she sets one, by asking in her own chat; never from
    // another chat, and only a known name.
    const ownerZone=(await scheduleTurn(live,member)).time_zone;
    assert.deepEqual(await timeZoneTurn(live,member,{time_zone:'Pacific/Auckland'}),{time_zone:'Pacific/Auckland'});
    assert.equal((await scheduleTurn(live,member)).time_zone,'Pacific/Auckland');
    await assert.rejects(timeZoneTurn(live,member,{time_zone:'Mars/Olympus'}),{status:400,code:'invalid_time_zone'});
    await assert.rejects(timeZoneTurn(live,{...member,scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT} as any,{time_zone:'UTC'}),{status:403,code:'time_zone_not_here'});
    await assert.rejects(timeZoneTurn(live,{admin:false,scope:null,space:OWNER} as any,{time_zone:'UTC'}),{status:403,code:'time_zone_not_here'});
    assert.deepEqual(await timeZoneTurn(live,member,{time_zone:null}),{time_zone:null});
    assert.equal((await scheduleTurn(live,member)).time_zone,ownerZone,'back to the owner\'s');
    // The owner sets theirs the same way, in their own private chat (ADR-0282): never null, never from a group's turn.
    const ownerLive={...live,knowledge:{...live.knowledge,ownerTurn:async()=>({source:{channel:'telegram',kind:'telegram_update',origin:'live',reference:{id:'e2'}}})}};
    const ownerTurn:Reader={admin:false,scope:null} as any;
    assert.deepEqual(await timeZoneTurn(ownerLive,ownerTurn,{time_zone:'America/Chicago'}),{time_zone:'America/Chicago'});
    assert.equal(await ownerTimeZone(stores.control),'America/Chicago');
    assert.equal((await scheduleTurn(live,member)).time_zone,'America/Chicago','a member with no zone of their own follows it');
    await assert.rejects(timeZoneTurn(ownerLive,ownerTurn,{time_zone:null}),{status:400,code:'invalid_time_zone'});
    await assert.rejects(timeZoneTurn(ownerLive,ownerTurn,{time_zone:'Mars/Olympus'}),{status:400,code:'invalid_time_zone'});
    await assert.rejects(timeZoneTurn(ownerLive,ownerTurn,{time_zone:'UTC',revision:1}),{status:400,code:'invalid_time_zone'});
    await assert.rejects(timeZoneTurn(ownerLive,{admin:false,scope:null,space:OWNER,answer:true} as any,{time_zone:'UTC'}),{status:403,code:'time_zone_not_here'});
    assert.equal(await ownerTimeZone(stores.control),'America/Chicago');
    await setOwnerTimeZone(stores.control,ownerZone);

    // Personal assistant off: her chat stops being a profile, nothing new is captured, and a reply may set none.
    await stores.control.query('UPDATE members SET assistant=false WHERE id=$1',[MEMBER_GP_ID]);
    restore();restore=installMembersForTest(fixtureMemberDirectory());
    assert.equal((await scheduleTurn(live,member)).allowed,false);
    await assert.rejects(capture(MEMBER_GP_CHAT),refusedProfile);
    assert.equal(seen.length,1,'nothing more ran');
  } finally {restore();await stores.close();await rm(root,{recursive:true,force:true});}
});
