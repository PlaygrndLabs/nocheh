// A node --test reporter for tools/development/check_all.py: one JSON line per failed test, with its file and full
// name ("outer > inner"), so a run can be compared with test/known-failures.json. A parent that failed only because
// a subtest failed is left out; the subtest is the failure.
import { relative } from 'node:path';

export default async function* failures(source) {
  const names = new Map();
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:fail' && type !== 'test:pass') continue;
    const file = data.file ? relative(process.cwd(), data.file) : '';
    const stack = names.get(file) ?? [];
    if (type === 'test:start') {
      stack.length = data.nesting;
      stack.push(data.name);
      names.set(file, stack);
      continue;
    }
    if (type === 'test:pass' || data.details?.error?.failureType === 'subtestsFailed') continue;
    const error = data.details?.error;
    const message = String(error?.cause?.message ?? error?.message ?? error ?? '').split('\n')[0].slice(0, 300);
    const test = [...stack.slice(0, data.nesting), data.name].join(' > ');
    yield JSON.stringify({ file, test, error: message }) + '\n';
  }
}
