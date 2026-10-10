import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {useOwnerCommand} from '../lib/owner-controls.tsx';
const dollars=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:value>0&&value<.1?6:2,maximumFractionDigits:value>0&&value<.1?6:2}).format(value);
const percentLabel=value=>value>0&&value<1?'Less than 1%':Math.round(value)+'%';

function HonchoBudget({notify,editable}) {
    const {data:budget,error}=useResource('/honcho/budget',10000),command=useOwnerCommand();
    const [draft,setDraft]=useState(''),[draftRevision,setDraftRevision]=useState(null),[dirty,setDirty]=useState(false),[inputError,setInputError]=useState('');
    useEffect(()=>{if(budget&&!dirty){setDraft((budget.limit_cents/100).toFixed(2));setDraftRevision(budget.revision);}},[budget?.limit_cents,budget?.revision,dirty]);
    const changed=dirty&&budget&&draftRevision!==budget.revision;
    const reload=()=>{setDraft((budget.limit_cents/100).toFixed(2));setDraftRevision(budget.revision);setDirty(false);setInputError('');command.clear();};
    const save=async event=>{
        event.preventDefault();setInputError('');
        if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(draft.trim())){setInputError('Enter a dollar amount with no more than two decimal places.');return;}
        const cents=Math.round(Number(draft)*100);
        if(cents>budget.max_limit_cents){setInputError('The maximum monthly cap is '+dollars(budget.max_limit_cents/100)+'.');return;}
        const result=await command.run('/honcho/budget',{limit_cents:cents,expected_revision:draftRevision});
        if(result){setDraft((result.limit_cents/100).toFixed(2));setDraftRevision(result.revision);setDirty(false);notify('Monthly embedding cap updated.');}
    };
    return h(React.Fragment,null,
      h(Panel,{title:'API embedding budget',note:'Paid OpenAI embeddings use the dedicated API key and this monthly dollar cap.'},
        error&&h('p',{role:'alert'},error),!budget&&!error&&h('p',{role:'status'},'Loading embedding budget…'),budget&&h('div',null,
          h('div',{className:'honcho-budget-summary'},
            h('div',{className:'honcho-budget-stat'},h('small',null,'Counted toward cap'),h('strong',null,dollars(budget.counted_toward_cap_usd)),h('span',null,'of '+dollars(budget.limit_usd)+' cap')),
            h('div',{className:'honcho-budget-stat'},h('small',null,'Remaining admission headroom'),h('strong',null,dollars(budget.remaining_usd)),h('span',null,budget.mode==='monthly'?'UTC monthly window':'Pilot budget')),
            h('div',{className:'honcho-budget-stat'},h('small',null,'Estimated API cost'),h('strong',null,dollars(budget.estimated_embedding_cost_usd)),h('span',null,budget.embedding_tokens.toLocaleString()+' reported tokens')),
            h('div',{className:'honcho-budget-stat'},h('small',null,'Embedding requests'),h('strong',null,budget.embedding_requests.toLocaleString()),h('span',null,budget.embedding_unreported_requests.toLocaleString()+' without a usage report'))),
          budget.limit_usd>0&&h(Progress,{value:Math.min(100,100*budget.counted_toward_cap_usd/budget.limit_usd),label:percentLabel(100*budget.counted_toward_cap_usd/budget.limit_usd)+' of embedding cap counted'}),
          h('p',{className:'n-muted honcho-budget-note'},'Each attempt holds $'+budget.embedding_hold_usd.toFixed(2)+' before the API call. Reported successes settle by tokens; confirmed HTTP errors release their holds. Transport failures and calls without a usable response retain their holds. '+dollars(budget.released_error_holds_usd||0)+' in error holds was released this window; '+dollars(budget.legacy_error_exposure_unverified_usd||0)+' of that came from historical errors whose response type cannot be verified. The estimate covers reported Honcho tokens, not your provider invoice. ',
            h('a',{href:'https://platform.openai.com/usage',target:'_blank',rel:'noopener noreferrer'},'Check OpenAI API usage')),
          budget.mode==='monthly'&&editable?h('form',{className:'honcho-budget-form',onSubmit:save},
            h('label',{htmlFor:'honcho-budget-limit'},'Monthly embedding cap (USD)'),
            h('input',{id:'honcho-budget-limit',type:'number',inputMode:'decimal',min:0,max:budget.max_limit_cents/100,step:'.01',value:draft,
              'aria-describedby':'honcho-budget-help'+(inputError?' honcho-budget-error':''),'aria-invalid':!!inputError,
              onChange:event=>{setDraft(event.target.value);setDirty(true);setInputError('');}}),
            h('p',{id:'honcho-budget-help',className:'n-muted'},'Set $0 to pause paid embeddings. Lowering the cap preserves all existing accounting.'),
            changed&&h(Alert,null,'The cap changed elsewhere. Load the latest value before saving.'),
            inputError&&h('p',{id:'honcho-budget-error',role:'alert',className:'honcho-budget-error'},inputError),
            command.error&&h(Alert,null,command.error),
            h('div',{className:'n-actions'},h(Button,{type:'submit',disabled:command.busy||changed||!dirty},command.busy?'Saving…':'Save monthly cap'),changed&&button('Load latest cap',reload)))
            :h('p',{className:'n-muted'},budget.mode==='monthly'?'Changing the monthly cap requires verified, attached Honcho memory.':'The $5 pilot cap is fixed. Monthly editing becomes available after the pilot cutover and accepted attachment.'))),
      h(Panel,{title:'Subscription reasoning limit',note:'Honcho LLM calls use the shared ChatGPT subscription, separate from the paid embedding key.'},
        error&&h('p',{role:'alert'},error),!budget&&!error&&h('p',{role:'status'},'Loading reasoning usage…'),budget&&h('div',null,
          h('div',{className:'honcho-budget-summary'},
            h('div',{className:'honcho-budget-stat'},h('small',null,'Reasoning requests this window'),h('strong',null,budget.reasoning_requests.toLocaleString()),h('span',null,'of '+budget.reasoning_request_limit.toLocaleString()+' safety limit')),
            h('div',{className:'honcho-budget-stat'},h('small',null,'Requests remaining'),h('strong',null,budget.reasoning_remaining_requests.toLocaleString()),h('span',null,budget.mode==='monthly'?'Resets with the UTC month':'Pilot window'))),
          h(Progress,{value:Math.min(100,100*budget.reasoning_requests/budget.reasoning_request_limit),label:Math.round(100*budget.reasoning_requests/budget.reasoning_request_limit)+'% of subscription request limit used'}),
          h('p',{className:'n-muted honcho-budget-note'},'This is a request safety limit, not a dollar budget. Reasoning calls do not consume the embedding cap.'))));
}
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
        h(Details,{value:{workspace:memory.workspace,sessions:memory.sessions,receipts:memory.receipts,deletions:memory.deletions},label:'Workspace, sessions and ingestion receipts'}))),
      h(HonchoBudget,{notify,editable:!!memory?.connection?.attached&&!!memory?.connection?.verified}),
      h(Panel,{title:'Connection checks',note:'Pinned local Honcho services use subscription reasoning and a dedicated, capped embeddings route.'},
      error&&h('p',{role:'alert'},error),!status&&!error&&h('p',{role:'status'},'Checking Honcho…'),status&&h('div',null,
        h(StatusBadge,{state:status.running?'running':'disabled',label:status.running?'Honcho services running':'Honcho stopped'}),
        h('div',{className:'n-row'},h('b',null,'Live compatibility'),h(StatusBadge,{state:memory?.connection?.verified?'verified':'unverified'})),
        h('div',{className:'n-row'},h('b',null,'Shared reasoning login'),h(StatusBadge,{state:status.subscription_login?'ready':'unverified',label:status.subscription_login?'Configured':'Not configured'})),
        h('div',{className:'n-row'},h('b',null,'Embedding credential'),h('span',null,status.embedding_credential?'Configured':'Not configured')),
        !status.running&&h('p',{className:'n-empty'},'Stored-data browsing is available while Honcho is running. Use the Honcho CLI for setup and lifecycle controls.'),
        h(Details,{value:status,label:'Honcho version and technical status'}))),
      h(Panel,{title:'Browse stored Honcho data',note:'Workspaces contain peers (people or agents) and sessions (conversations). These reads do not ask a model to generate new memory.'},
        h('div',{className:'n-form'},h('label',null,'What to browse',h('select',{value:kind,onChange:e=>{setKind(e.target.value);setData(null);}},...['workspace','peer','session'].map(v=>h('option',{key:v,value:v},({workspace:'Workspaces',peer:'Peers · people and agents',session:'Sessions · conversations'})[v])))),kind!=='workspace'&&h('label',null,'Workspace ID',h('input',{value:workspace,onChange:e=>{setWorkspace(e.target.value);setData(null);}}))),
        button(busy?'Loading…':'Load stored data',query,busy||!status?.running||(kind!=='workspace'&&!workspace.trim())),
        data&&h('div',null,data.error?h('p',{role:'alert'},data.error):h('p',{className:'n-afterword'},data.complete?'Stored data loaded.':'Showing the returned page. More data may be available through the CLI.'),h(Details,{value:data,label:'Stored data response'})),
        h('details',{className:'n-afterword'},h('summary',null,'CLI commands and setup'),h('p',{className:'n-muted'},'Use the existing terminal workflow to configure Honcho or retrieve structured data.'),h(Data,{value:'./bin/nocheh honcho doctor\n./bin/nocheh honcho workspace list --json\n./bin/nocheh honcho peer list -w WORKSPACE_ID --json'}))));
  }
