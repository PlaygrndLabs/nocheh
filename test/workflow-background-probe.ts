/** Synthetic engine-only probe: background slot contention against a real local Inngest. */
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {workflowClient,connectWorkflows} from '../src/workflows/client.js';
import {coordinatedFunctions} from '../src/workflows/engine.js';
import {observation,type Observation} from '../src/workflows/pipeline.js';
import {backgroundFamilies,boundStorageOperations} from '../src/stores/workflow-operations.js';
import type {WorkflowFamily} from '../src/workflows/store.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_required');
const mode=process.argv[2];if(mode!=='baseline'&&mode!=='shared')throw Error('probe_mode_required');
const families:WorkflowFamily[]=['honcho','memory_review','telegram'],authority={owner:'inngest' as const,epoch:1};
let active=0,maximum=0,polls=0;const done=new Map<string,number>();
const held=(family:string)=>async(job:string)=>{
  if(family!=='telegram'){active++;maximum=Math.max(maximum,active);}
  try{await delay(1500);done.set(job,Date.now());return observation('completed','sync');}finally{if(family!=='telegram')active--;}
};
const bounded=boundStorageOperations({honcho:held('honcho'),memory_review:held('memory_review'),telegram:held('telegram')});
const client=workflowClient('pipeline');
const functions=coordinatedFunctions(client,families,async(id,_dispatch,family)=>{
  const result:Observation=await bounded[family]!(id,authority);if(result.state==='waiting')polls++;return result;
},async()=>{},mode==='shared'?backgroundFamilies(families):new Set());
const connection=await connectWorkflows('pipeline',client,functions);
try {
  await delay(3000);const started=Date.now(),id=(name:string)=>createHash('sha256').update(mode+':'+started+':'+name).digest('hex');
  const work=[...Array(16).keys()].map(index=>({family:index%2?'honcho':'memory_review',workflow_id:id('background-'+index)}));
  await client.send(work.map(item=>({name:'nocheh/workflow.requested',id:item.workflow_id,data:{...item,dispatch:1}})));
  await delay(4000);const reply=id('reply'),replySent=Date.now();
  await client.send({name:'nocheh/workflow.requested',id:reply,data:{family:'telegram',workflow_id:reply,dispatch:1}});
  const all=[...work.map(item=>item.workflow_id),reply];
  for(const deadline=Date.now()+600000;all.some(job=>!done.has(job))&&Date.now()<deadline;)await delay(500);
  console.log(JSON.stringify({mode,completed:all.filter(job=>done.has(job)).length,expected:all.length,
    background_max_concurrency:maximum,waiting_polls:polls,reply_latency_ms:done.has(reply)?done.get(reply)!-replySent:null,
    elapsed_ms:Math.max(...done.values())-started}));
} finally {await connection.close();}
