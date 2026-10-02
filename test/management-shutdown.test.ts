import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('dashboard shutdown closes partial HTTP connections but waits for an admitted owner write', {timeout:15000},async()=>{
  const state=await mkdtemp(join(tmpdir(),'nocheh-shutdown-')),token='synthetic-dashboard-shutdown-token'.repeat(2);
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;
  await new Promise<void>(done=>probe.close(()=>done()));
  await mkdir(join(state,'admin/dashboard'),{recursive:true});await writeFile(join(state,'admin/dashboard/token'),token);
  await mkdir(join(state,'provider/keys'),{recursive:true});await writeFile(join(state,'provider/keys/monitor-admin.key'),token);
  const adapter=join(state,'python-fixture');await writeFile(adapter,`#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
root=Path(os.environ['NOCHEH_STATE_DIR']);body=json.load(sys.stdin)
if body['operation']=='archive.connection':result={'host':'127.0.0.1','port':9,'token':'synthetic-token'}
elif body['operation']=='settings.save':
 (root/'write-started').write_text('admitted')
 while not (root/'release').exists():time.sleep(.02)
 (root/'write-completed').write_text('durable')
 result={'saved':True}
else:raise RuntimeError('unexpected_child_operation')
print(json.dumps({'result':result}),flush=True)
`,{mode:0o700});
  const child=spawn(process.execPath,[resolve('dist/src/management.js')],{stdio:'ignore',env:{...process.env,NOCHEH_STATE_DIR:state,NOCHEH_DASHBOARD_PORT:String(port),NOCHEH_PYTHON:adapter}});
  const exited=once(child,'exit'),base='http://127.0.0.1:'+port,headers={'X-Nocheh-Session-Token':token,'Content-Type':'application/json'};
  const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('shutdown fixture timeout');};
  let incomplete:ReturnType<typeof connect>|undefined,write:ReturnType<typeof request>|undefined;
  try {
    await until(async()=>{try{return (await fetch(base+'/api/nocheh/health',{headers})).ok;}catch{return false;}});
    incomplete=connect(port,'127.0.0.1');incomplete.on('error',()=>{});await once(incomplete,'connect');
    incomplete.write('GET /api/nocheh/health HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\n');
    write=request(base+'/api/nocheh/settings',{method:'POST',headers});write.on('response',res=>res.resume());write.on('error',()=>{});
    write.end(JSON.stringify({changes:{},revision:0}));
    await until(async()=>{try{return (await readFile(join(state,'write-started'),'utf8'))==='admitted';}catch{return false;}});
    child.kill('SIGTERM');
    await until(async()=>incomplete!.destroyed);
    assert.equal(child.exitCode,null,'closing HTTP must not terminate the admitted settings write');
    await writeFile(join(state,'release'),'finish');
    const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
    assert.equal(await readFile(join(state,'write-completed'),'utf8'),'durable');
  }finally{
    incomplete?.destroy();write?.destroy();await writeFile(join(state,'release'),'finish');
    if(child.exitCode===null){child.kill('SIGKILL');await exited;}
    await rm(state,{recursive:true,force:true});
  }
});
