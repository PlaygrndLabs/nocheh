/**
 * Opens every dashboard page in a real browser against the synthetic preview
 * (test/dashboard-preview.ts) and checks what the owner actually sees.
 *
 * Needs `npm run build`, a disposable PostgreSQL reachable through the usual
 * PG* variables, and Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or the browser
 * Playwright manages). Run with `npm run test:dashboard-browser`.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

const port = Number(process.env.NOCHEH_DASHBOARD_PORT || 18900 + Math.floor(Math.random() * 500));
const origin = `http://127.0.0.1:${port}`;
const pages = [
  ['home', 'Home'],
  ['inbox', 'Inbox'],
  ['sharing', 'Sharing'],
  ['memory', 'Memory'],
  ['archive', 'Archive'],
  ['projects', 'Projects'],
  ['system', 'System'],
  ['settings', 'Settings'],
];
/** Every page, and every tab of the pages whose tabs live in the address. */
const routes = [
  ...pages,
  ...['working', 'learned', 'relations', 'graph', 'honcho'].map(view => ['memory?view=' + view, 'Memory']),
  ...['messages', 'imports'].map(view => ['archive?view=' + view, 'Archive']),
  ...['health', 'connections', 'databases', 'maintenance'].map(view => ['system?view=' + view, 'System']),
];

let server, browser;

function browserPath() {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/opt/pw-browsers/chromium'];
  return candidates.find(path => path && existsSync(path));
}

