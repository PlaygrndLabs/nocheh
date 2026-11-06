import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvalCard,approvalLines,backgroundCard,backgroundTexts,fillTemplate,labeledLines,learningInstruction,learningPrompt,promptKeys,promptProblem,withPrompts} from '../src/prompts.js';

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
  assert.match(approvalLines('').failed_action,/\{reason\}/);assert.match(approvalLines('').not_run,/\{reason\}/);
  assert.equal(approvalLines('reason_sign_in: Sign in to Notion again.').reason_sign_in,'Sign in to Notion again.','the owner words why a tool did not finish');
  assert.equal(promptProblem('telegram.approval_card','No message here'),'prompt_placeholder_missing','the exact message is always shown');
});

test('the GitHub copy has its own instruction text, card line and card answers, and the card keeps its other lines',()=>{
  assert.ok((promptKeys as readonly string[]).includes('background.repo'));
  assert.equal(promptProblem('background.repo','Any text'),null,'nothing must stay in it');
  assert.ok(backgroundCard.endsWith('\n🧰 {box}\n📦 {repo}\n\n{instruction}'));
  const lines=labeledLines(backgroundTexts,undefined);
  assert.equal(lines.box_repo,'It can run commands and Python in a sealed box: no internet, no keys, only the checked messages of the chat it reads and the GitHub copy below.');
  assert.equal(lines.repo_removed,'🚫 Withdrawn: its GitHub copy was removed. Nothing runs.');
  assert.equal(fillTemplate(lines.repo!,{repo_name:'example-org/widgets',repo_branch:'main',repo_commit:'3f2a91c',repo_copied:'2026-11-04 10:12 UTC',repo_size:'18 MB, 1,204 files'}),
    'It reads a copy of example-org/widgets, main at 3f2a91c, copied 2026-11-04 10:12 UTC (18 MB, 1,204 files). What it reads is secret-checked before the model sees it, and reading code adds to its cost. Your GitHub key stays outside the box.');
  assert.equal(fillTemplate(backgroundCard,{title:'T',size:'1 message',minutes:'2',cost:'about $0.10',cost_limit:'$5.0',minutes_limit:'45',unpriced:null,checked:null,notion:null,box:null,repo:null,instruction:'I'}),
    '🗂 Background job: T\n📏 1 message\n⏱ About 2 min, about $0.10\n🛑 Stops at $5.0 or 45 min, not counting the secret check\n\nI','a job without a copy shows no 📦 line');
});
