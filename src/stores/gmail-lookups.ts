import type {Reader} from '../access.js';
import {HttpError} from '../http.js';
import {parentSpace} from '../spaces.js';
import type {OwnerIds} from '../assistant-policy.js';

/**
 * The owner's own Gmail (ADR-0272): a few fixed reads, looked up only in the owner's private chat in a live turn. Never in
 * a job, a group, or a member's or stranger's private chat (403 `gmail_not_here`).
 */
export function assertGmailHere(principal:Reader,turn:{owner?:boolean;job?:string|null}) {
  if(principal.admin||turn.job||(principal.purpose??'assistant')!=='assistant'||principal.scope!==null||!turn.owner)
    throw new HttpError(403,'gmail_not_here');
}

/** Why a lookup may run without a card: every lookup reads, so one asked in the owner's private chat, in a live turn, runs. */
export function gmailAuthority(principal:Reader,turn:{owner?:boolean;job?:string|null},live:boolean):string|null {
  assertGmailHere(principal,turn);
  return live?'gmail_read:own':null;
}

/** Why a saved lookup may not run, checked again right before it runs: from a job, or not from the owner's private chat. */
export function gmailRunRefusal(row:any,ownerIds:OwnerIds|string|null):string|null {
  if(row.job_id)return 'gmail_not_here';
  const {chat:owner}=typeof ownerIds==='string'||!ownerIds?{chat:ownerIds}:ownerIds;
  return !!owner&&row.scope===owner&&(parentSpace(row.space_id)??row.space_id)===owner?null:'gmail_not_here';
}
