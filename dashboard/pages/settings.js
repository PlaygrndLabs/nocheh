import {useRevisionDraft} from '../lib/draft';
import {participantAllowed,switchDecision} from '../lib/group-access.js';
import {RotateCcw} from 'lucide-react';
import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
export function Settings({notify}) {
 const [defaultsRevision,setDefaultsRevision]=useState(0);
 return h(Tabs,{defaultValue:'nocheh',className:'settings-page'},h(TabsList,{'aria-label':'Settings category'},h(TabsTrigger,{value:'nocheh'},'Nocheh settings'),h(TabsTrigger,{value:'hermes'},'Hermes preferences')),
  h(TabsContent,{value:'nocheh',forceMount:true},h(NochehSettings,{notify}),h(TelegramGroups,{notify}),h(OwnerFreedom,{notify})),h(TabsContent,{value:'hermes',forceMount:true},h(HermesPreferences,{notify,defaultsRevision}),h(PolicySettings,{notify,onSaved:()=>setDefaultsRevision(v=>v+1)})));
}
  function TelegramGroups({notify}) {
    const [tick,setTick]=useState(0),[data,error]=useLoad('/conversations?limit=100',tick),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
    const groups=(data?.items||[]).filter(item=>item.kind==='group'&&item.configured);
    const topicsOf=group=>(data?.items||[]).filter(item=>item.kind==='topic'&&item.parent_space===group.space_id);
    const forums=groups.filter(group=>/^-100/.test(group.space_id));
    const [topicGroup,setTopicGroup]=useState(''),[topicRef,setTopicRef]=useState(''),[topicName,setTopicName]=useState('');
    const changeTopic=async(body,message)=>{
      setBusy(true);setProblem('');
      try{await call('/telegram/topics',body);setTick(v=>v+1);notify(message);return true;}catch(error){setProblem(errorText(error));return false;}finally{setBusy(false);}
    };
    const addTopic=async event=>{
      event.preventDefault();const ref=topicRef.trim(),group=topicGroup||forums[0]?.space_id;
      const target=/^\d+$/.test(ref)?{chat_id:group,topic_id:Number(ref)}:{link:ref};
      if(await changeTopic({action:'add',name:topicName,...target},'Topic added to the directory.')){setTopicRef('');setTopicName('');}
    };
    const topicLine=topic=>h('li',{key:topic.space_id},
      h('span',{dir:'auto'},topic.name||'Name unknown'),h('code',null,topic.space_id.split('/topic/')[1]),
      h('small',{className:'n-muted'},[topic.closed&&'closed',topic.registered&&'added by you',!topic.observed_at&&!topic.registered&&'no message yet'].filter(Boolean).join(' · ')),
      topic.registered&&button('Remove',()=>changeTopic({action:'remove',chat_id:topic.parent_space,topic_id:Number(topic.space_id.split('/topic/')[1])},'Topic removed from the directory.'),busy,''));
    const status=item=>item.telegram?.state==='migrated'?'Upgraded to a supergroup. Its new ID is '+item.telegram.migrate_to_chat_id+'; update Selected groups.':
      item.telegram?.state==='not_member'?'The bot is not a member of this group.':item.telegram?.state==='not_found'?'Telegram did not find this group.':
      item.observed_at?'Messages received.':'No message received from this group yet.';
    const refresh=async()=>{
      setBusy(true);setProblem('');
      try{const result=await call('/telegram/chats/refresh',{});setTick(v=>v+1);notify(`Checked ${result.chats.length} ${result.chats.length===1?'group':'groups'} with Telegram.`);}
      catch(error){setProblem(errorText(error));}finally{setBusy(false);}
    };
    return h(Panel,{title:'Telegram groups',note:'Names come from messages Nocheh received. Refresh asks Telegram for the selected groups\u2019 current names; it sends nothing.'},
      error&&!data&&h(Alert,null,'The group list is unavailable. Refresh and try again.'),!data&&!error&&h('p',{role:'status'},'Loading groups…'),
      data&&(groups.length?h('ul',{className:'telegram-groups'},groups.map(item=>h('li',{key:item.space_id},
        h('strong',{dir:'auto'},item.name||'Name unknown'),h('code',null,item.space_id),h('span',{className:'n-muted'},status(item)),
        topicsOf(item).length>0&&h('ul',{className:'telegram-topics','aria-label':'Topics in '+(item.name||item.space_id)},topicsOf(item).map(topicLine))))):
        h('p',{className:'n-muted'},'No groups are selected. Owner private messages still work.')),
      forums.length>0&&h('form',{className:'telegram-topic-form',onSubmit:addTopic},
        h('p',{className:'n-muted'},'Telegram does not let bots list topics. New topics appear automatically when they are created or renamed; add an older topic with no messages here. In Telegram, open the topic and use Copy link.'),
        forums.length>1&&h('label',null,'Group',h('select',{value:topicGroup||forums[0].space_id,disabled:busy,onChange:e=>setTopicGroup(e.target.value)},
          forums.map(group=>h('option',{key:group.space_id,value:group.space_id},group.name||group.space_id)))),
        h('label',null,'Topic link or number',h('input',{value:topicRef,disabled:busy,placeholder:'https://t.me/c/…/12',onChange:e=>setTopicRef(e.target.value)})),
        h('label',null,'Topic name',h('input',{value:topicName,disabled:busy,dir:'auto',maxLength:128,onChange:e=>setTopicName(e.target.value)})),
        h('div',{className:'n-actions'},h('button',{className:'n-primary',disabled:busy||!topicRef.trim()||!topicName.trim()},'Add topic'))),
      problem&&h('p',{role:'alert',className:'source-retirement-error'},'Refresh failed: '+problem+'. Telegram may be unavailable; try again.'),
      h('div',{className:'n-actions'},button(busy?'Checking with Telegram…':'Refresh from Telegram',refresh,busy||!groups.length,'')));
  }
  function OwnerFreedom({notify}) {
    const [tick,setTick]=useState(0),[data,error]=useLoad('/owner-autonomy',tick),[choice,setChoice]=useState(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
    const selected=choice??data?.mode??'approval_required',changed=!!data&&selected!==data.mode;
    const options=[
      ['approval_required','Ask me first (default)','Every Telegram message Nocheh sends for you and every shell, browser and MCP tool waits for your approval in Activity or your private chat.'],
      ['owner_requests_execute','Do what I ask','When you ask in your own private chat, Nocheh sends messages and runs tools without a separate approval. Requests from groups, schedules and background work still wait for approval, and explicit deny rules still block.']];
    const save=async e=>{
      e.preventDefault();if(!changed||busy)return;setBusy(true);setProblem('');
      try{const result=await call('/owner-autonomy',{mode:selected,expected_revision:data.revision,operation_id:crypto.randomUUID()});setChoice(null);setTick(v=>v+1);
        notify(result.mode==='owner_requests_execute'?'Your private requests now run without a separate approval.':'Every external action now waits for your approval.');}
      catch(error){setProblem(errorText(error));setTick(v=>v+1);}finally{setBusy(false);}
    };
    return h(Panel,{title:'Owner freedom',note:'How much Nocheh may do on your behalf without asking. Applies immediately; no restart is needed.'},
      error&&!data&&h(Alert,null,'The owner freedom setting is unavailable. Refresh and try again.'),!data&&!error&&h('p',{role:'status'},'Loading owner freedom…'),
      data&&h('form',{onSubmit:save,className:'owner-freedom'},
        h('fieldset',null,h('legend',{className:'sr-only'},'Owner freedom level'),
          options.map(([value,label,text])=>h('label',{key:value,className:'owner-freedom-option'},
            h('input',{type:'radio',name:'owner-freedom',value,checked:selected===value,disabled:busy,onChange:()=>setChoice(value)}),
            h('span',null,h('strong',null,label),h('span',{className:'n-muted'},text))))),
        problem&&h('p',{role:'alert',className:'source-retirement-error'},'Not saved: '+problem+'. Check the current setting and try again.'),
        h('p',{role:'status',className:'n-muted'},'Current: '+(data.mode==='owner_requests_execute'?'Do what I ask':'Ask me first')+(data.updated_at&&data.revision?' · changed '+new Date(data.updated_at).toLocaleString():'')),
        h('div',{className:'n-actions'},h('button',{className:'n-primary',disabled:busy||!changed},busy?'Saving…':'Save owner freedom'),changed&&button('Discard',()=>setChoice(null),busy))));
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
      h('p',{className:'n-muted'},'Whether external actions wait for your review is set under Owner freedom in Nocheh settings. Job overrides are stored for the scheduling phase.'));
  }
  function NochehSettings({notify}) {
    const [refresh,setRefresh]=useState(0),[data,error]=useLoad('/settings',refresh);
    const [identityTick,setIdentityTick]=useState(0),[identityDirectory,identityError]=useLoad('/telegram/identities',identityTick);
    const [chatRefresh,setChatRefresh]=useState(null),[refreshingChats,setRefreshingChats]=useState(false);
    // Reads Telegram only when the owner asks; saved names then serve every directory view.
    const refreshChats=async()=>{setRefreshingChats(true);
      try{const result=await call('/telegram/chats/refresh',{});setChatRefresh(result.chats||[]);setIdentityTick(v=>v+1);void refreshResources();notify('Group information refreshed from Telegram.');}
      catch(e){notify(errorText(e),true);}finally{setRefreshingChats(false);}};
    const chatState=chat=>chat.state==='available'?(chat.title||'No title')+(chat.is_forum?' · forum':''):chat.state==='migrated'?
      'Upgraded to a supergroup with ID '+chat.migrate_to_chat_id+'. Replace the old ID in Selected groups.':chat.state==='not_member'?
      'Nocheh’s bot is not a member of this group.':'Telegram does not know this ID.';
    const [changes,setChanges,editRevision]=useRevisionDraft(data?.revision),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
    const [accessGroup,setAccessGroup]=useState(''),[accessUser,setAccessUser]=useState(''),[manualDecision,setManualDecision]=useState('deny');
    const save=async()=>{setBusy(true);try{await call('/settings',{revision:editRevision,changes});setChanges({});setReview(false);setRefresh(v=>v+1);notify('Nocheh settings saved. Apply saved settings when you are ready to update running services.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    const apply=async()=>{setBusy(true);try{await call('/settings/apply',{});notify('Applying saved settings. Follow the result in Maintenance.');}catch(e){notify(errorText(e),true);}finally{setBusy(false);}};
    if(error&&!data)return h(Alert,null,'Settings are unavailable.');
    if(!data)return h('p',{role:'status'},'Loading settings…');
    const hints={TELEGRAM_ENABLED:'Start or stop Telegram message handling when settings are applied.',TELEGRAM_OWNER_ID:'Your numeric Telegram user ID. Only the owner can administer Nocheh.',TELEGRAM_GROUP_IDS:'Comma-separated numeric chat IDs. Each selected group uses its own memory and sources.',TELEGRAM_BOT_TOKEN:'The token from BotFather for the bot used by the native Hermes Telegram adapter.',NOCHEH_MODEL:'One model for Hermes replies, Honcho memory and secret detection, grouped by the provider login that serves it.',NOCHEH_EMBEDDING_MODEL:'The OpenAI model that turns memory into searchable vectors, paid from the embedding budget.',NOCHEH_GUARD_MODE:'On uses saved guarded copies for agents and memory. Off uses originals with the same access rules.',NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Explicit destinations for trusted preparation services. This does not bypass guarding for agents.',NOCHEH_PORT:'Local port used by the archive service.',NOCHEH_PARALLEL_RUNS:'Isolated agent containers that may run at once, shared by replies, memory reviews, browser turns and schedules. Each uses up to 2 GB of memory and 2 CPUs.',NOCHEH_PARALLEL_REPLIES:'Different chats answered at the same time. Messages in one chat, including every topic of a group, are always answered in order. Keep this below parallel agent runs so memory reviews and schedules still have room.'};
    const field=f=>{
      const value=changes[f.key]??f.value??'';
      const attrs={id:f.key,disabled:busy||!f.editable,value,type:f.secret?'password':'text',placeholder:f.secret&&f.configured?'****':undefined,autoComplete:'off','aria-describedby':f.key+'-help',onChange:e=>{const next={...changes};if(f.secret&&!e.target.value)delete next[f.key];else next[f.key]=e.target.value;setChanges(next);setReview(false);}};
      const served=data.models?.reasoning||[],locked=data.models?.embedding_locked;
      if(f.key==='NOCHEH_MODEL') {
        // One group per provider login; providers without a login offer no models.
        const providers=data.models?.providers||[],signedIn=providers.filter(p=>p.signed_in),missing=providers.filter(p=>!p.signed_in);
        const running=data.models?.provider_running!==false,offered=signedIn.some(p=>p.models.length);
        const cpa=h('a',{href:'/providers/management.html'},'CPA dashboard');
        const hint=!signedIn.length?['No model provider is signed in. Sign in to Claude or ChatGPT in the ',cpa,', then reload this page.']:
          !running?['The provider service is not running, so its models cannot be listed. Start Nocheh, then reload this page.']:
          !offered?['Signed in to '+signedIn.map(p=>p.label).join(' and ')+', but the provider lists no models yet. Reload in a moment.']:
          [hints[f.key],missing.length?' Not signed in: '+missing.map(p=>p.label+(p.id==='codex'?' (needed for voice transcription)':'')).join(', ')+'. Sign in from the ':'',missing.length?cpa:'',missing.length?'.':''];
        const groups=signedIn.filter(p=>p.models.length).map(p=>h('optgroup',{key:p.id,label:p.label},...p.models.map(model=>h('option',{key:model,value:model},model))));
        const stale=value&&!served.includes(value)?[h('option',{key:'saved',value},value+' · not served by a signed-in provider')]:[];
        return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]),
          offered?h('select',attrs,...stale,...groups):h('input',{...attrs,disabled:true}),
          h('small',{id:f.key+'-help',role:offered?undefined:'status'},...hint));
      }
      if(f.key==='NOCHEH_EMBEDDING_MODEL')
        return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]),
          h('select',attrs,...(data.models?.embedding||[value]).map(model=>h('option',{key:model,value:model},model))),
          h('small',{id:f.key+'-help'},hints[f.key],locked?' Memory already holds vectors from '+locked+'; another model needs a Honcho memory rebuild first.':' It can be changed until memory stores its first vectors.'));
      if(f.key==='NOCHEH_PARALLEL_RUNS'||f.key==='NOCHEH_PARALLEL_REPLIES') {
        // Replies can never exceed the agent runs that carry them.
        const runs=Number(changes.NOCHEH_PARALLEL_RUNS??saved('NOCHEH_PARALLEL_RUNS'))||4,limit=f.key==='NOCHEH_PARALLEL_RUNS'?8:runs;
        return h('div',{className:'n-field',key:f.key},h('label',{htmlFor:f.key},labels[f.key]),
          h('select',attrs,...Array.from({length:limit},(_,i)=>String(i+1)).map(n=>h('option',{key:n,value:n},n))),
          h('small',{id:f.key+'-help'},hints[f.key],f.key==='NOCHEH_PARALLEL_REPLIES'&&Number(value)>runs?' This is more than parallel agent runs; lower it before saving.':''));
      }
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
    const participantName=id=>observedUsers.get(id)?.name||observedUsers.get(id)?.username||'Unknown person';
    const participantMeta=id=>{const found=observedUsers.get(id);return [found?.name&&found.username!==found.name?found.username:null,'ID '+id].filter(Boolean).join(' · ');};
    const addObservedGroup=id=>{if(!id||groups.includes(id))return;setChanges({...changes,TELEGRAM_GROUP_IDS:[...groups,id].join(',')});setAccessGroup(id);setReview(false);};
    const chosen=groups.includes(accessGroup)?accessGroup:groups[0];
    let access={};try{access=JSON.parse(changes.TELEGRAM_GROUP_ACCESS??saved('TELEGRAM_GROUP_ACCESS')??'{}');}catch{access={};}
    const rule=access[chosen]||{granted:[],denied:[]};
    let savedAccess={};try{savedAccess=JSON.parse(saved('TELEGRAM_GROUP_ACCESS')||'{}');}catch{}
    const savedRule=savedAccess[chosen]||{granted:[],denied:[]};
    const participantIds=[...new Set([...(observedById.get(chosen)?.users||[]).map(user=>user.id),...rule.granted,...rule.denied])].filter(id=>id!==owner).sort((a,b)=>participantName(a).localeCompare(participantName(b))||a.localeCompare(b));
    const accessState=id=>rule.denied.includes(id)?'deny':rule.granted.includes(id)?'grant':'default';
    const changeAccess=(decision,user)=>{
      if(!/^[1-9]\d{0,18}$/.test(user)||user===owner){notify('Enter a valid participant user ID other than the owner.',true);return;}
      if(accessState(user)===decision)return;
      const next={...access},current=next[chosen]||{granted:[],denied:[]};
      const granted=current.granted.filter(id=>id!==user),denied=current.denied.filter(id=>id!==user);
      if(decision==='grant')granted.push(user);if(decision==='deny')denied.push(user);
      if(granted.length||denied.length)next[chosen]={granted:granted.sort(),denied:denied.sort()};else delete next[chosen];
      const updated={...changes},value=JSON.stringify(next);
      let original=saved('TELEGRAM_GROUP_ACCESS')||'{}';try{original=JSON.stringify(JSON.parse(original));}catch{}
      if(value===original)delete updated.TELEGRAM_GROUP_ACCESS;else updated.TELEGRAM_GROUP_ACCESS=value;
      setChanges(updated);setReview(false);
    };
    const accessChoices=[['deny','Denied'],['grant','Allowed']];
    const setParticipantAccess=(allow,id)=>{const decision=switchDecision(savedRule,rule,id,allow);if(decision)changeAccess(decision,id);};
    const personRow=id=>h('li',{className:'n-access-person',key:id},
      h('div',{className:'n-access-person-name'},h('strong',null,participantName(id)),h('small',null,participantMeta(id))),
      h('div',{className:'n-access-choice','role':'group','aria-label':'Group access for '+participantLabel(id)},
        ...accessChoices.map(([state,label])=>h('button',{type:'button',key:state,disabled:busy,'aria-pressed':participantAllowed(rule,id)===(state==='grant'),onClick:()=>setParticipantAccess(state==='grant',id)},label))));
    const addManualRule=()=>{changeAccess(manualDecision,accessUser.trim());setAccessUser('');setManualDecision('deny');};
    const accessEditor=h('div',{className:'n-settings-access','aria-labelledby':'group-access-title'},
      h('h4',{id:'group-access-title'},'Who may address Nocheh in groups'),
      h('p',{className:'n-muted'},'Everyone except you is denied by default. Switch a person to Allowed to let them address Nocheh; Denied blocks them. Telegram supplies group administrators; other people appear after Nocheh observes them. Save and Apply for changes to take effect.'),
      !identityDirectory&&!identityError&&h('p',{role:'status'},'Looking up Telegram group names and visible people…'),
      identityError&&h('p',{role:'status'},'Observed Telegram names are unavailable. You can still enter numeric IDs.'),
      h('div',{className:'n-actions'},button(refreshingChats?'Refreshing…':'Refresh group names from Telegram',refreshChats,refreshingChats||busy)),
      chatRefresh&&h('ul',{className:'n-telegram-refresh','aria-label':'Telegram group information'},chatRefresh.length?chatRefresh.map(chat=>
        h('li',{key:chat.chat_id},h('code',null,chat.chat_id),' ',chat.state==='available'?h('span',{dir:'auto'},chatState(chat)):h('strong',null,chatState(chat)))):
        h('li',null,'No groups are selected.')),
      observed.some(group=>!groups.includes(group.id))&&h('div',{className:'n-field'},h('label',{htmlFor:'observed-group'},'Add an observed group'),
        h('select',{id:'observed-group',value:'',disabled:busy,onChange:e=>addObservedGroup(e.target.value)},h('option',{value:''},'Choose a group…'),
          ...observed.filter(group=>!groups.includes(group.id)).map(group=>h('option',{value:group.id,key:group.id},groupLabel(group.id))))),
      groups.length?h('div',{className:'n-form'},
        h('div',{className:'n-field'},h('label',{htmlFor:'access-group'},'Selected group'),h('select',{id:'access-group',value:chosen,disabled:busy,onChange:e=>setAccessGroup(e.target.value)},...groups.map(id=>h('option',{value:id,key:id},groupLabel(id))))),
        h('div',{className:'n-access-directory'},
          h('div',{className:'n-access-directory-head'},h('b',null,'Known people in this group'),h('small',null,participantIds.filter(id=>participantAllowed(rule,id)).length+' allowed · '+participantIds.filter(id=>!participantAllowed(rule,id)).length+' denied')),
          h('ul',{className:'n-access-people'},
            owner&&h('li',{className:'n-access-person n-access-owner',key:'owner'},h('div',{className:'n-access-person-name'},h('strong',null,participantName(owner)),h('small',null,participantMeta(owner))),h('span',{className:'n-access-owner-badge'},'Owner · always allowed')),
            ...participantIds.map(personRow)),
          !participantIds.length&&h('p',{className:'n-muted n-access-empty'},'No other people are known yet. You can add someone by ID below.')),
        h('details',{className:'n-access-manual'},h('summary',null,'Add someone by user ID'),
          h('div',{className:'n-access-manual-fields'},
            h('div',{className:'n-field'},h('label',{htmlFor:'access-user'},'Telegram user ID'),h('input',{id:'access-user',inputMode:'numeric',value:accessUser,disabled:busy,placeholder:'Numeric user ID',onChange:e=>setAccessUser(e.target.value)})),
            h('div',{className:'n-field'},h('label',{htmlFor:'manual-decision'},'Access'),h('select',{id:'manual-decision',value:manualDecision,disabled:busy,onChange:e=>setManualDecision(e.target.value)},h('option',{value:'deny'},'Denied'),h('option',{value:'grant'},'Allowed'))),
            button('Add person',addManualRule,busy||!/^[1-9]\d{0,18}$/.test(accessUser.trim())||accessUser.trim()===owner))),
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
      h('form',{onSubmit:e=>{e.preventDefault();setReview(true);}},
        group('Telegram access','Choose who can use the assistant and which groups it can participate in.',['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_BOT_TOKEN'],accessEditor),
        group('Model and privacy','These rules apply to outgoing model requests. Applying a model change also restarts Honcho. Hermes profile preferences are in the other settings section.',['NOCHEH_MODEL','NOCHEH_EMBEDDING_MODEL','NOCHEH_GUARD_MODE']),
        group('Speed','How much work runs at the same time. More is faster for several chats but uses more memory and more of your model subscription at once. Apply restarts Hermes and its launcher.',['NOCHEH_PARALLEL_RUNS','NOCHEH_PARALLEL_REPLIES']),
        h('details',{className:'n-advanced'},h('summary',null,'Advanced · destinations, connections and internal credentials'),h('div',{className:'n-form'},...data.fields.filter(f=>!['TELEGRAM_ENABLED','TELEGRAM_OWNER_ID','TELEGRAM_GROUP_IDS','TELEGRAM_GROUP_ACCESS','TELEGRAM_BOT_TOKEN','NOCHEH_MODEL','NOCHEH_EMBEDDING_MODEL','NOCHEH_GUARD_MODE','NOCHEH_PARALLEL_RUNS','NOCHEH_PARALLEL_REPLIES'].includes(f.key)).map(field))),
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
