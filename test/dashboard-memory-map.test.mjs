import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('memory map is a separate accessible owner surface with explicit authority semantics',async()=>{
  const [app,page,style,layout]=await Promise.all([readFile('web/app.tsx','utf8'),readFile('web/pages/memory-map.tsx','utf8'),readFile('web/style.css','utf8'),readFile('web/lib/memory-map-layout.ts','utf8')]);
  assert.match(app,/memoryMap:'?MemoryMap|memoryMap:MemoryMap/);assert.match(app,/Memory map/);
  assert.match(page,/relationship and access graph/);assert.match(page,/Complete list fallback/);assert.match(page,/Reject once/);
  assert.match(page,/One-time \(default\)/);assert.match(page,/Persistent until revoked/);assert.match(page,/This connection grants access/);
  assert.match(page,/How to use this map/);assert.match(page,/Organizes work; grants no access/);assert.match(page,/Description only; no access/);
  assert.match(page,/connections shown/);assert.match(page,/facts hidden/);assert.match(page,/Drag cards to arrange them/);assert.match(page,/aria-pressed=\{factsVisible\}/);
  assert.match(page,/ReactFlow/);assert.match(page,/MiniMap/);assert.match(page,/Controls/);assert.match(page,/applyNodeChanges/);
  assert.match(page,/layoutMemoryMap/);assert.match(page,/ELK layered/);assert.match(layout,/elk\.algorithm':'layered/);assert.match(layout,/elk\.edgeRouting':'ORTHOGONAL/);
  assert.match(page,/deleteKeyCode=\{null\}/);assert.match(page,/Every change opens for review before it is saved/);
  assert.match(page,/Edit memory fact/);assert.match(page,/Edit person/);assert.match(page,/Edit project assignment/);assert.match(page,/Revoke this access/);
  assert.match(style,/@media\(prefers-reduced-motion:reduce\)/);assert.match(style,/memory-flow-edge\.access/);assert.match(style,/memory-flow-edge\.suggestion/);
});
