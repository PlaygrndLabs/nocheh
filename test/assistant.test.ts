import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {digest,ingest,type Envelope} from '../src/archive.js';
import {immutableFile} from '../src/storage.js';
import {conversationScope} from '../src/assistant-policy.js';
import {prepareArchiveFiles} from '../src/preparation.js';
import {dispatchCommitted} from '../src/assistant.js';
import {requestAction,controlReply,executeApproved} from '../src/actions.js';

const policy={enabled:true,owner_id:'123',group_ids:['-20','-30']};
const update=(chat:number,user:number,type='group')=>({update_id:1,message:{message_id:7,chat:{id:chat,type},from:{id:user,is_bot:false},text:'exact Aws 😃\r\n '}});
test('only owner private messages receive owner scope; selected groups stay group-local even for the owner',()=>{
  assert.equal(conversationScope(policy,update(123,123,'private'),'123')?.owner,true);
  assert.equal(conversationScope(policy,update(-20,123),'-20')?.owner,false);
  assert.equal(conversationScope(policy,update(123,456,'private'),'123'),null);
  assert.equal(conversationScope(policy,update(-99,123),'-99'),null);
  assert.equal(conversationScope(policy,{edited_message:update(-20,123).message},'-20'),null);
  assert.throws(()=>conversationScope(policy,update(-20,123),'-30'),{code:'source_scope_mismatch'});
});

