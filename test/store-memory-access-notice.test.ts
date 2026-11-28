import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {dashboardInbox} from '../src/stores/memory-access.js';
import {fixtureServices} from './fixture-agent.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('the Inbox link uses only the configured dashboard address',()=>{
  assert.equal(dashboardInbox(''),null);assert.equal(dashboardInbox(undefined),null);assert.equal(dashboardInbox('ftp://example.test'),null);
  assert.equal(dashboardInbox('not a url'),null);assert.equal(dashboardInbox(' https://nocheh.example.test/ '),'https://nocheh.example.test/#inbox');
});

test('several memory sharing suggestions in a row send the owner one notice, with no hidden id and no local link',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-notice-'));
  const label='memory-notice:'+Date.now(),owner:Reader={admin:true,scope:null},group='-'+Date.now()*10,destination=group;
  const previous=process.env.NOCHEH_DASHBOARD_URL;delete process.env.NOCHEH_DASHBOARD_URL;
  // The secret check flags every 64-hex string, as the live model did.
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(label),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[...new Set(String(input.text).match(/[a-f0-9]{64}/g)??[])]};
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    let index=0;
    const capture=async(scope:string,text:string)=>{
      const id=++index,event:Envelope={version:1,key:label+':'+id,origin:'live',kind:'telegram_update',bot_id:label,scope,source_id:String(id),revision:'1',occurred_at:null,text,
        payload:{message:{message_id:id,date:1,chat:{id:Number(scope),type:'supergroup'},from:{id:123,first_name:'Fixture'},text}}};
      const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
    };
    const project=await services.projects.save(owner,{name:'Orion notice',description:'Synthetic fixture',state:'active',expected_revision:0,operation_id:label+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:label+':assign'});
    const entity=await services.entities.ensureProject(project),binding=await services.guards.state();
    for(const [predicate,content] of [['launch_schedule','Orion launch schedule milestone is October.'],['launch_site','Orion launch site is the north field.']] as const) {
      const evidence=await capture(group+'9',content);
      await services.entities.publishClaim({subject_id:entity.id,predicate,content,attribution:'reported',uncertainty:'supported',evidence:[evidence]},binding,label+':'+predicate);
    }
    await services.memoryAccess.saveSettings(owner,{destination,notify_owner:true,auto_followup:false,expected_revision:1,operation_id:label+':settings'});
    const suggest=async(question:string,query:string)=>{
      const source=await capture(group,question),current=await services.guards.state();
      return services.memoryAccess.suggest({admin:false,scope:group,space:destination,turnEvent:source.id,generation:current.generation,guard_epoch:current.epoch},query);
    };
    const first=await suggest('What is the Orion launch schedule?','Orion launch schedule October');
    const second=await suggest('Where is the Orion launch site?','Orion launch site north field');
    assert.ok(first&&second&&first.id!==second.id,'two suggestions wait');
    const notices=(await stores.control.query(`SELECT r.id,a.proposal_reference FROM memory_access_requests r JOIN telegram_action_requests a ON a.id=r.notification_action_id
      WHERE r.id=ANY($1::text[])`,[[first.id,second.id]])).rows;
    assert.equal(notices.length,1,'one notice for both');
    const text=String((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[notices[0].proposal_reference.id])).rows[0].content);
    assert.ok(!text.includes('***')&&!/[a-f0-9]{64}/.test(text),'no id to hide');assert.ok(!text.includes('localhost'),'no local link');
    assert.match(text,/Inbox/);
  } finally {
    if(previous===undefined)delete process.env.NOCHEH_DASHBOARD_URL;else process.env.NOCHEH_DASHBOARD_URL=previous;
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
