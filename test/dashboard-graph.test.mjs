import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {layoutGraph, neighborhood, isReference, nodeStyle} from '../services/hermes/dashboard/graph-layout.mjs';

const fixture = () => ({
  scope: 'fixture',
  nodes: [
    {id:'collection:*', kind:'collection', label:'All private knowledge'},
    {id:'user:a', kind:'user', label:'User'},
    ...Array.from({length:20}, (_,i)=>({id:'message:'+i,kind:'message',label:'Original متن  '+i,event_id:'source:'+i})),
    {id:'project:a',kind:'project',label:'Nocheh'},
  ],
  edges: [
    ...Array.from({length:20},(_,i)=>({from:'collection:*',to:'message:'+i,kind:'contains'})),
    {from:'user:a',to:'message:0',kind:'authored'},
    {from:'project:a',to:'collection:*',kind:'project_context'},
  ],
});

test('management adapter normalizes legacy context entities and removes dangling operational links',()=>{
  const legacy={nodes:[{id:'scope:*',kind:'scope',label:'All',chat_type:'private'},{id:'author:a',kind:'author',label:'A'},
    {id:'event:m',kind:'message',label:'M'},{id:'project:p',kind:'project',label:'P'},
    {id:'event:x',kind:'event',label:'Action'},{id:'derived:x',kind:'derived',label:'runtime_context'}],
    edges:[{from:'scope:*',to:'event:m',kind:'contains'},{from:'event:x',to:'derived:x',kind:'derived_from'}],bounds:{messages:20,derived:200,truncated:true}};
  const code='import json,sys;from tools.operations.archive.graph import context_entities;print(json.dumps(context_entities(json.loads(sys.argv[1]))))';
  const data=JSON.parse(execFileSync('python3',['-c',code,JSON.stringify(legacy)],{encoding:'utf8'}));
  assert.deepEqual(data.nodes.map(node=>node.kind),['collection','user','message','project']);
  assert.deepEqual(data.nodes.map(node=>node.id),['collection:*','user:a','message:m','project:p']);
  assert.equal(data.nodes[0].chat_type,undefined);
  assert.deepEqual(data.edges,[{from:'collection:*',to:'message:m',kind:'contains'}]);
  assert.deepEqual(data.bounds,{collections:1,users:1,projects:1,groups:0,messages:1,truncated:true});
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
  const origin=first.nodes.find(node=>node.id==='collection:*');
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
  assert.deepEqual([...neighborhood(data,'project:a')].sort(),['collection:*','project:a']);
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
    data.edges.push({from:'collection:*',to:'extra-message:'+i,kind:'contains'});
  }
  const graph=layoutGraph(data);
  assert.equal(graph.nodes.length,423);
  assert.ok(graph.nodes.every(node=>['x','y','z'].every(axis=>Number.isFinite(node[axis]))));
  assert.equal(graph.edges.length,data.edges.length);
});
