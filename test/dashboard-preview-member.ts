/**
 * The members' app in the dashboard preview (ADR-0265): `/m/` with the member page's own CSP, and `/api/member/*`
 * answered in memory for synthetic members, with the real route list and list filter checks (src/member-app-wire.ts).
 * The preview does not check Telegram's signature: it reads the user id and auth_date from the launch data, as only
 * the real edge and member listener may trust them. Nothing here reaches the owner's data or routes.
 *
 * Members, by Telegram id: 201 Lena (read and write, in Aurora planning and Garden swap, each on a board, Weekend notes
 * with no board and Book club whose project is closed; Print crew, which she is not in, shares Aurora planning's board, so
 * she sees its tasks and its name as their group, ADR-0276); 202 Ravi (read only, Aurora planning only); 203 Sana (read and
 * write, her private chat with Nocheh off, so no reminders); 204 Tom (paused); 205 Noor (no groups). Only Lena has
 * Personal assistant on, with two schedules of her own (members' schedules). The owner is 42;
 * anyone else is a stranger. The boards' statuses and shared columns are the owner's own names (PREVIEW_MEMBER_BOARD);
 * a task's assignees are already as the member listener sends them: Telegram names, and the rest counted.
 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {HttpError,json,object,readJson} from '../src/http.js';
import {MEMBER_APP_PUBLIC_PREFIX,MEMBER_LAUNCH_HEADER,MEMBER_TASK_CREATE_FIELDS,MEMBER_TASK_PATCH_FIELDS,MEMBER_TASK_REFUSED_FIELDS,
  memberAppErrors,memberAppRoute,memberTaskQuery,type MemberActor,type MemberComment,type MemberDetail,type MemberMe,type MemberMeGroup,
  type MemberReminder,type MemberRemindersState,type MemberSchedule,type MemberTask,type MemberTaskColumn,type MemberTaskStatus} from '../src/member-app-wire.js';

/** The member page's policy, as nocheh-miniapp sends it: the owner page's, with Trusted Types required. */
export const MEMBER_PAGE_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; "+
  "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; require-trusted-types-for 'script'";
const LAUNCH_MAX_AGE=3600,OWNER='42',PAGE=20;
/** The owner's statuses and the columns shared with project chats, by id, as GET /tasks names them. */
export const PREVIEW_MEMBER_BOARD:{statuses:MemberTaskStatus[];columns:MemberTaskColumn[]}={
 statuses:[{id:'s-todo',name:'Not started',state:'open'},{id:'s-print',name:'At the printer',state:'open'},{id:'s-done',name:'Wrapped up',state:'done'},
  {id:'s-dropped',name:'Shelved',state:'dropped'}],
 columns:[{id:'c-budget',name:'Budget',type:'number'},
  {id:'c-size',name:'Paper size',type:'select',options:[{id:'o-a2',name:'A2'},{id:'o-a3',name:'A3'}]},
  {id:'c-rooms',name:'Rooms',type:'multi_select',options:[{id:'o-hall',name:'Hall'},{id:'o-yard',name:'Yard'}]},
  {id:'c-signed',name:'Signed off',type:'checkbox'}]};
const hex=(seed:string)=>createHash('sha256').update('preview-member:'+seed).digest('hex');
export const PREVIEW_MEMBER_PROJECTS={studio:hex('project:studio'),garden:hex('project:garden'),fair:hex('project:fair'),hidden:hex('project:hidden')};
const projectNames:Record<string,string>={[PREVIEW_MEMBER_PROJECTS.studio]:'Studio launch',[PREVIEW_MEMBER_PROJECTS.garden]:'Garden redesign',[PREVIEW_MEMBER_PROJECTS.fair]:'Spring fair',
 [PREVIEW_MEMBER_PROJECTS.hidden]:'Hidden project'};
