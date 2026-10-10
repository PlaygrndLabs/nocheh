import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {HttpError} from '../src/http.js';
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
  failure=new HttpError(503,'honcho_unavailable');
  await assert.rejects(operations.memory_review!(job,authority),{code:'honcho_unavailable'},'provider outages keep the normal retry path');
  failure=new HttpError(422,'unavailable_interpretation_evidence');
  await assert.rejects(operations.memory_review!(job,authority),{code:'unavailable_interpretation_evidence'});
});

test('closing workflow reasons pass the workflow data boundary',()=>{
  for(const reason of ['native_review_unconfirmed','invalid_model_output'])safeMetadata(observation('failed','review',1,Date.now(),reason));
  assert.throws(()=>safeMetadata(observation('failed','review',1,Date.now(),'unlisted_reason')));
});
