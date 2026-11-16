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
const {readPages, servedList} = await import(
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
const groups = (from, to) =>
  Array.from({length: to - from + 1}, (_, i) => ({space_id: 'g' + String(from + i).padStart(3, '0'), kind: 'group'}));
const firstPage = (items, next_cursor, error = '') => ({
  data: {items, next_cursor},
  error,
  loading: false,
  receivedAt: 1,
});
const ids = list => list.items.map(group => group.space_id);

test('the pages after the first count only when read after its cursor, so a group that moved is never lost', () => {
  // g099 was the first page's last group; a new group n000 sorts first, so g099 is now on no page read so far.
  const moved = firstPage([{space_id: 'n000', kind: 'group'}, ...groups(0, 98)], 'g098');
  const old = {cursor: 'g099', items: groups(100, 150), complete: true, error: ''};
  const reading = servedList(moved, old);
  assert.deepEqual(ids(reading), ['n000', ...ids({items: groups(0, 98)})]);
  assert.equal(reading.complete, false);
  assert.equal(reading.loading, true);
  // The read after the new cursor failed: the list is short, says why, and is no longer loading.
  const failed = servedList(moved, {cursor: 'g098', items: [], complete: false, error: 'offline'});
  assert.deepEqual(failed, {items: moved.data.items, complete: false, loading: false, error: 'offline'});
  // Read after the new cursor, every group is there once.
  const read = servedList(moved, {cursor: 'g098', items: groups(99, 150), complete: true, error: ''});
  assert.equal(read.items.length, 152);
  assert.ok(ids(read).includes('g099'));
  assert.equal(read.complete, true);
});

test('a served list that fits one page is whole; one not read yet, or unreadable, is not', () => {
  assert.deepEqual(servedList(firstPage(groups(0, 3), null), null), {
    items: groups(0, 3),
    complete: true,
    loading: false,
    error: '',
  });
  const none = {data: null, error: '', loading: true, receivedAt: null};
  assert.deepEqual(servedList(none, null), {items: [], complete: false, loading: true, error: ''});
  assert.deepEqual(servedList({...none, loading: false, error: 'offline'}, null), {
    items: [],
    complete: false,
    loading: false,
    error: 'offline',
  });
  // Pages read after the first stop at their bound: the list is not whole.
  const cut = servedList(firstPage(groups(0, 99), 'g099'), {
    cursor: 'g099',
    items: groups(100, 199),
    complete: false,
    error: '',
  });
  assert.equal(cut.items.length, 200);
  assert.equal(cut.complete, false);
  assert.equal(cut.loading, false);
});