/** The groups, by a Nocheh chat id, their Telegram title and the project whose board they show (null: none). */
const groups:{id:string;title:string;project:string|null;active:boolean}[]=[
 {id:'-30001',title:'Aurora planning',project:PREVIEW_MEMBER_PROJECTS.studio,active:true},
 {id:'-30002',title:'Garden swap',project:PREVIEW_MEMBER_PROJECTS.garden,active:true},
 {id:'-30003',title:'Weekend notes',project:null,active:true},
 {id:'-30004',title:'Book club',project:PREVIEW_MEMBER_PROJECTS.fair,active:false},
 {id:'-30005',title:'Hidden board',project:PREVIEW_MEMBER_PROJECTS.hidden,active:true},
 {id:'-30006',title:'Print crew',project:PREVIEW_MEMBER_PROJECTS.studio,active:true},
];
type Member={telegram:string;name:string;state:'active'|'paused';tasks:'read'|'write';private_chat:boolean;reminders:boolean;groups:string[];assistant?:true};
const members:Member[]=[
 {telegram:'201',name:'Lena',state:'active',tasks:'write',private_chat:true,reminders:true,groups:['-30001','-30002','-30003','-30004'],assistant:true},
 {telegram:'202',name:'Ravi',state:'active',tasks:'read',private_chat:true,reminders:true,groups:['-30001']},
 {telegram:'203',name:'Sana',state:'active',tasks:'write',private_chat:false,reminders:true,groups:['-30001']},
 {telegram:'204',name:'Tom',state:'paused',tasks:'write',private_chat:true,reminders:true,groups:['-30001']},
 {telegram:'205',name:'Noor',state:'active',tasks:'write',private_chat:true,reminders:true,groups:[]},
];
type Stored=Omit<MemberDetail,'version'|'mine'|'reminders'|'subtasks'|'children'|'comments'>&{revision:number;made_by:string|null;
 reminders:{id:string;at:string;by:string}[];others:number;comment_count?:number};
type State={tasks:Stored[];signedOut:Map<string,number>;receipts:Map<string,{request:string;result:unknown}>;schedules:MemberSchedule[];timeZone:string|null};
const SCHEDULE_LIMIT=5;
let state:State;
const day=(days:number)=>new Date(Date.now()+days*864e5).toISOString().slice(0,10);
const at=(days:number)=>new Date(Math.floor((Date.now()+days*864e5)/60000)*60000).toISOString();
function task(id:string,fields:Partial<Stored>&Pick<Stored,'title'|'project'|'group'>):Stored {
 return {id:hex('task:'+id),parent_id:null,status:'s-todo',state:'open',priority:0,start_on:null,start_time:null,due_on:null,due_time:null,tags:[],properties:{},assignees:[],assignees_other:0,
  archived:false,trashed:false,on_board_since:at(-20),updated_at:at(-1),done_at:null,notes:'',repeat:null,blocked_by:[],related:[],duplicate_of:[],
  attachments:[],comment_list:[],activity:[{at:at(-20),actor:{kind:'owner'},changes:{created:true}}],revision:1,made_by:null,reminders:[],others:0,...fields};
}
/** A fresh copy of the synthetic boards; tests reset to it. */
function seed():State {
 const S=PREVIEW_MEMBER_PROJECTS.studio,G=PREVIEW_MEMBER_PROJECTS.garden;
 const posters=task('posters',{title:'Print the launch posters',project:S,group:'-30001',status:'s-print',priority:3,due_on:day(2),tags:['Print'],
  assignees:[{name:'Ravi'},{name:'Sana'}],assignees_other:2,properties:{'c-size':'o-a2','c-rooms':['o-hall','o-yard'],'c-signed':true},
  notes:'Matte paper, A2.\nAsk the print shop for a proof first.',made_by:'201',created_at:at(-3),created_by:{kind:'member',name:'Lena'},
  comment_list:[{id:hex('comment:1'),body:'Use the matte paper.',author:{kind:'owner'},created_at:at(-2)}],
  reminders:[{id:hex('reminder:1'),at:at(1),by:'201'}],others:2});
 return {tasks:[posters,
  task('paper',{title:'Pick the paper',project:S,group:'-30001',parent_id:posters.id}),
  task('venue',{title:'Book the venue',project:S,group:null,properties:{'c-budget':1200},assignees_other:1,
   attachments:[{kind:'link',url:'https://example.com/venue',title:'Venue page'},{kind:'link',url:'javascript:alert(1)',title:'Not a web link'}]}),
  task('labels',{title:'<img src=x onerror=alert(1)> Label the seed trays',project:S,group:'-30001',tags:['Garden']}),
  task('thanks',{title:'Send the thank-you notes',project:S,group:'-30001',state:'done',status:'s-done',done_at:at(-1),finished_by:{kind:'member',name:'Ravi'}}),
  task('flyer',{title:'Old flyer draft',project:S,group:'-30001',trashed:true}),
  // Another group's task on the same board: one list for the whole project, whatever its group (ADR-0276).
  task('banner',{title:'Proof the banner',project:S,group:'-30006'}),
  task('beds',{title:'Measure the beds',project:G,group:'-30002',due_on:day(5)}),
  // A project the preview's members are in none of the groups of: nothing of it may ever show.
  task('hidden',{title:'HIDDENMARK budget sheet',project:PREVIEW_MEMBER_PROJECTS.hidden,group:'-30005'}),
 ],signedOut:new Map(),receipts:new Map(),timeZone:null,schedules:[
  {id:'a1b2c3d4e5f6',name:'Morning brief',schedule:'0 8 * * *',state:'scheduled',next_run_at:at(1),last_run_at:at(0),last_ok:true},
  {id:'f6e5d4c3b2a1',name:'Friday wrap-up',schedule:'0 17 * * 5',state:'paused',next_run_at:null,last_run_at:null,last_ok:null}]};
}
state=seed();

