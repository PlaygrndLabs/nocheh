import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hermesAdapter} from '../src/hermes-adapter.js';
import {telegramAdapter} from '../src/frontdoor/telegram.js';
import {combinedAdapter, runtimeCall, runtimeOperations, type RuntimeAdapter} from '../src/runtime.js';
import {runInput} from '../src/run-source.js';

function contract(name: string, adapter: RuntimeAdapter, observed: Array<{operation:string;body:Record<string,unknown>}>) {
  test(name+' passes helper service input through unchanged and refuses what it does not offer', async()=>{
    const call=runtimeCall(adapter);
    const input={text:'original 😃\r\n  ',priority:'background'};
    await call('guard.detect',input); await call('guard.detect',input);
    assert.deepEqual(observed[0]?.body,observed[1]?.body);
    assert.equal(observed[0]?.body.text,input.text);
    const count=observed.length;
    const unavailable=runtimeOperations.find(operation=>!adapter.capabilities[operation]);assert.ok(unavailable);
    await assert.rejects(call(unavailable,{id:'unknown'}),{code:'runtime_capability_unavailable'});
    assert.equal(observed.length,count,'unavailable operations never reach the service');
  });
}
const nativeCalls:Array<{operation:string;body:Record<string,unknown>}>=[];
const hermes=hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async(url,init)=>{
  nativeCalls.push({operation:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});
  assert.equal((init?.headers as Record<string,string>).authorization,'Bearer fixture');
  return Response.json({literals:[]});
}});
contract('Hermes services',{...hermes,capabilities:{...hermes.capabilities,'usage.price':false}},nativeCalls);
const fakeCalls:Array<{operation:string;body:Record<string,unknown>}>=[];
contract('Replacement services',{
  id:'fixture',capabilities:Object.fromEntries(runtimeOperations.map(op=>[op,op!=='image.read'])) as RuntimeAdapter['capabilities'],
  async call(operation,body){fakeCalls.push({operation,body});return {literals:[]};},
},fakeCalls);

test('the Hermes services answer only helper operations, at their own routes',async()=>{
  const bot=telegramAdapter({url:'http://bot.invalid',token:'fixture'});
  assert.ok(runtimeOperations.every(operation=>combinedAdapter(bot,hermes).capabilities[operation]),'every helper service has a route');
  assert.ok(runtimeOperations.every(operation=>!(hermes.capabilities[operation]&&bot.capabilities[operation])),'no operation has two services');
  assert.ok(runtimeOperations.filter(operation=>operation.startsWith('telegram.')).every(operation=>!hermes.capabilities[operation]),'Hermes answers no Telegram call');
  const seen:string[]=[];
  const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async(url,init)=>{
    const body=JSON.parse(String(init?.body));assert.ok(!('channel' in body));seen.push(new URL(String(url)).pathname);return Response.json({});
  }}));
  await call('memory.filter',{channel:'telegram',text:'x'});await call('voice.transcribe',{check:true});
  assert.deepEqual(seen,['/internal/memory/filter','/internal/transcribe']);
});

test('adapter preserves public error codes without exposing a provider response',async()=>{
  for(const [status,payload,code] of [[429,{secret:'private'},'quota_paused'],[503,{error:'detector_contract_rejected'},'detector_contract_rejected'],[502,{secret:'private'},'runtime_unavailable']] as const){
    const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async()=>Response.json(payload,{status})}));
    await assert.rejects(call('guard.detect',{text:'fixture'}),{code});
  }
  const call=runtimeCall(hermesAdapter({url:'http://fixture.invalid',token:'fixture',fetch:async()=>Response.json({error:'attachment_too_large'},{status:413})}));
  await assert.rejects(call('file.extract',{}),{code:'runtime_unavailable'});
});

test('browser and scheduled originals have their own identities and preserve text exactly',()=>{
  const input={scope:'owner',conversation:'new',id:'1',text:'literal\0\r\n  😃',payload:{}};
  const browser=runInput({...input,channel:'browser'}),schedule=runInput({...input,channel:'scheduler'});
  assert.notEqual(browser.key,schedule.key);assert.equal(browser.text,input.text);
  assert.equal(browser.kind,'browser_input');assert.equal(schedule.kind,'scheduled_trigger');
  assert.equal(browser.bot_id,'');assert.equal(browser.channel,'browser');
  assert.notEqual(runInput({...input,channel:'browser',scope:'group'}).key,browser.key);
});
