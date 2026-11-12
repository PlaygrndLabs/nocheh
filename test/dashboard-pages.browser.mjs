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
  ...['work', 'sends', 'machines', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'connections', 'machines', 'advanced'].map(
    view => ['settings?view=' + view, 'Settings'],
  ),
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

test('navigation lists each page once, in order, links to the assistant chat and console and collapses', async () => {
  const {page} = await open('home');
  const nav = page.getByRole('navigation', {name: 'Main'});
  const [home, ...rest] = pages.map(([, title]) => title);
  assert.deepEqual(
    (await nav.getByRole('link').allTextContents()).map(text => text.trim().replace(/\d+$/, '')),
    [home, 'Chat', ...rest],
  );
  // Chat opens the assistant console's chat directly.
  assert.equal(await nav.getByRole('link', {name: 'Chat', exact: true}).getAttribute('href'), '/hermes/chat');
  assert.equal(await page.locator('a[href="/hermes/nocheh"]', {hasText: 'Assistant console'}).count(), 1);
  assert.equal(await page.locator('a[href^="/providers"]').count(), 0);
  await page.getByRole('button', {name: 'Collapse navigation'}).click();
  await page.getByRole('button', {name: 'Expand navigation'}).waitFor();
  // Collapsed, every page and Chat are still named links.
  assert.equal(await nav.getByRole('link', {name: 'Settings'}).count(), 1);
  assert.equal(await nav.getByRole('link', {name: 'Chat', exact: true}).count(), 1);
  await page.getByRole('button', {name: 'Expand navigation'}).click();
  await nav.getByRole('link', {name: 'Chat', exact: true}).click();
  await page.waitForURL(origin + '/hermes/chat');
  await page.close();
});