before(async () => {
  server = spawn(process.execPath, ['dist/test/dashboard-preview.js'], {
    env: {
      ...process.env,
      NOCHEH_WORKFLOW_FIXTURE: '1',
      NOCHEH_DASHBOARD_PORT: String(port),
      SERVICE_TOKEN: process.env.SERVICE_TOKEN || 'synthetic-browser-test-token-0123456789',
      TELEGRAM_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('preview did not start')), 60000);
    server.on('exit', code => reject(Error('preview exited with ' + code)));
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('preview ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  browser = await chromium.launch({executablePath: browserPath()});
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/** A page that records uncaught errors and React/console errors. */
async function open(hash, viewport = {width: 1440, height: 900}) {
  const page = await browser.newPage({viewport});
  const problems = [];
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  page.on('console', message => {
    // The fixture answers some capabilities with an error status on purpose.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text()))
      problems.push('console: ' + message.text());
  });
  await page.goto(origin + '/#' + hash);
  await page.locator('main h1').first().waitFor();
  await page.waitForLoadState('networkidle');
  return {page, problems};
}

test('every page opens with its heading and without errors', async () => {
  for (const [route, title] of routes) {
    const {page, problems} = await open(route);
    assert.equal((await page.locator('main h1').first().textContent()).trim(), title, route);
    assert.deepEqual(problems, [], route);
    await page.close();
  }
});

test('navigation lists each page once, in order, and links to Hermes and CPA', async () => {
  const {page} = await open('home');
  const nav = page.getByRole('navigation', {name: 'Main navigation'});
  assert.deepEqual(
    (await nav.getByRole('link').allTextContents()).map(text => text.trim()),
    pages.map(([, title]) => title),
  );
  assert.equal(await page.locator('a[href="/hermes/nocheh"][aria-label="Open Hermes dashboard"]').count(), 1);
  assert.equal(await page.locator('a[href="/providers/management.html"][aria-label="Open CPA dashboard"]').count(), 1);
  await page.close();
});

test('old bookmarks open the page and tab that now own them', async () => {
  const cases = [
    ['overview', 'Home', null, '#home'],
    ['activity', 'Inbox', 'Decisions', '#inbox'],
    ['spaces', 'Sharing', null, '#sharing'],
    ['learned', 'Memory', 'Learned', '#memory?view=learned'],
    ['entities', 'Memory', 'Relations & access', '#memory?view=relations'],
    ['memoryMap?request=r1', 'Memory', 'Relations & access', '#memory?request=r1&view=relations'],
    ['honcho', 'Memory', 'Long-term memory', '#memory?view=honcho'],
    ['graph', 'Memory', 'Evidence graph', '#memory?view=graph'],
    ['imports', 'Archive', 'Import chat history', '#archive?view=imports'],
    ['monitoring', 'System', 'Health', '#system?view=health'],
    ['integrations', 'System', 'Connections', '#system?view=connections'],
    ['databases', 'System', 'Databases', '#system?view=databases'],
    ['operations', 'System', 'Backups & maintenance', '#system?view=maintenance'],
  ];
  for (const [hash, title, tab, canonical] of cases) {
    const {page, problems} = await open(hash);
    assert.equal((await page.locator('main h1').first().textContent()).trim(), title, hash);
    if (tab) assert.equal((await page.getByRole('tab', {selected: true}).first().textContent()).trim(), tab, hash);
    assert.equal(new URL(page.url()).hash, canonical, hash);
    assert.deepEqual(problems, [], hash);
    await page.close();
  }
});

test('an old link clicked inside the dashboard opens the right tab', async () => {
  const {page, problems} = await open('memory?view=working');
  await page.evaluate(() => (location.hash = 'graph'));
  await page.getByRole('tab', {name: 'Evidence graph', selected: true}).waitFor();
  assert.equal(new URL(page.url()).hash, '#memory?view=graph');
  assert.deepEqual(problems, []);
  await page.close();
});

test('home leads with what needs the owner', async () => {
  const {page, problems} = await open('home');
  const needs = page.getByRole('region', {name: 'What needs you'});
  await needs.getByRole('link', {name: /Open inbox/}).waitFor();
  await needs.getByRole('link', {name: /Check system/}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('archive shows a filterable table and opens a message in a drawer', async () => {
  const {page, problems} = await open('archive');
  const table = page.getByRole('table', {name: 'Archive records'});
  for (const header of ['Message', 'Status', 'Received'])
    await table.locator('thead th', {hasText: header}).first().waitFor();
  for (const filter of ['Record type', 'Conversation', 'Reply and action status'])
    await page.getByRole('combobox', {name: filter, exact: true}).waitFor();
  await table
    .getByRole('button', {name: /^Open message/})
    .last()
    .click();
  const drawer = page.getByRole('dialog', {name: 'Message details'});
  await drawer.waitFor();
  await drawer.getByText('Permanent · read only').first().waitFor();
  await drawer.getByRole('button', {name: 'Retire this message'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('memory has one workspace with relationships and access review', async () => {
  const {page, problems} = await open('memory');
  const tabs = page.getByRole('tablist', {name: 'Memory workspace'});
  for (const name of ['Notes & history', 'Learned', 'Relations & access', 'Evidence graph', 'Long-term memory'])
    await tabs.getByRole('tab', {name}).waitFor();
  await tabs.getByRole('tab', {name: 'Relations & access'}).click();
  await page.getByRole('heading', {name: 'Relationships & memory access'}).waitFor();
  await page.getByRole('tab', {name: /Review requests/}).click();
  await page.getByRole('button', {name: 'Reject once'}).first().waitFor();
  await page.getByRole('tab', {name: 'Shared memory'}).click();
  await page.getByRole('tab', {name: 'Explore'}).click();
  await page.getByRole('button', {name: 'Map'}).click();
  await page.getByRole('button', {name: 'Reset layout'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('settings keeps every section reachable', async () => {
  const {page, problems} = await open('settings');
  for (const name of [
    'Telegram access',
    'Model and privacy',
    'Speed',
    'Who may address Nocheh in groups',
    'Telegram groups',
    'Owner freedom',
  ])
    await page.getByRole('heading', {name, exact: true}).first().waitFor();
  for (const label of [
    'Reasoning model',
    'Embedding model',
    'Parallel agent runs',
    'Chats answered at once',
    'Names that address Nocheh',
  ])
    await page.getByLabel(label, {exact: true}).first().waitFor();
  await page.getByRole('tab', {name: 'Hermes preferences'}).click();
  await page.getByRole('heading', {name: 'Hermes profile preferences'}).first().waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('pages fit a phone screen and the menu opens as a drawer', async () => {
  for (const [route] of routes) {
    const {page, problems} = await open(route, {width: 390, height: 844});
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `${route} scrolls sideways by ${overflow}px on a phone`);
    assert.deepEqual(problems, [], route);
    await page.close();
  }
  const {page} = await open('home', {width: 390, height: 844});
  await page.getByRole('button', {name: 'Open navigation'}).click();
  await page.getByRole('dialog').getByRole('link', {name: 'Settings'}).waitFor();
  await page.close();
});
