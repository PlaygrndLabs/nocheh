import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,canonical,digest} from '../src/archive.js';
import {requestAction,decideTelegram,executeApproved} from '../src/actions.js';
import {approvalOperations} from '../src/workflows/approvals.js';
import {advanceWorkflow} from '../src/workflows/engine.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';

test('approval workflows wait for exact owner decisions, preserve receipt identity and close uncertain effects',async()=>{
  const admin=new pg.Pool(),schema='workflow_approvals_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({options:`-c search_path=${schema}`});
  try{
    await initialize(pool);await pauseFamily(pool,'actions',1);await switchFamily(pool,'actions',1,'inngest');
    const source=await ingest(pool,{version:1,key:'fixture:approval-source',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'1',revision:'1',occurred_at:null,text:'Synthetic request',payload:{}});
    const args={destination:'777',text:'Synthetic exact approved text'},action=await requestAction(pool,{scope:null,admin:true,turnEvent:source.id},args);
    const workflow=(await pool.query("SELECT id FROM workflow_registry WHERE family='actions' AND job_id=$1",[action.id])).rows[0].id;
    let calls=0;const identities:string[]=[];
    const operation=approvalOperations(pool,async(name,input)=>{assert.equal(name,'action.execute');assert.deepEqual(input,{id:action.id,...args});identities.push(String(input.id));calls++;if(calls===1)throw Error('lost_response');return {state:'done'};}).actions!;
    const advance=()=>advanceWorkflow(pool,workflow,1,'actions','fixture-run',operation);
    assert.equal((await advance()).waiting_reason,'approval_required');assert.equal(calls,0);
    await assert.rejects(decideTelegram(pool,{scope:null,admin:true},{id:action.id,fingerprint:'wrong',decision:'approve'}),{code:'action_changed'});
    await decideTelegram(pool,{scope:null,admin:true},{id:action.id,fingerprint:digest(canonical(args)),decision:'approve'});
    await executeApproved(pool,async()=>{throw Error('legacy_runner_must_not_execute');});
    assert.equal((await advance()).state,'running');assert.equal(calls,1);
    assert.equal((await advance()).state,'running');assert.equal(calls,1,'receipt wait is not a failed attempt');
    await pool.query("UPDATE action_requests SET updated_at=now()-interval '31 seconds' WHERE id=$1",[action.id]);
    assert.equal((await advance()).state,'completed');assert.deepEqual(identities,[action.id,action.id]);
    assert.equal((await advance()).state,'completed');assert.equal(calls,2);
    assert.equal((await pool.query("SELECT state FROM workflow_receipts WHERE workflow_id=$1",[workflow])).rows[0].state,'done');
    const uncertain=await requestAction(pool,{scope:null,admin:true,turnEvent:source.id},{...args,text:'Other synthetic exact text'});
    await decideTelegram(pool,{scope:null,admin:true},{id:uncertain.id,fingerprint:digest(canonical({...args,text:'Other synthetic exact text'})),decision:'approve'});
    const uncertainWorkflow=(await pool.query("SELECT id FROM workflow_registry WHERE family='actions' AND job_id=$1",[uncertain.id])).rows[0].id;
    const uncertainOperation=approvalOperations(pool,async()=>({state:'ambiguous'})).actions!;
    assert.equal((await advanceWorkflow(pool,uncertainWorkflow,1,'actions','uncertain-run',uncertainOperation)).state,'ambiguous');
    assert.equal((await advanceWorkflow(pool,uncertainWorkflow,1,'actions','duplicate-run',async()=>{throw Error('must_not_restart');})).state,'ambiguous');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
