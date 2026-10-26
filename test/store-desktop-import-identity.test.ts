import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {observedSource} from '../src/observed-source.js';
import {sourceObjectId} from '../src/source-model.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

const desktop=(scope:string,chat:{id:number;type:string},message:Record<string,unknown>,label=''):Envelope=>({version:1,
  key:`telegram-desktop:${chat.type}:${chat.id}:${message.id}:${label}`,origin:'import',bot_id:'desktop-export',kind:'telegram_desktop_message',
  scope,source_id:String(message.id),revision:digest(label+JSON.stringify(message)),occurred_at:null,text:String(message.text??''),
  payload:{chat:{...chat,name:'Example group'},message:{type:'message',...message}}});
const live=(chat:string,id:number,update:number,text:string):Envelope=>({version:1,key:'desktop-identity:live:'+chat+':'+update,origin:'live',bot_id:'fixture',
  kind:'telegram_update',scope:chat,source_id:String(id),revision:String(update),occurred_at:null,text,
  payload:{update_id:update,message:{message_id:id,date:1700000000,chat:{id:Number(chat),type:'supergroup'},from:{id:7,first_name:'Example'},text}}});
const author=(value:Envelope)=>observedSource(value).relations.find(relation=>relation.kind==='authored_by')?.target;

test('a Desktop export observes the live message and person only where Telegram proves the identity',()=>{
  const supergroup={id:1234567890,type:'private_supergroup'},message={id:5,from:'Example',from_id:'user7',text:'hello',reply_to_message_id:4};
  const mapped=observedSource(desktop('-1001234567890',supergroup,message)),bot=observedSource(live('-1001234567890',5,9,'hello'));
  assert.equal(sourceObjectId(mapped.object),sourceObjectId(bot.object),'a supergroup mapped to its own live chat is the same message');
  assert.deepEqual(author(desktop('-1001234567890',supergroup,message)),author(live('-1001234567890',5,9,'hello')),'a user id is one account everywhere');
  assert.deepEqual(mapped.relations.find(relation=>relation.kind==='reply_to')?.target,{...bot.object,external_id:'4'});
  assert.deepEqual(mapped.relations.find(relation=>relation.kind==='contained_in')?.target,bot.relations.find(relation=>relation.kind==='contained_in')?.target);
  // Unmapped, mapped elsewhere, or a basic group that numbers messages per member: the message stays a Desktop object.
  for(const value of [desktop('desktop:private_supergroup:1234567890',supergroup,message),desktop('-1009999999999',supergroup,message),
    desktop('-1234567890',{id:1234567890,type:'private_group'},message)]) {
    assert.notEqual(sourceObjectId(observedSource(value).object),sourceObjectId(bot.object));
    assert.deepEqual(author(value),author(live('-1001234567890',5,9,'hello')));
  }
  assert.deepEqual(author(desktop('-1001234567890',supergroup,{...message,from_id:'channel42'})),{platform:'telegram',namespace:'bot-api',kind:'conversation',external_id:'-10042'});
  assert.equal(author(desktop('-1001234567890',supergroup,{...message,from_id:'user7x'}))?.namespace,'desktop','an unknown sender form is not guessed');
});

test('a Desktop forum message joins the live topic the importer found for it',()=>{
  const supergroup={id:1234567890,type:'private_supergroup'},message={id:5,from:'Example',from_id:'user7',text:'hello',reply_to_message_id:3};
  const inTopic=(scope:string)=>{const value=desktop(scope,supergroup,message);(value.payload as any).topic_id=3;return observedSource(value);};
  const bot=live('-1001234567890',5,9,'hello');
  (bot.payload as any).message={...(bot.payload as any).message,chat:{id:-1001234567890,type:'supergroup',is_forum:true},message_thread_id:3,is_topic_message:true};
  const thread=(value:ReturnType<typeof observedSource>)=>value.relations.find(relation=>relation.kind==='in_thread')?.target;
  assert.deepEqual(thread(inTopic('-1001234567890')),thread(observedSource(bot)));
  assert.equal(thread(inTopic('desktop:private_supergroup:1234567890')),undefined,'an unmapped export has no live topic');
  assert.equal(thread(observedSource(desktop('-1001234567890',supergroup,message))),undefined,'General and unlinked messages have none');
});

test('imported copies of live messages are marked and lose to the live copy; newer exports replace older ones',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),bare=Date.now(),group='-100'+bare,owner={admin:true,scope:null};
  const s=storageServices(stores,{dataDir:'/tmp/nocheh-desktop-identity-fixture',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'42',group_ids:[group]}),
    runtime:async()=>{throw Error('runtime_not_expected');},honcho:async()=>{throw Error('honcho_not_expected');}});
  const chat={id:bare,type:'public_supergroup'};
  const record=async(value:Envelope)=>await s.imports.record(owner,{event:value,artifacts:[],derived:[]}) as any;
  try{
    const seen=(await s.capture.capture(live(group,5,9,'seen live'))).source.reference;
    const copy=await record(desktop(group,chat,{id:5,from:'Example',from_id:'user7',text:'seen live'}));
    assert.equal(copy.live_copy,true);assert.equal(copy.duplicate,false);
    assert.deepEqual(await s.retirements.revisions(seen.id),[copy.id,seen.id],'the live copy is the one memory learns');
    assert.deepEqual([...await s.retirements.liveCopies([copy.id,seen.id])],[copy.id]);
    const hits=await s.sources.search(owner,'seen live');
    assert.equal(hits.find(hit=>hit.id===copy.id)?.live_copy,true);assert.equal(hits.find(hit=>hit.id===seen.id)?.live_copy,undefined);
    // The bot's own reply, repeated by the export, is also already saved live.
    const sent=(await s.capture.capture({version:1,key:'desktop-identity:delivered:'+group,origin:'live',kind:'telegram_delivered_message',bot_id:'fixture',
      scope:group,source_id:'8',revision:'8',occurred_at:null,text:'bot reply',
      payload:{message:{message_id:8,date:1700000001,chat:{id:Number(group),type:'supergroup'},from:{id:9,is_bot:true,first_name:'Bot'},text:'bot reply'}}})).source.reference;
    const echo=await record(desktop(group,chat,{id:8,from:'Bot',from_id:'user9',text:'bot reply'}));
    assert.equal(echo.live_copy,true,'an exported copy of the bot reply counts as already kept');
    assert.deepEqual(await s.retirements.revisions(echo.id),[echo.id,sent.id],'the sent reply, not the export, is what memory keeps');
    const people=await stores.archive.query("SELECT DISTINCT target_id FROM source_relations WHERE kind='authored_by' AND event_id=ANY($1::text[])",[[copy.id,seen.id]]);
    assert.equal(people.rowCount,1,'the export and the live chat share one person');
    // A newer export of an edited message replaces the older export, whatever order they arrive in.
    const edited=await record(desktop(group,chat,{id:6,from:'Example',from_id:'user7',text:'edited',edited_unixtime:'1700000100'},'second'));
    const first=await record(desktop(group,chat,{id:6,from:'Example',from_id:'user7',text:'original'},'first'));
    assert.equal(edited.live_copy,undefined);assert.equal(first.live_copy,undefined);
    assert.deepEqual(await s.retirements.revisions(first.id),[first.id,edited.id]);
    assert.equal((await record(desktop(group,chat,{id:6,from:'Example',from_id:'user7',text:'original'},'first'))).duplicate,true);
  }finally{await stores.close();}
});
