import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentExtraction} from '../src/stores/reprocessing.js';

test('documents go to the runtime reader with their name and type, and plain text stays local', async () => {
  const calls:Record<string,unknown>[]=[];let answer:Record<string,unknown>={state:'done',text:'Synthetic slide text'};
  const engine=documentExtraction(async(operation,input)=>{assert.equal(operation,'file.extract');calls.push(input);return answer;});
  assert.equal(await engine.run(Buffer.from('Plain synthetic note متن'),{kind:'document',metadata:{file_name:'note.txt'}},{}),'Plain synthetic note متن');
  assert.deepEqual(await engine.run(Buffer.from([1,2,3]),{kind:'sticker',metadata:{mime_type:'image/webp'}},{}),
    {kind:'extraction_status',text:'Text extraction is unavailable for this original file.'},'stickers and moving pictures keep their original only');
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

test('photos and image files go to the runtime image reader; a busy provider is retried', async () => {
  const calls:Record<string,unknown>[]=[];let answer:Record<string,unknown>={state:'done',text:'GARDEN CLUB\nA made-up sign.'};
  const engine=documentExtraction(async(operation,input)=>{assert.equal(operation,'image.read');calls.push(input);return answer;});
  const image=Buffer.from([0xff,0xd8,0xff,0]);
  assert.equal(await engine.run(image,{kind:'photo',metadata:{}},{}),'GARDEN CLUB\nA made-up sign.');
  assert.equal(await engine.run(image,{kind:'file',metadata:{relative_path:'files/scan.png',mime_type:'image/png'}},{}),'GARDEN CLUB\nA made-up sign.');
  assert.deepEqual(calls[1],{bytes_base64:image.toString('base64'),name:'files/scan.png',mime_type:'image/png'});
  for(const reason of ['provider_error','rate_limited','timed_out']) {
    answer={state:'failed',reason};
    await assert.rejects(engine.run(image,{kind:'photo',metadata:{}},{}),{code:'image_reading_unavailable'},reason);
  }
  const status=async(value:Record<string,unknown>)=>{answer=value;return ((await engine.run(image,{kind:'photo',metadata:{}},{})) as {text:string}).text;};
  assert.equal(await status({state:'failed',reason:'refused'}),'This image could not be read; its original file is kept.');
  assert.equal(await status({state:'unreadable'}),'This image could not be read; its original file is kept.');
  assert.match(await status({state:'not_configured'}),/Settings › Models/);
});
