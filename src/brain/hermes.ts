import {HttpError,object} from '../http.js';
import {brainInvalid,brainRejected,brainUnavailable,closedTurnStates,type Brain,type TurnEvents,type TurnReceipt,type TurnRef,type TurnState} from './brain.js';

type Options={url:string;token:string;fetch?:typeof fetch};

const states=new Set<TurnState>(['queued','waiting','running','not_found',...closedTurnStates]);
/** Hermes's own refusals that the owner can act on, kept by their code. */
const settingCodes=new Set(['configuration_conflict','unsupported_preference','profile_scope_denied','invalid_preference','invalid_persona']);

/** Hermes behind the brain socket (ADR-0234). Only this file knows Hermes's run, management and notes routes. */
export function hermesBrain(options:Options):Brain {
  const transport=options.fetch??fetch;
  async function send(path:string,body:Record<string,unknown>|null,timeout:number,settings=false):Promise<Record<string,unknown>> {
    let response:Response;
    try {
      response=await transport(new URL(path,options.url),{method:body===null?'GET':'POST',signal:AbortSignal.timeout(timeout),
        headers:{authorization:`Bearer ${options.token}`,'content-type':'application/json'},...(body===null?{}:{body:JSON.stringify(body)})});
    }catch{throw brainUnavailable();}
    if(!response.ok) {
      const error=await response.json().catch(()=>null) as {error?:unknown}|null,code=typeof error?.error==='string'?error.error:'';
      if(response.status===429)throw new HttpError(429,'quota_paused');
      // No provider chosen in Settings › Models is a waiting condition, not a brain fault.
      if(code==='provider_not_configured'||settings&&settingCodes.has(code))throw new HttpError(response.status,code);
      throw response.status<500?brainRejected():brainUnavailable();
    }
    try{return object(await response.json());}catch{throw brainInvalid();}
  }
  // Telegram turns return their reply, which Nocheh's own bot sends (ADR-0235); every other turn runs on Hermes's run routes.
  const returns=(ref:TurnRef)=>ref.channel==='telegram';
  const route=(ref:TurnRef,action:string)=>(returns(ref)?'/internal/turn/':'/internal/run/')+action;
  const identity=(ref:TurnRef)=>({channel:ref.channel,event_id:ref.event_id,attempt:ref.attempt});
  const receipt=(ref:TurnRef,value:Record<string,unknown>):TurnReceipt=>{
    if(!states.has(value.state as TurnState))throw brainInvalid();
    const reply=value.reply as {text?:unknown;session_id?:unknown}|undefined;
    if(reply!==undefined&&(!reply||typeof reply!=='object'||typeof reply.text!=='string'||typeof reply.session_id!=='string'))throw brainInvalid();
    if(returns(ref)&&value.state==='done'&&reply===undefined)throw brainInvalid();
    return value as TurnReceipt;
  };
  const manage=(action:string,settings=false)=>async(input:Readonly<Record<string,unknown>>)=>send('/internal/manage',{...input,action},120000,settings);
  return {
    id:'hermes',name:'Hermes',channels:['telegram','browser','scheduler','background'],
    async startTurn(ref,input) {
      // The run routes take `asynchronous`, which their requests have always carried; it is not part of a turn's identity.
      return receipt(ref,await send(route(ref,'start'),{...input,...identity(ref),...(returns(ref)?{}:{asynchronous:true})},10000));
    },
    async observeTurn(ref){return receipt(ref,await send(route(ref,'resume'),{...identity(ref),observe_only:true},10000));},
    async cancelTurn(ref){return receipt(ref,await send(route(ref,'cancel'),identity(ref),10000));},
    async turnEvents(ref,after) {
      const value=await send(route(ref,'events'),{...identity(ref),after},10000);
      if(!Array.isArray(value.events))throw brainInvalid();
      return value as TurnEvents;
    },
    status:()=>send('/health',null,5000),
    readSettings:manage('preferences',true),writeSettings:manage('preferences',true),
    readPersona:manage('persona',true),writePersona:manage('persona',true),
    listProfiles:manage('profiles'),readNotes:manage('memory'),
    async promptDefaults() {
      const defaults=(await send('/internal/manage',{action:'prompts'},120000,true)).defaults;
      if(!defaults||typeof defaults!=='object'||Array.isArray(defaults)||Object.values(defaults).some(text=>typeof text!=='string'))throw brainInvalid();
      return defaults as Record<string,string>;
    },
    recallNotes:input=>send('/internal/memory/recall',{...input},120000),
    reviewNotes:input=>send('/internal/memory/review',{...input},input.observe_only===true?10000:240000),
    advanceSchedules:input=>send('/internal/schedule/advance',{...input},20000),
  };
}
