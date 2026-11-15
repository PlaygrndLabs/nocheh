import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {chatDirectory,chatIdFor,connectionIdFor,type ChatIdRow,type ChatRow} from '../src/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,GP_GROUP_IDS,NG1,NG1_TOPIC,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,fixtureChats,fixtureDirectory,
  legacyChats,seedChats,seedGroups} from './fixture-groups.js';

const fixtureDatabase=async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  return {config,passwords,stores:connectStores(config,passwords)};
};
/** Every table's rows, as one digest per table, and the schema itself: columns, constraints and indexes. */
async function fingerprint(db:pg.Pool) {
  const tables=(await db.query<{name:string}>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows;
  const rows:Record<string,string>={};
  for(const {name} of tables)rows[name]=(await db.query(`SELECT count(*)::text||':'||coalesce(md5(string_agg(t::text,'|' ORDER BY t::text)),'') AS sum FROM ${pg.escapeIdentifier(name)} t`)).rows[0].sum;
  const schema=(await db.query(`SELECT md5(string_agg(x,'|' ORDER BY x)) AS sum FROM (
    SELECT table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') AS x FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT tablename||':'||indexname||':'||indexdef FROM pg_indexes WHERE schemaname='public') s`)).rows[0].sum as string;
  return {rows,schema};
}
/** The directory as Part A's loader reads it: chats and chat_ids with each connection's app. */
async function load(db:pg.Pool,owner:string|null) {
  const chats=(await db.query<ChatRow>(`SELECT c.id,n.app,c.kind,c.parent_id,c.topic_key,c.state,c.title,c.is_forum,c.account_id,c.app_type
    FROM chats c JOIN chat_connections n ON n.id=c.connection_id`)).rows;
  const ids=(await db.query<ChatIdRow>(`SELECT n.app,i.external_id,i.chat_id,i.state FROM chat_ids i JOIN chat_connections n ON n.id=i.connection_id`)).rows;
  const revision=Number((await db.query('SELECT revision FROM chat_directory_state')).rows[0].revision);
  return chatDirectory({chats,ids,owner_chat:owner,revision});
}

test('the chat records bootstrap with the control store, hold both kinds of chat id, and a second bootstrap changes nothing',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {config,passwords,stores}=await fixtureDatabase(),db=stores.control;
  try{
    const served=[...GP_GROUP_IDS,...NG_GROUP_IDS],fixture=fixtureChats(served);
    await seedChats(db,fixture);await seedGroups(db);
    await seedChats(db,legacyChats(['-1001000000005/topic/3','42/topic/9'],{served:['-1001000000005']}));
    await seedChats(db,fixture);
    assert.equal((await db.query('SELECT revision FROM chat_directory_state')).rows[0].revision,'1');
    assert.equal((await db.query('SELECT count(*) FROM chat_connections')).rows[0].count,'1','one connection per app');

    const loaded=await load(db,OWNER),expected=fixtureDirectory(served);
    for(const chat of expected.all())assert.deepEqual(loaded.get(chat.id),chat,chat.id);
    assert.equal(loaded.groupOf(GP1_TOPIC),GP1);assert.equal(loaded.groupOf(NG1_TOPIC),NG1);assert.ok(loaded.isPrivate(BOB_CHAT));
    assert.deepEqual(loaded.rawScopes([NG2]),[NG2_OLD_TG,NG2_TG].sort());
    assert.equal(loaded.groupOf('-1001000000005/topic/3'),'-1001000000005');assert.equal(loaded.parentOf('42/topic/9'),'42');

    const before=await fingerprint(db);
    await initializeStoreDatabases(config,passwords);
    const after=await fingerprint(db);
    assert.equal(after.schema,before.schema,'the second bootstrap leaves the schema as it was');
    assert.deepEqual(after.rows,before.rows,'and every control row as it was');
    assert.ok(['chat_connections','chat_accounts','chats','chat_ids','chat_memberships','chat_directory_state'].every(name=>name in after.rows));

    // The schema's own rules, as the runtime role meets them.
    const connection=connectionIdFor('telegram'),insert=(id:string,kind='group',parent:string|null=null,key:string|null=null)=>
      db.query('INSERT INTO chats(id,connection_id,kind,parent_id,topic_key) VALUES($1,$2,$3,$4,$5)',[id,connection,kind,parent,key]);
    for(const bad of ['owner','*','system','desktop:private_supergroup:1','-1001000000006/topic/x','A'.repeat(64),NG1+'/topic/7'])
      await assert.rejects(insert(bad),{code:'23514'},bad);
    await insert(chatIdFor('telegram','-1001000000006'));
    await assert.rejects(insert(chatIdFor('telegram','-1001000000006',4),'topic'),{code:'23514'},'a topic needs its parent and key');
    await assert.rejects(insert(chatIdFor('telegram','-1001000000007'),'group',GP1,null),{code:'23514'},'only a topic has a parent');
    await assert.rejects(insert(chatIdFor('telegram',GP1,8),'topic','-1001000000099','8'),{code:'23503'},'a topic\'s parent is a chat');
    await assert.rejects(insert(chatIdFor('telegram',GP1,77),'topic',GP1,'7'),{code:'23505'},'one row per parent and topic key');
    await assert.rejects(db.query(`INSERT INTO chat_connections(id,app) VALUES($1,'telegram')`,[digest('another bot')]),{code:'23505'},'UNIQUE(app)');
    await assert.rejects(db.query(`INSERT INTO chat_connections(id,app,secret_ref) VALUES($1,'slack','xoxb-not-a-reference')`,[connectionIdFor('slack')]),{code:'23514'});
    await db.query(`INSERT INTO chat_connections(id,app,team,secret_ref) VALUES($1,'slack','T0EXAMPLE','env:SLACK_BOT_TOKEN')`,[connectionIdFor('slack')]);
    await assert.rejects(db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,'-1001000000088',$2,'current')`,[connection,GP1]),
      {code:'23505'},'one current id per chat');
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state,reason) VALUES($1,'-4000000000001',$2,'old','migrated')`,[connection,GP1]);
    await assert.rejects(db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,'-1001/topic/7',$2,'old')`,[connection,GP1]),{code:'23514'});
    // A Slack-shaped channel fits the same tables; its threads stay with its messages, never chats of their own.
    const slackChannel=chatIdFor('slack',['T0EXAMPLE','C0EXAMPLE1']);
    await db.query(`INSERT INTO chats(id,connection_id,kind,app_type,state) VALUES($1,$2,'group','public_channel','off')`,[slackChannel,connectionIdFor('slack')]);
    await db.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,'C0EXAMPLE1',$2,'current')`,[connectionIdFor('slack'),slackChannel]);
    const both=await load(db,OWNER);
    assert.equal(both.resolve('slack','C0EXAMPLE1'),slackChannel);assert.deepEqual(both.rawScopes([GP1]),['-1001000000001','-4000000000001']);
    const account=fixture.accounts[0]!.id;
    await db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source,seen_seq) VALUES($1,$2,'in','message',7)`,[GP1,account]);
    await assert.rejects(db.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source) VALUES($1,$2,'joined','message')`,[GP2,account]),{code:'23514'});
    await db.query(`UPDATE chats SET state='off',updated_at=now() WHERE id=$1`,[NG2]);await db.query(`DELETE FROM chat_memberships WHERE chat_id=$1`,[GP1]);
    await initializeStoreDatabases(config,passwords);
    assert.equal((await db.query('SELECT state FROM chats WHERE id=$1',[NG2])).rows[0].state,'off','the bootstrap never rewrites a chat row');
  }finally{await stores.close();}
});
