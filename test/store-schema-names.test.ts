import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storeSchemas} from '../src/stores/schema.js';

// Postgres cuts a name longer than 63 bytes without an error. A schema that names one, to drop it or for anything else,
// then misses the object it means: memory_generations kept its per-epoch constraint that way.
test('every name in the store schemas fits the 63 bytes Postgres keeps',()=>{
  for(const [store,sql] of Object.entries(storeSchemas)) {
    // Read left to right: quoted values and comments are not names, and a quote in a comment opens no value.
    const names=[...sql.matchAll(/'(?:[^']|'')*'|--[^\n]*|([A-Za-z_][A-Za-z0-9_$]*)/g)].map(match=>match[1]).filter(name=>name!==undefined);
    const long=[...new Set(names)].filter(name=>Buffer.byteLength(name)>63);
    assert.deepEqual(long,[],store+' schema names that Postgres cuts');
  }
});

test('memory keeps one current workspace per installation, not one per guard epoch, also where an earlier install made one',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const owner=new pg.Client({...config,database:'nocheh_control'});await owner.connect();
  const stores=connectStores(config,passwords),generation=randomUUID();
  const unique=async()=>(await owner.query(`SELECT conname FROM pg_constraint WHERE conrelid='memory_generations'::regclass AND contype='u'`))
    .rows.map(row=>String(row.conname));
  try {
    assert.deepEqual(await unique(),[],'a new install has no per-epoch constraint');
    // An earlier install made it from the table's definition, and Postgres named it.
    await owner.query('ALTER TABLE memory_generations ADD UNIQUE(installation_generation,guard_epoch,audience)');
    assert.deepEqual(await unique(),['memory_generations_installation_generation_guard_epoch_audi_key']);
    await initializeStoreDatabases(config,passwords);
    assert.deepEqual(await unique(),[],'setup drops it from an earlier install');
    // A fresh start retires the workspace and opens the next one, which may fall in the same guard epoch.
    const open=(id:string,state:string)=>stores.control.query(`INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience,state)
      VALUES($1,$2,7,'installation',$3)`,[id,generation,state]);
    await open(digest('retired-workspace'),'retired');await open(digest('current-workspace'),'ready');
    await assert.rejects(open(digest('second-current-workspace'),'building'),{code:'23505',constraint:'memory_generations_current'},
      'an installation still has one current workspace');
  } finally {
    await stores.control.query('DELETE FROM memory_generations WHERE installation_generation=$1',[generation]);
    await owner.end();await stores.close();
  }
});
