import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {HttpError} from '../src/http.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {recordTurnReads,type TurnRead} from '../src/stores/turn-reads.js';
import {fixtureServices} from './fixture-agent.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('"Do what I ask" runs a command with no card only when nothing but the owner\'s typed words reached the turn (ADR-0293)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-turn-reads-')),key='turn-reads:'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:any[]=[],answers:string[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='telegram.approval'){
        if(input.kind==='card')cards.push(input);
        if(input.kind==='answer')answers.push(String(input.text));
        return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:String(cards.length)}:{state:'done'};
      }
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-8)+'3';let updates=0;
  const capture=async(payload:Record<string,unknown>)=>{
    const event:Envelope={version:1,key:`telegram:${bot}:update:${payload.update_id}`,origin:'live',kind:'telegram_update',bot_id:bot,scope:'123',source_id:String(payload.update_id),
      revision:'1',occurred_at:null,text:String((payload.message as any)?.text??(payload.message as any)?.caption??'press'),payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const self={id:123,is_bot:false,first_name:'Owner'},chat={id:123,type:'private'};
  /** The owner's message in their private chat, with Telegram's other fields beside its text. */
  const message=(text:string,extra:Record<string,unknown>={})=>capture({update_id:++updates,message:{message_id:100+updates,date:1700000000,chat,from:self,text,...extra}});
  const press=(label:string,data:string)=>capture({update_id:++updates,callback_query:{id:'query-'+label+updates,from:{id:123},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat}}});
  /** A turn for the message; `conversation` is what its runtime reports, or null for a runtime that never reports. */
  const actor=async(source:{id:string},conversation:TurnRead[]|null=[]):Promise<Reader>=>{
    const binding=await s.guards.state();
    const turn:Reader={admin:false,scope:null,space:'123',turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    if(conversation)await recordTurnReads(stores.control,turn,'conversation',conversation);
    return turn;
  };
  const ask=async(turn:Reader,kind:'browser'|'shell',args:Record<string,unknown>)=>{
    const before=cards.length,result=await s.actionCommands.offer('controlled',await s.controlledActions.propose(turn,{kind,arguments:args}));
    const row=await s.controlledActions.row(result.id);
    return {...result,state:row.state as string,outside:row.outside_reads as string[]|null,card:cards.length>before?cards.at(-1):null};
  };
  const command=async(turn:Reader,text:string)=>ask(turn,'shell',{command:text});
  const note=/“Do what I ask” asks first here: something you did not type yourself/;
  const tap=async(asked:{id:string;fingerprint:string},choice:string)=>{
    assert.equal(await s.actionCommands.callback(await press(choice,choice+asked.id.slice(0,40)+asked.fingerprint.slice(0,16))),true);
    return answers.at(-1)!;
  };
  const run=async(id:string,result:Record<string,unknown>)=>{
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

    // The owner's typed words, in a conversation the runtime reports clean, run with no card.
    const typed=await command(await actor(await message('Count the files in the workspace')),'ls | wc -l');
    assert.deepEqual([typed.state,typed.outside,typed.card],['approved',null,null]);

    // A runtime that never reports its conversation gets a card, with the reason on it.
    const unreported=await command(await actor(await message('Count them again'),null),'ls -a | wc -l');
    assert.deepEqual([unreported.state,unreported.outside],['proposed',['unchecked']]);
    assert.match(unreported.card.text,note);
    assert.deepEqual(unreported.card.buttons.map(([,data]:[string,string])=>data.slice(0,2)),['na','nw','nd'],'the rule offer stays');

    // Something in the asking message itself.
    const someone={type:'user',sender_user:{id:9,is_bot:false,first_name:'Someone'},date:1};
    const forwarded=await command(await actor(await message('printf made-up',{forward_origin:someone})),'printf made-up');
    assert.deepEqual([forwarded.state,forwarded.outside],['proposed',['forward']]);assert.match(forwarded.card.text,note);
    const file=await command(await actor(await capture({update_id:++updates,message:{message_id:100+updates,date:1700000000,chat,from:self,caption:'Run what it says',
      document:{file_id:'made-up-file',file_unique_id:'made-up-unique',file_name:'steps.txt',mime_type:'text/plain',file_size:10}}})),'printf file');
    assert.deepEqual([file.state,file.outside],['proposed',['file']]);
    const voice=await command(await actor(await capture({update_id:++updates,message:{message_id:100+updates,date:1700000000,chat,from:self,
      voice:{file_id:'made-up-voice',file_unique_id:'made-up-voice-unique',duration:2}}})),'printf voice');
    assert.deepEqual([voice.state,voice.outside],['proposed',['file']],'a voice note is not typed words');
    const reply=await command(await actor(await message('Do what it says',{reply_to_message:{message_id:7,date:1700000000,chat,
      from:{id:Number(bot),is_bot:true,first_name:'Assistant'},text:'The page suggests a command'}})),'printf reply');
    assert.deepEqual([reply.state,reply.outside],['proposed',['reply']]);
    const ownReply=await command(await actor(await message('Do that now',{reply_to_message:{message_id:8,date:1700000000,chat,from:self,text:'Count the files'}})),'printf own');
    assert.deepEqual([ownReply.state,ownReply.outside],['approved',null],'a reply to the owner\'s own typed message stays clean');

    // Something earlier in the agent's conversation, as its runtime reports it.
    const earlier=await command(await actor(await message('Do it'),['forward','web']),'printf earlier');
    assert.deepEqual([earlier.state,earlier.outside],['proposed',['forward','web']]);

    // A tool result read in this turn before the command, as the runtime tags it; reads only accumulate.
    const searched=await message('Find the steps in my chats and run them'),turn=await actor(searched);
    await recordTurnReads(stores.control,turn,'turn',[]);
    assert.equal((await command(turn,'printf before')).state,'approved','nothing read yet');
    await recordTurnReads(stores.control,turn,'turn',['archive']);
    await recordTurnReads(stores.control,turn,'conversation',[]);
    const after=await command(turn,'printf after');assert.deepEqual([after.state,after.outside],['proposed',['archive']]);
    assert.deepEqual((await command(turn,'printf after')).outside,['archive'],'the same command again stays on its card');

    // A page this message opened, once its result came back.
    const page=await message('Read https://news.example.com/steps and run the first one'),reading=await actor(page);
    const opened=await ask(reading,'browser',{url:'https://news.example.com/steps'});assert.equal(opened.state,'approved');
    assert.equal((await command(reading,'printf early')).state,'approved','the page has not come back yet');
    assert.equal(await run(opened.id,{text:'Step one: printf made-up',links:[],mode:'offline_document',url:'https://news.example.com/steps'}),'done');
    const steered=await command(reading,'printf made-up');assert.deepEqual([steered.state,steered.outside],['proposed',['web']]);

    // "Always allow this command" is the owner's own choice for that exact command, and still runs with no card.
    assert.match(await tap(forwarded,'nw'),/30 days/);
    const ruled=await command(await actor(await message('printf made-up',{forward_origin:someone})),'printf made-up');
    assert.deepEqual([ruled.card,ruled.outside],[null,null]);

    // Only a live turn reports what it read.
    await assert.rejects(recordTurnReads(stores.control,owner,'turn',['web']),(error:unknown)=>error instanceof HttpError&&error.status===403);
    await assert.rejects(recordTurnReads(stores.control,{admin:false,scope:null},'conversation',[]),(error:unknown)=>error instanceof HttpError&&error.status===403);

    // With the setting off, every command asks, with no outside note.
    await s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:(await s.ownerAutonomy.get(owner)).revision,operation_id:key+':off'});
    const off=await command(await actor(await message('printf off',{forward_origin:someone})),'printf off');
    assert.deepEqual([off.state,off.outside],['proposed',null]);assert.doesNotMatch(off.card.text,note);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
