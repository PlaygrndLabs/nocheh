import {turnToken,type Reader} from '../access.js';
import {HttpError} from '../http.js';
import {GuardRepository,type GuardBinding} from './guards.js';

/** Preserved signing credentials cannot revive capabilities after a content reset. */
export class AudienceRepository {
  constructor(readonly guards:GuardRepository){}
  async assert(principal:Reader):Promise<GuardBinding> {
    const binding=await this.guards.state();
    if(!principal.admin&&(principal.generation!==binding.generation||principal.guard_epoch!==binding.epoch))
      throw new HttpError(409,'audience_context_changed');
    return binding;
  }
  async turn(secret:string,principal:Pick<Reader,'scope'|'space'|'purpose'|'logical_profile'>,eventId:string,expires:number):Promise<string> {
    if(!principal.space)throw new HttpError(400,'conversation_required');
    const binding=await this.guards.state();
    return turnToken(secret,principal.scope,expires,eventId,{space:principal.space,revision:binding.epoch,
      guard_epoch:binding.epoch,generation:binding.generation,...(principal.purpose?{purpose:principal.purpose}:{}),...(principal.logical_profile?{logical_profile:principal.logical_profile}:{})});
  }
}
