import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { attachmentRefs, canonical, digest, ingest, archiveStatus, type Envelope } from '../src/archive.js';
import { initialize } from '../src/database.js';
import { settings } from './fixture-settings.js';
import { drainSpool, fetchAttachments, immutableFile, reconcileLegacyDeliveries } from '../src/storage.js';
import {runInput} from '../src/run-source.js';
import {readEvent, importRecord,search} from '../src/retrieval.js';
import {browseData} from '../src/guarded.js';

test('a message keeps its own files, not those of a message it replies to or pins',()=>{
  const voice={file_id:'replied-voice',file_unique_id:'v',duration:3};
  const refs=attachmentRefs({update_id:1,message:{message_id:2,document:{file_id:'own-file',file_unique_id:'d',file_name:'notes.txt'},
    reply_to_message:{message_id:1,voice},external_reply:{chat:{id:-5},document:{file_id:'other-chat-file',file_unique_id:'x'}},
    pinned_message:{message_id:0,photo:[{file_id:'pinned-photo',file_unique_id:'p',width:1,height:1}]}}});
  assert.deepEqual(refs.map(ref=>[ref.kind,ref.ref]),[['document','own-file']]);
});

test('a picture Telegram sends in several sizes is one file at its largest size; the update keeps every size',()=>{
  const size=(id:string,width?:number,height?:number,file_size?:number)=>({file_id:id,file_unique_id:'u-'+id,
    ...(width===undefined?{}:{width}),...(height===undefined?{}:{height}),...(file_size===undefined?{}:{file_size})});
  const files=(payload:Record<string,unknown>)=>attachmentRefs(payload).map(ref=>[ref.kind,ref.ref]);
  const photo=[size('medium',320,240,9000),size('large',1280,960,90000),size('small',90,68,1200),size('wide',1000,1000,80000)];
  const update={update_id:1,message:{message_id:2,caption:'Synthetic garden sign',photo}};
  assert.deepEqual(files(update),[['photo','large']],'sizes out of order: the biggest area');
  assert.deepEqual(attachmentRefs(update)[0]!.metadata,photo[1],'its own size only');
  assert.equal(update.message.photo.length,4,'the update itself is unchanged');
  assert.deepEqual(files({message:{photo:[size('a',640,480,5000),size('b',480,640,7000)]}}),[['photo','b']],'the same area: the bigger file');
  assert.deepEqual(files({message:{photo:[size('a',640,480,5000),size('b',640,480,5000)]}}),[['photo','b']],'a tie: the later size');
  assert.deepEqual(files({message:{photo:[size('a',640,480),size('b',undefined,undefined,99999)]}}),[['photo','a']],'a size without width or height counts as none');
  assert.deepEqual(files({message:{photo:[size('only',1,1)]}}),[['photo','only']]);
  assert.deepEqual(files({message:{new_chat_photo:[size('a',160,160),size('b',640,640)]}}),[['new_chat_photo','b']]);
  assert.deepEqual(files({message:{paid_media:{star_count:1,paid_media:[{type:'photo',photo:[size('a',90,90),size('b',800,800)]}]}}}),[['photo','b']]);
  assert.deepEqual(files({message:{video:{file_id:'clip',file_unique_id:'u-clip',width:640,height:360,duration:4,cover:[size('a',90,50),size('b',640,360)]}}}),
    [['video','clip'],['cover','b']],'a video and the largest size of its cover');
  // A list with anything but PhotoSize fields is not one picture: every file in it stays.
  assert.deepEqual(files({message:{video:{file_id:'clip',file_unique_id:'u-clip',width:640,height:360,
    qualities:[{file_id:'q1',file_unique_id:'u-q1',width:640,height:360,codec:'h264',file_size:1},{file_id:'q2',file_unique_id:'u-q2',width:1280,height:720,codec:'h264',file_size:2}]}}}),
    [['video','clip'],['qualities','q1'],['qualities','q2']]);
  assert.deepEqual(files({message:{photo:[size('a',90,90),{file_id:'b',width:800,height:800,thumbnail:size('t',1,1)}]}}),
    [['photo','a'],['photo','b'],['thumbnail','t']],'a mixed list keeps every file');
  assert.deepEqual(files({message:{message_id:3,reply_to_message:{message_id:1,photo:[size('quoted',800,800)]},photo:[size('own',800,600)]}}),[['photo','own']],
    'a quoted message\'s picture still belongs to that message');
});

