import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import type {GuardBinding} from './guards.js';

export const defaultLogicalProfile=(principal:Reader)=>'nocheh-'+digest(principal.scope===null?principal.space!:
  principal.space+':policy:'+principal.revision).slice(0,24);
/** The default owner/group profile shares its native notes across transports;
 * named profiles remain distinct within the same conversation and generation. */
export const namedProfile=(principal:Reader)=>principal.logical_profile&&principal.logical_profile!==defaultLogicalProfile(principal)?principal.logical_profile:undefined;
export function runtimeProfile(principal:Reader,binding:GuardBinding) {
  return 'nocheh-'+digest(canonical([binding.generation,principal.space,principal.scope===null?'owner':'scoped',
    binding.epoch,principal.purpose==='filter'?'filter':'assistant',...(namedProfile(principal)?[namedProfile(principal)]:[])])).slice(0,24);
}
