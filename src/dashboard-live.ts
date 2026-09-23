import type {ServerResponse} from 'node:http';
import {HttpError} from './http.js';

/** A bounded invalidation stream. Reads stay on the existing authorized endpoints. */
export class DashboardLiveUpdates {
  private readonly clients=new Set<ServerResponse>();
  constructor(private readonly intervalMs=4000,private readonly limit=64) {}
  open(res:ServerResponse){
    if(this.clients.size>=this.limit)throw new HttpError(429,'live_stream_limit');
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
    res.write('retry: 2000\n: connected\n\n');
    this.clients.add(res);
    const timer=setInterval(()=>{
      if(res.writableEnded)return;
      if(res.writableLength>16*1024){res.end();return;}
      res.write('event: refresh\ndata: {}\n\n');
    },this.intervalMs);
    timer.unref();
    const maxAge=setTimeout(()=>res.end(),30*60*1000);maxAge.unref();
    res.once('close',()=>{clearInterval(timer);clearTimeout(maxAge);this.clients.delete(res);});
  }
  closeAll(){for(const client of this.clients)client.end();}
}
