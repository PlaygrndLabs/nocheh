import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('dashboard navigation has one task-oriented destination per responsibility',async()=>{
  const [app,overview,entities,projects,integrations]=await Promise.all([
    readFile('web/app.tsx','utf8'),
    readFile('web/pages/overview.tsx','utf8'),
    readFile('web/pages/entities.tsx','utf8'),
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

  assert.match(app,/\['entities','People'/);
  assert.match(entities,/export function EntityMemory/);
  assert.doesNotMatch(entities,/<TabsTrigger value="project">Project memory/);
  assert.match(projects,/import \{EntityMemory\} from '\.\/entities'/);
  assert.match(projects,/<TabsTrigger value="memory">Project memory/);
  assert.match(projects,/<EntityMemory kind="project"\/>/);
});
