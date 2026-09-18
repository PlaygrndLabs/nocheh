import {randomUUID} from 'node:crypto';
import {HttpError} from './http.js';

/** Freeze admission before draining already-admitted management work. */
export class ManagementMaintenance {
  private requests=new Map<symbol,Promise<void>>();
  private current:{job:string;token:string;ready:boolean}|undefined;
  enter(){const id=Symbol();let done!:()=>void;const completion=new Promise<void>(resolve=>{done=resolve;});
    this.requests.set(id,completion);return {id,finish:()=>{this.requests.delete(id);done();}};}
  get active(){return !!this.current;}
  get state(){return this.current?{...this.current}:null;}
  allows(method:string,path:string){
    if(!this.current)return true;
    if(method!=='GET')return false;
    if(path==='/'||/^\/assets\/(?:app\.js|style\.css|graph-3d\.js|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(path))return true;
    const route=path.replace(/^\/api\/(?:plugins\/)?nocheh\//,'/');
    return ['/health','/maintenance','/jobs','/jobs/'+this.current.job].includes(route);
  }
  async begin(job:string,request:symbol,timeoutMs=60000){
    if(this.current)throw new HttpError(409,'maintenance_busy');
    const token=randomUUID();this.current={job,token,ready:false};let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([Promise.all([...this.requests].filter(([id])=>id!==request).map(([,done])=>done)),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(409,'management_drain_timeout')),timeoutMs);})]);
      return token;
    }catch(error){this.end(token);throw error;}finally{clearTimeout(timer);}
  }
  ready(token:string){if(this.current?.token!==token)throw new HttpError(409,'maintenance_changed');this.current.ready=true;}
  end(token:string){if(this.current?.token===token)this.current=undefined;}
}
