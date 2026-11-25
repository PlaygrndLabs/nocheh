import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const load = async entry => {
  const compiled = await build({entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node'});
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};
const {staticItems, rank, score} = await load('dashboard/lib/search.ts');
const {resolveRoute, pageIds} = await load('dashboard/lib/routes.ts');
const {pageTabs} = await load('dashboard/lib/page-tabs.ts');

test('the search lists every page and every tab once, each opening without a rewrite', () => {
  const items = staticItems();
  assert.equal(new Set(items.map(item => item.key)).size, items.length, 'no item twice');
  for (const page of pageIds)
    assert.ok(
      items.some(item => item.key === 'page:' + page),
      page,
    );
  for (const [page, tabs] of Object.entries(pageTabs))
    for (const tab of Object.keys(tabs)) {
      const found = items.find(
        item => item.href === (tab === Object.keys(tabs)[0] ? '#' + page : `#${page}?view=${tab}`),
      );
      assert.ok(found, `${page} › ${tab}`);
    }
  for (const item of items) assert.equal(resolveRoute(item.href).hash, null, item.href);
});

test('a setting opens its own tab and names where it is', () => {
  for (const item of staticItems().filter(each => each.group === 'Settings')) {
    assert.ok(item.target, item.title);
    assert.ok(item.detail, item.title);
    const {page} = resolveRoute(item.href);
    const view = new URLSearchParams(item.href.split('?')[1] ?? '').get('view');
    if (page === 'settings') {
      assert.ok(!view || view in pageTabs.settings, item.href);
      assert.equal(item.detail, 'Settings › ' + pageTabs.settings[view ?? 'telegram'], item.title);
    }
  }
});

test('typed words rank a title that starts with them first, and find words a title leaves out', () => {
  const items = [
    {title: 'Monthly spending limit', keywords: 'budget cost'},
    {title: 'Time limit per job'},
    {title: 'Limit'},
  ];
  assert.deepEqual(
    rank(items, 'limit').map(item => item.title),
    ['Limit', 'Monthly spending limit', 'Time limit per job'],
  );
  assert.deepEqual(
    rank(items, 'budget').map(item => item.title),
    ['Monthly spending limit'],
  );
  assert.deepEqual(
    rank(items, 'spend lim').map(item => item.title),
    ['Monthly spending limit'],
    'word starts, any order',
  );
  assert.equal(score({title: 'Quiet hours'}, 'QUIET'), 80, 'case does not matter');
  assert.equal(score({title: 'Café notes'}, 'cafe'), 80, 'accents do not matter');
  assert.equal(score({title: 'Quiet hours'}, 'loud'), 0);
  assert.equal(score({title: 'Quiet hours'}, '  '), 1, 'nothing typed matches everything');
});
