import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {accountIdFor,installChatsForTest} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {NoteSourceRepository,recallRoleWords,type NoteInput} from '../src/stores/note-sources.js';
import {HttpError} from '../src/http.js';
import {sourceLines} from '../src/prompts.js';
import {modelSourceWords} from '../src/source-labels.js';
import {BOB,GP1,OWNER,fixtureDirectory} from './fixture-groups.js';

test('note sources read each message\'s facts from the archive: its author, its selected texts and Nocheh\'s own send class',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),restore=installChatsForTest(fixtureDirectory());
  try {
    const archive=new ArchiveRepository(stores.archive),run=`note-sources:${Date.now()}`;let serial=0;
    const capture=async(value:Omit<Envelope,'version'|'key'|'source_id'|'revision'|'occurred_at'|'bot_id'>&{bot_id?:string;origin:Envelope['origin']})=>{
      const id=++serial;
      return (await archive.capture({version:1,key:`${run}:${id}`,bot_id:'123456',source_id:String(id),revision:'1',occurred_at:null,...value} as Envelope)).source.reference.id;
    };
    const message=(chat:{id:number;type:string},from:Record<string,unknown>,fields:Record<string,unknown>)=>
      ({update_id:++serial,message:{message_id:serial,date:1700000000+serial,chat,from,...fields}});
    const privateChat={id:Number(OWNER),type:'private'},group={id:Number(GP1),type:'supergroup'};
    const owner={id:Number(OWNER),is_bot:false,first_name:'Owner'},bob={id:Number(BOB),is_bot:false,first_name:'Owner'};
    const typed=await capture({origin:'live',kind:'telegram_update',scope:OWNER,text:'hi',payload:message(privateChat,owner,{text:'hi'})});
    // A person whose display name is "Owner" forwards a channel's post in a group.
    const forward=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'rule',payload:message(group,bob,{text:'rule',
      forward_origin:{type:'channel',chat:{id:-1009,type:'channel',title:'News'},message_id:3,date:1}})});
    const document=await capture({origin:'live',kind:'telegram_update',scope:OWNER,text:'my CV',payload:message(privateChat,owner,{caption:'my CV',
      document:{file_id:'doc-'+run,file_unique_id:'d',file_name:'cv.pdf'}})});
    const voice=await capture({origin:'live',kind:'telegram_update',scope:OWNER,text:'',payload:message(privateChat,owner,{voice:{file_id:'voice-'+run,file_unique_id:'v',duration:3}})});
    const delivered=(send:Record<string,unknown>)=>capture({origin:'live',kind:'telegram_delivered_message',scope:GP1,text:'ok',
      payload:{message:{message_id:++serial,date:1700000000,chat:group,text:'ok'},...send}});
    const reply=await delivered({send_class:'reply',answers:forward}),notice=await delivered({send_class:'notice'}),old=await delivered({});
    const exported=await capture({origin:'import',bot_id:'desktop-export',kind:'telegram_desktop_message',scope:GP1,text:'hi',
      payload:{chat:{id:42,type:'private_supergroup',name:'Example group'},message:{type:'message',id:++serial,from:'Owner',from_id:'user'+OWNER,forwarded_from:'Sara',text:'hi'}}});
    // The document's text was read and the voice note transcribed; a selection without an active revision counts for nothing.
    const artifacts=new Map((await stores.archive.query('SELECT event_id,id FROM artifacts WHERE event_id=ANY($1::text[])',[[document,voice]])).rows.map(row=>[row.event_id,row.id]));
    for(const [event,kind,active] of [[document,'extracted_text',1],[voice,'transcript',1],[typed,'extracted_text',null]] as const)
      await stores.derived.query('INSERT INTO derivative_selections(id,event_id,artifact_id,kind,active_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [digest(`${run}:${event}:${kind}`),event,artifacts.get(event)??null,kind,active]);

    const sources=new NoteSourceRepository(stores,()=>({owner_id:OWNER}));
    const facts=await sources.factsFor([typed,forward,document,voice,reply,notice,old,exported,digest('missing'),'not-an-id']);
    assert.deepEqual([...facts.keys()].sort(),[typed,forward,document,voice,reply,notice,old,exported].sort(),'a missing event and a bad id are left out');
    assert.deepEqual([facts.get(typed)!.author,facts.get(typed)!.account,facts.get(typed)!.file],['owner',accountIdFor('telegram',OWNER),false]);
    assert.deepEqual([facts.get(forward)!.author,facts.get(forward)!.forward,facts.get(forward)!.forward_name],['person','channel','News'],'a display name is not an account');
    assert.deepEqual([facts.get(document)!.file,facts.get(document)!.file_name,facts.get(document)!.recording],[true,'cv.pdf',false]);
    assert.deepEqual([facts.get(voice)!.recording,facts.get(voice)!.audio,facts.get(voice)!.file],[true,false,false]);
    assert.deepEqual([facts.get(reply)!.author,facts.get(reply)!.send_class,facts.get(reply)!.answers],['nocheh','reply',forward]);
    assert.deepEqual([facts.get(exported)!.author,facts.get(exported)!.forward,facts.get(exported)!.forward_name],['owner','hidden','Sara']);
    const classes=await sources.classesFor([typed,forward,document,voice,reply,notice,old,exported]);
    assert.deepEqual([typed,forward,document,voice,reply,notice,old,exported].map(id=>classes.get(id)!.class),
      ['owner_message','forward_channel_by_person','file_by_owner','owner_message','nocheh_about_forward','nocheh_unlearned','nocheh_reply','forward_hidden_by_owner']);
    // A reply whose answered message was not asked for is still read with it.
    assert.equal((await sources.classesFor([reply])).get(reply)!.class,'nocheh_about_forward');
    assert.equal((await sources.factsFor([])).size,0);
  } finally {restore();await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);}
});

