import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {SourceRepository} from '../src/stores/retrieval.js';
import {fixtureServices} from './fixture-brain.js';

/** A result without the fields ADR-0259 adds, to compare with what the same read gave before. */
const plain=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(plain);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['tag','by','at','owner','reply_source'].includes(key)).map(([key,item])=>[key,plain(item)]));
};

test('search hits, memory hits, reactions and page items name their source, and keep every field they had (ADR-0259)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-search-tags-'));
  // Synthetic groups GP1 (a forum, A) and GP2 (B). The owner is account 123.
  const run=Date.now(),A='-100'+run,B='-100'+(run+1),word='kestrel'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A,B],topic_memory:'group'};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const zone=(await stores.control.query('SELECT settings FROM owner_task_settings WHERE singleton')).rows[0]?.settings??{};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0;
    const capture=async(scope:string,payload:Record<string,any>):Promise<SourceReference>=>{
      const update=++serial,inner=payload.message??payload.message_reaction;
      const value={version:1,key:`search-tags:${run}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(inner?.message_id??update),
        revision:String(update),occurred_at:String(inner.date),text:inner?.text??null,payload:{update_id:update,...payload}} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    // 2025-11-03 14:12 UTC, 15:12 in Europe/Berlin.
    const T=1762179120,chat=(id:string,title:string)=>({id:Number(id),type:'supergroup',title,is_forum:true});
    const sam={id:123,is_bot:false,first_name:'Sam',username:'sam_owner'},bob={id:456,is_bot:false,first_name:'Bob',username:'bob_gp'},ana={id:789,is_bot:false,first_name:'Ana'};
    let id=0;
    const message=(where:Record<string,unknown>,from:Record<string,unknown>,text:string,date:number,more:Record<string,unknown>={})=>({message_id:++id,date,chat:where,from,text,...more});
    const ownerPrivate=await capture('123',{message:message({id:123,type:'private',first_name:'Sam'},sam,`Owner private ${word}`,T)});
    const bobMessage=message(chat(A,'GP1'),bob,`Bob ${word} plan`,T),bobA=await capture(A,{message:bobMessage});
    const samA=await capture(A,{message:message(chat(A,'GP1'),sam,`Owner ${word} words`,T+60)});
    const reply=await capture(A,{message:message(chat(A,'GP1'),ana,`Ana ${word} reply`,T+120,{reply_to_message:bobMessage})});
    const openingMessage=message(chat(A,'GP1'),bob,'',T+180,{message_thread_id:77,is_topic_message:true,forum_topic_created:{name:'Trips',icon_color:1}});
    const opening=await capture(A,{message:openingMessage});
    const t77=await capture(A,{message:message(chat(A,'GP1'),bob,`Bob ${word} in trips`,T+240,{message_thread_id:77,is_topic_message:true,reply_to_message:openingMessage})});
    const bobB=await capture(B,{message:message(chat(B,'GP2'),bob,`Bob ${word} in GP2`,T)});
    const reaction=await capture(A,{message_reaction:{chat:chat(A,'GP1'),message_id:bobMessage.message_id,date:T+300,user:ana,old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}});
    await stores.control.query(`UPDATE owner_task_settings SET settings=jsonb_set(settings,'{time_zone}','"Europe/Berlin"') WHERE singleton`);

    const binding=await s.guards.state();
    const reader=(scope:string|null,space:string,turnEvent:string):Reader=>({admin:false,scope,space,turnEvent,generation:binding.generation,guard_epoch:binding.epoch});
    const owner=reader(null,'123',ownerPrivate.id),general=reader(A,A,bobA.id),other=reader(B,B,bobB.id);
    // The same reads without source tags: what each result held before ADR-0259.
    const before=new SourceRepository(s.access,s.attachments,s.selections);
    const named=(hits:any[])=>Object.fromEntries(hits.map(hit=>[hit.source,`${hit.by}: ${hit.tag}`]));

    // archive_search: every hit names its source; every field it had stays.
    const groupHits=await s.sources.search(general,word,10);
    assert.deepEqual(plain(groupHits),await before.search(general,word,10),'nothing a hit had is removed');
    assert.deepEqual(named(groupHits),{
      ['nocheh:event:'+bobA.id]:'person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC',
      ['nocheh:event:'+samA.id]:'owner: “Sam” (@sam_owner) · this chat · 2025-11-03 14:13 UTC',
      ['nocheh:event:'+reply.id]:'person: “Ana” · this chat · 2025-11-03 14:14 UTC',
      ['nocheh:event:'+t77.id]:'person: “Bob” (@bob_gp) · group “GP1” › topic “Trips” · 2025-11-03 14:16 UTC'});
    assert.equal(groupHits.find(hit=>hit.id===bobA.id).at,'2025-11-03T14:12:00.000Z');
    const ownerHits=await s.sources.search(owner,word,10);
    assert.deepEqual(plain(ownerHits),await before.search(owner,word,10));
    assert.equal(named(ownerHits)['nocheh:event:'+ownerPrivate.id],'owner: the owner · this chat · 2025-11-03 15:12 Europe/Berlin');
    assert.equal(named(ownerHits)['nocheh:event:'+bobB.id],'person: “Bob” (@bob_gp) · group “GP2” · 2025-11-03 15:12 Europe/Berlin');
    const outside:Reader={admin:false,scope:A,space:A,generation:binding.generation,guard_epoch:binding.epoch};
    assert.deepEqual(await s.sources.search(outside,word,10),await before.search(outside,word,10),'a reader outside a turn reads today\'s shapes');
    const otherHits=await s.sources.search(other,word,10);
    assert.deepEqual(named(otherHits),{['nocheh:event:'+bobB.id]:'person: “Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC'},'GP2 finds nothing of GP1');
    assert.ok(!JSON.stringify(otherHits).includes('GP1'),'GP2 never reads GP1\'s name');
    for(const never of ['Europe/Berlin','the owner','Owner private'])assert.ok(!JSON.stringify([groupHits,otherHits]).includes(never),`a member never reads ${never}`);

    // memory_search: the same hits in the same order; only those named first in their batch carry a tag.
    const ids=[bobA.id,bobB.id,samA.id,reply.id],first=new Set([bobA.id,reply.id]);
    const memoryHits=await s.sources.found(general,ids,5,first);
    assert.deepEqual(plain(memoryHits),await before.found(general,ids,5),'the same hits, ids, order and text');
    assert.deepEqual(memoryHits.map(hit=>hit.tag??null),['“Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC',null,'“Ana” · this chat · 2025-11-03 14:14 UTC']);
    assert.deepEqual(await s.sources.found(general,ids,5),await before.found(general,ids,5),'without a batch position, today\'s fields alone');

    // current_reactions: the reaction and the message it reacts to name their source; the reaction's fields stay.
    const reactions=await s.sources.currentReactions(general,10),found=reactions.sources.find(item=>item.source==='nocheh:event:'+reaction.id) as any;
    assert.ok(found,'the reaction is found');
    assert.deepEqual(plain(reactions),await before.currentReactions(general,10));
    assert.deepEqual([found.by,found.tag],['person','“Ana”, a reaction · this chat · 2025-11-03 14:17 UTC']);
    assert.deepEqual([found.targets[0].by,found.targets[0].tag],['person','“Bob” (@bob_gp) · this chat · 2025-11-03 14:12 UTC']);

    // archive_page: owner:true on the owner's own typing; reply_source only for a reply whose message is off the page, and
    // never for a topic's opening, which every message in the topic answers.
    const page=(principal:Reader,from='')=>s.sources.page(principal,{chat:'',from,to:'',after:'',count:50});
    const whole=await page(general),item=(items:any[],ref:SourceReference)=>items.find(entry=>entry.source==='nocheh:event:'+ref.id);
    assert.deepEqual(plain(whole),plain(await before.page(general,{chat:'',from:'',to:'',after:'',count:50})));
    assert.deepEqual(whole.items.filter((entry:any)=>entry.owner).map((entry:any)=>entry.source),['nocheh:event:'+samA.id]);
    assert.equal(item(whole.items,reply).reply_to,String(bobMessage.message_id));
    assert.equal(item(whole.items,reply).reply_source,undefined,'the message it answers is on this page');
    assert.equal(item(whole.items,t77).reply_source,undefined);
    const later=await page(general,new Date((T+90)*1000).toISOString());
    assert.equal(item(later.items,bobA),undefined);
    assert.equal(item(later.items,reply).reply_source,'nocheh:event:'+bobA.id,'off the page, the reply opens what it answers');
    const topicOnly=await page(general,new Date((T+200)*1000).toISOString());
    assert.equal(item(topicOnly.items,opening),undefined);
    assert.deepEqual([item(topicOnly.items,t77).reply_to,item(topicOnly.items,t77).reply_source],[String(openingMessage.message_id),undefined],
      'a message in a topic is no reply to the topic\'s opening');
    const ownerLater=await s.sources.page(owner,{chat:A,from:new Date((T+90)*1000).toISOString(),to:'',after:'',count:50});
    assert.equal(item(ownerLater.items,reply).reply_source,'nocheh:event:'+bobA.id);
    assert.deepEqual(plain(ownerLater),plain(await before.page(owner,{chat:A,from:new Date((T+90)*1000).toISOString(),to:'',after:'',count:50})));
  } finally {
    await stores.control.query('UPDATE owner_task_settings SET settings=$1 WHERE singleton',[JSON.stringify(zone)]).catch(()=>{});
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});
