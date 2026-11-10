import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {inspectionQuery,inspectionPath,rewriteInspection,proxyInngestInspection} from '../src/workflows/inspection.js';
import {HttpError,json} from '../src/http.js';

test('Inngest inspection parses queries and denies mutation, subscription, hidden roots and ingress paths',()=>{
  assert.ok(inspectionQuery({query:'query History($id: String!) { run(runID:$id) { status } }',variables:{id:'01KTEST'},operationName:'History'}));
  assert.ok(inspectionQuery({query:'query { ...Read } fragment Read on Query { history: runs { totalCount } }'}));
  for(const query of ['mutation { cancelRun(runID:"x") {id} }','subscription { stream {id} }','query A { apps {id} } mutation B { cancelRun(runID:"x") {id} }','{ ...Hidden } fragment Hidden on Query { __schema {queryType{name}} }','{ evil: createDebugSession {id} }','{ ...Loop } fragment Loop on Query {...Loop}'])assert.throws(()=>inspectionQuery({query}));
  for(const query of ['{ }','{ runs { } }','{ ...Empty } fragment Empty on Query { }'])assert.throws(()=>inspectionQuery({query}),/invalid_inspection_query/);
  assert.throws(()=>inspectionQuery([{query:'{apps{id}}'}]));
  assert.throws(()=>inspectionQuery({query:'query A {apps{id}}',operationName:'B'}));
  assert.throws(()=>inspectionQuery({query:'{apps{id}}',extensions:{persistedQuery:'ignored'}}));
  for(const [path,method] of [['/e/key','POST'],['/invoke/test','POST'],['/v0/connect/start','POST'],['/v0/gql?query=x','GET'],['//outside.example','GET'],['/assets/../e/key','GET'],['/assets/%2e%2e/e/key','GET'],['/debugger/function','GET'],['/apps','DELETE']])assert.throws(()=>inspectionPath(path!,method!));
  assert.equal(inspectionPath('/run?runID=01KTEST','GET').kind,'page');
  const js=rewriteInspection('/assets/index-DP5xzaet.js','text/javascript',Buffer.from('const a="assets/foo.js"; e.update({basepath:``,serializationAdapters:t});fetch(it(`/dev`));(g,{href:c?``:r,to:c?void 0:i,onClick:a,preload:s});A={items:[{label:`Runs`,href:`/runs`,Icon:R},{label:`Sandboxes`,href:`/sandboxes`,Icon:z}]};(S,{group:A,collapsed:e,first:!0}),(S,{group:N,collapsed:e});var up=[{label:`Docs`,href:`https://docs.example`,external:!0},{label:`MCP`,href:`/mcp/setup`,external:!1},{label:`Changelog`,href:`https://changes.example`,external:!0}];function _y({header:e,tab:t,actions:n=[],minLines:r=0}){return null}_y.Wrapper=({children:e})=>e;export{_y as D,lb as g};')).toString();
  assert.match(js,/inngest\/assets/);assert.match(js,/basepath:`\/inngest`/);assert.match(js,/fetch\(it\(`\/inngest\/dev`\)\)/);
  assert.match(js,/to:c\?void 0:\(i\?\?r\),onClick:a,"aria-label":e,preload:s/);assert.ok(!js.includes('Sandboxes')&&!js.includes('/mcp/setup'));
  assert.match(js,/\{group:A,collapsed:e,first:!0\}\),\(S,\{group:\{items:\[\]\},collapsed:e\}\)/);
  assert.match(js,/^import\{o as __nochehJsx\}from"\.\/useSelector-C9d0AIS8\.js";/);assert.match(js,/export\{__NochehCode as D,lb as g\};$/);
  assert.throws(()=>rewriteInspection('/assets/index-DP5xzaet.js','text/javascript',Buffer.from('different upstream')),/inngest_ui_version_mismatch/);
  assert.throws(()=>rewriteInspection('/assets/index-BtL2Q5bp.js','text/javascript',Buffer.from('e.update({basepath:``,serializationAdapters:t})')),/inngest_ui_version_mismatch/);
  const client=rewriteInspection('/assets/baseApi-DCLi0VUa.js','text/javascript',Buffer.from('ss=new ns(`/v0/gql`),cs=vi({});export{ss as n};')).toString();
  assert.match(client,/new ns\(`\/inngest\/v0\/gql`,\{headers:/);
  const info=rewriteInspection('/assets/devApi-a-0vSebx.js','text/javascript',Buffer.from('o=t({endpoints:e=>({info:e.query({query(){return{url:`/dev`,method:`GET`}}})})});export{o as t};')).toString();
  assert.match(info,/url:`\/inngest\/dev`/);assert.throws(()=>rewriteInspection('/assets/devApi-a-0vSebx.js','text/javascript',Buffer.from('different upstream')),/inngest_ui_version_mismatch/);
  const viewer=rewriteInspection('/assets/NewCodeBlock-Iha9tDmY.js','text/javascript',Buffer.from('import{o as n}from"./useSelector-C9d0AIS8.js";var Lr=({header:e,tab:t,actions:n=[]})=>null,le=1;export{le as n,Lr as t};')).toString();
  assert.match(viewer,/export\{le as n,__NochehCode as t\};$/);assert.match(viewer,/^import\{o as __nochehJsx\}from"\.\/useSelector-C9d0AIS8\.js";/);
});

test('pinned Inngest UI history is readable through the inspection boundary; native mutations never reach it',{skip:process.env.NOCHEH_WORKFLOW_FIXTURE!=='1'},async()=>{
  const server=createServer((req,res)=>{void proxyInngestInspection(req,res,process.env.INNGEST_SIGNING_KEY!).catch(error=>json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'unavailable'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/v1/workflows/inspection`;
  try{
    const page=await fetch(base+'/runs');assert.equal(page.status,200);const html=await page.text();
    assert.match(html,/nocheh-inspection-banner/);assert.match(html,/\/inngest\/assets\/index-DP5xzaet.js/);
    assert.ok(!html.includes(process.env.INNGEST_SIGNING_KEY!));assert.match(page.headers.get('content-security-policy')!,/connect-src 'self'/);
    const script=await fetch(base+'/assets/index-DP5xzaet.js');assert.equal(script.status,200);const index=await script.text();assert.match(index,/basepath:`\/inngest`/);assert.match(index,/Execution data/);assert.match(index,/__NochehCode as D,/);
    const client=await fetch(base+'/assets/baseApi-DCLi0VUa.js');assert.equal(client.status,200);assert.match(await client.text(),/`\/inngest\/v0\/gql`,\{headers:/);
    const devApi=await fetch(base+'/assets/devApi-a-0vSebx.js');assert.equal(devApi.status,200);assert.match(await devApi.text(),/url:`\/inngest\/dev`/);
    const traceViewer=await fetch(base+'/assets/NewCodeBlock-Iha9tDmY.js');assert.equal(traceViewer.status,200);assert.match(await traceViewer.text(),/,__NochehCode as t\};$/);
    const fonts=await fetch(base+'/assets/fonts-DQTamI_N.css');assert.ok(!(await fonts.text()).includes('https:'));
    const read=await fetch(base+'/v0/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ apps { id name } }'})});
    assert.equal(read.status,200);assert.ok(Array.isArray((await read.json() as any).data.apps));
    for(const path of ['/v0/gql','/e/key','/invoke/test']){
      const denied=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'mutation { cancelRun(runID:"01KTEST") {id} }'})});assert.equal(denied.status,403);
    }
    assert.equal((await fetch(base+'/runs',{headers:{origin:'http://untrusted'}})).status,403);
    const info=await(await fetch(base+'/dev')).json();assert.deepEqual(info,{version:'1.51.0',isSingleNodeService:true,startOpts:{autodiscover:false},features:{}});
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
