import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {initializeStoreDatabases} from '../src/stores/connections.js';
import {runtimeStoreGroups} from '../src/stores/runtime-pools.js';

test('workflow saturation leaves API guard callbacks available and API saturation leaves workflow admission available',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Client(config);await admin.connect();
  try{assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const groups=runtimeStoreGroups({NOCHEH_STORAGE_LAYOUT:'original-only-v1',PGHOST:config.host,
    NOCHEH_ARCHIVE_PASSWORD:passwords.archive,NOCHEH_DERIVED_PASSWORD:passwords.derived,NOCHEH_CONTROL_PASSWORD:passwords.control});
  try{
    for(const [occupied,available] of [[groups.workflow,groups.api],[groups.api,groups.workflow]]){
      const held:pg.PoolClient[]=[];
      try{
        for(let i=0;i<8;i++)held.push(await occupied!.control.connect());
        assert.equal(occupied!.control.idleCount,0);
        const current=await available!.control.query('SELECT generation FROM installation WHERE singleton');
        assert.equal(current.rowCount,1,'a saturated workflow must not block its own HTTP guard callback');
        assert.equal((await available!.archive.query('SELECT current_user AS role')).rows[0].role,'nocheh_archive');
        assert.equal((await available!.derived.query('SELECT current_user AS role')).rows[0].role,'nocheh_derived');
      }finally{for(const connection of held)connection.release();}
    }
  }finally{await groups.close();}
});
