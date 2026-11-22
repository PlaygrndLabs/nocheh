import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ensureAccount,ensureConnection} from '../src/stores/chats.js';
import {accountPeopleNames} from '../src/stores/entities.js';
import {fixtureServices} from './fixture-brain.js';

// ADR-0273: the name the owner sets in People is the person's name everywhere; the owner's private note is never.
test('a People name reaches groups and memory; the owner\'s private note reaches only the owner\'s own recall',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-people-notes-'));
  const run=Date.now(),key='people-notes:'+run,group='-100'+run,bob=Number(String(run).slice(-9)),NOTE='PRIVATE-NOTE-'+run,NAME='Robert Example '+run;
  const calls:{path:string;body:unknown}[]=[];let sequence=0;
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',owner_chat:'123',group_ids:[group]}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async(path,body:any)=>{
      calls.push({path,body});
      if(path.endsWith('/messages/list'))return {items:[]};
      if(path.endsWith('/messages'))return [{...body.messages[0],id:String(++sequence).padStart(21,'m')}];
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.includes('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'Summary.'},peer_representation:'Learned.'};
      if(path.endsWith('/representation'))return {representation:'Learned.'};
      if(path.endsWith('/chat'))return {content:'Recalled.'};
      if(path.includes('/conclusions/list'))return {items:[],next_page:null};
      return {};
    })});
  try {
    let serial=0;
    const say=async(from:number,first:string,text:string,chat=group)=>{
      const id=++serial,kind=chat===group?{type:'supergroup',is_forum:false}:{type:'private'};
      const event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:'999',scope:chat,source_id:String(id),revision:'1',occurred_at:null,text,
        payload:{update_id:id,message:{message_id:id,date:1700000000+id,chat:{id:Number(chat),...kind},from:{id:from,is_bot:false,first_name:first},text}}};
      const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    await s.guards.reconcile();await s.guards.setMode('off');await s.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now() WHERE singleton');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    const owner:Reader={admin:true,scope:null};
    const first=await say(bob,'Bob','Hello all.');
    for(const item of await s.memory.queueSource(first))for(const receipt of item.receipts)await s.memory.syncReceipt(receipt,authority);
    const person=(await s.entities.context(first,[])).speaker!;
    assert.equal(person.name,'Bob');
    const unnamed=await s.entities.list(owner,{kind:'person',query:'bob'});
    assert.equal(unnamed.entities.find(entity=>entity.id===person.id)?.people_name,undefined,'a name Nocheh gave by itself is not the owner\'s');

    // The owner renames Bob and writes a private note.
    await s.entities.rename(owner,person.id,{name:NAME,expected_revision:person.revision,operation_id:key+':rename'});
    const groupReader:Reader={admin:false,scope:group,space:group};
    await assert.rejects(s.entities.note(groupReader,person.id,{note:'x',expected_revision:0,operation_id:key+':denied'}),{code:'owner_required'});
    await assert.rejects(s.entities.note(owner,person.id,{note:NOTE,expected_revision:1,operation_id:key+':stale'}),{code:'entity_note_conflict'});
    const epoch=(await s.guards.state()).epoch;
    assert.deepEqual(await s.entities.note(owner,person.id,{note:' '+NOTE+' ',expected_revision:0,operation_id:key+':note'}),{id:person.id,revision:1});
    assert.equal((await s.guards.state()).epoch,epoch,'a note changes nothing memory holds, so no refresh');
    const inspected=await s.entities.inspect(owner,person.id) as any;
    assert.deepEqual(inspected.note,{note:NOTE,revision:1});
    assert.equal(inspected.entity.revision,person.revision+1,'the note leaves the person\'s own revision alone');
    await assert.rejects(s.entities.ownerNotes(groupReader,[person.id]),{code:'owner_required'});
    const commands=JSON.stringify((await stores.control.query("SELECT result FROM owner_commands WHERE id=$1",[key+':note'])).rows);
    assert.ok(!commands.includes(NOTE),'the stored command result holds no note text');
    const listed=await s.entities.list(owner,{kind:'person',query:'robert'});
    assert.equal(listed.entities.find(entity=>entity.id===person.id)?.people_name,true,'the owner sees which names everyone reads');

    // Everyone reads the People name: a member's Telegram account, task assignees and reminders read it.
    const account=await ensureAccount(stores.control,await ensureConnection(stores.control,'telegram'),{external:String(bob),display_name:'Bob'});
    assert.equal((await accountPeopleNames(stores.control,[account])).get(account),NAME);

    // Bob writes again: group memory names him by the People name, and the note reaches no write and no engine call.
    const second=await say(bob,'Bob','The launch moves to Monday.');
    const queued=await s.memory.queueSource(second);
    for(const item of queued)for(const receipt of item.receipts)await s.memory.syncReceipt(receipt,authority);
    const rows=(await stores.control.query(`SELECT audience,prepared_id FROM memory_ingestion_receipts WHERE source_reference->>'id'=$1 AND retired_at IS NULL`,[second.id])).rows;
    const written=(await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=ANY($1::text[])',[rows.map(row=>row.prepared_id)])).rows.map(row=>row.content.toString());
    assert.ok(written.length>0);
    assert.ok(written.some(text=>text.includes(JSON.stringify({sender_name:NAME}).slice(1,-1))),'group memory calls the sender by the People name');
    assert.ok(!JSON.stringify(calls).includes(NOTE)&&!written.some(text=>text.includes(NOTE)),'the note never reaches the memory engine');

    const binding=await s.guards.state();
    await stores.control.query(`INSERT INTO learning_refresh_sweeps(installation_generation,guard_epoch,family,stage)
      VALUES($1,$2,'honcho','done') ON CONFLICT(installation_generation,guard_epoch,family) DO UPDATE SET stage='done'`,[binding.generation,binding.epoch]);
    await s.memory.observe(queued[0]!.workspace);
    const member:Reader={admin:false,scope:group,space:group,turnEvent:second.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const inGroup=JSON.stringify(await s.memory.recall(member,`What did ${NAME} say about the launch?`));
    assert.ok(!inGroup.includes(NOTE),'a group\'s recall never holds the note');
    // The owner asks in their own private chat.
    const asked=await say(123,'Owner','What did Robert say?','123'),now=await s.guards.state();
    const ownTurn:Reader={admin:false,scope:null,space:'123',turnEvent:asked.id,generation:now.generation,guard_epoch:now.epoch};
    const own=JSON.stringify(await s.memory.recall(ownTurn,`What did ${NAME} say about the launch?`));
    assert.ok(own.includes(NOTE),'the owner\'s own recall holds the note');
    assert.ok(own.includes(`private note about ${NAME}`),'under its own header');
    assert.ok(!JSON.stringify(calls).includes(NOTE),'and still never the engine');

    // A cleared note is gone from the owner's recall.
    await s.entities.note(owner,person.id,{note:'',expected_revision:1,operation_id:key+':clear'});
    const cleared=JSON.stringify(await s.memory.recall(ownTurn,`What did ${NAME} say?`));
    assert.ok(cleared.includes('Recalled.')&&!cleared.includes(NOTE));
  } finally {
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});
