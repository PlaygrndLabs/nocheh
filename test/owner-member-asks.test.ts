import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Reader} from '../src/access.js';
import {telegramDeliveryAllowed} from '../src/assistant-policy.js';
import {fillTemplate,memberReadFrame,memberReadLines,memberReadTexts,promptKeys} from '../src/prompts.js';
import {readSet} from '../src/spaces.js';
import {askAttempt,askSendKey} from '../src/stores/owner-member-ask-turns.js';
import {askGuard,forwardedMessage,namesIn,ownerMemberAskJob,type AskableMember} from '../src/stores/owner-member-asks.js';
import {runtimeProfile} from '../src/stores/runtime-profile.js';
import {GP1,OWNER,groupsPolicy} from './fixture-groups.js';

// Step 4b (ADR-0262): the owner asks, in their own private chat, what a member said in their own private chat with Nocheh.
const ask='d'.repeat(32);
const sam:AskableMember={id:'1'.repeat(64),names:['Sam Rivers','@samr'],label:'"Sam Rivers"'};
const kim:AskableMember={id:'2'.repeat(64),names:['Kim','@kimtest'],label:'"Kim"'};
const otherKim:AskableMember={id:'3'.repeat(64),names:['Kim','@kimother'],label:'"Kim"'};
const update=(message:Record<string,unknown>,chat:{id:number;type:string}={id:Number(OWNER),type:'private'},from=Number(OWNER))=>
  ({update_id:1,message:{message_id:1,date:1,chat,from:{id:from,is_bot:false},...message}});

test('an ask is recorded only from the owner\'s own words in the owner\'s private chat that name the member',()=>{
  const policy=groupsPolicy(),people=[sam,kim];
  const guard=(payload:unknown,asked:string,scope=OWNER)=>askGuard(policy,payload,scope,people,asked);
  assert.deepEqual(guard(update({text:'What did Sam Rivers tell you about the trip?'}),'Sam Rivers'),{member:sam});
  assert.deepEqual(guard(update({text:'what did sam rivers say?'}),'@samr'),{member:sam},'by their @username, the message naming them by name');
  assert.deepEqual(guard(update({text:'What did @samr ask?'}),'samr'),{member:sam},'an @username without its @');
  assert.deepEqual(guard(update({caption:'Did Kim send this?'}),'Kim'),{member:kim},'a caption is the owner\'s own words too');
  // A name only in the tool's arguments, a quoted message or a forward records nothing.
  assert.deepEqual(guard(update({text:'What did they say about the trip?'}),'Sam Rivers'),{refused:'member_ask_not_named'});
  assert.deepEqual(guard(update({text:'And what about this?',reply_to_message:{message_id:2,text:'Sam Rivers said hi'}}),'Sam Rivers'),
    {refused:'member_ask_not_named'},'a quoted message is not the owner\'s own words');
  assert.deepEqual(guard(update({text:'What did Sam Rivers say?',forward_origin:{type:'hidden_user',sender_user_name:'Someone',date:1}}),'Sam Rivers'),
    {refused:'member_ask_forwarded'});
  assert.deepEqual(guard(update({text:'What did Sam Rivers say?',is_automatic_forward:true}),'Sam Rivers'),{refused:'member_ask_forwarded'});
  // Never from a group, from anyone but the owner, or in a chat's own name.
  assert.deepEqual(guard(update({text:'What did Sam Rivers say?'},{id:Number(GP1),type:'supergroup'}),'Sam Rivers',GP1),{refused:'member_ask_not_owner'});
  assert.deepEqual(guard(update({text:'What did Sam Rivers say?'},{id:Number(OWNER),type:'private'},456),'Sam Rivers'),{refused:'member_ask_not_owner'});
  assert.deepEqual(guard(update({text:'What did Sam Rivers say?',sender_chat:{id:-100,type:'channel'}}),'Sam Rivers'),{refused:'member_ask_not_owner'});
  assert.deepEqual(guard({update_id:1,edited_message:{text:'Sam Rivers'}},'Sam Rivers'),{refused:'member_ask_not_owner'},'an edit asks nothing');
  assert.deepEqual(guard(null,'Sam Rivers'),{refused:'member_ask_not_owner'});
  assert.deepEqual(askGuard(groupsPolicy({enabled:false}),update({text:'What did Sam Rivers say?'}),OWNER,people,'Sam Rivers'),{refused:'member_ask_not_owner'});
  // A name nobody has, or one two members share, is never guessed.
  assert.deepEqual(guard(update({text:'What did Alex say?'}),'Alex'),{refused:'member_not_found'});
  assert.deepEqual(askGuard(policy,update({text:'What did Kim say?'}),OWNER,[sam,kim,otherKim],'Kim'),{refused:'member_name_ambiguous'});
  assert.deepEqual(askGuard(policy,update({text:'What did Kim say?'}),OWNER,[sam,kim,otherKim],'@kimtest'),{member:kim},'their @username tells them apart');
});

