import {randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {HttpError} from './http.js';

type Session={id:string;csrf:string;expires:number};
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
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
