import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {settings} from '../config.js';
import {connectDatabase,initialize,heartbeat} from '../database.js';
import {runtimeCall} from '../runtime.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {workflowClient,connectWorkflows} from './client.js';
import {workflowFunctions} from './engine.js';
import {pipelineOperations} from './pipeline.js';
import {memoryOperations} from './memory.js';
import {honchoClient} from '../honcho.js';
import {registerWorker,type WorkflowFamily} from './store.js';
import {approvalOperations} from './approvals.js';
import {browserOperation} from './browser.js';

const config=settings(),pool=connectDatabase(config);
await initialize(pool);
const inactive=process.env.NOCHEH_WORKFLOWS_ENABLED!=='true'||existsSync(join(config.dataDir,'spool/.restore-inactive'))||existsSync(join(config.dataDir,'workflows/inactive'));
const client=workflowClient('pipeline');
const runtime=runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}));
const operations={...pipelineOperations(pool,config,runtime),...memoryOperations(pool,config,runtime,honchoClient(config.honchoUrl)),...approvalOperations(pool,runtime),browser:browserOperation(pool,config,runtime)};
const connection=inactive?null:await connectWorkflows('pipeline',client,workflowFunctions(client,pool,operations));
const report=async()=>{await registerWorker(pool,'pipeline',Object.keys(operations) as WorkflowFamily[]);await heartbeat(pool,'workflow-pipeline');};
if(connection?.state==='ACTIVE')await report();
const timer=setInterval(()=>{if(connection?.state==='ACTIVE')void report().catch(()=>{});},5000);
const server=createServer((_request,response)=>{void pool.query('SELECT 1').then(()=>{
  const connected=connection?.state==='ACTIVE';response.writeHead(inactive||connected?200:503,{'content-type':'application/json'});
  response.end(JSON.stringify({ok:inactive||connected,service:'workflow-pipeline',state:inactive?'inactive':connected?'connected':'reconnecting'}));
},()=>{response.writeHead(503);response.end('{"ok":false,"state":"database_unavailable"}');});});
server.listen(8780,'0.0.0.0');
let stopping=false;
function stop(){if(stopping)return;stopping=true;clearInterval(timer);void Promise.all([connection?.close(),new Promise<void>(resolve=>server.close(()=>resolve()))]).then(()=>pool.end()).then(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
