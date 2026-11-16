import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * The groups Nocheh is on in are read whole (ADR-0253): the import page and the name refresh follow every page of
 * /conversations?kind=group&state=active, not the first 100 chats of the whole directory.
 */
const compiled = await build({
  entryPoints: ['dashboard/lib/chat-directory.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {readPages} = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

const path = '/conversations?kind=group&state=active&limit=100';
/** A served list in pages of `size`, as the server pages it after filtering. */
const pager = (count, size) => {
  const groups = Array.from({length: count}, (_, i) => ({space_id: 'g' + String(i).padStart(3, '0'), kind: 'group'}));
  const asked = [];
  const get = async url => {
    asked.push(url);
    const after = decodeURIComponent(new URL(url, 'http://x').searchParams.get('after') ?? '');
    const remaining = groups.filter(group => group.space_id > after),
      items = remaining.slice(0, size);
    return {items, next_cursor: remaining.length > size ? items.at(-1).space_id : null};
  };
  return {groups, asked, get};
};

test('the pages after the first are read until the list ends', async () => {
  const {groups, asked, get} = pager(250, 100);
  const read = await readPages(get, path, 'g099', 20);
  assert.deepEqual(
    read.items.map(group => group.space_id),
    groups.slice(100).map(group => group.space_id),
  );
  assert.equal(read.complete, true);
  assert.deepEqual(asked, [path + '&after=g099', path + '&after=g199']);
});

test('reading stops after its last allowed page and says the list is not complete', async () => {
  const {asked, get} = pager(1000, 10);
  const read = await readPages(get, path, 'g009', 3);
  assert.equal(read.items.length, 30);
  assert.equal(read.complete, false);
  assert.equal(asked.length, 3);
});

test('a failed page fails the read, so no partial list passes as whole', async () => {
  await assert.rejects(
    readPages(
      async () => {
        throw Error('offline');
      },
      path,
      'g099',
      20,
    ),
    /offline/,
  );
});
