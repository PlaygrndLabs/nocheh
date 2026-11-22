import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {chatDirectory,installChatsForTest} from '../src/chats.js';

test('a conversation is read in time order, page by page, only by those who may read it',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),bare=Date.now(),group='-100'+bare,other='-200'+bare,key='conversation-page:'+bare;
  const s=fixtureServices(stores,{dataDir:'/tmp/nocheh-conversation-page-fixture',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'42',group_ids:[group,other]}),
    runtime:async()=>{throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('honcho_not_expected');})});
  const update=(chat:string,suffix:string,date:number,body:Record<string,unknown>,kind='telegram_update'):Envelope=>({version:1,key:key+suffix,origin:'live',
    bot_id:'fixture',kind,scope:chat,source_id:String(((body.message??body.edited_message??body.message_reaction) as any).message_id),
    revision:String(body.update_id??suffix),occurred_at:kind==='telegram_update'?String(date):null,
    text:String((body.message as any)?.text??(body.edited_message as any)?.text??''),payload:body});
  const message=(chat:string,id:number,date:number,text:string,extra:Record<string,unknown>={})=>
    ({message_id:id,date,chat:{id:Number(chat),type:'supergroup'},from:{id:7,first_name:'Example'},text,...extra});
  const capture=async(value:Envelope)=>(await s.capture.capture(value)).source.reference;
  try{
    // Saved out of order; read back by the time Telegram gave each message.
    const second=await capture(update(group,':second',1700000100,{update_id:2,message:message(group,2,1700000100,'Second plan step',{reply_to_message:message(group,1,1700000000,'First')})}));
    const first=await capture(update(group,':first',1700000000,{update_id:1,message:message(group,1,1700000000,'First plan step')}));
    const edit=await capture(update(group,':edit',1700000200,{update_id:3,edited_message:message(group,1,1700000000,'First plan step, edited',{edit_date:1700000200})}));
    const reaction=await capture(update(group,':reaction',1700000300,{update_id:4,message_reaction:{chat:{id:Number(group),type:'supergroup'},message_id:1,
      user:{id:8,first_name:'Ana'},date:1700000300,old_reaction:[],new_reaction:[{type:'emoji',emoji:'✅'}]}}));
    const reply=await capture(update(group,':reply',0,{message:{message_id:5,date:1700000400,chat:{id:Number(group),type:'supergroup'},from:{id:9,is_bot:true,first_name:'Bot'},text:'Noted'}},
      'telegram_delivered_message'));
    const foreign=await capture(update(other,':foreign',1700000050,{update_id:6,message:message(other,1,1700000050,'Other group plan')}));
    await s.guards.setMode('on');
    for(const reference of [second,first,edit,reaction,foreign])await s.guards.prepare(reference,'fixture',async()=>[]);
    const binding=await s.guards.state();
    const member:Reader={admin:false,scope:group,space:group,generation:binding.generation,guard_epoch:binding.epoch};
    const owner:Reader={admin:false,scope:null,space:'42',generation:binding.generation,guard_epoch:binding.epoch};
    const page=(principal:Reader,input:Partial<{chat:string;from:string;to:string;after:string;count:number}>)=>
      s.sources.page(principal,{chat:'',from:'',to:'',after:'',count:30,...input});

    const one=await page(member,{count:2});
    assert.deepEqual(one.items.map(item=>item.source),[first,second].map(reference=>'nocheh:event:'+reference.id));
    assert.deepEqual(one.items.map(item=>[item.type,item.text,item.reply_to]),[['message','First plan step',undefined],['message','Second plan step','1']]);
    assert.deepEqual([one.position,one.complete,one.chat],[{through:2,total:5},false,group]);
    const two=await page(member,{after:one.next!});
    assert.deepEqual(two.items.map(item=>item.type),['edit','reaction','assistant']);
    assert.deepEqual((two.items[1] as any).reaction,{change:'Added ✅',by:'Ana',message_id:'1'});
    assert.deepEqual(two.items[2],{source:'nocheh:event:'+reply.id,at:(two.items[2] as any).at,type:'assistant',checking:true},'a reply not yet checked for secrets shows no text');
    assert.deepEqual([two.next,two.complete,two.position],[null,true,{through:5,total:5}]);
    assert.ok(!JSON.stringify([one,two]).includes('Other group'),'another group stays out');

    const ranged=await page(member,{from:'2023-11-14T22:14:00Z',to:'2023-11-14T22:17:00Z'});
    assert.deepEqual(ranged.items.map(item=>item.type),['message','edit'],'from and to bound the times read');
    await assert.rejects(page(member,{chat:other}),{code:'conversation_not_permitted'});
    await assert.rejects(page(member,{after:'not-a-cursor'}),{code:'invalid_cursor'});
    assert.deepEqual((await page(owner,{chat:other})).items.map(item=>item.text),['Other group plan'],'the owner may read any chat');
    assert.deepEqual((await page(owner,{})).items,[],'without a chat the owner reads their private chat');

    const found=await s.sources.found(member,[foreign.id,second.id,digest('missing'),first.id],5);
    assert.deepEqual(found.map(hit=>[hit.source,hit.text]),[['nocheh:event:'+second.id,'Second plan step'],['nocheh:event:'+first.id,'First plan step']]);
  }finally{await s.guards.setMode('on');await stores.close();}
});