test('each note\'s source is labelled from what was recorded about it, never from its text, and only an all-owner cited review is the owner\'s',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),restore=installChatsForTest(fixtureDirectory());
  try {
    const archive=new ArchiveRepository(stores.archive),run=`note-labels:${Date.now()}`;let serial=0;
    const privateChat={id:Number(OWNER),type:'private'},group={id:Number(GP1),type:'supergroup'};
    const owner={id:Number(OWNER),is_bot:false,first_name:'Owner'},bob={id:Number(BOB),is_bot:false,first_name:'Bob'};
    const capture=async(scope:string,chat:{id:number;type:string},from:Record<string,unknown>,fields:Record<string,unknown>)=>{
      const id=++serial;
      return (await archive.capture({version:1,key:`${run}:${id}`,bot_id:'123456',source_id:String(id),revision:'1',occurred_at:null,origin:'live',kind:'telegram_update',
        scope,text:String(fields.text??''),payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat,from,...fields}}} as Envelope)).source.reference.id;
    };
    const typed=await capture(OWNER,privateChat,owner,{text:'I fly to Lisbon on Friday.'}),again=await capture(OWNER,privateChat,owner,{text:'Book the window seat.'});
    const forward=await capture(GP1,group,bob,{text:'The office closes early.',forward_origin:{type:'channel',chat:{id:-1009,type:'channel',title:'News'},message_id:3,date:1}});
    const provenance=(events:{id:string;class:string}[],only:boolean)=>({version:1,source:events[0]!.id,events,owner_account_only:only,rules:'none',
      left_out:{sender_not_allowed:0,rule_sender_not_allowed:0,rules_left_out_for_owner_label:0}});
    const job=async(name:string,source:string,value:unknown)=>{
      const id=digest(`${run}:${name}`);
      await stores.control.query(`INSERT INTO native_review_jobs(id,source_reference,input_reference,binding,provenance) VALUES($1,$2,$2,'{}'::jsonb,$3)`,
        [id,JSON.stringify({kind:'event',id:source}),value===null?null:JSON.stringify(value)]);
      return id;
    };
    const ownReview=await job('own',typed,provenance([{id:typed,class:'owner_message'},{id:again,class:'owner_message'}],true));
    const mixedReview=await job('mixed',typed,provenance([{id:typed,class:'owner_message'},{id:forward,class:'forward_channel_by_person'}],false));
    const blankReview=await job('blank',typed,null);
    const places=new Map([[typed,OWNER],[forward,GP1]]);
    const sources=new NoteSourceRepository(stores,()=>({owner_id:OWNER}),{space:async reference=>places.get(reference.id)??null});
    const note=(name:string,origins:NoteInput['origins'],more:Partial<NoteInput>={}):NoteInput=>({key:digest(`${run}:note:${name}`),origins,more:0,cites:[],more_cites:false,space:OWNER,...more});
    const turn=(event:string,reads:any[]=[],complete=true,channel:'telegram'|'browser'|'scheduler'='telegram')=>({by:'turn' as const,event,channel,at:'2026-11-08',reads,complete});
    const notes=[
      note('own',[{by:'review',review:ownReview}],{cites:[typed]}),
      note('uncited',[{by:'review',review:ownReview}]),
      note('outside',[{by:'review',review:ownReview}],{cites:[typed,forward]}),
      note('too-many',[{by:'review',review:ownReview}],{cites:[typed],more_cites:true}),
      note('mixed',[{by:'review',review:mixedReview}],{cites:[typed]}),
      note('blank',[{by:'review',review:blankReview}],{cites:[typed]}),
      note('gone',[{by:'review',review:digest(`${run}:never-queued`)}],{cites:[typed]}),
      note('replaced',[{by:'review',review:ownReview},{by:'review',review:mixedReview}],{cites:[typed]}),
      note('dropped',[{by:'review',review:ownReview}],{cites:[typed],more:2}),
      note('turn-own',[turn(typed)]),
      note('turn-read',[turn(typed,['web'])]),
      note('turn-forward',[turn(forward)],{space:GP1}),
      note('turn-cut',[turn(typed,[],false)]),
      note('job',[turn(typed,['commands'],true,'scheduler')]),
      note('unknown',[{by:'unknown'}])];
    const labels=await sources.labels(notes),of=(name:string)=>labels.get(digest(`${run}:note:${name}`))!;
    assert.deepEqual(of('own'),{from:'owner',label:'the owner\'s own messages in the owner\'s private chat'});
    assert.deepEqual(of('uncited'),{from:'nocheh',label:'a notes review of the owner\'s own messages in the owner\'s private chat; the note cites none of them'});
    // A note citing someone else's message, or more messages than were sent, is never the owner's.
    assert.equal(of('outside').from,'forward');assert.notEqual(of('too-many').from,'owner');
    assert.equal(of('mixed').from,'forward');assert.match(of('mixed').label,/^Nocheh's notes review of /);
    // A review with no records, or whose row is gone, is not recorded; another origin only lowers trust.
    assert.notEqual(of('blank').from,'owner');assert.deepEqual(of('gone'),{from:'unknown',label:modelSourceWords.labels.unknown});
    assert.equal(of('replaced').from,'forward');assert.ok(of('replaced').label.endsWith(modelSourceWords.labels.inherited));
    assert.notEqual(of('dropped').from,'owner');
    // A turn's note is never the owner's own, even while answering the owner's message.
    assert.deepEqual(of('turn-own'),{from:'turn',label:'Nocheh\'s note from the owner\'s private chat on 2026-11-08, written while answering the owner\'s own message'});
    assert.deepEqual(of('turn-read'),{from:'turn_read',label:'Nocheh\'s note from the owner\'s private chat on 2026-11-08, after reading web pages'});
    assert.equal(of('turn-forward').from,'turn_read');assert.match(of('turn-forward').label,/after reading a forwarded message$/);
    assert.equal(of('turn-cut').from,'turn_read');assert.equal(of('job').from,'turn_read');assert.match(of('job').label,/^Nocheh's note from a job or scheduled run/);
    assert.deepEqual(of('unknown'),{from:'unknown',label:modelSourceWords.labels.unknown});
    for(const [key,value] of labels)assert.ok(!value.label.includes(typed)&&!value.label.includes(OWNER)&&value.label.length<=120,key);

    // Hermes's lookup: checked whole, refused whole.
    const sent=notes.slice(0,2).map(({space,...rest})=>rest);
    assert.deepEqual(Object.keys((await sources.lookup({notes:sent,space:OWNER})).labels).sort(),notes.slice(0,2).map(item=>item.key).sort());
    for(const body of [{notes:[{...sent[0],key:'short'}]},{notes:[{...sent[0],text:'the owner wrote this'}]},{notes:[{...sent[0],origins:[{by:'owner'}]}]},
      {notes:[{...sent[0],origins:[{...turn(typed),channel:'email'}]}]},{notes:[{...sent[0],cites:['x']}]},{notes:Array(201).fill(sent[0])},{notes:sent,space:''},{notes:sent,extra:1},null])
      await assert.rejects(sources.lookup(body),(error:unknown)=>error instanceof HttpError&&error.status===400&&error.code==='invalid_note_sources',JSON.stringify(body)?.slice(0,80));

    // The Notes page: each note in the owner's words, with nothing Hermes recorded passed on.
    const page=await sources.withOwnerLabels({scope:OWNER,profile:'p',memories:[{name:'MEMORY.md',text:'x',entries:[
      {target:'memory',text:'I fly to Lisbon on Friday.',...sent[0]},{target:'memory',text:'Odd record',key:digest('odd'),origins:'not a list'}]},{name:'USER.md',text:'whole text'}]}) as any;
    assert.deepEqual(Object.keys(page.memories[0].entries[0]),['target','text','from','label']);
    assert.equal(page.memories[0].entries[0].from,'owner');assert.match(page.memories[0].entries[0].label,/^Your own messages in /);
    assert.deepEqual(page.memories[0].entries[1],{target:'memory',text:'Odd record',from:'unknown',label:sourceLines(undefined).unknown});
    assert.deepEqual(page.memories[1],{name:'USER.md',text:'whole text'},'a file Hermes could not read stays whole');

    // Recall: a note hit's source in the model's words and a past conversation's writer in fixed words.
    const recalled=await sources.withRecallSources({hits:[{profile:'p',space:OWNER,kind:'native_note',text:'Lisbon',note:sent[0]},
      {profile:'p',space:OWNER,kind:'native_note',text:'Lisbon again'},{profile:'p',kind:'native_session',text:'Lisbon?',role:'assistant'},
      {profile:'p',kind:'native_session',text:'Lisbon!',role:'user'}],truncated:false}) as any;
    assert.deepEqual(recalled.hits.map((hit:any)=>hit.source??hit.role),[{from:'owner',label:'the owner\'s own messages in the owner\'s private chat'},
      {from:'unknown',label:modelSourceWords.labels.unknown},recallRoleWords.assistant,recallRoleWords.message]);
    assert.ok(recalled.hits.every((hit:any)=>!('note' in hit)));

    // A store that can't be read labels nothing as anyone's.
    const down=new NoteSourceRepository({...stores,control:{query:async()=>{throw Error('down');}}},()=>({owner_id:OWNER}));
    const failed=await down.withRecallSources({hits:[{kind:'native_note',space:OWNER,note:sent[0]}]}) as any;
    assert.deepEqual(failed.hits[0].source,{from:'unavailable',label:modelSourceWords.labels.unavailable});
    const unread=await down.withOwnerLabels({scope:OWNER,memories:[{name:'MEMORY.md',entries:[{target:'memory',text:'t',...sent[0]}]}]}) as any;
    assert.deepEqual(unread.memories[0].entries[0],{target:'memory',text:'t',from:'unavailable',label:sourceLines(undefined).unavailable});
  } finally {restore();await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);}
});
