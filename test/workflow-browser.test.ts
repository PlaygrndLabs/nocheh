import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {captureInput,claimRun,finishRun} from '../src/managed-runs.js';
import {admitBrowser,activeBrowser,browserObservation,browserWorkflowContext,browserAuthority,browserOperation,cancelBrowser} from '../src/workflows/browser.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';
import {setGuardMode} from '../src/guarded.js';

test('browser workflows admit once, reconnect by native session and close cancelled or uncertain runs',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const root=await mkdtemp(join(tmpdir(),'nocheh-browser-workflow-')),namespace='test_browser_wf_'+Date.now();
  const admin=new pg.Pool(connection);await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`,max:6});
  config.dataDir=root;config.assistant={enabled:false,owner_id:'42',group_ids:[]};
  try {
    await initialize(pool);
    const body={id:'one',scope:'42',profile:'owner',conversation:'native-session',text:'Private browser canary',files:[]};
    const captured=await captureInput(pool,config,body),request={...body,event_id:captured.event_id};
    assert.equal((await admitBrowser(pool,config,request)).owned,false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM workflow_registry WHERE family='browser'")).rows[0].n,1);
    await pauseFamily(pool,'browser',1);await switchFamily(pool,'browser',1,'inngest');
    await Promise.all([admitBrowser(pool,config,request),admitBrowser(pool,config,request)]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM workflow_registry WHERE family='browser'")).rows[0].n,1);
    assert.equal((await activeBrowser(pool,config,body)).event_id,captured.event_id);
    const competing=await captureInput(pool,config,{...body,id:'two'});
    await assert.rejects(admitBrowser(pool,config,{...body,event_id:competing.event_id}),/session_busy/);
    await assert.rejects(claimRun(pool,config,{...request,actor:'legacy'}),/workflow_owner_changed/);
    await assert.rejects(browserWorkflowContext(pool,config,{event_id:captured.event_id,owner_epoch:1}),/workflow_owner_changed/);
    let effects=0,started=false;
    const op=browserOperation(pool,config,async(operation,input)=>{
      if(operation==='run.resume')return {state:started?'running':'not_found'};
      assert.equal(operation,'run.start');effects++;started=true;
      const context=await browserWorkflowContext(pool,config,input),authority=await browserAuthority(pool,config,context);
      await claimRun(pool,config,context,'browser',authority);
      // Lose the response after accepting the same native run identity.
      throw Error('acknowledgment lost');
    });
    assert.equal((await op(captured.event_id,{owner:'inngest',epoch:2})).state,'running');
    assert.equal((await op(captured.event_id,{owner:'inngest',epoch:2})).state,'running');assert.equal(effects,1);
    await finishRun(pool,{event_id:captured.event_id,actor:'run_'+captured.event_id,state:'done',session:body.conversation,text:'Private result canary'});
    assert.equal((await op(captured.event_id,{owner:'inngest',epoch:2})).state,'completed');
    assert.equal((await browserObservation(pool,config,request)).text,'Private result canary');
    assert.equal((await activeBrowser(pool,config,body)).active,false);
    const receipt=(await pool.query("SELECT receipt_id FROM workflow_receipts WHERE step='browser'")).rows[0];assert.match(receipt.receipt_id,/^[a-f0-9]{64}$/);
    await admitBrowser(pool,config,{...body,event_id:competing.event_id});
    await cancelBrowser(pool,config,{...body,event_id:competing.event_id});
    assert.equal((await op(competing.event_id,{owner:'inngest',epoch:2})).state,'cancelled');assert.equal(effects,1);
    const lost=await captureInput(pool,config,{...body,id:'lost',conversation:'other-session'});
    await admitBrowser(pool,config,{...body,conversation:'other-session',event_id:lost.event_id});
    const ctx=await browserWorkflowContext(pool,config,{event_id:lost.event_id,owner_epoch:2});
    await claimRun(pool,config,ctx,'browser',await browserAuthority(pool,config,ctx));
    const missing=browserOperation(pool,config,async()=>({state:'not_found'}));
    assert.equal((await missing(lost.event_id,{owner:'inngest',epoch:2})).state,'ambiguous');
    assert.equal((await missing(lost.event_id,{owner:'inngest',epoch:2})).state,'ambiguous');
    await setGuardMode(pool,'on');
    assert.equal((await browserObservation(pool,config,request)).visible,false);assert.equal((await browserObservation(pool,config,request)).text,'');
    await assert.rejects(browserObservation(pool,config,{...request,profile:'other'}),/run_profile_mismatch/);
    const metadata=(await pool.query("SELECT w.id,w.job_id,w.state,w.stage,o.dispatch FROM workflow_registry w JOIN workflow_outbox o ON o.workflow_id=w.id WHERE w.family='browser'")).rows;
    assert.ok(!JSON.stringify(metadata).includes('canary'));
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
});
