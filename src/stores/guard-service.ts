import {isAgentLogin,type AgentLogin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {object,HttpError} from '../http.js';
import {inspectRequest} from '../guard.js';
import {PreparedContextRepository} from './prepared-context.js';
import type {StorageServices} from './services.js';

/** Shared by the isolated broker and production composition; no legacy database client. */
export function storageGuardService(services:StorageServices) {
  const internal=new PreparedContextRepository(services.derived,services.guards,async principal=>{
    const row=(await services.stores.control.query("SELECT * FROM content_operations WHERE id=$1 AND kind='service_guard' AND scope='system'",[principal.turnEvent])).rows[0];
    if(!row)throw new HttpError(403,'guard_operation_required');
    const reference={store:'control' as const,kind:'operation' as const,id:row.id,generation:row.generation,input_hash:row.input_hash};
    await services.operations.verify(reference);return reference;
  },services.detectorVersion);
  // The system guard serves the agent's own model calls without a pass (its login, ADR-0291) and storage's own in-process
  // calls (the admin form); anyone else is a turn and keeps its pass's checks.
  return async(principal:Reader|AgentLogin,input:unknown)=>{
    const body=object(input);let destination:URL;
    try{destination=new URL(String(body.destination));}catch{throw new HttpError(400,'invalid_destination');}
    if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw new HttpError(400,'invalid_destination');
    const binding=isAgentLogin(principal)?await services.guards.state():await services.prepared.audience.assert(principal);
    if(binding.mode==='on')inspectRequest(body.payload);
    if(isAgentLogin(principal)||principal.admin) {
      const hash=digest(canonical({destination:destination.href,payload:body.payload,binding}));
      const operation=await services.operations.record({key:'service-guard:'+hash,kind:'service_guard',scope:'system',input_hash:hash});
      const actor:Reader={admin:false,scope:'system',space:'system',turnEvent:operation.id,generation:binding.generation,guard_epoch:binding.epoch};
      const payload=await internal.prepare(actor,body.payload,services.detect,{request:true});
      await services.guards.assertCurrent(binding);return {guarded:binding.mode==='on',payload};
    }
    await services.turns.binding(principal);
    const payload=await services.prepared.prepare(principal,body.payload,services.detect,{request:true});
    await services.turns.assertAudience(principal);return {guarded:true,payload};
  };
}
