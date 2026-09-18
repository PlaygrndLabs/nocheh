import {createServer,type Server} from 'node:http';
import {HttpError} from './http.js';

// The browser is on the host; the OAuth client and PKCE verifier are in Docker.
// Hold port 1455 only while an owner-initiated login is pending. Never log URLs.
export class ProviderOAuth {
  private server:Server|undefined;
  private state:string|undefined;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private monitor:number,private key:string,private ownerPort:number,private callbackPort=1455,private monitorHost='127.0.0.1',private bindHost='127.0.0.1') {}
  close() {
    this.state=undefined;
    if(this.timer)clearTimeout(this.timer);
    this.server?.close();this.server=undefined;
  }
  async quiesce(){
    this.state=undefined;if(this.timer)clearTimeout(this.timer);
    const server=this.server;this.server=undefined;
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
  private async call(path:string,body?:unknown) {
    const response=await fetch(`http://${this.monitorHost}:${this.monitor}/v0/management/${path}`,{
      method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.key}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok)throw new HttpError(503,'provider_oauth_unavailable');
    return await response.json() as Record<string,unknown>;
  }
  async start() {
    if(this.server)throw new HttpError(409,'provider_login_already_pending');
    const server=createServer((req,res)=>{void(async()=>{
      res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
      res.setHeader('x-content-type-options','nosniff');
      const url=new URL(req.url??'/',`http://localhost:${this.callbackPort}`);
      const host=req.headers.host;
      const state=url.searchParams.get('state'),code=url.searchParams.get('code'),error=url.searchParams.get('error');
      if(req.method!=='GET'||url.pathname!=='/auth/callback'||![`localhost:${this.callbackPort}`,`127.0.0.1:${this.callbackPort}`].includes(host??'')||
        !state||!this.state||state!==this.state||(!code&&!error)||(code?.length??0)>4096) {
        res.writeHead(400,{'content-type':'text/plain'});res.end('This login is unknown or expired. Start a fresh login from Nocheh.');return;
      }
      this.state=undefined; // Consume before awaiting: the callback cannot replay.
      try {
        await this.call('oauth-callback',{provider:'codex',state,...(code?{code}:{error:'access_denied'})});
        res.writeHead(303,{location:`http://localhost:${this.ownerPort}/providers/management.html#/oauth`});res.end();
      } catch {
        res.writeHead(502,{'content-type':'text/plain'});res.end('The provider could not finish this login. Start a fresh login in Nocheh.');
      } finally {this.close();}
    })().catch(()=>{res.writeHead(500);res.end();});});
    this.server=server;
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.callbackPort,this.bindHost,()=>resolve());});
    } catch {this.close();throw new HttpError(409,'oauth_callback_port_busy');}
    this.timer=setTimeout(()=>this.close(),300000);this.timer.unref();
    try {
      // No is_webui: our host listener relays the callback via the authenticated
      // management API; the container's loopback forwarder is not reachable.
      const result=await this.call('codex-auth-url');
      if(typeof result.state!=='string'||!/^[a-zA-Z0-9_-]{16,256}$/.test(result.state)||typeof result.url!=='string')throw Error();
      const url=new URL(result.url);
      if(url.origin!=='https://auth.openai.com'||url.searchParams.get('state')!==result.state)throw Error();
      this.state=result.state;
      return result;
    } catch {this.close();throw new HttpError(503,'provider_oauth_unavailable');}
  }
}
