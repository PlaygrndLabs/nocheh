import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {admin,adminOrAgent,agentLogin,answerId,currentReader,isAgentLogin,keyIdPattern,reader,turnToken,type Reader} from '../src/access.js';
import {keyClaims,keyPass} from './one-time-key-pass.js';
import {chatDirectory,chatIdFor,chats,installChats,installChatsForTest,setChatLoader} from '../src/chats.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_TG,OWNER,fixtureChats,fixtureDirectory} from './fixture-groups.js';

// Both fixture families, as the chat directory knows them: reader() asks it what a space and a scope are (ADR-0252).
installChatsForTest(fixtureDirectory());

const secret='synthetic-service-token-only-for-tests',event='e'.repeat(64),answer='a'.repeat(32),later=()=>Date.now()+60000;
const request=(token:string)=>({headers:{authorization:'Bearer '+token}}) as unknown as IncomingMessage;
/** A reader without its one-time key's fields, which every pass carries (ADR-0305) and the key test checks itself. */
const bare=(value:Reader)=>{const {person:_person,jti:_jti,keyKind:_kind,...rest}=value;return rest;};
/** A pass signed with the service token whatever its claims, as a bug in a signer would make it. */
const signed=(prefix:'turn'|'scope',claims:Record<string,unknown>)=>{
  // A one-time key's claims (ADR-0305) unless the test names others, so each refusal below is for the claim it is about.
  const key=prefix==='turn'?{agent:'hermes',person:'owner',jti:keyClaims().jti,key_kind:'turn'}:{};
  const body=Buffer.from(JSON.stringify({expires:later(),audience:prefix==='turn'?'nocheh-assistant':'nocheh-archive',...key,...claims})).toString('base64url');
  return `${prefix}.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
};

test('an answer claim is read only from a turn pass for the asker\'s private chat',()=>{
  const pass=keyPass(secret,OWNER,later(),event,{space:OWNER,revision:1,guard_epoch:1,answer});
  assert.deepEqual(bare(reader(request(pass),secret)),{scope:OWNER,admin:false,turnEvent:event,space:OWNER,revision:1,guard_epoch:1,agent:'hermes',answer});
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
  const group=bare(reader(request(keyPass(secret,GP1,later(),event,{space:GP1_TOPIC,revision:2})),secret));
  assert.deepEqual(group,{scope:GP1,admin:false,turnEvent:event,space:GP1_TOPIC,revision:2,agent:'hermes'});
  assert.equal('answer' in group||'reads' in group,false);
  // Both fixture families: a digest topic's pass reads under its group's row, and a space under another chat is refused.
  assert.deepEqual(bare(reader(request(keyPass(secret,NG1,later(),event,{space:NG1_TOPIC,revision:2})),secret)),
    {scope:NG1,admin:false,turnEvent:event,space:NG1_TOPIC,revision:2,agent:'hermes'});
  for(const [scope,space] of [[NG2,NG1_TOPIC],[GP1,NG1_TOPIC],[NG1,GP1_TOPIC]])
    assert.throws(()=>reader(request(signed('turn',{scope,event_id:event,space,revision:2})),secret),{code:'invalid_scope_token'},scope+' '+space);
  assert.deepEqual(bare(reader(request(keyPass(secret,null,later(),event,{space:OWNER,revision:1})),secret)),{scope:null,admin:false,turnEvent:event,space:OWNER,revision:1,agent:'hermes'});
  // The archive-wide scope pass is gone: every pass is a one-time key (ADR-0305).
  assert.throws(()=>reader(request(signed('scope',{scope:GP1})),secret),{code:'invalid_scope_token'});
  assert.deepEqual(reader(request(secret),secret),{scope:null,admin:true});
});

test('a scoped pass reads in its own chat or one of its topics, as the chat directory says',()=>{
  // Old-shaped and new chats alike, a topic by its own chat id.
  for(const [scope,space] of [[GP1,GP1],[GP1,GP1_TOPIC],[NG1,NG1],[NG1,NG1_TOPIC],[NG2,NG2]] as const)
    assert.equal(reader(request(keyPass(secret,scope,later(),event,{space,revision:1})),secret).space,space,`${scope} ${space}`);
  // Another chat, another chat's topic, or a topic the directory does not know: never read by the shape of an id.
  for(const [scope,space] of [[GP1,GP2],[NG1,GP1_TOPIC],[GP2,GP1_TOPIC],[GP1,GP1+'/topic/99'],[NG1,NG1+'/topic/7'],[NG2,NG1_TOPIC]] as const)
    assert.throws(()=>reader(request(signed('turn',{scope,event_id:event,space,revision:1})),secret),{code:'invalid_scope_token'},`${scope} ${space}`);
});

test('a turn pass may carry its chat\'s app binding; storage does not require it',()=>{
  const app={app:'telegram' as const,chat:NG1_TG,topic:'7'};
  assert.deepEqual(bare(reader(request(keyPass(secret,NG1,later(),event,{space:NG1_TOPIC,revision:1,app})),secret)),
    {scope:NG1,admin:false,turnEvent:event,space:NG1_TOPIC,revision:1,agent:'hermes',app});
  assert.deepEqual(reader(request(keyPass(secret,NG2,later(),event,{space:NG2,revision:1,app:{app:'telegram',chat:NG2_TG,topic:null}})),secret).app,
    {app:'telegram',chat:NG2_TG,topic:null});
  // A job's or a schedule's pass has no app binding and still reads.
  assert.equal('app' in reader(request(keyPass(secret,GP1,later(),event,{space:GP1,revision:1})),secret),false);
  for(const bad of [{app:'telegram',chat:NG1_TG},{app:'telegram',chat:NG1_TG,topic:7},{app:'email',chat:NG1_TG,topic:null},{app:'telegram',chat:'',topic:null},
    {app:'telegram',chat:NG1_TG,topic:null,extra:1},'telegram'])
    assert.throws(()=>reader(request(signed('turn',{scope:NG1,event_id:event,space:NG1,revision:1,app:bad})),secret),{code:'invalid_scope_token'},JSON.stringify(bad));
  assert.throws(()=>reader(request(signed('scope',{scope:NG1,app:{app:'telegram',chat:NG1_TG,topic:null}})),secret),{code:'invalid_scope_token'});
});

test('an answer pass reads only as the owner\'s private chat row, never another private chat or an unknown id',()=>{
  assert.equal(reader(request(keyPass(secret,OWNER,later(),event,{space:OWNER,revision:1,answer})),secret).answer,answer);
  for(const scope of [BOB_CHAT,GP1,NG1,'777'])
    assert.throws(()=>reader(request(signed('turn',{scope,event_id:event,space:scope,revision:1,answer})),secret),{code:'invalid_scope_token'},scope);
});

test('a pass for a topic another process recorded a moment ago is read once the directory has looked again',async()=>{
  // The app records NG1's new topic 9 and mints its pass; this process (the security service) still holds the
  // directory it loaded before. A plain read refuses; a server that can wait asks its loader to look again first.
  const fresh=chatIdFor('telegram',NG1_TG,'9'),before=fixtureChats(),after={...before,chats:[...before.chats,
    {id:fresh,app:'telegram' as const,kind:'topic' as const,parent_id:NG1,topic_key:'9',state:'active' as const,title:null,is_forum:false,account_id:null,app_type:null}]};
  const restore=installChatsForTest(chatDirectory(before));let looked=0;
  try {
    const pass=keyPass(secret,NG1,later(),event,{space:fresh,revision:1});
    assert.throws(()=>reader(request(pass),secret),{code:'invalid_scope_token'});
    // Without a loader to wait for, it is refused as before.
    await assert.rejects(currentReader(request(pass),secret),{code:'invalid_scope_token'});
    setChatLoader({epoch(){},miss(){},current:async()=>{looked++;installChats(chatDirectory(after));}});
    assert.equal((await currentReader(request(pass),secret)).space,fresh);
    assert.equal(looked,1);
    // Known chats never wait, and a space the reloaded directory still puts elsewhere, or does not know, is refused.
    assert.equal((await currentReader(request(keyPass(secret,GP1,later(),event,{space:GP1_TOPIC,revision:1})),secret)).space,GP1_TOPIC);
    assert.equal(looked,1);
    await assert.rejects(currentReader(request(signed('turn',{scope:GP2,event_id:event,space:fresh,revision:1})),secret),{code:'invalid_scope_token'});
    assert.equal(looked,1,'a known space in another chat is no miss');
    setChatLoader({epoch(){},miss(){},current:async()=>{looked++;}});
    await assert.rejects(currentReader(request(signed('turn',{scope:NG1,event_id:event,space:chatIdFor('telegram',NG1_TG,'10'),revision:1})),secret),{code:'invalid_scope_token'});
    assert.equal(looked,2);
    // A forged pass never reaches the directory.
    await assert.rejects(currentReader(request(pass.slice(0,-2)+'xx'),secret),{code:'invalid_scope_token'});
    assert.equal(looked,2);
    assert.ok(chats().get(fresh));
  } finally {setChatLoader(null);restore();}
});

test('the agent login is no reader and signs no pass; only the few calls the agent makes take it (ADR-0295)',async()=>{
  const agentKey='synthetic-agent-login-only-for-tests-0001',login=agentLogin(request(agentKey),agentKey);
  assert.deepEqual(login,{kind:'agent',agent:'hermes'});assert.ok(isAgentLogin(login));
  // The master key's readers never take it: it is no admin bearer and no pass.
  assert.throws(()=>reader(request(agentKey),secret),{code:'invalid_scope_token'});
  await assert.rejects(currentReader(request(agentKey),secret),{code:'invalid_scope_token'});
  // A pass signed with the agent login is no pass, and a real pass is no agent login.
  const forged=keyPass(agentKey,null,later(),event,{space:OWNER,revision:1});
  assert.throws(()=>reader(request(forged),secret),{code:'invalid_scope_token'});
  assert.equal(agentLogin(request(forged),agentKey),null);
  assert.equal(agentLogin(request(keyPass(secret,null,later(),event,{space:OWNER,revision:1})),agentKey),null);
  assert.equal(agentLogin(request(secret),agentKey),null,'the master key is not the agent login');
  // Only an exact bearer of a configured key of 32 characters or more.
  for(const header of [agentKey,'bearer '+agentKey,'Bearer '+agentKey+' ','Bearer '+agentKey.slice(0,-1),'Bearer ','',undefined])
    assert.equal(agentLogin({headers:header===undefined?{}:{authorization:header}} as unknown as IncomingMessage,agentKey),null,String(header));
  for(const key of [undefined,'',agentKey.slice(0,31)])assert.equal(agentLogin(request(key??''),key),null,String(key));
  assert.equal(agentLogin(request(agentKey.slice(0,32)),agentKey.slice(0,32))?.kind,'agent');
  // The repository calls the agent makes take it or the admin bearer, never a scoped reader, and admin() never takes it.
  assert.doesNotThrow(()=>adminOrAgent(login!));assert.doesNotThrow(()=>adminOrAgent({scope:null,admin:true}));
  assert.throws(()=>adminOrAgent({scope:null,admin:false}),{code:'owner_required'});
  assert.throws(()=>adminOrAgent({scope:OWNER,admin:false}),{code:'owner_required'});
  assert.throws(()=>admin(login as never),{code:'owner_required'});
  assert.equal(isAgentLogin({scope:null,admin:true}),false);
});

test('every pass is a one-time key naming its person, its own id, its kind and the agent plugged in now (ADR-0305)',()=>{
  const member='b'.repeat(64),read='c'.repeat(32);
  const owner=reader(request(keyPass(secret,null,later(),event,{space:OWNER,revision:1})),secret);
  assert.equal(owner.person,'owner');assert.equal(owner.keyKind,'turn');assert.equal(owner.agent,'hermes');assert.ok(keyIdPattern.test(owner.jti!));
  // A member's turn in a group names that member, and its lane, if any, is theirs.
  const group=reader(request(keyPass(secret,GP1,later(),event,{space:GP1,revision:1,person:member,lane:member})),secret);
  assert.equal(group.person,member);
  // A pass without any of the key's claims, with another agent, or with a key spelled the Reader's way, is no pass.
  const base={scope:GP1,event_id:event,space:GP1,revision:1};
  for(const [why,claims] of Object.entries({
    'no jti':{jti:undefined},'a short jti':{jti:'a'.repeat(31)},'an upper-case jti':{jti:'A'.repeat(32)},
    'no person':{person:undefined},'a person that is no member id':{person:'x'.repeat(64)},'a raw account':{person:'12345'},
    'no kind':{key_kind:undefined},'an unknown kind':{key_kind:'dashboard'},
    'no agent':{agent:undefined},'another agent':{agent:'other-agent'},
    'a Reader-spelled kind':{keyKind:'turn'},
  }))assert.throws(()=>reader(request(signed('turn',{...base,...claims})),secret),{code:'invalid_scope_token'},why);
  // Its person fits the pass: a lane is its member's, and the owner's chat, an answer and an ask are the owner's.
  for(const [why,claims] of Object.entries({
    'a lane of another member':{lane:member,person:'owner'},
    'the owner\'s chat as a member':{scope:null,space:OWNER,person:member},
    'an answer as a member':{scope:OWNER,space:OWNER,answer,person:member},
    'an ask as a member':{scope:OWNER,space:OWNER,member_read:read,key_kind:'member_ask',person:member},
  }))assert.throws(()=>reader(request(signed('turn',{...base,...claims})),secret),{code:'invalid_scope_token'},why);
  // Its kind fits the pass's purpose: a review's and a filter's keys are their own, an ask's key is an ask's, and a run's
  // key names its profile.
  for(const [why,claims] of Object.entries({
    'a review purpose on a turn key':{scope:null,space:OWNER,purpose:'memory-review'},
    'a review key without its purpose':{scope:null,space:OWNER,key_kind:'review'},
    'a filter purpose on a turn key':{scope:null,space:OWNER,purpose:'filter'},
    'a filter key without its purpose':{scope:null,space:OWNER,key_kind:'filter'},
    'an ask on a turn key':{scope:OWNER,space:OWNER,member_read:read},
    'an ask key without its ask':{scope:OWNER,space:OWNER,key_kind:'member_ask'},
    'a scheduled key without a profile':{key_kind:'scheduled'},'a background key without a profile':{key_kind:'background'},
  }))assert.throws(()=>reader(request(signed('turn',{...base,...claims})),secret),{code:'invalid_scope_token'},why);
  assert.equal(reader(request(signed('turn',{...base,scope:null,space:OWNER,purpose:'memory-review',key_kind:'review'})),secret).keyKind,'review');
  assert.equal(reader(request(signed('turn',{...base,scope:OWNER,space:OWNER,member_read:read,key_kind:'member_ask'})),secret).memberRead,read);
  // A pass signed without the key's claims (a signer that skipped AudienceRepository.turn) is refused.
  assert.throws(()=>reader(request(turnToken(secret,GP1,later(),event,{space:GP1,revision:1})),secret),{code:'invalid_scope_token'});
});
