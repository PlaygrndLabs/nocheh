import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** A file of the repository's Python services: in the checkout the tests were built from (dist/test) or run from (test),
 *  or under any PYTHONPATH entry, where the stores image's runner mounts them. A missing file fails, naming where it looked. */
export function servicesFile(path:string):string {
  const tried=[...['../../','../'].map(up=>fileURLToPath(new URL(up+path,import.meta.url))),
    ...(process.env.PYTHONPATH??'').split(delimiter).filter(Boolean).map(entry=>join(entry,path))];
  const found=tried.find(place=>existsSync(place));
  assert.ok(found,`${path} not found; tried ${tried.join(', ')}`);
  return found;
}
