import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {reader} from '../src/access.js';
import {machineRunRoute} from '../src/stores/machine-reads.js';
import {notionMachineRead,notionPageKey} from '../src/stores/notion.js';
import {notionPages} from '../src/stores/background-jobs.js';

const page='0123456789abcdef0123456789abcdef',other='fedcba9876543210fedcba9876543210';

test('a machine job\'s card names Notion pages by id or notion.so address, and its run fetches only those', ()=>{
  assert.equal(notionPageKey(page),page);
  assert.equal(notionPageKey('01234567-89ab-cdef-0123-456789abcdef'),page);
  assert.equal(notionPageKey('https://www.notion.so/Made-up-setup-'+page),page);
  assert.equal(notionPageKey('https://www.notion.so/cafe-'+page),page,'hex letters in the title before the id stay out');
  assert.equal(notionPageKey('https://www.notion.so/Made-up-'+page+'?p='+other),page,'a peek in the query names another page, never this one');
  assert.equal(notionPageKey('collection://'+page),page);
  assert.equal(notionPageKey('no id here'),null);
  const pages=['https://www.notion.so/Made-up-setup-'+page];
  assert.ok(notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page}},pages),'by its raw id');
  assert.ok(notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:'https://notion.so/'+page}},pages));
  assert.ok(notionMachineRead({operation:'list'},pages),'the list of tools reads no page');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:other}},pages),'a page the card did not name');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:'https://www.notion.so/Made-up-'+other+'?p='+page}},pages));
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-search',input:{query:'setup'}},pages),'no search');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page,url:'https://evil.example/'}},pages),'nothing rides along');
  assert.ok(!notionMachineRead({operation:'call',tool:'notion-fetch',input:{id:page}},[]));
  // What a card may name: 1 to 5 of the owner's own pages, each as a job's fetch takes it.
  assert.deepEqual(notionPages([page,' '+page+' ','https://www.notion.so/Made-up-'+other]),[page,'https://www.notion.so/Made-up-'+other]);
  for(const value of [[],Array(6).fill(page),['https://made-up.notion.site/'+page],['user://'+page],[''],[7],page])
    assert.throws(()=>notionPages(value),{code:'invalid_job_request'},JSON.stringify(value));
});

test('a machine job\'s run reaches only the routes that read its card\'s chat, its commands and its own cards', ()=>{
  for(const [method,path] of <[string,string][]>[['GET','/v1/search'],['GET','/v1/archive/page'],['GET','/v1/events/'+'a'.repeat(64)],['GET','/v1/artifacts/'+'a'.repeat(64)+'/bytes'],
    ['GET','/v1/imports/pending'],['GET','/v1/memory/context'],['GET','/v1/tools/actions'],['GET','/v1/notion/connections'],['POST','/v1/context/prepare'],
    ['POST','/v1/memory/longterm/search'],['POST','/v1/memory/longterm/context'],['POST','/v1/machines/exec'],['POST','/v1/tools/propose'],['POST','/v1/action-requests']])
    assert.ok(machineRunRoute(method,path),method+' '+path);
  for(const [method,path] of <[string,string][]>[['POST','/v1/memory/recall'],['GET','/v1/owner/people'],['GET','/v1/owner/tasks'],['POST','/v1/owner/tasks'],['GET','/v1/telegram/destinations'],
    ['GET','/v1/memory/notes/'+'a'.repeat(12)],['GET','/v1/memory/grants/'+'a'.repeat(64)],['GET','/v1/memory/facts/'+'a'.repeat(64)],['GET','/v1/knowledge/context'],
    ['POST','/v1/member-asks'],['POST','/v1/jobs/start'],['POST','/v1/schedules/turn'],['GET','/v1/github/repos'],['GET','/v1/search/../owner/people'],['DELETE','/v1/search']])
    assert.ok(!machineRunRoute(method,path),method+' '+path);
});

test('what a machine job\'s run reads comes from storage, never from its pass', ()=>{
  const secret='s'.repeat(32),now=Date.now();
  const pass=(claims:Record<string,unknown>)=>{
    // A one-time key's claims (ADR-0305), so the refusal below is for the machine claim.
    const body=Buffer.from(JSON.stringify({scope:null,expires:now+60000,event_id:'e'.repeat(64),audience:'nocheh-assistant',agent:'hermes',person:'owner',
      jti:'f'.repeat(32),key_kind:'background',logical_profile:'job-synthetic',generation:'00000000-0000-4000-8000-000000000001',...claims})).toString('base64url');
    return {headers:{authorization:'Bearer turn.'+body+'.'+createHmac('sha256',secret).update(body).digest('base64url')}} as unknown as IncomingMessage;
  };
  assert.equal(reader(pass({}),secret,now).machineReads,undefined);
  for(const claim of ['machine_reads','machineReads'])
    assert.throws(()=>reader(pass({[claim]:{job:'j',chat:'123',from:null,to:null,until:'999999',notion:[]}}),secret,now),{code:'invalid_scope_token'},claim);
});
