import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// The development supervisor for Node services (tools/development/dev-node-run.mjs). Under `node --watch` an app that
// exited at start waited for a file change, so the source-watched stack stayed down until someone edited code.
const supervisor=()=>import(pathToFileURL(resolve('tools/development/dev-node-run.mjs')).href);
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function until(check:()=>Promise<boolean>,ms=5000) {
  for(const end=Date.now()+ms;Date.now()<end;await sleep(25))if(await check())return;
  assert.fail('condition not reached');
}
async function scratch(script:string) {
  const directory=await mkdtemp(join(tmpdir(),'dev-node-run-')),entry=join(directory,'entry.mjs'),runs=join(directory,'runs');
  await writeFile(entry,`import {appendFileSync} from 'node:fs';const runs=${JSON.stringify(runs)};appendFileSync(runs,process.pid+'\\n');${script}`);
  const lines=async()=>(await readFile(runs,'utf8').catch(()=>'')).split('\n').filter(Boolean);
  return {directory,entry,runs:lines,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('a process that exits on its own starts again, waiting longer each time', async () => {
  const {DevProcess}=await supervisor(),files=await scratch('process.exit(1);'),log:string[]=[];
  const service=new DevProcess([files.entry],{name:'app',log:(line:string)=>log.push(line),firstDelay:40,maxDelay:100});
  try {
    service.start();
    await until(async()=>log.length>=4);
  } finally {await service.stop();await files.cleanup();}
  assert.deepEqual(log.slice(0,4),['app exited (1); starting it again in 0.04 s.','app exited (1); starting it again in 0.08 s.',
    'app exited (1); starting it again in 0.1 s.','app exited (1); starting it again in 0.1 s.']);
});

test('a finished build stops the running process and starts the new one at once', async () => {
  const {DevProcess}=await supervisor(),log:string[]=[];
  const files=await scratch(`process.on('SIGTERM',()=>{appendFileSync(runs+'.terms','term\\n');process.exit(0);});setInterval(()=>{},1000);`);
  const terms=join(files.directory,'runs.terms');
  const service=new DevProcess([files.entry],{log:(line:string)=>log.push(line)});
  try {
    service.start();
    await until(async()=>(await files.runs()).length===1);
    await service.restart();
    await until(async()=>(await files.runs()).length===2);
    assert.equal(service.running,true);
  } finally {await service.stop();}
  const [first,second]=await files.runs();
  assert.notEqual(first,second);
  assert.equal((await readFile(terms,'utf8')).trim().split('\n').length,2,'each process got SIGTERM: on restart, then on stop');
  assert.deepEqual(log,[],'a stop the supervisor asked for is not a crash');
  await files.cleanup();
});

test('a restart kills a process that ignores SIGTERM, so a hung shutdown never holds back new code', async () => {
  const {DevProcess}=await supervisor(),log:string[]=[];
  // The first process ignores SIGTERM; later ones stop when asked.
  const files=await scratch(`import {existsSync,writeFileSync} from 'node:fs';const stubborn=!existsSync(runs+'.once');writeFileSync(runs+'.once','');
process.on('SIGTERM',()=>{if(!stubborn)process.exit(0);});setInterval(()=>{},1000);`);
  const service=new DevProcess([files.entry],{name:'app',log:(line:string)=>log.push(line),stopAfter:200});
  try {
    service.start();
    await until(async()=>(await files.runs()).length===1);
    await sleep(100); // the handler is installed
    const restarted=Date.now();
    await service.restart();
    assert.ok(Date.now()-restarted<3000);
    await until(async()=>(await files.runs()).length===2);
    assert.deepEqual(log,['app did not stop within 0.2 s; killing it.']);
  } finally {await service.stop();await files.cleanup();}
});

test('a stop waits for the process to finish its work, and a stopped service never starts again', async () => {
  const {DevProcess}=await supervisor(),log:string[]=[];
  // The process takes longer than a restart would allow to finish after SIGTERM.
  const files=await scratch(`process.on('SIGTERM',()=>setTimeout(()=>{appendFileSync(runs+'.finished','1');process.exit(0);},400));setInterval(()=>{},1000);`);
  const service=new DevProcess([files.entry],{name:'app',log:(line:string)=>log.push(line),stopAfter:100,firstDelay:20});
  try {
    service.start();
    await until(async()=>(await files.runs()).length===1);
    await sleep(100);
    await service.stop();
    assert.equal(await readFile(join(files.directory,'runs.finished'),'utf8'),'1','the process was not killed');
    assert.equal(service.running,false);
    service.start();
    await sleep(200);
    assert.equal((await files.runs()).length,1);
    assert.deepEqual(log,[]);
  } finally {await service.stop();await files.cleanup();}
});

test('the ready marker starts the service once per finished build', async () => {
  const {watchReady}=await supervisor(),directory=await mkdtemp(join(tmpdir(),'dev-ready-')),marker=join(directory,'.dev-ready');
  const seen:string[]=[];let stopped=false;
  const watching=watchReady(marker,async(value:string)=>{seen.push(value.trim());},()=>stopped);
  try {
    await sleep(300);
    assert.deepEqual(seen,[],'no build has finished yet');
    await writeFile(marker,'1\n');
    await until(async()=>seen.length===1);
    await sleep(900);
    assert.deepEqual(seen,['1'],'an unchanged marker is not a new build');
    await writeFile(marker,'2\n');
    await until(async()=>seen.length===2);
    assert.deepEqual(seen,['1','2']);
  } finally {stopped=true;await watching;await rm(directory,{recursive:true,force:true});}
});
