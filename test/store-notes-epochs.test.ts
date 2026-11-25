import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {chatIdFor} from '../src/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {notesCarry} from '../src/stores/notes-epochs.js';
import {fixtureServices} from './fixture-agent.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {grantMembers} from './fixture-member-grants.js';

test('a chat keeps its Hermes notes across an epoch only when the change takes nothing away from it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-notes-epochs-')),key='notes-epochs:'+Date.now(),group='-100888';
  const owner={admin:true,scope:null},s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const capture=async(label:string,payload:any)=>{
    const value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:group,
      source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(payload.update_id),occurred_at:null,text:payload.message?.text??null,payload};
    return (await s.capture.capture(value)).source.reference;
  };
  const people=grantMembers({[group]:{granted:['7']}},{owner:'123'});
  // What Hermes asks for the owner's private chat and for a group, from one epoch to the next.
  const across=async(change:()=>Promise<unknown>)=>{
    const before=await s.guards.state();await change();const after=await s.guards.state();
    assert.equal(after.epoch,before.epoch+1,'the change moves the epoch once');
    return [await notesCarry(stores.control,after.generation,before.epoch,after.epoch,true),await notesCarry(stores.control,after.generation,before.epoch,after.epoch,false)];
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const said=await capture('said',{update_id:1,message:{message_id:1,date:1700000001,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:7},text:'A made-up plan'}});
    await s.guards.prepare(said,'fixture',s.detect);
    const start=await s.guards.state();

    // Hiding or restoring a message, a reaction and a yes to learning keep every chat's notes: Hermes leaves behind what rests on the hidden message.
    assert.deepEqual(await across(()=>s.retirements.set(owner,said.id,{retired:true,expected_revision:0,operation_id:key+':hide'})),[true,true]);
    assert.deepEqual(await across(()=>s.retirements.set(owner,said.id,{retired:false,expected_revision:1,operation_id:key+':restore'})),[true,true]);
    assert.deepEqual(await across(()=>capture('reaction',{update_id:2,message_reaction:{chat:{id:Number(group),type:'supergroup'},message_id:1,date:1700000002,
      user:{id:7},old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}})),[true,true]);
    assert.deepEqual(await across(()=>s.access.setConsent(owner,said,{enabled:true,expected_revision:0,operation_id:key+':learn'})),[true,true]);
    const kept=await s.guards.state();
    assert.equal(await notesCarry(stores.control,kept.generation,start.epoch,kept.epoch,false),true,'several kept epochs in a row carry together');

    // A project change can take something away from a group: only the owner's private chat keeps its notes. So can
    // turning a group off, which stops the project's other groups reading it; turning it on takes nothing away.
    assert.deepEqual(await across(()=>s.projects.save(owner,{name:key,description:'Made-up project',state:'active',expected_revision:0,operation_id:key+':project'})),[true,false]);
    const chat=chatIdFor('telegram',group);
    assert.deepEqual(await across(()=>s.chats.setState(owner,{chat_id:chat,state:'off',operation_id:key+':off'})),[true,false]);
    assert.deepEqual(await across(()=>s.chats.setState(owner,{chat_id:chat,state:'active',operation_id:key+':on'})),[true,true]);
    // Turning learning off, or turning safety checks off and on, starts every chat's notes fresh.
    assert.deepEqual(await across(()=>s.access.setConsent(owner,said,{enabled:false,expected_revision:1,operation_id:key+':forget'})),[false,false]);
    assert.deepEqual(await across(()=>s.guards.setMode('off')),[false,false]);
    assert.deepEqual(await across(()=>s.guards.setMode('on')),[false,false]);
    const now=await s.guards.state();
    assert.equal(await notesCarry(stores.control,now.generation,kept.epoch,now.epoch,true),false,'one fresh epoch in between stops the carry');

    // Only the current installation's settled epochs are answered.
    assert.equal(await notesCarry(stores.control,now.generation,now.epoch,now.epoch,true),true);
    assert.equal(await notesCarry(stores.control,now.generation,now.epoch,now.epoch+1,true),false,'an epoch not reached yet');
    assert.equal(await notesCarry(stores.control,now.generation,now.epoch,now.epoch-1,true),false);
    assert.equal(await notesCarry(stores.control,'22222222-2222-2222-2222-222222222222',start.epoch,kept.epoch,true),false,'another installation');

    // Hermes's lookup of what notes rest on: a notes review leaves with any message it read, and a fact the owner
    // granted a group lapses with its epoch, as the group can no longer read it.
    const review=digest(key+':review'),current=digest(key+':grant-now'),earlier=digest(key+':grant-before'),revoked=digest(key+':grant-revoked');
    await stores.control.query(`INSERT INTO native_review_jobs(id,source_reference,input_reference,binding,provenance) VALUES($1,$2,$2,'{}'::jsonb,$3)`,
      [review,JSON.stringify({id:digest(key+':reviewed')}),JSON.stringify({version:1,events:[{id:said.id}]})]);
    const grant=(id:string,binding:object,state='active')=>stores.control.query(`INSERT INTO memory_fact_grants(id,destination,fact_id,fact_revision,
      representation_reference,binding,text_hash,mode,state) VALUES($1,$2,$3,1,'{}'::jsonb,$4,$5,'persistent',$6)`,[id,group,digest(key+':fact'),JSON.stringify(binding),digest(id),state]);
    const latest=await s.guards.state();await grant(current,latest);await grant(earlier,start);await grant(revoked,now,'revoked');
    const asked=()=>s.retirements.historyRetirements([review,current,earlier,revoked]);
    assert.deepEqual(await asked().then(found=>[found.retired,found.lapsed_grants]),[[],[earlier,revoked].sort()],
      'the review read nothing hidden yet; the grant of this epoch holds; a lapsed grant is never read as retired, so stored history keeps it');
    await s.retirements.set(owner,said.id,{retired:true,expected_revision:2,operation_id:key+':hide-again'});
    assert.ok((await asked()).retired.includes(review),'the review read the hidden message');
  }finally{people();await stores.close();await rm(root,{recursive:true,force:true});}
});
