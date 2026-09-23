import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {initialize} from '../src/database.js';
import {browseData} from '../src/guarded.js';
import {storageServer} from '../src/stores/server.js';

test('archive browse orders received records across cursor pages in both storage layouts',
 {skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace=`browse_order_${process.pid}_${Date.now()}`;
  const root=await mkdtemp(join(tmpdir(),'nocheh-browse-order-'));
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  try {
    await initialize(pool);
    const source=Array.from({length:52},(_,index)=>({
      id:digest(`browse-order:${index}`),
      received_at:new Date(Date.UTC(2099,0,1,0,0,Math.floor(index/2))).toISOString(),
    }));
    for(const [index,row] of source.entries()){
      const payload=index===0?JSON.stringify({message:{message_id:index,voice:{file_id:'fixture-voice'}}}):'{}';
      await pool.query(`INSERT INTO events
      (id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,received_at,payload,payload_hash,original_text)
      VALUES($1,$2,'telegram','fixture','browse-order',$3,'1','live','telegram_update',$4,$5,$6,$7)`,
      [row.id,`browse-order:${index}`,String(index),row.received_at,Buffer.from(payload),digest(payload),Buffer.from(`Record ${index}`)]);
    }
    const expected=source.sort((a,b)=>b.received_at.localeCompare(a.received_at)||b.id.localeCompare(a.id)).map(row=>row.id);
    const filters={kind:'',scope:'browse-order',reply:''} as const;
    const check=async(load:(after:string)=>Promise<{records:{id:string;content_types?:string[]}[];next:string|null}>)=>{
      const first=await load('');assert.deepEqual(first.records.map(row=>row.id),expected.slice(0,50));
      assert.equal(first.next,expected[49]);
      const second=await load(first.next!);assert.deepEqual(second.records.map(row=>row.id),expected.slice(50));
      assert.equal(second.next,null);
      assert.deepEqual([...first.records,...second.records].find(row=>row.id===digest('browse-order:0'))?.content_types,['voice']);
    };
    await check(after=>browseData(pool,{admin:true,scope:null},after,filters));

    const token='browse-order-fixture-token';
    const server=storageServer(
      {stores:{archive:pool,control:{query:async()=>({rows:[]})},derived:{query:async()=>({rows:[]})}}} as unknown as Parameters<typeof storageServer>[0],
      {token,dataDir:root} as Parameters<typeof storageServer>[1],
      (async()=>({})) as Parameters<typeof storageServer>[2]);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address();assert.ok(address&&typeof address==='object');
      await check(async after=>{
        const url=new URL(`/v1/data?scope=browse-order${after?'&after='+after:''}`,`http://127.0.0.1:${address.port}`);
        const response=await fetch(url,{headers:{authorization:'Bearer '+token}});
        assert.equal(response.status,200);
        return await response.json() as {records:{id:string}[];next:string|null};
      });
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }finally{
    await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();
    await rm(root,{recursive:true,force:true});
  }
});
