import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('dashboard backup drains a partial upload, fences native/provider/content routes and retains progress access',async()=>{
  const state=await mkdtemp(join(tmpdir(),'nocheh-maintenance-http-')),token='synthetic-dashboard-key-'.repeat(3);
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;
  await new Promise<void>(done=>probe.close(()=>done()));
  await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),token);
  await mkdir(join(state,'provider/keys'),{recursive:true});await writeFile(join(state,'provider/keys/monitor-admin.key'),token);
  const adapter=join(state,'python-fixture');await writeFile(adapter,`#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
root=Path(os.environ['NOCHEH_STATE_DIR']);body=json.load(sys.stdin)
if body['operation']=='archive.connection': result={'host':'127.0.0.1','port':9,'token':'synthetic-token'}
elif body['operation']=='operations.run' and body['action']=='backup':
 (root/'coordinator').write_text(os.environ['NOCHEH_MAINTENANCE_COORDINATOR'])
 while not (root/'release').exists():time.sleep(.02)
 result={'status':'backed_up'}
else:raise RuntimeError('unexpected_child_operation')
print(json.dumps({'result':result}),flush=True)
`,{mode:0o700});
  const child=spawn(process.execPath,[resolve('dist/src/management.js')],{stdio:'ignore',env:{...process.env,NOCHEH_STATE_DIR:state,
    NOCHEH_DASHBOARD_PORT:String(port),NOCHEH_PYTHON:adapter}});
  const base='http://127.0.0.1:'+port,headers={'X-Nocheh-Session-Token':token,'Content-Type':'application/json'};
  const request=(path:string,body?:unknown)=>fetch(base+'/api/nocheh'+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  async function until(check:()=>Promise<boolean>){for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('maintenance fixture timeout');}
  try{
    await until(async()=>{try{return (await request('/health')).ok;}catch{return false;}});
    assert.equal((await fetch(base+'/api/nocheh/changes')).status,401);
    const liveRequest=httpRequest(base+'/api/nocheh/changes',{headers});liveRequest.end();
    const [liveResponse]=await once(liveRequest,'response');
    assert.equal(liveResponse.statusCode,200);
    assert.match(String(liveResponse.headers['content-type']),/text\/event-stream/);
    const liveEnded=once(liveResponse,'end');liveResponse.resume();
    const imported=await(await request('/jobs',{})).json() as any;
    const upload=httpRequest(base+'/api/nocheh/jobs/'+imported.id+'/upload?name=original.txt',{method:'PUT',headers});
    upload.write('partial original');const uploaded=once(upload,'response').then(async([res])=>{res.resume();await once(res,'end');return res.statusCode;});
    // Confirm the earlier upload is admitted before requesting maintenance.
    await until(async()=>{try{return (await import('node:fs/promises')).readdir(join(state,'admin/jobs',imported.id,'upload')).then(paths=>paths.some(p=>p.endsWith('.part')));}catch{return false;}});
    const backup=request('/operations',{action:'backup'});let returned=false;void backup.then(()=>{returned=true;});
    await until(async()=>{const status=await(await request('/maintenance')).json() as any;return !!status.token;});
    await liveEnded; // A stream must not hold the backup drain open.
    assert.equal(returned,false);assert.equal((await(await request('/maintenance')).json() as any).ready,false);
    assert.equal((await request('/jobs',{})).status,503);
    upload.end(' complete');assert.equal(await uploaded,200);
    const response=await backup;assert.equal(response.status,202);const job=await response.json() as any;
    await until(async()=>{try{return !!await readFile(join(state,'coordinator'),'utf8');}catch{return false;}});
    const status=await(await request('/maintenance')).json() as any;
    assert.equal(status.ready,true);assert.equal(status.token,await readFile(join(state,'coordinator'),'utf8'));
    assert.equal(await readFile(join(state,'admin/jobs',imported.id,'upload/original.txt'),'utf8'),'partial original complete');
    for(const path of ['/hermes/api/config','/providers/v0/management/codex-auth-url','/api/nocheh/artifacts/'+'a'.repeat(64)+'/download'])
      assert.equal((await fetch(base+path,{headers})).status,503);
    assert.equal((await request('/sources/'+'a'.repeat(64)+'/reprocess',{})).status,503);
    assert.equal((await request('/jobs/'+job.id)).status,200);assert.equal((await request('/health')).status,200);
    await writeFile(join(state,'release'),'done');
    await until(async()=>!(await(await request('/maintenance')).json() as any).ready);
    assert.equal((await(await request('/jobs/'+job.id)).json() as any).state,'complete');
    assert.equal((await request('/jobs',{})).status,201);
  }finally{
    await writeFile(join(state,'release'),'done');child.kill('SIGTERM');await once(child,'exit');await rm(state,{recursive:true,force:true});
  }
});
