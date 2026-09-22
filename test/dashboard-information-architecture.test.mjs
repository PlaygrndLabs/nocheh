import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('dashboard navigation has one task-oriented destination per responsibility',async()=>{
  const [app,overview,memory,projects,integrations]=await Promise.all([
    readFile('web/app.tsx','utf8'),
    readFile('web/pages/overview.tsx','utf8'),
    readFile('web/pages/memory-workspace.tsx','utf8'),
    readFile('web/pages/projects.tsx','utf8'),
    readFile('web/pages/integrations.js','utf8'),
  ]);

  assert.doesNotMatch(app,/\['spaces','Memory access'/);
  assert.match(app,/key==='spaces'\)return 'sharing'/);
  assert.doesNotMatch(app,/href="\/hermes\/nocheh"/);
  assert.doesNotMatch(app,/href="\/providers\/management\.html"/);
  assert.match(integrations,/\/hermes\/nocheh/);
  assert.match(integrations,/\/providers\/management\.html/);

  assert.doesNotMatch(overview,/Analytics/);
  assert.match(overview,/href="#monitoring">Review status/);

  assert.doesNotMatch(app,/\['learned','Learned memory'/);
  assert.doesNotMatch(app,/\['entities','People'/);
  assert.doesNotMatch(app,/\['memoryMap','Memory map'/);
  assert.doesNotMatch(app,/\['honcho','Honcho memory'/);
  assert.match(app,/\['learned','entities','memoryMap','honcho'\]\.includes\(key\)\)return 'memory'/);
  assert.match(memory,/Notes & history/);
  assert.match(memory,/<TabsTrigger value="honcho"/);
  assert.match(memory,/<Honcho notify=\{notify\}\/>/);
  assert.match(memory,/<TabsTrigger value="relations"/);
  assert.match(memory,/<MemoryMap\/>/);
  assert.doesNotMatch(integrations,/Open Honcho memory/);
  assert.match(projects,/import \{EntityMemory\} from '\.\/entities'/);
  assert.match(projects,/<TabsTrigger value="memory">Project memory/);
  assert.match(projects,/<EntityMemory kind="project"\/>/);
});
