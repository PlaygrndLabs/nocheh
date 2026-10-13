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
  ['chats', 'Chats'],
  ['messages', 'Messages'],
  ['memory', 'Memory'],
  ['usage', 'Usage'],
  ['system', 'System'],
  ['settings', 'Settings'],
];
/** Every page, every tab, and an open chat. */
const routes = [
  ...pages,
  ...['allowed', 'history'].map(view => ['inbox?view=' + view, 'Inbox']),
  ['chats?view=rules', 'Chats'],
  ['chats?chat=-10042', 'Chats'],
  ['chats?chat=-10042%2Ftopic%2F7', 'Chats'],
  ['chats?chat=42', 'Chats'],
  ['messages?view=import', 'Messages'],
  ...['people', 'projects', 'notes', 'longterm'].map(view => ['memory?view=' + view, 'Memory']),
  ...['work', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'advanced'].map(view => [
    'settings?view=' + view,
    'Settings',
  ]),
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

test('every page and tab opens with its heading and without errors', async () => {
  for (const [route, title] of routes) {
    const {page, problems} = await open(route);
    assert.equal((await page.locator('main h1').first().textContent()).trim(), title, route);
    assert.deepEqual(problems, [], route);
    await page.close();
  }
});

test('navigation lists each page once, in order, links to the assistant console and collapses', async () => {
  const {page} = await open('home');
  const nav = page.getByRole('navigation', {name: 'Main'});
  assert.deepEqual(
    (await nav.getByRole('link').allTextContents()).map(text => text.trim().replace(/\d+$/, '')),
    pages.map(([, title]) => title),
  );
  assert.equal(await page.locator('a[href="/hermes/nocheh"]', {hasText: 'Assistant console'}).count(), 1);
  assert.equal(await page.locator('a[href^="/providers"]').count(), 0);
  await page.getByRole('button', {name: 'Collapse navigation'}).click();
  await page.getByRole('button', {name: 'Expand navigation'}).waitFor();
  // Collapsed, every page is still a named link.
  assert.equal(await nav.getByRole('link', {name: 'Settings'}).count(), 1);
  await page.getByRole('button', {name: 'Expand navigation'}).click();
  await page.close();
});

test('old bookmarks open the page and tab that now hold them', async () => {
  const cases = [
    ['overview', 'Home', null, '#home'],
    ['activity', 'Inbox', null, '#inbox'],
    ['access', 'Chats', null, '#chats'],
    ['sharing', 'Chats', 'Sharing', '#chats?view=rules'],
    ['archive', 'Messages', null, '#messages'],
    ['imports', 'Messages', 'Import', '#messages?view=import'],
    ['projects', 'Memory', 'Projects', '#memory?view=projects'],
    ['learned', 'Memory', 'Facts', '#memory?view=facts'],
    ['memoryMap', 'Memory', 'People', '#memory?view=people'],
    ['memoryMap?request=r1', 'Inbox', null, '#inbox?kind=memory_access&decision=r1'],
    ['honcho', 'Memory', 'Long-term memory', '#memory?view=longterm'],
    ['monitoring', 'System', 'Health', '#system'],
    ['databases', 'System', 'Databases', '#system?view=databases'],
    ['operations', 'System', 'Backups', '#system?view=backups'],
    ['system?view=usage', 'Usage', null, '#usage'],
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

test('home leads with what needs the owner', async () => {
  const {page, problems} = await open('home');
  const needs = page.getByRole('list', {name: 'What needs you'});
  await needs.getByRole('link').first().waitFor();
  await page.getByRole('heading', {name: 'Today'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a settings edit survives switching tabs and one bar saves and applies it', async () => {
  const {page, problems} = await open('settings?view=telegram');
  const tabs = page.getByRole('tablist', {name: 'Settings sections'});
  assert.equal(await page.getByRole('region', {name: 'Save changes'}).count(), 0);
  await page.locator('#telegram-names').fill('Nocheh,Helper');
  await tabs.getByRole('tab', {name: /Speed/}).click();
  await tabs.getByRole('tab', {name: /Telegram.*unsaved/}).waitFor();
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('1 unsaved change').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved.'}).waitFor();
  await bar.waitFor({state: 'detached'});
  await tabs.getByRole('tab', {name: /Telegram/}).click();
  assert.equal(await page.locator('#telegram-names').inputValue(), 'Nocheh,Helper');
  assert.deepEqual(problems, []);
  await page.close();
});

test('discard drops unsaved edits', async () => {
  const {page, problems} = await open('settings?view=telegram');
  const before = await page.locator('#telegram-names').inputValue();
  await page.locator('#telegram-names').fill('Something else');
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByRole('button', {name: 'Discard'}).click();
  await bar.waitFor({state: 'detached'});
  assert.equal(await page.locator('#telegram-names').inputValue(), before);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a custom provider is checked, added and saved from one dialog', async () => {
  const {page, problems} = await open('settings?view=models');
  await page.getByRole('button', {name: 'Add provider'}).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', {name: /Custom/}).click();
  await dialog.getByLabel('Name').fill('Example gateway');
  await dialog.getByLabel('Address').fill('https://gateway.example.test/v1');
  await dialog.getByLabel('API key').fill('synthetic-gateway-key');
  // Its models are listed from the address and key before it is added.
  await dialog
    .getByText(/\d+ models? found|Connected/)
    .first()
    .waitFor();
  await dialog.getByRole('button', {name: 'Add provider'}).click();
  await dialog.waitFor({state: 'detached'});
  await page.getByText('Example gateway').first().waitFor();
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.waitFor();
  assert.equal(await bar.getByText('synthetic-gateway-key').count(), 0);
  await bar.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved.'}).waitFor();
  await bar.waitFor({state: 'detached'});
  assert.equal(await page.getByText(/Nocheh login|CPA/).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('usage shows calls, tokens and cost, and never prices an unknown cost as free', async () => {
  const {page, problems} = await open('usage');
  await page.getByRole('table', {name: 'Usage by part'}).waitFor();
  await page
    .getByText(/At least \$|Unknown/)
    .first()
    .waitFor();
  await page.getByRole('radiogroup', {name: 'Period'}).getByText('Today').click();
  assert.equal(new URL(page.url()).hash, '#usage?days=1');
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
