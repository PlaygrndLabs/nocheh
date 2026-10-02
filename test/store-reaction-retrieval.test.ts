import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('archive reads link current captured reactions while preserving removal, guards and topic access',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-reaction-read-')),key='reaction-read:'+Date.now(),group='-'+Date.now();
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async()=>({literals:[]}),honcho:async()=>{throw Error('no provider');}});
  const capture=async(label:string,payload:any)=>{
    const value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:String(payload.message?.message_id??payload.message_reaction?.message_id??payload.message_reaction_count?.message_id),
      revision:String(payload.update_id),occurred_at:null,text:payload.message?.text??null,payload};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(topic=17)=>{const b=await s.guards.state();return {admin:false,scope:group,space:group+'/topic/'+topic,generation:b.generation,guard_epoch:b.epoch};};
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    const message={message_id:1,date:1700000000,chat:{id:Number(group),type:'supergroup'},message_thread_id:17,from:{id:7},text:'Review the packet.'};
    const target=await capture('target',{update_id:1,message});
    const base={chat:message.chat,message_id:1,date:1700000010,user:{id:7}};
    const added=await capture('added',{update_id:2,message_reaction:{...base,old_reaction:[],new_reaction:[{type:'emoji',emoji:'✅'}]}});
    assert.deepEqual((await s.sources.read(await actor(),target.id)).current_reactions.sources,['nocheh:event:'+added.id]);
    const removed=await capture('removed',{update_id:3,message_reaction:{...base,old_reaction:[{type:'emoji',emoji:'✅'}],new_reaction:[]}});
    const latest=await s.sources.read(await actor(),target.id);
    assert.deepEqual(latest.current_reactions,{sources:['nocheh:event:'+removed.id],complete:false});
    await assert.rejects(s.sources.read(await actor(),added.id),{code:'source_not_found'},'superseded state must not become a readable current source');
    const removal=await s.sources.read(await actor(),removed.id);
    assert.deepEqual((removal.event.payload as any).message_reaction.new_reaction,[]);
    await assert.rejects(s.sources.read(await actor(18),target.id),{code:'source_not_found'});
    await assert.rejects(s.sources.read(await actor(18),removed.id),{code:'source_not_found'});
    const aggregate=await capture('aggregate',{update_id:4,message_reaction_count:{chat:message.chat,message_id:1,date:1700000011,reactions:[{type:{type:'emoji',emoji:'👍'},total_count:2}]}});
    assert.deepEqual(new Set((await s.sources.read(await actor(),target.id)).current_reactions.sources),new Set(['nocheh:event:'+removed.id,'nocheh:event:'+aggregate.id]));
    const guarded=await s.guards.read('events:'+removed.id,await s.guards.state());
    const changed=structuredClone(guarded.value) as any;changed.payload.message_reaction.old_reaction=[{type:'emoji',emoji:'👍'}];
    await s.guards.edit('events:'+removed.id,guarded.revision,changed,key+':guard-edit');
    assert.deepEqual((await s.sources.read(await actor(),removed.id)).event.payload,changed.payload,'reaction content must use the owner-edited guarded representation');
    await s.guards.setMode('off');
    assert.deepEqual(((await s.sources.read(await actor(),removed.id)).event.payload as any).message_reaction.old_reaction,[{type:'emoji',emoji:'✅'}]);
    await s.retirements.set({admin:true,scope:null},target.id,{retired:true,expected_revision:0,operation_id:key+':retire'});
    await assert.rejects(s.sources.read(await actor(),target.id),{code:'source_not_found'});
    await assert.rejects(s.sources.read(await actor(),removed.id),{code:'source_not_found'});
    assert.equal((await s.sources.read({admin:true,scope:null},target.id)).current_reactions.sources.length,2,'owner inspection retains original evidence after retirement');
  }finally{await s.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});
