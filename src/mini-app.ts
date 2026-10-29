import {createServer,request,type IncomingMessage,type ServerResponse} from 'node:http';
import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {HttpError,json} from './http.js';

/** Telegram's published Ed25519 keys for third-party validation of Mini App launch data. */
export const TELEGRAM_KEYS={production:'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test:'40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec'} as const;
const SPKI=Buffer.from('302a300506032b6570032100','hex');
export const ed25519=(hex:string):KeyObject=>createPublicKey({key:Buffer.concat([SPKI,Buffer.from(hex,'hex')]),format:'der',type:'spki'});

export type LaunchCheck={botId:string;ownerId:string;key:KeyObject;now?:number;maxAgeSeconds?:number};

/**
 * Checks the launch data Telegram gives a Mini App, with Telegram's public key
 * and the public bot ID only: no bot token is needed. Only the owner, within
 * the allowed age, gets through.
 */
export function verifyLaunch(raw:string,check:LaunchCheck):{user_id:string;auth_date:number} {
  if(!raw||raw.length>8192)throw new HttpError(401,'telegram_launch_required');
  const params=new URLSearchParams(raw),keys=[...params.keys()];
  if(new Set(keys).size!==keys.length)throw new HttpError(401,'telegram_launch_invalid');
  const signature=params.get('signature')??'';
  if(!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature))throw new HttpError(401,'telegram_launch_invalid');
  const fields=[...params].filter(([key])=>key!=='hash'&&key!=='signature').sort(([a],[b])=>a<b?-1:a>b?1:0);
  const data=check.botId+':WebAppData\n'+fields.map(([key,value])=>key+'='+value).join('\n');
  if(!verify(null,Buffer.from(data),check.key,Buffer.from(signature,'base64url')))throw new HttpError(401,'telegram_launch_invalid');
  const issued=Number(params.get('auth_date')),now=(check.now??Date.now())/1000;
  if(!Number.isSafeInteger(issued)||issued>now+60||now-issued>(check.maxAgeSeconds??86400))throw new HttpError(401,'telegram_launch_expired');
  let user:unknown;try{user=JSON.parse(params.get('user')??'');}catch{throw new HttpError(401,'telegram_launch_invalid');}
  const id=String((user as {id?:unknown})?.id??'');
  if(!/^[1-9]\d{0,18}$/.test(id)||id!==check.ownerId)throw new HttpError(403,'owner_required');
  return {user_id:id,auth_date:issued};
}

/**
 * The owner routes the mini app may reach: home status, the Inbox and its
 * decisions, tasks with the chats and people they point to, and the problems
 * System › Health lists, with retrying failed work. Of settings only the
 * owner's own Telegram ID is read.
 */
const routes:[string,RegExp][]=[
  ['GET',/^\/(?:status|settings|decisions|tools\/actions|tasks|memory-access\/requests|conversations|entities|monitoring)$/],
  ['POST',/^\/workflows\/retry-failed$/],
  ['GET',/^\/decisions\/(?:controlled_action|telegram_action|memory_access|entity|knowledge)\/[a-f0-9]{64}$/],
  ['GET',/^\/(?:tools\/actions|knowledge\/proposals)\/[a-f0-9]{64}$/],
  ['GET',/^\/tasks\/(?:settings|[a-f0-9]{64})$/],
  ['POST',/^\/tasks(?:\/archive-finished|\/[a-f0-9]{64}(?:\/(?:comments|delete))?)?$/],
  ['POST',/^\/tools\/(?:decide|telegram-decision|grant)$/],
  ['POST',/^\/(?:memory-access\/requests|entities)\/[a-f0-9]{64}\/decide$/],
  ['POST',/^\/knowledge\/proposals\/[a-f0-9]{64}\/(?:decide|undo)$/],
];
export const miniAppRoute=(method:string,route:string):boolean=>routes.some(([m,re])=>m===method&&re.test(route));

export type DashboardTarget={host:string;port:number};

