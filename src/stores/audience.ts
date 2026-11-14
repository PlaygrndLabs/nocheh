import {turnToken,type Reader} from '../access.js';
import {HttpError} from '../http.js';
import {GuardRepository,carriesForward,jobRun,type GuardBinding} from './guards.js';
import {ProjectRepository} from './projects.js';

/** Preserved signing credentials cannot revive capabilities after a content reset. */
export class AudienceRepository {
  constructor(readonly guards:GuardRepository){}
  /** The current binding, for a credential of the current epoch, or of a background job's live run whose own binding still
   *  carries to it (ADR-0208). What the run then reads is checked under the current binding. */
  async assert(principal:Reader):Promise<GuardBinding> {
    const binding=await this.guards.state();
    if(!principal.admin&&(principal.generation!==binding.generation||principal.guard_epoch!==binding.epoch)&&!await this.carried(principal,binding))
      throw new HttpError(409,'audience_context_changed');
    return binding;
  }
  /** Only as its own credential names it: the job's run, waiting or running with a live lease and not stopped, under its own binding. */
  private async carried(principal:Reader,current:GuardBinding):Promise<boolean> {
    if(!jobRun(principal)||!principal.turnEvent)return false;
    const run=(await this.guards.stores.control.query(`SELECT binding FROM managed_runs WHERE event_id=$1 AND channel='background' AND logical_profile=$2
      AND NOT cancel_requested AND (state='captured' OR state='running' AND lease_until>now())`,[principal.turnEvent,principal.logical_profile])).rows[0];
    return !!run&&run.binding.generation===principal.generation&&Number(run.binding.epoch)===principal.guard_epoch&&
      await carriesForward(this.guards.stores.control,run.binding,current);
  }
  /** A turn's credential, for the current binding, or for `own`, a job run's kept binding while it carries (ADR-0208). */
  async turn(secret:string,principal:Pick<Reader,'scope'|'space'|'purpose'|'logical_profile'|'answer'|'reads'>,eventId:string,expires:number,own?:GuardBinding):Promise<string> {
    if(!principal.space)throw new HttpError(400,'conversation_required');
    // A private answer's pass names its record and reads as the asker's private chat, never as the owner (ADR-0249).
    const answer=principal.answer;
    if(answer!==undefined&&(!principal.reads||principal.scope===null||principal.scope!==principal.space))throw new HttpError(409,'private_answer_closed');
    const binding=own?(await this.guards.assertCarried(own),own):await this.guards.state();
    // The chat's active project gives the turn that project's role and skills; a private answer's, the project of its
    // record, while that project is active.
    const control=this.guards.stores.control;
    const project=answer!==undefined?principal.reads!.project===null?null:
      (await control.query<{id:string;state:string}>('SELECT id,state FROM projects WHERE id=$1',[principal.reads!.project])).rows[0]??null:
      (await new ProjectRepository(control).effective(principal.space)).project;
    return turnToken(secret,principal.scope,expires,eventId,{space:principal.space,revision:binding.epoch,
      guard_epoch:binding.epoch,generation:binding.generation,...(principal.purpose?{purpose:principal.purpose}:{}),...(principal.logical_profile?{logical_profile:principal.logical_profile}:{}),
      ...(project?.state==='active'?{project:project.id}:{}),...(answer!==undefined?{answer}:{})});
  }
}
