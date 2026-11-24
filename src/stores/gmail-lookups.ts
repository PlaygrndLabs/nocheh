import type pg from 'pg';
import type {Reader} from '../access.js';
import {HttpError} from '../http.js';
import {scheduleRunning} from './scheduled-lookups.js';
import {parentSpace} from '../spaces.js';
import type {OwnerIds} from '../assistant-policy.js';

/**
 * The owner's own Gmail (ADR-0272): a few fixed reads, looked up only in the owner's private chat, in a live turn or a
 * schedule's running run there such as a morning brief (ADR-0266). Never in a background job, a group, or a member's or
 * stranger's private chat (403 `gmail_not_here`).
 */
export function assertGmailHere(principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean}) {
  if(principal.admin||turn.job&&!turn.scheduled||(principal.purpose??'assistant')!=='assistant'||principal.scope!==null||!turn.owner)
    throw new HttpError(403,'gmail_not_here');
}

/** Why a lookup may run without a card: every lookup reads, so one asked in the owner's private chat, in a live turn or a
 *  schedule's run, runs. */
export function gmailAuthority(principal:Reader,turn:{owner?:boolean;job?:string|null;scheduled?:boolean},live:boolean):string|null {
  assertGmailHere(principal,turn);
  return live?'gmail_read:own':null;
}

/** Why a saved lookup may not run, checked again right before it runs: from a background job or a schedule's run that has
 *  ended, or not from the owner's private chat. */
export async function gmailRunRefusal(db:Pick<pg.PoolClient,'query'>,row:any,ownerIds:OwnerIds|string|null):Promise<string|null> {
  if(row.job_id&&!await scheduleRunning(db,row.job_id))return 'gmail_not_here';
  // The owner's own mail is only ever for the owner's key (ADR-0301).
  if(row.person&&row.person!=='owner')return 'gmail_not_here';
  const {chat:owner}=typeof ownerIds==='string'||!ownerIds?{chat:ownerIds}:ownerIds;
  return !!owner&&row.scope===owner&&(parentSpace(row.space_id)??row.space_id)===owner?null:'gmail_not_here';
}
