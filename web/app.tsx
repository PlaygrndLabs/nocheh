import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {Activity as ActivityIcon,Archive as ArchiveIcon,ArrowUpRight,BrainCircuit,Database,FolderInput,FolderKanban,Share2,GitFork,Home,Menu,Network,PanelLeftClose,PanelLeftOpen,Plug,RefreshCw,Settings as SettingsIcon,ShieldCheck,Users,Wrench,X} from 'lucide-react';
import {Status} from './pages/overview';
import {Settings} from './pages/settings.js';
import {Jobs} from './pages/imports.js';
import {Archive} from './pages/archive';
import {Activity} from './pages/activity';
import {Memory} from './pages/memory';
import {LearnedMemory} from './pages/learned';
import {Projects} from './pages/projects';
import {Entities} from './pages/entities';
import {Sharing} from './pages/sharing';
import {MemoryMap} from './pages/memory-map';
import {Honcho} from './pages/honcho.js';
import {Source} from './pages/source.js';
import {Graph} from './pages/graph.js';
import {Operations} from './pages/maintenance.js';
import {SpaceControls} from './pages/access.js';
import {Integrations} from './pages/integrations.js';
import {Monitoring} from './monitoring.js';
import {call} from './lib/page-helpers.js';
import {Button,Sheet,Tooltip} from './components/ui/primitives';
import {ThemeSelect} from './lib/theme';
import {StatusBadge} from './components/status';
import {useResource,refreshResources} from './lib/resource';
const pages={overview:Status,monitoring:Monitoring,archive:Archive,activity:Activity,imports:Jobs,settings:Settings,integrations:Integrations,spaces:SpaceControls,graph:Graph,memoryMap:MemoryMap,operations:Operations,memory:Memory,learned:LearnedMemory,entities:Entities,projects:Projects,sharing:Sharing,honcho:Honcho,Source,call};
const routes=[
 ['overview','Overview',Home,'Your conversations, memory, and assistant at a glance.'],['archive','Archive',ArchiveIcon,'Find originals and inspect the evidence behind generated text.'],['learned','Learned memory',BrainCircuit,'Inspect meanings, evidence, conflicts, and owner corrections.'],['entities','People & projects',Users,'Review connected memory, relationships, evidence, and identity decisions.'],['memoryMap','Memory map',Network,'See relationships, fact suggestions, and explicit group or topic access.'],['memory','Memory',BrainCircuit,'Working notes and conversations, separated by profile.'],['honcho','Honcho memory',Database,'Primary memory availability and synchronization.'],['graph','Graph',GitFork,'Explore recorded relationships and their sources.'],
 ['monitoring','Monitoring',ActivityIcon,'System health, workflow progress, and historical trends.'],['activity','Activity',ShieldCheck,'Review approvals, permissions, and conversation results.'],
 ['projects','Projects',FolderKanban,'Organize conversations and their interpretation conventions.'],['sharing','Sharing',Share2,'Choose sources, destinations, and the exact knowledge they can use.'],['imports','Imports',FolderInput,'Bring Telegram history into your owned archive.'],['spaces','Memory access',ShieldCheck,'Control what each group and topic can use.'],['integrations','Integrations',Plug,'The connected tools behind your personal brain.'],['settings','Settings',SettingsIcon,'Telegram access, agent preferences, and privacy.'],['operations','Maintenance',Wrench,'Diagnostics, exports, backups, and recovery.']
] as const;
const groups=[['Knowledge',['overview','archive','learned','entities','memoryMap','memory','honcho','graph']],['Operations',['monitoring','activity']],['Manage',['projects','sharing','imports','spaces','integrations','settings','operations']]] as const;
function currentRoute(){const key=location.hash.slice(1).split('?')[0];return routes.some(r=>r[0]===key)?key:'overview';}
function PersistentStatus(){const {data,error}=useResource<any>('/monitoring',10000);return <a className="persistent-status" href="#monitoring" aria-label="Inspect system status"><StatusBadge state={error?'stale':data?.application?.ok?'ready':data?.application?.ok===false?'failed':'unknown'} label={error?'Status stale':data?.application?.ok?'API ready':data?.application?.ok===false?'API unavailable':'Status unobserved'}/></a>;}
function App(){
 const [page,setPage]=React.useState(currentRoute),[mobile,setMobile]=React.useState(false),[collapsed,setCollapsed]=React.useState(()=>{try{return localStorage.getItem('nocheh.sidebar.v1')==='collapsed';}catch{return false;}}),[notice,setNotice]=React.useState<{text:string;error:boolean}|null>(null),[refreshing,setRefreshing]=React.useState(false);
 const heading=React.useRef<HTMLHeadingElement>(null),menu=React.useRef<HTMLButtonElement>(null);
 React.useEffect(()=>{const change=()=>{setPage(currentRoute());setNotice(null);setMobile(false);};addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);
 React.useEffect(()=>{heading.current?.focus({preventScroll:true});},[page]);
 const toggle=()=>setCollapsed(value=>{try{localStorage.setItem('nocheh.sidebar.v1',!value?'collapsed':'expanded');}catch{}return !value;});
 const refresh=async()=>{setRefreshing(true);try{await refreshResources();}finally{setRefreshing(false);}};
 const notify=React.useCallback((text:string,error=false)=>setNotice({text,error}),[]);
 const route=routes.find(r=>r[0]===page)!;
 const Current=pages[page as keyof typeof pages] as React.ComponentType<any>;
 const navigation=(compact=false)=><><a href="#overview" className="n-brand"><span className="n-mark" aria-hidden="true">ن</span><span className={compact?'sr-only':''}>Nocheh<small>Your personal brain</small></span></a><nav aria-label="Main navigation">{groups.map(([label,keys])=><div className="n-nav-group" key={label}><span className={compact?'sr-only':'n-nav-label'}>{label}</span>{keys.map(key=>{const [id,title,Icon]=routes.find(r=>r[0]===key)!;const link=<a href={'#'+id} aria-current={page===id?'page':undefined} aria-label={compact?title:undefined} onClick={()=>setMobile(false)}><Icon size={18} aria-hidden="true"/><span className={compact?'sr-only':''}>{title}</span></a>;return compact?<Tooltip label={title} key={id}>{link}</Tooltip>:<React.Fragment key={id}>{link}</React.Fragment>;})}</div>)}</nav><div className="n-sidebar-foot"><a href="/hermes/nocheh" title="Open Hermes"><Plug size={16}/><span className={compact?'sr-only':''}>Hermes</span><ArrowUpRight size={14}/></a><a href="/providers/management.html" title="Open provider monitor"><ActivityIcon size={16}/><span className={compact?'sr-only':''}>Provider monitor</span><ArrowUpRight size={14}/></a>{!compact&&<small>Local owner dashboard</small>}</div></>;
 return <div className={'nocheh-app'+(collapsed?' sidebar-collapsed':'')+(['graph','memoryMap'].includes(page)?' n-graph-active':'')}><a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById('main-content')?.focus();}}>Skip to content</a><aside className="n-sidebar">{navigation(collapsed)}<Button className="sidebar-toggle" onClick={toggle} aria-label={collapsed?'Expand sidebar':'Collapse sidebar'}>{collapsed?<PanelLeftOpen size={18}/>:<><PanelLeftClose size={18}/><span>Collapse sidebar</span></>}</Button></aside><Sheet open={mobile} onOpenChange={setMobile} title="Navigation" side="left" returnFocus={menu.current}><div className="mobile-navigation">{navigation()}</div></Sheet><main className="n-main" id="main-content" tabIndex={-1}><header className="n-header"><div className="page-title"><Button className="mobile-menu" size="icon" onClick={()=>setMobile(true)} ref={menu} aria-label="Open navigation"><Menu size={20}/></Button><div><p className="n-eyebrow">NOCHEH / {groups.find(g=>g[1].some(id=>id===page))?.[0]}</p><h1 ref={heading} tabIndex={-1}>{route[1]}</h1><p className="n-page-description">{route[3]}</p></div></div><div className="header-actions"><PersistentStatus/><ThemeSelect/><Button onClick={refresh} disabled={refreshing} aria-label="Refresh page data"><RefreshCw size={15} className={refreshing?'refreshing':''}/><span>Refresh</span></Button></div></header>{notice&&<div className={'n-notice '+(notice.error?'n-error':'')} role={notice.error?'alert':'status'}><span>{notice.text}</span><Button size="icon" variant="ghost" onClick={()=>setNotice(null)} aria-label="Dismiss notification"><X size={16}/></Button></div>}<div className="page-content" key={page}><Current notify={notify} call={pages.call} renderSource={(record:any)=><pages.Source record={record} notify={notify}/>} refresh={0}/></div><footer>Owned sources. Useful memory. Clear operations.</footer></main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
