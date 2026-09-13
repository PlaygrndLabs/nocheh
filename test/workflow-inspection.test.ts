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
  assert.throws(()=>inspectionQuery([{query:'{apps{id}}'}]));
  assert.throws(()=>inspectionQuery({query:'query A {apps{id}}',operationName:'B'}));
  assert.throws(()=>inspectionQuery({query:'{apps{id}}',extensions:{persistedQuery:'ignored'}}));
  for(const [path,method] of [['/e/key','POST'],['/invoke/test','POST'],['/v0/connect/start','POST'],['/v0/gql?query=x','GET'],['//outside.example','GET'],['/assets/../e/key','GET'],['/assets/%2e%2e/e/key','GET'],['/debugger/function','GET'],['/apps','DELETE']])assert.throws(()=>inspectionPath(path!,method!));
  assert.equal(inspectionPath('/run?runID=01KTEST','GET').kind,'page');
  const js=rewriteInspection('/assets/index-CFHJRWXe.js','text/javascript',Buffer.from('const a="assets/foo.js"; e.update({basepath:``,serializationAdapters:t});new Dy(`/v0/gql`)')).toString();
  assert.match(js,/inngest\/assets/);assert.match(js,/basepath:`\/inngest`/);
  assert.throws(()=>rewriteInspection('/assets/index-CFHJRWXe.js','text/javascript',Buffer.from('different upstream')),/inngest_ui_version_mismatch/);
});

test('pinned Inngest UI history is readable through the inspection boundary; native mutations never reach it',{skip:process.env.NOCHEH_WORKFLOW_FIXTURE!=='1'},async()=>{
  const server=createServer((req,res)=>{void proxyInngestInspection(req,res,process.env.INNGEST_SIGNING_KEY!).catch(error=>json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'unavailable'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/v1/workflows/inspection`;
  try{
    const page=await fetch(base+'/runs');assert.equal(page.status,200);const html=await page.text();
    assert.match(html,/nocheh-inspection-banner/);assert.match(html,/\/inngest\/assets\/index-CFHJRWXe.js/);
    assert.ok(!html.includes(process.env.INNGEST_SIGNING_KEY!));assert.match(page.headers.get('content-security-policy')!,/connect-src 'self'/);
    const script=await fetch(base+'/assets/index-CFHJRWXe.js');assert.equal(script.status,200);assert.match(await script.text(),/basepath:`\/inngest`/);
    const viewer=await fetch(base+'/assets/CodeBlock-slQUre1D.js');assert.equal(viewer.status,200);assert.match(await viewer.text(),/Execution data/);
    const traceViewer=await fetch(base+'/assets/ErrorCard-B-YVbC3X.js');assert.equal(traceViewer.status,200);assert.match(await traceViewer.text(),/NochehCode as r,N as s,si as t/);
    const fonts=await fetch(base+'/assets/fonts-DQTamI_N.css');assert.ok(!(await fonts.text()).includes('https:'));
    const read=await fetch(base+'/v0/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ apps { id name } }'})});
    assert.equal(read.status,200);assert.ok(Array.isArray((await read.json() as any).data.apps));
    for(const path of ['/v0/gql','/e/key','/invoke/test']){
      const denied=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'mutation { cancelRun(runID:"01KTEST") {id} }'})});assert.equal(denied.status,403);
    }
    assert.equal((await fetch(base+'/runs',{headers:{origin:'http://untrusted'}})).status,403);
    const info=await(await fetch(base+'/dev')).json();assert.deepEqual(info,{version:'1.44.0',isSingleNodeService:true,startOpts:{autodiscover:false},features:{}});
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
