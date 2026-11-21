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
import {accountIdFor, chatIdFor, chatShortId} from '../dist/src/chats.js';
import {memberIdFor} from '../dist/src/members.js';

const port = Number(process.env.NOCHEH_DASHBOARD_PORT || 18900 + Math.floor(Math.random() * 500));
const origin = `http://127.0.0.1:${port}`;
/** The preview's chats with Nocheh's own ids (ADR-0252): a group first seen after step 2b, its topic, and a group
 * Telegram upgraded later, which keeps the id it got under its first Telegram id. */
const NEW_GROUP = chatIdFor('telegram', '-10088'),
  NEW_TOPIC = chatIdFor('telegram', '-10088', '3'),
  UPGRADED = chatIdFor('telegram', '-4005');
/** The preview's members (step 3): Mira, Omar (carried from the lists before step 3, never wrote) and Devon (paused). */
const MIRA = memberIdFor(accountIdFor('telegram', '73')),
  OMAR = memberIdFor(accountIdFor('telegram', '95')),
  DEVON = memberIdFor(accountIdFor('telegram', '84'));
const pages = [
  ['home', 'Home'],
  ['inbox', 'Inbox'],
  ['tasks', 'Tasks'],
  ['schedules', 'Schedules'],
  ['chats', 'Chats'],
  ['members', 'Members'],
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
  ['chats?chat=' + chatIdFor('telegram', '-10088'), 'Chats'],
  ['members?member=' + MIRA, 'Members'],
  ['members?add=new', 'Members'],
  ['messages?view=import', 'Messages'],
  ...['people', 'projects', 'notes', 'longterm'].map(view => ['memory?view=' + view, 'Memory']),
  ...['work', 'sends', 'machines', 'backups', 'databases'].map(view => ['system?view=' + view, 'System']),
  ...['telegram', 'models', 'speed', 'privacy', 'assistant', 'tasks', 'connections', 'machines', 'advanced'].map(
    view => ['settings?view=' + view, 'Settings'],
  ),
  // The sub-tabs of the two longest pages.
  ...['tools', 'jobs', 'instructions'].map(tab => ['settings?view=assistant&tab=' + tab, 'Settings']),
  ...['role', 'tools', 'memory'].map(tab => ['chats?chat=-10042&tab=' + tab, 'Chats']),
  ...['services', 'storage', 'diagnostics'].map(tab => ['system?tab=' + tab, 'System']),
  ...['tasks', 'history'].map(tab => ['system?view=work&tab=' + tab, 'System']),
  ['system?view=backups&tab=history', 'System'],
  ...['days', 'speed', 'replies'].map(tab => ['usage?tab=' + tab, 'Usage']),
  ...['organizing', 'runs'].map(tab => ['inbox?view=history&tab=' + tab, 'Inbox']),
  ...['actions', 'facts'].map(tab => ['memory?view=longterm&tab=' + tab, 'Memory']),
  ...['activity', 'groups', 'miniapp'].map(tab => ['settings?view=telegram&tab=' + tab, 'Settings']),
  ['settings?view=models&tab=providers', 'Settings'],
  ...['records', 'offsite'].map(tab => ['settings?view=privacy&tab=' + tab, 'Settings']),
  ...['priorities', 'columns'].map(tab => ['settings?view=tasks&tab=' + tab, 'Settings']),
  ['settings?view=connections&tab=github', 'Settings'],
  ['chats?view=rules&tab=defaults', 'Chats'],
  ...['about', 'conversations'].map(tab => ['memory?view=notes&tab=' + tab, 'Memory']),
  ...['chats', 'pause'].map(tab => ['members?member=' + MIRA + '&tab=' + tab, 'Members']),
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
/** Tasks show ten to a page, so a test finds its own task by searching for it; the search stays on between tabs. */
async function findTask(page, title) {
  await page.getByLabel('Search tasks').fill(title);
  return page.getByRole('row').filter({hasText: title});
}

/**
 * The table of chats and of members: a row by its name, found on whichever page of the table holds it, and opened
 * from there. From an open chat or member, the way is back to the table first.
 */
function tableOf(page, name, back) {
  const table = page.getByRole('table', {name});
  const row = link => table.getByRole('row').filter({has: page.getByRole('link', {name: link})});
  const turn = async label => {
    const button = page.getByRole('button', {name: label, exact: true});
    if (!(await button.count()) || !(await button.isEnabled())) return false;
    await button.click();
    return true;
  };
  const find = async link => {
    if (await page.getByRole('button', {name: back}).count()) await page.getByRole('button', {name: back}).click();
    await table.waitFor();
    while (await turn('Previous'));
    while (!(await row(link).count()) && (await turn('Next')));
    return row(link);
  };
  return {table, row, find, open: async link => (await find(link)).getByRole('link', {name: link}).click()};
}
const chatsTable = page => tableOf(page, 'Chats', 'All chats');
const membersTable = page => tableOf(page, 'Members', 'All members');
/** An open member's sub-tab: What they can do, Private chat and groups, or Pause or remove. */
const memberPart = (page, name) => page.getByRole('tablist', {name: 'This member'}).getByRole('tab', {name}).click();

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

// A built-in instruction is found by name in its table, a page of them at a time, and edited in a drawer.
async function instruction(page, title) {
  await page.getByRole('searchbox', {name: 'Find an instruction'}).fill(title);
  await page.getByRole('button', {name: 'Edit ' + title, exact: true}).click();
  const drawer = page.getByRole('dialog', {name: title, exact: true});
  await drawer.getByRole('textbox', {name: title, exact: true}).waitFor();
  return drawer;
}
const done = drawer => drawer.getByRole('button', {name: 'Done'}).click();

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
  const {page, problems} = await open('settings?view=telegram&tab=groups');
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
    const {page, problems} = await open('settings?view=telegram&tab=groups');
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
    const {page, problems} = await open('settings?view=telegram&tab=groups');
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
  // A chat's page is four sub-tabs; the role and skills are the second.
  const {page, problems} = await open('chats?chat=-10042');
  await page.getByRole('tab', {name: 'Role and skills'}).click();
  assert.equal(new URL(page.url()).hash, '#chats?chat=-10042&tab=role');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Role and skills'})});
  await card.getByRole('textbox', {name: 'Role'}).fill('You help this group plan stargazing trips.');
  // A skill is a row of the skills table, written in a drawer.
  await card.getByRole('button', {name: 'Add skill'}).click();
  await page.getByRole('dialog', {name: 'New skill'}).waitFor();
  const skill = page.getByRole('dialog');
  await skill.getByRole('textbox', {name: 'Name'}).fill('Kp Forecast');
  await skill.getByRole('textbox', {name: 'When to use it'}).fill('When someone asks about tonight’s aurora.');
  await skill.getByRole('textbox', {name: 'Instructions'}).fill('Give the Kp index and the best viewing hour.');
  await done(skill);
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByText('2 unsaved changes').waitFor();
  // An edit made on one sub-tab is kept, and saved, from another.
  await page.getByRole('tab', {name: 'Access'}).click();
  await bar.getByText('2 unsaved changes').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  // A name Hermes cannot use opens that skill and is explained in place; nothing is saved.
  const bad = page.getByRole('dialog');
  await bad.getByText('Name it with lower-case English letters').waitFor();
  await bad.getByRole('textbox', {name: 'Name'}).fill('kp-forecast');
  await done(bad);
  await bar.getByRole('button', {name: 'Try again'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.goto(origin + '/#chats?chat=-10042&tab=role');
  await page.reload();
  const row = card.getByRole('row').filter({hasText: 'kp-forecast'});
  await row.getByText('When someone asks about tonight’s aurora.').waitFor();
  assert.equal(
    await card.getByRole('textbox', {name: 'Role'}).inputValue(),
    'You help this group plan stargazing trips.',
  );
  const {page: topic} = await open('chats?chat=-10042%2Ftopic%2F7&tab=role');
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
  await mine.getByRole('table', {name: 'Skills in your private chat'}).getByText('weekly-menu').waitFor();
  assert.equal(await groups.getByRole('table').count(), 0, 'groups never start from the private chat’s skills');
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
  await page.goto(origin + '/#chats?chat=-10042&tab=role');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Role and skills'})});
  await card.getByText('The connected assistant can’t do this').waitFor();
  await card.getByText('It doesn’t offer the role and skills.').waitFor();
  assert.equal(await card.getByRole('button', {name: 'Try again'}).count(), 0);
  await page.close();
});

test('a built-in instruction is replaced, checked and reset to the built-in text', async () => {
  const {page, problems} = await open('settings?view=assistant&tab=instructions');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Built-in instructions'})});
  const bar = page.getByRole('region', {name: 'Save changes'});
  // The instructions are a table, a page at a time, never one long list.
  const table = card.getByRole('table', {name: 'Built-in instructions'});
  assert.equal(await table.locator('tbody tr').count(), 12);
  await card.getByRole('button', {name: 'Next'}).waitFor();
  let drawer = await instruction(page, 'Groups');
  await drawer
    .getByRole('textbox', {name: 'Groups'})
    .fill('Reply in Persian and stay quiet with [NO_REPLY] otherwise.');
  await done(drawer);
  drawer = await instruction(page, 'Learning from conversations');
  await drawer.getByRole('textbox', {name: 'Learning from conversations'}).fill('Learn only decisions.');
  await done(drawer);
  await bar.getByText('2 unsaved changes').waitFor();
  await bar.getByRole('button', {name: 'Save'}).click();
  // The values Nocheh fills in cannot be dropped by mistake: the failed save opens the text it is about.
  drawer = page.getByRole('dialog', {name: 'Learning from conversations'});
  await drawer.getByText('Keep {trigger_id} and {citable_ids} in the text').waitFor();
  await drawer
    .getByRole('textbox', {name: 'Learning from conversations'})
    .fill('Learn only decisions from {trigger_id} citing {citable_ids}.');
  await done(drawer);
  await bar.getByRole('button', {name: 'Try again'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  await table.getByText('Changed').first().waitFor();
  assert.equal(await table.getByText('Changed', {exact: true}).count(), 2);
  drawer = await instruction(page, 'Groups');
  await drawer.getByRole('button', {name: 'Reset to built-in'}).click();
  assert.equal(
    await drawer.getByRole('textbox', {name: 'Groups'}).inputValue(),
    'This is a shared space. For routine chatter return exactly [NO_REPLY].',
  );
  await drawer.getByText('Reset when saved').waitFor();
  await done(drawer);
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.getByRole('searchbox', {name: 'Find an instruction'}).fill('');
  assert.equal(await table.getByText('Changed', {exact: true}).count(), 1);
  assert.deepEqual(problems, []);
  await page.close();
});

test('the private answer’s rules, first line, button and notices are built-in instructions the owner can edit', async () => {
  const {page, problems} = await open('settings?view=assistant&tab=instructions');
  const texts = {};
  for (const title of ['Private answers', 'Private answer’s first line', 'Answer privately button and notices']) {
    const drawer = await instruction(page, title);
    const box = drawer.getByRole('textbox', {name: title, exact: true});
    assert.equal(await box.isEditable(), true, title);
    texts[title] = await box.inputValue();
    await done(drawer);
  }
  assert.equal(texts['Private answers'], 'This is a private answer, in the private chat of the person who asked.');
  assert.match(texts['Private answer’s first line'], /\{group\}.*\{groups\}/);
  assert.match(texts['Answer privately button and notices'], /^button: 🔒 Answer privately$/m);
  assert.deepEqual(problems, []);
  await page.close();
});

test('the reminder lines are a built-in instruction, and a line that drops a value Nocheh fills in is refused', async () => {
  const {page, problems} = await open('settings?view=assistant&tab=instructions');
  const bar = page.getByRole('region', {name: 'Save changes'});
  const title = 'Reminder lines: who set it and where';
  let drawer = await instruction(page, title);
  // Its description says so, and so does the text itself.
  await drawer
    .getByText(/at most one message per group every 10 minutes/)
    .first()
    .waitFor();
  const box = drawer.getByRole('textbox', {name: title});
  const text = await box.inputValue();
  assert.match(text, /^set_by: 👤 Set by \{who\} in \{place\}$/m);
  await box.fill(text.replace('set_by: 👤 Set by {who} in {place}', 'set_by: 👤 Set by {who}'));
  await done(drawer);
  await bar.getByRole('button', {name: 'Save'}).click();
  await page
    .getByRole('alert')
    .filter({hasText: 'A “name: text” line lost a value in braces that Nocheh fills in'})
    .first()
    .waitFor();
  // The edit is kept until the owner puts the value back or discards it.
  drawer = await instruction(page, title);
  assert.match(await drawer.getByRole('textbox', {name: title}).inputValue(), /^set_by: 👤 Set by \{who\}$/m);
  await done(drawer);
  await bar.getByRole('button', {name: 'Discard'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  drawer = await instruction(page, title);
  assert.equal(await drawer.getByRole('textbox', {name: title}).inputValue(), text);
  assert.deepEqual(problems, []);
  await page.close();
});

test('long-term memory is re-run or replaced only after the owner sees what it would send', async () => {
  const {page, problems} = await open('memory?view=longterm');
  const status = page.locator('section').filter({has: page.getByRole('heading', {name: 'Long-term memory'})});
  await status.getByText('Engine: Honcho').waitFor();
  // Re-running and looking share the second sub-tab; the choice is in the address.
  await page.getByRole('tab', {name: 'Re-run and look'}).click();
  assert.match(page.url(), /#memory\?view=longterm&tab=actions$/);
  await page.getByRole('heading', {name: 'What it remembers'}).waitFor();
  const card = page.locator('section').filter({has: page.getByRole('heading', {name: 'Re-run or replace'})});
  // The three actions are rows of one table, so the page needs no scrolling to reach them.
  const actions = card.getByRole('table', {name: 'Re-run or replace'});
  assert.deepEqual(
    (await actions.getByRole('rowheader').allTextContents()).map(text => text.trim()),
    ['Retry failed learning', 'Re-learn chats', 'Replace long-term memory'],
  );
  await actions.getByText('3 learning tasks failed.').waitFor();
  await actions.getByRole('button', {name: 'Retry failed learning'}).click();
  await page.getByRole('status').filter({hasText: 'Running 3 learning tasks again.'}).waitFor();
  await actions.getByText('Nothing has failed.').waitFor();
  assert.equal(await actions.getByRole('button', {name: 'Retry failed learning'}).isDisabled(), true);

  // Re-learn opens a dialog that says what it forgets and sends before its button works.
  await actions.getByRole('button', {name: 'Re-learn…'}).click();
  const relearn = page.getByRole('dialog', {name: 'Re-learn chats'});
  await relearn.getByText(/every chat and learns again from 180 saved messages from 5 conversations/).waitFor();
  await relearn.getByRole('radio', {name: 'Chosen chats'}).click();
  const start = relearn.getByRole('button', {name: 'Re-learn', exact: true});
  assert.equal(await start.isDisabled(), true, 'a chat must be chosen first');
  await relearn.getByRole('searchbox', {name: 'Chats to re-learn'}).fill('-10042');
  await relearn.getByRole('listbox', {name: 'Chats to re-learn'}).getByRole('option').first().click();
  await relearn.getByText(/these chats and learns again from 12 saved messages from 1 conversation/).waitFor();
  await start.click();
  await page.getByRole('status').filter({hasText: 'Re-learning 12 saved messages.'}).waitFor();
  await relearn.waitFor({state: 'detached'});

  await actions.getByRole('button', {name: 'Replace…'}).click();
  const replacing = page.getByRole('dialog', {name: 'Replace long-term memory'});
  await replacing.getByText('Up to 212 saved messages you allowed it to learn will be sent again.').waitFor();
  const replace = replacing.getByRole('button', {name: 'Replace long-term memory'});
  assert.equal(await replace.isDisabled(), true, 'replacing waits for the typed confirmation');
  await replacing.getByLabel('Type “replace” to confirm').fill('replace');
  await replace.click();
  await page.getByRole('status').filter({hasText: 'It is learning your saved messages again.'}).waitFor();
  await replacing.waitFor({state: 'detached'});
  assert.deepEqual(problems, []);
  await page.close();
});

test('discard drops unsaved edits', async () => {
  const {page, problems} = await open('settings?view=telegram&tab=groups');
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
  const {page, problems} = await open('settings?view=assistant&tab=jobs');
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
  const other = await open('settings?view=assistant&tab=jobs');
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
  // Providers have their own sub-tab; with one already added the page opens on Models.
  const {page, problems} = await open('settings?view=models');
  const subTabs = page.getByRole('tablist', {name: 'Model settings'});
  await subTabs.getByRole('tab', {name: 'Models', selected: true}).waitFor();
  await subTabs.getByRole('tab', {name: 'Providers'}).click();
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
  await subTabs.getByRole('tab', {name: 'Models'}).click();
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
  await page.getByRole('status').filter({hasText: 'Task added.'}).waitFor();
  const row = await findTask(page, title);
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
  const done = page.getByRole('row').filter({hasText: title});
  await done.getByRole('checkbox', {name: `Reopen “${title}”`}).click();
  await done.waitFor({state: 'detached'});
  await page.getByRole('tab', {name: /^Open/}).click();
  await page.getByRole('row').filter({hasText: title}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a reminder a person set says who and where, keeps its exact time and setter, and you keep up to 10 of your own', async () => {
  const {page, problems} = await open('tasks');
  const title = 'Water the greenhouse plants';
  // The task as the owner API gives it, the way the page reads it.
  const read = id =>
    page.evaluate(async id => {
      const headers = {'X-Nocheh-CSRF': window.__NOCHEH_CSRF__ ?? ''};
      return (await fetch('/api/nocheh/tasks/' + id, {headers})).json();
    }, id);
  const listed = await page.evaluate(async () => {
    const headers = {'X-Nocheh-CSRF': window.__NOCHEH_CSRF__ ?? ''};
    return (await (await fetch('/api/nocheh/tasks', {headers})).json()).tasks;
  });
  const task = listed.find(item => item.title === title);
  const person = task.reminders.find(item => item.set_by === 'person' && item.state === 'pending');
  assert.match(person.at, /:30\.000Z$/, 'set to the second');
  // The server renders who set it and where from the owner's reminder lines; the page has no words of its own for it.
  assert.match(person.source, /^👤 Set by .*Sam Rivera.*, a member in group .*Aurora planning/);
  assert.equal(task.reminders.find(item => item.set_by === 'owner').source, null);
  const posts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nocheh/tasks/' + task.id))
      posts.push(request.postDataJSON());
  });
  await (await findTask(page, title)).getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog');
  // The line shows under the reminder still to come and under the one Telegram refused, which reads Not sent.
  const setBy = dialog.getByText(/Set by .*Sam Rivera.*a member in group .*Aurora planning/);
  await setBy.first().waitFor();
  assert.equal(await setBy.count(), 2);
  await dialog.getByText(/^Not sent · /).waitFor();
  // Nine of the owner's own are set: one more fills the task, and Add turns off.
  const add = dialog.getByRole('button', {name: 'Add reminder'});
  assert.equal(await add.isEnabled(), true);
  await add.click();
  await dialog.getByText('A task keeps up to 10 reminders of your own. Remove one to add another.').waitFor();
  assert.equal(await add.isDisabled(), true);
  await dialog.getByLabel('Reminder 11', {exact: true}).fill('2030-01-04T09:00');
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  // The ones the owner didn't touch go back exactly as stored, the person's to the second; only the new one as typed.
  const stored = task.reminders.filter(item => item.state === 'pending').map(item => item.at);
  assert.deepEqual(posts.at(-1).reminders, [...stored, '2030-01-04T09:00']);
  const saved = await read(task.id);
  const kept = saved.reminders.find(item => item.at === person.at);
  assert.deepEqual({set_by: kept.set_by, source: kept.source}, {set_by: 'person', source: person.source});
  assert.equal(saved.reminders.find(item => item.at === '2030-01-04T09:00:00.000Z').set_by, 'owner');
  assert.equal(await setBy.count(), 2, 'it still names who set it');
  // A new time for the person's reminder makes it the owner's eleventh, which the server refuses in plain words.
  await dialog.getByLabel('Reminder 1', {exact: true}).fill('2030-01-05T09:00');
  assert.equal(await setBy.count(), 1, 'a reminder the owner changed is the owner’s');
  await dialog.getByRole('button', {name: 'Save'}).click();
  await dialog
    .getByText('A task keeps up to 10 reminders of your own, and one save can add at most 10. Remove one first.')
    .waitFor();
  assert.equal((await read(task.id)).reminders.find(item => item.at === person.at).set_by, 'person');
  await dialog.getByRole('button', {name: 'Discard'}).click();
  assert.equal(await setBy.count(), 2);
  assert.deepEqual(problems, []);
  await page.close();
});

test('today, upcoming and the board show tasks by date and status', async () => {
  const {page, problems} = await open('tasks?view=today');
  // Today's tasks are one table, under a line for each day.
  await page.getByRole('row').filter({hasText: 'Pay the rent'}).waitFor();
  await page
    .getByRole('table', {name: 'Tasks'})
    .getByRole('columnheader', {name: /^Today · /})
    .waitFor();
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

test('the board shows four cards a column at a time, and an open chat leads back to the table or on to another chat', async () => {
  const {page, problems} = await open('tasks?view=board');
  const todo = page.getByLabel('Board').getByRole('list', {name: 'To do tasks'});
  await settles(todo.getByRole('listitem'), 4);
  await page.getByText(/^1–4 of \d+$/).waitFor();
  const first = await todo.getByRole('listitem').first().innerText();
  await page.getByRole('button', {name: 'Next To do tasks'}).click();
  await page.getByText(/^5–\d+ of \d+$/).waitFor();
  assert.notEqual(await todo.getByRole('listitem').first().innerText(), first);
  // A chat opens in place of the table of chats; another chat is one choice away, on the same sub-tab.
  await page.goto(origin + '/#chats?chat=-10042&tab=tools');
  await page.getByRole('heading', {name: 'Aurora planning', level: 2}).waitFor();
  assert.equal(await page.getByRole('table', {name: 'Chats'}).count(), 0);
  await page.getByLabel('Open another chat').selectOption(UPGRADED);
  await page.getByRole('heading', {name: 'Garden swap', level: 2}).waitFor();
  await page.getByRole('tab', {name: 'Tools and limits', selected: true}).waitFor();
  await page.getByRole('button', {name: 'All chats'}).click();
  await page.getByRole('table', {name: 'Chats'}).getByRole('link', {name: 'Garden swap'}).waitFor();
  assert.equal(new URL(page.url()).hash, '#chats');
  // Sharing keeps its rules and its defaults on two sub-tabs; a chat's topic memory link opens the defaults.
  await page.goto(origin + '/#chats?chat=-10042&tab=memory');
  assert.equal(
    await page.getByRole('link', {name: 'Change topic memory'}).getAttribute('href'),
    '#chats?view=rules&tab=defaults',
  );
  await page.getByRole('link', {name: 'Change topic memory'}).click();
  await page.getByRole('radiogroup', {name: 'Topic memory'}).waitFor();
  assert.equal(await page.getByRole('table', {name: 'Sharing rules'}).isVisible(), false);
  await page.getByRole('tablist', {name: 'Sharing'}).getByRole('tab', {name: 'Rules'}).click();
  await page
    .getByRole('table', {name: 'Sharing rules'})
    .getByRole('button', {name: 'Trip notes from the topic'})
    .waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('task statuses, priorities and columns are edited in Settings', async () => {
  const {page, problems} = await open('settings?view=tasks');
  const statuses = page.getByRole('list', {name: 'Statuses'});
  await statuses.getByLabel('Status name 3').fill('On hold');
  // Priorities are on the next sub-tab; the status edit is kept while it is shown.
  await page.getByRole('tab', {name: 'Priorities and time zone'}).click();
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
  const {page, problems} = await open('settings?view=privacy&tab=offsite');
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

test('a project has its own Notion: its sign-in and switch are apart from yours, and Nothing asks me is not offered', async () => {
  // ADR-0268: the project's Notion card in Memory › Projects signs in on its own and comes back to Settings › Connections.
  const project = 'memory?view=projects&project=' + 'ab'.repeat(32);
  const {page, problems} = await open(project);
  const drawer = page.getByRole('dialog', {name: 'Aurora field guide'});
  const card = drawer.getByRole('region', {name: 'Notion for this project'});
  await card.getByText('Not connected').waitFor();
  assert.deepEqual(await card.getByLabel('Ask me first').locator('option').allTextContents(), [
    'Reads run, changes ask me',
    'Everything asks me',
  ]);
  await card.getByRole('button', {name: 'Connect Notion'}).click();
  await page.getByRole('status').filter({hasText: 'The project’s Notion is connected.'}).waitFor();
  assert.match(page.url(), /#settings\?view=connections$/);
  await page.getByRole('region', {name: 'Notion', exact: true}).getByText('Not connected').waitFor();
  await page.goto(origin + '/#' + project);
  await card.getByText('Connected to Synthetic workspace').waitFor();
  // In the drawer each change saves at once: the page's Save is behind it.
  await card.getByRole('switch', {name: 'Use this project’s Notion'}).click();
  await card.getByRole('switch', {name: 'Use this project’s Notion', checked: true}).waitFor();
  await card.getByLabel('Ask me first').selectOption({label: 'Everything asks me'});
  await page.waitForResponse(
    response => response.url().endsWith('/api/nocheh/notion') && response.request().method() === 'POST',
  );
  await page.reload();
  await card.getByRole('switch', {name: 'Use this project’s Notion', checked: true}).waitFor();
  assert.equal(await card.getByLabel('Ask me first').inputValue(), 'everything');
  assert.deepEqual(problems, []);
  await page.close();
});

test('GitHub is connected through its own app, lists the chosen repositories, copies one and is disconnected', async () => {
  // GitHub has its own sub-tab, and a sign-in that returns opens it.
  const {page, problems} = await open('settings?view=connections&tab=github');
  const card = page.getByRole('region', {name: 'GitHub'});
  await card.getByText('Not connected').waitFor();
  // A sign-in that comes back while Nocheh is busy keeps its code in the address, so a reload can finish it.
  await page.goto(origin + '/?connect=github&code=preview-busy&state=fixture-state');
  await card.getByText('Reload this page in a minute to finish.', {exact: false}).waitFor();
  assert.equal(new URL(page.url()).search, '?connect=github&code=preview-busy&state=fixture-state');
  problems.splice(0, problems.length, ...problems.filter(problem => !/409/.test(problem)));
  await page.goto(origin + '/#settings?view=connections&tab=github');
  await card.getByText('Not connected').waitFor();
  // GitHub creates the app, then asks which repositories it may read, and each time sends the browser back here.
  await card.getByRole('button', {name: 'Connect GitHub'}).click();
  await page.getByRole('status').filter({hasText: 'GitHub is connected.'}).waitFor();
  await card.getByText('Connected', {exact: true}).waitFor();
  await card.getByText('Nocheh reads through its app Nocheh-a1b2c3 on octo-example', {exact: false}).waitFor();
  assert.equal(new URL(page.url()).search, '');
  assert.match(page.url(), /#settings\?view=connections&tab=github$/);
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

test('a repository is linked to a project from Settings or from the project, and unlinked there', async () => {
  // ADR-0269: by name, copied or not; each change saves at once.
  const {page, problems} = await open('settings?view=connections&tab=github');
  const card = page.getByRole('region', {name: 'GitHub'});
  await card.getByText('Not connected').waitFor();
  await card.getByRole('button', {name: 'Connect GitHub'}).click();
  await page.getByRole('status').filter({hasText: 'GitHub is connected.'}).waitFor();
  const who = card.getByLabel('Who uses example-org/widgets');
  const options = await who.locator('option').allTextContents();
  assert.equal(options[0], 'You only');
  assert.ok(options.includes('Project: Aurora field guide'), options.join());
  await who.selectOption({label: 'Project: Aurora field guide'});
  await page.getByRole('status').filter({hasText: 'Linked to Aurora field guide'}).waitFor();
  const project = 'memory?view=projects&project=' + 'ab'.repeat(32);
  await page.goto(origin + '/#' + project);
  const github = page
    .getByRole('dialog', {name: 'Aurora field guide'})
    .getByRole('region', {name: 'GitHub for this project'});
  const listed = github.getByRole('list', {name: 'This project’s repositories'});
  await listed.getByText('example-org/widgets').waitFor();
  await github.getByLabel('Repository to link').selectOption({label: 'example-org/gadgets'});
  await github.getByRole('button', {name: 'Link', exact: true}).click();
  await listed.getByText('example-org/gadgets').waitFor();
  await listed
    .getByRole('listitem')
    .filter({hasText: 'example-org/widgets'})
    .getByRole('button', {name: 'Unlink'})
    .click();
  await page.getByRole('status').filter({hasText: 'example-org/widgets is yours only now'}).waitFor();
  await page.reload();
  await listed.getByText('example-org/gadgets').waitFor();
  assert.equal(await listed.getByText('example-org/widgets').count(), 0);
  await page.goto(origin + '/#settings?view=connections&tab=github');
  assert.equal(await card.getByLabel('Who uses example-org/widgets').inputValue(), '');
  // Back as the next test expects it: not connected.
  await card.getByRole('button', {name: 'Disconnect'}).click();
  await page.getByRole('dialog', {name: 'Disconnect GitHub?'}).getByRole('button', {name: 'Disconnect'}).click();
  await card.getByText('Not connected').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a machine is added with its public key, tested, edited, turned off and removed, and its commands are in the log', async () => {
  const {page, problems} = await open('settings?view=machines');
  const card = page.getByRole('region', {name: 'Machines'});
  // The machines are rows of one table.
  const list = card.getByRole('table', {name: 'Machines'});
  const row = name => list.locator('tbody tr').filter({has: page.getByText(name, {exact: true})});
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

  // Background work lists the job with its machine; its drawer shows the plan its card showed and links to its commands.
  await page.goto(origin + '/#system?view=work');
  const jobs = page.getByRole('table', {name: 'Background jobs'});
  const job = jobs.getByRole('row').filter({hasText: 'Set up the garden site on build-vm'});
  await job.waitFor();
  assert.match(await job.textContent(), / · on build-vm · started /);
  await job.getByRole('button', {name: 'Set up the garden site on build-vm', exact: true}).click();
  const detail = page.getByRole('dialog', {name: 'Set up the garden site on build-vm'});
  assert.deepEqual(
    (await detail.getByRole('list', {name: 'Plan'}).getByRole('listitem').allTextContents()).map(text => text.trim()),
    [
      'Install git and the build tools',
      'Copy the project into ~/projects/garden-site',
      'Install its packages and run its tests',
      'Start it and check that it answers on port 8080',
    ],
  );
  assert.deepEqual(
    (await detail.getByRole('list', {name: 'To-do list'}).getByRole('listitem').allTextContents()).map(text =>
      text.trim(),
    ),
    ['Install git and the build tools', 'Copy the project into ~/projects/garden-site'],
  );
  await detail.getByRole('button', {name: 'Close'}).click();
  // Stop says that it ends the programs on the machine too; Cancel leaves the job running.
  await job.getByRole('button', {name: 'Stop'}).click();
  const stop = page.getByRole('dialog', {name: 'Stop this job?'});
  await stop.getByText('Nocheh also ends the programs it started on build-vm.', {exact: false}).waitFor();
  await stop.getByRole('button', {name: 'Cancel'}).click();
  // A machine job still waiting has run nothing there, and Stop says so.
  const waiting = jobs.getByRole('row').filter({hasText: 'Rotate the logs on build-vm'});
  await waiting.getByRole('button', {name: 'Stop'}).click();
  await stop.getByText('The job is cancelled before it starts.', {exact: false}).waitFor();
  await stop.getByText('Nothing has run on build-vm yet.', {exact: false}).waitFor();
  assert.equal(await stop.getByText('The running job', {exact: false}).count(), 0);
  assert.equal(await stop.getByText('ends the programs it started', {exact: false}).count(), 0);
  await stop.getByRole('button', {name: 'Cancel'}).click();
  // Programs Nocheh couldn't end are the owner's to end.
  await jobs
    .getByRole('row')
    .filter({hasText: 'Build the photo gallery on build-vm'})
    .getByText('Nocheh couldn’t end its programs on build-vm. End them yourself.')
    .waitFor();
  await job.getByRole('button', {name: 'Set up the garden site on build-vm', exact: true}).click();
  await detail.getByRole('link', {name: 'Commands it ran on build-vm'}).click();
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
  const added = await findTask(page, title);
  await added.getByText('Urgent').waitFor();
  // A task points to a group and to people from its edit dialog.
  await added.getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option', {name: /Aurora planning\s*Group/}).click();
  await dialog.locator('#task-panel-people').selectOption({label: 'Devon'});
  await dialog.getByRole('button', {name: 'Remove tag Urgent'}).click();
  await dialog.getByRole('button', {name: 'Save'}).click();
  // A group's task is seen only in that group, and the group isn't in this project yet: the owner is told first.
  const ask = page.getByRole('dialog', {name: 'Move to Aurora planning?'});
  await ask
    .getByText(/Aurora planning isn’t in this project, so only you see this task until you add that group to it\./)
    .waitFor();
  await ask.getByRole('button', {name: 'Move'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  await dialog.getByRole('button', {name: 'Close'}).click();
  await dialog.waitFor({state: 'detached'});
  await added.getByText('Aurora planning').waitFor();
  await added.getByText('Devon').waitFor();
  await added.getByText('Urgent').waitFor({state: 'detached'});
  await page.getByLabel('Search tasks').fill('');
  await lists.getByRole('radio', {name: /Personal/}).click();
  await page.getByText('Book a dentist checkup').waitFor();
  // A project task stays out of the personal list.
  await page.getByText(title).waitFor({state: 'detached'});
  await lists.getByRole('radio', {name: 'All', exact: true}).click();
  await page.getByRole('radiogroup', {name: 'Tag'}).getByRole('radio', {name: 'Health'}).click();
  await page.getByText('Book a dentist checkup').waitFor();
  // A tag narrows the list.
  await page.getByText('Send the garden supplier the measurements').waitFor({state: 'detached'});
  // The table has the same columns on every row; cards show the same tasks, and the choice is remembered.
  assert.deepEqual(
    (await page.getByRole('table', {name: 'Tasks'}).getByRole('columnheader').allInnerTexts()).map(text => text.trim()),
    ['Done', 'Task', 'Status', 'Priority', 'Due', 'List', 'Actions'],
  );
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

test('a group’s task in a project names only that group, and a subtask follows its parent’s group', async () => {
  const {page, problems} = await open('tasks');
  await page
    .getByRole('radiogroup', {name: 'List'})
    .getByRole('radio', {name: /Studio launch/})
    .click();
  const title = 'Bring the extension cords ' + Date.now();
  await page.getByLabel('New task').fill(title);
  await page.getByRole('button', {name: 'Add'}).click();
  const added = await findTask(page, title);
  await added.getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog').filter({has: page.locator('#task-panel-list')});
  await dialog.getByText('Every group in the project sees it. Choose a group to keep it to that group.').waitFor();
  await dialog.getByRole('option', {name: /Aurora planning\s*Group/}).click();
  await dialog.getByText('Only Aurora planning sees it in this project.').waitFor();
  await dialog.getByRole('button', {name: 'Save'}).click();
  // Changing the group asks first, and names only that group.
  const ask = page.getByRole('dialog', {name: 'Move to Aurora planning?'});
  await ask
    .getByText(
      /^People in Aurora planning will see this task from now on\. Other groups in this project don’t see it\. Earlier comments/,
    )
    .waitFor();
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await ask.waitFor({state: 'detached'});
  await dialog.getByRole('button', {name: 'Save'}).click();
  await ask.getByRole('button', {name: 'Move'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  // A subtask belongs to its parent's group: its own group can't be chosen.
  await dialog.getByLabel('New subtask').fill('Count the plugs');
  await dialog.getByLabel('New subtask').press('Enter');
  await dialog.getByRole('list', {name: 'Subtasks'}).getByRole('button', {name: 'Count the plugs'}).click();
  const sub = page.getByRole('dialog').filter({has: page.locator('#task-panel-list')});
  await sub.getByText('Follows its parent task.').waitFor();
  assert.equal(await sub.getByPlaceholder('Search by name or Telegram ID').isDisabled(), true);
  assert.equal(await sub.getByRole('button', {name: 'Remove Aurora planning'}).isDisabled(), true);
  assert.deepEqual(problems, []);
  await page.close();
});

test('moving a task into a project’s list names the chats that will see it first', async () => {
  const {page, problems} = await open('tasks');
  const title = 'Ask for the studio keys ' + Date.now();
  await page.getByLabel('New task').fill(title);
  await page.getByRole('button', {name: 'Add'}).click();
  const added = await findTask(page, title);
  await added.getByRole('button', {name: `Edit “${title}”`}).click();
  const panel = page.getByRole('dialog').filter({has: page.locator('#task-panel-list')});
  await panel.locator('#task-panel-list').selectOption({label: 'Studio launch'});
  await panel.getByRole('button', {name: 'Save'}).click();
  const ask = page.getByRole('dialog', {name: 'Move to Studio launch?'});
  await ask
    .getByText(
      /People in Aurora planning will see this task from now on, and so will chats you add to this project later\. Earlier comments and history/,
    )
    .waitFor();
  // Cancel keeps the task where it was.
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await ask.waitFor({state: 'detached'});
  assert.equal(await panel.locator('#task-panel-list').inputValue(), '8'.repeat(64), 'the choice stays unsaved');
  await panel.getByRole('button', {name: 'Save'}).click();
  await ask.getByRole('button', {name: 'Move'}).click();
  await page.getByRole('status').filter({hasText: 'Task saved.'}).waitFor();
  // A column stays private to the owner until it is shared with project chats.
  await page.goto(origin + '/#settings?view=tasks&tab=columns');
  await page.getByRole('button', {name: 'Add column'}).click();
  const columns = page.getByRole('list', {name: 'Your columns'});
  const shared = columns
    .getByRole('listitem')
    .last()
    .getByRole('checkbox', {name: 'Project chats can see this column'});
  assert.equal(await shared.isChecked(), false);
  const effort = 'Effort ' + String(Date.now()).slice(-4);
  await columns.getByRole('listitem').last().getByRole('textbox').first().fill(effort);
  // Sharing it names every project's chats first, and says the values already in it show there too.
  const share = page.getByRole('dialog', {name: `Let project chats see “${effort}”?`});
  await shared.click();
  await share
    .getByText(
      `People in each project’s chats will see “${effort}” on that project’s tasks, with every value already in it, also what was written before a task joined a project’s list: Studio launch (Aurora planning).`,
      {exact: false},
    )
    .waitFor();
  await share.getByRole('button', {name: 'Cancel'}).click();
  await share.waitFor({state: 'detached'});
  assert.equal(await shared.isChecked(), false, 'cancelled, it stays private');
  await shared.click();
  await share.getByRole('button', {name: 'Let them see it'}).click();
  await share.waitFor({state: 'detached'});
  assert.equal(await shared.isChecked(), true);
  const bar = page.getByRole('region', {name: 'Save changes'});
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('No unsaved changes').waitFor();
  await page.reload();
  assert.equal(
    await page
      .getByRole('list', {name: 'Your columns'})
      .getByRole('listitem')
      .last()
      .getByRole('checkbox', {name: 'Project chats can see this column'})
      .isChecked(),
    true,
  );
  assert.deepEqual(problems, []);
  await page.close();
});

test('a project shares its group chats only by its switch, and a group joins one only after seeing the groups already there', async () => {
  // No box makes groups share (ADR-0247); the project's "Share group chats" switch does, on by default (ADR-0267).
  const {page, problems} = await open('memory?view=projects&project=' + 'ab'.repeat(32));
  const drawer = page.getByRole('dialog', {name: 'Aurora field guide'});
  await drawer.getByRole('button', {name: 'Edit'}).click();
  const dialog = page.getByRole('dialog', {name: 'Edit project'});
  await dialog.getByText('Put only related groups in one project; keep family groups out of projects.').waitFor();
  assert.equal(await dialog.getByRole('checkbox').count(), 0, 'no box makes a project share');
  const share = dialog.getByRole('switch', {name: 'Share group chats'});
  assert.equal(await share.getAttribute('aria-checked'), 'true', 'the project shares its group chats');
  await share.click();
  await dialog.getByText('Off: an answer in a group uses only that group.').waitFor();
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await dialog.waitFor({state: 'detached'});
  assert.equal(await page.getByText('Shares', {exact: true}).count(), 0);
  // A topic follows its group, so only a whole group joins.
  const search = drawer.getByPlaceholder('Search by name or Telegram ID');
  await search.fill('Meteor watch');
  await drawer.getByText('Only whole groups can be chosen here.', {exact: false}).waitFor();
  // Adding a group names the groups already there first, then private answers, then the task list. A group is found
  // by its Telegram ID too, and chosen from the list: an id is never typed in (ADR-0252).
  await search.fill('-10073');
  assert.equal(await drawer.getByRole('button', {name: /Use the ID/}).count(), 0);
  await drawer.getByRole('option', {name: /Weekend notes/}).click();
  await drawer.getByRole('button', {name: 'Add', exact: true}).click();
  const ask = page.getByRole('dialog', {name: /^Add .+ to Aurora field guide\?$/});
  await ask.getByText('Already in Aurora field guide: Aurora planning.').waitFor();
  const text = await ask.textContent();
  const order = [
    'Already in Aurora field guide',
    'Everyone in these groups, members or not, can see answers built from all of them.',
    'Put only related groups in one project',
    'will see and, where they may write tasks, change the tasks set on the whole of Aurora field guide, never another group’s own tasks.',
  ].map(part => text.indexOf(part));
  assert.ok(
    order.every((at, index) => at >= 0 && (!index || at > order[index - 1])),
    'other groups come first',
  );
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await ask.waitFor({state: 'detached'});
  // Removing a group asks first and says its tasks stay on this project's list, where only the owner sees them.
  const removed = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nocheh/projects/assignments'))
      removed.push(request);
  });
  const member = drawer
    .getByRole('listitem')
    .filter({hasText: 'Aurora planning'})
    .getByRole('button', {name: 'Remove', exact: true});
  await member.click();
  const removing = page.getByRole('dialog', {name: 'Remove Aurora planning from Aurora field guide?'});
  await removing
    .getByText('Its tasks, and its topics’ tasks, stay on Aurora field guide’s list, where only you see them.', {
      exact: false,
    })
    .waitFor();
  await removing.getByRole('button', {name: 'Cancel'}).click();
  await removing.waitFor({state: 'detached'});
  assert.equal(await member.count(), 1, 'cancelled, it stays in the project');
  assert.equal(removed.length, 0, 'nothing is saved before the confirm');
  await page.close();

  // Adding a group that is in another project moves it, and says its tasks move with it.
  const moving = await browser.newPage({viewport: {width: 1440, height: 900}});
  await moving.route(/\/api\/nocheh\/projects\/assignments\?after=$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        assignments: [
          {space_id: '-10042', project_id: 'ab'.repeat(32), mode: 'assigned', revision: 1},
          {space_id: '-10073', project_id: 'cd'.repeat(32), mode: 'assigned', revision: 2},
        ],
        next: null,
      }),
    }),
  );
  await moving.goto(origin + '/#memory?view=projects&project=' + 'ab'.repeat(32));
  const movingDrawer = moving.getByRole('dialog', {name: 'Aurora field guide'});
  await movingDrawer.getByPlaceholder('Search by name or Telegram ID').fill('Weekend');
  await movingDrawer.getByRole('option', {name: /Weekend notes/}).click();
  await movingDrawer.getByRole('button', {name: 'Add', exact: true}).click();
  const moveHere = moving.getByRole('dialog', {name: /^Move .+\?$/});
  await moveHere.getByText('It is in Garden redesign now.', {exact: false}).waitFor();
  await moveHere
    .getByText('Its tasks, and its topics’ tasks, move with it from Garden redesign to Aurora field guide.')
    .waitFor();
  await moveHere.getByRole('button', {name: 'Cancel'}).click();
  await moving.close();

  // A group's card says its project's groups read each other while it shares, and moving it asks first, naming the groups in the
  // other project.
  const {page: chat, problems: chatProblems} = await open('chats?chat=-10042&tab=memory');
  const card = chat.locator('section', {has: chat.getByRole('heading', {name: 'Project', exact: true})});
  await card
    .getByText('While it shares its group chats, an answer in any of its groups can use all of them.', {
      exact: false,
    })
    .waitFor();
  assert.equal(await chat.getByRole('switch', {name: /Don’t share into/}).count(), 0);
  assert.equal(await chat.locator('#chat-project option', {hasText: '· shares'}).count(), 0);
  await chat.locator('#chat-project').selectOption({label: 'Garden redesign'});
  const move = chat.getByRole('dialog', {name: 'Move Aurora planning to Garden redesign?'});
  await move.getByText('No other group is in Garden redesign yet.').waitFor();
  await move
    .getByText('Its tasks, and its topics’ tasks, move with it from Aurora field guide to Garden redesign.')
    .waitFor();
  await move.getByRole('button', {name: 'Cancel'}).click();
  assert.equal(await chat.locator('#chat-project').inputValue(), 'ab'.repeat(32));
  // "No project" asks first too, and says the group's tasks stay on the old list, where only the owner sees them.
  const leftPosted = [];
  await chat.route(/\/api\/nocheh\/projects\/assignments$/, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    leftPosted.push(body);
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({...body, revision: 9})});
  });
  await chat.locator('#chat-project').selectOption({label: 'No project'});
  const leave = chat.getByRole('dialog', {name: 'Remove Aurora planning from Aurora field guide?'});
  await leave
    .getByText('Its tasks, and its topics’ tasks, stay on Aurora field guide’s list, where only you see them.', {
      exact: false,
    })
    .waitFor();
  await leave.getByRole('button', {name: 'Cancel'}).click();
  await leave.waitFor({state: 'detached'});
  assert.equal(await chat.locator('#chat-project').inputValue(), 'ab'.repeat(32));
  assert.equal(leftPosted.length, 0, 'nothing is saved before the confirm');
  await chat.locator('#chat-project').selectOption({label: 'No project'});
  await leave.getByRole('button', {name: 'Remove'}).click();
  await chat.getByRole('status').filter({hasText: 'Removed from its project.'}).waitFor();
  assert.deepEqual(
    leftPosted.map(({space_id, mode, project_id}) => ({space_id, mode, project_id})),
    [{space_id: '-10042', mode: 'none', project_id: null}],
  );
  await chat.close();

  // A topic's card only says which project it follows.
  const {page: topic, problems: topicProblems} = await open('chats?chat=-10042%2Ftopic%2F7&tab=memory');
  const topicCard = topic.locator('section', {has: topic.getByRole('heading', {name: 'Project', exact: true})});
  await topicCard.locator('p', {hasText: 'Follows Aurora planning’s project: Aurora field guide.'}).waitFor();
  assert.equal(await topic.locator('#chat-project').count(), 0, 'a topic has no project of its own');
  await topic.close();

  // A served group with no answer yet asks which project it joins; None is saved as an answer.
  const unanswered = await browser.newPage({viewport: {width: 1440, height: 900}});
  const posted = [];
  await unanswered.route(/\/api\/nocheh\/projects\/effective\?space=-10042$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({space: '-10042', own_assignment: null, assignment: null, project: null, inherited: false}),
    }),
  );
  await unanswered.route(/\/api\/nocheh\/projects\/assignments$/, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({status: 200, contentType: 'application/json', body: '{"space_id":"-10042","mode":"none"}'});
  });
  // The question is on the chat's last sub-tab, which is marked while it waits.
  await unanswered.goto(origin + '/#chats?chat=-10042');
  const marked = unanswered.getByRole('tab', {name: 'Memory and project 1'});
  await marked.click();
  const question = unanswered.getByRole('status').filter({hasText: 'Which project does this group join?'});
  await question.waitFor();
  await question.getByRole('button', {name: 'None'}).click();
  await unanswered.getByRole('status').filter({hasText: 'Joins no project.'}).waitFor();
  const sent = list =>
    list.map(({space_id, mode, project_id, expected_revision}) => ({space_id, mode, project_id, expected_revision}));
  assert.deepEqual(sent(posted), [{space_id: '-10042', mode: 'none', project_id: null, expected_revision: 0}]);
  await unanswered.close();

  // A group that only follows no project (an older removal or an undo) has not answered either.
  const following = await browser.newPage({viewport: {width: 1440, height: 900}});
  const followingPosted = [];
  const inheritRow = space => ({space_id: space, project_id: null, mode: 'inherit', revision: 3});
  for (const space of ['-10042', '-10073'])
    await following.route(new RegExp('/api/nocheh/projects/effective\\?space=' + space + '$'), route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          space,
          own_assignment: inheritRow(space),
          assignment: null,
          project: null,
          inherited: false,
        }),
      }),
    );
  await following.route(/\/api\/nocheh\/projects\/assignments$/, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    followingPosted.push(body);
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({...body, revision: 4})});
  });
  await following.goto(origin + '/#chats?chat=-10042&tab=memory');
  const asked = following.getByRole('status').filter({hasText: 'Which project does this group join?'});
  await asked.getByRole('button', {name: 'None'}).click();
  await following.getByRole('status').filter({hasText: 'Joins no project.'}).waitFor();
  assert.deepEqual(sent(followingPosted), [{space_id: '-10042', mode: 'none', project_id: null, expected_revision: 3}]);
  // Turning Nocheh on there asks first too, and sends the answer with the switch, in one request (ADR-0253).
  const switched = [];
  await following.route(/\/api\/nocheh\/chats\/state$/, route => {
    const body = route.request().postDataJSON();
    switched.push(body);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({chat_id: body.chat_id, state: body.state, project_id: null}),
    });
  });
  await following.goto(origin + '/#chats?chat=-10073');
  const followingSwitch = following.getByRole('switch', {name: 'Nocheh in this group'});
  await followingSwitch.click();
  const followingJoin = following.getByRole('dialog', {name: 'Which project does this group join?'});
  await followingJoin.locator('#join-project').selectOption({label: 'None'});
  await followingJoin.getByRole('button', {name: 'Turn on'}).click();
  await following.getByRole('status').filter({hasText: 'Weekend notes joins no project.'}).waitFor();
  assert.deepEqual(
    switched.map(({chat_id, state, project}) => ({chat_id, state, project})),
    [{chat_id: '-10073', state: 'active', project: {mode: 'none'}}],
  );
  assert.equal(followingPosted.length, 1, 'no separate assignment is saved');
  await following.close();

  // A group already in a project names that project's other groups and its task list before Nocheh turns on there,
  // since it then joins them.
  const placed = await browser.newPage({viewport: {width: 1440, height: 900}});
  const placedRow = {space_id: '-10073', project_id: 'ab'.repeat(32), mode: 'assigned', revision: 4};
  await placed.route(/\/api\/nocheh\/projects\/effective\?space=-10073$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        space: '-10073',
        own_assignment: placedRow,
        assignment: placedRow,
        project: {id: 'ab'.repeat(32), name: 'Aurora field guide', description: '', state: 'active', revision: 1},
        inherited: false,
      }),
    }),
  );
  const placedSent = [];
  placed.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nocheh/chats/state'))
      placedSent.push(request.postDataJSON());
  });
  await placed.goto(origin + '/#chats?chat=-10073');
  const placedSwitch = placed.getByRole('switch', {name: 'Nocheh in this group'});
  await placedSwitch.click();
  const turnOn = placed.getByRole('dialog', {name: 'Turn Nocheh on in Weekend notes?'});
  await turnOn.getByText('Already in Aurora field guide: Aurora planning.').waitFor();
  await turnOn
    .getByText('Everyone in these groups, members or not, can see answers built from all of them.', {exact: false})
    .waitFor();
  await turnOn
    .getByText('the tasks set on the whole of Aurora field guide, never another group’s own', {exact: false})
    .waitFor();
  await turnOn.getByRole('button', {name: 'Cancel'}).click();
  await turnOn.waitFor({state: 'detached'});
  assert.equal(await placedSwitch.isChecked(), false, 'Cancel leaves it off');
  assert.equal(placedSent.length, 0, 'nothing is sent before the confirm');
  await placedSwitch.click();
  await turnOn.getByRole('button', {name: 'Turn on'}).click();
  await placed.getByRole('switch', {name: 'Nocheh in this group', checked: true}).waitFor();
  assert.equal(await placed.getByRole('dialog', {name: 'Which project does this group join?'}).count(), 0);
  // Turning it off asks first: Nocheh stays in the group, silent, and its members keep their switches.
  await placed.getByRole('switch', {name: 'Nocheh in this group', checked: true}).click();
  const turnOff = placed.getByRole('dialog', {name: 'Turn Nocheh off in “Weekend notes”?'});
  await turnOff.getByText('It stays in the group, silent. Its members keep their switches.').waitFor();
  await turnOff.getByRole('button', {name: 'Turn off'}).click();
  await placed.getByRole('switch', {name: 'Nocheh in this group', checked: false}).waitFor();
  // A group already in a project keeps it: the switch sends no project.
  assert.deepEqual(
    placedSent.map(({chat_id, state, project}) => ({chat_id, state, project})),
    [
      {chat_id: '-10073', state: 'active', project: undefined},
      {chat_id: '-10073', state: 'off', project: undefined},
    ],
  );
  await placed.close();

  // Turning Nocheh on in a group asks which project it joins first; Cancel leaves it off. A new project named after the
  // group is offered beside the owner's own.
  const {page: off, problems: offProblems} = await open('chats?chat=-10073');
  const offSent = [];
  await off.route(/\/api\/nocheh\/chats\/state$/, route => {
    const body = route.request().postDataJSON();
    offSent.push(body);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({chat_id: body.chat_id, state: body.state, project_id: body.project.project_id}),
    });
  });
  const on = off.getByRole('switch', {name: 'Nocheh in this group'});
  await on.click();
  const join = off.getByRole('dialog', {name: 'Which project does this group join?'});
  await join.getByRole('button', {name: 'Cancel'}).click();
  await join.waitFor({state: 'detached'});
  assert.equal(await on.isChecked(), false, 'nothing turns on without an answer');
  assert.equal(offSent.length, 0);
  await on.click();
  const options = await join.locator('#join-project option').allTextContents();
  assert.deepEqual(options.slice(0, 3), ['Choose a project…', 'New project “Weekend notes”', 'None']);
  assert.ok(options.includes('Aurora field guide') && !options.includes('Old apartment move'), options.join(', '));
  await join.locator('#join-project').selectOption({label: 'Aurora field guide'});
  await join.getByText('Already in Aurora field guide: Aurora planning.').waitFor();
  await join
    .getByText('Everyone in these groups, members or not, can see answers built from all of them.', {exact: false})
    .waitFor();
  await join.getByRole('button', {name: 'Turn on'}).click();
  await off.getByRole('status').filter({hasText: 'Weekend notes joins Aurora field guide.'}).waitFor();
  assert.deepEqual(
    offSent.map(({chat_id, state, project}) => ({chat_id, state, project})),
    [{chat_id: '-10073', state: 'active', project: {mode: 'assigned', project_id: 'ab'.repeat(32)}}],
  );
  // The switch is no setting: nothing waits to be saved.
  await off.getByRole('region', {name: 'Save changes'}).getByText('No unsaved changes').waitFor();
  await off.close();

  // A suggested move names the groups already in the project before the owner decides.
  const {page: review, problems: reviewProblems} = await open('inbox?kind=knowledge&decision=' + 'f'.repeat(64));
  const proposal = review.getByRole('dialog');
  await proposal.getByText('This moves a group into or out of a project').waitFor();
  await proposal.getByText('Already in Aurora field guide: Aurora planning.').waitFor();
  await proposal
    .getByText('While a project shares its group chats, everyone in its groups, members or not, can see answers', {
      exact: false,
    })
    .waitFor();
  await review.close();

  // Sharing rules are the owner's own, and a rule names who will see what it lets in.
  const {page: rules, problems: ruleProblems} = await open('chats?view=rules');
  assert.equal(await rules.getByText(/Set by project/).count(), 0);
  await rules.getByRole('button', {name: 'New rule'}).click();
  const rule = rules.getByRole('dialog', {name: 'New sharing rule'});
  await rule
    .getByText('You and every member in the chat you share into, its topics included, will see what this rule lets in.')
    .waitFor();
  // A rule into a topic names its group: everyone there reads every topic, and the group's memory is shared.
  const into = rule.getByRole('listbox', {name: 'Into this chat'});
  const audience = 'You and every member in Aurora planning, its topics included, will see what this rule lets in.';
  await into.getByRole('option', {name: /^Iceland planning/}).click();
  await rule.getByText(audience).waitFor();
  assert.equal(await rule.getByText(/every member in Iceland planning/).count(), 0);
  await into.getByRole('option', {name: /^Aurora planning/}).click();
  await rule.getByText(audience).waitFor();
  assert.deepEqual(
    [...problems, ...chatProblems, ...topicProblems, ...offProblems, ...reviewProblems, ...ruleProblems],
    [],
  );
  await rules.close();
});

