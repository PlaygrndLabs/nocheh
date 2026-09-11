import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hermesAdapter} from '../src/hermes-adapter.js';
import {runtimeCall, runtimeOperations, type RuntimeAdapter} from '../src/runtime.js';
import {runInput} from '../src/run-source.js';

function contract(name: string, adapter: RuntimeAdapter, observed: Array<{operation:string;body:Record<string,unknown>}>) {
  test(name+' preserves scope, receipt identity and immutable input through the runtime boundary', async()=>{
    const call=runtimeCall(adapter);
    const source={channel:'telegram',event_id:'a'.repeat(64),scope:'-20',source_key:'fixture:1',attempt:1,text:'original 😃\r\n  '};
    await call('run.start',source); await call('run.start',source);
    assert.deepEqual(observed[0]?.body,observed[1]?.body);
    assert.equal(observed[0]?.body.scope,'-20');
    assert.equal(observed[0]?.body.text,source.text);
    await call('config.write',{scope:'-20',revision:'old',changes:{'agent.max_iterations':9}});
    assert.equal(observed.at(-1)?.body.revision,'old');
    const count=observed.length;
    const unavailable=runtimeOperations.find(operation=>!adapter.capabilities[operation]);assert.ok(unavailable);
    await assert.rejects(call(unavailable,{id:'unknown'}),{code:'runtime_capability_unavailable'});
    assert.equal(observed.length,count,'unavailable operations never reach the harness');
  });
}
const nativeCalls:Array<{operation:string;body:Record<string,unknown>}>=[];
contract('Hermes',hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async(url,init)=>{
  nativeCalls.push({operation:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});
  assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fixture');
  return Response.json({state:'done'});
}}),nativeCalls);
const fakeCalls:Array<{operation:string;body:Record<string,unknown>}>=[];
contract('Replacement harness',{
  id:'fixture',capabilities:Object.fromEntries(runtimeOperations.map(op=>[op,op!=='run.cancel'])) as RuntimeAdapter['capabilities'],
  async call(operation,body){fakeCalls.push({operation,body});return {state:'done'};},
},fakeCalls);

test('adapter preserves public error codes without exposing a provider response',async()=>{
  for(const [status,payload,code] of [[429,{secret:'private'},'quota_paused'],[503,{error:'detector_contract_rejected'},'detector_contract_rejected'],[502,{secret:'private'},'runtime_unavailable']] as const){
    const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async()=>Response.json(payload,{status})}));
    await assert.rejects(call('guard.detect',{text:'fixture'}),{code});
  }
  const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async()=>{throw Error('must not run');}}));
  await assert.rejects(call('run.start',{channel:'browser'}),{code:'runtime_channel_unavailable'});
});

test('asynchronous Telegram runtime operations retain one source and attempt identity',async()=>{
  const seen:Array<{path:string;body:unknown}>=[];
  const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async(url,init)=>{
    seen.push({path:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});return Response.json({state:'running'});
  }}));
  const source={channel:'telegram',event_id:'a'.repeat(64),attempt:7,asynchronous:true};
  for(const operation of ['run.start','run.resume','run.events','run.cancel'] as const)await call(operation,source);
  assert.deepEqual(seen.map(row=>row.path),['/internal/run/start','/internal/run/resume','/internal/run/events','/internal/run/cancel']);
  assert.ok(seen.every(row=>JSON.stringify(row.body)===JSON.stringify(source)));
});

test('browser and scheduled originals have their own identities and preserve text exactly',()=>{
  const input={scope:'owner',conversation:'new',id:'1',text:'literal\0\r\n  😃',payload:{}};
  const browser=runInput({...input,channel:'browser'}),schedule=runInput({...input,channel:'scheduler'});
  assert.notEqual(browser.key,schedule.key);assert.equal(browser.text,input.text);
  assert.equal(browser.kind,'browser_input');assert.equal(schedule.kind,'scheduled_trigger');
  assert.equal(browser.bot_id,'');assert.equal(browser.channel,'browser');
  assert.notEqual(runInput({...input,channel:'browser',scope:'group'}).key,browser.key);
});
