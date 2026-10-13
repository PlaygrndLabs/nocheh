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
  ['access', 'Chats & access'],
  ['memory', 'Memory'],
  ['archive', 'Archive'],
  ['projects', 'Projects'],
  ['system', 'System'],
  ['settings', 'Settings'],
];
/** Every page, and every tab of the pages whose tabs live in the address. */
const routes = [
  ...pages,
  ...['chats', 'requests', 'shared', 'rules', 'defaults'].map(view => ['access?view=' + view, 'Chats & access']),
  ['access?view=chats&chat=-10042', 'Chats & access'],
  ['access?view=chats&chat=-10042%2Ftopic%2F7', 'Chats & access'],
  ['access?view=chats&chat=42', 'Chats & access'],
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'advanced'].map(view => [
    'settings?view=' + view,
    'Settings',
  ]),
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
    ['spaces', 'Chats & access', 'Sharing rules', '#access?view=rules'],
    ['sharing', 'Chats & access', 'Sharing rules', '#access?view=rules'],
    ['learned', 'Memory', 'Learned', '#memory?view=learned'],
    ['entities', 'Memory', 'People & facts', '#memory?view=relations'],
    ['memoryMap', 'Memory', 'People & facts', '#memory?view=relations'],
    ['memoryMap?request=r1', 'Inbox', null, '#inbox?kind=memory_access&decision=r1'],
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

