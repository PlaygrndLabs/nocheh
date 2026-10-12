import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['dashboard/lib/routes.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {resolveRoute,pageIds}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('current page names open as they are',()=>{
 for(const page of pageIds)assert.deepEqual(resolveRoute('#'+page+'?view=x'),{page,hash:null});
});

test('old page names lead to the page and tab that now own them, keeping their details',()=>{
 assert.deepEqual(resolveRoute('#activity?kind=entity&decision=abc'),{page:'inbox',hash:'#inbox?kind=entity&decision=abc'});
 assert.deepEqual(resolveRoute('#memoryMap?request=r1'),{page:'memory',hash:'#memory?request=r1&view=relations'});
 assert.deepEqual(resolveRoute('#monitoring'),{page:'system',hash:'#system?view=health'});
 assert.deepEqual(resolveRoute('#operations'),{page:'system',hash:'#system?view=maintenance'});
 assert.deepEqual(resolveRoute('#imports'),{page:'archive',hash:'#archive?view=imports'});
 assert.deepEqual(resolveRoute('#graph'),{page:'memory',hash:'#memory?view=graph'});
 assert.deepEqual(resolveRoute('#overview'),{page:'home',hash:'#home'});
 assert.deepEqual(resolveRoute('#spaces'),{page:'sharing',hash:'#sharing'});
 assert.deepEqual(resolveRoute('#honcho?view=learned'),{page:'memory',hash:'#memory?view=learned'},'an explicit tab wins');
});

test('an empty or unknown address opens Home',()=>{
 assert.deepEqual(resolveRoute(''),{page:'home',hash:null});
 assert.deepEqual(resolveRoute('#nothing-here'),{page:'home',hash:'#home'});
});
