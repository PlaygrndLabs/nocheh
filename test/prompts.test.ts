import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvalCard,approvalLines,fillTemplate,learningInstruction,learningPrompt,promptProblem,withPrompts} from '../src/prompts.js';

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
    'learning.interpret':'Stays in Nocheh {trigger_id} {citable_ids}','telegram.not_allowed':'Also stays in Nocheh','telegram.approval_card':'Card {text}','telegram.approval_texts':'sent: Sent'}}]})} as any;
  const seen:[string,Record<string,unknown>][]=[];
  const call=withPrompts(async(operation,input)=>{seen.push([operation,input]);return {};},control);
  await call('run.start',{event_id:'e'});await call('guard.detect',{text:'t'});await call('status',{});
  assert.deepEqual(seen,[['run.start',{event_id:'e',prompts:{'reply.owner':'Mine'}}],['guard.detect',{text:'t',prompts:{'reply.owner':'Mine'}}],['status',{}]]);
  const failing=withPrompts(async()=>({}),{query:async()=>{throw Error('control unavailable');}} as any);
  await assert.rejects(failing('memory.filter',{}),/control unavailable/);
});

test('approval card templates leave out a line whose value is missing and keep default texts the owner did not set',()=>{
  assert.equal(fillTemplate(approvalCard,{destination:'your private chat',origin:null,text:'Hello'}),'📨 Send to your private chat\n\nHello');
  assert.equal(fillTemplate('A {kind}\n\n\n\n{arguments} {unknown}',{kind:'shell',arguments:'{}'}),'A shell\n\n{} {unknown}');
  const lines=approvalLines('sent: Done!\nreject:\nnot a line');
  assert.equal(lines.sent,'Done!');assert.equal(lines.reject,'❌ Reject','an empty line keeps the default');assert.equal(lines.approve,'✅ Approve');
  assert.equal(promptProblem('telegram.approval_card','No message here'),'prompt_placeholder_missing','the exact message is always shown');
});
