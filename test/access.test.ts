import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {answerId,reader,scopeToken,turnToken} from '../src/access.js';
import {GP1,GP1_TOPIC,NG1,NG1_TOPIC,NG2,OWNER,fixtureDirectory} from './fixture-groups.js';
import {installChatsForTest} from '../src/chats.js';

// A pass's space must be its chat or one of that chat's topics, as the chat directory holds them (ADR-0250).
installChatsForTest(fixtureDirectory());

const secret='synthetic-service-token-only-for-tests',event='e'.repeat(64),answer='a'.repeat(32),later=()=>Date.now()+60000;
const request=(token:string)=>({headers:{authorization:'Bearer '+token}}) as unknown as IncomingMessage;
/** A pass signed with the service token whatever its claims, as a bug in a signer would make it. */
const signed=(prefix:'turn'|'scope',claims:Record<string,unknown>)=>{
  const body=Buffer.from(JSON.stringify({expires:later(),audience:prefix==='turn'?'nocheh-assistant':'nocheh-archive',...claims})).toString('base64url');
  return `${prefix}.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
};

test('an answer claim is read only from a turn pass for the asker\'s private chat',()=>{
  const pass=turnToken(secret,OWNER,later(),event,{space:OWNER,revision:1,guard_epoch:1,answer});
  assert.deepEqual(reader(request(pass),secret),{scope:OWNER,admin:false,turnEvent:event,space:OWNER,revision:1,guard_epoch:1,brain:'hermes',answer});
  assert.ok(answerId.test(answer));
  for(const value of ['A'.repeat(32),'a'.repeat(31),'a'.repeat(33),'a'.repeat(64),'g'.repeat(32),'',32])
    assert.throws(()=>reader(request(signed('turn',{scope:OWNER,event_id:event,space:OWNER,revision:1,answer:value})),secret),{code:'invalid_scope_token'},String(value));
  // Never an owner pass, a group or topic pass, a pass without its space, or a scope pass.
  for(const [why,claims] of Object.entries({
    'an owner pass':{scope:null,space:OWNER,revision:1},'a group pass':{scope:GP1,space:GP1,revision:1},'a topic pass':{scope:GP1,space:GP1_TOPIC,revision:1},
    'a pass without a space':{scope:OWNER},'a desktop import':{scope:'desktop:personal_chat:9',space:'desktop:personal_chat:9',revision:1},
    'a topic of the private chat':{scope:OWNER,space:OWNER+'/topic/5',revision:1},
    'a digest group pass':{scope:NG1,space:NG1,revision:1},'a digest topic pass':{scope:NG1,space:NG1_TOPIC,revision:1},
  }))assert.throws(()=>reader(request(signed('turn',{event_id:event,answer,...claims})),secret),{code:'invalid_scope_token'},why);
  assert.throws(()=>reader(request(signed('scope',{scope:OWNER,answer})),secret),{code:'invalid_scope_token'},'a scope pass');
});

test('a read set never comes from a pass, and passes without an answer read as before',()=>{
  for(const reads of [{home:GP1,exact:[],whole:[GP1],project:null},[],null,'everything'])
    assert.throws(()=>reader(request(signed('turn',{scope:OWNER,event_id:event,space:OWNER,revision:1,answer,reads})),secret),{code:'invalid_scope_token'});
  assert.throws(()=>reader(request(signed('turn',{scope:GP1,event_id:event,space:GP1,revision:1,reads:{home:GP1,exact:[],whole:[GP1],project:null}})),secret),{code:'invalid_scope_token'});
  assert.throws(()=>reader(request(signed('scope',{scope:GP1,reads:[GP1]})),secret),{code:'invalid_scope_token'});
  const group=reader(request(turnToken(secret,GP1,later(),event,{space:GP1_TOPIC,revision:2})),secret);
  assert.deepEqual(group,{scope:GP1,admin:false,turnEvent:event,space:GP1_TOPIC,revision:2,brain:'hermes'});
  assert.equal('answer' in group||'reads' in group,false);
  // Both fixture families: a digest topic's pass reads under its group's row, and a space under another chat is refused.
  assert.deepEqual(reader(request(turnToken(secret,NG1,later(),event,{space:NG1_TOPIC,revision:2})),secret),
    {scope:NG1,admin:false,turnEvent:event,space:NG1_TOPIC,revision:2,brain:'hermes'});
  for(const [scope,space] of [[NG2,NG1_TOPIC],[GP1,NG1_TOPIC],[NG1,GP1_TOPIC]])
    assert.throws(()=>reader(request(signed('turn',{scope,event_id:event,space,revision:2})),secret),{code:'invalid_scope_token'},scope+' '+space);
  assert.deepEqual(reader(request(turnToken(secret,null,later(),event,{space:OWNER,revision:1})),secret),{scope:null,admin:false,turnEvent:event,space:OWNER,revision:1,brain:'hermes'});
  assert.deepEqual(reader(request(scopeToken(secret,GP1,later())),secret),{scope:GP1,admin:false});
  assert.deepEqual(reader(request(secret),secret),{scope:null,admin:true});
});
