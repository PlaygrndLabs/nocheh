import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide,defaultPolicy,validatePolicy,fingerprint,manifest,type Effect} from '../src/security/contract.js';
import {providerPayload} from '../src/security/provider-request.js';
const effect:Effect={id:'proposal',kind:'shell',scope:'owner',profile:'native-owner',fingerprint:'a'.repeat(64)};
test('security contract preserves routine autonomy and requires effect authority',()=>{
  assert.equal(manifest.enforcement,'external');
  for(const kind of ['archive.read','memory.read','memory.write','model.request'] as const)assert.equal(decide(defaultPolicy,1,{...effect,kind}).outcome,'allow');
  for(const kind of ['shell','browser','mcp','telegram.send'] as const)assert.equal(decide(defaultPolicy,1,{...effect,kind}).outcome,'ask');
  assert.equal(decide(defaultPolicy,1,effect,{grant:'owner-approved-workflow'}).outcome,'allow');
});
test('mandatory limits and explicit denies beat grants regardless of rule order',()=>{
  const policy=validatePolicy({version:1,rules:[{id:'review',kind:'shell',outcome:'ask'},{id:'no-shell',kind:'shell',outcome:'deny',profile:'native-owner'}]});
  assert.equal(decide(policy,7,effect,{grant:'owner'}).rule,'no-shell');
  assert.equal(decide(policy,7,{...effect,profile:'other'},{grant:'owner'}).outcome,'allow');
  assert.deepEqual(decide(policy,7,effect,{grant:'owner',mandatoryDenial:'audience_changed'}),{outcome:'deny',rule:'audience_changed',revision:7,origin:'mandatory'});
});
test('unknown settings, pretend grants and prompt-heavy policies fail validation',()=>{
  for(const value of [{version:2,rules:[]},{version:1,rules:[],enabled:false},{version:1,rules:[{id:'x',kind:'shell',outcome:'allow'}]},
    {version:1,rules:[{id:'x',kind:'memory.read',outcome:'ask'}]},{version:1,rules:[{id:'x',kind:'shell',outcome:'deny',job:'*'}]},
    {version:1,rules:[{id:'x',kind:'shell',outcome:'deny'},{id:'x',kind:'shell',outcome:'deny'}]}])assert.throws(()=>validatePolicy(value));
});
test('structured effect identities ignore field order but distinguish all argument values',()=>{
  assert.equal(fingerprint({b:2,a:1}),fingerprint({a:1,b:2}));
  assert.notEqual(fingerprint({a:'echo yes'}),fingerprint({a:'echo no'}));
});
test('provider cannot execute hosted tools or fetch remote media or opaque history even when guarding is off',()=>{
  for(const value of [{tools:[{type:'web_search'}]},{web_search_options:{}},{previous_response_id:'old-private-response'},
    {input:[{type:'input_file',file_id:'old-private-file'}]},{input:[{type:'input_image',image_url:'https://external.example/private-data'}]}])assert.throws(()=>providerPayload(value));
  const valid={input:[{role:'user',content:'Quoted evidence: previous_response_id and web_search are just words.'}],tools:[{type:'function',name:'local_tool',parameters:{properties:{file_id:{type:'string'}}}}]};
  assert.deepEqual(providerPayload(valid),valid);
});
