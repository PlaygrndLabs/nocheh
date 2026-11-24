import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {MemoryProvenanceRepository} from '../src/stores/memory-provenance.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {Reader} from '../src/access.js';
import {readSet,readSetIds,readSetParam,readSetSql} from '../src/spaces.js';
import {memoryWallName} from '../src/stores/memory-walls.js';
import {NativeMemoryRepository} from '../src/stores/native-memory.js';
import {installChatsForTest} from '../src/chats.js';
import {GP1,GP1_TOPIC,GP2,GP4,GP_GROUP_IDS,NG1,NG1_TOPIC,OWNER,P1,fixtureChats,groupsPolicy,legacyChats} from './fixture-groups.js';

test('Honcho ancestry maps only verified ingestion receipts and current authorized workspaces to original evidence',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const key='provenance:'+Date.now(),workspace=digest(key),conclusion='c'.repeat(21),message='m'.repeat(21),receipt=digest(key+':receipt');
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-42',source_id:'1',revision:'1',occurred_at:null,text:'Synthetic evidence',payload:{}};
  let mutate=false,calls=0,cited:unknown=true;
  const call=async(path:string,body:any)=>{
    calls++;assert.equal(path,'/v3/workspaces/'+workspace+'/nocheh/provenance');assert.deepEqual(body,{conclusion_ids:[conclusion]});
    if(mutate)await stores.control.query('UPDATE guard_state SET epoch=epoch+1');
    return {roots:[conclusion],nodes:[{id:conclusion,parents:[],deleted:false,exact_citations:cited}],messages:[{message_id:message,receipt_id:receipt},{message_id:'x'.repeat(21),receipt_id:digest('unknown')}],limitations:[],exact_citations:true};
  };
  const provenance=new MemoryProvenanceRepository(stores,archive,guards,honchoEngine(call));
  try {
    const source=(await archive.capture(event)).source.reference,related=(await archive.capture({...event,key:key+':related',source_id:'2'})).source.reference,binding=await guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    await stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,content_hash,state,remote_id)
      VALUES($1,$2,$3,$4,$5,$6,'done',$7)`,[receipt,workspace,JSON.stringify(source),'events:'+source.id,digest(key+':prepared'),digest('fixture'),message]);
    await stores.control.query('UPDATE memory_ingestion_receipts SET source_references=$2 WHERE id=$1',[receipt,JSON.stringify([source,related])]);
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],binding),{code:'memory_context_retired'});
    assert.equal(calls,0,'detached memory does not invoke native readers');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true');
    const result=await provenance.read(workspace,'owner',[conclusion],binding);
    assert.deepEqual(result.evidence,[source,related]);assert.equal(result.exact_citations,true,'a conclusion that cites its messages is an exact citation');
    assert.deepEqual(result.conclusions,[{id:conclusion,parents:[],deleted:false,exact_citations:true}]);
    assert.ok(result.limitations.includes('ingestion_reference_unavailable'));assert.ok(!result.limitations.includes('ancestry_is_not_an_exact_citation'));
    cited=false;
    const batch=await provenance.read(workspace,'owner',[conclusion],binding);
    assert.equal(batch.exact_citations,false,'a derivation batch is never an exact citation, whatever Honcho reports for the chain');
    assert.ok(batch.limitations.includes('ancestry_is_not_an_exact_citation'));
    cited=undefined;
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],binding),{code:'invalid_honcho_provenance'});
    cited=true;
    const group=await provenance.read(workspace,'-42',[conclusion],binding);
    assert.deepEqual(group.evidence,[],'another audience cannot trace owner-private receipts');assert.ok(group.limitations.includes('ingestion_reference_unavailable'));
    mutate=true;
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],binding),{code:'guard_context_changed'});
    mutate=false;
    assert.deepEqual((await provenance.read(workspace,'owner',[conclusion],await guards.state())).evidence,[source,related],'a guard epoch never retires the workspace');
    await stores.control.query("UPDATE memory_generations SET state='retired' WHERE id=$1",[workspace]);
    await assert.rejects(provenance.read(workspace,'owner',[conclusion],await guards.state()),{code:'memory_context_retired'});
  } finally {
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false');
    await stores.close();
  }
});

test('a private answer searches Honcho only through the sessions and receipts of the groups frozen in its record',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const key='answer-memory:'+Date.now(),workspace=digest(key);
  const provenance=new MemoryProvenanceRepository(stores,archive,guards,honchoEngine(async()=>{throw Error('unused');}));
  // One conversation session per place with a completed write: the asking group, its topic, another group of the project and
  // its topic, a group in no project, the owner (audience 'owner'), the owner's chat named as itself and an import.
  const places=[GP1,GP1_TOPIC,GP2,GP2+'/topic/9',GP4,GP4+'/topic/9','owner',OWNER,OWNER+'/topic/5','desktop:private_supergroup:1234567890',NG1,NG1_TOPIC];
  // Both fixture families, plus the topics of GP1, GP2 and GP4 above as the seeder makes their rows (ADR-0252).
  const policy=groupsPolicy(),base=fixtureChats(),known=new Set(base.chats.map(chat=>chat.id));
  const extra=legacyChats([GP2+'/topic/9',GP4+'/topic/9',GP2+'/topic/11',GP1+'/topic/12',OWNER+'/topic/5'],{served:GP_GROUP_IDS});
  const restore=installChatsForTest({...base,chats:[...base.chats,...extra.chats.filter(chat=>!known.has(chat.id))],ids:[...base.ids,...extra.ids.filter(row=>!known.has(row.chat_id))]});
  const session=(place:string)=>digest(key+':session:'+place),receipt=(place:string,n=0)=>digest(key+':receipt:'+place+':'+n);
  const remote=(place:string,n=0)=>digest(place+':'+n).slice(0,21),source=(place:string)=>({store:'archive',kind:'event',id:digest(key+':event:'+place),revision:'1',input_hash:digest(place)});
  const write=(place:string,n:number,state:string,retired=false)=>stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,
    content_hash,state,remote_id,session_id,audience,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [receipt(place,n),workspace,JSON.stringify(source(place)),'events:'+source(place).id,digest(key+':prepared:'+place+':'+n),digest('fixture'),state,remote(place,n),
      session(place),place,retired?new Date():null]);
  try {
    const binding=await guards.state();
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    for(const place of places) {
      await stores.control.query(`INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,'conversation',$4)`,[workspace,digest(key+':key:'+place),place,session(place)]);
      await write(place,0,'done');
    }
    // A session whose only write is pending or retired was not learned, and is not searched.
    const pending=GP2+'/topic/11',retired=GP1+'/topic/12';
    for(const [place,state,gone] of [[pending,'pending',false],[retired,'done',true]] as const) {
      await stores.control.query(`INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,'conversation',$4)`,[workspace,digest(key+':key:'+place),place,session(place)]);
      await write(place,0,state,gone);
    }

    const frozen=readSet({home:GP1,whole:[GP1,GP2],project:P1}),readable=[GP1,GP1_TOPIC,GP2,GP2+'/topic/9'];
    assert.deepEqual((await provenance.readSetSessions(workspace,frozen)).sort(),readable.map(session).sort(),
      'the sessions of every group of the set and of their topics: never GP4, the owner, a private chat or an import');
    assert.deepEqual(await provenance.readSetSessions(workspace,readSet({home:GP1_TOPIC,exact:[GP1_TOPIC]})),[session(GP1_TOPIC)],
      'an exact topic reads only itself');
    assert.deepEqual(await provenance.readSetSessions(workspace,frozen,2),(await provenance.readSetSessions(workspace,frozen)).slice(0,2));
    // A read set made by hand, with private chats, imports and patterns in it, still reads only its groups.
    for(const forged of [['owner'],[OWNER],[OWNER+'/*'],['owner/*'],[OWNER+'/topic/5'],['desktop:private_supergroup:1234567890'],['*'],[]])
      assert.deepEqual(await provenance.readSetSessions(workspace,{home:OWNER,exact:forged,whole:forged,project:null}),[],'no set opens a private chat or an import: '+JSON.stringify(forged));
    assert.deepEqual(await provenance.readSetSessions(workspace,{home:OWNER,exact:[OWNER,'owner',GP4],whole:[OWNER],project:null}),[session(GP4)],
      'a group in a set made by hand with private chats reads only the group');
    // The SQL itself reads only what readSetParam marked: a list of ids bound by hand, the owner's chat or a group, reads
    // no session at all (ADR-0242).
    const bound=async(param:string[])=>(await stores.control.query(`SELECT s.session_id FROM memory_sessions s WHERE s.workspace=$1 AND ${readSetSql('s.audience',2)}`,
      [workspace,param])).rows.map(row=>String(row.session_id));
    assert.deepEqual(await bound([OWNER,'owner',GP1,GP4]),[],'a list by hand reads nothing');
    assert.deepEqual(await bound(readSetParam(readSet({home:GP4,exact:[GP4]}))),[session(GP4)]);
    assert.deepEqual((await provenance.readSetSessions(workspace,readSet({home:NG1_TOPIC,whole:[NG1]}))).sort(),[NG1,NG1_TOPIC].map(session).sort(),
      'a digest group reads its topic rows');

    // The search itself: Honcho is asked through the memory wall of those sessions (ADR-0286), and a hit counts only with a
    // done, current receipt of the set.
    const asked:any[]=[],walled:any[]=[];
    const hits=[...places,pending,retired].map(place=>({id:remote(place),metadata:{nocheh_receipt:receipt(place)}}));
    const contexts={access:{stores,policy:()=>policy,recall:()=>null,reads:(principal:Reader)=>principal.reads},guards};
    const prepared={audience:{assert:async()=>binding},prepare:async(_actor:unknown,query:string)=>query,allow:async()=>{}};
    const memory=new NativeMemoryRepository(contexts as any,{} as any,prepared as any,provenance,honchoEngine(async(path:string,body:any)=>{
      if(/\/scopes\/[^/]+\/status$/.test(path))return {backfill_status:{}};
      if(/\/scopes(\/[^/]+\/sessions)?$/.test(path)){walled.push(body);return null;}
      asked.push(body);return hits;}),async()=>[]);
    Object.assign(memory as any,{workspace:async()=>({id:workspace}),current:async()=>({row:{id:workspace,state:'ready'},binding,principal:{}})});
    const answer:Reader={admin:false,scope:OWNER,space:OWNER,turnEvent:digest(key+':start'),answer:'a'.repeat(32),reads:frozen};
    const found=await memory.search(answer,'kestrelpine',20);
    assert.equal(asked[0].scope,memoryWallName(workspace,readSetIds(frozen)));assert.equal(asked[0].filters,undefined);
    assert.deepEqual([...walled[1].session_ids].sort(),readable.map(session).sort(),'the wall holds exactly the sessions of the frozen groups');
    assert.deepEqual(found.ids.sort(),readable.map(place=>source(place).id).sort(),'never the evidence of GP4, the owner, a private chat or an import');
    assert.deepEqual((await memory.search({...answer,reads:readSet({home:GP4,whole:[GP4],project:null})},'kestrelpine',20)).ids.sort(),
      [source(GP4).id,source(GP4+'/topic/9').id].sort(),'whatever Honcho returns, a set keeps only its own groups\' evidence');
  } finally {
    await stores.control.query('DELETE FROM memory_ingestion_receipts WHERE generation=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_walls WHERE workspace=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_sessions WHERE workspace=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_generations WHERE id=$1',[workspace]);
    restore();await stores.close();
  }
});

test('recall evidence reads the receipts its recall asked: a sibling topic\'s only when topics share memory, never a retired one, and only what a group can read',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const key='topic-evidence:'+Date.now(),workspace=digest(key),conclusion='t'.repeat(21);
  // GP1's topic 3 asks; topic 4 is its sibling. One write each, a retired write in topic 3, and one of topic 3's
  // messages the reader may not read.
  const group='-100',topic=group+'/topic/3',sibling=group+'/topic/4',writes=['own','sibling','retired','unreadable'] as const;
  const audienceOf={own:topic,sibling,retired:topic,unreadable:topic},remote=(name:string)=>(name[0]!+'m').repeat(10)+name[0]!;
  const call=async(path:string,body:any)=>{
    assert.equal(path,'/v3/workspaces/'+workspace+'/nocheh/provenance');assert.deepEqual(body,{conclusion_ids:[conclusion]});
    return {roots:[conclusion],nodes:[{id:conclusion,parents:[],deleted:false,exact_citations:true}],
      messages:writes.map(name=>({message_id:remote(name),receipt_id:digest(key+':receipt:'+name)})),limitations:[],exact_citations:true};
  };
  const provenance=new MemoryProvenanceRepository(stores,archive,guards,honchoEngine(call));
  try {
    const binding=await guards.state(),sources:Record<string,any>={};
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,'owner']);
    for(const name of writes) {
      const event:Envelope={version:1,key:key+':'+name,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:group,source_id:name,revision:'1',occurred_at:null,text:'Synthetic '+name,payload:{}};
      sources[name]=(await archive.capture(event)).source.reference;
      await stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,content_hash,state,remote_id,audience,retired_at)
        VALUES($1,$2,$3,$4,$5,$6,'done',$7,$8,$9)`,[digest(key+':receipt:'+name),workspace,JSON.stringify(sources[name]),'events:'+sources[name].id,
        digest(key+':prepared:'+name),digest('fixture'),remote(name),audienceOf[name],name==='retired'?new Date():null]);
    }
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true');
    const batches:string[][]=[],readable=async(references:any[])=>{batches.push(references.map(reference=>reference.id));
      return new Map(references.map(reference=>[reference.id,reference.id!==sources.unreadable.id]));};
    const shared=await provenance.read(workspace,topic,[conclusion],binding,{group:[group,topic,sibling],readable});
    assert.deepEqual(shared.evidence,[sources.own,sources.sibling],'topics that share memory keep the sibling topic\'s evidence the recall read');
    assert.ok(shared.limitations.includes('ingestion_reference_unavailable'),'a retired write is not evidence');
    assert.ok(shared.limitations.includes('source_reference_unreadable'),'a message the group cannot read is left out, and says so');
    assert.deepEqual(batches.map(batch=>[...batch].sort()),[[sources.own.id,sources.sibling.id,sources.unreadable.id].sort()],
      'every reference is checked for the reader, all in one batch (readable), never one read per message');
    const separate=await provenance.read(workspace,topic,[conclusion],binding,{group:null,readable});
    assert.deepEqual(separate.evidence,[sources.own],'a topic with its own memory reads only its own receipts');
    const owner=await provenance.read(workspace,'owner',[conclusion],binding);
    assert.deepEqual(owner.evidence,[sources.own,sources.sibling,sources.unreadable],'the owner reads every audience\'s evidence, but never a retired write');
    assert.ok(owner.limitations.includes('ingestion_reference_unavailable'));
    // The owner's own turn checks too: a message retired since it was learned is no evidence any more.
    const turn=await provenance.read(workspace,'owner',[conclusion],binding,{readable:async references=>new Map(references.map(reference=>[reference.id,reference.id!==sources.own.id]))});
    assert.deepEqual(turn.evidence,[sources.sibling,sources.unreadable],'the owner\'s turn keeps only messages its check lets it read');
    assert.ok(turn.limitations.includes('source_reference_unreadable'));
  } finally {
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false');
    await stores.control.query('DELETE FROM memory_ingestion_receipts WHERE generation=$1',[workspace]);
    await stores.control.query('DELETE FROM memory_generations WHERE id=$1',[workspace]);
    await stores.close();
  }
});
