import type {Brain,TurnEvents,TurnReceipt,TurnRef} from '../src/brain/brain.js';
import type {StorePools} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

/** A test fake answering by operation name: the helper services' names, and for the brain the names below. */
export type FakeCall=(operation:string,input:Record<string,unknown>,timeout?:number)=>Promise<Record<string,unknown>>;
const identity=(ref:TurnRef)=>({channel:ref.channel,event_id:ref.event_id,attempt:ref.attempt});
/** The reply a done Telegram turn returns when a fake gives none, as a real brain always does (ADR-0235). */
export const fixtureReply={text:'Fixture reply',session_id:'fixture-session'};
const replied=(ref:TurnRef,receipt:Record<string,unknown>):TurnReceipt=>
  (ref.channel==='telegram'&&receipt.state==='done'&&receipt.reply===undefined?{...receipt,reply:fixtureReply}:receipt) as TurnReceipt;

/**
 * A brain for tests that hands each operation to a fake by name, with the body Hermes's run routes receive:
 * `run.start`, `run.resume` (observe only), `run.cancel`, `run.events`, `status`, `config.read`, `config.write`,
 * `persona.read`, `persona.write`, `prompts.defaults`, `profiles.list`, `memory.read`, `memory.recall`,
 * `memory.review` and `schedule.advance`.
 */
export function fixtureBrain(call:FakeCall,id='hermes'):Brain {
  const as=(operation:string)=>(input:Readonly<Record<string,unknown>>)=>call(operation,{...input});
  return {id,name:'Fixture brain',channels:['telegram','browser','scheduler','background'],
    startTurn:async(ref,input)=>replied(ref,await call('run.start',{...input,...identity(ref),asynchronous:true})),
    observeTurn:async ref=>replied(ref,await call('run.resume',{...identity(ref),observe_only:true})),
    cancelTurn:async ref=>replied(ref,await call('run.cancel',identity(ref))),
    turnEvents:async(ref,after)=>await call('run.events',{...identity(ref),after}) as unknown as TurnEvents,
    status:()=>call('status',{}),
    readSettings:as('config.read'),writeSettings:as('config.write'),readPersona:as('persona.read'),writePersona:as('persona.write'),
    promptDefaults:async()=>(await call('prompts.defaults',{})).defaults as Record<string,string>,
    listProfiles:as('profiles.list'),readNotes:as('memory.read'),recallNotes:as('memory.recall'),reviewNotes:as('memory.review'),
    advanceSchedules:as('schedule.advance')};
}

/** The calls a turn makes on Nocheh's bot while it runs and answers. */
const turnDelivery=new Set(['telegram.identity','telegram.presence','telegram.reply']);
/**
 * Nocheh's bot for tests: it names itself `Nocheh_Bot`, shows presence, and sends each reply at once, with the send
 * time and window the real bot reports. `record` sees every call.
 */
export function fixtureTelegram(record?:(operation:string,input:Record<string,unknown>)=>void):FakeCall {
  return async(operation,input)=>{
    record?.(operation,input);
    if(operation==='telegram.identity')return {state:'connected',bot_id:'123456',username:'Nocheh_Bot',first_name:'Nocheh'};
    if(operation==='telegram.presence')return {state:input.finish?'finished':'shown'};
    if(operation==='telegram.reply') {
      if(input.cancel===true||input.observe_only===true)return {state:'not_found'};
      const now=Date.now();return {state:'done',timings:{telegram_send:{ms:5,calls:1}},window:{delivery:now-5,finished:now}};
    }
    throw Error('unexpected Telegram call '+operation);
  };
}

type Options=Parameters<typeof storageServices>[1];
/**
 * The storage services with one fake answering both the helper services and the brain, unless a brain is given. A turn's
 * presence and reply go to `telegram` (by default `fixtureTelegram()`), and groups get a reply to every message unless
 * `groupReplies` says otherwise.
 */
export function fixtureServices(stores:StorePools,options:Omit<Options,'runtime'|'brain'>&{runtime:FakeCall;brain?:Brain;telegram?:FakeCall}) {
  const {telegram=fixtureTelegram(),...rest}=options;
  const runtime:FakeCall=(operation,input,timeout)=>turnDelivery.has(operation)?telegram(operation,input,timeout):options.runtime(operation,input,timeout);
  return storageServices(stores,{groupReplies:{mode:'all',names:['Nocheh']},...rest,runtime,brain:options.brain??fixtureBrain(options.runtime)});
}
