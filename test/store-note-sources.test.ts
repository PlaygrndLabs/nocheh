import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {accountIdFor,installChatsForTest} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {NoteSourceRepository} from '../src/stores/note-sources.js';
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