test('a project lists its Answer privately buttons: where, what the answer could read and what became of it', async () => {
  const {page, problems} = await open('memory?view=projects&project=' + 'ab'.repeat(32));
  const drawer = page.getByRole('dialog', {name: 'Aurora field guide'});
  const section = drawer.locator('section', {has: page.getByRole('heading', {name: 'Private answers'})});
  const rows = section.getByRole('listitem');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  const answered = rows.filter({hasText: 'Answered'});
  await answered.getByText('Aurora planning › Iceland planning').waitFor();
  await answered.getByText('Could read: Aurora planning, Group -10077').waitFor();
  assert.equal(
    await answered.getByRole('link', {name: 'The question'}).getAttribute('href'),
    '#messages?source=' + '1'.repeat(64),
  );
  const refused = rows.filter({hasText: 'Refused'});
  await refused.getByText('(the project’s groups or the question changed)').waitFor();
  assert.equal(await refused.getByText(/^Could read/).count(), 0, 'nothing was frozen without a tap');
  assert.deepEqual(problems, []);
  await page.close();
});

test('Notes names a private answer’s profile by where it was asked and the day it ran', async () => {
  const {page, problems} = await open('memory?view=notes');
  const select = page.locator('#notes-profile');
  await select.waitFor();
  const labels = await select.locator('option').allTextContents();
  const day = await page.evaluate(() => new Date('2026-11-12T10:00:00+00:00').toLocaleDateString());
  assert.ok(
    labels.includes('Private answer · “Aurora planning” › Iceland planning · ' + day),
    'named from its receipt: ' + labels.join(' | '),
  );
  assert.ok(labels.includes('Private answer · ' + 'b2'.repeat(3)), 'one from before the receipt keeps its short tail');
  assert.deepEqual(problems, []);
  await page.close();
});

