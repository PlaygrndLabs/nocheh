import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {telegramAdapter} from '../frontdoor/telegram.js';
import {memoryEngine} from '../memory/engines.js';
import {combinedAdapter,runtimeCall} from '../runtime.js';
import {brainWithPrompts,withPrompts} from '../prompts.js';
import {brain} from '../brain/brains.js';
import {runtimeStoreGroups} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageServer} from './server.js';
import {startStorageCapture} from './worker.js';
import {startStorageWorkflows} from './workflow-service.js';
import {hostTransport} from '../workflows/host-transport.js';
import {restoredInactive} from './lifecycle.js';

// Turns and service calls that run a built-in instruction text carry the owner's replacements. Telegram calls go to
// Nocheh's own bot (ADR-0235), the other helper services to the Hermes service.
const config=settings(),pools=runtimeStoreGroups(),adapter=combinedAdapter(telegramAdapter({url:config.telegramUrl,token:config.token}),hermesAdapter({url:config.hermesUrl,token:config.token})),call=withPrompts(runtimeCall(adapter),pools.api.control);
const options={dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:()=>config.assistant,runtime:call,brain:brainWithPrompts(brain(config),pools.api.control),memoryEngine:memoryEngine(config)};
const services=storageServices(pools.api,options),workflowServices=storageServices(pools.workflow,options);
const capture=startStorageCapture(services,config),workflows=startStorageWorkflows(workflowServices,config,call);
const transport=process.env.INNGEST_SIGNING_KEY?hostTransport(process.env.INNGEST_SIGNING_KEY,undefined,undefined,()=>!restoredInactive(config.dataDir)):undefined;
const server=storageServer(services,config,call,()=>({...capture.status(),workflows:workflows.state()}),transport,adapter.capabilities);
transport?.attach(server);
// Long-term memory is on by default once its engine's service (Honcho) is enabled; an owner's own attach or detach stands.
if(config.honchoEnabled)void services.memory.attachByDefault().catch(error=>console.warn(JSON.stringify({event:'memory_default_attach_failed',code:error?.code??'unknown'})));
server.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'ready',service:config.service,storage_layout:'original-only-v1',port:(server.address() as {port:number}).port})));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  transport?.close();
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  void Promise.all([closed,capture.stop(),workflows.close()]).then(()=>pools.close()).catch(()=>{process.exitCode=1;});
});