test('the sidebar lists the open page’s tabs and opens any page’s tab directly', async () => {
  const {page, problems} = await open('settings?view=models');
  const nav = page.getByRole('navigation', {name: 'Main'});
  const settingsTabs = nav.getByRole('list', {name: 'Settings tabs'});
  assert.deepEqual(
    (await settingsTabs.getByRole('link').allTextContents()).map(text => text.trim()),
    ['Telegram', 'Models', 'Speed', 'Privacy & data', 'Assistant', 'Tasks', 'Connections', 'Machines', 'Advanced'],
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
  // A saved ID changes only from the command line: the field is read-only and says how.
  const {page} = await open('settings?view=telegram');
  const owner = page.locator('#telegram-owner');
  assert.equal(await owner.inputValue(), '42');
  assert.equal(await owner.getAttribute('readonly'), '');
  await page.getByText('./bin/nocheh config set TELEGRAM_OWNER_ID <id>').waitFor();
  assert.equal(await page.getByRole('button', {name: 'Find my ID'}).count(), 0);
  await page.close();
  writeFileSync('/tmp/nocheh-ui-scenario', 'no-owner');
  try {
    // Without a saved bot token there is nothing to look in yet.
    const {page: empty} = await open('settings?view=telegram');
    assert.equal(await empty.getByRole('button', {name: 'Find my ID'}).isDisabled(), true);
    assert.equal(await empty.locator('#telegram-owner').getAttribute('readonly'), null);
    await empty.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
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

test('the private chat and groups each start from their own default role and skills', async () => {
  const {page, problems} = await open('settings?view=assistant');
  const mine = page.locator('section', {
    has: page.getByRole('heading', {name: 'Role and skills in your private chat'}),
  });
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Role and skills in groups'})});
  await mine.getByText('Your private chat can use these.').waitFor();
  await groups.getByText('Every group and topic can use these.').waitFor();
  assert.equal(await mine.getByRole('textbox', {name: 'Name'}).inputValue(), 'weekly-menu');
  assert.equal(
    await groups.getByRole('textbox', {name: 'Name'}).count(),
    0,
    'groups never start from the private chat’s skills',
  );
  const saved = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/memory/persona'))
      saved.push(request.postDataJSON().scope);
  });
  await groups.getByRole('textbox', {name: 'Role'}).fill('You help each group plan its week.');
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('1 unsaved change').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  assert.deepEqual(saved, ['default:groups']);
  await page.reload();
  await groups.getByRole('textbox', {name: 'Role'}).waitFor();
  assert.equal(await groups.getByRole('textbox', {name: 'Role'}).inputValue(), 'You help each group plan its week.');
  assert.equal(await mine.getByRole('textbox', {name: 'Role'}).inputValue(), '');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a page for a feature the connected assistant lacks says so instead of offering a retry', async () => {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await page.route(/\/api\/nocheh\/memory\/persona\?/, route =>
    route.fulfill({status: 409, contentType: 'application/json', body: '{"error":"brain_capability_unavailable"}'}),
  );
  await page.goto(origin + '/#chats?chat=-10042');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Role and skills'})});
  await card.getByText('The connected assistant can’t do this').waitFor();
  await card.getByText('It doesn’t offer the role and skills.').waitFor();
  assert.equal(await card.getByRole('button', {name: 'Try again'}).count(), 0);
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
  const status = page.locator('section').filter({has: page.getByRole('heading', {name: 'Long-term memory'})});
  await status.getByText('Engine: Honcho').waitFor();
  await page.getByRole('heading', {name: 'What it remembers'}).waitFor();
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

test('off-site storage connects from one Cloudflare token or a Backblaze key, then saves with the passphrase', async () => {
  const {page, problems} = await open('settings?view=privacy');
  await page.getByRole('radiogroup', {name: 'Send off-site copies'}).getByRole('radio', {name: 'On'}).click();
  const storage = page.getByRole('radiogroup', {name: 'Storage'});
  assert.equal(await storage.getByRole('radio', {name: 'Cloudflare'}).getAttribute('aria-checked'), 'true');
  // Cloudflare opens its token page with both permissions already chosen.
  const link = new URL(await page.getByRole('link', {name: 'Open Cloudflare'}).getAttribute('href'));
  assert.deepEqual(JSON.parse(link.searchParams.get('permissionGroupKeys')), [
    {key: 'workers_r2', type: 'edit'},
    {key: 'account_api_tokens', type: 'edit'},
  ]);
  const token = page.locator('#offsite-cloudflare-token');
  await token.fill('refused');
  await page.getByRole('button', {name: 'Connect'}).click();
  const refused = page.getByRole('alert').filter({hasText: 'Cloudflare didn’t accept this token'});
  await refused.waitFor();
  assert.doesNotMatch(await refused.textContent(), /Nocheh setup/);
  // A stop after the token was accepted leaves it for another try, and says where to delete it.
  await token.fill('no-r2');
  await page.getByRole('button', {name: 'Connect'}).click();
  const stopped = page.getByRole('alert').filter({hasText: 'R2 isn’t turned on'});
  await stopped.waitFor();
  assert.match(await stopped.textContent(), /delete “Nocheh setup”/);
  // A token that reaches two accounts asks which one.
  await token.fill('two-accounts');
  await page.getByRole('button', {name: 'Connect'}).click();
  await page.locator('#offsite-cloudflare-account').selectOption({label: 'Example work'});
  await page.getByRole('button', {name: 'Connect'}).click();
  const done = page.getByRole('status').filter({hasText: 'Connected to bucket nocheh-backups.'});
  await done.waitFor();
  assert.match(await done.textContent(), /locked for 7 days.*Now type your passphrase below and save\./);
  await page.getByText('Connected. Copies go to bucket nocheh-backups.').waitFor();
  assert.equal(await token.count(), 0, 'the token form closes once connected');
  // Turning copies on is still the owner's unsaved edit, and saves with the passphrase.
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('1 unsaved change').waitFor();
  await page.locator('#NOCHEH_OFFSITE_PASSPHRASE').fill('a long synthetic passphrase');
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  // Backblaze fills everything from a key limited to one bucket. Choosing it alone saves nothing.
  await storage.getByRole('radio', {name: 'Backblaze'}).click();
  await page.getByText('Keep only the last version', {exact: false}).waitFor();
  assert.equal(await bar.getByText('No unsaved changes').count(), 1);
  await page.locator('#offsite-backblaze-key-id').fill('0041example');
  await page.getByLabel('Application key').fill('K004example');
  await page.getByRole('button', {name: 'Connect'}).click();
  await page.getByRole('status').filter({hasText: 'Connected to bucket example-backups.'}).waitFor();
  await bar.getByText('No unsaved changes').waitFor();
  // Other S3 storage keeps every field to fill in by hand, and is saved with Save.
  await storage.getByRole('radio', {name: 'Other S3'}).click();
  assert.equal(await page.locator('#NOCHEH_OFFSITE_ENDPOINT').inputValue(), 'https://s3.us-west-004.backblazeb2.com');
  await page.locator('#NOCHEH_OFFSITE_BUCKET').fill('example-other');
  await bar.getByText('2 unsaved changes').waitFor();
  // Going back drops what was typed for it.
  await storage.getByRole('radio', {name: 'Backblaze'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.getByText('Connected. Copies go to bucket example-backups.').waitFor();
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

test('a machine is added with its public key, tested, edited, turned off and removed, and its commands are in the log', async () => {
  const {page, problems} = await open('settings?view=machines');
  const card = page.getByRole('region', {name: 'Machines'});
  const list = card.getByRole('list', {name: 'Machines'});
  const row = name => list.getByRole('listitem').filter({has: page.getByText(name, {exact: true})});
  await row('build-vm').getByText('Ready').waitFor();
  await row('test-vm').getByText('Test failed: the machine refused the key').waitFor();
  // The form checks what the store would refuse before anything is sent.
  await card.getByRole('button', {name: 'Add machine'}).click();
  const form = page.getByRole('dialog', {name: 'Add a machine'});
  const local = 'For a VM on this computer, use host.docker.internal, not localhost.';
  await form.getByText('An IP address or a host name. ' + local).waitFor();
  await form.getByRole('textbox', {name: 'Name'}).fill('Build-VM');
  await form.getByRole('textbox', {name: 'Address'}).fill('-oProxyCommand=x');
  await form.getByRole('button', {name: 'Add machine'}).click();
  await form.getByText('Another machine already has this name.').waitFor();
  await form.getByText('Write a host name or an IP address', {exact: false}).waitFor();
  await form.getByText('Use a Linux login name', {exact: false}).waitFor();
  // localhost is Nocheh's own container: the form says what to use for a VM on this computer, and still takes it.
  await form.getByRole('textbox', {name: 'Address'}).fill('127.0.0.1');
  await form.getByText(local, {exact: true}).waitFor();
  assert.equal(await form.getByRole('alert').filter({hasText: local}).count(), 0);
  await form.getByRole('textbox', {name: 'Name'}).fill('lab-vm');
  await form.getByRole('textbox', {name: 'Address'}).fill('192.0.2.20');
  await form.getByRole('textbox', {name: 'Login'}).fill('nocheh');
  await form.getByRole('button', {name: 'Add machine'}).click();
  const setup = page.getByRole('dialog', {name: 'Put the key on lab-vm'});
  await setup
    .getByText('On the machine, signed in as nocheh, paste the setup command into a terminal', {exact: false})
    .waitFor();
  assert.match(
    await setup.getByRole('textbox', {name: 'Setup command for lab-vm'}).inputValue(),
    /^mkdir -p ~\/\.ssh .* 'ssh-ed25519 [A-Za-z0-9+/]+ nocheh lab-vm' >> ~\/\.ssh\/authorized_keys; }; }$/,
  );
  // A browser that refuses the clipboard, as on a plain http address, leaves the key to select by hand.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: async () => Promise.reject(new Error('denied'))},
    }),
  );
  await setup.getByRole('button', {name: 'Copy setup command'}).click();
  await setup.getByText('This browser didn’t allow copying.', {exact: false}).waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: async text => void (window.copied = text)},
    }),
  );
  await setup.getByRole('button', {name: 'Copy setup command'}).click();
  await page.getByRole('status').filter({hasText: 'The setup command is copied.'}).waitFor();
  assert.match(
    await page.evaluate(() => window.copied),
    /^mkdir -p ~\/\.ssh .* nocheh lab-vm' >> ~\/\.ssh\/authorized_keys; }; }$/,
  );
  await setup.getByRole('button', {name: 'Copy public key'}).click();
  await page.getByRole('status').filter({hasText: 'The public key is copied.'}).waitFor();
  assert.match(await page.evaluate(() => window.copied), /^ssh-ed25519 [A-Za-z0-9+/]+ nocheh lab-vm$/);
  await setup.getByRole('button', {name: 'Test'}).click();
  await setup.getByText('lab-vm is ready').waitFor();
  await setup.getByRole('button', {name: 'Done'}).click();
  await row('lab-vm').getByText('Ready').waitFor();
  assert.match(await row('lab-vm').textContent(), /Host key: SHA256:[A-Za-z0-9+/]{43}/);

  // Edit: a new name saves at once and keeps the host key.
  await row('lab-vm').getByRole('button', {name: 'Edit'}).click();
  const edit = page.getByRole('dialog', {name: 'Edit lab-vm'});
  assert.equal(await edit.getByRole('textbox', {name: 'Address'}).inputValue(), '192.0.2.20');
  await edit.getByRole('textbox', {name: 'Name'}).fill('build-VM');
  await edit.getByRole('button', {name: 'Save'}).click();
  await edit.getByText('Another machine already has this name.').waitFor();
  await edit.getByRole('textbox', {name: 'Name'}).fill('lab-vm-2');
  // A change made meanwhile refuses the first Save; the edit stays, and the next Save goes over the machine as it is now.
  const changed = await page.evaluate(async () => {
    const headers = {'Content-Type': 'application/json', 'X-Nocheh-CSRF': window.__NOCHEH_CSRF__ ?? ''};
    const {machines} = await (await fetch('/api/nocheh/machines', {headers})).json();
    const lab = machines.find(machine => machine.name === 'lab-vm');
    const body = JSON.stringify({enabled: true, revision: lab.revision});
    return (await fetch('/api/nocheh/machines/' + lab.id, {method: 'POST', headers, body})).ok;
  });
  assert.equal(changed, true);
  const reread = page.waitForResponse(
    response => response.url().endsWith('/api/nocheh/machines') && response.request().method() === 'GET',
  );
  await edit.getByRole('button', {name: 'Save'}).click();
  await edit.getByText('This changed somewhere else. Check it and try again.').waitFor();
  await reread;
  assert.equal(await edit.getByRole('textbox', {name: 'Name'}).inputValue(), 'lab-vm-2');
  await edit.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'lab-vm-2 is saved.'}).waitFor();
  await row('lab-vm-2').getByText('Ready').waitFor();
  // A new address, port or login asks first, in plain words; Cancel keeps the machine and the edit.
  await row('build-vm').getByRole('button', {name: 'Edit'}).click();
  const move = page.getByRole('dialog', {name: 'Edit build-vm'});
  await move.getByRole('textbox', {name: 'Port'}).fill('2200');
  await move.getByRole('button', {name: 'Save'}).click();
  const moving = page.getByRole('dialog', {name: 'Change where Nocheh reaches build-vm?'});
  assert.equal(
    (await moving.textContent()).includes(
      'A job works on it. Nocheh forgets the host key it trusts for build-vm. Jobs running on it stop, and cards waiting for your approval are withdrawn. Then press Test, so Nocheh trusts the machine again.',
    ),
    true,
  );
  await moving.getByRole('button', {name: 'Cancel'}).click();
  assert.equal(await move.getByRole('textbox', {name: 'Port'}).inputValue(), '2200');
  await move.getByRole('button', {name: 'Cancel'}).click();
  assert.match(await row('build-vm').textContent(), /nocheh@192\.0\.2\.10:22/);
  await row('lab-vm-2').getByRole('button', {name: 'Edit'}).click();
  await page.getByRole('dialog', {name: 'Edit lab-vm-2'}).getByRole('textbox', {name: 'Address'}).fill('192.0.2.21');
  await page.getByRole('dialog', {name: 'Edit lab-vm-2'}).getByRole('button', {name: 'Save'}).click();
  await page
    .getByRole('dialog', {name: 'Change where Nocheh reaches lab-vm-2?'})
    .getByRole('button', {name: 'Change and forget the host key'})
    .click();
  await page.getByRole('status').filter({hasText: 'lab-vm-2 is changed. Press Test to trust its host key.'}).waitFor();
  await row('lab-vm-2').getByText('Not tested').waitFor();
  assert.match(await row('lab-vm-2').textContent(), /nocheh@192\.0\.2\.21:22/);
  await row('lab-vm-2').getByRole('button', {name: 'Test'}).click();
  await row('lab-vm-2').getByText('Ready').waitFor();

  // A machine that can't be reached says so in words, and its badge stays a warning.
  await row('spare-vm').getByRole('switch', {name: 'Use spare-vm'}).click();
  await row('spare-vm').getByText('Not tested').waitFor();
  await row('spare-vm').getByRole('button', {name: 'Test'}).click();
  await card.getByRole('alert').filter({hasText: 'spare-vm: Can’t reach the machine.'}).waitFor();
  await row('spare-vm').getByText('Test failed: can’t reach the machine').waitFor();

  // Turning a machine with a running job off asks first; Cancel leaves it on.
  await row('build-vm').getByRole('switch', {name: 'Use build-vm'}).click();
  const offMachine = page.getByRole('dialog', {name: 'Turn off build-vm?'});
  await offMachine.getByText('A job works on it.', {exact: false}).waitFor();
  await offMachine.getByRole('button', {name: 'Cancel'}).click();
  assert.equal(await row('build-vm').getByRole('switch', {name: 'Use build-vm'}).getAttribute('aria-checked'), 'true');

  // The one switch for everything asks first, and the page says it is off until it is on again.
  await card.getByRole('switch', {name: 'Machine control'}).click();
  await page.getByRole('dialog', {name: 'Turn off machine control?'}).getByRole('button', {name: 'Turn off'}).click();
  await page.getByRole('status').filter({hasText: 'No job can work on your machines until you turn it on.'}).waitFor();
  await card.getByRole('switch', {name: 'Machine control'}).click();
  await page.getByRole('status').filter({hasText: 'Machine control is on.'}).waitFor();
  await page.getByText('No job can work on your machines until you turn it on.').waitFor({state: 'detached'});

  // A new host key is trusted only after a confirm and the next Test; Remove asks too.
  await row('lab-vm-2').getByRole('button', {name: 'Trust a new host key'}).click();
  await page
    .getByRole('dialog', {name: 'Trust a new host key for lab-vm-2?'})
    .getByRole('button', {name: 'Forget the old key'})
    .click();
  await row('lab-vm-2').getByText('Not tested').waitFor();
  await row('lab-vm-2').getByRole('button', {name: 'Remove'}).click();
  await page.getByRole('dialog', {name: 'Remove lab-vm-2?'}).getByRole('button', {name: 'Remove'}).click();
  await page.getByRole('status').filter({hasText: 'lab-vm-2 is removed.'}).waitFor();
  await row('lab-vm-2').waitFor({state: 'detached'});

  // Each machine's commands open in the log, filtered to it; internal ones only on request.
  await row('build-vm').getByRole('link', {name: 'Log'}).click();
  await page.getByRole('tab', {name: 'Machine log', selected: true}).waitFor();
  const log = page.getByRole('table', {name: 'Machine commands'});
  await log.getByText('npm test 2>&1 | tail -n 40').waitFor();
  assert.equal(await page.getByRole('combobox', {name: 'Machine'}).inputValue(), 'ab12'.repeat(8));
  assert.equal(await log.getByText('cd ~ && pwd').count(), 0);
  await page.getByRole('button', {name: 'Next'}).click();
  await log.getByText('sudo -n true').waitFor();
  await page.getByRole('checkbox', {name: 'All commands, also internal ones'}).check();
  await page.getByRole('button', {name: 'Next'}).click();
  await log.getByText('cd ~ && pwd').waitFor();
  await log.getByRole('button', {name: 'curl -fsS', exact: false}).click();
  const drawer = page.getByRole('dialog', {name: 'Command on build-vm'});
  await drawer.getByText('Can’t reach the machine').waitFor();
  await drawer.getByText('Didn’t run').waitFor();
  assert.match(await drawer.textContent(), /Fingerprint of what ran \(SHA-256\)[a-f0-9]{64}/);
  assert.match(await drawer.textContent(), /Fingerprint of what it printed \(SHA-256\)[a-f0-9]{64}/);
  await drawer.getByRole('button', {name: 'Close'}).click();
  // A command still running hasn't been counted yet: its output is not known, not nothing.
  await page.getByRole('button', {name: 'Previous'}).click();
  await log.getByRole('button', {name: 'npm test 2>&1 | tail -n 40'}).click();
  await drawer.getByText('Running').first().waitFor();
  assert.match(await drawer.textContent(), /PrintedNot known yet/);
  assert.match(await drawer.textContent(), /Fingerprint of what ran \(SHA-256\)[a-f0-9]{64}/);
  assert.match(await drawer.textContent(), /Fingerprint of what it printed \(SHA-256\)Not known yet/);
  await drawer.getByRole('button', {name: 'Close'}).click();

  // Background work shows the machine and the plan its card showed, and links to its commands.
  await page.goto(origin + '/#system?view=work');
  const job = page
    .getByRole('list', {name: 'Background jobs'})
    .getByRole('listitem')
    .filter({hasText: 'Set up the garden site on build-vm'});
  await job.getByRole('list', {name: 'Plan'}).waitFor();
  assert.match(await job.textContent(), / · on build-vm · started /);
  assert.deepEqual(
    (await job.getByRole('list', {name: 'Plan'}).getByRole('listitem').allTextContents()).map(text => text.trim()),
    [
      'Install git and the build tools',
      'Copy the project into ~/projects/garden-site',
      'Install its packages and run its tests',
      'Start it and check that it answers on port 8080',
    ],
  );
  // Stop says that it ends the programs on the machine too; Cancel leaves the job running.
  await job.getByRole('button', {name: 'Stop'}).click();
  const stop = page.getByRole('dialog', {name: 'Stop this job?'});
  await stop.getByText('Nocheh also ends the programs it started on build-vm.', {exact: false}).waitFor();
  await stop.getByRole('button', {name: 'Cancel'}).click();
  // A machine job still waiting has run nothing there, and Stop says so.
  const waiting = page
    .getByRole('list', {name: 'Background jobs'})
    .getByRole('listitem')
    .filter({hasText: 'Rotate the logs on build-vm'});
  await waiting.getByRole('button', {name: 'Stop'}).click();
  await stop.getByText('The job is cancelled before it starts.', {exact: false}).waitFor();
  await stop.getByText('Nothing has run on build-vm yet.', {exact: false}).waitFor();
  assert.equal(await stop.getByText('The running job', {exact: false}).count(), 0);
  assert.equal(await stop.getByText('ends the programs it started', {exact: false}).count(), 0);
  await stop.getByRole('button', {name: 'Cancel'}).click();
  // Programs Nocheh couldn't end are the owner's to end.
  await page
    .getByRole('list', {name: 'Background jobs'})
    .getByRole('listitem')
    .filter({hasText: 'Build the photo gallery on build-vm'})
    .getByText('Nocheh couldn’t end its programs on build-vm. End them yourself.')
    .waitFor();
  await job.getByRole('link', {name: 'Commands it ran on build-vm'}).click();
  await log.getByText('npm test 2>&1 | tail -n 40').waitFor();
  assert.equal(await page.getByRole('combobox', {name: 'Job'}).inputValue(), '9c'.repeat(32));
  assert.equal(await page.getByRole('combobox', {name: 'Machine'}).inputValue(), '');
  assert.deepEqual(problems, []);
  await page.close();
});

