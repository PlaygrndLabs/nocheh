import {settings} from '../config.js';
import {hermesAdapter} from '../hermes-adapter.js';
import {honchoClient} from '../honcho.js';
import {runtimeCall} from '../runtime.js';
import {brokerServer} from '../security/broker.js';
import {runtimeStores} from './runtime-pools.js';
import {storageServices} from './services.js';
import {storageGuardService} from './guard-service.js';
import {assertStorageActive,assertGuardConfiguration,restoredInactive,storageHealth,storageHeartbeat} from './lifecycle.js';

const config=settings(),stores=runtimeStores(),call=runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}));
const services=storageServices(stores,{dataDir:config.dataDir,detectorVersion:config.detectorVersion,serviceToken:config.token,
  policy:()=>config.assistant,runtime:call,honcho:honchoClient(config.honchoUrl)});
const server=brokerServer({pool:stores.control,storage:services.turns,token:config.token,model:process.env.NOCHEH_MODEL??'gpt-5.6-sol',
  archive:process.env.ARCHIVE_URL??'http://nocheh-app:8780',hermes:config.hermesUrl,prepare:storageGuardService(services),
  assertActive:()=>assertStorageActive(config.dataDir),assertReady:()=>assertGuardConfiguration(services.guards,config.guardMode),health:()=>storageHealth(stores)});
const timer=setInterval(()=>{if(!restoredInactive(config.dataDir))void storageHeartbeat(stores,'nocheh-security').catch(()=>{});},5000);timer.unref();
server.listen(8786,'0.0.0.0');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;clearInterval(timer);
  server.close(()=>{void stores.close().catch(()=>{process.exitCode=1;});});
});
