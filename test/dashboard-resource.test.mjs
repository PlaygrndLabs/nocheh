import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../web/lib/resource-store.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {createResourceStore}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const flush=()=>new Promise(resolve=>queueMicrotask(resolve));
test('route handoff retains one shared observation and does not abort its request',async()=>{
 let calls=0,resolveRequest,signal;
 const store=createResourceStore((path,options)=>{calls++;signal=options.signal;return new Promise(resolve=>{resolveRequest=resolve;});});
 const outgoing=store.get('/status'),unsubscribe=store.subscribe(outgoing,()=>{});
 const request=store.update(outgoing),incoming=store.get('/status');
 unsubscribe();const stop=store.subscribe(incoming,()=>{});
 await flush();assert.equal(store.get('/status'),incoming);assert.equal(signal.aborted,false);
 await store.update(incoming);assert.equal(calls,1,'overlapping consumers deduplicate requests');
 resolveRequest({events:42});await request;assert.equal(incoming.snapshot.data.events,42);
 stop();await flush();assert.notEqual(store.get('/status'),incoming);
});
test('failed refresh preserves the successful observation with an explicit stale error',async()=>{
 let fail=false;const store=createResourceStore(async()=>{if(fail)throw Error('offline');return {completed:7};});
 const entry=store.get('/metrics'),stop=store.subscribe(entry,()=>{});await store.update(entry);
 const observed=entry.snapshot.receivedAt;fail=true;await store.refresh();
 assert.deepEqual(entry.snapshot.data,{completed:7});assert.equal(entry.snapshot.receivedAt,observed);assert.equal(entry.snapshot.error,'offline');assert.equal(entry.snapshot.loading,false);stop();
});
test('obsolete requests are aborted and late results cannot enter a replacement subscription',async()=>{
 let resolveRequest,signal;const store=createResourceStore((path,options)=>{signal=options.signal;return new Promise(resolve=>{resolveRequest=resolve;});});
 const old=store.get('/source/a'),stop=store.subscribe(old,()=>{}),request=store.update(old);stop();await flush();
 assert.equal(signal.aborted,true);const next=store.get('/source/a');resolveRequest({private:'old'});await request;
 assert.equal(next.snapshot.data,null);assert.equal(old.snapshot.data,null);
});

test('live invalidation refreshes only visible selected resources and keeps their current path',async()=>{
 const calls=[],store=createResourceStore(async path=>{calls.push(path);return {path,version:calls.length};});
 const archive=store.get('/data?scope=one'),rows=store.get('/database-browser?action=rows&offset=50'),guard=store.get('/guards/events/source'),hidden=store.get('/monitoring');
 const stopArchive=store.subscribe(archive,()=>{}),stopRows=store.subscribe(rows,()=>{}),stopGuard=store.subscribe(guard,()=>{});
 await store.refreshPaths(['/data?scope=one','/database-browser?action=rows&offset=50','/data?scope=one',null,'/monitoring'],['/guards/events/source']);
 assert.deepEqual(calls,['/data?scope=one','/database-browser?action=rows&offset=50','/guards/events/source']);
 assert.equal(archive.snapshot.data.path,'/data?scope=one');assert.equal(rows.snapshot.data.path,'/database-browser?action=rows&offset=50');
 assert.equal(hidden.snapshot.data,null);stopArchive();stopRows();stopGuard();
});
