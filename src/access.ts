import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, object, string } from './http.js';

export interface Reader {readonly scope:string|null; readonly admin:boolean;readonly turnEvent?:string}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export function scopeToken(secret:string,scope:string|null,expires:number):string {
  const body=Buffer.from(JSON.stringify({scope,expires,audience:'nocheh-archive'})).toString('base64url');
  return `scope.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function turnToken(secret:string,scope:string|null,expires:number,eventId:string):string {
  const body=Buffer.from(JSON.stringify({scope,expires,event_id:eventId,audience:'nocheh-assistant'})).toString('base64url');
  return `turn.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function reader(req:IncomingMessage,secret:string,now=Date.now()):Reader {
  if (!req.headers.authorization?.startsWith('Bearer ')) throw new HttpError(401,'unauthorized');
  const bearer=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
  if (equal(bearer,secret)) return {scope:null,admin:true};
  try {
    const [prefix,body,signature,extra]=bearer.split('.');
    if (!['scope','turn'].includes(prefix ?? '') || !body || !signature || extra || body.length>2048 || !equal(signature,createHmac('sha256',secret).update(body).digest('base64url'))) throw Error();
    const claims=object(JSON.parse(Buffer.from(body,'base64url').toString()));
    if (claims.audience!==(prefix==='turn'?'nocheh-assistant':'nocheh-archive') || typeof claims.expires!=='number' || claims.expires<=now || claims.expires>now+3600000) throw Error();
    const scope=claims.scope===null ? null : string(claims.scope,256);
    if (scope==='') throw Error();
    if(prefix==='turn' && (typeof claims.event_id!=='string' || !/^[a-f0-9]{64}$/.test(claims.event_id)))throw Error();
    return {scope,admin:false,...(prefix==='turn'?{turnEvent:claims.event_id as string}:{})};
  } catch { throw new HttpError(401,'invalid_scope_token'); }
}
export function admin(principal:Reader):void { if (!principal.admin) throw new HttpError(403,'owner_required'); }
