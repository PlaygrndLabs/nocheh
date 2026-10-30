import {createHash,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {HttpError} from './http.js';

/** Hash settings for the owner password; kept with each hash so they can grow later. */
const COST={N:32768,r:8,p:1,length:32};
const DAY=24*60*60*1000;
/** A browser or phone stays signed in until it goes this long without being used. */
export const SESSION_IDLE=30*DAY;
/** Wrong passwords allowed before a pause, and the first pause; each further miss doubles it, up to a day. */
export const FREE_TRIES=5,FIRST_PAUSE=15*60*1000;
const MAX_SESSIONS=10;

/** Where a session signed in: the dashboard in a browser, or the mini app on a phone. */
export type SessionKind='browser'|'phone';
type Hash={salt:string;hash:string;N:number;r:number;p:number;changed_at:number};
type Session={id:string;kind:SessionKind;created_at:number;last_seen_at:number};
type State={password:Hash|null;sessions:Session[];failures:{count:number;paused_until:number}};
export type LockStatus={password_set:boolean;changed_at:number|null;paused_until:number|null;
  sessions:{kind:SessionKind;created_at:number;last_seen_at:number;current:boolean}[]};
export type SessionState='signed_in'|'signed_out'|'no_password';

const derive=(password:string,salt:Buffer,cost:{N:number;r:number;p:number})=>new Promise<Buffer>((resolve,reject)=>
  scrypt(password.normalize('NFC'),salt,COST.length,{...cost,maxmem:128*cost.N*cost.r*2},(error,key)=>error?reject(error):resolve(key)));
export const tokenId=(token:string)=>createHash('sha256').update(token).digest('hex');
const validToken=(token:unknown):token is string=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token);

/** Checks a new password: not empty, short enough to hash quickly. */
export function passwordProblem(password:unknown):string|null {
  if(typeof password!=='string')return 'invalid_password';
  if(!password)return 'password_empty';
  if(password.length>200)return 'password_too_long';
  return null;
}

/**
 * The owner's one Nocheh password and the browsers and phones signed in with
 * it. The dashboard keeps it in its own state; the mini app service holds no
 * copy. Only a hash of the password and of each session token is stored, so
 * sign-ins survive restarts. A new password signs every other session out.
 */
export class OwnerLock {
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
      const state=await this.read(),now=this.now();
      state.sessions=state.sessions.filter(session=>now-session.last_seen_at<SESSION_IDLE);
      return work(state);
    });
    this.queue=next.catch(()=>{});
    return next;
  }
  private change<T>(work:(state:State)=>Promise<T>):Promise<T> {
    return this.serial(async state=>{const result=await work(state);await this.write(state);return result;});
  }
  private open(state:State,kind:SessionKind):string {
    const token=randomBytes(32).toString('base64url'),now=this.now();
    const others=state.sessions.filter(session=>session.kind!==kind);
    const same=state.sessions.filter(session=>session.kind===kind).sort((a,b)=>b.last_seen_at-a.last_seen_at).slice(0,MAX_SESSIONS-1);
    state.sessions=[...others,...same,{id:tokenId(token),kind,created_at:now,last_seen_at:now}];
    return token;
  }
  /**
   * Compares a password with the hash. After FREE_TRIES wrong ones in a row,
   * every try pauses, the right one too, so guessing gains nothing from it.
   */
  private async verify(state:State,password:unknown) {
    const now=this.now();
    if(!state.password)throw new HttpError(409,'owner_password_not_set');
    if(state.failures.paused_until>now)throw Object.assign(new HttpError(429,'sign_in_paused'),{until:state.failures.paused_until});
    const given=typeof password==='string'&&password.length<=200?password:'';
    const stored=Buffer.from(state.password.hash,'base64');
    const actual=await derive(given,Buffer.from(state.password.salt,'base64'),state.password);
    if(given&&actual.length===stored.length&&timingSafeEqual(actual,stored)){state.failures={count:0,paused_until:0};return;}
    const count=state.failures.count+1;
    const pause=count>=FREE_TRIES?Math.min(DAY,FIRST_PAUSE*2**(count-FREE_TRIES)):0;
    state.failures={count,paused_until:pause?now+pause:0};
    // The refusal is written before it is returned.
    await this.write(state);
    throw Object.assign(new HttpError(pause?429:401,pause?'sign_in_paused':'wrong_password'),
      pause?{until:now+pause}:{tries_left:FREE_TRIES-count});
  }
  private async hash(password:string,state:State) {
    const salt=randomBytes(16),hash=await derive(password,salt,COST);
    state.password={salt:salt.toString('base64'),hash:hash.toString('base64'),N:COST.N,r:COST.r,p:COST.p,changed_at:this.now()};
  }

  /** The password's state and every signed-in session; `token` marks the asking browser's own. */
  async status(token?:string):Promise<LockStatus> {
    const own=validToken(token)?tokenId(token):'';
    return this.serial(async state=>({password_set:!!state.password,changed_at:state.password?.changed_at??null,
      paused_until:state.failures.paused_until>this.now()?state.failures.paused_until:null,
      sessions:state.sessions.map(({id,kind,created_at,last_seen_at})=>({kind,created_at,last_seen_at,current:id===own}))
        .sort((a,b)=>b.last_seen_at-a.last_seen_at)}));
  }

  /** Creates the first password, from the first dashboard visit, and signs that browser in. */
  async create(password:unknown):Promise<{token:string}> {
    const problem=passwordProblem(password);if(problem)throw new HttpError(400,problem);
    return this.change(async state=>{
      if(state.password)throw new HttpError(409,'owner_password_already_set');
      await this.hash(password as string,state);
      state.sessions=[];state.failures={count:0,paused_until:0};
      return {token:this.open(state,'browser')};
    });
  }

  /** Changes the password after checking the current one; every session ends and this browser signs in again. */
  async changePassword(current:unknown,next:unknown):Promise<{token:string}> {
    const problem=passwordProblem(next);if(problem)throw new HttpError(400,problem);
    return this.change(async state=>{
      await this.verify(state,current);
      await this.hash(next as string,state);
      state.sessions=[];
      return {token:this.open(state,'browser')};
    });
  }

  /** Trades the password for a session token. */
  async signIn(password:unknown,kind:SessionKind):Promise<{token:string}> {
    return this.change(async state=>{await this.verify(state,password);return {token:this.open(state,kind)};});
  }

  /** Whether a token is a live session of its kind; using a session keeps it signed in for another SESSION_IDLE. */
  async check(token:unknown,kind:SessionKind):Promise<SessionState> {
    const id=validToken(token)?tokenId(token):'';
    return this.serial(async state=>{
      if(!state.password)return 'no_password';
      const session=id?state.sessions.find(item=>item.id===id&&item.kind===kind):undefined;
      if(!session)return 'signed_out';
      // Record use at most hourly, so checks rarely write.
      if(this.now()-session.last_seen_at>60*60*1000){session.last_seen_at=this.now();await this.write(state);}
      return 'signed_in';
    });
  }

  async signOut(token:unknown):Promise<void> {
    if(!validToken(token))return;
    const id=tokenId(token);
    await this.change(async state=>{state.sessions=state.sessions.filter(session=>session.id!==id);});
  }

  /** Signs out every browser and phone except the one holding `keep`. */
  async signOutOthers(keep:unknown):Promise<void> {
    const id=validToken(keep)?tokenId(keep):'';
    await this.change(async state=>{state.sessions=state.sessions.filter(session=>session.id===id);});
  }
}
