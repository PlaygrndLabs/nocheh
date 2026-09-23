import {useRevisionDraft} from '../lib/draft';
import {RotateCcw} from 'lucide-react';
import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
export function Settings({notify}) {
 const [defaultsRevision,setDefaultsRevision]=useState(0);
 return h(Tabs,{defaultValue:'nocheh',className:'settings-page'},h(TabsList,{'aria-label':'Settings category'},h(TabsTrigger,{value:'nocheh'},'Nocheh settings'),h(TabsTrigger,{value:'hermes'},'Hermes preferences')),
  h(TabsContent,{value:'nocheh',forceMount:true},h(NochehSettings,{notify})),h(TabsContent,{value:'hermes',forceMount:true},h(HermesPreferences,{notify,defaultsRevision}),h(PolicySettings,{notify,onSaved:()=>setDefaultsRevision(v=>v+1)})));
}
  function PolicySettings({notify,onSaved}) {
    const [tick,setTick]=useState(0),[data,error]=useLoad('/policy',tick),[changes,setChanges,editRevision]=useRevisionDraft(data?.revision),[busy,setBusy]=useState(false);
    const save=async e=>{e.preventDefault();setBusy(true);try{await call('/policy',{changes,revision:editRevision});setChanges({});setTick(v=>v+1);onSaved();notify('Global preferences saved. Profiles that inherit them use them on the next turn.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h(Panel,{title:'Global Hermes defaults',note:'These values apply to Hermes profiles without their own override. Saving a default does not replace a profile override.'},
      error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Loading policy…'),data&&h('form',{onSubmit:save},h('div',{className:'n-form n-settings-preferences'},...Object.entries(data.schema).map(([key,spec])=>{
        const input={id:'policy-'+key,value:changes[key]??data.values[key],disabled:busy,onChange:e=>setChanges({...changes,[key]:spec.choices?e.target.value:Number(e.target.value)})};
        const name=({'nocheh_tools.shell':'Controlled shell','nocheh_tools.browser':'Controlled browser','nocheh_tools.mcp':'Controlled MCP','agent.reasoning_effort':'Reasoning effort','agent.max_iterations':'Maximum agent steps','agent.run_budget_seconds':'Time per turn (seconds)','memory.memory_char_limit':'General memory limit (characters)','memory.user_char_limit':'User profile limit (characters)'})[key]||key;
        return h('div',{className:'n-field n-settings-preference',key},h('label',{htmlFor:input.id},name),h('div',{className:'n-preference-control'},spec.choices?h('select',input,...spec.choices.map(v=>h('option',{value:v,key:v},v))):h('input',{...input,type:'number',min:spec.min,max:spec.max,required:true}),h(Button,{type:'button',variant:'outline',size:'icon',title:'Reset '+name+' to the built-in default','aria-label':'Reset '+name+' to the built-in default',disabled:busy||changes[key]===null||(changes[key]===undefined&&data.origins[key]==='default'),onClick:()=>setChanges({...changes,[key]:null})},h(RotateCcw,{size:16,'aria-hidden':true}))),h('small',null,changes[key]===null?'Built-in default will apply after saving.':'Source: '+data.origins[key]));
      })),h('div',{className:'n-actions'},h('button',{className:'n-primary',disabled:busy||!Object.keys(changes).length},busy?'Saving…':'Save global preferences'),button('Discard edits',()=>setChanges({}),busy))),
      h('p',{className:'n-muted'},'External actions currently require owner review. Broader tool policies become available with the tools phase; job overrides are stored for the scheduling phase.'));
  }
  function NochehSettings({notify}) {
    const [refresh,setRefresh]=useState(0),[data,error]=useLoad('/settings',refresh);
    const [identityDirectory,identityError]=useLoad('/telegram/identities');
    const [changes,setChanges,editRevision]=useRevisionDraft(data?.revision),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
    const [accessGroup,setAccessGroup]=useState(''),[accessUser,setAccessUser]=useState('');
    const save=async()=>{setBusy(true);try{await call('/settings',{revision:editRevision,changes});setChanges({});setReview(false);setRefresh(v=>v+1);notify('Nocheh settings saved. Apply saved settings when you are ready to update running services.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const apply=async()=>{setBusy(true);try{await call('/settings/apply',{});notify('Applying saved settings. Follow the result in Maintenance.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    if(error&&!data)return h(Alert,null,'Settings are unavailable.');
    if(!data)return h('p',{role:'status'},'Loading settings…');
    const hints={TELEGRAM_ENABLED:'Start or stop Telegram message handling when settings are applied.',TELEGRAM_OWNER_ID:'Your numeric Telegram user ID. Only the owner can administer Nocheh.',TELEGRAM_GROUP_IDS:'Comma-separated numeric chat IDs. Each selected group uses its own memory and sources.',TELEGRAM_BOT_TOKEN:'The token from BotFather for the bot used by the native Hermes Telegram adapter.',NOCHEH_MODEL:'The model used through your ChatGPT subscription.',NOCHEH_GUARD_MODE:'On uses saved guarded copies for agents and memory. Off uses originals with the same access rules.',NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Explicit destinations for trusted preparation services. This does not bypass guarding for agents.',NOCHEH_PORT:'Local port used by the archive service.'};
    const field=f=>{
      const value=changes[f.key]??f.value??'';
      const attrs={id:f.key,disabled:busy||!f.editable,value,type:f.secret?'password':'text',placeholder:f.secret&&f.configured?'****':undefined,autoComplete:'off','aria-describedby':f.key+'-help',onChange:e=>{const next={...changes};if(f.secret&&!e.target.value)delete next[f.key];else next[f.key]=e.target.value;setChanges(next);setReview(false);}};
      const options=f.key==='NOCHEH_GUARD_MODE'?[['on','On · use guarded copies'],['off','Off · use originals']]:[['false','Disabled'],['true','Enabled']];
      return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]||f.key,f.secret&&h('span',{className:'n-secret-status'},f.configured?'Configured':'Missing')),
        f.key==='NOCHEH_GUARD_MODE'||f.key==='TELEGRAM_ENABLED'?h('select',attrs,...options.map(([value,label])=>h('option',{key:value,value},label))):h('input',attrs),
        h('small',{id:f.key+'-help'},hints[f.key],f.key==='TELEGRAM_GROUP_IDS'&&!value?' No groups selected; owner private messages can still work.':'',f.secret?' '+(f.configured?(f.editable?'**** is a placeholder, not the saved value. Leave blank to keep it; enter a replacement to change it.':'Configured and managed internally.'):'Not configured.'):!f.editable?' Managed automatically.':''),
        f.key==='TELEGRAM_GROUP_IDS'&&groups.length&&h('small',null,'Selected: '+groups.map(groupLabel).join('; ')),
        f.key==='TELEGRAM_OWNER_ID'&&observedUsers.has(value)&&h('small',null,participantLabel(value)));
    };
    const group=(title,note,keys,extra=null)=>{const id='settings-'+keys[0].toLowerCase();return h('section',{className:'n-settings-group','aria-labelledby':id},h('h3',{id},title),h('p',{className:'n-muted'},note),h('div',{className:'n-form'},...data.fields.filter(f=>keys.includes(f.key)).map(field)),extra);};
    const saved=key=>data.fields.find(f=>f.key===key)?.value||'';
    const groups=(changes.TELEGRAM_GROUP_IDS??saved('TELEGRAM_GROUP_IDS')).split(',').map(value=>value.trim()).filter(Boolean);
    const owner=changes.TELEGRAM_OWNER_ID??saved('TELEGRAM_OWNER_ID');
    const observed=identityDirectory?.groups||[],observedById=new Map(observed.map(group=>[group.id,group]));
    const observedUsers=new Map(observed.flatMap(group=>group.users||[]).map(user=>[user.id,user]));
    const groupLabel=id=>{const name=observedById.get(id)?.name;return name?name+' · ID '+id:'Group ID '+id;};
    const participantLabel=id=>{
      const found=observedUsers.get(id);
      if(!found)return 'User ID '+id;
      const name=[found.name,found.username&&found.username!==found.name?'('+found.username+')':null].filter(Boolean).join(' ');
      return name?name+' · ID '+id:'User ID '+id;
    };
    const addObservedGroup=id=>{if(!id||groups.includes(id))return;setChanges({...changes,TELEGRAM_GROUP_IDS:[...groups,id].join(',')});setAccessGroup(id);setReview(false);};
    const chosen=groups.includes(accessGroup)?accessGroup:groups[0];
    const candidates=(observedById.get(chosen)?.users||[]).filter(user=>user.id!==owner);
    let access={};try{access=JSON.parse(changes.TELEGRAM_GROUP_ACCESS??saved('TELEGRAM_GROUP_ACCESS')??'{}');}catch{access={};}
    const rule=access[chosen]||{granted:[],denied:[]};
    const changeAccess=(decision,user)=>{
      if(!/^[1-9]\d{0,18}$/.test(user)||user===owner){notify('Enter a valid participant user ID other than the owner.',true);return;}
      const next={...access},current=next[chosen]||{granted:[],denied:[]};
      const granted=current.granted.filter(id=>id!==user),denied=current.denied.filter(id=>id!==user);
      if(decision==='grant')granted.push(user);if(decision==='deny')denied.push(user);
      if(granted.length||denied.length)next[chosen]={granted:granted.sort(),denied:denied.sort()};else delete next[chosen];
      setChanges({...changes,TELEGRAM_GROUP_ACCESS:JSON.stringify(next)});setAccessUser('');setReview(false);
    };
    const accessEditor=h('div',{className:'n-settings-access','aria-labelledby':'group-access-title'},
      h('h4',{id:'group-access-title'},'Who may address Nocheh in groups'),
      h('p',{className:'n-muted'},'Only you may start a bot reply by default. Choose a known person to fill their ID, or enter an ID manually. Telegram supplies group administrators; other people appear after Nocheh observes them. A deny wins over a grant. Save and Apply for changes to take effect.'),
      !identityDirectory&&!identityError&&h('p',{role:'status'},'Looking up Telegram group names and visible people…'),
      identityError&&h('p',{role:'status'},'Observed Telegram names are unavailable. You can still enter numeric IDs.'),
      observed.some(group=>!groups.includes(group.id))&&h('div',{className:'n-field'},h('label',{htmlFor:'observed-group'},'Add an observed group'),
        h('select',{id:'observed-group',value:'',disabled:busy,onChange:e=>addObservedGroup(e.target.value)},h('option',{value:''},'Choose a group…'),
          ...observed.filter(group=>!groups.includes(group.id)).map(group=>h('option',{value:group.id,key:group.id},groupLabel(group.id))))),
      groups.length?h('div',{className:'n-form'},
        h('div',{className:'n-field'},h('label',{htmlFor:'access-group'},'Selected group'),h('select',{id:'access-group',value:chosen,disabled:busy,onChange:e=>setAccessGroup(e.target.value)},...groups.map(id=>h('option',{value:id,key:id},groupLabel(id))))),
        h('div',{className:'n-field'},h('label',{htmlFor:'observed-user'},'Known participant'),
          h('select',{id:'observed-user',value:'',disabled:busy||!candidates.length,onChange:e=>setAccessUser(e.target.value)},h('option',{value:''},candidates.length?'Choose a person to fill their ID…':'No known participants in this group'),
            ...candidates.map(user=>h('option',{value:user.id,key:user.id},participantLabel(user.id))))),
        h('div',{className:'n-field'},h('label',{htmlFor:'access-user'},'Participant user ID'),h('input',{id:'access-user',inputMode:'numeric',value:accessUser,disabled:busy,placeholder:'Telegram numeric user ID',onChange:e=>setAccessUser(e.target.value)}),
          accessUser&&h('small',null,participantLabel(accessUser))),
        h('div',{className:'n-actions'},button('Grant access',()=>changeAccess('grant',accessUser),busy||!accessUser),button('Deny access',()=>changeAccess('deny',accessUser),busy||!accessUser)),
        h('div',{className:'n-field n-settings-decisions'},h('b',null,'Participant decisions'),
          !rule.granted.length&&!rule.denied.length?h('p',{className:'n-muted'},'No participant access granted. Only you may address Nocheh here.'):
          h('div',{className:'n-list'},
            ...rule.granted.map(id=>h('div',{className:'n-row',key:'grant-'+id},h('span',null,participantLabel(id)+' · granted'),button('Revoke',()=>changeAccess('revoke',id),busy))),
            ...rule.denied.map(id=>h('div',{className:'n-row',key:'deny-'+id},h('span',null,participantLabel(id)+' · denied'),button('Revoke',()=>changeAccess('revoke',id),busy))))),
        Object.keys(access).some(id=>!groups.includes(id))&&h('p',{role:'alert'},'A removed group still has access decisions. Restore its group ID or revoke its decisions before saving.')):
        h('p',{className:'n-muted'},'Add a selected group above to manage participant access.'));
    const reviewValue=(key,value)=>{
      if(key==='TELEGRAM_GROUP_IDS')return value.split(',').filter(Boolean).map(groupLabel).join(', ')||'(empty)';
      if(key==='TELEGRAM_OWNER_ID')return participantLabel(value);
      if(key==='TELEGRAM_GROUP_ACCESS')try{return Object.entries(JSON.parse(value)).map(([id,decision])=>
        groupLabel(id)+': '+[...(decision.granted||[]).map(user=>participantLabel(user)+' granted'),...(decision.denied||[]).map(user=>participantLabel(user)+' denied')].join(', ')).join('; ')||'Owner only';}catch{return 'Invalid group access configuration';}
      return value||'(empty)';
    };
    return h(Panel,{title:'Nocheh settings',note:'Telegram access, model routing and privacy for the whole installation. Stored in Nocheh’s .env file.'},
      error&&h(Alert,null,'Saved settings may be stale. Edits are retained.'),
      editRevision!==data.revision&&h(Alert,null,'These settings changed elsewhere. Your edits are retained against the original revision. Discard edits to load the new values, or attempt Save to see the conflict.'),
      h(StatusBadge,{state:data.apply_state,label:({current:'Saved settings match the last successful apply',pending:'Saved changes are waiting to be applied',unverified:'Running settings have not been verified by this dashboard'})[data.apply_state]||data.apply_state}),
      h(Steps,{items:['Edit and review','Save configuration','Apply to running services']}),
      h('form',{onSubmit:e=>{e.preventDefault();setReview(true);}},
        group('Telegram access','Choose who can use the assistant and which groups it can participate in.',['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_BOT_TOKEN'],accessEditor),
        group('Model and privacy','These rules apply to outgoing model requests. Hermes profile preferences are in the other settings section.',['NOCHEH_MODEL','NOCHEH_GUARD_MODE']),
        h('details',{className:'n-advanced'},h('summary',null,'Advanced · destinations, connections and internal credentials'),h('div',{className:'n-form'},...data.fields.filter(f=>!['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_GROUP_ACCESS','TELEGRAM_BOT_TOKEN','NOCHEH_MODEL','NOCHEH_GUARD_MODE'].includes(f.key)).map(field))),
        h('div',{className:'n-actions'},h('button',{disabled:busy||!Object.keys(changes).length},'Review changes'),button('Discard edits',()=>{setChanges({});setReview(false);},busy||!Object.keys(changes).length))),
      review&&h('div',{className:'n-review'},h('h3',null,'Review before saving'),h('p',null,'Saving changes the configuration file. Running services update only after Apply.'),...Object.entries(changes).map(([k,v])=>h('p',{key:k},(labels[k]||k)+': '+(data.fields.find(f=>f.key===k)?.secret?'Replace stored credential':reviewValue(k,v)))),button('Save changes',save,busy,'n-primary')),
      h('div',{className:'n-apply'},h('h3',null,'Apply saved settings'),h('p',{className:'n-muted'},'Updates the running services and may briefly interrupt Telegram replies. Save or discard your current edits first.'),button('Apply saved settings',apply,busy||!!Object.keys(changes).length),h(RouteLink,{page:'operations'},'View apply results →')));
  }
  function HermesPreferences({notify,defaultsRevision}) {
    const [profiles,error]=useLoad('/memory/profiles'),[scope,setScope]=useState(''),[tick,setTick]=useState(0),[busy,setBusy]=useState(false);
    useEffect(()=>{if(!scope&&profiles?.profiles?.length)setScope(profiles.profiles[0].scope);},[profiles]);
    const [prefs,problem]=useLoad(scope?'/memory/preferences?scope='+encodeURIComponent(scope):null,tick+defaultsRevision);
    const [changes,setChanges,editRevision]=useRevisionDraft(prefs?.revision);
    const names={'nocheh_tools.shell':['Controlled shell','Propose commands in an isolated workspace. Each execution requires approval or an exact bounded permission.'],'nocheh_tools.browser':['Controlled browser','Inspect an approved public page offline. No logins or interactive actions.'],'nocheh_tools.mcp':['Controlled MCP','Propose an exact call to a public HTTPS MCP server. No ambient credentials.'],'agent.reasoning_effort':['Reasoning effort','Higher effort allows more reasoning and can take longer.'],'agent.max_iterations':['Maximum agent steps','Maximum tool and reasoning iterations in one turn.'],'agent.run_budget_seconds':['Time per turn (seconds)','Upper time budget for one assistant turn.'],'memory.memory_char_limit':['General memory limit (characters)','Space available for Hermes’s general memory note.'],'memory.user_char_limit':['User profile limit (characters)','Space available for Hermes’s user profile note.']};
    const save=async e=>{e.preventDefault();if(prefs?.scope!==scope)return;setBusy(true);try{await call('/memory/preferences',{scope,revision:editRevision,changes});setChanges({});setTick(v=>v+1);notify('Hermes preferences saved for this profile. They take effect on the next turn.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    return h(Panel,{title:'Hermes profile preferences',note:'These values apply to one chat profile. The global Hermes defaults below apply wherever this profile has no override. Saves take effect on the next turn; no service restart is needed.'},
      error&&h('p',{role:'alert'},error),h('label',null,'Profile to configure',h('select',{value:scope,disabled:busy,onChange:e=>{setScope(e.target.value);setChanges({});}},...(profiles?.profiles||[]).map(p=>h('option',{value:p.scope,key:p.scope},profileName(p))))),
      !profiles&&!error&&h('p',{role:'status'},'Loading profiles…'),profiles&&!profiles.profiles.length&&h('p',null,'Configure the Telegram owner and groups in Nocheh settings to make profiles available.'),
      problem&&h('p',{role:'alert'},problem),scope&&!problem&&prefs?.scope!==scope&&h('p',{role:'status'},'Loading this profile’s preferences…'),
      scope&&prefs?.scope===scope&&h('form',{onSubmit:save},h('div',{className:'n-form n-preferences n-settings-preferences'},...Object.entries(prefs.schema).map(([key,spec])=>{
        const input={id:key,value:changes[key]??prefs.values[key],disabled:busy,'aria-describedby':key+'-help',onChange:e=>setChanges({...changes,[key]:spec.choices?e.target.value:Number(e.target.value)})};
        const name=names[key]?.[0]||key;
        return h('div',{className:'n-field n-settings-preference',key},h('label',{htmlFor:key},name),h('div',{className:'n-preference-control'},spec.choices?h('select',input,...spec.choices.map(v=>h('option',{key:v,value:v},v[0].toUpperCase()+v.slice(1)))):h('input',{...input,type:'number',min:spec.min,max:spec.max,required:true,step:1}),h(Button,{type:'button',variant:'outline',size:'icon',title:'Reset '+name+' to the global default','aria-label':'Reset '+name+' to the global default',disabled:busy||changes[key]===null||(changes[key]===undefined&&prefs.origins?.[key]!=='profile'),onClick:()=>setChanges({...changes,[key]:null})},h(RotateCcw,{size:16,'aria-hidden':true}))),h('small',{id:key+'-help'},changes[key]===null?'Global default will apply after saving.':(names[key]?.[1]||'')+' Source: '+(prefs.origins?.[key]||'profile')));
      })),h('div',{className:'n-actions'},h('button',{disabled:busy||!Object.keys(changes).length,className:'n-primary'},busy?'Saving…':'Save Hermes preferences'),button('Discard edits',()=>setChanges({}),busy||!Object.keys(changes).length))),
      h('p',{className:'n-muted n-afterword'},'Model routing, enabled tools and access policy are managed by Nocheh. These are the supported native preferences, not the full Hermes configuration.'),h(RouteLink,{page:'memory'},'Read this installation’s Hermes memory →'));
  }
