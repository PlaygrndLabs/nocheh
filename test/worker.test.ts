import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startLoops} from '../src/worker-loops.js';

test('slow inference does not block capture, attachments or approved actions; shutdown waits without overlapping a stage',async()=>{
  let release!:()=>void;
  const slow=new Promise<void>(resolve=>{release=resolve;});
  const counts={capture:0,attachments:0,assistant:0,actions:0};
  let captureActive=0,maxCapture=0;
  const stop=startLoops({
    capture:async()=>{counts.capture++;captureActive++;maxCapture=Math.max(maxCapture,captureActive);await delay(12);captureActive--;},
    attachments:async()=>{counts.attachments++;},
    assistant:async()=>{counts.assistant++;await slow;},
    actions:async()=>{counts.actions++;},
  },2);
  try {
    for(let i=0;i<100 && counts.capture<3;i++)await delay(5);
    assert.ok(counts.capture>=3);assert.ok(counts.attachments>=3);assert.ok(counts.actions>=3);
    assert.equal(counts.assistant,1);assert.equal(maxCapture,1);
    let finished=false;const closing=stop().then(()=>{finished=true;});
    await delay(10);assert.equal(finished,false);
    const before={...counts};release();await closing;await delay(10);
    assert.deepEqual(counts,before);
  } finally {release();await stop();}
});

test('failed stage retries while other stages continue; diagnostics expose only the stage',async()=>{
  let attempts=0,archived=0;const failures:string[]=[];
  const stop=startLoops({capture:async()=>{archived++;},assistant:async()=>{attempts++;throw Error('sensitive content');}},2,stage=>failures.push(stage));
  try {
    for(let i=0;i<100 && attempts<3;i++)await delay(5);
    assert.ok(archived>=3);assert.ok(attempts>=3);
    assert.deepEqual(new Set(failures),new Set(['assistant']));
  } finally {await stop();}
});
