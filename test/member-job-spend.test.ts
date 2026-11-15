import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cents,memberCostLimit,memberDecided,memberPause,memberResume} from '../src/stores/member-job-spend.js';
import {backgroundMemberPaused,backgroundMemberSpend,backgroundMemberTexts,backgroundTexts,fillTemplate,labeledLines,promptKeys,promptProblem} from '../src/prompts.js';

test('a member\'s job cap is the owner\'s limit or half again over its estimate, in whole cents',()=>{
  // A $0.50 limit gives a small job $0.50, where whole dollars gave every member job $1.
  assert.equal(memberCostLimit(0.5,0.05),0.5);
  assert.equal(memberCostLimit(0.5,0.35),0.53,'52.5 cents round up to 53');
  // A job near the limit keeps its room to finish: at most $7.50 for a job a member may approve under a $5 limit.
  assert.equal(memberCostLimit(5,5),7.5);assert.equal(memberCostLimit(5,4.99),7.49);assert.equal(memberCostLimit(5,0.35),5);
  // Counted in cents, with no float drift: 0.1 x 1.5 is 0.15000000000000002 in floating point, which a plain ceil would make 16 cents.
  assert.equal(memberCostLimit(0.01,0.1),0.15);assert.equal(memberCostLimit(0.01,0.07),0.11);
  assert.equal(memberCostLimit(5,null),5,'a job without a price keeps the limit');
  assert.equal(memberCostLimit(0.333,0),0.34,'a limit with a part of a cent rounds up, never down');
});

test('a cap reads to the cent, never as less than it is',()=>{
  assert.deepEqual([5,0.5,0.53,7.5,12.4,1000,0.333,0.08].map(cents),['$5.00','$0.50','$0.53','$7.50','$12.40','$1000.00','$0.34','$0.08']);
});

test('only a job a member asked for and approved themselves counts toward their spend and waits in a pause',()=>{
  assert.equal(memberDecided({requester:'9',decided_by:'9'},'123'),true);
  assert.equal(memberDecided({requester:'9',decided_by:'8'},'123'),true,'another member\'s press is still a member\'s');
  assert.equal(memberDecided({requester:'9',decided_by:'123'},'123'),false,'the owner approved it');
  assert.equal(memberDecided({requester:null,decided_by:'123'},'123'),false,'the owner\'s own job');
  assert.equal(memberDecided({requester:'9',decided_by:null},'123'),false,'not decided yet');
  assert.deepEqual([memberPause,memberResume],['njp','nju']);
});

test('the member spend notices, their buttons and the paused card line are the owner\'s texts',()=>{
  for(const key of ['background.member_spend','background.member_paused','background.member_texts'])
    assert.ok((promptKeys as readonly string[]).includes(key),key);
  assert.equal(promptProblem('background.member_spend','Members spent {spent}.'),null,'nothing must stay in it');
  const lines=labeledLines(backgroundMemberTexts,'pause: Hold them');
  assert.deepEqual([lines.pause,lines.resume],['Hold them','▶\ufe0f Resume member jobs'],'a line the owner left out keeps its default');
  assert.ok(lines.pause!.length<=40&&lines.resume!.length<=40);
  assert.ok([lines.paused,lines.resumed,lines.only_owner].every(line=>Array.from(line!).length<=200),'each answer fits a button press answer');
  const members=[fillTemplate(lines.member!,{name:'Sam',group:'“Made-up group”',spent:'$12.10'}),fillTemplate(lines.more!,{count:'3',spent:'$8.00'})].join('\n');
  assert.equal(fillTemplate(backgroundMemberSpend,{spent:'$20.10',mark:'$20.00',pause_mark:'$100.00',members}),
    '💸 Jobs that members approved themselves spent $20.10 today (UTC), past your notice mark of $20.00.\n• Sam in “Made-up group”: $12.10\n• 3 more: $8.00\n\n'+
    'Pause holds approved member jobs that have not started until you resume them. Members can still ask and approve, running jobs finish, and your own jobs never wait. '+
    'At $100.00 today, member jobs pause by themselves until 00:00 UTC.');
  assert.ok(fillTemplate(backgroundMemberPaused,{spent:'$100.40',mark:'$100.00',members}).startsWith(
    '⏸ Member jobs are paused until 00:00 UTC: jobs that members approved themselves spent $100.40 today, past your high mark of $100.00.\n• Sam'));
  assert.equal(labeledLines(backgroundTexts,undefined).paused,'⏸ Approved. Member jobs are paused for now; it starts when they resume.');
  assert.equal(labeledLines(backgroundTexts,'running: Runs.').paused,labeledLines(backgroundTexts,undefined).paused,'an older saved text keeps the new line\'s default');
});
