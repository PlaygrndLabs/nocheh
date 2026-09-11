import {Inngest, type InngestFunction} from 'inngest';
import {connect, type WorkerConnection} from 'inngest/connect';
import {hostname} from 'node:os';
import {WorkflowBoundary} from './boundary.js';

export type WorkflowApp='pipeline'|'host';
export type WorkflowConfig={baseUrl:string;gatewayUrl:string;eventKey:string;signingKey:string;version:string};

export function workflowConfig(env:NodeJS.ProcessEnv=process.env):WorkflowConfig {
  const baseUrl=env.INNGEST_BASE_URL??'http://inngest:8288';
  const gatewayUrl=env.INNGEST_CONNECT_GATEWAY_URL??'ws://inngest:8289/v0/connect';
  for(const [value,protocol] of [[baseUrl,'http:'],[gatewayUrl,'ws:']]) {
    const url=new URL(value!);
    if(url.protocol!==protocol||!['inngest','127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)
      throw Error('workflow_local_endpoint_required');
  }
  const eventKey=env.INNGEST_EVENT_KEY??'',signingKey=env.INNGEST_SIGNING_KEY??'';
  if(!/^[a-f0-9]{64}$/.test(eventKey)||!/^[a-f0-9]{64}$/.test(signingKey))throw Error('workflow_keys_missing');
  const version=env.NOCHEH_WORKFLOW_VERSION??'1';
  if(!/^[a-zA-Z0-9._-]{1,80}$/.test(version))throw Error('workflow_version_invalid');
  return {baseUrl,gatewayUrl,eventKey,signingKey,version};
}

// Never forward SDK/provider exception objects or payloads to operational logs.
const quietLogger={info(){},warn(){},error(){},debug(){}};
export function workflowClient(app:WorkflowApp,config=workflowConfig()):Inngest {
  const origin=new URL(config.baseUrl).origin;
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!==origin)throw Error('workflow_destination_denied');
    return fetch(input,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  };
  return new Inngest({id:'nocheh-'+app,appVersion:config.version,isDev:false,
    baseUrl:config.baseUrl,eventKey:config.eventKey,signingKey:config.signingKey,
    logger:quietLogger,internalLogger:quietLogger,fetch:transport,middleware:[WorkflowBoundary]});
}

export async function connectWorkflows(app:WorkflowApp,client:Inngest,functions:InngestFunction.Like[],
  config=workflowConfig(),max=4):Promise<WorkerConnection> {
  try {
    return await connect({apps:[{client,functions}],gatewayUrl:config.gatewayUrl,
      instanceId:app+'-'+hostname(),maxWorkerConcurrency:max,handleShutdownSignals:[]});
  } catch {throw Error('workflow_connection_failed');}
}

export function workflowIdentity(value:unknown):string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('workflow_identity_invalid');
  return value;
}