test('immutable file storage detects collisions and preserves bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nocheh-files-'));
  try {
    const bytes=Buffer.from([0,255,42,10]);
    await immutableFile(root,'object',bytes); await immutableFile(root,'object',bytes);
    await assert.rejects(immutableFile(root,'object',Buffer.from('different')));
    assert.deepEqual(await readFile(join(root,'object')),bytes);
    assert.deepEqual(await readdir(root),['object']);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('real PostgreSQL: durable duplicate capture, revisions, outage recovery, attachment retries and original text', {skip:!process.env.PGHOST}, async()=>{
  const config=settings();
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection), namespace=`test_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`,max:3});
  const root=await mkdtemp(join(tmpdir(),'nocheh-archive-'));
  const value:Envelope={version:1,key:'telegram:fixture:update:100',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-20',
    source_id:'3',revision:'100',occurred_at:'1700000000',text:'Hey Sam 😃\r\nAws pass: 123456\0  ',
    payload:{update_id:100,message:{message_id:3,chat:{id:-20},text:'Hey Sam 😃\r\nAws pass: 123456\0  ',voice:{file_id:'voice1',file_unique_id:'unique1'}}}};
  try {
    await initialize(pool);
    const spool=join(root,'spool','pending'),name=`${digest(value.key)}.json`;
    await immutableFile(spool,name,Buffer.from(canonical(value)));
    // Simulated outage uses an actual stopped pool: the fsynced entry survives.
    const unavailable=new pg.Pool(connection); await unavailable.end();
    await drainSpool(unavailable,root);
    assert.equal((await readdir(spool)).length,1);
    await drainSpool(pool,root);
    assert.equal((await readdir(spool)).length,0);
    const results=await Promise.all([ingest(pool,value),ingest(pool,value)]);
    assert.ok(results.every(r=>r.duplicate));
    await assert.rejects(ingest(pool,{...value,text:'rewritten'}),{code:'source_identity_conflict'});
    await ingest(pool,{...value,key:'telegram:fixture:update:101',revision:'101',text:'edited',payload:{...value.payload,update_id:101}});
    const original=await pool.query('SELECT original_text,payload FROM events WHERE id=$1',[digest(value.key)]);
    assert.equal(original.rows[0].original_text.toString(),value.text);
    assert.deepEqual(JSON.parse(original.rows[0].payload.toString()),value.payload);
    assert.equal((await pool.query('SELECT count(*) FROM events')).rows[0].count,'2');
    assert.equal((await pool.query("SELECT count(*) FROM dispatches WHERE state='pending'")).rows[0].count,'2');
    await fetchAttachments(pool,root,async()=>{throw new Error('network failed');},undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM artifacts LIMIT 1')).rows[0].state,'failed');
    await pool.query('UPDATE artifacts SET next_attempt=now()');
    const audio=Buffer.from([79,103,103,83,0,1,255]);
    await fetchAttachments(pool,root,async()=>audio,undefined,{owner:'inngest',epoch:1});
    assert.deepEqual(await readFile(join(root,'files',digest(audio))),audio);
    assert.equal((await pool.query("SELECT count(*) FROM artifacts WHERE state='ready'")).rows[0].count,'2');
    await ingest(pool,{...value,key:'import:fixture:3',origin:'import'});
    assert.equal((await pool.query("SELECT state FROM dispatches WHERE event_id=$1",[digest('import:fixture:3')])).rows[0].state,'suppressed');
    for (let i=0;i<100;i++) await immutableFile(spool,`${'0'.repeat(60)}${i.toString(16).padStart(4,'0')}.json`,Buffer.from('{"version":9}'));
    await immutableFile(spool,name,Buffer.from(canonical(value)));
    await drainSpool(pool,root); await drainSpool(pool,root);
    assert.equal((await readdir(spool)).includes(name),false,'malformed entries cannot starve valid originals');
    assert.equal((await pool.query('SELECT count(*) FROM spool_failures')).rows[0].count,'100');
    for (const channel of ['browser','scheduler'] as const) {
      const input=runInput({channel,scope:'123',conversation:'fixture',id:'1',text:'exact\0\r\n 😃',payload:{file_id:'not-a-telegram-file'}});
      const captured=await ingest(pool,input);
      const exported=await readEvent(pool,{admin:true,scope:null},captured.id);
      assert.deepEqual(exported.event,input);
      assert.equal((await importRecord(pool,exported)).duplicate,true);
      assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[captured.id])).rows[0].state,'suppressed');
      assert.equal(exported.artifacts.length,0,'non-Telegram payloads cannot trigger Telegram downloads');
    }
    assert.equal((await ingest(pool,{...value,channel:'telegram'})).duplicate,true,'explicit default channel preserves legacy identity');
    await pool.query("UPDATE dispatches SET state='failed',error_code='model_unavailable',attempts=2 WHERE event_id=$1",[digest(value.key)]);
    await ingest(pool,{...value,key:'generated:outbound',origin:'generated',kind:'outbound_result',text:'operational marker',payload:{state:'delivered'}});
    const deliveredText='Hello from the assistant';
    const delivered={message_id:77,date:1700000001,chat:{id:-20,type:'group'},from:{id:999,is_bot:true},text:deliveredText};
    const receipt:Envelope={...value,key:'outbound:fixture:telegram:fixture:update:100:sendMessage:hash:result',origin:'generated',kind:'outbound_result',
      text:null,payload:{method:'sendMessage',state:'delivered',status:200,
        wire_base64:Buffer.from(canonical({ok:true,result:delivered})).toString('base64')}};
    // This receipt has already left the spool, as on installations running the
    // older legacy capture code. Reconciliation must expose its observed reply.
    await ingest(pool,receipt);
    await reconcileLegacyDeliveries(pool,root+'/historical-deliveries');
    const replyRows=await browseData(pool,{admin:true,scope:null},'',{kind:'assistant',scope:'-20',reply:''});
    assert.equal(replyRows.records.length,1);
    assert.equal(replyRows.records[0]?.text,deliveredText);
    await reconcileLegacyDeliveries(pool,root+'/historical-deliveries');
    assert.equal((await pool.query("SELECT count(*) FROM events WHERE kind='telegram_delivered_message'")).rows[0].count,'1');
    const freshReceipt={...receipt,key:'outbound:fixture:next:result',payload:{...receipt.payload,
      wire_base64:Buffer.from(canonical({ok:true,result:{...delivered,message_id:78,text:'Second reply'}})).toString('base64')}};
    await immutableFile(spool,digest(freshReceipt.key)+'.json',Buffer.from(canonical(freshReceipt)));
    await drainSpool(unavailable,root);
    assert.ok((await readdir(spool)).includes(digest(freshReceipt.key)+'.json'),'a database outage retains the reply receipt for replay');
    await drainSpool(pool,root);
    assert.equal((await browseData(pool,{admin:true,scope:null},'',{kind:'assistant',scope:'-20',reply:''})).records.length,2);
    await ingest(pool,{...value,key:'telegram:fixture:wire:1',origin:'live',kind:'telegram_wire',text:null,payload:{update_ids:[100]}});
    const browse=await browseData(pool,{admin:true,scope:null});
    assert.ok(browse.records.every(row=>row.kind!=='outbound_result'&&row.kind!=='telegram_wire'),'default archive browse contains source evidence only');
    const originalRow=browse.records.find(row=>row.id===digest(value.key));
    assert.equal(originalRow?.assistant_state,'failed');assert.equal(originalRow?.assistant_attempts,2);
    assert.deepEqual(originalRow?.reply_messages?.map((reply:{text:string|null})=>reply.text),[deliveredText],
      'the observed assistant message remains linked to its incoming source even when dispatch state later changes');
    const ownerHit=(await search(pool,{admin:true,scope:null},'Hey Sam')).find(row=>row.id===digest(value.key));
    assert.equal(ownerHit?.assistant_state,'failed','owner search retains the incoming reply status');
    assert.deepEqual(ownerHit?.reply_messages?.map((reply:{text:string|null})=>reply.text),[deliveredText]);
    assert.deepEqual(originalRow?.content_types,['voice'],'browse identifies the original attachment alongside message text');
    assert.equal((await search(pool,{admin:true,scope:null},'operational marker')).length,0,'owner archive search excludes operational records');
    const monitoring=await archiveStatus(pool);
    assert.equal(monitoring.workflows.length,2,'imports and browser/scheduler records are excluded from Telegram workflows');
    const failed=monitoring.workflows.find(row=>row.event_id===digest(value.key));
    assert.equal(failed.state,'failed');assert.equal(failed.attempts,2);assert.equal(failed.files,1);assert.equal(failed.files_waiting,0);
    assert.ok(!JSON.stringify(monitoring.workflows).includes('Hey Sam'),'workflow metadata does not copy message content');
    assert.equal(monitoring.telegram.reduce((count,row)=>count+row.count,0),2);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
    await rm(root,{recursive:true,force:true});
  }
});
