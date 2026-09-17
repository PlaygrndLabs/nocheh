import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
export function Jobs({notify}) {
    const [tick,setTick]=useState(0),{data:jobs,error}=useResource('/jobs',10000,tick),[settings]=useLoad('/settings');
    const [selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[mapping,setMapping]=useState({}),[reviewApproved,setReviewApproved]=useState(false);

    const fields=Object.fromEntries((settings?.fields||[]).map(f=>[f.key,f.value]));
    const scopes=[fields.TELEGRAM_OWNER_ID,...(fields.TELEGRAM_GROUP_IDS||'').split(',')].filter(Boolean);
    const upload=async files=>{
      if(!files.length)return;setBusy(true);setProgress('Preparing upload…');
      try{
        const job=await call('/jobs',{});let done=0;
        for(const file of files){
          const name=file.webkitRelativePath||file.name;
          const response=await sdk.authedFetch(base+'/jobs/'+job.id+'/upload?name='+encodeURIComponent(name),{method:'PUT',body:file});
          if(!response.ok)throw new Error((await response.json()).error||'Upload failed');
          setProgress('Uploaded '+(++done)+' of '+files.length+' files');
        }
        setProgress('Checking export and media…');const preview=await call('/jobs/'+job.id+'/preview',{});
        setSelected(preview);setMapping({});setReviewApproved(false);setTick(v=>v+1);setProgress('Ready to review.');
      }catch(e){notify(errorText(e),true);setProgress('Upload needs attention. Your archive has not been imported.');}finally{setBusy(false);}
    };
    const run=async(job,action)=>{setBusy(true);try{const result=await call('/jobs/'+job.id+'/'+action,action==='start'?{mapping:job.mapping||mapping,review_approved:job.review_approved??reviewApproved}:{});setSelected(result);setTick(v=>v+1);notify(action==='cancel'?'Import stopped. Already archived messages are retained.':'Import started. Historical messages will not send replies.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const current=jobs?.find(j=>j.id===selected?.id)||selected;
    return h('div',null,h(Panel,{title:'1. Choose a Telegram export',note:'Export from Telegram Desktop as JSON. Select the export folder to include media, a ZIP, or a JSON file for text only.'},
      h(Steps,{items:['Choose an export','Review access and files','Import and track progress'],current:current?.state==='ready'?1:current?.preview?2:0}),h('div',{className:'n-actions'},h('label',{className:'n-file'},'Select JSON or ZIP',h('input',{type:'file',accept:'.json,.zip',disabled:busy,onChange:e=>upload([...e.target.files])})),
        h('label',{className:'n-file'},'Select export folder',h('input',{type:'file',webkitdirectory:'',multiple:true,disabled:busy,onChange:e=>upload([...e.target.files])}))),
      h('p',{role:'status'},progress),h('p',{className:'n-muted'},'Limits: 32 MiB export JSON, 50 MiB per media file, 256 MiB ZIP upload, 512 MiB unpacked.')),
      !current?.preview&&h(Panel,{title:'2. Review access and files',note:'Choose an export above to preview message counts and missing files, then decide whether its history stays private or is shared with a selected group.'}),current?.preview&&h(Panel,{title:'2. Review access and files'},
        h('p',null,current.preview.messages+' messages · '+current.preview.supplied_files+' supplied files · '+current.preview.missing_files+' missing files'),
        ...current.preview.chats.map(c=>h('div',{className:'n-field',key:c.id},h('label',{htmlFor:'scope-'+c.id},c.name+' · '+c.messages+' messages'),
          h('select',{id:'scope-'+c.id,value:(current.mapping||mapping)[c.id]||'',disabled:busy||current.state!=='ready',onChange:e=>{const next={...mapping};if(e.target.value)next[c.id]=e.target.value;else delete next[c.id];setMapping(next);}},
            h('option',{value:''},'Owner-only archive (default)'),...scopes.map(s=>h('option',{value:s,key:s},s===fields.TELEGRAM_OWNER_ID?'Owner DM · '+s:'Share with group · '+s))))),
        h('p',{className:'n-muted'},'Group mapping makes this history available to that group. Import stores originals; it does not automatically rewrite memory.'),
        h('label',{className:'n-review-consent'},h('input',{type:'checkbox',checked:current.review_approved??reviewApproved,disabled:busy||current.state!=='ready',onChange:e=>setReviewApproved(e.target.checked)}),'Allow this import to be learned by memory'),h('p',{className:'n-muted'},'Optional. This permits native memory review and Honcho learning when attached. Guarding alone does not permit learning. This choice is preserved when resuming.'),h(StatusBadge,{state:current.state,label:friendlyState(current.state)}),current.preview.messages>0&&h(Progress,{value:100*current.completed/current.preview.messages,label:current.completed+' / '+current.preview.messages+' messages · '+current.duplicates+' duplicates'}),
        current.error&&h('p',{role:'alert'},current.error),
        ['ready','failed','cancelled','interrupted'].includes(current.state)&&button(current.completed?'Resume import':'Start import',()=>run(current,'start'),busy,'n-primary'),
        current.state==='running'&&button('Stop import',()=>run(current,'cancel'))),
      h(Panel,{title:'3. Import history',note:'Select an import to inspect its progress or resume it. Maintenance and settings jobs appear in Maintenance.'},error&&h('p',{role:'alert'},error),jobs?.some(j=>j.kind==='import')?h('div',{className:'n-list'},...jobs.filter(j=>j.kind==='import').map(j=>h('div',{className:'n-job',key:j.id},
        button(jobName(j.kind)+' · '+new Date(j.created_at).toLocaleString(),()=>{setSelected(j);setMapping(j.mapping||{});setReviewApproved(j.review_approved??false);}),h(StatusBadge,{state:j.state,label:friendlyState(j.state)}),h('small',null,j.completed+' processed'),j.error&&h('p',{role:'alert'},j.error),
        j.result&&j.kind!=='import'&&h('p',null,'Result: '+(j.result.status||j.state))))):h('p',{className:'n-muted'},jobs?'No imports yet. Your first import will appear here.':'Loading import history…')));
  }
