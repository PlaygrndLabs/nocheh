import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ConnectionState} from 'inngest/connect';
import {superviseConnection} from '../src/workflows/supervisor.js';

test('connection startup failures recover without blocking application work or duplicating reconnects',async()=>{
  let calls=0,reports=0,finish!:()=>void;
  const connection={state:ConnectionState.RECONNECTING,closed:new Promise<void>(r=>{finish=r;}),close:async()=>{finish();}};
  const service=superviseConnection(async()=>{if(++calls===1)throw Error('private failure');return connection;},async()=>{reports++;},5);
  assert.equal(service.state(),'reconnecting');
  await delay(30);assert.equal(calls,2);assert.equal(reports,0);
  connection.state=ConnectionState.ACTIVE;
  await delay(15);assert.equal(service.state(),'connected');assert.ok(reports>0);assert.equal(calls,2);
  await service.close();const previous=reports;await delay(15);assert.equal(reports,previous);assert.equal(service.state(),'stopped');
});

test('shutdown during unavailable initial connection closes a late connection without reporting readiness',async()=>{
  let resolve!: (value:any)=>void,closed=0,reports=0;
  const service=superviseConnection(()=>new Promise(r=>{resolve=r;}),async()=>{reports++;},5);
  await service.close();
  resolve({state:ConnectionState.ACTIVE,closed:new Promise(()=>{}),close:async()=>{closed++;}});
  await delay(10);assert.equal(closed,1);assert.equal(reports,0);
});
