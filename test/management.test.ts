import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadName} from '../src/management.js';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';

test('upload paths cannot escape a job or use ambiguous directory components', () => {
  for (const path of ['/tmp/private','../private','export/../private','export\\private','a//b','a/./b','a\0b']) {
    assert.throws(() => uploadName(path), {code:'unsafe_upload_path'});
  }
  assert.equal(uploadName('Chat Export/photos/متن.jpg'), 'Chat Export/photos/متن.jpg');
});

test('owner HTTP: denied origins, durable upload/preview, cancelled import resumes with stable identities', {timeout:60000}, async () => {
  const state = await mkdtemp(join(tmpdir(), 'nocheh-management-'));
  const token = 'test-owner-token-'.repeat(4);
  const records = new Map<string, unknown>(); let uploads = 0, slow = false;
  const archive = createServer(async (req,res) => {
    let raw=''; for await(const chunk of req) raw+=chunk;
    const body=JSON.parse(raw || '{}');
    if(slow) await new Promise(r=>setTimeout(r,300));
    let result:unknown={};
    if(req.url==='/v1/import') {const duplicate=records.has(body.event.key);records.set(body.event.key,body);result={duplicate};}
    else if(req.url?.endsWith('/bytes')) uploads++;
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  });
  archive.listen(0,'127.0.0.1'); await once(archive,'listening');
  const archivePort=(archive.address() as {port:number}).port;
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=(probe.address() as {port:number}).port; await new Promise<void>(r=>probe.close(()=>r()));
  let child:ChildProcess|undefined;
  const base=`http://127.0.0.1:${port}/api/plugins/nocheh`;
  const headers={'X-Hermes-Session-Token':token,'Content-Type':'application/json'};
  const request=async(path:string,body?:unknown)=>{
    const response=await fetch(base+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const value=await response.json() as any; assert.ok(response.ok,JSON.stringify(value)); return value;
  };
  const wait=async(check:()=>Promise<boolean>)=>{for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw new Error('timed out');};
  const start=async()=>{
    child=spawn(process.execPath,[resolve('dist/src/management.js')],{env:{...process.env,NOCHEH_STATE_DIR:state,NOCHEH_DASHBOARD_PORT:String(port)},stdio:'ignore'});
    await wait(async()=>{try{return (await fetch(base+'/health',{headers})).ok;}catch{return false;}});
  };
  const stop=async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}};
  try {
    const setup=spawnSync('python3',['-c',"import sys; from pathlib import Path; from scripts.configuration import initialize,write_env,env_path; s=Path(sys.argv[1]); v=initialize(s); v['NOCHEH_PORT']=sys.argv[2]; write_env(env_path(s),v)",state,String(archivePort)],{cwd:resolve('.')});
    assert.equal(setup.status,0,setup.stderr.toString());
    await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),token);
    await start();
    assert.equal((await fetch(base+'/settings')).status,401);
    assert.equal((await fetch(base+'/settings',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(base+'/settings',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
    const health=await fetch(base+'/health',{headers});assert.match(health.headers.get('set-cookie')??'',/HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(base+'/settings',{headers:{Cookie:'nocheh_download='+token}})).status,401,'download cookies cannot administer settings');
    const settings=await request('/settings');assert.ok(!JSON.stringify(settings).includes('test-owner-token'));
    const job=await request('/jobs',{});
    const document={id:77,type:'private_group',name:'Synthetic export',messages:Array.from({length:12},(_,id)=>({id,type:'message',text:'Exact متن  '+id}))};
    const put=await fetch(base+'/jobs/'+job.id+'/upload?name=result.json',{method:'PUT',headers,body:JSON.stringify(document)});assert.equal(put.status,200);
    const bad=await fetch(base+'/jobs/'+job.id+'/upload?name=..%2Fescape',{method:'PUT',headers,body:'x'});assert.equal(bad.status,400);
    const preview=await request('/jobs/'+job.id+'/preview',{});assert.equal(preview.preview.messages,12);
    slow=true; await request('/jobs/'+job.id+'/start',{mapping:{}});
    await wait(async()=>records.size>0);
    assert.equal((await fetch(base+'/operations',{method:'POST',headers,body:JSON.stringify({action:'backup'})})).status,409);
    assert.equal((await fetch(base+'/operations',{method:'POST',headers,body:JSON.stringify({action:'shell'})})).status,400);
    await request('/jobs/'+job.id+'/cancel',{});
    await wait(async()=>JSON.parse(await readFile(join(state,'admin/jobs',job.id,'job.json'),'utf8')).state==='cancelled');
    await stop();slow=false;await start();
    await request('/jobs/'+job.id+'/start',{mapping:{}});
    await wait(async()=>(await request('/jobs/'+job.id)).state==='complete');
    const finished=await request('/jobs/'+job.id);
    assert.equal(finished.completed,12);assert.equal(finished.result.telegram_replies,0);
    assert.equal(records.size,13);assert.ok(uploads>=1);
    assert.ok(JSON.stringify([...records.values()]).includes('Exact متن  0'));
    assert.equal((await fetch(base+'/exports/'+job.id+'/download',{headers})).status,409);
    assert.equal((await fetch(base+'/exports/'+job.id+'/download',{headers:{Cookie:'nocheh_download='+token}})).status,409);
    assert.equal((await fetch(base+'/exports/'+job.id+'/download',{headers:{Cookie:'nocheh_download=wrong'}})).status,401);
    assert.equal((await fetch(base+'/exports/'+job.id+'/download',{headers:{Cookie:'nocheh_download='+token,Origin:'https://untrusted.example'}})).status,403);
    const invalid=await request('/operations',{action:'restore',options:{backup:'../escape',port:19543}});
    await wait(async()=>(await request('/jobs/'+invalid.id)).state==='failed');
    assert.equal((await request('/jobs/'+invalid.id)).error,'invalid_operation_id');
  } finally {await stop();await new Promise<void>(r=>archive.close(()=>r()));await rm(state,{recursive:true,force:true});}
});
