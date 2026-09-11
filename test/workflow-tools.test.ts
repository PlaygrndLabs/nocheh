import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,digest} from '../src/archive.js';
import {proposeControlled,controlledAction,claimControlled,startControlled,finishControlled,decideControlled,grantPermission,revokePermission} from '../src/controlled-actions.js';
import {claimHostWorkflow,finishHostWorkflow} from '../src/workflows/host-coordinator.js';
import {hostActionAuthority} from '../src/workflows/host-tools.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';
import {setGuardMode} from '../src/guarded.js';

test('host tool workflows fence targets, preserve one executor, recheck revocation and never restart uncertain effects',async()=>{
  const admin=new pg.Pool(),schema='workflow_tools_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({options:`-c search_path=${schema}`,max:8}),owner={scope:null,admin:true};
  try{
    await initialize(pool);await setGuardMode(pool,'on');await pauseFamily(pool,'tools',1);await switchFamily(pool,'tools',1,'inngest');
    async function propose(label:string,command=label){
      const source=await ingest(pool,{version:1,key:'tool-source:'+label,channel:'browser',origin:'live',bot_id:'fixture',kind:'browser_input',scope:'123',source_id:label,revision:'0',occurred_at:null,text:'Synthetic request',payload:{profile:'nocheh-'+digest('123').slice(0,24)}});
      const result=await proposeControlled(pool,{...owner,turnEvent:source.id},{kind:'shell',arguments:{command}});
      return controlledAction(pool,owner,result.id);
    }
    async function approve(action:any){return decideControlled(pool,owner,{id:action.id,fingerprint:action.fingerprint,decision:'approve'});}
    async function acquire(action:any){
      const workflow_id=(await pool.query("SELECT id FROM workflow_registry WHERE family='tools' AND job_id=$1",[action.id])).rows[0].id;
      const request={workflow_id,dispatch:1,family:'tools',run_id:'fixture-'+action.id};
      const lease=await claimHostWorkflow(pool,request);
      const input={id:action.id,actor:'wf-'+workflow_id,workflow_id,workflow_token:lease.token};
      return {lease,input,request,finish:(result:unknown={completed:1})=>finishHostWorkflow(pool,{workflow_id,token:lease.token,result})};
    }
    const first=await propose('first');let work=await acquire(first);
    assert.equal((await claimControlled(pool,work.input,first.id,await hostActionAuthority(pool,work.input))).claimed,false);
    assert.equal((await work.finish()).waiting_reason,'approval_required');await approve(first);work=await acquire(first);
    assert.equal((await claimControlled(pool,{actor:'legacy'})).claimed,false);
    await assert.rejects(hostActionAuthority(pool,{...work.input,workflow_token:randomUUID()}),{code:'workflow_lease_closed'});
    const authority=await hostActionAuthority(pool,work.input);
    assert.equal((await claimControlled(pool,work.input,first.id,authority)).claimed,true);
    const second=await propose('second');await approve(second);let queued=await acquire(second);
    assert.equal((await claimControlled(pool,queued.input,second.id,await hostActionAuthority(pool,queued.input))).claimed,false,'the host retains one tool executor');
    assert.equal((await queued.finish()).waiting_reason,'prerequisite');
    await pauseFamily(pool,'tools',2);
    assert.equal((await startControlled(pool,work.input,authority)).started,true,'already claimed work drains under its exact owner epoch');
    await finishControlled(pool,{id:first.id,actor:work.input.actor,state:'done',result:{exit_code:0}});
    const receipt=await work.finish();assert.equal(receipt.state,'completed');assert.deepEqual(await work.finish(),receipt);
    assert.equal((await pool.query("SELECT receipt_id FROM workflow_receipts WHERE workflow_id=$1",[work.input.workflow_id])).rows[0].receipt_id,(await controlledAction(pool,owner,first.id)).result_id);
    await pool.query("UPDATE workflow_owners SET admission=true WHERE family='tools'");
    const permitted=await propose('permitted','first');const grant=await grantPermission(pool,owner,{action_id:first.id,fingerprint:first.fingerprint,uses:1,minutes:5});
    const permissionWork=await acquire(permitted);const permissionAuthority=await hostActionAuthority(pool,permissionWork.input);
    assert.equal((await claimControlled(pool,permissionWork.input,permitted.id,permissionAuthority)).claimed,true);
    await revokePermission(pool,owner,{id:grant.id});
    assert.equal((await startControlled(pool,permissionWork.input,permissionAuthority)).started,false);
    await finishControlled(pool,{id:permitted.id,actor:permissionWork.input.actor,state:'failed',result:{error:'security_start_denied'}});
    assert.equal((await permissionWork.finish()).state,'failed');
    queued=await acquire(second);const secondAuthority=await hostActionAuthority(pool,queued.input);
    assert.equal((await claimControlled(pool,queued.input,second.id,secondAuthority)).claimed,true);
    await pool.query("UPDATE controlled_actions SET lease_until=now()-interval '1 second' WHERE id=$1",[second.id]);
    assert.equal((await claimControlled(pool,queued.input,second.id,secondAuthority)).claimed,false);
    assert.equal((await queued.finish()).state,'ambiguous');
    assert.equal((await claimHostWorkflow(pool,queued.request)).observation?.state,'ambiguous');
    const changed=await propose('changed');await approve(changed);const changedWork=await acquire(changed);
    await pool.query('UPDATE guard_state SET epoch=epoch+1');
    assert.equal((await claimControlled(pool,changedWork.input,changed.id,await hostActionAuthority(pool,changedWork.input))).claimed,false);
    assert.equal((await changedWork.finish()).state,'denied');
    assert.equal((await controlledAction(pool,owner,changed.id)).state,'rejected');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
