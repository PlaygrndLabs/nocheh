import {workflowMetrics} from '../src/workflows/metrics.js';
/** Isolated UI acceptance fixture. No poller, scheduler, provider, or effect executor. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {DashboardSessions} from '../src/dashboard-auth.js';
import {HttpError,json,readJson} from '../src/http.js';
import {requestWorkflow} from '../src/workflows/store.js';
import {listWorkflows,workflowHealth,workflowDetail,controlWorkflow} from '../src/workflows/owner.js';
if(process.env.NOCHEH_WORKFLOW_FIXTURE!=='1')throw Error('synthetic_fixture_opt_in_required');
const pool=new pg.Pool(),sessions=new DashboardSessions(),port=Number(process.env.NOCHEH_DASHBOARD_PORT||18848);
await initialize(pool);
const client=await pool.connect();try{
 for(let i=0;i<90;i++){
  const family=(['browser','imports','tools','telegram','honcho','memory_review','preparation'] as const)[i%7]!;
  const id=await requestWorkflow(client,family,'ui-fixture-'+i);
  const state=i%11===0?'retryable_failed':i%13===0?'ambiguous':i%17===0?'failed':i%7===0?'waiting':i%9===0?'running':'completed';
  await client.query("UPDATE workflow_registry SET state=$2,created_at=now()-($3*interval '80 minutes'),updated_at=now()-($3*interval '80 minutes')+interval '47 seconds',stage=$4,attempts=1 WHERE id=$1 AND revision=1",[id,state,i+1,family==='honcho'?'sync':'execution']);
 }
 await client.query("INSERT INTO workflow_worker_registrations(family,version,app) SELECT family,1,CASE WHEN family IN ('tools','imports') THEN 'host' ELSE 'pipeline' END FROM workflow_owners ON CONFLICT(family) DO UPDATE SET seen_at=now()");
}finally{client.release();}
const id='a'.repeat(64),profile='fixture-owner';
const source={id,event:{text:'A synthetic conversation about the northern lights.',payload:{message:{message_id:1,text:'A synthetic conversation about the northern lights.'}},scope:'42',source_id:'fixture',channel:'telegram',received_at:new Date().toISOString()},artifacts:[],derived:[],derivative_versions:true};
const voiceId='b'.repeat(64),voiceFileId='c'.repeat(64);
const voice={id:voiceId,event:{kind:'telegram_update',text:null,payload:{message:{message_id:2,voice:{file_id:'synthetic-voice',duration:3,mime_type:'audio/wav'}}},scope:'42',source_id:'fixture-voice',channel:'telegram',received_at:new Date().toISOString()},
 artifacts:[{id:voiceFileId,kind:'voice',metadata:{duration:3,mime_type:'audio/wav'},state:'ready'}],derived:[{id:'d'.repeat(64),artifact_id:voiceFileId,kind:'transcript',content_base64:Buffer.from('Synthetic voice transcript for preview verification.').toString('base64'),provenance:{producer:'synthetic-preview'}}]};
const voiceBytes=Buffer.alloc(44+24000,128);
voiceBytes.write('RIFF',0);voiceBytes.writeUInt32LE(voiceBytes.length-8,4);voiceBytes.write('WAVEfmt ',8);voiceBytes.writeUInt32LE(16,16);voiceBytes.writeUInt16LE(1,20);voiceBytes.writeUInt16LE(1,22);voiceBytes.writeUInt32LE(8000,24);voiceBytes.writeUInt32LE(8000,28);voiceBytes.writeUInt16LE(1,32);voiceBytes.writeUInt16LE(8,34);voiceBytes.write('data',36);voiceBytes.writeUInt32LE(24000,40);
let modeRevision=false;
let revision=1,guarded='A synthetic conversation about the northern lights.',settingsRevision='fixture-1';
let retirementRevision=0,retired=false;const retirementHistory:any[]=[];
let settingsChanges:Record<string,unknown>={};
/** Which provider and model each part uses, as owner monitoring reports it; never a key. */
function modelRoutes() {
  const setting=(key:string)=>String(settingsChanges[key]??fields.find(f=>f.key===key)?.value??'');
  const customs:{id:string;name:string}[]=JSON.parse(setting('NOCHEH_PROVIDERS')||'[]');
  const name=(id:string)=>({openai:'OpenAI',anthropic:'Anthropic'} as Record<string,string>)[id]??customs.find(c=>c.id===id)?.name??id;
  const parts=[['reply','Replies (Hermes)','REPLY'],['memory','Memory (Honcho)','MEMORY'],['guard','Secret check','GUARD']].map(([part,label,key])=>{
    const provider=setting(`NOCHEH_${key}_PROVIDER`)||setting('NOCHEH_PROVIDER');
    return {part,label,provider,provider_name:provider?name(provider):'',model:provider?setting(`NOCHEH_${key}_MODEL`)||setting('NOCHEH_MODEL'):'',configured:!!provider};
  });
  const embedding=setting('NOCHEH_EMBEDDING_PROVIDER')||'openai';
  return [...parts,{part:'embedding',label:'Memory search',provider:embedding,provider_name:name(embedding),model:setting('NOCHEH_EMBEDDING_MODEL'),configured:true}];
}
const fields=[{key:'TELEGRAM_ENABLED',value:'false',editable:true},{key:'TELEGRAM_OWNER_ID',value:'42',editable:true},{key:'TELEGRAM_GROUP_IDS',value:'-10042',editable:true},{key:'TELEGRAM_GROUP_ACCESS',value:'{}',editable:true},{key:'TELEGRAM_GROUP_REPLIES',value:'addressed',editable:true},{key:'TELEGRAM_BOT_NAMES',value:'Nocheh,نوچه',editable:true},{key:'TELEGRAM_TOPIC_MEMORY',value:'group',editable:true},{key:'NOCHEH_MODEL',value:'claude-sonnet-5-5',editable:true},{key:'NOCHEH_EMBEDDING_MODEL',value:'text-embedding-3-small',editable:true},{key:'NOCHEH_PROVIDER',value:'',editable:true},{key:'NOCHEH_REPLY_PROVIDER',value:'',editable:true},{key:'NOCHEH_REPLY_MODEL',value:'',editable:true},{key:'NOCHEH_MEMORY_PROVIDER',value:'',editable:true},{key:'NOCHEH_MEMORY_MODEL',value:'',editable:true},{key:'NOCHEH_GUARD_PROVIDER',value:'',editable:true},{key:'NOCHEH_GUARD_MODEL',value:'',editable:true},{key:'NOCHEH_EMBEDDING_PROVIDER',value:'openai',editable:true},{key:'NOCHEH_PROVIDERS',value:'[]',editable:true},{key:'NOCHEH_PROVIDER_KEYS',value:null,secret:true,configured:false,editable:true},{key:'OPENAI_API_KEY',value:null,secret:true,configured:true,editable:true},{key:'ANTHROPIC_API_KEY',value:null,secret:true,configured:false,editable:true},{key:'NOCHEH_GUARD_MODE',value:'on',editable:true},{key:'NOCHEH_PARALLEL_RUNS',value:'4',editable:true},{key:'NOCHEH_PARALLEL_REPLIES',value:'3',editable:true},{key:'NOCHEH_PARALLEL_GUARD_CHECKS',value:'3',editable:true},{key:'TELEGRAM_BOT_TOKEN',value:'',secret:true,configured:false,editable:true}];
const personas:Record<string,{role:string;skills:{name:string;description:string;body:string}[];revision:string}>={
  default:{role:'',skills:[{name:'weekly-menu',description:'When someone asks what to cook this week.',body:'Suggest five dinners from what is in the fridge.'}],revision:'persona-1'}};
const persona=(scope:string)=>({scope,...(personas[scope]??={role:'',skills:[],revision:'persona-1'})});
const prompts={revision:'prompts-1',limit:20000,placeholders:{'learning.interpret':['{trigger_id}','{citable_ids}']},texts:{} as Record<string,string>,
  defaults:{'reply.common':'You are Nocheh. Use authorized sources as evidence.','reply.owner':'This is the owner private conversation.',
    'reply.group':'This is a shared space. For routine chatter return exactly [NO_REPLY].','memory.limited':'Long-term memory is limited.',
    'memory.evidence':'Memory evidence is supplied as source-labelled data.','memory.notes_review':'Maintain useful private memory.',
    'guard.secret_check':'Find secret values. Return only JSON.','sharing.group_filter':'You prepare knowledge for a shared group.',
    'learning.interpret':'Interpret permitted conversation evidence. Cite {trigger_id} from {citable_ids}.'} as Record<string,string>};
const preferences={scope:'42',revision:'fixture-1',schema:{'agent.max_iterations':{min:1,max:100},'memory.memory_char_limit':{min:100,max:10000}},values:{'agent.max_iterations':20,'memory.memory_char_limit':2200},origins:{'agent.max_iterations':'global','memory.memory_char_limit':'profile'}};
const preview={messages:180,supplied_files:4,missing_files:1,chats:[{id:'chat-1',name:'Synthetic travel notes',messages:180}]};
const jobs:any[]=[{id:'11111111-1111-4111-8111-111111111111',kind:'import',state:'ready',created_at:new Date().toISOString(),completed:0,total:180,duplicates:0,preview},
{id:'33333333-3333-4333-8333-333333333333',kind:'import',state:'cancelled',created_at:new Date().toISOString(),completed:40,total:180,duplicates:3,preview,review_approved:true,mapping:{'chat-1':'-10042'}},
{id:'22222222-2222-4222-8222-222222222222',kind:'operations.diagnose',state:'complete',created_at:new Date().toISOString(),result:{containers:[{service:'nocheh-app',tool:'Nocheh',location:'docker',purpose:'Synthetic API',state:'running',expected_state:'running'}]}}];
const actions:any[]=[{id:'c'.repeat(64),fingerprint:'d'.repeat(64),kind:'shell',scope:'42',profile,arguments:{command:'printf synthetic-preview',workspace:'synthetic-demo'},state:'proposed',created_at:new Date().toISOString()}],permissions:any[]=[];
let spaceRevision=1,spaceOverrides:Record<string,any>={mode:'approved'},shares:any[]=[];
/** System and Usage fixtures: maintenance history, reply timing, storage and the read-only database browser. Synthetic only. */
const hoursAgo=(h:number)=>new Date(Date.now()-h*36e5).toISOString();
jobs.push({id:'44444444-4444-4444-8444-444444444444',kind:'settings.apply',state:'complete',created_at:hoursAgo(3),result:{status:'applied'}},
 {id:'55555555-5555-4555-8555-555555555555',kind:'operations.export',state:'complete',created_at:hoursAgo(26),result:{status:'exported',events:1842,files:28}},
 {id:'66666666-6666-4666-8666-666666666666',kind:'settings.apply',state:'failed',created_at:hoursAgo(50),error:'operation_failed',result:{status:'apply_failed',rolled_back:true}},
 {id:'77777777-7777-4777-8777-777777777777',kind:'operations.backup',state:'complete',created_at:hoursAgo(72),result:{status:'backed_up'}});
const timingStages:[string,string,string,number][]=[['capture','internal','capture → archive',180],['queue:telegram','workflow','dispatch queue wait',420],['step:telegram','internal','dispatch steps',260],['hermes_queue','workflow','Hermes run queue',150],['memory_recall','third_party','Honcho context',610],['history_prepare','internal','Hermes history',90],['conversation','internal','tools + agent',540],['llm','llm','provider wait',3900],['model_guard','internal','model guard',230],['telegram_send','third_party','Telegram send',340]];
const timingIds=Array.from({length:12},(_,i)=>(0x70+i).toString(16).repeat(32));
const timingFor=(id:string)=>{const n=timingIds.indexOf(id),scale=1+((n*37)%10)/8;const stages=timingStages.map(([stage,category,label,ms])=>({stage,category,label,ms:Math.round(ms*scale),calls:stage==='llm'?2:1}));const unmeasured=Math.round(120*scale),reply=stages.reduce((t,s)=>t+s.ms,0)+unmeasured;
 return {event_id:id,started_at:hoursAgo(n*1.7+0.2),ended_at:hoursAgo(n*1.7+0.2-reply/36e5),reply_ms:reply,complete:n!==5,attempts:n===3?2:1,stages:[...stages,{stage:'unmeasured',category:'unmeasured',label:'unmeasured',ms:unmeasured,calls:0}],unmeasured_ms:unmeasured};};
