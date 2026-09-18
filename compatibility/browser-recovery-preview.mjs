/** Isolated component rehearsal: real React recovery UI, synthetic HTTP transport. */
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';

const port=Number(process.env.NOCHEH_RECOVERY_PREVIEW_PORT||18861),cssRoot=process.env.NOCHEH_NATIVE_ASSETS;
if(!cssRoot)throw Error('NOCHEH_NATIVE_ASSETS must point to the candidate image assets');
const css=(await Promise.all((await readdir(cssRoot)).filter(name=>name.endsWith('.css')).map(name=>readFile(join(cssRoot,name),'utf8')))).join('\n');
const hash=text=>createHash('sha256').update(text).digest('hex'),acknowledged=new Set();let available=false;
const answers=['The inspection is complete.\nThe reaction refers to the northern telescope.',
  'گزارش بررسی آماده است. ✅\nThe original remains available for a better transcription engine.',
  'Long response wrapping: '+('reference-without-spaces-'.repeat(15)),
  'This fourth response arrived while the event connection was unavailable.'];
const rows=answers.map((text,i)=>({event_id:hash('event'+i),conversation:'synthetic-conversation',status:'complete',text,nocheh_delivery:{receipt:hash('receipt'+i),sha256:hash(text)}}));
const api=`export const api={undeliveredBrowserResponses:async(profile,after)=>(await fetch('/fixture/results?profile='+encodeURIComponent(profile))).json(),acknowledgeBrowserDelivery:async receipt=>{const response=await fetch('/fixture/receipt',{method:'POST',body:JSON.stringify(receipt)});if(!response.ok)throw Error('capture unavailable');return response.json();}};`;
const entry=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRecovery} from './scripts/native-browser-recovery';import {resumeBrowserDeliveries} from './scripts/native-browser-delivery';import {api} from '@/lib/api';
function Preview(){const[profile,setProfile]=useState('owner'),[status,setStatus]=useState({acknowledged:0,available:false});
useEffect(()=>resumeBrowserDeliveries(api.acknowledgeBrowserDelivery),[]);
useEffect(()=>{const timer=setInterval(()=>{fetch('/fixture/state').then(r=>r.json()).then(setStatus)},500);return()=>clearInterval(timer)},[]);
return <main><h1>Synthetic response recovery</h1><p>No providers or installation data. Receipt capture starts offline.</p>
<nav><button onClick={()=>{document.documentElement.dataset.fixtureTheme=document.documentElement.dataset.fixtureTheme==='light'?'dark':'light'}}>Toggle theme</button>
<button onClick={()=>setProfile(profile==='owner'?'group':'owner')}>Switch profile</button>
<button onClick={()=>fetch('/fixture/available',{method:'POST'})}>Resume receipt capture</button></nav>
<p role="status">Profile: {profile}. Acknowledged: {status.acknowledged}. Capture: {status.available?'ready':'offline'}.</p>
<BrowserRecovery key={profile} profile={profile}/></main>};createRoot(document.getElementById('root')).render(<Preview/>);`;
const built=await build({stdin:{contents:entry,resolveDir:resolve('.'),sourcefile:'recovery-preview.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',jsx:'automatic',plugins:[{name:'fixture-api',setup(builder){
  builder.onResolve({filter:/^@\/lib\/api$/},()=>({path:'api',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:api,loader:'js'}));
  builder.onResolve({filter:/^@\/lib\/nocheh-browser-delivery$/},()=>({path:resolve('scripts/native-browser-delivery.ts')}));}}]});
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://fixture');res.setHeader('cache-control','no-store');
  if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html data-fixture-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Browser recovery rehearsal</title><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:auto;max-height:none;overflow:auto}body{background:var(--background);color:var(--midground);font-family:system-ui}main{max-width:24rem;padding:1rem;margin:auto}nav{display:flex;flex-wrap:wrap;gap:.5rem}nav button{border:1px solid currentColor;padding:.5rem}h1{font-size:1.2rem}main>p{margin:1rem 0}section{margin:.75rem 0}html[data-fixture-theme=light]{--background:#fff;--background-base:#fff;--foreground:#152528;--midground:#152528;--color-foreground:#152528;--border:#a7b6b8;--color-border:#a7b6b8}</style><div id="root"></div><script type="module" src="/app.js"></script></html>');return;}
  if(url.pathname==='/app.js'){res.setHeader('content-type','text/javascript');res.end(built.outputFiles[0].contents);return;}
  if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(css);return;}
  res.setHeader('content-type','application/json');
  if(url.pathname==='/fixture/results'){res.end(JSON.stringify({items:url.searchParams.get('profile')==='owner'?rows.filter(row=>!acknowledged.has(row.event_id)):[],next:null}));return;}
  if(url.pathname==='/fixture/available'&&req.method==='POST')available=true;
  else if(url.pathname==='/fixture/receipt'&&req.method==='POST'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    const row=rows.find(row=>row.nocheh_delivery.receipt===body.receipt&&row.nocheh_delivery.sha256===body.sha256);
    if(!available||!row){res.statusCode=503;res.end('{}');return;}acknowledged.add(row.event_id);
  }else if(url.pathname!=='/fixture/state'){res.statusCode=404;res.end('{}');return;}
  res.end(JSON.stringify({acknowledged:acknowledged.size,available}));
}catch{res.statusCode=500;res.end('{}');}});
server.listen(port,'127.0.0.1',()=>console.log('Synthetic browser recovery preview: http://127.0.0.1:'+port));