test('Notes lists past conversations as a table, each named by its title or first message, a page at a time', async () => {
  const {page, problems} = await open('memory?view=notes&tab=conversations');
  const table = page.getByRole('table', {name: 'Past conversations'});
  const chat = table.getByRole('row').filter({hasText: 'Private chat'});
  await chat.getByText('Where can we see the northern lights?').waitFor();
  // A conversation without a title is named by its first message, never "Untitled".
  await table.getByRole('button', {name: 'Planning a stargazing trip'}).waitFor();
  assert.equal(await page.getByText(/Untitled/).count(), 0);
  assert.equal(await table.getByRole('row').count(), 11, 'a header and ten conversations');
  await page.getByRole('button', {name: 'Older', exact: true}).click();
  await table.getByRole('button', {name: 'Older question 9'}).waitFor();
  assert.equal(await table.getByRole('row').count(), 3);
  await page.getByRole('button', {name: 'Newer', exact: true}).click();
  // Working notes are a table too, on their own sub-tab, each note with where it came from.
  const parts = page.getByRole('tablist', {name: 'Assistant notes'});
  await parts.getByRole('tab', {name: 'General notes'}).click();
  const notes = page.getByRole('table', {name: 'General notes'});
  await notes
    .getByRole('row')
    .filter({hasText: 'Alice is planning a trip to Iceland.'})
    .getByText(/forwarded/)
    .waitFor();
  await parts.getByRole('tab', {name: 'Past conversations'}).click();
  await table.getByRole('button', {name: 'Planning a stargazing trip'}).click();
  await page.getByRole('dialog', {name: 'Planning a stargazing trip'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('turning automatic organizing on is what lets it create projects, with no separate switch', async () => {
  const {page, problems} = await open('memory?view=projects');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Automatic organizing'})});
  const row = card.getByRole('row').filter({hasText: 'Organize the travel group'});
  await row.waitFor();
  assert.equal(await row.getByText('may create projects', {exact: false}).count(), 0);
  await row.getByRole('button', {name: 'Edit'}).click();
  const dialog = page.getByRole('dialog', {name: 'Automatic organizing'});
  await dialog
    .getByText('While it is on, Nocheh may create projects from what it learns in these chats', {exact: false})
    .waitFor();
  assert.equal(await dialog.getByRole('switch', {name: 'May create new projects'}).count(), 0);
  // The preview refuses a save that still sends the old switch, as the server does.
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Saved.'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the owner’s private chat stays out of sharing rules and projects', async () => {
  // A rule picks only groups and topics; an older rule that names a private chat is flagged.
  const {page: rules, problems} = await open('chats?view=rules');
  const legacy = rules.getByRole('row').filter({hasText: 'Notes from my chat'});
  await legacy.getByText('Reads a private chat. Nocheh skips it.').waitFor();
  // That older rule can still be turned off as it is.
  await legacy.getByRole('switch', {name: 'Turn off Notes from my chat'}).click();
  await rules.getByRole('status').filter({hasText: 'Rule turned off.'}).waitFor();
  await rules.getByRole('button', {name: 'New rule'}).click();
  const dialog = rules.getByRole('dialog', {name: 'New sharing rule'});
  const from = dialog.getByRole('listbox', {name: 'Share facts from'});
  await from
    .getByRole('option', {name: /Aurora planning/})
    .first()
    .waitFor();
  assert.equal(await from.getByRole('option', {name: /You|Mira Chen/}).count(), 0);
  const search = dialog.getByPlaceholder('Search by name or Telegram ID').first();
  await search.fill('42');
  await from
    .getByRole('option', {name: /Aurora planning/})
    .first()
    .waitFor();
  assert.equal(await from.getByRole('option', {name: /You/}).count(), 0);
  assert.equal(await from.getByRole('button', {name: /Use the ID/}).count(), 0);
  await search.fill('Mira');
  await from.getByText('Only groups and topics can be chosen here, never a private chat.').waitFor();
  assert.equal(await from.getByRole('button', {name: /Use the ID/}).count(), 0);
  await rules.close();

  // The owner's chat page offers no project, and clears one an older setting still names.
  const {page: own, problems: ownProblems} = await open('chats?chat=42&tab=memory');
  const older = own.getByRole('status').filter({hasText: 'An older setting puts this chat in a project'});
  await older.getByText('Nocheh ignores the setting that puts it in Aurora field guide.', {exact: false}).waitFor();
  assert.equal(await own.locator('#chat-project').count(), 0);
  await own.getByRole('button', {name: 'Remove it'}).click();
  await own.getByRole('status').filter({hasText: 'Removed from its project.'}).waitFor();
  await own.getByText('Your private chat never joins a project.', {exact: true}).waitFor();
  assert.equal(await own.getByRole('button', {name: 'Remove it'}).count(), 0);
  assert.deepEqual([...problems, ...ownProblems], []);
  await own.close();
});

test('a group first seen after the new ids and a group Telegram upgraded open like any other, with their Telegram IDs', async () => {
  const {page, problems} = await open('chats');
  const list = chatsTable(page);
  const search = page.getByPlaceholder('Find a chat by name or Telegram ID');
  // A chat is found by any Telegram ID it has had, and its page names the current one and the earlier one.
  await search.fill('-4005');
  await list.table.getByRole('link', {name: 'Garden swap'}).click();
  await page.getByRole('heading', {name: 'Garden swap', level: 2}).waitFor();
  await page.locator('main header').getByText('Telegram ID -10099 · earlier -4005').waitFor();
  assert.equal(new URL(page.url()).hash, '#chats?chat=' + encodeURIComponent(UPGRADED));
  // A group first seen later has a digest id that is never shown; its topic is listed under it.
  await list.open('Night sky club');
  await page.getByRole('heading', {name: 'Night sky club', level: 2}).waitFor();
  await page.locator('main header').getByText('Telegram ID -10088').waitFor();
  await list.open('Meteor watch');
  await page.getByRole('heading', {name: 'Meteor watch', level: 2}).waitFor();
  await page.locator('main header').getByRole('link', {name: 'Night sky club'}).waitFor();
  // A group from before keeps its stored id, and its topic too.
  await list.open('Iceland planning');
  await page.getByRole('heading', {name: 'Iceland planning', level: 2}).waitFor();
  assert.equal(new URL(page.url()).hash, '#chats?chat=-10042%2Ftopic%2F7');
  const opened = await page.locator('main').innerText();
  await list.find('Iceland planning');
  for (const text of [await list.table.innerText(), opened])
    assert.ok(!/[0-9a-f]{64}/.test(text), 'no Nocheh id is shown');
  // Turning Nocheh on in the new group, which is off, asks which project it joins and turns it on at once, by its own
  // id: no setting is saved (ADR-0253). Turning it off asks first, then is off at once too.
  const switched = [],
    settings = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/nocheh/chats/state')) switched.push(request.postDataJSON());
    if (/\/api\/nocheh\/settings(?:\/apply)?$/.test(request.url())) settings.push(request.url());
  });
  await (await list.find('Night sky club')).getByText('Off', {exact: true}).waitFor();
  await list.open('Night sky club');
  await page.getByText('Nocheh doesn’t answer here.').waitFor();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: false}).click();
  const join = page.getByRole('dialog', {name: 'Which project does this group join?'});
  await join.locator('#join-project').selectOption({label: 'None'});
  await join.getByRole('button', {name: 'Turn on'}).click();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).waitFor();
  // The table says so too.
  await (await list.find('Night sky club')).getByText('On', {exact: true}).waitFor();
  await list.open('Night sky club');
  await page.getByRole('region', {name: 'Save changes'}).getByText('No unsaved changes').waitFor();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).click();
  const off = page.getByRole('dialog', {name: 'Turn Nocheh off in “Night sky club”?'});
  await off.getByText('It stays in the group, silent. Its members keep their switches.').waitFor();
  await off.getByRole('button', {name: 'Turn off'}).click();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: false}).waitFor();
  await (await list.find('Night sky club')).getByText('Off', {exact: true}).waitFor();
  assert.deepEqual(
    switched.map(({chat_id, state, project}) => ({chat_id, state, project})),
    [
      {chat_id: NEW_GROUP, state: 'active', project: {mode: 'none'}},
      {chat_id: NEW_GROUP, state: 'off', project: undefined},
    ],
  );
  assert.ok(switched.every(body => typeof body.operation_id === 'string' && body.operation_id.length > 0));
  assert.deepEqual(settings, [], 'the switch saves no setting');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a group and a person show the short ID a send card adds after their name, and a person links to their profile', async () => {
  const {page, problems} = await open('chats');
  const list = chatsTable(page);
  const header = page.locator('main header');
  // The same short ID as the server's, the one a card adds to a name that reads like another's (ADR-0254).
  await list
    .row('Aurora planning')
    .getByText('…' + chatShortId('-10042'), {exact: true})
    .waitFor();
  await list.open('Aurora planning');
  await page.getByRole('heading', {name: 'Aurora planning', level: 2}).waitFor();
  await header.getByText('…' + chatShortId('-10042'), {exact: true}).waitFor();
  assert.equal(await header.getByRole('link', {name: /^@/}).count(), 0, 'a group has no profile');
  // A topic is named by its group's on a card, and your own chat needs none.
  await list.open('Iceland planning');
  await page.getByRole('heading', {name: 'Iceland planning', level: 2}).waitFor();
  assert.equal(await header.getByText(/^…[0-9a-f]{4}$/).count(), 0);
  await list.open(/^You\b/);
  await page.getByRole('heading', {name: 'Your private chat', level: 2}).waitFor();
  assert.equal(await header.getByText(/^…[0-9a-f]{4}$/).count(), 0);
  // A person's private chat: their short ID, and their public username linked to their Telegram profile.
  await list.open('Mira Chen');
  await page.getByRole('heading', {name: 'Mira Chen', level: 2}).waitFor();
  await header.getByText('…' + chatShortId('73'), {exact: true}).waitFor();
  assert.equal(await header.getByRole('link', {name: '@mira_chen'}).getAttribute('href'), 'https://t.me/mira_chen');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a group’s Members here card is read-only, links each member, offers Make member, and an older topic is added by its number or link', async () => {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const problems = [];
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  // The new group is on here, so its Topics card shows.
  await page.route(/\/api\/nocheh\/conversations\?/, async route => {
    const response = await route.fetch(),
      view = await response.json();
    for (const item of view.items ?? []) if ([NEW_GROUP, NEW_TOPIC].includes(item.space_id)) item.state = 'active';
    return route.fulfill({response, json: view});
  });
  const topics = [],
    switched = [],
    settings = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nocheh/telegram/topics'))
      topics.push(request.postDataJSON());
    if (request.method() === 'POST' && request.url().endsWith('/api/nocheh/chats/state'))
      switched.push(request.postDataJSON());
    if (request.method() === 'POST' && /\/api\/nocheh\/(settings|members)/.test(request.url()))
      settings.push(request.url());
  });
  // A group Telegram upgraded opens as itself (ADR-0252).
  await page.goto(origin + '/#chats?chat=' + encodeURIComponent(UPGRADED));
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).waitFor();
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Members here'})});
  const members = card.getByRole('list', {name: 'Members here'});
  // You always; Mira writes here and has no switch yet: New here, and she can talk, as a member's group with no switch
  // is on. Her name links to her page.
  await members.getByText('You · always').waitFor();
  const mira = members.getByRole('listitem').filter({has: page.getByRole('link', {name: 'Mira Chen'})});
  await mira.getByText('Can talk here').waitFor();
  await mira.getByText('New here').waitFor();
  assert.equal(await mira.getByRole('link', {name: 'Mira Chen'}).getAttribute('href'), '#members?member=' + MIRA);
  await card.getByText('You and 1 member can talk to Nocheh here.').waitFor();
  // Rosa writes here and isn't a member; Sam wrote and left, and Lee's only record is that he left: neither is offered.
  const rosa = card.getByRole('link', {name: 'Make Rosa a member'});
  await rosa.waitFor();
  assert.equal(await rosa.getAttribute('href'), '#members?add=' + accountIdFor('telegram', '61'));
  for (const name of ['Sam', 'Lee']) assert.equal(await card.getByText(name, {exact: true}).count(), 0, name);
  // No switch and no choice here: each lives on the Members page.
  assert.equal(await card.getByRole('switch').count(), 0);
  assert.equal(await card.getByRole('radiogroup').count(), 0);
  assert.equal(await card.getByRole('textbox').count(), 0);
  // Turning the group off and on again changes no setting and no member.
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).click();
  await page
    .getByRole('dialog', {name: 'Turn Nocheh off in “Garden swap”?'})
    .getByRole('button', {name: 'Turn off'})
    .click();
  await card.getByText('Nocheh is off in this group, so nobody talks to it here until you turn it on.').waitFor();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: false}).click();
  const join = page.getByRole('dialog', {name: 'Which project does this group join?'});
  await join.locator('#join-project').selectOption({label: 'None'});
  await join.getByRole('button', {name: 'Turn on'}).click();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).waitFor();
  await mira.getByText('Can talk here').waitFor();
  assert.deepEqual(
    switched.map(({chat_id, state}) => [chat_id, state]),
    [
      [UPGRADED, 'off'],
      [UPGRADED, 'active'],
    ],
  );
  assert.deepEqual(settings, [], 'the switch saves no setting and changes no member');
  // Make member opens the add flow with that person.
  await rosa.click();
  const add = page.getByRole('dialog', {name: 'Add a member'});
  await add.waitFor();
  assert.equal(await add.locator('#add-person').inputValue(), accountIdFor('telegram', '61'));
  assert.equal(await add.getByRole('checkbox', {name: /Garden swap/}).isChecked(), true);
  await add.getByRole('button', {name: 'Cancel'}).click();
  await add.waitFor({state: 'detached'});
  assert.equal(new URL(page.url()).hash, '#members');
  await page.goto(origin + '/#chats?chat=' + encodeURIComponent(NEW_GROUP));
  const topicsCard = page.locator('section', {has: page.getByRole('heading', {name: 'Topics', exact: true})});
  await topicsCard.getByRole('link', {name: 'Meteor watch'}).waitFor();
  assert.equal(
    await topicsCard.getByRole('link', {name: 'Meteor watch'}).getAttribute('href'),
    '#chats?chat=' + NEW_TOPIC,
  );
  for (const [reference, name] of [
    ['5', 'Comet log'],
    ['https://t.me/c/10088/6', 'Star charts'],
  ]) {
    await topicsCard.getByRole('button', {name: 'Add an older topic'}).click();
    const dialog = page.getByRole('dialog', {name: 'Add an older topic'});
    await dialog.getByLabel('Topic link or number').fill(reference);
    await dialog.getByLabel('Topic name').fill(name);
    await dialog.getByRole('button', {name: 'Add topic'}).click();
    await page.getByRole('status').filter({hasText: 'Topic added.'}).last().waitFor();
    await dialog.waitFor({state: 'detached'});
  }
  assert.deepEqual(topics, [
    {action: 'add', name: 'Comet log', chat_id: NEW_GROUP, topic_id: 5},
    {action: 'add', name: 'Star charts', link: 'https://t.me/c/10088/6'},
  ]);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a group people were seen in, past the first page of chats, is listed once and opens as itself', async () => {
  // More than 100 chats: the upgraded group is not on the first page. People were seen there, so the list shows it from
  // the people route, which names it by its Nocheh id, and opening it looks it up (ADR-0252).
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const problems = [];
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  await page.route(/\/api\/nocheh\/conversations\?limit=100$/, async route => {
    const response = await route.fetch(),
      first = await response.json();
    first.items = first.items.filter(item => item.space_id !== UPGRADED);
    first.next_cursor = first.items.at(-1).space_id;
    return route.fulfill({response, json: first});
  });
  await page.goto(origin + '/#chats');
  const list = page.getByRole('table', {name: 'Chats'});
  // Every chat of the table, whichever page it is on.
  await page.getByLabel('Find a chat').fill('Garden swap');
  await list.getByRole('link', {name: 'Garden swap'}).waitFor();
  assert.equal(await list.getByRole('link', {name: 'Garden swap'}).count(), 1, 'listed once');
  await page.getByLabel('Find a chat').fill('Unknown chat');
  await page.getByText('No chats match').waitFor();
  await page.getByLabel('Find a chat').fill('Garden swap');
  await list.getByRole('link', {name: 'Garden swap'}).click();
  await page.getByRole('heading', {name: 'Garden swap', level: 2}).waitFor();
  assert.equal(new URL(page.url()).hash, '#chats?chat=' + encodeURIComponent(UPGRADED));
  await page.locator('main header').getByText('Telegram ID -10099 · earlier -4005').waitFor();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: true}).waitFor();
  await page.getByRole('link', {name: 'Make Rosa a member'}).waitFor();
  assert.equal(await page.getByText('Nocheh doesn’t know this chat.', {exact: false}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('each group says where Nocheh stands, and only a group Nocheh is in has a switch', async () => {
  const {page, problems} = await open('chats');
  const list = chatsTable(page);
  // The table names each group's state from the chat directory (ADR-0253); On is marked.
  for (const [name, state] of [
    ['Aurora planning', 'On'],
    ['Weekend notes', 'Off'],
    ['Book swap', 'Leaving'],
    ['Choir practice', 'Left'],
    ['Hiking crew', 'Removed'],
  ])
    await (await list.find(name)).getByText(state, {exact: true}).waitFor();
  // A group someone else added is being left, one added without showing who was left, and one Nocheh was removed
  // from says so: none has a switch, or people to choose.
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Nocheh here', exact: true})});
  for (const [name, state, text] of [
    ['Book swap', 'Leaving', 'Someone else added Nocheh here, so it is leaving.'],
    [
      'Choir practice',
      'Left',
      'Nocheh left because someone added it without showing who. To use it here, turn off Remain anonymous and add Nocheh yourself.',
    ],
    ['Hiking crew', 'Removed', 'Nocheh was removed from this group.'],
  ]) {
    await list.open(name);
    await page.getByRole('heading', {name, level: 2}).waitFor();
    await card.getByText(text).waitFor();
    await card.getByText(state, {exact: true}).waitFor();
    assert.equal(await page.getByRole('switch', {name: 'Nocheh in this group'}).count(), 0, name);
    assert.equal(await page.getByRole('heading', {name: 'Members here'}).count(), 0, name);
  }
  // A topic follows its group: one in a group Nocheh was removed from says so, in the group's own words, and has no
  // reply mode or Telegram notice, as its group's page has none.
  assert.equal(await card.getByText(/Add the bot in Telegram first/).count(), 0, 'Hiking crew');
  await list.open('Trail maps');
  await page.getByRole('heading', {name: 'Trail maps', level: 2}).waitFor();
  await card.getByText('Nocheh was removed from this group.').waitFor();
  assert.match(await card.innerText(), /Follows its group, Hiking crew: Removed\./);
  for (const wrong of [/where Nocheh is/, /Add the bot in Telegram first/, /Answers only when called/])
    assert.equal(await card.getByText(wrong).count(), 0, String(wrong));
  // A group Nocheh is in but off has its switch.
  await list.open('Weekend notes');
  await card.getByText('Nocheh doesn’t answer here.').waitFor();
  await page.getByRole('switch', {name: 'Nocheh in this group', checked: false}).waitFor();
  // Imported history can be shared with a group Nocheh is on in, and only with one.
  await page.goto(origin + '/#messages?view=import&job=11111111-1111-4111-8111-111111111111');
  await page.locator('#map-chat-1 option', {hasText: 'Share with Garden swap'}).waitFor({state: 'attached'});
  const targets = await page.locator('#map-chat-1 option').allTextContents();
  assert.ok(
    targets.includes('Share with Aurora planning') && targets.includes('Share with Garden swap'),
    targets.join(),
  );
  assert.ok(!targets.some(target => /Weekend notes|Book swap|Choir practice/.test(target)), targets.join());
  // Settings lists no groups: each one is turned on or off in Chats.
  await page.goto(origin + '/#settings?view=telegram&tab=groups');
  await page.getByText('Add Nocheh to a group yourself in Telegram', {exact: false}).waitFor();
  assert.equal(await page.getByText('Groups Nocheh is on in').count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('every group Nocheh is on in can be shared with and refreshed, past the first 100 chats', async () => {
  // 120 more groups Nocheh is on in: Garden swap falls past the first 100 chats, and past the first 100 such groups.
  writeFileSync('/tmp/nocheh-ui-scenario', 'many-chats');
  try {
    const {page, problems} = await open('messages?view=import&job=11111111-1111-4111-8111-111111111111');
    await page.locator('#map-chat-1 option', {hasText: 'Share with Garden swap'}).waitFor({state: 'attached'});
    const targets = (await page.locator('#map-chat-1 option').allTextContents()).filter(text =>
      text.startsWith('Share with '),
    );
    assert.equal(targets.length, 122, 'Aurora planning, 120 clubs and Garden swap');
    assert.ok(['Aurora planning', 'Club 001', 'Club 120'].every(name => targets.includes('Share with ' + name)));
    // The chat list loads its first 100 chats; a search that finds no group Nocheh is on in still lets Telegram be
    // asked about all of them.
    await page.goto(origin + '/#chats');
    await page.getByText('Showing the first 100 chats', {exact: false}).waitFor();
    await page.getByLabel('Find a chat').fill('Choir');
    await page.getByRole('table', {name: 'Chats'}).getByRole('link', {name: 'Choir practice'}).waitFor();
    assert.equal(await page.getByRole('button', {name: /Refresh group names/}).isEnabled(), true);
    // Telegram is asked about 50 of the 122 a press. The owner is told how many are left to check, fewer each press,
    // and nothing more once every group was checked in the last hour; a press never promises to check them all.
    for (const toast of [
      'Checked 50 groups with Telegram. 72 more haven’t been checked in the last hour. Press again to check more.',
      'Checked 50 groups with Telegram. 22 more haven’t been checked in the last hour. Press again to check more.',
      'Checked 50 groups with Telegram.',
    ]) {
      await page.getByRole('button', {name: /Refresh group names/}).click();
      await page
        .getByRole('status')
        .filter({hasText: new RegExp('^' + toast.replaceAll('.', '\\.') + '$')})
        .waitFor();
    }
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
});

test('a group that moves to a page not read yet is never dropped quietly, and sharing it still asks first', async () => {
  writeFileSync('/tmp/nocheh-ui-scenario', 'many-chats');
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  try {
    const problems = [];
    page.on('pageerror', error => problems.push('page error: ' + error.message));
    // The served list is read again each minute: the test moves the page's clock on instead of waiting.
    await page.clock.install();
    await page.goto(origin + '/#messages?view=import&job=11111111-1111-4111-8111-111111111111');
    const map = page.locator('#map-chat-1');
    await map.locator('option', {hasText: 'Share with Club 099'}).waitFor({state: 'attached'});
    await map.selectOption({label: 'Share with Club 099'});
    // Club 000 is turned on and sorts first, so Club 099 leaves the first page; the pages after it can't be read.
    writeFileSync('/tmp/nocheh-ui-scenario', 'many-chats-moved');
    await page.clock.fastForward(61000);
    await page.getByText('Some groups may be missing').waitFor();
    await map.locator('option', {hasText: 'Share with Club 000'}).waitFor({state: 'attached'});
    assert.equal(await map.locator('option', {hasText: 'Share with Club 099'}).count(), 0);
    assert.equal(await map.locator('option', {hasText: 'Share with Garden swap'}).count(), 0);
    assert.equal(await map.inputValue(), '-2000000000099');
    // The mapping still goes to a group, so starting asks first. Cancelling starts nothing.
    await page.getByRole('button', {name: 'Start import'}).click();
    const dialog = page.getByRole('dialog', {name: 'Share imported history with a group?'});
    await dialog.getByRole('button', {name: 'Cancel'}).click();
    await dialog.waitFor({state: 'detached'});
    await page.getByRole('button', {name: 'Start import'}).waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    rmSync('/tmp/nocheh-ui-scenario', {force: true});
  }
});

test('a sharing rule finds messages from its groups by their chat, a new-id group and an upgraded one included', async () => {
  // Hits name their Nocheh chat; the archive's scope stays the Telegram ID the message came with.
  const rule = {
    id: '5e'.repeat(32),
    name: 'Sky notes',
    enabled: true,
    sources: [NEW_TOPIC, UPGRADED],
    destination: '-10042',
    mode: 'approved',
    instructions: '',
    revision: 1,
    private_sources: [],
  };
  const hit = (id, scope, chat_id, text) => ({
    id: id.repeat(64),
    scope,
    chat_id,
    text,
    channel: 'telegram',
    occurred_at: new Date().toISOString(),
  });
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await page.route(/\/api\/nocheh\/sharing\/rules\?after=$/, route =>
    route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({rules: [rule], next: null})}),
  );
  await page.route(/\/api\/nocheh\/search\?/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        hit('1', '-10088', NEW_GROUP, 'The sky cleared over the club field.'),
        hit('2', '-4005', UPGRADED, 'Clear sky for the seed swap, before Telegram upgraded the group.'),
        hit('3', '-10073', '-10073', 'Clear sky on the weekend walk.'),
        hit('4', '-10088', null, 'A sky message whose chat is not known.'),
      ]),
    }),
  );
  await page.goto(origin + '/#chats?view=rules&rule=' + rule.id);
  const drawer = page.getByRole('dialog', {name: 'Sky notes'});
  await drawer.getByRole('button', {name: 'Write a text to share'}).click();
  await drawer.getByPlaceholder('Search messages in the source chats').fill('sky');
  await drawer.getByRole('button', {name: 'Search messages'}).click();
  await drawer.getByText('The sky cleared over the club field.').waitFor();
  await drawer.getByText('Clear sky for the seed swap, before Telegram upgraded the group.').waitFor();
  assert.equal(await drawer.getByText('Clear sky on the weekend walk.').count(), 0, 'another group’s message');
  assert.equal(await drawer.getByText('A sky message whose chat is not known.').count(), 0);
  await page.close();
});

