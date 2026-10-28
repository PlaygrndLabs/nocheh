import {createHash,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {HttpError,json,object,readJson} from './http.js';

/** Hash settings for the mini app password; kept with each hash so they can grow later. */
const COST={N:32768,r:8,p:1,length:32};
const DAY=24*60*60*1000;
/** A phone stays signed in until it goes this long without opening the mini app. */
export const SESSION_IDLE=30*DAY;
/** Wrong passwords allowed before a pause, and the first pause; each further miss doubles it, up to a day. */
export const FREE_TRIES=5,FIRST_PAUSE=15*60*1000;
const MAX_SESSIONS=10;

type Hash={salt:string;hash:string;N:number;r:number;p:number;changed_at:number};
type Session={id:string;created_at:number;last_seen_at:number};
type State={password:Hash|null;sessions:Session[];failures:{count:number;paused_until:number}};
export type LockStatus={password_set:boolean;changed_at:number|null;
  sessions:{created_at:number;last_seen_at:number}[];paused_until:number|null};

const derive=(password:string,salt:Buffer,cost:{N:number;r:number;p:number})=>new Promise<Buffer>((resolve,reject)=>
  scrypt(password.normalize('NFC'),salt,COST.length,{...cost,maxmem:128*cost.N*cost.r*2},(error,key)=>error?reject(error):resolve(key)));
const tokenId=(token:string)=>createHash('sha256').update(token).digest('hex');

/** Checks a new password: long enough to resist guessing, short enough to hash quickly. */
export function passwordProblem(password:unknown):string|null {
  if(typeof password!=='string')return 'invalid_password';
  if([...password].length<8)return 'password_too_short';
  if(password.length>200)return 'password_too_long';
  return null;
}

/**
 * The mini app's password and the phones signed in with it. The dashboard keeps
 * it in its own state; the mini app service holds no copy and asks the
 * dashboard on sign-in and to check a session. Only a hash of the password and
 * of each session token is stored. Changing the password signs every phone out.
 */
export class MiniAppLock {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private path:string,private now=Date.now) {}

  private async read():Promise<State> {
    try {
      const value=JSON.parse(await readFile(this.path,'utf8')) as State;
      return {password:value.password??null,sessions:value.sessions??[],failures:value.failures??{count:0,paused_until:0}};
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {password:null,sessions:[],failures:{count:0,paused_until:0}};
      throw error;
    }
  }
  private async write(state:State) {
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    const temporary=this.path+'.'+randomBytes(6).toString('hex')+'.tmp';
    const file=await open(temporary,'wx',0o600);
    try {await file.writeFile(JSON.stringify(state));await file.sync();} finally {await file.close();}
    await rename(temporary,this.path);
  }
  /** One change at a time, so two sign-ins can't both use the last free try. */
  private serial<T>(work:(state:State)=>Promise<T>):Promise<T> {
    const next=this.queue.then(async()=>{
      const state=await this.read(),now=this.now(),before=state.sessions.length;
      state.sessions=state.sessions.filter(session=>now-session.last_seen_at<SESSION_IDLE);
      const result=await work(state);
      return {result,state,expired:before!==state.sessions.length};
    });
    this.queue=next.catch(()=>{});
    return next.then(({result})=>result);
  }
  private change<T>(work:(state:State)=>Promise<T>):Promise<T> {
    return this.serial(async state=>{const result=await work(state);await this.write(state);return result;});
  }

  async status():Promise<LockStatus> {
    return this.serial(async state=>({password_set:!!state.password,changed_at:state.password?.changed_at??null,
      sessions:state.sessions.map(({created_at,last_seen_at})=>({created_at,last_seen_at})).sort((a,b)=>b.last_seen_at-a.last_seen_at),
      paused_until:state.failures.paused_until>this.now()?state.failures.paused_until:null}));
  }

  /** Sets or changes the password; every signed-in phone has to sign in again. */
  async setPassword(password:unknown):Promise<LockStatus> {
    const problem=passwordProblem(password);if(problem)throw new HttpError(400,problem);
    const salt=randomBytes(16),hash=await derive(password as string,salt,COST);
    await this.change(async state=>{
      state.password={salt:salt.toString('base64'),hash:hash.toString('base64'),N:COST.N,r:COST.r,p:COST.p,changed_at:this.now()};
      state.sessions=[];state.failures={count:0,paused_until:0};
    });
    return this.status();
  }

  async signOutAll():Promise<LockStatus> {
    await this.change(async state=>{state.sessions=[];});
    return this.status();
  }

  /**
   * Trades the password for a session token. After FREE_TRIES wrong passwords
   * in a row, sign-in pauses; a right password during a pause is refused too,
   * so guessing gains nothing from it.
   */
  async signIn(password:unknown):Promise<{token:string}> {
    return this.change(async state=>{
      const now=this.now();
      if(!state.password)throw new HttpError(409,'mini_app_password_not_set');
      if(state.failures.paused_until>now)throw Object.assign(new HttpError(429,'mini_app_sign_in_paused'),{until:state.failures.paused_until});
      const given=typeof password==='string'&&password.length<=200?password:'';
      const stored=Buffer.from(state.password.hash,'base64');
      const actual=await derive(given,Buffer.from(state.password.salt,'base64'),state.password);
      if(!given||actual.length!==stored.length||!timingSafeEqual(actual,stored)) {
        const count=state.failures.count+1;
        const pause=count>=FREE_TRIES?Math.min(DAY,FIRST_PAUSE*2**(count-FREE_TRIES)):0;
        state.failures={count,paused_until:pause?now+pause:0};
        // The refusal is written before it is returned.
        await this.write(state);
        throw Object.assign(new HttpError(pause?429:401,pause?'mini_app_sign_in_paused':'wrong_password'),
          pause?{until:now+pause}:{tries_left:FREE_TRIES-count});
      }
      const token=randomBytes(32).toString('base64url');
      state.failures={count:0,paused_until:0};
      state.sessions=[...state.sessions.sort((a,b)=>b.last_seen_at-a.last_seen_at).slice(0,MAX_SESSIONS-1),
        {id:tokenId(token),created_at:now,last_seen_at:now}];
      return {token};
    });
  }

  /** Whether a token is a live session; a used session stays signed in for another SESSION_IDLE. */
  async check(token:unknown):Promise<'signed_in'|'signed_out'|'no_password'> {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))
      return this.serial(async state=>state.password?'signed_out':'no_password');
    const id=tokenId(token);
    return this.serial(async state=>{
      if(!state.password)return 'no_password';
      const session=state.sessions.find(item=>item.id===id);
      if(!session)return 'signed_out';
      // Record use at most hourly, so checks rarely write.
      if(this.now()-session.last_seen_at>60*60*1000){session.last_seen_at=this.now();await this.write(state);}
      return 'signed_in';
    });
  }

  async signOut(token:unknown):Promise<void> {
    if(typeof token!=='string')return;
    const id=tokenId(token);
    await this.change(async state=>{state.sessions=state.sessions.filter(session=>session.id!==id);});
  }
}

