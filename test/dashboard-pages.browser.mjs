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
  ['tasks', 'Tasks'],
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
  ...['today', 'upcoming', 'board', 'done', 'dropped', 'archive', 'trash'].map(view => ['tasks?view=' + view, 'Tasks']),
  ['chats?view=rules', 'Chats'],
  ['chats?chat=-10042', 'Chats'],
  ['chats?chat=-10042%2Ftopic%2F7', 'Chats'],
  ['chats?chat=42', 'Chats'],
  ['messages?view=import', 'Messages'],
  ...['people', 'projects', 'notes', 'longterm'].map(view => ['memory?view=' + view, 'Memory']),
  ...['work', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'advanced'].map(view => [
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

test('the sidebar lists the open page’s tabs and opens any page’s tab directly', async () => {
  const {page, problems} = await open('settings?view=models');
  const nav = page.getByRole('navigation', {name: 'Main'});
  const settingsTabs = nav.getByRole('list', {name: 'Settings tabs'});
  assert.deepEqual(
    (await settingsTabs.getByRole('link').allTextContents()).map(text => text.trim()),
    ['Telegram', 'Models', 'Speed', 'Privacy & data', 'Assistant', 'Tasks', 'Advanced'],
  );
  assert.equal(await settingsTabs.getByRole('link', {name: 'Models'}).getAttribute('aria-current'), 'true');
  assert.equal(await nav.getByRole('list', {name: 'Memory tabs'}).count(), 0);
  await nav.getByRole('button', {name: 'Show Memory tabs'}).click();
  await nav.getByRole('list', {name: 'Memory tabs'}).getByRole('link', {name: 'Long-term memory'}).click();
  await page.getByRole('tab', {name: 'Long-term memory', selected: true}).waitFor();
  assert.match(page.url(), /#memory\?view=longterm$/);
  await page.getByRole('button', {name: 'Collapse navigation'}).click();
  assert.equal(await nav.getByRole('list').count(), 0);
  await page.getByRole('button', {name: 'Expand navigation'}).click();
  await page.evaluate(() => localStorage.removeItem('nocheh.sidebar-groups.v1'));
  assert.deepEqual(problems, []);
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

test('a settings edit survives switching tabs and Save at the top of the page saves and applies it', async () => {
  const {page, problems} = await open('settings?view=telegram');
  const tabs = page.getByRole('tablist', {name: 'Settings sections'});
  // Save is always in the same place on Settings, turned off until there is something to save.
  const save = page.getByRole('region', {name: 'Save changes'}).getByRole('button', {name: 'Save'});
  assert.equal(await save.isDisabled(), true);
  const headerBefore = await page.locator('main header').boundingBox();
  await page.locator('#telegram-names').fill('Nocheh,Helper');
  await tabs.getByRole('tab', {name: /Speed/}).click();
  await tabs.getByRole('tab', {name: /Telegram.*unsaved/}).waitFor();
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('1 unsaved change').waitFor();
  assert.equal(await save.isEnabled(), true);
  assert.deepEqual(await page.locator('main header').boundingBox(), headerBefore, 'the header does not move');
  // Save stays at the top of the screen, never in a card at the bottom, even after scrolling down.
  await page.locator('main').evaluate(main => main.scrollTo(0, main.scrollHeight));
  assert.ok((await bar.boundingBox()).y < 120, 'Save sits at the top of the screen');
  await bar.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved and applied.'}).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await bar.getByRole('button', {name: 'Save'}).isDisabled(), true);
  await tabs.getByRole('tab', {name: /Telegram/}).click();
  assert.equal(await page.locator('#telegram-names').inputValue(), 'Nocheh,Helper');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a group’s role and skills are edited on its chat page and saved from the top of the page', async () => {
  const {page, problems} = await open('chats?chat=-10042');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Role and skills'})});
  await card.getByRole('textbox', {name: 'Role'}).fill('You help this group plan stargazing trips.');
  await card.getByRole('button', {name: 'Add skill'}).click();
  await card.getByRole('textbox', {name: 'Name'}).fill('Kp Forecast');
  await card.getByRole('textbox', {name: 'When to use it'}).fill('When someone asks about tonight’s aurora.');
  await card.getByRole('textbox', {name: 'Instructions'}).fill('Give the Kp index and the best viewing hour.');
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('2 unsaved changes').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  // A name Hermes cannot use is explained in place and nothing is saved.
  await card.getByText('Name it with lower-case English letters').waitFor();
  await card.getByRole('textbox', {name: 'Name'}).fill('kp-forecast');
  await bar.getByRole('button', {name: 'Try again'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  await card.getByRole('textbox', {name: 'Name'}).waitFor();
  assert.equal(await card.getByRole('textbox', {name: 'Name'}).inputValue(), 'kp-forecast');
  assert.equal(
    await card.getByRole('textbox', {name: 'Role'}).inputValue(),
    'You help this group plan stargazing trips.',
  );
  const {page: topic} = await open('chats?chat=-10042%2Ftopic%2F7');
  await topic.getByText('This topic uses its group’s role and skills.').waitFor();
  assert.equal(await topic.getByRole('heading', {name: 'Role and skills'}).count(), 0);
  await topic.close();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a built-in instruction is replaced, checked and reset to the built-in text', async () => {
  const {page, problems} = await open('settings?view=assistant');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Built-in instructions'})});
  const bar = page.getByRole('region', {name: 'Save changes'});
  await card.getByText('Groups', {exact: true}).click();
  await card.getByRole('textbox', {name: 'Groups'}).fill('Reply in Persian and stay quiet with [NO_REPLY] otherwise.');
  await card.getByText('Learning from conversations').click();
  await card.getByRole('textbox', {name: 'Learning from conversations'}).fill('Learn only decisions.');
  await bar.getByText('2 unsaved changes').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  // The values Nocheh fills in cannot be dropped by mistake.
  await card.getByText('Keep {trigger_id} and {citable_ids} in the text').waitFor();
  await card
    .getByRole('textbox', {name: 'Learning from conversations'})
    .fill('Learn only decisions from {trigger_id} citing {citable_ids}.');
  await bar.getByRole('button', {name: 'Try again'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  await card.getByText('Changed').first().waitFor();
  assert.equal(await card.getByText('Changed', {exact: true}).count(), 2);
  await card.getByText('Groups', {exact: true}).click();
  const groups = card.getByRole('listitem').filter({has: page.getByRole('textbox', {name: 'Groups'})});
  await groups.getByRole('button', {name: 'Reset to built-in'}).click();
  assert.equal(
    await card.getByRole('textbox', {name: 'Groups'}).inputValue(),
    'This is a shared space. For routine chatter return exactly [NO_REPLY].',
  );
  await groups.getByText('Reset when saved').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await card.getByText('Changed', {exact: true}).count(), 1);
  assert.deepEqual(problems, []);
  await page.close();
});

test('long-term memory is re-run or replaced only after the owner sees what it would send', async () => {
  const {page, problems} = await open('memory?view=longterm');
  const card = page.locator('section').filter({has: page.getByRole('heading', {name: 'Re-run or replace'})});
  await card.getByText('3 learning tasks failed.').waitFor();
  await card.getByRole('button', {name: 'Retry failed learning'}).click();
  await page.getByRole('status').filter({hasText: 'Running 3 learning tasks again.'}).waitFor();
  await card.getByText('Nothing has failed.').waitFor();
  assert.equal(await card.getByRole('button', {name: 'Retry failed learning'}).isDisabled(), true);

  await card.getByText('180 saved messages from 5 conversations will be sent again.').waitFor();
  await card.getByRole('radio', {name: 'Chosen chats'}).click();
  assert.equal(await card.getByRole('button', {name: 'Re-learn'}).isDisabled(), true, 'a chat must be chosen first');
  await card.getByRole('searchbox', {name: 'Chats to re-learn'}).fill('-10042');
  await card.getByRole('listbox', {name: 'Chats to re-learn'}).getByRole('option').first().click();
  await card.getByText('12 saved messages from 1 conversation will be sent again.').waitFor();
  await card.getByRole('button', {name: 'Re-learn'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(/learns again from 12 saved messages/).waitFor();
  await dialog.getByRole('button', {name: 'Re-learn'}).click();
  await page.getByRole('status').filter({hasText: 'Re-learning 12 saved messages.'}).waitFor();

  await card.getByText('Up to 212 saved messages you allowed it to learn will be sent again.').waitFor();
  const replace = card.getByRole('button', {name: 'Replace long-term memory'});
  assert.equal(await replace.isDisabled(), true, 'replacing waits for the typed confirmation');
  await card.getByLabel('Type “replace” to confirm').fill('replace');
  await replace.click();
  await page.getByRole('status').filter({hasText: 'It is learning your saved messages again.'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('discard drops unsaved edits', async () => {
  const {page, problems} = await open('settings?view=telegram');
  const before = await page.locator('#telegram-names').inputValue();
  await page.locator('#telegram-names').fill('Something else');
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByRole('button', {name: 'Discard'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await bar.getByRole('button', {name: 'Save'}).isDisabled(), true);
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
  await page.getByRole('status').filter({hasText: 'Saved and applied.'}).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await bar.getByRole('button', {name: 'Save'}).isDisabled(), true);
  assert.equal(await page.getByText(/Nocheh login|CPA/).count(), 0);
  // Every model is picked from a dropdown of the provider's models, and any other name can still be typed.
  const mainModel = page.locator('#main-model');
  await mainModel.locator('option', {hasText: 'gpt-5.6-sol'}).waitFor({state: 'attached'});
  assert.equal(await mainModel.evaluate(element => element.tagName), 'SELECT');
  assert.equal(await page.locator('#reply-model').evaluate(element => element.tagName), 'SELECT');
  await mainModel.selectOption({label: 'Type another name…'});
  assert.equal(await page.locator('#main-model').evaluate(element => element.tagName), 'INPUT');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a task is added, edited, finished and reopened from the Tasks page', async () => {
  const {page, problems} = await open('tasks');
  const title = 'Renew the passport ' + Date.now();
  await page.getByLabel('New task').fill(title);
  await page.locator('#task-due').fill('2030-01-04');
  await page.getByRole('button', {name: 'Add'}).click();
  const row = page.getByRole('listitem').filter({hasText: title});
  await row.getByText(/Due /).waitFor();
  await row.getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog');
  // Save and Discard sit at the top, and stay off until something changes.
  await dialog.getByRole('button', {name: 'Save'}).waitFor();
  assert.equal(await dialog.getByRole('button', {name: 'Save'}).isDisabled(), true);
  await dialog.locator('#task-panel-notes').fill('Bring **two** photos');
  await dialog.locator('#task-panel-priority').selectOption({label: 'High'});
  await dialog.locator('#task-panel-due').fill('');
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  // Notes read as Markdown in the preview.
  await dialog.getByRole('radiogroup', {name: 'Notes view'}).getByRole('radio', {name: 'Preview'}).click();
  await dialog.locator('strong', {hasText: 'two'}).waitFor();
  // A subtask and a comment, both kept in the history.
  await dialog.getByLabel('New subtask').fill('Find the old passport');
  await dialog.getByLabel('New subtask').press('Enter');
  await dialog.getByRole('list', {name: 'Subtasks'}).getByText('Find the old passport').waitFor();
  await dialog.getByLabel('New comment').fill('Office opens at nine');
  await dialog.getByRole('button', {name: 'Comment'}).click();
  await dialog.getByRole('list', {name: 'Comments'}).getByText('Office opens at nine').waitFor();
  await dialog
    .getByRole('list', {name: 'History'})
    .getByText(/Priority/)
    .waitFor();
  await dialog.getByRole('button', {name: 'Close'}).click();
  await dialog.waitFor({state: 'detached'});
  await row.getByText('Bring two photos').waitFor();
  await row.getByText('High').waitFor();
  await row.getByText('0/1').waitFor();
  assert.equal(await row.getByText(/Due /).count(), 0, 'clearing the due date removes it');
  await row.getByRole('checkbox', {name: `Mark “${title}” done`}).click();
  await page.getByRole('status').filter({hasText: 'Task done.'}).waitFor();
  await row.waitFor({state: 'detached'});
  await page.getByRole('tab', {name: /Done/}).click();
  const done = page.getByRole('listitem').filter({hasText: title});
  await done.getByRole('checkbox', {name: `Reopen “${title}”`}).click();
  await done.waitFor({state: 'detached'});
  await page.getByRole('tab', {name: /^Open/}).click();
  await page.getByRole('listitem').filter({hasText: title}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('today, upcoming and the board show tasks by date and status', async () => {
  const {page, problems} = await open('tasks?view=today');
  await page.getByRole('listitem').filter({hasText: 'Pay the rent'}).waitFor();
  await page.getByText('Book a dentist checkup').waitFor({state: 'detached'});
  await page.getByRole('tab', {name: /Upcoming/}).click();
  await page.getByText('Book the Iceland flights').waitFor();
  await page.getByRole('tab', {name: /Board/}).click();
  const board = page.getByLabel('Board');
  await board.getByRole('list', {name: 'In progress tasks'}).getByText('Draft the launch announcement').waitFor();
  await board.getByRole('list', {name: 'Waiting tasks'}).getByText('Check the booking page works').waitFor();
  await board.getByLabel('Status of “Book a dentist checkup”').selectOption({label: 'In progress'});
  await page.getByRole('status').filter({hasText: 'Moved to In progress.'}).waitFor();
  await board.getByRole('list', {name: 'In progress tasks'}).getByText('Book a dentist checkup').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('task statuses, priorities and columns are edited in Settings', async () => {
  const {page, problems} = await open('settings?view=tasks');
  const statuses = page.getByRole('list', {name: 'Statuses'});
  await statuses.getByLabel('Status name 3').fill('On hold');
  await page.getByLabel('Priority name Level 4').fill('Now');
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.goto(origin + '/#tasks?view=board');
  await page.getByLabel('Board').getByRole('list', {name: 'On hold tasks'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('personal tasks and each project keep separate lists, with tags, a group and people on a task', async () => {
  const {page, problems} = await open('tasks');
  const lists = page.getByRole('radiogroup', {name: 'List'});
  await lists.getByRole('radio', {name: /Garden redesign/}).click();
  await page.getByText('Send the garden supplier the measurements').waitFor();
  // A project list shows only its own tasks.
  await page.getByText('Book a dentist checkup').waitFor({state: 'detached'});
  const title = 'Order the planters ' + Date.now();
  await page.getByLabel('New task').fill(title);
  await page.locator('#task-tags').fill('Suppliers');
  await page.locator('#task-tags').press('Enter');
  await page.locator('#task-tags').fill('Urgent');
  await page.getByRole('button', {name: 'Add'}).click();
  const added = page.getByRole('listitem').filter({hasText: title});
  await added.getByText('Urgent').waitFor();
  // A task points to a group and to people from its edit dialog.
  await added.getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option', {name: /Aurora planning\s*Group/}).click();
  await dialog.locator('#task-panel-people').selectOption({label: 'Devon'});
  await dialog.getByRole('button', {name: 'Remove tag Urgent'}).click();
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  await dialog.getByRole('button', {name: 'Close'}).click();
  await dialog.waitFor({state: 'detached'});
  await added.getByText('Aurora planning').waitFor();
  await added.getByText('Devon').waitFor();
  await added.getByText('Urgent').waitFor({state: 'detached'});
  await lists.getByRole('radio', {name: /Personal/}).click();
  await page.getByText('Book a dentist checkup').waitFor();
  // A project task stays out of the personal list.
  await page.getByText(title).waitFor({state: 'detached'});
  await lists.getByRole('radio', {name: 'All', exact: true}).click();
  await page.getByRole('radiogroup', {name: 'Tag'}).getByRole('radio', {name: 'Health'}).click();
  await page.getByText('Book a dentist checkup').waitFor();
  // A tag narrows the list.
  await page.getByText('Send the garden supplier the measurements').waitFor({state: 'detached'});
  // Cards show the same tasks, and the choice is remembered.
  await page.getByRole('radiogroup', {name: 'Show tasks as'}).getByRole('radio', {name: 'Cards'}).click();
  await page.getByRole('list', {name: 'Tasks'}).getByText('Book a dentist checkup').waitFor();
  await page.reload();
  await page
    .getByRole('radiogroup', {name: 'Show tasks as'})
    .getByRole('radio', {name: 'Cards', checked: true})
    .waitFor();
  await page.evaluate(() => localStorage.removeItem('nocheh.tasks-layout'));
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
