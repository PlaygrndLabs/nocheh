import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {reader} from '../src/access.js';
import type {Settings} from '../src/config.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServer} from '../src/stores/server.js';
import {OneTimeKeyRepository,closeEvent,closeSubject} from '../src/stores/one-time-keys.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {fixtureServices,type FakeCall} from './fixture-agent.js';
import {keyPass,passClaims} from './one-time-key-pass.js';

// Every pass is a one-time key (ADR-0305): minted with its row, checked open on every request by storage, reaching only
// its kind's routes, and never opened again once it closes. Synthetic owner, chats and events only.
test('a one-time key is minted with its row, reused for the same reply, checked on every request and closed for good',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-one-time-keys-')),key='keys:'+Date.now(),token=digest(key);
  const policy={enabled:true,owner_id:'123',group_ids:['-42']};
  const runtime:FakeCall=async operation=>{
    if(operation==='status')return {ok:true};
    if(operation==='guard.detect')return {literals:[]};
    throw Error('unexpected external operation '+operation);
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,serviceToken:token,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const settings:Settings={service:'nocheh-app',host:'127.0.0.1',port:0,token,agentKey:digest('agent:'+token),databasePassword:'',storageLayout:'original-only-v1',dataDir:root,
    hermesUrl:'http://fixture',telegramUrl:'http://fixture',honchoUrl:'http://fixture',honchoEnabled:false,memoryToken:'',guardMode:'off',detectorVersion:'fixture',assistant:policy};
  await services.guards.reconcile();await services.configuration.configure(policy,'off');
  const server=storageServer(services,settings,runtime);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const call=async(path:string,pass:string,method='GET')=>{
    const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+pass,'content-type':'application/json',accept:'application/json, text/event-stream'},
      ...(method==='POST'?{body:path==='/mcp'?JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}):'{}'}:{})});
    return {status:response.status,body:await response.json().catch(()=>null) as any};
  };
  const audience=services.prepared.audience,keys=new OneTimeKeyRepository(stores.control),later=()=>Date.now()+600000;
  const event=digest(key+':event'),owner={scope:null,space:'123'};
  const row=async(jti:string)=>(await stores.control.query('SELECT * FROM one_time_keys WHERE jti=$1',[jti])).rows[0];
  try {
    // Minting writes the key's row, for the owner and the agent plugged in now.
    const first=await audience.turn(token,owner,event,Date.now()+60000,{kind:'turn',subject:event,attempt:1,person:'owner'});
    const claims=passClaims(first),minted=await row(claims.jti);
    assert.deepEqual([claims.person,claims.key_kind,claims.agent],['owner','turn','hermes']);
    assert.deepEqual([minted.kind,minted.subject,minted.attempt,minted.person,minted.agent,minted.event_id,minted.closed_at],['turn',event,'1','owner','hermes',event,null]);
    // The same reply signed again (a presence renewal, the delivery) is the same key, its expiry moved to the later one.
    const again=await audience.turn(token,owner,event,later(),{kind:'turn',subject:event,attempt:1,person:'owner'});
    assert.equal(passClaims(again).jti,claims.jti);
    assert.ok((await row(claims.jti)).expires_at.getTime()>minted.expires_at.getTime());
    // Another attempt is another key.
    const retry=await audience.turn(token,owner,event,later(),{kind:'turn',subject:event,attempt:2,person:'owner'});
    assert.notEqual(passClaims(retry).jti,claims.jti);

    // Storage takes the open key, also on /mcp, and refuses the dashboard to it.
    assert.equal((await call('/v1/memory/check',again)).status,200);
    assert.equal((await call('/mcp',again,'POST')).status,200);
    assert.deepEqual(await call('/v1/runtime',again),{status:403,body:{error:'one_time_key_route_denied'}});
    // A signed pass whose key was never minted reaches nothing, /mcp included.
    for(const [path,method] of [['/v1/memory/check','GET'],['/mcp','POST'],['/v1/search?q=x','GET']] as const)
      assert.deepEqual(await call(path,keyPass(token,null,later(),event,{space:'123',revision:1}),method),{status:401,body:{error:'one_time_key_unknown'}},path);
    // A pass whose claims do not match its row (another person, kind or event) is unknown too.
    const parsed=reader({headers:{authorization:'Bearer '+again}} as IncomingMessage,token);
    for(const changed of [{person:'a'.repeat(64)},{keyKind:'follow_up' as const},{turnEvent:digest('other')},{agent:'other-agent'}])
      await assert.rejects(services.turns.assertKey({...parsed,...changed}),{status:401,code:'one_time_key_unknown'},Object.keys(changed)[0]);

    // Closed: every copy of the key reaches nothing any more, and it is never opened again.
    assert.equal(await closeSubject(stores.control,'turn',event,'delivered'),2,'both attempts');
    assert.equal(await closeSubject(stores.control,'turn',event,'delivered'),0,'closing is idempotent');
    for(const pass of [first,again])for(const [path,method] of [['/v1/memory/check','GET'],['/mcp','POST']] as const)
      assert.deepEqual(await call(path,pass,method),{status:409,body:{error:'one_time_key_closed'}},path);
    await assert.rejects(services.turns.assertAudience(parsed),{code:'one_time_key_closed'},'every audience check sees it');
    await assert.rejects(audience.turn(token,owner,event,later(),{kind:'turn',subject:event,attempt:1,person:'owner'}),{status:409,code:'one_time_key_closed'});
    assert.equal((await row(claims.jti)).closed_reason,'delivered');
    // An expired key is closed as well.
    const expiring=await audience.turn(token,owner,event,Date.now()+60000,{kind:'turn',subject:event,attempt:3,person:'owner'});
    await stores.control.query("UPDATE one_time_keys SET expires_at=now()-interval '1 second' WHERE jti=$1",[passClaims(expiring).jti]);
    await assert.rejects(keys.assertOpen(reader({headers:{authorization:'Bearer '+expiring}} as IncomingMessage,token)),{status:409,code:'one_time_key_closed'});
    // Signed again for its own attempt, an expired key opens anew, so the reply can still settle; the copy signed before
    // still ends at its own signed expiry.
    const renewed=await audience.turn(token,owner,event,later(),{kind:'turn',subject:event,attempt:3,person:'owner'});
    assert.equal(passClaims(renewed).jti,passClaims(expiring).jti);
    await keys.assertOpen(reader({headers:{authorization:'Bearer '+renewed}} as IncomingMessage,token));

    // No person, no pass; a person that does not fit the pass, or another agent, gets none either.
    const fresh=digest(key+':fresh');
    await assert.rejects(audience.turn(token,owner,fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:null}),{status:409,code:'one_time_key_person_required'});
    await assert.rejects(audience.turn(token,owner,fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:'a'.repeat(64)}),{status:409,code:'one_time_key_person_mismatch'});
    await assert.rejects(audience.turn(token,{scope:'-42',space:'-42',lane:'b'.repeat(64)},fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:'owner'}),
      {status:409,code:'one_time_key_person_mismatch'},'a lane is its member\'s');
    await assert.rejects(audience.turn(token,owner,fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:'owner',agent:'other-agent'}),{status:409,code:'one_time_key_agent_changed'});
    await assert.rejects(audience.turn(token,{...owner,purpose:'filter'},fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:'owner'}),{status:409,code:'one_time_key_kind_mismatch'});
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM one_time_keys WHERE subject=$1',[fresh])).rows[0].n,0,'nothing refused leaves a row');
    // A member's group turn is that member's.
    const member='b'.repeat(64),grouped=passClaims(await audience.turn(token,{scope:'-42',space:'-42',lane:member},fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:member}));
    assert.deepEqual([grouped.person,grouped.lane],[member,member]);
    // A key minted for one person is not opened for another.
    await assert.rejects(audience.turn(token,{scope:'-42',space:'-42'},fresh,later(),{kind:'turn',subject:fresh,attempt:1,person:'owner'}),{status:409,code:'one_time_key_conflict'});

    // A review's and a filter's keys reach no data tool and no read route, beyond those routes' own checks.
    const review=await audience.turn(token,{...owner,purpose:'memory-review'},event,later(),{kind:'review',subject:'review-1',attempt:1,person:'owner'});
    const filter=await audience.turn(token,{...owner,purpose:'filter'},event,later(),{kind:'filter',subject:'preview-1',attempt:1,person:'owner'});
    for(const pass of [review,filter])for(const [path,method] of [['/mcp','POST'],['/v1/search?q=x','GET'],['/v1/archive/page','GET'],['/v1/memory/context','GET']] as const)
      assert.deepEqual(await call(path,pass,method),{status:403,body:{error:'one_time_key_route_denied'}},passClaims(pass).key_kind+' '+path);
    assert.equal((await call('/v1/memory/check',review)).status,200,'a review may still ask whether it may deliver');
    assert.deepEqual(await call('/v1/memory/check',filter),{status:403,body:{error:'one_time_key_route_denied'}});

    // A run's keys close with the run, whichever of its kinds.
    const run=digest(key+':run');
    await stores.control.query(`INSERT INTO one_time_keys(jti,kind,subject,attempt,person,agent,event_id,expires_at) VALUES
      ($1,'scheduled',$3,'1','owner','hermes',$3,now()+interval '10 minutes'),($2,'turn',$3,'1','owner','hermes',$3,now()+interval '10 minutes')`,['c'.repeat(32),'d'.repeat(32),run]);
    assert.equal(await closeEvent(stores.control,run,['scheduled','background'],'run_finished'),1);
    assert.deepEqual((await stores.control.query('SELECT kind,closed_reason FROM one_time_keys WHERE event_id=$1 ORDER BY kind',[run])).rows,
      [{kind:'scheduled',closed_reason:'run_finished'},{kind:'turn',closed_reason:null}],'only the run\'s own kinds');
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});
