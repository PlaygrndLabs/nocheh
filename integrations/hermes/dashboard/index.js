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
    useEffect(() => { let alive=true; setError(''); if(!path)return()=>{alive=false;}; call(path).then(v => {if(alive)setData(v);}).catch(e => {if(alive)setError(errorText(e));}); return()=>{alive=false;}; }, [path,refresh]);
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
      record&&h(Source,{record,notify}));
  }
  function Memory({notify}) {
    const [profiles,error]=useLoad('/memory/profiles'),[scope,setScope]=useState(''),[session,setSession]=useState(''),[offset,setOffset]=useState(0),[tick,setTick]=useState(0),[changes,setChanges]=useState({});
    useEffect(()=>{if(!scope&&profiles?.profiles?.length)setScope(profiles.profiles[0].scope);},[profiles]);
    const [data,problem]=useLoad(scope?'/memory?scope='+encodeURIComponent(scope)+'&session='+encodeURIComponent(session)+'&offset='+offset:null,tick);
    const [prefs]=useLoad(scope?'/memory/preferences?scope='+encodeURIComponent(scope):null,tick);
    const save=async()=>{try{await call('/memory/preferences',{scope,revision:prefs.revision,changes});setChanges({});setTick(v=>v+1);notify('Hermes preferences saved. They take effect on the next turn.');}catch(e){notify(errorText(e),true);}};
    return h('div',null,h(Panel,{title:'Hermes memory',note:'Native notes are maintained by Hermes. An explicit source citation is needed to identify supporting evidence.'},
      error&&h('p',{role:'alert'},error),h('label',null,'Chat profile',h('select',{value:scope,onChange:e=>{setScope(e.target.value);setSession('');setOffset(0);setChanges({});}},...(profiles?.profiles||[]).map(p=>h('option',{value:p.scope,key:p.scope},(p.owner?'Owner DM':'Group')+' · '+p.scope)))),
      scope&&problem&&h('p',{role:'alert'},problem),scope&&data?.scope===scope&&(data.memories||[]).map(m=>h('article',{key:m.name},h('h3',null,m.name),m.exists?h(Data,{value:m.text||'This note is empty.'}):h('p',{className:'n-muted'},'No note has been created yet.'),m.truncated&&h('p',null,'Showing the first 256 KiB.'),h('small',null,m.citations.length+' explicit source references')))),
      scope&&prefs?.scope===scope&&h(Panel,{title:'Profile preferences',note:'Source: Hermes config.yaml. Changes take effect on the next turn. Routing and scope policy remain managed by Nocheh.'},
        h('div',{className:'n-form'},...Object.entries(prefs.schema).map(([key,spec])=>h('label',{key},key.replaceAll('_',' ').replace('.',' · '),spec.choices?h('select',{value:changes[key]??prefs.values[key],onChange:e=>setChanges({...changes,[key]:e.target.value})},...spec.choices.map(v=>h('option',{key:v},v))):h('input',{type:'number',min:spec.min,max:spec.max,value:changes[key]??prefs.values[key],onChange:e=>setChanges({...changes,[key]:Number(e.target.value)})})))),button('Save profile preferences',save,!Object.keys(changes).length)),
      scope&&data?.scope===scope&&h(Panel,{title:'Native sessions'},session&&button('Back to sessions',()=>{setSession('');setOffset(0);}),
        !session&&!data.sessions.length&&h('p',{className:'n-muted'},'No sessions in this profile.'),
        ...data.sessions.map(s=>h('div',{className:'n-row',key:s.id},button(s.title||s.id,()=>{setSession(s.id);setOffset(0);}),h('small',null,s.source))),
        ...data.messages.map((m,i)=>h('article',{className:'n-result',key:m.id||i},h('b',null,m.role),h(Data,{value:m.content}),m.truncated&&h('small',null,'Message preview truncated.'))),
        h('div',{className:'n-actions'},offset>0&&button('Previous page',()=>setOffset(Math.max(0,offset-50))),data.next_offset!==null&&button('Next page',()=>setOffset(data.next_offset)))));
  }
  function Honcho({notify}) {
    const [status,error]=useLoad('/honcho/status'),[workspace,setWorkspace]=useState(''),[kind,setKind]=useState('workspace'),[data,setData]=useState(null),[busy,setBusy]=useState(false);
    const query=async()=>{setBusy(true);try{setData(await call('/honcho/read',{args:kind==='workspace'?['workspace','list']:[kind,'list','-w',workspace]}));}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h(Panel,{title:'Honcho experiment',note:'Separate from production Hermes memory. Stored-data inspection makes no inference requests.'},error&&h('p',{role:'alert'},error),status&&h(Data,{value:status}),
      h('div',{className:'n-form'},h('label',null,'Stored data',h('select',{value:kind,onChange:e=>setKind(e.target.value)},...['workspace','peer','session'].map(v=>h('option',{key:v,value:v},v+'s')))),kind!=='workspace'&&h('label',null,'Workspace ID',h('input',{value:workspace,onChange:e=>setWorkspace(e.target.value)}))),button('Load stored data',query,busy||!status?.running||(kind!=='workspace'&&!workspace)),data&&h(Data,{value:data}));
  }
  function download(path,name) {
    const a=document.createElement('a');a.href=base+path+'?name='+encodeURIComponent(name);a.download=name;document.body.appendChild(a);a.click();a.remove();
  }
  function exportJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function Source({record,notify}){
    return h(Panel,{title:'Original source'},h('p',{dir:'auto',className:'n-source'},record.event?.text),
      button('Download source JSON',()=>exportJSON(record,'nocheh-source-'+record.id+'.json')),
      ...record.artifacts.map(a=>h('div',{className:'n-row',key:a.id},h('span',null,a.metadata?.relative_path||a.kind),h('small',null,a.state),button('Download original file',()=>download('/artifacts/'+a.id+'/download',a.metadata?.relative_path?.split('/').pop()||a.id,notify),a.state!=='ready'))),
      ...record.derived.map(d=>h('article',{key:d.id},h('h3',null,'Derived '+d.kind),h(Data,{value:new TextDecoder().decode(Uint8Array.from(atob(d.content_base64),c=>c.charCodeAt(0)))}),h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:d.provenance})))),
      h('details',null,h('summary',null,'Source identity and complete metadata'),h(Data,{value:record})));
  }
  function Graph({notify}){
    const selection=useRef(0);
    const [scope,setScope]=useState(''),[scopeAfter,setScopeAfter]=useState(''),[scopeList,setScopeList]=useState([]),[scopes]=useLoad('/scopes?after='+encodeURIComponent(scopeAfter)),[after,setAfter]=useState(''),[history,setHistory]=useState([]),[data,setData]=useState(null),[selected,setSelected]=useState(null),[record,setRecord]=useState(null),[zoom,setZoom]=useState(1),[busy,setBusy]=useState(false);
    useEffect(()=>{if(scopes?.scopes){setScopeList(old=>[...new Map([...old,...scopes.scopes].map(s=>[s.scope,s])).values()]);if(!scope&&scopes.scopes.length)setScope(scopes.scopes[0].scope);}},[scopes]);
    useEffect(()=>{if(!scope)return;let alive=true;selection.current++;setBusy(true);setData(null);setRecord(null);setSelected(null);call('/graph?scope='+encodeURIComponent(scope)+'&after='+after).then(value=>{if(alive)setData(value);}).catch(e=>{if(alive)notify(errorText(e),true);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[scope,after]);
    const choose=async node=>{const request=++selection.current;setSelected(node);setRecord(null);if(node.event_id)try{const value=await call('/events/'+node.event_id);if(selection.current===request)setRecord(value);}catch(e){notify(errorText(e),true);}};
    const columns={scope:0,profile:0,memory:0,author:1,message:2,attachment:3,derived:4};const counts=[0,0,0,0,0];
    const placed=(data?.nodes||[]).map(n=>{const column=columns[n.kind]??0;return {...n,x:20+column*254,y:30+counts[column]++*82};});
    const byId=Object.fromEntries(placed.map(n=>[n.id,n])),height=Math.max(300,...counts.map(n=>n*82+45));
    return h('div',null,h(Panel,{title:'Evidence graph',note:'Observed source relationships, with explicit memory references. Select a node to inspect its source. This view makes no model calls.'},
      h('label',null,'Archive scope',h('select',{value:scope,onChange:e=>{setScope(e.target.value);setAfter('');setHistory([]);}},...scopeList.map(s=>h('option',{key:s.scope,value:s.scope},s.scope+' · '+s.events+' events')))),scopes?.next&&button('Load more scopes',()=>setScopeAfter(scopes.next)),
      !scopeList.length&&h('p',{className:'n-muted'},'No archived scopes yet. Import a chat to begin.'),busy&&h('p',{role:'status'},'Loading source relationships…'),
      data&&h('div',null,h('div',{className:'n-actions'},button('Zoom out',()=>setZoom(v=>Math.max(.5,v-.2)),zoom<=.5),button('Zoom in',()=>setZoom(v=>Math.min(1.8,v+.2)),zoom>=1.8),button('Export this graph page',()=>exportJSON(data,'nocheh-graph.json'))),
        h('p',{className:'n-muted'},data.nodes.length+' nodes · '+data.edges.length+' links · Scroll to explore. Dashed links are citations or generated content.'),
        h('div',{className:'n-graph-scroll',tabIndex:0,'aria-label':'Scrollable evidence graph'},h('svg',{width:1300*zoom,height:height*zoom,viewBox:'0 0 1300 '+height,role:'group','aria-label':'Scoped evidence relationships'},
          h('defs',null,h('marker',{id:'n-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'},h('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#94a9a2'}))),
          ...data.edges.map((edge,i)=>{const a=byId[edge.from],b=byId[edge.to];if(!a||!b)return null;const relevant=!selected||[edge.from,edge.to].includes(selected.id);return h('path',{key:'e'+i,d:`M ${a.x+216} ${a.y+28} C ${a.x+245} ${a.y+28}, ${b.x-30} ${b.y+28}, ${b.x} ${b.y+28}`,fill:'none',stroke:relevant?'#71998b':'#d6e0dc',strokeWidth:relevant?1.7:1,strokeDasharray:['derived_from','explicit_citation'].includes(edge.kind)?'5 4':undefined,markerEnd:'url(#n-arrow)'});}),
          ...placed.map(node=>h('g',{key:node.id,transform:`translate(${node.x},${node.y})`,tabIndex:0,role:'button','aria-label':node.kind+': '+node.label,onClick:()=>choose(node),onKeyDown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(node);}},className:'n-graph-node'},
            h('rect',{width:216,height:58,rx:7,fill:node.kind==='message'?'#fff':node.kind==='memory'||node.kind==='derived'?'#f5efdf':'#eaf2ed',stroke:selected?.id===node.id?'#1f6659':'#c1d0c9',strokeWidth:selected?.id===node.id?3:1}),
            h('text',{x:12,y:19,fontSize:10,fill:'#526571'},node.kind.toUpperCase()),h('text',{x:12,y:40,fontSize:12,fill:'#182b37'},node.label.slice(0,27)+(node.label.length>27?'…':'')))))),
        data.bounds.truncated&&h('p',{role:'status'},'Attachment or derived-node limit reached. Open source records for the complete details.'),
        h('p',{className:'n-muted'},data.unresolved_replies+' reply references outside this page.'),
        h('div',{className:'n-actions'},history.length>0&&button('Previous messages',()=>{setAfter(history.at(-1));setHistory(history.slice(0,-1));}),data.next&&button('Next messages',()=>{setHistory([...history,after]);setAfter(data.next);})))),
      selected&&h(Panel,{title:selected.kind+' · '+selected.label},selected.text&&h(Data,{value:selected.text}),selected.provenance&&h(Data,{value:selected.provenance}),selected.unresolved_citations>0&&h('p',null,selected.unresolved_citations+' citations are outside this page or scope.'),
        ...data.edges.filter(e=>e.from===selected.id||e.to===selected.id).map((edge,i)=>h('div',{className:'n-row',key:i},h('span',null,edge.kind.replaceAll('_',' ')),button(byId[edge.from===selected.id?edge.to:edge.from]?.label||'Related node',()=>choose(byId[edge.from===selected.id?edge.to:edge.from]))))),record&&h(Source,{record,notify}));
  }
  function Operations({notify}){
    const [tick,setTick]=useState(0),[listing]=useLoad('/operations',tick),[jobs]=useLoad('/jobs',tick),[review,setReview]=useState(''),[backup,setBackup]=useState(''),[port,setPort]=useState(8795),[busy,setBusy]=useState(false);
    useEffect(()=>{const timer=setInterval(()=>setTick(v=>v+1),3000);return()=>clearInterval(timer);},[]);
    const run=async action=>{setBusy(true);try{const job=await call('/operations',{action,options:action==='restore'?{backup,port}:undefined});setReview('');setTick(v=>v+1);notify('Operation started. Its result will appear below. Job '+job.id);}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const descriptions={backup:'Pause running archive writers, take a consistent database and file snapshot, then resume those services.',restart:'Restart Hermes and the archive workers with their configured shutdown grace periods, then check readiness.',restore:'Restore the selected backup into a new, separate Compose project. Telegram stays disabled and the copied subscription login stays inactive.'};
    return h('div',null,h(Panel,{title:'Local operations',note:'Operations share durable job tracking. Wait for running imports before restarting or taking a backup.'},
      h('div',{className:'n-actions'},button('Run diagnostics',()=>run('diagnose'),busy),button('Export archive',()=>run('export'),busy),button('Create backup',()=>setReview('backup'),busy),button('Restart services',()=>setReview('restart'),busy))),
      h(Panel,{title:'Backups and restore',note:'Backup snapshots include private runtime state and credentials. They stay in your local state directory. Archive exports contain source records and files.'},
        h('label',null,'Saved backup',h('select',{value:backup,onChange:e=>setBackup(e.target.value)},h('option',{value:''},'Choose a backup'),...(listing?.backups||[]).map(b=>h('option',{key:b.id,value:b.id},new Date(b.created_at).toLocaleString()+' · '+b.files+' files')))),
        h('label',null,'Port for inactive restore',h('input',{type:'number',min:1024,max:65535,value:port,onChange:e=>setPort(Number(e.target.value))})),button('Review inactive restore',()=>setReview('restore'),!backup||busy)),
      review&&h(Panel,{title:'Review '+review},h('p',null,descriptions[review]),review==='restore'&&h('p',null,'Backup '+backup+' · loopback port '+port),h('div',{className:'n-actions'},button('Confirm '+review,()=>run(review),busy,'n-primary'),button('Cancel',()=>setReview('')))),
      h(Panel,{title:'Operation results'},...(jobs||[]).filter(j=>j.kind.startsWith('operations.')).map(j=>h('article',{className:'n-result',key:j.id},h('h3',null,j.kind.replace('operations.','')+' · '+j.state),h('small',null,new Date(j.created_at).toLocaleString()),j.error&&h('p',{role:'alert'},j.error),j.result&&h(Data,{value:j.result}),j.kind==='operations.export'&&j.state==='complete'&&button('Download archive ZIP',()=>download('/exports/'+j.id+'/download','nocheh-archive.zip',notify))))));
  }
  const extensions = {graph:{label:'Graph',component:Graph},operations:{label:'Operations',component:Operations},memory:{label:'Memory',component:Memory},honcho:{label:'Honcho',component:Honcho}};
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
