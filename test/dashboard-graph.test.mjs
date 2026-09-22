import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {layoutGraph, neighborhood, isReference, nodeStyle} from '../integrations/hermes/dashboard/graph-layout.mjs';

const fixture = () => ({
  scope: 'fixture',
  nodes: [
    {id:'group:*', kind:'group', label:'All private knowledge'},
    {id:'user:a', kind:'user', label:'User'},
    ...Array.from({length:20}, (_,i)=>({id:'message:'+i,kind:'message',label:'Original متن  '+i,event_id:'source:'+i})),
    {id:'project:a',kind:'project',label:'Nocheh'},
  ],
  edges: [
    ...Array.from({length:20},(_,i)=>({from:'group:*',to:'message:'+i,kind:'contains'})),
    {from:'user:a',to:'message:0',kind:'authored'},
    {from:'project:a',to:'group:*',kind:'project_context'},
  ],
});

test('management adapter normalizes legacy context entities and removes dangling operational links',()=>{
  const legacy={nodes:[{id:'scope:*',kind:'scope',label:'All',chat_type:'private'},{id:'author:a',kind:'author',label:'A'},
    {id:'event:m',kind:'message',label:'M'},{id:'project:p',kind:'project',label:'P'},
    {id:'event:x',kind:'event',label:'Action'},{id:'derived:x',kind:'derived',label:'runtime_context'}],
    edges:[{from:'scope:*',to:'event:m',kind:'contains'},{from:'event:x',to:'derived:x',kind:'derived_from'}],bounds:{messages:20,derived:200,truncated:true}};
  const code='import json,sys;from scripts.graph import context_entities;print(json.dumps(context_entities(json.loads(sys.argv[1]))))';
  const data=JSON.parse(execFileSync('python3',['-c',code,JSON.stringify(legacy)],{encoding:'utf8'}));
  assert.deepEqual(data.nodes.map(node=>node.kind),['group','user','message','project']);
  assert.deepEqual(data.nodes.map(node=>node.id),['group:*','user:a','message:m','project:p']);
  assert.equal(data.nodes[0].chat_type,'private');
  assert.deepEqual(data.edges,[{from:'group:*',to:'message:m',kind:'contains'}]);
  assert.deepEqual(data.bounds,{users:1,projects:1,groups:1,messages:1,truncated:true});
});

test('3D layout preserves originals and edges without mutating the source graph',()=>{
  const data=fixture(), original=structuredClone(data), graph=layoutGraph(data);
  assert.deepEqual(data,original);
  assert.deepEqual(graph.edges,data.edges);
  for(const source of data.nodes) {
    const node=graph.nodes.find(node=>node.id===source.id);
    for(const key of Object.keys(source)) assert.deepEqual(node[key],source[key]);
    assert.ok(['x','y','z'].every(axis=>Number.isFinite(node[axis])));
  }
  assert.equal(graph.nodes.length,data.nodes.length);
  assert.ok(graph.nodes.some(node=>node.id==='project:a'),'project context stays visible');
});

test('layout is repeatable across input ordering and occupies all three dimensions',()=>{
  const data=fixture(), first=layoutGraph(data);
  assert.deepEqual(first,layoutGraph({...data,nodes:[...data.nodes].reverse()}));
  for(const axis of ['x','y','z']) {
    const values=first.nodes.map(node=>node[axis]);
    assert.ok(Math.max(...values)-Math.min(...values)>40,axis+' has real depth');
  }
  const origin=first.nodes.find(node=>node.id==='group:*');
  assert.deepEqual([origin.x,origin.y,origin.z],[0,0,0]);
});

test('empty, single-node and missing-endpoint graphs stay renderable',()=>{
  assert.deepEqual(layoutGraph({nodes:[],edges:[]}),{nodes:[],edges:[]});
  const data={nodes:[{id:'group',kind:'group',label:'Empty archive'}],edges:[{from:'group',to:'missing',kind:'explicit_citation'}]};
  const graph=layoutGraph(data);
  assert.equal(graph.nodes.length,1);assert.deepEqual(graph.edges,[]);
  assert.equal(data.edges.length,1,'export remains the unmodified API response');
});

test('highlighting follows only direct recorded connections in either direction',()=>{
  const data=fixture();
  assert.deepEqual([...neighborhood(data,'user:a')].sort(),['message:0','user:a']);
  assert.deepEqual([...neighborhood(data,'project:a')].sort(),['group:*','project:a']);
  assert.equal(neighborhood(data,null).size,0);
  assert.ok(!neighborhood(data,'project:a').has('message:0'),'a second hop is not a direct connection');
});

