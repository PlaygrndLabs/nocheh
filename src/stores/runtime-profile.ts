import type {Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import type {GuardBinding} from './guards.js';

export const defaultLogicalProfile=(principal:Reader)=>'nocheh-'+digest(principal.space!).slice(0,24);
/** The default owner/group profile shares its native notes across transports;
 * named profiles remain distinct within the same conversation and generation. */
export const namedProfile=(principal:Reader)=>principal.logical_profile&&principal.logical_profile!==defaultLogicalProfile(principal)?principal.logical_profile:undefined;
/** The Hermes profile a turn runs in. Scopes.apply_revision (services/hermes/scopes.py) derives the same name from the same
 * claims. A private answer's record is part of it, so each answer is its own conversation and never sees another
 * answer's groups (ADR-0249). */
export function runtimeProfile(principal:Reader,binding:GuardBinding) {
  return 'nocheh-'+digest(canonical([binding.generation,principal.space,principal.scope===null?'owner':'scoped',
    binding.epoch,principal.purpose==='filter'?'filter':'assistant',...(namedProfile(principal)?[namedProfile(principal)]:[]),
    ...(principal.answer!==undefined?['answer:'+principal.answer]:[])])).slice(0,24);
}
