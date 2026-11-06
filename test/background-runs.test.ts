import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HttpError} from '../src/http.js';
import {backgroundLimit,backgroundRepo,backgroundRestart,backgroundTexts,fillTemplate,labeledLines,promptKeys,promptPlaceholders,promptProblem} from '../src/prompts.js';
import {jobDeadlines,maxTokens,runCost,runProgress,runTokens,todoList} from '../src/stores/background-jobs.js';

const examples=JSON.parse(readFileSync(new URL('../../test/run-cost-examples.json',import.meta.url),'utf8')) as {name:string;rates:any;tokens:any;unknown_calls:number;cost:number}[];
const counts=(input_tokens:number,calls=1)=>({input_tokens,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls});
const refused=(run:()=>unknown)=>assert.throws(run,(error:unknown)=>error instanceof HttpError&&error.status===400&&error.code==='invalid_run_progress');

test('a run is priced exactly as its Python twin prices it',()=>{
  assert.equal(examples.length,9);
  for(const example of examples)assert.equal(runCost(example.rates,example.tokens,example.unknown_calls),example.cost,example.name);
});

test('run counts are plain whole numbers in exactly five buckets, and the larger of two is kept bucket by bucket',()=>{
  assert.deepEqual(runTokens(counts(5)),counts(5));
  for(const value of [null,undefined,[],{...counts(5),extra:1},counts(-1),counts(1e12),counts(1.5),{input_tokens:1},{...counts(1),calls:'1'}])
    assert.equal(runTokens(value),null,JSON.stringify(value));
  assert.deepEqual(maxTokens({...counts(5,3),output_tokens:9},counts(7,1)),{...counts(7,3),output_tokens:9});
  assert.deepEqual(maxTokens(null,counts(2)),counts(2));assert.equal(maxTokens(null,null),null);
});

test('a heartbeat\'s progress is checked strictly, and a to-do list is cut by code points',()=>{
  assert.deepEqual(runProgress({tokens:counts(5),unknown_calls:2}),{tokens:counts(5),unknown_calls:2});
  refused(()=>runProgress({unknown_calls:0}));refused(()=>runProgress({tokens:counts(5),unknown_calls:1e6+1}));
  refused(()=>runProgress({tokens:counts(5),unknown_calls:0,extra:true}));refused(()=>runProgress({tokens:counts(5),unknown_calls:-1}));
  refused(()=>runProgress({tokens:counts(5),unknown_calls:0,todo:'none'}));refused(()=>runProgress([]));
  refused(()=>todoList([1]));refused(()=>todoList([{content:5,status:'pending'}]));
  const long='a'.repeat(199)+'😀'+'b',items=todoList([{content:long,status:'in_progress_and_more_words'},...Array(60).fill({content:'Later',status:'pending'})]);
  assert.equal(items.length,50);assert.deepEqual(items[0],{content:'a'.repeat(199)+'😀',status:'in_progress_and_more'},'an emoji at the edge is kept whole');
  assert.deepEqual(todoList([{}]),[{content:'',status:''}]);
  // jsonb refuses NUL and a lone surrogate, which a model can write as JSON escapes: each becomes U+FFFD, a valid pair stays.
  assert.deepEqual(todoList([{content:'a\u0000b\ud800 😀',status:'\udc00done'}]),[{content:'a\ufffdb\ufffd 😀',status:'\ufffddone'}]);
  assert.deepEqual(runProgress({tokens:counts(5),unknown_calls:0,todo:[{content:'Read the chat',status:'completed'}]}).todo,[{content:'Read the chat',status:'completed'}]);
});

test('a job\'s deadlines follow its start and time limit',()=>{
  const started=Date.UTC(2026,10,4,12),deadlines=jobDeadlines({started_at:new Date(started),minutes_limit:45});
  assert.equal(started/1000,1793793600);
  assert.deepEqual(Object.fromEntries(Object.entries(deadlines).map(([name,ms])=>[name,ms/1000])),{soft:1793796300,hard:1793796480,credential:1793796600,box:1793796780});
  assert.equal(jobDeadlines({started_at:new Date(started).toISOString(),minutes_limit:50}).soft,started+50*60000);
});

test('the limit note says what the to-do list has done and left, and the restart note drops a list that may not be shown',()=>{
  assert.equal(fillTemplate(backgroundLimit,{title:'Made-up job',limit:'cost',done:'nothing yet',left:'Search the marks; Write the report',none:null}),
    '⏱ Made-up job: the job stopped at its cost limit before it wrote a report.\n✅ Done: nothing yet\n⏳ Left: Search the marks; Write the report');
  assert.equal(fillTemplate(backgroundLimit,{title:'Made-up job',limit:'time',done:null,left:null,none:'No to-do list was kept.'}),
    '⏱ Made-up job: the job stopped at its time limit before it wrote a report.\nNo to-do list was kept.');
  assert.equal(fillTemplate(backgroundRestart,{todo:null}),'This job restarted and its earlier work could not be kept.');
  assert.equal(fillTemplate(backgroundRestart,{todo:'Read the chat (completed)'}),'This job restarted and its earlier work could not be kept.\nYour last to-do list was: Read the chat (completed)');
  for(const key of ['background.resume','background.restart','background.limit','background.repo'])assert.ok((promptKeys as readonly string[]).includes(key),key);
  for(const key of ['background.continue','background.wrap_up'])assert.ok(!(promptKeys as readonly string[]).includes(key),key);
});

test('a run that reads a GitHub copy is told where it is, that it may still arrive, and to clone it beside /work, never into it',()=>{
  assert.equal(promptPlaceholders['background.repo'],undefined,'no value is required');assert.equal(promptProblem('background.repo','Read /repo/code.'),null);
  const text=fillTemplate(backgroundRepo,{repo:'example-org/widgets',branch:'main',commit:'3f2a91c'+'0'.repeat(33),copied:'2026-11-04 10:12 UTC'});
  assert.match(text,/^\[GitHub copy\]\n\/repo\/code is a read-only copy of the GitHub repository example-org\/widgets, branch main at commit 3f2a91c0{33}, copied 2026-11-04 10:12 UTC,/);
  assert.match(text,/git clone -q --shared \/repo\/code \/work\/code/);assert.match(text,/never copy the repository into \/work itself/);
  assert.match(text,/if it says failed, or is still not there after a few minutes, the copy will not arrive in this run/);
  assert.doesNotMatch(text,/next step|\{/);
  const lines=labeledLines(backgroundTexts,undefined);
  for(const name of ['box_repo','repo','repo_removed'])assert.ok(lines[name],name);
  assert.match(lines.repo!,/\{repo_name\}, \{repo_branch\} at \{repo_commit\}, copied \{repo_copied\} \(\{repo_size\}\)/);
});
