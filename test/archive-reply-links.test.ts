import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {canonical,digest,envelope} from '../src/archive.js';
import {captureEvidence} from '../src/stores/generated-capture.js';
import {archiveReplyPreviews,legacyArchiveReplyPreviews} from '../src/stores/archive-reply-links.js';

test('archive shows only confirmed replies belonging to the incoming turn and scope',async()=>{
  const input='a'.repeat(64),reply='b'.repeat(64),otherScope='c'.repeat(64),unrelated='d'.repeat(64);
  const archive={query:async(sql:string)=>({rows:sql.startsWith('SELECT id,source_key')?
    [{id:input,source_key:'telegram:123:update:42',bot_id:'123'}]:[
      {id:reply,scope:'42',kind:'telegram_delivered_message',original_text:Buffer.from('Confirmed answer'),received_at:new Date('2026-09-23T10:00:00Z')},
      {id:otherScope,scope:'99',kind:'telegram_delivered_message',original_text:Buffer.from('Wrong conversation'),received_at:new Date('2026-09-23T10:01:00Z')},
      {id:unrelated,scope:'42',kind:'telegram_update',original_text:Buffer.from('Not a delivery'),received_at:new Date('2026-09-23T10:02:00Z')},
    ]})} as unknown as pg.Pool;
  const control={query:async()=>({rows:[
    {operation_key:'outbound:123:telegram:123:update:42:sendMessage:hash',sources:[{id:reply},{id:otherScope},{id:unrelated}]},
    {operation_key:'outbound:123:telegram:123:update:420:sendMessage:hash',sources:[{id:unrelated}]},
  ]})} as unknown as pg.Pool;
  const previews=await archiveReplyPreviews(archive,control,[{id:input,kind:'telegram_update',scope:'42'}]);
  assert.deepEqual(previews.get(input),[{id:reply,text:'Confirmed answer',received_at:'2026-09-23T10:00:00.000Z',content_types:[]}]);
  assert.equal(previews.size,1);
});

test('archive leaves a reply unlinked when no delivery receipt is recorded',async()=>{
  const archive={query:async()=>({rows:[{id:'a'.repeat(64),source_key:'telegram:123:update:42',bot_id:'123'}]})} as unknown as pg.Pool;
  const control={query:async()=>({rows:[]})} as unknown as pg.Pool;
  assert.equal((await archiveReplyPreviews(archive,control,[{id:'a'.repeat(64),kind:'telegram_update',scope:'42'}])).size,0);
});

test('legacy archive links only observed messages reconstructed from a confirmed receipt',async()=>{
  const input='a'.repeat(64),message={message_id:7,date:1700000000,chat:{id:42},text:'Confirmed answer'};
  const receipt=envelope({version:1,key:'outbound:123:telegram:123:update:42:sendMessage:hash:result',origin:'generated',
    bot_id:'123',kind:'outbound_result',scope:'42',source_id:'outbound-source',revision:'0',occurred_at:null,text:null,
    payload:{method:'sendMessage',state:'delivered',status:200,wire_base64:Buffer.from(canonical({ok:true,result:message})).toString('base64')}});
  const reply=digest(captureEvidence(receipt).originals[0]!.key);
  const pool={query:async(sql:string)=>({rows:sql.startsWith('SELECT id,source_key')?
    [{id:input,source_key:'telegram:123:update:42',bot_id:'123'}]:sql.includes("origin='generated'")?
      [{source_key:receipt.key,channel:'telegram',bot_id:receipt.bot_id,scope:receipt.scope,source_id:receipt.source_id,
        revision:receipt.revision,occurred_at:null,original_text:null,payload:Buffer.from(canonical(receipt.payload))}]:
      [{id:reply,scope:'42',kind:'telegram_delivered_message',original_text:Buffer.from('Confirmed answer'),received_at:new Date('2026-09-23T10:00:00Z')}]})} as unknown as pg.Pool;
  assert.deepEqual((await legacyArchiveReplyPreviews(pool,[{id:input,kind:'telegram_update',scope:'42'}])).get(input),
    [{id:reply,text:'Confirmed answer',received_at:'2026-09-23T10:00:00.000Z',content_types:[]}]);
});
