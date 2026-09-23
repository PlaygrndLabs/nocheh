import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceContentLabel,sourceContentTypes} from '../src/source-content.js';

test('original content types identify textless voice, mixed media, and structured messages',()=>{
 assert.deepEqual(sourceContentTypes('telegram_update',{message:{voice:{file_id:'voice-1'}}},['voice']),['voice']);
 assert.equal(sourceContentLabel('voice'),'Voice message');
 assert.deepEqual(sourceContentTypes('telegram_update',{message:{text:'Look',photo:[{file_id:'small'},{file_id:'large'}]}},['photo','photo']),['photo']);
 assert.deepEqual(sourceContentTypes('telegram_update',{message:{contact:{first_name:'A',phone_number:'123'}}}),['contact']);
 assert.deepEqual(sourceContentTypes('telegram_update',{message:{location:{latitude:1,longitude:2}}}),['location']);
 assert.deepEqual(sourceContentTypes('browser_input',{attachments:[{kind:'image'}]},['image']),['image']);
 assert.deepEqual(sourceContentTypes('telegram_update',{message_reaction:{new_reaction:[{type:'emoji',emoji:'👍'}]}}),['reaction']);
 assert.deepEqual(sourceContentTypes('telegram_update',null),[]);
 assert.deepEqual(sourceContentTypes('telegram_update',{message:{}},['unsupported']),['file']);
});
