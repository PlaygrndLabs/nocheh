import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MemoryDashboard} from '../src/stores/memory-dashboard.js';

test('the unused-facts rule: off by default, saved with its revision, and a daily sweep that waits for its days of tracking (ADR-0299)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords);
  const calls:{before:Date;limit:number}[]=[];let left=450,fail=false,space:{id:string}|null={id:'w'};
  const engine={id:'fake',hideUnused:async(_space:string,before:Date,limit:number)=>{
    if(fail)throw Object.assign(new Error('memory_engine_unavailable'),{code:'memory_engine_unavailable'});
    calls.push({before,limit});const step=Math.min(left,limit);left-=step;return step;}};
  const memory={engine,dashboardSpace:async()=>space} as any;
  const dashboard=new MemoryDashboard(stores,memory,null as any,()=>({}) as any);
  const admin:Reader={admin:true,scope:null};
  try {
    await stores.control.query('UPDATE memory_clean_up SET hide_unused_days=NULL,swept_at=NULL,last_hidden=NULL,tracking_since=now()');
    const start=await dashboard.cleanUp(admin);
    assert.equal(start.hide_unused_days,null,'off by default');assert.equal(start.starts_at,null);
    await assert.rejects(dashboard.cleanUp({admin:false,scope:null} as Reader),/owner_required/,'the owner only');
    assert.equal(await dashboard.sweepUnused(),null,'off never sweeps');
    for(const bad of [{hide_unused_days:29,expected_revision:start.revision},{hide_unused_days:3651,expected_revision:start.revision},
      {hide_unused_days:'180',expected_revision:start.revision},{hide_unused_days:180},{hide_unused_days:180,expected_revision:start.revision,more:1}])
      await assert.rejects(dashboard.saveCleanUp(admin,bad),/invalid_clean_up_request/,JSON.stringify(bad));
    const on=await dashboard.saveCleanUp(admin,{hide_unused_days:180,expected_revision:start.revision,operation_id:'op'});
    assert.equal(on.hide_unused_days,180);assert.equal(on.revision,start.revision+1);
    assert.equal(Date.parse(on.starts_at!)-Date.parse(on.tracking_since),180*86400000,'nothing is hidden before 180 days of tracking');
    await assert.rejects(dashboard.saveCleanUp(admin,{hide_unused_days:90,expected_revision:start.revision}),/clean_up_revision_conflict/);

    // Tracked for only 10 days: the sweep claims its day but hides nothing.
    await stores.control.query("UPDATE memory_clean_up SET tracking_since=now()-interval '10 days'");
    assert.equal(await dashboard.sweepUnused(),null);assert.equal(calls.length,0);
    // Tracked long enough, on the next day: facts unused since 180 days ago are hidden, 200 families a call until none are left.
    await stores.control.query("UPDATE memory_clean_up SET tracking_since=now()-interval '400 days',swept_at=NULL");
    const now=new Date();
    assert.equal(await dashboard.sweepUnused(now),450);
    assert.deepEqual(calls.map(call=>call.limit),[200,200,200,200]);
    assert.equal(calls[0]!.before.getTime(),now.getTime()-180*86400000);
    assert.equal((await dashboard.cleanUp(admin)).last_hidden,450);
    assert.equal(await dashboard.sweepUnused(new Date(now.getTime()+3600000)),null,'at most once a day');
    // A failed sweep is tried again at the next hourly check, not the next day.
    fail=true;const later=new Date(now.getTime()+21*3600000);
    assert.equal(await dashboard.sweepUnused(later),null);
    fail=false;left=3;
    assert.equal(await dashboard.sweepUnused(new Date(later.getTime()+3600000)),3);
    // No long-term memory connected: nothing to sweep.
    space=null;await stores.control.query('UPDATE memory_clean_up SET swept_at=NULL');
    assert.equal(await dashboard.sweepUnused(),null);
    // Turning it off.
    const off=await dashboard.saveCleanUp(admin,{hide_unused_days:null,expected_revision:(await dashboard.cleanUp(admin)).revision});
    assert.equal(off.hide_unused_days,null);
  } finally {
    await stores.control.query('UPDATE memory_clean_up SET hide_unused_days=NULL,swept_at=NULL,last_hidden=NULL');
    await stores.close();
  }
});
