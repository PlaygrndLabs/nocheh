import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installChatsForTest} from '../src/chats.js';
import {placeName,recallNames,recallPlace,withRecallPlaces} from '../src/stores/recall-places.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG1_TOPIC_KEY,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,UNSERVED,fixtureDirectory,legacyDirectory} from './fixture-groups.js';

const none=new Map<string,string>();
// The chats these hits name, as the seeder makes their rows for values stored before step 2b (ADR-0252).
installChatsForTest(legacyDirectory(['-1005','-1005/topic/9','-1005/topic/3','-1006','123/topic/4'],{owner:'123',served:['-1005','-1006']}));

test('a recalled hit names its chat in words, and only the owner\'s own chat gets the owner\'s label',()=>{
  const names=new Map([['-1005','Synthetic Forum'],['-1005/topic/9','Trip plans']]);
  assert.equal(recallPlace({space:'123',owner:true,answer:false},names),'Your private chat');
  assert.equal(recallPlace({space:'123/topic/4',owner:true,answer:false},names),'Your private chat','the owner\'s own topics too');
  assert.equal(recallPlace({space:'-1005',owner:false,answer:false},names),'“Synthetic Forum”');
  assert.equal(recallPlace({space:'-1005/topic/9',owner:false,answer:false},names),'“Synthetic Forum” › Trip plans');
  assert.equal(recallPlace({space:'-1005/topic/3',owner:false,answer:false},names),'“Synthetic Forum” › a topic');
  assert.equal(recallPlace({space:'-1006',owner:false,answer:false},names),'A Telegram group','a group Nocheh cannot name is still a group');
  // A private answer's profile names the owner's private chat, but its notes come from groups: never the owner's label.
  assert.equal(recallPlace({space:'123',owner:false,answer:true,answer_group:'“Synthetic Forum” › Trip plans'},names),
    'Private answer asked in “Synthetic Forum” › Trip plans','the same wording as the answer\'s first line');
  assert.equal(recallPlace({space:'123',owner:false,answer:true},names),'A private answer');
  assert.equal(recallPlace({space:'123',owner:true,answer:true},names),'A private answer','an answer flag wins over an owner flag');
  for(const where of [{space:'123',owner:false,answer:false},{space:null},{},{space:'desktop:import'},{space:'-0'}])
    assert.equal(recallPlace(where,names),'A chat Nocheh can’t name',JSON.stringify(where));
  assert.equal(recallPlace({space:'-1005',owner:'true',answer:'true'},names),'“Synthetic Forum”','only real flags count');
});

test('a chat or topic name keeps Persian joiners but loses what could break or fake its label',()=>{
  assert.equal(placeName('خانه\u200cی ما'),'خانه\u200cی ما','a zero-width non-joiner stays');
  assert.equal(placeName('Fam[ily]\u202e “x”\n\u2066y\u2069\u{e0041}'),'Fam ily x y');
  assert.equal(placeName(' a '.repeat(80)).length<=64,true);
  assert.equal(placeName('😀'.repeat(70)),'😀'.repeat(64),'a cut never splits a character');
  assert.equal(placeName(42),'');
  // A receipt's group keeps its quotes, but not brackets or hidden characters.
  assert.equal(recallPlace({answer:true,answer_group:'[“Fam\u202eily”]'},none),'Private answer asked in “Fam ily”');
  assert.equal(recallPlace({answer:true,answer_group:'[]\u200b'},none),'A private answer');
});

test('recall results are labelled from saved names, and a failed lookup only leaves a name out',async()=>{
  const seen:string[]=[];
  const pool=(rows:(sql:string)=>any[])=>({query:async(sql:string)=>{seen.push(sql);return {rows:rows(sql)};}}) as any;
  const at=new Date(1700000000000);
  const stores={control:pool(sql=>sql.includes('FROM chats')?[{id:'-1005',title:'Old [name]'},{id:'-1005/topic/9',title:'Owner named'}]:[]),
    archive:pool(sql=>sql.includes('forum_topic_created')?[{chat:'-1005/topic/9',name:'Trip plans',edited:false,received_at:at,id:'e2'}]:
      [{chat:'-1005',scope:'-1005',payload:Buffer.from(JSON.stringify({message:{chat:{id:-1005,title:'Synthetic Forum'}}})),received_at:at,id:'e1'}])};
  const result=await withRecallPlaces(stores,{hits:[
    {profile:'a',space:'123',owner:true,answer:false,kind:'native_note',text:'one'},
    {profile:'b',space:'-1005/topic/9',owner:false,answer:false,kind:'native_session',session:'s',text:'two'},
    {profile:'c',space:'123',owner:false,answer:true,answer_group:'“Synthetic Forum”',kind:'native_session',session:'t',text:'three'}],truncated:true,next_profile:'z'}) as any;
  assert.deepEqual(result,{truncated:true,next_profile:'z',hits:[
    {profile:'a',place:'Your private chat',kind:'native_note',text:'one'},
    {profile:'b',place:'“Synthetic Forum” › Trip plans',kind:'native_session',session:'s',text:'two'},
    {profile:'c',place:'Private answer asked in “Synthetic Forum”',kind:'native_session',session:'t',text:'three'}]});
  assert.equal(seen.length,3,'one lookup of each kind, for the groups among the hits only');

  seen.length=0;
  const owned=await withRecallPlaces(stores,{hits:[{profile:'a',space:'123',owner:true,answer:false,text:'one'}]}) as any;
  assert.equal(owned.hits[0].place,'Your private chat');assert.equal(seen.length,0,'no lookup without a group among the hits');

  const broken={query:async()=>{throw Error('synthetic database outage');}} as any;
  const failed=await withRecallPlaces({control:broken,archive:broken},{hits:[{profile:'b',space:'-1005/topic/9',owner:false,answer:false,text:'two'}]}) as any;
  assert.deepEqual(failed.hits,[{profile:'b',place:'A Telegram group › a topic',text:'two'}]);
  assert.deepEqual(await withRecallPlaces(stores,{error:'x'}),{error:'x'},'anything but hits passes through');
});

