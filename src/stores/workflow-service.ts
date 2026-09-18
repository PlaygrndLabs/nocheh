import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Settings} from '../config.js';
import type {RuntimeCall} from '../runtime.js';
import {connectWorkflows,workflowClient} from '../workflows/client.js';
import {workflowFunctions} from '../workflows/engine.js';
import {observation,type WorkflowOperation} from '../workflows/pipeline.js';
import {registerWorker,type WorkflowFamily} from '../workflows/store.js';
import {superviseConnection} from '../workflows/supervisor.js';
import {assertGuardConfiguration,restoredInactive,storageHeartbeat} from './lifecycle.js';
import type {StorageServices} from './services.js';
import {storageWorkflowOperations} from './workflow-operations.js';

export function startStorageWorkflows(s:StorageServices,config:Settings,call:RuntimeCall) {
  const inactive=()=>restoredInactive(config.dataDir)||existsSync(join(config.dataDir,'workflows/inactive'));
  if(inactive())return {state:()=> 'inactive',close:async()=>{}};
  let stopping=false;
  const operations:Partial<Record<WorkflowFamily,WorkflowOperation>>={};
  for(const [family,operation] of Object.entries(storageWorkflowOperations(s,call)))operations[family as WorkflowFamily]=async(...args)=>{
    if(stopping||inactive())return observation('waiting','admission',0,Date.now()+30000,'owner_paused');
    await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);return operation(...args);
  };
  const service=superviseConnection(async()=>{
    const client=workflowClient('pipeline');
    return connectWorkflows('pipeline',client,workflowFunctions(client,s.stores.control,operations),undefined,2);
  },async()=>{
    await registerWorker(s.stores.control,'pipeline',Object.keys(operations) as WorkflowFamily[]);await storageHeartbeat(s.stores,'workflow-pipeline');
  });
  return {state:service.state,async close(){stopping=true;await service.close();}};
}