/** One request to the local dashboard, as the local dashboard page would make it. */
function send(target:DashboardTarget,method:string,path:string,headers:Record<string,string>,body?:Buffer):Promise<{status:number;headers:IncomingMessage['headers'];body:Buffer}> {
  return new Promise((resolve,reject)=>{
    const req=request({host:target.host,port:target.port,method,path,timeout:180000,
      // The dashboard only answers its own local address.
      headers:{...headers,host:'127.0.0.1:'+target.port,...(body?{'content-length':String(body.length)}:{})}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024){req.destroy(Error('dashboard_response_too_large'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({status:res.statusCode??502,headers:res.headers,body:Buffer.concat(chunks)}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('dashboard_timeout')));req.on('error',reject);req.end(body);
  });
}

/**
 * Calls the local dashboard for a phone. The mini app holds no credential: an
 * owner call carries the phone's own session token, which the dashboard checks
 * and limits to the mini app's routes.
 */
export class DashboardClient {
  constructor(readonly target:DashboardTarget){}
  call(method:string,path:string,body?:Buffer,phone?:string) {
    // A phone call always names a session, even an empty one, so the dashboard answers it as a phone.
    return send(this.target,method,'/api/nocheh'+path,{...(phone!==undefined?{'x-nocheh-mini-session':phone||'none'}:{}),
      ...(body?{'content-type':'application/json'}:{})},body);
  }
}

async function readBody(req:IncomingMessage,max=1024*1024):Promise<Buffer> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);size+=bytes.length;if(size>max)throw new HttpError(413,'body_too_large');chunks.push(bytes);}
  return Buffer.concat(chunks);
}

export type MiniAppOptions={check:Omit<LaunchCheck,'now'>;dashboard:DashboardClient;assets:string;now?:()=>number};

/** The phone sign-in routes of the dashboard, which holds the owner's password and every session. */
class MiniAppSessions {
  constructor(private dashboard:DashboardClient) {}
  private async lock(path:string,body:unknown) {
    const result=await this.dashboard.call('POST','/mini-app/'+path,Buffer.from(JSON.stringify(body)));
    let value:Record<string,unknown>={};try{value=JSON.parse(result.body.toString('utf8')) as Record<string,unknown>;}catch{}
    if(result.status>=500||!value||typeof value!=='object')throw new HttpError(503,'dashboard_unavailable');
    return {status:result.status,value};
  }
  async state(token:string):Promise<string> {
    const {status,value}=await this.lock('check',{token});
    if(status!==200||!['signed_in','signed_out','no_password'].includes(String(value.state)))throw new HttpError(503,'dashboard_unavailable');
    return String(value.state);
  }
  signIn(password:unknown) {return this.lock('sign-in',{password});}
  async signOut(token:string) {await this.lock('sign-out',{token});}
}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; "+
  "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org";

/**
 * The Telegram Mini App's own small server. It is the only part of Nocheh
 * that a tunnel exposes: it serves the mini app page and forwards a fixed set
 * of owner routes to the local dashboard after checking Telegram's signature
 * and the phone's password sign-in.
 */
export function miniAppServer(options:MiniAppOptions) {
  const sessions=new MiniAppSessions(options.dashboard);
  return createServer((req,res)=>{void handle(options,sessions,req,res).catch(error=>{
    if(!res.headersSent)json(res,error instanceof HttpError?error.status:502,{error:error instanceof HttpError?error.code:'mini_app_unavailable'});else res.destroy();
  });});
}

