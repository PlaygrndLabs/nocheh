import {createServer,request,type IncomingMessage,type ServerResponse} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {HttpError,json} from './http.js';
import {launchKey,MEMBER_LAUNCH_MAX_AGE,verifyLaunch,verifyLaunchUser,type LaunchCheck} from './telegram-launch.js';
import {MEMBER_APP_BODY_MAX,MEMBER_APP_CORE_PREFIX,MEMBER_APP_PAGE,MEMBER_APP_PUBLIC_PREFIX,MEMBER_APP_QUERY_MAX,MEMBER_LAUNCH_HEADER,memberAppErrors,
  memberAppRoute} from './member-app-wire.js';

/**
 * The owner routes the mini app may reach: home status, the Inbox and its
 * decisions, tasks with the chats and people they point to, schedules, and the problems
 * System › Health lists, with retrying failed work. Of settings only the
 * owner's own Telegram ID is read.
 */
const routes:[string,RegExp][]=[
  ['GET',/^\/(?:status|settings|decisions|tools\/actions|tasks|schedules|schedules\/runs|memory-access\/requests|conversations|entities|monitoring)$/],
  // Pause, Resume, Run now or Delete on a schedule (ADR-0266).
  ['POST',/^\/schedules$/],
  ['POST',/^\/workflows\/retry-failed$/],
  ['GET',/^\/decisions\/(?:controlled_action|telegram_action|memory_access|entity|knowledge)\/[a-f0-9]{64}$/],
  ['GET',/^\/(?:tools\/actions|knowledge\/proposals)\/[a-f0-9]{64}$/],
  // A person or project card offers the other cards waiting, to fold one into another.
  ['GET',/^\/entities\/suggestions$/],
  ['GET',/^\/tasks\/(?:settings|[a-f0-9]{64}(?:\/audience)?)$/],
  ['POST',/^\/tasks(?:\/archive-finished|\/[a-f0-9]{64}(?:\/(?:comments|delete))?)?$/],
  ['POST',/^\/tools\/(?:decide|telegram-decision|resolve|telegram-resolve|grant)$/],
  ['POST',/^\/(?:memory-access\/requests|entities)\/[a-f0-9]{64}\/decide$/],
  ['POST',/^\/entities\/[a-f0-9]{64}\/(?:fold|split)$/],
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
  call(method:string,path:string,body?:Buffer,phone?:string,launch?:string) {
    // A phone call always names a session, even an empty one, so the dashboard answers it as a phone.
    return send(this.target,method,'/api/nocheh'+path,{...(phone!==undefined?{'x-nocheh-mini-session':phone||'none'}:{}),
      ...(launch!==undefined?{'x-telegram-init-data':launch}:{}),...(body?{'content-type':'application/json'}:{})},body);
  }
}

/** Where the members' app's listener in nocheh-app is (NOCHEH_APP_URL, http://nocheh-app:8790). */
export type AppTarget={host:string;port:number};
/** Reads NOCHEH_APP_URL: a plain http address with a host and a port and nothing else, or null. */
export function appTarget(value:string|undefined):AppTarget|null {
  if(!value)return null;
  try {
    const url=new URL(value);
    if(url.protocol!=='http:'||!url.hostname||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))return null;
    return {host:url.hostname,port:Number(url.port||80)};
  } catch {return null;}
}

/**
 * Calls the members' app's own listener in nocheh-app for the member page (ADR-0265 D3). It sends only the launch data
 * and the body, never a phone session, a cookie or a credential: nocheh-app checks the launch again and decides who the
 * member is itself.
 */
export class AppClient {
  constructor(readonly target:AppTarget){}
  call(method:string,route:string,launch:string,body?:Buffer) {
    return send(this.target,method,MEMBER_APP_CORE_PREFIX+route,{[MEMBER_LAUNCH_HEADER]:launch,...(body?{'content-type':'application/json'}:{})},body);
  }
}

async function readBody(req:IncomingMessage,max=1024*1024):Promise<Buffer> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);size+=bytes.length;if(size>max)throw new HttpError(413,'body_too_large');chunks.push(bytes);}
  return Buffer.concat(chunks);
}

/** `app` is the members' app's listener; without it every member route answers 503 member_app_unavailable. */
export type MiniAppOptions={check:Omit<LaunchCheck,'now'>;dashboard:DashboardClient;app?:AppClient;assets:string;now?:()=>number};

/** The phone sign-in routes of the dashboard, which holds the owner's password and every session. */
class MiniAppSessions {
  constructor(private dashboard:DashboardClient) {}
  private async lock(path:string,body:unknown,launch?:string) {
    const result=await this.dashboard.call('POST','/mini-app/'+path,Buffer.from(JSON.stringify(body)),undefined,launch);
    let value:Record<string,unknown>={};try{value=JSON.parse(result.body.toString('utf8')) as Record<string,unknown>;}catch{}
    if(result.status>=500||!value||typeof value!=='object')throw new HttpError(503,'dashboard_unavailable');
    return {status:result.status,value};
  }
  async state(token:string):Promise<string> {
    const {status,value}=await this.lock('check',{token});
    if(status!==200||!['signed_in','signed_out','no_password'].includes(String(value.state)))throw new HttpError(503,'dashboard_unavailable');
    return String(value.state);
  }
  /** The launch data goes along, so the dashboard counts wrong passwords per Telegram account (ADR-0251). */
  signIn(password:unknown,launch:string) {return this.lock('sign-in',{password},launch);}
  async signOut(token:string) {await this.lock('sign-out',{token});}
}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; "+
  "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org";
