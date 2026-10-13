import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['dashboard/lib/routes.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {resolveRoute,pageIds,href}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('current page names open as they are',()=>{
 for(const page of pageIds)assert.deepEqual(resolveRoute('#'+page+'?view=x'),{page,hash:null});
});

test('links Nocheh already sent keep working, with their details',()=>{
 assert.deepEqual(resolveRoute('#inbox?kind=memory_access&decision=abc'),{page:'inbox',hash:null});
 assert.deepEqual(resolveRoute('#inbox?action=abc'),{page:'inbox',hash:null});
 assert.deepEqual(resolveRoute('#activity?kind=entity&decision=abc'),{page:'inbox',hash:'#inbox?kind=entity&decision=abc'});
 assert.deepEqual(resolveRoute('#memoryMap?request=r1'),{page:'inbox',hash:'#inbox?kind=memory_access&decision=r1'},'a sent request link opens that request');
 assert.deepEqual(resolveRoute('#memory?view=learned&project=p1&entry=e1'),{page:'memory',hash:'#memory?view=facts&project=p1&entry=e1'});
 assert.deepEqual(resolveRoute('#memory?view=relations'),{page:'memory',hash:'#memory?view=people'});
});

test('old page names lead to the page and tab that now own them',()=>{
 assert.deepEqual(resolveRoute('#access?view=chats&chat=-10042'),{page:'chats',hash:'#chats?chat=-10042'});
 assert.deepEqual(resolveRoute('#access?view=rules'),{page:'chats',hash:'#chats?view=rules'});
 assert.deepEqual(resolveRoute('#sharing'),{page:'chats',hash:'#chats?view=rules'});
 assert.deepEqual(resolveRoute('#archive?source=abc'),{page:'messages',hash:'#messages?source=abc'});
 assert.deepEqual(resolveRoute('#imports'),{page:'messages',hash:'#messages?view=import'});
 assert.deepEqual(resolveRoute('#projects?project=p1'),{page:'memory',hash:'#memory?project=p1&view=projects'});
 assert.deepEqual(resolveRoute('#honcho'),{page:'memory',hash:'#memory?view=longterm'});
 assert.deepEqual(resolveRoute('#graph'),{page:'memory',hash:'#memory?view=people'});
 assert.deepEqual(resolveRoute('#monitoring'),{page:'system',hash:'#system'});
 assert.deepEqual(resolveRoute('#system?view=health'),{page:'system',hash:'#system'});
 assert.deepEqual(resolveRoute('#operations'),{page:'system',hash:'#system?view=backups'});
 assert.deepEqual(resolveRoute('#overview'),{page:'home',hash:'#home'});
 assert.deepEqual(resolveRoute('#system?view=usage'),{page:'usage',hash:'#usage'},'the old usage tab opens the Usage page');
 assert.deepEqual(resolveRoute('#honcho?view=learned'),{page:'memory',hash:'#memory?view=facts'},'an explicit tab wins');
});

test('an empty or unknown address opens Home',()=>{
 assert.deepEqual(resolveRoute(''),{page:'home',hash:null});
 assert.deepEqual(resolveRoute('#nothing-here'),{page:'home',hash:'#home'});
});

test('links skip empty details',()=>{
 assert.equal(href('settings',{view:'models',x:null}),'#settings?view=models');
 assert.equal(href('home'),'#home');
});
