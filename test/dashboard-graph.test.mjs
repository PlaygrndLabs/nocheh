import {test} from 'node:test';
import assert from 'node:assert/strict';
import {layoutGraph, neighborhood, isReference, nodeStyle} from '../integrations/hermes/dashboard/graph-layout.mjs';

const fixture = () => ({
  scope: 'fixture',
  nodes: [
    {id:'scope:fixture', kind:'scope', label:'Fixture scope'},
    {id:'author:a', kind:'author', label:'Author'},
    ...Array.from({length:20}, (_,i)=>({id:'message:'+i,kind:'message',label:'Original متن  '+i,event_id:'source:'+i})),
    {id:'file:a',kind:'attachment',label:'Voice',event_id:'source:0'},
    {id:'derived:a',kind:'derived',label:'Transcript',provenance:{source:'file:a'}},
    {id:'memory:a',kind:'memory',label:'A note with no verified citation'},
  ],
  edges: [
    ...Array.from({length:20},(_,i)=>({from:'scope:fixture',to:'message:'+i,kind:'contains'})),
    {from:'author:a',to:'message:0',kind:'authored'},
    {from:'message:0',to:'file:a',kind:'attachment'},
    {from:'file:a',to:'derived:a',kind:'derived_from'},
  ],
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
  assert.ok(graph.nodes.some(node=>node.id==='memory:a'),'uncited memory stays visible without invented links');
});

test('layout is repeatable across input ordering and occupies all three dimensions',()=>{
  const data=fixture(), first=layoutGraph(data);
  assert.deepEqual(first,layoutGraph({...data,nodes:[...data.nodes].reverse()}));
  for(const axis of ['x','y','z']) {
    const values=first.nodes.map(node=>node[axis]);
    assert.ok(Math.max(...values)-Math.min(...values)>40,axis+' has real depth');
  }
  const origin=first.nodes.find(node=>node.kind==='scope');
  assert.deepEqual([origin.x,origin.y,origin.z],[0,0,0]);
});

test('empty, single-node and missing-endpoint graphs stay renderable',()=>{
  assert.deepEqual(layoutGraph({nodes:[],edges:[]}),{nodes:[],edges:[]});
  const data={nodes:[{id:'scope',kind:'scope',label:'Empty archive'}],edges:[{from:'scope',to:'missing',kind:'explicit_citation'}]};
  const graph=layoutGraph(data);
  assert.equal(graph.nodes.length,1);assert.deepEqual(graph.edges,[]);
  assert.equal(data.edges.length,1,'export remains the unmodified API response');
});

test('highlighting follows only direct recorded connections in either direction',()=>{
  const data=fixture();
  assert.deepEqual([...neighborhood(data,'file:a')].sort(),['derived:a','file:a','message:0']);
  assert.deepEqual([...neighborhood(data,'memory:a')],['memory:a']);
  assert.equal(neighborhood(data,null).size,0);
  assert.ok(!neighborhood(data,'file:a').has('author:a'),'a second hop is not a direct connection');
});

test('citation and generated-content links remain visually distinct from observations',()=>{
  assert.ok(isReference({kind:'explicit_citation'}));assert.ok(isReference({kind:'derived_from'}));
  for(const kind of ['authored','contains','attachment','reply_to_source','same_source_revision']) assert.equal(isReference({kind}),false);
  assert.equal(nodeStyle('future-kind'),nodeStyle('message'),'unrecognized nodes can still be inspected');
});

test('a full bounded page including 400 artifacts retains every node with finite coordinates',()=>{
  const data=fixture();
  for(let i=0;i<400;i++) {
    data.nodes.push({id:'artifact:'+i,kind:i<200?'attachment':'derived',label:'Artifact '+i});
    data.edges.push({from:'message:'+i%20,to:'artifact:'+i,kind:i<200?'attachment':'derived_from'});
  }
  const graph=layoutGraph(data);
  assert.equal(graph.nodes.length,425);
  assert.ok(graph.nodes.every(node=>['x','y','z'].every(axis=>Number.isFinite(node[axis]))));
  assert.equal(graph.edges.length,data.edges.length);
});

// Exercise the actual graph component's asynchronous owner API behavior. The
// small hook driver keeps these tests independent of the native React bundle.
const {readFile} = await import('node:fs/promises');
const {runInNewContext} = await import('node:vm');
const pluginSource = (await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
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
  const window={__HERMES_PLUGIN_SDK__:{React,fetchJSON},__HERMES_PLUGINS__:{register(){}}};
  runInNewContext(pluginSource,{window,React,fetchJSON,authedFetch:fetchJSON,createRoot:()=>({render(){}}),document:{getElementById:()=>({})}});
  const Graph=window.__NOCHEH_PAGES__.graph.component;
  return {
    async flush(){for(let i=0;i<15;i++){await Promise.resolve();if(dirty){dirty=false;cursor=0;tree=Graph({notify(){}});while(effects.length)effects.shift()();}}return tree;},
    elements(){const result=[];const visit=node=>{if(node&&typeof node==='object'){result.push(node);node.children?.forEach(visit);}};visit(tree);return result;},
    unmount(){for(const slot of slots)slot?.cleanup?.();},
  };
}
const page = (scope, label) => ({scope,nodes:[{id:'event:'+scope,kind:'message',label,event_id:scope}],edges:[],bounds:{truncated:false},unresolved_replies:0,next:null});

test('scope changes ignore a late graph response and never show old source nodes',async()=>{
  const a=deferred(),b=deferred();
  const view=componentDriver(path=>path.includes('/scopes?')?Promise.resolve({scopes:[{scope:'a',events:1},{scope:'b',events:1}]}):path.includes('scope=a')?a.promise:b.promise);
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
