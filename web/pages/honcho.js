import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {useOwnerCommand} from '../lib/owner-controls.tsx';
export function Honcho({notify}) {
    const [tick,setTick]=useState(0),{data:memory,error:memoryError}=useResource('/memory/honcho',10000,tick),[history,setHistory]=useState(false),[catchUp,setCatchUp]=useState(false);
    const connectionCommand=useOwnerCommand();
    const connect=async attached=>{const result=await connectionCommand.run('/memory/honcho',{attached,include_history:history,catch_up:catchUp,expected_revision:memory.connection.revision});if(result){setTick(v=>v+1);notify(attached?'Memory attached. Current authorized sources are being prepared.':'Memory detached. Originals and guarded edits are preserved.');}};
    const {data:status,error}=useResource('/honcho/status',10000),[workspace,setWorkspace]=useState(''),[kind,setKind]=useState('workspace'),[data,setData]=useState(null),[busy,setBusy]=useState(false);
    const query=async()=>{setBusy(true);setData(null);try{setData(await call('/honcho/read',{args:kind==='workspace'?['workspace','list']:[kind,'list','-w',workspace]}));}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const total=(memory?.receipts||[]).reduce((n,r)=>n+r.count,0),done=(memory?.receipts||[]).filter(r=>r.state==='done').reduce((n,r)=>n+r.count,0);
    return h('div',null,h(Panel,{title:'Primary long-term memory',note:'Honcho recalls learned sources. Hermes keeps compact native working notes. Originals and saved guarded copies remain in Nocheh.'},
      memoryError&&h('p',{role:'alert'},memoryError),memory&&h('div',null,
        h('div',{className:'connection-grid'},
          h('div',null,h('small',null,'Connection'),h(StatusBadge,{state:memory.connection.attached?'connected':'disabled',label:memory.connection.attached?'Attached':'Detached'})),
          h('div',null,h('small',null,'Memory availability'),h(StatusBadge,{state:memory.limited_memory?'limited':'ready',label:memory.limited_memory?'Limited memory':'Current memory ready'})),
          h('div',null,h('small',null,'Synchronization'),h(StatusBadge,{state:memory.syncing?'syncing':'unknown',label:memory.syncing?'Preparing current sources':'No build in progress'})),
          h('div',null,h('small',null,'Live compatibility'),h(StatusBadge,{state:memory.connection.verified?'verified':'unverified'}))),
        total>0&&h(Progress,{value:100*done/total,label:done+' / '+total+' stored ingestion receipts complete'}),
        h('p',{className:'n-muted'},'Receipt counts describe recorded ingestion, not an estimate of all future sources. Native notes and archive search remain available.'),
        h('div',{className:'health-strip'},...(memory.receipts||[]).map(r=>h(StatusBadge,{key:r.state,state:r.state,label:r.count+' '+friendlyState(r.state)}))),

        !memory.connection.verified&&h('p',{className:'n-muted'},'Live Honcho ingestion, recall, reasoning, restart and provider-failure checks are still pending. Attachment is disabled.'),
        h('fieldset',{className:'honcho-attachment-options'},
          h('legend',null,'When attaching memory'),
          h('label',{className:'honcho-attachment-option'},h('input',{type:'checkbox',checked:history,onChange:e=>setHistory(e.target.checked)}),h('span',null,'Include previously consented history when attaching')),
          h('label',{className:'honcho-attachment-option'},h('input',{type:'checkbox',checked:catchUp,onChange:e=>setCatchUp(e.target.checked)}),h('span',null,'Catch up on consented sources received while detached'))),
        h('p',{className:'n-muted honcho-attachment-note'},'Previously learned sources rebuild in the current mode. These options do not approve learning from any new import.'),
        connectionCommand.error&&h(Alert,null,connectionCommand.error),
        button(memory.connection.attached?'Detach memory':'Attach memory',()=>connect(!memory.connection.attached),connectionCommand.busy||!!memoryError||!memory.connection.attached&&!memory.connection.verified),
        h(Details,{value:{generations:memory.generations,receipts:memory.receipts},label:'Preparation and ingestion receipts'}))),
      h(Panel,{title:'Connection checks',note:'Pinned local Honcho services use subscription reasoning and a dedicated, capped embeddings route.'},
      error&&h('p',{role:'alert'},error),!status&&!error&&h('p',{role:'status'},'Checking Honcho…'),status&&h('div',null,
        h(StatusBadge,{state:status.running?'running':'disabled',label:status.running?'Honcho services running':'Honcho stopped'}),
        h('div',{className:'n-row'},h('b',null,'Live compatibility'),h(StatusBadge,{state:memory?.connection?.verified?'verified':'unverified'})),
        h('div',{className:'n-row'},h('b',null,'Shared ChatGPT login'),h(StatusBadge,{state:status.subscription_login?'ready':'unverified',label:status.subscription_login?'Configured':'Not configured'})),
        h('div',{className:'n-row'},h('b',null,'Embedding credential'),h('span',null,status.embedding_credential?'Configured':'Not configured')),
        h('div',{className:'n-row'},h('b',null,'Metered API budget cap'),h('span',null,'$'+status.api_budget_usd+' · not a live spending balance')),
        !status.running&&h('p',{className:'n-empty'},'Stored-data browsing is available while Honcho is running. Use the Honcho CLI for setup and lifecycle controls.'),
        h(Details,{value:status,label:'Honcho version and technical status'}))),
      h(Panel,{title:'Browse stored Honcho data',note:'Workspaces contain peers (people or agents) and sessions (conversations). These reads do not ask a model to generate new memory.'},
        h('div',{className:'n-form'},h('label',null,'What to browse',h('select',{value:kind,onChange:e=>{setKind(e.target.value);setData(null);}},...['workspace','peer','session'].map(v=>h('option',{key:v,value:v},({workspace:'Workspaces',peer:'Peers · people and agents',session:'Sessions · conversations'})[v])))),kind!=='workspace'&&h('label',null,'Workspace ID',h('input',{value:workspace,onChange:e=>{setWorkspace(e.target.value);setData(null);}}))),
        button(busy?'Loading…':'Load stored data',query,busy||!status?.running||(kind!=='workspace'&&!workspace.trim())),
        data&&h('div',null,data.error?h('p',{role:'alert'},data.error):h('p',{className:'n-afterword'},data.complete?'Stored data loaded.':'Showing the returned page. More data may be available through the CLI.'),h(Details,{value:data,label:'Stored data response'})),
        h('details',{className:'n-afterword'},h('summary',null,'CLI commands and setup'),h('p',{className:'n-muted'},'Use the existing terminal workflow to configure Honcho or retrieve structured data.'),h(Data,{value:'./scripts/nocheh honcho doctor\n./scripts/nocheh honcho workspace list --json\n./scripts/nocheh honcho peer list -w WORKSPACE_ID --json'}))));
  }
