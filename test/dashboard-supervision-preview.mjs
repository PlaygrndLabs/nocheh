/** Synthetic UI preview only: no database, adapters, provider calls or external effects. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
if(process.env.NOCHEH_SUPERVISION_FIXTURE!=='1')throw Error('synthetic_fixture_opt_in_required');
const root=new URL('..',import.meta.url).pathname,port=Number(process.env.NOCHEH_DASHBOARD_PORT||18852),now=new Date().toISOString(),id=n=>n.toString(16).padStart(64,'0');
const project={id:id(1),name:'Aurora field guide',description:'Synthetic project for permitted travel research.',state:'active',revision:1};
const conversations=[{space_id:'42',name:'Owner notebook',kind:'private'},{space_id:'-10042',name:'Aurora planning',kind:'group'},{space_id:'-10042/topic/7',name:'Iceland planning',kind:'topic',parent_name:'Aurora planning'},{space_id:'-10073',name:'Aurora planning',kind:'group'},...Array.from({length:103},(_,index)=>({space_id:String(-20000-index),name:'Synthetic conversation '+(index+1),kind:'group'}))].sort((a,b)=>a.space_id.localeCompare(b.space_id));
let mode='normal';const assignments=[{space_id:'-10042',project_id:project.id,mode:'assigned',revision:1}];
const memoryRequest={id:id(4),destination:'-10042',state:'pending',revision:1,expires_at:'2099-01-01T00:00:00Z',wording:'Mira prefers quiet aurora viewpoints.',relationship_path:['Mira','Aurora field guide'],evidence:[{id:id(9)}],provenance:{synthetic:true}};
const suggestion={id:id(5),kind:'person',name:'Mira Chen',candidate_entity_id:null,reason:'Two permitted sources mention this name; confirm its identity.',revision:1,source_reference:{id:id(9)}};
const action={id:id(6),fingerprint:id(7),kind:'telegram_message',scope:'42',arguments:{text:'The field guide draft is ready for your review.',destination:'-10042'},state:'proposed',created_at:now};
const proposal={id:id(8),kind:'organization',state:'review',revision:1,created_at:now,source_scope:'-10042',source_reference:{id:id(9)},affected_topics:{'-10042':['-10042/topic/7']},proposal:{kind:'organization',reason:'The planning conversation is dedicated to the aurora guide.',creates:[{key:'guide',name:'Aurora field guide supplement',description:'Evidence-backed planning notes.',evidence_ids:[id(9)]}],assignments:[{space_id:'-10042',project_key:'guide',expected_revision:0,evidence_ids:[id(9)],reason:'The topic is used for this project’s planning.',purpose_evidence:true}]}};
const decisions=[{kind:'memory_access',id:memoryRequest.id,title:'Share a specific fact',state:'pending',created_at:now,destination:'-10042',detail:memoryRequest},{kind:'entity',id:suggestion.id,title:suggestion.name,state:'pending',created_at:now,detail:suggestion},{kind:'telegram_action',id:action.id,title:'Send Telegram message',state:'proposed',created_at:now,detail:action},{kind:'knowledge',id:proposal.id,title:'Organize aurora planning',state:'review',created_at:now,detail:proposal},...Array.from({length:102},(_,index)=>({kind:'entity',id:id(100+index),title:'Synthetic identity '+(index+1),state:'pending',created_at:now,detail:{...suggestion,id:id(100+index),name:'Synthetic identity '+(index+1)}}))].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
const delegations=[{id:id(10),name:'Travel planning organization',enabled:true,scopes:['-10042','-10042/topic/7'],project_ids:[project.id],allow_create:true,expires_at:null,revision:1,capture_watermark:100,baselines:{'-10042':0,'-10042/topic/7':0},suspended_scopes:['-10042']}];
const rules=[{id:id(11),name:'Planning updates',sources:['-10042/topic/7'],destination:'-10073',enabled:false,mode:'approved',instructions:'Share scheduling details only.',revision:1}];
const page=(items,url,key)=>{const after=url.searchParams.get('after')??'',limit=Math.min(Number(url.searchParams.get('limit')||30),100),remaining=items.filter(item=>key(item)>after);return {items:remaining.slice(0,limit),total:items.length,next_cursor:remaining.length>limit?key(remaining[limit-1]):null,state:'current',observed_at:now};};
const effective=space=>({space,project,own_assignment:assignments.find(item=>item.space_id===space)??null,assignment:assignments[0],inherited:space.includes('/topic/')});
const decisionPage=url=>{const kind=url.searchParams.get('kind'),items=decisions.filter(item=>!['approved','rejected','applied'].includes(item.state)&&(!kind||item.kind===kind));return {...page(items,url,item=>item.kind+':'+item.id),totals:Object.fromEntries(['controlled_action','telegram_action','memory_access','entity','knowledge'].map(kind=>[kind,decisions.filter(item=>item.kind===kind&&!['approved','rejected','applied'].includes(item.state)).length]))};};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
const server=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url??'/','http://127.0.0.1'),path=url.pathname;
 if(path==='/fixture/scenario'){mode=url.searchParams.get('mode')??'normal';return json(res,200,{mode});}
 if(path==='/'){res.setHeader('content-type','text/html');res.end((await readFile(join(root,'dashboard/dist/index.html'),'utf8')).replace('/*NOCHEH_BOOTSTRAP*/','window.__NOCHEH_CSRF__="synthetic-only";'));return;}
 if(/^\/assets\/[a-zA-Z0-9_./-]+$/.test(path)&&!path.includes('..')){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join(root,'dashboard/dist',path.slice(8))));return;}
 const route=path.replace('/api/nocheh','');
 if(mode==='offline'&&['/decisions','/conversations','/memory/honcho'].includes(route))return json(res,503,{error:'synthetic_observation_unavailable'});
 if(req.method==='GET'){
  if(route==='/monitoring')return json(res,200,{application:{ok:true},runtime:{status:{telegram:'disabled'}},workflows:{counts:[],workers:[]},services:[]});
  if(route==='/status')return json(res,200,{archive:{events:142,artifacts:[{state:'ready',count:14}],managed_runs:[]},guard_mode:'on'});
  if(route==='/memory/honcho')return json(res,200,{connection:{attached:true,verified:true},limited_memory:true,syncing:true,workspace:null,sessions:[],receipts:[],deletions:[]});
  if(route==='/conversations')return json(res,200,page(conversations.filter(item=>(item.name+' '+item.space_id).toLowerCase().includes((url.searchParams.get('q')??'').toLowerCase())),url,item=>item.space_id));
  if(route==='/conversations/context'){const space=url.searchParams.get('space');return json(res,200,{conversation:conversations.find(item=>item.space_id===space)??{space_id:space,name:null,kind:'unknown'},state:'current',observed_at:now,addressing:{state:'current',enabled:true,group_enabled:true,granted:['42','73'],denied:[]},knowledge_access:{owner_access:space==='42',sharing_rules:rules,fact_grants:[],note:'Only this scope’s permitted sources and explicitly shared facts may be used.'},external_actions:{permissions:[],note:'Actions require exact approval or a matching permission.'},organization:{effective:effective(space),delegations,note:'Organization does not grant knowledge access.'},memory:{availability:'limited',syncing:true,note:'Sources are still preparing.'}});}
  if(route==='/decisions')return json(res,200,decisionPage(url));
  if(route.startsWith('/decisions/')){const [, ,kind,identity]=route.split('/'),item=decisions.find(item=>item.kind===kind&&item.id===identity);return json(res,item?200:404,item?{...item,...(mode==='knowledge-stale'&&kind==='knowledge'?{state:'stale',detail:{...item.detail,state:'stale',error_code:'knowledge_dependencies_changed'}}:{}),observation:['stale','knowledge-stale'].includes(mode)?'stale':'current'}:{error:'decision_not_found'});}
  if(route==='/tools/actions')return json(res,200,{actions:[],telegram:[action],permissions:[]});
  if(route==='/tools/actions/'+action.id)return json(res,200,action);
  if(route==='/projects')return json(res,200,{projects:[project],next:null});
  if(route==='/projects/assignments')return json(res,200,{assignments,next:null});
  if(route==='/projects/effective')return json(res,200,effective(url.searchParams.get('space')));
  if(route==='/projects/'+project.id+'/context')return json(res,200,{project,conversations:conversations.filter(item=>item.space_id.startsWith('-10042')).map(item=>({...item,effective:effective(item.space_id)})),knowledge:{items:[{id:id(12),subject:'Field guide tone and sources',kind:'guidance',revision:1}],total:1,next_cursor:null},decisions:decisionPage(new URL('http://fixture?kind=knowledge'))});
  if(route==='/organization/delegations')return json(res,200,{delegations,next:null});
  if(route==='/knowledge/proposals')return json(res,200,{proposals:[proposal],next:null});
  if(route==='/knowledge/proposals/'+proposal.id)return json(res,200,proposal);
  if(route==='/sharing/rules')return json(res,200,{rules,next:null});
  if(route==='/sharing/previews')return json(res,200,{previews:[],next:null});
  if(route==='/sharing/releases')return json(res,200,{releases:[],next:null});
 }
 if(req.method==='POST'){
  let content='';for await(const part of req)content+=part;const body=JSON.parse(content||'{}');
  if(mode==='save-failure')return json(res,409,{error:'synthetic_version_changed'});
  if(route==='/organization/delegations'){const saved={...body,id:body.id??id(50),revision:body.expected_revision+1,suspended_scopes:body.resume_scopes?.length?[]:delegations.find(item=>item.id===body.id)?.suspended_scopes??[]};const index=delegations.findIndex(item=>item.id===saved.id);if(index<0)delegations.push(saved);else delegations[index]=saved;return json(res,200,saved);}
  if(route==='/sharing/rules'){const saved={...body,id:body.id??id(51),revision:body.expected_revision+1};const index=rules.findIndex(item=>item.id===saved.id);if(index<0)rules.push(saved);else rules[index]=saved;return json(res,200,saved);}
  if(route==='/projects'){Object.assign(project,body,{revision:body.expected_revision+1});return json(res,200,project);}
  if(route==='/projects/assignments'){const saved={...body,revision:body.expected_revision+1};assignments.push(saved);return json(res,200,saved);}
  if(route.endsWith('/decide')||route==='/tools/telegram-decision'){
   const identity=body.id??route.split('/').at(-2),item=decisions.find(item=>item.id===identity);if(item){item.state=['reject','deny'].includes(body.decision)?'rejected':'approved';item.detail.state=item.state;}
   if(identity===proposal.id){proposal.state=body.decision==='approve'?'queued':'cancelled';proposal.revision++;}
   return json(res,200,{state:item?.state??'saved'});
  }
 }
 return json(res,404,{error:'synthetic_route_not_implemented'});
})().catch(error=>json(res,500,{error:error.message}));});
server.listen(port,'127.0.0.1',()=>process.stdout.write('Synthetic supervision preview: http://127.0.0.1:'+port+'\n'));
