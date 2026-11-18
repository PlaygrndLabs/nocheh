import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {accountIdFor,chatIdFor} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {ChatSeeder,chatSeedColumns} from '../src/stores/chat-seed.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
async function open():Promise<StorePools> {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  return connectStores(config,passwords);
}
/** The chat records the seeder writes. Every other table, in every store, must be left exactly as it was. */
const chatRecordTables=new Set(['chat_connections','chat_accounts','chats','chat_ids','chat_details','chat_seed_state','chat_directory_state']);
/** A checksum of every row of every table, per store and table. */
async function checksums(stores:StorePools):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  for(const store of ['archive','derived','control'] as const) {
    const tables=(await stores[store].query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY 1`)).rows;
    for(const {table_name:table} of tables)
      result[store+'.'+table]=(await stores[store].query(`SELECT count(*)::text||':'||coalesce(md5(string_agg(md5(t::text),'' ORDER BY md5(t::text))),'') AS sum FROM "${table}" t`)).rows[0].sum;
  }
  return result;
}
const without=(sums:Record<string,string>)=>Object.fromEntries(Object.entries(sums).filter(([key])=>!chatRecordTables.has(key.split('.')[1]!)));

test('the seeder gives every stored chat value its row, only inserts, changes no other table, and a second run changes nothing',fixture,async()=>{
  const stores=await open(),base=Date.now(),person=(n:number)=>String(base%1000000000*10+n);
  // Old-shaped values, stored before step 2b: a group and its topic, a private chat, the owner's private chat, a group
  // only the archive saw, a private chat only the archive saw, and a group Telegram upgraded before.
  const group='-100'+base,topic=group+'/topic/7',named=group+'/topic/9',privateChat=person(1),archived='-100'+(base+1),alice=person(2);
  const owner=person(3),upgraded='-100'+(base+3),notChats=['*','owner','system','desktop:*',digest('not a chat')];
  // Which groups are on is chats.state (ADR-0253): the seeder takes no group list, only the owner.
  const policy={owner_id:owner};
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control);
  const capture=(n:number,scope:string,chat:Record<string,unknown>)=>coordinator.capture({version:1,key:'seed:'+base+':'+n,origin:'live',kind:'telegram_update',
    bot_id:'777',scope,source_id:String(n),revision:'1',occurred_at:null,text:null,payload:{update_id:base*100+n,message:{message_id:n,date:n,chat,from:{id:Number(alice),first_name:'Alice'},
      text:'SECRET_SEED_TEXT'}}} as Envelope);
  const settings=['owner','system','desktop:*',notChats[4]!];
  try {
    // Where this test's first seeding starts: the originals below were taken in before chat records existed.
    const start=Number((await stores.archive.query('SELECT coalesce(max(capture_sequence),0) AS last FROM events')).rows[0].last);
    await capture(1,archived,{id:Number(archived),type:'supergroup',title:'Archived title',is_forum:true});
    await capture(2,alice,{id:Number(alice),type:'private',first_name:'Alice',username:'alice_p1'});
    await stores.control.query(`INSERT INTO project_assignments(space_id,mode,revision) VALUES($1,'none',1),($2,'none',1)`,[group,topic]);
    await stores.control.query(`INSERT INTO chat_tool_settings(space_id,shell) VALUES($1,true),($2,true)`,[privateChat,owner]);
    await stores.control.query(`INSERT INTO chat_tool_settings(space_id,shell) VALUES('*',true) ON CONFLICT DO NOTHING`);
    await stores.control.query(`INSERT INTO memory_access_settings(destination) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,[settings]);
    await stores.control.query(`INSERT INTO telegram_topic_registrations(chat_id,topic_id,name) VALUES($1,9,'Owner named')`,[group]);
    await stores.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id)
      VALUES($1,'available','supergroup','Refreshed title','p1group',true,NULL),($2,'migrated',NULL,NULL,NULL,NULL,$3)`,[group,upgraded,'-100'+(base+4)]);
    await stores.control.query('UPDATE chat_seed_state SET seeded_at=NULL,archive_sequence=$1 WHERE singleton',[start]);

    const before=await checksums(stores);
    const first=await new ChatSeeder(stores,policy).seed();
    assert.ok(first.chats>=6&&first.topics>=2,JSON.stringify(first));
    const after=await checksums(stores);
    assert.deepEqual(without(after),without(before),'the seeder writes only chat records: every other table is unchanged');

    const ids=[group,topic,named,privateChat,archived,alice,owner,upgraded];
    const rows=new Map((await stores.control.query(`SELECT c.id,c.kind,c.parent_id,c.topic_key,c.title,c.title_source,c.app_type,c.is_forum,c.state,c.account_id,c.added_by_role,
      d.username,d.seen_at FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id WHERE c.id=ANY($1::text[])`,[ids])).rows.map(row=>[row.id,row]));
    const shape=(id:string)=>{const row=rows.get(id);return row&&[row.kind,row.parent_id,row.topic_key,row.title,row.title_source,row.app_type,row.state,row.added_by_role];};
    assert.deepEqual(shape(group),['group',null,null,'Refreshed title','refreshed','supergroup','off','seeded'],'a stored value stays its chat\'s id');
    assert.equal(rows.get(group).is_forum,true);assert.equal(rows.get(group).username,'p1group');
    assert.deepEqual(shape(topic),['topic',group,'7',null,null,null,'off','seeded']);
    assert.deepEqual(shape(named),['topic',group,'9','Owner named','owner',null,'off','seeded'],'a topic the owner added keeps the owner\'s name');
    assert.deepEqual(shape(privateChat),['private',null,null,null,null,null,'off','seeded']);
    assert.equal(rows.get(privateChat).account_id,accountIdFor('telegram',privateChat));
    assert.deepEqual(shape(archived),['group',null,null,'Archived title','observed','supergroup','off','seeded'],'the archive names a chat');
    assert.ok(rows.get(archived).seen_at);
    assert.deepEqual(shape(alice),['private',null,null,'Alice','observed','private','off','seeded']);
    assert.equal(rows.get(alice).username,'alice_p1');
    assert.deepEqual(shape(owner),['private',null,null,null,null,null,'active','seeded'],'the owner\'s private chat is on; every group is off');
    assert.equal(shape(upgraded)?.[6],'removed','a group Telegram upgraded before step 2b stays, removed');
    // The owner's last refresh still shows in the directory.
    // ...with the name and username it answered, which keep naming runtime profiles and destinations whatever later updates show.
    assert.deepEqual((await stores.control.query('SELECT chat_id,refreshed_state,refreshed_to,refreshed_title,refreshed_username FROM chat_details WHERE chat_id=ANY($1::text[])',[[group,upgraded]])).rows
      .map(row=>[row.chat_id,row.refreshed_state,row.refreshed_to,row.refreshed_title,row.refreshed_username]).sort(),
      [[group,'available',null,'Refreshed title','p1group'],[upgraded,'migrated','-100'+(base+4),null,null]].sort());
    assert.deepEqual((await stores.control.query(`SELECT external_id,chat_id,state FROM chat_ids WHERE external_id=ANY($1::text[])`,[ids])).rows
      .map(row=>[row.external_id,row.chat_id,row.state]).sort(),[group,privateChat,archived,alice,owner,upgraded].sort().map(id=>[id,id,'current']));
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM chats WHERE id=ANY($1::text[])',[notChats])).rows[0].count),0,'values that name no chat get no row');
    assert.equal(Number((await stores.control.query(`SELECT count(*) FROM chats t WHERE row_to_json(t)::text LIKE '%SECRET_SEED%'`)).rows[0].count),0);

    // A second run, with nothing new, inserts nothing and changes nothing anywhere.
    assert.deepEqual(await new ChatSeeder(stores,policy).seed(),{chats:0,topics:0});
    assert.deepEqual(await checksums(stores),after);

    // After the first seeding, a chat found only in the archive gets a chatIdFor id, while a stored value still names
    // its chat by itself.
    const seenLater='-100'+(base+6),storedLater='-100'+(base+7);
    await capture(3,seenLater,{id:Number(seenLater),type:'supergroup',title:'Seen later'});
    await stores.control.query(`INSERT INTO project_assignments(space_id,mode,revision) VALUES($1,'none',1)`,[storedLater]);
    assert.deepEqual(await new ChatSeeder(stores,policy).seed(),{chats:2,topics:0});
    assert.deepEqual((await stores.control.query(`SELECT external_id,chat_id FROM chat_ids WHERE external_id=ANY($1::text[])`,[[seenLater,storedLater]])).rows
      .map(row=>[row.external_id,row.chat_id]).sort(),[[seenLater,chatIdFor('telegram',seenLater)],[storedLater,storedLater]].sort());
  }finally{
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=ANY($1::text[])',[[group,topic,'-100'+(base+7)]]);
    await stores.control.query('DELETE FROM chat_tool_settings WHERE space_id=ANY($1::text[])',[[privateChat,owner]]);
    await stores.control.query('DELETE FROM memory_access_settings WHERE destination=ANY($1::text[])',[settings]);
    await stores.control.query('DELETE FROM telegram_topic_registrations WHERE chat_id=$1',[group]);
    await stores.control.query('DELETE FROM telegram_chat_observations WHERE chat_id=ANY($1::text[])',[[group,upgraded]]);
    await stores.close();
  }
});

/** Columns whose names look like chat values but hold none, with the reason. Every other such column is read by the
 * seeder (chatSeedColumns), so a new chat column cannot be added without the seeder or this list naming it. */
const notChatColumns:Record<string,string>={
  'control.chat_details.chat_id':'a chat record','control.chat_ids.chat_id':'a chat record','control.chat_memberships.chat_id':'a chat record',
  'control.chat_state_events.chat_id':'a chat record','control.member_chats.chat_id':'a chat record (a member\'s switch for a group)',
  'control.members.group_talk':'a member permission','control.members.group_jobs':'a member permission',
  'control.members.group_post_other':'a member permission','control.members.group_tools':'a member permission',
  'control.chat_memberships.source':'how a membership was learned','control.chats.title_source':'where a chat name came from','control.chats.topic_key':'a topic key in its app',
  'control.chat_sends.chat':'the app\'s own chat id a send went to, as the gateway wrote it; chat_id holds the chat',
  'control.chat_sends.chat_id':'filled from the chat directory when the record is drained','control.chat_sends.topic':'the app\'s thread key of a send',
  'control.background_jobs.changes':'card ids and fingerprints','control.capture_effect_receipts.sources':'archive event references',
  'control.capture_handoffs.source_revision':'a source revision','control.source_intakes.source_revision':'a source revision',
  'control.guard_invalidations.source_id':'a guard source id','control.guard_publications.source_id':'a guard source id',
  'control.memory_ingestion_receipts.guard_source_id':'a guard source id','control.security_events.source_event_id':'an archive event id',
  'control.interpretation_jobs.workspace':'a memory workspace id','control.memory_sessions.workspace':'a memory workspace id',
  'control.memory_session_deletions.workspace':'a memory workspace id','control.memory_workspace_deletions.workspace':'a memory workspace id',
  'control.memory_engine_connection.workspace_revision':'a revision','control.knowledge_proposals.source_job_id':'a job id',
  'control.learning_refresh_sweeps.source_after_sequence':'an archive sequence','control.managed_runs.conversation_id':'the runtime\'s conversation id',
  'control.memory_entity_bindings.source_object_id':'a memory engine object id','control.owner_task_comments.source_event':'an archive event id',
  'control.owner_tasks.source_event':'an archive event id','control.reaction_states.target_id':'a reacted message','control.stage_timings.source':'a pipeline stage',
  'control.telegram_chat_observations.chat_id':'frozen in step 2b-1; read once by the seeder','control.telegram_chat_observations.chat_type':'Telegram\'s word for a chat',
  'control.telegram_chat_observations.migrate_to_chat_id':'frozen in step 2b-1; a Telegram id','control.telegram_topic_registrations.chat_id':'frozen in step 2b-1; read once by the seeder',
  'control.telegram_topic_registrations.topic_id':'frozen in step 2b-1; a topic key',
  'derived.derived_artifacts.source_revision':'a source revision','derived.guard_activations.source_id':'a guard source id','derived.guard_fragments.source_id':'a guard source id',
  'derived.guard_revisions.source_id':'a guard source id','derived.guard_sources.source_id':'a guard source id','derived.learned_entries.scope_kind':'the kind of scope_id',
  'derived.runtime_prepared_inputs.source_id':'an archive source id',
};

test('every column that may hold a chat value is read by the seeder or named as not a chat',fixture,async()=>{
  const stores=await open();
  try {
    const seeded=new Set(chatSeedColumns.map(item=>item.store+'.'+item.table+'.'+item.column)),found=new Set<string>();
    for(const store of ['control','derived'] as const)for(const row of (await stores[store].query(`SELECT c.table_name,c.column_name,c.data_type FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
      WHERE c.table_schema=current_schema() AND (c.column_name ~ '(space|scope|chat|destination|group|audience|source|target|thread|topic|conversation|changes)')`)).rows) {
      const key=store+'.'+row.table_name+'.'+row.column_name;found.add(key);
      // A reference to an archive event ({id,revision,input_hash}) is never a chat.
      if(row.column_name==='source_reference'||row.column_name==='source_references')continue;
      assert.ok(seeded.has(key)||key in notChatColumns,key+' may hold chat values: add it to chatSeedColumns, or to notChatColumns with the reason');
    }
    for(const key of seeded)assert.ok(found.has(key),key+' is read by the seeder but is no column of the schema');
  }finally{await stores.close();}
});
