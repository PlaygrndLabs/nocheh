import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {prepareGuarded,editGuarded,exportGuarded,guardedValue,setGuardMode,guardState} from '../src/guarded.js';
import {exportPage,importRecord,readEvent,search} from '../src/retrieval.js';

test('portable guarded history requires explicit restore and preserves exact owner revisions',{skip:!process.env.PGHOST},async()=>{
 const admin=new pg.Pool(),prefix=`guard_restore_${Date.now()}`,pools:pg.Pool[]=[];
 try{
  for(const suffix of ['source','restore','untrusted']){await admin.query(`CREATE SCHEMA ${prefix}_${suffix}`);const pool=new pg.Pool({options:`-c search_path=${prefix}_${suffix}`});pools.push(pool);await initialize(pool);}
  const [source,target,untrusted]=pools as [pg.Pool,pg.Pool,pg.Pool];
  const original='Database password: mango123\r\n';const {id}=await ingest(source,{version:1,key:'portable-edit',origin:'import',bot_id:'fixture',scope:'42',source_id:'1',revision:'1',kind:'message',occurred_at:null,text:original,payload:{}},false);
  await prepareGuarded(source,async text=>text.includes('mango123')?['mango123']:[],undefined,undefined,undefined,{owner:'inngest',epoch:1});
  await editGuarded(source,{admin:true,scope:null},id,{source_id:'events:'+id,expected_revision:1,content:{text:'Database credentials are in my password manager.',payload:{}}});
  const record=(await exportPage(source,'')).records[0]!;
  await importRecord(untrusted,record);await assert.rejects(guardedValue(untrusted,'events:'+id),{code:'guard_preparation_pending'});
  await importRecord(target,record,true);await importRecord(target,record,true);
  assert.deepEqual(await exportGuarded(target,id),await exportGuarded(source,id));
  await prepareGuarded(target,async()=>{throw Error('restored content must not be detected again');},undefined,undefined,undefined,{owner:'inngest',epoch:1});
  const on=await setGuardMode(target,'on'),principal={admin:false,scope:null,guard_epoch:on.epoch};
  assert.equal((await readEvent(target,principal,id)).event.text,'Database credentials are in my password manager.');
  assert.equal((await readEvent(target,{admin:true,scope:null},id)).event.text,original);
  const off=await setGuardMode(target,'off');assert.equal((await readEvent(target,{...principal,guard_epoch:off.epoch},id)).event.text,original);
  const again=await setGuardMode(target,'on');assert.equal((await readEvent(target,{...principal,guard_epoch:again.epoch},id)).event.text,'Database credentials are in my password manager.');
  // Old generated summaries remain owner-visible evidence, not fresh agent context.
  await target.query("INSERT INTO derived_artifacts(id,event_id,kind,content,search_text,provenance) VALUES('old-summary',$1,'browser_result',$2,'outdated planted summary',$3)",[id,Buffer.from('outdated planted summary'),{guard_epoch:on.epoch}]);
  await prepareGuarded(target,async()=>[],undefined,undefined,undefined,{owner:'inngest',epoch:1});
  assert.equal((await search(target,{...principal,guard_epoch:again.epoch},'outdated')).length,0);
  assert.ok(!JSON.stringify(await readEvent(target,{...principal,guard_epoch:again.epoch},id)).includes('old-summary'));
  assert.ok(JSON.stringify(await readEvent(target,{admin:true,scope:null},id)).includes('old-summary'));
 }finally{for(const pool of pools)await pool.end();for(const suffix of ['source','restore','untrusted'])await admin.query(`DROP SCHEMA IF EXISTS ${prefix}_${suffix} CASCADE`);await admin.end();}
});