type Who={member:Member;auth:number};
/** Who calls, from the launch data's user and auth_date, with the member listener's answers for everyone else. */
function caller(req:IncomingMessage):Who {
 if(req.headers.authorization)throw new HttpError(400,memberAppErrors.noBearer);
 const raw=String(req.headers[MEMBER_LAUNCH_HEADER]??''),params=new URLSearchParams(raw);
 let user='';try{user=String(JSON.parse(params.get('user')??'null')?.id??'');}catch{}
 const auth=Number(params.get('auth_date'));
 if(!/^[1-9]\d{0,18}$/.test(user)||!Number.isInteger(auth)||Date.now()/1000-auth>LAUNCH_MAX_AGE)throw new HttpError(401,memberAppErrors.launchInvalid);
 if(user===OWNER)throw new HttpError(403,memberAppErrors.memberRequired);
 const member=members.find(item=>item.telegram===user&&item.state==='active');
 if(!member)throw new HttpError(403,memberAppErrors.closed);
 if(auth<=(state.signedOut.get(user)??-1))throw new HttpError(401,memberAppErrors.signedOut);
 return {member,auth};
}
const reminderState=(member:Member):MemberRemindersState=>member.tasks==='read'?{available:false,reason:'read_only'}:!member.reminders?{available:false,reason:'reminders_off'}:
 !member.private_chat?{available:false,reason:'private_chat_off'}:{available:true};
