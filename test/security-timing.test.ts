import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeTimings,timedBody,type ModelTimings} from '../src/security/timing.js';

test('provider measurements admit only bounded numeric fields, with missing data distinct from zero',()=>{
  assert.equal(safeTimings(null),null);assert.equal(safeTimings({prompt:'private'}),null);
  assert.deepEqual(safeTimings({provider_headers_ms:0,provider_read_ms:-1,downstream_ms:NaN,provider_chunks:true,
    broker_prepare_ms:86400001,url:'private',token:'private'}),{provider_headers_ms:0});
});

test('upstream byte waits exclude consumer work and close the source on interruption',async t=>{
  let clock=0,reads=0,closed=0;
  t.mock.method(performance,'now',()=>clock);
  const body={
    [Symbol.asyncIterator](){return {
      async next(){clock+=5;return ++reads<=2?{done:false,value:new Uint8Array([1])}:{done:true,value:undefined};},
      async return(){closed++;return {done:true,value:undefined};},
    };},
  } as unknown as ReadableStream<Uint8Array>;
  const observed:ModelTimings={};
  for await(const _ of timedBody(body,observed))clock+=80;
  assert.deepEqual(observed,{provider_read_ms:15,provider_chunks:2});assert.equal(closed,0);
  reads=0;
  for await(const _ of timedBody(body,{}))break;
  assert.equal(closed,1);
});

test('failed upstream reads retain elapsed wait and cancellation without invented completion',async t=>{
  let clock=0,closed=false;
  t.mock.method(performance,'now',()=>clock);
  const body={
    [Symbol.asyncIterator](){return {
      async next(){clock=37;throw new Error('synthetic disconnect');},
      async return(){closed=true;return {done:true,value:undefined};},
    };},
  } as unknown as ReadableStream<Uint8Array>;
  const observed:ModelTimings={};
  await assert.rejects(async()=>{for await(const _ of timedBody(body,observed)){}},/synthetic disconnect/);
  assert.deepEqual(observed,{provider_read_ms:37,provider_chunks:0});assert.equal(closed,true);
});
