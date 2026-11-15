import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, object, string } from './http.js';
import type pg from 'pg';
import {policyRevision,validateSpace,type ReadSet} from './spaces.js';
import {guardState} from './guarded.js';
import {activeBrain} from './brain/brains.js';
import {chatApps,type AppBinding} from './chat-wire.js';
import {chats,chatsAfterMiss} from './chats.js';

export interface Reader {readonly scope:string|null; readonly admin:boolean;readonly turnEvent?:string;readonly space?:string;readonly revision?:number;readonly guard_epoch?:number;readonly generation?:string;readonly logical_profile?:string;readonly purpose?:'assistant'|'memory-review'|'filter';readonly brain?:string;
  /** The "Answer privately" record this turn answers (32 hex, ADR-0249). Signed in a turn pass, and only in one whose
   * scope and space are the asker's private chat; it never makes the pass an owner pass. */
  readonly answer?:string;
  /** The conversations an answer reader may read, resolved on the server from the frozen record for every request.
   * Never taken from a pass: a pass that names one is refused. Absent means the reader's own recall scope. */
  readonly reads?:ReadSet;
  /** The app a turn pass is bound to (ADR-0252): its chat's current app id and topic. Signed only in a turn pass and
   * checked by the front door that receives the turn; storage does not require it, so job passes carry none. */
  readonly app?:AppBinding}
