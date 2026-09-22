import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import pg from 'pg';
import { reader, scopeToken, admin } from '../src/access.js';
import { digest, ingest, type Envelope } from '../src/archive.js';
import { initialize } from '../src/database.js';
import { settings } from '../src/config.js';
import { exportPage, importRecord, readArtifact, readEvent, replay, search, uploadArtifact } from '../src/retrieval.js';

test('scope capabilities are signed, expiring and cannot grant administrative writes',()=>{
  const secret='test-only-service-secret-long-enough',now=Date.now();
  const request=(token:string)=>({headers:{authorization:`Bearer ${token}`}} as IncomingMessage);
  const token=scopeToken(secret,'-100',now+60000);
  assert.deepEqual(reader(request(token),secret,now),{scope:'-100',admin:false});
  assert.throws(()=>admin(reader(request(token),secret,now)),{code:'owner_required'});
  assert.throws(()=>reader(request(token.slice(0,-4)+'fake'),secret,now),{code:'invalid_scope_token'});
  assert.throws(()=>reader({headers:{authorization:secret}} as IncomingMessage,secret,now),{code:'unauthorized'});
  assert.throws(()=>reader(request(token),secret,now+60001),{code:'invalid_scope_token'});
  assert.throws(()=>admin(reader(request(scopeToken(secret,null,now+60000)),secret,now)),{code:'owner_required'});
});

test('real PostgreSQL: scoped reads and export/reimport preserve originals, files and provenance without replay replies',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const adminPool=new pg.Pool(connection),prefix=`roundtrip_${Date.now()}`;
  const pools:pg.Pool[]=[],roots:string[]=[];
  try {
    for (const suffix of ['source','target']) {
      await adminPool.query(`CREATE SCHEMA ${prefix}_${suffix}`);
      const pool=new pg.Pool({...connection,options:`-c search_path=${prefix}_${suffix}`});pools.push(pool);await initialize(pool);
      roots.push(await mkdtemp(join(tmpdir(),'nocheh-roundtrip-')));
    }
    const source=pools[0]!,target=pools[1]!,root=roots[0]!,copyRoot=roots[1]!;
    const owner={scope:null,admin:true},group={scope:'-100',admin:false};
    const base:Envelope={version:1,key:'telegram:fixture:update:21',bot_id:'fixture',scope:'-100',source_id:'9',revision:'21',origin:'live',kind:'telegram_update',occurred_at:'1700000000',
      text:'Friday 😃\r\nAws pass: 123456  ',payload:{update_id:21,message:{text:'Friday 😃\r\nAws pass: 123456  ',voice:{file_id:'f1',file_unique_id:'u1'}}},wire_base64:Buffer.from('{ "untouched": true }').toString('base64')};
    const {id}=await ingest(source,base); const artifact=digest(`${id}:f1`);
    const bytes=Buffer.from([0,255,83,10,42]);
    await uploadArtifact(source,root,artifact,{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});
    await source.query('INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,provenance) VALUES($1,$2,$3,$4,$5,$6)',
      ['transcript-fixture',id,artifact,'transcript',Buffer.from('  Friday\r\nمتن اصلی  '),JSON.stringify({provider:'synthetic',version:'1',source_artifact:artifact})]);
    await source.query("UPDATE derived_artifacts SET search_text='Friday متن اصلی'");
    const privateId=(await ingest(source,{...base,key:'private:1',scope:'100'})).id;
    await ingest(source,{...base,key:'group:2',scope:'-200'});
    assert.equal((await search(source,group,'Friday')).length,2);
    const ownerResults=await search(source,owner,'Friday');
    assert.equal(ownerResults.length,3);
    assert.ok(ownerResults.every(result=>result.origin!=='derived'),'owner archive search returns source records only');
    assert.equal((await search(source,group,'متن'))[0]?.origin,'derived');
    await assert.rejects(readEvent(source,group,privateId),{code:'source_not_found'});
    await assert.rejects(readArtifact(source,group,root,digest(`${privateId}:f1`)),{code:'source_not_found'});
    const page=await exportPage(source,'');
    for (const record of page.records) {
      await importRecord(target,record);
      assert.equal((await importRecord(target,record)).duplicate,true);
      for (const a of record.artifacts) if (a.state==='ready') await uploadArtifact(target,copyRoot,a.id,
        {bytes_base64:(await readArtifact(source,owner,root,a.id)).toString('base64'),sha256:a.file_hash});
      const copy=await readEvent(target,owner,record.id);
      assert.deepEqual(copy.event,record.event);assert.equal(copy.received_at,record.received_at);
      assert.deepEqual(copy.derived,record.derived);
    }
    assert.deepEqual(await readArtifact(target,group,copyRoot,artifact),bytes);
    assert.equal((await target.query("SELECT count(*) FROM dispatches WHERE state<>'suppressed'")).rows[0].count,'0');
    assert.deepEqual(await replay(target,[id]),{replayed:1,telegram_replies:0,mode:'archive_only'});
    assert.equal((await target.query("SELECT state FROM dispatches WHERE event_id=$1",[id])).rows[0].state,'suppressed');
    await assert.rejects(uploadArtifact(target,copyRoot,artifact,{bytes_base64:Buffer.from('altered').toString('base64'),sha256:digest('altered')}),{code:'immutable_file_conflict'});
  } finally {
    for (const pool of pools) await pool.end();
    for (const suffix of ['source','target']) await adminPool.query(`DROP SCHEMA IF EXISTS ${prefix}_${suffix} CASCADE`);
    await adminPool.end();for (const root of roots) await rm(root,{recursive:true,force:true});
  }
});
