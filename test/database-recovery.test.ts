import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {connectDatabase,initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {setGuardMode} from '../src/guarded.js';
import {prepareContext} from '../src/prepared-context.js';

test('database loss during an external wait rejects work, releases the client and permits recovery',{
  skip:!process.env.PGHOST||process.env.NOCHEH_WORKFLOW_FIXTURE!=='1',timeout:60000,
},async()=>{
  assert.equal(process.env.NOCHEH_WORKFLOW_FIXTURE,'1','backend termination is restricted to the isolated fixture');
  const pool=connectDatabase(settings()),admin=new pg.Pool(),namespace='disconnect_'+Date.now();
  const previous=process.env.PGOPTIONS;
  let held:pg.PoolClient|undefined;
  try{
    held=await pool.connect();
    const pid=Number((await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const ended=new Promise<void>(resolve=>held!.once('end',()=>resolve()));
    await admin.query('SELECT pg_terminate_backend($1)',[pid]);
    await ended;
    await assert.rejects(held.query('SELECT 1'));
    held.release(true);held=undefined;
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1,'the service continues with a new connection');

    await admin.query(`CREATE SCHEMA ${namespace}`);
    process.env.PGOPTIONS=`-c search_path=${namespace}`;
    const contextPool=connectDatabase(settings());
    try{
      await initialize(contextPool);
      const event=await ingest(contextPool,{version:1,key:'disconnect-context',origin:'import',bot_id:'fixture',scope:'42',source_id:'1',revision:'1',kind:'message',occurred_at:null,text:'Synthetic context recovery',payload:{}},false);
      const guard=await setGuardMode(contextPool,'on');
      let contextClient:pg.PoolClient|undefined,contextPid:number|undefined;
      const observed=Object.create(contextPool) as pg.Pool;
      observed.connect=(async()=>{
        contextClient=await contextPool.connect();
        contextPid=Number((await contextClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return contextClient;
      }) as typeof observed.connect;
      // Keep pool.query bound to the real pool; only the operation's held
      // connection is terminated while its synthetic detector is awaiting I/O.
      observed.query=contextPool.query.bind(contextPool);
      await assert.rejects(prepareContext(observed,{admin:false,scope:null,turnEvent:event.id,guard_epoch:guard.epoch},'Unprepared synthetic context',async()=>{
        assert.ok(contextClient&&contextPid);
        const ended=new Promise<void>(resolve=>contextClient!.once('end',()=>resolve()));
        await admin.query('SELECT pg_terminate_backend($1)',[contextPid]);await ended;return [];
      }));
      assert.equal(contextPool.totalCount,contextPool.idleCount,'failed cleanup cannot leak a checked-out connection');
      assert.equal((await contextPool.query('SELECT count(*) FROM guard_context_inputs')).rows[0].count,'0','interrupted preparation publishes no context');
      assert.equal(await prepareContext(contextPool,{admin:false,scope:null,turnEvent:event.id,guard_epoch:guard.epoch},'Unprepared synthetic context',async()=>[]),'Unprepared synthetic context');
    }finally{await contextPool.end();}
  }finally{
    if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous;
    held?.release(true);await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await admin.end();
  }
});