test('a name is a name of its own, never part of a longer word',()=>{
  assert.equal(namesIn('What did Kim say?','Kim'),true);
  assert.equal(namesIn('KIM, what did you say?','kim'),true);
  assert.equal(namesIn('Did Kimberly write?','Kim'),false);
  assert.equal(namesIn('Ask Akim','Kim'),false);
  assert.equal(namesIn('Ask @samr now','@samr'),true);
  assert.equal(namesIn('Ask @samrx now','@samr'),false);
  assert.equal(namesIn('Anything','  '),false);
  assert.equal(forwardedMessage({text:'x'}),false);
  assert.equal(forwardedMessage({text:'x',forward_from:{id:1}}),true);
  assert.equal(forwardedMessage({text:'x',forward_origin:null}),false);
});

test('an ask has its own job, attempt and send key, never a message turn\'s',()=>{
  assert.equal(ownerMemberAskJob(ask),'ask:'+ask);
  assert.equal(askAttempt(ask,1),'m1-'+ask);
  assert.match(askAttempt(ask,2),/^m[1-9]\d{0,2}-[a-f0-9]{32}$/,'services/hermes/assistant_gateway.py takes this shape only with its ask');
  assert.equal(askSendKey(ask),'member-ask:'+ask);
});

test('each ask runs in its own runtime profile, the one Hermes derives from the same claims',()=>{
  const binding={generation:'11111111-1111-1111-1111-111111111111',epoch:5} as Parameters<typeof runtimeProfile>[1];
  const scoped=(fields:Partial<Reader>={}):Reader=>({admin:false,scope:'123',space:'123',...fields});
  // services/hermes/test_scopes.py pins the same name for the same claims.
  assert.equal(runtimeProfile(scoped({memberRead:ask}),binding),'nocheh-4c79eaf776a2c61788142716');
  const profiles=[runtimeProfile(scoped({memberRead:ask}),binding),runtimeProfile(scoped({memberRead:'e'.repeat(32)}),binding),
    runtimeProfile(scoped({answer:ask}),binding),runtimeProfile(scoped(),binding),runtimeProfile({admin:false,scope:null,space:'123'},binding)];
  assert.equal(new Set(profiles).size,5,'never another ask\'s, an answer\'s, a plain scoped one or the owner\'s');
  assert.equal(runtimeProfile(scoped({memberRead:ask,memberChat:'456',reads:readSet({home:'123'})}),binding),profiles[0],'the chat it reads does not name it');
});

test('an ask\'s answer is delivered only into the owner\'s own private chat, with the member\'s chat bound',()=>{
  const policy=groupsPolicy();
  const source=(chat:{id:number;type:string},from:number)=>({origin:'live',channel:'telegram',kind:'telegram_update',scope:String(chat.id),
    payload:Buffer.from(JSON.stringify(update({text:'What did Sam Rivers say?'},chat,from)))});
  const ownerChat=source({id:Number(OWNER),type:'private'},Number(OWNER)),groupChat=source({id:Number(GP1),type:'supergroup'},Number(OWNER));
  const bound={scope:OWNER,memberRead:ask,reads:readSet({home:OWNER}),memberChat:'456'};
  assert.equal(telegramDeliveryAllowed(policy,bound,ownerChat),true);
  assert.equal(telegramDeliveryAllowed(policy,{scope:OWNER,memberRead:ask,reads:readSet({home:OWNER})},ownerChat),false,'never without the member\'s chat bound');
  assert.equal(telegramDeliveryAllowed(policy,{scope:OWNER,memberRead:ask,memberChat:'456'},ownerChat),false,'never without its bound read set');
  assert.equal(telegramDeliveryAllowed(policy,{...bound,scope:GP1},groupChat),false,'never into a group');
  assert.equal(telegramDeliveryAllowed(policy,bound,groupChat),false);
  assert.equal(telegramDeliveryAllowed(policy,bound,{...ownerChat,channel:'browser'}),false);
  assert.equal(telegramDeliveryAllowed(policy,bound,{...ownerChat,origin:'import'}),false);
  assert.equal(telegramDeliveryAllowed(policy,bound,null),false);
  assert.equal(telegramDeliveryAllowed(policy,{...bound,scope:null},ownerChat),false,'never as the owner');
  // The owner's own pass is unchanged.
  assert.equal(telegramDeliveryAllowed(policy,{scope:null},ownerChat),true);
});

test('the ask\'s frame and fixed texts are the owner\'s to edit, with the member in each',()=>{
  for(const key of ['reply.member_read','telegram.member_read','telegram.member_read_texts'] as const)assert.ok((promptKeys as readonly string[]).includes(key),key);
  assert.ok(memberReadFrame.includes('{member}'));
  for(const tool of ['archive_search','archive_read','archive_page'])assert.ok(memberReadFrame.includes('mcp__nocheh__'+tool),tool);
  const lines=memberReadLines(undefined);
  assert.deepEqual(Object.keys(lines).sort(),['closed','failed','source']);
  assert.equal(fillTemplate(lines.source,{member:'"Sam Rivers"'}),'🔒 From "Sam Rivers"’s private chat with Nocheh:');
  assert.deepEqual(memberReadLines(memberReadTexts),lines);
  // An edit that drops a line or its member falls back to the default.
  assert.deepEqual(memberReadLines('source: Hello'),lines);
  for(const text of Object.values(lines))assert.doesNotMatch(text,/\bteam\b/i,'the owner reads "member", never "team"');
});