/** The id of an "Answer privately" record: also the button's data after `np` and the private chat's /start parameter. */
export const answerId=/^[a-f0-9]{32}$/;
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export function scopeToken(secret:string,scope:string|null,expires:number,binding?:{generation:string;guard_epoch:number}):string {
  const body=Buffer.from(JSON.stringify({scope,expires,audience:'nocheh-archive',...binding})).toString('base64url');
  return `scope.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
/** The brain a turn's pass is for: the one plugged into the brain socket (ADR-0234). The pass names it so its effects can be told apart (ADR-0233). */
export const defaultBrain=activeBrain;
const brainName=/^[a-z][a-z0-9-]{0,31}$/;
export function turnToken(secret:string,scope:string|null,expires:number,eventId:string,policy?:{space:string;revision:number;guard_epoch?:number;generation?:string;logical_profile?:string;purpose?:'assistant'|'memory-review'|'filter';project?:string;brain?:string;answer?:string;app?:AppBinding}):string {
  const body=Buffer.from(JSON.stringify({scope,expires,event_id:eventId,audience:'nocheh-assistant',brain:defaultBrain,...policy})).toString('base64url');
  return `turn.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
const appText=/^[A-Za-z0-9._:-]{1,128}$/,appTopic=/^[A-Za-z0-9._-]{1,64}$/;
/** A turn pass's app binding, exactly {app, chat, topic}; anything else refuses the pass. */
export function appBinding(value:unknown):AppBinding {
  const claim=object(value);
  if(Object.keys(claim).sort().join()!=='app,chat,topic'||!(chatApps as readonly unknown[]).includes(claim.app)||
    typeof claim.chat!=='string'||!appText.test(claim.chat)||claim.topic!==null&&(typeof claim.topic!=='string'||!appTopic.test(claim.topic)))
    throw new HttpError(400,'invalid_app_binding');
  return {app:claim.app as AppBinding['app'],chat:claim.chat,topic:claim.topic as string|null};
}
/** The owner's private chat itself, never one of its topics, as the chat directory knows it. */
const ownersPrivateChat=(id:string,missed:()=>void)=>{const chat=chats().get(id);if(!chat)missed();return chat?.kind==='private'&&chat.owner;};
export function reader(req:IncomingMessage,secret:string,now=Date.now()):Reader {return verifiedReader(req,secret,now,()=>{});}
/**
 * reader() for a server that can wait: a signed pass naming a chat or topic this process's chat directory does not hold
 * yet (another process recorded it a moment ago: a new forum topic's first message) is read again once the directory has
 * looked again, instead of being refused at once. Still unknown after that, it is refused as before (ADR-0252).
 */
export async function currentReader(req:IncomingMessage,secret:string,now=Date.now()):Promise<Reader> {
  let missed=false;
  try {return verifiedReader(req,secret,now,()=>{missed=true;});}
  catch(error) {if(!missed||!await chatsAfterMiss())throw error;}
  return reader(req,secret,now);
}
function verifiedReader(req:IncomingMessage,secret:string,now:number,missed:()=>void):Reader {
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
      // A scoped pass reads as its chat, in the chat itself or one of its topics, as the chat directory says; never by
      // the shape of an id, and a topic the directory does not know belongs to no chat (ADR-0252, fail closed).
      if(!Number.isSafeInteger(claims.revision)||Number(claims.revision)<1)throw Error();
      if(scope!==null&&space!==scope&&chats().parentOf(space)!==scope){if(!chats().get(space))missed();throw Error();}
      policy={space,revision:claims.revision as number};
    }
    if(claims.guard_epoch!==undefined&&(!Number.isSafeInteger(claims.guard_epoch)||Number(claims.guard_epoch)<1))throw Error();
    if(claims.generation!==undefined&&(typeof claims.generation!=='string'||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(claims.generation)))throw Error();
    if(claims.purpose!==undefined&&!['assistant','memory-review','filter'].includes(String(claims.purpose)))throw Error();
    if(claims.logical_profile!==undefined&&(prefix!=='turn'||!claims.generation||typeof claims.logical_profile!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(claims.logical_profile)))throw Error();
    if(claims.project!==undefined&&(prefix!=='turn'||typeof claims.project!=='string'||!/^[a-f0-9]{64}$/.test(claims.project)))throw Error();
    if(claims.brain!==undefined&&(prefix!=='turn'||typeof claims.brain!=='string'||!brainName.test(claims.brain)))throw Error();
    // An answer pass reads as the asker's private chat, never as the owner: its scope and space are that chat, a private
    // chat row of the owner's (ADR-0249, ADR-0252).
    if(claims.answer!==undefined&&(prefix!=='turn'||typeof claims.answer!=='string'||!answerId.test(claims.answer)||scope===null||
      !ownersPrivateChat(scope,missed)||!('space' in policy)||policy.space!==scope))throw Error();
    // What an answer may read comes from its record on the server, never from the pass.
    if(claims.reads!==undefined)throw Error();
    const app=claims.app===undefined?undefined:appBinding(claims.app);
    if(app!==undefined&&prefix!=='turn')throw Error();
    return {scope,admin:false,...(prefix==='turn'?{turnEvent:claims.event_id as string}:{}),...policy,...(claims.guard_epoch===undefined?{}:{guard_epoch:claims.guard_epoch as number}),...(claims.generation===undefined?{}:{generation:claims.generation as string}),...(claims.logical_profile===undefined?{}:{logical_profile:claims.logical_profile as string}),...(claims.purpose===undefined?{}:{purpose:claims.purpose as NonNullable<Reader['purpose']>}),...(claims.brain===undefined?{}:{brain:claims.brain as string}),...(claims.answer===undefined?{}:{answer:claims.answer as string}),...(app===undefined?{}:{app})};
  } catch { throw new HttpError(401,'invalid_scope_token'); }
}
export function admin(principal:Reader):void { if (!principal.admin) throw new HttpError(403,'owner_required'); }
export async function assertAudience(pool:pg.Pool,principal:Reader) {
  if(!principal.admin){const guard=await guardState(pool);if((guard.mode==='on'||principal.guard_epoch!==undefined)&&principal.guard_epoch!==guard.epoch)throw new HttpError(409,'guard_context_changed');}
  if(principal.scope!==null && principal.space && principal.revision!==await policyRevision(pool))throw new HttpError(409,'space_policy_changed');
}
