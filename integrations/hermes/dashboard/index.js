(() => {
  const sdk = window.__HERMES_PLUGIN_SDK__;
  const {createElement: h, useState, useEffect, useRef} = sdk.React;
  const base = '/api/plugins/nocheh';
  const call = (path, body) => sdk.fetchJSON(base + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const button = (label, onClick, disabled = false, className = '') => h('button', {type: 'button', onClick, disabled, className}, label);
  const errorText = e => e.message || 'The operation could not finish. Try again.';
  const labels = {NOCHEH_PORT:'Archive port', NOCHEH_MODEL:'ChatGPT model', NOCHEH_GUARD_MODE:'Outgoing guard',
    NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Trusted destinations (JSON)', TELEGRAM_ENABLED:'Telegram enabled',
    TELEGRAM_BOT_TOKEN:'Telegram bot token', TELEGRAM_OWNER_ID:'Owner user ID', TELEGRAM_GROUP_IDS:'Selected group IDs',
    POSTGRES_PASSWORD:'Database credential', SERVICE_TOKEN:'Service credential', NOCHEH_CONFIG_VERSION:'Configuration version'};
  function Panel({title, children, note}) { return h('section', {className:'n-panel'}, h('h2', null, title), note && h('p', {className:'n-muted'}, note), children); }
  function Data({value}) { return h('pre', {className:'n-data', dir:'auto'}, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
  function useLoad(path, refresh = 0) {
    const [data,setData] = useState(null), [error,setError] = useState('');
    useEffect(() => { let alive=true; setError(''); call(path).then(v => {if(alive)setData(v);}).catch(e => {if(alive)setError(errorText(e));}); return()=>{alive=false;}; }, [path,refresh]);
    return [data,error];
  }
  function Status({refresh}) {
    const [data,error] = useLoad('/status',refresh);
    if(error)return h('p',{role:'alert'},error);
    if(!data)return h('p',{role:'status'},'Connecting to your archive…');
    return h('div',null,
      h('div',{className:'n-metrics'},
        h(Panel,{title:'Archive'},h('strong',null,'Connected'),h('p',{className:'n-muted'},'Original messages and files stay in your owned archive.')),
        h(Panel,{title:'Outgoing guard'},h('strong',null,data.guard_mode),h('p',{className:'n-muted'},'Trust is determined by destination policy.')),
        h(Panel,{title:'Memory'},h('strong',null,'Hermes native'),h('p',{className:'n-muted'},'Separate profiles for the owner and selected groups.'))),
      h(Panel,{title:'Services'},h('div',{className:'n-list'},...(data.services||[]).map(s=>h('div',{className:'n-row',key:s.service},h('b',null,s.service),h('span',null,'Last seen '+new Date(s.seen_at).toLocaleString()))))),
      h(Panel,{title:'Archive work'},h('p',null,(data.archive?.events||0)+' original events preserved'),
        ...['artifacts','dispatches','transcriptions','actions'].map(kind=>h('div',{className:'n-row',key:kind},
          h('b',null,({artifacts:'Files',dispatches:'Assistant replies',transcriptions:'Transcripts',actions:'Approved actions'})[kind]),
          h('span',null,data.archive?.[kind]?.length?data.archive[kind].map(s=>s.count+' '+s.state).join(' · '):'No work queued'))),
        data.archive?.dispatch_failures?.length>0&&h('details',null,h('summary',null,'Inspect suppressed or failed work'),h(Data,{value:data.archive.dispatch_failures}))));
  }
  function Settings({notify}) {
    const [refresh,setRefresh]=useState(0),[data,error]=useLoad('/settings',refresh);
    const [changes,setChanges]=useState({}),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
    const save=async()=>{setBusy(true);try{await call('/settings',{revision:data.revision,changes});setChanges({});setReview(false);setRefresh(v=>v+1);notify('Settings saved. Apply them to update the running services.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const apply=async()=>{setBusy(true);try{const job=await call('/settings/apply',{});notify('Apply started. Follow its result in Imports & jobs. Job '+job.id);}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    if(error)return h('p',{role:'alert'},error);
    if(!data)return h('p',null,'Loading settings…');
    return h(Panel,{title:'Configuration',note:'Nocheh settings are saved in .env. Saved changes take effect after Apply. Credentials are never displayed.'},
      h('p',{className:'n-badge'},'Runtime configuration: '+data.apply_state),
      h('form',{onSubmit:e=>{e.preventDefault();setReview(true);}},h('div',{className:'n-form'},...data.fields.map(f=>{
        const value=changes[f.key]??f.value??'';
        const attrs={id:f.key,disabled:busy||!f.editable,value,type:f.secret?'password':'text',autoComplete:'off',
          onChange:e=>{setChanges({...changes,[f.key]:e.target.value});setReview(false);}};
        let input;
        if(f.key==='NOCHEH_GUARD_MODE'||f.key==='TELEGRAM_ENABLED') input=h('select',attrs,...(f.key==='NOCHEH_GUARD_MODE'?['auto','on','off']:['false','true']).map(v=>h('option',{key:v,value:v},v)));
        else input=h('input',attrs);
        return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]||f.key),input,
          h('small',null,f.secret?(f.configured?(f.editable?'Configured. Enter a replacement to change it.':'Configured. Managed internally.'):'Not configured.'):(f.editable?'Source: '+f.source:'Managed automatically')));
      })),h('div',{className:'n-actions'},h('button',{disabled:busy||!Object.keys(changes).length},'Review changes'),button('Apply saved settings',apply,busy))),
      review&&h('div',{className:'n-review'},h('h3',null,'Review before saving'),...Object.entries(changes).map(([k,v])=>h('p',{key:k},(labels[k]||k)+': '+(data.fields.find(f=>f.key===k)?.secret?'Replace stored credential':v))),button('Save changes',save,busy,'n-primary')));
  }
  function Jobs({notify}) {
    const [tick,setTick]=useState(0),[jobs,error]=useLoad('/jobs',tick),[settings]=useLoad('/settings');
    const [selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[mapping,setMapping]=useState({});
    useEffect(()=>{const timer=setInterval(()=>setTick(v=>v+1),2500);return()=>clearInterval(timer);},[]);
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
        setSelected(preview);setMapping({});setTick(v=>v+1);setProgress('Ready to review.');
      }catch(e){notify(errorText(e),true);setProgress('Upload needs attention. Your archive has not been imported.');}finally{setBusy(false);}
    };
    const run=async(job,action)=>{try{const result=await call('/jobs/'+job.id+'/'+action,action==='start'?{mapping:job.mapping||mapping}:{});setSelected(result);setTick(v=>v+1);notify(action==='cancel'?'Import stopped. Already archived messages are retained.':'Import started. Historical messages will not send replies.');}catch(e){notify(errorText(e),true);}};
    const current=jobs?.find(j=>j.id===selected?.id)||selected;
    return h('div',null,h(Panel,{title:'Import chat history',note:'Export from Telegram Desktop as JSON. Select the export folder to include media, a ZIP, or a JSON file for text only.'},
      h('div',{className:'n-actions'},h('label',{className:'n-file'},'Select JSON or ZIP',h('input',{type:'file',accept:'.json,.zip',disabled:busy,onChange:e=>upload([...e.target.files])})),
        h('label',{className:'n-file'},'Select export folder',h('input',{type:'file',webkitdirectory:'',multiple:true,disabled:busy,onChange:e=>upload([...e.target.files])}))),
      h('p',{role:'status'},progress),h('p',{className:'n-muted'},'Limits: 32 MiB export JSON, 50 MiB per media file, 256 MiB ZIP upload, 512 MiB unpacked.')),
      current?.preview&&h(Panel,{title:'Review import'},
        h('p',null,current.preview.messages+' messages · '+current.preview.supplied_files+' supplied files · '+current.preview.missing_files+' missing files'),
        ...current.preview.chats.map(c=>h('div',{className:'n-field',key:c.id},h('label',{htmlFor:'scope-'+c.id},c.name+' · '+c.messages+' messages'),
          h('select',{id:'scope-'+c.id,value:(current.mapping||mapping)[c.id]||'',disabled:current.state!=='ready',onChange:e=>{const next={...mapping};if(e.target.value)next[c.id]=e.target.value;else delete next[c.id];setMapping(next);}},
            h('option',{value:''},'Owner-only archive (default)'),...scopes.map(s=>h('option',{value:s,key:s},s===fields.TELEGRAM_OWNER_ID?'Owner DM · '+s:'Share with group · '+s))))),
        h('p',{className:'n-muted'},'Group mapping makes this history available to that group. Import stores originals; it does not automatically rewrite memory.'),
        h('p',{role:'status'},current.state+' · '+current.completed+' / '+current.preview.messages+' messages · '+current.duplicates+' duplicates'),
        current.error&&h('p',{role:'alert'},current.error),
        ['ready','failed','cancelled','interrupted'].includes(current.state)&&button(current.completed?'Resume import':'Start import',()=>run(current,'start'),busy,'n-primary'),
        current.state==='running'&&button('Stop import',()=>run(current,'cancel'))),
      h(Panel,{title:'Imports & jobs'},error&&h('p',{role:'alert'},error),jobs?.length?h('div',{className:'n-list'},...jobs.map(j=>h('div',{className:'n-job',key:j.id},
        button(j.kind+' · '+new Date(j.created_at).toLocaleString(),()=>setSelected(j)),h('span',{className:'n-badge'},j.state),h('small',null,j.completed+' processed'),j.error&&h('p',{role:'alert'},j.error),
        j.result&&j.kind!=='import'&&h('p',null,'Result: '+(j.result.status||j.state))))):h('p',{className:'n-muted'},'No jobs yet. Your first import will appear here.')));
  }
  function Archive({notify}) {
    const [query,setQuery]=useState(''),[results,setResults]=useState(null),[record,setRecord]=useState(null),[busy,setBusy]=useState(false);
    const search=async e=>{e.preventDefault();setBusy(true);try{setResults(await call('/search?q='+encodeURIComponent(query)));setRecord(null);}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const read=async id=>{try{setRecord(await call('/events/'+id));}catch(e){notify(errorText(e),true);}};
    const rows=Array.isArray(results)?results:results?.results||results?.items||[];
    return h('div',null,h(Panel,{title:'Search your archive',note:'Search original messages and derived text. Owner access spans all chats.'},
      h('form',{className:'n-actions',onSubmit:search},h('label',{className:'n-grow'},'Search terms',h('input',{value:query,onChange:e=>setQuery(e.target.value),required:true})),h('button',{disabled:busy},busy?'Searching…':'Search')),
      results&&(!rows.length?h('p',null,'No matching messages.'):h('div',{className:'n-list'},...rows.map(r=>h('article',{className:'n-result',key:r.id||r.event_id},h('small',null,r.scope),h('p',{dir:'auto'},r.text||r.snippet||r.preview),button('Open source',()=>read(r.id||r.event_id))))))),
      record&&h(Panel,{title:'Original source'},h('p',{dir:'auto',className:'n-source'},record.event?.text),h('details',null,h('summary',null,'Source, files and provenance'),h(Data,{value:record}))));
  }
  const extensions = {};
  window.__NOCHEH_PAGES__=extensions;
  function App() {
    const [page,setPage]=useState(location.hash.slice(1)||'overview'),[notice,setNotice]=useState(null),[tick,setTick]=useState(0);
    const root=useRef(null);
    useEffect(()=>{const change=()=>setPage(location.hash.slice(1)||'overview');addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);
    useEffect(()=>{
      // Keep the native shell mounted for its SDK; avoid unreachable background controls.
      const hidden=[];let node=root.current;
      while(node?.parentElement&&node.parentElement!==document.body){for(const sibling of node.parentElement.children)if(sibling!==node){hidden.push([sibling,sibling.inert,sibling.style.visibility]);sibling.inert=true;sibling.style.visibility='hidden';}node=node.parentElement;}
      return()=>hidden.forEach(([node,inert,visibility])=>{node.inert=inert;node.style.visibility=visibility;});
    },[]);
    const notify=(text,error=false)=>setNotice({text,error});
    const pages={overview:'Overview',settings:'Settings',imports:'Imports & jobs',archive:'Archive',...Object.fromEntries(Object.entries(extensions).map(([k,v])=>[k,v.label]))};
    const Current=extensions[page]?.component;
    return h('div',{className:'nocheh-app',ref:root},
      h('aside',{className:'n-sidebar'},h('a',{href:'#overview',className:'n-brand'},h('span',{className:'n-mark','aria-hidden':true},'N'),h('div',null,'nocheh',h('small',null,'Your owned AI brain'))),
        h('nav',{'aria-label':'Nocheh'},...Object.entries(pages).map(([key,label])=>h('a',{href:'#'+key,key,'aria-current':page===key?'page':undefined},label))),
        h('div',{className:'n-sidebar-foot'},h('span',{className:'n-dot'}),'Local workspace',h('small',null,'Powered by Hermes'))),
      h('main',{className:'n-main'},h('header',{className:'n-header'},h('div',null,h('p',{className:'n-eyebrow'},'PERSONAL WORKSPACE'),h('h1',null,pages[page]||'Overview')),button('Refresh',()=>setTick(v=>v+1))),
        notice&&h('div',{className:'n-notice '+(notice.error?'n-error':''),role:notice.error?'alert':'status'},notice.text,button('Dismiss',()=>setNotice(null))),
        h('div',{key:page+tick},page==='settings'?h(Settings,{notify}):page==='imports'?h(Jobs,{notify}):page==='archive'?h(Archive,{notify}):Current?h(Current,{notify,call,h,sdk}):h(Status,{refresh:tick})),
        h('footer',null,'Originals are evidence. Memories and transcripts are separate views.')));
  }
  window.__HERMES_PLUGINS__.register('nocheh',App);
})();
