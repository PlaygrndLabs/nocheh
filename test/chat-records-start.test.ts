import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// After a live reload the app can start before the schema step has added a new table (42P01). The pool drops a client
// whose query failed, so between attempts only the retry wait holds the process open. If it does not, Node exits
// mid-start ("unsettled top-level await", exit 13) and the source watcher leaves the app down until a file changes.
test('chat records start stays open and tries again while a table is missing', () => {
  const module=new URL('../src/stores/chat-seed.js',import.meta.url).href;
  const script=`import {startChatRecords} from ${JSON.stringify(module)};
const missing=()=>Promise.reject(Object.assign(Error('relation does not exist'),{code:'42P01'}));
const pool={query:missing,connect:missing};
await startChatRecords({archive:pool,derived:pool,control:pool},{},()=>({owner_id:'',group_ids:[]}),{attempts:3,wait:20});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:20000});
  const failures=child.stderr.split('\n').filter(line=>line.includes('"event":"chat_records_start_failed"'));
  assert.equal(failures.length,3,child.stderr);
  assert.ok(failures.every(line=>JSON.parse(line).code==='42P01'),child.stderr);
  assert.doesNotMatch(child.stderr,/unsettled top-level await/i);
  // Every attempt failed, so the start fails for the service to restart; it never just stops waiting.
  assert.equal(child.status,1,child.stderr);
});
