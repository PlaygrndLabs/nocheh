/** Inspection transport on the existing authenticated archive listener. */
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {parse,Kind,type SelectionSetNode,type FragmentDefinitionNode} from 'graphql';
import {HttpError,object,readJson} from '../http.js';

const rootFields=new Set(['apps','app','event','events','eventV2','eventsV2','functionBySlug','functions','functionRun','runs','run','runTraceSpanOutputByID','runTrigger','runTrace','workerConnections','workerConnection','__typename']);
export function inspectionQuery(input:unknown){
  const b=object(input);
  if(typeof b.query!=='string'||b.query.length>65536||Object.keys(b).some(k=>!['query','variables','operationName'].includes(k)))throw new HttpError(400,'invalid_inspection_query');
  if(b.variables!==undefined&&b.variables!==null)object(b.variables);
  let document;try{document=parse(b.query,{maxTokens:8192});}catch{throw new HttpError(400,'invalid_inspection_query');}
  const operations=document.definitions.filter(d=>d.kind===Kind.OPERATION_DEFINITION);
  if(operations.length!==1||operations[0]!.operation!=='query'||b.operationName!=null&&b.operationName!==operations[0]!.name?.value)throw new HttpError(403,'inngest_inspection_only');
  const fragments=new Map<string,FragmentDefinitionNode>();
  for(const d of document.definitions){
    if(d.kind===Kind.FRAGMENT_DEFINITION){if(fragments.has(d.name.value))throw new HttpError(400,'invalid_inspection_query');fragments.set(d.name.value,d);}
    else if(d.kind!==Kind.OPERATION_DEFINITION)throw new HttpError(403,'inngest_inspection_only');
  }
  let count=0;
  function check(set:SelectionSetNode,depth=0,root=true,seen=new Set<string>()){
    if(depth>30)throw new HttpError(400,'inspection_query_too_complex');
    for(const item of set.selections){
      if(++count>3000)throw new HttpError(400,'inspection_query_too_complex');
      if(item.kind===Kind.FIELD){
        if(root&&!rootFields.has(item.name.value)||item.name.value.startsWith('__')&&item.name.value!=='__typename')throw new HttpError(403,'inngest_inspection_only');
        if(item.selectionSet)check(item.selectionSet,depth+1,false,seen);
      }else if(item.kind===Kind.INLINE_FRAGMENT)check(item.selectionSet,depth+1,root,seen);
      else{
        const name=item.name.value,fragment=fragments.get(name);
        if(!fragment||seen.has(name))throw new HttpError(400,'invalid_inspection_query');
        check(fragment.selectionSet,depth+1,root,new Set([...seen,name]));
      }
    }
  }
  check(operations[0]!.selectionSet);return b;
}
export function inspectionPath(raw:string,method:string){
  if(!raw.startsWith('/')||raw.startsWith('//')||raw.includes('\\'))throw new HttpError(403,'inngest_inspection_only');
  const url=new URL(raw,'http://local');
  if(raw.split('?')[0]!==url.pathname)throw new HttpError(403,'inngest_inspection_only');
  const page=/^\/(?:runs?|events?|functions(?:\/config)?|apps(?:\/app)?)?\/?$/.test(url.pathname);
  const asset=/^\/(?:assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|svg|png)|fonts\/[A-Za-z0-9_./-]+\.(?:woff2?|ttf)|favicon-june-2025\.svg)$/.test(url.pathname)&&!url.pathname.includes('..');
  if(method==='POST'&&url.pathname==='/v0/gql'&&!url.search)return {path:'/v0/gql',kind:'query' as const};
  if(method==='GET'&&(page||asset||url.pathname==='/dev'))return {path:url.pathname+url.search,kind:page?'page' as const:asset?'asset' as const:'info' as const};
  throw new HttpError(403,'inngest_inspection_only');
}
export const inspectionHeaders={
  'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const bootstrap=`<script>(()=>{document.addEventListener('DOMContentLoaded',()=>{const decorate=()=>{const layout=document.getElementById('layout-scroll-container');if(!layout)return;layout.parentElement.parentElement.setAttribute('data-nocheh-layout','');if(!document.getElementById('nocheh-inspection-style')){const style=document.createElement('style');style.id='nocheh-inspection-style';style.textContent='#nocheh-inspection-banner{position:fixed;left:0;top:0;right:0;min-height:38px;background:#16483d;color:white;padding:9px 16px;font:13px system-ui;z-index:99999}[data-nocheh-layout]{top:38px!important}#nocheh-inspection-banner a{color:white;text-decoration:underline}[data-nocheh-hidden]{display:none!important}';document.head.append(style);}if(!document.getElementById('nocheh-inspection-banner')){const banner=document.createElement('aside');banner.id='nocheh-inspection-banner';banner.innerHTML='Inngest · inspection only. <a href="/#monitoring">Manage workflows in Nocheh</a>';document.body.append(banner);}for(const link of document.querySelectorAll('a[href]')){const href=link.getAttribute('href');if(/^\\/(?:run|runs|apps|functions|event|events)(?:[/?]|$)/.test(href))link.setAttribute('href','/inngest'+href);}for(const node of document.querySelectorAll('button,[role="menuitem"]')){const text=(node.textContent||node.getAttribute('aria-label')||'').trim();if(/^(?:Rerun|Cancel|Invoke|Send (?:test )?event|Sync app|Resync|Delete app|Remove app|Register app|Add app|Open in Debugger)(?:\\b|$)/i.test(text)&&!node.hasAttribute('data-nocheh-hidden')){node.setAttribute('data-nocheh-hidden','');node.setAttribute('aria-hidden','true');}}};decorate();new MutationObserver(decorate).observe(document,{childList:true,subtree:true});});})();</script>`;

export function rewriteInspection(path:string,type:string,body:Buffer):Buffer{
  if(path==='/assets/fonts-DQTamI_N.css')return Buffer.from('body{font-family:system-ui,sans-serif}');
  if(path==='/assets/CodeBlock-slQUre1D.js'){
    if(!body.toString().endsWith('export{O as t};\n')&&!body.toString().endsWith('export{O as t};'))throw new HttpError(503,'inngest_ui_version_mismatch');
    // The pinned Monaco viewer otherwise fetches an external editor before it
    // displays anything. Inspection uses a local, accessible, read-only value.
    return Buffer.from(`import{t as factory}from"./jsx-runtime-D4MLZeW6.js";const h=factory();function Code({header,tab,loading}){return h.jsxs('section',{className:'border-subtle bg-canvasBase border-b',children:[header?.title&&h.jsx('p',{className:'text-subtle px-5 py-2.5 text-sm',children:header.title}),h.jsx('pre',{tabIndex:0,'aria-label':header?.title||'Execution data',style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',overflow:'auto',maxHeight:'65vh',padding:'16px',font:'13px/1.6 ui-monospace,monospace'},children:loading?'Loading…':String(tab?.content??'')})]});}Code.Wrapper=({children})=>h.jsx('div',{className:'border-subtle w-full overflow-hidden rounded-md border',children});export{Code as t};`);
  }
  if(!/html|javascript|css/.test(type))return body;
  let value=body.toString().replace(/(["'`])\/assets\//g,'$1/inngest/assets/').replace(/(["'`])assets\//g,'$1inngest/assets/').replace(/(["'`])\/favicon-june-2025\.svg/g,'$1/inngest/favicon-june-2025.svg');
  if(path==='/assets/ErrorCard-B-YVbC3X.js'){
    const signature='ai as r,N as s,si as t';
    if(value.split(signature).length!==2)throw new HttpError(503,'inngest_ui_version_mismatch');
    // Run traces bundle a second copy of the Monaco viewer. Route its public
    // export through the same local renderer without altering other exports.
    value='import{t as NochehCode}from"./CodeBlock-slQUre1D.js";'+value.replace(signature,'NochehCode as r,N as s,si as t');
  }
  if(path==='/assets/index-CFHJRWXe.js'){
    const signature='basepath:``,serializationAdapters:';
    if(value.split(signature).length!==2)throw new HttpError(503,'inngest_ui_version_mismatch');
    value=value.replace(signature,'basepath:`/inngest`,serializationAdapters:');
    const graphql='new Dy(`/v0/gql`)';
    if(value.split(graphql).length!==2)throw new HttpError(503,'inngest_ui_version_mismatch');
    value=value.replace(graphql,"new Dy(`/inngest/v0/gql`,{headers:()=>({'X-Nocheh-CSRF':window.__NOCHEH_CSRF__})})").replaceAll('`/dev`','`/inngest/dev`');
  }
  if(path==='/assets/_dashboard-B8OQ17R4.js'){
    const signature='to:l?void 0:i,preload:o';
    if(value.split(signature).length!==2)throw new HttpError(503,'inngest_ui_version_mismatch');
    value=value.replace(signature,'to:l?void 0:(i??r),"aria-label":e,preload:o')
      .replace('{group:B,collapsed:e}','{group:{items:[]},collapsed:e}').replace('{group:V,collapsed:e}','{group:{items:[]},collapsed:e}');
  }
  if(type.includes('text/html'))value=value.replace('</head>',bootstrap+'</head>');
  return Buffer.from(value);
}
export async function boundedInspectionBody(response:Response){
  const chunks:Buffer[]=[];let length=0;
  if(response.body)for await(const part of response.body){length+=part.length;if(length>12*1024*1024){await response.body.cancel().catch(()=>{});throw new HttpError(502,'inspection_response_too_large');}chunks.push(Buffer.from(part));}
  return Buffer.concat(chunks);
}
export async function proxyInngestInspection(req:IncomingMessage,res:ServerResponse,key:string,upstream='http://inngest-server:8288'){
  const selected=inspectionPath((req.url??'').slice('/v1/workflows/inspection'.length),req.method??'GET');
  if(req.headers.origin||req.headers.cookie)throw new HttpError(403,'inspection_backend_only');
  if(!/^[a-f0-9]{64}$/.test(key))throw new HttpError(503,'workflows_unavailable');
  const query=selected.kind==='query'?inspectionQuery(await readJson(req,128*1024)):undefined;
  if(selected.kind==='info'){res.writeHead(200,{...inspectionHeaders,'content-type':'application/json'});res.end(JSON.stringify({version:'1.44.0',isSingleNodeService:true,startOpts:{autodiscover:false},features:{}}));return;}
  const authorization='Bearer '+createHash('sha256').update(Buffer.from(key,'hex')).digest('hex');
  let response:Response;try{response=await fetch(new URL(selected.path,upstream),{method:req.method??'GET',headers:{authorization,'content-type':'application/json','accept-encoding':'identity'},...(query?{body:JSON.stringify(query)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new HttpError(503,'workflows_unavailable');}
  if(!response.ok){await response.body?.cancel();throw new HttpError(502,'inspection_unavailable');}
  const type=response.headers.get('content-type')??'application/octet-stream';
  if(selected.kind==='asset'&&type.includes('text/html'))throw new HttpError(404,'inspection_asset_missing');
  const body=rewriteInspection(selected.path.split('?')[0]!,type,await boundedInspectionBody(response));
  res.writeHead(200,{...inspectionHeaders,'content-type':type});res.end(body);
}
