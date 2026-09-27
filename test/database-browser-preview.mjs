/** Synthetic, loopback-only UI preview. No installation services or credentials. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const port=Number(process.env.NOCHEH_DASHBOARD_PORT||18963);
const legacy=process.env.NOCHEH_PREVIEW_STORAGE_LAYOUT==='legacy';
let changes=0;
const rows=Array.from({length:63},(_,index)=>({id:String(index+1),message:index===0?'Owner greeting':'Synthetic archived row '+String(index+1),scope:'555000111'}));
const databases=[
 {id:'archive',name:legacy?'Legacy combined':'Archive',engine:'postgres'},
 ...(legacy?[]:[{id:'derived',name:'Derived',engine:'postgres'},{id:'control',name:'Control',engine:'postgres'}]),
 {id:'workflow',name:'Workflow · Inngest',engine:'postgres'},
 {id:'honcho',name:'Honcho memory',engine:'postgres'},
 {id:'hermes:owner',name:'Hermes · owner',engine:'sqlite'},
 {id:'provider-usage',name:'Provider usage',engine:'sqlite'},
];
const tables={archive:[{schema:'public',name:'events',estimated_rows:63},{schema:'public',name:'artifacts',estimated_rows:4}],
 derived:[{schema:'public',name:'derived_artifacts',estimated_rows:3},{schema:'public',name:'guard_revisions',estimated_rows:2}],
 control:[{schema:'public',name:'installation',estimated_rows:1},{schema:'public',name:'workflow_registry',estimated_rows:19}],
 workflow:[{schema:'public',name:'workflow_registry',estimated_rows:19}],honcho:[{schema:'public',name:'messages',estimated_rows:12}],
 'hermes:owner':[{schema:'main',name:'sessions',estimated_rows:null}],
 'provider-usage':[{schema:'main',name:'usage',estimated_rows:null}]};
const identifiers={archive:legacy?'nocheh':'nocheh_archive',derived:'nocheh_derived',control:'nocheh_control',workflow:'nocheh_inngest',honcho:'honcho_experiment'};
const json=(response,body,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));};
createServer(async(request,response)=>{
 try{
  const url=new URL(request.url||'/',`http://127.0.0.1:${port}`);
  if(url.pathname==='/__fixture/change'&&request.method==='POST'){
   changes++;rows[0].message='Updated row '+changes;return json(response,{changes});
  }
  if(url.pathname==='/api/nocheh/changes'){
   response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});
   response.write(': connected\n\n');
   const timer=setInterval(()=>response.write('event: refresh\ndata: {}\n\n'),1000);
   response.on('close',()=>clearInterval(timer));return;
  }
  if(url.pathname==='/api/nocheh/scopes')return json(response,{scopes:[{scope:'owner',events:changes?2:1}]});
  if(url.pathname==='/api/nocheh/data'||url.pathname==='/api/nocheh/search'){
   const records=[{id:'a'.repeat(64),scope:'owner',kind:'telegram_update',text:'Original archived message',received_at:'2026-09-23T12:00:00.000Z'}];
   if(changes)records.unshift({id:'b'.repeat(64),scope:'owner',kind:'telegram_update',text:'New live message '+changes,received_at:'2026-09-23T12:01:00.000Z'});
   return json(response,{records,next:null});
  }
  if(url.pathname==='/api/nocheh/database-browser'){
   const query=url.searchParams,action=query.get('action');
   if(action==='databases')return json(response,{databases});
   if(action==='status')return json(response,{databases:databases.map((item,index)=>({
    ...item,identifier:item.engine==='postgres'?identifiers[item.id]:item.id==='provider-usage'?'usage.sqlite':'state.db',
    service:item.engine==='postgres'?item.id==='honcho'?'honcho-postgres':'nocheh-db':null,
    state:item.id==='honcho'?'unavailable':'available',
    ...(item.id==='honcho'?{detail:'Database could not be reached'}:{table_count:(tables[item.id]||[]).length,size_bytes:1024*1024*(index+1),version:item.engine==='sqlite'?'3.49.1':'17.7'}),
   }))});
   const database=query.get('database')||'archive';
   if(database==='honcho')return json(response,{error:'database_unavailable'},503);
   if(action==='tables')return json(response,{tables:tables[database]||[]});
   if(action==='rows'){
    const columns=[{name:'id',type:'integer'},{name:'message',type:'text'},{name:'scope',type:'text'}];
    const selected=query.get('table')==='events'?rows:[{id:'1',message:`Synthetic ${database} row`,scope:'fixture'}];
    const filterColumn=query.get('filter_column'),filter=query.get('filter')?.toLowerCase();
    const filtered=filterColumn&&filter?selected.filter(row=>String(row[filterColumn]||'').toLowerCase().includes(filter)):selected;
    const sort=query.get('sort')||'id',direction=query.get('direction')==='desc'?-1:1;
    const sorted=[...filtered].sort((a,b)=>direction*(sort==='id'?Number(a.id)-Number(b.id):String(a[sort]||'').localeCompare(String(b[sort]||''))));
    const offset=Number(query.get('offset')||0),page=sorted.slice(offset,offset+50);
    return json(response,{columns,rows:page,offset,next_offset:offset+50<sorted.length?offset+50:null,cell_limit:500});
   }
   return json(response,{error:'invalid_action'},400);
  }
  if(url.pathname.startsWith('/api/'))return json(response,{error:'fixture_only'},404);
  if(url.pathname==='/'){
   response.writeHead(200,{'content-type':'text/html'});
   response.end((await readFile('dashboard/dist/index.html','utf8')).replace('/*NOCHEH_BOOTSTRAP*/','window.__NOCHEH_CSRF__="fixture";'));
   return;
  }
  if(/^\/assets\/(?:app\.js|style\.css|graph-3d\.js|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(url.pathname)){
   response.writeHead(200,{'content-type':url.pathname.endsWith('.css')?'text/css':'text/javascript'});
   response.end(await readFile(join('dashboard/dist',url.pathname.slice(8))));
   return;
  }
  json(response,{error:'not_found'},404);
 }catch(error){json(response,{error:String(error)},500);}
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic database browser preview on http://127.0.0.1:${port}/#databases`));
