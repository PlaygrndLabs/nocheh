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
import {existsSync, rmSync, writeFileSync} from 'node:fs';
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
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'connections', 'advanced'].map(view => [
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
    ['Telegram', 'Models', 'Speed', 'Privacy & data', 'Assistant', 'Tasks', 'Connections', 'Advanced'],
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

test('an unclear action waits for the owner’s word, and an unclear page read closes itself', async () => {
  const unclear = '6'.repeat(64),
    read = '5'.repeat(64);
  const {page, problems} = await open('inbox');
  const posts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/tools/resolve')) posts.push(request.postDataJSON());
  });
  // Waiting lists the unclear command, but not the page read that closed itself.
  await page.getByText('printf synthetic-unclear').waitFor();
  assert.equal(await page.getByText('https://example.org/aurora-weather').count(), 0);
  await page.goto(origin + '/#inbox?kind=controlled_action&decision=' + unclear);
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Nocheh isn’t sure whether this ran').waitFor();
  assert.equal(await dialog.getByText(/connection dropped/).count(), 0);
  for (const name of ['It ran', 'It didn’t run', 'Dismiss'])
    assert.equal(await dialog.getByRole('button', {name}).isEnabled(), true, name);
  await dialog.getByRole('button', {name: 'It didn’t run'}).click();
  await dialog.waitFor({state: 'detached'});
  const sent = posts.at(-1);
  assert.equal(typeof sent.operation_id, 'string');
  assert.deepEqual(
    {...sent, operation_id: undefined},
    {id: unclear, fingerprint: '6a'.repeat(32), outcome: 'not_run', expected_revision: 4, operation_id: undefined},
  );
  await page.getByText('printf synthetic-unclear').waitFor({state: 'detached'});
  // History says how each one closed; a closed one offers no buttons.
  await page.goto(origin + '/#inbox?view=history');
  await page.getByText('You marked it didn’t run').waitFor();
  await page.getByText('Closed, no answer').waitFor();
  await page.goto(origin + '/#inbox?view=history&action=' + read);
  await dialog.getByText('Closed by itself').waitFor();
  assert.equal(await dialog.getByRole('button', {name: 'Dismiss'}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a new installation is guided on Home and finds its Telegram ID without a terminal', async () => {
  writeFileSync('/tmp/nocheh-ui-scenario', 'fresh');
  try {
    const {page, problems} = await open('home');
    const steps = page.getByRole('list', {name: 'Get started'});
    await steps.getByRole('link', {name: /Add your Telegram ID/}).waitFor();
    await page.getByText('1 of 5 done').waitFor();
    // A missing OpenAI key is a warning that names what stops working.
    assert.match(
      await steps.getByRole('link', {name: /Add an OpenAI key/}).textContent(),
      /Memory search and voice notes need it/,
    );
    assert.equal(
      await steps.getByRole('link', {name: /Connect your Telegram bot/}).count(),
      0,
      'a done step is no link',
    );
    // Steps on the list aren't repeated as things that need the owner.
    const needs = page.getByRole('list', {name: 'What needs you'});
    assert.equal(await needs.getByText(/Telegram is turned off|No model is set up/).count(), 0);
    await steps.getByRole('link', {name: /Add your Telegram ID/}).click();
    await page.getByRole('tab', {name: /Telegram/, selected: true}).waitFor();
    await page.getByRole('button', {name: 'Find my ID'}).click();
    const found = page.getByRole('list', {name: 'Accounts that wrote to the bot'});
    await found.getByText('Owner').waitFor();
    await found.getByRole('button', {name: 'Use this ID'}).click();
    assert.equal(await page.locator('#telegram-owner').inputValue(), '42');
    await page.getByRole('region', {name: 'Save changes'}).getByText('1 unsaved change').waitFor();
    await page.getByRole('region', {name: 'Save changes'}).getByRole('button', {name: 'Discard'}).click();
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
  // Without a saved bot token there is nothing to look in yet.
  const {page} = await open('settings?view=telegram');
  assert.equal(await page.getByRole('button', {name: 'Find my ID'}).isDisabled(), true);
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

test('a slow apply shows its step and time, and a reload keeps following it to the end', async () => {
  writeFileSync('/tmp/nocheh-ui-scenario', 'slow-apply');
  try {
    const {page, problems} = await open('settings?view=telegram');
    const bar = page.getByRole('region', {name: 'Save changes'});
    await page.locator('#telegram-names').fill('Nocheh,Slow');
    await bar.getByRole('button', {name: 'Save'}).click();
    // The services restart for a while; the page names the step and counts the time.
    const progress = bar.getByText(/^Restarting services… 0:0\d$/);
    await progress.waitFor();
    const first = await progress.textContent();
    await page.waitForTimeout(2100);
    assert.notEqual(await progress.textContent(), first, 'the time counts up');
    // A reload in the middle follows the running apply instead of offering to apply again.
    await page.reload();
    await page.locator('main h1').first().waitFor();
    await bar.getByText(/^(Restarting services|Refreshing memory)… 0:0\d$/).waitFor();
    assert.equal(await bar.getByText('Saved, not in use yet').count(), 0);
    assert.equal(await bar.getByRole('button', {name: 'Save'}).isDisabled(), true);
    await bar.getByText(/^Refreshing memory… /).waitFor();
    await page.getByRole('status').filter({hasText: 'Saved and applied.'}).waitFor({timeout: 15000});
    await bar.getByText('No unsaved changes').waitFor();
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
});

test('an apply the dashboard lost ends with a clear error and the Save button back', async () => {
  writeFileSync('/tmp/nocheh-ui-scenario', 'lost-apply');
  try {
    const {page, problems} = await open('settings?view=telegram');
    const bar = page.getByRole('region', {name: 'Save changes'});
    await page.locator('#telegram-names').fill('Nocheh,Lost');
    await bar.getByRole('button', {name: 'Save'}).click();
    await bar.getByText(/^Restarting services… /).waitFor();
    await bar.getByText('Couldn’t save').waitFor({timeout: 10000});
    await page.getByRole('alert').filter({hasText: 'Couldn’t save: The dashboard restarted while applying'}).waitFor();
    assert.equal(await bar.getByRole('button', {name: 'Try again'}).isEnabled(), true);
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
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

test('the sealed box switch saves with the job limits in either order, and again after a change elsewhere', async () => {
  const {page, problems} = await open('settings?view=assistant');
  const posts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/background-jobs/settings'))
      posts.push(request.postDataJSON());
  });
  const bar = page.getByRole('region', {name: 'Save changes'});
  const box = page.getByRole('switch', {name: 'Sealed box for jobs'});
  const minutes = page.locator('#job-minutes_limit');
  const on = async () => (await box.getAttribute('aria-checked')) === 'true';
  // One save sends the switch and the limits together, over one revision, whichever was changed first.
  for (const order of ['switch first', 'limit first']) {
    const wasOn = await on();
    const next = String(Number(await minutes.inputValue()) - 5);
    if (order === 'switch first') await box.click();
    await minutes.fill(next);
    if (order === 'limit first') await box.click();
    await bar.getByText('2 unsaved changes').waitFor();
    const sent = posts.length;
    await bar.getByRole('button', {name: 'Save'}).click();
    await bar.getByText('No unsaved changes').waitFor();
    assert.equal(posts.length, sent + 1, order);
    assert.equal(posts.at(-1).box_tools, !wasOn, order);
    assert.equal(posts.at(-1).minutes_limit, Number(next), order);
    assert.equal(await on(), !wasOn, order);
    assert.equal(await minutes.inputValue(), next, order);
  }
  // Changed elsewhere meanwhile: the save is refused with the edit kept, and Try again saves over the new revision.
  const other = await open('settings?view=assistant');
  const otherBar = other.page.getByRole('region', {name: 'Save changes'});
  const wasOn = await on();
  const next = String(Number(await minutes.inputValue()) - 5);
  await minutes.fill(next);
  await other.page.getByRole('switch', {name: 'Sealed box for jobs'}).click();
  await otherBar.getByRole('button', {name: 'Save'}).click();
  await otherBar.getByText('No unsaved changes').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByRole('button', {name: 'Try again'}).waitFor();
  assert.match(await bar.textContent(), /Job settings were changed somewhere else\. Your edits are kept/);
  assert.equal(await minutes.inputValue(), next, 'the edit is kept');
  await bar.getByRole('button', {name: 'Try again'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  await minutes.waitFor();
  assert.equal(await minutes.inputValue(), next);
  assert.equal(await on(), !wasOn, 'the switch saved elsewhere stays');
  assert.deepEqual([...problems, ...other.problems], []);
  await other.page.close();
  await page.close();
});

test('a custom provider is checked, added and saved from one dialog', async () => {
  const {page, problems} = await open('settings?view=models');
  await page.getByRole('button', {name: 'Add provider'}).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', {name: /Custom/}).click();
  await dialog.getByLabel('Name').fill('Example gateway');
  await dialog.getByLabel('Address').fill('https://gateway.example.test/');
  await dialog.getByLabel('API key').fill('synthetic-gateway-key');
  // Its models are listed from the address and key before it is added.
  await dialog
    .getByText(/\d+ models? found|Connected/)
    .first()
    .waitFor();
  // The address works without /v1: the check finds the API there, and that address is saved.
  await dialog.getByText('Nocheh will call https://gateway.example.test/v1').waitFor();
  await dialog.getByRole('button', {name: 'Add provider'}).click();
  await dialog.waitFor({state: 'detached'});
  await page.getByText('Example gateway').first().waitFor();
  await page.getByText('https://gateway.example.test/v1', {exact: true}).waitFor();
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.waitFor();
  assert.equal(await bar.getByText('synthetic-gateway-key').count(), 0);
  await bar.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved and applied.'}).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await bar.getByRole('button', {name: 'Save'}).isDisabled(), true);
  // Leaving out /v1 when editing it keeps the saved address and its saved key.
  await page.getByRole('button', {name: 'Edit Example gateway'}).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Address').fill('https://gateway.example.test');
  await edit.getByText('Leave empty to keep the saved key.').waitFor();
  await edit.getByText('Nocheh will call https://gateway.example.test/v1').waitFor();
  await edit.getByRole('button', {name: 'Done'}).click();
  await edit.waitFor({state: 'detached'});
  await bar.getByText('No unsaved changes').waitFor();
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

test('the memory search model can be changed after confirming a memory rebuild', async () => {
  const {page, problems} = await open('settings?view=models');
  const model = page.locator('#embedding-model');
  await model.locator('option', {hasText: 'text-embedding-3-large'}).waitFor({state: 'attached'});
  assert.equal(await model.locator('option[disabled]').count(), 0);
  await model.selectOption('text-embedding-3-large');
  await page.getByText(/Saving rebuilds long-term memory with text-embedding-3-large/).waitFor();
  const bar = page.getByRole('region', {name: 'Save changes'});
  // Cancelling the confirmation saves nothing.
  await bar.getByRole('button', {name: 'Save'}).click();
  let dialog = page.getByRole('dialog', {name: 'Switch memory search to text-embedding-3-large?'});
  await dialog.getByText(/learns again from your saved messages/).waitFor();
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await dialog.waitFor({state: 'detached'});
  await bar.getByText('1 unsaved change').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  dialog = page.getByRole('dialog', {name: 'Switch memory search to text-embedding-3-large?'});
  await dialog.getByRole('button', {name: 'Switch and rebuild'}).click();
  await page.getByRole('status').filter({hasText: 'Saved and applied.'}).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  // Back to the model memory is stored with needs no rebuild and no question.
  await model.selectOption('text-embedding-3-small');
  await bar.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved and applied.'}).nth(0).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
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

test('Notion is connected through its sign-in, turned on with an approval choice, and disconnected', async () => {
  const {page, problems} = await open('settings?view=connections');
  const card = page.getByRole('region', {name: 'Notion'});
  await card.getByText('Not connected').waitFor();
  assert.equal(await card.getByRole('switch', {name: 'Use Notion'}).isDisabled(), true);
  // Notion's sign-in returns to the dashboard, which finishes it and cleans the address.
  await card.getByRole('button', {name: 'Connect Notion'}).click();
  await page.getByRole('status').filter({hasText: 'Notion is connected.'}).waitFor();
  await card.getByText('Connected to Synthetic workspace').waitFor();
  assert.equal(new URL(page.url()).search, '');
  assert.match(page.url(), /#settings\?view=connections$/);
  await card.getByRole('switch', {name: 'Use Notion'}).click();
  await card.getByLabel('Ask me first').selectOption({label: 'Everything asks me'});
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  await card.getByRole('switch', {name: 'Use Notion', checked: true}).waitFor();
  assert.equal(await card.getByLabel('Ask me first').inputValue(), 'everything');
  await card.getByRole('button', {name: 'Disconnect'}).click();
  await page.getByRole('dialog', {name: 'Disconnect Notion?'}).getByRole('button', {name: 'Disconnect'}).click();
  await card.getByText('Not connected').waitFor();
  await card.getByRole('switch', {name: 'Use Notion', checked: false}).waitFor();
  // A wrong Business-plan token is refused in plain words.
  await card.getByText('Paste an MCP token instead').click();
  await card.getByLabel('Notion MCP token').fill('wrong-token');
  await card.getByRole('button', {name: 'Save token'}).click();
  await card.getByText('Notion refused that token.', {exact: false}).waitFor();
  problems.splice(0, problems.length, ...problems.filter(problem => !/400/.test(problem)));
  assert.deepEqual(problems, []);
  await page.close();
});

test('GitHub is connected through its own app, lists the chosen repositories, copies one and is disconnected', async () => {
  const {page, problems} = await open('settings?view=connections');
  const card = page.getByRole('region', {name: 'GitHub'});
  await card.getByText('Not connected').waitFor();
  // A sign-in that comes back while Nocheh is busy keeps its code in the address, so a reload can finish it.
  await page.goto(origin + '/?connect=github&code=preview-busy&state=fixture-state');
  await card.getByText('Reload this page in a minute to finish.', {exact: false}).waitFor();
  assert.equal(new URL(page.url()).search, '?connect=github&code=preview-busy&state=fixture-state');
  problems.splice(0, problems.length, ...problems.filter(problem => !/409/.test(problem)));
  await page.goto(origin + '/#settings?view=connections');
  await card.getByText('Not connected').waitFor();
  // GitHub creates the app, then asks which repositories it may read, and each time sends the browser back here.
  await card.getByRole('button', {name: 'Connect GitHub'}).click();
  await page.getByRole('status').filter({hasText: 'GitHub is connected.'}).waitFor();
  await card.getByText('Connected', {exact: true}).waitFor();
  await card.getByText('Nocheh reads through its app Nocheh-a1b2c3 on octo-example', {exact: false}).waitFor();
  assert.equal(new URL(page.url()).search, '');
  assert.match(page.url(), /#settings\?view=connections$/);
  const widgets = card
    .getByRole('list', {name: 'Repositories'})
    .getByRole('listitem')
    .filter({hasText: 'example-org/widgets'});
  await widgets.getByRole('button', {name: 'Copy'}).click();
  await page.getByRole('status').filter({hasText: 'example-org/widgets is copied.'}).waitFor();
  await card.getByRole('button', {name: 'Disconnect'}).click();
  await page.getByRole('dialog', {name: 'Disconnect GitHub?'}).getByRole('button', {name: 'Disconnect'}).click();
  await card.getByText('Not connected').waitFor();
  // The app stays on GitHub until the owner deletes it there.
  assert.equal(
    await card.getByRole('link', {name: 'Open it on GitHub'}).getAttribute('href'),
    'https://github.com/settings/apps/nocheh-a1b2c3',
  );
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

test('a project’s chats share what they know only once it is ticked, and its rules change on the project', async () => {
  const {page, problems} = await open('memory?view=projects&project=' + 'ab'.repeat(32));
  const drawer = page.getByRole('dialog', {name: 'Aurora field guide'});
  await drawer.getByRole('button', {name: 'Edit'}).click();
  const dialog = page.getByRole('dialog', {name: 'Edit project'});
  const share = dialog.getByRole('checkbox', {name: 'Chats in this project share what they know'});
  assert.equal(await share.isChecked(), false);
  await share.check();
  await dialog.getByText('Everyone allowed in any of these chats will see what the others know.').waitFor();
  await dialog
    .getByRole('radiogroup', {name: 'How chats share'})
    .getByRole('radio', {name: 'Filter automatically', checked: true})
    .waitFor();
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Project saved.'}).waitFor();
  // The list behind the open drawer marks it.
  await page.locator('li button', {hasText: 'Aurora field guide'}).getByText('Shares', {exact: true}).waitFor();
  await drawer.getByText('These chats share what they know (Filter automatically).').waitFor();
  await drawer.getByRole('switch', {name: 'Don’t share into Aurora planning'}).click();
  await page
    .getByRole('status')
    .filter({hasText: 'Nothing from this project goes into Aurora planning now.'})
    .waitFor();
  await page.close();

  // The chat's project card shows the same choice, and marks the projects that share.
  const {page: chat, problems: chatProblems} = await open('chats?chat=-10042');
  await chat.getByRole('switch', {name: 'Don’t share into this chat', checked: true}).waitFor();
  await chat.getByText('Chats in Aurora field guide share what they know (Filter automatically).').waitFor();
  assert.equal(await chat.locator('#chat-project option', {hasText: 'Aurora field guide · shares'}).count(), 1);
  await chat.close();

  // A topic set to follow its group into a project that shares asks first.
  const {page: topic, problems: topicProblems} = await open('chats?chat=-10042%2Ftopic%2F7');
  const choice = topic.locator('#chat-project');
  await choice.selectOption({label: 'No project'});
  await topic.getByRole('status').filter({hasText: 'Removed from its project.'}).waitFor();
  await choice.selectOption({label: 'Same as the group (Aurora field guide · shares)'});
  const ask = topic.getByRole('dialog', {name: 'Share with the chats in Aurora field guide?'});
  await ask.getByText('Everyone allowed in any of these chats will see what the others know.').waitFor();
  await ask.getByRole('button', {name: 'Cancel'}).click();
  assert.equal(await choice.inputValue(), '__none');
  await choice.selectOption({label: 'Same as the group (Aurora field guide · shares)'});
  await ask.getByRole('button', {name: 'Follow the group'}).click();
  await topic.getByRole('status').filter({hasText: 'Follows the group’s project now.'}).waitFor();
  await topic.close();

  // A suggested move out of it says so before the owner decides.
  const {page: review, problems: reviewProblems} = await open('inbox?kind=knowledge&decision=' + 'f'.repeat(64));
  await review.getByRole('dialog').getByText('A project here shares what its chats know').waitFor();
  await review.close();

  // A project's rule is read on Sharing and changed on the project.
  const {page: rules, problems: ruleProblems} = await open('chats?view=rules');
  const row = rules.getByRole('listitem').filter({hasText: 'Set by project Aurora field guide'});
  await row.getByRole('link', {name: 'Open project'}).waitFor();
  assert.equal(await row.getByRole('switch').count(), 0);
  await row.getByRole('button', {name: /Set by project Aurora field guide/}).click();
  const details = rules.getByRole('dialog', {name: /Set by project Aurora field guide/});
  await details.getByRole('link', {name: 'Project Aurora field guide'}).waitFor();
  await details.getByRole('link', {name: 'Open project'}).waitFor();
  assert.equal(await details.getByRole('button', {name: 'Edit'}).count(), 0);
  assert.deepEqual([...problems, ...chatProblems, ...topicProblems, ...reviewProblems, ...ruleProblems], []);
  await rules.close();
});

test('usage shows calls, tokens and cost, and never prices an unknown cost as free', async () => {
  const {page, problems} = await open('usage');
  await page.getByRole('table', {name: 'Usage by part'}).waitFor();
  await page
    .getByText(/At least \$|Unknown/)
    .first()
    .waitFor();
  // Input counts cached tokens too, and says how much the prompt cache covered.
  await page.getByRole('table', {name: 'Usage by part'}).getByText('67% cached').waitFor();
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
