import type {WorkerConnection} from 'inngest/connect';

type Connection=Pick<WorkerConnection,'state'|'close'|'closed'>;
/** The SDK owns reconnects within a connection; restart only a closed/failed one. */
export function superviseConnection(connect:()=>Promise<Connection>,report:()=>Promise<void>,interval=5000) {
  let stopped=false,connection:Connection|null=null,starting=false,reporting:Promise<void>|null=null;
  const tick=()=>{
    if(stopped)return;
    if(connection?.state==='ACTIVE'&&!reporting) {
      reporting=report().catch(()=>{}).finally(()=>{reporting=null;});
    }
    if(connection||starting)return;
    starting=true;
    void connect().then(async next=>{
      if(stopped){await next.close();return;}
      connection=next;
      void next.closed.finally(()=>{if(connection===next)connection=null;}).catch(()=>{});
      tick();
    }).catch(()=>{}).finally(()=>{starting=false;});
  };
  const timer=setInterval(tick,interval);tick();
  return {
    state:()=>stopped?'stopped':connection?.state==='ACTIVE'?'connected':'reconnecting',
    async close(){
      if(stopped)return;
      stopped=true;clearInterval(timer);
      // Initial connect has no cancellation API. A late result closes itself;
      // it cannot start domain work after the application closes admission.
      await connection?.close();await reporting;
    },
  };
}