/** The dashboard's mini app lock routes, under `/mini-app/lock`. Never on the mini app's own route list. */
export async function miniAppLockRoute(lock:MiniAppLock,req:IncomingMessage,res:ServerResponse,route:string):Promise<void> {
  const action=route.slice('/mini-app/lock'.length);
  if(req.method==='GET'&&action==='')return json(res,200,await lock.status());
  if(req.method!=='POST')throw new HttpError(404,'not_found');
  const body=()=>readJson(req,4096).then(object);
  if(action==='/password')return json(res,200,await lock.setPassword((await body()).password));
  if(action==='/sign-out-all')return json(res,200,await lock.signOutAll());
  if(action==='/check')return json(res,200,{state:await lock.check((await body()).token)});
  if(action==='/sign-out'){await lock.signOut((await body()).token);return json(res,200,{ok:true});}
  if(action==='/sign-in') {
    const {password}=await body();
    try {return json(res,200,await lock.signIn(password));}
    catch(error) {
      if(!(error instanceof HttpError))throw error;
      const {until,tries_left}=error as HttpError&{until?:number;tries_left?:number};
      return json(res,error.status,{error:error.code,...(until?{until}:{}),...(tries_left!==undefined?{tries_left}:{})});
    }
  }
  throw new HttpError(404,'not_found');
}