test('real PostgreSQL: action proposals require a bound turn; only a captured owner DM can approve exact immutable arguments',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace=`actions_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const input:Envelope={version:1,key:'action:source',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-20',source_id:'1',revision:'1',occurred_at:null,text:'Please contact another chat',payload:update(-20,456)};
  try {
    await initialize(pool);const source=await ingest(pool,input);
    await assert.rejects(requestAction(pool,{scope:'-20',admin:false},{destination:'777',text:'Synthetic external message'}),{code:'assistant_turn_required'});
    await assert.rejects(requestAction(pool,{scope:'-30',admin:false,turnEvent:source.id},{destination:'777',text:'Synthetic external message'}),{code:'action_scope_denied'});
    const action=await requestAction(pool,{scope:'-20',admin:false,turnEvent:source.id},{destination:'777',text:'Synthetic external message'});
    let sends=0;await executeApproved(pool,async()=>{sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});assert.equal(sends,0);
    const group=await ingest(pool,{...input,key:'action:group-approval',payload:{...update(-20,123),message:{...update(-20,123).message,text:'/approve '+action.id}}});
    assert.match((await controlReply(pool,policy,group.id))!,/Only the owner/);
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'proposed');
    const ownerMessage={...update(123,123,'private'),message:{...update(123,123,'private').message,text:'/approve '+action.id}};
    const historical=await ingest(pool,{...input,key:'action:historical-approval',origin:'import',scope:'123',payload:ownerMessage});
    assert.equal(await controlReply(pool,policy,historical.id),null);
    const owner=await ingest(pool,{...input,key:'action:owner-approval',scope:'123',payload:ownerMessage});
    const approved=await controlReply(pool,policy,owner.id);assert.match(approved!,/approved/);
    assert.equal(await controlReply(pool,policy,owner.id),approved);
    await executeApproved(pool,async(path,body)=>{assert.equal(path,'action.execute');assert.deepEqual(body,{id:action.id,destination:'777',text:'Synthetic external message'});sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});assert.equal(sends,1);
    assert.equal(await controlReply(pool,policy,owner.id),approved,'decision replay remains idempotent after delivery');
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'done');
    const uncertain=await requestAction(pool,{scope:'-20',admin:false,turnEvent:source.id},{destination:'777',text:'Another synthetic message'});
    const decision=await ingest(pool,{...input,key:'action:second-approval',scope:'123',payload:{...ownerMessage,message:{...ownerMessage.message,text:'/approve '+uncertain.id}}});
    await controlReply(pool,policy,decision.id);
    let attempts=0;
    await executeApproved(pool,async()=>{attempts++;throw Error('receipt response lost');},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{attempts++;throw Error('must wait before fetching receipt');},undefined,{owner:'inngest',epoch:1});
    assert.equal(attempts,1);
    await pool.query("UPDATE action_requests SET updated_at=now()-interval '31 seconds' WHERE id=$1",[uncertain.id]);
    await executeApproved(pool,async(_path,body)=>{attempts++;assert.equal((body as {id:string}).id,uncertain.id);return {state:'ambiguous'};},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{throw Error('ambiguous action must not resend');},undefined,{owner:'inngest',epoch:1});
    assert.equal(attempts,2);
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

test('real PostgreSQL: voice is stored as derived text before dispatch; quotas pause, uncertain RPC reuses receipt identity, history never replies',{skip:!process.env.PGHOST},async()=>{
  const config={...settings(),assistant:policy};
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace=`assistant_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const root=await mkdtemp(join(tmpdir(),'nocheh-assistant-'));config.dataDir=root;
  const value:Envelope={version:1,key:'telegram:fixture:update:1',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-20',source_id:'7',revision:'1',occurred_at:'1700000000',text:null,
    payload:{update_id:1,message:{message_id:7,chat:{id:-20,type:'group'},from:{id:123,is_bot:false},voice:{file_id:'voice1'}}}};
  try {
    await initialize(pool);const event=await ingest(pool,value);let calls=0;
    await dispatchCommitted(pool,config,async()=>{calls++;throw Error('not ready');},undefined,{owner:'inngest',epoch:1});assert.equal(calls,0);
    const audio=Buffer.from('synthetic Ogg bytes');
    await immutableFile(join(root,'files'),digest(audio),audio);
    await pool.query("UPDATE artifacts SET state='ready',file_hash=$1,byte_size=$2",[digest(audio),audio.length]);
    await pool.query('UPDATE dispatches SET next_attempt=now()');
    await prepareArchiveFiles(pool,root,async(path)=>{assert.equal(path,'perception.transcribe');calls++;return {success:false,error:'quota_paused'};},event.id,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT error_code FROM transcription_jobs')).rows[0].error_code,'quota_paused');
    await pool.query('UPDATE transcription_jobs SET next_attempt=now()');await pool.query('UPDATE dispatches SET next_attempt=now()');
    const transcript='😃 Juniper is due Friday.\r\n  ';let firstAttempt=0;
    await prepareArchiveFiles(pool,root,async()=>{calls++;return {success:true,transcript};},event.id,{owner:'inngest',epoch:1});
    await dispatchCommitted(pool,config,async(path,body)=>{
      calls++;
      assert.equal(path,'run.start');assert.equal(body.asynchronous,true);
      const request=body as {attempt:number;archive_credential:string;transcripts:string[]};firstAttempt=request.attempt;
      assert.deepEqual(request.transcripts,[transcript]);
      const claims=JSON.parse(Buffer.from(request.archive_credential.split('.')[1]!,'base64url').toString());assert.equal(claims.scope,'-20');
      assert.equal((await pool.query('SELECT count(*) FROM derived_artifacts')).rows[0].count,'1');
      throw Error('response lost after possible delivery');
    },undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches')).rows[0].state,'running');
    await pool.query('UPDATE dispatches SET next_attempt=now()');
    await dispatchCommitted(pool,config,async(path,body)=>{assert.equal(path,'run.resume');assert.equal((body as {attempt:number}).attempt,firstAttempt);return {state:'done'};},undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT content FROM derived_artifacts')).rows[0].content.toString(),transcript);
    assert.equal((await pool.query('SELECT original_text FROM events')).rows[0].original_text,null);
    await ingest(pool,{...value,key:'historical:voice1',origin:'import'});
    await dispatchCommitted(pool,config,async()=>{throw Error('history must not dispatch');},undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[event.id])).rows[0].state,'done');
    assert.equal(calls,3);
    const other={...value,key:'telegram:fixture:update:2',text:'other',payload:update(-20,456)};
    const second=await ingest(pool,other);
    await dispatchCommitted(pool,config,async()=>({state:'ambiguous',error_code:'delivery_unconfirmed'}),undefined,{owner:'inngest',epoch:1});
    await dispatchCommitted(pool,config,async()=>{throw Error('ambiguous delivery must not resend');},undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[second.id])).rows[0].state,'ambiguous');
    const malformed=await ingest(pool,{...other,key:'telegram:fixture:update:3',payload:update(-30,456)});
    const later=await ingest(pool,{...other,key:'telegram:fixture:update:4'});
    await dispatchCommitted(pool,config,async()=>{throw Error('invalid scope must not reach Hermes');},undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT error_code FROM dispatches WHERE event_id=$1',[malformed.id])).rows[0].error_code,'invalid_source_message');
    await dispatchCommitted(pool,config,async()=>({state:'done'}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[later.id])).rows[0].state,'done');
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
});