/** The member's own groups with a board, by project. */
const reach=(member:Member)=>groups.filter(group=>member.groups.includes(group.id)&&group.active&&group.project);
/** A board is its project's whole list, whatever each task's group (ADR-0276). */
const visible=(member:Member,item:Stored)=>reach(member).some(group=>group.project===item.project);
/** Whether a group is one of a project's now: only such a group is a task's label, or one a task may take. */
const inProject=(group:unknown,project:string)=>groups.some(item=>item.id===group&&item.project===project);
const version=(item:Stored)=>hex('version:'+item.id+':'+item.revision).slice(0,32);
function row(member:Member,item:Stored):MemberTask {
 const children=state.tasks.filter(other=>other.parent_id===item.id&&!other.trashed&&visible(member,other));
 const {revision,made_by,reminders,others,comment_list,notes,repeat,blocked_by,related,duplicate_of,attachments,activity,...rest}=item;
 return {...rest,group:inProject(item.group,item.project)?item.group:null,version:version(item),subtasks:{open:children.filter(child=>child.state==='open').length,total:children.length},comments:comment_list.length,
  mine:made_by===member.telegram||reminders.some(reminder=>reminder.by===member.telegram),
  reminders:{mine:reminders.filter(reminder=>reminder.by===member.telegram).map(reminder=>({id:reminder.id,at:reminder.at,state:'pending' as const})),
   others:others+reminders.filter(reminder=>reminder.by!==member.telegram).length}};
}
function detail(member:Member,item:Stored):MemberDetail {
 const link=(other:Stored)=>({id:other.id,title:other.title,state:other.state});
 return {...row(member,item),notes:item.notes,repeat:item.repeat,blocked_by:[],related:[],duplicate_of:[],attachments:item.attachments.map(entry=>({...entry})),
  children:state.tasks.filter(other=>other.parent_id===item.id&&!other.trashed&&visible(member,other)).map(link),
  comment_list:item.comment_list.map(entry=>({...entry})),activity:item.activity.map(entry=>({...entry}))};
}
function find(member:Member,id:string):Stored {
 const item=state.tasks.find(entry=>entry.id===id);
 if(!item||!visible(member,item))throw new HttpError(404,'task_not_found');
 return item;
}
function me(member:Member):MemberMe {
 const seen=new Set<string>(),projects:MemberMe['projects']=[];
 const named=(project:string)=>groups.filter(group=>group.project===project).map(({id,title})=>({id,title})).sort((a,b)=>a.title.localeCompare(b.title));
 for(const group of reach(member))if(!seen.has(group.project!)){seen.add(group.project!);
  projects.push({id:group.project!,name:projectNames[group.project!]!,groups:named(group.project!)});}
 const items:MemberMeGroup[]=groups.filter(group=>member.groups.includes(group.id)).map(group=>!group.project?{id:group.id,title:group.title,board:'none',project:null}:
  !group.active?{id:group.id,title:group.title,board:'closed',project:null}:
  {id:group.id,title:group.title,board:'open',project:group.project,open_count:state.tasks.filter(item=>item.group===group.id&&item.state==='open'&&!item.trashed).length});
 return {name:member.name,mode:member.tasks,reminders:reminderState(member),projects,groups:items,assistant:!!member.assistant&&member.private_chat};
}
/** A replayed operation answers what it answered; the same id with another request is a conflict. */
function once<T>(who:Who,operation:unknown,request:unknown,change:()=>T):T {
 if(typeof operation!=='string'||!/^[0-9a-f-]{36}$/.test(operation))throw new HttpError(400,'invalid_operation_id');
 const key=who.member.telegram+':'+operation,text=JSON.stringify(request),seen=state.receipts.get(key);
 if(seen){if(seen.request!==text)throw new HttpError(409,'operation_conflict');return seen.result as T;}
 const result=change();state.receipts.set(key,{request:text,result});return result;
}
const actor=(member:Member):MemberActor=>({kind:'member',name:member.name});
function apply(who:Who,item:Stored,fields:Record<string,unknown>) {
 const member=who.member,changes:Record<string,unknown>={};
 for(const [key,value] of Object.entries(fields)) {
  if((MEMBER_TASK_REFUSED_FIELDS as readonly string[]).includes(key))throw new HttpError(403,memberAppErrors.fieldNotAllowed);
  if(!(MEMBER_TASK_PATCH_FIELDS as readonly string[]).includes(key))throw new HttpError(400,'unknown_task_field');
  if(key==='reminders'){
   // While reminders can't reach the member, a list that only removes their own still saves (ADR-0265 D9).
   const own=new Set(item.reminders.filter(entry=>entry.by===member.telegram).map(entry=>entry.at));
   const removing=Array.isArray(value)&&value.every(entry=>typeof entry==='string'&&own.has(new Date(entry).toISOString()));
   if(!member.reminders&&!removing)throw new HttpError(403,memberAppErrors.remindersOff);
   if(!reminderState(member).available&&!removing)throw new HttpError(409,memberAppErrors.remindersUnavailable);
   if(!Array.isArray(value)||value.length>10||value.some(entry=>typeof entry!=='string'||!/[+-]\d{2}:\d{2}$|Z$/.test(entry)||Number.isNaN(Date.parse(entry))))throw new HttpError(400,'invalid_task_reminders');
   item.reminders=[...item.reminders.filter(entry=>entry.by!==member.telegram),...value.map(entry=>({id:hex('reminder:'+item.id+':'+entry+':'+member.telegram),at:new Date(entry as string).toISOString(),by:member.telegram}))];
  } else if(key==='group'){
   if(value!==null&&!inProject(value,item.project))throw new HttpError(403,'task_group_denied');
   item.group=value as string|null;changes.group_id={to:value};
  } else if(key==='state'){
   if(value!=='done'&&value!=='open')throw new HttpError(400,'invalid_task_state');
   item.state=value;item.status=value==='done'?'s-done':'s-todo';item.done_at=value==='done'?new Date().toISOString():null;
   if(value==='done')item.finished_by=actor(member);else delete item.finished_by;changes.status_id={to:item.status};
  } else if(key==='trashed'||key==='archived'){item[key]=value===true;changes[key]={to:value===true};}
  else if(key==='status'){
   const status=PREVIEW_MEMBER_BOARD.statuses.find(entry=>entry.id===value);if(!status)throw new HttpError(400,'invalid_task_status');
   item.status=status.id;item.state=status.state;item.done_at=status.state==='open'?null:item.done_at??new Date().toISOString();
   if(status.state==='open')delete item.finished_by;else item.finished_by=actor(member);changes.status_id={to:status.id};
  } else if(key==='properties'){
   // Only the shared columns, a choice by its option's id; null clears one.
   const values=object(value),next={...item.properties};
   for(const [id,entry] of Object.entries(values)){
    const column=PREVIEW_MEMBER_BOARD.columns.find(item=>item.id===id);if(!column)throw new HttpError(400,'unknown_task_property');
    const options=new Set((column.options??[]).map(option=>option.id));
    const ok=entry===null||(column.type==='number'?typeof entry==='number':column.type==='checkbox'?typeof entry==='boolean':
     column.type==='select'?options.has(entry as string):Array.isArray(entry)&&entry.every(option=>options.has(option)));
    if(!ok)throw new HttpError(400,'invalid_task_property_value');
    if(entry===null)delete next[id];else next[id]=entry;
   }
   item.properties=next;changes.properties={to:true};
  } else if(key==='tags'){if(!Array.isArray(value))throw new HttpError(400,'invalid_task_tags');item.tags=value.map(String);changes.tags={to:item.tags};}
  else if(['title','notes','due_on','due_time','parent'].includes(key)){
   const target=key==='parent'?'parent_id':key;(item as any)[target]=value;changes[target]={to:value};
  } else changes[key]={to:value};
 }
 if(!item.title?.trim())throw new HttpError(400,'invalid_task_title');
 item.revision++;item.updated_at=new Date().toISOString();
 if(Object.keys(changes).length)item.activity.push({at:item.updated_at,actor:actor(member),changes});
}
function writer(who:Who) {if(who.member.tasks!=='write')throw new HttpError(403,memberAppErrors.readOnly);}

