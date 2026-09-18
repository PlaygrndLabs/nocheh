import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, object, string } from './http.js';
import type pg from 'pg';
import {policyRevision,validateSpace,parentSpace} from './spaces.js';
import {guardState} from './guarded.js';

export interface Reader {readonly scope:string|null; readonly admin:boolean;readonly turnEvent?:string;readonly space?:string;readonly revision?:number;readonly guard_epoch?:number;readonly generation?:string;readonly logical_profile?:string;readonly purpose?:'assistant'|'memory-review'|'filter'}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export function scopeToken(secret:string,scope:string|null,expires:number,binding?:{generation:string;guard_epoch:number}):string {
  const body=Buffer.from(JSON.stringify({scope,expires,audience:'nocheh-archive',...binding})).toString('base64url');
  return `scope.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function turnToken(secret:string,scope:string|null,expires:number,eventId:string,policy?:{space:string;revision:number;guard_epoch?:number;generation?:string;logical_profile?:string;purpose?:'assistant'|'memory-review'|'filter'}):string {
  const body=Buffer.from(JSON.stringify({scope,expires,event_id:eventId,audience:'nocheh-assistant',...policy})).toString('base64url');
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
    let policy:{}|{space:string;revision:number}={};
    if(claims.space!==undefined || claims.revision!==undefined){
      const space=validateSpace(claims.space);
      if(!Number.isSafeInteger(claims.revision)||Number(claims.revision)<1||(scope!==null&&(parentSpace(space)??space)!==scope))throw Error();
      policy={space,revision:claims.revision as number};
    }
    if(claims.guard_epoch!==undefined&&(!Number.isSafeInteger(claims.guard_epoch)||Number(claims.guard_epoch)<1))throw Error();
    if(claims.generation!==undefined&&(typeof claims.generation!=='string'||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(claims.generation)))throw Error();
    if(claims.purpose!==undefined&&!['assistant','memory-review','filter'].includes(String(claims.purpose)))throw Error();
    if(claims.logical_profile!==undefined&&(prefix!=='turn'||!claims.generation||typeof claims.logical_profile!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(claims.logical_profile)))throw Error();
    return {scope,admin:false,...(prefix==='turn'?{turnEvent:claims.event_id as string}:{}),...policy,...(claims.guard_epoch===undefined?{}:{guard_epoch:claims.guard_epoch as number}),...(claims.generation===undefined?{}:{generation:claims.generation as string}),...(claims.logical_profile===undefined?{}:{logical_profile:claims.logical_profile as string}),...(claims.purpose===undefined?{}:{purpose:claims.purpose as NonNullable<Reader['purpose']>})};
  } catch { throw new HttpError(401,'invalid_scope_token'); }
}
export function admin(principal:Reader):void { if (!principal.admin) throw new HttpError(403,'owner_required'); }
export async function assertAudience(pool:pg.Pool,principal:Reader) {
  if(!principal.admin){const guard=await guardState(pool);if((guard.mode==='on'||principal.guard_epoch!==undefined)&&principal.guard_epoch!==guard.epoch)throw new HttpError(409,'guard_context_changed');}
  if(principal.scope!==null && principal.space && principal.revision!==await policyRevision(pool))throw new HttpError(409,'space_policy_changed');
}
