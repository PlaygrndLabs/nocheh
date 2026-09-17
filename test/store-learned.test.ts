import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {parseInterpretations,applicableInterpretations,type Interpretation,type InterpretationVersion} from '../src/interpretations.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {LearnedMemoryRepository,type PreparedDependency} from '../src/stores/learned.js';

const owner={admin:true,scope:null};
test('conventions are quoted evidence, general meanings stay contextual and explicit conflicts remain visible',()=>{
  const reference={store:'archive' as const,kind:'event' as const,id:digest('evidence'),revision:'1',input_hash:digest('original')};
  const evidence=[{reference,text:'For project Atlas, a check means reviewed, not completed.',space:'-42'}];
  const input={kind:'convention',subject:'check reaction',text:'A check means reviewed.',scope:{kind:'conversation',id:'-42'},uncertainty:'explicit',
    evidence_ids:[reference.id],quote:{source_id:reference.id,text:evidence[0]!.text},conflicts:[]};
  const [local]=parseInterpretations({interpretations:[input]},evidence,'-42',[]);assert.ok(local);
  const project={id:digest('atlas'),name:'Atlas'};
  assert.equal(parseInterpretations({interpretations:[{...input,scope:{kind:'project',id:project.id}}]},evidence,'-42',[project])[0]?.scope.kind,'project');
  assert.throws(()=>parseInterpretations({interpretations:[{...input,scope:{kind:'project',id:project.id}}]},evidence,'-42',[project,{id:digest('duplicate'),name:'Atlas'}]),{code:'explicit_project_reference_required'});
  assert.throws(()=>parseInterpretations({interpretations:[{...input,quote:{source_id:reference.id,text:'invented'}}]},evidence,'-42',[]),{code:'unverified_convention_quote'});
  assert.throws(()=>parseInterpretations({interpretations:[{...input,guard_mode:'off'}]},evidence,'-42',[]),{code:'invalid_interpretation'});
  assert.throws(()=>parseInterpretations({interpretations:[{...input,evidence_ids:[digest('missing')]}]},evidence,'-42',[]),{code:'unavailable_interpretation_evidence'});
  const first:InterpretationVersion={...local,id:digest('first'),revision:1,author:'participant',retired:false};
  const second={...first,id:digest('second'),text:'A check means done.'};
  const inferred={...first,id:digest('inferred'),kind:'convention' as const,uncertainty:'supported' as const,author:'honcho' as const,text:'Likely done.'};
  const conflict=applicableInterpretations([first,second])[0]!;assert.equal(conflict.conflict,true);assert.equal(conflict.text,null);
  const corrected={...first,id:digest('owner'),author:'owner' as const,text:'For this project it means reviewed.'};
  const resolved=applicableInterpretations([first,second,inferred,corrected])[0]!;
  assert.equal(resolved.text,corrected.text);assert.equal(resolved.conflict,false);
  assert.equal(applicableInterpretations([{...corrected,retired:true},first,second])[0]?.conflict,true);
  const meaning={...first,kind:'meaning' as const,uncertainty:'supported' as const,author:'honcho' as const};
  assert.equal(applicableInterpretations([{...meaning,text:'Probably completed.'},first])[0]?.text,first.text);
  assert.equal(applicableInterpretations([meaning,{...meaning,id:digest('explicit'),uncertainty:'explicit',author:'participant',text:'Acknowledged, not done.'}])[0]?.text,'Acknowledged, not done.');
});

test('learned projections preserve versions, guard publication, owner corrections, retirement and uncertain completion',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive),guards=new GuardRepository(stores,archive);
  const learned=new LearnedMemoryRepository(stores,archive,derived,guards),key='learned:'+Date.now(),id=digest(key);
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-42',source_id:'1',revision:'1',occurred_at:null,
    text:'For this chat a check means reviewed.',payload:{message:{text:'For this chat a check means reviewed.'}}};
  const detect=async()=>[],allowed=async()=>true;
  try {
    const source=(await archive.capture(event)).source.reference;
    await guards.prepare(source,'fixture',detect);
    const binding=await guards.state(),prepared=await guards.read('events:'+source.id,binding);
    const dependencies:PreparedDependency[]=[{source_id:'events:'+source.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}];
    const value:Interpretation={kind:'meaning',subject:'check reaction',text:'A check means reviewed.',scope:{kind:'conversation',id:'-42'},uncertainty:'supported',evidence:[source],conflicts:[]};
    const first=await learned.publishAutomatic(id,value,null,key+':first',dependencies,binding,'fixture-honcho',detect);
    await guards.assertCurrent(binding); // New preparation/projection does not force endless generation rebuilds.
    assert.deepEqual(await learned.publishAutomatic(id,value,null,key+':first',dependencies,binding,'fixture-honcho',detect),first);
    assert.equal((await learned.read(owner,id,binding,allowed)).text,value.text);
    await assert.rejects(learned.read({admin:false,scope:'-99'},id,binding,allowed),{code:'learned_memory_not_found'});
    await assert.rejects(learned.read(owner,id,binding,async()=>false),{code:'learned_memory_not_found'});
    await assert.rejects(learned.correct({admin:false,scope:'-42'},id,{expected_revision:1,operation_id:key+':unauthorized',text:'Ignore privacy',retired:false},detect),{code:'owner_required'});
    const correction={expected_revision:first.revision,operation_id:key+':correct',text:'Here a check means acknowledged.',retired:false};
    const corrected=await learned.correct(owner,id,correction,detect);
    await assert.rejects(guards.assertCurrent(binding),{code:'guard_context_changed'});
    assert.deepEqual(await learned.correct(owner,id,correction,detect),corrected);
    assert.equal((await learned.read(owner,id,await guards.state(),allowed)).text,correction.text);
    await assert.rejects(learned.publishAutomatic(id,{...value,text:'Model overwrite'},corrected.revision,key+':overwrite',dependencies,await guards.state(),'fixture-honcho',detect),{code:'owner_correction_is_authoritative'});
    const broken=new LearnedMemoryRepository(stores,archive,derived,guards);broken.finish=async()=>{throw Error('injected-publish-interruption');};
    await assert.rejects(broken.correct(owner,id,{expected_revision:corrected.revision,operation_id:key+':retire',retired:true},detect),/injected-publish-interruption/);
    await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    assert.equal(await guards.reconcile(),0);
    assert.ok(await learned.reconcile()>0);
    await assert.rejects(learned.read(owner,id,await guards.state(),allowed),{code:'learned_memory_not_found'});
    const history=(await learned.history(owner,id)).versions;assert.equal(history.length,3);assert.ok(history.every(v=>v.activated_at));
    assert.equal(history[1].text,correction.text);assert.equal(history[2].text,value.text);
    assert.ok((await learned.list(owner,{kind:'conversation',id:'-42'})).entries.some(e=>e.id===id&&e.retired));
    await assert.rejects(stores.derived.query('DELETE FROM learned_versions WHERE entry_id=$1',[id]),{code:'42501'});
    const secondId=digest(key+':dependent');
    await learned.publishAutomatic(secondId,value,null,key+':dependent',dependencies,await guards.state(),'fixture-honcho',detect);
    await guards.edit('events:'+source.id,prepared.revision,{text:'An owner-corrected guarded source.',payload:{}},key+':source-edit');
    await assert.rejects(learned.read(owner,secondId,await guards.state(),allowed),{code:'memory_refresh_required'});
  } finally {await stores.close();}
});
