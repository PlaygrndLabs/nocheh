import type pg from 'pg';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Settings} from '../config.js';
import {heartbeat} from '../database.js';
import {runtimeCall} from '../runtime.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {workflowClient,connectWorkflows} from './client.js';
import {workflowFunctions} from './engine.js';
import {pipelineOperations,observation,type WorkflowOperation} from './pipeline.js';
import {memoryOperations} from './memory.js';
import {honchoClient} from '../honcho.js';
import {registerWorker,type WorkflowFamily} from './store.js';
import {approvalOperations} from './approvals.js';
import {browserOperation,managedRunOperation} from './browser.js';
import {scheduleOperation} from './schedules.js';
import {superviseConnection} from './supervisor.js';

export function startWorkflowService(pool:pg.Pool,config:Settings) {
  const inactive=process.env.NOCHEH_WORKFLOWS_ENABLED!=='true'||existsSync(join(config.dataDir,'spool/.restore-inactive'))||existsSync(join(config.dataDir,'workflows/inactive'));
  if(inactive)return {state:()=> 'inactive',close:async()=>{}};
  let stopping=false;
  const runtime=runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}));
  const domain={...pipelineOperations(pool,config,runtime),...memoryOperations(pool,config,runtime,honchoClient(config.honchoUrl)),...approvalOperations(pool,runtime),browser:browserOperation(pool,config,runtime),schedules:scheduleOperation(pool,runtime,managedRunOperation(pool,config,runtime,'scheduler'))};
  const operations:Partial<Record<WorkflowFamily,WorkflowOperation>>={};
  for(const [family,operation] of Object.entries(domain))operations[family as WorkflowFamily]=async(...args)=>stopping?observation('waiting','admission',0,Date.now()+30000,'owner_paused'):operation(...args);
  const service=superviseConnection(async()=>{
    const client=workflowClient('pipeline');
    return connectWorkflows('pipeline',client,workflowFunctions(client,pool,operations));
  },async()=>{await registerWorker(pool,'pipeline',Object.keys(operations) as WorkflowFamily[]);await heartbeat(pool,'workflow-pipeline');});
  return {state:service.state,async close(){stopping=true;await service.close();}};
}
