import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {HttpError,readJson} from '../http.js';
import type {Reader} from '../access.js';
import {mcpTools,type ToolContext,type Loopback} from './tools.js';

/** MCP revisions this server speaks: JSON-only Streamable HTTP, no sessions, no server-to-client requests (ADR-0231). */
export const protocolVersions=['2025-11-25','2025-06-18','2025-03-26'];
const serverInfo={name:'nocheh',title:'Nocheh',version:'1'};
type Id=string|number;
const rpc=(res:ServerResponse,status:number,value:unknown)=>{
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));
};
const failure=(id:Id|null,code:number,message:string)=>({jsonrpc:'2.0',id,error:{code,message}});

/** A loop-back to this service's own routes with the caller's bearer, so each tool passes every check its route has today. */
export function loopback(base:string,authorization:string,fetcher:typeof fetch=fetch):Loopback {
  return async(method,path,body,timeoutMs)=>{
    const response=await fetcher(base+path,{method,headers:{authorization,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    // A tool reads at most 2 MiB, as the Python tools did.
    const text=Buffer.from(await response.arrayBuffer());
    if(text.length>2*1024*1024)throw new Error('archive_response_too_large');
    let value:unknown=null;
    try{value=text.length?JSON.parse(text.toString('utf8')):null;}catch{if(response.ok)throw new Error('invalid_archive_response');}
    return {status:response.status,body:value};
  };
}

/** This service itself, on the port the request came in on. Both services listen on every interface. */
export const selfBase=(req:IncomingMessage)=>'http://127.0.0.1:'+req.socket.localPort;

/** The turn's own deadline, from the trusted turn process. It can only shorten a long memory recall; a bad value is ignored. */
export function turnDeadline(req:IncomingMessage,now=Date.now()):number|undefined {
  const value=req.headers['x-nocheh-turn-deadline'];
  if(typeof value!=='string'||!/^\d{9,12}(?:\.\d{1,6})?$/.test(value))return undefined;
  const seconds=Number(value);
  return seconds*1000>now&&seconds*1000<=now+3600000?seconds:undefined;
}

/** One MCP request: POST with one JSON-RPC message. The caller has already authenticated `principal`. */
export async function serveMcp(req:IncomingMessage,res:ServerResponse,options:{principal:Reader;call:Loopback;isolated:boolean}) {
  if(req.method!=='POST'){res.writeHead(405,{allow:'POST','content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'method_not_allowed'}));return;}
  // Brains reach this only from inside Nocheh's own network; a browser never does.
  if(req.headers.origin!==undefined)throw new HttpError(403,'origin_not_allowed');
  if(options.principal.admin)throw new HttpError(403,'turn_credential_required');
  const version=req.headers['mcp-protocol-version'];
  if(version!==undefined&&!protocolVersions.includes(String(version)))return rpc(res,400,failure(null,-32600,'Unsupported protocol version'));
  let message:unknown;
  try{message=await readJson(req,1024*1024);}catch(error){
    if(error instanceof HttpError&&error.status===413)throw error;
    return rpc(res,400,failure(null,-32700,'Parse error'));
  }
  if(!message||typeof message!=='object'||Array.isArray(message)||(message as any).jsonrpc!=='2.0')return rpc(res,400,failure(null,-32600,'Invalid request'));
  const {id,method,params}=message as {id?:unknown;method?:unknown;params?:unknown};
  // Notifications and responses get no answer.
  if(id===undefined||typeof method!=='string'){res.writeHead(202);res.end();return;}
  if(typeof id!=='string'&&typeof id!=='number')return rpc(res,400,failure(null,-32600,'Invalid request'));
  const input=params&&typeof params==='object'&&!Array.isArray(params)?params as Record<string,unknown>:{};
  if(method==='initialize') {
    const asked=typeof input.protocolVersion==='string'?input.protocolVersion:'';
    return rpc(res,200,{jsonrpc:'2.0',id,result:{protocolVersion:protocolVersions.includes(asked)?asked:protocolVersions[0],
      capabilities:{tools:{listChanged:false}},serverInfo}});
  }
  if(method==='ping')return rpc(res,200,{jsonrpc:'2.0',id,result:{}});
  if(method==='tools/list')return rpc(res,200,{jsonrpc:'2.0',id,result:{tools:mcpTools.map(({name,description,inputSchema})=>({name,description,inputSchema}))}});
  if(method==='tools/call') {
    const tool=mcpTools.find(item=>item.name===input.name);
    const args=input.arguments===undefined?{}:input.arguments;
    if(!tool||!args||typeof args!=='object'||Array.isArray(args))return rpc(res,200,failure(id,-32602,tool?'Invalid arguments':'Unknown tool'));
    const context:ToolContext={call:options.call,principal:options.principal,isolated:options.isolated,deadline:turnDeadline(req)};
    let text:string;
    // A tool's own failure is a normal result whose text says so, as the Python tools answered: a brain reads it and goes on.
    try{text=await tool.run(args as Record<string,unknown>,context);}catch{text=JSON.stringify({error:'tool_unavailable'});}
    return rpc(res,200,{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],isError:false}});
  }
  return rpc(res,200,failure(id,-32601,'Method not found'));
}

/** A digest of the tool list, so a test or an operator can tell which tool surface a brain was offered. */
export function toolSurface():string {
  return createHash('sha256').update(JSON.stringify(mcpTools.map(({name,description,inputSchema})=>({name,description,inputSchema})))).digest('hex');
}
