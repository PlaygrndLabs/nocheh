import {createHash,timingSafeEqual} from 'node:crypto';
import type {Reader} from '../access.js';
import {HttpError} from '../http.js';
import {BOX_PAGE_RECORDS,pageDate} from '../conversation-page.js';
import type {TurnBinding} from '../security/broker.js';
import type {SourceAccessRepository} from './access.js';
import {boxExpires,boxJob,boxOpen} from './background-jobs.js';
import {validFromEpoch} from './guards.js';
import type {SourceRepository} from './retrieval.js';

/** What the launcher needs for a run's sealed box: the job's chat and period from its row, the guard binding
 *  a filled copy stays good for, and when the box must be gone. */
export interface BoxBinding {job:string;chat:string;from:string|null;to:string|null;generation:string;mode:'on';valid_from_epoch:number;expires:string}

/** Whether the box token is set; without it no run gets a box and nothing reads a box copy. */
export const boxTokenSet=(token=process.env.NOCHEH_BOX_TOKEN):token is string=>!!token&&token.length>=32;
/** Whether `given` is the box token that only the broker and the launcher hold. An unset or short token refuses everything. */
export function boxTokenValid(given:unknown,token=process.env.NOCHEH_BOX_TOKEN):boolean {
  if(!boxTokenSet(token)||typeof given!=='string')return false;
  const hash=(value:string)=>createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(given),hash(token));
}

/**
 * The sealed box of a job the owner asked for and approved in their private chat: Hermes's own terminal,
 * file and code tools run there, with a read-only copy of the job's chat that passed the secret check.
 * Nocheh decides which runs get a box and what the copy holds; the launcher only follows the binding.
 */
export class JobBoxRepository {
  constructor(readonly access:SourceAccessRepository){}
  private get control(){return this.access.stores.control;}
  /** A turn's box: only a run of a box job that `ownerApprovedJob` lets through, before the box's time
   *  is up, while the box switch and the guard are on (`boxJob`). */
  async binding(turn:Pick<TurnBinding,'owner'|'job'|'logical_profile'|'reference'>):Promise<BoxBinding|null> {
    if(!turn.job||turn.reference?.store!=='control')return null;
    const guard=await this.access.guards.state(),job=await boxJob(this.control,this.access.policy().owner_id,turn.reference,turn,guard);
    if(!job)return null;
    const from=pageDate(job.estimate.from??''),to=pageDate(job.estimate.to??'',true);
    return {job:job.id,chat:job.target,from:from?.toISOString()??null,to:to?.toISOString()??null,generation:guard.generation,mode:'on',
      valid_from_epoch:await validFromEpoch(this.control,guard),expires:boxExpires(job)};
  }
  /** The boxes that may exist now; the launcher removes every other one. */
  async live() {
    const guard=await this.access.guards.state(),owner=this.access.policy().owner_id;
    if(guard.mode!=='on'||!owner)return {boxes:[]};
    const jobs=(await this.control.query(`SELECT j.id,j.started_at,j.minutes_limit FROM background_jobs j JOIN background_settings s ON s.singleton AND s.box_tools
      WHERE j.box AND j.state='running' AND NOT j.cancel_requested AND j.scope=$1 AND j.requester IS NULL AND j.decided_by=$1 AND ${boxOpen} ORDER BY j.id`,[owner])).rows;
    const from=jobs.length?await validFromEpoch(this.control,guard):guard.epoch;
    return {boxes:jobs.map(job=>({job:job.id,generation:guard.generation,mode:guard.mode,valid_from_epoch:from,expires:boxExpires(job)}))};
  }
  /** One page of the box's copy: the job's own chat and period only, oldest first, whole up to 600,000 characters a record,
   *  without reaction updates; messages still being checked are left out and counted. The broker checks the box token first. */
  async chat(principal:Reader,turn:TurnBinding,sources:SourceRepository,cursor:string) {
    if(principal.admin)throw new HttpError(403,'job_box_not_allowed');
    const box=await this.binding(turn);if(!box)throw new HttpError(403,'job_box_not_allowed');
    const page=await sources.page(principal,{chat:box.chat,from:box.from??'',to:box.to??'',after:cursor,count:BOX_PAGE_RECORDS,whole:true});
    return {records:page.items,next:page.next,checking:page.checking??0,complete:page.complete};
  }
}
