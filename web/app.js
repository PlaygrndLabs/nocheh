import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {fetchJSON,authedFetch} from './client.js';

(() => {
  const sdk = {React,fetchJSON,authedFetch};
  const {createElement: h, useState, useEffect, useRef, useMemo} = sdk.React;
  const base = '/api/nocheh';
  const call = (path, body) => sdk.fetchJSON(base + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const button = (label, onClick, disabled = false, className = '') => h('button', {type: 'button', onClick, disabled, className}, label);
  const errorText = e => ({configuration_conflict:'These settings changed elsewhere. Refresh this page and review your changes again.', operation_in_progress:'Another maintenance task is running. Wait for it to finish and try again.'})[e.message] || e.message || 'The operation could not finish. Try again.';
  const labels = {NOCHEH_PORT:'Archive port', NOCHEH_MODEL:'ChatGPT model', NOCHEH_GUARD_MODE:'Outgoing guard',
    NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Trusted destinations (JSON)', TELEGRAM_ENABLED:'Telegram enabled',
    TELEGRAM_BOT_TOKEN:'Telegram bot token', TELEGRAM_OWNER_ID:'Owner user ID', TELEGRAM_GROUP_IDS:'Selected group IDs',
    POSTGRES_PASSWORD:'Database credential', SERVICE_TOKEN:'Service credential', NOCHEH_CONFIG_VERSION:'Configuration version'};
  function Panel({title, children, note}) { return h('section', {className:'n-panel'}, h('h2', null, title), note && h('p', {className:'n-muted'}, note), children); }
  function Data({value}) { return h('pre', {className:'n-data', dir:'auto'}, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
  const friendlyState = value => ({ready:'Ready',running:'In progress',complete:'Complete',failed:'Needs attention',cancelled:'Stopped',interrupted:'Interrupted',uploading:'Uploading',pending:'Waiting'})[value] || String(value||'Unknown').replaceAll('_',' ');
  const jobName = value => ({import:'Chat import','settings.apply':'Apply settings','operations.diagnose':'Service diagnostics','operations.export':'Archive export','operations.backup':'Full backup','operations.restart':'Service restart','operations.restore':'Inactive restore'})[value] || value;
  const profileName = p => (p.owner?'Owner · private DM':'Group')+' · '+p.scope;
  function Details({value,label='Technical details'}) { return h('details',null,h('summary',null,label),h(Data,{value})); }
  function RouteLink({page,children}) { return h('a',{href:'#'+page,className:'n-text-link'},children); }
  function Steps({items}) { return h('ol',{className:'n-steps'},...items.map((item,i)=>h('li',{key:item},h('span',{'aria-hidden':true},i+1),item))); }
  function useLoad(path, refresh = 0) {
    const [data,setData] = useState(null), [error,setError] = useState('');
    useEffect(() => { let alive=true; setError(''); if(!path)return()=>{alive=false;}; call(path).then(v => {if(alive)setData(v);}).catch(e => {if(alive)setError(errorText(e));}); return()=>{alive=false;}; }, [path,refresh]);
    return [data,error];
  }

  function Status({refresh}) {
    const [data,error] = useLoad('/status',refresh);
    return h('div',null,
      h('div',{className:'n-shortcuts'},...[
        ['imports','Bring in a chat','Upload a Telegram export and choose who can use it.'],
        ['memory','See what Hermes remembers','Read the notes and conversation history for a chat.'],
        ['graph','Follow a connection','Explore links between messages, people and source evidence.']
      ].map(([page,title,note])=>h('a',{href:'#'+page,key:page,className:'n-shortcut'},h('h2',null,title,h('span',{'aria-hidden':true},'↗')),h('p',null,note)))),
      h(Panel,{title:'Where your information lives',note:'Three different jobs, each with its own place in the dashboard.'},
        h('div',{className:'n-explain-grid'},
          h('div',null,h('h3',null,'Original chats'),h('p',null,'Messages, files and revisions preserved in your archive. Search these when you need the original evidence.'),h(RouteLink,{page:'archive'},'Search original chats →')),
          h('div',null,h('h3',null,'Hermes memory'),h('p',null,'Notes Hermes maintains while it works, with separate profiles for your DM and selected groups. Check important claims against their sources.'),h(RouteLink,{page:'memory'},'Read Hermes memory →')),
          h('div',null,h('h3',null,'Honcho lab'),h('p',null,'An optional, isolated memory experiment. Its data and setup are separate from the Hermes memory used by your assistant.'),h(RouteLink,{page:'honcho'},'View experiment status →')))),
      error&&h(Panel,{title:'Archive status unavailable'},h('p',{role:'alert'},error),h(RouteLink,{page:'operations'},'Open maintenance →')),
      !data&&!error&&h('p',{role:'status'},'Connecting to your archive…'),
      data&&h(Panel,{title:'Archive activity',note:'Recorded counts and service check-ins. Run diagnostics in Maintenance to check current service health.'},
        h('div',{className:'n-summary-line'},h('div',null,h('strong',null,Number(data.archive?.events||0).toLocaleString()),h('small',null,'original events preserved')),h('div',null,h('span',{className:'n-badge'},'Guard: '+({auto:'Automatic',on:'On',off:'Off'})[data.guard_mode]),h('small',null,'Controls masking before outgoing model requests'))),
        ...['artifacts','dispatches','transcriptions','actions'].map(kind=>h('div',{className:'n-row',key:kind},h('b',null,({artifacts:'Files',dispatches:'Assistant replies',transcriptions:'Transcripts',actions:'Approved actions'})[kind]),h('span',null,data.archive?.[kind]?.length?data.archive[kind].map(s=>s.count+' '+friendlyState(s.state).toLowerCase()).join(' · '):'None recorded'))),
        h('p',{className:'n-muted n-afterword'},'Suppressed replies were deliberately skipped, for example for imported history. Open the details below to inspect recorded reasons.'),h('details',null,h('summary',null,'Service check-ins'),...(data.services||[]).map(s=>h('div',{className:'n-row',key:s.service},h('b',null,s.service),h('span',null,'Last seen '+new Date(s.seen_at).toLocaleString())))),
        data.archive?.dispatch_failures?.length>0&&h(Details,{label:'Suppressed or failed replies',value:data.archive.dispatch_failures})),
      h(Panel,{title:'How Nocheh and Hermes fit together'},h('div',{className:'n-explain-grid n-two'},
        h('div',null,h('h3',null,'Hermes runs the assistant'),h('p',null,'We reuse its Telegram adapter, agent, tools, profiles and built-in memory. Nocheh adds archive capture, access rules and outgoing guarding.')),
        h('div',null,h('h3',null,'Nocheh is this control panel'),h('p',null,'Nocheh owns your archive, imports, source graph, settings and approvals. Hermes is the connected runtime, with its own native dashboard for agent operations.'),h(RouteLink,{page:'settings'},'Manage Nocheh and Hermes settings →')))));
  }

  function Settings({notify}) {
    const [section,setSection]=useState('nocheh');
    return h('div',null,h('div',{className:'n-section-switch','aria-label':'Settings category'},
      h('button',{type:'button',onClick:()=>setSection('nocheh'),'aria-pressed':section==='nocheh',className:section==='nocheh'?'n-primary':''},'Nocheh settings'),
      h('button',{type:'button',onClick:()=>setSection('hermes'),'aria-pressed':section==='hermes',className:section==='hermes'?'n-primary':''},'Hermes preferences'),
      h('button',{type:'button',onClick:()=>setSection('policy'),'aria-pressed':section==='policy',className:section==='policy'?'n-primary':''},'Policy defaults')),
      section==='nocheh'?h(NochehSettings,{notify}):section==='policy'?h(PolicySettings,{notify}):h(HermesPreferences,{notify}));
  }
  function PolicySettings({notify}) {
    const [tick,setTick]=useState(0),[data,error]=useLoad('/policy',tick),[changes,setChanges]=useState({}),[busy,setBusy]=useState(false);
    const save=async e=>{e.preventDefault();setBusy(true);try{await call('/policy',{changes,revision:data.revision});setChanges({});setTick(v=>v+1);notify('Global preferences saved. Profiles that inherit them use them on the next turn.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h(Panel,{title:'Global preference defaults',note:'Profiles can inherit these values or keep an explicit override. Existing profile overrides are preserved.'},
      error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Loading policy…'),data&&h('form',{onSubmit:save},h('div',{className:'n-form'},...Object.entries(data.schema).map(([key,spec])=>{
        const input={id:'policy-'+key,value:changes[key]??data.values[key],disabled:busy,onChange:e=>setChanges({...changes,[key]:spec.choices?e.target.value:Number(e.target.value)})};
        return h('div',{className:'n-field',key},h('label',{htmlFor:input.id},({'nocheh_tools.shell':'Controlled shell','nocheh_tools.browser':'Controlled browser','nocheh_tools.mcp':'Controlled MCP','agent.reasoning_effort':'Reasoning effort','agent.max_iterations':'Maximum agent steps','agent.run_budget_seconds':'Time per turn (seconds)','memory.memory_char_limit':'General memory limit (characters)','memory.user_char_limit':'User profile limit (characters)'})[key]||key),spec.choices?h('select',input,...spec.choices.map(v=>h('option',{value:v,key:v},v))):h('input',{...input,type:'number',min:spec.min,max:spec.max,required:true}),h('small',null,changes[key]===null?'Will use the built-in default after saving.':'Effective source: '+data.origins[key]),button('Use built-in default',()=>setChanges({...changes,[key]:null}),busy));
      })),h('div',{className:'n-actions'},h('button',{className:'n-primary',disabled:busy||!Object.keys(changes).length},busy?'Saving…':'Save global preferences'),button('Discard edits',()=>setChanges({}),busy))),
      h('p',{className:'n-muted'},'External actions currently require owner review. Broader tool policies become available with the tools phase; job overrides are stored for the scheduling phase.'));
  }
  function NochehSettings({notify}) {
    const [refresh,setRefresh]=useState(0),[data,error]=useLoad('/settings',refresh);
    const [changes,setChanges]=useState({}),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
    const save=async()=>{setBusy(true);try{await call('/settings',{revision:data.revision,changes});setChanges({});setReview(false);setRefresh(v=>v+1);notify('Nocheh settings saved. Apply saved settings when you are ready to update running services.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const apply=async()=>{setBusy(true);try{await call('/settings/apply',{});notify('Applying saved settings. Follow the result in Maintenance.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    if(error)return h('p',{role:'alert'},error);
    if(!data)return h('p',{role:'status'},'Loading settings…');
    const hints={TELEGRAM_ENABLED:'Start or stop Telegram message handling when settings are applied.',TELEGRAM_OWNER_ID:'Your numeric Telegram user ID. Only the owner can administer Nocheh.',TELEGRAM_GROUP_IDS:'Comma-separated numeric chat IDs. Each selected group uses its own memory and sources.',TELEGRAM_BOT_TOKEN:'The token from BotFather for the bot used by the native Hermes Telegram adapter.',NOCHEH_MODEL:'The model used through your ChatGPT subscription.',NOCHEH_GUARD_MODE:'Automatic follows destination trust. On requires masking; Off skips masking.',NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Explicitly trusted model destinations may receive original text in Automatic mode.',NOCHEH_PORT:'Local port used by the archive service.'};
    const field=f=>{
      const value=changes[f.key]??f.value??'';
      const attrs={id:f.key,disabled:busy||!f.editable,value,type:f.secret?'password':'text',autoComplete:'off','aria-describedby':f.key+'-help',onChange:e=>{const next={...changes};if(f.secret&&!e.target.value)delete next[f.key];else next[f.key]=e.target.value;setChanges(next);setReview(false);}};
      const options=f.key==='NOCHEH_GUARD_MODE'?[['auto','Automatic · follow trust policy'],['on','On · always guard'],['off','Off · no masking']]:[['false','Disabled'],['true','Enabled']];
      return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]||f.key),
        f.key==='NOCHEH_GUARD_MODE'||f.key==='TELEGRAM_ENABLED'?h('select',attrs,...options.map(([value,label])=>h('option',{key:value,value},label))):h('input',attrs),
        h('small',{id:f.key+'-help'},hints[f.key],f.secret?' '+(f.configured?(f.editable?'Configured. Leave blank to keep it; enter a replacement to change it.':'Configured and managed internally.'):'Not configured.'):!f.editable?' Managed automatically.':''));
    };
    const group=(title,note,keys)=>h('fieldset',{className:'n-settings-group'},h('legend',null,title),h('p',{className:'n-muted'},note),h('div',{className:'n-form'},...data.fields.filter(f=>keys.includes(f.key)).map(field)));
    return h(Panel,{title:'Nocheh settings',note:'Telegram access, model routing and privacy for the whole installation. Stored in Nocheh’s .env file.'},
      h('p',{className:'n-badge'},({current:'Saved settings match the last successful apply',pending:'Saved changes are waiting to be applied',unverified:'Running settings have not been verified by this dashboard'})[data.apply_state]||data.apply_state),
      h(Steps,{items:['Edit and review','Save configuration','Apply to running services']}),
      h('form',{onSubmit:e=>{e.preventDefault();setReview(true);}},
        group('Telegram access','Choose who can use the assistant and which groups it can participate in.',['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_BOT_TOKEN']),
        group('Model and privacy','These rules apply to outgoing model requests. Hermes profile preferences are in the other settings section.',['NOCHEH_MODEL','NOCHEH_GUARD_MODE']),
        h('details',{className:'n-advanced'},h('summary',null,'Advanced · destinations, connections and internal credentials'),h('div',{className:'n-form'},...data.fields.filter(f=>!['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_BOT_TOKEN','NOCHEH_MODEL','NOCHEH_GUARD_MODE'].includes(f.key)).map(field))),
        h('div',{className:'n-actions'},h('button',{disabled:busy||!Object.keys(changes).length},'Review changes'),button('Discard edits',()=>{setChanges({});setReview(false);},busy||!Object.keys(changes).length))),
      review&&h('div',{className:'n-review'},h('h3',null,'Review before saving'),h('p',null,'Saving changes the configuration file. Running services update only after Apply.'),...Object.entries(changes).map(([k,v])=>h('p',{key:k},(labels[k]||k)+': '+(data.fields.find(f=>f.key===k)?.secret?'Replace stored credential':v||'(empty)'))),button('Save changes',save,busy,'n-primary')),
      h('div',{className:'n-apply'},h('h3',null,'Apply saved settings'),h('p',{className:'n-muted'},'Updates the running services and may briefly interrupt Telegram replies. Save or discard your current edits first.'),button('Apply saved settings',apply,busy||!!Object.keys(changes).length),h(RouteLink,{page:'operations'},'View apply results →')));
  }
  function HermesPreferences({notify}) {
    const [profiles,error]=useLoad('/memory/profiles'),[scope,setScope]=useState(''),[tick,setTick]=useState(0),[changes,setChanges]=useState({}),[busy,setBusy]=useState(false);
    useEffect(()=>{if(!scope&&profiles?.profiles?.length)setScope(profiles.profiles[0].scope);},[profiles]);
    const [prefs,problem]=useLoad(scope?'/memory/preferences?scope='+encodeURIComponent(scope):null,tick);
    const names={'nocheh_tools.shell':['Controlled shell','Propose commands in an isolated workspace. Each execution requires approval or an exact bounded permission.'],'nocheh_tools.browser':['Controlled browser','Inspect an approved public page offline. No logins or interactive actions.'],'nocheh_tools.mcp':['Controlled MCP','Propose an exact call to a public HTTPS MCP server. No ambient credentials.'],'agent.reasoning_effort':['Reasoning effort','Higher effort allows more reasoning and can take longer.'],'agent.max_iterations':['Maximum agent steps','Maximum tool and reasoning iterations in one turn.'],'agent.run_budget_seconds':['Time per turn (seconds)','Upper time budget for one assistant turn.'],'memory.memory_char_limit':['General memory limit (characters)','Space available for Hermes’s general memory note.'],'memory.user_char_limit':['User profile limit (characters)','Space available for Hermes’s user profile note.']};
    const save=async e=>{e.preventDefault();if(prefs?.scope!==scope)return;setBusy(true);try{await call('/memory/preferences',{scope,revision:prefs.revision,changes});setChanges({});setTick(v=>v+1);notify('Hermes preferences saved for this profile. They take effect on the next turn.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h(Panel,{title:'Hermes preferences',note:'Agent behavior and memory limits for one chat profile. Saved in that profile’s Hermes config.yaml and used on its next turn; no service restart needed.'},
      error&&h('p',{role:'alert'},error),h('label',null,'Profile to configure',h('select',{value:scope,disabled:busy,onChange:e=>{setScope(e.target.value);setChanges({});}},...(profiles?.profiles||[]).map(p=>h('option',{value:p.scope,key:p.scope},profileName(p))))),
      !profiles&&!error&&h('p',{role:'status'},'Loading profiles…'),profiles&&!profiles.profiles.length&&h('p',null,'Configure the Telegram owner and groups in Nocheh settings to make profiles available.'),
      problem&&h('p',{role:'alert'},problem),scope&&!problem&&prefs?.scope!==scope&&h('p',{role:'status'},'Loading this profile’s preferences…'),
      scope&&prefs?.scope===scope&&h('form',{onSubmit:save},h('div',{className:'n-form n-preferences'},...Object.entries(prefs.schema).map(([key,spec])=>{
        const input={id:key,value:changes[key]??prefs.values[key],disabled:busy,'aria-describedby':key+'-help',onChange:e=>setChanges({...changes,[key]:spec.choices?e.target.value:Number(e.target.value)})};
        return h('div',{className:'n-field',key},h('label',{htmlFor:key},names[key]?.[0]||key),spec.choices?h('select',input,...spec.choices.map(v=>h('option',{key:v,value:v},v[0].toUpperCase()+v.slice(1)))):h('input',{...input,type:'number',min:spec.min,max:spec.max,required:true,step:1}),h('small',{id:key+'-help'},changes[key]===null?'Will inherit the global value after saving.':(names[key]?.[1]||'')+' Effective source: '+(prefs.origins?.[key]||'profile')),button('Inherit global value',()=>setChanges({...changes,[key]:null}),busy));
      })),h('div',{className:'n-actions'},h('button',{disabled:busy||!Object.keys(changes).length,className:'n-primary'},busy?'Saving…':'Save Hermes preferences'),button('Discard edits',()=>setChanges({}),busy||!Object.keys(changes).length))),
      h('p',{className:'n-muted n-afterword'},'Model routing, enabled tools and access policy are managed by Nocheh. These are the supported native preferences, not the full Hermes configuration.'),h(RouteLink,{page:'memory'},'Read this installation’s Hermes memory →'));
  }
  function Jobs({notify}) {
    const [tick,setTick]=useState(0),[jobs,error]=useLoad('/jobs',tick),[settings]=useLoad('/settings');
    const [selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[mapping,setMapping]=useState({}),[reviewApproved,setReviewApproved]=useState(false);
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
        setSelected(preview);setMapping({});setReviewApproved(false);setTick(v=>v+1);setProgress('Ready to review.');
      }catch(e){notify(errorText(e),true);setProgress('Upload needs attention. Your archive has not been imported.');}finally{setBusy(false);}
    };
    const run=async(job,action)=>{try{const result=await call('/jobs/'+job.id+'/'+action,action==='start'?{mapping:job.mapping||mapping,review_approved:job.review_approved??reviewApproved}:{});setSelected(result);setTick(v=>v+1);notify(action==='cancel'?'Import stopped. Already archived messages are retained.':'Import started. Historical messages will not send replies.');}catch(e){notify(errorText(e),true);}};
    const current=jobs?.find(j=>j.id===selected?.id)||selected;
    return h('div',null,h(Panel,{title:'1. Choose a Telegram export',note:'Export from Telegram Desktop as JSON. Select the export folder to include media, a ZIP, or a JSON file for text only.'},
      h(Steps,{items:['Choose an export','Review access and files','Import and track progress']}),h('div',{className:'n-actions'},h('label',{className:'n-file'},'Select JSON or ZIP',h('input',{type:'file',accept:'.json,.zip',disabled:busy,onChange:e=>upload([...e.target.files])})),
        h('label',{className:'n-file'},'Select export folder',h('input',{type:'file',webkitdirectory:'',multiple:true,disabled:busy,onChange:e=>upload([...e.target.files])}))),
      h('p',{role:'status'},progress),h('p',{className:'n-muted'},'Limits: 32 MiB export JSON, 50 MiB per media file, 256 MiB ZIP upload, 512 MiB unpacked.')),
      !current?.preview&&h(Panel,{title:'2. Review access and files',note:'Choose an export above to preview message counts and missing files, then decide whether its history stays private or is shared with a selected group.'}),current?.preview&&h(Panel,{title:'2. Review access and files'},
        h('p',null,current.preview.messages+' messages · '+current.preview.supplied_files+' supplied files · '+current.preview.missing_files+' missing files'),
        ...current.preview.chats.map(c=>h('div',{className:'n-field',key:c.id},h('label',{htmlFor:'scope-'+c.id},c.name+' · '+c.messages+' messages'),
          h('select',{id:'scope-'+c.id,value:(current.mapping||mapping)[c.id]||'',disabled:current.state!=='ready',onChange:e=>{const next={...mapping};if(e.target.value)next[c.id]=e.target.value;else delete next[c.id];setMapping(next);}},
            h('option',{value:''},'Owner-only archive (default)'),...scopes.map(s=>h('option',{value:s,key:s},s===fields.TELEGRAM_OWNER_ID?'Owner DM · '+s:'Share with group · '+s))))),
        h('p',{className:'n-muted'},'Group mapping makes this history available to that group. Import stores originals; it does not automatically rewrite memory.'),
        h('label',{className:'n-review-consent'},h('input',{type:'checkbox',checked:current.review_approved??reviewApproved,disabled:busy||current.state!=='ready',onChange:e=>setReviewApproved(e.target.checked)}),'Review with Hermes to update private memory'),h('p',{className:'n-muted'},'Optional. Leave unchecked to import searchable originals without starting a memory review. This decision is preserved when resuming.'),h('p',{role:'status'},friendlyState(current.state)+' · '+current.completed+' / '+current.preview.messages+' messages · '+current.duplicates+' duplicates'),
        current.error&&h('p',{role:'alert'},current.error),
        ['ready','failed','cancelled','interrupted'].includes(current.state)&&button(current.completed?'Resume import':'Start import',()=>run(current,'start'),busy,'n-primary'),
        current.state==='running'&&button('Stop import',()=>run(current,'cancel'))),
      h(Panel,{title:'3. Import history',note:'Select an import to inspect its progress or resume it. Maintenance and settings jobs appear in Maintenance.'},error&&h('p',{role:'alert'},error),jobs?.some(j=>j.kind==='import')?h('div',{className:'n-list'},...jobs.filter(j=>j.kind==='import').map(j=>h('div',{className:'n-job',key:j.id},
        button(jobName(j.kind)+' · '+new Date(j.created_at).toLocaleString(),()=>setSelected(j)),h('span',{className:'n-badge'},friendlyState(j.state)),h('small',null,j.completed+' processed'),j.error&&h('p',{role:'alert'},j.error),
        j.result&&j.kind!=='import'&&h('p',null,'Result: '+(j.result.status||j.state))))):h('p',{className:'n-muted'},jobs?'No imports yet. Your first import will appear here.':'Loading import history…')));
  }
  function Archive({notify}) {
    const [query,setQuery]=useState(''),[results,setResults]=useState(null),[record,setRecord]=useState(null),[busy,setBusy]=useState(false);
    const search=async e=>{e.preventDefault();setBusy(true);try{setResults(await call('/search?q='+encodeURIComponent(query)));setRecord(null);}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const read=async id=>{try{setRecord(await call('/events/'+id));}catch(e){notify(errorText(e),true);}};
    const rows=Array.isArray(results)?results:results?.results||results?.items||[];
    return h('div',null,h(Panel,{title:'Find an original message',note:'Search preserved chat messages and generated text such as transcripts across all chats. Open a result to see its original source, files and provenance.'},
      h('form',{className:'n-actions',onSubmit:search},h('label',{className:'n-grow'},'Search terms',h('input',{value:query,onChange:e=>setQuery(e.target.value),required:true})),h('button',{disabled:busy},busy?'Searching…':'Search')),
      results===null&&h('p',{className:'n-empty'},'Search a word or phrase from a conversation. To add older history, use Import chats.'),results&&(!rows.length?h('p',null,'No matching messages.'):h('div',{className:'n-list'},...rows.map(r=>h('article',{className:'n-result',key:r.id||r.event_id},h('small',null,(r.derived_id?'Generated text match':'Original message')+' · '+r.scope),h('p',{dir:'auto'},r.text||r.snippet||r.preview),button('Open source',()=>read(r.id||r.event_id))))))),
      record&&h(Source,{record,notify}));
  }

  function Activity({notify}) {
    const [tick,setTick]=useState(0),[record,setRecord]=useState(null),[selected,setSelected]=useState(null),[minutes,setMinutes]=useState(60),[uses,setUses]=useState(3),[busy,setBusy]=useState(false);
    useEffect(()=>{const timer=setInterval(()=>setTick(v=>v+1),10000);return()=>clearInterval(timer);},[]);
    const [data,error]=useLoad('/status',tick);
    const [queue,queueError]=useLoad('/tools/actions',tick);
    const actions=[...(queue?.actions||[]),...(queue?.telegram||[])].sort((a,b)=>b.created_at.localeCompare(a.created_at));
    const action=actions.find(item=>item.id===selected);
    const decide=async(route,body)=>{setBusy(true);try{await call('/tools/'+route,body);notify('Decision saved');setTick(v=>v+1);}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const read=async id=>{try{setRecord(await call('/events/'+id));}catch(e){notify(errorText(e),true);}};
    const runs=data?.archive?.managed_runs||[];
    return h('div',null,h(Panel,{title:'Approvals',note:'Review the exact operation before it runs. Shell gets only the selected workspace. Browser reads one approved public page. MCP sends the displayed tool arguments. Uncertain outcomes are never automatically retried.'},
      queueError&&h('p',{role:'alert'},queueError),queue&&!actions.length&&h('p',null,'No proposed actions. Hermes can propose an operation during a conversation.'),
      ...actions.map(item=>h('article',{className:'n-result',key:item.id},h('div',{className:'n-row'},h('strong',null,({shell:'Workspace command',browser:'Read web page',mcp:'MCP tool call',telegram_message:'Telegram message'})[item.kind]),h('span',null,friendlyState(item.state))),h('small',null,'Scope: '+item.scope),button('Review operation',()=>setSelected(item.id)))),
      action&&h(Panel,{title:'Exact operation',note:'ID: '+action.id},h('p',null,'Profile: '+(action.profile||'Telegram delivery')+' · Scope: '+action.scope),h(Data,{value:action.arguments}),
        action.result&&h('details',null,h('summary',null,'Execution result'),h(Data,{value:action.result})),
        ['proposed','approved'].includes(action.state)&&h('div',{className:'n-row'},button('Approve this operation',()=>decide(action.kind==='telegram_message'?'telegram-decision':'decide',{id:action.id,fingerprint:action.fingerprint,decision:'approve'}),busy||action.state==='approved'),button('Deny',()=>decide(action.kind==='telegram_message'?'telegram-decision':'decide',{id:action.id,fingerprint:action.fingerprint,decision:'deny'}),busy||(action.kind==='telegram_message'&&action.state!=='proposed'))),
        action.kind!=='telegram_message'&&h('details',null,h('summary',null,'Allow this exact operation again'),h('p',null,'Applies only to these arguments, profile and scope. Revoking prevents new starts; it cannot undo an operation already sent.'),
          h('label',null,'Expires in minutes (1–1440)',h('input',{type:'number',min:1,max:1440,value:minutes,onChange:e=>setMinutes(Number(e.target.value))})),
          h('label',null,'Maximum starts (1–20)',h('input',{type:'number',min:1,max:20,value:uses,onChange:e=>setUses(Number(e.target.value))})),
          button('Create bounded permission',()=>decide('grant',{action_id:action.id,fingerprint:action.fingerprint,minutes,uses}),busy)))),
      h(Panel,{title:'Standing permissions',note:'Only exact matches can start automatically while a permission remains valid.'},
        ...(queue?.permissions||[]).map(permission=>h('article',{className:'n-result',key:permission.id},h('strong',null,permission.kind+' · '+permission.remaining+' starts left'),h('p',null,'Expires '+new Date(permission.expires_at).toLocaleString()+' · Scope '+permission.scope),h('details',null,h('summary',null,'Exact arguments'),h(Data,{value:permission.arguments})),permission.revoked_at?h('span',null,'Revoked'):button('Revoke permission',()=>decide('revoke',{id:permission.id}),busy))),queue&&!queue.permissions.length&&h('p',null,'No standing permissions. Each action requires review.')),
      h(Panel,{title:'Conversations and scheduled runs',note:'The latest 50 captured inputs and schedule fires. Missed and interrupted runs stay visible. Use Hermes Schedules to catch up once or cancel a run.'},
      h('a',{href:'/hermes/cron'},'Manage schedules in Hermes →'),
      error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Loading activity…'),
      data&&!runs.length&&h('p',null,'No runs yet. Open Hermes Chat or Schedules to start.'),
      ...runs.map(run=>h('article',{className:'n-result',key:run.event_id},
        h('div',{className:'n-row'},h('strong',null,({captured:'Captured only',done:'Complete'})[run.state]||friendlyState(run.state)),h('small',null,new Date(run.created_at).toLocaleString())),
        h('p',null,(run.channel==='scheduler'?'Schedule: '+(run.job_name||run.job_id)+' · ':'Browser · ')+'Profile: '+run.profile+' · Scope: '+run.scope),run.error_code&&h('p',{role:'status'},run.error_code.replaceAll('_',' ')),
        button('Open original and result',()=>read(run.event_id))))),record&&h(Source,{record,notify}));
  }

  function Memory() {
    const [profiles,error]=useLoad('/memory/profiles'),[scope,setScope]=useState(''),[profile,setProfile]=useState(''),[session,setSession]=useState(''),[offset,setOffset]=useState(0);
    useEffect(()=>{if(!scope&&profiles?.profiles?.length){setScope(profiles.profiles[0].scope);setProfile(profiles.profiles[0].profile);}},[profiles]);
    const [data,problem]=useLoad(scope?'/memory?scope='+encodeURIComponent(scope)+'&profile='+encodeURIComponent(profile)+'&session='+encodeURIComponent(session)+'&offset='+offset:null);
    return h('div',null,h(Panel,{title:'Choose whose memory to read',note:'Your private assistant can recall across profiles. Shared spaces keep separate notes for each policy revision; historical notes remain available here to you.'},
      error&&h('p',{role:'alert'},error),h('label',null,'Chat profile',h('select',{value:profile,onChange:e=>{const p=(profiles.history_profiles||profiles.profiles).find(p=>p.profile===e.target.value);setProfile(p.profile);setScope(p.scope);setSession('');setOffset(0);}},...(profiles?.history_profiles||profiles?.profiles||[]).map(p=>h('option',{value:p.profile,key:p.profile},profileName(p)+(p.revision?' · policy '+p.revision:''))))),
      profiles&&!profiles.profiles.length&&h('p',null,'No configured profiles yet. Set up your Telegram owner and groups in Settings.'),h(RouteLink,{page:'settings'},'Change memory limits in Settings →')),
      scope&&problem&&h('p',{role:'alert'},problem),(!profiles||scope&&(data?.scope!==scope||data?.profile!==profile))&&!error&&!problem&&h('p',{role:'status'},'Loading Hermes memory…'),
      scope&&data?.scope===scope&&data?.profile===profile&&h(Panel,{title:'Working notes',note:'General memory and user profile notes are generated knowledge. Explicit source references help you check the supporting evidence.'},
        ...(data.memories||[]).map(m=>h('article',{className:'n-memory-note',key:m.name},h('h3',null,m.name==='MEMORY.md'?'General memory':m.name==='USER.md'?'User profile notes':m.name),h('small',null,'Native Hermes file · '+m.name),
          m.exists&&m.text?h(Data,{value:m.text}):h('p',{className:'n-empty'},'No notes yet. Hermes fills this file when it saves useful information during conversations. Importing a chat alone does not create a note.'),
          m.truncated&&h('p',null,'Showing the first 256 KiB.'),h('small',null,m.citations.length+' explicit source references')))),
      scope&&data?.scope===scope&&data?.profile===profile&&h(Panel,{title:'Conversation history',note:'Sessions saved by Hermes while running the assistant. Imported originals are searchable in Original chats; they do not become Hermes sessions.'},session&&button('Back to conversations',()=>{setSession('');setOffset(0);}),
        !session&&!data.sessions.length&&h('p',{className:'n-empty'},'No saved conversations in this profile yet. They appear after the assistant runs here.'),
        !session&&data.sessions.map(s=>h('div',{className:'n-row',key:s.id},button(s.title||'Conversation '+s.id,()=>{setSession(s.id);setOffset(0);}),h('small',null,s.source))),
        ...data.messages.map((m,i)=>h('article',{className:'n-result',key:m.id||i},h('b',null,({user:'User',assistant:'Hermes',tool:'Tool result',system:'System'})[m.role]||m.role),h(Data,{value:m.content}),m.truncated&&h('small',null,'Message preview truncated.'))),
        h('div',{className:'n-actions'},offset>0&&button('Previous page',()=>setOffset(Math.max(0,offset-50))),data.next_offset!==null&&button('Next page',()=>setOffset(data.next_offset))),h(RouteLink,{page:'archive'},'Search original chats →')));
  }

  function Honcho({notify}) {
    const [status,error]=useLoad('/honcho/status'),[workspace,setWorkspace]=useState(''),[kind,setKind]=useState('workspace'),[data,setData]=useState(null),[busy,setBusy]=useState(false);
    const query=async()=>{setBusy(true);setData(null);try{setData(await call('/honcho/read',{args:kind==='workspace'?['workspace','list']:[kind,'list','-w',workspace]}));}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h('div',null,h(Panel,{title:'Optional memory experiment',note:'Honcho is isolated from your assistant. Hermes remains the memory system used in production.'},
      error&&h('p',{role:'alert'},error),!status&&!error&&h('p',{role:'status'},'Checking the experiment…'),status&&h('div',null,
        h('p',{className:'n-badge'},status.running?'Experiment services running':'Experiment stopped'),
        h('div',{className:'n-row'},h('b',null,'Live compatibility'),h('span',null,status.live_compatibility)),
        h('div',{className:'n-row'},h('b',null,'Separate subscription login'),h('span',null,status.subscription_login?'Configured':'Not configured')),
        h('div',{className:'n-row'},h('b',null,'Experiment embedding credential'),h('span',null,status.embedding_credential?'Configured':'Not configured')),
        h('div',{className:'n-row'},h('b',null,'Metered API budget cap'),h('span',null,'$'+status.api_budget_usd+' · not a live spending balance')),
        !status.running&&h('p',{className:'n-empty'},'Stored-data browsing becomes available when the isolated experiment is running. Setup and lifecycle controls currently use the Honcho CLI.'),
        h(Details,{value:status,label:'Experiment version and technical status'}))),
      h(Panel,{title:'Browse stored Honcho data',note:'Workspaces contain peers (people or agents) and sessions (conversations). These reads do not ask a model to generate new memory.'},
        h('div',{className:'n-form'},h('label',null,'What to browse',h('select',{value:kind,onChange:e=>{setKind(e.target.value);setData(null);}},...['workspace','peer','session'].map(v=>h('option',{key:v,value:v},({workspace:'Workspaces',peer:'Peers · people and agents',session:'Sessions · conversations'})[v])))),kind!=='workspace'&&h('label',null,'Workspace ID',h('input',{value:workspace,onChange:e=>{setWorkspace(e.target.value);setData(null);}}))),
        button(busy?'Loading…':'Load stored data',query,busy||!status?.running||(kind!=='workspace'&&!workspace.trim())),
        data&&h('div',null,data.error?h('p',{role:'alert'},data.error):h('p',{className:'n-afterword'},data.complete?'Stored data loaded.':'Showing the returned page. More data may be available through the CLI.'),h(Data,{value:data})),
        h('details',{className:'n-afterword'},h('summary',null,'CLI commands and setup'),h('p',{className:'n-muted'},'Use the existing terminal workflow to configure the isolated experiment or retrieve structured data.'),h(Data,{value:'./scripts/nocheh honcho doctor\n./scripts/nocheh honcho workspace list --json\n./scripts/nocheh honcho peer list -w WORKSPACE_ID --json'}))));
  }
  function download(path,name) {
    const a=document.createElement('a');a.href=base+path+'?name='+encodeURIComponent(name);a.download=name;document.body.appendChild(a);a.click();a.remove();
  }
  function exportJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function Source({record,notify}){
    return h(Panel,{title:'Original source'},h('p',{dir:'auto',className:'n-source'},record.event?.text),
      button('Download source JSON',()=>exportJSON(record,'nocheh-source-'+record.id+'.json')),
      ...record.artifacts.map(a=>h('div',{className:'n-row',key:a.id},h('span',null,a.metadata?.relative_path||a.metadata?.file_name||a.kind),h('small',null,a.state),button('Download original file',()=>download('/artifacts/'+a.id+'/download',a.metadata?.relative_path?.split('/').pop()||a.metadata?.file_name||a.id,notify),a.state!=='ready'))),
      ...record.derived.map(d=>h('article',{key:d.id},h('h3',null,d.kind==='browser_result'?'Assistant result':d.kind==='transcript'?'Voice transcript':'Generated '+d.kind.replaceAll('_',' ')),h(Data,{value:new TextDecoder().decode(Uint8Array.from(atob(d.content_base64),c=>c.charCodeAt(0)))}),h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:d.provenance})))),
      h('details',null,h('summary',null,'Source identity and complete metadata'),h(Data,{value:record})));
  }
  const graphKinds = {scope:'Scope',profile:'Profile',message:'Message',author:'Author',attachment:'File',memory:'Memory',derived:'Derived'};
  function GraphSpace({data, selectedId, matchingIds, choose}) {
    const host=useRef(null), scene=useRef(null), onChoose=useRef(choose);
    const [problem,setProblem]=useState(''),[ready,setReady]=useState(false),[retry,setRetry]=useState(0),[labels,setLabels]=useState(true),[expanded,setExpanded]=useState(false),[expandError,setExpandError]=useState('');
    onChoose.current=choose;
    useEffect(()=>{const change=()=>setExpanded(document.fullscreenElement===host.current?.parentElement);document.addEventListener('fullscreenchange',change);return()=>document.removeEventListener('fullscreenchange',change);},[]);
    const expand=async()=>{setExpandError('');try{if(document.fullscreenElement)await document.exitFullscreen();else await host.current.parentElement.requestFullscreen();}catch{setExpandError('Full screen is unavailable in this browser.');}};
    useEffect(()=>{
      let alive=true;setReady(false);setProblem('');
      import('/assets/graph-3d.js').then(module=>{
        if(!alive)return;
        scene.current=module.createGraphScene(host.current,data,{onSelect:node=>onChoose.current(node),onError:message=>{if(alive){setProblem(message);setReady(false);}}});
        setReady(true);
      }).catch(()=>{if(alive)setProblem('The 3D view could not start. Check that graphics acceleration is available, then reload the scene. You can still inspect every node in the node browser.');});
      return()=>{alive=false;scene.current?.dispose();scene.current=null;};
    },[data,retry]);
    useEffect(()=>{scene.current?.update({selectedId,matchingIds,labels});},[selectedId,matchingIds,labels,ready]);
    const action=(label,fn)=>h('button',{type:'button',disabled:!ready,onClick:()=>fn(scene.current),'aria-label':({'←':'Orbit left','→':'Orbit right','↑':'Orbit up','↓':'Orbit down','−':'Zoom out','+':'Zoom in'})[label]||label,title:({'←':'Orbit left','→':'Orbit right','↑':'Orbit up','↓':'Orbit down','−':'Zoom out','+':'Zoom in'})[label]||label},label);
    return h('div',{className:'n-space-shell'},
      h('div',{className:'n-space-top'},h('span',{className:'n-space-title'},'Evidence space',h('small',null,'3D · '+data.nodes.length+' nodes · '+data.edges.length+' links')),
        h('div',{className:'n-space-actions'},h('button',{type:'button','aria-pressed':labels,onClick:()=>setLabels(v=>!v),disabled:!ready},'Labels'),action('Reset view',v=>v.fit()),document.fullscreenEnabled&&button(expanded?'Exit full screen':'Full screen',expand,!ready))),
      h('div',{className:'n-space',ref:host,'aria-busy':!ready&&!problem}),
      !ready&&h('div',{className:'n-space-status',role:problem?'alert':'status'},h('p',null,problem||'Preparing your evidence space…'),problem&&button('Reload scene',()=>setRetry(v=>v+1))),
      h('div',{className:'n-space-bottom'},h('div',{className:'n-space-help',id:'n-graph-help'},'Drag to orbit · scroll to zoom',h('small',null,'Right-drag to pan · touch: one finger orbits, two pan / pinch')),
        h('div',{className:'n-space-actions','aria-label':'Camera controls'},action('←',v=>v.orbit(-.25,0)),action('→',v=>v.orbit(.25,0)),action('↑',v=>v.orbit(0,-.25)),action('↓',v=>v.orbit(0,.25)),action('−',v=>v.zoom(1.25)),action('+',v=>v.zoom(.8)))),
      h('div',{className:'n-space-focus'},button('Focus selected node',()=>scene.current?.focus(selectedId),!ready||!selectedId),expandError&&h('small',{role:'status'},expandError)));
  }
  function Graph({notify}) {
    const selection=useRef(0), source=useRef(null);
    const [scope,setScope]=useState('*'),[scopeAfter,setScopeAfter]=useState(''),[scopeList,setScopeList]=useState([]),[scopes,scopeError]=useLoad('/scopes?after='+encodeURIComponent(scopeAfter));
    const [after,setAfter]=useState(''),[history,setHistory]=useState([]),[data,setData]=useState(null),[selected,setSelected]=useState(null),[record,setRecord]=useState(null);
    const [busy,setBusy]=useState(false),[problem,setProblem]=useState(''),[retry,setRetry]=useState(0),[sourceBusy,setSourceBusy]=useState(false),[sourceError,setSourceError]=useState('');
    const [query,setQuery]=useState(''),[kind,setKind]=useState('');
    useEffect(()=>{if(scopes?.scopes){setScopeList(old=>[...new Map([...old,...scopes.scopes].map(s=>[s.scope,s])).values()]);if(!scope&&scopes.scopes.length)setScope(scopes.scopes[0].scope);}},[scopes]);
    useEffect(()=>{
      if(!scope)return;let alive=true;selection.current++;setBusy(true);setProblem('');setData(null);setRecord(null);setSelected(null);setSourceError('');setSourceBusy(false);setQuery('');setKind('');
      call('/graph?scope='+encodeURIComponent(scope)+'&after='+encodeURIComponent(after)).then(value=>{if(alive)setData(value);}).catch(e=>{if(alive)setProblem(errorText(e));}).finally(()=>{if(alive)setBusy(false);});
      return()=>{alive=false;selection.current++;};
    },[scope,after,retry]);
    const choose=async node=>{
      if(!node)return;const request=++selection.current;setSelected(node);setRecord(null);setSourceError('');setSourceBusy(!!node.event_id);
      if(node.event_id)try{const value=await call('/events/'+encodeURIComponent(node.event_id));if(selection.current===request)setRecord(value);}catch(e){if(selection.current===request)setSourceError(errorText(e));}finally{if(selection.current===request)setSourceBusy(false);}
    };
    const byId=useMemo(()=>new Map((data?.nodes||[]).map(node=>[node.id,node])),[data]);
    const filtered=useMemo(()=>(data?.nodes||[]).filter(node=>(!kind||node.kind===kind)&&(!query.trim()||(node.label+' '+node.kind+' '+node.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))),[data,kind,query]);
    const matchingIds=useMemo(()=>kind||query.trim()?new Set(filtered.map(node=>node.id)):null,[filtered,kind,query]);
    const connections=(data?.edges||[]).filter(edge=>edge.from===selected?.id||edge.to===selected?.id);
    return h('div',{className:'n-graph-page'},
      h('div',{className:'n-graph-intro'},h('div',null,h('h2',null,'Follow the evidence'),h('p',{className:'n-muted'},'Explore messages, people and memory in three dimensions. Select a node to follow its source.')),
        h('label',{className:'n-graph-scope'},'Archive scope',h('select',{value:scope,onChange:e=>{setScope(e.target.value);setAfter('');setHistory([]);}},h('option',{value:'*'},'All private knowledge'),...scopeList.map(s=>h('option',{key:s.scope,value:s.scope},s.scope+' · '+s.events+' events')))),
        scopes?.next&&button('Load more scopes',()=>setScopeAfter(scopes.next))),
      scopeError&&h('p',{role:'alert'},scopeError),!scopes&&!scopeError&&h('p',{role:'status'},'Loading archive scopes…'),
      scopes&&!scopeList.length&&h(Panel,{title:'Your evidence space starts here'},h('p',null,'Import a chat to explore its messages and connections.'),h('a',{href:'#imports'},'Open Imports & jobs')),
      busy&&h('div',{className:'n-graph-loading',role:'status'},'Loading source relationships…'),
      problem&&h(Panel,{title:'Graph unavailable'},h('p',{role:'alert'},problem),button('Try again',()=>setRetry(v=>v+1))),
      data&&h('div',null,
        data.native_profiles_truncated&&h('p',{role:'status'},'Showing notes from the first 20 native profiles. Select an archive scope or use Hermes memory to inspect further profiles.'),
        h('div',{className:'n-graph-workspace'},h(GraphSpace,{data,selectedId:selected?.id,matchingIds,choose}),
          h('aside',{className:'n-graph-inspector','aria-label':'Graph inspector'},
            h('div',{className:'n-node-browser'},h('h3',null,'Node browser'),
              h('label',{htmlFor:'n-node-search'},'Find on this page'),h('input',{id:'n-node-search',type:'search',placeholder:'Search nodes…',value:query,onChange:e=>setQuery(e.target.value)}),
              h('label',{className:'n-sr-only',htmlFor:'n-node-kind'},'Node type'),h('select',{id:'n-node-kind',value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:''},'All types'),...Object.entries(graphKinds).filter(([key])=>data.nodes.some(n=>n.kind===key)).map(([key,label])=>h('option',{key,value:key},label))),
              h('small',{role:'status'},filtered.length+' of '+data.nodes.length+' nodes'),
              h('div',{className:'n-node-list'},...filtered.map(node=>h('button',{type:'button',key:node.id,className:'n-node-option','aria-pressed':selected?.id===node.id,onClick:()=>choose(node),title:node.kind+': '+node.label},h('span',{className:'n-kind-dot n-kind-'+node.kind,'aria-hidden':true}),h('span',null,h('small',null,graphKinds[node.kind]||node.kind),h('span',{dir:'auto'},node.label))))),
              !filtered.length&&h('p',{className:'n-muted'},'No nodes match. Clear your search or choose another type.')),
            h('div',{className:'n-node-detail'},
              selected?h('div',null,h('div',{className:'n-selection-heading'},h('h3',null,graphKinds[selected.kind]||selected.kind),button('Clear',()=>{selection.current++;setSelected(null);setRecord(null);setSourceError('');setSourceBusy(false);})),
                h('p',{className:'n-node-title',dir:'auto'},selected.label),selected.state&&h('p',{className:'n-badge'},selected.state),
                selected.text&&h(Data,{value:selected.text}),selected.provenance&&h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:selected.provenance})),
                selected.unresolved_citations>0&&h('p',{className:'n-muted'},selected.unresolved_citations+' citations are outside this page or scope.'),
                sourceBusy&&h('p',{role:'status'},'Loading original source…'),sourceError&&h('div',null,h('p',{role:'alert'},sourceError),button('Retry source',()=>choose(selected))),
                record&&button('View original source',()=>source.current?.scrollIntoView({block:'start'}),false,'n-primary'),
                !selected.event_id&&h('p',{className:'n-muted'},'Follow a connection to inspect an original message.'),
                h('details',{open:true},h('summary',null,connections.length+' direct connections'),...connections.map((edge,i)=>{
                  const target=byId.get(edge.from===selected.id?edge.to:edge.from);if(!target)return null;
                  return h('button',{type:'button',key:i,className:'n-connection',onClick:()=>choose(target)},h('small',null,(edge.from===selected.id?'Outgoing · ':'Incoming · ')+edge.kind.replaceAll('_',' ')),h('span',{dir:'auto'},target.label));
                }))) : h('div',null,h('h3',null,'Inspect a connection'),h('p',{className:'n-muted'},'Select a node in the space or the list. Its direct connections will light up here.'),h('p',{className:'n-muted'},'Positions help you navigate. Only the links represent recorded relationships.'))))),
        h('div',{className:'n-graph-legend','aria-label':'Node legend'},...Object.entries(graphKinds).filter(([key])=>data.nodes.some(n=>n.kind===key)).map(([key,label])=>h('span',{key},h('i',{className:'n-kind-dot n-kind-'+key,'aria-hidden':true}),label)),h('span',null,h('i',{className:'n-reference-line','aria-hidden':true}),'Dashed: citation / derived')),
        h('div',{className:'n-graph-pagination'},h('p',{className:'n-muted'},'Page '+(history.length+1)+' · '+data.nodes.filter(n=>n.kind==='message').length+' messages · '+data.unresolved_replies+' reply references outside this page'),
          h('div',{className:'n-space-actions'},button('Previous messages',()=>{setAfter(history.at(-1));setHistory(history.slice(0,-1));},!history.length),button('Next messages',()=>{setHistory([...history,after]);setAfter(data.next);},!data.next),button('Export graph JSON',()=>exportJSON(data,'nocheh-graph.json')))),
        data.bounds.truncated&&h('p',{role:'status'},'Attachment or derived-node limit reached. Open source records for the complete details.'),
        !data.nodes.some(n=>n.kind==='message')&&h('p',{className:'n-muted'},'No messages on this page. Choose another scope or return to the previous page.'),
        h('p',{className:'n-muted'},'Observed relationships and explicit memory citations. This view makes no model calls.'),
        record&&h('div',{ref:source,id:'n-graph-source'},h(Source,{record,notify}))));
  }

  function OperationResult({result}) {
    if(result.containers)return h('div',null,...result.containers.map(c=>h('div',{className:'n-row',key:c.service},h('b',null,c.service),h('span',null,(c.state==='running'?'Running':friendlyState(c.state))+(c.health?' · '+c.health:'')))),h(Details,{value:result,label:'Full diagnostics'}));
    const messages={backed_up:'Full backup created.',restored_inactive:'Backup restored into a separate inactive installation. Telegram and the copied login remain disabled.',exported:'Portable archive ZIP ready to download.',restarted:'Services restarted and readiness checked.',applied:'Saved settings applied to running services.',apply_failed:result.rolled_back?'Applying settings failed. The previous configuration was restored.':'Applying settings failed. Check diagnostics before trying again.'};
    return h('div',null,h('p',null,messages[result.status]||'Task finished. See details for its result.'),
      result.status==='exported'&&h('p',{className:'n-muted'},result.events+' source records · '+result.files+' original files'),
      result.status==='restored_inactive'&&h('p',{className:'n-muted'},(result.verified_tables?.length||0)+' tables verified · '+result.verified_state_files+' state files verified'),h(Details,{value:result}));
  }
  function Operations({notify}){
    const [tick,setTick]=useState(0),[listing,listError]=useLoad('/operations',tick),[jobs,jobsError]=useLoad('/jobs',tick),[review,setReview]=useState(''),[backup,setBackup]=useState(''),[port,setPort]=useState(8795),[busy,setBusy]=useState(false);
    useEffect(()=>{const timer=setInterval(()=>setTick(v=>v+1),3000);return()=>clearInterval(timer);},[]);
    const run=async action=>{setBusy(true);try{await call('/operations',{action,options:action==='restore'?{backup,port}:undefined});setReview('');setTick(v=>v+1);notify('Task started. Follow its progress in Recent maintenance below.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const descriptions={backup:'Pause archive writers, save a consistent database, files and runtime snapshot, then resume those services. This local backup includes private state and credentials.',restart:'Restart Hermes and the archive workers, then check readiness. Telegram replies may be briefly interrupted.',restore:'Restore the selected backup into a new, separate local installation. Telegram stays disabled and the copied subscription login stays inactive. Your current installation is not replaced.'};
    const tasks=(jobs||[]).filter(j=>j.kind!=='import');
    return h('div',null,h('div',{className:'n-operation-grid'},...[
      ['diagnose','Check service health','Inspect containers and archive readiness without changing your data.','Run diagnostics'],
      ['export','Download your archive','Create a portable ZIP of original source records and files.','Prepare archive ZIP'],
      ['backup','Back up the installation','Save the database, files and Hermes runtime state, including credentials, locally.','Review full backup'],
      ['restart','Restart services','Restart the assistant and workers. Wait for active imports to finish.','Review restart']
    ].map(([action,title,note,label])=>h(Panel,{key:action,title,note},button(label,()=>['backup','restart'].includes(action)?setReview(action):run(action),busy)))),
      h(Panel,{title:'Saved backups'},listError&&h('p',{role:'alert'},listError),!listing&&!listError&&h('p',{role:'status'},'Loading saved backups…'),listing&&h('p',{className:'n-muted'},listing.backups.length?listing.backups.length+' local backup'+(listing.backups.length===1?'':'s')+' available. Restore creates a separate installation for verification.':'No backups yet. Create a full backup above to enable an inactive restore.'),
        h('details',null,h('summary',null,'Advanced · restore a backup into an inactive installation'),h('p',{className:'n-muted'},descriptions.restore),
          h('div',{className:'n-form'},h('label',null,'Saved backup',h('select',{value:backup,onChange:e=>{setBackup(e.target.value);setReview('');}},h('option',{value:''},'Choose a backup'),...(listing?.backups||[]).map(b=>h('option',{key:b.id,value:b.id},new Date(b.created_at).toLocaleString()+' · '+b.files+' files')))),
          h('label',null,'Local port for the inactive installation',h('input',{type:'number',min:1024,max:65535,value:port,onChange:e=>{setPort(Number(e.target.value));setReview('');}}))),button('Review inactive restore',()=>setReview('restore'),!backup||busy))),
      review&&h(Panel,{title:'Review '+({backup:'full backup',restart:'service restart',restore:'inactive restore'})[review]},h('p',null,descriptions[review]),review==='restore'&&h('p',null,'Backup '+backup+' · local port '+port),h('div',{className:'n-actions'},button('Confirm '+review,()=>run(review),busy,'n-primary'),button('Cancel',()=>setReview('')))),
      h(Panel,{title:'Recent maintenance',note:'Diagnostics, exports, backups, restarts, restores and settings applies. Results update automatically.'},jobsError&&h('p',{role:'alert'},jobsError),jobs&&!tasks.length&&h('p',{className:'n-empty'},'No maintenance tasks yet. Run diagnostics above to check the installation.'),
        ...tasks.map(j=>h('article',{className:'n-result',key:j.id},h('div',{className:'n-result-heading'},h('h3',null,jobName(j.kind)),h('span',{className:'n-badge'},friendlyState(j.state))),h('small',null,new Date(j.created_at).toLocaleString()),j.error&&h('p',{role:'alert'},j.error),j.result&&h(OperationResult,{result:j.result}),j.kind==='operations.export'&&j.state==='complete'&&button('Download archive ZIP',()=>download('/exports/'+j.id+'/download','nocheh-archive.zip',notify))))));
  }
  function SpaceControls() {
    const [Component,setComponent]=useState(null),[error,setError]=useState('');
    useEffect(()=>{let alive=true;import('../integrations/hermes/dashboard/space-controls.js').then(m=>{if(alive)setComponent(()=>m.createSpaceControls(sdk.React,call));}).catch(e=>{if(alive)setError(errorText(e));});return()=>{alive=false;};},[]);
    return error?h('p',{role:'alert'},error):Component?h(Component):h('p',{role:'status'},'Loading memory controls…');
  }
  const extensions = {spaces:{label:'Memory access',component:SpaceControls},graph:{label:'Evidence graph',component:Graph},operations:{label:'Maintenance',component:Operations},memory:{label:'Hermes memory',component:Memory},honcho:{label:'Honcho lab',component:Honcho}};
  window.__NOCHEH_PAGES__=extensions;
  function Integrations() {
    const [data,error]=useLoad('/runtime');
    return h('div',null,h(Panel,{title:'Hermes',note:'Your agent runtime: chat, native tools, profiles, sessions and built-in memory.'},
      error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Checking runtime…'),
      data&&h('div',null,h('p',{className:'n-badge'},data.status?.ok?'Runtime connected':'Runtime unavailable'),
        h('p',{className:'n-muted'},data.status?.model||'Check runtime health or restart services in Maintenance.'),
        h('a',{className:'n-text-link',href:'/hermes/nocheh'},'Open native Hermes dashboard →'),
        h(Details,{value:data,label:'Runtime status and capabilities'}))),
      h(Panel,{title:'Honcho',note:'A separate, optional memory experiment. Its configuration and data stay separate from your assistant.'},h(RouteLink,{page:'honcho'},'Open Honcho lab →')));
  }
  function App() {
    const [page,setPage]=useState(location.hash.slice(1)||'overview'),[notice,setNotice]=useState(null),[tick,setTick]=useState(0);
    const heading=useRef(null);
    useEffect(()=>{const change=()=>{setPage(location.hash.slice(1)||'overview');setNotice(null);};addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);
    useEffect(()=>{heading.current?.focus({preventScroll:true});},[page]);
    const notify=(text,error=false)=>setNotice({text,error});
    const pages={spaces:'Memory access',overview:'Overview',archive:'Archive',memory:'Memory',graph:'Graph',activity:'Activity',imports:'Imports',integrations:'Integrations',settings:'Settings',operations:'Maintenance',honcho:'Honcho lab'};
    const descriptions={spaces:'Connect your private knowledge and control what each group or topic can use.',overview:'Your conversations, memory, and assistant in one place.',archive:'Find preserved messages and files, and inspect the evidence behind generated text.',memory:'Read the notes Hermes keeps for each chat.',graph:'Explore recorded relationships and follow links back to original sources.',imports:'Add Telegram history to your archive.',integrations:'Manage the tools that power Nocheh.',settings:'Control Telegram access, agent preferences, and privacy.',operations:'Check health, download data, back up and maintain your installation.',honcho:'Inspect a separate memory experiment and its setup status.'};
    descriptions.activity='Review proposed actions, manage permissions and inspect conversation results.';
    const groups=[['Explore',['overview','archive','memory','graph','activity']],['Manage',['imports','spaces','integrations','settings','operations']],['Experiments',['honcho']]];
    const Current=extensions[page]?.component;
    return h('div',{className:'nocheh-app'+(page==='graph'?' n-graph-active':'')},
      h('aside',{className:'n-sidebar'},h('a',{href:'#overview',className:'n-brand'},h('span',{className:'n-mark','aria-hidden':true},'ن'),h('span',null,'Nocheh',h('small',null,'Your conversations & memory'))),
        h('nav',{'aria-label':'Main navigation'},...groups.map(([label,keys])=>h('div',{className:'n-nav-group',key:label},h('span',{className:'n-nav-label'},label),...keys.map(key=>h('a',{href:'#'+key,key,'aria-current':page===key?'page':undefined},pages[key]))))),
        h('label',{className:'n-mobile-navigation'},'Navigate',h('select',{value:pages[page]?page:'overview',onChange:e=>{location.hash=e.target.value;}},...Object.entries(pages).map(([key,label])=>h('option',{key,value:key},label)))),
        h('div',{className:'n-sidebar-foot'},h('a',{href:'/hermes/nocheh',className:'n-text-link'},'Open Hermes ↗'),h('small',null,'Local owner dashboard'))),
      h('main',{className:'n-main'},h('header',{className:'n-header'},h('div',null,h('h1',{ref:heading,tabIndex:-1},pages[page]||'Overview'),h('p',{className:'n-page-description'},descriptions[page]||descriptions.overview)),button('Refresh',()=>setTick(v=>v+1))),
        notice&&h('div',{className:'n-notice '+(notice.error?'n-error':''),role:notice.error?'alert':'status'},notice.text,button('Dismiss',()=>setNotice(null))),
        h('div',{key:page+tick},page==='activity'?h(Activity,{notify}):page==='integrations'?h(Integrations):page==='settings'?h(Settings,{notify}):page==='imports'?h(Jobs,{notify}):page==='archive'?h(Archive,{notify}):Current?h(Current,{notify,call,h,sdk}):h(Status,{refresh:tick})),
        h('footer',null,'Owned archive · Native Hermes memory · Local administration')));
  }
  createRoot(document.getElementById('root')).render(h(App));
})();
