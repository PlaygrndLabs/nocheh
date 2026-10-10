import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {learningResult,parseInterpretations,triggeredInterpretations,applicableInterpretations,type Interpretation,type InterpretationVersion} from '../src/interpretations.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {LearnedMemoryRepository,type PreparedDependency} from '../src/stores/learned.js';

const owner={admin:true,scope:null};
test('identical automatic interpretations do not require a new revision, but evidence and meaning changes do',async()=>{
  const source={store:'archive' as const,kind:'event' as const,id:digest('repeat-source'),revision:'1',input_hash:digest('repeat-input')};
  const value:Interpretation={kind:'state',subject:'synthetic task',text:'The task is under review.',
    scope:{kind:'conversation',id:'synthetic'},uncertainty:'supported',evidence:[source],conflicts:[]};
  const dependencies:PreparedDependency[]=[{source_id:'events:'+source.id,revision:1,value_hash:digest('guarded-source')}];
  const {text,...learning}=value;
  const row={author:'honcho',retired:false,dependencies,content:Buffer.from(text),provenance:{learning}};
  let staged=false;
  const stores={derived:{query:async()=>({rows:staged?[]:[row]})}} as any;
  const learned=new LearnedMemoryRepository(stores,{} as any,{} as any,{} as any);
  const check=(candidate:Interpretation,deps=dependencies)=>learned.matchesActiveAutomatic(digest('entry'),candidate,deps,'synthetic-operation');
  assert.equal(await check(value),true);
  assert.equal(await check({...value,text:'The task is complete.'}),false);
  assert.equal(await check({...value,evidence:[{...source,revision:'2'}]}),false);
  assert.equal(await check(value,[{...dependencies[0]!,revision:2}]),false);
  row.author='owner';assert.equal(await check(value),false);
  row.author='honcho';row.retired=true;assert.equal(await check(value),false);
  row.retired=false;staged=true;assert.equal(await check(value),false,'a previously staged operation must use recovery');
});
test('reaction learning ignores unrelated conclusions and keeps strict original-source validation',()=>{
  const trigger=digest('reaction'),target=digest('older-message'),rule=digest('learned-rule'),unknown=digest('unknown');
  const evidence=[trigger,target].map(id=>({reference:{store:'archive' as const,kind:'event' as const,id,revision:'1',input_hash:digest(id)},text:'Synthetic source.',space:'-42'}));
  const base={kind:'state',subject:'older item',text:'The older item is done.',scope:{kind:'conversation',id:'-42'},
    uncertainty:'supported',conflicts:[]};
  const raw={interpretations:[{...base,subject:'unrelated',evidence_ids:[target]},
    {...base,evidence_ids:[trigger,target,rule]}]};
  const scoped=triggeredInterpretations(raw,trigger,[rule]);
  const {values}=parseInterpretations(scoped,evidence,'-42',[]);
  assert.equal(values.length,1);assert.deepEqual(values[0]!.evidence.map(item=>item.id),[trigger,target]);
  assert.equal(raw.interpretations[1]!.evidence_ids.length,3,'the saved model result stays unchanged');
  const unavailable=parseInterpretations(triggeredInterpretations({interpretations:[{...base,evidence_ids:[trigger,unknown]},{...base,subject:'kept',evidence_ids:[trigger]}]},trigger,[rule]),
    evidence,'-42',[]);
  assert.deepEqual(unavailable.values.map(v=>v.subject),['kept'],'an unavailable citation drops only its own item');
  assert.deepEqual(unavailable.rejected,[{section:'interpretations',code:'unavailable_interpretation_evidence'}]);
});
test('a saved reasoning result is read from plain, fenced or sentence-wrapped JSON and unusable output is rejected',()=>{
  const value={interpretations:[{kind:'state',subject:'a {brace} "quoted"',text:'Synthetic.'}],entity_claims:[]};
  const json=JSON.stringify(value,null,2);
  for(const text of [json,'```json\n'+json+'\n```','Here is the result:\n```\n'+json+'\n```\nDone.','Based on the evidence, '+json+' is my answer.'])
    assert.deepEqual(learningResult(text),value);
  assert.deepEqual(learningResult('Example {"note":1} then '+json),value,'an unrelated object is not the result');
  for(const text of ['No learnable content.','```json\n{"interpretations":[\n```','[]','{"notes":"none"}'])
    assert.throws(()=>learningResult(text),{code:'invalid_interpretation_result'});
});
test('learning result sections keep valid leading items and record what was dropped',()=>{
  const source=digest('limit-trigger'),evidence=[{reference:{store:'archive' as const,kind:'event' as const,id:source,revision:'1',input_hash:digest(source)},text:'Synthetic source',space:'-42'}];
  const item=(subject:string)=>({kind:'state',subject,text:'Synthetic.',scope:{kind:'conversation',id:'-42'},uncertainty:'supported',evidence_ids:[source]});
  const many=parseInterpretations({interpretations:Array.from({length:14},(_,i)=>item('item '+i))},evidence,'-42',[]);
  assert.equal(many.values.length,12);assert.deepEqual(many.rejected.map(r=>r.code),['interpretations_limit','interpretations_limit']);
  assert.deepEqual(parseInterpretations({entity_claims:[]},evidence,'-42',[]),{values:[],rejected:[]},'an omitted section means none');
  assert.deepEqual(parseInterpretations({interpretations:null},evidence,'-42',[]).rejected,[]);
  assert.deepEqual(parseInterpretations({interpretations:'none'},evidence,'-42',[]).rejected,[{section:'interpretations',code:'invalid_interpretations'}]);
});
test('optional organization output cannot change or prevent ordinary interpretation validation',()=>{
  const source=digest('organization-trigger'),evidence=[{reference:{store:'archive' as const,kind:'event' as const,id:source,revision:'1',input_hash:digest(source)},text:'Synthetic source',space:'-42'}];
  const interpretation={kind:'state',subject:'item',text:'Under review',scope:{kind:'conversation',id:'-42'},uncertainty:'supported',conflicts:[],evidence_ids:[source]};
  const expected=parseInterpretations({interpretations:[interpretation]},evidence,'-42',[]);
  for(const organization of [null,'malformed',42,[],{approved:true,owner:true},{creates:[],assignments:[]}]){
    const raw={interpretations:[interpretation],organization};
    assert.deepEqual(parseInterpretations(triggeredInterpretations(raw,source,[]),evidence,'-42',[]),expected);
    assert.deepEqual(raw.organization,organization,'organization is retained for its separate trusted workflow');
  }
  assert.throws(()=>parseInterpretations({interpretations:[interpretation],permissions:{approved:true}},evidence,'-42',[]),{code:'invalid_interpretation_result'});
});
test('conventions are quoted evidence, general meanings stay contextual and explicit conflicts remain visible',()=>{
  const reference={store:'archive' as const,kind:'event' as const,id:digest('evidence'),revision:'1',input_hash:digest('original')};
  const evidence=[{reference,text:'For project Atlas, a check means reviewed, not completed.',space:'-42'}];
  const input={kind:'convention',subject:'check reaction',text:'A check means reviewed.',scope:{kind:'conversation',id:'-42'},uncertainty:'explicit',
    evidence_ids:[reference.id],quote:{source_id:reference.id,text:evidence[0]!.text},conflicts:[]};
  const rejection=(raw:unknown,projects:{id:string;name:string}[]=[],values=evidence,session?:string)=>{
    const parsed=parseInterpretations({interpretations:[raw]},values,'-42',projects,session);assert.equal(parsed.values.length,0);return parsed.rejected[0]?.code;
  };
  const [local]=parseInterpretations({interpretations:[input]},evidence,'-42',[]).values;assert.ok(local);
  const session=digest('current-honcho-session');
  const [aliased]=parseInterpretations({interpretations:[{...input,scope:{kind:'conversation',id:session}}]},evidence,'-42',[],session).values;
  assert.equal(aliased?.scope.id,'-42','only the current session resolves to the evidence conversation');
  assert.equal(rejection({...input,scope:{kind:'conversation',id:digest('other-session')}},[],evidence,session),'interpretation_scope_mismatch');
  assert.equal(rejection({...input,scope:{kind:'conversation',id:session}},[],[{...evidence[0]!,space:'-99'}],session),'interpretation_scope_mismatch');
  const project={id:digest('atlas'),name:'Atlas'};
  assert.equal(parseInterpretations({interpretations:[{...input,scope:{kind:'project',id:project.id}}]},evidence,'-42',[project]).values[0]?.scope.kind,'project');
  assert.equal(rejection({...input,scope:{kind:'project',id:project.id}},[project,{id:digest('duplicate'),name:'Atlas'}]),'explicit_project_reference_required');
  assert.equal(rejection({...input,quote:{source_id:reference.id,text:'invented'}}),'unverified_convention_quote');
  assert.equal(rejection({...input,guard_mode:'off'}),'invalid_interpretation');
  assert.equal(rejection({...input,evidence_ids:[digest('missing')]}),'unavailable_interpretation_evidence');
  assert.equal(rejection({...input,quote:null}),'convention_quote_required','a null optional field is absent, never a bypass');
  const first:InterpretationVersion={...local,id:digest('first'),revision:1,author:'participant',retired:false};
  const second={...first,id:digest('second'),text:'A check means done.'};
  const duplicate={...first,id:digest('duplicate-convention'),text:'The check means that is reviewed.'};
  assert.equal(applicableInterpretations([first,duplicate])[0]?.conflict,false,'minor grammar differences do not manufacture a convention conflict');
  const opposite={...first,id:digest('opposite-convention'),text:'A check means not reviewed.'};
  assert.equal(applicableInterpretations([first,opposite])[0]?.conflict,true,'negation remains meaningful');
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
