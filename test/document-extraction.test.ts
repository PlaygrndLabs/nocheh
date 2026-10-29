import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentExtraction} from '../src/stores/reprocessing.js';

test('documents go to the runtime reader with their name and type, plain text and images stay local', async () => {
  const calls:Record<string,unknown>[]=[];let answer:Record<string,unknown>={state:'done',text:'Synthetic slide text'};
  const engine=documentExtraction(async(operation,input)=>{assert.equal(operation,'file.extract');calls.push(input);return answer;});
  assert.equal(await engine.run(Buffer.from('Plain synthetic note متن'),{kind:'document',metadata:{file_name:'note.txt'}},{}),'Plain synthetic note متن');
  assert.deepEqual(await engine.run(Buffer.from([1,2,3]),{kind:'photo',metadata:{}},{}),
    {kind:'extraction_status',text:'Text extraction is unavailable for this original file.'});
  assert.equal(calls.length,0);
  const slides=Buffer.concat([Buffer.from('PK'),Buffer.alloc(8)]);
  assert.equal(await engine.run(slides,{kind:'document',metadata:{relative_path:'files/plan.pptx',mime_type:'application/vnd.ms-powerpoint'}},{}),'Synthetic slide text');
  assert.deepEqual(calls[0],{bytes_base64:slides.toString('base64'),name:'files/plan.pptx',mime_type:'application/vnd.ms-powerpoint'});
  answer={state:'scanned'};
  assert.deepEqual(await engine.run(Buffer.from('%PDF-1.4 synthetic'),{kind:'document',metadata:{file_name:'scan.pdf'}},{}),
    {kind:'extraction_status',text:'This document is scanned pages without a text layer; its original file is kept.'},'a text-looking PDF still goes to the reader');
  answer={state:'something_new'};
  assert.equal(((await engine.run(slides,{kind:'document',metadata:{}},{})) as {text:string}).text,'This document could not be read; its original file is kept.');
  await assert.rejects(engine.run(slides,{kind:'document',metadata:{}},{pages:2}),{code:'unsupported_extraction_configuration'});
});
