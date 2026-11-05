import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';

const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};

test('concurrent writes of one derivative all return the one stored row',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally {await admin.end();}
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const key=`derived-race-fixture:${Date.now()}`;
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'fixture',source_id:key,
    revision:'1',occurred_at:null,text:'A synthetic note.',payload:{message:{text:'A synthetic note.'}}};
  try {
    const source=(await archive.capture(event)).source.reference;
    // The id derives from the operation id, so both unique keys meet at once. Many rounds make the race likely.
    for(let round=0;round<60;round++) {
      const write=()=>derived.record({operation_id:`${key}:${round}`,source,kind:'summary',content:Buffer.from('A synthetic summary'),
        producer:'fixture',producer_version:'1',configuration:{round}});
      const outputs=await Promise.all(Array.from({length:8},write));
      assert.equal(new Set(outputs.map(output=>output.id)).size,1);
    }
  } finally {await stores.close();}
});
