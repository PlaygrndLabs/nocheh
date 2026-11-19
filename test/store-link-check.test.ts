import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('"Do what I ask" opens only addresses no model built, at most ten a message, and rules cover a site, a shared file or a tool',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-link-check-')),key='link-check:'+Date.now(),group='-100'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:any[]=[],answers:string[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='telegram.approval'){
        if(input.kind==='card')cards.push(input);
        if(input.kind==='answer')answers.push(String(input.text));
        return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:String(cards.length)}:{state:'done'};
      }
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-8)+'7';let updates=0;
  const capture=async(payload:Record<string,unknown>,scope='123')=>{
    const event:Envelope={version:1,key:`telegram:${bot}:update:${payload.update_id}`,origin:'live',kind:'telegram_update',bot_id:bot,scope,source_id:String(payload.update_id),
      revision:'1',occurred_at:null,text:String((payload.message as any)?.text??'press'),payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  /** The owner's message in their private chat, with Telegram's other fields, such as a forward's, beside its text. */
  const message=(text:string,extra:Record<string,unknown>={})=>capture({update_id:++updates,message:{message_id:100+updates,date:1700000000,
    chat:{id:123,type:'private'},from:{id:123,first_name:'Owner'},text,...extra}});
  const press=(label:string,data:string)=>capture({update_id:++updates,callback_query:{id:'query-'+label+updates,from:{id:123},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:123,type:'private'}}}});
  const actor=async(source:{id:string}):Promise<Reader>=>{
    const binding=await s.guards.state();
    return {admin:false,scope:null,space:'123',turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const ask=async(source:{id:string},kind:'browser'|'mcp'|'shell',args:Record<string,unknown>)=>{
    const before=cards.length,result=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(source),{kind,arguments:args}));
    const row=await s.controlledActions.row(result.id);
    return {...result,state:row.state as string,free:row.free_read as string|null,card:cards.length>before?cards.at(-1):null};
  };
  const choices=(card:any)=>card.buttons.map(([,data]:[string,string])=>data.slice(0,2));
  const tap=async(asked:{id:string;fingerprint:string},choice:string)=>{
    assert.equal(await s.actionCommands.callback(await press(choice,choice+asked.id.slice(0,40)+asked.fingerprint.slice(0,16))),true);
    return answers.at(-1)!;
  };
  /** Runs an approved read to its end with the page the fake web gives. */
  const run=async(id:string,result:Record<string,unknown>={exit_code:0})=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id+'-'+updates++});
    const b={id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token},claim=await s.controlledExecution.claim(b);
    if(!claim.claimed)return (await s.controlledActions.row(id)).state;
    const start=await s.controlledExecution.start(b);
    if(start.started)await s.controlledExecution.finish({...b,state:'done',result});
    return (await s.controlledActions.row(id)).state;
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    const initial=await s.ownerAutonomy.get(owner);
    await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:initial.revision,operation_id:key+':on'});

    // A link the owner typed opens; the same link with something added, or a site the model picked, asks with its rule offer.
    const asked=await message('Summarize https://news.example.com/story?id=7 and weather in Berlin on wttr.in');
    const typed=await ask(asked,'browser',{url:'https://news.example.com/story?id=7'});
    assert.deepEqual([typed.state,typed.free,typed.card],['approved','typed',null]);
    const added=await ask(asked,'browser',{url:'https://news.example.com/story?id=7&d=made-up-private'});
    assert.equal(added.state,'proposed');assert.deepEqual(choices(added.card),['na','nc','nw','nd']);
    assert.match(added.card.text,/“Always allow this site” lets Nocheh open any page there without asking, including addresses that carry short pieces of your data\./);
    const named=await ask(asked,'browser',{url:'https://wttr.in/Berlin'});assert.deepEqual([named.state,named.free],['approved','named']);
    const built=await ask(asked,'browser',{url:'https://wttr.in/Berlin?d=made-up-private'});assert.equal(built.state,'proposed');
    const elsewhere=await ask(asked,'browser',{url:'https://search.example.net/?q=made-up-private'});assert.equal(elsewhere.state,'proposed');
    // Commands keep running under the setting.
    assert.equal((await ask(asked,'shell',{command:'printf made-up'})).state,'approved');

    // Links on a page opened for this message open too, exactly; a link that repeats a piece of what a model-built page
    // address sent does not.
    assert.equal(await run(typed.id,{text:'A story',links:['/related','https://other.example/plain'],mode:'offline_document',url:'https://news.example.com/story?id=7'}),'done');
    const related=await ask(asked,'browser',{url:'https://news.example.com/related'});assert.deepEqual([related.state,related.free],['approved','page']);
    const plain=await ask(asked,'browser',{url:'https://other.example/plain'});assert.equal(plain.free,'page');
    assert.equal((await ask(asked,'browser',{url:'https://other.example/plain?x=1'})).state,'proposed');

    // A forward from someone else: its links open only when it has at most two.
    const forward={forward_origin:{type:'user',sender_user:{id:9,first_name:'Someone'}}};
    const few=await message('https://a.example/1 https://b.example/2',forward);
    assert.equal((await ask(few,'browser',{url:'https://a.example/1'})).free,'forwarded');
    const many=await message('https://a.example/1 https://b.example/2 https://c.example/3',forward);
    assert.equal((await ask(many,'browser',{url:'https://a.example/1'})).state,'proposed');

    // Ten reads a message at most without a card, and five of them from page links.
    const list=Array.from({length:12},(_,n)=>`https://list.example/item-${n}`),long=await message('Read all: '+list.join(' '));
    const states=[];for(const url of list)states.push((await ask(long,'browser',{url})).state);
    assert.deepEqual(states,[...Array(10).fill('approved'),'proposed','proposed']);

    // Another server's tool always asks under the setting. Always allow this tool covers later calls with short input.
    const tools=await message('Use my made-up tool server');
    const first=await ask(tools,'mcp',{url:'https://tools.example/mcp',tool:'lookup',input:{city:'Berlin'}});
    assert.equal(first.state,'proposed');assert.deepEqual(choices(first.card),['na','nw','nd']);
    assert.match(first.card.text,/“Always allow this tool” lets Nocheh call it again without asking/);
    assert.match(await tap(first,'nw'),/allowed for 30 days/);
    const again=await ask(tools,'mcp',{url:'https://tools.example/mcp',tool:'lookup',input:{city:'Paris'}});
    assert.deepEqual([again.state,again.card,again.free],['proposed',null,'rule'],'the rule covers it without a card');
    const longer=await ask(tools,'mcp',{url:'https://tools.example/mcp',tool:'lookup',input:{city:'x'.repeat(201)}});
    assert.deepEqual(choices(longer.card),['na','nd'],'long input asks, with no rule to offer');
    assert.equal((await ask(tools,'mcp',{url:'https://tools.example/mcp',tool:'other',input:{}})).card?.kind,'card','another tool asks');

    // On a shared site the rule covers one file; an address carrying another address asks with no rule to offer.
    const forms=await message('Fill in the form');
    const form=await ask(forms,'browser',{url:'https://docs.google.com/forms/d/e/1FAIpQLSf-made-up-form/viewform'});
    assert.deepEqual(choices(form.card),['na','nc','nw','nd']);assert.match(form.card.buttons[2][0],/Always allow this file where asked/);
    assert.match(form.card.text,/“Always allow this file” lets Nocheh open any page of this one shared file/);
    await tap(form,'nw');
    const rule=(await stores.control.query("SELECT match_key FROM action_permissions WHERE grain='chat' AND kind='browser'")).rows.map(row=>row.match_key);
    assert.deepEqual(rule,['nocheh_browser:docs.google.com/forms/1FAIpQLSf-made-up-form']);
    assert.equal((await ask(forms,'browser',{url:'https://docs.google.com/forms/d/e/1FAIpQLSf-made-up-form/formResponse'})).card,null,'the same form');
    assert.ok((await ask(forms,'browser',{url:'https://docs.google.com/forms/d/e/1FAIpQLSf-other-form/viewform'})).card,'another form asks');
    const proxied=await ask(forms,'browser',{url:'https://proxy.example/fetch?u=https%3A%2F%2Fevil.example%2F'});
    assert.deepEqual(choices(proxied.card),['na','nd']);

    // The setting off: everything asks again, a typed link too.
    await s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:(await s.ownerAutonomy.get(owner)).revision,operation_id:key+':off'});
    const off=await message('Read https://news.example.com/off');
    assert.equal((await ask(off,'browser',{url:'https://news.example.com/off'})).state,'proposed');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
