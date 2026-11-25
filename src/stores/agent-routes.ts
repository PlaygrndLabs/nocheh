import type {IncomingMessage,ServerResponse} from 'node:http';
import {isAgentLogin,type AgentLogin,type Reader} from '../access.js';
import {servedChats} from '../chats.js';
import type {Settings} from '../config.js';
import {HttpError,json,object,readJson} from '../http.js';
import {memberAssistant,memberPrivate} from '../spaces.js';
import {currentChats} from './chats.js';
import {notesCarry} from './notes-epochs.js';
import {assertGuardConfiguration} from './lifecycle.js';
import type {StorageServices} from './services.js';

/**
 * Every route the agent login reaches on nocheh-app (ADR-0295): exactly what Hermes calls, by method and path, with no
 * query. Anything else is refused, so a leaked agent login opens no owner, data or tool route. Saving a runtime profile
 * (POST /v1/runtime/profiles) is left out while Hermes's own Profiles page only reads; adding its row back here and
 * removing native_admin's profiles_read_only check is the whole change if that decision is reversed.
 */
export const agentRoutes:readonly (readonly [method:string,path:string])[]=[
  ['GET','/internal/chats'],['POST','/internal/notes/sources'],['POST','/internal/sources/retired'],['POST','/internal/notes/carry'],
  ['GET','/v1/runtime/profiles'],['POST','/v1/runtime/profiles/resolve'],
  ...['definition','input','workflow-context','claim','prepare','heartbeat','observe','cancel','finish','recover','runs'].map(operation=>['POST','/v1/scheduler/'+operation] as const),
  ...['workflow-context','claim','prepare','heartbeat','observe','finish'].map(operation=>['POST','/v1/background/'+operation] as const),
];
export function agentRoute(method:string|undefined,url:URL):boolean {
  return !url.search&&agentRoutes.some(([m,p])=>m===method&&p===url.pathname);
}

/** The chats the Python services may act for (ADR-0252): served chats with their topics, the owner's private chat apart
 * from the owner's account, and each member's own private chat open now, marked member_private (and member_assistant
 * when their Personal assistant is on). */
export async function internalChats(s:StorageServices){
  const owner=s.access.policy().owner_id,directory=await currentChats();
  return servedChats(directory,owner?{app:'telegram',external:owner}:null,id=>memberPrivate(id,directory),id=>memberAssistant(id,directory));
}
/** Hermes withholds retired turns from its own native history before each turn. */
export async function retiredSources(s:StorageServices,req:IncomingMessage){
  const ids=object(await readJson(req,64*1024)).event_ids;
  if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(400,'invalid_event_ids');
  return s.retirements.historyRetirements(ids as string[]);
}
/** Whether a chat's new profile may take the notes of its earlier one (ADR-0292): whether every epoch since let notes
 *  through for this chat. It names no chat, only whether it is the owner's. */
export async function notesCarryAnswer(s:StorageServices,req:IncomingMessage){
  const body=object(await readJson(req,1024));
  if(Object.keys(body).some(key=>!['generation','from','to','owner'].includes(key))||typeof body.generation!=='string'||typeof body.owner!=='boolean'||
    !Number.isSafeInteger(body.from)||!Number.isSafeInteger(body.to))throw new HttpError(400,'invalid_notes_carry');
  return {carry:await notesCarry(s.stores.control,body.generation,Number(body.from),Number(body.to),body.owner)};
}
/** Where Hermes's notes came from, before each turn and review (ADR-0257). */
export async function noteSources(s:StorageServices,req:IncomingMessage){return s.noteSources.lookup(await readJson(req,256*1024));}
/** The runtime profiles: list and resolve for the agent and the owner; save for the owner's admin bearer only. */
export async function runtimeProfiles(s:StorageServices,config:Settings,caller:Reader|AgentLogin,req:IncomingMessage,path:string){
  await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
  if(req.method==='GET'&&path==='/v1/runtime/profiles')return s.runtimeProfiles.list(caller);
  if(req.method==='POST'&&path==='/v1/runtime/profiles/resolve')return s.runtimeProfiles.resolve(caller,await readJson(req));
  if(req.method==='POST'&&path==='/v1/runtime/profiles'&&!isAgentLogin(caller))return s.runtimeProfiles.save(caller,await readJson(req));
  return undefined;
}
/** A scheduled run's step, as Hermes's scheduler posts it. Ownership, delivery and a new schedule's message are Nocheh's
 * own (ADR-0290), so they answer 404. */
export async function schedulerOperation(s:StorageServices,config:Settings,caller:Reader|AgentLogin,operation:string,body:Record<string,unknown>){
  if(operation==='finish')return s.scheduled.finish(body);
  await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
  if(operation==='definition')return s.schedules.definition(caller,body);
  if(operation==='input')return s.schedules.capture(caller,body);
  if(operation==='workflow-context')return s.scheduled.context(body);
  if(operation==='claim')return s.scheduled.claim(body);
  if(operation==='prepare')return s.scheduled.prepare(body);
  if(operation==='heartbeat')return s.scheduled.heartbeat(body);
  if(operation==='observe')return s.scheduled.observe(body);
  if(operation==='cancel')return s.scheduled.cancel(body);
  if(operation==='recover')return s.scheduled.recoverExpired();
  if(operation==='runs')return s.scheduled.history(body);
  throw new HttpError(404,'not_found');
}
/** A background run's step, as Hermes's managed runs post it. */
export async function backgroundOperation(s:StorageServices,config:Settings,operation:string,body:Record<string,unknown>){
  const runs=s.jobs.runs;
  if(operation==='finish')return runs.finish(body);
  if(operation==='cancel')return runs.cancel(body);
  if(operation==='observe')return runs.observe(body);
  await assertGuardConfiguration(s.guards,config.guardMode);await s.configuration.assert(config.assistant);
  if(operation==='workflow-context')return runs.context(body);
  if(operation==='claim')return runs.claim(body);
  if(operation==='prepare')return runs.prepare(body);
  if(operation==='heartbeat')return runs.heartbeat(body);
  throw new HttpError(404,'not_found');
}

/** The agent login's requests: only agentRoutes, each answered by the handler the owner's bearer reaches too. */
export async function serveAgent(s:StorageServices,config:Settings,login:AgentLogin,req:IncomingMessage,res:ServerResponse,url:URL){
  if(!agentRoute(req.method,url))throw new HttpError(403,'agent_route_not_allowed');
  const path=url.pathname;
  if(path==='/internal/chats')return json(res,200,await internalChats(s));
  if(path==='/internal/notes/sources')return json(res,200,await noteSources(s,req));
  if(path==='/internal/sources/retired')return json(res,200,await retiredSources(s,req));
  if(path==='/internal/notes/carry')return json(res,200,await notesCarryAnswer(s,req));
  if(path.startsWith('/v1/runtime/profiles'))return json(res,200,await runtimeProfiles(s,config,login,req,path));
  const body=object(await readJson(req,2*1024*1024));
  if(path.startsWith('/v1/scheduler/'))return json(res,200,await schedulerOperation(s,config,login,path.slice('/v1/scheduler/'.length),body));
  return json(res,200,await backgroundOperation(s,config,path.slice('/v1/background/'.length),body));
}
