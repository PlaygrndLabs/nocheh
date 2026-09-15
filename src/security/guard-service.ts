import type pg from 'pg';
import type {Settings} from '../config.js';
import type {Reader} from '../access.js';
import {assertAudience} from '../access.js';
import {object,HttpError} from '../http.js';
import {guardPayload,inspectRequest} from '../guard.js';
import {guardState} from '../guarded.js';
import {prepareContext} from '../prepared-context.js';
import type {RuntimeCall} from '../runtime.js';

export function guardService(pool:pg.Pool,config:Settings,call:RuntimeCall) {
  return async(principal:Reader,input:unknown)=>{
    const body=object(input);
    let destination:URL;
    try{destination=new URL(String(body.destination));}catch{throw new HttpError(400,'invalid_destination');}
    if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw new HttpError(400,'invalid_destination');
    await assertAudience(pool,principal);
    // Detection uses the trusted runtime operation, never this broker's model route.
    const detect=async(text:string)=>(await call('guard.detect',{text})).literals;
    if(principal.admin)return guardPayload(body.payload,{mode:config.guardMode,trusted:config.guardTrusted,detectorVersion:config.detectorVersion},destination.href,detect,pool);
    if((await guardState(pool)).mode==='on')inspectRequest(body.payload);
    const payload=await prepareContext(pool,principal,body.payload,detect);
    await assertAudience(pool,principal);
    return {guarded:true,payload};
  };
}