test('a group Telegram upgraded after step 2b keeps its id, and its messages from before the upgrade still page and search (ADR-0252)',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  // The group was stored before step 2b as '-4…', which stays its Nocheh id; Telegram later moved it to '-100…', a new
  // current id of the same chat. A look-alike group ('-100…' plus one digit) is another chat.
  const bare=String(Date.now()).slice(-10),old='-4'+bare,upgraded='-100'+bare,alike='-100'+bare+'1',key='conversation-upgrade:'+bare;
  const restore=installChatsForTest(chatDirectory({owner_chat:'42',chats:[
    {id:'42',app:'telegram',kind:'private',parent_id:null,topic_key:null,state:'active'},
    {id:old,app:'telegram',kind:'group',parent_id:null,topic_key:null,state:'active'},
    {id:alike,app:'telegram',kind:'group',parent_id:null,topic_key:null,state:'active'}],ids:[
    {app:'telegram',external_id:'42',chat_id:'42',state:'current'},{app:'telegram',external_id:upgraded,chat_id:old,state:'current'},
    {app:'telegram',external_id:old,chat_id:old,state:'old'},{app:'telegram',external_id:alike,chat_id:alike,state:'current'}]}));
  const stores=connectStores(config,passwords);
  const s=fixtureServices(stores,{dataDir:'/tmp/nocheh-conversation-upgrade-fixture',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'42',group_ids:[upgraded,alike]}),
    runtime:async()=>{throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('honcho_not_expected');})});
  const capture=async(chat:string,id:number,date:number,text:string)=>(await s.capture.capture({version:1,key:key+':'+chat+':'+id,origin:'live',bot_id:'fixture',
    kind:'telegram_update',scope:chat,source_id:String(id),revision:String(id),occurred_at:String(date),text,
    payload:{update_id:id,message:{message_id:id,date,chat:{id:Number(chat),type:'supergroup'},from:{id:7,first_name:'Example'},text}}})).source.reference;
  try{
    const before=await capture(old,1,1700000000,'Plan from before the upgrade');
    const after=await capture(upgraded,2,1700000100,'Plan from after the upgrade');
    const other=await capture(alike,3,1700000050,'Plan of a look-alike group');
    await s.guards.setMode('on');
    for(const reference of [before,after,other])await s.guards.prepare(reference,'fixture',async()=>[]);
    const binding=await s.guards.state();
    const member:Reader={admin:false,scope:old,space:old,generation:binding.generation,guard_epoch:binding.epoch};
    const read=await s.sources.page(member,{chat:'',from:'',to:'',after:'',count:30});
    assert.deepEqual(read.items.map(item=>item.text),['Plan from before the upgrade','Plan from after the upgrade'],'both of its Telegram ids, and no look-alike');
    assert.equal(read.chat,old,'the chat keeps the id it had before the upgrade');
    const found=await s.sources.found(member,[other.id,after.id,before.id],5);
    assert.deepEqual(found.map(hit=>hit.text),['Plan from after the upgrade','Plan from before the upgrade']);
    const neighbour:Reader={admin:false,scope:alike,space:alike,generation:binding.generation,guard_epoch:binding.epoch};
    assert.deepEqual((await s.sources.page(neighbour,{chat:'',from:'',to:'',after:'',count:30})).items.map(item=>item.text),['Plan of a look-alike group']);
  }finally{restore();await s.guards.setMode('on');await stores.close();}
});
