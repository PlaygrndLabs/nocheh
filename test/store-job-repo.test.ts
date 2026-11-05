import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {backgroundCard} from '../src/prompts.js';
import {brokerServer,jobErrors} from '../src/security/broker.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {storageServer} from '../src/stores/server.js';
import {storageServices} from '../src/stores/services.js';

// The job tool's own list of codes it may relay; the broker relays exactly these.
test('the broker relays the job codes the job tool names, the GitHub copy\'s among them',()=>{
  const places=[new URL('../../services/hermes/archive_tools.py',import.meta.url).pathname,join(process.env.PYTHONPATH??'/nonexistent','services/hermes/archive_tools.py')];
  const source=readFileSync(places.find(place=>existsSync(place))!,'utf8'),tuple=source.match(/^JOB_ERRORS=\(([^)]*)\)$/m);
  assert.ok(tuple,'JOB_ERRORS is one tuple line');
  assert.deepEqual([...jobErrors].sort(),[...tuple[1]!.matchAll(/'([a-z_]+)'/g)].map(match=>match[1]!).sort());
  assert.ok(jobErrors.has('job_repo_not_allowed'));
});

test('a box job pins a GitHub copy the owner made: start, card, runs and binding read the pin, and Remove withdraws what has not started',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:900000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-repo-')),key='job-repo:'+Date.now(),group='-100777',other='-100778';
  const token=digest(key),boxToken='synthetic-box-token-'+'r'.repeat(24),owner:Reader={admin:true,scope:null};
  const previousBox=process.env.NOCHEH_BOX_TOKEN;process.env.NOCHEH_BOX_TOKEN=boxToken;
  const policy={enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const};
  const cards:Record<string,any>[]=[];let checks=0;
  // A card being posted can run something first, as a Remove that lands while Telegram answers; a settle that reaches the
  // gateway before its card was sent is not shown, as the gateway answers edited:false without a sent receipt.
  let posting:{id:string;before:()=>Promise<void>}|null=null;const unsent=new Set<string>(),dropped:string[]=[];
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect'){checks++;return {literals:[]};}
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.approval') {
        if(input.kind==='settle'&&unsent.has(String(input.id))){dropped.push(String(input.id));return {state:'done',edited:false};}
        const early=posting;
        if(early&&input.kind==='card'&&early.id===input.id){unsent.add(early.id);await early.before();unsent.delete(early.id);}
        cards.push(input);return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
      }
      if(operation.startsWith('telegram.'))return {state:'done',chat_id:input.chat_id,message_id:'5'};
      throw Error('unexpected runtime call '+operation);
    },honcho:async()=>{throw Error('no memory provider');}});
  let refuse=(_url:string):Response|null=>null;
  const mock:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000});
    return refuse(String(url))??fetch(url,init);
  };
  const archive=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy} as unknown as Settings,async()=>({}));
  await new Promise<void>(resolve=>archive.listen(0,'127.0.0.1',resolve));
  const archiveBase='http://127.0.0.1:'+(archive.address() as {port:number}).port;
  const broker=brokerServer({pool:stores.control,storage:s.turns,token,archive:archiveBase,hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(s),fetch:mock});
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  const brokerBase='http://127.0.0.1:'+(broker.address() as {port:number}).port;
  const get=async(path:string,headers:Record<string,string>={})=>{const response=await fetch(brokerBase+path,{headers});return {status:response.status,body:await response.json() as any};};
  let sent=100;
  const capture=async(chat:string,payload:Record<string,unknown>,text:string|null=null)=>{
    const id=++sent,event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(id),revision:'1',
      occurred_at:null,text,payload:{update_id:id,...payload}};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const message=(chat:string,from:number,text:string,at=1700000000+sent+1)=>capture(chat,{message:{message_id:sent+1,date:at,
    chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}},text);
  const react=async(target:number,user:number)=>{
    const before=(await s.guards.state()).epoch;
    await capture(other,{message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:target,date:1700000000+sent+1,user:{id:user},old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}});
    assert.equal((await s.guards.state()).epoch,before+1,'a reaction starts a quiet epoch');
  };
  /** A button press by the owner in their private chat, and the answer it got. */
  const press=async(data:string)=>{
    await s.actionCommands.callback(await capture('123',{callback_query:{id:'query-'+(sent+1),from:{id:123},chat_instance:'1',data,
      message:{message_id:5,date:1700000000,chat:{id:123,type:'private'}}}}));
    return cards.filter(card=>card.kind==='answer').at(-1)!.text as string;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const privately=async(text:string)=>actor((await message('123',123,text)).id,null,'123');
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const latest=async(id:string)=>(await stores.control.query('SELECT event_id FROM background_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[id])).rows[0].event_id as string;
  const period={chat:group,from:'2026-01-10',to:'2026-01-12'};
  const name='example-org/widgets',gadgets='example-org/gadgets';
  const commitOf=(n:number)=>digest('commit '+n).slice(0,40),digestOf=(n:number)=>digest('bundle '+n);
  /** What github.py saves after a verified fetch: a new copy with copy_id null, or Copy again with the row's copy_id. */
  const set=(repo:string,copy_id:string|null,n:number,extra:Record<string,unknown>={})=>s.jobs.changeCopies(owner,{set:{repo,branch:'main',commit:commitOf(n),
    digest:digestOf(n),bytes:18000000,need:60000000,files:1204,copy_id,not_after:Math.floor(Date.now()/1000)+10,...extra}});
  const copyOf=async(repo:string)=>(await s.jobs.copies(owner)).copies.find((row:any)=>row.repo.toLowerCase()===repo.toLowerCase());
  const copyAgain=async(repo:string,n:number)=>set(repo,(await copyOf(repo)).copy_id,n);
  const remove=(repo:string)=>s.jobs.changeCopies(owner,{remove:repo});
  const ask=async(title:string,extra:Record<string,unknown>={})=>s.jobs.start(await privately('Read the made-up group: '+title),
    {title,instruction:'Compare the made-up tasks with the made-up code.',...period,box:true,repo:name,...extra});
  const approve=async(proposed:{id:string;fingerprint:string})=>s.jobs.decide('123',{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message('123',123,'Approve'));
  /** Run a job's latest run: read its context and claim it. */
  const run=async(id:string)=>{
    const step=await latest(id);await s.jobs.runs.run(step,await authority());
    const context:any=await s.jobs.runs.context({event_id:step,owner_epoch:(await authority()).epoch});
    const claimed:any=await s.jobs.runs.claim({...context,actor:context.actor});
    return {step,context,claimed,text:String(claimed.text),credential:String(claimed.archive_credential)};
  };
  const begin=async(proposed:{id:string;fingerprint:string})=>{await approve(proposed);await tick(proposed.id);return run(proposed.id);};
  /** A run that read and called the model once, then failed, so a relaunch resumes or restarts it. */
  const fail=async(step:Awaited<ReturnType<typeof run>>)=>{
    await s.jobs.runs.prepare({...step.context,actor:step.context.actor});
    await s.jobs.runs.finish({event_id:step.step,actor:step.context.actor,state:'failed',session:step.context.conversation,error_code:'model_unavailable',text:'',todo:[],
      tokens:{input_tokens:5000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1}});
  };
  /** End a job that is still running, so it frees its slot. */
  const retire=async(id:string)=>{await s.jobs.halt(id).catch(()=>{});await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE job_id=$1 AND state IN ('captured','running')",[id]);await tick(id);};
  const live=async()=>(await get('/v1/box/live',{authorization:'Bearer '+boxToken})).body.boxes as any[];
  const bindingBox=async(credential:string)=>{const binding=await get('/v1/security/binding',{authorization:'Bearer '+credential});assert.equal(binding.status,200);return binding.body.box;};
  const pinned=async()=>((await s.jobs.copies(owner)).pinned as string[]).sort();
  const wait=async(check:()=>boolean|Promise<boolean>,what:string)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('timed out: '+what);};
  const settledText=(id:string)=>cards.filter(card=>card.kind==='settle'&&card.id===id).at(-1) as Record<string,any>;
  const removedLine='🚫 Withdrawn: its GitHub copy was removed. Nothing runs.';
  const boxRepoLine='🧰 It can run commands and Python in a sealed box: no internet, no keys, only the checked messages of the chat it reads and the GitHub copy below.';
  const boxLine='🧰 It can run commands and Python in a sealed box: no internet, no keys, only the checked messages of the chat it reads.';
  const repoLine=(copy:any)=>'📦 It reads a copy of '+copy.repo+', main at '+copy.commit.slice(0,7)+', copied '+new Date(copy.copied_at).toISOString().slice(0,16).replace('T',' ')+
    ' UTC (18 MB, 1,204 files). What it reads is secret-checked before the model sees it, and reading code adds to its cost. Your GitHub key stays outside the box.';
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy,'on');
    const day=Date.UTC(2026,0,10,8)/1000;
    for(let i=0;i<5;i++)await message(group,9,'A member: made-up task '+i,day+i);
    const hidden=await message(group,9,'A member: a made-up message the owner hides later',day+10);
    const noted=sent+1;await message(other,9,'Another member: a made-up note',day+20);

    // Copies: only the owner's service token, strict bodies, at most ten, and a set that comes too late changes nothing.
    const member:Reader={admin:false,scope:null};
    await assert.rejects(s.jobs.copies(member),{code:'owner_required'});
    await assert.rejects(s.jobs.changeCopies(member,{clear:true}),{code:'owner_required'});
    assert.deepEqual(await s.jobs.copies(owner),{copies:[],pinned:[]});
    const good={repo:name,branch:'main',commit:commitOf(1),digest:digestOf(1),bytes:18000000,need:60000000,files:1204,copy_id:null,not_after:Math.floor(Date.now()/1000)+10};
    const bad=[{repo:'example-org/widgets.git'},{repo:'example-org/..'},{repo:'-example/widgets'},{repo:'example-org/widgets/more'},{branch:'-main'},{branch:'a..b'},
      {branch:'main.lock'},{branch:'a//b'},{branch:'main/'},{branch:'.main'},{branch:'x'.repeat(256)},{commit:commitOf(1).slice(1)},{commit:commitOf(1).toUpperCase()},
      {digest:digestOf(1).slice(1)},{bytes:0},{bytes:67108865},{bytes:1.5},{need:268435457},{files:-1},{files:50001},{copy_id:'f'.repeat(31)},{copy_id:7},
      {not_after:Math.floor(Date.now()/1000)+70},{not_after:String(good.not_after)},{extra:true}];
    for(const change of bad)await assert.rejects(s.jobs.changeCopies(owner,{set:{...good,...change}}),{status:400,code:'invalid_github_copy'},JSON.stringify(change).slice(0,60));
    const {files:_files,...short}=good;
    for(const body of [{set:short},{set:good,clear:true},{remove:'widgets'},{remove:'example-org/widgets.git'},{clear:false},{},[],null,{set:[good]}])
      await assert.rejects(s.jobs.changeCopies(owner,body),{status:400,code:'invalid_github_copy'},JSON.stringify(body));
    assert.deepEqual((await s.jobs.copies(owner)).copies,[],'nothing was saved');
    // A new copy gets a new random copy_id; a second new copy of the same name, in any case, is refused.
    await set(name,null,1);
    const first=await copyOf(name);
    assert.match(first.copy_id,/^[a-f0-9]{32}$/);
    assert.deepEqual({...first,copied_at:null},{copy_id:first.copy_id,repo:name,branch:'main',commit:commitOf(1),digest:digestOf(1),bytes:18000000,need:60000000,files:1204,previous_digest:null,copied_at:null});
    assert.equal(typeof first.bytes,'number');assert.ok(first.copied_at instanceof Date);
    await assert.rejects(set('Example-Org/Widgets',null,2),{status:409,code:'github_copy_cancelled'});
    // Copy again keeps its copy_id and the digest it replaced; the same digest keeps the earlier one.
    await copyAgain(name,2);
    const again=await copyOf(name);
    assert.deepEqual([again.copy_id,again.digest,again.previous_digest,again.commit],[first.copy_id,digestOf(2),digestOf(1),commitOf(2)]);
    assert.ok(again.copied_at>=first.copied_at);
    await set(name,first.copy_id,2);assert.equal((await copyOf(name)).previous_digest,digestOf(1),'the same digest keeps the previous one');
    await assert.rejects(set(name,'0'.repeat(32),3),{code:'github_copy_cancelled'},'a copy_id that is not the row\'s');
    await assert.rejects(set(gadgets,first.copy_id,3),{code:'github_copy_cancelled'},'another name');
    // A set past its not_after changes nothing, also one that waited on the row's lock until then.
    await assert.rejects(set(name,first.copy_id,3,{not_after:Math.floor(Date.now()/1000)-1}),{code:'github_copy_cancelled'});
    await assert.rejects(set(gadgets,null,3,{not_after:Math.floor(Date.now()/1000)-1}),{code:'github_copy_cancelled'});
    assert.deepEqual((await s.jobs.copies(owner)).copies.map((row:any)=>[row.repo,row.digest]),[[name,digestOf(2)]]);
    const holder=await stores.control.connect();
    try {
      await holder.query('BEGIN');await holder.query('SELECT 1 FROM github_copies WHERE copy_id=$1 FOR UPDATE',[first.copy_id]);
      const notAfter=Math.floor(Date.now()/1000)+1,late=set(name,first.copy_id,3,{not_after:notAfter}).then(()=>null,error=>error);
      await wait(()=>Date.now()/1000>notAfter+0.3,'the not_after to pass');
      await holder.query('COMMIT');
      assert.equal((await late)?.code,'github_copy_cancelled','the check follows the write');
    }finally{holder.release();}
    assert.equal((await copyOf(name)).digest,digestOf(2));
    // At most ten copies; Copy again still works at ten.
    for(let i=0;i<9;i++)await set(name+'-'+i,null,40+i);
    await assert.rejects(set(name+'-9',null,49),{status:409,code:'github_repo_limit'});
    await copyAgain(name+'-0',50);
    assert.equal((await s.jobs.copies(owner)).copies.length,10);
    assert.deepEqual((await s.jobs.copies(owner)).copies.map((row:any)=>row.repo).slice(0,2),[name,name+'-0'],'ordered by name');
    for(let i=0;i<9;i++)await remove(name+'-'+i);
    assert.deepEqual((await s.jobs.copies(owner)).copies.map((row:any)=>row.repo),[name]);
    await set(gadgets,null,60);

    // start: a repo only with the box, only one that was copied, and refused before anything is recorded or checked.
    const requests=async()=>Number((await stores.derived.query("SELECT count(*) FROM derived_artifacts WHERE kind='background_job_request'")).rows[0].count);
    const ownerTurn=await privately('Read the made-up group with its code'),counted=[await requests(),checks];
    const plain={title:'Repo refusals',instruction:'Compare them.',...period};
    for(const body of [{...plain,repo:name} as Record<string,unknown>,{...plain,box:false,repo:name},{...plain,box:true,repo:'example-org/unknown'},{...plain,box:true,repo:'example-org/widgets.git'},
      {...plain,box:true,repo:'example-org'}])
      await assert.rejects(s.jobs.start(ownerTurn,body),{status:409,code:'job_repo_not_allowed'},JSON.stringify(body.repo)+String(body.box));
    for(const repo of [5,'',name+'x'.repeat(141-name.length),null])
      await assert.rejects(s.jobs.start(ownerTurn,{...plain,box:true,repo}),{status:400,code:'invalid_job_request'},String(repo).length+' '+typeof repo);
    assert.deepEqual([await requests(),checks],counted,'no proposal record and no secret check');
    await assert.rejects(s.jobs.start(await actor((await message(group,9,'Run it here')).id,group,group),{title:'Member box',instruction:'Read it.',box:true,repo:name}),
      {code:'job_box_not_allowed'},'a member\'s job never gets the box, nor a copy');
    await assert.rejects(s.jobs.start(await actor((await message(group,123,'Run it here too')).id,group,group),{title:'Group box',instruction:'Read it.',box:true,repo:name}),
      {code:'job_box_not_allowed'},'nor does the owner\'s job asked in a group');
    const copied=await copyOf(name),proposed=await ask('Repo task check');
    assert.deepEqual(proposed.repo,{name,branch:'main',commit:commitOf(2),copied_at:copied.copied_at.toISOString()});
    const asked=await job(proposed.id);
    assert.deepEqual(asked.repo,{copy_id:copied.copy_id,name,branch:'main',commit:commitOf(2),digest:digestOf(2),bytes:18000000,need:60000000,files:1204,
      copied_at:copied.copied_at.toISOString()},'the pin, its numbers as numbers');
    // The fingerprint covers the pin next to the frozen rates and the byte budget; a job without one keeps today's keys.
    const fingerprint=async(row:any,repo:boolean)=>{
      const shown=await s.jobs.proposal(row),{from:_from,to:_to,...estimate}=row.estimate;
      return digest(canonical({proposal:shown,chat:row.target,from:row.estimate.from??'',to:row.estimate.to??'',estimate,cost_limit:Number(row.cost_limit_usd),
        minutes_limit:row.minutes_limit,approver:row.approver,box:row.box,byte_budget:row.byte_budget===null?null:Number(row.byte_budget),...(repo?{repo:row.repo}:{})}));
    };
    assert.ok(asked.estimate.rates&&asked.byte_budget!==null);
    assert.equal(await fingerprint(asked,true),asked.fingerprint);
    const boxOnly=await s.jobs.start(await privately('Box only'),{title:'Box only check',instruction:'Compare the made-up tasks.',...period,box:true});
    const boxRow=await job(boxOnly.id);
    assert.equal(boxRow.repo,null);assert.equal(boxOnly.repo,null);assert.equal(await fingerprint(boxRow,false),boxRow.fingerprint,'a job without a copy keeps its fingerprint');
    const same=await privately('Same request with its code');
    const sameRequest=(repo:string)=>s.jobs.start(same,{title:'Same repo request',instruction:'Compare them.',...period,box:true,repo});
    await sameRequest(name);
    await assert.rejects(sameRequest(gadgets),{code:'job_changed'},'another copy is another job');
    await copyAgain(name,3);
    await assert.rejects(sameRequest(name),{code:'job_changed'},'so is the same copy copied again');
    // The card says what the box holds and which copy, from the job's own pin.
    await s.actionCommands.offer('background',proposed);
    const card=cards.filter(card=>card.kind==='card'&&card.id===proposed.id).at(-1)!;
    assert.ok(card.text.includes('\n'+boxRepoLine+'\n'+repoLine(copied)+'\n\n'),card.text);
    assert.deepEqual(card.buttons.map((button:string[])=>button[1]),['na'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16),'nd'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16)]);
    const savedCard=async(text:string|null)=>stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify(text===null?{}:{'background.card':text})]);
    await savedCard('Made-up card: {title}\n\n{instruction}');
    assert.equal((await s.jobs.card(proposed.id)).text,'Made-up card: Repo task check\n\nCompare the made-up tasks with the made-up code.\n\n'+boxRepoLine+'\n'+repoLine(copied),
      'a saved card without the lines still shows them, at its end');
    const boxCard=(await s.jobs.card(boxOnly.id)).text;
    assert.equal(boxCard,'Made-up card: Box only check\n\nCompare the made-up tasks.\n\n'+boxLine);
    // A card without a copy reads as it did before the 📦 line existed.
    await savedCard(null);const now=(await s.jobs.card(boxOnly.id)).text;
    await savedCard(backgroundCard.replace('\n📦 {repo}',''));assert.equal((await s.jobs.card(boxOnly.id)).text,now);assert.doesNotMatch(now,/📦/);
    await savedCard(null);
    // A copy does not lift the time limit.
    const sources=s.jobs.sources,size=sources.size.bind(sources);
    sources.size=async(...args:Parameters<typeof size>)=>({...await size(...args),characters:200000000});
    try{await assert.rejects(ask('Every year with code'),{status:409,code:'job_too_long'});}finally{sources.size=size;}

    // status: the copies show only in the owner's private live turn, while the box switch is on.
    const repos=async(principal:Reader)=>{const listed:any=await s.jobs.list(principal);return 'repos' in listed?listed.repos.map((row:any)=>({...row,copied_at:row.copied_at.toISOString()})):undefined;};
    const latestCopies=(await s.jobs.copies(owner)).copies;
    assert.deepEqual(await repos(await privately('What can a job read?')),latestCopies.map((row:any)=>({name:row.repo,branch:'main',commit:row.commit.slice(0,12),copied_at:row.copied_at.toISOString()})));
    assert.deepEqual((await repos(await privately('Again'))).map((row:any)=>row.name),[gadgets,name],'ordered by name');
    assert.equal(await repos(await actor((await message(group,123,'Jobs here?')).id,group,group)),undefined,'not in a group');
    assert.equal(await repos(await actor((await message(group,9,'Jobs here?')).id,group,group)),undefined,'not for a member');
    assert.equal(await repos(owner),undefined,'not for the dashboard');
    const switchBox=async(on:boolean)=>s.jobs.saveSettings(owner,{...await s.jobs.settings(),box_tools:on});
    await switchBox(false);assert.equal(await repos(await privately('And now?')),undefined,'not with the box off');await switchBox(true);

    // pinned: approved, running within its box time and proposed under 24 hours, never reporting, closed, stopping or removed.
    const pins:Record<string,string>={},ids:Record<string,string>={},labels=['proposed','approved','running','reporting','old','late','stopping','done'];
    for(const [index,label] of labels.entries()){await copyAgain(name,70+index);ids[label]=(await ask('Pinned '+label)).id;pins[label]=digestOf(70+index);}
    const update=(label:string,sql:string)=>stores.control.query('UPDATE background_jobs SET '+sql+' WHERE id=$1',[ids[label]]);
    await update('approved',"state='approved'");await update('running',"state='running',started_at=now()");await update('reporting',"state='reporting',started_at=now()");
    await update('old',"created_at=now()-interval '25 hours'");await update('late',"state='running',started_at=now()-(minutes_limit+9)*interval '1 minute'");
    await update('stopping',"state='approved',cancel_requested=true");await update('done',"state='done',finished_at=now()");
    // The earlier jobs of this copy are proposals too.
    const earlier=[digestOf(2)];
    assert.deepEqual(await pinned(),[pins.proposed!,pins.approved!,pins.running!,...earlier].sort());
    assert.equal((await copyOf(name)).digest,digestOf(77),'the row has moved on; the pins stay');
    await remove(name);
    assert.deepEqual(await pinned(),[],'a removed copy pins nothing');
    assert.deepEqual([(await job(ids.proposed!)).state,(await job(ids.approved!)).state,(await job(ids.running!)).state,(await job(ids.done!)).state],['stopped','stopped','running','done']);
    await stores.control.query("UPDATE background_jobs SET state='done',finished_at=now() WHERE id=ANY($1)",[[ids.running,ids.reporting,ids.late]]);

    // Withdrawal: Remove stops what has not started, says why on its card, and a running job only loses its box.
    await set(name,null,100);
    const waiting=await ask('Withdrawn proposal'),queued=await ask('Withdrawn approval'),running=await ask('Running through Remove');
    for(const each of [waiting,queued])await s.actionCommands.offer('background',each);
    await approve(queued);assert.equal((await job(queued.id)).state,'approved');
    const started=await begin(running);
    assert.equal(started.context.background.box,true);assert.deepEqual((await live()).map(box=>box.job),[running.id]);
    const removed=await remove(name);
    assert.deepEqual(removed,await s.jobs.copies(owner),'Remove answers with the copies left');assert.deepEqual(removed.copies.map((row:any)=>row.repo),[gadgets]);
    for(const withdrawn of [waiting,queued]) {
      const row=await job(withdrawn.id);
      assert.deepEqual([row.state,row.cancel_requested,row.error_code],['stopped',true,'job_repo_removed']);assert.ok(row.finished_at);
      await wait(()=>!!settledText(withdrawn.id)?.text.endsWith(removedLine),'the card of '+withdrawn.id);
      assert.equal(settledText(withdrawn.id).buttons,undefined,'no buttons');
      assert.ok(settledText(withdrawn.id).text.startsWith((await s.jobs.card(withdrawn.id)).text),'the card keeps its text');
    }
    assert.equal(await press('na'+waiting.id.slice(0,40)+waiting.fingerprint.slice(0,16)),'This request was already decided or can no longer change. Review it in the dashboard Inbox.');
    assert.equal((await job(waiting.id)).state,'stopped');
    assert.equal((await tick(queued.id)).state,'cancelled');
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM background_runs WHERE job_id=ANY($1)',[[waiting.id,queued.id]])).rows[0].count),0,'no run');
    assert.equal((await job(running.id)).state,'running','a running job goes on');
    assert.deepEqual(await live(),[],'without its box');assert.equal(await bindingBox(started.credential),null);
    const statusJobs=((await s.jobs.list(await privately('Status please'))) as any).jobs;
    assert.equal(statusJobs.find((row:any)=>row.id===queued.id).error_code,'job_repo_removed');assert.equal(statusJobs.find((row:any)=>row.id===queued.id).state,'stopped');
    await retire(running.id);
    // A copy row gone without a Remove still approves nothing.
    await set(name,null,101);
    const gone=await ask('Copy gone before approval');
    await stores.control.query('DELETE FROM github_copies WHERE copy_id=$1',[(await job(gone.id)).repo.copy_id]);
    await assert.rejects(approve(gone),{status:409,code:'job_changed'});assert.equal((await job(gone.id)).state,'proposed');
    // A Remove that commits while the card is posted: its settle finds no card yet, so offerJob settles it right after.
    await set(name,null,102);
    const racing=await ask('Removed while posted');
    posting={id:racing.id,before:async()=>{await remove(name);await wait(()=>dropped.includes(racing.id),'the early settle');}};
    try{await s.actionCommands.offer('background',racing);}finally{posting=null;}
    const posted=cards.findIndex(card=>card.kind==='card'&&card.id===racing.id);
    assert.ok(posted>=0);
    await wait(()=>!!settledText(racing.id),'the settle after the post');
    assert.ok(cards.findIndex(card=>card.kind==='settle'&&card.id===racing.id)>posted);
    assert.ok(settledText(racing.id).text.endsWith(removedLine));assert.equal(settledText(racing.id).buttons,undefined);
    // clear withdraws the jobs of every copy.
    await set(name,null,103);
    const one=await ask('Cleared widgets'),two=await ask('Cleared gadgets',{repo:gadgets});
    assert.deepEqual(await s.jobs.changeCopies(owner,{clear:true}),{copies:[],pinned:[]});
    for(const cleared of [one,two])assert.deepEqual([(await job(cleared.id)).state,(await job(cleared.id)).error_code],['stopped','job_repo_removed']);

    // Lock order: start and decide lock the copy row before the job row, as Remove does, so a Remove meanwhile waits and then withdraws.
    const connect=stores.control.connect.bind(stores.control);
    let gate:{reached:()=>void;release:Promise<void>}|null=null;
    // Only this checkout is watched: the pool's own query() calls its clients with a callback, so release puts query back.
    (stores.control as any).connect=(callback?:any)=>{
      if(callback)return connect(callback);
      return connect().then(client=>{
        const query=client.query,release=client.release;
        (client as any).query=async(text:any,values?:any)=>{
          const result=await (query as any).call(client,text,values);
          if(gate&&typeof text==='string'&&text.includes('FROM github_copies WHERE copy_id=$1 FOR SHARE')){const held=gate;gate=null;held.reached();await held.release;}
          return result;
        };
        client.release=(...args:any[])=>{delete (client as any).query;client.release=release;return (release as any).apply(client,args);};
        return client;
      });
    };
    const blocked=async()=>{const admin=new pg.Client(config);await admin.connect();
      try{return Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'")).rows[0].count);}finally{await admin.end();}};
    const holding=async<T>(work:()=>Promise<T>)=>{
      let reached!:()=>void,release!:()=>void;const at=new Promise<void>(resolve=>{reached=resolve;});
      gate={reached,release:new Promise<void>(resolve=>{release=resolve;})};
      const result=work().then(value=>({value}),error=>({error}));
      await at;
      let removedAt=0;const removing=remove(name).then(()=>{removedAt=Date.now();});
      await wait(async()=>await blocked()>0,'Remove to wait on the copy lock');
      assert.equal(removedAt,0,'Remove waits');
      release();
      const [outcome]=await Promise.all([result,removing]);return outcome as {value?:T;error?:any};
    };
    try {
      await set(name,null,110);
      const startedUnder=await holding(()=>ask('Started under the lock'));
      assert.equal(startedUnder.error,undefined,String(startedUnder.error));
      assert.deepEqual([(await job(startedUnder.value!.id)).state,(await job(startedUnder.value!.id)).error_code],['stopped','job_repo_removed'],'the new job is withdrawn');
      await set(name,null,111);
      const decided=await ask('Approved under the lock');
      const approvedUnder=await holding(()=>approve(decided));
      assert.deepEqual(approvedUnder.value,{id:decided.id,state:'approved'});
      assert.deepEqual([(await job(decided.id)).state,(await job(decided.id)).error_code],['stopped','job_repo_removed'],'the approved job is stopped');
    }finally{delete (stores.control as any).connect;gate=null;}

    // Runs: each run's text says what the box holds and which copy, and its binding names the pinned copy.
    await set(name,null,120);
    const r1=await ask('Relaunch keeps the copy'),pin=(await job(r1.id)).repo;
    const a=await begin(r1);
    assert.equal(a.context.background.box,true);
    assert.match(a.text,/^\[Background job: Relaunch keeps the copy\]\n/);
    assert.ok(a.text.includes('\n\n[Sealed box]\n')&&a.text.indexOf('[Sealed box]')<a.text.indexOf('[GitHub copy]'),a.text);
    assert.ok(a.text.includes('\n\n[GitHub copy]\n/repo/code is a read-only copy of the GitHub repository '+name+', branch main at commit '+commitOf(120)+', copied '+
      pin.copied_at.slice(0,16).replace('T',' ')+' UTC, with that branch\'s full history.'));
    assert.match(a.text,/never copy the repository into \/work itself/);assert.doesNotMatch(a.text,/next step/);
    // The binding names the copy for the launcher, without its copy_id or file count; a box job without a copy gets today's binding.
    const box=await bindingBox(a.credential);
    assert.deepEqual(box.repo,{name,branch:'main',commit:commitOf(120),digest:digestOf(120),bytes:18000000,need:60000000});
    assert.deepEqual(Object.keys(box).sort(),['chat','expires','from','generation','job','mode','repo','to','valid_from_epoch']);
    const b=await begin(boxOnly);
    assert.deepEqual(Object.keys(await bindingBox(b.credential)).sort(),['chat','expires','from','generation','job','mode','to','valid_from_epoch']);
    assert.doesNotMatch(b.text,/GitHub copy/);
    await retire(boxOnly.id);
    // Carry: reactions during the run keep its box, its copy and the copy's fill.
    const from=(await live())[0].valid_from_epoch;
    await react(noted,11);await react(noted,12);
    assert.deepEqual((await bindingBox(a.credential)).repo,box.repo);assert.equal((await live())[0].valid_from_epoch,from);
    // Copy again leaves the job its pin: the binding still names the first digest, and that digest stays pinned.
    await copyAgain(name,121);
    assert.equal((await bindingBox(a.credential)).repo.digest,digestOf(120));
    assert.deepEqual(await pinned(),[digestOf(120)]);
    // A failed run's relaunch in the same epoch resumes: the resume line, then both texts, and still the first digest.
    await fail(a);await tick(r1.id);
    const a2=await run(r1.id);
    assert.equal(a2.context.background.attempt,2);
    assert.match(a2.text,/^\[Background job: Relaunch keeps the copy\] The job was interrupted and restarted\./);
    assert.ok(a2.text.includes('\n\n[Sealed box]\n')&&a2.text.includes('\n\n[GitHub copy]\n')&&a2.text.includes('at commit '+commitOf(120)));
    assert.equal((await bindingBox(a2.credential)).repo.digest,digestOf(120),'the same copy after Copy again');
    // A relaunch after a hide starts over: the first message, the restart text and both texts, a new fill and the same copy.
    const before=(await bindingBox(a2.credential)).valid_from_epoch;
    await fail(a2);
    await s.retirements.set(owner,hidden.id,{retired:true,expected_revision:0,operation_id:key+':hide'});
    await tick(r1.id);
    const a3=await run(r1.id),restarted=await bindingBox(a3.credential);
    assert.equal(a3.context.background.attempt,3);
    assert.match(a3.text,/^\[Background job: Relaunch keeps the copy\]\nYou are running a background job/);
    assert.match(a3.text,/\n\nThis job restarted and its earlier work could not be kept\.[^]*\n\n\[Sealed box\]\n[^]*\n\n\[GitHub copy\]\n/);
    assert.notEqual(restarted.valid_from_epoch,before,'a new fill');assert.equal(restarted.repo.digest,digestOf(120),'the same copy');
    // Stop on its card drops the box, and the stopped job pins nothing.
    const fingerprintOf=(await job(r1.id)).fingerprint;
    assert.equal(await press('ns'+r1.id.slice(0,40)+fingerprintOf.slice(0,16)),'🛑 Stopping the job. Nothing more runs.');
    assert.equal((await job(r1.id)).cancel_requested,true);
    assert.deepEqual(await live(),[]);assert.deepEqual(await pinned(),[],'a stopping job pins nothing');
    await retire(r1.id);
    // After Remove, a relaunch runs plain: no box, no binding box and neither text.
    const r3=await ask('Relaunch after Remove'),c=await begin(r3);
    assert.ok((await bindingBox(c.credential)).repo);
    await remove(name);
    assert.equal(await bindingBox(c.credential),null,'Remove ends the box binding of a running job');
    await fail(c);await tick(r3.id);
    const c2=await run(r3.id);
    assert.equal(c2.context.background.box,false);assert.equal(await bindingBox(c2.credential),null);
    assert.doesNotMatch(c2.text,/\[Sealed box\]|\[GitHub copy\]/);
    await retire(r3.id);
    // Remove, then Copy the same name: a new copy_id, so the job never gets its box back and its old digest is not kept.
    await set(name,null,140);
    const r4=await ask('Copied again after Remove'),d=await begin(r4);
    const oldCopy=(await job(r4.id)).repo.copy_id;
    await remove(name);await set(name,null,140);
    assert.notEqual((await copyOf(name)).copy_id,oldCopy);
    assert.equal(await bindingBox(d.credential),null);assert.deepEqual(await live(),[]);assert.deepEqual(await pinned(),[]);
    await retire(r4.id);

    // The broker relays the refusal to the job, as it relays the box's.
    const refusing=await ask('Broker refusal');
    const runCredential=(await begin(refusing)).credential;
    refuse=url=>url.includes('/v1/jobs/start')?Response.json({error:'job_repo_not_allowed'},{status:409}):null;
    const relayed=await fetch(brokerBase+'/v1/jobs/start',{method:'POST',headers:{authorization:'Bearer '+runCredential,'content-type':'application/json'},
      body:JSON.stringify({title:'Made-up job',instruction:'Count the made-up tasks.',box:true,repo:'example-org/other'})});
    assert.deepEqual([relayed.status,await relayed.json()],[409,{error:'job_repo_not_allowed'}]);
    refuse=()=>null;
    await retire(refusing.id);
  } finally {
    if(previousBox===undefined)delete process.env.NOCHEH_BOX_TOKEN;else process.env.NOCHEH_BOX_TOKEN=previousBox;
    broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    archive.closeAllConnections();await new Promise<void>(resolve=>archive.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
