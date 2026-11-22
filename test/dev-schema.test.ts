import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {devBuild,schemaReady} from '../src/stores/dev-schema.js';

// In development the app waits for the store setup of its own build before it reads (dev-schema.ts): a reader that ran
// first met a table the setup had not made yet, or deadlocked with it.

test('the build marker names a development build; anything else is no build', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dev-schema-'));
  try {
    const marker=pathToFileURL(join(directory,'.dev-ready'));
    assert.equal(devBuild(marker),null,'no marker outside development');
    await writeFile(marker,'1700000000000\n');assert.equal(devBuild(marker),'1700000000000');
    await writeFile(marker,'not a build\n');assert.equal(devBuild(marker),null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('the app starts at once outside development and waits for its own build in it', async () => {
  const lines:string[]=[],log=(line:string)=>lines.push(line);
  const asked:string[]=[];
  assert.equal(await schemaReady({query:async(text:string)=>{asked.push(text);return {rows:[]};}},null,{log}),'none');
  assert.deepEqual(asked,[],'no build, no query');
  // No table first (setup has not reached this code), then an older build, then this one. It never reads a missing
  // table: the database logs that error even when the app catches it.
  const builds:(string|undefined)[]=[undefined,'1','2'],reads:string[]=[];
  const control={query:async(text:string)=>{
    if(text.includes('to_regclass')) {
      if(builds[0]!==undefined)return {rows:[{present:true}]};
      builds.shift();return {rows:[{present:false}]};
    }
    const build=builds.shift();
    if(build===undefined)throw Object.assign(Error('relation does not exist'),{code:'42P01'});
    reads.push(build);return {rows:[{build}]};
  }};
  assert.equal(await schemaReady(control,'2',{every:5,log}),'ready');
  assert.deepEqual(reads,['1','2']);
  assert.equal(JSON.parse(lines.at(-1)!).event,'development_schema_ready');
});

test('setup that never finishes holds the app back only until the deadline', async () => {
  const lines:string[]=[];
  const result=await schemaReady({query:async()=>({rows:[{build:'1'}]})},'2',{deadline:30,every:5,log:line=>lines.push(line)});
  assert.equal(result,'timeout');
  assert.equal(JSON.parse(lines.at(-1)!).event,'development_schema_wait_timeout');
});
