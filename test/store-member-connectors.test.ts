import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installMembersForTest} from '../src/members.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {githubReposHere,githubRunRefusal} from '../src/stores/github-lookups.js';
import {memberChatProjects} from '../src/stores/member-reads.js';
import {notionConnectionsHere,notionRunRefusal} from '../src/stores/notion.js';
import {fixtureServices} from './fixture-agent.js';
import {GP1,GP2,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,NG1,NG_GROUP_IDS,OWNER,P1,fixtureChats,fixtureMemberDirectory,
  groupsPolicy,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

/*
 * A member's private chat reads its projects' connectors (ADR-0278): the Notion and GitHub of each active project that
 * holds a group the member reads, whether or not the project shares its group chats; only reads that need no card, and
 * never another project's, the owner's own, or anything once the member leaves the group. Checked again before it runs.
 */
test('a member\'s private chat reads its projects\' Notion and GitHub, with no card, and nothing else',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-connectors-')),key='member-connectors:'+Date.now();
  const policy=groupsPolicy({group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]}),owner:Reader={admin:true,scope:null};
  const restore=installMembersForTest(fixtureMemberDirectory());
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const other='c4'.repeat(32),widgets='example-org/widgets',gadgets='example-org/gadgets',mine='example-org/mine';
  let serial=0;
  /** A live message in the member's own private chat, as their bound reader. */
  const memberTurn=async(text:string):Promise<Reader>=>{
    const n=++serial,message={message_id:n,date:1700000000+n,chat:{id:Number(MEMBER_GP),type:'private'},from:{id:Number(MEMBER_GP),is_bot:false,first_name:'Someone'},text};
    const source=(await s.capture.capture({version:1,key:key+':'+n,origin:'live',kind:'telegram_update',bot_id:key,scope:MEMBER_GP,source_id:String(n),revision:'1',
      occurred_at:null,text,payload:{message}} as Envelope)).source.reference;
    await s.guards.prepare(source,'fixture',s.detect);
    await stores.control.query("INSERT INTO member_turns(member_id,event_id,day,left_out) VALUES($1,$2,current_date,'{}') ON CONFLICT DO NOTHING",[MEMBER_GP_ID,source.id]);
    const binding=await s.guards.state();
    return s.access.bindReads({admin:false,scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,
      revision:binding.epoch,member:MEMBER_GP_ID});
  };
  const ask=async(text:string,args:Record<string,unknown>)=>{
    const reader=await memberTurn(text);
    return {reader,result:await s.controlledActions.propose(reader,{kind:'mcp',arguments:args})};
  };
  const notion=(project:string|null,tool:string,input:Record<string,unknown>)=>({connection:'notion',...(project?{project}:{}),tool,input});
  const search=(project:string|null)=>notion(project,'notion-search',{query:'reading list'});
  const create=notion(P1,'notion-create-pages',{pages:[{properties:{title:'Plan'}}]});
  const look=(repo:string)=>({connection:'github',tool:'search_code',input:{repo,query:'made up'}});
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[id])).rows[0];
  const kept=async()=>Number((await stores.control.query('SELECT count(*) FROM controlled_actions')).rows[0].count);
  const readOnly={status:403,code:'member_private_read_only'};
  try {
    await seedChats(stores.control,fixtureChats([...GP_GROUP_IDS,...NG_GROUP_IDS]));await seedMembers(stores.control);await seedGroups(stores.control);
    // Telegram confirmed her in GP1 and GP3 lately; GP3 is switched off for her, and she left GP2. P1 holds GP1-GP3 and
    // does not share its group chats; another project holds only NG1, where she is not.
    await stores.control.query('UPDATE chat_memberships SET checked_at=now() WHERE account_id=$1',[MEMBER_GP_ACCOUNT]);
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'Other','active',1) ON CONFLICT(id) DO NOTHING",[other]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO NOTHING",[NG1,other]);
    await s.guards.reconcile();await s.guards.setMode('on');
    for(const project of [P1,other])await s.notion.save(owner,{project,enabled:true,expected_revision:0});
    await s.jobs.setRepoProject(owner,{repo:widgets,project:P1});await s.jobs.setRepoProject(owner,{repo:gadgets,project:other});
    assert.deepEqual(await memberChatProjects(stores.control,MEMBER_GP_CHAT,OWNER),{member:MEMBER_GP_ID,projects:[P1]},'P1 through GP1, sharing off');

    // A read of P1's Notion and a lookup in P1's repository run with no card.
    const read=await ask('What is on our reading list?',search(P1));
    assert.equal(read.result.state,'approved');
    const lookup=await ask('Search our code',look(widgets));
    assert.equal(lookup.result.state,'approved');
    assert.equal((await stores.control.query("SELECT 1 FROM security_events WHERE rule=$1 AND state='allowed'",['github_read:'+P1])).rowCount,1);
    // The same lookup asked again in that turn is the one already there.
    assert.equal((await s.controlledActions.propose(lookup.reader,{kind:'mcp',arguments:look(widgets)})).id,lookup.result.id);
    const turn=await s.turns.binding(read.reader);
    assert.deepEqual(await notionConnectionsHere(stores.control,read.reader,turn),[{connection:P1,name:'Notion of the project P1'}]);
    assert.deepEqual(await githubReposHere(stores.control,read.reader,turn),{repos:[{repo:widgets,project:'P1'}]});

    // Never a change, nor a read that would ask, and nothing of them is kept; never another project's or the owner's own.
    const before=await kept();
    await assert.rejects(ask('Add a page',create),readOnly);
    await assert.rejects(ask('Read this',notion(P1,'notion-fetch',{id:'https://example.com/page'})),readOnly,'an outside address counts as a change');
    await s.notion.save(owner,{project:P1,approval:'everything',expected_revision:(await s.notion.get(owner,P1)).revision});
    await assert.rejects(ask('Search when everything asks',search(P1)),readOnly);
    await s.notion.save(owner,{project:P1,approval:'changes',expected_revision:(await s.notion.get(owner,P1)).revision});
    await assert.rejects(ask('Search theirs',search(other)),{code:'notion_not_here'});
    await assert.rejects(ask('Search the owner\'s',search(null)),{code:'notion_owner_private_only'});
    for(const repo of [gadgets,mine])await assert.rejects(ask('Search that code',look(repo)),{code:'github_not_here'},repo);
    await assert.rejects(ask('Read my mail',{connection:'gmail',tool:'search_mail',input:{query:'x'}}),readOnly);
    const plain=await memberTurn('Open a page');
    await assert.rejects(s.controlledActions.propose(plain,{kind:'browser',arguments:{url:'https://example.com/'}}),readOnly);
    await assert.rejects(s.controlledActions.propose(plain,{kind:'mcp',arguments:{url:'https://example.com/mcp',operation:'list'}}),readOnly);
    assert.equal(await kept(),before);

    // Right before it runs: still her open chat, still reading a group of that active project, and only a read.
    const asked=await row(read.result.id),looked=await row(lookup.result.id);
    assert.equal(await notionRunRefusal(stores.control,asked,OWNER,search(P1)),null);
    assert.equal(await notionRunRefusal(stores.control,asked,OWNER,create),'notion_not_here');
    assert.equal(await githubRunRefusal(stores.control,looked,OWNER,look(widgets)),null);
    await stores.control.query("UPDATE chat_memberships SET state='left' WHERE account_id=$1 AND chat_id=$2",[MEMBER_GP_ACCOUNT,GP1]);
    assert.equal(await notionRunRefusal(stores.control,asked,OWNER,search(P1)),'notion_not_here','she left GP1');
    assert.equal(await githubRunRefusal(stores.control,looked,OWNER,look(widgets)),'github_not_here');
    await assert.rejects(ask('Search again',search(P1)),{code:'notion_not_here'});
    await stores.control.query("UPDATE chat_memberships SET state='in' WHERE account_id=$1 AND chat_id=$2",[MEMBER_GP_ACCOUNT,GP1]);
    await stores.control.query('UPDATE members SET private_chat=false WHERE id=$1',[MEMBER_GP_ID]);
    assert.equal(await notionRunRefusal(stores.control,asked,OWNER,search(P1)),'notion_not_here','private chat off');
    await stores.control.query('UPDATE members SET private_chat=true WHERE id=$1',[MEMBER_GP_ID]);
    await stores.control.query("UPDATE projects SET state='archived' WHERE id=$1",[P1]);
    assert.equal(await githubRunRefusal(stores.control,looked,OWNER,look(widgets)),'github_not_here','an archived project');
    void GP2;
  } finally {restore();await stores.close();await rm(root,{recursive:true,force:true});}
});
