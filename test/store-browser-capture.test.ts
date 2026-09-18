import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {drainSourceSpool} from '../src/stores/capture.js';
import {browserManifests} from '../src/stores/browser-capture.js';

test('browser originals and file manifests survive database outages and replay without starting managed execution',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const connected=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-browser-capture-'));let controlDown=true,archiveDown=true;
  const outage=(pool:pg.Pool,down:()=>boolean)=>new Proxy(pool,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{
    if(down()&&['query','connect'].includes(String(key)))return Promise.reject(Error('synthetic database outage'));return value.apply(target,args);
  }:value;}});
  const stores:StorePools={...connected,archive:outage(connected.archive,()=>archiveDown),control:outage(connected.control,()=>controlDown)};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async()=>{throw Error('capture cannot invoke runtime');},honcho:async()=>{throw Error('capture cannot invoke memory');}}),owner={admin:true,scope:null};
  const original=Buffer.from([0,1,2,255,13,10]),text='Original text  \r\n😃',body={scope:'123',profile:'research',conversation:'fixture-'+Date.now(),id:'submission',text,
    files:[{name:'exact.bin',kind:'file',bytes_base64:original.toString('base64')},{name:'empty.txt',kind:'file',bytes_base64:''}]};
  try {
    const first=await s.browserCapture.capture(owner,body);assert.equal(first.state,'spooled');
    assert.deepEqual(await s.browserCapture.capture(owner,body),first);
    const path=join(root,'spool/pending',first.event_id+'.json'),spooled=JSON.parse(await readFile(path,'utf8'));
    assert.equal(spooled.text,text);assert.deepEqual(await readFile(join(root,'files',digest(original))),original);
    assert.deepEqual(await readFile(join(root,'files',digest(''))),Buffer.alloc(0));
    assert.equal((await connected.archive.query('SELECT 1 FROM events WHERE id=$1',[first.event_id])).rowCount,0);
    await drainSourceSpool(s.capture,root);assert.ok((await readdir(join(root,'spool/pending'))).includes(first.event_id+'.json'));
    await assert.rejects(s.browserCapture.capture(owner,{...body,text:'Changed same submission'}),{code:'immutable_file_conflict'});
    await assert.rejects(s.browserCapture.capture({admin:false,scope:'123'},body),{status:403});
    await assert.rejects(s.browserCapture.capture(owner,{...body,scope:'-99'}),{code:'run_scope_denied'});
    await assert.rejects(s.browserCapture.capture(owner,{...body,files:[{name:'../secret',kind:'file',bytes_base64:''}]}),{code:'invalid_attachment'});
    const second=await s.browserCapture.capture(owner,{...body,profile:'planning'});assert.notEqual(first.event_id,second.event_id);
    archiveDown=false;await drainSourceSpool(s.capture,root);
    for(const item of [first,second]) {
      assert.ok((await readdir(join(root,'spool/pending'))).includes(item.event_id+'.json'));
      assert.equal((await connected.archive.query('SELECT original_text FROM events WHERE id=$1',[item.event_id])).rows[0].original_text.toString(),text);
      assert.equal((await connected.archive.query('SELECT count(*)::int AS n FROM artifacts WHERE event_id=$1',[item.event_id])).rows[0].n,2);
    }
    const identities=(await connected.archive.query('SELECT revision_id FROM source_observations WHERE event_id=ANY($1)',[[first.event_id,second.event_id]])).rows;
    assert.notEqual(identities[0].revision_id,identities[1].revision_id,'matching session/input IDs in named profiles are different originals');
    controlDown=false;await drainSourceSpool(s.capture,root);assert.deepEqual(await readdir(join(root,'spool/pending')),[]);
    await s.browserCapture.capture(owner,body);await drainSourceSpool(s.capture,root);
    assert.equal((await connected.archive.query('SELECT count(*)::int AS n FROM events WHERE id=$1',[first.event_id])).rows[0].n,1);
    const jobs=(await connected.control.query('SELECT family FROM workflow_registry WHERE job_id=$1',[first.event_id])).rows.map(r=>r.family);
    assert.deepEqual(jobs,['preparation']);
    assert.equal((await connected.control.query("SELECT 1 FROM workflow_registry WHERE family='browser' AND job_id=$1",[first.event_id])).rowCount,0,'capture alone cannot admit execution');
    const epoch=(await connected.control.query("SELECT epoch FROM workflow_owners WHERE family='preparation'")).rows[0].epoch;
    await s.attachments.fetch(first.event_id,async()=>{throw Error('owned browser bytes cannot download again');},{owner:'inngest',epoch});
    const manifests=browserManifests(first.event_id,spooled);
    for(const manifest of manifests)assert.equal((await s.attachments.bytes(await s.attachments.file(manifest.id))).length,manifest.byte_size);
    await assert.rejects(s.archive.capture(spooled,{manifests:manifests.map((m,i)=>i?m:{...m,file_hash:digest('changed')})}),{code:'artifact_metadata_conflict'});
    const exported=await s.sourcePortability.record(owner,first.event_id);
    assert.equal(exported.event.text,text);assert.equal(exported.artifacts.length,2);assert.deepEqual(exported.event.source,spooled.source);
    for(const kind of ['browser_result','scheduled_result','scheduled_prompt','scheduled_trigger'])await assert.rejects(s.archive.capture({...spooled,key:spooled.key+kind,kind}),{code:'original_source_required'});
    assert.equal((await connected.control.query("SELECT count(*)::int AS n FROM attachment_retrievals WHERE event_id=$1 AND state='done'",[first.event_id])).rows[0].n,2);
  }finally{await connected.close();await rm(root,{recursive:true,force:true});}
});