test('a recalled hit is named by its chat row, never by how its id looks: digest groups, an upgraded group and unknown ids (ADR-0252)',async t=>{
  t.after(installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS])));
  const names=new Map([[GP1,'GP one'],[GP1_TOPIC,'Plans'],[NG1,'NG one'],[NG1_TOPIC,'Trips'],[NG2,'NG two']]);
  assert.equal(recallPlace({space:GP1,owner:false,answer:false},names),'“GP one”');
  assert.equal(recallPlace({space:GP1_TOPIC,owner:false,answer:false},names),'“GP one” › Plans');
  assert.equal(recallPlace({space:NG1,owner:false,answer:false},names),'“NG one”','a digest group');
  assert.equal(recallPlace({space:NG1_TOPIC,owner:false,answer:false},names),'“NG one” › Trips','a digest group\'s topic');
  assert.equal(recallPlace({space:NG2,owner:false,answer:false},names),'“NG two”','a group Telegram upgraded');
  assert.equal(recallPlace({space:UNSERVED,owner:false,answer:false},none),'A Telegram group','a group not served is still a group');
  assert.equal(recallPlace({space:OWNER,owner:true,answer:false},names),'Your private chat');
  // A Telegram id is no Nocheh chat id, and an id with no row, however it looks, names no group (fail closed).
  for(const space of [NG1_TG,NG2_TG,NG2_OLD_TG,'-1009999999999','-1009999999999/topic/2',BOB_CHAT,OWNER,'0'.repeat(64)])
    assert.equal(recallPlace({space,owner:false,answer:false},names),'A chat Nocheh can’t name',space);

  // Names come from the chat rows by Nocheh id, and from the archive under every Telegram id the group has had: the
  // latest message names NG2 though it was sent under its old id, and NG1's topic is found by its key.
  const asked:{sql:string;values:unknown[]}[]=[],older=new Date(1700000000000),newer=new Date(1700000100000);
  const pool=(rows:(sql:string,values:any[])=>any[])=>({query:async(sql:string,values:any[])=>{asked.push({sql,values});return {rows:rows(sql,values)};}}) as any;
  const message=(id:number,title:string)=>Buffer.from(JSON.stringify({message:{chat:{id,title,type:'supergroup'}}}));
  const stores={
    control:pool(()=>[{id:NG1,title:'NG1 row'},{id:NG2,title:'NG2 row'},{id:NG1_TOPIC,title:'Topic row'}]),
    archive:pool(sql=>sql.includes('forum_topic_created')?[{chat:NG1_TOPIC,name:'Trips',edited:false,received_at:newer,id:'t1'}]:
      [{chat:NG2,scope:NG2_TG,payload:message(Number(NG2_TG),'NG2 before'),received_at:older,id:'a'},
       {chat:NG2,scope:NG2_OLD_TG,payload:message(Number(NG2_OLD_TG),'NG2 latest'),received_at:newer,id:'b'}])};
  const found=await recallNames(stores,[NG1,NG1_TOPIC,NG2,NG1_TG,'-1009999999999',OWNER]);
  assert.deepEqual(Object.fromEntries(found),{[NG1]:'NG1 row',[NG1_TOPIC]:'Trips',[NG2]:'NG2 latest'});
  assert.deepEqual(asked[0]!.values,[[NG1,NG2,NG1_TOPIC]],'chat rows are read by Nocheh ids only');
  const [groups,topics]=[asked[1]!.values,asked[2]!.values];
  assert.deepEqual(groups,[[NG1,NG2,NG2],[NG1_TG,...[NG2_TG,NG2_OLD_TG].sort()]],'the archive is read by every Telegram id each group has had');
  assert.deepEqual(topics,[[NG1_TOPIC],[NG1_TG],[NG1_TOPIC_KEY]],'a topic is read in its group\'s Telegram ids by its key');
  assert.equal(asked.length,3);
});
