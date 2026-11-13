import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {storeSchemas} from '../src/stores/schema.js';
import {OwnerPortabilityRepository,portableOwnerTables,type OwnerRecord} from '../src/stores/owner-portability.js';
import type {StorePools} from '../src/stores/connections.js';
import {canonical,digest} from '../src/archive.js';

// Two empty schemas in the fixture's control database: one to export from, one to import into.
test('owner data travels with its types, and nothing imported acts by itself',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const schemas=['owner_source_'+randomUUID().replaceAll('-',''),'owner_target_'+randomUUID().replaceAll('-','')];
  // The repositories run as a role with the control store's grants, never as the owner of the tables.
  const role='owner_fixture_'+randomUUID().replaceAll('-',''),config:pg.PoolConfig={user:process.env.PGUSER??'nocheh',database:process.env.PGDATABASE??'nocheh'},setup=new pg.Pool(config);
  const pools=schemas.map(schema=>new pg.Pool({...config,options:'-c search_path='+schema+',pg_catalog -c TimeZone='+(schema===schemas[0]?'UTC':'Asia/Tokyo')}));
  const app=schemas.map(schema=>new pg.Pool({...config,options:'-c search_path='+schema+',pg_catalog -c role='+role}));
  try {
    await setup.query(`CREATE ROLE ${role} NOLOGIN`);
    for(const schema of schemas)await setup.query(`CREATE SCHEMA ${schema}`);
    for(const [i,pool] of pools.entries()) {
      await pool.query(storeSchemas.control);
      await pool.query(`GRANT USAGE ON SCHEMA ${schemas[i]} TO ${role}`);
      await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schemas[i]} TO ${role}`);
      await pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schemas[i]} TO ${role}`);
    }
    const [source,target]=pools as [pg.Pool,pg.Pool],owner={admin:true,scope:null};
    const from=new OwnerPortabilityRepository({control:app[0]} as unknown as StorePools),to=new OwnerPortabilityRepository({control:app[1]} as unknown as StorePools);
    const project='9'.repeat(64),person='1'.repeat(64),parent='a'.repeat(64),child='0'.repeat(64);
    for(const pool of pools) {
      await pool.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'Garden redesign','active',1)",[project]);
      await pool.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person','Mira Chen','active')",[person]);
    }
    await source.query(`INSERT INTO owner_tasks(id,title,status_id,state,priority,start_on,start_time,due_on,due_time,position,project_id,tags,origin,created_at)
      VALUES($1,'Plan the beds','todo','open',2,'2026-12-01','08:30','2026-12-03','17:00',2.75,$2,'{garden,spring}','dashboard','2026-11-01T10:00:00Z')`,[parent,project]);
    // The child sorts first by key, so the parent arrives after it.
    await source.query("INSERT INTO owner_tasks(id,title,status_id,origin,parent_id) VALUES($1,'Buy seeds','todo','chat',$2)",[child,parent]);
    await source.query("INSERT INTO owner_task_people(task_id,entity_id,role) VALUES($1,$2,'assignee')",[parent,person]);
    await source.query("INSERT INTO owner_task_reminders(id,task_id,remind_at,state) VALUES($1,$2,'2020-01-01T00:00:00Z','pending'),($3,$2,'2099-01-01T00:00:00Z','pending')",['c'.repeat(64),parent,'d'.repeat(64)]);
    await source.query("INSERT INTO owner_task_activity(task_id,actor,origin,changes) VALUES($1,'{\"kind\":\"owner\"}','dashboard','{\"title\":\"Plan the beds\"}')",[parent]);
    // Twelve history entries: as text, 10 would sort before 2.
    for(let step=2;step<=12;step++)await source.query("INSERT INTO owner_task_activity(task_id,actor,origin,changes) VALUES($1,'{\"kind\":\"owner\"}','dashboard',$2)",[parent,JSON.stringify({step})]);
    await source.query("INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,revision) VALUES('rule-1','Garden to studio','[\"-10042\"]','-10073',true,'filtered',1)");
    await source.query("UPDATE background_settings SET cost_limit_usd=7.5,revision=1");
    await source.query("INSERT INTO chat_tool_settings(space_id,shell,browser,mcp) VALUES('*',false,null,null),('-10042',null,true,false)");
    await source.query("UPDATE owner_prompts SET texts='{\"greeting\":\"Hello there\"}',revision=2");
    await target.query("UPDATE owner_prompts SET texts='{\"greeting\":\"Target wording\"}',revision=1");

    const records:OwnerRecord[]=[];
    for(const table of portableOwnerTables) {
      let after:string|null=null;
      do {const page=await from.page(owner,table,after,1);records.push(...page.records);after=page.next;} while(after);
    }
    assert.equal(records.filter(r=>r.table==='owner_tasks').length,2);
    // Import the way the Python side does: tasks whose parent is missing wait for another pass.
    let waiting=records;
    while(waiting.length) {
      const next:OwnerRecord[]=[];
      for(const record of waiting) {
        try{await to.restore(owner,[record]);}
        catch(error){if((error as {message?:string}).message==='portable_parent_pending'&&record.table==='owner_tasks'){next.push(record);continue;}throw error;}
      }
      assert.ok(next.length<waiting.length,'no progress');waiting=next;
    }
    const task=(await target.query("SELECT to_char(start_on,'YYYY-MM-DD') AS start_on,to_char(due_time,'HH24:MI') AS due_time,position,tags,created_at FROM owner_tasks WHERE id=$1",[parent])).rows[0];
    assert.deepEqual({...task,created_at:task.created_at.toISOString()},{start_on:'2026-12-01',due_time:'17:00',position:2.75,tags:['garden','spring'],created_at:'2026-11-01T10:00:00.000Z'});
    assert.equal((await target.query('SELECT parent_id FROM owner_tasks WHERE parent_id IS NOT NULL')).rows[0].parent_id,parent);
    assert.equal((await target.query('SELECT role FROM owner_task_people')).rows[0].role,'assignee');
    // Sharing comes back switched off; a missed reminder does not fire late; a future one still does.
    assert.equal((await target.query('SELECT enabled FROM sharing_rules')).rows[0].enabled,false);
    assert.deepEqual((await target.query('SELECT state FROM owner_task_reminders ORDER BY id')).rows.map(r=>r.state),['skipped','pending']);
    // A changed setting on the target wins; an untouched one takes the imported value.
    assert.equal((await target.query('SELECT texts FROM owner_prompts')).rows[0].texts.greeting,'Target wording');
    assert.equal(Number((await target.query('SELECT cost_limit_usd FROM background_settings')).rows[0].cost_limit_usd),7.5);
    // The owner's tool switches come along, chat by chat; one that was on arrives inherited, so an import never turns a tool on.
    assert.deepEqual((await target.query('SELECT space_id,shell,browser,mcp FROM chat_tool_settings ORDER BY space_id')).rows,
      [{space_id:'*',shell:false,browser:null,mcp:null},{space_id:'-10042',shell:null,browser:null,mcp:false}]);
    // A hand-edited file cannot turn a tool on with values the database reads as true, nor pin a revision nothing can follow.
    const edited={space_id:'-10073',shell:'t',browser:1,mcp:'on',revision:2147483647};
    await to.restore(owner,[{format:'nocheh-owner-record-v1',table:'chat_tool_settings',key:['-10073'],row:edited,
      sha256:digest(canonical({table:'chat_tool_settings',key:['-10073'],row:edited}))}]);
    assert.deepEqual((await target.query("SELECT shell,browser,mcp,revision FROM chat_tool_settings WHERE space_id='-10073'")).rows,[{shell:null,browser:null,mcp:null,revision:1}]);
    // History keeps its order.
    const steps=async(pool:pg.Pool)=>(await pool.query('SELECT changes FROM owner_task_activity ORDER BY id')).rows.map(r=>JSON.stringify(r.changes));
    assert.deepEqual(await steps(target),await steps(source));
    // New activity keeps counting after the imported rows.
    const next=(await target.query("INSERT INTO owner_task_activity(task_id,actor,origin,changes) VALUES($1,'{}','dashboard','{}') RETURNING id",[parent])).rows[0].id;
    assert.ok(Number(next)>1);
    // A second import changes nothing.
    let unchanged=0;for(const record of records)unchanged+=(await to.restore(owner,[record])).unchanged;
    assert.equal(unchanged,records.length-1);
    // A changed record is refused.
    await assert.rejects(to.restore(owner,[{...records[1]!,row:{...records[1]!.row,title:'Edited'}}]),/owner_record_integrity/);
  } finally {
    for(const pool of [...pools,...app])await pool.end();
    for(const schema of schemas)await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.query(`DROP ROLE IF EXISTS ${role}`);
    await setup.end();
  }
});
