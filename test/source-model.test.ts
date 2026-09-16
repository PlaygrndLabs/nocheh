import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,envelope,ingest,schema,type Envelope} from '../src/archive.js';
import {initialize} from '../src/database.js';
import {settings} from '../src/config.js';
import {sourceDescriptor,sourceObjectId,legacySource,type SourceIdentity} from '../src/source-model.js';
import {evidenceGraph} from '../src/graph.js';
import {exportPage,importRecord,readEvent,readArtifact,uploadArtifact,replay,search} from '../src/retrieval.js';
import {prepareGuarded,guardedSchema} from '../src/guarded.js';
import {learningSchema} from '../src/learning.js';
import {spacePolicy} from '../src/spaces.js';
import {fetchAttachments} from '../src/storage.js';

const owner={scope:null,admin:true};
const object=(platform='slack',namespace='workspace:one/channel:general',id='1700000000.000001',kind='message'):SourceIdentity=>({platform,namespace,kind,external_id:id});
function event(key:string,source=object(),scope='source:public',overrides:Partial<Envelope>={}):Envelope {
  return {version:1,key,channel:source.platform,bot_id:'',origin:'import',scope,source_id:source.external_id,revision:'r1',kind:'source_observation',
    occurred_at:'2026-09-16T00:00:00Z',text:'exact source\r\n\0 متن',payload:{external_id:source.external_id,unrecognized:{nested:['preserved',null]}},
    source:{version:1,adapter:source.platform+'.fixture',adapter_version:'1.0',object:source,operation:'snapshot',completeness:'full',relations:[],
      metadata:{format_version:1,custom:{unknown:'retained'}},provenance:{import_job_id:'fixture-import'}},...overrides};
}
async function fixture(run:(pool:pg.Pool,other:pg.Pool)=>Promise<void>,migrate=true) {
  const config=settings(),connection={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),prefix='sources_'+randomUUID().replaceAll('-',''),pools:pg.Pool[]=[];
  try {
    for(const suffix of ['a','b']) {
      await admin.query(`CREATE SCHEMA ${prefix}_${suffix}`);
      const pool=new pg.Pool({...connection,options:`-c search_path=${prefix}_${suffix}`,max:4});pools.push(pool);
      if(migrate)await initialize(pool);
    }
    await run(pools[0]!,pools[1]!);
  }finally {
    await Promise.all(pools.map(p=>p.end()));
    for(const suffix of ['a','b'])await admin.query(`DROP SCHEMA IF EXISTS ${prefix}_${suffix} CASCADE`);
    await admin.end();
  }
}

test('source contract keeps opaque identities and rejects ambiguous or unsupported descriptors',()=>{
  const value=event('contract',object('future-platform','tenant','900719925474099312345'));
  assert.deepEqual(envelope(value),value);
  assert.equal(sourceDescriptor(value.source).object.external_id,'900719925474099312345');
  assert.throws(()=>envelope({...value,source:undefined}),{code:'source_descriptor_required'});
  assert.throws(()=>envelope({...value,source:{...value.source,version:2}}),{code:'unsupported_source_version'});
  assert.throws(()=>envelope({...value,channel:'other-platform'}),{code:'source_identity_mismatch'});
  assert.throws(()=>envelope({...value,source_id:'different'}),{code:'source_identity_mismatch'});
  assert.throws(()=>sourceDescriptor({...value.source,object:{...value.source!.object,external_id:9007199254740992}}));
  assert.throws(()=>sourceDescriptor({...value.source,object:{...value.source!.object,namespace:'private\0public'}}));
  assert.throws(()=>sourceDescriptor({...value.source,metadata:{text:'nul\0'}}),{code:'invalid_source_metadata'});
  assert.equal(sourceDescriptor({...value.source,metadata:{text:'literal \\u0000'}}).metadata!.text,'literal \\u0000');
  assert.throws(()=>sourceDescriptor({...value.source,metadata:{text:'\ud800'}}),{code:'invalid_source_metadata'});
  const relation={kind:'reply_to',target:object()};
  assert.throws(()=>sourceDescriptor({...value.source,relations:[relation,relation]}),{code:'duplicate_source_relation'});
  assert.throws(()=>sourceDescriptor({...value.source,relations:Array(101).fill(relation)}),{code:'invalid_source_relations'});
  assert.notEqual(sourceObjectId(object('slack','a:b','c')),sourceObjectId(object('slack','a','b:c')));
  const legacy=event('legacy',object('telegram'),'-20',{kind:'telegram_update',bot_id:'fixture',payload:{message:{chat:{id:-20},from:{id:42},sender_chat:{id:-30}}}});
  const author=legacySource(legacy).relations.find(r=>r.kind==='authored_by')!.target;
  assert.equal(author.external_id,'42');assert.equal(author.kind,'actor','identity kind follows the selected source field');
});

