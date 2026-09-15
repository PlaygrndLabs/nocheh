import {settings} from '../config.js';
import {connectDatabase,initialize,heartbeat} from '../database.js';
import {brokerServer} from './broker.js';
import {guardService} from './guard-service.js';
import {runtimeCall} from '../runtime.js';
import {hermesAdapter} from '../hermes-adapter.js';
const config=settings(),pool=connectDatabase(config);
await initialize(pool);
const server=brokerServer({pool,token:config.token,model:process.env.NOCHEH_MODEL??'gpt-5.6-sol',
  archive:process.env.ARCHIVE_URL??'http://nocheh-app:8780',prepare:guardService(pool,config,runtimeCall(hermesAdapter({url:config.hermesUrl,token:config.token}))),hermes:config.hermesUrl});
const timer=setInterval(()=>{void heartbeat(pool,'nocheh-security').catch(()=>{});},5000);timer.unref();
server.listen(8786,'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{void pool.end();});});
