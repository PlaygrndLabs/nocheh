import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {honchoClient} from '../honcho.js';
import {runtimeCall} from '../runtime.js';
import {runtimeStoreGroups} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageServer} from './server.js';
import {startStorageCapture} from './worker.js';
import {startStorageWorkflows} from './workflow-service.js';
import {hostTransport} from '../workflows/host-transport.js';
import {restoredInactive} from './lifecycle.js';

const config=settings(),pools=runtimeStoreGroups(),call=runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}));
const options={dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:()=>config.assistant,runtime:call,honcho:honchoClient(config.honchoUrl)};
const services=storageServices(pools.api,options),workflowServices=storageServices(pools.workflow,options);
const capture=startStorageCapture(services,config),workflows=startStorageWorkflows(workflowServices,config,call);
const transport=process.env.INNGEST_SIGNING_KEY?hostTransport(process.env.INNGEST_SIGNING_KEY,undefined,undefined,()=>!restoredInactive(config.dataDir)):undefined;
const server=storageServer(services,config,call,()=>({...capture.status(),workflows:workflows.state()}),transport);
transport?.attach(server);
server.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'ready',service:config.service,storage_layout:'original-only-v1',port:(server.address() as {port:number}).port})));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  transport?.close();
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  void Promise.all([closed,capture.stop(),workflows.close()]).then(()=>pools.close()).catch(()=>{process.exitCode=1;});
});
