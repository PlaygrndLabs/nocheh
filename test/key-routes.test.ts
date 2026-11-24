import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keyKinds,type KeyKind,type Reader} from '../src/access.js';
import {assertKeyRoute,keyRoute,keyRoutes} from '../src/stores/key-routes.js';
import {relayRoutes} from '../src/security/relay-routes.js';

// Each kind of one-time key reaches only its own routes (ADR-0305). Synthetic paths only.
const hex=(n:number)=>'a'.repeat(n);
const reader=(keyKind?:KeyKind):Reader=>({admin:false,scope:null,space:'123',turnEvent:hex(64),...(keyKind?{keyKind,person:'owner',jti:hex(32)}:{})});
const denied={status:403,code:'one_time_key_route_denied'};

test('a reply\'s or run\'s key reaches the relayed data routes and the turn\'s own routes, nothing of the dashboard', () => {
  const reached:[string,string][]=[['GET','/v1/search'],['GET','/v1/memory/check'],['POST','/v1/memory/recall'],['POST','/v1/jobs/start'],['POST','/v1/member-asks'],
    ['GET','/v1/security/binding'],['GET','/v1/turn-files/'+hex(64)],['GET','/v1/box/chat'],['POST','/mcp'],['POST','/v1/guard'],['POST','/v1/chat/completions'],
    ['POST','/v1/turn/conversation-reads'],['POST','/anthropic/v1/messages']];
  const refused:[string,string][]=[['GET','/v1/runtime'],['POST','/v1/ingest'],['GET','/v1/projects'],['POST','/v1/memory/spaces'],['GET','/mcp'],['DELETE','/v1/search'],
    ['GET','/v1/search/extra'],['GET','/v1/turn-files/'+hex(63)]];
  for(const kind of ['turn','follow_up','scheduled','background'] as const) {
    for(const [method,path] of reached){assert.ok(keyRoute(kind,method,path),kind+' '+method+' '+path);assert.doesNotThrow(()=>assertKeyRoute(reader(kind),method,path));}
    for(const [method,path] of refused){assert.ok(!keyRoute(kind,method,path),kind+' '+method+' '+path);assert.throws(()=>assertKeyRoute(reader(kind),method,path),denied);}
  }
});

test('every route the broker relays for a turn is on a turn key\'s list', () => {
  for(const kind of ['turn','follow_up','scheduled','background'] as const)for(const route of relayRoutes)assert.ok(keyRoutes[kind].includes(route),kind+' '+route[1]);
});

test('a review\'s and a filter\'s keys reach no data tool and no read route', () => {
  const dataRoutes:[string,string][]=[['POST','/mcp'],['GET','/v1/search'],['GET','/v1/archive/page'],['GET','/v1/memory/context'],['POST','/v1/memory/recall'],
    ['POST','/v1/jobs/start'],['POST','/v1/action-requests'],['GET','/v1/turn-files/'+hex(64)],['GET','/v1/box/chat']];
  for(const kind of ['review','filter'] as const)for(const [method,path] of dataRoutes)
    assert.throws(()=>assertKeyRoute(reader(kind),method,path),denied,kind+' '+method+' '+path);
  for(const [method,path] of <[string,string][]>[['GET','/v1/memory/check'],['GET','/v1/security/binding'],['POST','/v1/context/prepare'],['POST','/v1/guard'],['POST','/v1/chat/completions'],['POST','/anthropic/v1/messages']])
    assert.ok(keyRoute('review',method,path),'review '+method+' '+path);
  for(const [method,path] of <[string,string][]>[['GET','/v1/security/binding'],['POST','/v1/guard'],['POST','/v1/chat/completions'],['POST','/anthropic/v1/messages']])
    assert.ok(keyRoute('filter',method,path),'filter '+method+' '+path);
  for(const [method,path] of <[string,string][]>[['GET','/v1/memory/check'],['POST','/v1/context/prepare']])assert.ok(!keyRoute('filter',method,path),'filter '+method+' '+path);
});

test('every kind has a route list, a reader without a key reaches nothing, and the owner\'s admin bearer is not held here', () => {
  for(const kind of keyKinds)assert.ok(keyRoute(kind,'GET','/v1/security/binding')||kind==='member_ask',kind);
  assert.throws(()=>assertKeyRoute(reader(),'GET','/v1/search'),denied);
  assert.doesNotThrow(()=>assertKeyRoute({admin:true,scope:null},'GET','/v1/runtime'));
});