test('real PostgreSQL: additive migration preserves legacy originals, receipts and stable event hashes',{skip:!process.env.PGHOST},async()=>{
  await fixture(async pool=>{
    await pool.query(schema);
    const value:Envelope={version:1,key:'legacy-update',bot_id:'old-bot',origin:'import',kind:'telegram_update',scope:'-20',source_id:'3',revision:'界'.repeat(1024),occurred_at:'1700000000',
      text:'unchanged\0\r\nمتن',payload:{message:{message_id:3,chat:{id:-20},from:{id:42},reply_to_message:{message_id:1}}}};
    const id=digest(value.key),hash=digest(canonical({...value,wire_base64:undefined}));
    await pool.query(`INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,occurred_at,payload,payload_hash,original_text,search_text,wire)
      VALUES($1,$2,'telegram',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'unchanged',$13)`,
      [id,value.key,value.bot_id,value.scope,value.source_id,value.revision,value.origin,value.kind,value.occurred_at,Buffer.from(canonical(value.payload)),hash,Buffer.from(value.text!),Buffer.from([0,255,1])]);
    await pool.query("INSERT INTO dispatches(event_id,state,attempts,error_code) VALUES($1,'suppressed',3,'retained')",[id]);
    await pool.query("INSERT INTO artifacts(id,event_id,kind,source_ref,state,error_code) VALUES('old-file',$1,'file','desktop:missing','failed','import_file_missing')",[id]);
    await pool.query("INSERT INTO derived_artifacts(id,event_id,kind,content,provenance) VALUES('old-derived',$1,'transcript',$2,$3)",[id,Buffer.from('separate\0 transcript'),{model:'fixture'}]);
    await pool.query(guardedSchema);await pool.query(learningSchema);
    await pool.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version)
      VALUES('owner-edit',$1,1,$2,'owner-authored safe copy','old-input','owner','old-detector')`,['events:'+id,Buffer.from(canonical({text:'owner-authored safe copy',payload:{}}))]);
    await pool.query("UPDATE guard_sources SET active_revision=1,state='ready' WHERE id=$1",['events:'+id]);
    await pool.query("INSERT INTO memory_learning_sources(event_id,reason,batch) VALUES($1,'owner_approved','old-import')",[id]);
    const before=await pool.query('SELECT * FROM events');
    const receipts=await pool.query('SELECT * FROM dispatches');
    const guarded=await pool.query('SELECT * FROM guard_revisions');
    const consent=await pool.query('SELECT * FROM memory_learning_sources');
    await initialize(pool);await Promise.all([initialize(pool),initialize(pool)]);
    const after=await pool.query('SELECT * FROM events');
    const {source_descriptor,...unchanged}=after.rows[0];
    assert.equal(source_descriptor,null);assert.deepEqual(unchanged,before.rows[0]);
    assert.deepEqual((await pool.query('SELECT * FROM dispatches')).rows,receipts.rows);
    assert.deepEqual((await pool.query('SELECT * FROM guard_revisions')).rows,guarded.rows);
    assert.deepEqual((await pool.query('SELECT * FROM memory_learning_sources')).rows,consent.rows);
    assert.equal((await pool.query('SELECT count(*) FROM source_model_migrations')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM source_observations')).rows[0].count,'1');
    assert.equal((await ingest(pool,value,false)).duplicate,true);
    const original=await readEvent(pool,owner,id);assert.ok('source_model' in original);
    assert.equal(original.source_model!.descriptor.adapter,'telegram.bot-api');
    assert.equal((await pool.query('SELECT content FROM derived_artifacts')).rows[0].content.toString(),'separate\0 transcript');
    assert.equal((await pool.query('SELECT state FROM artifacts')).rows[0].state,'failed');
    const batch=Array.from({length:201},(_,i)=>{
      const item:Envelope={...value,key:'migration-batch:'+i,source_id:String(i),payload:{},text:null};
      return {id:digest(item.key),source_key:item.key,source_id:item.source_id,
        payload_hash:digest(canonical({...item,wire_base64:undefined}))};
    });
    await pool.query(`INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,occurred_at,payload,payload_hash)
      SELECT id,source_key,'telegram',$2,$3,source_id,$4,$5,$6,$7,$8,payload_hash FROM jsonb_to_recordset($1::jsonb)
      AS x(id text,source_key text,source_id text,payload_hash text)`,
      [JSON.stringify(batch),value.bot_id,value.scope,value.revision,value.origin,value.kind,value.occurred_at,Buffer.from('{}')]);
    await initialize(pool);
    assert.equal((await pool.query('SELECT count(*) FROM source_observations')).rows[0].count,'202','backfill crosses a batch boundary and skips existing observations');
  },false);
});

test('real PostgreSQL: concurrent observations deduplicate without merging platforms, tenants or object kinds',{skip:!process.env.PGHOST},async()=>{
  await fixture(async pool=>{
    const first=event('same-import');
    const {source:_source,...withoutSource}=first;
    await assert.rejects(ingest(pool,withoutSource),{code:'source_descriptor_required'});
    await assert.rejects(ingest(pool,{...first,channel:'discord'}),{code:'source_identity_mismatch'});
    const captured=await Promise.all(Array.from({length:5},()=>ingest(pool,first,false)));
    assert.equal(captured.filter(r=>!r.duplicate).length,1);
    const live=event('live-observation',first.source!.object,first.scope,{origin:'live',payload:{text:'a partial API observation',file_id:'not-telegram'},
      source:{...first.source!,adapter:'slack.events',completeness:'partial',provenance:{connector_id:'second-connector'}}});
    await ingest(pool,live);
    assert.equal((await pool.query('SELECT count(*) FROM source_objects')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM source_revisions')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM source_observations')).rows[0].count,'2');
    for(const identity of [object('discord'),object('slack','workspace:two/channel:general'),object('slack',first.source!.object.namespace,first.source_id,'document')])
      await ingest(pool,event(canonical(identity),identity));
    assert.equal((await pool.query('SELECT count(*) FROM source_objects')).rows[0].count,'4');
    assert.equal((await pool.query("SELECT count(*) FROM dispatches WHERE state<>'suppressed'")).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM artifacts')).rows[0].count,'0');
    await assert.rejects(ingest(pool,{...first,source:{...first.source!,metadata:{changed:true}}}),{code:'source_identity_conflict'});
    await assert.rejects(pool.query("INSERT INTO source_objects SELECT repeat('f',64),platform,namespace,kind,external_id FROM source_objects LIMIT 1"),{code:'23505'});
    await assert.rejects(pool.query("INSERT INTO source_relations VALUES($1,'reply_to','missing','{}')",[digest(first.key)]),{code:'23503'});
  });
});

test('real PostgreSQL: generic relationships resolve out of order without widening audience access',{skip:!process.env.PGHOST},async()=>{
  await fixture(async pool=>{
    const parent=object('discord','guild:g/channel:c','9007199254740993123'),actor=object('discord','users','9007199254740993555','actor');
    const child=event('reply',object('discord',parent.namespace,'9007199254740993999'));
    child.source!.relations.push({kind:'reply_to',target:parent},{kind:'authored_by',target:actor},{kind:'contained_in',target:object('discord','guild:g','c','channel')});
    await ingest(pool,child);
    assert.equal((await evidenceGraph(pool,owner,'source:public')).unresolved_replies,1);
    const parentEvent=event('private-parent',parent,'source:private');await ingest(pool,parentEvent);
    const publicReader={scope:'source:public',admin:false};
    const graph=await evidenceGraph(pool,publicReader,'source:public');
    assert.equal(graph.unresolved_replies,1);
    assert.ok(!JSON.stringify(graph).includes(digest(parentEvent.key)));
    await assert.rejects(readEvent(pool,publicReader,digest(parentEvent.key)),{code:'source_not_found'});
    assert.equal((await search(pool,publicReader,'source')).length,1);
    assert.equal((await pool.query('SELECT space_id FROM event_spaces WHERE event_id=$1',[digest(child.key)])).rows[0].space_id,child.scope);
    assert.equal((await spacePolicy(pool,child.scope)).parent,null);
    assert.equal((await evidenceGraph(pool,owner,'*')).edges.filter(r=>r.kind==='reply_to_source').length,1);
    await ingest(pool,event('public-parent-observation',parent));
    assert.equal((await evidenceGraph(pool,publicReader,'source:public')).unresolved_replies,0);
    const edit=event('edit',parent,'source:public',{revision:'r2',text:'edited',source:{...parentEvent.source!,operation:'update'}});
    const deletion=event('delete',parent,'source:public',{revision:'r3',text:null,payload:{deleted:true},source:{...parentEvent.source!,operation:'delete',completeness:'partial'}});
    await ingest(pool,deletion);await ingest(pool,edit);
    assert.equal((await pool.query('SELECT count(*) FROM source_revisions WHERE object_id=$1',[sourceObjectId(parent)])).rows[0].count,'3');
    assert.equal((await readEvent(pool,owner,digest(parentEvent.key))).event.text,parentEvent.text);
    assert.equal((await readEvent(pool,owner,digest(deletion.key))).event.text,null);
  });
});

test('real PostgreSQL: portable sources retain adapter versions, unknown fields, files and raw bytes across replay',{skip:!process.env.PGHOST},async()=>{
  await fixture(async(source,target)=>{
    const root=await mkdtemp(join(tmpdir(),'nocheh-source-roundtrip-'));
    try {
      const value=event('future-document',object('future-platform','workspace:w','doc:1','document'), 'source:private',
        {wire_base64:Buffer.from('{ "duplicate": 1, "duplicate": 2, "raw": "bytes" }').toString('base64')});
      value.source!.relations.push({kind:'derived_from',target:object('future-platform','workspace:w','unavailable','document'),metadata:{reason:'observed'}});
      const id=digest(value.key),bytes=Buffer.from([0,255,17,88]),artifact=digest(id+':upload'),missing=digest(id+':missing');
      await importRecord(source,{event:value,artifacts:[{id:artifact,kind:'file',source_ref:'upload',metadata:{filename:'original.bin'}},{id:missing,kind:'file',source_ref:'missing',state:'failed'}]});
      await uploadArtifact(source,root,artifact,{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});
      const page=await exportPage(source,'');
      for(const record of page.records) {
        await importRecord(target,record);await uploadArtifact(target,root,artifact,{bytes_base64:bytes.toString('base64'),sha256:digest(bytes)});
        assert.equal((await importRecord(target,record)).duplicate,true);
        const copy=await readEvent(target,owner,record.id);
        assert.deepEqual(copy.event,record.event);assert.ok('source_model' in copy&&'source_model' in record);
        assert.deepEqual(copy.source_model,record.source_model);
      }
      assert.deepEqual(await readArtifact(target,owner,root,artifact),bytes);
      await replay(target,[id]);await initialize(target);
      assert.equal((await poolCount(target,'source_observations')),1);
      assert.equal((await target.query('SELECT state FROM artifacts WHERE id=$1',[missing])).rows[0].state,'failed');
      let downloads=0;
      await fetchAttachments(target,root,async()=>{downloads++;return bytes;},undefined,{owner:'inngest',epoch:1});
      assert.equal(downloads,0,'a missing external attachment cannot be sent to the Telegram downloader');
      const reader={scope:'source:private',admin:false};
      assert.equal('source_model' in await readEvent(target,reader,id),false,'internal projection metadata is owner-only');
      await prepareGuarded(target,async()=>[],undefined,100,undefined,{owner:'inngest',epoch:1});
      await target.query("UPDATE guard_state SET mode='on'");
      const guarded=await readEvent(target,{...reader,guard_epoch:1},id);
      assert.equal('source' in guarded.event,false,'unguarded adapter metadata is not exposed through guarded reads');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
async function poolCount(pool:pg.Pool,table:'source_observations'):Promise<number> {return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);}
