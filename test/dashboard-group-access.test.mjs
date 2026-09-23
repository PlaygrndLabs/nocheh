import test from 'node:test';
import assert from 'node:assert/strict';
import {participantAllowed,switchDecision} from '../web/lib/group-access.js';

test('default-denied people switch on and return to the saved default',()=>{
  const empty={granted:[],denied:[]},granted={granted:['73'],denied:[]};
  assert.equal(participantAllowed(empty,'73'),false);
  assert.equal(switchDecision(empty,empty,'73',true),'grant');
  assert.equal(switchDecision(empty,granted,'73',false),'default');
  assert.equal(switchDecision(empty,empty,'73',false),null);
});

test('a saved grant switches off to deny and back to its saved state',()=>{
  const granted={granted:['73'],denied:[]},denied={granted:[],denied:['73']};
  assert.equal(switchDecision(granted,granted,'73',false),'deny');
  assert.equal(switchDecision(granted,denied,'73',true),'grant');
});

test('explicit denies remain denied and take precedence over grants',()=>{
  const denied={granted:[],denied:['73']},conflict={granted:['73'],denied:['73']};
  assert.equal(participantAllowed(denied,'73'),false);
  assert.equal(participantAllowed(conflict,'73'),false);
  assert.equal(switchDecision(denied,denied,'73',true),'grant');
  assert.equal(switchDecision(denied,{granted:['73'],denied:[]},'73',false),'deny');
});
