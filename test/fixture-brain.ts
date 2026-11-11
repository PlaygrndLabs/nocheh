import type {Brain,TurnEvents,TurnReceipt,TurnRef} from '../src/brain/brain.js';
import type {StorePools} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

/** A test fake answering by operation name: the helper services' names, and for the brain the names below. */
export type FakeCall=(operation:string,input:Record<string,unknown>,timeout?:number)=>Promise<Record<string,unknown>>;
const identity=(ref:TurnRef)=>({channel:ref.channel,event_id:ref.event_id,attempt:ref.attempt});

/**
 * A brain for tests that hands each operation to a fake by name, with the body Hermes's run routes receive:
 * `run.start`, `run.resume` (observe only), `run.cancel`, `run.events`, `status`, `config.read`, `config.write`,
 * `persona.read`, `persona.write`, `prompts.defaults`, `profiles.list`, `memory.read`, `memory.recall`,
 * `memory.review` and `schedule.advance`.
 */
export function fixtureBrain(call:FakeCall,id='hermes'):Brain {
  const as=(operation:string)=>(input:Readonly<Record<string,unknown>>)=>call(operation,{...input});
  return {id,name:'Fixture brain',channels:['telegram','browser','scheduler','background'],
    startTurn:async(ref,input)=>await call('run.start',{...input,...identity(ref),asynchronous:true}) as TurnReceipt,
    observeTurn:async ref=>await call('run.resume',{...identity(ref),observe_only:true}) as TurnReceipt,
    cancelTurn:async ref=>await call('run.cancel',identity(ref)) as TurnReceipt,
    turnEvents:async(ref,after)=>await call('run.events',{...identity(ref),after}) as unknown as TurnEvents,
    status:()=>call('status',{}),
    readSettings:as('config.read'),writeSettings:as('config.write'),readPersona:as('persona.read'),writePersona:as('persona.write'),
    promptDefaults:async()=>(await call('prompts.defaults',{})).defaults as Record<string,string>,
    listProfiles:as('profiles.list'),readNotes:as('memory.read'),recallNotes:as('memory.recall'),reviewNotes:as('memory.review'),
    advanceSchedules:as('schedule.advance')};
}

type Options=Parameters<typeof storageServices>[1];
/** The storage services with one fake answering both the helper services and the brain, unless a brain is given. */
export function fixtureServices(stores:StorePools,options:Omit<Options,'runtime'|'brain'>&{runtime:FakeCall;brain?:Brain}) {
  return storageServices(stores,{...options,brain:options.brain??fixtureBrain(options.runtime)});
}
