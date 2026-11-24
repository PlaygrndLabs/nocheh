import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActionBecause,ruleTarget} from '../src/stores/action-because.js';

const ID='a'.repeat(64),EVENT='e'.repeat(64),RUN='r'.repeat(64),TURN='t'.repeat(64),ACCOUNT='c'.repeat(64);

/** Control and archive stores as ActionBecause reads them: one allowed grant, the permission, the run and the messages. */
function stores(grant:{rule:string;permission_id?:string|null}|null,options:{operation?:string;permission?:any;messages?:Record<string,unknown>}={}) {
  const messages=options.messages??{[EVENT]:{message:{message_id:1,text:'  read\nexample.com/prices  '}}};
  const control={query:async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('FROM security_events'))return {rows:grant?[{permission_id:null,...grant}]:[]};
    if(sql.includes('FROM action_permissions'))return {rows:options.permission?[options.permission]:[]};
    if(sql.includes('FROM content_operations'))return {rows:options.operation?[{kind:options.operation}]:[]};
    if(sql.includes('FROM managed_runs'))return {rows:values[0]===RUN?[{version_id:'v1',created_turn:TURN}]:[]};
    if(sql.includes('FROM chat_accounts'))return {rows:values[0]===ACCOUNT||(values[0] as string[])?.[0]===ACCOUNT?[{id:ACCOUNT,name:'Sara',external_id:'77'}]:[]};
    return {rows:[]};
  }} as any;
  const archive={query:async(_:string,values:unknown[])=>{
    const payload=messages[String(values[0])];return {rows:payload?[{payload:Buffer.from(JSON.stringify(payload))}]:[]};
  }} as any;
  return new ActionBecause(control,archive,async version=>version==='v1'?{name:'Morning brief'}:null,async()=>'Weekly review');
}
const row=(changes:Record<string,unknown>={})=>({id:ID,event_id:EVENT,asker_account:null,free_read:null,authority:null,send_class:null,...changes});

test('an action says why it ran from the grant Nocheh first allowed it under (ADR-0294)',async()=>{
  assert.equal(await stores(null).because(row()),null,'one still waiting has no reason yet');
  assert.deepEqual(await stores({rule:'exact_owner_approval'}).because(row()),{kind:'approved'});
  // "Do what I ask", a same-group post and the owner's own private request quote the asking message, on one line.
  for(const rule of ['owner_autonomy:7','same_group_request','owner_private_request'])
    assert.deepEqual(await stores({rule}).because(row()),{kind:'said',who:'owner',name:null,words:'read example.com/prices'},rule);
  assert.deepEqual(await stores({rule:'gmail_read:own'}).because(row()),{kind:'setting',connection:'gmail'});
  assert.deepEqual(await stores({rule:'github_read:p1'}).because(row()),{kind:'setting',connection:'github'});
  assert.deepEqual(await stores({rule:'notion_setting:3'}).because(row()),{kind:'setting',connection:'notion'});
  // A chat rule names what it covers, where and until when; an exact allowance only that it was one.
  const until=new Date('2026-12-30T00:00:00Z');
  assert.deepEqual(await stores({rule:'p1',permission_id:'p1'},{permission:{grain:'chat',match_key:'nocheh_browser:example.com',space_id:'-100',expires_at:until}}).because(row()),
    {kind:'rule',what:'site',target:'example.com',chat:'-100',until:until.toISOString()});
  assert.deepEqual(await stores({rule:'p2'},{permission:{grain:'exact',match_key:null,space_id:null,expires_at:until}}).because(row()),
    {kind:'rule',what:'exact',target:null,chat:null,until:until.toISOString()});
  // A scheduled result names its schedule and the words that set it.
  const scheduled=stores({rule:'owner_scheduled_chat'},{messages:{[TURN]:{message:{text:'Every weekday at 8, brief me'}}}});
  assert.deepEqual(await scheduled.because(row({event_id:RUN})),{kind:'schedule',name:'Morning brief',words:'Every weekday at 8, brief me'});
  // A long message is cut on one line.
  const long=stores({rule:'owner_autonomy:1'},{messages:{[EVENT]:{message:{text:'x'.repeat(400)}}}});
  assert.equal(((await long.because(row())) as any).words,'x'.repeat(159)+'…');
});

test('who asked: a member by name, a schedule, a job, or nobody for a message Nocheh never kept',async()=>{
  const member=await stores({rule:'group_tools'}).because(row({asker_account:ACCOUNT,authority:'group_tools'}));
  assert.deepEqual(member,{kind:'group_tools',who:'member',name:'Sara'});
  assert.deepEqual(await stores(null).asked(row({asker_account:ACCOUNT})),{kind:'said',who:'member',name:'Sara',words:'read example.com/prices'});
  assert.deepEqual(await stores(null,{operation:'background_run'}).asked(row()),{kind:'job',title:'Weekly review'});
  assert.deepEqual(await stores(null,{operation:'scheduled_trigger',messages:{}}).asked(row({event_id:RUN})),{kind:'schedule',name:'Morning brief',words:null});
  assert.equal(await stores(null,{messages:{}}).asked(row()),null);
});

test('a chat rule key reads as what it covers',()=>{
  assert.deepEqual(ruleTarget('nocheh_browser:example.com'),{what:'site',target:'example.com'});
  assert.deepEqual(ruleTarget('nocheh_browser:docs.example.com/d/abc'),{what:'file',target:'docs.example.com/d/abc'});
  assert.deepEqual(ruleTarget('nocheh_mcp:tools.example.com:'+'f'.repeat(64)),{what:'tool',target:'tools.example.com'});
  assert.deepEqual(ruleTarget('nocheh_shell:'+'f'.repeat(64)),{what:'command',target:null});
});
