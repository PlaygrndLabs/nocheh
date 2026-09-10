import {settings} from '../config.js';
import {connectDatabase,initialize,heartbeat} from '../database.js';
import {brokerServer} from './broker.js';
const config=settings(),pool=connectDatabase(config);
await initialize(pool);
const server=brokerServer({pool,token:config.token,model:process.env.NOCHEH_MODEL??'gpt-5.6-sol',
  archive:process.env.ARCHIVE_URL??'http://archive:8780',guard:process.env.GUARD_URL??'http://guard:8780',hermes:config.hermesUrl});
const timer=setInterval(()=>{void heartbeat(pool,'security').catch(()=>{});},5000);timer.unref();
server.listen(8786,'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{void pool.end();});});
