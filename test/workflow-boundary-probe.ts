/** Real-server negative privacy fixture. Never registered by product workers. */
import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {workflowClient,connectWorkflows} from '../src/workflows/client.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const canary='SYNTHETIC_PROTECTED_SOURCE_912_BOUNDARY';
const database=new pg.Client({database:'nocheh_inngest',user:'nocheh_inngest',password:process.env.INNGEST_POSTGRES_PASSWORD});
await database.connect();
const client=workflowClient('pipeline');
const fn=client.createFunction({id:'boundary-probe',triggers:[{event:'nocheh/fixture.pipeline'}],retries:0},async({event,step})=>{
  await step.run('protected-output',async()=>{
    if(event.data.version===1)throw new Error(canary,{cause:{credential:canary}});
    return {transcript:canary};
  });
  return {state:'done'};
});
const connection=await connectWorkflows('pipeline',client,[fn]);
try {
  const since=new Date();
  for(const version of [1,2])await client.send({id:randomBytes(32).toString('hex'),name:'nocheh/fixture.pipeline',data:{id:randomBytes(32).toString('hex'),version}});
  let finished=0;
  for(let i=0;i<240;i++) {
    finished=Number((await database.query(`SELECT count(*) FROM function_finishes ff JOIN function_runs r USING(run_id)
      JOIN functions f ON f.id=r.function_id WHERE f.slug LIKE '%boundary-probe' AND ff.created_at>=$1`,[since])).rows[0].count);
    if(finished===2)break;await delay(250);
  }
  if(finished!==2)throw Error('privacy_probe_incomplete');
  let scanned=0;
  for(const table of ['events','history','function_finishes','spans','traces','trace_runs']) {
    const rows=await database.query(`SELECT row_to_json(t)::text AS value FROM ${table} t`);
    for(const row of rows.rows) {scanned++;if(row.value.includes(canary))throw Error('workflow_history_contains_protected_data');}
  }
  console.log(JSON.stringify({privacy_probe:'passed',rejected_executions:finished,history_rows_scanned:scanned}));
} finally {await connection.close();await database.end();}
