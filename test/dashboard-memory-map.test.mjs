import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('memory map is a separate accessible owner surface with explicit authority semantics',async()=>{
  const [app,page,style]=await Promise.all([readFile('web/app.tsx','utf8'),readFile('web/pages/memory-map.tsx','utf8'),readFile('web/style.css','utf8')]);
  assert.match(app,/memoryMap:'?MemoryMap|memoryMap:MemoryMap/);assert.match(app,/Memory map/);
  assert.match(page,/relationship and access graph/);assert.match(page,/Complete list fallback/);assert.match(page,/Reject once/);
  assert.match(page,/One-time \(default\)/);assert.match(page,/Persistent until revoked/);assert.match(page,/This edge grants access/);
  assert.match(page,/How to read this map/);assert.match(page,/Organizes work; grants no access/);assert.match(page,/Description only; no access/);
  assert.match(page,/connections shown/);assert.match(page,/facts hidden/);assert.match(page,/Select any circle or connection/);assert.match(page,/aria-pressed=\{factsVisible\}/);
  assert.match(page,/role="button" tabIndex=\{0\}/);assert.match(style,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(style,/memory-map-edge\.access/);assert.match(style,/memory-map-edge\.suggestion/);
});
