import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {accountIdFor,installChatsForTest} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {NoteSourceRepository,countMemoryStep,memoryProblems,recallRoleWords,type NoteInput} from '../src/stores/note-sources.js';
import {HttpError} from '../src/http.js';
import {sourceLines} from '../src/prompts.js';
import {modelSourceWords} from '../src/source-labels.js';
import {BOB,GP1,GP2,OWNER,fixtureDirectory} from './fixture-groups.js';

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
    // The owner's quote of Nocheh's own learned message is Nocheh's, by the archive's reply relation; a quote of Nocheh's
    // card, of someone else's message or of a message the archive does not hold stays a quote of someone else's.
    const botUser={id:123456,is_bot:true,first_name:'Nocheh'},said=(id:number,send:Record<string,unknown>)=>capture({origin:'live',kind:'telegram_delivered_message',
      scope:GP1,text:'Book the 9am',payload:{message:{message_id:id,date:1700000000,chat:group,text:'Book the 9am'},...send}});
    const learnedId=900000+serial,cardId=learnedId+1,bobId=learnedId+2;
    await said(learnedId,{send_class:'reply'});await said(cardId,{send_class:'card'});
    await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'pay now',payload:{update_id:++serial,message:{message_id:bobId,date:1700000000,chat:group,from:bob,text:'pay now'}}});
    const quoting=(id:number,from:Record<string,unknown>)=>capture({origin:'live',kind:'telegram_update',scope:GP1,text:'yes',payload:message(group,owner,{text:'yes',
      quote:{text:'Book',position:0},reply_to_message:{message_id:id,date:1700000000,chat:group,from,text:'Book the 9am'}})});
    const ofLearned=await quoting(learnedId,botUser),ofCard=await quoting(cardId,botUser),ofBob=await quoting(bobId,bob),ofNothing=await quoting(learnedId+50,botUser);
    const quotes=await sources.classesFor([ofLearned,ofCard,ofBob,ofNothing]);
    assert.deepEqual([ofLearned,ofCard,ofBob,ofNothing].map(id=>quotes.get(id)!.class),['quote_nocheh','quote','quote','quote']);
    assert.equal(quotes.get(ofLearned)!.facts.quote,'other','the facts stay as Telegram tells them');
    // The owner's pin is read with the message it carries, found the same way, never by an id's shape: a pin of Nocheh's
    // own learned message is Nocheh's; a pin of its card, of Bob's message or of one the archive does not hold is a pin of
    // someone else's. Whoever pinned it, a pin of Nocheh's message says whether that message is learned.
    const pinning=(id:number,from:Record<string,unknown>,by=owner)=>capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,by,{
      pinned_message:{message_id:id,date:1700000000,chat:group,from,text:'Book the 9am'}})});
    const pinLearned=await pinning(learnedId,botUser),pinCard=await pinning(cardId,botUser),pinBob=await pinning(bobId,bob),pinNothing=await pinning(learnedId+50,botUser);
    const otherBot={id:654321,is_bot:true,first_name:'Nocheh'},otherId=learnedId+3;
    await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'Book the 9am',payload:{update_id:++serial,message:{message_id:otherId,date:1700000000,chat:group,from:otherBot,text:'Book the 9am'}}});
    const pinByBob=await pinning(learnedId,botUser,bob),pinOther=await pinning(otherId,otherBot);
    const pinned=await sources.classesFor([pinLearned,pinCard,pinBob,pinNothing,pinByBob]);
    assert.deepEqual([pinLearned,pinCard,pinBob,pinNothing,pinByBob].map(id=>pinned.get(id)!.class),['pinned_nocheh','pinned','pinned','pinned','pinned']);
    assert.deepEqual(Object.fromEntries(await sources.pinnedNocheh([pinLearned,pinCard,pinBob,pinNothing,pinByBob,pinOther,typed,ofLearned])),
      {[pinLearned]:'learned',[pinCard]:'unlearned',[pinByBob]:'learned'},'another bot\'s message, Bob\'s, a missing one or no pin at all is not Nocheh\'s');
    // What a pin or quote carries of Nocheh's own words (carried) is also told by the bot the update came to, the account the
    // archive stored for it (here 123456), by equality: a pin of Nocheh's message the archive does not hold, or of the
    // owner's forward of one, is Nocheh's own account's (`bot`), and so is a quote of either. Another bot's message, and
    // one sent through an inline bot, carries nothing of Nocheh's. With no known bot, the fields tell nothing.
    const forwardOfNocheh={message_id:++serial,date:1700000000,chat:group,from:owner,forward_origin:{type:'user',sender_user:botUser,date:1},text:'Book the 9am'};
    const pinForward=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,owner,{pinned_message:forwardOfNocheh})});
    const quoteForward=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'done',payload:message(group,owner,{text:'done',quote:{text:'Book',position:0},
      reply_to_message:forwardOfNocheh})});
    const viaPin=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,owner,{pinned_message:{message_id:++serial,date:1700000000,
      chat:group,from:bob,via_bot:botUser,text:'Book the 9am'}})});
    const otherQuote=await quoting(otherId,otherBot);
    const unknownPin=await capture({origin:'live',bot_id:'fixture',kind:'telegram_update',scope:GP1,text:'',payload:message(group,owner,{
      pinned_message:{message_id:learnedId+60,date:1700000000,chat:group,from:botUser,text:'Book the 9am'}})});
    // A message another message embeds is Nocheh's own words the same way, by its place in the message (`held`).
    const nochehPoll=(from:Record<string,unknown>)=>({poll_option_added:{poll_message:{message_id:learnedId+70,date:1700000000,chat:group,from,poll:{id:'p',question:'Q',
      options:[]}},option_persistent_id:'a',option_text:'mine'}});
    const heldNocheh=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,owner,nochehPoll(botUser))});
    const heldOther=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,owner,nochehPoll(otherBot))});
    // Telegram leaves the reply out of a message another embeds, so a quote inside one is traced through that message's own
    // archived event, by the id Telegram gives it in the same chat: a quote of Nocheh's card is Nocheh's (`held`); one
    // whose message the archive does not hold, or holds answering nothing, can't be told (`untraced`); one of Bob's
    // message is Bob's words, left to be judged where it is learned. Each is cut or judged by its place.
    const pollQuoting=(id:number,extra:Record<string,unknown>)=>({message_id:id,date:1700000000,chat:group,from:owner,poll:{id:'p'+id,question:'Lunch?',options:[]},
      quote:{text:'QUOTED words',position:0},...extra});
    const archivedAs=(id:number,message:Record<string,unknown>)=>archive.capture({version:1,key:`${run}:as:${id}`,bot_id:'123456',source_id:String(id),revision:'1',
      occurred_at:null,origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:{update_id:++serial,message}} as Envelope);
    const cardPollId=learnedId+80,bobPollId=learnedId+81,barePollId=learnedId+82,lostPollId=learnedId+83;
    await archivedAs(cardPollId,pollQuoting(cardPollId,{reply_to_message:{message_id:cardId,date:1700000000,chat:group,from:botUser,text:'Book the 9am'}}));
    await archivedAs(bobPollId,pollQuoting(bobPollId,{reply_to_message:{message_id:bobId,date:1700000000,chat:group,from:bob,text:'pay now'}}));
    await archivedAs(barePollId,pollQuoting(barePollId,{}));
    const optionAdded=(id:number,chat=group)=>capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,bob,{poll_option_added:{
      poll_message:pollQuoting(id,{chat}),option_persistent_id:'a',option_text:'Friday'}})});
    const addedCard=await optionAdded(cardPollId),addedBob=await optionAdded(bobPollId),addedBare=await optionAdded(barePollId),addedLost=await optionAdded(lostPollId);
    // A message Telegram names in another chat is never looked up by its id here: it can't be traced.
    const addedElsewhere=await optionAdded(cardPollId,{id:Number(GP2),type:'supergroup'});
    const quotePlace='["poll_option_added","poll_message","quote"]';
    assert.deepEqual(Object.fromEntries(await sources.carried([pinLearned,pinCard,pinNothing,pinOther,pinForward,quoteForward,viaPin,otherQuote,unknownPin,ofLearned,ofCard,ofNothing,typed,
      heldNocheh,heldOther,addedCard,addedBob,addedBare,addedLost,addedElsewhere])),{
      [pinLearned]:{pinned:'learned',quote:false,pinned_quote:false,held:[],untraced:[]},[pinCard]:{pinned:'unlearned',quote:false,pinned_quote:false,held:[],untraced:[]},
      [pinNothing]:{pinned:'bot',quote:false,pinned_quote:false,held:[],untraced:[]},[pinForward]:{pinned:'bot',quote:false,pinned_quote:false,held:[],untraced:[]},
      [quoteForward]:{pinned:null,quote:true,pinned_quote:false,held:[],untraced:[]},[ofLearned]:{pinned:null,quote:true,pinned_quote:false,held:[],untraced:[]},
      [ofCard]:{pinned:null,quote:true,pinned_quote:false,held:[],untraced:[]},[ofNothing]:{pinned:null,quote:true,pinned_quote:false,held:[],untraced:[]},
      [heldNocheh]:{pinned:null,quote:false,pinned_quote:false,held:['["poll_option_added","poll_message"]'],untraced:[]},
      [addedCard]:{pinned:null,quote:false,pinned_quote:false,held:[quotePlace],untraced:[]},
      [addedBare]:{pinned:null,quote:false,pinned_quote:false,held:[],untraced:[quotePlace]},
      [addedLost]:{pinned:null,quote:false,pinned_quote:false,held:[],untraced:[quotePlace]},
      [addedElsewhere]:{pinned:null,quote:false,pinned_quote:false,held:[],untraced:[quotePlace]}});
    const traced=await sources.embeddedTo([addedCard,addedBob,addedBare,addedLost,addedElsewhere,typed]);
    assert.deepEqual([...traced.keys()].sort(),[addedCard,addedBob,addedBare].sort(),'only a message the archive holds in the same chat is traced');
    assert.deepEqual([...traced.get(addedBob)!.keys()],[quotePlace]);assert.equal(traced.get(addedBob)!.get(quotePlace)!.length,1);
    // A Telegram Desktop export of a supergroup Nocheh serves is another revision of the same message, which records its
    // reply as reply_to_message_id: beside the live revision that shows it, the quote is traced as that one traces it. An
    // export alone shows no reply Nocheh's card can be told by, so its quote still can't be traced.
    const exportedAs=(id:number,fields:Record<string,unknown>)=>archive.capture({version:1,key:`${run}:export:${id}`,bot_id:'desktop-export',source_id:String(id),revision:'1',
      occurred_at:null,origin:'import',kind:'telegram_desktop_message',scope:GP1,text:'',payload:{chat:{id:1000000001,type:'private_supergroup',name:'Example group'},
        message:{type:'message',id,from:'Owner',from_id:'user'+OWNER,poll:{question:'Lunch?',answers:[]},text:'',...fields}}} as Envelope);
    const bothPollId=learnedId+84,exportPollId=learnedId+85;
    await archivedAs(bothPollId,pollQuoting(bothPollId,{reply_to_message:{message_id:bobId,date:1700000000,chat:group,from:bob,text:'pay now'}}));
    await exportedAs(bothPollId,{reply_to_message_id:bobId});await exportedAs(exportPollId,{reply_to_message_id:bobId});
    const addedBoth=await optionAdded(bothPollId),addedExport=await optionAdded(exportPollId);
    assert.equal((await sources.embeddedTo([addedBoth])).get(addedBoth)?.get(quotePlace)?.length,2,'the live and the exported revision');
    // Telegram keeps the reply of an embedded message that answers one in another chat (external_reply): that quote is not
    // traced or cut here, and the owner's notes review judges it by that message (embeddedTo with every quote).
    const addedFar=await capture({origin:'live',kind:'telegram_update',scope:GP1,text:'',payload:message(group,bob,{poll_option_added:{poll_message:pollQuoting(bobPollId,
      {external_reply:{origin:{type:'user',sender_user:bob,date:1},chat:{id:Number(GP2),type:'supergroup'},message_id:bobId}}),option_persistent_id:'a',option_text:'Friday'}})});
    assert.deepEqual(Object.fromEntries(await sources.carried([addedBoth,addedExport,addedFar])),{
      [addedExport]:{pinned:null,quote:false,pinned_quote:false,held:[],untraced:[quotePlace]}});
    assert.equal((await sources.embeddedTo([addedFar])).size,0);
    assert.deepEqual([...((await sources.embeddedTo([addedFar],true)).get(addedFar)??new Map())].map(([place,found])=>[place,found.length]),[[quotePlace,1]]);
    // In the owner's own private chat, told by equality with the policy's owner chat, nobody else can add tasks: the owner's
    // checklist there stays the owner's own, even one open to others. In a group the same checklist may hold others' tasks,
    // and so may it in a chat the policy does not name as the owner's.
    const listIn=(chat:{id:number;type:string},scope:string)=>capture({origin:'live',kind:'telegram_update',scope,text:'',payload:message(chat,owner,{
      checklist:{title:'Trip',tasks:[{id:1,text:'keys'}],others_can_add_tasks:true}})});
    const listPrivate=await listIn(privateChat,OWNER),listGroup=await listIn(group,GP1),lists=await sources.classesFor([listPrivate,listGroup]);
    assert.deepEqual([lists.get(listPrivate)!.class,lists.get(listGroup)!.class,lists.get(listGroup)!.facts.held],['owner_message','pinned',true]);
    const elsewhere=new NoteSourceRepository(stores,()=>({owner_id:OWNER,owner_chat:GP2}));
    assert.equal((await elsewhere.classesFor([listPrivate])).get(listPrivate)!.class,'pinned');
    // The owner's quote of their own forward of Nocheh's message is a quote of someone else's, never the owner's own words.
    const quotedForward=(await sources.classesFor([quoteForward])).get(quoteForward)!;
    assert.deepEqual([quotedForward.facts.quote,quotedForward.class],['other','quote']);
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
    const labels=await sources.labels(notes),of=(name:string)=>labels[notes.findIndex(item=>item.key===digest(`${run}:note:${name}`))]!;
    assert.equal(labels.length,notes.length);
    // Saved without Telegram's time, so a review's day is the day each was saved.
    const saved=((await stores.archive.query('SELECT received_at FROM events WHERE id=$1',[typed])).rows[0].received_at as Date).toISOString().slice(0,10);
    assert.deepEqual(of('own'),{from:'owner',label:`the owner's own messages of ${saved} in the owner's private chat`});
    assert.deepEqual(of('uncited'),{from:'nocheh',label:`a notes review on ${saved} of the owner's own messages in the owner's private chat; the note cites none of them`});
    // A note citing someone else's message, or more messages than were sent, is never the owner's.
    assert.equal(of('outside').from,'forward');assert.notEqual(of('too-many').from,'owner');
    assert.equal(of('mixed').from,'forward');assert.ok(of('mixed').label.startsWith(`Nocheh's notes review on ${saved} of a message another person forwarded `),of('mixed').label);
    // A review with no records, or whose row is gone, is not recorded; another origin only lowers trust.
    assert.notEqual(of('blank').from,'owner');assert.deepEqual(of('gone'),{from:'unknown',label:modelSourceWords.labels.unknown});
    assert.equal(of('replaced').from,'forward');assert.ok(of('replaced').label.endsWith(modelSourceWords.labels.inherited));
    assert.notEqual(of('dropped').from,'owner');
    // A turn's note is never the owner's own, even while answering the owner's message. One that recorded only its UTC
    // day, as notes did before their moment was kept, says so.
    assert.deepEqual(of('turn-own'),{from:'turn',label:'Nocheh\'s note from the owner\'s private chat on 2026-11-08 UTC, written while answering the owner\'s own message'});
    assert.deepEqual(of('turn-read'),{from:'turn_read',label:'Nocheh\'s note from the owner\'s private chat on 2026-11-08 UTC, after reading web pages'});
    assert.equal(of('turn-forward').from,'turn_read');assert.match(of('turn-forward').label,/after reading a forwarded message$/);
    assert.equal(of('turn-cut').from,'turn_read');assert.equal(of('job').from,'turn_read');assert.match(of('job').label,/^Nocheh's note from a job or scheduled run/);
    assert.deepEqual(of('unknown'),{from:'unknown',label:modelSourceWords.labels.unknown});
    for(const [index,value] of labels.entries())assert.ok(!value.label.includes(typed)&&!value.label.includes(OWNER)&&value.label.length<=120,String(index));

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
    assert.deepEqual(recalled.hits.map((hit:any)=>hit.source??hit.role),[{from:'owner',label:`the owner's own messages of ${saved} in the owner's private chat`},
      {from:'unknown',label:modelSourceWords.labels.unknown},recallRoleWords.assistant,recallRoleWords.message]);
    assert.ok(recalled.hits.every((hit:any)=>!('note' in hit)));
    // The same note's key in two profiles: each hit and each entry keeps its own source.
    const twin={...sent[0]!,origins:[turn(forward)]};
    const twins=await sources.withRecallSources({hits:[{profile:'p',space:OWNER,kind:'native_note',text:'Lisbon',note:sent[0]},
      {profile:'q',space:GP1,kind:'native_note',text:'Lisbon',note:twin}]}) as any;
    assert.deepEqual(twins.hits.map((hit:any)=>hit.source.from),['owner','turn_read']);
    const twinPage=await sources.withOwnerLabels({scope:OWNER,memories:[{name:'MEMORY.md',entries:[{target:'memory',text:'a',...sent[0]},
      {target:'memory',text:'b',...twin}]}]}) as any;
    assert.deepEqual(twinPage.memories[0].entries.map((entry:any)=>entry.from),['owner','turn_read']);

    // Each failed labelling is counted for the owner's notice: a chat that can't be read is a failure, and the labels
    // still go out. One that works is counted only once the day holds a failure, so the notice can say it works again.
    const today=async()=>{const rows=await memoryProblems(stores.control);const row=rows.find(item=>item.kind==='notes');return {done:row?.done??0,failed:row?.failed??0};};
    const placeless=new NoteSourceRepository(stores,()=>({owner_id:OWNER}),{space:async()=>{throw Error('archive down');}});
    let before=await today();
    const partial=await placeless.labels([notes[0]!]);
    assert.equal(partial[0]!.from,'owner');assert.match(partial[0]!.label,/a chat Nocheh can't name/);
    assert.ok((await today()).failed>before.failed,'a place that could not be read');
    before=await today();
    await sources.labels([notes[0]!]);
    assert.ok((await today()).done>before.done,'a labelling that worked after a failure');
    // While nothing failed that day, the Notes page's polls, recall and each turn's lookup write nothing (rolled back, so
    // the other counts of today stay as they are).
    const day=await stores.control.connect();
    try {
      await day.query('BEGIN');await day.query(`DELETE FROM memory_problem_days WHERE day=(now() AT TIME ZONE 'UTC')::date`);
      const rows=async()=>(await memoryProblems(day)).map(row=>[row.kind,row.done,row.failed]);
      await countMemoryStep(day,'notes',true);await countMemoryStep(day,'memory_read',true);
      assert.deepEqual(await rows(),[],'steps that work write nothing on a day with no failure');
      await countMemoryStep(day,'notes',false);await countMemoryStep(day,'notes',true);await countMemoryStep(day,'notes',true);
      await countMemoryStep(day,'memory_read',true);await countMemoryStep(day,'memory_read',false);
      assert.deepEqual(await rows(),[['memory_read',0,1],['notes',2,1]],'every failure is counted, and what worked after one');
    }finally{await day.query('ROLLBACK').catch(()=>{});day.release();}
    // A lookup that fails shows every note as not available right now, never anyone's, and is counted too.
    const failing=new NoteSourceRepository({...stores,control:{query:async(sql:string,values?:unknown[])=>{
      if(sql.includes('native_review_jobs'))throw Error('down');return stores.control.query(sql,values);}} as any},()=>({owner_id:OWNER}));
    before=await today();
    const lost=await failing.withRecallSources({hits:[{kind:'native_note',space:OWNER,note:sent[0]}]}) as any;
    assert.deepEqual(lost.hits[0].source,{from:'unavailable',label:modelSourceWords.labels.unavailable});
    const lostPage=await failing.withOwnerLabels({scope:OWNER,memories:[{name:'MEMORY.md',entries:[{target:'memory',text:'t',...sent[0]}]}]}) as any;
    assert.deepEqual(lostPage.memories[0].entries[0],{target:'memory',text:'t',from:'unavailable',label:sourceLines(undefined).unavailable});
    assert.ok((await today()).failed>=before.failed+2,'both failures are counted');

    // A store that can't be read labels nothing as anyone's.
    const down=new NoteSourceRepository({...stores,control:{query:async()=>{throw Error('down');}}},()=>({owner_id:OWNER}));
    const failed=await down.withRecallSources({hits:[{kind:'native_note',space:OWNER,note:sent[0]}]}) as any;
    assert.deepEqual(failed.hits[0].source,{from:'unavailable',label:modelSourceWords.labels.unavailable});
    const unread=await down.withOwnerLabels({scope:OWNER,memories:[{name:'MEMORY.md',entries:[{target:'memory',text:'t',...sent[0]}]}]}) as any;
    assert.deepEqual(unread.memories[0].entries[0],{target:'memory',text:'t',from:'unavailable',label:sourceLines(undefined).unavailable});
  } finally {restore();await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);}
});