test('legacy reference links remain recognizable while context relationships stay solid',()=>{
  assert.ok(isReference({kind:'explicit_citation'}));assert.ok(isReference({kind:'derived_from'}));
  for(const kind of ['authored','contains','project_context','reply_to_source','same_source_revision']) assert.equal(isReference({kind}),false);
  assert.equal(nodeStyle('future-kind'),nodeStyle('message'),'unrecognized nodes can still be inspected');
});

test('a full bounded page including 400 messages retains every node with finite coordinates',()=>{
  const data=fixture();
  for(let i=0;i<400;i++) {
    data.nodes.push({id:'extra-message:'+i,kind:'message',label:'Message '+i});
    data.edges.push({from:'group:*',to:'extra-message:'+i,kind:'contains'});
  }
  const graph=layoutGraph(data);
  assert.equal(graph.nodes.length,423);
  assert.ok(graph.nodes.every(node=>['x','y','z'].every(axis=>Number.isFinite(node[axis]))));
  assert.equal(graph.edges.length,data.edges.length);
});

// Exercise the actual graph component's asynchronous owner API behavior. The
// small hook driver keeps these tests independent of the native React bundle.
const {readFile} = await import('node:fs/promises');
const {runInNewContext} = await import('node:vm');
const pluginSource = (await readFile(new URL('../web/pages/graph.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace('export function Graph', 'function Graph')+'\nwindow.__NOCHEH_PAGES__={graph:{component:Graph}};';
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function componentDriver(fetchJSON) {
  let cursor=0, dirty=true, tree;
  const slots=[], effects=[];
  const React={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{const next=typeof value==='function'?value(slots[i]):value;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
    useRef(initial){const i=cursor++;return slots[i]||=({current:initial});},
    useMemo(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>!Object.is(v,slots[i].deps[j])))slots[i]={deps,value:fn()};return slots[i].value;},
    useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>!Object.is(v,slots[i].deps[j]))){const old=slots[i];slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
  };
  const window={addEventListener(){},removeEventListener(){},__HERMES_PLUGIN_SDK__:{React,fetchJSON},__HERMES_PLUGINS__:{register(){}}};
  const useLoad=(path)=>{const [data,setData]=React.useState(null),[error,setError]=React.useState('');React.useEffect(()=>{let alive=true;fetchJSON('/api/nocheh'+path).then(v=>{if(alive)setData(v);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[path]);return [data,error];};
  runInNewContext(pluginSource,{window,React,AbortController,StatusBadge:()=>null,h:React.createElement,useState:React.useState,useEffect:React.useEffect,useRef:React.useRef,useMemo:React.useMemo,useLoad,call:path=>fetchJSON('/api/nocheh'+path),errorText:e=>e.message,button:(label,onClick,disabled=false)=>React.createElement('button',{onClick,disabled},label),Panel:()=>null,Source:()=>null,Data:()=>null,document:{getElementById:()=>({})}});
  const Graph=window.__NOCHEH_PAGES__.graph.component;
  return {
    async flush(){for(let i=0;i<15;i++){await Promise.resolve();if(dirty){dirty=false;cursor=0;tree=Graph({notify(){}});while(effects.length)effects.shift()();}}return tree;},
    elements(){const result=[];const visit=node=>{if(node&&typeof node==='object'){result.push(node);node.children?.forEach(visit);}};visit(tree);return result;},
    unmount(){for(const slot of slots)slot?.cleanup?.();},
  };
}
const page = (scope, label) => ({scope,nodes:[{id:'message:'+scope,kind:'message',label,event_id:scope}],edges:[],bounds:{truncated:false},unresolved_replies:0,next:null});

test('scope changes ignore a late graph response and never show old source nodes',async()=>{
  const a=deferred(),b=deferred();
  const view=componentDriver(path=>path.includes('/scopes?')?Promise.resolve({scopes:[{scope:'a',events:1},{scope:'b',events:1}]}):path.includes('scope=a')?a.promise:b.promise);
  await view.flush();
  view.elements().find(node=>node.type==='select'&&node.props.value==='*').props.onChange({target:{value:'a'}});
  await view.flush();
  view.elements().find(node=>node.type==='select'&&node.props.value==='a').props.onChange({target:{value:'b'}});
  await view.flush();a.resolve(page('a','Old scope'));await view.flush();
  assert.ok(!view.elements().some(node=>node.props.title==='message: Old scope'));
  b.resolve(page('b','New scope'));await view.flush();
  assert.ok(view.elements().some(node=>node.props.title==='message: New scope'));
  view.unmount();
});

test('clearing selection discards a late source and a source failure offers retry',async()=>{
  const first=deferred(),second=deferred();let requests=0;
  const view=componentDriver(path=>path.includes('/scopes?')?Promise.resolve({scopes:[{scope:'a',events:1}]}):path.includes('/graph?')?Promise.resolve(page('a','Original')):(requests++===0?first.promise:second.promise));
  await view.flush();
  const choose=()=>view.elements().find(node=>node.props.title==='message: Original').props.onClick();
  choose();await view.flush();
  view.elements().find(node=>node.type==='button'&&node.children.includes('Clear')).props.onClick();
  first.resolve({id:'a',event:{text:'Late original'},artifacts:[],derived:[]});await view.flush();
  assert.ok(!view.elements().some(node=>node.props.record),'late original cannot reappear after clearing');
  choose();await view.flush();second.reject(new Error('Source unavailable'));await view.flush();
  assert.ok(view.elements().some(node=>node.props.role==='alert'&&node.children.includes('Source unavailable')));
  assert.ok(view.elements().some(node=>node.type==='button'&&node.children.includes('Retry source')));
  view.unmount();
});

test('graph request failure exposes a retry instead of an empty successful scene',async()=>{
  const view=componentDriver(path=>path.includes('/scopes?')?Promise.resolve({scopes:[{scope:'a',events:1}]}):Promise.reject(new Error('Archive offline')));
  await view.flush();
  assert.ok(view.elements().some(node=>node.props.role==='alert'&&node.children.includes('Archive offline')));
  assert.ok(view.elements().some(node=>node.type==='button'&&node.children.includes('Try again')));
  assert.ok(!view.elements().some(node=>node.props.data));
  view.unmount();
});


test('only users, projects, groups and messages reach the browser',async()=>{
  const original=page('a','Original');
  original.nodes.push({id:'derived:a',kind:'derived',label:'runtime_context'},{id:'event:a',kind:'event',label:'action'});
  original.edges.push({from:'event:a',to:'event:a',kind:'workflow'});
  const view=componentDriver(path=>Promise.resolve(path.includes('/scopes?')?{scopes:[{scope:'a',events:1}]}:original));
  await view.flush();
  assert.ok(view.elements().some(node=>node.type==='option'&&node.props.value==='message'&&node.children.includes('Message')));
  assert.ok(view.elements().some(node=>node.children.includes('Page 1 · 1 messages · 0 reply references outside this page')));
  assert.ok(!view.elements().some(node=>node.props.title==='derived: runtime_context'||node.props.title==='event: action'));
  assert.ok(!view.elements().some(node=>node.children.some(child=>typeof child==='string'&&child.startsWith('No messages'))));
  view.unmount();
});

test('private conversations are named as private chats across browser, search, filter and inspector',async()=>{
  const original=page('a','Original');
  original.nodes.unshift({id:'group:123',kind:'group',chat_type:'private',label:'Private chat · 123'});
  const view=componentDriver(path=>Promise.resolve(path.includes('/scopes?')?{scopes:[{scope:'a',events:1}]}:original));
  await view.flush();
  assert.ok(view.elements().some(node=>node.props.title==='private chat: Private chat · 123'));
  assert.ok(view.elements().some(node=>node.type==='option'&&node.props.value==='group'&&node.children.includes('Private chats')));
  assert.ok(view.elements().some(node=>node.children.includes('Private chat')),'the node browser and legend expose the semantic subtype');
  const search=view.elements().find(node=>node.props.id==='n-node-search');search.props.onChange({target:{value:'private chat'}});await view.flush();
  assert.ok(view.elements().some(node=>node.children.includes('1 of 2 nodes')),'the semantic subtype is searchable');
  view.elements().find(node=>node.props.title==='private chat: Private chat · 123').props.onClick();await view.flush();
  assert.ok(view.elements().some(node=>node.type==='h3'&&node.children.includes('Private chat')),'the inspector keeps the subtype');
  view.unmount();
});