async function handle(options:MiniAppOptions,sessions:MiniAppSessions,req:IncomingMessage,res:ServerResponse) {
  const url=new URL(req.url??'/','http://mini.invalid'),path=url.pathname,method=req.method??'';
  res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');res.setHeader('content-security-policy',CSP);
  if(method==='GET'&&path==='/health')return json(res,200,{ok:true});
  const token=String(req.headers['x-nocheh-mini-session']??'').slice(0,100);
  // Signing in, checking and signing out: each still needs the owner's Telegram launch data.
  const own=['GET /api/mini/session','POST /api/mini/sign-in','POST /api/mini/sign-out'].includes(method+' '+path);
  if(own||path.startsWith('/api/nocheh/')) {
    if(req.headers.origin&&req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'cross_site_denied');
  }
  if(own) {
    if(url.search)throw new HttpError(404,'not_found');
    verifyLaunch(String(req.headers['x-telegram-init-data']??''),{...options.check,now:(options.now??Date.now)()});
    res.setHeader('cache-control','no-store');
    if(path==='/api/mini/session')return json(res,200,{state:await sessions.state(token)});
    if(path==='/api/mini/sign-out'){await sessions.signOut(token);return json(res,200,{ok:true});}
    let password:unknown;try{password=(JSON.parse((await readBody(req,4096)).toString('utf8')) as {password?:unknown})?.password;}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'invalid_json');}
    const {status,value}=await sessions.signIn(password);
    const pick=(key:string)=>value[key]!==undefined?{[key]:value[key]}:{};
    return json(res,status,{...pick('token'),...pick('error'),...pick('until'),...pick('tries_left')});
  }
  if(path.startsWith('/api/nocheh/')) {
    const route=path.slice('/api/nocheh'.length);
    if(!miniAppRoute(method,route)||url.search.length>600)throw new HttpError(404,'not_found');
    verifyLaunch(String(req.headers['x-telegram-init-data']??''),{...options.check,now:(options.now??Date.now)()});
    const body=method==='POST'?await readBody(req):undefined;
    // The dashboard checks the phone's sign-in and refuses any route outside the mini app's.
    const result=await options.dashboard.call(method,route+url.search,body,token);
    // The Inbox reads settings only to know which chat is the owner's own.
    if(route==='/settings'&&result.status===200) {
      const view=JSON.parse(result.body.toString('utf8')) as {fields?:{key:string}[]};
      return json(res,200,{fields:(view.fields??[]).filter(field=>field.key==='TELEGRAM_OWNER_ID')});
    }
    res.writeHead(result.status,{'content-type':String(result.headers['content-type']??'application/json; charset=utf-8'),'cache-control':'no-store'});
    res.end(result.body);return;
  }
  if(method!=='GET')throw new HttpError(405,'method_not_allowed');
  if(path==='/'||path==='/index.html') {
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});
    res.end(await readFile(join(options.assets,'mini.html')));return;
  }
  const asset=path.match(/^\/assets\/(mini\.js|style\.css|chunks\/[a-zA-Z0-9_-]+\.js)$/);
  if(!asset?.[1])throw new HttpError(404,'not_found');
  res.writeHead(200,{'content-type':asset[1].endsWith('.css')?'text/css':'text/javascript','cache-control':'no-cache'});
  createReadStream(join(options.assets,asset[1])).on('error',()=>res.destroy()).pipe(res);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const botId=process.env.TELEGRAM_BOT_ID??'',ownerId=process.env.TELEGRAM_OWNER_ID??'';
  if(!/^[1-9]\d{0,18}$/.test(botId)||!/^[1-9]\d{0,18}$/.test(ownerId))throw Error('mini_app_requires_telegram_bot_and_owner');
  const port=Number(process.env.NOCHEH_MINI_APP_PORT??8788),dashboardPort=Number(process.env.NOCHEH_DASHBOARD_PORT??8783);
  const server=miniAppServer({check:{botId,ownerId,key:ed25519(process.env.TELEGRAM_TEST_ENVIRONMENT==='true'?TELEGRAM_KEYS.test:TELEGRAM_KEYS.production)},
    dashboard:new DashboardClient({host:process.env.NOCHEH_DASHBOARD_HOST??'nocheh-dashboard',port:dashboardPort}),assets:join(process.cwd(),'dashboard/dist')});
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'mini_app_ready',port})));
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
}
