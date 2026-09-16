import type {IncomingMessage,ServerResponse} from 'node:http';
import {HttpError,readJson} from './http.js';
import {inspectionPath,inspectionHeaders,boundedInspectionBody} from './workflows/inspection.js';

/** Owner session is checked by management before this internal authenticated hop. */
export async function proxyOwnerInspection(req:IncomingMessage,res:ServerResponse,port:number,token:string,csrf:string,host='127.0.0.1'){
  const selected=inspectionPath((req.url??'').slice('/inngest'.length),req.method??'GET');
  const requestBody=req.method==='POST'?JSON.stringify(await readJson(req,128*1024)):undefined;
  let response:Response;try{response=await fetch(`http://${host}:${port}/v1/workflows/inspection`+selected.path,{method:req.method??'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(requestBody?{body:requestBody}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new HttpError(503,'workflows_unavailable');}
  let body=await boundedInspectionBody(response);const type=response.headers.get('content-type')??'application/octet-stream';
  if(type.includes('text/html'))body=Buffer.from(body.toString().replace('</head>',`<script>window.__NOCHEH_CSRF__=${JSON.stringify(csrf)};</script></head>`));
  res.writeHead(response.status,{...inspectionHeaders,'content-type':type});res.end(body);
}
