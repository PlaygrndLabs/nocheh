import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {observedSource} from '../src/observed-source.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {RelationshipRepository} from '../src/stores/relationships.js';

const event=(key:string,payload:any):Envelope=>({version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-42',
  source_id:String(payload.message?.message_id??payload.message_reaction?.message_id??payload.message_reaction_count?.message_id??1),
  revision:String(payload.update_id),occurred_at:null,text:payload.message?.text??null,payload});
const check={type:'emoji',emoji:'✅'},heart={type:'custom_emoji',custom_emoji_id:'1234'};
test('reaction observations retain actor changes, removals, anonymous counts and unknown types without meanings',()=>{
  const value=event('reaction',{update_id:3,message_reaction:{chat:{id:-42},message_id:1,date:1700000000,user:{id:9},old_reaction:[check],new_reaction:[heart]}});
  const source=observedSource(value),reaction=source.metadata!.reaction as any;
  assert.equal(source.object.kind,'reaction_change');assert.equal(source.object.external_id,'3');
  assert.equal(source.relations.find(r=>r.kind==='reaction_to')?.target.external_id,'1');
  assert.equal(source.relations.find(r=>r.kind==='authored_by')?.target.external_id,'9');
  assert.deepEqual(reaction.added,[heart]);assert.deepEqual(reaction.removed,[check]);assert.equal(reaction.date,'1700000000');
  assert.equal((source.metadata!.audience as any).topic_state,'unknown');
  const removed=observedSource(event('removal',{update_id:4,message_reaction:{...(value.payload.message_reaction as object),user:undefined,actor_chat:{id:-10},new_reaction:[]}}));
  assert.equal(removed.relations.find(r=>r.kind==='authored_by')?.target.kind,'conversation');
  assert.deepEqual((removed.metadata!.reaction as any).removed,[check]);
  const aggregate=observedSource(event('counts',{update_id:5,message_reaction_count:{chat:{id:-42},message_id:1,date:1700000002,reactions:[{type:check,total_count:3}]}}));
  assert.equal(aggregate.relations.some(r=>r.kind==='authored_by'),false);
  assert.deepEqual((aggregate.metadata!.reaction as any).counts,[{type:check,total_count:3}]);
  assert.equal((aggregate.metadata!.reaction as any).before,null);assert.equal((aggregate.metadata!.reaction as any).added,null);
  const future=observedSource(event('future',{update_id:6,message_reaction:{...(value.payload.message_reaction as object),new_reaction:[{type:'future_type',unknown:42}]}}));
  assert.deepEqual((future.metadata!.reaction as any).added,[{type:'future_type',unknown:42}]);
  const malformed=observedSource(event('malformed',{update_id:7,message_reaction:{...(value.payload.message_reaction as object),old_reaction:null}}));
  assert.equal((malformed.metadata!.reaction as any).removed,null);
});

test('old targets resolve outside graph pagination; duplicates, delays and unknown topic membership remain safe',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),relationships=new RelationshipRepository(archive);
  const key=`relation:${Date.now()}`,chatId=String(-Date.now()),topic={kind:'conversation' as const,chat_id:chatId,topic_id:'17'};
  const change=event(key+':reaction',{update_id:30,message_reaction:{chat:{id:chatId},message_id:1,date:1700000010,user:{id:9},old_reaction:[],new_reaction:[check]}});
  const capture=(value:Envelope)=>archive.capture({...value,scope:chatId});
  try {
    const reaction=(await capture(change)).source.reference;
    assert.equal((await relationships.context(reaction,topic)).source,null);
    assert.equal((await relationships.context(reaction,{kind:'conversation',chat_id:chatId,topic_id:null})).source,null);
    assert.equal((await relationships.context(reaction,{kind:'owner'})).targets[0]?.unresolved,true);
    assert.equal((await capture(change)).duplicate,true);
    const parent=event(key+':parent',{update_id:10,message:{message_id:1,chat:{id:chatId,type:'supergroup',is_forum:true},message_thread_id:17,text:'Older original'}});
    const original=(await capture(parent)).source.reference;
    const resolved=await relationships.context(reaction,topic,1);
    assert.deepEqual(resolved.targets[0]?.references,[original]);
    assert.equal((await relationships.context(reaction,{...topic,topic_id:'18'})).source,null);
    const reply=(await capture(event(key+':reply',{update_id:40,message:{message_id:99,chat:{id:chatId,type:'supergroup'},message_thread_id:17,reply_to_message:{message_id:1},text:'Reply much later'}}))).source.reference;
    assert.deepEqual((await relationships.context(reply,topic,1)).targets[0]?.references,[original]);
    const delayed=(await capture(event(key+':delayed',{update_id:20,message_reaction:{...(change.payload.message_reaction as object),date:1700000005,old_reaction:[heart],new_reaction:[]}}))).source.reference;
    assert.deepEqual((await relationships.describe(delayed)).reaction?.removed,[heart]);
    assert.deepEqual((await relationships.describe(reaction)).reaction?.added,[check],'a delayed observation does not overwrite later evidence');
    const counts=(await capture(event(key+':counts',{update_id:31,message_reaction_count:{chat:{id:chatId},message_id:1,date:1700000011,reactions:[]}}))).source.reference;
    assert.deepEqual((await relationships.describe(counts)).reaction?.counts,[]);
    const unknown=(await capture(event(key+':unknown',{update_id:50,message:{message_id:101,chat:{id:chatId,type:'supergroup'},text:'Topic not supplied'}}))).source.reference;
    assert.equal((await relationships.context(unknown,{...topic,topic_id:null})).source,null);
    const otherChat=String(Number(chatId)-1);
    const foreign=(await capture(event(key+':foreign',{update_id:51,message:{message_id:102,chat:{id:chatId,type:'supergroup'},message_thread_id:17,
      external_reply:{chat:{id:otherChat},message_id:77},text:'External reply'}}))).source.reference;
    assert.equal((await relationships.context(foreign,topic)).targets.length,0);
    assert.equal((await relationships.context(foreign,{kind:'owner'})).targets[0]?.unresolved,true);
    const bytes=(await stores.archive.query('SELECT payload FROM events WHERE id=$1',[reaction.id])).rows[0].payload;
    assert.equal(bytes.toString(),canonical(change.payload));
    // Conflicting topic observations cannot expand access or be resolved by arrival order.
    await capture(event(key+':conflict',{update_id:11,message:{...(parent.payload.message as object),message_thread_id:18}}));
    assert.equal((await relationships.context(reaction,topic)).source,null);
  } finally {await stores.close();}
});
