import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../scripts/native-browser-delivery.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const load=async id=>import('data:text/javascript;base64,'+Buffer.from(code+'\n// '+id).toString('base64'));

test('native browser acknowledges exact completed text and retains opaque receipts through outage and reconnect',async()=>{
  const stored=new Map();globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
  const client=await load('first'),text=' exact\r\n🙂 ',delivery={receipt:'a'.repeat(64),sha256:createHash('sha256').update(text).digest('hex')};
  let calls=0;const offline=async()=>{calls++;throw Error('offline');};
  await client.receiveBrowserDelivery({status:'complete',text:'forged',nocheh_delivery:delivery},offline);
  await client.receiveBrowserDelivery({status:'error',text,nocheh_delivery:delivery},offline);
  await client.receiveBrowserDelivery({status:'complete',text},offline);assert.equal(calls,0);
  await client.receiveBrowserDelivery({status:'complete',text,nocheh_delivery:delivery},offline);assert.equal(calls,1);
  const pending=JSON.parse(stored.values().next().value);assert.deepEqual(pending,[delivery]);assert.ok(!JSON.stringify(pending).includes(text));
  const restarted=await load('restarted'),received=[];
  await restarted.flushBrowserDeliveries(async body=>{received.push(body);return {state:'spooled'};});
  assert.deepEqual(received,[delivery]);assert.deepEqual(JSON.parse(stored.values().next().value),[]);
  await restarted.flushBrowserDeliveries(async()=>assert.fail('already acknowledged'));
  delete globalThis.localStorage;
});
