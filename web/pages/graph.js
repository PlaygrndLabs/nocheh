import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {Source} from './source.js';
  const graphKinds = {user:'User',project:'Project',group:'Group',message:'Message'};
  const nodeKindLabel = node=>node.kind==='group'&&node.chat_type==='private'?'Private chat':graphKinds[node.kind]||node.kind;
  const kindFilterLabel = (kind,nodes)=>{
    if(kind!=='group')return graphKinds[kind]||kind;
    const conversations=nodes.filter(node=>node.kind==='group'),hasPrivate=conversations.some(node=>node.chat_type==='private'),hasGroup=conversations.some(node=>node.chat_type!=='private');
    return hasPrivate&&hasGroup?'Groups / private chats':hasPrivate?'Private chats':'Groups';
  };
  const graphLegend = nodes=>Object.keys(graphKinds).flatMap(kind=>{
    if(kind!=='group')return nodes.some(node=>node.kind===kind)?[{key:kind,kind,label:graphKinds[kind]}]:[];
    const entries=[];
    if(nodes.some(node=>node.kind==='group'&&node.chat_type==='private'))entries.push({key:'private-chat',kind:'group',label:'Private chat'});
    if(nodes.some(node=>node.kind==='group'&&node.chat_type!=='private'))entries.push({key:'group',kind:'group',label:'Group'});
    return entries;
  });
  const contextGraph = value=>{
    const nodes=(value?.nodes||[]).filter(node=>Object.hasOwn(graphKinds,node.kind)),ids=new Set(nodes.map(node=>node.id));
    return {...value,nodes,edges:(value?.edges||[]).filter(edge=>ids.has(edge.from)&&ids.has(edge.to))};
  };
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
export function Graph({notify}) {
    const selection=useRef(0), source=useRef(null),sourceRequest=useRef(null);
    const [scope,setScope]=useState('*'),[scopeAfter,setScopeAfter]=useState(''),[scopeList,setScopeList]=useState([]),[scopes,scopeError]=useLoad('/scopes?after='+encodeURIComponent(scopeAfter));
    const [after,setAfter]=useState(''),[history,setHistory]=useState([]),[data,setData]=useState(null),[selected,setSelected]=useState(null),[record,setRecord]=useState(null);
    const [busy,setBusy]=useState(false),[problem,setProblem]=useState(''),[retry,setRetry]=useState(0),[sourceBusy,setSourceBusy]=useState(false),[sourceError,setSourceError]=useState('');
    const [query,setQuery]=useState(''),[kind,setKind]=useState('');
    useEffect(()=>{if(scopes?.scopes){setScopeList(old=>[...new Map([...old,...scopes.scopes].map(s=>[s.scope,s])).values()]);if(!scope&&scopes.scopes.length)setScope(scopes.scopes[0].scope);}},[scopes]);
    useEffect(()=>{
      if(!scope)return;let alive=true;const controller=new AbortController();selection.current++;sourceRequest.current?.abort();setBusy(true);setProblem('');setData(null);setRecord(null);setSelected(null);setSourceError('');setSourceBusy(false);setQuery('');setKind('');
      call('/graph?scope='+encodeURIComponent(scope)+'&after='+encodeURIComponent(after),undefined,{signal:controller.signal}).then(value=>{if(alive)setData(contextGraph(value));}).catch(e=>{if(alive)setProblem(errorText(e));}).finally(()=>{if(alive)setBusy(false);});
      return()=>{alive=false;controller.abort();sourceRequest.current?.abort();selection.current++;};
    },[scope,after,retry]);
    useEffect(()=>{let alive=true,controller;
      const refresh=()=>{controller?.abort();controller=new AbortController();setBusy(true);call('/graph?scope='+encodeURIComponent(scope)+'&after='+encodeURIComponent(after),undefined,{signal:controller.signal}).then(value=>{if(alive){setData(contextGraph(value));setProblem('');}}).catch(e=>{if(alive&&e.name!=='AbortError')setProblem(errorText(e));}).finally(()=>{if(alive)setBusy(false);});};
      window.addEventListener('nocheh:refresh',refresh);return()=>{alive=false;controller?.abort();window.removeEventListener('nocheh:refresh',refresh);};
    },[scope,after]);
    const choose=async node=>{
      if(!node)return;sourceRequest.current?.abort();const controller=new AbortController();sourceRequest.current=controller;const request=++selection.current;setSelected(node);setRecord(null);setSourceError('');setSourceBusy(!!node.event_id);
      if(node.event_id)try{const value=await call('/events/'+encodeURIComponent(node.event_id),undefined,{signal:controller.signal});if(selection.current===request)setRecord(value);}catch(e){if(selection.current===request)setSourceError(errorText(e));}finally{if(selection.current===request)setSourceBusy(false);}
    };
    const byId=useMemo(()=>new Map((data?.nodes||[]).map(node=>[node.id,node])),[data]);
    const filtered=useMemo(()=>(data?.nodes||[]).filter(node=>(!kind||node.kind===kind)&&(!query.trim()||(node.label+' '+node.kind+' '+nodeKindLabel(node)+' '+node.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))),[data,kind,query]);
    const matchingIds=useMemo(()=>kind||query.trim()?new Set(filtered.map(node=>node.id)):null,[filtered,kind,query]);
    const connections=(data?.edges||[]).filter(edge=>edge.from===selected?.id||edge.to===selected?.id);
    return h('div',{className:'n-graph-page'},
      h('div',{className:'n-graph-intro'},h('div',null,h('h2',null,'Explore your context'),h('p',{className:'n-muted'},'Explore users, projects, groups, private chats, and messages in three dimensions. Actions and runtime events stay out of the graph.')),
        h('label',{className:'n-graph-scope'},'Archive scope',h('select',{value:scope,onChange:e=>{setScope(e.target.value);setAfter('');setHistory([]);}},h('option',{value:'*'},'All private knowledge'),...scopeList.map(s=>h('option',{key:s.scope,value:s.scope},s.scope+' · '+s.events+' events')))),
        scopes?.next&&button('Load more scopes',()=>setScopeAfter(scopes.next))),
      scopeError&&h('p',{role:'alert'},scopeError),!scopes&&!scopeError&&h('p',{role:'status'},'Loading archive scopes…'),
      scopes&&!scopeList.length&&h(Panel,{title:'Your evidence space starts here'},h('p',null,'Import a chat to explore its messages and connections.'),h('a',{href:'#imports'},'Open Imports & jobs')),
      busy&&h('div',{className:'n-graph-loading',role:'status'},'Loading source relationships…'),
      problem&&h(Panel,{title:'Graph unavailable'},h('p',{role:'alert'},problem),button('Try again',()=>setRetry(v=>v+1))),
      data&&h('div',null,
        h('div',{className:'n-graph-workspace'},h(GraphSpace,{data,selectedId:selected?.id,matchingIds,choose}),
          h('aside',{className:'n-graph-inspector','aria-label':'Graph inspector'},
            h('div',{className:'n-node-browser'},h('h3',null,'Node browser'),
              h('label',{htmlFor:'n-node-search'},'Find on this page'),h('input',{id:'n-node-search',type:'search',placeholder:'Search nodes…',value:query,onChange:e=>setQuery(e.target.value)}),
              h('label',{className:'n-sr-only',htmlFor:'n-node-kind'},'Node type'),h('select',{id:'n-node-kind',value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:''},'All types'),...Object.keys(graphKinds).filter(key=>data.nodes.some(n=>n.kind===key)).map(key=>h('option',{key,value:key},kindFilterLabel(key,data.nodes)))),
              h('small',{role:'status'},filtered.length+' of '+data.nodes.length+' nodes'),
              h('div',{className:'n-node-list'},...filtered.map(node=>h('button',{type:'button',key:node.id,className:'n-node-option','aria-pressed':selected?.id===node.id,onClick:()=>choose(node),title:nodeKindLabel(node).toLocaleLowerCase()+': '+node.label},h('span',{className:'n-kind-dot n-kind-'+node.kind,'aria-hidden':true}),h('span',null,h('small',null,nodeKindLabel(node)),h('span',{dir:'auto'},node.label))))),
              !filtered.length&&h('p',{className:'n-muted'},'No nodes match. Clear your search or choose another type.')),
            h('div',{className:'n-node-detail'},
              selected?h('div',null,h('div',{className:'n-selection-heading'},h('h3',null,nodeKindLabel(selected)),button('Clear',()=>{sourceRequest.current?.abort();selection.current++;setSelected(null);setRecord(null);setSourceError('');setSourceBusy(false);})),
                h('p',{className:'n-node-title',dir:'auto'},selected.label),selected.state&&h(StatusBadge,{state:selected.state}),
                selected.text&&h(Data,{value:selected.text}),selected.provenance&&h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:selected.provenance})),
                selected.unresolved_citations>0&&h('p',{className:'n-muted'},selected.unresolved_citations+' citations are outside this page or scope.'),
                sourceBusy&&h('p',{role:'status'},'Loading original source…'),sourceError&&h('div',null,h('p',{role:'alert'},sourceError),button('Retry source',()=>choose(selected))),
                record&&button('View original source',()=>source.current?.scrollIntoView({block:'start'}),false,'n-primary'),
                !selected.event_id&&h('p',{className:'n-muted'},'Follow a connection to a message to inspect its original source.'),
                h('details',{open:true},h('summary',null,connections.length+' direct connections'),...connections.map((edge,i)=>{
                  const target=byId.get(edge.from===selected.id?edge.to:edge.from);if(!target)return null;
                  return h('button',{type:'button',key:i,className:'n-connection',onClick:()=>choose(target)},h('small',null,(edge.from===selected.id?'Outgoing · ':'Incoming · ')+edge.kind.replaceAll('_',' ')),h('span',{dir:'auto'},target.label));
                }))) : h('div',null,h('h3',null,'Inspect a connection'),h('p',{className:'n-muted'},'Select a node in the space or the list. Its direct connections will light up here.'),h('p',{className:'n-muted'},'Positions help you navigate. Only the links represent recorded relationships.'))))),
        h('div',{className:'n-graph-legend','aria-label':'Node legend'},...graphLegend(data.nodes).map(entry=>h('span',{key:entry.key},h('i',{className:'n-kind-dot n-kind-'+entry.kind,'aria-hidden':true}),entry.label))),
        h('div',{className:'n-graph-pagination'},h('p',{className:'n-muted'},'Page '+(history.length+1)+' · '+data.nodes.filter(n=>n.kind==='message').length+' messages · '+data.unresolved_replies+' reply references outside this page'),
          h('div',{className:'n-space-actions'},button('Previous messages',()=>{setAfter(history.at(-1));setHistory(history.slice(0,-1));},!history.length),button('Next messages',()=>{setHistory([...history,after]);setAfter(data.next);},!data.next),button('Export graph JSON',()=>exportJSON(data,'nocheh-graph.json')))),
        data.bounds.truncated&&h('p',{role:'status'},'The context-entity limit was reached. Choose a narrower archive scope to inspect more.'),
        !data.nodes.some(n=>n.kind==='message')&&h('p',{className:'n-muted'},'No messages on this page. Choose another scope or return to the previous page.'),
        h('p',{className:'n-muted'},'Recorded context relationships only. Actions and events are excluded, and this view makes no model calls.'),
        record&&h('div',{ref:source,id:'n-graph-source'},h(Source,{record,notify}))));
  }
