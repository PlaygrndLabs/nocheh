import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Inngest} from 'inngest';
import {workflowConfig,workflowIdentity} from '../src/workflows/client.js';
import {backgroundConcurrency,coordinatedFunctions} from '../src/workflows/engine.js';
import {backgroundFamilies} from '../src/stores/workflow-operations.js';
import {families} from '../src/workflows/store.js';

test('workflow config requires dedicated keys and local endpoints without a cloud fallback',()=>{
  const env={INNGEST_EVENT_KEY:'a'.repeat(64),INNGEST_SIGNING_KEY:'b'.repeat(64)};
  assert.equal(workflowConfig(env).baseUrl,'http://inngest-server:8288');
  assert.equal(workflowConfig({...env,INNGEST_BASE_URL:'http://nocheh-app:8780',INNGEST_CONNECT_GATEWAY_URL:'ws://nocheh-app:8780/v0/connect'}).gatewayUrl,'ws://nocheh-app:8780/v0/connect');
  for(const INNGEST_BASE_URL of ['https://inn.gs','http://external.example','http://key@localhost:8288','http://localhost:8288/?key=secret'])
    assert.throws(()=>workflowConfig({...env,INNGEST_BASE_URL}),/local_endpoint/);
  assert.throws(()=>workflowConfig({}),/keys_missing/);
  assert.throws(()=>workflowConfig({...env,INNGEST_CONNECT_GATEWAY_URL:'wss://connect.inngest.com'}),/local_endpoint/);
  assert.throws(()=>workflowIdentity('source text or secret'),/identity_invalid/);
});

test('background memory work waits in one shared engine queue instead of polling the busy slot',()=>{
  const background=backgroundFamilies(families),client=new Inngest({id:'fixture',isDev:false,eventKey:'a'.repeat(64),signingKey:'b'.repeat(64)});
  assert.deepEqual([...background].filter(family=>['memory_review','honcho','organization'].includes(family)).sort(),['honcho','memory_review','organization']);
  for(const family of ['preparation','telegram','browser','schedules','actions'] as const)assert.equal(background.has(family),false);
  const registered=Object.fromEntries(coordinatedFunctions(client,['telegram','preparation','honcho','memory_review'],async()=>{throw Error('not executed');},async()=>{},background)
    .map(fn=>[fn.opts.id,fn.opts.concurrency]));
  assert.deepEqual(registered['honcho-v1'],[backgroundConcurrency]);assert.deepEqual(registered['memory_review-v1'],[backgroundConcurrency]);
  assert.equal(registered['telegram-v1'],undefined);assert.equal(registered['preparation-v1'],undefined);
});
