import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {ownerChat} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installMembersForTest,memberDirectory,type MemberDirectory} from '../src/members.js';
import {groupToolsLines,memberDailyLimitReply,notAllowedReply} from '../src/prompts.js';
import {policySnapshot,savePolicy} from '../src/security/store.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {groupToolKind} from '../src/stores/controlled-actions.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {fixtureServices} from './fixture-brain.js';
import {BOB,GP1,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_TG,NG_GROUP_IDS,OWNER,
  fixtureChats,fixtureMemberDirectory,fixtureMembers,groupsPolicy,seedChats,seedMembers,type FixtureMembers} from './fixture-groups.js';

/*
 * Every person check reads the member directory, the owner first (step 3), in both fixture families at once: GP groups
 * keep their old-shaped ids, NG groups have digest ids. The fixture members: MEMBER_GP talks in GP1 (seen in it) and GP2
 * (Telegram saw them leave), is switched off in GP3 and was never seen in GP4; MEMBER_NG talks in NG1 and in NG2, which has
 * no switch row, so it counts as on, and was seen in both.
 */
test('members are checked before every effect in their groups, the owner first, and a change since they asked stops what is still to come',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-gates-')),key='member-gates:'+Date.now();
  const policy=groupsPolicy({group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]});
  const owner:Reader={admin:true,scope:null},refusals:Record<string,any>[]=[],turns:Record<string,any>[]=[],sends:Record<string,any>[]=[];
  let atDelivery:(()=>void)|null=null;
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,groupReplies:{mode:'addressed',names:['Nocheh']},
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:0.1,output:0.5,cache_read:0.01,cache_write:0.1,request:0}};
      if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
      if(operation==='run.start'){turns.push(input);return {state:'done',stage:'assistant'};}
      if(operation==='run.resume')return {state:'done'};
      if(operation==='action.execute') {
        sends.push(input);if(input.observe_only)return {state:'not_found'};
        if(atDelivery) {
          const change=atDelivery;atDelivery=null;change();
          await assert.rejects(s.telegramActions.authorizeDelivery(input),{code:'action_delivery_denied'},'the bot\'s last check finds the member changed');
          return {state:'denied'};
        }
        assert.deepEqual(await s.telegramActions.authorizeDelivery(input),{valid:true});return {state:'done'};
      }
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  // The members as the owner set them, swapped as the owner would change them.
  let restore=installMembersForTest(fixtureMemberDirectory());
  const use=(directory:MemberDirectory)=>{restore();restore=installMembersForTest(directory);};
  const variant=(edit:(fixture:FixtureMembers)=>void)=>{const fixture=fixtureMembers();edit(fixture);return memberDirectory(fixture);};
  const switchedOff=(member:string,chat:string)=>variant(fixture=>{
    fixture.chats=[...fixture.chats.filter(row=>!(row.member_id===member&&row.chat_id===chat)),{member_id:member,chat_id:chat,enabled:false}];});
  const leftIn=(account:string,chat:string)=>variant(fixture=>{
    fixture.presence=fixture.presence.map(row=>row.account_id===account&&row.chat_id===chat?{...row,state:'left' as const}:row);});
  const bot=String(Date.now()).slice(-9);let update=0;
  /** One live Telegram message, taken in as the bot hands it over. Only a message the test dispatches carries its update
   * id: a turn waits for an earlier update in its chat that has not started, and the others are never dispatched here. */
  const capture=async(telegram:string,from:number|string,text:string,extra:Record<string,unknown>={},ordered=false)=>{
    const n=++update,message={message_id:n,date:1700000000+n,chat:{id:Number(telegram),type:'supergroup',is_forum:false},
      from:{id:Number(from),is_bot:false,first_name:'Someone'},text,...extra};
    return (await s.capture.capture({version:1,key:`telegram:${bot}:update:${n}`,origin:'live',kind:'telegram_update',bot_id:bot,scope:telegram,
      source_id:String(n),revision:'1',occurred_at:null,text,payload:ordered?{update_id:n,message}:{message}} as Envelope)).source.reference;
  };
  /** A turn's principal in `chat` (a Nocheh chat id) for a message prepared as the service does. */
  const asked=async(telegram:string,chat:string,from:number|string,text:string):Promise<Reader>=>{
    const source=await capture(telegram,from,text);await s.guards.prepare(source,'fixture',s.detect);
    const binding=await s.guards.state();return {admin:false,scope:chat,space:chat,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const actions=s.telegramActions,tools=s.controlledActions;
  const closed=async(id:string)=>{const view=await actions.inspect(owner,id);return [view.state,view.error_code];};
  const security=await policySnapshot(stores.control);
  try {
    await seedChats(stores.control,fixtureChats([...GP_GROUP_IDS,...NG_GROUP_IDS]));await seedMembers(stores.control);
    await stores.control.query('DELETE FROM member_turns WHERE member_id=ANY($1::text[])',[[MEMBER_GP_ID,MEMBER_NG_ID]]);
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    await s.guards.reconcile();await s.guards.setMode('on');

    // Posts. The owner first: their post from GP1 to GP2 waits for their own card, with no member reviewer, whatever the
    // member directory holds.
    use(memberDirectory({members:[],accounts:[],chats:[],presence:[],owner_account:null}));
    const mine=await actions.request(await asked(GP1,GP1,OWNER,'Tell GP2'),{destination:GP2,text:'From the owner to GP2'});
    assert.equal(mine.state,'proposed');assert.equal(await actions.reviewer(mine.id),null);
    use(fixtureMemberDirectory());
    // A member may post to the groups they reach with their post permission: GP1, where they asked. GP2 (they left), GP3
    // (switched off) and GP4 (never seen there) are not offered, and a post there goes to the owner's card.
    const gp=await asked(GP1,GP1,MEMBER_GP,'Please tell the others');
    assert.deepEqual((await actions.destinations(gp)).groups.map(group=>group.destination),[GP1]);
    for(const destination of [GP2,GP3,GP4]) {
      const post=await actions.request(gp,{destination,text:'From a member to '+destination});
      assert.equal(post.state,'proposed',destination);assert.equal(await actions.reviewer(post.id),null,destination);
      assert.equal((await stores.control.query('SELECT asker_account FROM telegram_action_requests WHERE id=$1',[post.id])).rows[0].asker_account,MEMBER_GP_ACCOUNT);
    }
    // In NG, the member reaches both groups: their post from NG1 to NG2 is theirs to confirm on a card.
    const ng=await asked(NG1_TG,NG1,MEMBER_NG,'Please tell NG2');
    assert.deepEqual((await actions.destinations(ng)).groups.map(group=>group.destination).sort(),[NG1,NG2].sort());
    const across=await actions.request(ng,{destination:NG2,text:'From NG1 to NG2'});
    assert.equal(across.state,'proposed');assert.deepEqual(await actions.reviewer(across.id),{user:MEMBER_NG,space:NG1});
    // With posting to other groups off, a post there is refused before anything is recorded; the same group, a topic of
    // it included, is part of talking.
    use(fixtureMemberDirectory({[MEMBER_NG_ID]:{group_post_other:false}}));
    await assert.rejects(actions.request(ng,{destination:NG2,text:'Never proposed'}),{status:403,code:'member_post_not_allowed'});
    assert.equal((await actions.request(ng,{destination:NG1_TOPIC,text:'To our own topic'})).state,'approved');
    use(fixtureMemberDirectory());

    // A member's approved send goes out only while they may still have it sent: paused since, or switched off in the group,
    // it is closed at the worker, and changed while sending, the bot's last check refuses it.
    const authority=await epoch('actions');
    const here=async(text:string)=>{const post=await actions.request(gp,{destination:'current',text});assert.equal(post.state,'approved');return post.id;};
    const sent=await here('Sent while all is well');
    assert.equal((await actions.run(sent,authority)).state,'completed');assert.equal(sends.at(-1)!.destination,GP1);
    for(const [label,changed] of [['paused',fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}})],['switched off',switchedOff(MEMBER_GP_ID,GP1)]] as const) {
      const id=await here('Asked before the member was '+label),before=sends.length;use(changed);
      assert.equal((await actions.run(id,authority)).state,'cancelled',label);assert.equal(sends.length,before,label);
      assert.deepEqual(await closed(id),['cancelled','member_changed'],label);
      use(fixtureMemberDirectory());
    }
    const raced=await here('Paused while sending');atDelivery=()=>use(fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}}));
    assert.equal((await actions.run(raced,authority)).state,'denied');assert.deepEqual(await closed(raced),['rejected','member_changed']);
    use(fixtureMemberDirectory());
    // A post into another group the member approved on their own card goes out only while they still reach that group:
    // switched off there, or Telegram saying they left, since they pressed Approve closes it, and so does a change while it
    // is sent. A post the owner's card decided keeps the owner's word, though the member never reached that group.
    let made=0;
    const approved=async(principal:Reader,destination:string,card:string)=>{
      const post=await actions.request(principal,{destination,text:'Approved post '+(++made)});assert.equal(post.state,'proposed');
      const row=(await stores.control.query('UPDATE telegram_action_requests SET card_space=$2 WHERE id=$1 RETURNING fingerprint',[post.id,card])).rows[0];
      assert.equal((await actions.decide(owner,{id:post.id,fingerprint:row.fingerprint,decision:'approve'})).state,'approved');return post.id;
    };
    for(const [label,changed] of [['switched off there',switchedOff(MEMBER_NG_ID,NG2)],['left there',leftIn(MEMBER_NG_ACCOUNT,NG2)]] as const) {
      const id=await approved(ng,NG2,NG1),before=sends.length;use(changed);
      assert.equal((await actions.run(id,authority)).state,'cancelled',label);assert.equal(sends.length,before,label);
      assert.deepEqual(await closed(id),['cancelled','member_changed'],label);
      use(fixtureMemberDirectory());
    }
    const crossed=await approved(ng,NG2,NG1);atDelivery=()=>use(switchedOff(MEMBER_NG_ID,NG2));
    assert.equal((await actions.run(crossed,authority)).state,'denied');assert.deepEqual(await closed(crossed),['rejected','member_changed']);
    use(fixtureMemberDirectory());
    const owners=await approved(gp,GP2,ownerChat(policy)!);
    assert.equal((await actions.run(owners,authority)).state,'completed');assert.equal(sends.at(-1)!.destination,GP2);

    // Web pages and outside tools. A member's web page read or outside tool call in a group runs with no card, under the
    // group's tools permission, and keeps who asked; a command still waits for the owner's card.
    const web=(principal:Reader,path:string)=>tools.propose(principal,{kind:'browser',arguments:{url:'https://example.com/'+path}});
    const read=await web(await asked(GP1,GP1,MEMBER_GP,'Read the page'),'member');
    assert.deepEqual([read.state,(read as any).allowed,(read as any).message],['approved',true,groupToolsLines(undefined).allowed_follow_up]);
    const row=await tools.row(read.id);assert.deepEqual([row.authority,row.asker_account],['group_tools',MEMBER_GP_ACCOUNT]);
    const outside=await tools.propose(await asked(NG2_TG,NG2,MEMBER_NG,'Ask the tool'),{kind:'mcp',arguments:{url:'https://example.com/mcp',tool:'search',input:{q:'made-up'}}});
    assert.equal(outside.state,'approved','an outside tool in NG2, which has no switch row');
    const command=await tools.propose(await asked(GP1,GP1,MEMBER_GP,'Run it'),{kind:'shell',arguments:{command:'printf member'}});
    assert.equal(command.state,'proposed');assert.equal((await tools.row(command.id)).authority,null);
    assert.equal(groupToolKind('mcp',{connection:'notion',tool:'notion-search',input:{}}),false,'Notion stays the owner\'s own');
    // The owner's own request in a group needs no card either (the one switch in groupToolsGrant), and has no asker.
    const owned=await web(await asked(GP1,GP1,OWNER,'Read it for me'),'owner');
    assert.equal(owned.state,'approved');assert.deepEqual([(await tools.row(owned.id)).authority,(await tools.row(owned.id)).asker_account],['group_tools',null]);
    // With their tools permission off, a member's request is refused before anything is recorded.
    use(fixtureMemberDirectory({[MEMBER_GP_ID]:{group_tools:false}}));
    await assert.rejects(web(await asked(GP1,GP1,MEMBER_GP,'Read again'),'off'),{status:403,code:'tool_not_permitted'});
    use(fixtureMemberDirectory());
    // The owner's tool switch for the chat comes first, and so does a deny rule.
    const switches=async(changes:Record<string,boolean|null>)=>s.chatTools.save(owner,{space:GP1,changes,expected_revision:(await s.chatTools.get(owner,GP1)).revision});
    await switches({browser:false});
    try{await assert.rejects(web(await asked(GP1,GP1,MEMBER_GP,'Read when off'),'switched'),{status:403,code:'tool_disabled_by_owner'});}finally{await switches({browser:null});}
    await savePolicy(stores.control,owner,{expected_revision:security.revision,policy:{version:1,rules:[...security.policy.rules,{id:key+':deny',kind:'browser',outcome:'deny'}]}});
    try {
      const denied=await web(await asked(GP1,GP1,MEMBER_GP,'Read when denied'),'denied');
      assert.notEqual(denied.state,'approved');assert.equal((await tools.row(denied.id)).authority,null);
    }finally{await savePolicy(stores.control,owner,{expected_revision:(await policySnapshot(stores.control)).revision,policy:security.policy});}
    // At the claim, right before it runs, the member is checked again: their tools permission turned off since stops it.
    const host=async(id:string)=>{
      const registered=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
      const lease=await claimHostWorkflow(stores.control,{workflow_id:registered.id,dispatch:registered.dispatch,family:'tools',run_id:'fixture-'+registered.id});
      assert.equal(lease.claimed,true);return {id,actor:'wf-'+registered.id,workflow_id:registered.id,workflow_token:lease.token};
    };
    const later=await web(await asked(GP1,GP1,MEMBER_GP,'Read it later'),'later'),lb=await host(later.id);
    use(fixtureMemberDirectory({[MEMBER_GP_ID]:{group_tools:false}}));
    assert.deepEqual(await s.controlledExecution.claim(lb),{claimed:false,blocked:later.id,reason:'member_changed'});
    use(fixtureMemberDirectory());
    assert.equal((await s.controlledExecution.claim(await host(read.id))).claimed,true,'an unchanged member\'s request runs');

    // Jobs: no daily count, four in a day all start, each the member's own to approve; the jobs permission decides.
    const started:string[]=[];
    for(let n=1;n<=4;n++) {
      const job=await s.jobs.start(await asked(GP1,GP1,MEMBER_GP,'Job '+n),{title:'Member job '+n,instruction:'Read what is open.'});
      assert.deepEqual([job.state,job.approver],['proposed','requester'],'job '+n);started.push(job.id);
    }
    const job=started[0]!;
    assert.equal(await s.jobs.presser(job,MEMBER_GP,GP1),true);
    for(const [label,changed] of [['paused',fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}})],['left',leftIn(MEMBER_GP_ACCOUNT,GP1)],
      ['switched off',switchedOff(MEMBER_GP_ID,GP1)],['jobs off',fixtureMemberDirectory({[MEMBER_GP_ID]:{group_jobs:false}})]] as const) {
      use(changed);
      assert.equal(s.jobs.permitted(await s.jobs.row(job)),false,label);assert.equal(await s.jobs.presser(job,MEMBER_GP,GP1),false,label);
    }
    await assert.rejects(s.jobs.start(await asked(GP1,GP1,MEMBER_GP,'Job off'),{title:'Refused job',instruction:'Read it.'}),{status:403,code:'job_not_permitted'});
    use(memberDirectory({members:[],accounts:[],chats:[],presence:[],owner_account:null}));
    assert.equal((await s.jobs.start(await asked(GP1,GP1,OWNER,'Owner job'),{title:'Owner job',instruction:'Read it.'})).state,'proposed','the owner needs no permission');
    use(fixtureMemberDirectory());
    const ngJob=await s.jobs.start(await asked(NG2_TG,NG2,MEMBER_NG,'NG job'),{title:'NG job',instruction:'Read it.'});
    assert.equal(await s.jobs.presser(ngJob.id,MEMBER_NG,NG2),true,'NG2 has no switch row, so it counts as on');
    use(switchedOff(MEMBER_NG_ID,NG2));assert.equal(await s.jobs.presser(ngJob.id,MEMBER_NG,NG2),false);
    use(fixtureMemberDirectory());

    // The daily message cap: every member turn that addresses Nocheh counts once, across groups; the owner's never.
    use(memberDirectory({...fixtureMembers(),daily_messages:2}));
    const dispatch=async(telegram:string,from:number|string,text:string,extra:Record<string,unknown>={})=>{
      const source=await capture(telegram,from,text,extra,true);
      await s.preparation.run(source.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
      await s.telegram.run(source.id,await epoch('telegram'));
      const row=(await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[source.id])).rows[0];
      return {id:source.id,state:row?.state as string,error_code:row?.error_code as string|null,turn:turns.some(turn=>turn.event_id===source.id)};
    };
    const counted=async(member:string)=>Number((await stores.control.query('SELECT count(*) FROM member_turns WHERE member_id=$1',[member])).rows[0].count);
    const chatter=await dispatch(GP1,MEMBER_GP,'Lunch is at noon');
    assert.deepEqual([chatter.error_code,chatter.turn,await counted(MEMBER_GP_ID)],['not_addressed',false,0],'chatter is not counted');
    const first=await dispatch(GP1,MEMBER_GP,'Nocheh, what is open?'),second=await dispatch(GP1,MEMBER_GP,'Nocheh, and now?');
    assert.deepEqual([first.turn,second.turn,await counted(MEMBER_GP_ID)],[true,true,2]);
    assert.equal(await (s.telegram as any).overDailyCap(MEMBER_GP_ID,second.id),false,'a retry of the same event counts once');
    assert.equal(await counted(MEMBER_GP_ID),2);
    const before=refusals.length,over=await dispatch(GP1,MEMBER_GP,'Nocheh, one more?');
    assert.deepEqual([over.state,over.error_code,over.turn],['suppressed','member_daily_limit',false]);
    assert.equal(refusals.length,before+1);
    assert.deepEqual({...refusals.at(-1),event_id:undefined,message_id:undefined},{event_id:undefined,message_id:undefined,chat_id:GP1,user_id:MEMBER_GP,once:'daily_limit',reply:memberDailyLimitReply});
    for(let n=0;n<3;n++)assert.equal((await dispatch(GP1,OWNER,'Nocheh, owner here '+n)).turn,true,'the owner is never counted');
    assert.equal((await dispatch(NG1_TG,MEMBER_NG,'Nocheh, from NG1')).turn,true,'each member has their own count');
    use(fixtureMemberDirectory());

    // Who may not talk there and addresses Nocheh, a stranger or a paused member, gets the owner's fixed reply, which the bot
    // sends at most once a day per group (`once`); nobody's message gets nothing.
    const refused=async(label:string,from:number|string,changed:MemberDirectory|null)=>{
      if(changed)use(changed);const count=refusals.length,result=await dispatch(GP1,from,'Nocheh, are you there?');use(fixtureMemberDirectory());
      assert.deepEqual([result.error_code,result.turn,refusals.length],['not_allowed',false,count+1],label);
      assert.deepEqual([refusals.at(-1)!.once,refusals.at(-1)!.reply,refusals.at(-1)!.user_id],['not_allowed',notAllowedReply,String(from)],label);
    };
    await refused('a stranger',BOB,null);
    await refused('a paused member',MEMBER_GP,fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}}));
    await refused('a member switched off there',MEMBER_GP,switchedOff(MEMBER_GP_ID,GP1));
    const quiet=refusals.length;
    const named=await dispatch(GP1,MEMBER_GP,'Nocheh, in the channel\'s name',{sender_chat:{id:-1003000000001,type:'channel',title:'Made-up channel'}});
    const proxy=await dispatch(GP1,777000,'Nocheh, from Telegram itself');
    const unaddressed=await dispatch(GP1,BOB,'Just chatting');
    assert.deepEqual([named.turn,proxy.turn,unaddressed.turn,refusals.length],[false,false,false,quiet],'nobody\'s message and chatter get no reply');
  }finally{restore();await stores.close();await rm(root,{recursive:true,force:true});}
});
