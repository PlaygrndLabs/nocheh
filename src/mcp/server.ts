import {createHash} from 'node:crypto';
import {request,type IncomingMessage,type ServerResponse} from 'node:http';
import {HttpError,readJson} from '../http.js';
import type {Reader} from '../access.js';
import {mcpTools,type ToolContext,type Loopback} from './tools.js';

/** MCP revisions this server speaks: Streamable HTTP without sessions or server-to-client requests (ADR-0233). */
export const protocolVersions=['2025-11-25','2025-06-18','2025-03-26'];
const serverInfo={name:'nocheh',title:'Nocheh',version:'1'};
type Id=string|number;
const rpc=(res:ServerResponse,status:number,value:unknown)=>{
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));
};
const failure=(id:Id|null,code:number,message:string)=>({jsonrpc:'2.0',id,error:{code,message}});

/** A loop-back to this service's own routes with the caller's bearer, so each tool passes every check its route has today.
 * node:http sets no idle limit of its own, so a long memory recall keeps its whole budget; only `timeoutMs` ends a call.
 * Each call has its own connection: a route that refuses a body before reading all of it leaves no half-read socket for the next. */
export function loopback(base:string,authorization:string):Loopback {
  return (method,path,body,timeoutMs)=>new Promise((resolve,reject)=>{
    const signal=AbortSignal.timeout(timeoutMs),payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    let settled=false;
    const fail=(error:unknown)=>{if(!settled){settled=true;reject(signal.aborted?signal.reason:error);}};
    const outgoing=request(base+path,{method,signal,agent:false,headers:{authorization,'content-type':'application/json',...(payload?{'content-length':payload.length}:{})}},response=>{
      const status=response.statusCode??0;
      if(status>=300&&status<400){response.resume();outgoing.destroy();return fail(new Error('archive_redirect_refused'));}
      // A tool reads at most 2 MiB, as the Python tools did.
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{
        if(settled)return;
        size+=chunk.length;
        if(size>2*1024*1024){fail(new Error('archive_response_too_large'));outgoing.destroy();return;}
        chunks.push(chunk);
      });
      response.on('error',fail);
      response.on('end',()=>{
        if(settled)return;
        const text=Buffer.concat(chunks);let value:unknown=null;
        try{value=text.length?JSON.parse(text.toString('utf8')):null;}catch{if(status>=200&&status<300)return fail(new Error('invalid_archive_response'));}
        settled=true;resolve({status,body:value});
      });
    });
    outgoing.on('error',fail);
    outgoing.end(payload);
  });
}

/** This service itself, on the port the request came in on. Both services listen on every interface. */
export const selfBase=(req:IncomingMessage)=>'http://127.0.0.1:'+req.socket.localPort;

/** The turn's own deadline, from the trusted turn process. It can only shorten a long memory recall: one already past leaves
 * no time for it, and a malformed value, or one more than an hour ahead, is ignored. */
export function turnDeadline(req:IncomingMessage,now=Date.now()):number|undefined {
  const value=req.headers['x-nocheh-turn-deadline'];
  if(typeof value!=='string'||!/^\d{9,12}(?:\.\d{1,6})?$/.test(value))return undefined;
  const seconds=Number(value);
  return seconds*1000<=now+3600000?seconds:undefined;
}

/** How often a long tool call tells the client it is still running. A client's own read limit is never shorter. */
export const keepaliveMs=20000;

/** One MCP request: POST with one JSON-RPC message. The caller has already authenticated `principal`. */
export async function serveMcp(req:IncomingMessage,res:ServerResponse,options:{principal:Reader;call:Loopback;isolated:boolean;keepalive?:number}) {
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
    // A long call, such as a memory recall, would leave the connection silent past a client's read limit. A client that takes an
    // event stream gets one after the first interval: a comment line each interval, then the answer as one message.
    let streaming=false;
    const timer=String(req.headers.accept??'').includes('text/event-stream')?setInterval(()=>{
      if(!streaming){streaming=true;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});}
      res.write(': running\n\n');
    },options.keepalive??keepaliveMs):undefined;
    let text:string;
    // A tool's own failure is a normal result whose text says so, as the Python tools answered: a brain reads it and goes on.
    try{text=await tool.run(args as Record<string,unknown>,context);}catch{text=JSON.stringify({error:'tool_unavailable'});}finally{clearInterval(timer);}
    const answer={jsonrpc:'2.0',id,result:{content:[{type:'text',text}],isError:false}};
    if(!streaming)return rpc(res,200,answer);
    res.end('event: message\ndata: '+JSON.stringify(answer)+'\n\n');
    return;
  }
  return rpc(res,200,failure(id,-32601,'Method not found'));
}

/** A digest of the tool list, so a test or an operator can tell which tool surface a brain was offered. */
export function toolSurface():string {
  return createHash('sha256').update(JSON.stringify(mcpTools.map(({name,description,inputSchema})=>({name,description,inputSchema})))).digest('hex');
}
