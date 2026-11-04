import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {brokerServer,scopedRoute} from '../src/security/broker.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {validFromEpoch} from '../src/stores/guards.js';
import {JobBoxRepository,boxTokenValid} from '../src/stores/job-box.js';
import {notionJobFetch,notionReads} from '../src/stores/notion.js';
import {storageServer} from '../src/stores/server.js';
import {storageServices} from '../src/stores/services.js';

test('only the owner\'s approved private job gets the sealed box, its binding and live list follow the job, the guard and the switch, and its chat copy is the job\'s own checked chat, whole',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:600000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-box-')),key='job-box:'+Date.now(),group='-100888',other='-100999';
  const token=digest(key),boxToken='synthetic-box-token-'+'b'.repeat(24),owner:Reader={admin:true,scope:null};
  const previousBox=process.env.NOCHEH_BOX_TOKEN;process.env.NOCHEH_BOX_TOKEN=boxToken;
  const policy={enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {costs:[0.5]};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },honcho:async()=>{throw Error('no memory provider');}});
  const relayed:string[]=[];let refuse=(_url:string):Response|null=>null;
  const mock:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000});
    relayed.push(String(url));return refuse(String(url))??fetch(url,init);
  };
  const archive=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy} as unknown as Settings,async()=>({}));
  await new Promise<void>(resolve=>archive.listen(0,'127.0.0.1',resolve));
  const archiveBase='http://127.0.0.1:'+(archive.address() as {port:number}).port;
  const broker=brokerServer({pool:stores.control,storage:s.turns,token,archive:archiveBase,hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(s),fetch:mock});
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  const brokerBase='http://127.0.0.1:'+(broker.address() as {port:number}).port;
  const get=async(base:string,path:string,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{headers});return {status:response.status,body:await response.json() as any};
  };
  const post=async(path:string,credential:string,body:unknown)=>{
    const response=await fetch(brokerBase+path,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  let sent=100;
  const message=async(chat:string,from:number,text:string,at?:number,checked=true)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',
      occurred_at:at===undefined?null:String(at),text,payload:{update_id:id,message:{message_id:id,date:at??1700000000+id,
        chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}}};
    const source=(await s.capture.capture(event)).source.reference;if(checked)await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const react=async(chat:string,target:number,user:number,at?:number)=>{
    const id=++sent,before=(await s.guards.state()).epoch;
    const {source}=await s.capture.capture({version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(target),revision:String(id),
      occurred_at:at===undefined?null:String(at),text:null,payload:{update_id:id,message_reaction:{chat:{id:Number(chat),type:'supergroup'},message_id:target,
        date:at??1700000000+id,user:{id:user},old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}}});
    assert.equal((await s.guards.state()).epoch,before+1,'a reaction starts a quiet epoch');
    await s.guards.prepare(source.reference,'fixture',s.detect);
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const latest=async(id:string)=>(await stores.control.query('SELECT event_id FROM background_steps WHERE job_id=$1 ORDER BY step DESC,attempt DESC LIMIT 1',[id])).rows[0].event_id as string;
  const period={chat:group,from:'2026-01-10',to:'2026-01-12'};
  const ask=async(title:string,box?:boolean)=>s.jobs.start(await actor((await message('123',123,'Read the made-up group')).id,null,'123'),
    {title,instruction:'List the made-up tasks the group agreed on.',...period,...(box===undefined?{}:{box})});
  /** Run a job's latest step and read its context; `claim` also claims that step and returns its credential. */
  const run=async(id:string,claim:boolean)=>{
    const step=await latest(id);await s.jobs.steps.run(step,await authority());
    const context:any=await s.jobs.steps.context({event_id:step,owner_epoch:(await authority()).epoch});
    const claimed:any=claim?await s.jobs.steps.claim({...context,actor:context.actor}):null;
    return {step,context,claimed,credential:String(claimed?.archive_credential??'')};
  };
  /** Approve a job, start it, and run its first step. */
  const start=async(job:{id:string;fingerprint:string},claim:boolean)=>{
    await s.jobs.decide('123',{id:job.id,fingerprint:job.fingerprint,decision:'approve'},await message('123',123,'Approve'));
    await tick(job.id);return run(job.id,claim);
  };
  const live=async()=>(await get(brokerBase,'/v1/box/live',{authorization:'Bearer '+boxToken})).body.boxes as any[];
  const bindingBox=async(credential:string)=>{const binding=await get(brokerBase,'/v1/security/binding',{authorization:'Bearer '+credential});assert.equal(binding.status,200);return binding.body.box;};
  const copy=(credential:string,cursor='',extra:Record<string,string>={})=>get(brokerBase,'/v1/box/chat'+(cursor?'?cursor='+cursor:''),
    {authorization:'Bearer '+credential,'x-nocheh-box-token':boxToken,...extra});
  const saveNotion=async(change:Record<string,unknown>)=>s.notion.save(owner,{...change,expected_revision:(await s.notion.get(owner)).revision});
  const switchBox=async(on:boolean)=>s.jobs.saveSettings(owner,{...await s.jobs.settings(),box_tools:on});
  const boxTime=async(id:string,minutes:number)=>stores.control.query("UPDATE background_jobs SET started_at=now()-($2::integer+minutes_limit)*interval '1 minute' WHERE id=$1",[id,minutes]);
  const expiresOf=async(id:string)=>{const row=(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
    return new Date(row.started_at.getTime()+(row.minutes_limit+60)*60000).toISOString();};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy,'on');
    // The group's chat in the job's period: 205 short messages, one of 5,000 characters, three of 250,000, a reaction, one still being checked
    // and one of 1,200,005 characters that JSON doubles.
    const day=Date.UTC(2026,0,10,8)/1000;
    const firstId=sent+1,first=await message(group,9,'Alice: hello 0',day);
    for(let i=1;i<205;i++)await message(group,9,'Alice: hello '+i,day+i);
    const long='Alice: '+'a'.repeat(4993);await message(group,9,long,day+300);
    for(let i=0;i<3;i++)await message(group,9,'Bob: '+String(i).repeat(249995),day+301+i);
    await react(group,firstId,7,day+304);
    await message(group,9,'Alice: still being checked',day+305,false);
    const huge='Bob: '+'"\\\n'.repeat(400000);await message(group,9,huge,day+306);
    await message(group,9,'Bob: outside the period',day-5*86400);
    const otherId=sent+1;await message(other,9,'Carol: another chat',day+10);
    await message('123',123,'Owner: a private note',day+11);

    // Only the owner's own job, asked in their private chat, may ask for the box, and only while the switch is on.
    assert.equal((await s.jobs.settings()).box_tools,true,'the sealed box is on by default');
    const boxed=await ask('Box task check',true);
    assert.equal(boxed.box,true);
    const card=(await s.jobs.card(boxed.id)).text;
    assert.match(card,/\n🧰 It can run commands and Python in a sealed box: no internet, no keys, only the checked messages of the chat it reads\.\n/);
    const plain=await ask('Plain task check');
    assert.equal(plain.box,false);assert.doesNotMatch((await s.jobs.card(plain.id)).text,/🧰/,'a job without the box says nothing about it');
    // A saved card without the Notion or box line still shows that line, at its end, before the owner approves.
    await saveNotion({enabled:true});
    const notionLine='📒 It can read your Notion without asking. Changes still ask you.',boxLine='🧰 It can run commands and Python in a sealed box: no internet, no keys, only the checked messages of the chat it reads.';
    const savedCard=async(text:string)=>stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'background.card':text})]);
    await savedCard('Made-up card: {title}\n\n{instruction}');
    assert.equal((await s.jobs.card(boxed.id)).text,'Made-up card: Box task check\n\nList the made-up tasks the group agreed on.\n\n'+notionLine+'\n'+boxLine);
    assert.equal((await s.jobs.card(plain.id)).text,'Made-up card: Plain task check\n\nList the made-up tasks the group agreed on.\n\n'+notionLine);
    await savedCard('Made-up card: {title}\n🧰 {box}\n\n{instruction}');
    assert.equal((await s.jobs.card(boxed.id)).text,'Made-up card: Box task check\n'+boxLine+'\n\nList the made-up tasks the group agreed on.\n\n'+notionLine,'a line the card has stays in its place');
    // A line the card leaves out for another missing value still shows its own value at the end.
    await savedCard('Made-up card: {title}\n📒 {notion} · 🧰 {box}\n\n{instruction}');
    assert.equal((await s.jobs.card(boxed.id)).text,'Made-up card: Box task check\n'+notionLine+' · '+boxLine+'\n\nList the made-up tasks the group agreed on.');
    assert.equal((await s.jobs.card(plain.id)).text,'Made-up card: Plain task check\n\nList the made-up tasks the group agreed on.\n\n'+notionLine,'no box: the Notion line is added');
    await saveNotion({enabled:false});
    assert.equal((await s.jobs.card(boxed.id)).text,'Made-up card: Box task check\n\nList the made-up tasks the group agreed on.\n\n'+boxLine,'no Notion reads: the box line is added');
    assert.equal((await s.jobs.card(plain.id)).text,'Made-up card: Plain task check\n\nList the made-up tasks the group agreed on.','a line without a value is not added');
    await stores.control.query("UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton");
    assert.notEqual(plain.fingerprint,boxed.fingerprint);
    const again=await message('123',123,'Read it again');
    const same=async(box:boolean)=>s.jobs.start(await actor(again.id,null,'123'),{title:'Same request',instruction:'List the made-up tasks.',...period,box});
    await same(true);
    await assert.rejects(same(false),{code:'job_changed'},'the box is part of what the owner approves');
    await assert.rejects(s.jobs.start(await actor((await message(group,9,'Run it here')).id,group,group),{title:'Member box',instruction:'Read it.',box:true}),
      {code:'job_box_not_allowed'},'a member\'s job never gets the box');
    await assert.rejects(s.jobs.start(await actor((await message(group,123,'Run it here too')).id,group,group),{title:'Group box',instruction:'Read it.',box:true}),
      {code:'job_box_not_allowed'},'nor does the owner\'s job asked in a group');
    await assert.rejects(ask('Odd box','yes' as unknown as boolean),{code:'invalid_job_request'});
    // The switch saves with the limits: over the revision they were changed from, and it moves the revision on.
    const before=await s.jobs.settings(),{revision:_revision,...unrevised}=before;
    await assert.rejects(s.jobs.saveSettings(owner,{...before,box_tools:'no'}),{code:'invalid_settings'});
    await assert.rejects(s.jobs.saveSettings(owner,{...unrevised,box_tools:false}),{code:'invalid_settings'},'never without the revision');
    await assert.rejects(s.jobs.saveSettings(owner,{box_tools:false,revision:before.revision}),{code:'invalid_settings'},'never without the limits');
    await assert.rejects(s.jobs.saveSettings(owner,{...before,box_tools:false,revision:before.revision-1}),{code:'configuration_conflict'});
    const off=await switchBox(false);
    assert.equal(off.box_tools,false);assert.equal(off.revision,before.revision+1);
    await assert.rejects(s.jobs.saveSettings(owner,{cost_limit_usd:5,minutes_limit:60,member_daily_jobs:3,revision:before.revision}),{code:'configuration_conflict'},
      'a limits edit from before the switch changed does not save over it');
    await assert.rejects(ask('Switched off',true),{code:'job_box_not_allowed'},'never dropped without a word');
    const limits=await s.jobs.settings();
    assert.equal((await s.jobs.saveSettings(owner,{cost_limit_usd:5,minutes_limit:60,member_daily_jobs:3,revision:limits.revision})).box_tools,false,'the limits leave the switch');
    // The dashboard saves the switch with the limits: one save, one revision.
    const both=await s.jobs.saveSettings(owner,{cost_limit_usd:5,minutes_limit:60,member_daily_jobs:4,box_tools:true,revision:limits.revision+1});
    assert.deepEqual([both.box_tools,both.member_daily_jobs,both.revision],[true,4,limits.revision+2]);

    // The box job's step: its context, step text and binding carry the box; a plain job's do not.
    const a=await start(boxed,true);
    assert.equal(a.context.background.box,true);assert.match(a.claimed!.text,/\[Sealed box\]\nIn this step your terminal, file and execute_code tools run/);
    assert.match(a.claimed!.text,/Records within a part are oldest first, but a later part can hold older records that finished their secret check later: sort by the at field/);
    assert.match(a.claimed!.text,/Reaction updates are left out; an imported message keeps the reactions it was exported with\./);
    assert.match(a.claimed!.text,/When the manifest says full, \/chat ran out of room: the copy stays partial for good/);
    const n=await start(plain,false);
    assert.equal(n.context.background.box,false);
    const nClaimed:any=await s.jobs.steps.claim({...n.context,actor:n.context.actor});assert.doesNotMatch(nClaimed.text,/Sealed box/);
    const binding=await get(brokerBase,'/v1/security/binding',{authorization:'Bearer '+a.credential});
    assert.equal(binding.status,200);
    const state=await s.guards.state();
    assert.deepEqual(binding.body.box,{job:boxed.id,chat:group,from:'2026-01-10T00:00:00.000Z',to:'2026-01-13T00:00:00.000Z',generation:state.generation,mode:'on',
      valid_from_epoch:await validFromEpoch(stores.control,state),expires:await expiresOf(boxed.id)});
    assert.equal(await bindingBox(nClaimed.archive_credential),null,'a job without the box gets none');
    await switchBox(false);
    assert.equal(await bindingBox(a.credential),null,'switched off, a running job gets no box at its next step');
    assert.deepEqual(await live(),[]);
    assert.deepEqual(await copy(a.credential),{status:403,body:{error:'job_box_not_allowed'}});
    await switchBox(true);

    // The live list: the box token only, compared whole; unset or short refuses everything.
    assert.deepEqual(await live(),[{job:boxed.id,generation:state.generation,mode:'on',valid_from_epoch:binding.body.box.valid_from_epoch,expires:binding.body.box.expires}]);
    for(const authorization of [undefined,'Bearer '+token,'Bearer '+boxToken.slice(0,-1)+'c','Bearer '+boxToken+'c',boxToken,'Bearer '+a.credential])
      assert.equal((await get(brokerBase,'/v1/box/live',authorization===undefined?{}:{authorization})).status,403,String(authorization).slice(0,12));
    assert.ok(boxTokenValid(boxToken)&&!boxTokenValid(boxToken.toUpperCase())&&!boxTokenValid(undefined)&&!boxTokenValid(boxToken,boxToken.slice(0,31)));
    process.env.NOCHEH_BOX_TOKEN='short-made-up-token';
    assert.equal((await get(brokerBase,'/v1/box/live',{authorization:'Bearer short-made-up-token'})).status,403,'a short token is no token');
    const request={title:'Made-up box job',instruction:'Count the made-up tasks.',box:true};
    for(const unset of [true,false]) {
      if(unset)delete process.env.NOCHEH_BOX_TOKEN;
      assert.equal(await bindingBox(a.credential),null,'without the box token no step gets a box');
      relayed.length=0;
      assert.deepEqual(await post('/v1/jobs/start',a.credential,request),{status:409,body:{error:'job_box_not_allowed'}},'nor may a job ask for one');
      assert.deepEqual(relayed,[]);
      process.env.NOCHEH_BOX_TOKEN='short-made-up-token';
    }
    delete process.env.NOCHEH_BOX_TOKEN;
    assert.equal((await get(brokerBase,'/v1/box/live',{authorization:'Bearer '+boxToken})).status,403,'an unset token refuses');
    assert.equal((await copy(a.credential)).status,403);
    process.env.NOCHEH_BOX_TOKEN=boxToken;
    assert.equal((await bindingBox(a.credential))?.job,boxed.id);

    // A job request through the broker says what to correct; any other refusal stays opaque.
    relayed.length=0;
    assert.deepEqual(await post('/v1/jobs/start',a.credential,request),{status:403,body:{error:'job_in_a_job'}},'with the token the request reaches storage');
    assert.equal(relayed.length,1);
    assert.deepEqual(await post('/v1/jobs/stop',a.credential,{id:boxed.id}),{status:403,body:{error:'job_in_a_job'}},'nor stop one, its own included');
    refuse=url=>url.includes('/v1/jobs/status')?Response.json({error:'made_up_refusal'},{status:409}):url.includes('/v1/archive/page')?Response.json({error:'job_not_found'},{status:404}):
      url.includes('/v1/jobs/stop')?Response.json({error:'job_box_not_allowed',padding:'x'.repeat(5000)},{status:409}):null;
    assert.deepEqual(await post('/v1/jobs/status',a.credential,{}),{status:409,body:{error:'scoped_archive_unavailable'}},'a code off the list');
    assert.deepEqual(await post('/v1/jobs/stop',a.credential,{id:boxed.id}),{status:409,body:{error:'scoped_archive_unavailable'}},'an answer past the bound');
    assert.deepEqual(await get(brokerBase,'/v1/archive/page?chat='+group,{authorization:'Bearer '+a.credential}),{status:404,body:{error:'scoped_archive_unavailable'}},'a read other than a job request');
    // Storage's box refusal reaches the job, and so does a job proposed again with only the box changed.
    for(const code of ['job_box_not_allowed','job_changed','job_too_long']) {
      refuse=url=>url.includes('/v1/jobs/start')?Response.json({error:code},{status:409}):null;relayed.length=0;
      assert.deepEqual(await post('/v1/jobs/start',a.credential,{title:'Made-up job',instruction:'Count the made-up tasks.'}),{status:409,body:{error:code}},code);
      assert.equal(relayed.length,1);
    }
    // The box's chat copy streams at most 8 MiB, the most the launcher reads.
    const sized=(bytes:number)=>'{"records":[],"padding":"'+'x'.repeat(bytes-27)+'"}';
    for(const bytes of [8*1024*1024,8*1024*1024+1]) {
      assert.equal(Buffer.byteLength(sized(bytes)),bytes);
      refuse=url=>url.includes('/v1/box/chat')?new Response(sized(bytes),{headers:{'content-type':'application/json'}}):null;relayed.length=0;
      if(bytes===8*1024*1024)assert.equal((await copy(a.credential)).status,200);else await assert.rejects(copy(a.credential),'a longer copy is cut off');
      assert.equal(relayed.length,1);
    }
    refuse=()=>null;

    // The chat copy: the step's credential and the box token, never an owner credential, a plain job or a chosen chat.
    assert.equal(scopedRoute('GET','/v1/box/chat'),false,'the copy is no relayed archive route');
    assert.equal((await get(brokerBase,'/v1/box/chat',{authorization:'Bearer '+a.credential})).status,403,'the step credential alone is not enough');
    assert.equal((await copy(a.credential,'',{'x-nocheh-box-token':'x'.repeat(40)})).status,403);
    assert.deepEqual(await copy(token),{status:403,body:{error:'job_box_not_allowed'}},'never with the owner credential');
    relayed.length=0;
    assert.deepEqual(await copy(nClaimed.archive_credential),{status:403,body:{error:'job_box_not_allowed'}},'a job without the box has no copy');
    assert.deepEqual(relayed,[],'the broker checks the box binding itself, before storage');
    assert.equal((await get(brokerBase,'/v1/box/chat?chat='+other,{authorization:'Bearer '+a.credential,'x-nocheh-box-token':boxToken})).status,400);
    assert.deepEqual(await get(archiveBase,'/v1/box/chat',{authorization:'Bearer '+token}),{status:403,body:{error:'job_box_not_allowed'}},'storage refuses an owner credential too');
    const boxes=new JobBoxRepository(s.access),step=reader({headers:{authorization:'Bearer '+a.credential}} as IncomingMessage,token),turn=await s.turns.binding(step);
    await assert.rejects(boxes.chat(owner,turn,s.sources,''),{code:'job_box_not_allowed'},'and so does the box copy itself');
    const pages:any[]=[];let cursor='';
    const prepared=async()=>(await stores.derived.query('SELECT count(*)::integer AS n FROM runtime_prepared_values')).rows[0].n as number,preparedBefore=await prepared();
    for(;;) {
      const page=await copy(a.credential,cursor);assert.equal(page.status,200,JSON.stringify(page.body));pages.push(page.body);
      assert.ok(JSON.stringify(page.body.records).length<=600000||page.body.records.length===1,'a page holds at most 600,000 characters');
      if(page.body.complete)break;cursor=page.body.next;
    }
    assert.equal(await prepared(),preparedBefore,'the copy is no prepared value that later model calls load');
    assert.deepEqual(pages.map(page=>page.records.length),[200,8,1,1],'200 records a page, or fewer when the next would pass 600,000 characters');
    assert.deepEqual(pages.map(page=>page.checking),[0,0,1,0],'a message still being checked is left out and counted');
    assert.deepEqual(pages.map(page=>page.complete),[false,false,false,true]);assert.equal(pages.at(-1).next,null);
    const records=pages.flatMap(page=>page.records),texts=records.map(record=>record.text);
    assert.equal(texts[0],'Alice: hello 0');assert.equal(texts[204],'Alice: hello 204');
    assert.equal(texts[205],long,'no 1,500-character cut');assert.equal(texts[208].length,250000);
    assert.ok(records.slice(0,-1).every(record=>record.type==='message'&&!record.truncated&&!record.checking),'no reactions, cuts or unchecked records');
    // The huge message: cut to one record's 600,000 characters with a note, so its page stays far within the 8 MiB the broker and launcher read.
    const cutText=records.at(-1).text as string,note=cutText.match(/\n\[… ([\d,]+) more characters cut from this copy\]$/);
    assert.equal(records.at(-1).truncated,true);assert.ok(cutText.length<=600000&&cutText.length>599900,String(cutText.length));
    assert.ok(note&&huge.startsWith(cutText.slice(0,note.index)),'the start of the message, then the note');
    assert.equal(Number(note![1]!.replaceAll(',','')),huge.length-note!.index!);
    const bytes=Buffer.byteLength(JSON.stringify(pages.at(-1)));assert.ok(bytes<8*1024*1024&&bytes>1000000,String(bytes));
    assert.ok(!texts.some(text=>/outside the period|another chat|a private note|still being checked/.test(text)),'only the job\'s own chat and period');
    const normal=await s.sources.page(step,{...period,after:pages[1].next,count:50});
    assert.ok(await prepared()>preparedBefore,'an ordinary page is still a prepared value');
    assert.deepEqual(normal.items.map((item:any)=>item.type),['message','reaction','message','message'],'an ordinary page shows the reaction');
    assert.equal((normal.items[2] as any).checking,true);assert.equal((normal.items[0] as any).text.length,1500);

    // Other relayed reads lose any `full` key.
    relayed.length=0;
    assert.equal((await get(brokerBase,'/v1/archive/page?chat='+group+'&full=1&limit=5',{authorization:'Bearer '+a.credential})).status,200);
    assert.equal(relayed.length,1);assert.doesNotMatch(relayed[0]!,/full/);assert.match(relayed[0]!,/limit=5/);

    // Notion in a job step: only the known read tools skip the card, and a fetch only by id or notion.so address.
    assert.ok(notionReads('notion-search')&&notionReads('notion-fetch')&&notionReads('notion-get-users'));
    assert.ok(!notionReads('notion-ai-search')&&!notionReads('notion-get-file-download-urls')&&!notionReads('notion-list-made-up'));
    const id='0123456789abcdef0123456789abcdef',uuid='01234567-89ab-cdef-0123-456789abcdef';
    for(const target of [id,uuid,'https://www.notion.so/Made-up-'+id,'https://notion.so/'+id+'?v=1','collection://'+uuid,'view://'+uuid])
      assert.equal(notionJobFetch({id:target}),true,target);
    for(const target of ['https://made-up.notion.site/Page-'+id,'https://www.notion.so.example.test/'+id,'https://www.notion.so@example.test/'+id,
      'http://www.notion.so/'+id,'collection://made-up','made-up-page'])assert.equal(notionJobFetch({id:target}),false,target);
    assert.equal(notionJobFetch({id,url:'https://example.test'}),false,'no other address rides along');
    await saveNotion({enabled:true});
    const notion=async(tool:string,input:Record<string,unknown>)=>(await s.controlledActions.propose(step,{kind:'mcp',arguments:{connection:'notion',tool,input}})).state;
    assert.equal(await notion('notion-fetch',{id}),'approved');
    assert.equal(await notion('notion-fetch',{id:'https://www.notion.so/Made-up-'+id}),'approved');
    assert.equal(await notion('notion-fetch',{id:'https://made-up.notion.site/Page-'+id}),'proposed','another address asks');
    assert.equal(await notion('notion-get-file-download-urls',{ids:[id]}),'proposed','a tool not on the read list asks');
    await saveNotion({enabled:false});

    // Past the box's time, a step runs as a plain step: no box in its binding, its context or the live list.
    const contextOf=async(step:string)=>((await s.jobs.steps.context({event_id:step,owner_epoch:(await authority()).epoch})) as any).background.box;
    await boxTime(boxed.id,59);
    assert.equal(await contextOf(a.step),true,'the box lasts the time limit and an hour more');assert.equal((await bindingBox(a.credential))?.job,boxed.id);
    assert.equal((await live()).length,1);
    await boxTime(boxed.id,61);
    assert.equal(await contextOf(a.step),false);assert.equal(await bindingBox(a.credential),null);assert.deepEqual(await live(),[]);
    assert.equal(await boxes.binding(turn),null);
    await stores.control.query('UPDATE background_jobs SET started_at=now() WHERE id=$1',[boxed.id]);assert.equal(await contextOf(a.step),true);

    // The step ends at the time limit: the report written at the limit gets no box, though the box's own time is not up.
    assert.equal((await boxes.binding(turn))?.job,boxed.id);
    await s.jobs.steps.finish({event_id:a.step,actor:a.context.actor,state:'done',session:a.context.conversation,error_code:null,text:'Read part one.',continue:true,todo:[],cost_usd:0.1});
    await boxTime(boxed.id,1);await tick(boxed.id);
    const wrap=await latest(boxed.id);await s.jobs.steps.run(wrap,await authority());
    const wrapContext:any=await s.jobs.steps.context({event_id:wrap,owner_epoch:(await authority()).epoch});
    assert.equal(wrapContext.background.kind,'wrap_up');assert.equal(wrapContext.background.box,false,'the report at a limit is no box step');
    const wrapClaimed:any=await s.jobs.steps.claim({...wrapContext,actor:wrapContext.actor});assert.doesNotMatch(wrapClaimed.text,/Sealed box/);
    assert.equal(await bindingBox(wrapClaimed.archive_credential),null);
    assert.deepEqual((await live()).map(box=>box.job),[boxed.id],'the box may stay until its time is up');
    await s.jobs.steps.finish({event_id:wrap,actor:wrapContext.actor,state:'done',session:wrapContext.conversation,error_code:null,text:'Report: made-up task 3 is open.',continue:false,todo:[],cost_usd:0.1});
    // The job reports: no box any more, and it leaves the live list.
    assert.equal((await tick(boxed.id)).stage,'delivery');
    assert.equal((await stores.control.query('SELECT state FROM background_jobs WHERE id=$1',[boxed.id])).rows[0].state,'reporting');
    assert.equal(await boxes.binding(turn),null,'a reporting job is no box job');assert.deepEqual(await live(),[]);
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=(SELECT action_id FROM background_reports WHERE job_id=$1)",[boxed.id]);
    assert.equal((await tick(boxed.id)).state,'completed');assert.deepEqual(await live(),[]);
    await s.jobs.stop(await actor((await message('123',123,'Stop the plain job')).id,null,'123'),{id:plain.id});
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1",[plain.id]);await tick(plain.id);

    // A second box job, not yet claimed: its copy stays good across reactions, and a hide starts it over.
    const second=await ask('Second box check',true),b=await start(second,false);
    assert.equal(b.context.background.box,true);
    const listed=await live();assert.deepEqual(listed.map(box=>box.job),[second.id]);
    const from=listed[0].valid_from_epoch;
    await react(other,otherId,11);await react(other,otherId,12);
    assert.equal((await live())[0].valid_from_epoch,from,'reactions keep the copy');
    assert.equal(await validFromEpoch(stores.control,await s.guards.state()),from);
    await s.retirements.set(owner,first.id,{retired:true,expected_revision:0,operation_id:key+':hide'});
    const hidden=await s.guards.state();
    assert.equal((await live())[0].valid_from_epoch,hidden.epoch,'a hide is no reaction: the copy is filled again');
    await react(other,otherId,13);assert.equal((await live())[0].valid_from_epoch,hidden.epoch);

    // Guard off: no box and no copy anywhere, also for a box job whose step starts while it is off.
    await s.guards.setMode('off');
    assert.deepEqual(await live(),[]);
    assert.equal(await boxes.binding({owner:true,job:second.id,logical_profile:'job-'+second.id.slice(0,24),reference:{store:'control',kind:'operation',id:b.step} as any}),null);
    await assert.rejects(s.sources.page(await actor((await message('123',123,'Read it plain')).id,null,'123'),{...period,after:'',count:200,whole:true}),{code:'job_box_guard_off'});
    const third=await ask('Unguarded box check',true),c=await start(third,true);
    assert.equal(c.context.background.box,false);assert.equal(await bindingBox(c.credential),null);
    relayed.length=0;
    assert.deepEqual(await copy(c.credential),{status:403,body:{error:'job_box_not_allowed'}},'the broker gives no copy with the guard off');assert.deepEqual(relayed,[]);
    // This archive server is set up for the guard on and refuses everything now; its box copy refuses on its own.
    const unguarded=reader({headers:{authorization:'Bearer '+c.credential}} as IncomingMessage,token);
    await assert.rejects(boxes.chat(unguarded,await s.turns.binding(unguarded),s.sources,''),{code:'job_box_not_allowed'},'nor does storage');
    await s.guards.setMode('on');
    assert.deepEqual((await live()).map(box=>box.job),[second.id,third.id].sort());
    await s.jobs.stop(await actor((await message('123',123,'Stop the box job')).id,null,'123'),{id:second.id});
    assert.deepEqual((await live()).map(box=>box.job),[third.id],'a stopping job has no box');
    await s.jobs.stop(await actor((await message('123',123,'Stop the other box job')).id,null,'123'),{id:third.id});
    assert.deepEqual(await live(),[]);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=ANY($1)",[[second.id,third.id]]);await tick(second.id);await tick(third.id);

    // A box job whose steps find no box fails saying so, not as a managed execution failure.
    const fourth=await ask('Boxless box check',true);let failing=await start(fourth,true);
    for(let attempt=1;;attempt++) {
      await s.jobs.steps.finish({event_id:failing.step,actor:failing.context.actor,state:'failed',session:failing.context.conversation,error_code:'job_box_unavailable',text:'',continue:false,todo:[],cost_usd:0});
      await tick(fourth.id);if(attempt>2)break;failing=await run(fourth.id,true);
    }
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM background_jobs WHERE id=$1',[fourth.id])).rows[0],{state:'failed',error_code:'job_box_unavailable'});
    assert.deepEqual(await live(),[]);
  } finally {
    if(previousBox===undefined)delete process.env.NOCHEH_BOX_TOKEN;else process.env.NOCHEH_BOX_TOKEN=previousBox;
    broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    archive.closeAllConnections();await new Promise<void>(resolve=>archive.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
