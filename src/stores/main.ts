import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {telegramAdapter} from '../frontdoor/telegram.js';
import {memoryEngine} from '../memory/engines.js';
import {combinedAdapter,runtimeCall} from '../runtime.js';
import {agentWithPrompts,withPrompts} from '../prompts.js';
import {agent} from '../agent/agents.js';
import {ownerPublicName} from './entities.js';
import {agentOperation} from '../agent/agent.js';
import {runtimeStoreGroups} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageServer} from './server.js';
import {startStorageCapture} from './worker.js';
import {startStorageWorkflows} from './workflow-service.js';
import {hostTransport} from '../workflows/host-transport.js';
import {restoredInactive} from './lifecycle.js';
import {servedPolicy} from './chats.js';
import {startChatRecords} from './chat-seed.js';
import {memberAppServer} from './member-app.js';
import {MEMBER_APP_PORT} from '../member-app-wire.js';
import {launchKey} from '../telegram-launch.js';
import {schemaReady} from './dev-schema.js';

// Turns and service calls that run a built-in instruction text carry the owner's replacements. Telegram calls go to
// Nocheh's own bot (ADR-0235), the other helper services to the Hermes service.
// The members' app checks Telegram's launch data with the public bot id and Telegram's key; a fixture key set where it
// may not be honoured stops the app here, before anything starts (ADR-0265 D2).
const memberBot=process.env.TELEGRAM_BOT_ID??'',memberKey=launchKey(process.env,memberBot);
const config=settings(),pools=runtimeStoreGroups(),adapter=combinedAdapter(telegramAdapter({url:config.telegramUrl,token:config.token}),hermesAdapter({url:config.hermesUrl,token:config.agentKey})),call=withPrompts(runtimeCall(adapter),pools.api.control);
// Chats are served as the chat directory holds them (ADR-0252): the owner adds Nocheh to a group or turns it on (ADR-0253).
const options={dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:servedPolicy(()=>config.assistant),runtime:call,agent:agentWithPrompts(agent(config),pools.api.control,()=>ownerPublicName(pools.api.control,config.assistant.owner_id)),memoryEngine:memoryEngine(config)};
// In development nothing reads or runs before the store setup of this build has finished (dev-schema.ts).
await schemaReady(pools.api.control);
const services=storageServices(pools.api,options),workflowServices=storageServices(pools.workflow,options);
// Every chat already stored gets its row and the directory loads before anything captures or runs.
const stopChatRecords=await startChatRecords(pools.api,services.chats,()=>config.assistant);
const capture=startStorageCapture(services,config),workflows=startStorageWorkflows(workflowServices,config,call);
const transport=process.env.INNGEST_SIGNING_KEY?hostTransport(process.env.INNGEST_SIGNING_KEY,undefined,undefined,()=>!restoredInactive(config.dataDir)):undefined;
const server=storageServer(services,config,call,()=>({...capture.status(),workflows:workflows.state()}),transport,adapter.capabilities);
transport?.attach(server);
// Long-term memory is on by default once its engine's service (Honcho) is enabled; an owner's own attach or detach stands.
// The unused-facts rule checks hourly and sweeps at most once a day (ADR-0299); a restored, inactive install never runs it.
const stopCleanUp=services.memoryDashboard.startCleanUp(()=>!restoredInactive(config.dataDir));
if(config.honchoEnabled)void services.memory.attachByDefault().catch(error=>console.warn(JSON.stringify({event:'memory_default_attach_failed',code:error?.code??'unknown'})));
// The members' app's own listener (ADR-0265 D3): only /v1/member-app/*, reached by nocheh-miniapp alone.
// A member's own schedules go through the same agent operation as the owner's Schedules page (members' schedules).
const memberApp=memberAppServer({control:services.stores.control,tasks:services.tasks,policy:()=>services.access.policy(),call,dataDir:config.dataDir,
  ...(services.agent.manageSchedules?{schedules:agentOperation(services.agent,'manageSchedules')}:{})},
  {botId:memberBot,key:memberKey});
memberApp.listen(MEMBER_APP_PORT,config.host,()=>console.log(JSON.stringify({event:'member_app_ready',port:MEMBER_APP_PORT})));
server.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'ready',service:config.service,storage_layout:'original-only-v1',port:(server.address() as {port:number}).port})));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  transport?.close();stopChatRecords();stopCleanUp();
  const closed=Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>memberApp.close(()=>resolve()))]);
  void Promise.all([closed,capture.stop(),workflows.close()]).then(()=>pools.close()).catch(()=>{process.exitCode=1;});
});