/** Answers `/m/`, the member page's script, the members' API and the preview's own test hooks; false for anything else. */
export async function memberAppPreview(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
 const path=url.pathname,method=req.method??'GET';
 if(method==='GET'&&(path==='/m/'||path==='/m/index.html')){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','content-security-policy':MEMBER_PAGE_CSP});
  res.end(await readFile('dashboard/dist/member.html'));return true;}
 if(method==='GET'&&path==='/assets/member.js'){
  res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-cache','content-security-policy':MEMBER_PAGE_CSP});
  res.end(await readFile('dashboard/dist/member.js'));return true;}
 // Test hooks: start over, or change a task as someone else would.
 if(method==='POST'&&path==='/__preview/member/reset'){state=seed();json(res,200,{ok:true});return true;}
 const touch=/^\/__preview\/member\/touch\/([a-f0-9]{64})$/.exec(path);
 if(method==='POST'&&touch){const item=state.tasks.find(entry=>entry.id===touch[1]);if(!item)throw new HttpError(404,'task_not_found');
  item.title+=' (changed)';item.revision++;json(res,200,{ok:true});return true;}
 // A reminder a member set before their reminders stopped reaching them.
 const remind=/^\/__preview\/member\/remind\/([a-f0-9]{64})\/(\d+)$/.exec(path);
 if(method==='POST'&&remind){const item=state.tasks.find(entry=>entry.id===remind[1]);if(!item)throw new HttpError(404,'task_not_found');
  const when=at(3+item.reminders.filter(entry=>entry.by===remind[2]).length);item.reminders.push({id:hex('reminder:'+item.id+':'+when+':'+remind[2]),at:when,by:remind[2]!});json(res,200,{ok:true});return true;}
 if(!path.startsWith(MEMBER_APP_PUBLIC_PREFIX+'/'))return false;
 const route=memberAppRoute(method,path.slice(MEMBER_APP_PUBLIC_PREFIX.length));
 if(!route||url.search&&route.name!=='tasks')throw new HttpError(404,'not_found');
 const who=caller(req),member=who.member;
 const body=method==='POST'&&route.name!=='sign_out'?object(await readJson(req,64*1024)):{};
 switch(route.name){
  case 'me':return json(res,200,me(member)),true;
  case 'tasks':{
   const query=memberTaskQuery(url.searchParams);
   if(!me(member).projects.some(project=>project.id===query.project))throw new HttpError(404,'project_not_found');
   if(query.group&&!inProject(query.group,query.project))throw new HttpError(400,memberAppErrors.filterNotAllowed);
   const all=state.tasks.filter(item=>item.project===query.project&&visible(member,item)&&(query.trash?item.trashed:!item.trashed&&(query.state==='done'?item.state!=='open':item.state==='open')));
   const tags=[...new Set(all.flatMap(item=>item.tags))].sort();
   const rows=all.filter(item=>(!query.group||item.group===query.group)&&(!query.tag||item.tags.includes(query.tag))).map(item=>row(member,item)).filter(item=>!query.mine||item.mine);
   const from=Number(query.cursor??0);
   return json(res,200,{tasks:rows.slice(from,from+PAGE),next:from+PAGE<rows.length?String(from+PAGE):null,tags,...PREVIEW_MEMBER_BOARD}),true;
  }
  case 'task':return json(res,200,detail(member,find(member,route.task!))),true;
  case 'create':{
   writer(who);
   const {operation_id,project,...fields}=body;
   return json(res,200,once(who,operation_id,body,()=>{
    if(!me(member).projects.some(item=>item.id===project))throw new HttpError(403,memberAppErrors.fieldNotAllowed);
    for(const key of Object.keys(fields))if(!(MEMBER_TASK_CREATE_FIELDS as readonly string[]).includes(key))
     throw new HttpError((MEMBER_TASK_REFUSED_FIELDS as readonly string[]).includes(key)?403:400,(MEMBER_TASK_REFUSED_FIELDS as readonly string[]).includes(key)?memberAppErrors.fieldNotAllowed:'unknown_task_field');
    // As the store: a subtask takes its parent's group unless one is named; with no group and no parent, the member's
    // first group on the board.
    const parent=fields.parent?find(member,String(fields.parent)):null;
    const home=reach(member).find(group=>group.project===project)?.id??null;
    const item=task('new:'+operation_id,{title:'',project:project as string,group:parent?parent.group:'group' in fields?null:home,made_by:member.telegram,
     created_at:new Date().toISOString(),created_by:actor(member),on_board_since:new Date().toISOString(),activity:[]});
    apply(who,item,fields);item.revision=1;item.activity=[{at:item.updated_at,actor:actor(member),changes:{created:true}}];
    state.tasks.push(item);return detail(member,item);
   })),true;
  }
  case 'update':{
   writer(who);
   const item=find(member,route.task!);
   if(Object.keys(body).some(key=>!['operation_id','expected_version','patch'].includes(key)))throw new HttpError(400,'unknown_task_field');
   return json(res,200,once(who,body.operation_id,{id:item.id,...body},()=>{
    if(body.expected_version!==version(item))throw new HttpError(409,memberAppErrors.conflict);
    apply(who,item,object(body.patch));return detail(member,item);
   })),true;
  }
  case 'comment':{
   writer(who);
   const item=find(member,route.task!);
   if(Object.keys(body).some(key=>!['operation_id','text'].includes(key))||typeof body.text!=='string'||!body.text.trim())throw new HttpError(400,'invalid_task_comment');
   return json(res,200,once(who,body.operation_id,{id:item.id,...body},()=>{
    const comment:MemberComment={id:hex('comment:'+body.operation_id),body:String(body.text),author:actor(member),created_at:new Date().toISOString()};
    item.comment_list.push(comment);return detail(member,item);
   })),true;
  }
  case 'reminders':{
   const list:MemberReminder[]=state.tasks.filter(item=>!item.trashed&&visible(member,item)).flatMap(item=>item.reminders.filter(entry=>entry.by===member.telegram)
    .map(entry=>({id:entry.id,at:entry.at,task:{id:item.id,title:item.title,project:item.project}}))).sort((a,b)=>a.at.localeCompare(b.at));
   return json(res,200,list),true;
  }
  // The member's own schedules: only with Personal assistant on and their private chat open.
  case 'schedules':
   if(!me(member).assistant)throw new HttpError(403,memberAppErrors.schedulesOff);
   return json(res,200,{schedules:state.schedules,limit:SCHEDULE_LIMIT,time_zone:state.timeZone}),true;
  case 'schedule':{
   if(!me(member).assistant)throw new HttpError(403,memberAppErrors.schedulesOff);
   const item=state.schedules.find(entry=>entry.id===route.schedule);if(!item)throw new HttpError(404,memberAppErrors.scheduleGone);
   if(typeof body.operation_id!=='string'||!/^[0-9a-f-]{36}$/.test(body.operation_id))throw new HttpError(400,'invalid_operation_id');
   if(body.action==='delete'){state.schedules=state.schedules.filter(entry=>entry!==item);return json(res,200,{schedule:null}),true;}
   if(body.action==='pause'){item.state='paused';item.next_run_at=null;}
   else if(body.action==='resume'){item.state='scheduled';item.next_run_at=at(1);}
   else if(body.action==='run'){item.last_run_at=new Date().toISOString();item.last_ok=true;}
   else throw new HttpError(400,'invalid_schedule_action');
   return json(res,200,{schedule:item}),true;
  }
  // The member's own time zone for new schedules; null is the owner's.
  case 'time_zone':{
   if(!me(member).assistant)throw new HttpError(403,memberAppErrors.schedulesOff);
   if(typeof body.operation_id!=='string'||!/^[0-9a-f-]{36}$/.test(body.operation_id))throw new HttpError(400,'invalid_time_zone');
   const zone=body.time_zone===null||body.time_zone===''?null:String(body.time_zone);
   if(zone!==null)try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw new HttpError(400,'invalid_time_zone');}
   state.timeZone=zone;return json(res,200,{time_zone:zone}),true;
  }
  // Every launch opened before now, on every phone: up to this one's, or now less the minute of slack (D13).
  case 'sign_out':state.signedOut.set(member.telegram,Math.max(who.auth,Math.floor(Date.now()/1000)-60));return json(res,200,{}),true;
 }
}
