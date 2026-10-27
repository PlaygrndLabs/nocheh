import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {HttpError} from '../src/http.js';
import {learningQuery} from '../src/stores/learning-engine.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {observation} from '../src/workflows/pipeline.js';

test('an unusable saved learning result closes its workflow while other learning failures stay retryable',async()=>{
  let failure:Error=new HttpError(422,'invalid_interpretation_result');
  const services:any={stores:{control:{query:async()=>({rows:[{attempts:3}]})}},learning:{run:async()=>{throw failure;}}};
  const operations=storageWorkflowOperations(services,async()=>{throw Error('no runtime calls');});
  const job='interpret:'+digest('synthetic-learning-job'),authority={owner:'inngest' as const,epoch:1};
  const closed=await operations.memory_review!(job,authority);
  assert.deepEqual([closed.state,closed.stage,closed.attempts,closed.waiting_reason],['failed','review',3,'invalid_model_output']);
  safeMetadata(closed);
  failure=new HttpError(413,'learning_query_limit');
  const oversized=await operations.memory_review!(job,authority);
  assert.deepEqual([oversized.state,oversized.waiting_reason],['failed','input_limit'],'an input too large to ask is not retried');
  failure=new HttpError(503,'honcho_unavailable');
  await assert.rejects(operations.memory_review!(job,authority),{code:'honcho_unavailable'},'provider outages keep the normal retry path');
  failure=new HttpError(422,'unavailable_interpretation_evidence');
  await assert.rejects(operations.memory_review!(job,authority),{code:'unavailable_interpretation_evidence'});
});

test('closing workflow reasons pass the workflow data boundary',()=>{
  for(const reason of ['native_review_unconfirmed','invalid_model_output','input_limit'])safeMetadata(observation('failed','review',1,Date.now(),reason));
  assert.throws(()=>safeMetadata(observation('failed','review',1,Date.now(),'unlisted_reason')));
});

test('a learning query fits Honcho\'s limit by trimming other evidence, then rules, then the trigger\'s payload, then leaving out other evidence',()=>{
  const observation=(id:string,size:number)=>({source:{id,revision:1},value:{text:'Synthetic note '+id,payload:{padding:'p'.repeat(size)}},derivatives:[]});
  const rule=(index:number)=>({scope:'conversation',kind:'meaning',subject:'s'+index,conflict:false,text:'r'.repeat(400),selected:['v'+index],superseded:[]});
  const context=(trigger:number,other:number,rules:number)=>({source:{id:'trigger',revision:1},space:'synthetic',projects:[],entities:{} as any,limitations:[],
    observations:[observation('trigger',trigger),observation('other',other)],rules:Array.from({length:rules},(_,index)=>rule(index))}) as any;
  const parse=(query:string)=>JSON.parse(query.slice(query.indexOf('\n')+1));
  const small=learningQuery('Instruction',context(100,100,2));
  assert.deepEqual(parse(small).limitations,[],'a query within the limit is unchanged');
  const trimmed=parse(learningQuery('Instruction',context(1000,8000,6)));
  assert.equal(trimmed.observations[1].value.payload,undefined);assert.equal(trimmed.observations[1].value.text,'Synthetic note other');
  assert.equal(trimmed.observations[0].value.payload.padding.length,1000,'the trigger keeps its payload while it fits');
  assert.equal(trimmed.rules.length,6);assert.deepEqual(trimmed.limitations,['other_evidence_text_only']);
  const ruled=learningQuery('Instruction',context(1000,8000,30));
  assert.ok(Array.from(ruled).length<=10000);assert.ok(parse(ruled).rules.length<30&&parse(ruled).rules.length>0);
  assert.deepEqual(parse(ruled).limitations,['other_evidence_text_only','rules_omitted']);
  const bare=parse(learningQuery('Instruction',context(12000,0,1)));
  assert.equal(bare.observations[0].value.payload,undefined);assert.equal(bare.observations[0].value.text,'Synthetic note trigger');
  assert.deepEqual(bare.rules,[]);assert.deepEqual(bare.limitations,['other_evidence_text_only','rules_omitted','trigger_text_only']);
  // Many related messages that don't fit even as text are left out from the end; the instruction cites only those shown.
  const crowded={...context(12000,0,1),observations:[observation('trigger',12000),...Array.from({length:30},(_,index)=>
    ({source:{id:'other'+index,revision:1},value:{text:'t'.repeat(500)},derivatives:[]}))]};
  let cited:string[]=[];
  const omitted=learningQuery(ids=>{cited=ids;return 'Instruction '+ids.join(',');},crowded);
  assert.ok(Array.from(omitted).length<=10000);
  const kept=parse(omitted).observations.map((item:{source:{id:string}})=>item.source.id);
  assert.ok(kept.length>1&&kept.length<31);assert.equal(kept[0],'trigger');assert.deepEqual(kept,crowded.observations.slice(0,kept.length).map((item:any)=>item.source.id));
  assert.deepEqual(cited,kept);
  assert.deepEqual(parse(omitted).limitations,['other_evidence_text_only','rules_omitted','trigger_text_only','other_evidence_omitted']);
  assert.throws(()=>learningQuery('i'.repeat(10001),context(0,0,0)),{code:'learning_query_limit'});
});
