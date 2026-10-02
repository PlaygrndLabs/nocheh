import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['dashboard/lib/memory-access-presentation.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {accessDescription,connectionDescription,shareableFact}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('only an active saved grant is described as permitting recall',()=>{
  assert.equal(accessDescription('active'),'This fact can be used here.');
  for(const state of ['suspended','revoked','consumed','expired','pending','unknown',undefined]){
    assert.notEqual(accessDescription(state),accessDescription('active'));
    assert.equal(connectionDescription({kind:'access',state}),accessDescription(state));
  }
  assert.match(accessDescription('suspended'),/cannot be used/);
  assert.match(accessDescription('revoked'),/no longer allows future recall/);
  assert.match(accessDescription('consumed'),/No further access/);
});

test('descriptive and pending connections never claim memory access',()=>{
  for(const kind of ['relationship','project_assignment'])assert.match(connectionDescription({kind,state:'active'}),/No memory access granted/);
  assert.match(connectionDescription({kind:'suggestion',state:'pending'}),/No access granted/);
  assert.match(connectionDescription({kind:'suggestion',state:'approved'}),/does not grant access/);
});

test('sharing controls require an active versioned fact, excluding retired and legacy records',()=>{
  const fact={id:'fact:'+'a'.repeat(64),kind:'fact',state:'active',detail:{retired:false}};
  assert.equal(shareableFact(fact),true);
  for(const patch of [{kind:'person'},{state:'retired'},{state:undefined},{detail:{retired:true}},{id:'fact:release-'+'a'.repeat(64)}])assert.equal(shareableFact({...fact,...patch}),false);
});