/** The member page shares the owner page's origin, so it also takes only Trusted Types into its DOM sinks: it never
 * renders raw HTML (ADR-0265 D1). */
const MEMBER_CSP=CSP+"; require-trusted-types-for 'script'";

/**
 * The Telegram Mini App's own small server. It is the only part of Nocheh
 * that a tunnel exposes: it serves the mini app page and forwards a fixed set
 * of owner routes to the local dashboard after checking Telegram's signature
 * and the phone's password sign-in. It also serves the members' page at `/m/`
 * and forwards its fixed routes to nocheh-app's member listener (ADR-0265).
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
  if(own||path.startsWith('/api/nocheh/')||path.startsWith(MEMBER_APP_PUBLIC_PREFIX+'/')) {
    if(req.headers.origin&&req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'cross_site_denied');
  }
  if(own) {
    if(url.search)throw new HttpError(404,'not_found');
    verifyLaunch(String(req.headers['x-telegram-init-data']??''),{...options.check,now:(options.now??Date.now)()});
    res.setHeader('cache-control','no-store');
    if(path==='/api/mini/session')return json(res,200,{state:await sessions.state(token)});
    if(path==='/api/mini/sign-out'){await sessions.signOut(token);return json(res,200,{ok:true});}
    let password:unknown;try{password=(JSON.parse((await readBody(req,4096)).toString('utf8')) as {password?:unknown})?.password;}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'invalid_json');}
    const {status,value}=await sessions.signIn(password,String(req.headers['x-telegram-init-data']??''));
    const pick=(key:string)=>value[key]!==undefined?{[key]:value[key]}:{};
    return json(res,status,{...pick('token'),...pick('error'),...pick('until'),...pick('tries_left')});
  }
  if(path.startsWith(MEMBER_APP_PUBLIC_PREFIX+'/'))return member(options,req,res,url);
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
  // The members' page (ADR-0265 D1), with Trusted Types required.
  if(path===MEMBER_APP_PAGE||path===MEMBER_APP_PAGE+'index.html') {
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','content-security-policy':MEMBER_CSP});
    res.end(await readFile(join(options.assets,'member.html')));return;
  }
  const asset=path.match(/^\/assets\/(mini\.js|member\.js|style\.css|chunks\/[a-zA-Z0-9_-]+\.js)$/);
  if(!asset?.[1])throw new HttpError(404,'not_found');
  res.writeHead(200,{'content-type':asset[1].endsWith('.css')?'text/css':'text/javascript','cache-control':'no-cache',
    ...(asset[1]==='member.js'?{'content-security-policy':MEMBER_CSP}:{})});
  createReadStream(join(options.assets,asset[1])).on('error',()=>res.destroy()).pipe(res);
}

/**
 * The member page's calls (ADR-0265): `/api/member/<route>` for MEMBER_APP_ROUTES only, a query on GET tasks only, a
 * small body, and Telegram's launch data from anyone but the owner, at most an hour old (the owner gets 403
 * member_required: the owner's own mini app is at `/`). Forwarded as `/v1/member-app/<route>` to nocheh-app's member
 * listener, which checks the launch again and who the member is; never to the dashboard, and never with a session.
 */
async function member(options:MiniAppOptions,req:IncomingMessage,res:ServerResponse,url:URL) {
  const method=req.method??'',route=url.pathname.slice(MEMBER_APP_PUBLIC_PREFIX.length),found=memberAppRoute(method,route);
  if(!found||url.search&&found.name!=='tasks'||url.search.length>MEMBER_APP_QUERY_MAX)throw new HttpError(404,'not_found');
  const launch=String(req.headers[MEMBER_LAUNCH_HEADER]??'');
  let user:string;
  try{user=verifyLaunchUser(launch,{botId:options.check.botId,key:options.check.key,maxAgeSeconds:MEMBER_LAUNCH_MAX_AGE,now:(options.now??Date.now)()}).user_id;}
  catch{throw new HttpError(401,memberAppErrors.launchInvalid);}
  if(user===options.check.ownerId)throw new HttpError(403,memberAppErrors.memberRequired);
  if(!options.app)throw new HttpError(503,'member_app_unavailable');
  const body=method==='POST'?await readBody(req,MEMBER_APP_BODY_MAX):undefined;
  const result=await options.app.call(method,route+url.search,launch,body);
  // Only the answer itself goes back: JSON, never stored, and no header nocheh-app might add.
  res.writeHead(result.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(result.body);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const botId=process.env.TELEGRAM_BOT_ID??'',ownerId=process.env.TELEGRAM_OWNER_ID??'';
  if(!/^[1-9]\d{0,18}$/.test(botId)||!/^[1-9]\d{0,18}$/.test(ownerId))throw Error('mini_app_requires_telegram_bot_and_owner');
  const port=Number(process.env.NOCHEH_MINI_APP_PORT??8788),dashboardPort=Number(process.env.NOCHEH_DASHBOARD_PORT??8783);
  // The members' app's listener in nocheh-app; without a valid address the member routes answer 503.
  const app=appTarget(process.env.NOCHEH_APP_URL);
  const server=miniAppServer({check:{botId,ownerId,key:launchKey(process.env,botId)},
    dashboard:new DashboardClient({host:process.env.NOCHEH_DASHBOARD_HOST??'nocheh-dashboard',port:dashboardPort}),...(app?{app:new AppClient(app)}:{}),
    assets:join(process.cwd(),'dashboard/dist')});
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'mini_app_ready',port})));
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
}
