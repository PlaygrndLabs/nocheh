import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { settings } from '../src/config.js';
import { initialize } from '../src/database.js';
import { DEFAULT_TRUSTED, guardPayload, literalSpans, mask, patternSpans, requiresGuard, type GuardPolicy } from '../src/guard.js';

const policy:GuardPolicy={mode:'on',trusted:DEFAULT_TRUSTED,detectorVersion:'synthetic-v1'};
test('masking preserves every unselected character including Unicode, casing, whitespace and repeated/overlapping literals',()=>{
  for(let i=0;i<250;i++) {
    const prefix=`😃 Aws\r\n${'متن '.repeat(i%5)}\t`,suffix=`\u0000  Friday ${i} 😃`;
    const secret=`SYNTHETIC-${i}-密`,text=`${prefix}${secret}${suffix}${secret}`;
    assert.equal(mask(text,literalSpans(text,[secret])).text,`${prefix}***${suffix}***`);
  }
  assert.equal(mask('hey Mak this is Aws pass: 123456',patternSpans('hey Mak this is Aws pass: 123456')).text,'hey Mak this is Aws pass: ***');
  assert.equal(mask('abcdef',literalSpans('abcdef',['abc','cde'])).text,'***f');
  assert.throws(()=>mask('😃',[{start:0,end:1}]),{code:'invalid_secret_span'});
  assert.throws(()=>literalSpans('original',['rewritten']),{code:'detector_contract_rejected'});
});

test('off skips detection; on guards even explicitly trusted routes',async()=>{
  let calls=0;const detect=async()=>{calls++;throw Error('unavailable');};
  const payload={model:'untrusted-name',messages:[{content:'pass: 123456'}]};
  assert.equal((await guardPayload(payload,{...policy,mode:'off'},'https://chatgpt.com/backend-api/codex/responses',detect)).payload,payload);
  assert.equal((await guardPayload(payload,{...policy,mode:'off'},'https://untrusted.example/v1/responses',detect)).payload,payload);
  assert.equal(calls,0);
  assert.equal(requiresGuard(policy,'https://chatgpt.com.evil.example/backend-api/codex/responses'),true);
  assert.equal(requiresGuard(policy,'https://chatgpt.com/backend-api/codex-other/responses'),true);
  assert.equal(requiresGuard(policy,'https://chatgpt.com:444/backend-api/codex/responses'),true);
  assert.equal(requiresGuard({...policy,mode:'on'},'https://chatgpt.com/backend-api/codex/responses'),true);
});

test('the complete payload includes history, tool results, memory and JSON keys; invalid/opaque context fails closed',async()=>{
  const payload={model:'gpt-is-not-a-trust-policy',instructions:'system',input:[
    {role:'user',content:'Aws password: planted-SECRET'},
    {role:'assistant',content:'remember planted-SECRET'},
    {type:'function_call_output',output:'{"history":"planted-SECRET"}'},
  ],metadata:{'planted-SECRET':'scoped-memory planted-SECRET'}};
  const original=JSON.stringify(payload);
  const result=await guardPayload(payload,policy,'https://untrusted.example/v1/responses',async()=>['planted-SECRET']);
  assert.equal(JSON.stringify(payload),original);
  assert.equal(JSON.stringify(result.payload).includes('planted-SECRET'),false);
  assert.ok(JSON.stringify(result.payload).includes('Aws'));
  for (const value of [{input_audio:{data:'raw'}},{previous_response_id:'opaque'},{input:[{type:'input_image',image_url:'data:image/png;base64,raw'}]}]) {
    let calls=0;await assert.rejects(guardPayload(value,policy,'https://untrusted.example',async()=>{calls++;return [];}),{code:'uninspectable_model_context'});assert.equal(calls,0);
  }
  await assert.rejects(guardPayload(payload,policy,'https://untrusted.example',async()=>{throw Error('quota');}));
  await assert.rejects(guardPayload(payload,policy,'https://untrusted.example',async()=>['not present']),{code:'detector_contract_rejected'});
});

test('real PostgreSQL: guarded caches are isolated by input, destination, policy and detector version',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace=`guard_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  try {
    await initialize(pool);let calls=0;
    const detect=async()=>{calls++;return ['planted-SECRET'];};
    const value={input:[{content:'password: planted-SECRET'}]},destination='https://untrusted.example/responses';
    assert.equal((await guardPayload(value,policy,destination,detect,pool)).cache_hit,false);
    assert.equal((await guardPayload(value,policy,destination,detect,pool)).cache_hit,true);assert.equal(calls,1);
    await guardPayload(value,{...policy,detectorVersion:'synthetic-v2'},destination,detect,pool);
    await guardPayload(value,{...policy,mode:'on'},destination,detect,pool);
    await guardPayload({...value,extra:'new'},policy,destination,detect,pool);
    await guardPayload(value,policy,'https://other.example/responses',detect,pool);assert.equal(calls,4);
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});
