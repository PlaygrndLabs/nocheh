import {test} from 'node:test';
import assert from 'node:assert/strict';
import {placeName,recallPlace,withRecallPlaces} from '../src/stores/recall-places.js';

const none=new Map<string,string>();

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
  const stores={control:pool(sql=>sql.includes('telegram_chat_observations')?[{chat_id:'-1005',title:'Old [name]'}]:
      sql.includes('telegram_topic_registrations')?[{chat_id:'-1005',topic_id:9,name:'Owner named'}]:[]),
    archive:pool(sql=>sql.includes('forum_topic_created')?[{chat:'-1005',topic:'9',name:'Trip plans'}]:
      [{scope:'-1005',payload:Buffer.from(JSON.stringify({message:{chat:{id:-1005,title:'Synthetic Forum'}}}))}])};
  const result=await withRecallPlaces(stores,{hits:[
    {profile:'a',space:'123',owner:true,answer:false,kind:'native_note',text:'one'},
    {profile:'b',space:'-1005/topic/9',owner:false,answer:false,kind:'native_session',session:'s',text:'two'},
    {profile:'c',space:'123',owner:false,answer:true,answer_group:'“Synthetic Forum”',kind:'native_session',session:'t',text:'three'}],truncated:true,next_profile:'z'}) as any;
  assert.deepEqual(result,{truncated:true,next_profile:'z',hits:[
    {profile:'a',place:'Your private chat',kind:'native_note',text:'one'},
    {profile:'b',place:'“Synthetic Forum” › Trip plans',kind:'native_session',session:'s',text:'two'},
    {profile:'c',place:'Private answer asked in “Synthetic Forum”',kind:'native_session',session:'t',text:'three'}]});
  assert.equal(seen.length,4,'one lookup of each kind, for the groups among the hits only');

  seen.length=0;
  const owned=await withRecallPlaces(stores,{hits:[{profile:'a',space:'123',owner:true,answer:false,text:'one'}]}) as any;
  assert.equal(owned.hits[0].place,'Your private chat');assert.equal(seen.length,0,'no lookup without a group among the hits');

  const broken={query:async()=>{throw Error('synthetic database outage');}} as any;
  const failed=await withRecallPlaces({control:broken,archive:broken},{hits:[{profile:'b',space:'-1005/topic/9',owner:false,answer:false,text:'two'}]}) as any;
  assert.deepEqual(failed.hits,[{profile:'b',place:'A Telegram group › a topic',text:'two'}]);
  assert.deepEqual(await withRecallPlaces(stores,{error:'x'}),{error:'x'},'anything but hits passes through');
});
