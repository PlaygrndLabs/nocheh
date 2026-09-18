import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {honchoClient} from '../honcho.js';
import {runtimeCall} from '../runtime.js';
import {runtimeStores} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageServer} from './server.js';
import {startStorageCapture} from './worker.js';
import {startStorageWorkflows} from './workflow-service.js';

const config=settings(),stores=runtimeStores(),call=runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}));
const services=storageServices(stores,{dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:()=>config.assistant,runtime:call,honcho:honchoClient(config.honchoUrl)});
const capture=startStorageCapture(services,config),workflows=startStorageWorkflows(services,config,call);
const server=storageServer(services,config,call,()=>({...capture.status(),workflows:workflows.state()}));
server.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'ready',service:config.service,storage_layout:'original-only-v1',port:(server.address() as {port:number}).port})));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  void Promise.all([closed,capture.stop(),workflows.close()]).then(()=>stores.close()).catch(()=>{process.exitCode=1;});
});