test('a rule keeps a source the chat directory is still looking up, and saving waits for it', async () => {
  // Past the first 100 chats a source is looked up by itself (ADR-0252). Until that lookup answers, the source is
  // neither a group nor private: it stays chosen, and Save waits. A failed lookup is asked again, never taken as unknown.
  const rule = {
    id: '5f'.repeat(32),
    name: 'Seed notes',
    enabled: true,
    sources: ['-10073', UPGRADED],
    destination: '-10042',
    mode: 'approved',
    instructions: '',
    revision: 1,
    private_sources: [],
  };
  let failing = true;
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const problems = [];
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  await page.route(/\/api\/nocheh\/sharing\/rules\?after=$/, route =>
    route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({rules: [rule], next: null})}),
  );
  await page.route(/\/api\/nocheh\/conversations\?limit=100$/, async route => {
    const response = await route.fetch(),
      page = await response.json();
    page.items = page.items.filter(item => item.space_id !== UPGRADED);
    page.next_cursor = page.items.at(-1).space_id;
    return route.fulfill({response, json: page});
  });
  await page.route(/\/api\/nocheh\/conversations\?limit=100&q=/, route =>
    failing ? route.abort('failed') : route.fallback(),
  );
  const posted = [];
  await page.route(/\/api\/nocheh\/sharing\/rules$/, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({...rule, revision: 2})});
  });
  await page.goto(origin + '/#chats?view=rules&rule=' + rule.id);
  await page.getByRole('dialog', {name: 'Seed notes'}).getByRole('button', {name: 'Edit'}).click();
  const dialog = page.getByRole('dialog', {name: 'Edit sharing rule'});
  const chosen = dialog.getByRole('list', {name: 'Chosen: Share facts from'});
  await chosen.getByText('Weekend notes').waitFor();
  await chosen.getByText('Loading…').waitFor();
  await dialog.getByLabel('Name').fill('Seed and weekend notes');
  assert.equal(await dialog.getByRole('button', {name: 'Save'}).isDisabled(), true, 'saving waits for the lookup');
  failing = false;
  await chosen.getByText('Garden swap').waitFor({timeout: 30000});
  await dialog.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('status').filter({hasText: 'Sharing rule saved.'}).last().waitFor();
  assert.deepEqual(posted.at(-1)?.sources, ['-10073', UPGRADED]);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a chat the directory doesn’t know offers nothing, and nothing is read from its id', async () => {
  const {page, problems} = await open('chats?chat=' + 'f'.repeat(64));
  await page.getByRole('heading', {name: 'Unknown chat', level: 2}).waitFor();
  await page.getByText('Nocheh doesn’t know this chat. It shows here once Nocheh sees a message from it.').waitFor();
  assert.equal(await page.getByRole('switch', {name: 'Nocheh in this group'}).count(), 0);
  assert.equal(await page.getByText('Private chat', {exact: true}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a share from the private side names where it came from and who will see it', async () => {
  // Sharing a fact from the private chat lists groups only, names where it came from and who sees it, and asks first.
  const {page: people, problems: peopleProblems} = await open('memory?view=people&person=' + '1'.repeat(64));
  const card = people.getByRole('listitem').filter({hasText: 'Mira prefers quiet aurora viewpoints'}).first();
  await card.getByRole('button', {name: 'Let a chat use it'}).click();
  await card.getByText('Came from: your private chat').waitFor();
  const choice = card.getByLabel('Chat', {exact: true});
  assert.deepEqual(
    (await choice.locator('option').allTextContents()).filter(text => /Owner|Mira Chen|Private/.test(text)),
    [],
  );
  await choice.selectOption({label: 'Aurora planning'});
  await card.getByText('Who will see it: everyone in Aurora planning.').waitFor();
  await card.getByRole('button', {name: 'Share', exact: true}).click();
  const ask = people.getByRole('dialog', {name: 'Share something from a private chat?'});
  await ask
    .getByText('This fact comes from your private chat. Everyone in Aurora planning will see the wording below.')
    .waitFor();
  await ask.getByRole('button', {name: 'Share it'}).click();
  await people.getByRole('status').filter({hasText: 'Aurora planning may now use this.'}).waitFor();
  // The correction editor says who can read the new wording.
  await card.getByRole('button', {name: 'Correct'}).click();
  await card
    .getByText(
      'Who can read the new wording: only you. Chats you shared it with pause until you approve the new wording.',
    )
    .waitFor();
  await people.close();

  // A suggestion names its source and its readers, posts once by default, and posts a lasting share only when ticked.
  const {page: inbox, problems: inboxProblems} = await open('inbox?kind=memory_access&decision=' + '4'.repeat(64));
  const drawer = inbox.getByRole('dialog');
  await drawer.getByText('Came from', {exact: true}).waitFor();
  await drawer.getByText('Everyone in Aurora planning').waitFor();
  await drawer.getByRole('button', {name: 'Post it once in Aurora planning'}).waitFor();
  await drawer.getByText('Nocheh posts this exact wording there now.').waitFor();
  await drawer.getByRole('radio', {name: 'Until I revoke it'}).click();
  await drawer
    .getByText(
      'Nocheh may use it when it answers in Aurora planning and all its topics, until you revoke it under Chats.',
    )
    .waitFor();
  assert.equal(await drawer.getByRole('checkbox', {name: 'Also post it in Aurora planning now'}).isChecked(), false);
  assert.deepEqual([...peopleProblems, ...inboxProblems], []);
  await inbox.close();
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

test('Usage, Messages and Inbox › History are tables of ten rows a page', async () => {
  // Recent replies have their own sub-tab of Usage.
  const {page, problems} = await open('usage?tab=replies');
  const replies = page.getByRole('table', {name: 'Recent replies'});
  await replies.locator('tbody tr').first().waitFor();
  assert.equal(await replies.locator('tbody tr').count(), 10);
  await page.getByRole('button', {name: 'Older'}).click();
  await settles(replies.locator('tbody tr'), 2);
  assert.equal(await page.getByRole('table', {name: 'Usage by part'}).count(), 0, 'one sub-tab at a time');

  // Messages: ten a page, the reply beside its message, and the next page starts after the last one shown.
  await page.goto(origin + '/#messages');
  const messages = page.getByRole('table', {name: 'Messages'});
  await messages.getByRole('button', {name: /^Open the assistant’s reply: The tour leaves at 21:30/}).waitFor();
  assert.equal(await messages.locator('tbody tr').count(), 10);
  const shown = await messages.locator('tbody tr td:first-child').allInnerTexts();
  await page.getByRole('button', {name: 'Older'}).click();
  await page.getByText('Newest first · page 2').waitFor();
  const older = await messages.locator('tbody tr td:first-child').allInnerTexts();
  assert.ok(older.length > 0 && older.every(text => !shown.includes(text)), 'no message on two pages');
  await page.getByRole('button', {name: 'Newer'}).click();
  await settles(messages.locator('tbody tr'), 10);

  // Inbox › History: each kind is one table on its own sub-tab, and a row keeps its sub-tab when it opens.
  await page.goto(origin + '/#inbox?view=history');
  await page.getByRole('table', {name: 'Actions'}).getByRole('link', {name: 'Send a Telegram message'}).waitFor();
  await page.getByRole('tab', {name: 'Assistant runs'}).click();
  await page.getByRole('table', {name: 'Assistant runs'}).getByRole('link', {name: 'Morning aurora check'}).click();
  await page.getByRole('dialog').waitFor();
  assert.match(new URL(page.url()).hash, /^#inbox\?view=history&tab=runs&run=/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('System pages are sub-tabs of tables: failed tasks open filtered, and a backup task opens from History', async () => {
  const {page, problems} = await open('system');
  // Health › Status lists what needs a look as a table; Review opens the Tasks sub-tab filtered to the failures.
  const issue = page
    .getByRole('table', {name: 'Things that need a look'})
    .getByRole('row')
    .filter({hasText: 'background tasks failed'});
  await issue.getByRole('link', {name: 'Review'}).click();
  await page.getByRole('tab', {name: 'Tasks', selected: true}).waitFor();
  assert.match(new URL(page.url()).hash, /^#system\?view=work&tab=tasks&status=(failed|retryable_failed)$/);
  const tasks = page.getByRole('table', {name: 'Background tasks'});
  await tasks.locator('tbody tr').first().waitFor();
  assert.ok((await tasks.locator('tbody tr').count()) <= 10);
  assert.notEqual(await page.getByRole('combobox', {name: 'Status'}).inputValue(), '');
  await page.getByRole('table', {name: 'Right now'}).getByRole('rowheader', {name: 'Running'}).waitFor();
  // The charts sit on their own sub-tab; the choice is in the address.
  await page.getByRole('tab', {name: 'History'}).click();
  await page.getByRole('img', {name: 'Activity'}).waitFor();
  assert.match(new URL(page.url()).hash, /tab=history/);
  assert.equal(await tasks.count(), 0);

  // Backups: every action is a table row, and past tasks are on the History sub-tab.
  await page.goto(origin + '/#system?view=backups');
  const actions = page.getByRole('table', {name: 'Backup and maintenance actions'});
  assert.deepEqual(await actions.getByRole('rowheader').allTextContents(), [
    'Back up now',
    'Restore a backup',
    'Off-site copy',
    'Test the off-site copy',
    'Export your archive',
    'Export archive and memory',
    'Check services',
    'Restart Nocheh',
  ]);
  await page.getByRole('tab', {name: 'History'}).click();
  const history = page.getByRole('table', {name: 'History'});
  await history.getByRole('button', {name: 'Archive export'}).click();
  const drawer = page.getByRole('dialog', {name: 'Archive export'});
  await drawer.getByText('1,842 messages · 28 files').waitFor();
  await drawer.getByRole('button', {name: 'Download ZIP'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('sent to apps lists each send with its outcome, and Health opens the ones that failed', async () => {
  const {page, problems} = await open('system');
  // Health counts the last day's problems, leaving out expected no-ops and attempts a retry delivered, and opens them filtered.
  const issue = page
    .getByRole('table', {name: 'Things that need a look'})
    .getByRole('row')
    .filter({hasText: '2 sends to chat apps failed in the last day'});
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
  // A send names its chat (ADR-0252): a group first seen after step 2b links to its own id.
  assert.equal(
    await table.getByRole('link', {name: 'Night sky club'}).getAttribute('href'),
    '#chats?chat=' + NEW_GROUP,
  );
  assert.equal(await table.getByText('Bot setup').count(), 0);
  // Ten sends a page: the older ones are a page away each.
  const older = page.getByRole('button', {name: 'Older'});
  await older.click();
  for (const name of ['Already up to date', 'Button press expired']) await table.getByRole('cell', {name}).waitFor();
  await older.click();
  await page.getByText('Page 3 ·', {exact: false}).waitFor();
  await older.click();
  await table.getByText('Bot setup').waitFor();
  assert.equal(await older.isDisabled(), true);
  for (const number of [3, 2, 1]) {
    await page.getByRole('button', {name: 'Newer'}).click();
    await page.getByText(`Page ${number} ·`, {exact: false}).waitFor();
  }
  await table.getByText('Reaction cleared').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

/** Owner POSTs to the Members routes, as sent: path and body. */
function memberPosts(page) {
  const posts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/nocheh/members'))
      posts.push({path: new URL(request.url()).pathname.replace('/api/nocheh', ''), body: request.postDataJSON()});
  });
  return posts;
}

test('Members lists each member by name with their groups, and a carried member who never wrote shows by name', async () => {
  const {page, problems} = await open('members');
  const list = membersTable(page);
  await list.row(/Omar Haddad/).waitFor();
  // A table with the same columns on every row.
  assert.deepEqual(
    (await list.table.getByRole('columnheader').allInnerTexts()).map(text => text.trim()),
    ['Member', 'Telegram', 'State', 'Groups', 'Private chat'],
  );
  const rows = await list.table
    .locator('tbody tr')
    .evaluateAll(found => found.map(row => [...row.cells].slice(0, 4).map(cell => cell.innerText.trim())));
  assert.deepEqual(rows, [
    ['Devon', 'ID 84', 'Paused', '1 of 1 group on'],
    ['Mira Chen', '@mira · ID 73', 'Active', '2 of 3 groups on · 1 new here'],
    // Carried from the lists before step 3 and never seen writing: Telegram's name for him, from the identities route.
    ['Omar Haddad', 'ID 95', 'Active', '1 of 1 group on'],
  ]);
  await page.getByText('Each member can talk to Nocheh 200 times a day.').waitFor();
  await list.open(/Omar Haddad/);
  await page.getByRole('heading', {name: 'Omar Haddad', level: 2}).waitFor();
  assert.equal(new URL(page.url()).hash, '#members?member=' + OMAR);
  // The open member names the way back and to any other member.
  await page.getByRole('button', {name: 'All members'}).waitFor();
  assert.deepEqual(await page.getByLabel('Open another member').locator('option').allInnerTexts(), [
    'Devon',
    'Mira Chen',
    'Omar Haddad',
  ]);
  await memberPart(page, 'Private chat and groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Groups', exact: true})});
  const aurora = groups.getByRole('listitem').filter({hasText: 'Aurora planning'});
  await aurora.getByText('Nothing from Telegram yet').waitFor();
  assert.equal(await aurora.getByRole('link', {name: 'Aurora planning'}).getAttribute('href'), '#chats?chat=-10042');
  // A page with no setting has no Save bar.
  assert.equal(await page.getByRole('region', {name: 'Save changes'}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('each member switch saves at once, the three under talk are off while it is, and a New here group is on', async () => {
  const {page, problems} = await open('members?member=' + MIRA);
  const posts = memberPosts(page);
  await page.getByRole('heading', {name: 'Mira Chen', level: 2}).waitFor();
  const toast = text => page.getByRole('status').filter({hasText: text}).last().waitFor();
  const talk = 'Talk to Nocheh in groups they joined';
  const under = [
    'Small jobs (no daily limit)',
    'Post to their other groups',
    'Web pages and outside tools (no approval)',
  ];
  for (const name of under) assert.equal(await page.getByRole('switch', {name}).isEnabled(), true, name);
  await page.getByRole('switch', {name: talk, checked: true}).click();
  await toast('Mira Chen can’t talk to Nocheh now.');
  await page.getByRole('switch', {name: talk, checked: false}).waitFor();
  // With talk off, the three under it can't be changed, and each keeps its own setting.
  for (const name of under) {
    const control = page.getByRole('switch', {name});
    assert.equal(await control.isDisabled(), true, name);
    assert.equal(await control.getAttribute('aria-checked'), 'true', name);
  }
  await page.getByRole('switch', {name: talk, checked: false}).click();
  await page.getByRole('switch', {name: talk, checked: true}).waitFor();
  await page.getByRole('switch', {name: under[2], checked: true}).click();
  await page.getByRole('switch', {name: under[2], checked: false}).waitFor();
  await page.getByRole('radiogroup', {name: 'Tasks'}).getByRole('radio', {name: 'Read only'}).click();
  await page.getByRole('radiogroup', {name: 'Tasks'}).getByRole('radio', {name: 'Read only', checked: true}).waitFor();
  // Garden swap: Telegram shows her there and she has no switch yet, so it is New here and on; Weekend notes is off.
  await memberPart(page, 'Private chat and groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Groups', exact: true})});
  const garden = groups.getByRole('listitem').filter({hasText: 'Garden swap'});
  await garden.getByText('New here').waitFor();
  await garden.getByText('Seen here').waitFor();
  await garden.getByRole('switch', {name: 'Mira Chen in Garden swap', checked: true}).click();
  await garden.getByRole('switch', {name: 'Mira Chen in Garden swap', checked: false}).waitFor();
  assert.equal(await garden.getByText('New here').count(), 0, 'a switch is set there now');
  const weekend = groups.getByRole('listitem').filter({hasText: 'Weekend notes'});
  await weekend.getByText('Nocheh here: Off').waitFor();
  await weekend.getByRole('switch', {name: 'Mira Chen in Weekend notes', checked: false}).click();
  await toast('Mira Chen can talk in Weekend notes.');
  assert.deepEqual(
    posts.map(({path, body}) => [path, body.changes]),
    [
      ['/members/' + MIRA, {talk: false}],
      ['/members/' + MIRA, {talk: true}],
      ['/members/' + MIRA, {tools: false}],
      ['/members/' + MIRA, {tasks: 'read'}],
      ['/members/' + MIRA, {groups: {[UPGRADED]: false}}],
      ['/members/' + MIRA, {groups: {'-10073': true}}],
    ],
  );
  assert.equal(
    new Set(posts.map(({body}) => body.operation_id)).size,
    posts.length,
    'each change has its own operation',
  );
  assert.equal(await page.getByRole('region', {name: 'Save changes'}).count(), 0, 'no Save bar');
  // Saved: a reload shows the same, on the sub-tab that was open.
  await page.reload();
  await page.getByRole('tab', {name: 'Private chat and groups', selected: true}).waitFor();
  await memberPart(page, 'What they can do');
  await page.getByRole('switch', {name: under[2], checked: false}).waitFor();
  await page.getByRole('radiogroup', {name: 'Tasks'}).getByRole('radio', {name: 'Read only', checked: true}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a member is added from people seen in a group, with one of their groups unticked, and opens at once', async () => {
  const {page, problems} = await open('chats?chat=-10042');
  const posts = memberPosts(page);
  const nia = accountIdFor('telegram', '91');
  await page.getByRole('link', {name: 'Make Nia a member'}).click();
  const dialog = page.getByRole('dialog', {name: 'Add a member'});
  assert.equal(await dialog.locator('#add-person').inputValue(), nia);
  // Every group Telegram shows her in starts ticked.
  const aurora = dialog.getByRole('checkbox', {name: /Aurora planning/}),
    night = dialog.getByRole('checkbox', {name: /Night sky club/});
  assert.deepEqual([await aurora.isChecked(), await night.isChecked()], [true, true]);
  assert.equal(await dialog.getByRole('checkbox').count(), 2);
  await night.uncheck();
  await dialog.getByRole('button', {name: 'Add member'}).click();
  await page.getByRole('heading', {name: 'Nia', level: 2}).waitFor();
  assert.equal(new URL(page.url()).hash, '#members?member=' + memberIdFor(nia));
  assert.equal(posts.length, 1);
  const {operation_id, ...body} = posts[0].body;
  assert.equal(typeof operation_id, 'string');
  // The unticked group is sent off: with no switch it would be on.
  assert.deepEqual(
    [posts[0].path, body],
    ['/members', {account_id: nia, groups: {'-10042': true, [NEW_GROUP]: false}}],
  );
  for (const name of ['Talk to Nocheh in groups they joined', 'Small jobs (no daily limit)'])
    assert.equal(await page.getByRole('switch', {name}).getAttribute('aria-checked'), 'true', name);
  await memberPart(page, 'Private chat and groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Groups', exact: true})});
  await groups.getByRole('switch', {name: 'Nia in Aurora planning', checked: true}).waitFor();
  await groups.getByRole('switch', {name: 'Nia in Night sky club', checked: false}).waitFor();
  // She is a member now, so Aurora planning no longer offers to make her one.
  await page.goto(origin + '/#chats?chat=-10042');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Members here'})});
  await card.getByRole('link', {name: 'Nia', exact: true}).waitFor();
  assert.equal(await card.getByRole('link', {name: 'Make Nia a member'}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a member is added by Telegram user ID, ticking groups from every group Nocheh is in, none ticked at first', async () => {
  const {page, problems} = await open('members');
  const posts = memberPosts(page);
  await page.getByRole('button', {name: 'Add member'}).click();
  const dialog = page.getByRole('dialog', {name: 'Add a member'});
  await dialog.getByRole('radio', {name: 'By Telegram user ID'}).click();
  const boxes = dialog.getByRole('checkbox');
  // Every group Nocheh is in, on or off or leaving; never one it left, was removed from or knows only from history.
  assert.deepEqual(
    (await boxes.evaluateAll(inputs => inputs.map(input => input.closest('label').innerText.trim()))).map(text =>
      text.replace(/\s+/g, ' '),
    ),
    [
      'Aurora planning',
      'Book swap Nocheh: Leaving',
      'Garden swap',
      'Night sky club Nocheh: Off',
      'Weekend notes Nocheh: Off',
      'Unnamed group Nocheh: Off',
    ],
  );
  for (const box of await boxes.all()) assert.equal(await box.isChecked(), false);
  const add = dialog.getByRole('button', {name: 'Add member'});
  await dialog.getByLabel('Telegram user ID').fill('42');
  assert.equal(await add.isDisabled(), true, 'nothing ticked yet');
  await dialog.getByRole('checkbox', {name: /Garden swap/}).check();
  await add.click();
  await dialog.getByText('That’s you. You can always talk to Nocheh.').waitFor();
  await dialog.getByLabel('Telegram user ID').fill('not a number');
  await add.click();
  await dialog.getByText('A Telegram user ID is a number, like 123456789.').waitFor();
  assert.equal(posts.length, 0, 'nothing is sent until the ID is one');
  await dialog.getByLabel('Telegram user ID').fill('777');
  await add.click();
  await page.getByRole('heading', {name: 'Telegram ID 777', level: 2}).waitFor();
  const {operation_id, ...body} = posts[0].body;
  assert.equal(typeof operation_id, 'string');
  const joined = ['-10042', '-10073', '-10077', NEW_GROUP, UPGRADED, chatIdFor('telegram', '-10091')];
  assert.deepEqual(body, {
    telegram_id: '777',
    groups: Object.fromEntries(joined.map(chat => [chat, chat === UPGRADED])),
  });
  // Telegram never showed them anywhere: their first message proves they are there.
  await memberPart(page, 'Private chat and groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Groups', exact: true})});
  await groups.getByRole('switch', {name: 'Telegram ID 777 in Garden swap', checked: true}).waitFor();
  await groups.getByRole('listitem').filter({hasText: 'Garden swap'}).getByText('Nothing from Telegram yet').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('Pause this member saves at once, and Remove asks first', async () => {
  const {page, problems} = await open('members?member=' + DEVON);
  const posts = memberPosts(page);
  await page.getByRole('heading', {name: 'Devon', level: 2}).waitFor();
  await page.getByText('Their switches are kept for when you resume them.', {exact: false}).waitFor();
  // Paused, with read-only tasks and jobs switched off: the switches show what is kept.
  await page.getByRole('radiogroup', {name: 'Tasks'}).getByRole('radio', {name: 'Read only', checked: true}).waitFor();
  await page.getByRole('switch', {name: 'Small jobs (no daily limit)', checked: false}).waitFor();
  await memberPart(page, 'Pause or remove');
  await page.getByRole('switch', {name: 'Pause this member', checked: true}).click();
  await page.getByRole('status').filter({hasText: 'Devon is active again.'}).waitFor();
  await page.getByRole('switch', {name: 'Pause this member', checked: false}).waitFor();
  const list = membersTable(page);
  await (await list.find(/^Devon/)).getByText('Active').waitFor();
  // Remove asks first; cancelling sends nothing.
  await list.open(/Omar Haddad/);
  await page.getByRole('heading', {name: 'Omar Haddad', level: 2}).waitFor();
  await memberPart(page, 'Pause or remove');
  await page.getByRole('button', {name: 'Remove', exact: true}).click();
  const ask = page.getByRole('dialog', {name: 'Remove Omar Haddad as a member?'});
  await ask.getByText('Their tasks and reminders stay.', {exact: false}).waitFor();
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await ask.waitFor({state: 'detached'});
  assert.equal(posts.filter(({path}) => path.endsWith('/remove')).length, 0);
  await page.getByRole('button', {name: 'Remove', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Remove Omar Haddad as a member?'})
    .getByRole('button', {name: 'Remove'})
    .click();
  await page.getByRole('status').filter({hasText: 'Omar Haddad is no longer a member.'}).waitFor();
  // Back at the table, without them.
  await list.row(/Devon/).waitFor();
  assert.equal(new URL(page.url()).hash, '#members');
  assert.equal(await list.row(/Omar Haddad/).count(), 0);
  assert.deepEqual(
    posts.map(({path, body}) => [path, body.changes ?? null]),
    [
      ['/members/' + DEVON, {state: 'active'}],
      ['/members/' + OMAR + '/remove', null],
    ],
  );
  assert.deepEqual(problems, []);
  await page.close();
});

test('the daily message cap has its own Save, within 1 to 10,000', async () => {
  const {page, problems} = await open('members');
  const posts = memberPosts(page);
  await page.getByText('Switches save at once; the daily cap has its own Save.').waitFor();
  const input = page.getByLabel('Times each member may ask Nocheh a day');
  assert.equal(await input.inputValue(), '200');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Daily messages'})});
  await input.fill('0');
  await card.getByText('Choose a whole number from 1 to 10,000.').waitFor();
  assert.equal(await card.getByRole('button', {name: 'Save'}).isDisabled(), true);
  await input.fill('150');
  await input.press('Enter');
  await page.getByRole('status').filter({hasText: 'Each member can talk to Nocheh 150 times a day.'}).waitFor();
  await card.getByText('Each member can talk to Nocheh 150 times a day.').waitFor();
  assert.deepEqual(
    posts.map(({path, body}) => [path, body.daily_messages]),
    [['/members/settings', 150]],
  );
  assert.equal(await page.getByRole('region', {name: 'Save changes'}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a new member, a saved switch and the daily cap show at once while the member list is still reloading', async () => {
  const {page, problems} = await open('members');
  // Every reload of the member list waits until released, so the page has only what each change answered.
  let release;
  const held = new Promise(resolve => (release = resolve));
  await page.route('**/api/nocheh/members', async route => {
    if (route.request().method() === 'GET') await held;
    await route.continue();
  });
  await page.getByRole('button', {name: 'Add member'}).click();
  const dialog = page.getByRole('dialog', {name: 'Add a member'});
  await dialog.getByRole('radio', {name: 'By Telegram user ID'}).click();
  await dialog.getByLabel('Telegram user ID').fill('778');
  await dialog.getByRole('checkbox', {name: /Garden swap/}).check();
  await dialog.getByRole('button', {name: 'Add member'}).click();
  await page.getByRole('heading', {name: 'Telegram ID 778', level: 2}).waitFor();
  assert.equal(await page.getByText('This member isn’t here any more').count(), 0);
  await page
    .getByLabel('Open another member')
    .locator('option', {hasText: 'Telegram ID 778'})
    .waitFor({state: 'attached'});
  await memberPart(page, 'Private chat and groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'Groups', exact: true})});
  await groups.getByRole('switch', {name: 'Telegram ID 778 in Garden swap', checked: true}).click();
  await page.getByRole('status').filter({hasText: 'Telegram ID 778 is off in Garden swap.'}).waitFor();
  await groups.getByRole('switch', {name: 'Telegram ID 778 in Garden swap', checked: false}).waitFor();
  // The table has the new member too, and the daily cap under it.
  const list = membersTable(page);
  await (await list.find(/Telegram ID 778/)).waitFor();
  const input = page.getByLabel('Times each member may ask Nocheh a day');
  await input.fill('120');
  await input.press('Enter');
  await page.getByRole('status').filter({hasText: 'Each member can talk to Nocheh 120 times a day.'}).waitFor();
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Daily messages'})});
  await card.getByText('Each member can talk to Nocheh 120 times a day.').waitFor();
  assert.equal(await input.inputValue(), '120');
  // The list catches up and says the same.
  const reloaded = page.waitForResponse(
    response => new URL(response.url()).pathname === '/api/nocheh/members' && response.request().method() === 'GET',
  );
  release();
  await reloaded;
  assert.equal(await input.inputValue(), '120');
  await list.open(/Telegram ID 778/);
  await memberPart(page, 'Private chat and groups');
  await groups.getByRole('switch', {name: 'Telegram ID 778 in Garden swap', checked: false}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a change whose answer was lost is applied when made again after a later change, not answered with its old receipt', async () => {
  const {page, problems} = await open('members?member=' + MIRA);
  const posts = memberPosts(page);
  await page.getByRole('heading', {name: 'Mira Chen', level: 2}).waitFor();
  // The first Pause reaches Nocheh and is applied, but its answer is lost on the way back.
  let lose = true;
  await page.route('**/api/nocheh/members/' + MIRA, async route => {
    if (!lose || route.request().method() !== 'POST') return route.continue();
    lose = false;
    await route.fetch();
    await route.abort('failed');
  });
  const pause = checked => page.getByRole('switch', {name: 'Pause this member', checked});
  await memberPart(page, 'Pause or remove');
  await pause(false).click();
  await page.getByText('Failed to fetch').waitFor();
  // Another change brings the list back: Mira is paused. She is resumed, then paused again.
  await page.getByRole('button', {name: 'All members'}).click();
  const input = page.getByLabel('Times each member may ask Nocheh a day');
  await input.fill('130');
  await input.press('Enter');
  await membersTable(page).open(/^Mira Chen/);
  await memberPart(page, 'Pause or remove');
  await pause(true).click();
  await page.getByRole('status').filter({hasText: 'Mira Chen is active again.'}).waitFor();
  await pause(false).click();
  await page.getByRole('status').filter({hasText: 'Mira Chen is paused.'}).waitFor();
  const changes = posts.filter(({path}) => path === '/members/' + MIRA);
  assert.deepEqual(
    changes.map(({body}) => body.changes),
    [{state: 'paused'}, {state: 'active'}, {state: 'paused'}],
  );
  assert.notEqual(changes[2].body.operation_id, changes[0].body.operation_id, 'the second Pause is a new change');
  await page.reload();
  await pause(true).waitFor();
  // Back as she was for the tests after this one.
  await pause(true).click();
  await pause(false).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the owner reads where group web pages and outside tools skip the card, and that members are chosen on Members', async () => {
  const groupTools =
    'In a group, web pages and outside tools run without a card when you ask, or a member with “Web pages and outside tools” on asks; commands still wait, and Notion is never used in a group.';
  const {page, problems} = await open('home');
  await page.getByText('Turn Nocheh on in a group and see who are members there.').waitFor();
  // The preview keeps no owner freedom setting, and the Inbox has no allowed action left here.
  await page.route('**/api/nocheh/owner-autonomy', route =>
    route.fulfill({json: {mode: 'approval_required', revision: 1}}),
  );
  await page.route('**/api/nocheh/tools/actions', async route => {
    const answer = await route.fetch();
    await route.fulfill({response: answer, json: {...(await answer.json()), permissions: []}});
  });
  await page.goto(origin + '/#settings?view=assistant');
  const freedom = page.getByRole('radiogroup', {name: 'Acting for you'});
  for (const name of ['Ask me first', 'Do what I ask'])
    assert.ok((await freedom.getByRole('radio', {name: new RegExp(name)}).innerText()).includes(groupTools), name);
  await page.goto(origin + '/#inbox?view=allowed');
  await page
    .getByText('Except web pages and outside tools other than Notion asked for in a group', {exact: false})
    .waitFor();
  // A group's Allowed actions with nothing allowed names the exceptions and what still waits; the private chat has none.
  await page.goto(origin + '/#chats?chat=-10073&tab=tools');
  const allowed = page.locator('section', {has: page.getByRole('heading', {name: 'Allowed actions'})});
  const groupAllowed =
    'Web pages and outside tools other than Notion run without a card when you ask here, or a member with “Web pages and outside tools” on asks, and a message for this chat asked for here goes out without one. Commands still wait for your approval in the Inbox.';
  await allowed.getByText(groupAllowed).waitFor();
  assert.equal(await allowed.getByText('Anything else waits', {exact: false}).count(), 0);
  const privateAllowed = 'Nothing without asking. Each action waits for your approval in the Inbox.';
  await page.goto(origin + '/#chats?chat=42&tab=tools');
  await allowed.getByText(privateAllowed).waitFor();
  // A topic of the owner's private chat is no group: no member talks there, so nothing skips the card.
  const ownerTopic = '42/topic/9';
  await page.route(
    url =>
      url.pathname === '/api/nocheh/conversations' && !['q', 'kind', 'after'].some(name => url.searchParams.has(name)),
    async route => {
      const answer = await route.fetch();
      const body = await answer.json();
      const owner = body.items.find(item => item.space_id === '42');
      const topic = {
        ...owner,
        space_id: ownerTopic,
        name: 'Trip ideas',
        kind: 'topic',
        parent_space: '42',
        parent_name: owner.name,
        topic_key: '9',
        configured: false,
        closed: false,
      };
      await route.fulfill({response: answer, json: {...body, items: [...body.items, topic], total: body.total + 1}});
    },
  );
  await page.goto(origin + '/#chats?chat=' + encodeURIComponent(ownerTopic) + '&tab=tools');
  await page.reload();
  await allowed.getByText('Permissions belong to the whole private chat.').waitFor();
  await allowed.getByText(privateAllowed).waitFor();
  assert.equal(await allowed.getByText('run without a card', {exact: false}).count(), 0);
  // A member's own switch says the same of Notion.
  await page.goto(origin + '/#members?member=' + MIRA);
  await page
    .getByText('Commands still ask you, Notion is never used in a group, and each chat’s tool switches still apply.')
    .waitFor();
  await page.goto(origin + '/#settings?view=telegram&tab=groups');
  const groups = page.locator('section', {has: page.getByRole('heading', {name: 'In groups'})});
  assert.equal(await groups.getByRole('link', {name: 'Members'}).getAttribute('href'), '#members');
  assert.equal(await groups.getByRole('link', {name: 'Chats'}).getAttribute('href'), '#chats');
  assert.deepEqual(problems, []);
  await page.close();
});

test('Settings lists the member texts and no group access setting, and Background jobs has no daily job count', async () => {
  const {page, problems} = await open('settings?view=assistant&tab=instructions');
  for (const title of [
    'Reply to people who may not talk in a group',
    'Reply to a member past the daily limit',
    'Tool runs a group allows without a card',
  ]) {
    const drawer = await instruction(page, title);
    const box = drawer.getByRole('textbox', {name: title, exact: true});
    assert.equal(await box.isEditable(), true, title);
    if (title.startsWith('Tool runs')) assert.match(await box.inputValue(), /^allowed_follow_up: .+\nallowed: .+$/);
    await done(drawer);
  }
  await page.getByRole('searchbox', {name: 'Find an instruction'}).fill('reason_member_changed');
  await page
    .getByRole('table', {name: 'Built-in instructions'})
    .getByText(/reason_member_changed when the member who asked was paused or removed/)
    .waitFor();
  await page.getByRole('tab', {name: 'Background jobs'}).click();
  await page.locator('#job-minutes_limit').waitFor();
  assert.equal(await page.locator('#job-member_daily_jobs').count(), 0);
  assert.equal(await page.getByText('Jobs a member may start each day').count(), 0);
  for (const view of ['telegram', 'advanced']) {
    await page.goto(origin + '/#settings?view=' + view);
    await page.locator('main h1').first().waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByText('Who can talk in groups').count(), 0, view);
    assert.equal(await page.getByText('TELEGRAM_GROUP_ACCESS').count(), 0, view);
  }
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

test('a member’s private chat with Nocheh is its own switch, kept apart from group talk, and Pause says it stops', async () => {
  const {page, problems} = await open('members?member=' + MIRA);
  const posts = memberPosts(page);
  await page.getByRole('heading', {name: 'Mira Chen', level: 2}).waitFor();
  const toast = text => page.getByRole('status').filter({hasText: text}).last().waitFor();
  await memberPart(page, 'Private chat and groups');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Private chat', exact: true})});
  await card.getByText('Group talk off doesn’t stop it.').waitFor();
  await card.getByText('You can read the chat under Messages › Members’ chats.', {exact: false}).waitFor();
  const privateChat = 'Private chat with Nocheh';
  const talk = 'Talk to Nocheh in groups they joined';
  // Group talk off leaves the private chat switch as it is, and it can still be changed.
  await memberPart(page, 'What they can do');
  await page.getByRole('switch', {name: talk, checked: true}).click();
  await toast('Mira Chen can’t talk to Nocheh now.');
  await memberPart(page, 'Private chat and groups');
  assert.equal(await page.getByRole('switch', {name: privateChat, checked: true}).isEnabled(), true);
  await page.getByRole('switch', {name: privateChat, checked: true}).click();
  await toast('Mira Chen can’t talk to Nocheh privately now.');
  // The table says so in its Private chat column.
  const list = membersTable(page);
  await (await list.find(/^Mira Chen/)).getByText('Off', {exact: true}).waitFor();
  await page.reload();
  await list.open(/^Mira Chen/);
  await memberPart(page, 'Private chat and groups');
  await page.getByRole('switch', {name: privateChat, checked: false}).click();
  await toast('Mira Chen can talk to Nocheh privately.');
  await memberPart(page, 'What they can do');
  await page.getByRole('switch', {name: talk, checked: false}).click();
  await page.getByRole('switch', {name: talk, checked: true}).waitFor();
  assert.deepEqual(
    posts.map(({path, body}) => [path, body.changes]),
    [
      ['/members/' + MIRA, {talk: false}],
      ['/members/' + MIRA, {private_chat: false}],
      ['/members/' + MIRA, {private_chat: true}],
      ['/members/' + MIRA, {talk: true}],
    ],
  );
  // Pause, and Remove, say the private chat stops too.
  await memberPart(page, 'Pause or remove');
  await page.getByText('in every group and in their private chat', {exact: false}).waitFor();
  await page.getByText('Deletes them and their switches, and their private chat stops.', {exact: false}).waitFor();
  await page.getByRole('switch', {name: 'Pause this member', checked: false}).click();
  await page
    .getByText('They can’t talk to Nocheh in any group or in their private chat with it', {exact: false})
    .waitFor();
  await page.getByRole('switch', {name: 'Pause this member', checked: true}).click();
  await toast('Mira Chen is active again.');
  assert.deepEqual(problems, []);
  await page.close();
});

test('the Members page shows the owner-only local laws line, from a text the owner can edit', async () => {
  const {page, problems} = await open('members');
  const line = page.getByTestId('members-local-laws');
  await line.waitFor();
  assert.equal(
    (await line.textContent()).trim(),
    "Before you read your members' private chats with Nocheh, check what your local laws allow.",
  );
  assert.equal(
    await page
      .locator('main')
      .getByText(/\b(team|staff)\b/i)
      .count(),
    0,
    'the owner’s words say member',
  );
  assert.deepEqual(problems, []);
  await page.close();
});

test('Messages keeps members’ private chats out of the default list, under their own filter and by their name', async () => {
  const {page, problems} = await open('messages');
  const asked = 'Which night did the Aurora planning group pick for the tour?';
  await page.getByText('Can you remind me what time the aurora tour starts on Friday?').first().waitFor();
  assert.equal(await page.getByText(asked).count(), 0, 'not in the default list');
  const chat = page.locator('#message-chat');
  assert.equal(
    (await chat.locator('option').first().textContent()).trim(),
    'Your chats and groups',
    'the default says what it holds',
  );
  const group = chat.locator('optgroup[label="Members’ chats"]');
  await group.locator('option', {hasText: 'Mira Chen’s private chat · 2'}).waitFor({state: 'attached'});
  assert.equal(await chat.locator(':scope > option', {hasText: 'Mira Chen’s private chat'}).count(), 0);
  await chat.selectOption({label: 'Members’ chats'});
  const rows = page.getByRole('table', {name: 'Messages'});
  await rows.getByText(asked).first().waitFor();
  await rows.getByText('Mira Chen’s private chat').first().waitFor();
  assert.equal(await page.getByText('Can you remind me what time the aurora tour starts on Friday?').count(), 0);
  assert.equal(new URL(page.url()).hash.includes('chat=%3Amembers'), true, page.url());
  // Searching from the default list leaves the members’ chats out too.
  await chat.selectOption({label: 'Your chats and groups'});
  await page.locator('#message-search').fill('Aurora planning');
  await page.locator('#message-search').press('Enter');
  await page.getByRole('table', {name: 'Search results'}).or(page.getByText('No messages match')).first().waitFor();
  assert.equal(await page.getByText(asked).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('Notes names a member’s private chat and your question about a member as what they are, after your own chats', async () => {
  const {page, problems} = await open('memory?view=notes');
  const select = page.locator('#notes-profile');
  await select.waitFor();
  const labels = (await select.locator('option').allTextContents()).map(label => label.trim());
  const day = await page.evaluate(() => new Date('2026-11-14T09:00:00+00:00').toLocaleDateString());
  assert.equal(labels[0], 'Your private chat', 'the page opens on your own chat');
  assert.equal(labels[1], 'Your private chat · earlier notes', 'an earlier setup’s notes come after, named as such');
  assert.equal(
    await select.inputValue(),
    'fixture-owner',
    'opens on the current notes, not the earlier setup listed first',
  );
  assert.deepEqual(labels.slice(-2), ['Your question about a member · ' + day, 'Member · Mira Chen']);
  assert.equal(labels.filter(label => label === 'Mira Chen').length, 0, 'never shown as a bare chat name');
  assert.deepEqual(problems, []);
  await page.close();
});

test('Settings lists the member private chat texts and the local laws line, each editable', async () => {
  const {page, problems} = await open('settings?view=assistant&tab=instructions');
  const texts = {};
  for (const title of [
    'Members’ private chats',
    'Reply to a member past the daily limit, in private',
    'Reply to people who may not talk in private',
    'Local laws line on the Members page',
  ]) {
    const drawer = await instruction(page, title);
    const box = drawer.getByRole('textbox', {name: title, exact: true});
    assert.equal(await box.isEditable(), true, title);
    texts[title] = await box.inputValue();
    if (title === 'Reply to people who may not talk in private')
      await drawer.getByText('a member who is paused or has their private chat switched off', {exact: false}).waitFor();
    await done(drawer);
  }
  assert.match(texts['Members’ private chats'], /the owner can read it/);
  assert.match(texts['Reply to people who may not talk in private'], /its owner and the people they add/);
  assert.deepEqual(problems, []);
  await page.close();
});

/*
 * The members' app (ADR-0265) at /m/, against the preview's in-memory member API (test/dashboard-preview-member.ts):
 * Lena (201) reads and writes, Ravi (202) only reads, Sana (203) has her private chat off, Tom (204) is paused, Noor
 * (205) is in no group, 42 is the owner.
 */
const memberLaunch = (id, {auth = Math.floor(Date.now() / 1000), language = 'en'} = {}) =>
  new URLSearchParams({
    user: JSON.stringify({id, first_name: 'Synthetic', language_code: language}),
    auth_date: String(auth),
    hash: '0'.repeat(64),
  }).toString();
const resetMembers = () => fetch(origin + '/__preview/member/reset', {method: 'POST'});
/** The member page for one launch, recording errors, every member API answer and every storage key it touches. */
async function openMember(id, options = {}) {
  const page = options.page ?? (await browser.newPage({viewport: {width: 390, height: 844}}));
  if (options.init) await page.addInitScript(options.init);
  const problems = [],
    answers = [];
  if (!options.page) {
    page.on('pageerror', error => problems.push('page error: ' + error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !/Failed to load resource/.test(message.text()))
        problems.push('console: ' + message.text());
    });
    page.on('response', async response => {
      if (new URL(response.url()).pathname.startsWith('/api/member/'))
        answers.push({
          path: new URL(response.url()).pathname,
          headers: await response.request().allHeaders(),
          request: response.request().postData(),
          body: await response.text().catch(() => ''),
        });
    });
  }
  // A page opened again loads afresh, as a new launch from the menu does (an address that differs only after # would not).
  if (options.page) await page.goto('about:blank');
  await page.goto(origin + '/m/#tgWebAppData=' + encodeURIComponent(memberLaunch(id, options)));
  await page.waitForLoadState('networkidle');
  return {page, problems, answers};
}
/** Waits for a list to settle on a count, after a filter reloads it. */
async function settles(locator, expected) {
  for (let tries = 0; tries < 50 && (await locator.count()) !== expected; tries++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await locator.count(), expected);
}
const memberTab = (page, name) => page.getByRole('navigation').getByRole('button', {name});

test('the members’ app opens from the launch with four tabs, Chat greyed, no password, and a bare address', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201);
  await page.getByRole('heading', {name: 'Tasks', level: 1}).waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the launch is gone from the address');
  assert.deepEqual(
    (await page.getByRole('navigation', {name: 'Main'}).getByRole('button').allInnerTexts()).map(text => text.trim()),
    ['Tasks', 'Groups', 'Chat', 'Settings'],
  );
  assert.equal(await memberTab(page, 'Chat').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('input[type=password]').count(), 0, 'no password');
  // Greyed, it still says why when tapped.
  await memberTab(page, 'Chat').click({force: true});
  await page.getByText('Coming later.').waitFor();
  // Every call goes to the members' API with the launch and nothing of the owner's.
  assert.ok(answers.length > 0);
  for (const {headers} of answers) {
    assert.ok(headers['x-telegram-init-data']?.includes('auth_date='));
    assert.equal(headers['x-nocheh-mini-session'], undefined);
    assert.equal(headers.authorization, undefined);
  }
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app shows only the member’s boards, with remembered project chips, filters and groups', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201);
  const chips = page.getByRole('radiogroup', {name: 'Projects'});
  await chips.getByRole('radio', {name: 'Studio launch', checked: true}).waitFor();
  const list = page.getByRole('list', {name: 'Studio launch'});
  await list.getByText('Print the launch posters').waitFor();
  assert.equal(await list.getByRole('listitem').count(), 4);
  // A title is text, never HTML.
  await list.getByText('<img src=x onerror=alert(1)> Label the seed trays').waitFor();
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  // Mine: the task Lena made or set a reminder on.
  await page.getByRole('button', {name: 'Mine'}).click();
  await settles(list.getByRole('listitem'), 1);
  await list.getByRole('listitem').getByText('Print the launch posters').waitFor();
  await page.getByRole('button', {name: 'Mine'}).click();
  await page.getByRole('radio', {name: 'Done'}).click();
  await page.getByText('Send the thank-you notes').click();
  await page.getByRole('dialog').getByText('Finished by Ravi').waitFor();
  await page.getByRole('dialog').getByRole('button', {name: 'Close'}).click();
  await page.getByRole('radio', {name: 'Trash'}).click();
  await page.getByText('Old flyer draft').waitFor();
  await page.getByRole('radio', {name: 'Open'}).click();
  await page.getByLabel('Tag').selectOption('Print');
  await settles(list.getByRole('listitem'), 1);
  // Another project, remembered on this phone for the next launch.
  await chips.getByRole('radio', {name: 'Garden redesign'}).click();
  await page.getByText('Measure the beds').waitFor();
  assert.match(
    await page.evaluate(() => JSON.parse(localStorage.getItem('nocheh.member-ui')).project),
    /^[a-f0-9]{64}$/,
  );
  await openMember(201, {page});
  await page
    .getByRole('radiogroup', {name: 'Projects'})
    .getByRole('radio', {name: 'Garden redesign', checked: true})
    .waitFor();
  // Groups: each with its board, and a tap opens that group's tasks.
  await memberTab(page, 'Groups').click();
  const groups = page.getByRole('list', {name: 'Groups'});
  await groups.getByText('Studio launch · 3 open tasks').waitFor();
  await groups.getByRole('listitem').filter({hasText: 'Weekend notes'}).getByText('No task board').waitFor();
  await groups.getByRole('listitem').filter({hasText: 'Book club'}).getByText('Board closed').waitFor();
  await groups.getByRole('button', {name: /Aurora planning/}).click();
  await page
    .getByRole('radiogroup', {name: 'Projects'})
    .getByRole('radio', {name: 'Studio launch', checked: true})
    .waitFor();
  await page.getByText('Print the launch posters').waitFor();
  // Nothing from a board the member doesn't reach ever reached the page.
  assert.equal(answers.filter(({body}) => body.includes('HIDDENMARK')).length, 0);
  assert.deepEqual(problems, []);
  await page.close();
});

/** The preview's messages for ADR-0261 step 4 (test/dashboard-preview.ts, sourcesFixture). */
const sourceIds = {
  tour: 'e1'.repeat(32),
  tourReply: 'e2'.repeat(32),
  forecast: 'e3'.repeat(32),
  packing: 'e4'.repeat(32),
  booking: 'e5'.repeat(32),
  opening: 'e6'.repeat(32),
  photo: 'e8'.repeat(32),
  voice: 'b'.repeat(64),
};
/** One of a message panel's sections, by its heading. */
const panelSection = (page, title) =>
  page.getByRole('dialog').locator('section', {has: page.getByRole('heading', {name: title, exact: true})});
const linksTo = async (scope, id) => scope.locator(`a[href="#messages?source=${id}"]`).count();

test('a message shows what it replies to, its replies and the facts long-term memory learned from it', async () => {
  const {page, problems} = await open('messages?source=' + sourceIds.tour);
  const thread = panelSection(page, 'Thread');
  await thread.getByText('Replies (1)', {exact: true}).waitFor();
  await thread.getByText('Nocheh’s reply in your private chat', {exact: false}).waitFor();
  assert.equal(await linksTo(thread, sourceIds.tourReply), 1);
  // A reply is called a reply, never an original.
  await thread.getByRole('link', {name: 'Reply', exact: true}).waitFor();
  assert.equal(await thread.getByRole('link', {name: /^Original message/}).count(), 0);
  assert.equal(await thread.locator('dt', {hasText: 'Replies to'}).count(), 0, 'it replies to nothing');
  const learned = panelSection(page, 'Learned into memory');
  const exact = learned.getByRole('listitem').filter({hasText: 'You booked the 21:30 aurora tour for Friday.'});
  await exact.getByText('Exact source', {exact: true}).waitFor();
  // The message open now is named, not linked to itself; the other message a batch fact came from is linked.
  await exact.getByText('This message', {exact: true}).waitFor();
  const batch = learned.getByRole('listitem').filter({hasText: 'The aurora tour leaves from the harbour car park.'});
  await batch.getByText('Learned with other messages', {exact: true}).waitFor();
  assert.equal(await linksTo(batch, sourceIds.tourReply), 1);
  assert.equal(await linksTo(learned, sourceIds.tour), 0);
  // Opening a reply from the Thread section moves the panel to it.
  await thread.locator(`a[href="#messages?source=${sourceIds.tourReply}"]`).click();
  await page.waitForURL(url => url.hash.includes('source=' + sourceIds.tourReply));
  await panelSection(page, 'Learned into memory')
    .getByText('Long-term memory hasn’t learned from this message.', {exact: true})
    .waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a message in a topic shows its Topic and never Replies to, and a retired message it replies to is never linked', async () => {
  const {page, problems} = await open('messages?source=' + sourceIds.forecast);
  let thread = panelSection(page, 'Thread');
  await thread.locator('dt', {hasText: 'Topic'}).waitFor();
  await thread.getByText('“Aurora planning” › Iceland planning', {exact: true}).waitFor();
  await thread.getByRole('link', {name: 'The topic’s first message'}).waitFor();
  assert.equal(await linksTo(thread, sourceIds.opening), 1);
  assert.equal(await thread.locator('dt', {hasText: 'Replies to'}).count(), 0, 'the opening is its topic, not a reply');
  await page.goto(origin + '/#messages?source=' + sourceIds.opening);
  thread = panelSection(page, 'Thread');
  await thread.getByText('this message opens the topic', {exact: false}).waitFor();
  assert.equal(await thread.getByText(/^Replies \(/).count(), 0, 'the whole topic is not listed as its replies');
  await page.goto(origin + '/#messages?source=' + sourceIds.packing);
  thread = panelSection(page, 'Thread');
  await thread.getByText('The message it replies to · Hidden from assistant', {exact: true}).waitFor();
  assert.equal(await linksTo(thread, sourceIds.photo), 0);
  await page.goto(origin + '/#messages?source=' + sourceIds.booking);
  thread = panelSection(page, 'Thread');
  await thread.locator('dt', {hasText: 'Forwarded from'}).waitFor();
  await thread.getByText('the channel “Night sky news”', {exact: true}).waitFor();
  assert.equal(await linksTo(thread, sourceIds.tour), 1);
  // A read long-term memory couldn't answer says so, and is not shown as nothing learned.
  await page.goto(origin + '/#messages?source=' + sourceIds.voice);
  await panelSection(page, 'Learned into memory')
    .getByText('Long-term memory can’t be reached right now. Try again in a minute.', {exact: true})
    .waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app adds a task for a group or the whole project, comments, reminds, finishes and trashes', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201);
  await page.getByRole('button', {name: 'New task'}).click();
  const form = page.getByRole('dialog', {name: 'New task'});
  // The member's own group by default, and the line says who will see it.
  assert.equal(await form.getByLabel('Group').inputValue(), '-30001');
  await form.getByText('Everyone in Aurora planning will see this task.').waitFor();
  await form.getByLabel('Group').selectOption({label: 'Whole project'});
  await form.getByText('Everyone in Studio launch’s groups will see this task.').waitFor();
  await form.getByLabel('Group').selectOption({label: 'Aurora planning'});
  await form.getByLabel('Title').fill('Hang the bunting');
  await form.getByLabel('Tags').fill('Decor, Outside');
  await form.getByRole('button', {name: 'Add task'}).click();
  const drawer = page.getByRole('dialog', {name: 'Hang the bunting'});
  await drawer.getByText('Made by Lena', {exact: false}).waitFor();
  await drawer.getByText('Decor, Outside').waitFor();
  const created = answers.find(({path, request}) => path === '/api/member/tasks' && request);
  assert.deepEqual(JSON.parse(created.request), {
    operation_id: JSON.parse(created.request).operation_id,
    project: JSON.parse(created.request).project,
    title: 'Hang the bunting',
    group: '-30001',
    tags: ['Decor', 'Outside'],
  });
  // A comment, as plain text.
  await drawer.getByLabel('Write a comment').fill('Bring the <b>ladder</b>.');
  await drawer.getByRole('button', {name: 'Send'}).click();
  await drawer.getByText('Bring the <b>ladder</b>.').waitFor();
  // Remind me, at a time in the phone's own zone.
  await drawer.getByRole('button', {name: 'Remind me'}).click();
  await drawer.getByLabel('Remind me at').fill('2030-01-04T09:00');
  await drawer.getByRole('button', {name: 'Set', exact: true}).click();
  await drawer.getByRole('list', {name: 'Reminders'}).getByRole('listitem').waitFor();
  // Finish, then Reopen; then the trash and back.
  await drawer.getByRole('button', {name: 'Finish'}).click();
  await drawer.getByRole('button', {name: 'Reopen'}).click();
  await drawer.getByRole('button', {name: 'Finish'}).waitFor();
  await drawer.getByRole('button', {name: 'Move to trash'}).click();
  await drawer.getByText('In the trash').waitFor();
  await drawer.getByRole('button', {name: 'Restore'}).click();
  await drawer.getByRole('button', {name: 'Move to trash'}).waitFor();
  // The reminder went with the phone's own offset, never as a bare wall-clock time.
  const reminder = answers.find(({request}) => request?.includes('"reminders"'));
  assert.match(JSON.parse(reminder.request).patch.reminders[0], /^2030-01-04T09:00:00(?:[+-]\d{2}:\d{2})$/);
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app reloads a task someone else changed, and says so', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201);
  await page.getByText('Print the launch posters').click();
  const drawer = page.getByRole('dialog', {name: 'Print the launch posters'});
  await drawer.getByText('Use the matte paper.').waitFor();
  const id = await drawer.locator('[data-task]').getAttribute('data-task');
  await fetch(origin + '/__preview/member/touch/' + id, {method: 'POST'});
  await drawer.getByRole('button', {name: 'Edit'}).click();
  await drawer.getByLabel('Title').fill('Print the posters on A2');
  await drawer.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('dialog').getByText('Someone changed this task. Here is the new version.').waitFor();
  await page.getByRole('dialog', {name: 'Print the launch posters (changed)'}).waitFor();
  assert.ok(answers.some(({path, body}) => path.endsWith('/tasks/' + id) && body.includes('"conflict"')));
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app with read access only shows no buttons and says why', async () => {
  await resetMembers();
  const {page, problems} = await openMember(202);
  await page.getByText('You can read these tasks. The owner can let you change them.').first().waitFor();
  assert.equal(await page.getByRole('button', {name: 'New task'}).count(), 0);
  assert.equal(await page.getByRole('radiogroup', {name: 'Projects'}).count(), 0, 'one project, no chips');
  await page.getByText('Print the launch posters').click();
  const drawer = page.getByRole('dialog', {name: 'Print the launch posters'});
  await drawer.getByText('Use the matte paper.').waitFor();
  for (const name of ['Edit', 'Finish', 'Move to trash', 'Remind me', 'Send', 'Change', 'Remove'])
    assert.equal(await drawer.getByRole('button', {name, exact: true}).count(), 0, name);
  assert.equal(await drawer.getByLabel('Write a comment').count(), 0);
  // Others' reminders are a count, never names.
  await drawer.getByText('3 other reminders').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app hides Remind me with one line when reminders can’t reach the member', async () => {
  await resetMembers();
  const {page, problems} = await openMember(203);
  await page.getByText('Print the launch posters').click();
  const drawer = page.getByRole('dialog', {name: 'Print the launch posters'});
  await drawer.getByRole('button', {name: 'Finish'}).waitFor();
  assert.equal(await drawer.getByRole('button', {name: 'Remind me'}).count(), 0);
  await drawer.getByText('Reminders can’t reach you: your private chat with Nocheh is off.').waitFor();
  await drawer.getByRole('button', {name: 'Close'}).click();
  await memberTab(page, 'Settings').click();
  await page.getByText('Reminders are off for you: Your private chat with Nocheh is off.').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app still removes the member’s own reminders when new ones can’t reach them', async () => {
  await resetMembers();
  const {page, problems} = await openMember(203);
  await page.getByText('Print the launch posters').click();
  const drawer = page.getByRole('dialog', {name: 'Print the launch posters'});
  const id = await drawer.locator('[data-task]').getAttribute('data-task');
  await drawer.getByRole('button', {name: 'Close'}).click();
  // Two reminders Sana set before her private chat with Nocheh was turned off.
  for (let index = 0; index < 2; index++)
    await fetch(origin + '/__preview/member/remind/' + id + '/203', {method: 'POST'});
  await page.getByText('Print the launch posters').click();
  const mine = drawer.getByRole('list', {name: 'Reminders'});
  await settles(mine.getByRole('listitem'), 2);
  assert.equal(await drawer.getByRole('button', {name: 'Change'}).count(), 0, 'no new time can be set');
  assert.equal(await drawer.getByRole('button', {name: 'Remind me'}).count(), 0);
  await mine.getByRole('button', {name: 'Remove'}).first().click();
  await page.getByText('Reminder removed.').waitFor();
  await settles(mine.getByRole('listitem'), 1);
  await drawer.getByRole('button', {name: 'Close'}).click();
  // Settings › My reminders removes the other.
  await memberTab(page, 'Settings').click();
  const listed = page.getByRole('list', {name: 'My reminders'});
  await settles(listed.getByRole('listitem'), 1);
  await listed.getByRole('button', {name: 'Remove'}).click();
  await page.getByText('You have no reminders waiting.').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app adds a subtask where its parent is, with no group to choose', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201);
  await page.getByRole('button', {name: 'New task'}).click();
  const form = page.getByRole('dialog', {name: 'New task'});
  assert.equal(await form.getByLabel('Group').inputValue(), '-30001');
  // Under a task set on the whole project: the group goes, and the line says who sees it.
  await form.getByLabel('Under task').selectOption({label: 'Book the venue'});
  assert.equal(await form.getByLabel('Group').count(), 0);
  await form.getByText('Everyone in Studio launch’s groups will see this task.').waitFor();
  await form.getByLabel('Title').fill('Sign the venue contract');
  await form.getByRole('button', {name: 'Add task'}).click();
  await page.getByRole('dialog', {name: 'Sign the venue contract'}).waitFor();
  const created = JSON.parse(answers.find(({path, request}) => path === '/api/member/tasks' && request).request);
  assert.equal('group' in created, false, 'the parent decides the group');
  assert.match(created.parent, /^[a-f0-9]{64}$/);
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app shows a group filter it opened from the Groups tab, so it can be cleared', async () => {
  await resetMembers();
  const {page, problems} = await openMember(201);
  await memberTab(page, 'Groups').click();
  await page
    .getByRole('list', {name: 'Groups'})
    .getByRole('button', {name: /Aurora planning/})
    .click();
  const list = page.getByRole('list', {name: 'Studio launch'});
  await list.getByText('Print the launch posters').waitFor();
  // Lena has one group on this board, yet the filter shows, and the whole project's task is a choice away.
  const filter = page.getByRole('combobox', {name: 'Group'});
  assert.equal(await filter.inputValue(), '-30001');
  assert.equal(await list.getByText('Book the venue').count(), 0);
  await filter.selectOption({label: 'All groups'});
  await list.getByText('Book the venue').waitFor();
  assert.equal(
    await page.getByRole('combobox', {name: 'Group'}).count(),
    0,
    'with no filter on, one group needs no filter',
  );
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app follows only http(s) links and shows the rest as text', async () => {
  await resetMembers();
  const {page, problems} = await openMember(201);
  await page.getByText('Book the venue').click();
  const drawer = page.getByRole('dialog', {name: 'Book the venue'});
  assert.equal(await drawer.getByRole('link', {name: 'Venue page'}).getAttribute('href'), 'https://example.com/venue');
  await drawer.getByText('Not a web link').waitFor();
  assert.equal(await drawer.getByRole('link', {name: 'Not a web link'}).count(), 0);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app is closed to strangers and paused members, asks for a new launch, and stops for the owner', async () => {
  await resetMembers();
  for (const [who, options, heading] of [
    [204, {}, 'This app is closed for you'],
    [999, {}, 'This app is closed for you'],
    [201, {auth: Math.floor(Date.now() / 1000) - 2 * 3600}, 'Open me again from the menu button'],
    [42, {}, 'This page is for members'],
  ]) {
    const {page, problems} = await openMember(who, options);
    await page.getByRole('heading', {name: heading}).waitFor();
    await page.getByRole('button', {name: 'Close'}).waitFor();
    // Nothing of the visit is kept, and nothing about tasks is shown.
    assert.deepEqual(
      await page.evaluate(() => [
        sessionStorage.getItem('nocheh.member-launch'),
        localStorage.getItem('nocheh.member-ui'),
      ]),
      [null, null],
      String(who),
    );
    assert.equal(await page.getByRole('navigation', {name: 'Main'}).count(), 0);
    assert.deepEqual(problems, [], String(who));
    await page.close();
  }
  // Opened outside Telegram: no launch at all.
  const page = await browser.newPage({viewport: {width: 390, height: 844}});
  await page.goto(origin + '/m/');
  await page.getByRole('heading', {name: 'Open this from Telegram'}).waitFor();
  await page.close();
});

test('the members’ app signs out on every phone, clears only its own keys and never reads the owner’s', async () => {
  await resetMembers();
  // The owner's own mini app keys on the same phone, and a record of every key the page touches.
  const init = () => {
    if (location.protocol !== 'http:') return;
    if (!sessionStorage.getItem('test.seeded')) {
      localStorage.setItem('nocheh.mini-session', 'owner-phone-token');
      sessionStorage.setItem('nocheh.telegram-launch', 'owner-launch');
      sessionStorage.setItem('test.seeded', '1');
    }
    window.__touched = [];
    for (const name of ['getItem', 'setItem', 'removeItem']) {
      const real = Storage.prototype[name];
      Storage.prototype[name] = function (key, ...rest) {
        window.__touched.push(key);
        return real.call(this, key, ...rest);
      };
    }
  };
  // Opened on this phone ten minutes ago; another phone opened the app five minutes ago.
  const auth = Math.floor(Date.now() / 1000) - 600;
  const {page, problems} = await openMember(201, {auth, init});
  await page.getByRole('heading', {name: 'Tasks', level: 1}).waitFor();
  assert.ok(await page.evaluate(() => sessionStorage.getItem('nocheh.member-launch')));
  await memberTab(page, 'Settings').click();
  await page.getByText('Signs you out on every phone. Opening the app from the menu signs you in again.').waitFor();
  await page.getByRole('button', {name: 'Sign out'}).click();
  await page.getByRole('heading', {name: 'You are signed out'}).waitFor();
  const touched = await page.evaluate(() => window.__touched.filter(key => key !== 'test.seeded'));
  assert.deepEqual([...new Set(touched)].sort(), ['nocheh.member-launch', 'nocheh.member-ui']);
  assert.deepEqual(
    await page.evaluate(() => [
      sessionStorage.getItem('nocheh.member-launch'),
      localStorage.getItem('nocheh.member-ui'),
      localStorage.getItem('nocheh.mini-session'),
      sessionStorage.getItem('nocheh.telegram-launch'),
    ]),
    [null, null, 'owner-phone-token', 'owner-launch'],
  );
  // The same launch is refused now, and so is the other phone's, opened after it; one opened from the menu now works.
  await openMember(201, {page, auth});
  await page.getByRole('heading', {name: 'Open me again from the menu button'}).waitFor();
  await openMember(201, {page, auth: auth + 300});
  await page.getByRole('heading', {name: 'Open me again from the menu button'}).waitFor();
  await openMember(201, {page, auth: auth + 600});
  await page.getByRole('heading', {name: 'Tasks', level: 1}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app is in English only, whatever Telegram’s language, with no language setting', async () => {
  await resetMembers();
  const {page, problems, answers} = await openMember(201, {language: 'fa'});
  await page.getByRole('heading', {name: 'Tasks', level: 1}).waitFor();
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]), [
    'ltr',
    'en',
  ]);
  await memberTab(page, 'Settings').click();
  await page.getByRole('heading', {name: 'Settings', level: 1}).waitFor();
  assert.equal(await page.getByText('Language', {exact: true}).count(), 0);
  assert.equal(await page.getByText('Follow Telegram').count(), 0);
  assert.equal(await page.getByRole('radio').count(), 0);
  // Only the eight routes: nothing asks for or saves a language.
  assert.equal(answers.filter(({path}) => /\/prefs/.test(path)).length, 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('Long-term lists facts newest first with their sources, by chat or person, under the coverage line', async () => {
  const {page, problems} = await open('memory?view=longterm&tab=facts');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Facts it learned'})});
  await card.getByText('412 exact · 96 learned with other messages · 7 none', {exact: true}).waitFor();
  const facts = card.getByRole('table', {name: 'Facts', exact: true});
  const texts = async () =>
    (await facts.locator('tbody > tr > td:first-child').allTextContents()).map(text => text.trim());
  await facts.getByText('Mira took photos from the ridge.').waitFor();
  assert.deepEqual(await texts(), [
    'The aurora tour leaves from the harbour car park.',
    'You booked the 21:30 aurora tour for Friday.',
    'Mira wants to check the Kp forecast before the trip.',
    'Mira took photos from the ridge.',
  ]);
  const photo = facts.getByRole('row').filter({hasText: 'Mira took photos from the ridge.'}).first();
  await photo.getByText('Hidden from assistant', {exact: false}).waitFor();
  assert.equal(await linksTo(photo, sourceIds.photo), 0, 'a retired original is never linked');
  const forecast = facts.getByRole('row').filter({hasText: 'Mira wants to check the Kp forecast'}).first();
  await forecast.getByText('“Mira Chen” in “Aurora planning” › Iceland planning', {exact: false}).waitFor();
  assert.equal(await linksTo(forecast, sourceIds.forecast), 1);
  // About one person, then within one group and its topics.
  await card.locator('#facts-person').selectOption({label: 'Mira Chen'});
  await facts.getByText('Mira wants to check the Kp forecast before the trip.').waitFor();
  await facts.getByText('You booked the 21:30 aurora tour for Friday.').waitFor({state: 'detached'});
  assert.equal((await texts()).length, 2);
  await page.goto(origin + '/#memory?view=longterm&chat=-10042');
  await facts.getByText('Mira took photos from the ridge.').waitFor();
  assert.deepEqual(await texts(), [
    'Mira wants to check the Kp forecast before the trip.',
    'Mira took photos from the ridge.',
  ]);
  await page.goto(origin + '/#memory?view=longterm&chat=42');
  await facts.getByText('You booked the 21:30 aurora tour for Friday.').waitFor();
  assert.equal((await texts()).length, 2);
  // A link to one chat's facts opens on the facts; re-running or replacing is one sub-tab away.
  await page.getByRole('tab', {name: 'Facts it learned', selected: true}).waitFor();
  await page.getByRole('tab', {name: 'Re-run and look'}).click();
  await page.getByRole('heading', {name: 'Re-run or replace'}).waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the members’ app shows assignees by Telegram name with the rest counted, and statuses and columns by name', async () => {
  await resetMembers();
  const {page, problems} = await openMember(201);
  const list = page.getByRole('list', {name: 'Studio launch'});
  const row = title => list.getByRole('listitem').filter({hasText: title});
  // Rows: the owner's status names, and who does each task.
  await row('Print the launch posters').getByText('At the printer').waitFor();
  await row('Print the launch posters').getByText('Ravi, Sana and 2 other people').waitFor();
  await row('Book the venue').getByText('1 other person').waitFor();
  await row('Book the venue').getByText('Not started').waitFor();
  assert.equal(await row('Label the seed trays').getByLabel('Assignees').count(), 0, 'nobody: nothing shown');
  // The drawer names each shared column and its choices, never their ids.
  await page.getByText('Print the launch posters').click();
  const drawer = page.getByRole('dialog', {name: 'Print the launch posters'});
  const facts = async () =>
    Object.fromEntries(
      await drawer
        .locator('dl')
        .first()
        .evaluate(list =>
          [...list.querySelectorAll('dt')].map(term => [
            term.textContent.trim(),
            term.nextElementSibling.textContent.trim(),
          ]),
        ),
    );
  await drawer.getByText('Use the matte paper.').waitFor();
  const before = await facts();
  assert.equal(before.Assignees, 'Ravi, Sana and 2 other people');
  assert.equal(before['Paper size'], 'A2');
  assert.equal(before.Rooms, 'Hall, Yard');
  assert.equal(before['Signed off'], '✓');
  assert.equal(before.Budget, undefined, 'an empty column is left out');
  assert.equal(await drawer.getByText(/\b[co]-[a-z0-9]+\b/).count(), 0, 'no column or choice id');
  await drawer.getByText('At the printer').waitFor();
  // Edit: the owner's statuses and the shared columns, and only what changed is sent.
  const sent = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/member/tasks/'))
      sent.push(JSON.parse(request.postData() ?? '{}'));
  });
  await drawer.getByRole('button', {name: 'Edit'}).click();
  assert.deepEqual(
    (await drawer.getByLabel('Status').locator('option').allInnerTexts()).map(text => text.trim()),
    ['Not started', 'At the printer', 'Wrapped up', 'Shelved'],
  );
  assert.deepEqual(
    (await drawer.getByLabel('Paper size').locator('option').allInnerTexts()).map(text => text.trim()),
    ['None', 'A2', 'A3'],
  );
  await drawer.getByLabel('Status').selectOption({label: 'Wrapped up'});
  await drawer.getByLabel('Paper size').selectOption({label: 'A3'});
  await drawer.getByLabel('Budget').fill('300');
  await drawer.getByRole('group', {name: 'Rooms'}).getByLabel('Yard').uncheck();
  await drawer.getByRole('button', {name: 'Save'}).click();
  await drawer.getByText('Wrapped up').waitFor();
  assert.deepEqual(sent.at(-1).patch, {
    status: 's-done',
    properties: {'c-budget': 300, 'c-size': 'o-a3', 'c-rooms': ['o-hall']},
  });
  const after = await facts();
  assert.deepEqual([after['Paper size'], after.Rooms, after.Budget], ['A3', 'Hall', '300']);
  await drawer.getByRole('button', {name: 'Close'}).click();
  // New task: the first open status by default (not sent), and the shared columns.
  await page.getByRole('button', {name: 'New task'}).click();
  const form = page.getByRole('dialog', {name: 'New task'});
  assert.equal(await form.getByLabel('Status').inputValue(), 's-todo');
  await form.getByLabel('Title').fill('Hang the bunting');
  await form.getByRole('group', {name: 'Rooms'}).getByLabel('Yard').check();
  await form.getByLabel('Signed off').check();
  const created = page.waitForRequest(
    request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/member/tasks',
  );
  await form.getByRole('button', {name: 'Add task'}).click();
  const body = JSON.parse((await created).postData());
  assert.equal(body.status, undefined);
  assert.deepEqual(body.properties, {'c-rooms': ['o-yard'], 'c-signed': true});
  const added = page.getByRole('dialog', {name: 'Hang the bunting'});
  await added.getByText('Not started').waitFor();
  assert.deepEqual(
    (await added.locator('dl dt').allInnerTexts()).map(text => text.trim()),
    ['Group', 'Rooms', 'Signed off'],
  );
  assert.deepEqual(problems, []);
  await page.close();
  await resetMembers();
});

test('the members’ app says when there is no board yet and no group', async () => {
  await resetMembers();
  const {page, problems} = await openMember(205);
  await page
    .getByText('No task boards yet. When the owner puts one of your groups in a project, its tasks show here.')
    .waitFor();
  await memberTab(page, 'Groups').click();
  await page.getByText('You are not in any group that Nocheh serves.').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('Notes shows the day each note names and links its original messages, never a retired one', async () => {
  const {page, problems} = await open('memory?view=notes');
  const notes = page.locator('section', {has: page.getByRole('heading', {name: 'General notes'})});
  const own = notes.getByRole('row').filter({hasText: 'Synthetic memory: interested in astronomy.'}).first();
  const day = await page.evaluate(() =>
    new Date(2026, 10, 12).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'}),
  );
  await own.getByText(day, {exact: true}).waitFor();
  const links = own.getByRole('list', {name: 'Original messages'});
  await links.getByRole('link', {name: 'Original message 1'}).waitFor();
  assert.equal(await linksTo(links, sourceIds.tour), 1);
  assert.equal(await linksTo(links, sourceIds.packing), 1);
  const forward = notes.getByRole('row').filter({hasText: 'Alice is planning a trip to Iceland.'}).first();
  await forward.getByText('Original message 2 · Hidden from assistant', {exact: true}).waitFor();
  assert.equal(await linksTo(forward, sourceIds.photo), 0);
  assert.equal(await linksTo(forward, sourceIds.booking), 1);
  // A note's words are shown without the ids of Nocheh's own records it carries.
  await notes.getByText('The lunch poll now offers tacos on Friday.', {exact: true}).waitFor();
  assert.equal(await notes.getByText(/nocheh:event:|conv 4200042/).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('Facts, People and Inbox review name each original next to its link', async () => {
  const label = 'you in your private chat';
  const {page: facts, problems: factProblems} = await open('memory?view=facts&entry=' + 'e1'.repeat(32));
  const from = panelSection(facts, 'Where it came from');
  await from.getByText(label, {exact: false}).waitFor();
  assert.equal(await linksTo(from, 'a'.repeat(64)), 1);
  await facts.close();
  const {page: people, problems: peopleProblems} = await open('memory?view=people&person=' + '1'.repeat(64));
  const claim = people.getByRole('listitem').filter({hasText: 'Mira prefers quiet aurora viewpoints'}).first();
  await claim.getByText(label, {exact: false}).waitFor();
  assert.equal(await linksTo(claim, 'a'.repeat(64)), 1);
  // A source that names no message the archive holds has no link, only why.
  const unlinked = people
    .getByRole('listitem')
    .filter({hasText: 'Mira and Devon are planning the Iceland trip'})
    .first();
  await unlinked.getByText('Source not recorded', {exact: true}).waitFor();
  assert.equal(await unlinked.locator('a[href^="#messages?source="]').count(), 0);
  const learned = people.getByRole('link', {name: 'What long-term memory learned about Mira Chen'});
  assert.equal(await learned.getAttribute('href'), '#memory?view=longterm&about=' + '1'.repeat(64));
  await people.close();
  const {page: inbox, problems: inboxProblems} = await open('inbox?kind=memory_access&decision=' + '4'.repeat(64));
  const drawer = inbox.getByRole('dialog');
  await drawer.locator('summary', {hasText: 'Why Nocheh suggested this'}).click();
  await drawer.getByRole('link', {name: 'Open the original message'}).waitFor();
  await drawer.getByText(label, {exact: false}).waitFor();
  assert.deepEqual([...factProblems, ...peopleProblems, ...inboxProblems], []);
  await inbox.close();
});

/** A page opened with every dashboard request it makes counted by path, the query left out. */
async function counted(hash) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const problems = [],
    asked = new Map();
  page.on('pageerror', error => problems.push('page error: ' + error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/nocheh/')) {
      const path = url.pathname.slice('/api/nocheh'.length);
      asked.set(path, (asked.get(path) ?? 0) + 1);
    }
  });
  await page.goto(origin + '/#' + hash);
  await page.locator('main h1').first().waitFor();
  await page.waitForLoadState('networkidle');
  return {page, problems, asked: path => asked.get(path) ?? 0};
}

test('what a message taught long-term memory is asked when its panel opens and when you check again, never on a live update', async () => {
  const {page, problems, asked} = await counted('messages?source=' + sourceIds.tour);
  const learned = panelSection(page, 'Learned into memory');
  await learned.getByText('You booked the 21:30 aurora tour for Friday.').waitFor();
  const thread = '/events/' + sourceIds.tour + '/thread';
  assert.equal(asked('/memory/message-facts'), 1);
  // Live updates are paused in the preview, so Messages refreshes what it shows every 10 seconds: the thread, never this.
  await page.getByText('Live updates paused', {exact: true}).waitFor();
  const before = asked(thread);
  await page.waitForTimeout(11000);
  assert.ok(asked(thread) > before, 'the thread follows live updates');
  assert.equal(asked('/memory/message-facts'), 1, 'long-term memory is not asked again on a live update');
  await learned.getByRole('button', {name: 'Check again'}).click();
  await page.waitForLoadState('networkidle');
  assert.equal(asked('/memory/message-facts'), 2);
  assert.deepEqual(problems, []);
  await page.close();
});

test('an Inbox proposal names every original of its new projects and moved chats with one lookup', async () => {
  const {page, problems, asked} = await counted('inbox?kind=knowledge&decision=' + 'f'.repeat(64));
  const drawer = page.getByRole('dialog');
  await drawer.getByText('Iceland trip 2027', {exact: true}).waitFor();
  await drawer.getByText('an audio file you sent in your private chat', {exact: false}).waitFor();
  await drawer.getByText('you in your private chat', {exact: false}).first().waitFor();
  assert.equal(asked('/memory/originals'), 1, 'one lookup for the whole panel');
  assert.deepEqual(problems, []);
  await page.close();
});

test('Long-term’s filters: the chosen person stays chosen while searching, and other people’s private chats aren’t offered', async () => {
  const {page, problems} = await open('memory?view=longterm&about=' + '1'.repeat(64));
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Facts it learned'})});
  const person = card.locator('#facts-person');
  await card.getByRole('table', {name: 'Facts', exact: true}).getByText('Mira took photos from the ridge.').waitFor();
  await card.getByRole('searchbox', {name: 'Search people'}).fill('Devon');
  await card.locator('#facts-person option', {hasText: 'Devon'}).waitFor({state: 'attached'});
  assert.equal(await person.inputValue(), '1'.repeat(64));
  assert.deepEqual(
    (await card.locator('#facts-person option').allTextContents()).map(text => text.trim()),
    ['Anyone', 'Devon', 'Mira Chen'],
  );
  // Mira's private chat with Nocheh is hers: long-term memory never learns from it, so it isn't a choice here.
  // The chats open under the search box only while it is in use, so the list takes no room on the page.
  const chats = card.getByRole('listbox', {name: 'In chat'});
  assert.equal(await chats.count(), 0);
  await card.getByPlaceholder('Search by name or Telegram ID').click();
  await chats
    .getByRole('option', {name: /^Aurora planning/})
    .first()
    .waitFor();
  assert.equal(await chats.getByRole('option', {name: /Mira Chen/}).count(), 0);
  await card.getByPlaceholder('Search by name or Telegram ID').fill('Mira');
  await card.getByText('Other people’s private chats aren’t learned from, so they aren’t listed here.').waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('the owner sees Reminders to themselves under Tasks, and where the members’ app is', async () => {
  const {page, problems} = await open('members?member=' + MIRA);
  const posts = memberPosts(page);
  await page.getByRole('heading', {name: 'Mira Chen', level: 2}).waitFor();
  const toast = text => page.getByRole('status').filter({hasText: text}).last().waitFor();
  const tasks = page.getByRole('radiogroup', {name: 'Tasks'});
  if (await tasks.getByRole('radio', {name: 'Read only', checked: true}).count()) {
    await tasks.getByRole('radio', {name: 'Read and write'}).click();
    await toast('Mira Chen can read and change tasks.');
  }
  await page.getByText('Read and write, in groups and the members’ app', {exact: false}).waitFor();
  await page.getByText('Members open the app from the menu button in their private chat with Nocheh.').waitFor();
  const reminders = 'Reminders to themselves';
  await page.getByRole('switch', {name: reminders, checked: true}).click();
  await toast('Mira Chen can’t set reminders now.');
  await page.getByRole('switch', {name: reminders, checked: false}).click();
  await toast('Mira Chen can set reminders to themselves.');
  // Read only: reminders can't be set, and the switch keeps its setting.
  await tasks.getByRole('radio', {name: 'Read only'}).click();
  await page.getByText('Read only, in groups and the members’ app', {exact: false}).waitFor();
  assert.equal(await page.getByRole('switch', {name: reminders}).isDisabled(), true);
  assert.equal(await page.getByRole('switch', {name: reminders}).getAttribute('aria-checked'), 'true');
  await tasks.getByRole('radio', {name: 'Read and write'}).click();
  await page.getByRole('switch', {name: reminders, checked: true}).waitFor();
  assert.deepEqual(
    posts.map(({body}) => body.changes).filter(changes => 'reminders' in changes),
    [{reminders: false}, {reminders: true}],
  );
  assert.deepEqual(problems, []);
  await page.close();
});

test('the Mini app card shows the owner’s and the members’ addresses and who gets the menu button', async () => {
  const {page, problems} = await open('settings?view=telegram&tab=miniapp');
  const card = page.locator('section', {has: page.getByRole('heading', {name: 'Mini app', exact: true})});
  await card.getByText('Your members get their own small app at its own address.', {exact: false}).waitFor();
  await card.locator('#mini-app-url').fill('https://nocheh.example.com/');
  const addresses = card.getByRole('definition');
  assert.deepEqual(await addresses.allInnerTexts(), ['https://nocheh.example.com/', 'https://nocheh.example.com/m/']);
  await card
    .getByText(
      'Every private chat with Nocheh gets the menu button. Only active members can open the app. Others see a closed page.',
    )
    .waitFor();
  await card.locator('#mini-app-url').fill('');
  assert.equal(await card.getByRole('definition').count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a task from the members’ app says so on its row, its comments and its history', async () => {
  const {page, problems} = await open('tasks');
  await page
    .getByRole('radiogroup', {name: 'List'})
    .getByRole('radio', {name: /Studio launch/})
    .click();
  const title = 'Label the seed trays';
  const row = page.getByRole('row').filter({hasText: title});
  await row.getByText('Members’ app').waitFor();
  await row.getByRole('button', {name: `Edit “${title}”`}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('list', {name: 'Comments'}).getByText('in the members’ app', {exact: false}).waitFor();
  await dialog
    .getByRole('list', {name: 'History'})
    .getByText('Mira Chen in the members’ app', {exact: false})
    .waitFor();
  await dialog.getByText('Yours are sent to your private chat with Nocheh', {exact: false}).first().waitFor();
  assert.deepEqual(problems, []);
  await page.close();
});

test('a note Nocheh wrote while answering names its day once, in its own words', async () => {
  const {page, problems} = await open('memory?view=notes&tab=about');
  const turn = page.getByRole('row').filter({hasText: 'Prefers short answers.'}).first();
  await turn.getByText('Nocheh’s note from your private chat on 2026-11-12', {exact: true}).waitFor();
  const day = await page.evaluate(() =>
    new Date(2026, 10, 12).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'}),
  );
  assert.equal(await turn.getByText(day, {exact: true}).count(), 0);
  assert.deepEqual(problems, []);
  await page.close();
});
