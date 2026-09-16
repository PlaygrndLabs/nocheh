import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workflowConfig,workflowIdentity} from '../src/workflows/client.js';

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
