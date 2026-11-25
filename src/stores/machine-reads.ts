import type {Reader} from '../access.js';
import {HttpError} from '../http.js';

/**
 * What a run of a job on the owner's machine may reach in storage (machine jobs' reads): its card's chat through the
 * archive read routes (canRead narrows each to that chat, period and approval cutoff), memory search among those
 * messages, long-term context and recall answered as limited, its own operations and cards, the Notion pages its card
 * names through a proposal, and its machine commands. Nothing else: no owner views, notes, knowledge, tasks, jobs, member
 * asks or schedules, whatever the pass would otherwise allow.
 */
const machineRoutes:readonly [string,RegExp][]=[
  ['GET',/^\/v1\/(search|archive\/page|imports\/pending|events\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64}\/bytes|memory\/check|memory\/context|tools\/actions(?:\/[a-f0-9]{64})?|notion\/connections)$/],
  ['POST',/^\/v1\/(context\/prepare|memory\/longterm\/(recall|context|search)|machines\/exec|tools\/propose|action-requests)$/],
];
/** Whether a machine job's run may call a route. */
export function machineRunRoute(method:string,path:string):boolean {return machineRoutes.some(([verb,route])=>verb===method&&route.test(path));}
/** Refuses a machine job's run anything but its routes (machineRunRoute). */
export function assertMachineRunRoute(principal:Reader,method:string|undefined,path:string):void {
  if(principal.machineReads&&!machineRunRoute(method??'',path))throw new HttpError(403,'machine_job_reads_card_only');
}
/** The data tools a machine job's run is offered (services/hermes/assistant_turn.py MACHINE_DATA_TOOLS, by their names here). */
export const machineRunTools:ReadonlySet<string>=new Set(['archive_search','archive_read','archive_page','memory_search','action_request','notion','action_status']);
