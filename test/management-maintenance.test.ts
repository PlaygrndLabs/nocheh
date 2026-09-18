import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ManagementMaintenance} from '../src/management-maintenance.js';

test('maintenance drains admitted work before attesting readiness and denies every content/proxy mutation',async()=>{
  const gate=new ManagementMaintenance(),earlier=gate.enter(),caller=gate.enter();let drained=false;
  const waiting=gate.begin('backup-job',caller.id).then(token=>{drained=true;return token;});
  assert.equal(gate.state?.ready,false);await Promise.resolve();assert.equal(drained,false);
  for(const [method,path] of [['POST','/api/nocheh/jobs'],['PUT','/api/nocheh/jobs/old/upload'],['POST','/api/nocheh/data/abc/guarded'],
    ['GET','/hermes/api/config'],['GET','/providers/v0/management/codex-auth-url'],['GET','/api/nocheh/artifacts/abc/download'],['GET','/api/nocheh/jobs/other'],['POST','/api/nocheh/shutdown']])
    assert.equal(gate.allows(method!,path!),false,path);
  assert.ok(gate.allows('GET','/api/nocheh/jobs/backup-job'));assert.ok(gate.allows('GET','/api/plugins/nocheh/maintenance'));
  assert.ok(gate.allows('GET','/'));assert.ok(gate.allows('GET','/assets/app.js'));
  earlier.finish();const token=await waiting;assert.equal(gate.state?.ready,false);
  gate.ready(token);assert.equal(gate.state?.ready,true);gate.end('stale');assert.ok(gate.active);
  caller.finish();gate.end(token);assert.ok(!gate.active);assert.ok(gate.allows('POST','/api/nocheh/jobs'));
});

test('an incomplete drain never authorizes a backup and releases admission on timeout',async()=>{
  const gate=new ManagementMaintenance(),earlier=gate.enter(),caller=gate.enter();
  await assert.rejects(gate.begin('backup',caller.id,5),{code:'management_drain_timeout'});
  assert.equal(gate.active,false);earlier.finish();caller.finish();
});
