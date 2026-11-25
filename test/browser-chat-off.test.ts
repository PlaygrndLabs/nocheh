import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keyPass} from './one-time-key-pass.js';
import {storageServer} from '../src/stores/server.js';

test('storage takes no browser input, run or delivery while the dashboard chat page is off, whatever the caller holds',async()=>{
  // No stores: the refusal comes before any check of the caller, the stores or an inactive restore.
  const token='t'.repeat(32),server=storageServer({} as never,{service:'nocheh-app',token,dataDir:join(tmpdir(),'nocheh-none')} as never,(async()=>({})) as never);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try {
    const operations=['input','delivered','admit','workflow-context','claim','prepare','heartbeat','finish','cancel','observe','active','undelivered','unknown'];
    for(const credential of [token,keyPass(token,'123',Date.now()+60000),null])
      for(const operation of operations) {
        const answer=await fetch(base+'/v1/browser/'+operation,{method:'POST',headers:credential?{authorization:'Bearer '+credential}:{},
          body:JSON.stringify({scope:'123',conversation:'c1',id:'submission',text:'Synthetic browser text',files:[]})});
        assert.equal(answer.status,404,operation);assert.deepEqual(await answer.json(),{error:'browser_chat_off'},operation);
      }
    assert.equal((await fetch(base+'/v1/browser/active',{headers:{authorization:'Bearer '+token}})).status,404);
  } finally {server.closeAllConnections();server.close();}
});
