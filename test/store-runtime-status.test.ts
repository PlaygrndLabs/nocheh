import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeToken} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {storageServer} from '../src/stores/server.js';
import type {StorageServices} from '../src/stores/services.js';

test('owner runtime status reports Telegram polling and denies scoped readers',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nocheh-runtime-status-'));
  const token='fixture-owner-token';
  const config={token,dataDir} as Settings;
  const server=storageServer({} as StorageServices,config,async()=>({ok:true,telegram:'connected',
    telegram_details:{last_poll_at:'2026-09-25T11:44:49Z'},reasoning_route:'shared'}));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const url=`http://127.0.0.1:${address.port}/v1/runtime`;
    const owner=await fetch(url,{headers:{authorization:'Bearer '+token}});
    assert.equal(owner.status,200);
    const body=await owner.json() as {status:{telegram:string;telegram_details:{last_poll_at:string}}};
    assert.equal(body.status.telegram,'connected');
    assert.equal(body.status.telegram_details.last_poll_at,'2026-09-25T11:44:49Z');
    const scoped=await fetch(url,{headers:{authorization:'Bearer '+scopeToken(token,'owner',Date.now()+60_000)}});
    assert.equal(scoped.status,403);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dataDir,{recursive:true,force:true});
  }
});
