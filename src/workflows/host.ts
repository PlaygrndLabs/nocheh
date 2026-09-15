import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workflowClient,connectWorkflows} from './client.js';
import {coordinatedFunctions} from './engine.js';
import {safeMetadata} from './boundary.js';
import type {Observation} from './pipeline.js';

const root=resolve(fileURLToPath(new URL('../../..',import.meta.url))),state=process.env.NOCHEH_STATE_DIR;
if(!state||existsSync(join(state,'workflows/inactive'))||existsSync(join(state,'spool/.restore-inactive')))process.exit(0);
const base='http://127.0.0.1:'+Number(process.env.NOCHEH_PORT??8780),token=process.env.SERVICE_TOKEN??'';
if(token.length<24)throw Error('workflow_host_configuration_missing');
export type ArchiveRPC=(path:string,body:unknown)=>Promise<any>;
const rpc:ArchiveRPC=async(path,body)=>{
  const response=await fetch(base+'/v1/workflows/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('workflow_archive_unavailable');return response.json();
};
function batch(body:unknown):Promise<unknown> {
  return new Promise((accept,reject)=>{
    const child=spawn(process.env.NOCHEH_PYTHON??'python3',['-m','scripts.management'],{cwd:root,env:process.env,stdio:['pipe','pipe','ignore']});
    let buffer='',result:unknown,failure='workflow_host_operation_failed';const timer=setTimeout(()=>child.kill('SIGKILL'),300000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>65536){child.kill('SIGKILL');return;}
      let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const value=JSON.parse(line);if(value.result)result=value.result;
        if(['import_configuration_changed','scope_mapping_denied','export_integrity_failed','invalid_import_checkpoint'].includes(value.error))failure=value.error;
      }catch{child.kill('SIGKILL');}}
    });
    child.on('error',()=>{clearTimeout(timer);reject(Error('workflow_host_operation_failed'));});
    child.on('close',code=>{clearTimeout(timer);if(code||!result)reject(Error(failure));else accept(result);});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(body));
  });
}
const client=workflowClient('host');
const functions=coordinatedFunctions(client,['imports','tools'],async(workflow_id,dispatch,family,run_id)=>{
  const claim=await rpc('host/claim',{workflow_id,dispatch,family,run_id});
  if(!claim.claimed){safeMetadata(claim.observation);return claim.observation;}
  const identity={workflow_id,token:claim.token,import_token:claim.job.lease_token};
  const timer=setInterval(()=>{void rpc('host/renew',identity).catch(()=>{});},15000);
  try{
    let result:unknown,failure_code:string|undefined;
    try{result=await batch(family==='tools'?{operation:'workflow.tools.tick',action_id:claim.job.id,workflow_id,workflow_token:claim.token}:
      {operation:'workflow.import.batch',job:claim.job.id,lease:claim.job.lease_token,configuration_hash:claim.job.configuration_hash,
      completed:claim.job.completed,duplicates:claim.job.duplicates,learning_after:claim.job.learning_after});}catch(error){failure_code=error instanceof Error?error.message:'workflow_host_operation_failed';}
    const observation:Observation=await rpc('host/finish',{...identity,...(result===undefined?{failure_code}:{result})});safeMetadata(observation);return observation;
  }finally{clearInterval(timer);}
},async(workflow_id,dispatch)=>{await rpc('host/continue',{workflow_id,dispatch});});
const connection=await connectWorkflows('host',client,functions,undefined,2);
if(connection.state==='ACTIVE')await rpc('host/heartbeat',{});
const heartbeat=setInterval(()=>{if(connection.state==='ACTIVE')void rpc('host/heartbeat',{}).catch(()=>{});},5000);
let stopping=false;
function stop(){if(stopping)return;stopping=true;clearInterval(heartbeat);void connection.close().then(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