test('machine control that isn’t running says so without an alert', async () => {
  writeFileSync('/tmp/nocheh-ui-scenario', 'unavailable');
  try {
    const {page, problems} = await open('settings?view=machines');
    await page.getByRole('status').filter({hasText: 'Machine control isn’t running'}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Add machine'}).isDisabled(), true);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
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

test('sent to apps lists each send with its outcome, and Health opens the ones that failed', async () => {
  const {page, problems} = await open('system');
  // Health counts the last day's problems, leaving out expected no-ops and attempts a retry delivered, and opens them filtered.
  const issue = page.getByRole('listitem').filter({hasText: '2 sends to chat apps failed in the last day'});
  await issue.getByText('Approval card: 1 · Reply: 1').waitFor();
  await issue.getByRole('link', {name: 'Review'}).click();
  await page.getByRole('tab', {name: 'Sent to apps 2', selected: true}).waitFor();
  assert.equal(new URL(page.url()).hash, '#system?view=sends&filter=problems');
  await page.getByText(/^Last day: \d+ sent, 5 failed, 1 uncertain, 2 not sent$/).waitFor();
  const table = page.getByRole('table', {name: 'Sent to apps'});
  await table.getByRole('cell', {name: 'No answer in time'}).waitFor();
  // App, chat, what, result and reason, as a wide screen shows them.
  assert.deepEqual(
    await table
      .locator('tbody tr')
      .evaluateAll(rows => rows.map(row => [...row.cells].slice(1).map(cell => cell.innerText.trim()))),
    [
      ['Telegram', 'Mira Chen', 'Reply', 'Uncertain', 'No answer in time'],
      ['Telegram', 'Mira Chen', 'Approval card', 'Failed', 'The person blocked the bot'],
    ],
  );
  // All keeps no-ops and what Nocheh held back, in plain words, and pages back to older sends.
  await page.getByRole('radiogroup', {name: 'Show'}).getByRole('radio', {name: 'All'}).click();
  assert.equal(new URL(page.url()).hash, '#system?view=sends');
  await table.getByText('Reaction cleared').waitFor();
  for (const name of [
    'Already up to date',
    'Button press expired',
    'Reactions not allowed in this chat',
    'Formatting rejected; sent on a retry',
    'Blocked: wrong chat',
    'Held back: too many at once',
  ])
    await table.getByRole('cell', {name}).waitFor();
  assert.equal(
    await table.getByRole('link', {name: 'Aurora planning · topic 7'}).first().getAttribute('href'),
    '#chats?chat=-10042%2Ftopic%2F7',
  );
  assert.equal(await table.getByText('Bot setup').count(), 0);
  await page.getByRole('button', {name: 'Older'}).click();
  await table.getByText('Bot setup').waitFor();
  await page.getByRole('button', {name: 'Newer'}).click();
  await table.getByText('Reaction cleared').waitFor();
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