const browserDatabases=[['archive','Archive','postgres','nocheh_archive'],['derived','Derived','postgres','nocheh_derived'],['control','Control','postgres','nocheh_control'],['workflow','Workflow · Inngest','postgres','nocheh_inngest'],['hermes:fixture-owner','Hermes · fixture-owner','sqlite','state.db'],['usage','Model usage','sqlite','usage.sqlite']] as const;
const browserRows=Array.from({length:73},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),channel:i%3?'telegram':'browser',scope:i%4?'42':'-10042',text:i%9===0?null:'Synthetic message '+(i+1)+' about stargazing plans.',received_at:hoursAgo(i*2)}));
let memoryAttached=true;
const serviceRows=[['nocheh-app','Nocheh','Archive API and workflow handlers','running'],['nocheh-executor','Nocheh','Approved execution','running'],['hermes','Hermes','Assistant runtime','running'],['honcho-api','Honcho','Memory engine','unhealthy'],['pgweb-archive','pgweb','Optional archive inspection','optional-stopped']].map(([service,tool,purpose,state])=>({service,tool,purpose,state,location:'docker',expected_state:state==='optional-stopped'?state:'running'}));
const personId='1'.repeat(64),projectEntityId='2'.repeat(64),projectId='ab'.repeat(32),factId='3'.repeat(64),requestId='4'.repeat(64),grantId='5'.repeat(64),conversation='-10042',topic='-10042/topic/7';
const memoryMapNodes:any[]=[
 {id:`person:${personId}`,kind:'person',label:'Mira Chen',state:'active',detail:{revision:2,fact_count:2}},
 {id:`project:${projectEntityId}`,kind:'project',label:'Aurora field guide',state:'active',detail:{revision:1,project_id:projectId,project:{id:projectId,name:'Aurora field guide',description:'Synthetic project for the isolated preview.',state:'active',revision:1}}},
 {id:`conversation:${conversation}`,kind:'conversation',label:'Friends travel group',detail:{space_id:conversation,assignment:{space_id:conversation,project_id:projectId,mode:'assigned',revision:1}}},
 {id:`topic:${topic}`,kind:'topic',label:'Topic 7 · Iceland planning',detail:{space_id:topic,parent:conversation,assignment:{space_id:topic,project_id:null,mode:'inherit',revision:1}}},
 {id:`fact:${factId}`,kind:'fact',label:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',state:'active',detail:{revision:1,predicate:'preference',attribution:'direct',uncertainty:'explicit',evidence:[{id}],author:'fixture-owner',created_at:new Date().toISOString()}},
];
const memoryMapEdges:any[]=[
 {id:`relationship:fact:${factId}`,kind:'relationship',source:`person:${personId}`,target:`fact:${factId}`,label:'preference',authoritative:false,detail:{claim_id:factId,content:memoryMapNodes[4].label,attribution:'direct',uncertainty:'explicit',evidence:[{id}],revision:1}},
 {id:`project_assignment:${conversation}`,kind:'project_assignment',source:`project:${projectEntityId}`,target:`conversation:${conversation}`,label:'contains',authoritative:false,detail:{destination:conversation,project_id:projectId,mode:'assigned',revision:1}},
 {id:`access:${grantId}`,kind:'access',source:`fact:${factId}`,target:`topic:${topic}`,state:'active',label:'persistent',authoritative:true,detail:{grant_id:grantId,destination:topic,wording:'Mira prefers quiet aurora viewpoints.',mode:'persistent',revision:1,fact_revision:1}},
 {id:`suggestion:${requestId}`,kind:'suggestion',source:`fact:${factId}`,target:`conversation:${conversation}`,state:'pending',label:'suggested',authoritative:false,detail:{request_id:requestId,destination:conversation,wording:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',revision:1,fact_revision:1,relationship_path:['Mira Chen','Aurora field guide'],evidence:[{id}],expires_at:new Date(Date.now()+86400000).toISOString()}},
];
const conversations:any[]=[
 {space_id:'42',name:'Owner',kind:'private',parent_space:null,parent_name:null,observed_at:new Date().toISOString(),configured:true},
 {space_id:'73',name:'Mira Chen',kind:'private',parent_space:null,parent_name:null,observed_at:new Date().toISOString(),configured:false},
 {space_id:conversation,name:'Aurora planning',kind:'group',parent_space:null,parent_name:null,observed_at:new Date().toISOString(),configured:true},
 {space_id:topic,name:'Iceland planning',kind:'topic',parent_space:conversation,parent_name:'Aurora planning',observed_at:new Date().toISOString(),configured:false,closed:false},
];
permissions.push({id:'6'.repeat(64),kind:'shell',scope:conversation,arguments:{command:'printf synthetic-group'},remaining:2,expires_at:new Date(Date.now()+3600000).toISOString()});
const memoryAccessRequest={id:requestId,destination:conversation,state:'pending',revision:1,expires_at:new Date(Date.now()+86400000).toISOString(),wording:'Mira prefers quiet aurora viewpoints away from tour-bus routes.',relationship_path:['Mira Chen','Aurora field guide'],evidence:[{id}],provenance:{fixture:true}};
const memoryGrant={id:grantId,destination:topic,fact_id:factId,fact_revision:1,mode:'persistent',state:'active',revision:1,wording:'Mira prefers quiet aurora viewpoints.',suspended_reason:null,provenance:{fixture:true}};
// Chats page: sharing rules, shared texts, suggestion settings and project assignments (synthetic, in memory).
const sharingRules:any[]=[{id:'7'.repeat(64),name:'Trip notes from the topic',enabled:true,sources:[topic],destination:conversation,mode:'approved',instructions:'',revision:1}];
const sharingPreviews:any[]=[{id:'8'.repeat(64),rule_id:'7'.repeat(64),rule_revision:1,state:'ready',created_at:new Date(Date.now()-7200000).toISOString(),text:'We land in Reykjavik on the 3rd and stay two nights.'}];
const sharingReleases:any[]=[];
const memorySettings:any[]=[{destination:'*',suggestions:'related',notify_owner:true,auto_followup:true,request_ttl_seconds:86400,default_grant_mode:'one_time',revision:1}];
const assignments:any[]=[{space_id:conversation,project_id:projectId,mode:'assigned',revision:1}];
// Memory page: learned facts, people and their facts, projects, automatic organizing, long-term memory (synthetic, in memory).
const hx=(s:string)=>s.repeat(64/s.length),minutesAgo=(m:number)=>new Date(Date.now()-m*60000).toISOString();
const memoryProjects:any[]=[memoryMapNodes[1].detail.project,{id:hx('cd'),name:'Garden redesign',description:'Ideas and suppliers for the back garden.',state:'active',revision:1},{id:hx('ce'),name:'Old apartment move',description:'',state:'archived',revision:2}];
const devonId=hx('d1');
const people:any[]=[{id:personId,kind:'person',name:'Mira Chen',state:'active',project_id:null,merged_into:null,revision:2},{id:devonId,kind:'person',name:'Devon',state:'active',project_id:null,merged_into:null,revision:1},
 {id:projectEntityId,kind:'project',name:'Aurora field guide',state:'active',project_id:projectId,merged_into:null,revision:1}];
const claim=(id:string,subject:string,object:string|null,predicate:string,content:string,extra:any={})=>({id,subject_entity_id:subject,object_entity_id:object,predicate,revision:1,content,relationship_kind:object?'associated':null,attribution:'direct',speaker_entity_id:subject,uncertainty:'explicit',author:'learning',retired:false,evidence:[{id}],created_at:minutesAgo(900),...extra});
const claims:any[]=[claim(factId,personId,null,'preference','Mira prefers quiet aurora viewpoints away from tour-bus routes.'),
 claim(hx('d2'),personId,devonId,'travel_partner','Mira and Devon are planning the Iceland trip together.',{relationship_kind:'participates',uncertainty:'supported'}),
 claim(hx('d3'),devonId,null,'diet','Devon is vegetarian.',{attribution:'reported',uncertainty:'supported'}),
 claim(hx('d4'),projectEntityId,null,'scope','The field guide covers viewpoints within two hours of Reykjavik.')];
const learnedEntry=(key:string,subject:string,kind:string,scope_kind:string,scope_id:string,texts:string[],extra:any={})=>{const learning={subject,kind,scope:{kind:scope_kind,id:scope_id},uncertainty:extra.uncertainty??'supported',evidence:[{id}],conflicts:extra.conflicts??[]};
 const versions=texts.map((text,index)=>({revision:index+1,text,author:index&&extra.author?extra.author:'learning',retired:false,created_at:minutesAgo(2000-index*600),evidence:[{id}],provenance:{learning,producer:'synthetic-preview'}}));
 const last=versions.at(-1)!;if(extra.retired)last.retired=true;
 return {entry:{id:hx(key),subject,kind,scope_kind,scope_id,active_revision:last.revision,text:last.text,author:last.author,retired:!!extra.retired,revised_at:last.created_at,provenance:last.provenance},versions};};
const learnedRows=[learnedEntry('e1','“The cabin”','meaning','conversation',conversation,['“The cabin” means the rented cottage near Vík for the March trip.']),
 learnedEntry('e2','Flight booking','state','conversation',topic,['Flights for the Iceland trip are not booked yet.','Flights for the Iceland trip are booked; hotels are still open.'],{author:'owner',uncertainty:'explicit'}),
 learnedEntry('e3','Photo naming','convention','project',projectId,['Aurora photos are named by date and place, for example 2027-03-04-vik.'],{uncertainty:'explicit'}),
 learnedEntry('e4','“The cabin”','meaning','conversation',conversation,['“The cabin” may mean Devon’s family house in the north.'],{uncertainty:'uncertain',conflicts:[hx('e1')]}),
 learnedEntry('e5','Weekly call','state','conversation','42',['The weekly family call is on Sundays.'],{retired:true})];
const learned:any[]=learnedRows.map(row=>row.entry),learnedVersions:Record<string,any[]>=Object.fromEntries(learnedRows.map(row=>[row.entry.id,row.versions]));
const factGrants:any[]=[];
const delegations:any[]=[{id:hx('d5'),name:'Organize the travel group',enabled:true,scopes:[conversation,topic],project_ids:[projectId],allow_create:true,expires_at:null,revision:1,baseline_suspended:[topic]}];
const delegationView=(d:any)=>({...d,baseline_suspended:undefined,suspended_scopes:d.baseline_suspended.filter((s:string)=>d.scopes.includes(s)),expired:!!d.expires_at&&new Date(d.expires_at)<=new Date()});
const pastProposals:any[]=[{id:hx('d6'),kind:'organization',state:'applied',revision:2,created_at:minutesAgo(4000),source_scope:conversation,proposal:{kind:'organization',reason:'Put the travel group in the Aurora field guide project.'}}];
const honchoBudget:any={limit_cents:500,max_limit_cents:1500,revision:3,mode:'monthly',limit_usd:5,counted_toward_cap_usd:1.27,remaining_usd:3.73,estimated_embedding_cost_usd:0.94,embedding_tokens:47000,embedding_requests:312,embedding_reported_requests:310,embedding_unreported_requests:2,embedding_hold_usd:0.01,released_error_holds_usd:0,legacy_error_exposure_unverified_usd:0,reasoning_requests:184,reasoning_request_limit:2000,reasoning_remaining_requests:1816,window_started_at:new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString()};
let memoryRevision=4,memoryIncludeHistory=true;
let failedLearning=3;
const fixtureProject=(pid?:string)=>memoryProjects.find(p=>p.id===pid)??memoryMapNodes[1].detail.project;
function effectiveProject(space:string){const parent=space.includes('/topic/')?space.split('/topic/')[0]:null,own=assignments.find(a=>a.space_id===space)??null,inherited=!own||own.mode==='inherit',chosen=inherited?assignments.find(a=>a.space_id===parent):own;
 return {space,own_assignment:own,assignment:chosen??null,project:chosen?.project_id?fixtureProject(chosen.project_id):null,inherited:!!chosen&&inherited};}
const previewView=(row:any)=>({...row,input:{rule:sharingRules.find(r=>r.id===row.rule_id),sources:[{id}]},guard_revision:1,text_hash:'9'.repeat(64),current:sharingRules.find(r=>r.id===row.rule_id)?.revision===row.rule_revision,output_provenance:{fixture:true}});
// Inbox fixtures: synthetic decided actions, Telegram messages, an identity suggestion and an organization proposal.
const inboxAgo=(minutes:number)=>new Date(Date.now()-minutes*60000).toISOString();
actions.push({id:'7'.repeat(64),event_id:id,fingerprint:'7a'.repeat(32),kind:'browser',scope:conversation,profile,arguments:{url:'https://example.org/aurora-forecast'},state:'done',revision:3,created_at:inboxAgo(190),result:{text:'Aurora forecast: Kp 5 expected tonight, clear skies after 22:00.'}},
 {id:'8'.repeat(64),event_id:id,fingerprint:'8a'.repeat(32),kind:'shell',scope:'42',profile,arguments:{command:'rm -rf ./synthetic-cache'},state:'rejected',revision:2,created_at:inboxAgo(1500)});
const telegramActions:any[]=[{id:'ab'.repeat(32),event_id:id,fingerprint:'ba'.repeat(32),kind:'telegram_message',scope:'42',profile,arguments:{destination:conversation,text:'Hi all, the cabin is booked for 14 to 18 March. Bring warm layers for the aurora nights!'},state:'proposed',revision:1,created_at:inboxAgo(12),result:null},
 {id:'cd'.repeat(32),event_id:id,fingerprint:'dc'.repeat(32),kind:'telegram_message',scope:'42',profile,arguments:{destination:topic,text:'Reminder: flights land at 09:40.'},state:'done',revision:3,created_at:inboxAgo(2900),result:{delivered:true}}];
const memoryAccessCreated=inboxAgo(40);
const entitySuggestion:any={id:'0'.repeat(64),kind:'person',name:'Nia Okafor',candidate_entity_id:null,source_reference:{id},reason:'Mentioned twice in Aurora planning as the person booking the cabin.',status:'pending',revision:1,created_at:inboxAgo(300)};
const knowledgeProposal:any={id:'f'.repeat(64),kind:'organization',origin:'learning',state:'review',revision:1,approved:false,created_at:inboxAgo(95),source_scope:conversation,source_reference:{id},error_code:null,result:null,decision_history:[],affected_topics:{},
 proposal:{kind:'organization',reason:'The Iceland topic is all about one trip; a project keeps its notes together.',creates:[{key:'trip',name:'Iceland trip 2027',description:'Planning the March aurora trip with friends.',evidence_ids:[id]}],assignments:[{space_id:topic,project_key:'trip',reason:'Every recent message in this topic is about the trip.',evidence_ids:[id],expected_revision:1}]}};
function inboxDecisions(){
 const summary=(kind:string,row:any,extra:any)=>({kind,id:row.id,state:row.state??row.status,revision:row.revision??1,created_at:row.created_at,source_scope:null,destination:null,fingerprint:null,...extra});
 return [...actions.filter(a=>['proposed','ambiguous'].includes(a.state)).map(a=>summary('controlled_action',a,{title:a.kind,source_scope:a.scope,fingerprint:a.fingerprint})),
  ...telegramActions.filter(a=>['proposed','ambiguous'].includes(a.state)).map(a=>summary('telegram_action',a,{title:'Send Telegram message',source_scope:a.scope,destination:a.arguments.destination,fingerprint:a.fingerprint})),
  ...(memoryAccessRequest.state==='pending'?[summary('memory_access',{...memoryAccessRequest,created_at:memoryAccessCreated},{title:'Share a specific fact',source_scope:conversation,destination:memoryAccessRequest.destination})]:[]),
  ...(entitySuggestion.status==='pending'?[summary('entity',entitySuggestion,{title:entitySuggestion.name})]:[]),
  ...(['review','stale','failed'].includes(knowledgeProposal.state)?[summary('knowledge',knowledgeProposal,{title:knowledgeProposal.kind,source_scope:knowledgeProposal.source_scope})]:[])];
}
function inboxRecord(kind:string,recordId:string):any{
 if(kind==='controlled_action')return actions.find(a=>a.id===recordId);
 if(kind==='telegram_action')return telegramActions.find(a=>a.id===recordId);
 if(kind==='memory_access'&&recordId===requestId)return {...memoryAccessRequest,source_scope:conversation,fact_id:factId,fact_revision:1,current_fact_revision:1,created_at:memoryAccessCreated};
 if(kind==='entity'&&recordId===entitySuggestion.id)return entitySuggestion;
 if(kind==='knowledge'&&recordId===knowledgeProposal.id)return knowledgeProposal;
}
/** Messages page fixture: synthetic kept messages, the assistant's copies, hiding, versions and imports. */
const messagesFixture=(()=>{
 const hex=(n:string)=>n.repeat(32),ago=(minutes:number)=>new Date(Date.now()-minutes*60000).toISOString();
 const ids={tour:hex('e1'),tourReply:hex('e2'),forecast:hex('e3'),packing:hex('e4'),booking:hex('e5'),rejected:hex('e6'),archivedVoice:hex('e7'),photo:hex('e8'),reaction:hex('e9'),browser:hex('ea'),browserReply:hex('eb')};
 const photoFile=hex('f1'),archivedVoiceFile=hex('f2'),transcriptVersion=hex('d1'),olderTranscript=hex('d2'),archivedStatus=hex('d3');
 const owner={id:42,first_name:'Owner'},mira={id:73,first_name:'Mira',last_name:'Chen'};
 type Message={id:string;scope:string;kind:string;text:string|null;minutes:number;payload:any;state?:string;error?:string;attempts?:number;retired?:boolean;action?:any;replies?:string[];artifacts?:any[];derived?:any[];transcript?:string};
 const telegram=(message_id:number,from:any,extra:any={})=>({message:{message_id,from,chat:{id:42},...extra}});
 const list:Message[]=[
  {id:ids.tour,scope:'42',kind:'telegram_update',text:'Can you remind me what time the aurora tour starts on Friday?',minutes:12,payload:telegram(201,owner,{text:'Can you remind me what time the aurora tour starts on Friday?'}),state:'done',replies:[ids.tourReply]},
  {id:ids.tourReply,scope:'42',kind:'telegram_delivered_message',text:'The tour leaves at 21:30 from the harbour car park. Bring warm layers and a flask.',minutes:11,payload:telegram(202,{id:1,first_name:'Nocheh',is_bot:true},{text:'The tour leaves at 21:30 from the harbour car park. Bring warm layers and a flask.'})},
  {id:ids.forecast,scope:'-10042',kind:'telegram_update',text:'@Nocheh what is the Kp forecast for tonight?',minutes:40,payload:telegram(88,mira,{text:'@Nocheh what is the Kp forecast for tonight?'}),state:'failed',error:'model_unavailable',attempts:2},
  {id:ids.packing,scope:'42',kind:'telegram_update',text:'Send the packing list to Mira when you can.',minutes:95,payload:telegram(199,owner,{text:'Send the packing list to Mira when you can.'}),state:'ambiguous',error:'delivery_unconfirmed'},
  {id:ids.booking,scope:'42',kind:'telegram_update',text:'Please book the 22:00 slot for two people.',minutes:130,payload:telegram(197,owner,{text:'Please book the 22:00 slot for two people.'}),state:'running',action:{id:'c'.repeat(64),state:'proposed',count:1}},
  {id:ids.rejected,scope:'-10042',kind:'telegram_update',text:'Can someone share the meeting point pin?',minutes:300,payload:telegram(80,mira,{text:'Can someone share the meeting point pin?'}),state:'suppressed',error:'telegram_rejected'},
  {id:voiceId,scope:'42',kind:'telegram_update',text:null,minutes:420,payload:voice.event.payload,state:'done',artifacts:voice.artifacts.map(a=>({...a,file_hash:hex('9c')})),derived:voice.derived.map(d=>({...d,id:transcriptVersion})),transcript:'Synthetic voice transcript for preview verification.'},
  {id:ids.archivedVoice,scope:'42',kind:'telegram_update',text:null,minutes:600,payload:telegram(190,owner,{voice:{file_id:'synthetic-voice-2',duration:14,mime_type:'audio/ogg'}}),state:'suppressed',error:'unsupported_message',
   artifacts:[{id:archivedVoiceFile,kind:'voice',metadata:{duration:14,mime_type:'audio/ogg'},state:'ready',file_hash:hex('9a')}],derived:[{id:archivedStatus,event_id:ids.archivedVoice,artifact_id:archivedVoiceFile,kind:'extraction_status',content_base64:Buffer.from('Voice note archived; transcription is not available.').toString('base64'),provenance:{extractor:'voice-archive-v1'}}]},
  {id:ids.photo,scope:'-10042',kind:'telegram_update',text:'Our view from the ridge last night',minutes:1500,payload:telegram(70,mira,{caption:'Our view from the ridge last night',photo:[{file_id:'synthetic-photo'}]}),state:'done',retired:true,
   artifacts:[{id:photoFile,kind:'photo',metadata:{file_name:'ridge.jpg',mime_type:'image/jpeg'},state:'ready',file_hash:hex('9b')}]},
  {id,scope:'42',kind:'telegram_update',text:source.event.text,minutes:2000,payload:source.event.payload},
  {id:ids.reaction,scope:'-10042',kind:'telegram_update',text:null,minutes:2100,payload:{message_reaction:{chat:{id:-10042},message_id:70,user:mira,new_reaction:[{type:'emoji',emoji:'👍'}]}}},
  {id:ids.browser,scope:'42',kind:'browser_input',text:'Summarize what we planned for the trip.',minutes:3000,payload:{text:'Summarize what we planned for the trip.'},replies:[ids.browserReply]},
  {id:ids.browserReply,scope:'42',kind:'browser_delivered_message',text:'Friday: aurora tour at 21:30. Saturday: ridge hike if the sky is clear.',minutes:2999,payload:{text:'Friday: aurora tour at 21:30. Saturday: ridge hike if the sky is clear.'}},
 ];
 const byId=new Map(list.map(m=>[m.id,m]));
 const contentTypes=(m:Message)=>m.kind==='telegram_update'&&m.payload.message_reaction?['reaction']:[...new Set([...(m.payload.message?.photo?['photo']:[]),...(m.artifacts??[]).map(a=>a.kind)])];
 const preview=(rid:string)=>{const r=byId.get(rid)!;return {id:r.id,text:r.text,received_at:ago(r.minutes),content_types:contentTypes(r)};};
 const retirement=new Map<string,{retired:boolean;revision:number;history:any[]}>();
 const retire=(rid:string)=>{if(!retirement.has(rid)){const retired=!!byId.get(rid)?.retired;retirement.set(rid,{retired,revision:retired?1:0,history:retired?[{revision:1,retired:true,event_id:rid,decision_authority:'owner',created_at:ago(1400)}]:[]});}return retirement.get(rid)!;};
 const row=(m:Message)=>({id:m.id,channel:m.kind.startsWith('browser')?'browser':'telegram',scope:m.scope,source_id:'synthetic-'+m.id.slice(0,6),revision:'1',kind:m.kind,origin:'live',occurred_at:ago(m.minutes),received_at:ago(m.minutes),
  ...(m.kind==='telegram_update'&&m.state?{assistant_state:m.state,assistant_stage:m.state==='running'?'execution':null,assistant_error:m.error??null,assistant_attempts:m.attempts??1}:{}),
  retired:retire(m.id).retired,...(m.action?{action_review:m.action}:{}),text:m.text,content_types:contentTypes(m),
  reaction_preview:m.payload.message_reaction?{change:'👍 added',actor:'Mira Chen',target:'70'}:null,reply_messages:(m.replies??[]).map(preview),transcript_preview:m.transcript??null});
 const record=(m:Message)=>({id:m.id,source:'nocheh:event:'+m.id,reference:{id:m.id},received_at:ago(m.minutes),representation:'original',guarded_revision:null,
  event:{version:1,key:'synthetic:'+m.id.slice(0,8),channel:m.kind.startsWith('browser')?'browser':'telegram',bot_id:'synthetic',origin:'live',scope:m.scope,source_id:'synthetic-'+m.id.slice(0,6),revision:'1',kind:m.kind,occurred_at:ago(m.minutes),text:m.text,payload:m.payload},
  artifacts:m.artifacts??[],derived:m.derived??[],relationships:[],current_reactions:[],derivative_versions:'/v1/sources/'+m.id+'/derivatives',reply_messages:(m.replies??[]).map(preview)});
 // The assistant's copies, keyed like the real store: `<kind>:<id>`.
 const guards=new Map<string,{input:any;revisions:{revision:number;content:any;author:string;created_at:string}[]}>();
 for(const m of list)if(m.id!==ids.archivedVoice)guards.set('events:'+m.id,{input:{text:m.text,payload:m.payload},revisions:[{revision:1,content:{text:m.text,payload:m.payload},author:'automatic',created_at:ago(m.minutes-1)}]});
 const tour=guards.get('events:'+ids.tour)!;tour.revisions.push({revision:2,content:{text:'Can you remind me what time the aurora tour starts on Friday (the 21:30 one)?',payload:tour.input.payload},author:'owner',created_at:ago(8)});
 for(const m of list)for(const a of m.artifacts??[])guards.set('artifacts:'+a.id,{input:{kind:a.kind,metadata:a.metadata},revisions:[{revision:1,content:{kind:a.kind,metadata:a.metadata},author:'automatic',created_at:ago(m.minutes-1)}]});
 const transcriptText='Synthetic voice transcript for preview verification.';
 const versions:any[]=[{id:transcriptVersion,event:voiceId,artifact_id:voiceFileId,kind:'transcript',text:transcriptText,producer:'synthetic-transcriber',producer_version:'2',active:true,created_at:ago(419)},
  {id:olderTranscript,event:voiceId,artifact_id:voiceFileId,kind:'transcript',text:'Synthetic voice transcript, first try.',producer:'synthetic-transcriber',producer_version:'1',active:false,created_at:ago(419.5)},
  {id:archivedStatus,event:ids.archivedVoice,artifact_id:archivedVoiceFile,kind:'extraction_status',text:'Voice note archived; transcription is not available.',producer:'voice-archive',producer_version:'1',active:true,created_at:ago(599)}];
 for(const v of versions)guards.set('derived_artifacts:'+v.id,{input:{text:v.text,kind:v.kind,provenance:{producer:v.producer}},revisions:[{revision:1,content:{text:v.text,kind:v.kind,provenance:{producer:v.producer}},author:'automatic',created_at:v.created_at}]});
 let selectionRevision=1;const reprocessing=new Map<string,number>();
 const importChats=[{id:'chat-2',name:'Synthetic hiking group',messages:64,type:'private_group'},{id:'chat-3',name:'Synthetic notes to self',messages:22,type:'saved_messages'}];
 jobs.push({id:'44444444-4444-4444-8444-444444444444',kind:'import',state:'complete',created_at:ago(9000),completed:120,files:3,bytes:2048,duplicates:4,review_approved:false,mapping:{},
  preview:{file:'result.json',sha256:hex('7c'),chats:[{id:'chat-9',name:'Synthetic book club',messages:120,type:'private_group'}],messages:120,supplied_files:6,missing_files:0}});
 const body=async(req:any)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return chunks.length?JSON.parse(Buffer.concat(chunks).toString()||'{}'):{};};
 const guardView=(key:string)=>{const g=guards.get(key);if(!g)return {id:key,state:'pending',active_revision:null};const last=g.revisions.at(-1)!;return {id:key,state:'ready',input:g.input,active_revision:last.revision,content:last.content,author:last.author,error_code:null};};
 return async(req:any,res:any,route:string,url:URL):Promise<boolean>=>{
  const method=req.method;
  if(method==='GET'&&(route==='/data'||route==='/search')){
   const q=(url.searchParams.get('q')??'').toLowerCase(),kind=url.searchParams.get('kind')??'',scope=url.searchParams.get('scope')??'',reply=url.searchParams.get('reply')??'';
   const rows=list.filter(m=>(!q||(m.text??'').toLowerCase().includes(q))&&(!scope||m.scope===scope)
    &&(!kind||kind==='incoming'&&['telegram_update','browser_input'].includes(m.kind)||kind==='assistant'&&m.kind.endsWith('_delivered_message'))
    &&(!reply||m.kind==='telegram_update'&&!m.payload.message_reaction&&(reply==='approval_pending'?m.action?.state==='proposed':reply==='not_started'?!m.state:m.state===reply))).map(row);
   json(res,200,route==='/search'?rows:{records:rows,next:null});return true;
  }
  if(method==='GET'&&route==='/scopes'){const counts=new Map<string,number>();for(const m of list)counts.set(m.scope,(counts.get(m.scope)??0)+1);json(res,200,{scopes:[...counts].map(([scope,events])=>({scope,events})),next:null});return true;}
  const event=/^\/events\/([a-f0-9]{64})$/.exec(route);
  if(method==='GET'&&event&&byId.has(event[1]!)){json(res,200,record(byId.get(event[1]!)!));return true;}
  const artifactDownload=/^\/artifacts\/([a-f0-9]{64})\/download$/.exec(route);
  if(method==='GET'&&artifactDownload&&[photoFile,archivedVoiceFile].includes(artifactDownload[1]!)){
   // A 1×1 synthetic image or the synthetic tone; never real media.
   const bytes=artifactDownload[1]===photoFile?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJYQPcbT2U2wAAAABJRU5ErkJggg==','base64'):voiceBytes;
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.end(bytes);return true;
  }
  const retirementRoute=/^\/sources\/([a-f0-9]{64})\/retirement$/.exec(route);
  if(retirementRoute&&byId.has(retirementRoute[1]!)){
   const rid=retirementRoute[1]!,m=byId.get(rid)!;
   if(m.kind.startsWith('browser'))throw new HttpError(404,'telegram_message_not_found');
   const state=retire(rid);
   if(method==='POST'){const input=await body(req);if(input.expected_revision!==state.revision)throw new HttpError(409,'source_retirement_conflict');
    state.retired=!!input.retired;state.revision++;state.history.unshift({revision:state.revision,retired:state.retired,event_id:rid,decision_authority:'owner',created_at:new Date().toISOString()});
    json(res,200,{event_id:rid,retired:state.retired,revision:state.revision,authority:'owner',observation:'not_observed'});return true;}
   const related=(m.replies??[]).map(r=>({event_id:r,relation:'reply',text:byId.get(r)!.text,received_at:ago(byId.get(r)!.minutes),retired:retire(r).retired,revision:retire(r).revision}));
   json(res,200,{event_id:rid,retired:state.retired,revision:state.revision,authority:'owner',observation:'not_observed',history:state.history,related_replies:related});return true;
  }
  const prepare=/^\/sources\/([a-f0-9]{64})\/prepare$/.exec(route);
  if(method==='POST'&&prepare&&byId.has(prepare[1]!)){const m=byId.get(prepare[1]!)!;await body(req);
   if(!guards.has('events:'+m.id))guards.set('events:'+m.id,{input:{text:m.text,payload:m.payload},revisions:[{revision:1,content:{text:m.text,payload:m.payload},author:'automatic',created_at:new Date().toISOString()}]});
   json(res,200,{workflow_id:hex('5d')});return true;}
  const guard=/^\/guards\/(events|artifacts|derived_artifacts)\/([a-f0-9]{64})(?:\/(history)|\/revisions\/(\d+))?$/.exec(route);
  if(guard){
   const key=guard[1]+':'+guard[2],g=guards.get(key);
   if(method==='GET'&&guard[3]){json(res,200,{revisions:(g?.revisions??[]).slice().reverse().map(r=>({revision:r.revision,author:r.author,preparation_version:r.author==='owner'?'owner-edit-v1':'synthetic-v1',created_at:r.created_at})),next:null});return true;}
   if(method==='GET'&&guard[4]){const r=g?.revisions.find(item=>item.revision===Number(guard[4]));if(!r)throw new HttpError(404,'guard_revision_missing');json(res,200,{source_id:key,revision:r.revision,content:r.content,author:r.author,created_at:r.created_at});return true;}
   if(method==='GET'){json(res,200,guardView(key));return true;}
   if(method==='POST'&&g){const input=await body(req);const active=g.revisions.at(-1)!.revision;
    if(input.expected_revision!==active)throw new HttpError(409,'guard_revision_conflict');
    const content='restore_revision' in input?g.revisions.find(r=>r.revision===input.restore_revision)?.content:input.content;
    if(!content)throw new HttpError(404,'guard_revision_missing');
    g.revisions.push({revision:active+1,content,author:'owner',created_at:new Date().toISOString()});json(res,200,{source_id:key,revision:active+1});return true;}
  }
  const derivatives=/^\/sources\/([a-f0-9]{64})\/derivatives$/.exec(route);
  if(method==='GET'&&derivatives){json(res,200,{versions:versions.filter(v=>v.event===derivatives[1]).map(v=>({id:v.id,artifact_id:v.artifact_id,kind:v.kind,created_at:v.created_at,source_revision:'1',input_hash:hex('3f'),content_hash:hex('4f'),producer:v.producer,producer_version:v.producer_version,configuration_hash:hex('6f'),provenance:{producer:v.producer},guard_revision:guards.get('derived_artifacts:'+v.id)?.revisions.at(-1)?.revision??null,active:v.active,selection_revision:selectionRevision})),next:null});return true;}
  const derivative=/^\/derivatives\/([a-f0-9]{64})(?:\/(activate))?$/.exec(route);
  if(derivative){const v=versions.find(item=>item.id===derivative[1]);if(!v)throw new HttpError(404,'derivative_not_found');
   if(method==='GET'&&!derivative[2]){json(res,200,{id:v.id,event_id:v.event,artifact_id:v.artifact_id,kind:v.kind,content_base64:Buffer.from(v.text).toString('base64'),producer:v.producer,producer_version:v.producer_version,source_revision:'1',input_hash:hex('3f'),configuration_hash:hex('6f'),provenance:{producer:v.producer,synthetic:true},guarded:'/v1/guards/derived_artifacts/'+v.id});return true;}
   if(method==='POST'){const input=await body(req);if(input.expected_revision!==selectionRevision)throw new HttpError(409,'selection_revision_conflict');
    for(const other of versions)if(other.event===v.event&&other.kind===v.kind)other.active=other.id===v.id;selectionRevision++;json(res,200,{revision:selectionRevision});return true;}
  }
  if(method==='GET'&&route==='/derivation-engines'){json(res,200,{engines:[{producer:'synthetic-transcriber',producer_version:'2',kind:'transcript'},{producer:'synthetic-reader',producer_version:'1',kind:'extracted_text'}]});return true;}
  const reprocess=/^\/sources\/([a-f0-9]{64})\/reprocess$/.exec(route);
  if(method==='POST'&&reprocess){await body(req);const job=hex(String(reprocessing.size%10)+'c');reprocessing.set(job,Date.now());json(res,200,{id:job,state:'queued',status_url:'/v1/reprocessing/'+job});return true;}
  const reprocessJob=/^\/reprocessing\/([a-f0-9]{64})$/.exec(route);
  if(method==='GET'&&reprocessJob&&reprocessing.has(reprocessJob[1]!)){json(res,200,{id:reprocessJob[1],state:Date.now()-reprocessing.get(reprocessJob[1]!)!>4000?'done':'running',error_code:null});return true;}
  if(method==='POST'&&route==='/jobs'){await body(req);const job={id:randomUUID(),kind:'import',state:'uploading',created_at:new Date().toISOString(),completed:0,files:0,bytes:0,duplicates:0};jobs.unshift(job);json(res,201,job);return true;}
  const upload=/^\/jobs\/([a-f0-9-]{36})\/(upload|preview)$/.exec(route);
  if(upload){const job=jobs.find(j=>j.id===upload[1]);if(!job)throw new HttpError(404,'job_not_found');
   if(method==='PUT'&&upload[2]==='upload'){if(job.state!=='uploading')throw new HttpError(409,'upload_closed');let size=0;for await(const chunk of req)size+=chunk.length;job.files++;job.bytes+=size;json(res,200,job);return true;}
   if(method==='POST'&&upload[2]==='preview'){await body(req);if(job.state!=='uploading')throw new HttpError(409,'preview_closed');
    job.preview={file:'result.json',sha256:hex('8d'),chats:importChats.map(c=>({...c,scope:'desktop:'+c.type+':'+c.id})),messages:86,supplied_files:5,missing_files:2};job.state='ready';json(res,200,job);return true;}
  }
  return false;
 };
})();
async function scenario(){try{return (await readFile('/tmp/nocheh-ui-scenario','utf8')).trim();}catch{return 'normal';}}
const server=createServer((req,res)=>{void(async()=>{
 const url=new URL(req.url||'/','http://fixture'),path=url.pathname;
 if(req.method==='GET'&&path==='/'){
  const session=sessions.page(req);res.setHeader('set-cookie',`nocheh_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  res.setHeader('content-type','text/html');res.end((await readFile('dashboard/dist/index.html','utf8')).replace('/*NOCHEH_BOOTSTRAP*/',`window.__NOCHEH_CSRF__=${JSON.stringify(session.csrf)};`));return;
 }
 if(req.method==='GET'&&/^\/assets\/(?:app\.js|style\.css|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(path)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join('dashboard/dist',path.slice(8))));return;}
 sessions.authorize(req,req.method!=='GET');
 if(['/inngest/runs','/hermes/nocheh'].includes(path)){res.setHeader('content-type','text/html');res.end('<h1>Synthetic integration boundary</h1><p>This isolated preview has no native runtime or provider. Production proxy behavior is verified by boundary tests.</p><a href="/">Return to Nocheh</a>');return;}
 const route=path.replace(/^\/api\/(?:plugins\/)?nocheh/,'');
 const mode=await scenario();if(mode==='conflict'&&!modeRevision){settingsRevision+='external';revision++;modeRevision=true;}if(mode!=='conflict')modeRevision=false;if(mode==='offline'&&['/monitoring','/workflows/metrics','/status','/tools/actions'].includes(route))throw new HttpError(503,'fixture_observation_unavailable');
 if(await messagesFixture(req,res,route,url))return;
 if(req.method==='GET'){
  if(route==='/health')return json(res,200,{ok:true});
  if(route==='/usage'){const days=Number(url.searchParams.get('days')||30),day=(ago:number)=>new Date(Date.now()-ago*864e5).toISOString().slice(0,10);
    const row=(ago:number,part:string,label:string,service:string,provider:string,provider_name:string,model:string,calls:number,input:number,output:number,cost:number|null)=>({day:day(ago),part,label,service,provider,provider_name,model,runs:calls,calls,failed:part==='memory'&&ago===0?1:0,input_tokens:input,output_tokens:output,cache_read_tokens:0,cache_write_tokens:0,reasoning_tokens:0,cost_usd:cost,cost_complete:cost!==null});
    const rows=[row(0,'reply','Telegram replies','Hermes','openai','OpenAI','gpt-5.6-sol',12,48000,3200,0.21),row(3,'reply','Telegram replies','Hermes','custom-1','Example gateway','claude-sonnet-5-5',5,20000,1500,null),
      row(0,'guard','Secret check','Nocheh','openai','OpenAI','gpt-5.6-sol',12,6000,240,0.01),row(0,'memory','Memory','Honcho','custom-1','Example gateway','claude-sonnet-5-5',9,30000,4000,null),
      row(0,'embedding','Memory search','Honcho','openai','OpenAI','text-embedding-3-small',20,8000,0,0.0002)].filter(r=>r.day>=day(days-1));
    return json(res,200,{since:day(days-1),today:day(0),days,rows,parts:[['reply','Telegram replies','Hermes'],['browser','Browser chat','Hermes'],['schedule','Scheduled runs','Hermes'],['memory_review','Memory notes','Hermes'],['guard','Secret check','Nocheh'],['memory','Memory','Honcho'],['embedding','Memory search','Honcho']].map(([id,label,service])=>({id,label,service})),sources:{hermes:'ok',honcho:'ok',pricing:'ok'}});}
  if(route==='/monitoring'){const workflows=await workflowHealth(pool);return json(res,200,{checked_at:new Date().toISOString(),telegram_enabled:false,keys:[{name:'SERVICE_TOKEN',service:'Nocheh services',usage:'Lets Nocheh’s own services and the dashboard call each other',present:true},{name:'NOCHEH_MEMORY_TOKEN',service:'Long-term memory (Honcho)',usage:'Lets Honcho’s model calls pass Nocheh’s secret check',present:false}],runtime:{status:{telegram:'disabled'}},archive:{archive:{telegram:[],workflows:[],preparation:[{state:'ready',count:180}],artifacts:[],transcriptions:[],actions:[]},guard_mode:'on'},routes:modelRoutes(),application:{ok:true,workers:{capture:'ready',workflows:'connected'}},workflows:mode==='unavailable'?{unavailable:true}:workflows,services:serviceRows});}
  if(route==='/workflows')return json(res,200,await listWorkflows(pool,Object.fromEntries(url.searchParams)));
  if(route==='/workflows/metrics')return json(res,200,await workflowMetrics(pool,Object.fromEntries(url.searchParams)));
  if(route==='/workflows/health')return json(res,200,await workflowHealth(pool));
  if(route==='/workflows/timings'){const items=timingIds.map(timingFor),done=items.filter(i=>i.complete),pct=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*v.length)-1)]!;
   return json(res,200,{observed_at:new Date().toISOString(),messages:done.length,reply_ms_p50:pct(done.map(i=>i.reply_ms),.5),reply_ms_p95:pct(done.map(i=>i.reply_ms),.95),
    stages:[...timingStages,['unmeasured','unmeasured','unmeasured',0] as const].map(([stage,category,label])=>{const v=done.map(i=>i.stages.find(s=>s.stage===stage)!.ms);return {stage,category,label,messages:v.length,ms_p50:pct(v,.5),ms_p95:pct(v,.95)};}),
    recent:items.map(i=>({event_id:i.event_id,started_at:i.started_at,reply_ms:i.reply_ms,unmeasured_ms:i.unmeasured_ms,complete:i.complete}))});}
  if(/^\/workflows\/timings\/[a-f0-9]{64}$/.test(route)){const event=route.split('/')[3]!;if(!timingIds.includes(event))throw new HttpError(404,'event_not_found');return json(res,200,timingFor(event));}
  if(route==='/storage')return json(res,200,{databases:[{database:'nocheh_archive',role:'owned originals',state:'measured',bytes:48_300_000,largest_tables:[{table:'events',bytes:31_000_000,estimated_rows:1842},{table:'artifacts',bytes:9_400_000,estimated_rows:28}]},
    {database:'nocheh_derived',role:'derived',state:'measured',bytes:12_100_000,largest_tables:[{table:'derived_artifacts',bytes:7_000_000,estimated_rows:412}]},{database:'nocheh_control',role:'operational',state:'measured',bytes:9_800_000,largest_tables:[{table:'dispatches',bytes:2_100_000,estimated_rows:86}]},
    {database:'nocheh_inngest',role:'workflow history',state:'measured',bytes:22_600_000,largest_tables:[{table:'function_runs',bytes:14_000_000,estimated_rows:930}]}],
   state_folders:[{path:'hermes',bytes:84_000_000,complete:true},{path:'archive',bytes:37_500_000,complete:true},{path:'admin',bytes:5_200_000,complete:false}],docker_logs:{max_size_per_file:'10m',max_files_per_container:3},retention_days:14});
  if(route==='/database-browser'){const q=Object.fromEntries(url.searchParams),db=browserDatabases.find(d=>d[0]===q.database);
   if(q.action==='databases'||!q.action)return json(res,200,{databases:browserDatabases.map(([id,name,engine])=>({id,name,engine}))});
   if(q.action==='status')return json(res,200,{databases:browserDatabases.map(([id,name,engine,identifier])=>id==='usage'?{id,name,engine,identifier,service:null,state:'missing',detail:'Database file has not been created'}:{id,name,engine,identifier,service:engine==='postgres'?'nocheh-db':null,state:'available',size_bytes:engine==='postgres'?12_000_000:420_000,table_count:id==='archive'?3:2,version:engine==='postgres'?'17.6':'3.46.1'})});
   if(!db)throw new HttpError(400,'invalid_database');
   const tables=db[0]==='archive'?[{schema:'public',name:'artifacts',estimated_rows:28},{schema:'public',name:'events',estimated_rows:73},{schema:'public',name:'spool_failures',estimated_rows:0}]:[{schema:db[2]==='sqlite'?'main':'public',name:'notes',estimated_rows:db[2]==='sqlite'?null:0},{schema:db[2]==='sqlite'?'main':'public',name:'settings',estimated_rows:db[2]==='sqlite'?null:0}];
   if(q.action==='tables')return json(res,200,{tables});
   if(!tables.some(t=>t.schema===q.schema&&t.name===q.table))throw new HttpError(400,'table_not_found');
   const columns=[{name:'id',type:'text'},{name:'channel',type:'text'},{name:'scope',type:'text'},{name:'text',type:'text'},{name:'received_at',type:'timestamp with time zone'}];
   let rows:Record<string,string|null>[]=q.table==='events'?browserRows:[];const offset=Number(q.offset||0);
   if(q.filter_column&&q.filter)rows=rows.filter(r=>String((r as any)[q.filter_column!]??'').toLowerCase().includes(q.filter!.toLowerCase()));
   if(q.sort)rows=[...rows].sort((a,b)=>String((a as any)[q.sort!]??'').localeCompare(String((b as any)[q.sort!]??''))*(q.direction==='desc'?-1:1));
   return json(res,200,{database:db[0],schema:q.schema,table:q.table,columns,rows:rows.slice(offset,offset+50),next_offset:rows.length>offset+50?offset+50:null,offset,cell_limit:240});}
  if(/^\/exports\/[a-f0-9-]{36}\/download$/.test(route)){res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="nocheh-archive.zip"','cache-control':'no-store'});res.end(Buffer.from([0x50,0x4b,5,6,...Array(18).fill(0)]));return;}
  if(/^\/workflows\/[a-f0-9]{64}$/.test(route))return json(res,200,await workflowDetail(pool,route.split('/')[2]!));
  if(route==='/status')return json(res,200,{archive:{events:1842,artifacts:[{state:'ready',count:28}],dispatches:[{state:'done',count:86}],transcriptions:[{state:'done',count:12}],actions:[],managed_runs:[{event_id:id,state:'done',created_at:new Date().toISOString(),channel:'browser',profile,scope:'42'},{event_id:voiceId,state:'failed',error_code:'provider_timeout',created_at:new Date(Date.now()-86400000).toISOString(),channel:'scheduler',job_id:'morning-check',job_name:'Morning aurora check',profile,scope:'42'}]},guard_mode:'on',services:[]});
  if(route==='/settings')return json(res,200,{revision:settingsRevision,apply_state:'current',fields:fields.map(f=>({...f,value:settingsChanges[f.key]??f.value})),
   models:{embedding:['text-embedding-3-large','text-embedding-3-small'],embedding_locked:mode==='no-provider'?null:'text-embedding-3-small'},
   providers:{list:[{id:'openai',name:'OpenAI',kind:'openai',url:'https://api.openai.com/v1',has_key:true},{id:'anthropic',name:'Anthropic',kind:'anthropic',url:'https://api.anthropic.com/v1',has_key:false},
     ...JSON.parse(String(settingsChanges.NOCHEH_PROVIDERS??'[]')).map((p:any)=>({...p,kind:'custom',has_key:true}))],
    parts:[{id:'reply',label:'Replies (Hermes)',provider_setting:'NOCHEH_REPLY_PROVIDER',model_setting:'NOCHEH_REPLY_MODEL'},{id:'memory',label:'Memory (Honcho)',provider_setting:'NOCHEH_MEMORY_PROVIDER',model_setting:'NOCHEH_MEMORY_MODEL'},{id:'guard',label:'Secret check',provider_setting:'NOCHEH_GUARD_PROVIDER',model_setting:'NOCHEH_GUARD_MODEL'}]}});
  if(route==='/telegram/identities')return json(res,200,{groups:[
    {id:'-10042',name:'Aurora planning',users:[{id:'42',name:'Owner',username:'@owner'},{id:'73',name:'Mira Chen',username:'@mira'},{id:'91',name:'Nia',username:null}]},
    {id:'-10073',name:'Weekend notes',users:[{id:'42',name:'Owner',username:'@owner'},{id:'84',name:'Devon',username:null}]},
  ],truncated:false});
  if(route==='/jobs')return json(res,200,jobs);
  if(route==='/operations')return json(res,200,{backups:[{id:'synthetic-backup',created_at:'2026-09-16T12:00:00Z',files:28}]});
  if(route==='/scopes')return json(res,200,{scopes:[{scope:'42',events:180},{scope:'-10042',events:32}],next:null});
  if(route==='/data')return json(res,200,{records:[{...voice.event,id:voiceId,content_types:['voice'],ready:2,total:2},{...source.event,id,ready:1,total:1}],next:null});
  if(route==='/search')return json(res,200,[{...source.event,id}]);
  if(route==='/events')return json(res,200,{events:[source.event?{...source.event,id,text:source.event.text}:source],results:[{...source.event,id}],next:null});
  if(route==='/events/'+id)return json(res,200,source);
  if(route==='/sources/'+id+'/retirement')return json(res,200,{event_id:id,retired,revision:retirementRevision,history:retirementHistory});
  if(route==='/events/'+voiceId)return json(res,200,voice);
  if(route==='/artifacts/'+voiceFileId+'/download'){res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.end(voiceBytes);return;}
  if(route==='/data/'+voiceId+'/guarded')return json(res,200,{projections:[]});
  if(route==='/data/'+id+'/guarded')return json(res,200,{projections:[{id:'b'.repeat(64),source_id:id,kind:'events',state:'ready',active_revision:revision,author:revision>1?'owner':'automatic',content:{text:guarded,payload:{text:guarded}}}]});
  if(route==='/data/'+id+'/guarded/history')return json(res,200,url.searchParams.has('revision')?{revision:1,content:{text:source.event.text}}:{revisions:[{revision:1,author:'automatic',created_at:new Date().toISOString()}],next:null});
  if(route==='/memory/profiles')return json(res,200,{profiles:[{owner:true,scope:'42',profile},{owner:false,scope:'-10042',profile:'fixture-group'}]});
  if(route==='/memory')return json(res,200,{scope:url.searchParams.get('scope'),profile:url.searchParams.get('profile'),memories:[{name:'MEMORY.md',exists:true,text:'Synthetic memory: interested in astronomy. Verify against original evidence.',citations:[]}],sessions:[{id:'fixture-session',title:'Planning a stargazing trip',source:'browser'}],messages:url.searchParams.get('session')?[{id:'m1',role:'user',content:'Where can we see the northern lights?'}]:[],next_offset:null});
  if(route==='/memory/preferences'||route==='/policy')return json(res,200,preferences);
  if(route==='/memory/persona')return json(res,200,persona(url.searchParams.get('scope')??''));
  if(route==='/prompts')return json(res,200,prompts);
  if(route==='/memory/honcho')return json(res,200,{connection:{attached:memoryAttached,verified:true,revision:memoryRevision,include_history:memoryIncludeHistory},workspace:{id:'synthetic-workspace',state:'building',last_ready_at:minutesAgo(30),error_code:null},limited_memory:!memoryAttached,syncing:true,generations:[{id:'fixture',state:'ready',mode:'on'}],receipts:[{state:'done',count:176},{state:'pending',count:4}]});
  if(route==='/memory/honcho/rebuild'){const chosen=url.searchParams.getAll('space').length;
    return json(res,200,{workspace:'synthetic-workspace',failed_learning:failedLearning,relearn:chosen?{conversations:chosen,sessions:chosen*2,messages:12*chosen,interpretations:1}:{conversations:5,sessions:9,messages:180,interpretations:4},replace:{saved_messages:212}});}
  if(route==='/honcho/status')return json(res,200,{enabled:true,running:true,reasoning_provider_configured:false,embedding_credential:true,api_budget_usd:5});
  if(route==='/runtime')return json(res,200,{status:{ok:true,model:'Subscription model',telegram:'disabled'},capabilities:{'run.start':true,'memory.recall':true,'lifecycle':false}});
  if(route==='/graph'){
    const scope=url.searchParams.get('scope')??'*',all=scope==='*';
    return json(res,200,{scope,nodes:[...(all?[{id:'collection:*',kind:'collection',label:'All private knowledge'}]:[]),{id:'group:42',kind:'group',chat_type:'private',label:'Private chat · @fixture_owner'},{id:'message:'+id,event_id:id,kind:'message',label:'Northern lights trip'},{id:'user:owner',kind:'user',label:'@fixture_owner'},{id:'project:night-sky',kind:'project',label:'Night sky'}],edges:[...(all?[{from:'collection:*',to:'group:42',kind:'contains'}]:[]),{from:'group:42',to:'message:'+id,kind:'contains'},{from:'user:owner',to:'message:'+id,kind:'authored'},{from:'project:night-sky',to:'group:42',kind:'project_context'}],bounds:{truncated:false},unresolved_replies:0,next:null});
  }
  if(route==='/runs')return json(res,200,{runs:[]});
  if(route==='/tools/actions')return json(res,200,{actions,telegram:telegramActions,permissions});
  const actionRead=route.match(/^\/tools\/actions\/([a-f0-9]{64})$/);
  if(actionRead){const found=[...actions,...telegramActions].find((item:any)=>item.id===actionRead[1]);return found?json(res,200,found):json(res,400,{error:'action_not_found'});}
  if(route==='/decisions'){const kind=url.searchParams.get('kind')||null,after=url.searchParams.get('after')??'',limit=Number(url.searchParams.get('limit')||50),all=inboxDecisions(),matching=all.filter(d=>!kind||d.kind===kind).sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)),rest=matching.filter(d=>d.kind+':'+d.id>after),items=rest.slice(0,limit);
   const totals:Record<string,number>={controlled_action:0,telegram_action:0,memory_access:0,entity:0,knowledge:0};for(const d of all)totals[d.kind]!++;
   return json(res,200,{items,total:matching.length,totals,next_cursor:rest.length>limit?items.at(-1)!.kind+':'+items.at(-1)!.id:null,observed_at:new Date().toISOString(),state:'current'});}
  const inboxDecision=route.match(/^\/decisions\/(controlled_action|telegram_action|memory_access|entity|knowledge)\/([a-f0-9]{64})$/);
  if(inboxDecision){const record=inboxRecord(inboxDecision[1]!,inboxDecision[2]!);if(!record)throw new HttpError(404,'decision_not_found');
   return json(res,200,{kind:inboxDecision[1],id:record.id,title:record.name??record.kind,state:record.state??record.status,revision:record.revision??1,source_scope:record.source_scope??record.scope??null,destination:record.destination??record.arguments?.destination??null,fingerprint:record.fingerprint??null,created_at:record.created_at,detail:record,observed_at:new Date().toISOString(),observation:'current'});}
  if(route==='/memory/spaces')return json(res,200,url.searchParams.has('id')?{id:url.searchParams.get('id'),private_owner:url.searchParams.get('id')==='42',overrides:spaceOverrides,inherited:{mode:'approved',sources:[],privacy_instructions:''},effective:{mode:'approved',...spaceOverrides},revision:spaceRevision}:{spaces:[{id:'42'},{id:'-10042'}],owner_space:'42',next:null});
  if(route==='/memory/shares')return json(res,200,shares);
  if(route==='/memory/preview')return json(res,200,{originals:[],shares,filtered_sources:[]});
  if(route==='/memory/reviews')return json(res,200,{jobs:[{id:'e'.repeat(64),event_id:id,reason:'import',state:'paused',chunk_index:0}],next:null});
  if(route==='/memory-map'){const query=(url.searchParams.get('q')??'').trim().toLocaleLowerCase(),kind=url.searchParams.get('kind')??'',state=url.searchParams.get('state')??'';const stateEdges=state?memoryMapEdges.filter(edge=>edge.state===state||edge.label===state):memoryMapEdges,stateNodes=new Set(stateEdges.flatMap(edge=>[edge.source,edge.target])),nodes=memoryMapNodes.filter(node=>(!kind||node.kind===kind)&&(!state||node.state===state||stateNodes.has(node.id))&&(!query||`${node.label} ${node.kind}`.toLocaleLowerCase().includes(query))),ids=new Set(nodes.map(node=>node.id));return json(res,200,{format:'nocheh-memory-map-v1',nodes,edges:stateEdges.filter(edge=>ids.has(edge.source)||ids.has(edge.target)),next:null,collapsed_facts:true,focus:null,counts:{nodes:nodes.length,edges:memoryMapEdges.length},relationship_edges_grant_access:false});}
  if(route==='/memory-access/requests')return json(res,200,{requests:[memoryAccessRequest].filter(row=>!url.searchParams.get('destination')||row.destination===url.searchParams.get('destination'))});
  if(route==='/memory-access/grants')return json(res,200,{grants:[memoryGrant,...factGrants].filter(row=>!url.searchParams.get('destination')||row.destination===url.searchParams.get('destination'))});
  if(route==='/conversations'){const q=(url.searchParams.get('q')??'').toLocaleLowerCase(),items=conversations.filter(row=>!q||[row.space_id,row.name,row.parent_name].some(value=>value?.toLocaleLowerCase().includes(q)));return json(res,200,{items,total:items.length,next_cursor:null,state:'current',observed_at:new Date().toISOString()});}
  if(route==='/conversations/context'){const space=url.searchParams.get('space')??'',group=space.split('/topic/')[0]!,groups=String(settingsChanges.TELEGRAM_GROUP_IDS??'-10042').split(',');
   return json(res,200,{conversation:conversations.find(row=>row.space_id===space)??{space_id:space,name:null,kind:'unknown'},observed_at:new Date().toISOString(),state:'current',
    addressing:{state:'current',enabled:false,owner_id:'42',group_enabled:groups.includes(group),granted:[],denied:[]},
    knowledge_access:{owner_access:space==='42',sharing_rules:sharingRules.filter(rule=>rule.destination===space),fact_grants:[],sharing_releases:[],note:'Synthetic preview.'},
    external_actions:{policy:null,permissions:permissions.filter(row=>row.scope===group),note:'Synthetic preview.'},
    organization:{effective:{project:space.startsWith(conversation)?{id:projectId,name:'Aurora field guide'}:null,inherited:space===topic},delegations:[],note:'Synthetic preview.'},
    memory:{connection:{attached:memoryAttached,verified:true},availability:memoryAttached?'available':'unavailable',syncing:false,sessions:[],note:'Synthetic preview.'}});}
  if(route==='/sharing/rules')return json(res,200,{rules:sharingRules,next:null});
  if(route==='/sharing/previews')return json(res,200,{previews:sharingPreviews.map(({text,...row})=>row),next:null});
  if(route.startsWith('/sharing/previews/')){const row=sharingPreviews.find(p=>p.id===route.split('/')[3]);if(!row)throw new HttpError(404,'sharing_preview_not_found');return json(res,200,previewView(row));}
  if(route==='/sharing/releases')return json(res,200,{releases:sharingReleases,next:null});
  if(route==='/projects/effective')return json(res,200,effectiveProject(url.searchParams.get('space')??''));
  if(route==='/memory-access/settings'){const destination=url.searchParams.get('destination');if(!destination)return json(res,200,{settings:memorySettings,partial:false});
   const keys=['suggestions','notify_owner','auto_followup','request_ttl_seconds','default_grant_mode'],global=memorySettings[0],row=memorySettings.find(r=>r.destination===destination),override=row?Object.fromEntries(keys.filter(k=>row[k]!==null&&row[k]!==undefined).map(k=>[k,row[k]])):null;
   return json(res,200,{destination,global:Object.fromEntries(keys.map(k=>[k,global[k]])),override,effective:{...Object.fromEntries(keys.map(k=>[k,global[k]])),...override},revision:row?row.revision:global.revision});}
  if(route==='/learned'){const kind=url.searchParams.get('scope_kind'),sid=url.searchParams.get('scope_id');if(!!kind!==!!sid)throw new HttpError(400,'invalid_memory_scope');const needle=(url.searchParams.get('q')??'').toLowerCase(),show=url.searchParams.get('show')??'';
    return json(res,200,{entries:learned.filter((e:any)=>(!kind||e.scope_kind===kind&&e.scope_id===sid)&&(!needle||(e.subject+' '+e.text).toLowerCase().includes(needle))
      &&(!show||(show==='retired')===!!e.retired)&&(show!=='revised'||e.active_revision>1)&&(show!=='unsure'||e.provenance?.learning?.uncertainty==='uncertain'||e.provenance?.learning?.conflicts?.length)),next:null});}
  const learnedRead=route.match(/^\/learned\/([a-f0-9]{64})(\/history)?$/);
  if(learnedRead){const entry=learned.find(e=>e.id===learnedRead[1]);if(!entry)throw new HttpError(404,'learned_memory_not_found');const before=Number(url.searchParams.get('before')||1e9),versions=learnedVersions[entry.id]!.filter(v=>v.revision<before).sort((a,b)=>b.revision-a.revision);
   return json(res,200,learnedRead[2]?{versions,next:null}:{id:entry.id,active_revision:entry.active_revision,entry,versions,next:null});}
  if(route==='/entities'){const kind=url.searchParams.get('kind')??'',q=(url.searchParams.get('q')??'').toLocaleLowerCase(),all=url.searchParams.get('state')==='all';
   return json(res,200,{entities:people.filter(p=>(!kind||p.kind===kind)&&(all||p.state==='active')&&p.name.toLocaleLowerCase().includes(q)),next:null});}
  if(route==='/entities/suggestions')return json(res,200,{suggestions:entitySuggestion.status==='pending'?[entitySuggestion]:[],next:null});
  const entityRead=route.match(/^\/entities\/([a-f0-9]{64})$/);
  if(entityRead){const entity=people.find(p=>p.id===entityRead[1]);if(!entity)throw new HttpError(404,'entity_not_found');return json(res,200,{entity,bindings:[],claims:claims.filter(c=>!c.retired&&(c.subject_entity_id===entity.id||c.object_entity_id===entity.id)),partial:false});}
  if(route==='/projects')return json(res,200,{projects:memoryProjects,next:null});
  if(route==='/projects/assignments')return json(res,200,{assignments,next:null});
  const projectContext=route.match(/^\/projects\/([a-f0-9]{64})\/context$/);
  if(projectContext){const project=memoryProjects.find(p=>p.id===projectContext[1]);if(!project)throw new HttpError(404,'project_not_found');
   const chats=conversations.map(c=>({...c,effective:effectiveProject(c.space_id)})).filter(c=>c.effective.project?.id===project.id);
   const entityIds=people.filter(p=>p.project_id===project.id).map(p=>p.id);
   const items=[...learned.filter(e=>e.scope_kind==='project'&&e.scope_id===project.id&&!e.retired).map(e=>({type:'learned',id:e.id,subject:e.subject,kind:e.kind,revision:e.active_revision,author:e.author,retired:false,content:null,attribution:null,uncertainty:null,evidence:e.provenance.learning.evidence})),
    ...claims.filter(c=>!c.retired&&(entityIds.includes(c.subject_entity_id)||entityIds.includes(c.object_entity_id))).map(c=>({type:'claim',id:c.id,subject:c.predicate,kind:'fact',revision:c.revision,author:c.author,retired:false,content:c.content,attribution:c.attribution,uncertainty:c.uncertainty,evidence:c.evidence}))];
   const decisions=project.id===projectId&&knowledgeProposal.state==='review'?[{kind:'knowledge',id:knowledgeProposal.id,title:'Organizing suggestion for Iceland planning',state:'review',created_at:knowledgeProposal.created_at}]:[];
   return json(res,200,{project,conversations:chats,observed_at:new Date().toISOString(),state:'current',knowledge:{items,total:items.length,next_cursor:null},decisions:{items:decisions,total:decisions.length,next_cursor:null}});}
  if(route==='/organization/delegations')return json(res,200,{delegations:delegations.map(delegationView),next:null});
  if(route==='/knowledge/proposals')return json(res,200,{proposals:[knowledgeProposal,...pastProposals],next:null});
  if(route==='/honcho/budget')return json(res,200,honchoBudget);
 }
 if(req.method==='POST'){
  const body=await readJson(req) as any;
  if(/^\/workflows\/[a-f0-9]{64}\/(retry|cancel)$/.test(route))return json(res,200,await controlWorkflow(pool,route.split('/')[2]!,route.split('/')[3]!,body));
  if(route==='/memory/honcho/retry-failed'){const retried=failedLearning;failedLearning=0;return json(res,200,{retried});}
  if(route==='/memory/honcho/rebuild'){return json(res,200,body.spaces?{conversations:body.spaces.length,sessions:2,messages:12*body.spaces.length,interpretations:1}:{conversations:5,sessions:9,messages:180,interpretations:4});}
  if(route==='/memory/honcho/fresh-start'){if(body.expected_revision!==memoryRevision)throw new HttpError(409,'memory_connection_conflict');memoryIncludeHistory=body.from_archive===true;memoryRevision++;return json(res,200,{ok:true});}
  if(route==='/memory/honcho'){if(body.expected_revision!==memoryRevision)throw new HttpError(409,'memory_connection_conflict');memoryAttached=body.attached;memoryIncludeHistory=body.include_history;memoryRevision++;return json(res,200,{ok:true});}
  const learnedCorrect=route.match(/^\/learned\/([a-f0-9]{64})\/correct$/);
  if(learnedCorrect){const entry=learned.find(e=>e.id===learnedCorrect[1]);if(!entry)throw new HttpError(404,'learned_memory_not_found');if(entry.active_revision!==body.expected_revision)throw new HttpError(409,'learned_revision_conflict');
   const text=body.retired?entry.text:String(body.text??'').trim();if(!text)throw new HttpError(400,'memory_correction_required');
   entry.provenance={...entry.provenance,learning:{...entry.provenance.learning,uncertainty:'explicit',conflicts:[]}};Object.assign(entry,{text,author:'owner',retired:body.retired,revised_at:new Date().toISOString(),active_revision:entry.active_revision+1});
   learnedVersions[entry.id]!.push({revision:entry.active_revision,text,author:'owner',retired:body.retired,created_at:entry.revised_at,evidence:entry.provenance.learning.evidence,provenance:entry.provenance});return json(res,200,{id:entry.id,revision:entry.active_revision,retired:body.retired});}
  const claimCorrect=route.match(/^\/entities\/claims\/([a-f0-9]{64})\/correct$/);
  if(claimCorrect){const item=claims.find(c=>c.id===claimCorrect[1]);if(!item)throw new HttpError(404,'entity_claim_not_found');if(item.revision!==body.expected_revision)throw new HttpError(409,'entity_claim_revision_conflict');
   Object.assign(item,{content:String(body.content),attribution:body.attribution,uncertainty:body.uncertainty,retired:body.retired,author:'owner',revision:item.revision+1},body.relationship_kind?{relationship_kind:body.relationship_kind}:{});return json(res,200,{id:item.id,revision:item.revision,retired:item.retired});}
  const entityChange=route.match(/^\/entities\/([a-f0-9]{64})\/(rename|merge|unmerge)$/);
  if(entityChange){const entity=people.find(p=>p.id===entityChange[1]);if(!entity)throw new HttpError(404,'entity_not_found');if(entity.revision!==body.expected_revision)throw new HttpError(409,'entity_revision_conflict');
   if(entityChange[2]==='rename')entity.name=String(body.name).trim();else if(entityChange[2]==='merge'){entity.state='merged';entity.merged_into=body.target_id;}else{entity.state='active';entity.merged_into=null;}
   entity.revision++;return json(res,200,{id:entity.id,name:entity.name,state:entity.state,revision:entity.revision});}
  if(route==='/memory-access/grants'){const fact=claims.find(c=>c.id===body.fact_id&&!c.retired);if(!fact)throw new HttpError(404,'memory_fact_not_found');if(fact.revision!==body.fact_revision)throw new HttpError(409,'memory_fact_changed');
   const grant={id:randomUUID().replace(/-/g,'').repeat(2),destination:body.destination,fact_id:fact.id,fact_revision:fact.revision,mode:'persistent',state:'active',revision:1,wording:body.wording??fact.content,expires_at:body.expires_at??null,suspended_reason:null,provenance:{fixture:true}};
   factGrants.push(grant);return json(res,200,{id:grant.id,state:'active',revision:1});}
  const factRevoke=route.match(/^\/memory-access\/grants\/([a-f0-9]{64})\/revoke$/),ownGrant=factRevoke&&factGrants.find(g=>g.id===factRevoke[1]);
  if(ownGrant){if(ownGrant.revision!==body.expected_revision||ownGrant.state!=='active')throw new HttpError(409,'memory_fact_grant_changed');ownGrant.state='revoked';ownGrant.revision++;return json(res,200,{id:ownGrant.id,state:'revoked',revision:ownGrant.revision});}
  if(route==='/projects'){const prior=body.id?memoryProjects.find(p=>p.id===body.id):null;if((prior?.revision??0)!==body.expected_revision)throw new HttpError(409,'project_revision_conflict');
   if(!String(body.name??'').trim()||!['active','archived'].includes(body.state))throw new HttpError(400,'invalid_project');
   const saved=prior??{id:randomUUID().replace(/-/g,'').repeat(2)};Object.assign(saved,{name:String(body.name).trim(),description:String(body.description??''),state:body.state,revision:(prior?.revision??0)+1});if(!prior)memoryProjects.push(saved);return json(res,200,saved);}
  if(route==='/organization/delegations'){const prior=body.id?delegations.find(d=>d.id===body.id):null;if((prior?.revision??0)!==body.expected_revision)throw new HttpError(409,'organization_delegation_changed');
   if(!String(body.name??'').trim()||!Array.isArray(body.scopes)||!body.scopes.length)throw new HttpError(400,'invalid_organization_delegation');
   const saved=prior??{id:randomUUID().replace(/-/g,'').repeat(2),baseline_suspended:[]};Object.assign(saved,{name:String(body.name).trim(),enabled:body.enabled,scopes:body.scopes,project_ids:body.project_ids,allow_create:body.allow_create,expires_at:body.expires_at??null,revision:(prior?.revision??0)+1,
    baseline_suspended:(saved.baseline_suspended??[]).filter((s:string)=>!(body.resume_scopes??[]).includes(s))});if(!prior)delegations.push(saved);return json(res,200,delegationView(saved));}
  if(route==='/honcho/budget'){if(body.expected_revision!==honchoBudget.revision)throw new HttpError(409,'budget_revision_conflict');if(!Number.isInteger(body.limit_cents)||body.limit_cents<0||body.limit_cents>honchoBudget.max_limit_cents)throw new HttpError(400,'invalid_budget_request');
   Object.assign(honchoBudget,{limit_cents:body.limit_cents,limit_usd:body.limit_cents/100,remaining_usd:Math.max(0,body.limit_cents/100-honchoBudget.counted_toward_cap_usd),revision:honchoBudget.revision+1});return json(res,200,honchoBudget);}
  if(route==='/honcho/read')return json(res,200,{complete:true,workspaces:[{id:'synthetic-workspace'}]});
  if(route==='/prompts'){if(body.revision!==prompts.revision)throw new HttpError(409,'configuration_conflict');
   for(const [key,text] of Object.entries(body.texts as Record<string,string|null>)){
     if(text!==null&&(prompts.placeholders as Record<string,string[]>)[key]?.some(name=>!text.includes(name)))throw new HttpError(400,'prompt_placeholder_missing');
     if(text===null)delete prompts.texts[key];else prompts.texts[key]=text;}
   prompts.revision+='x';return json(res,200,prompts);}
  if(route==='/memory/persona'){const current=persona(String(body.scope));if(body.revision!==current.revision)throw new HttpError(409,'configuration_conflict');
   personas[String(body.scope)]={role:body.role,skills:body.skills,revision:current.revision+'x'};return json(res,200,persona(String(body.scope)));}
  if(route==='/memory/preferences'||route==='/policy'){if(body.revision!==preferences.revision)throw new HttpError(409,'configuration_conflict');preferences.revision+='x';preferences.values={...preferences.values,...body.changes};return json(res,200,{ok:true});}
  if(route==='/tools/decide'){const item=actions.find(a=>a.id===body.id);if(!item||item.fingerprint!==body.fingerprint)throw new HttpError(409,'action_changed');item.state=body.decision==='approve'?'approved':'rejected';return json(res,200,{ok:true});}
  if(route==='/tools/grant'){const granted=actions.find(a=>a.id===body.action_id)??actions[0];permissions.push({id:randomUUID(),kind:granted.kind,scope:granted.scope,arguments:granted.arguments,remaining:body.uses,expires_at:new Date(Date.now()+body.minutes*60000).toISOString()});return json(res,200,{ok:true});}
  if(route==='/tools/telegram-decision'){const item=telegramActions.find(a=>a.id===body.id);if(!item||item.fingerprint!==body.fingerprint)throw new HttpError(409,'action_changed');if(body.expected_revision!==undefined&&body.expected_revision!==item.revision)throw new HttpError(409,'action_revision_changed');if(item.state!=='proposed')throw new HttpError(409,'action_already_started_or_closed');item.state=body.decision==='approve'?'approved':'rejected';item.revision++;return json(res,200,{id:item.id,state:item.state,revision:item.revision});}
  if(route==='/memory-access/requests/'+requestId+'/decide'){if(body.expected_revision!==memoryAccessRequest.revision||memoryAccessRequest.state!=='pending')throw new HttpError(409,'memory_access_request_changed');memoryAccessRequest.state=body.decision==='reject'?'rejected':'approved';if(body.wording)memoryAccessRequest.wording=body.wording;memoryAccessRequest.revision++;return json(res,200,{id:requestId,state:memoryAccessRequest.state,grant_id:null,revision:memoryAccessRequest.revision});}
  if(route==='/entities/'+entitySuggestion.id+'/decide'){if(body.expected_revision!==entitySuggestion.revision)throw new HttpError(409,'entity_suggestion_conflict');entitySuggestion.status=body.decision==='confirm'?'confirmed':'rejected';entitySuggestion.revision++;return json(res,200,{suggestion:entitySuggestion});}
  if(route==='/knowledge/proposals/'+knowledgeProposal.id+'/decide'||route==='/knowledge/proposals/'+knowledgeProposal.id+'/undo'){if(body.expected_revision!==knowledgeProposal.revision)throw new HttpError(409,'knowledge_proposal_changed');knowledgeProposal.state=route.endsWith('/undo')?'undone':body.decision==='approve'?'queued':'cancelled';knowledgeProposal.revision++;return json(res,200,{id:knowledgeProposal.id,state:knowledgeProposal.state,revision:knowledgeProposal.revision});}
  if(route==='/tools/revoke'){const item=permissions.find(p=>p.id===body.id);if(item)item.revoked_at=new Date().toISOString();return json(res,200,{ok:true});}
  if(route==='/projects/assignments'){const own=assignments.find(a=>a.space_id===body.space_id);if((own?.revision??0)!==body.expected_revision)throw new HttpError(409,'assignment_revision_conflict');const next={space_id:body.space_id,project_id:body.mode==='assigned'?body.project_id:null,mode:body.mode,revision:body.expected_revision+1};if(own)Object.assign(own,next);else assignments.push(next);return json(res,200,next);}
  if(route==='/memory-access/settings'){const row=memorySettings.find(r=>r.destination===body.destination);if(row?row.revision!==body.expected_revision:body.expected_revision!==1)throw new HttpError(409,'memory_access_settings_conflict');const values={suggestions:body.suggestions??null,notify_owner:body.notify_owner??null,auto_followup:body.auto_followup??null,request_ttl_seconds:body.request_ttl_seconds??null,default_grant_mode:body.default_grant_mode??null};const revision=row?row.revision+1:1;if(row)Object.assign(row,values,{revision});else memorySettings.push({destination:body.destination,...values,revision});return json(res,200,{destination:body.destination,revision});}
  if(/^\/memory-access\/grants\/[a-f0-9]{64}\/revoke$/.test(route)){if(memoryGrant.revision!==body.expected_revision||!['active','suspended'].includes(memoryGrant.state))throw new HttpError(409,'memory_fact_grant_changed');memoryGrant.state='revoked';memoryGrant.revision++;return json(res,200,{id:memoryGrant.id,state:'revoked',revision:memoryGrant.revision});}
  if(route==='/sharing/rules'){const rule=body.id?sharingRules.find(r=>r.id===body.id):null;if((rule?.revision??0)!==body.expected_revision)throw new HttpError(409,'sharing_revision_conflict');const next={id:rule?.id??randomUUID().replaceAll('-','').padEnd(64,'0'),name:body.name,sources:body.sources,destination:body.destination,enabled:body.enabled,mode:body.mode,instructions:body.instructions??'',revision:body.expected_revision+1};if(rule)Object.assign(rule,next);else sharingRules.push(next);return json(res,200,next);}
  if(route==='/sharing/preview'){const rule=sharingRules.find(r=>r.id===body.rule_id);if(!rule||rule.revision!==body.expected_revision)throw new HttpError(409,'sharing_revision_conflict');const row={id:randomUUID().replaceAll('-','').padEnd(64,'0'),rule_id:rule.id,rule_revision:rule.revision,state:'ready',created_at:new Date().toISOString(),text:body.content??''};sharingPreviews.push(row);return json(res,200,previewView(row));}
  if(/^\/sharing\/previews\/[a-f0-9]{64}\/approve$/.test(route)){const row=sharingPreviews.find(p=>p.id===route.split('/')[3]);if(!row)throw new HttpError(404,'sharing_preview_not_found');const release={id:randomUUID().replaceAll('-','').padEnd(64,'0'),preview_id:row.id,rule_id:row.rule_id,state:'active',mode:'approved',revision:1,expires_at:null,created_at:new Date().toISOString()};sharingReleases.push(release);return json(res,200,{id:release.id,revision:1});}
  if(/^\/sharing\/releases\/[a-f0-9]{64}\/revoke$/.test(route)){const release=sharingReleases.find(r=>r.id===route.split('/')[3]);if(!release||release.revision!==body.expected_revision||release.state!=='active')throw new HttpError(409,'sharing_revision_conflict');release.state='revoked';release.revision++;return json(res,200,{id:release.id,revision:release.revision,state:'revoked'});}
  if(route==='/memory/spaces'){if(body.revision!==spaceRevision)throw new HttpError(409,'space_revision_conflict');spaceOverrides=body.overrides;spaceRevision++;return json(res,200,{ok:true});}
  if(route==='/memory/shares'){shares.push({id:randomUUID(),destination:body.destination,content:body.content});spaceRevision++;return json(res,200,{ok:true});}
  if(route==='/memory/recall')return json(res,200,{hits:[]});
  if(route==='/settings/provider-models')return json(res,200,body.provider==='openai'||body.key||JSON.parse(String(settingsChanges.NOCHEH_PROVIDERS??'[]')).some((p:any)=>p.id===body.provider&&p.url===body.url)
    ?{provider:body.provider,models:body.provider==='openai'?['gpt-5.6-sol','text-embedding-3-small']:['claude-sonnet-5-5','gpt-5.6-sol']}
    :{provider:body.provider,models:[],error:'missing_key'});
  if(route==='/memory/reviews/control')return json(res,200,{ok:true});
  if(route==='/operations'||route==='/settings/apply'){const job={id:randomUUID(),kind:route==='/operations'?'operations.'+body.action:'settings.apply',state:'complete',created_at:new Date().toISOString(),result:{status:'synthetic_only'}};jobs.unshift(job);return json(res,200,job);}
  const importAction=/^\/jobs\/([a-f0-9-]{36})\/(start|cancel)$/.exec(route);
  if(importAction){const job=jobs.find(j=>j.id===importAction[1]);if(!job)throw new HttpError(404,'job_not_found');if(importAction[2]==='start'){if(job.state!=='ready'&&(JSON.stringify(body.mapping)!==JSON.stringify(job.mapping)||body.review_approved!==job.review_approved))throw new HttpError(409,'import_configuration_conflict');job.mapping=body.mapping;job.review_approved=body.review_approved;job.state='running';}else job.state='cancelled';return json(res,200,job);}
  if(route==='/telegram/chats/refresh')return json(res,200,{chats:String(settingsChanges.TELEGRAM_GROUP_IDS??'-10042').split(',').filter(Boolean).map(chat_id=>({chat_id,state:'available',title:'Aurora planning',is_forum:false}))});
  if(route==='/telegram/topics')return json(res,200,{ok:true});
  if(route==='/settings'){if(body.revision!==settingsRevision)throw new HttpError(409,'configuration_conflict');settingsChanges={...settingsChanges,...body.changes};settingsRevision+='x';return json(res,200,{ok:true});}
  if(route==='/data/'+id+'/guarded'){if(body.expected_revision!==revision)throw new HttpError(409,'guard_revision_conflict');guarded=body.content?.text??source.event.text;revision++;return json(res,200,{ok:true});}
  if(route==='/sources/'+id+'/retirement'){
    if(body.expected_revision!==retirementRevision)throw new HttpError(409,'source_retirement_conflict');
    retired=body.retired;retirementRevision++;retirementHistory.unshift({revision:retirementRevision,retired,created_at:new Date().toISOString()});
    return json(res,200,{event_id:id,retired,revision:retirementRevision});
  }
 }
 throw new HttpError(404,'fixture_capability_unavailable');
})().catch(error=>json(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.code:'fixture_request_failed'}));});
server.listen(port,'0.0.0.0',()=>console.log(`Synthetic dashboard preview ready on ${port}; no external execution authorities.`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>void pool.end());});