test('memory has one workspace, and people and facts open as a map', async () => {
  const {page, problems} = await open('memory');
  const tabs = page.getByRole('tablist', {name: 'Memory workspace'});
  for (const name of ['Notes & history', 'Learned', 'People & facts', 'Evidence graph', 'Long-term memory'])
    await tabs.getByRole('tab', {name}).waitFor();
  await tabs.getByRole('tab', {name: 'People & facts'}).click();
  await page.getByRole('heading', {name: 'People, projects & facts'}).first().waitFor();
  await page.getByRole('link', {name: 'Chats & access'}).first().waitFor();
  await page.getByRole('button', {name: 'Map'}).click();
  await page.getByRole('button', {name: 'Reset layout'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('chats & access manages a group, its people, shared facts and requests in one place', async () => {
  const {page, problems} = await open('access');
  const list = page.getByRole('region', {name: 'Chats'});
  await list.getByRole('link', {name: /^You/}).waitFor();
  await list.getByRole('link', {name: /Weekend notes.*Nocheh is off/}).waitFor();
  await list.getByRole('link', {name: /Aurora planning.*Nocheh is on/}).click();
  assert.equal(new URL(page.url()).hash, '#access?view=chats&chat=-10042');
  await page.getByText('Nocheh is on in this group').waitFor();
  await page.getByRole('heading', {name: 'Who can talk to Nocheh here'}).waitFor();
  await page.getByText('You · always allowed').waitFor();
  const mira = page.getByRole('group', {name: 'Who may talk to Nocheh: Mira Chen'});
  await mira.getByRole('button', {name: 'Allowed', exact: true}).click();
  await page.getByRole('status').filter({hasText: 'Saved, not applied yet.'}).waitFor();
  assert.equal(await mira.getByRole('button', {name: 'Allowed', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: 'Apply saved settings'}).click();
  await page.getByRole('status').filter({hasText: 'Saved, not applied yet.'}).waitFor({state: 'detached'});
  // A request to share with this group, a sharing rule into it and a standing permission.
  await page.getByRole('heading', {name: 'What Nocheh remembers here'}).waitFor();
  await page.getByRole('button', {name: 'Reject once'}).first().waitFor();
  await page.getByText('Trip notes from the topic').waitFor();
  await page.getByText('Nothing shared with this chat yet').waitFor();
  await page.getByRole('heading', {name: 'What Nocheh may do here'}).waitFor();
  await page.getByRole('button', {name: 'Revoke'}).click();
  await page.getByText('Nothing without asking.', {exact: false}).waitFor();
  // The topic follows its group and holds the shared fact.
  await list.getByRole('link', {name: /Iceland planning/}).click();
  await page.getByText('Topics follow their group.', {exact: false}).waitFor();
  await page.getByText('Mira prefers quiet aurora viewpoints.').first().waitFor();
  // A group Nocheh is not in can be turned on.
  await list.getByRole('link', {name: /Weekend notes/}).click();
  await page.getByText('Nocheh is off in this group').waitFor();
  await page.getByRole('group', {name: 'Nocheh in this group'}).getByRole('button', {name: 'On'}).click();
  await page.getByText('Nocheh is on in this group').waitFor();
  await list.getByRole('link', {name: /Weekend notes.*Nocheh is on/}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('chats & access holds requests, shared facts, sharing rules and topic memory', async () => {
  const {page, problems} = await open('access?view=requests');
  await page.getByRole('button', {name: 'Reject once'}).first().waitFor();
  await page.getByRole('tab', {name: 'Shared facts'}).click();
  await page.getByText('Mira prefers quiet aurora viewpoints.').first().waitFor();
  await page.getByRole('tab', {name: 'Sharing rules'}).click();
  await page.getByRole('button', {name: 'New sharing rule'}).waitFor();
  await page.getByRole('tab', {name: 'Defaults'}).click();
  const topicMemory = page.getByRole('group', {name: 'Topic memory'});
  assert.equal(await topicMemory.getByRole('button', {name: /Whole group/}).getAttribute('aria-pressed'), 'true');
  await topicMemory.getByRole('button', {name: /Each topic/}).click();
  await page.getByRole('status').filter({hasText: 'Saved, not applied yet.'}).waitFor();
  await page.getByRole('heading', {name: 'Suggestion and delivery settings'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('settings keeps every section reachable, with one save and apply bar', async () => {
  const {page, problems} = await open('settings');
  const tabs = page.getByRole('tablist', {name: 'Settings sections'});
  const sections = [
    ['Telegram', 'Telegram access', ['Names that address Nocheh', 'Group replies']],
    ['Models', 'Providers', ['Provider', 'Model']],
    ['Speed', 'Speed', ['Parallel agent runs', 'Chats answered at once', 'Guard checks at once']],
    ['Privacy', 'Privacy', ['Secret guarding']],
    ['Advanced', 'Advanced', []],
  ];
  for (const [tab, heading, fields] of sections) {
    await tabs.getByRole('tab', {name: tab, exact: true}).click();
    await page.getByRole('heading', {name: heading, exact: true}).first().waitFor();
    for (const label of fields) await page.getByLabel(label, {exact: true}).first().waitFor();
  }
  await tabs.getByRole('tab', {name: 'Assistant'}).click();
  await page.getByRole('heading', {name: 'Owner freedom'}).first().waitFor();
  await page.getByRole('heading', {name: 'Hermes profile preferences'}).first().waitFor();
  // An edit survives switching sections, and the bar saves it.
  await tabs.getByRole('tab', {name: 'Telegram', exact: true}).click();
  await page.getByRole('link', {name: 'Chats & access'}).first().waitFor();
  await page.getByLabel('Names that address Nocheh', {exact: true}).fill('Nocheh,Helper');
  await tabs.getByRole('tab', {name: 'Speed'}).click();
  await tabs.getByRole('tab', {name: 'Telegram •'}).waitFor();
  const bar = page.getByRole('region', {name: 'Save and apply settings'});
  await bar.getByText('1 unsaved change').waitFor();
  await bar.getByRole('button', {name: 'Review changes'}).click();
  await bar.getByText('Names that address Nocheh: Nocheh,Helper').waitFor();
  await bar.getByRole('button', {name: 'Save changes'}).click();
  await bar.getByRole('button', {name: 'Apply saved settings'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('models let the owner add a custom provider and give one part its own provider', async () => {
  const {page, problems} = await open('settings?view=models');
  await page.getByRole('heading', {name: 'Which provider each part uses'}).waitFor();
  await page.getByRole('button', {name: 'Add custom provider'}).click();
  await page.getByLabel('Name', {exact: true}).fill('my-gateway');
  await page.getByLabel('Address', {exact: true}).fill('https://gateway.example.test/v1');
  await page.locator('#key-custom-1').fill('synthetic-gateway-key');
  await page.locator('#memory-provider').selectOption('custom-1');
  await page.locator('#memory-model').fill('gpt-5.6-sol');
  const bar = page.getByRole('region', {name: 'Save and apply settings'});
  await bar.getByRole('button', {name: 'Review changes'}).click();
  await bar.getByText('Custom providers: my-gateway').waitFor();
  await bar.getByText('Custom provider API keys: Replace stored credential').waitFor();
  await bar.getByText('Memory provider: my-gateway').waitFor();
  assert.equal(await bar.getByText('synthetic-gateway-key').count(), 0);
  await bar.getByRole('button', {name: 'Save changes'}).click();
  await bar.getByRole('button', {name: 'Apply saved settings'}).waitFor();
  // A provider still used by a part cannot be removed.
  assert.equal(await page.getByRole('button', {name: 'Remove my-gateway'}).isDisabled(), true);
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
