import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {HttpError} from './http.js';
import {tokenId,type OwnerLock,type SessionKind,type SessionState} from './owner-lock.js';

type Session={id:string;csrf:string;expires:number};
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
/** Open in-memory sessions for the synthetic dashboard previews, which have no owner password. */
export class DashboardSessions {
  private sessions=new Map<string,Session>();
  private tickets=new Map<string,{session:string;expires:number}>();
  constructor(private now=Date.now) {}
  session(req: Pick<IncomingMessage,'headers'>):Session|undefined {
    const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('nocheh_session='));
    if(cookies.length!==1)return;
    const session=this.sessions.get(cookies[0]!.slice('nocheh_session='.length));
    return session&&session.expires>this.now()?session:undefined;
  }
  page(req:Pick<IncomingMessage,'headers'>):Session {
    const found=this.session(req);if(found)return found;
    for(const [id,s] of this.sessions)if(s.expires<=this.now())this.sessions.delete(id);
    if(this.sessions.size>=256)throw new HttpError(429,'owner_session_limit');
    const session={id:randomBytes(32).toString('base64url'),csrf:randomBytes(32).toString('base64url'),expires:this.now()+12*60*60*1000};
    this.sessions.set(session.id,session);return session;
  }
  authorize(req:Pick<IncomingMessage,'headers'|'method'>,requireCsrf=true):Session {
    const session=this.session(req);
    if(!session)throw new HttpError(401,'owner_session_required');
    const value=String(req.headers['x-nocheh-csrf']??req.headers['x-hermes-session-token']??'');
    if(requireCsrf&&!equal(value,session.csrf))throw new HttpError(403,'csrf_required');
    return session;
  }
  ticket(session:Session):string {
    for(const [id,t] of this.tickets)if(t.expires<=this.now())this.tickets.delete(id);
    if(this.tickets.size>=512)throw new HttpError(429,'websocket_ticket_limit');
    const ticket=randomBytes(32).toString('base64url');
    this.tickets.set(ticket,{session:session.id,expires:this.now()+30000});return ticket;
  }
  consume(req:Pick<IncomingMessage,'headers'>,value:string):void {
    const session=this.session(req),ticket=this.tickets.get(value);
    if(!session||!ticket||ticket.expires<=this.now()||ticket.session!==session.id)throw new HttpError(401,'websocket_ticket_invalid');
    this.tickets.delete(value);
  }
}

/** A signed-in browser: its session token from the cookie, the token's ID, and the CSRF value derived from it. */
export type OwnerSession={id:string;token:string;csrf:string};
export const SESSION_COOKIE_AGE=30*24*60*60;
/** The CSRF value of a session; derived, so nothing more is stored and a restart keeps it. */
export const csrfFor=(token:string)=>createHmac('sha256','nocheh-csrf').update(token).digest('base64url');

/**
 * The dashboard's signed-in browsers and the mini app's phones, checked
 * against the owner's password lock. A session known to be signed in is
 * remembered for a minute; every sign-out or password change goes through
 * `forget`, so it ends at once.
 */
export class OwnerSessions {
  private known=new Map<string,{kind:SessionKind;until:number}>();
  private tickets=new Map<string,{session:string;expires:number}>();
  /** With `open`, every browser and phone counts as signed in: the development stack on the developer's own computer. */
  private openSession:OwnerSession|undefined;
  constructor(readonly lock:OwnerLock,private now=Date.now,readonly open=false) {
    if(open){const token=randomBytes(32).toString('base64url');this.openSession={id:tokenId(token),token,csrf:csrfFor(token)};}
  }
  /** The single `nocheh_session` cookie's token, if any. */
  token(req:Pick<IncomingMessage,'headers'>):string|undefined {
    const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('nocheh_session='));
    return cookies.length===1?cookies[0]!.slice('nocheh_session='.length):undefined;
  }
  async state(token:string|undefined,kind:SessionKind):Promise<SessionState> {
    if(this.open)return 'signed_in';
    if(!token)return (await this.lock.status()).password_set?'signed_out':'no_password';
    const id=tokenId(token),known=this.known.get(id);
    if(known&&known.kind===kind&&known.until>this.now())return 'signed_in';
    const state=await this.lock.check(token,kind);
    if(state==='signed_in'){
      for(const [key,entry] of this.known)if(entry.until<=this.now())this.known.delete(key);
      if(this.known.size<64)this.known.set(id,{kind,until:this.now()+60000});
    }
    return state;
  }
  async session(req:Pick<IncomingMessage,'headers'>):Promise<OwnerSession|undefined> {
    if(this.openSession)return this.openSession;
    const token=this.token(req);
    if(!token||await this.state(token,'browser')!=='signed_in')return;
    return {id:tokenId(token),token,csrf:csrfFor(token)};
  }
  async authorize(req:Pick<IncomingMessage,'headers'|'method'>,requireCsrf=true):Promise<OwnerSession> {
    const session=await this.session(req);
    if(!session)throw new HttpError(401,'owner_session_required');
    const value=String(req.headers['x-nocheh-csrf']??req.headers['x-hermes-session-token']??'');
    if(requireCsrf&&!equal(value,session.csrf))throw new HttpError(403,'csrf_required');
    return session;
  }
  /** Drops remembered answers after a sign-out or a password change. */
  forget() {this.known.clear();this.tickets.clear();}
  ticket(session:OwnerSession):string {
    for(const [id,t] of this.tickets)if(t.expires<=this.now())this.tickets.delete(id);
    if(this.tickets.size>=512)throw new HttpError(429,'websocket_ticket_limit');
    const ticket=randomBytes(32).toString('base64url');
    this.tickets.set(ticket,{session:session.id,expires:this.now()+30000});return ticket;
  }
  async consume(req:Pick<IncomingMessage,'headers'>,value:string):Promise<void> {
    const session=await this.session(req),ticket=this.tickets.get(value);
    if(!session||!ticket||ticket.expires<=this.now()||ticket.session!==session.id)throw new HttpError(401,'websocket_ticket_invalid');
    this.tickets.delete(value);
  }
}
