import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide,defaultPolicy,validatePolicy,fingerprint,manifest,type Effect} from '../src/security/contract.js';
import {anthropicPayload,providerPayload} from '../src/security/provider-request.js';
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

test("Anthropic's Messages API keeps the same boundary: local tools only, no stored files, remote media or new features",()=>{
  const tool={name:'mcp',description:'Calls a connected tool',input_schema:{type:'object',properties:{url:{type:'string'},file_id:{type:'string'}}},cache_control:{type:'ephemeral'}};
  const valid={model:'claude-test',max_tokens:100,stream:true,system:[{type:'text',text:'system',cache_control:{type:'ephemeral'}}],tools:[tool],tool_choice:{type:'auto'},
    thinking:{type:'adaptive',display:'summarized'},output_config:{effort:'low'},messages:[
      {role:'user',content:'Quoted evidence: url, file_id and mcp_servers are just words.'},
      {role:'assistant',content:[{type:'text',text:'Calling.'},{type:'tool_use',id:'call-1',name:'mcp',input:{url:'https://tools.example',file_id:'local'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:[{type:'text',text:'done'}]},{type:'image',source:{type:'base64',media_type:'image/png',data:'raw'}}]}]};
  assert.deepEqual(anthropicPayload(valid),valid);
  const message=(content:unknown)=>({...valid,messages:[{role:'user',content}]});
  for(const [value,code] of [
    [{...valid,tools:[{type:'web_search_20260209',name:'web_search'}]},'hosted_provider_tools_denied'],
    [{...valid,tools:[{...tool,type:'bash_20250124'}]},'hosted_provider_tools_denied'],
    [{...valid,tools:[{...tool,allowed_callers:['code_execution_20260120']}]},'hosted_provider_tools_denied'],
    [{...valid,tool_choice:{type:'web_search'}},'hosted_provider_tools_denied'],
    [{...valid,mcp_servers:[{type:'url',url:'https://mcp.example'}]},'provider_request_field_denied'],
    [{...valid,container:'old-container'},'provider_request_field_denied'],
    [{...valid,context_management:{edits:[]}},'provider_request_field_denied'],
    [message([{type:'document',source:{type:'file',file_id:'old-private-file'}}]),'opaque_provider_context_denied'],
    [message([{type:'container_upload',file_id:'old-private-file'}]),'opaque_provider_context_denied'],
    [message([{type:'server_tool_use',id:'x',name:'web_search',input:{}}]),'opaque_provider_context_denied'],
    [message([{type:'image',source:{type:'url',url:'https://external.example/private-data'}}]),'remote_provider_media_denied'],
    [message([{type:'tool_result',tool_use_id:'x',content:[{type:'image',source:{type:'file',file_id:'old'}}]}]),'remote_provider_media_denied'],
    [message([{type:'text',text:'x',citations:[{type:'web_search_result_location',url:'https://external.example'}]}]),'opaque_provider_context_denied'],
  ] as const)assert.throws(()=>anthropicPayload(value),{code},JSON.stringify(value));
  assert.throws(()=>anthropicPayload({...valid,messages:'text'}),{code:'invalid_model_request'});
  assert.throws(()=>anthropicPayload(message({type:'text'})),{code:'invalid_model_request'});
  // Earlier reasoning is not replayed; a turn of only reasoning is left for the API to judge.
  const reasoning={...valid,messages:[{role:'assistant',content:[{type:'thinking',thinking:'t',signature:'s'},{type:'redacted_thinking',data:'d'},{type:'text',text:'answer'}]},
    {role:'assistant',content:[{type:'thinking',thinking:'t',signature:'s'}]},{role:'user',content:[{type:'thinking',thinking:'t',signature:'s'}]}]};
  assert.deepEqual(anthropicPayload(reasoning).messages,[{role:'assistant',content:[{type:'text',text:'answer'}]},reasoning.messages[1],reasoning.messages[2]]);
});
