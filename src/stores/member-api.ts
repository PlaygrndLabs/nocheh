import type {Reader} from '../access.js';
import {isTelegramAccount} from '../chats-telegram.js';
import {isChatId} from '../chats.js';
import {HttpError,object,string} from '../http.js';
import {DAILY_MESSAGES_MAX,DAILY_MESSAGES_MIN,memberStates,memberTaskModes,type MemberAddRequest,type MemberChangeRequest,type MemberChanges,
  type MemberList,type MemberRemoved,type MemberRemoveRequest,type MemberResult,type MemberSettingsRequest,type MemberSettingsResult} from '../member-wire.js';

/*
 * The owner's Members routes (step 3). The owner API checks each body's shape here; the repository behind
 * services.members does the rest, each change as one owner command with no new guard epoch (OwnerCommands.run
 * {epoch:false}), and moves the member revision so the directory reloads in this process at once.
 */

/**
 * What services.members does. Every method is the owner's only (admin) and every change is idempotent by its
 * operation_id (the same id with another request is 409 owner_command_conflict).
 * - list: GET /v1/members.
 * - add: POST /v1/members. account_id must be a human account Nocheh has seen (404 member_account_not_found), never the
 *   owner's, a bot or a proxy account (400 member_account_invalid), and every group set to true one Nocheh is in where
 *   that person's newest Telegram row says 'in' (409 member_group_not_seen, Rule 1). telegram_id is Add by Telegram
 *   user ID: the account is made with ensureAccount when missing (the same refusals for the owner, a known bot or a
 *   proxy id), and its groups may be any group Nocheh is in. A group that is no group Nocheh is in is 400
 *   member_group_invalid; an account already linked to a member is 409 member_exists.
 * - change: POST /v1/members/:id (404 member_not_found). A group set to false writes or switches a row for any group
 *   Nocheh is in; set to true it switches an existing row, or makes one only where the member's newest Telegram row says
 *   'in' (409 member_group_not_seen).
 * - remove: POST /v1/members/:id/remove (404 member_not_found).
 * - settings: POST /v1/members/settings, the daily message cap.
 */
export interface MemberRepository {
  list(principal:Reader):Promise<MemberList>;
  add(principal:Reader,request:MemberAddRequest):Promise<MemberResult>;
  change(principal:Reader,id:string,request:MemberChangeRequest):Promise<MemberResult>;
  remove(principal:Reader,id:string,request:MemberRemoveRequest):Promise<MemberRemoved>;
  settings(principal:Reader,request:MemberSettingsRequest):Promise<MemberSettingsResult>;
}

const exact=(input:unknown,keys:readonly string[])=>{
  const body=object(input);if(Object.keys(body).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_member_field');return body;
};
const operation=(value:unknown)=>{const id=string(value,200);if(!id.trim())throw new HttpError(400,'operation_id_required');return id;};
const flag=(value:unknown)=>{if(typeof value!=='boolean')throw new HttpError(400,'invalid_member_request');return value;};
/** A group chat id → on (true) or off (false) map; at most 1000 entries. */
function groupSwitches(value:unknown):Record<string,boolean> {
  const body=object(value),entries=Object.entries(body);
  if(entries.length>1000||entries.some(([id,on])=>!isChatId(id)||typeof on!=='boolean'))throw new HttpError(400,'invalid_member_groups');
  return Object.fromEntries(entries) as Record<string,boolean>;
}

/** POST /v1/members: exactly one of account_id or telegram_id, and at least one group switched on. */
export function memberAddRequest(input:unknown):MemberAddRequest {
  const body=exact(input,['operation_id','account_id','telegram_id','groups']);
  const account=body.account_id??null,telegram=body.telegram_id??null;
  if((account===null)===(telegram===null))throw new HttpError(400,'invalid_member_request');
  if(account!==null&&(typeof account!=='string'||!/^[a-f0-9]{64}$/.test(account)))throw new HttpError(400,'invalid_member_request');
  if(telegram!==null&&!isTelegramAccount(telegram))throw new HttpError(400,'invalid_member_request');
  const groups=groupSwitches(body.groups);
  if(!Object.values(groups).includes(true))throw new HttpError(400,'member_group_required');
  return {operation_id:operation(body.operation_id),account_id:account as string|null,telegram_id:telegram as string|null,groups};
}
/** POST /v1/members/:id: at least one change. */
export function memberChangeRequest(input:unknown):MemberChangeRequest {
  const body=exact(input,['operation_id','changes']),raw=object(body.changes),changes:MemberChanges={};
  if(Object.keys(raw).some(key=>!['state','talk','jobs','post','tools','tasks','groups'].includes(key)))throw new HttpError(400,'unknown_member_field');
  if(raw.state!==undefined){if(!(memberStates as readonly unknown[]).includes(raw.state))throw new HttpError(400,'invalid_member_request');changes.state=raw.state as MemberChanges['state'] & string;}
  if(raw.talk!==undefined)changes.talk=flag(raw.talk);
  if(raw.jobs!==undefined)changes.jobs=flag(raw.jobs);
  if(raw.post!==undefined)changes.post=flag(raw.post);
  if(raw.tools!==undefined)changes.tools=flag(raw.tools);
  if(raw.tasks!==undefined){if(!(memberTaskModes as readonly unknown[]).includes(raw.tasks))throw new HttpError(400,'invalid_member_request');changes.tasks=raw.tasks as MemberChanges['tasks'] & string;}
  if(raw.groups!==undefined)changes.groups=groupSwitches(raw.groups);
  if(!Object.keys(changes).length||changes.groups&&!Object.keys(changes.groups).length&&Object.keys(changes).length===1)throw new HttpError(400,'member_change_empty');
  return {operation_id:operation(body.operation_id),changes};
}
/** POST /v1/members/:id/remove. */
export function memberRemoveRequest(input:unknown):MemberRemoveRequest {
  return {operation_id:operation(exact(input,['operation_id']).operation_id)};
}
/** POST /v1/members/settings: the daily message cap, a whole number from 1 to 10000. */
export function memberSettingsRequest(input:unknown):MemberSettingsRequest {
  const body=exact(input,['operation_id','daily_messages']),daily=body.daily_messages;
  if(typeof daily!=='number'||!Number.isSafeInteger(daily)||daily<DAILY_MESSAGES_MIN||daily>DAILY_MESSAGES_MAX)throw new HttpError(400,'invalid_daily_messages');
  return {operation_id:operation(body.operation_id),daily_messages:daily};
}
