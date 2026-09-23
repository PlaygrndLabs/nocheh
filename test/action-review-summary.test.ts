import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {actionReviews,summarizeActionReviews} from '../src/action-review-summary.js';
import {telegramAction} from '../src/actions.js';

test('a proposed action remains visible ahead of an older completed action from the same message',()=>{
 const summary=summarizeActionReviews([
  {id:'sent',event_id:'message',state:'done'},
  {id:'waiting',event_id:'message',state:'proposed'},
  {id:'separate',event_id:'other',state:'approved'},
 ]);
 assert.deepEqual(summary.get('message'),{id:'waiting',state:'proposed',count:2});
 assert.deepEqual(summary.get('other'),{id:'separate',state:'approved',count:1});
});

test('action review lookup uses only requested source IDs in either storage layout',async()=>{
 const observed:{sql:string;ids:string[]}[]=[];
 const pool={query:async(sql:string,params:string[][])=>{
  observed.push({sql,ids:params[0]!});
  return {rows:[{id:'pending',event_id:'source-a',state:'proposed'}]};
 }} as unknown as pg.Pool;
 assert.equal((await actionReviews(pool,[],'separated')).size,0);
 assert.equal(observed.length,0);
 for(const layout of ['legacy','separated'] as const){
  assert.deepEqual((await actionReviews(pool,['source-a'],layout)).get('source-a'),{id:'pending',state:'proposed',count:1});
 }
 assert.deepEqual(observed.map(item=>item.ids),[['source-a'],['source-a']]);
 assert.match(observed[0]!.sql,/FROM action_requests WHERE event_id=ANY/);
 assert.match(observed[1]!.sql,/FROM telegram_action_requests WHERE source_reference->>'id'=ANY/);
});

test('legacy direct review loads a Telegram action beyond the limited queue and rejects an unknown ID',async()=>{
 const id='a'.repeat(64),owner={admin:true,scope:null};
 const pool={query:async(_sql:string,params:string[])=>({rows:params[0]===id?[{id,event_id:'source',scope:'123456',destination:'123456',original_text:Buffer.from('Exact text'),state:'proposed',created_at:new Date()}]:[]})} as unknown as pg.Pool;
 const action=await telegramAction(pool,owner,id);
 assert.deepEqual(action.arguments,{destination:'123456',text:'Exact text'});
 assert.equal(action.state,'proposed');
 await assert.rejects(telegramAction(pool,owner,'b'.repeat(64)),{code:'action_not_found'});
});
