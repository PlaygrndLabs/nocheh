import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['dashboard/lib/supervision.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {decisionLink,selectedDecision,activityNavigation,knowledgeDecisionControls,memoryAvailability,proposalState}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('exact decision links identify every family independently of the loaded page',()=>{
 for(const kind of ['controlled_action','telegram_action','memory_access','entity','knowledge']){
  const id='f'.repeat(64);assert.deepEqual(selectedDecision(decisionLink(kind,id)),{kind,id});
 }
 assert.equal(selectedDecision('#activity?kind=other&decision=123'),null);
 assert.equal(selectedDecision('#activity?kind=entity'),null);
 assert.equal(selectedDecision('#activity?action=legacy'),null);
});
test('unavailable memory observations and service attachment never claim usable memory',()=>{
 assert.equal(memoryAvailability(null).state,'unknown');
 assert.equal(memoryAvailability({connection:{attached:true,verified:true},limited_memory:false},true).state,'unknown');
 assert.equal(memoryAvailability({connection:{attached:false,verified:true},limited_memory:false}).state,'disabled');
 assert.equal(memoryAvailability({connection:{attached:true,verified:false},limited_memory:false}).state,'unverified');
 assert.equal(memoryAvailability({connection:{attached:true,verified:true}}).state,'limited');
 assert.equal(memoryAvailability({connection:{attached:true,verified:true},limited_memory:true}).state,'limited');
 assert.equal(memoryAvailability({connection:{attached:true,verified:true},limited_memory:false}).state,'ready');
});
test('authorization and waiting are distinct from a confirmed application receipt',()=>{
 assert.match(proposalState('queued'),/Queued/);assert.match(proposalState('waiting'),/Waiting/);
 for(const state of ['review','queued','waiting','stale','cancelled','failed','undone'])assert.notEqual(proposalState(state),proposalState('applied'));
});
test('same-page decision links reopen their tab and replace a legacy action selection',()=>{
 for(const tab of ['approvals','permissions','runs']){
  const route=activityNavigation(decisionLink('entity','e'.repeat(64)),tab);
  assert.deepEqual(route,{tab:'decisions',actionId:null});
 }
 const prior=activityNavigation('#activity?action=old-action','permissions');
 assert.deepEqual(prior,{tab:'decisions',actionId:'old-action'});
 const next=activityNavigation(decisionLink('memory_access','a'.repeat(64)),prior.tab);
 assert.equal(next.actionId,null,'the old action reviewer must close when another decision owns the hash');
 assert.deepEqual(activityNavigation('#activity','runs'),{tab:'runs',actionId:null});
 assert.deepEqual(activityNavigation('#activity?kind=entity&decision=new&action=old','approvals'),{tab:'decisions',actionId:null});
});
test('stale or failed proposals can be dismissed without authorizing their stale dependencies',()=>{
 for(const state of ['stale','failed'])for(const stale of [false,true]){
  const controls=knowledgeDecisionControls(state,{stale});
  assert.equal(controls.cancel,true);assert.equal(controls.approve,false);assert.equal(controls.undo,false);
 }
 const staleReview=knowledgeDecisionControls('review',{stale:true});
 assert.equal(staleReview.approve,false);assert.equal(staleReview.reject,true);
 for(const state of ['queued','waiting'])assert.equal(knowledgeDecisionControls(state,{stale:true}).cancel,true);
});
test('dismissal requires the saved revision and an available observation and cannot repeat a closed outcome',()=>{
 for(const state of ['review','queued','waiting','stale','failed','applied']){
  for(const blocker of ['unavailable','changed','busy']){
   const controls=knowledgeDecisionControls(state,{[blocker]:true});
   assert.ok(Object.values(controls).every(value=>value===false),state+' must remain locked while '+blocker);
  }
 }
 for(const state of ['cancelled','undone'])assert.ok(Object.values(knowledgeDecisionControls(state)).every(value=>value===false));
 assert.equal(knowledgeDecisionControls('failed',{busy:false}).cancel,true,'a completed failed request can be retried against the same retained revision');
});
