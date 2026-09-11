/** Explicit synthetic Compose probe, never registered by production workers. */
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {workflowClient,connectWorkflows,workflowIdentity,type WorkflowApp} from '../src/workflows/client.js';
import type {WorkerConnection} from 'inngest/connect';

if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const action=process.argv[2];
if(!['prepare','resume'].includes(action??''))throw Error('probe_action_required');
const pool=new pg.Pool();
const connections:WorkerConnection[]=[];
try {
  await pool.query('CREATE SCHEMA IF NOT EXISTS workflow_fixture');
  await pool.query('CREATE TABLE IF NOT EXISTS workflow_fixture.checkpoints(id text,app text,stage text,calls int NOT NULL DEFAULT 1,PRIMARY KEY(id,stage))');
  if(action==='prepare') {
    const forbidden=new pg.Client({user:'nocheh_inngest',database:'nocheh',password:process.env.INNGEST_POSTGRES_PASSWORD});
    let denied=false;
    try {await forbidden.connect();}catch {denied=true;}finally {await forbidden.end().catch(()=>{});}
    if(!denied)throw Error('orchestration_role_has_archive_access');
    await pool.query('TRUNCATE workflow_fixture.checkpoints');
  }
  const clients=[];
  for(const app of ['pipeline','host'] as WorkflowApp[]) {
    const client=workflowClient(app);clients.push({app,client});
    const fn=client.createFunction({id:'checkpoint-probe',triggers:[{event:'nocheh/fixture.'+app}],retries:2},async({event,step})=>{
      const id=workflowIdentity(event.data.id);
      await step.run('first',async()=>{
        await pool.query("INSERT INTO workflow_fixture.checkpoints(id,app,stage) VALUES($1,$2,'first') ON CONFLICT(id,stage) DO UPDATE SET calls=workflow_fixture.checkpoints.calls+1",[id,app]);
        return {id};
      });
      await step.sleep('pause','20s');
      await step.run('second',async()=>{
        await pool.query("INSERT INTO workflow_fixture.checkpoints(id,app,stage) VALUES($1,$2,'second') ON CONFLICT(id,stage) DO UPDATE SET calls=workflow_fixture.checkpoints.calls+1",[id,app]);
        return {id};
      });
      return {id,state:'done'};
    });
    connections.push(await connectWorkflows(app,client,[fn]));
  }
  if(action==='prepare')for(const {app,client} of clients)await client.send({id:randomBytes(32).toString('hex'),name:'nocheh/fixture.'+app,data:{id:randomBytes(32).toString('hex')}});
  const expected=action==='prepare'?2:4;
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {
    const rows=(await pool.query('SELECT app,stage,calls FROM workflow_fixture.checkpoints ORDER BY app,stage')).rows;
    if(rows.some(r=>r.calls!==1))throw Error('checkpoint_repeated');
    if(rows.length===expected) {
      // Allow the completed step acknowledgments to reach persisted history.
      await delay(1500);
      console.log(JSON.stringify({action,checkpoint_rows:rows,archive_role_denied:true}));break;
    }
    await delay(250);
  }
  if((await pool.query('SELECT count(*)::int AS count FROM workflow_fixture.checkpoints')).rows[0].count!==expected)throw Error('workflow_probe_timeout');
} catch(error) {
  console.error(JSON.stringify({error:error instanceof Error&&['orchestration_role_has_archive_access','checkpoint_repeated','workflow_probe_timeout','workflow_connection_failed'].includes(error.message)?error.message:'workflow_probe_failed'}));
  process.exitCode=1;
} finally {
  await Promise.all(connections.map(c=>c.close()));await pool.end();
}
