import {test} from 'node:test';
import assert from 'node:assert/strict';
import {learningInstruction,learningPrompt,promptProblem,withPrompts} from '../src/prompts.js';

test('owner instruction texts need content, a known name and the values Nocheh fills in',()=>{
  assert.equal(promptProblem('reply.owner','Answer in Persian.'),null);
  assert.equal(promptProblem('reply.unknown','Text'),'unknown_prompt');
  assert.equal(promptProblem('reply.owner','  '),'empty_prompt');
  assert.equal(promptProblem('reply.owner',7),'empty_prompt');
  assert.equal(promptProblem('reply.owner','x'.repeat(20001)),'prompt_too_long');
  assert.equal(promptProblem('learning.interpret','Interpret {trigger_id}.'),'prompt_placeholder_missing');
  assert.equal(promptProblem('learning.interpret',learningPrompt),null);
  assert.equal(learningInstruction('Cite {trigger_id} from {citable_ids}.',{trigger_id:'t',citable_ids:'["t"]'}),'Cite t from ["t"].');
});

test('runtime calls that run an instruction text carry only the owner’s valid replacements',async()=>{
  const control={query:async()=>({rows:[{texts:{'reply.owner':'Mine','reply.group':' ','bogus':'Ignored',
    'learning.interpret':'Stays in Nocheh {trigger_id} {citable_ids}','telegram.not_allowed':'Also stays in Nocheh'}}]})} as any;
  const seen:[string,Record<string,unknown>][]=[];
  const call=withPrompts(async(operation,input)=>{seen.push([operation,input]);return {};},control);
  await call('run.start',{event_id:'e'});await call('guard.detect',{text:'t'});await call('status',{});
  assert.deepEqual(seen,[['run.start',{event_id:'e',prompts:{'reply.owner':'Mine'}}],['guard.detect',{text:'t',prompts:{'reply.owner':'Mine'}}],['status',{}]]);
  const failing=withPrompts(async()=>({}),{query:async()=>{throw Error('control unavailable');}} as any);
  await assert.rejects(failing('memory.filter',{}),/control unavailable/);
});
