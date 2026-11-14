import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {answerId,currentReader,reader,scopeToken,turnToken} from '../src/access.js';
import {chatDirectory,chatIdFor,chats,installChats,installChatsForTest,setChatLoader} from '../src/chats.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_TG,OWNER,fixtureChats,fixtureDirectory} from './fixture-groups.js';

// Both fixture families, as the chat directory knows them: reader() asks it what a space and a scope are (ADR-0250).
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
  assert.deepEqual(reader(request(turnToken(secret,null,later(),event,{space:OWNER,revision:1})),secret),{scope:null,admin:false,turnEvent:event,space:OWNER,revision:1,brain:'hermes'});
  assert.deepEqual(reader(request(scopeToken(secret,GP1,later())),secret),{scope:GP1,admin:false});
  assert.deepEqual(reader(request(secret),secret),{scope:null,admin:true});
});

test('a scoped pass reads in its own chat or one of its topics, as the chat directory says',()=>{
  // Old-shaped and new chats alike, a topic by its own chat id.
  for(const [scope,space] of [[GP1,GP1],[GP1,GP1_TOPIC],[NG1,NG1],[NG1,NG1_TOPIC],[NG2,NG2]] as const)
    assert.equal(reader(request(turnToken(secret,scope,later(),event,{space,revision:1})),secret).space,space,`${scope} ${space}`);
  // Another chat, another chat's topic, or a topic the directory does not know: never read by the shape of an id.
  for(const [scope,space] of [[GP1,GP2],[NG1,GP1_TOPIC],[GP2,GP1_TOPIC],[GP1,GP1+'/topic/99'],[NG1,NG1+'/topic/7'],[NG2,NG1_TOPIC]] as const)
    assert.throws(()=>reader(request(signed('turn',{scope,event_id:event,space,revision:1})),secret),{code:'invalid_scope_token'},`${scope} ${space}`);
});

test('a turn pass may carry its chat\'s app binding; storage does not require it',()=>{
  const app={app:'telegram' as const,chat:NG1_TG,topic:'7'};
  assert.deepEqual(reader(request(turnToken(secret,NG1,later(),event,{space:NG1_TOPIC,revision:1,app})),secret),
    {scope:NG1,admin:false,turnEvent:event,space:NG1_TOPIC,revision:1,brain:'hermes',app});
  assert.deepEqual(reader(request(turnToken(secret,NG2,later(),event,{space:NG2,revision:1,app:{app:'telegram',chat:NG2_TG,topic:null}})),secret).app,
    {app:'telegram',chat:NG2_TG,topic:null});
  // A job's or a schedule's pass has no app binding and still reads.
  assert.equal('app' in reader(request(turnToken(secret,GP1,later(),event,{space:GP1,revision:1})),secret),false);
  for(const bad of [{app:'telegram',chat:NG1_TG},{app:'telegram',chat:NG1_TG,topic:7},{app:'email',chat:NG1_TG,topic:null},{app:'telegram',chat:'',topic:null},
    {app:'telegram',chat:NG1_TG,topic:null,extra:1},'telegram'])
    assert.throws(()=>reader(request(signed('turn',{scope:NG1,event_id:event,space:NG1,revision:1,app:bad})),secret),{code:'invalid_scope_token'},JSON.stringify(bad));
  assert.throws(()=>reader(request(signed('scope',{scope:NG1,app:{app:'telegram',chat:NG1_TG,topic:null}})),secret),{code:'invalid_scope_token'});
});

test('an answer pass reads only as the owner\'s private chat row, never another private chat or an unknown id',()=>{
  assert.equal(reader(request(turnToken(secret,OWNER,later(),event,{space:OWNER,revision:1,answer})),secret).answer,answer);
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
    const pass=turnToken(secret,NG1,later(),event,{space:fresh,revision:1});
    assert.throws(()=>reader(request(pass),secret),{code:'invalid_scope_token'});
    // Without a loader to wait for, it is refused as before.
    await assert.rejects(currentReader(request(pass),secret),{code:'invalid_scope_token'});
    setChatLoader({epoch(){},miss(){},current:async()=>{looked++;installChats(chatDirectory(after));}});
    assert.equal((await currentReader(request(pass),secret)).space,fresh);
    assert.equal(looked,1);
    // Known chats never wait, and a space the reloaded directory still puts elsewhere, or does not know, is refused.
    assert.equal((await currentReader(request(turnToken(secret,GP1,later(),event,{space:GP1_TOPIC,revision:1})),secret)).space,GP1_TOPIC);
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
