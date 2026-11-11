import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {telegramAdapter} from '../frontdoor/telegram.js';
import {memoryEngine} from '../memory/engines.js';
import {combinedAdapter,runtimeCall} from '../runtime.js';
import {brainWithPrompts,withPrompts} from '../prompts.js';
import {brain} from '../brain/brains.js';
import {brokerServer} from '../security/broker.js';
import {runtimeStores} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageGuardService} from './guard-service.js';
import {assertStorageActive,assertGuardConfiguration,restoredInactive,storageHealth,storageHeartbeat} from './lifecycle.js';

const config=settings(),stores=runtimeStores(),call=withPrompts(runtimeCall(combinedAdapter(telegramAdapter({url:config.telegramUrl,token:config.token}),hermesAdapter({url:config.hermesUrl,token:config.token}))),stores.control);
const services=storageServices(stores,{dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:()=>config.assistant,runtime:call,brain:brainWithPrompts(brain(config),stores.control),memoryEngine:memoryEngine(config)});
const server=brokerServer({pool:stores.control,storage:services.turns,token:config.token,model:process.env.NOCHEH_MODEL??'claude-sonnet-5-5',
  archive:process.env.ARCHIVE_URL??'http://nocheh-app:8780',hermes:config.hermesUrl,prepare:storageGuardService(services),
  assertActive:()=>assertStorageActive(config.dataDir),assertReady:async()=>{await assertGuardConfiguration(services.guards,config.guardMode);await services.configuration.assert(config.assistant);},health:()=>storageHealth(stores)});
const timer=setInterval(()=>{if(!restoredInactive(config.dataDir))void storageHeartbeat(stores,'nocheh-security').catch(()=>{});},5000);timer.unref();
server.listen(8786,'0.0.0.0');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;clearInterval(timer);
  server.close(()=>{void stores.close().catch(()=>{process.exitCode=1;});});
});
